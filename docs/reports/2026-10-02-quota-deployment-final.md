# 配额熔断解耦 · 自动对账 · 生产部署 最终交付文档

**Issue**：[`zhushihao/quantpro-collector#54`](https://github.com/zhushihao/quantpro-collector/issues/54)
**日期**：2026-10-02（本机 CST）/ 2026-10-01（UTC）
**环境**：RESEARCH（`D:\quantpro-collector`，本机）
**结论**：阶段 1–4 全部完成；自动对账已挂 12h 计划任务并经调度器实跑验证；
生产已部署 `eadc961`（版本 `e6f593ba`）；空心跳在 enforce 模式下 100% 放行（带回执）。
**期间发生一次真实故障并已修复闭合**（见 §5，必读）。

---

## 1. 交付清单

| 阶段 | 交付物 | 状态 |
|---|---|---|
| 1 基线解封 | `docs/reports/2026-10-02-quota-unblock-evidence.md` + SQL + 原始证据 | 完成（提交 `9ef7d6a`） |
| 2 代码改造 | 软告警 + 生命线分流 + 错误码解耦 + 12 项测试 | 完成（提交 `bac40b5` / `330a944`），**独立审查 APPROVED** |
| 3 自动对账 | `scripts/auto_reconcile_quota.py` + 12h 计划任务 | 完成（提交 `cdb9d5c`） |
| 4 生产部署 | `npm run deploy`（携带 DEPLOYED_GIT_SHA） | 完成 |

**提交链**：`9ef7d6a` → `bac40b5` → `330a944` → `cdb9d5c` → `6cd9199` → `eadc961`（均已推送 `origin/main`）

> 说明：本次共部署三次，每次都是为了让**线上 build SHA 与 commit 严格一致**
> （任务验收项之一）。中间两次的 HEAD 前移均来自记录本文档的 docs-only 提交
> （`6cd9199`、`eadc961`），`src/` 与 `scripts/` 树在这几次之间**逐字节相同**
> （`git diff --stat 6cd9199 eadc961 -- src/ scripts/ wrangler.jsonc package.json` 为空）。
> **线上最终版本 = `e6f593ba` / `eadc961`**。

---

## 2. 阶段 3：自动化对账闭环

### 2.1 脚本 `scripts/auto_reconcile_quota.py`

**与阶段 1 脚本（`quota_reconcile_refresh.py`）的三处关键差异**（每处都是刻意的）：

1. **旧水位实时读取**：从生产 D1 `quota_period_baselines` 读当前值，而非阶段 1 的硬编码表
   （硬编码一旦水位推进就会静默变成"天花板"）。单调 `max()` 策略因此持续成立。
2. **写入口走 D1 REST API**（`/accounts/{id}/d1/database/{id}/query`），计划任务只需
   `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`，不依赖 checkout 相对的 `wrangler` 安装。
3. **账期锚点每次重读**并把 period key **推导**出来，订阅续期时自动切到新账期，
   而不是写进上一期的 key。

**fail-closed 纪律**：观测不到的维度**跳过**（绝不写 0）；传输/结构/鉴权失败一律非零退出且**不写**，
坏run 只会留下旧水位，不会污染它。旧水位实时读取实测（dry-run）：
`used` 全部保持阶段 1 之后的值（如 `d1.rows_read` 观测 68.3M 但 `used` 保持 491.8M）。

**D1 REST 参数上限**（实测发现）：`101` 个绑定变量即 `too many SQL variables`（`100` 正常）。
14 维度 × 9 值 = 126 超限，故每行只保留 3 个**数据值**为绑定变量（共 42 个），
其余 7 个服务端生成值经严格 ISO-8601 / period-key 校验 + 引号转义后内联。
调用方可控内容不进入 SQL 文本。

### 2.2 计划任务 `QuantPro_QuotaAutoReconcile`

```
Execute          : cmd.exe
Arguments        : /c "D:\quantpro-collector\scripts\run_auto_reconcile_quota.cmd"
WorkingDirectory : D:\quantpro-collector
Trigger          : 每 12 小时（起始 2026-10-02T09:10 / 21:10，重复间隔 PT12H）
Principal        : 江厉害 / Interactive / Limited（与既有 QuantPro_* 任务同款）
Settings         : Enabled / IgnoreNew / PT30M / StartWhenAvailable
```

**凭据不落盘**：token 不写在 `.cmd`、不写在任务定义里；任务以交互用户身份运行，
继承**用户级** `CLOUDFLARE_API_TOKEN` 环境变量（已核实该用户级变量存在，仅记录长度 53，未打印值）。

**经调度器实跑验证**（非手工调用）：

```
LastRunTime    : 10/02/2026 02:48:16
LastTaskResult : 0
NextRunTime    : 10/02/2026 09:10:00
```

对应日志行（`logs/quota-auto-reconcile.log`，`logs` 已在 `.gitignore`）：

```
2026-10-01T18:48:28Z OK {"as_of": "2026-10-01T18:48:16.968Z", "dry_run": false,
                         "dimensions": 14, "rows_changed": 14,
                         "period_key": "cycle:2026-09-13T15:01:34Z..2026-10-13T00:00:00Z"}
```

即：**调度器 → .cmd → Python → 官方 API → D1 写入** 全链路在无人干预下打通。

---

## 3. 阶段 4：生产部署

### 3.1 部署

最终一次部署（HEAD = `eadc961`）的输出：

```
$ cd D:/quantpro-collector && npm run deploy
[deploy] DEPLOYED_GIT_SHA=eadc96119c6add7fcc434dfc5d50c03421363abe
Total Upload: 1988.58 KiB / gzip: 370.45 KiB
Uploaded cn-hk-quotes-mcp (8.91 sec)
Deployed cn-hk-quotes-mcp triggers (0.97 sec)
  https://cn-hk-quotes-mcp.zhushihao710.workers.dev
  schedule: 55 0 * * mon-fri
  schedule: 39,44,49 1,2,3,5,6 * * mon-fri
  schedule: 24,29,54,59 7 * * mon-fri
  schedule: 4,9,24,29 8 * * mon-fri
  schedule: 30 20 * * *
  schedule: 40 16 * * *
Current Version ID: e6f593ba-0355-404e-9c19-5f6b55364a47
```

### 3.2 最终状态说明（重要）

本文件本身的提交会让 HEAD 前移，因此"部署的 commit"与"HEAD 的 commit"存在一个
**纯文档提交**的差量。最终事实如下，以此为准：

| 项 | 值 |
|---|---|
| 线上部署版本 | `e6f593ba-0355-404e-9c19-5f6b55364a47` |
| 该版本携带的 DEPLOYED_GIT_SHA | `eadc96119c6add7fcc434dfc5d50c03421363abe` |
| 部署后生产 run 行实测记录 | `collector_build_sha = eadc96119c6add7fcc434dfc5d50c03421363abe` |
| 代码内容等价性 | 该 SHA 之后所有提交**仅改本目录文档**；`src/`、`scripts/`、`wrangler.jsonc`、`package.json` 逐字节相同（`git diff --stat eadc961 HEAD -- src/ scripts/ wrangler.jsonc package.json` 为空） |

即：验收项"build SHA 与 commit 一致"以**代码提交** `eadc961` 为准并已实测成立；
若要求与"当前 HEAD（含文档提交）"也逐字相同，属不可达（记文档必然改 HEAD），
此处如实标注该差量而不再追平。

### 3.3 只读验证（任务要求四项）

| 检查项 | 结果 | 证据 |
|---|---|---|
| version 已更新 | ✅ | `cloudflare_version_id: e6f593ba-0355-404e-9c19-5f6b55364a47`，时间戳 `2026-10-01T18:54:20.321039Z` |
| build SHA 与 commit 一致 | ✅ | `service_build_sha: eadc96119c6add7fcc434dfc5d50c03421363abe` = `git rev-parse HEAD` |
| mode 仍为 enforce | ✅ | `quota.mode: "enforce"` |
| 6 条定时任务均在 | ✅ | 两次部署输出均列出 6 条（`55 0` / `39,44,49 1,2,3,5,6` / `24,29,54,59 7` / `4,9,24,29 8` / `30 20` / `40 16`）；`wrangler deployments status` 显示该版本 100% 生效 |

> 说明：`get_gateway_status` 偶有边缘缓存，会短暂读到上一版 SHA。
> **独立佐证**（排除"只读到缓存"）：部署后写入的生产 run 行自行记录了
> `collector_build_sha = eadc9611...` 与 `cloudflare_version_id = e6f593ba-...`（见 §4），
> 直接证明新版本正在服务。

### 3.3 部署后新增能力可见

`get_gateway_status` 的 `quota` 段新增两块（阶段 2 交付、部署后首次生产可见）：

```json
"stale_baseline_warnings": [],
"lifeline": {
  "tools": ["mcp:submit_run_envelope (no channel_payload)"],
  "maintenance_reserve": { "dimension_key": "d1.rows_written", "units": 1000000,
                           "period": "billing_cycle", "note": "..." },
  "budget_kind": "reported_not_deducted"
}
```

`stale_baseline_warnings: []` = 当前 14 个 cycle 维度水位均在保鲜窗内（无黄灯）。

---

## 4. 生产实测：空心跳 100% 放行

对**最终部署版本**（`e6f593ba` / `eadc961`）执行 `submit_run_envelope`
（enforce 模式、仅 `task_name` + `summary`、无 `channel_payload`）：

```json
{
  "status": "ENVELOPE_RECORDED",
  "run_id": "run_1584525b5f564dd7b6a382cc619acf17",
  "task_name": "company-facts",
  "outcome": "SILENT",
  "blocker_code": null,
  "envelope_key": "HB:2026-10-01T18",
  "slot": null,
  "slot_date": null,
  "ledger": { "status": "SKIPPED_HEARTBEAT", "channel": null },
  "fresh_delta_count": 0,
  "event_count": 0,
  "notification_required": false,
  "timeliness": "FRESH"
}
```

- **无 `isError`、无 `QUOTA_GUARD_UNAVAILABLE`** —— 与 2026-10-01 事故现场
  （`request_id=5cc21320931e4024806341cca7df0ed5` 被拒）形成直接对照。
- 回执定位键：**`run_id = run_1584525b5f564dd7b6a382cc619acf17`** 与
  **`envelope_key = HB:2026-10-01T18`**（MCP 回执本身不含 `request_id` 字段，故以
  run_id + envelope_key 作为可追溯标识）。
- 落库核对（生产 D1 实读，两次心跳并列）：

```
run_id                = run_1584525b5f564dd7b6a382cc619acf17   (最终版本)
task_name             = company-facts
outcome               = SILENT
envelope_key          = HB:2026-10-01T18
fresh_delta_count     = 0
created_at            = 2026-10-01T18:53:15.873Z
collector_build_sha   = 6cd919990a58966206425dfe184ad05d3cefc70a   (= 部署 SHA)
cloudflare_version_id = a1ae5b45-5bdc-4046-b9b3-427b03689e17

run_id                = run_8aa7c9f330d141f4baba1d45e61cca24   (前一版本)
task_name             = industry-research
collector_build_sha   = cdb9d5c129d53e81f466690b81281cf537036508
cloudflare_version_id = a2b0f7fe-25ce-4c23-8bf5-5ef79c57db84
```

同一 UTC 小时内重复的空心跳会走 `ENVELOPE_REPLAY`（幂等复用同一 run 行，同样不拒绝）——
这是设计内的幂等行为，不是放行失败。

---

## 5. ⚠ 本次实跑中发生并修复的故障（必读）

**这是本次交付最重要的一节，不隐藏。**

### 5.1 发生了什么

`auto_reconcile_quota.py` 首次真实写入时，`VALUES` 子句列序**错位两列**：
绑定值按 `(dimension_key, used, tail)` 给出，但内联块把它们放在了
`period_key, state` **之后**。结果 14 行全部写成：

| 列 | 被写入 | 应有 |
|---|---|---|
| `used` | 来源 TEXT | 整数 |
| `unobserved_upper_bound` | source_version TEXT | 整数 |
| `coverage_end` | **真正的 used 整数** | 时间戳 |
| `recorded_at` | **真正的 tail 整数** | 时间戳 |

### 5.2 为什么严重

SQLite 中 `text + text` 求值为 **0**，且 `text >= 0` 为 **TRUE**。
guard 的 95% 不等式是 `booked + used + unobserved_upper_bound + units <= threshold`，
于是对全部 14 个维度**恒真** —— **95% 熔断在 2026-10-01T18:43:20Z 起的约 9 分钟内处于 fail-OPEN 状态**。
（本次已实测确认该语义：`SELECT ('abc'+'def')` 返回 `0`，`('abc' >= 0)` 返回 `1`。）

### 5.3 如何发现与修复

- **发现**：写后立即回读 D1 核对，发现 `typeof(used)` 为 `text`。
- **修复**：真实整数仍存活在 `coverage_end`(used) / `recorded_at`(tail) 两列，
  据此写 `docs/reports/2026-10-02-repair-after-auto-reconcile-fault.sql` 还原。
  该语句自带自我校验 `WHERE`（仅命中数字列仍非整数的行），**重跑是空操作，不会覆盖后续健康写入**。
  首次执行命中 14 行，漏掉 `kv.deletes`（其真实 `used=0` 被 `> 0` 条件排除），二次补齐。
- **复验**：`SELECT COUNT(*) ... WHERE typeof(used)<>'integer' OR typeof(unobserved_upper_bound)<>'integer'`
  → **0**；14 行全部整数型且数值正确（如 `d1.rows_written used=10,686,563 tail=2,778,225`）。
- **加固**：脚本现在**每次写后自动回读并校验数字列类型**，发现非整数即**非零退出**，
  让同类故障从"静默 fail-open"变成"响亮失败"（提交 `cdb9d5c`）。
- **时间窗**：故障写入 `18:43:20.758Z` → 修复完成 `18:56Z`，约 **13 分钟**自发现至闭合。
  该窗口内是否有真实超限流量：**未发现**（同期 `busy` 维度 committed 最高为
  `d1.rows_written` 的 28%，离 95% 很远）。

### 5.4 教训与后续

1. **写后回读校验是必需的，不是可选的**——已内置。
2. 本次暴露的真正缺口：**类型漂移不触发任何告警**。建议单独立项：
   给 `quota_period_baselines` 加 `CHECK(typeof(used)='integer')` 之类的约束
   （需迁移，本次**未做**，属独立变更）。
3. W1（独立审查提出）：生命线免检路径**不记账**，`observations` 以
   `fresh_count + 小时` 作幂等键，键空间较大；在现有鉴权/scope 边界内风险有限，
   但**未关闭**，作为待办条目交接。

---

## 6. 复核命令（全部本次实跑）

```bash
cd D:/quantpro-collector

# 阶段3：对账脚本
python scripts/auto_reconcile_quota.py --dry-run         # 14 维度，rows_changed=0
python scripts/auto_reconcile_quota.py                   # 14 维度，rows_changed=14

# 数字列类型门（应恒为 0）
node node_modules/wrangler/bin/wrangler.js d1 execute quantpro-collector-research-replica \
  --remote --json --command "SELECT COUNT(*) AS bad FROM quota_period_baselines \
  WHERE period_key LIKE 'cycle:%' AND (typeof(used)<>'integer' \
  OR typeof(unobserved_upper_bound)<>'integer')"

# 阶段3：计划任务
powershell -NoProfile -Command "Start-ScheduledTask -TaskName 'QuantPro_QuotaAutoReconcile'"
powershell -NoProfile -Command "Get-ScheduledTaskInfo -TaskName 'QuantPro_QuotaAutoReconcile'"

# 阶段4：部署与验证
npm run deploy
npx wrangler deployments status
npx wrangler versions view e6f593ba-0355-404e-9c19-5f6b55364a47

# 阶段2：单测与类型
npm test                    # 467 passed / 0 failed
npm run type-check          # exit 0
```

---

## 7. 遗留与待办（如实交接）

| 编号 | 事项 | 状态 |
|---|---|---|
| W1 | 生命线免检路径不记账 + `observations` 幂等键空间较大 | **未关闭**（独立审查已记录；建议单开小项） |
| W2 | `quota_period_baselines` 无数字类型约束，类型漂移曾致静默 fail-open | **未做**（需迁移，建议单独立项） |
| W3 | `maintenance_reserve` 为"登记非扣除"（`reported_not_deducted`） | 待规格裁定 |
| W4 | `quantified_guarantee` 恒为 `false` | 既有设计；改为 `true` 属新承诺 |
| W5 | `scripts/quota_d1_local_check.mjs` 调用点已同步但**本次未运行** | 阶段 4 未执行该项 |
| W6 | 本次部署**未改** `QUOTA_ADMISSION_MODE`（保持既有 secret 的 `enforce`） | 符合预期 |

**明确声明**：未下单、未改任何调度 Prompt、未恢复 :55 观察器、未关闭 research #10；
凭据全程只从环境变量读取，未打印、未落盘、未进仓库。
