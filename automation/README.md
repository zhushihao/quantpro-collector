# QuantPro Scheduled Tasks 版本治理与发布清单

本目录是 QuantPro ChatGPT Scheduled Tasks 的 Git 版本治理与发布审计真源。Scheduled Task 运行时使用其自身保存的完整 Prompt 快照，不再每轮从 Web/GitHub/Collector 动态加载 Prompt。

- `control/production.json`：当前生产注册表，按 Scheduled Task 的固定 `REGISTRY_KEY` 记录 Prompt 路径、exact `production_ref`、`WRITE_SCOPE` 与 Guidance 路径。
- `prompts/*.md`：唯一可执行的业务 Prompt。
- `../automation_guidance/` / `../research_guidance/`：发布时与业务 Prompt 合并进 Scheduled Task 的完整 Prompt 快照；不得在运行时动态读取。

## 运行时合同

1. Scheduled Task 本身保存完整业务 Prompt + 对应 Guidance；运行时不依赖公开 Web/GitHub/Collector 来加载配置。
2. Git `production.json` 仅用于审计“当前正式版本应来自哪个 exact ref”，不属于运行时必需链路。
3. Collector 提供业务数据、LIVE facts、Research replica / Research Job 协议与 State Gateway；不得承载或分发 Automation Prompt。holding-assistant 的 MARKET 状态与产业/公司的 INDUSTRY/COMPANY 状态统一由 QuantPro Collector State Gateway 运输；QuantPro RESEARCH 不再属于 Scheduled Task 的生产状态运输链。
4. Web 只用于业务 Prompt 明确要求的最新外部事实扫描；不得承担 Prompt/Guidance 控制面或账本运行态读取。
5. GitHub Issue #2/#3 只作为审计落点；Scheduled Task 不直接分页或写 GitHub，也不依赖 GitHub Plugin / Connector、QuantPro RESEARCH、`gh` 或 shell 完成运行态持久化。Issue #2/#3 唯一生产运输路径为 QuantPro Collector State Gateway 的固定 Channel/Profile；调用方不得控制 repo/issue/URL/token/producer/dimension。
6. 所有生产 Prompt 都必须明确：任何 BLOCKER 只能结束本轮，绝对禁止任务修改自己的 title/schedule/enabled/notifications/email 配置。

## 变更流程

1. 修改 `automation/prompts/<prompt>.md` 和/或 Guidance；
2. commit + push，得到候选内容 SHA；
3. 运行 `python automation/promote.py --ref <40位候选SHA>`；该门禁必须从公开 raw exact-ref 通道实际读到所有将被引用的 Prompt/Guidance，并校验 Prompt 头部合同；
4. 只有第 3 步 `PROMOTION_GATE=PASS` 后，才允许运行 `python automation/promote.py --ref <40位候选SHA> --apply` 写入 `production.json`；
5. 单独 commit + push control 变更，并再次从公开 raw 读取 `main/automation/control/production.json` 与其中 exact refs 验证；
6. 将 exact ref 下的业务 Prompt 与对应 Guidance 合并成完整文本，显式覆盖到目标 Scheduled Task；holding-assistant 两个任务共享同一业务 Prompt，但分别固定 `TASK_MODE=INTRADAY` 与 `TASK_MODE=PREOPEN_CLOSE`；
7. 覆盖后回读 Automation：title/schedule/enabled/notifications 不变，Prompt 不含动态 control/bundle 加载逻辑，并保留 Collector/Web/GitHub 的职责边界。

这样 main 上尚未切生产的新 Prompt 不会被 Scheduled Task 自动采用，同时 Scheduled Task 也不会因为 Web/connector schema/cache 波动而无法加载自己的业务配置。
同一业务 Prompt 可以被多个 registry key 复用；例如持仓助手的盘中任务与盘前+收盘任务共享同一个 mode-aware Prompt，但拥有不同调度与独立 Bootstrap key。盘前+收盘任务允许增加 10:10 PREOPEN Recovery，Recovery 的账本 semantic slot 仍为 09:10。

`WRITE_SCOPE` 约束生产业务写权限。状态账本统一通过 QuantPro Collector State Gateway：`MARKET_LEDGER_APPEND_ONLY` 仅允许 `MARKET` Channel 固定写 Issue #2；`RESEARCH_JOB_AND_INDUSTRY_LEDGER` 在 Research Job 正式协议之外仅允许 `INDUSTRY` Channel 固定写 #3 的 `industry_trend/INDUSTRY`；`COMPANY_LEDGER_APPEND_ONLY` 仅允许 `COMPANY` Channel 固定写 #3 的 `company_validation/COMPANY`。Scheduled Task 不得使用 QuantPro RESEARCH、GitHub Connector、`gh`、shell 或任意 HTTP writer 作为状态账本 fallback。

禁止在本目录存放 token、secret、账户、订单、持仓数量或其他敏感信息。
