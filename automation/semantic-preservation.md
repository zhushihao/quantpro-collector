# Issue #33 语义保留与发布审核

本次为静态Prompt发布机制改造，不是State Gateway开发。基线793820afc2a6f2526efd9a80f3fd6df20b55eb46；四个写任务原内容ref=16d596d20b608401d7acf7c4e4e55773d073ceb9，两个只读任务原ref=7b62caecbef5e09ba71d08c3eaa29fed49e40058。

| 原规则 | v3落点 | 保留/修正 |
|---|---|---|
| 不自改Automation、不接触凭据、先发现再调用、无替代运输 | common-safety +各任务权限首段 | 保留；服务端profile不等于任务身份，未删除模型级channel白名单 |
| 事件首次公开时间、独立来源、仅实质新增、反证、中文两层输出 | fresh-delta/output-style及研究Guidance | 保留；静默不能被解释为只读任务有写权限 |
| 状态snapshot→validate→append同batch→receipt→snapshot | state-gateway +具体任务输入 | 保留；不删模型仍需提供的schema身份/事件字段；移除内部D1/分页实现讲解 |
| 全ACTIVE覆盖、MAPPING_ONLY排除、闭市不等于节假日、官方确认、混合市场 | holding-assistant 本轮事实与休市闸门 | 保留；应交易市场必要行情不可stale，canonical CN/HK输入明确 |
| 固定比较基准、3/5/10日、缺数据降级、两类筹码证据、单日不R4 | holding-assistant 市场状态与输入 | 保留，不由价格制造R1/R2 |
| 09:10原始条件、10:10同键补建、无前视、16:45闭环 | modes/holding-preclose | 保留；盘中产物不编入此执行段 |
| 盘中语义时点、午休/尾盘、上一检查点比较、每时点后台落账 | modes/holding-intraday | 保留；盘前收盘产物不编入此执行段 |
| 唯一Research Job writer、最多1非backfill、先终态化lease、真实Evidence ID、submit/defer | industry-research Research Job优先 | 原流程保留；失败不能假装释放，不用空洞proposal清队列 |
| 系统BOM数量/端口/速度/能耗/价值量、5500 NPO vs48000 800G只是校准线索 | 原system-bom Guidance完整编入 | 保留；新数据可二次获得新增资格 |
| 事件时间与Anthropic历史重报道复盘 | fresh-delta-event-time Guidance | 去重缩写，保留全部判断条件与案例含义 |
| 公司R2正式来源、资本行为与经营逻辑隔离、50/80/95/100里程碑 | company-facts +资本Guidance | 保留；精简重复句，明确company_thesis/company_validation与r_proposal分工 |
| 中央范围及权威叙事30–90日同署名同主题连续变化 | central-policy +原authority-narrative Guidance | 保留；正式政策与叙事作为两类候选，消除旧“只有新工具”与Guidance冲突 |
| AI长融资与2/10/30Y、通胀/Fed/财政/期限溢价等替代解释 | ai-financing-rates +原causal Guidance | 保留；不得由单次利率波动推定AI因果 |

## 审核边界
长度/关键词测试是回归网，非LLM业务正确性的自动证明。上述语义逐项对照完整旧文人工审核。新编译器保留所有必需Guidance，按角色编译，不进行摘要生成或自动截断。
只删冗余来源/安全条款和服务端实现介绍。发布没有运行时GitHub依赖，没有新MCP接口，没有重新授权、没有Worker部署，也不写业务账本。

## 发布证据要求
候选prepare不修改production.json。实际Automation全文保存/回读与编译产物相同，且title、schedule、is_enabled、default_timezone、timing_mode、notifications_enabled、email_enabled逐项不变，才标VERIFIED并推进每registry版本。v2已知手工拼接排版漂移由本次精确编译取代，不声称旧快照已具备全文一致性。
实际工作区的before/after/manifest/receipt保存在automation/_build，公开审计只保存校验结论、hash和不含秘密的配置，不搬运token或账户数据。自然交易日业务结果仍属于#32后续运行观察，不用本次单元测试顶替。
