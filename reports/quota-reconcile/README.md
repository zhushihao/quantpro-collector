# Cloudflare 官方电表对账（Phase 3）

> 规格：`.sdd/2026-10-01-collector-quota-redesign/spec-plan-collector-quota-reconcile.md` §四 Phase 3
> 关联 Issue：`zhushihao/quantpro-collector#54`
> 脚本：`scripts/cf_quota_meter_reconcile.py`　定时任务安装：`scripts/install_quota_reconcile_task.ps1`

## 一、链路（谁在什么时候读什么、写什么）

```
每 12 小时（Windows 计划任务 QuantPro_QuotaReconcile，本机研究机）
  │
  ├─ ① 拉官方真值（Cloudflare 官方 API，凭据只读环境变量 CLOUDFLARE_API_TOKEN）
  │     ├ GraphQL d1AnalyticsAdaptiveGroups（date 粒度）→ sum.rowsRead / sum.rowsWritten
  │     │   窗口 = Workers Paid 订阅周期 [current_period_start, now)
  │     ├ GraphQL aiInferenceAdaptiveGroups（datetimeHour 粒度）→ sum.totalNeurons
  │     │   窗口 = 当前 UTC 日（00:00Z 起；实测字段名是 totalNeurons，不是 neurons）
  │     ├ REST /accounts/{id}/vectorize/v2/indexes/research-public-bge-m3-v1/info
  │     │   → dimensions / vectorCount / processedUpToDatetime（库存证据）
  │     └ REST /accounts/{id}/subscriptions → 锚定 Workers Paid 账期（prod_workers / workers_paid）
  │
  ├─ ② 95% 判定 → 生成四个维度的熔断状态（见 §四）
  │
  ├─ ③ 写 D1（经 wrangler，与 Worker 同一扇门）
  │     wrangler d1 execute RESEARCH_REPLICA --remote
  │     ├ 建表（IF NOT EXISTS，首次运行自动建 quota_circuit_state）
  │     └ 幂等 UPSERT 四行（INSERT ... ON CONFLICT(dimension_key) DO UPDATE）
  │
  └─ ④ 出报表 → reports/quota-reconcile/reconcile-<UTC时间戳>.json / .md
        读 D1 表 quota_client_usage_hourly（Phase 2 分端流水）按 client_id 聚合
        最近 N 小时（默认 24h）的调用量、D1 读写行数、AI neurons 及占比
```

任何一步官方 API 失败 → **整体安全降级**：打印 WARNING、退出码 3，**不改熔断状态、
不写任何行、绝不补零**。下次定时任务用新真值重新判定。

## 二、启停（运维）

注册（幂等：先删同名任务再注册，注册后断言任务列表里恰好一行）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install_quota_reconcile_task.ps1
```

移除：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install_quota_reconcile_task.ps1 -Remove
```

- 任务名 `QuantPro_QuotaReconcile`，每 12 小时一次（重复间隔），当前用户、仅登录时运行
  （因此继承用户环境变量里的 `CLOUDFLARE_API_TOKEN`；注册脚本发现 USER 域没有该变量会
  警告但照常注册——只警告，不打印值）。
- Python 解析顺序：仓库 `.venv\Scripts\python.exe` 优先，否则注册时从 PATH 解析
  `python.exe` 并把绝对路径写进任务 Action。
- 手动触发一次：`Start-ScheduledTask QuantPro_QuotaReconcile`；查看结果：
  `Get-ScheduledTaskInfo QuantPro_QuotaReconcile`。
- 手动跑一次（不装任务、不写 D1、不落报表，只拉官方数据并打印）：

```bash
python scripts/cf_quota_meter_reconcile.py --dry-run
```

- 退出码：`0` 成功；`1` 配置错（如缺 token）；`3` 官方 API 失败（什么都没写）；
  `4` D1 持久化失败（官方数据已拿到，报表仍会落盘，熔断表可能未刷新）。

## 三、口径（算的是什么、窗口怎么取）

| 维度 | 官方额度 | 95% 阈值（floor） | 窗口 | 数据源 |
|---|---:|---:|---|---|
| `ai.neurons` | 10,000 Neurons/天 | 9,500 | UTC 日（00:00Z 重置） | GraphQL `aiInferenceAdaptiveGroups.sum.totalNeurons`（datetimeHour 粒度求和） |
| `d1.rows_read` | 250 亿行/账期 | 23,750,000,000 | Workers Paid 订阅周期 | GraphQL `d1AnalyticsAdaptiveGroups.sum.rowsRead`（date 粒度求和） |
| `d1.rows_written` | 5,000 万行/账期 | 47,500,000 | Workers Paid 订阅周期 | GraphQL `d1AnalyticsAdaptiveGroups.sum.rowsWritten` |
| `vectorize.queries` | 3,000 万查询维/账期 | 28,500,000 | Workers Paid 订阅周期 | **无官方月度电表**（见下） |

关键口径纪律（沿用 `src/quota-dimensions.ts` 冻结规则）：

1. **账期窗口锚在订阅续期日，不是 UTC 自然月，更不做"月额 ÷ 31"**。账期唯一来源是
   REST `/subscriptions` 里 `product.name == "prod_workers"` 且 `rate_plan.id == "workers_paid"`
   的 `current_period_start/end`。拿不到该订阅 = 官方数据失败 = 退出码 3。
2. GraphQL 官方限制单次时间跨度 ≤ 4 周 4 天（实测报错），月度账期 ≤ 31 天天然满足；
   脚本里另有 32 天钳制作兜底。
3. **`vectorize.queries` 当前没有官方电表**：REST info 只给库存（vectorCount / dimensions /
   processedUpToDatetime），GraphQL schema 里没有 vectorize 数据集（2026-10-01 实测：
   `unknown field "vectorizeAdaptiveGroups"`）。因此该维度每轮都写成 `CLOSED`，
   `current_usage` 存哨兵值 `-1.0`（表结构 `current_usage REAL NOT NULL`，不能存 NULL；
   **绝不补 0**——0 会冒充"官方实测为零"）。报表里仍给出 vectorCount 等库存证据与
   "每次语义查询 topK 上限 50 × 1024 维 = 51,200 维" 的内部估算参考，但**估算永不参与熔断判定**。
4. 多端分摊报表读的是 `quota_client_usage_hourly`（Phase 2 Worker 记的**内部流水**），
   只用于"谁调了多少"的归因展示，**不是官方真值，永不驱动熔断**。表还没上线时报表
   如实标注 `unavailable`，不影响熔断判定。

## 四、95% 拉闸逻辑（动静分离）

- **只有官方真值真实触及红线才拉闸**：`usage >= threshold_95` 才把该维度
  `quota_circuit_state.state` 置 `OPEN`；其余一切情况（低于阈值、无电表、API 失败）一律
  `CLOSED`，并刷新 `current_usage` / `as_of` / `updated_at`。四行每次全量 UPSERT，天然幂等。
- **只熔断高算力端点，生命线不连坐**：`OPEN` 生效后，Worker 侧只拦截依赖该维度的路由
  （如 `mcp:search_documents_semantic` → `ai.neurons` + `vectorize.queries`），返回
  `QUOTA_CIRCUIT_OPEN`；行情、心跳、状态探针、只读文档等生命线**永久放行**。
- **自愈**：AI 维度是 UTC 日窗口，跨天后官方用量归零，下一轮对账自动把 `OPEN` 翻回
  `CLOSED`；D1 维度在订阅周期滚动后同理。没有任何需要人工复位的开关。
- 每轮写 D1 前先读旧状态，状态发生翻转时在控制台打印
  `state change: <dimension> <OLD> -> <NEW>`，报表 JSON 也会带 `previous_circuit_states`。

## 五、产物

- `reports/quota-reconcile/reconcile-<YYYYMMDDTHHMMSSZ>.json`：机器可读全量对账报告
  （官方逐日/逐时明细、四维判定、多端分摊、写库结果）。
- `reports/quota-reconcile/reconcile-<同戳>.md`：人读版（维度表 + 分摊表 + 官方证据）。
- 本目录 ASCII 输出由脚本生成（计划任务环境安全）；口径解释以本 README 为准。

## 六、已知边界

- GraphQL 分析数据有 Cloudflare 侧的事件到达延迟（官方口径为分钟级），12 小时一次的
  对账对该延迟不敏感。
- `src/quota-dimensions.ts` 目录里 Vectorize 查询维额度登记为 5,000 万维（旧准入目录，
  键名 `vectorize.queried_dims`）；本脚本按规格书 §3.2 契约使用键名 `vectorize.queries`
  与 3,000 万维口径。两处口径差异已在上方表格注明，改动任一处需同步另一处。
- `quota_circuit_state` 的消费方（Worker 熔断拦截）属 Phase 4 演练验收范围，本脚本只
  负责把状态表维护到最新真值。
