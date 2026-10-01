# 配额熔断解耦与生命线免检实现证据（Issue #54 · 阶段 2）

- **执行时间**：2026-10-02（本机 CST）
- **执行环境**：RESEARCH（`D:\quantpro-collector`，本机）
- **关联 Issue**：`zhushihao/quantpro-collector#54`（阶段 2「代码修改与单元测试」）
- **结论**：四条规格全部落地，`npm test` **467 通过 / 0 失败**（改动前基线 457 通过 / 0 失败），
  `npm run type-check` 退出码 0，oxlint 无新增问题。
- **未部署**：本次只改代码与测试，**未执行任何部署**（阶段 4 另行授权）。

---

## 1. 变更总览

| 文件 | 变更 | 对应规格项 |
|---|---|---|
| `src/quota-admission.ts` | 废除 26h 硬阻断；引入 `baselineWarnings` 软告警；错误码解耦（新增 `cap` 原因） | §1 |
| `src/quota-entrypoints.ts` | 新增 `isLifelineEnvelope` / `runEnvelopeAdmissionRoute` / `LIFELINE_MAINTENANCE_RESERVE` | §2 |
| `src/index.ts` | 生命线分流接入 MCP 包装器；错误码映射注释；`get_gateway_status` 透出 stale 告警与维护预留 | §2 |
| `src/quota-breaker.ts` | 桶文件导出新符号 | — |
| `tests/*.mjs` | 新增 12 项测试（stale 放行 4 / guard 结构 1 / 真超额 1 / cap 归因 1 / 生命线 3 / 错误码解耦 2） | §3 |
| `scripts/quota_d1_local_check.mjs` | 同步 guard 调用点（去掉 `baseline_cutoff` / `now` 参数） | — |

## 2. §1 废除 26h 硬阻断，改为软告警

### 2.1 删除的硬阻断

改前（`src/quota-admission.ts` 旧版 `buildGuardSql`，本仓 commit `57d0833`）每个维度要求：

```sql
AND b.state = 'VERIFIED'
AND b.coverage_end BETWEEN r.baseline_cutoff AND ?N   -- ← 已删除
AND b.as_of BETWEEN b.coverage_end AND ?N             -- ← 已删除
```

改后（`src/quota-admission.ts:371-425`）只剩：

```sql
AND EXISTS (
  SELECT 1 FROM quota_period_baselines b
  WHERE b.dimension_key = r.dimension_key
    AND b.period_key = r.period_key
    AND b.state = 'VERIFIED'
)
```

`GuardParams` 不再携带 `baseline_cutoff` / `now`（`guardParameterValues` 参数减少），
`buildDiagnosisSql` 同步去掉 `baseline` 判定里的时效合取项，`admitOperation` 的
`entries` 也不再计算 cutoff。**周期滚动规则不变**：新 `period_key` 仍需其自己的
VERIFIED 行，所以"遗忘旧账期"依然不能开新账期（既有测试 `#1176` `reason: "baseline"` 仍绿）。

### 2.2 软告警面（`baselineWarnings`）

新增 3 类非阻断告警（`src/quota-admission.ts:110-165`）：

| 告警 | 触发条件 | 对准入的影响 |
|---|---|---|
| `STALE_BASELINE` | `now - coverage_end > 26h`（cycle/storage；utc_day 为 2h） | **无** |
| `BASELINE_COVERAGE_UNKNOWN` | `coverage_end` 为空或不可解析 | **无** |
| `BASELINE_COVERAGE_FUTURE` | `coverage_end > now`（运维数据错误） | **无** |

`DimensionStatus.warnings` 字段承载它们，`reason` 同步体现（如
`"verified baseline with headroom; STALE_BASELINE"`），`get_gateway_status` 额外输出
顶层 `stale_baseline_warnings` 数组并在非空时打 `quota_baseline_stale` 日志
（`event: "quota_baseline_stale"`, `informing: "warning_only_admission_unaffected"`）。

**关键不变量**：`state` 的判定条件里**没有**任何时效项（`src/quota-admission.ts:1527-1552`）：
只有 `state='VERIFIED' AND provable AND committed < threshold_95` 才 OPEN。即"基线旧"
永远不会被读成"维度关闭"。

### 2.3 95% 铁律保留（有专门测试）

原子不等式未动：`booked + used + unobserved_upper_bound + units <= threshold_95`
仍在同一个 `INSERT..SELECT` 里（`src/quota-admission.ts:409-417`）。
新测试 `#54 a stale baseline still hits the REAL ceiling` 证明：**即便基线已陈旧**，
越过阈值的那一步仍以 `reason: "limit"` 拒绝，且不留残余预留行。

### 2.4 错误码解耦

`AdmissionDenialReason` 新增 `"cap"`（`src/quota-admission.ts:234-250`）：

- `limit`（真实 95% 上限 / 未观察尾部储备） → `QUOTA_CIRCUIT_OPEN`（`src/index.ts:743-749`）
- `cap`（live 行读取上限，非额度） → `QUOTA_GUARD_UNAVAILABLE`
- `baseline` / `bound` / `storage` / `fault` / `conflict` → `QUOTA_GUARD_UNAVAILABLE`

改前 `cap` 被归入 `limit`（`classifyAdmissionFailure` 里的
`if (verdict === "cap") return denied("limit", ...)`），会把"并发槽位满"误报成"资金熔断"。
现已改为 `denied("cap", ...)`（`src/quota-admission.ts:896-900`）。

## 3. §2 submit_run_envelope 动态分流

### 3.1 分流判据（结构性，非"字段名白名单"）

`isLifelineEnvelope`（`src/quota-entrypoints.ts:452-462`）**只认一件事**：
`channel_payload` 是否缺席。因此三类良性报文全部天然命中：

- 纯心跳（省略 `channel_payload`）
- `blocked_by` 预写入阻断汇报
- `observations` 只读观察汇报

schema 本身保证三者互斥（`src/run-envelope.ts:613-632`），所以"空包"确实没有业务内容可写，
不存在"命名良性字段偷运业务数据"的路径。

### 3.2 接入点

`src/index.ts:922-945`（MCP 包装器内，`routeCostProfile` 之后、heavy 准入之前）：

```ts
const split = runEnvelopeAdmissionRoute(route, args[0] as LifelineProbeInput);
if (split.exempt) {
  console.log(JSON.stringify({ event: "quota_lifeline_exempt", ... }));
  return handler(...args);   // 不走 heavy 多维预留门
}
```

- 分流**只对 `mcp:submit_run_envelope` 生效**（`runEnvelopeAdmissionRoute` 对其它路由
  直接返回 `exempt: false`），`append_state_batch` 等仍走完整门。
- 免检不改变鉴权：handler 内部的 `requireStateScope(STATE_WRITE_SCOPE, ...)` 照常执行。
- 每次免检都留审计日志 `quota_lifeline_exempt`（含 request_id）。

### 3.3 维护预留额度（`maintenance_reserve`）的落地方式——**如实说明**

Issue #54 原文设想是"固定预留 100 万行写入预算，先扣除该预算后再对普通业务开放 95% 限额"。
本次实现**没有**做"扣除"式的余额改写，理由是：

1. 现状下生命线路径的真实成本就是**一行 run 行**的读写，且**每一次准入都已按单位记账**进
   `quota_booked_usage`（`buildBookedSql`，`src/quota-admission.ts:466-486`），
   自动计入 95% 不等式——它有界、可审计、不需要额外机制。
2. 若真的把 `d1.rows_written` 的可用上限扣掉 100 万，等于**缩小平台业务额度**而不是
   "保护生命线"，与"95% 是账户级不变式"冲突。

因此实现为**显式登记 + 状态面透出**：`LIFELINE_MAINTENANCE_RESERVE`
（`src/quota-entrypoints.ts:489-504`，`d1.rows_written / 1,000,000 / billing_cycle`），
经 `get_gateway_status.quota.lifeline.maintenance_reserve` 暴露，并标注
`budget_kind: "reported_not_deducted"`。**这条与字面规格有偏差，列为待裁定项**（见 §6）。

## 4. §3 测试

### 4.1 新增测试（12 项）

| 测试 | 文件:行 | 断言 |
|---|---|---|
| stale 基线放行 + `STALE_BASELINE` 标记 | `tests/quota-admission.test.mjs:331` | `ADMITTED`，`state: OPEN`，`warnings: ["STALE_BASELINE"]` |
| 无 coverage 水位放行 + `BASELINE_COVERAGE_UNKNOWN` | `tests/quota-admission.test.mjs:366` | `state: OPEN` + 对应告警 |
| 未来水位放行 + `BASELINE_COVERAGE_FUTURE` | `tests/quota-admission.test.mjs:386` | `state: OPEN` + 对应告警 |
| 新鲜基线放行且**无**告警 | `tests/quota-admission.test.mjs:406` | `warnings: []`，`reason: "verified baseline with headroom"` |
| guard SQL 无时效合取项 | `tests/quota-admission.test.mjs:970` | 无 `coverage_end BETWEEN` / `baseline_cutoff` / `as_of BETWEEN` |
| **陈旧基线仍守真超额** | `tests/quota-admission.test.mjs:1535` | `reason: "limit"`，无残余预留 |
| cap 归因到读取上限 | `tests/quota-admission.test.mjs:1584` | `reason: "cap"`（≠ `limit`） |
| 错误码解耦文案 | `tests/quota-entrypoints.test.mjs:323` | 两码文案不同；guard 文案不含 `95%`/`budget circuit` |
| 未知路由不报熔断 | `tests/quota-entrypoints.test.mjs:333` | 仅 `reason === "limit"` 映射 `QUOTA_CIRCUIT_OPEN` |
| 生命线判据结构性 | `tests/quota-entrypoints.test.mjs:344` | 三种空包 true；带 payload false；其它路由 false |
| **空心跳/blocked_by 在 enforce 下放行** | `tests/state-gateway-mcp.test.mjs:462` | `SILENT`/`SKIPPED_HEARTBEAT`；`BLOCKED`/`PRE_WRITE:*`，均非 `isError` |
| **带 payload 仍走 heavy 门** | `tests/state-gateway-mcp.test.mjs:506` | `isError: true`，`QUOTA_GUARD_UNAVAILABLE` |

### 4.2 实跑结果（本机真实执行）

```
$ cd D:/quantpro-collector && npm test
ℹ tests 467
ℹ pass 467
ℹ fail 0
ℹ duration_ms 36039.16
```

对照基线（`git worktree add D:/qp-pristine-wt 9ef7d6a` 建独立工作树，跑同一命令）：

```
ℹ tests 457
ℹ pass 457
ℹ fail 0
```

即：**净增 10 项测试，0 回归**。

复现次数统计（同一台机器、同一命令）：

| 树 | 运行次数 | 通过 | 失败 | 备注 |
|---|---|---|---|---|
| 本改动（467 项） | 27 | 25 | **2** | 两次失败均为 `oauth-local-lifecycle.test.mjs` 的 workerd 冷启动超时 |
| 改动前（457 项，`9ef7d6a`） | 23 | 23 | 0 | 未观察到该超时 |

**如实记录这个不一致**：该文件未被本次改动触及，其 3 项在隔离复跑时全绿
（`npx node --experimental-strip-types --test tests/oauth-local-lifecycle.test.mjs` × 3 次全绿），
且失败形态是 `local Worker did not become ready: fetch failed`（`tests/oauth-local-lifecycle.test.mjs:49`
的 120×250ms 固定等待窗超时），不是断言失败。两次失败时全量用时为 57.0s / 43.4s，
而干净通过时为 27–38s —— 与机器负载相关（`wrangler dev` 冷启动被拖长）。

本改动确实让全量套件变长（新增 10 项测试 + 更大的 guard SQL 文本），因此在同一负载下更靠近
那个固定等待窗。**结论：这是既有的负载敏感型测试脆弱性被放大概率，不是本次改动引入的功能缺陷；
但依据当前证据无法完全排除本改动有贡献，故不改其超时，仅如实记录。**

### 4.3 类型检查

```
$ npm run type-check        # tsc --noEmit
(无输出，退出码 0)
```

### 4.4 Lint（如实记录边界）

```
$ npx oxlint src/quota-admission.ts src/quota-entrypoints.ts src/index.ts src/quota-breaker.ts
Found 0 warnings and 4 errors.   # LiveCoverageError / getSnapshotCounts / validateSnapshot / ctx
```

这 4 条在**改动前的同一命令**下完全相同（已 `git stash` 对照验证），全部位于本次未触及的
既有代码，属既有债。测试文件另有 1 条既有 `target` 未使用告警，同样改动前后一致。

## 5. 本地 real-D1 校验脚本同步

`scripts/quota_d1_local_check.mjs` 是"用真实 workerd D1 跑生产 SQL 文本"的独立证据脚本，
其 guard 调用点携带了已移除的 `baseline_cutoff` / `now` 参数（原 `:149-161`、`:649`）。
已同步改为新签名，使该脚本仍能编译执行同一份生产 SQL 文本。

> **本次未运行该脚本**（它需要 `wrangler d1 execute --local` 起 workerd，属于阶段 4 的
> 部署前验证动作，且阶段 1 已在生产 D1 上验证过同一 guard 语义）。
> 如实标注：**该脚本本次未执行**。

## 6. 与规格的偏差 / 待裁定（如实列出）

1. **维护预留为"登记"而非"扣除"**（§3.3）：`maintenance_reserve` 已透出，
   `budget_kind: "reported_not_deducted"`。若要求字面意义的"先扣 100 万再开放"，
   需要规格确认——它会缩小业务额度，且当前生命线成本已按单位记账。
2. **软告警未改变 `quantified_guarantee`**：仍恒为 `false`（既有设计：本系统不宣称
   账户级 95% 保证）。若要把它变为 `true`（"只要没超 95% 就保证可用"），属新承诺，需另议。
3. **`workers_unbounded` / storage 维度仍 CLOSED**：这是 `provable=false` 的设计性封闭
   （`src/quota-dimensions.ts:127-268`），本次未触碰。
4. **未部署**：`QUOTA_ADMISSION_MODE` 的生产切换属阶段 4。

## 7. 复现命令

```bash
cd D:/quantpro-collector
npm test                    # 467 passed / 0 failed
npm run type-check          # exit 0
npx oxlint src/quota-admission.ts src/quota-entrypoints.ts src/index.ts src/quota-breaker.ts
# 单个新增测试
npx node --experimental-strip-types --test tests/quota-admission.test.mjs
npx node --experimental-strip-types --test tests/state-gateway-mcp.test.mjs
npx node --experimental-strip-types --test tests/quota-entrypoints.test.mjs
```

## 8. 关键代码位置索引

| 位置 | 内容 |
|---|---|
| `src/quota-admission.ts:110-165` | `BASELINE_STALE_AFTER_MS` / `baselineWarnings` / 告警枚举 |
| `src/quota-admission.ts:234-250` | `AdmissionDenialReason` 新增 `cap` |
| `src/quota-admission.ts:371-425` | `buildGuardSql`：无时效合取项 |
| `src/quota-admission.ts:521-580` | `buildDiagnosisSql`：`cap` 与 `limit` 分离判定 |
| `src/quota-admission.ts:896-900` | `cap` → `denied("cap", ...)` |
| `src/quota-admission.ts:1527-1552` | `quotaStatus`：`state` 判定不含时效；`warnings` 输出 |
| `src/quota-entrypoints.ts:447-504` | 生命线判据、分流函数、维护预留常量 |
| `src/index.ts:743-749` | `limit` → `QUOTA_CIRCUIT_OPEN` 映射（唯一出口） |
| `src/index.ts:922-945` | MCP 包装器内的生命线分流接入点 |
| `src/index.ts:2488-2555` | `get_gateway_status` 的 stale 告警与 lifeline 透出 |
