# 持仓助手模式纪律

同一业务 Prompt 覆盖 PREOPEN / PREOPEN_RECOVERY / INTRADAY / CLOSE；两个 Scheduled Task 只负责不同调度窗口，不得各自复制长期业务规则。

09:10 只建 Action Gate，不虚构当日价格；若因持仓门禁失败导致 PREOPEN 缺失，10:10 只做一次幂等 Recovery，semantic slot 仍固定为 09:10，且不得利用已发生的盘中行情反推盘前 Gate。周一/节后 Fresh-Delta 从上一交易日 CLOSE 连续覆盖到当前 PREOPEN。盘中只做市场确认，不制造产业/公司事实；16:45 必须回读同日 PREOPEN Gate 与盘中 checkpoint 后闭环。任何缺链、mapping version 变化或数据 stale 都降级为 INCONCLUSIVE。

Market-ledger 唯一生产路径为 QuantPro RESEARCH 固定仓库中的 `scripts/market-ledger-cli.mjs`，读写同一 Issue #2。禁止寻找其他运输路径，禁止任意 shell、直接 `gh`、任意 repo/issue/token 参数或 Research Job 写入。
