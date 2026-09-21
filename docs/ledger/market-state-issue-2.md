# 市场状态日志

> 机器状态总线之一。用于保存持仓助手的盘前 Action Gate、盘中检查点和收盘市场确认。
> 只保存市场结构；不要写公司基本面 Thesis，不要用价格倒推基本面。

## 账本定位

- GitHub Issue：`zhushihao/quantpro-collector#2`
- 物理存储：append-only Issue Comment；不覆盖、编辑或删除历史评论。
- 生产读取：Scheduled Task 只调用 Collector `get_market_checkpoints`，由服务端完成 GitHub comments 分页、过滤和链解析。
- 生产写入：Scheduled Task 只调用 Collector `append_market_checkpoint`，由服务端固定 append 到本 Issue 并写后回读；模型不接触 GitHub token，也不依赖 GitHub Plugin / Connector。
- 兼容桥：若个人开发者 ChatGPT Connector 的冻结工具快照尚未暴露上述新增 action，可临时通过已批准的 QuantPro RESEARCH `run_process` 调用固定 `scripts/market-ledger-cli.mjs`。CLI 复用同一 `src/market-ledger.ts`，目标仍固定本 Issue，不接受 repo/issue/token 参数；模型不得直接调用 `gh` 或任意 shell。兼容桥仅解决 Connector schema 刷新问题，不改变账本语义。
- 行情原始事实：Issue #1；不是状态账本。
- 产业/公司 Thesis：Issue #3；不是 Action Gate 或市场观察账本。
- QuantPro #28：生产 Prompt 注册表；QuantPro #30：工程验收；两者都不是运行状态。

旧 `market_observation_v1` / `scheduled_write_probe_v1` 测试评论和旧 producer 的
评论仅作历史审计；生产消费者忽略不符合本契约的记录。

## 当前生产契约

`holding-assistant` 是唯一当前生产 producer，单一任务覆盖 PREOPEN、INTRADAY 与
CLOSE：

| 阶段 | 时间 | schema_version | observation_type |
| --- | --- | --- | --- |
| PREOPEN | 09:10 | `premarket_plan_batch_v1` | `PREMARKET` |
| INTRADAY | 09:50 / 10:50 / 11:50 / 13:50 / 14:50 | `market_observation_batch_v1` | `INTRADAY` |
| CLOSE | 16:45 | `market_observation_batch_v1` | `CLOSE` |

每次计划任务最多写一条评论，评论正文只放一个 JSON code block。所有当前生产评论的
顶层必须有 `schema_version`（不能写成 `schema`），并使用：

```json
{
  "schema_version": "premarket_plan_batch_v1 | market_observation_batch_v1",
  "prompt_id": "holding-assistant",
  "production_ref": "<exact Git prompt SHA>",
  "portfolio_version": "<Collector value>",
  "event_id": "YYYYMMDDTHHMMSS+08|holding-assistant|BATCH",
  "idempotency_key": "holding-assistant:<trade_date>:<scheduled_slot>",
  "trading_date": "YYYY-MM-DD",
  "as_of": "ISO8601+08:00",
  "scheduled_slot": "09:10 | 09:50 | 10:50 | 11:50 | 13:50 | 14:50 | 16:45",
  "producer": "holding-assistant",
  "observation_type": "PREMARKET | INTRADAY | CLOSE",
  "previous_checkpoint_comment_id": "<comment id or null>",
  "preopen_comment_id": "<comment id or null>",
  "live_universe_hash": "<Collector value>",
  "source_task": "持仓助手",
  "records": []
}
```

`records[]` 使用本轮 Collector 的 canonical instrument key；`MAPPING_ONLY` 不能单独
作为持仓 record。它必须包含市场观察、固定 `benchmark_key`、
`benchmark_mapping_version`、`market_signal_as_of`，以及适用的
`relative_strength_3d/5d/10d`、量价和连续市场结构字段。市场状态的计算值缺失时写明
状态（例如 `INSUFFICIENT_HISTORY` 或 `NO_VALID_BENCHMARK`），不得临时选择基准或
伪造数值。

PREOPEN 的 records 还必须含 1–2 个 Action Gate；每个 Gate 保存不可变的
`action_gate_id` 和 `original_condition`。INTRADAY/CLOSE 的同一 Gate 引用这两个
原值，`gate_status` 只允许 `PENDING`、`PASS`、`FAIL` 或 `INCONCLUSIVE`。

## 状态链和幂等

1. `get_market_checkpoints` 在 Collector 服务端完整分页读取同日有效评论和上一交易日最后有效 CLOSE；Scheduled Task 不自行分页 GitHub。服务端分页/解析失败即状态链未知。
2. `append_market_checkpoint` 写前以 `idempotency_key` 查重。相同 key 且内容相同返回 `IDEMPOTENT_REPLAY`；相同 key 内容不同为 `CHECKPOINT_CONFLICT`。
3. `append_market_checkpoint` 写入后必须由服务端回读 GitHub comment id、URL、创建时间及 payload；回读一致才返回 `PERSISTED`。
4. 每个 INTRADAY 都要写 checkpoint，即使没有用户通知；它引用上一个成功 checkpoint。
   没有上一个 checkpoint 时，不能声称严格 Fresh-Delta。
5. CLOSE 必须回读原始 PREOPEN Gate 和完整同日链。PREOPEN 缺失、链冲突、mapping
   version 变化或分页不完整时，Gate 结果只能 `INCONCLUSIVE`。
6. 自然交易日结束后，可将 Issue #2 全量 comments API JSON 保存到临时文件并运行
   `python automation/validate_holding_day.py --comments-json <file> --trade-date YYYY-MM-DD`；
   只有输出 `HOLDING_DAY_LOOP=PASS` 才能作为 QuantPro#30 的自然日状态链验收证据。

## 硬边界

1. 市场价格和成交量只能支持市场确认 R3/R4；不得生成产业转强 R1 或公司确认 R2，
   也不得混称市场价格确认是“公司确认 R2”。
2. 单日只可称“单日显著相对超额”。“持续独立超额”与“交易结构确认”必须有版本化连续
   市场结构字段和所需多观察点历史。
3. Action Gate、价格和市场观察不是 D/S/M/E/P/C Evidence，禁止写入 Evidence accumulator。
4. 组合样本只代表该组合样本，不得外推整个 A 股市场。
5. 评论不得包含持仓数量、账户标识、订单、凭据、token、claim token、lease token 或
   Research Job 数据。
