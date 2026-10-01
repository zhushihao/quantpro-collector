# 配额解封与基线刷新证据（Issue #54 · 阶段 1）

- **执行时间**：2026-10-02（本机 CST）/ 2026-10-01T16:50Z（UTC，基线时间戳口径）
- **执行环境**：RESEARCH（`D:\quantpro-collector`，本机）
- **关联 Issue**：`zhushihao/quantpro-collector#54`（阶段 1「救急与基线刷新」）
- **结论**：生产 D1 `quota_period_baselines` 已完成官方对账刷新（14 行，`Rows written: 14`），
  `get_gateway_status` 中 `d1.rows_read` / `d1.rows_written` 由 `CLOSED` 变为 `OPEN`；
  五维准入探针全 PASS；`heavy_bounded` 路由端到端放行实证（见 §6）。
- **红线声明**：本次所有 Cloudflare 侧调用均为**只读**（订阅/账单/GraphQL Analytics）；
  唯一写操作是经 `wrangler d1 execute --remote` 向生产 D1 的基线表 UPSERT。
  凭据只从环境变量读取，未打印、未落盘（§7 有脱敏核验）。

---

## 1. 事故与判据（为什么必须刷新）

准入 guard（`quantpro-collector/src/quota-admission.ts:326-366` `buildGuardSql`）对
每个 `billing_cycle` 维度要求：

```
b.state='VERIFIED' AND b.coverage_end BETWEEN (now-26h) AND now
                   AND b.as_of BETWEEN b.coverage_end AND now
```

26 小时保鲜窗定义于 `src/quota-admission.ts:100-104`
（`BASELINE_COVERAGE_AGE_MS.billing_cycle = 26h`）。

刷新前生产 D1 全部 14 个 `cycle:*` 维度的 `coverage_end = 2026-09-30T03:30:51Z`，
距执行时刻（2026-10-01T16:50Z）已 ~37.3 小时 → **全部 `CLOSED`**，
`get_gateway_status` 显示 `reason: "baseline coverage is missing, stale or future-dated"`，
所有 `heavy_bounded` 路由返回 `QUOTA_GUARD_UNAVAILABLE`（Issue #54 事故现场）。

## 2. 对账取数（真实 Cloudflare 只读）

凭据：环境变量 `CLOUDFLARE_API_TOKEN` 存在（len=53，未打印值）。

| 数据源 | 端点 | 用途 |
|---|---|---|
| 订阅锚点 | `GET /accounts/{id}/subscriptions` | 复核账期 `2026-09-13T15:01:34Z..2026-10-13T00:00:00Z` 未变 |
| 账单行 | `GET /accounts/{id}/billable-usage` | 逐产品官方计量行（73 行，覆盖至 09-30） |
| Workers | GraphQL `workersInvocationsAdaptive` | requests / cpuTimeUs（日粒度） |
| D1 读写 | GraphQL `d1AnalyticsAdaptiveGroups` + `d1QueriesAdaptiveGroups` | rowsRead / rowsWritten（双数据集取大） |
| D1 存储 | GraphQL `d1StorageAdaptiveGroups` | databaseSizeBytes（周期内峰值） |
| KV | GraphQL `kvOperationsAdaptiveGroups` / `kvStorageAdaptiveGroups` | read/write/delete/list 与 byteCount |
| R2 | GraphQL `r2OperationsAdaptiveGroups` / `r2StorageAdaptiveGroups` | Class A/B 与 payload+metadata |
| Vectorize | GraphQL `vectorizeV2QueriesAdaptiveGroups` / `vectorizeV2StorageAdaptiveGroups` | queried / stored dims |
| AI | GraphQL `aiInferenceAdaptiveGroups` | neurons（记账参考，不写基线） |

取数脚本：`scripts/quota_reconcile_refresh.py`（新增，只读）。
原始取证：`docs/reports/2026-10-02-quota-unblock-raw.json`。

### 2.1 粒度判据（重要，决定求和方式）

执行中实测到三种官方口径分歧，逐条做了判别实验后才定口径：

1. **Vectorize `datetimeHour` 桶是「UTC 日内累计值」而非小时增量**。
   判据：09-30 当日最后一个小时桶 `1,771,520` ≈ 同日 `date` 粒度合计 `1,827,840`；
   若逐时求和会得到 `28,656,640`（虚增 15.7 倍）。故 **只按 `date` 粒度求和**
   （`vectorize_queried_dims_day_grain = 4,517,888`）。
2. **D1 双数据集交叉验证成立**。`d1AnalyticsAdaptiveGroups`（日粒度）与
   `d1QueriesAdaptiveGroups` 在 09-30 与账单行**完全相等**（`9,614,443` 行读）；
   但全周期合计略有差异（`67,900,807` vs `67,414,196`），取 **较大值**（fail-closed）。
3. **账单 API 有滞后**：`billable-usage` 73 行仅覆盖至 09-30（D1 读行 25 亿包含量下
   仅累计 `20,955,425`，而 GraphQL 同期 `67.9M`），缺失日不可当零，
   故基线 `used` 取 GraphQL 大值，账单行作交叉参考。

### 2.2 保守水位策略（写入前逐维计算）

- `used = max(旧 VERIFIED 值, 新观测值)` —— 单调不减，任何较小的新读数都不能放宽余量。
- `unobserved_upper_bound = max(旧尾部值, 规则尾部)`，
  规则尾部（沿用 2026-09-29 运维口径）：`ceil(max(日均×剩余天数×3, used×25%))`。
- `coverage_end = as_of = recorded_at = now`（毫秒级 `Z` 格式，与 guard 的
  `new Date().toISOString()` 文本比较口径一致）。
- 存储维度按 `峰值字节/1e9 × 已过周期占比` 折算 GB-month（千分位整数）。

## 3. 写入生产 D1

生成物：`docs/reports/2026-10-02-quota-unblock-refresh.sql`（14 行 UPSERT）。

执行命令（真实执行，非模拟）：

```
node node_modules/wrangler/bin/wrangler.js d1 execute quantpro-collector-research-replica \
  --remote --json --file docs/reports/2026-10-02-quota-unblock-refresh.sql
```

返回：`success: true`，`Total queries executed: 1`，`Rows written: 14`，`changes: 15`，
`served_by: v3-prod / APAC / HKG`。执行前快照留存于
`docs/reports/2026-10-02-quota-baselines-before.json`，执行后
`docs/reports/2026-10-02-quota-baselines-after.json`。

### 3.1 刷新前后对照（周期键 `cycle:2026-09-13T15:01:34Z..2026-10-13T00:00:00Z`）

| 维度 | used（旧→新） | 尾部（旧→新） | 新 `used+尾部` | 95% 阈值 | 占比 |
|---|---|---|---|---|---|
| workers.requests | 101,409 → 130,092 | 266,000 → 266,000 | 396,092 | 9,500,000 | 4.17% |
| workers.cpu_ms | 1,148,306 → 1,570,302 | 3,014,000 → 3,014,000 | 4,584,302 | 28,500,000 | 16.09% |
| d1.rows_read | 491,844,015（保持） | 131,000,000（保持） | 622,844,015 | 23,750,000,000 | 2.62% |
| d1.rows_written | 10,686,563（保持） | 1,570,000 → 2,671,641 | 13,358,204 | 47,500,000 | 28.12% |
| d1.storage_gb_month | 35 → 50 | 270 → 270 | 320 | 4,750 | 6.74% |
| kv.reads | 2,624 → 2,680 | 26,600 → 26,600 | 29,280 | 9,500,000 | 0.31% |
| kv.writes | 2,279（保持） | 23,100 → 23,100 | 25,379 | 950,000 | 2.67% |
| kv.deletes | 0（保持） | 10,000 → 10,000 | 10,000 | 950,000 | 1.05% |
| kv.lists | 2（保持） | 500 → 500 | 502 | 950,000 | 0.05% |
| kv.storage_gb_month | 1（保持） | 10 → 10 | 11 | 950 | 1.16% |
| r2.class_a | 96,504（保持） | 153,000 → 153,000 | 249,504 | 950,000 | 26.26% |
| r2.class_b | 39,648（保持） | 3,700 → 9,912 | 49,560 | 9,500,000 | 0.52% |
| r2.storage_gb_month | 160 → 335 | 900 → 900 | 1,235 | 9,500 | 13.00% |
| vectorize.queried_dims | 824,320 → 4,517,888 | 2,125,000 → 8,472,117 | 12,990,005 | 47,500,000 | 27.35% |

新 `coverage_end` / `as_of` 全部为 `2026-10-01T16:50:06.636Z`（执行时刻）。
所有维度的 `used+尾部` 均低于各自 95% 红线；缺口最大的 `d1.rows_written` 为 28.12%。

## 4. 准入条件复现探针（只读 SQL）

`docs/reports/2026-10-02-quota-guard-probe.sql` 用与 `buildGuardSql` **逐条相同的四个合取项**
（catalog 版本匹配 / 基线 VERIFIED 与 26h 窗 / 记账+基线+本次单位 ≤ 阈值 / 行数上限），
参数取执行时刻真实时钟，对生产 D1 执行（`--command`，只读 SELECT）：

| 维度 | catalog | baseline | committed | thr | 判定 |
|---|---|---|---|---|---|
| d1.rows_read | ✓ | ✓ | 1,202,838,278 | 23,750,000,000 | PASS |
| d1.rows_written | ✓ | ✓ | 26,046,705 | 47,500,000 | PASS |
| kv.reads | ✓ | ✓ | 29,312 | 9,500,000 | PASS |
| r2.class_a | ✓ | ✓ | 300,733 | 950,000 | PASS |
| vectorize.queried_dims | ✓ | ✓ | 13,055,541 | 47,500,000 | PASS |

`ALL_CONJUNCTS PASS`（探针时刻 2026-10-01T16:53:34Z）。

## 5. get_gateway_status 验证（MCP，任务指定检查）

命令：MCP 工具 `get_gateway_status`（`mcp__collector__get_gateway_status`），
在生产服务上真实调用两次（刷新前 / 刷新后）。

| 维度 | 刷新前 | 刷新后 | 刷新后 reason |
|---|---|---|---|
| d1.rows_read | **CLOSED** | **OPEN** | verified baseline with headroom |
| d1.rows_written | **CLOSED** | **OPEN** | verified baseline with headroom |
| kv.reads | CLOSED | OPEN | verified baseline with headroom |
| kv.writes | CLOSED | OPEN | verified baseline with headroom |
| kv.deletes | CLOSED | OPEN | verified baseline with headroom |
| kv.lists | CLOSED | OPEN | verified baseline with headroom |
| r2.class_a | CLOSED | OPEN | verified baseline with headroom |
| r2.class_b | CLOSED | OPEN | verified baseline with headroom |
| vectorize.queried_dims | CLOSED | OPEN | verified baseline with headroom |
| ai.neurons | OPEN | OPEN | （utc-day 运行时自举，未受影响） |

**仍为 CLOSED 的维度属于设计性封闭，不是本次事故残留**：
`workers.*`、`d1.storage_gb_month`、`kv.storage_gb_month`、`r2.storage_gb_month` 的
reason 是 `dimension has no provable per-operation bound`（catalog `provable=false`，
`src/quota-dimensions.ts:127-206`），`r2.ia_*` / `vectorize.stored_dims` 是无包含量或
无单次可证上界（reason `baseline state is missing`）。这些维度本就不允许被准入命名，
与 26h 保鲜无关，改动它们需要规格级决策。

服务其余状态：`mode: "enforce"`、`quantified_guarantee: false`、`anchor_verified: true`，
`service_build_sha: 57d0833acf4b8367c027f22d69a418a0a3e8f40e`。

## 6. 端到端放行实证（heavy_bounded 真实路由）

刷新后经 MCP 调用 `search_documents_semantic`（`heavy_bounded`，声明
`d1.rows_read 32 + d1.rows_written 32 + ai.neurons 94 + vectorize.queried_dims 1024`，
`src/quota-entrypoints.ts:326-331`）：

- 返回业务结果 `{"matches": [], "index_status": "PARTIAL"}` —— **不是** `QUOTA_GUARD_UNAVAILABLE`。

生产 D1 结算日志（`quota_reservation_journal`，`recorded_at > 16:45Z`）逐条可查：

```
2026-10-01T16:54:03.365Z  mcp:search_documents_semantic  SETTLED  declared_bound_charged
  expected: ai.neurons 94 | d1.rows_read 33857 | d1.rows_written 19 | vectorize.queried_dims 1024
  observed: ai.neurons 94 | d1.rows_read 33857 | d1.rows_written 19 | vectorize.queried_dims 1024
```

即该次调用完成了 `预留 → 业务执行 → 按声明上界记账 → 结算` 全链路。
同期（16:53:42Z–16:55:27Z）另有 22 条 `http:/internal/research-replica/v2/ingest`
路由 `SETTLED`（`ingest_completed`，声明 `d1.rows_read 43825` 等，实际观测值远低于声明），
证明业务流量在解封后已恢复。

记账侧交叉验证：`ai.neurons` 与 `vectorize.queried_dims` 的 booked 增量与
`search_documents_semantic` 的声明单位**精确吻合**：

| 维度 | 16:50Z 前 booked | 结算后 booked | 增量 | 说明 |
|---|---|---|---|---|
| ai.neurons | 1,128（12 次预约） | 1,222（13 次预约） | **+94** | 该维度仅 `search_documents_semantic` 使用 |
| vectorize.queried_dims | 64,512（63 次） | 65,536（64 次） | **+1,024** | 同上，且仅此一条路由 |

`booked` 的语义（与代码核对）：准入时按**声明上界**全额计入；结算时
`settleReservation` 会把未使用的头寸减记回去（`UPDATE quota_booked_usage
SET booked_units = MAX(0, booked_units - unused)`，`src/quota-admission.ts:948-962`，
commit `31fc15d`）。因此 `d1.rows_read` 的 booked 在 16:54–16:56 区间内从
`580,071,937` 回落到 `580,028,193`（同批 ingest 路由的声明上界远大于实际观测：
声明 43,825/次，观测仅 3–11/次），这是**正常减记**而非异常。
`d1.rows_read` / `d1.rows_written` 的 booked 增量因此不能直接读数，只有
`ai.neurons` / `vectorize.queried_dims` 两条"仅此路由使用"的维度才是单路由归因证据。

## 7. 安全与合规核验

- 凭据：仅从 `CLOUDFLARE_API_TOKEN` 环境变量读取；脚本/证据文件中无 token、
  无 account id（`docs/reports/2026-10-02-quota-unblock-raw.json` 已程序化核验：
  不含账号 ID、不含 ≥40 字符 token 样串）。
- 未执行任何下单、未改调度 Prompt、未恢复 :55 观察器、未关 research #10。
- Cloudflare 侧零写入：订阅/账单为 GET，Analytics 为 GraphQL 查询；
  唯一写入为生产 D1 基线表（Issue #54 阶段 1 授权范围）。
- 防爆破红线保持：本次只做了"用真实数据把 `used` 与尾部抬高到真实水位"，
  95% 阈值与 `provable` catalog 未做任何放宽；真实超额仍会 `QUOTA_CIRCUIT_OPEN`。

## 8. 遗留与后续（阶段 2/3，Issue #54 未完成部分）

1. **26h 硬阻断仍在代码中**（`src/quota-admission.ts:100-104, 344-345`）。
   本次是"用刷新把窗户纸重新糊上"，不是拆机制。超过 26h 未刷新仍会全量 CLOSED。
   阶段 2 需把 `BASELINE_COVERAGE_AGE_MS` 从硬阻断降级为 `quota_baseline_stale` 告警。
2. **生命线免检未实施**：`submit_run_envelope` 仍为 `heavy_bounded`
   （`src/quota-entrypoints.ts:256-260`），空心跳仍走全量多维预留。
   阶段 2 需做动静分流（`lifeline_heartbeat`）。
3. **自动对账未挂载**：本脚本是人工触发。阶段 3 需挂常驻调度（每 12h）
   并把本脚本纳入自动化；脚本已按幂等 UPSERT + 单调水位设计，可重复执行。
4. **本脚本可重复运行**：`python scripts/quota_reconcile_refresh.py --write`
   会重新生成当时刻的 SQL 与证据（旧值保留在 `docs/reports/*-before.json`）。
5. 刷新后 26h 有效期至 **2026-10-02T18:50Z**（≈ 北京时间 2026-10-03 02:50）；
   若阶段 2 未按期落地，需要重跑本脚本续期。

## 9. 复现命令清单

```bash
# 1) 只读对账 + 生成刷新 SQL（需环境变量 CLOUDFLARE_API_TOKEN）
cd D:/quantpro-collector
python scripts/quota_reconcile_refresh.py --write

# 2) 写入生产 D1（唯一写操作）
node node_modules/wrangler/bin/wrangler.js d1 execute quantpro-collector-research-replica \
  --remote --json --file docs/reports/2026-10-02-quota-unblock-refresh.sql

# 3) 读取刷新后状态
node node_modules/wrangler/bin/wrangler.js d1 execute quantpro-collector-research-replica \
  --remote --json --command "SELECT dimension_key,state,used,unobserved_upper_bound,coverage_end FROM quota_period_baselines WHERE period_key LIKE 'cycle:%' ORDER BY dimension_key"

# 4) 状态验证：MCP get_gateway_status（需 state:read scope）
```

## 10. 证据文件索引

| 文件 | 内容 |
|---|---|
| `scripts/quota_reconcile_refresh.py` | 只读对账 + SQL 生成器（本次新增） |
| `docs/reports/2026-10-02-quota-unblock-refresh.sql` | 实际执行的 14 行 UPSERT |
| `docs/reports/2026-10-02-quota-unblock-raw.json` | 原始取数（脱敏，含各口径判据数据） |
| `docs/reports/2026-10-02-quota-baselines-before.json` | 刷新前生产基线快照 |
| `docs/reports/2026-10-02-quota-baselines-after.json` | 刷新后生产基线快照 |
| `docs/reports/2026-10-02-quota-guard-probe.sql` | 准入四合取项只读探针 |
