# 信封契约开工 + 文档库根因调查（2026-09-29）

> **汇编说明**：本报告由本次工作流的实现会话、独立复核会话与根因调查会话产出的事实包汇编而成。文中所有 `文件:行号` 引用、探针输出与测试数字均来自上述会话的实际亲读/实跑记录（各条目下方的"独立核实记录"即为核实凭据）；文末"验证了什么 / 没验证什么"两栏按各会话核实记录如实汇总，本报告本身不新增核查。

## 0. 人话总结

今天干了两件事。

**第一件：给"运行信封"功能动工。** 运行信封（run envelope）可以理解为：数据采集器每跑一次任务，就领一张标准"回执单"，上面记录这次用的是哪个代码版本、最终状态是完成/静默/阻断/失败。代码写完后，独立复核揪出一个高优先级 bug：每次任务"收尾更新"数据库时，会把"这次用的是哪个构建版本"两列审计信息错写成时间戳——好比快递单把"发货批次号"涂改成了"发货时间"。已按复核指认的位置修好，并补了防回归测试：修复前探针复现两列确实被写成同一个时间戳，修复后正确显示部署标记；单元测试 18/18、类型检查绿、全量测试 327/327 全绿。

**第二件：查"研究文档库为什么隔三差五报 STORE_UNAVAILABLE（存储暂时不可用）"。** 列出 5 个候选原因并逐一独立核实，**5 个全部在代码层面证实成立（confirmed）**。最主要的解释是：9 月 28 日的一次改动（fcc3e05）只是把这类错误的标签从"别重试、整轮阻断（BLOCKED）"改成了"可以重试、带伤降级（DEGRADED）"，底层的间歇性后端故障并没有修——病人还是同一个病人，只是病历换了张纸。其余原因包括：副本里有些文档"只有目录没有正文"（已知欠账，一查就报"别重试"）、语义搜索比普通搜索多依赖的两件云工具会抖动、云平台配置绑定问题（只能解释个别整轮阻断）、写入侧的放大效应。五个原因都还差生产日志侧的最终对账，相关"没验证"项如实列在文末。

### 术语速查（白话解释，后文直接使用）

| 术语 | 白话解释 |
|---|---|
| 运行信封（run envelope） | 每次采集任务的标准化回执单：构建版本、终态（COMPLETED/SILENT/BLOCKED/FAILED）等 |
| INSERT / 终态 UPDATE | 数据库两步写入：任务开始先"建行"（INSERT），任务结束再"收尾更新"（UPDATE）该行 |
| COALESCE(?13, 旧值) | SQL 写法，含义是"传了新值就用新值，没传就保留旧值" |
| 构建归因列 | `collector_build_sha` / `cloudflare_version_id` 两列，记录本次运行对应哪个代码构建 |
| D1 / R2 | Cloudflare 云平台自带的两种存储：D1 像表格数据库，R2 像网盘文件仓 |
| Workers AI / Vectorize | Cloudflare 的嵌入模型服务与向量索引；语义搜索（按意思找文档）依赖的两件外置工具 |
| STORE_UNAVAILABLE | 平台统一的"存储暂时不可用"错误信封，带 retryable（是否建议稍后重试）标记 |
| UNKNOWN / TRANSIENT / DETERMINISTIC | 错误三分类：认不出的错 / 网络类瞬态错 / 确定性错误（重试也没用） |
| BLOCKED / DEGRADED | 自动化任务一轮的两种处置形态：整轮阻断不做 / 带伤降级继续做 |
| slot / 排班槽 | 任务被安排到的时段档位，用于在回执上记"这轮归哪个时间槽" |
| fcc3e05 / f16de97 | 两个代码提交（commit）的短编号；fcc3e05 提交于 2026-09-28 10:06 +08（= 02:06 UTC） |
| replica / 回填 | replica = 研究文档库在 Cloudflare 侧的只读副本；回填 = 把缺投递的内容补送过去 |
| automation | 下游自动化生产任务（ai-financing-rates / central-policy / company-facts 等 prompt 驱动的轮次），靠读文档库干活，读到 STORE_UNAVAILABLE 就记一轮失败 |
| RIWS | 研究侧的上游文档系统，负责把文档投递给 Cloudflare 侧的 replica |

---

## 一、信封契约实现

### 1.1 实现摘要

修复复核发现的高优先 bug：`run-envelope.ts` 的 `updateRunV3Row` 终态 UPDATE 把 `collector_build_sha`/`cloudflare_version_id` 绑定成 `updatedAt`（ISO 时间戳），覆写 INSERT 阶段写入的构建归因列。

修法：`updateRunV3Row` 入参增加 `collectorBuildSha`/`cloudflareVersionId` 两字段并绑定到 ?13/?14（COALESCE(NULL,旧值) 语义保留，未传时保留 INSERT 值），`processRunEnvelope` 调用处透传 `input.collectorBuildSha`/`cloudflareVersionId`。

验证：修复前探针复现两列均为 `"2026-09-28T20:08:17.799Z"`（与复核一致）；修复后同探针返回 `BUILD_MARKER_1234`/`VER_MARKER_5678` 且 `updated_at` 正常；新增用例 **build attribution survives the terminal update**（心跳+PERSISTED 双路径断言两列等于部署标记且 ≠ updated_at）；`tests/run-envelope.test.mjs` 18/18，`npx tsc --noEmit` 绿，`npm test` 全量 327/327（基线 297 + 新增 30）。

### 1.2 改动文件

- `src/run-envelope.ts`
- `tests/run-envelope.test.mjs`

### 1.3 偏离规格的决定

- 无新增偏离：修复严格按复核指认的位置与语义；同文件 `insertUnknownRunRow`/`insertInvalidRunRow` 的 `?11,?11` 复用经逐参核对为有意绑定同一 nowIso，无同类错位。

### 1.4 门禁结果

- 第 1 轮：npm test + type-check 全绿。
- 独立复核修复后重跑门禁：test exit 0 / type-check exit 0。

### 1.5 独立复核发现（6 条）

1. **【high】`src/run-envelope.ts:338-339`** — 终态 UPDATE 的 SET 子句 `collector_build_sha=COALESCE(?13,…)` / `cloudflare_version_id=COALESCE(?14,…)` 的 ?13/?14 绑定的是 `input.updatedAt`（函数入参根本没有 buildSha/versionId 字段，绑定处 :356-358 连填三个 updatedAt），INSERT 阶段正确写入的构建 SHA/版本 ID 在每次终态更新时被覆写为 ISO 时间戳——临时探针实证传入 BUILD_MARKER_1234/VER_MARKER_5678 后落库两列均为 `"2026-09-28T20:03:36.258Z"`，所有 COMPLETED/SILENT/BLOCKED/FAILED 行的构建归因审计列被系统性写坏且无测试覆盖。

2. **【medium】`src/run-envelope.ts:618-665`** — 真并发同信封时唯一索引输家的幻影 run_id：步骤3读到 existing=null、步骤5 INSERT 撞索引且赢家仍 UNKNOWN 时直接穿透继续执行，但 runId 仍是自己 `newRunId()` 的值（未改用 winner.run_id），`updateRunV3Row` 的 `WHERE run_id=?2` 匹配 0 行静默丢更新——输家返回 ENVELOPE_RECORDED 附一个库中不存在的 run_id；若输家先拿到回执租约 PERSISTED，真行停留 UNKNOWN 只能靠下次重试翻成 SILENT；测试(а)只覆盖"读时已存在 UNKNOWN 行"的顺序场景，未测读后插前创建的真并发分支。

3. **【low】`src/run-envelope.ts:611`** — 心跳不绑排班槽：`payload ? resolveSlotBinding(…) : null` 使心跳行 slot/slot_date 恒 NULL，而规格 §1.4 步骤4 对整个流程（含心跳）无条件做 slot 绑定；MISSED_SLOT 判满按 received_at 计算不受影响，属观测字段缺失的规格偏差。

4. **【low】`src/run-envelope.ts:740`** — 写前失败的 run 行 event_count 误填事件数：`ledgerOutcome.eventCount`（executedEventCount，append 未开始时为 null）构造后从未被读取，终态 UPDATE（:807）用的是外层已赋值为 `events.length` 的 eventCount——owner 上下文失败的行 event_count=1，与 ：738-740 自己的注释"event_count stays NULL"矛盾（探针实证），也不符合 §3.3 event_count=服务端投影后写入事件数的定义。

5. **【low】`tests/state-gateway-mcp.test.mjs:338-355`** — 服务器字段禁词第二循环（schema_version/event_id/write_key/source_task/portfolio_version/live_universe_hash）仍只遍历四个窄写工具，未把 `submit_run_envelope` 纳入；实际 schema 经 listTools 实证干净（8 禁词命中 0），但规格 §1.2 要点2 要求加进两份断言循环，防回归门只补了一半。

6. **【low】`work/` 与 `package-lock.json`** — 未跟踪杂物：仓内嵌套 `work/quantpro-collector/` 复制目录（含重复的 package-lock.json 与规格副本）非规格交付物；根级 package-lock.json 为 origin/main 没有的 npm install 副产物，混入提交会引入规格外的锁文件基线变化。

### 1.6 规格文件与交付边界

- 规格文件：`work/quantpro-collector/docs/specs/2026-09-29-envelope-spec.md`
- 交付边界：代码与测试在工作副本中待主线评审提交；生产部署、ChatGPT 侧 Prompt 安装不在本次工作流内。

---

## 二、文档库间歇 STORE_UNAVAILABLE 根因

**按复核判定分组：confirmed（已证实）5 条；unconfirmed（未证实）0 条。**

五个候选原因的证据链均经独立复核成立。confidence 是确认者对因果链的自评把握：假设 1–3 为 medium，假设 4–5 为 low。"成立"限于代码与仓内文档层面——生产观测记录、部署时刻等仓外证据另有未验证项，见文末第三节两栏。

### 2.1 confirmed 组（5/5）

#### 假设 1【最可能·主因候选】读面重试预算太短 + fcc3e05 只翻标签不修故障

- **复核判定**：confirmed（置信度 medium）
- **白话**：数据库那头偶尔瞬时报错，读侧重试总预算只有约 2 秒，撑不过去就把 STORE_UNAVAILABLE 甩给上层；9-28 的改动只是把甩出去的错误从"别重试（BLOCKED）"改成"可以重试（DEGRADED）"，抽风本身没治。
- **机制**：读面把 D1/R2 后端瞬态错误经 withResearchReadRetry（仅 2 次重试、500/1500ms、总预算≈2 秒）转成 STORE_UNAVAILABLE 信封；且 09-27 的 BLOCKED(retryable=false) 与 09-28 的 DEGRADED(retryable=true) 形态差异，正是 fcc3e05（2026-09-28 10:06 +08 = 02:06 UTC 提交，约 02:31 UTC 部署，见 automation/observers/production-health.md:45 company-facts 修复版锚点）把 UNKNOWN 类后端错误的 retryable 从 false 翻成 true、并在 automation prompt 新增 RESEARCH_DEGRADED 规则造成的——标签变了，底层间歇后端故障本身没修。
  - 注：机制句中"约 02:31 UTC 部署"这一引用经复核有瑕疵（见下方核实记录·瑕疵1），但不参与因果链。
- **证据链**：
  - `src/research-read-retry.ts:9` `RESEARCH_READ_RETRY_DELAYS_MS=[500,1500]`；:138-143 两个正则都不中的错误→UNKNOWN 类；:221-228 最终 `retryable: backend.failure_class !== "DETERMINISTIC"`。
  - fcc3e05 diff（本会话 git show 亲读）：旧码 `retryable: backend.failure_class === "TRANSIENT"` 且 `shouldRetry === TRANSIENT`，即 UNKNOWN 一次不重试且 retryable=false（BLOCKED 形态）；新码 UNKNOWN 重试 1 次后 retryable=true（DEGRADED 形态）。
  - 同一 commit 给 `automation/prompts/ai-financing-rates.md:11` 与 `central-policy.md:11` 新增"返回 STORE_UNAVAILABLE 时标记 RESEARCH_DEGRADED…只有…才整轮 BLOCKED"，而 fcc3e05 之前 4 个生产 prompt 中 STORE_UNAVAILABLE 出现次数为 0（git show fcc3e05^ 后 grep -c 逐一证实）。
  - 本机分类探针（node --experimental-strip-types）：`'D1_ERROR: internal error: INTERNAL'`、`'D1_ERROR: too many requests'`、`'database session was terminated'` 均判 UNKNOWN→现行码 finalRetryable=true，与 09-28 观测形态逐字吻合；`'Network connection lost'`/`'fetch failed'` 判 TRANSIENT。
  - 信封出口：`src/index.ts:857-866` researchDomain 兜底 `new ResearchBoundaryError("STORE_UNAVAILABLE")`（默认 retryable=true，`src/research-outbound-v2.ts:367-369`），automation 看到的 `{error_code, retryable}` 即观测括号内容。
- **修复建议**：读重试加宽：UNKNOWN 类给满 2 次重试、总预算拉到 ≥5-10 秒指数退避，并把 D1 常见错误词（internal error / too many requests / session terminated / D1_ERROR 前缀）纳入 TRANSIENT 正则——`src/research-read-retry.ts`。验证：改后跑 `tests/research-read-retry.test.mjs` 全绿，再对比生产 research_read_failure 事件频度（见"没验证"栏）。
- **独立核实记录**：证据链成立（机制与 fcc3e05 前后形态翻转全部亲验），但有两处外围引用瑕疵，不动摇结论。
  1. 现行代码：`src/research-read-retry.ts:9` `RESEARCH_READ_RETRY_DELAYS_MS=[500,1500]`（满预算 3 次尝试、2 次重试、共 2000ms≈2 秒）；:138-143 两个正则（:112-136）都不中→UNKNOWN 类；:221-228 兜底抛 `STORE_UNAVAILABLE` 且 `retryable: backend.failure_class !== "DETERMINISTIC"`；:192-193 UNKNOWN 仅 attemptIndex===0 允许重试 1 次。
  2. fcc3e05 diff（git show 亲读）：提交时间 2026-09-28 10:06:29 +0800 = 02:06:29 UTC ✓。旧码 `shouldRetryResearchRead` 返回 `failure_class === "TRANSIENT"`（:173 旧行）、兜底 `retryable: backend.failure_class === "TRANSIENT"`——UNKNOWN 一次不重试且 retryable=false；新码改为 `!== "DETERMINISTIC"` 并加 `willRetry` 的 UNKNOWN 单次重试闸。与机制描述逐字吻合。
  3. 双版本对照实测（node --experimental-strip-types，跑的是真模块非复刻）：现行码对 `'D1_ERROR: internal error: INTERNAL'`、`'D1_ERROR: too many requests'`、`'database session was terminated'` 三条均判 UNKNOWN→终态信封 `{error_code:STORE_UNAVAILABLE, retryable:true}`（UNKNOWN 实测 2 次尝试/1 次重试）；`'Network connection lost'`/`'fetch failed'` 判 TRANSIENT（3 次尝试/2 次重试）；`'no such table'` 判 DETERMINISTIC→retryable=false。把 fcc3e05^ 的源文件提取到临时目录跑同一探针：同样三条 UNKNOWN 消息 → 1 次尝试、will_retry=false、retryable=false（BLOCKED 形态），TRANSIENT 仍 retryable=true。形态差异由该 commit 造成的判断成立。
  4. prompt 侧：`automation/prompts/ai-financing-rates.md:11` 与 `central-policy.md:11` 现各含 1 条 'STORE_UNAVAILABLE→标记RESEARCH_DEGRADED…才整轮BLOCKED'，正是 fcc3e05 各 +1 行新增（git show 确认）。fcc3e05^ 时点 5 个 prompt 源文件（ai-financing-rates/central-policy/company-facts/holding-assistant/industry-research）grep -c STORE_UNAVAILABLE 全部为 0；现行仅上述两个文件各为 1。
  5. 信封出口：`src/index.ts:857-866` researchDomain 对非 ResearchBoundaryError 兜底 `new ResearchBoundaryError("STORE_UNAVAILABLE")`；`src/research-outbound-v2.ts:367-369` 默认 retryable=true（STORE_UNAVAILABLE||RATE_LIMITED）；:372-379 asError() 输出 `{error_code,safe_message,retryable,request_id}`，即 automation 观测到的字段。读面接线亲验：index.ts:2077/2085/2106/2119/2153/2164 等——search_documents、get_document、search_documents_semantic、get_coverage_status、get_source_health 等全部经 researchRead→withResearchReadRetry，onFailure 打 research_read_failure 事件（index.ts:874-882）。
  6. 现行测试：`node --experimental-strip-types --test tests/research-read-retry.test.mjs` → 11 pass / 0 fail（含 'unknown native read failure can recover on its second attempt'，锁死现行行为）。
  - **瑕疵1·部署时间引用错位**：机制称 fcc3e05 "约 02:31 UTC 部署，见 automation/observers/production-health.md:45 company-facts 修复版锚点"——亲读该行实际记录的是 HOST_SAFETY 修复 post-fix 基线 2026-09-28T10:31:55.434604Z（=18:31:55+08，Cloudflare Version ID 8cb754e8），这是比 fcc3e05（02:06 UTC 提交）晚约 8.5 小时的另一次部署（company 窄写修复），"02:31 UTC"疑为把 10:31:55Z 误读/换算错。observers 文档、git log 中均未找到钉死 fcc3e05 于 02:31 UTC 部署的仓内证据——该部署时刻属未验证推断；但它不参与因果链（代码翻转与两版形态已直接实测）。
  - **瑕疵2·prompt 计数不精确**：机制说"4 个生产 prompt"——实际 fcc3e05^ 时点是 5 个 prompt 源文件、编译出 6 个生产任务（holding-assistant.md 展开为 intraday+preclose，automation/build_prompts.py:48-53）；"全部为 0"比机制原话还强，方向不受影响。
  - **未能验证项**：'09-27 BLOCKED(retryable=false) / 09-28 DEGRADED(retryable=true)' 的生产观测记录本身是 GPT 侧 automation 会话观察，不在本仓（.sdd 与 observers 均无该观测原文）；已验证的是代码机制在这两个时点必然产出这两种形态，而非观测记录本身。生产 research_read_failure 频度对比（修复建议的验证手段）需生产日志，本会话无法执行，未跑。

#### 假设 2：副本缺正文对象 → 非重试 STORE_UNAVAILABLE（09-27 三连 BLOCKED 的首选解释）

- **复核判定**：confirmed（置信度 medium）
- **白话**：副本里有些文档只登记了目录、正文文件没送到；一查这种文档就报"不可用、别重试"，依赖它做历史去重/证据链的一整轮就卡死。这不是猜测——RIWS 侧 2026-09-28 task E 已把它文档化为已知欠账，还备了补投递工具。
- **机制**：replica 存在"元数据在 D1、正文 R2 对象缺失/从未投递"的文档：get_document/get_evidence 遍历完所有 servable 版本都没有可用对象时抛非重试 STORE_UNAVAILABLE（retryable=false，"retry is not advised"），依赖该文档做历史去重/证据链的轮即整轮 BLOCKED——09-27 三连 BLOCKED 的首选解释；这不是猜测，RIWS 侧 2026-09-28 task E 已文档化该已知债务。
- **证据链**：
  - `src/research-remote-adapter.ts:74-79` `failMissingReplicaObject` 显式 `retryable:false, safeMessage:"research replica object is unavailable; retry is not advised"`。
  - :355-377 getDocument 逐候选版本取 R2 对象、全部缺失→该错误；:425-428 getEvidence 同路径。
  - 反证写入顺序：`src/research-replica.ts:234-242` 对象先写 R2 再写 D1 batch，本码序不会造成"metadata 有/R2 无"，故缺口来自投递面——`quantpro-research/research/riws/scripts/backfill_public_replica.py:5-9` 明言"outbound_producer.py 按 document_id 序最多投影 --limit（默认 500）条……replica 永远收不到窗口之后的文档，get_document 持续对它们的正文回答 STORE_UNAVAILABLE"（文件头自述 Why this tool exists, 2026-09-28 task E）；同目录 `backfill_requeue_failed_outbox.py:5` 提"STORE_UNAVAILABLE debt"。
- **修复建议**：RIWS 侧完成 task E 冻结回填补齐缺失对象；读面把该错误与瞬时不可用区分为专用错误码/safe_message（`src/research-remote-adapter.ts`），让 automation prompt 与日志能区分"别重试的缺件"与"稍后重试的故障"。验证：对当轮 BLOCKED 涉及的 document_id 逐个 get_document 读回抽样；或查日志中该错误固定 safe_message 特征（需生产访问，见"没验证"栏）。
- **独立核实记录**：证据链成立，全部代码/文档引用本会话亲读核实，并跑了适配器测试套件。逐条：
  1. `src/research-remote-adapter.ts:74-79` `failMissingReplicaObject` 抛 `ResearchBoundaryError("STORE_UNAVAILABLE")` 显式 retryable:false、safeMessage:"research replica object is unavailable; retry is not advised"——逐字吻合。
  2. getDocument :355-377：候选按 version_number DESC 排序（:348-354），逐个 servable 版本取 R2 对象，对象缺失 continue 下一版本（:360-363），循环走完且 sawServable=true → :376 `failMissingReplicaObject()`；全无 servable → :377 UNSUPPORTED_OPERATION。
  3. getEvidence :425-428 同路径：对象缺失即 `failMissingReplicaObject()`（:426）——行号精确。
  4. 反证写入顺序：`src/research-replica.ts:234-236` 先写 R2 journal、:237-242 再写 R2 对象体、:244 起才组装 D1 batch（metadata 行 :258-290、对象登记 :275-289）——同码序内崩溃只会留下"R2 有对象/D1 无元数据"的相反缺口，确实产生不了"元数据有/R2 对象无"，缺口只能来自投递面的推理成立。
  5. RIWS 侧文档化债务：`quantpro-research/research/riws/scripts/backfill_public_replica.py:1-9` 文件头 "Why this tool exists (2026-09-28 task E)"，原文逐字读及：outbound_producer.py 按 document_id 序最多投影 --limit（默认 500）条、"replica therefore never receives documents whose ids sort behind that window, and get_document keeps answering STORE_UNAVAILABLE for their bodies even though RIWS holds them (T2 evidence chain 3)"——与机制引述语义一致（引文是准确的中文转译）。`backfill_requeue_failed_outbox.py:5` 原文 "2026-09-16 rate-limit + dependency STORE_UNAVAILABLE debt"——债务早于 09-27，时间线自洽。
  6. 已执行检查：`node --experimental-strip-types --test tests/research-remote-adapter.test.mjs` → 27 pass / 0 fail；套件内 `tests/research-remote-adapter.test.mjs:497-514` "C8 every candidate object missing is STORE_UNAVAILABLE" 直接断言 `error_code==="STORE_UNAVAILABLE" && retryable===false`（:512），:469-495 另测"缺对象回退下一 servable 版本"——机制行为有测试锁定且全绿。
  - **瑕疵a**：机制措辞"正文 R2 对象缺失/从未投递"把两种模式合在一起：元数据在 D1 而对象缺→正是上述非重试 STORE_UNAVAILABLE（机制精确成立，且 T2 生产确认记录 `.sdd/2026-09-28-multi-source-leads/work-T2-COLLECTOR-FIX.md:28` 正是"500 snapshot window 截断导致 R2 缺少对象实体"这一模式）；但整篇文档从未投递（元数据与对象全无）时 get_document 走 recordByKey :242 抛 NOT_FOUND（research-remote-adapter.ts:233-242）——同样 retryable=false（research-outbound-v2.ts:367-369 默认仅 STORE_UNAVAILABLE/RATE_LIMITED 为 true），但 error_code/safe_message 不同，automation prompt 的 STORE_UNAVAILABLE→RESEARCH_DEGRADED 规则字面上只覆盖前一种。文档化债务两种模式都含（task E 头部两种都提），按字面机制链只对"元数据在/对象缺"模式成立。
  - **瑕疵b**：getEvidence 的缺对象路径无专门测试（getDocument 有 C8 两条），仅读码核实。
  - **瑕疵c**："09-27 三连 BLOCKED"观测记录与假设 1 同样是 GPT 侧会话观察、不在本仓（observers/.sdd 均无原文），已验证的是机制与债务文档化，不是该观测本身。
  - **瑕疵d**：修复建议中的验证（对当轮 BLOCKED 的 document_id 逐个 get_document 读回抽样、日志 grep 该固定 safe_message）需生产访问，本会话无法执行，未跑。

#### 假设 3：语义检索面多两个外部依赖，抖动产出间歇 DEGRADED

- **复核判定**：confirmed（置信度 medium）
- **白话**：语义搜索（按意思找文档）比普通关键词搜索多依赖两件云上工具——嵌入模型和向量索引；它们一抖就报"可重试的不可用"，普通搜索却正常——正好造成"时好时坏"的假象。
- **机制**：语义检索面 search_documents_semantic 比词法面多两个外部依赖——Workers AI（bge-m3 嵌入）与 Vectorize 索引查询——任一抖动即抛 retryable=true 的 STORE_UNAVAILABLE；语义调用失败而词法 documents 正常，恰好产出"穿插 documents=OK/正常轮"的间歇 DEGRADED 形态。
- **证据链**：
  - `src/research-semantic-index.ts:311-314` `ai.run` 抛错→`fail("EMBEDDING_UNAVAILABLE", true, "embedding provider is unavailable; retry later")`。
  - :372-384 `index.query` 抛错/返回形状异常→`fail("INDEX_UNAVAILABLE", true, …)`。
  - :139-141 fail 构造 `ResearchBoundaryError("STORE_UNAVAILABLE", undefined, {retryable,…})`。
  - :1209-1239 searchPublicDocumentsSemantic 整体 try/catch→boundaryFailure(:143-146) 把任何非边界错误也归为 retryable=true 的 INDEX_UNAVAILABLE。
  - 工具注册 `src/index.ts:2090-2112`，deps 来自 semanticIndexDeps(env)；重试仍只享 `src/research-read-retry.ts:9` 的 2 次预算。
  - 绑定：`wrangler.jsonc:39-41`（ai）与 :42-47（vectorize RESEARCH_PUBLIC_INDEX）。
- **修复建议**：语义面失败时回退词法检索或在信封中标明 index-degraded 供调用方降级（`src/index.ts`、`src/research-semantic-index.ts`），并对 ai.run/index.query 加一次内联短重试。验证：生产日志统计 tool=search_documents_semantic 的 research_read_failure 计数与时间点对齐 DEGRADED 轮（需生产日志，见"没验证"栏）。
- **独立核实记录**：证据链成立，全部引用本会话亲读核实，并跑了语义索引测试套件。逐条：
  1. `src/research-semantic-index.ts:311-314` `ai.run` 抛错→`fail("EMBEDDING_UNAVAILABLE", true, "embedding provider is unavailable; retry later")`——行号与字符串逐字吻合。
  2. :372-384 `queryVectorIndex`：index.query 抛错→:379 `fail("INDEX_UNAVAILABLE", true, "vector index is unavailable; retry later")`；返回缺 matches 数组→:382-384 `fail("INDEX_UNAVAILABLE", true, "vector index returned an unexpected shape")`——均 retryable=true。
  3. :139-141 `fail` 构造 `new ResearchBoundaryError("STORE_UNAVAILABLE", undefined, { retryable, safeMessage })`——精确。
  4. :1209-1239 searchPublicDocumentsSemantic 整体 try/catch，:1237-1239 catch→boundaryFailure(:143-146)：边界错误原样重抛，其余任何错误（含 try 内 validateSemanticHit/semanticIndexStatus 的裸 D1 错）一律转成 retryable=true 的 INDEX_UNAVAILABLE——"任何非边界错误也归为 retryable=true"逐字成立。
  5. 工具注册 `src/index.ts:2090-2112`，:2106 包 researchRead→withResearchReadRetry（research_read_failure 事件照打），:2109 deps=semanticIndexDeps(env)（:2365-2374：缺绑定抛非重试 STORE_UNAVAILABLE，有绑定回 {ai: env.AI, index: env.RESEARCH_PUBLIC_INDEX}）；该类边界错误在重试器里被 failureMetadata 归为 TRANSIENT（research-read-retry.ts:151-159），享满 2 次重试（500+1500ms，research-read-retry.ts:9）后仍失败则原样保留 retryable=true 抛出（:211-217）——"重试仍只享 2 次预算"准确。
  6. 绑定：`wrangler.jsonc:39-41` `ai`（AI）、:42-47 `vectorize`（RESEARCH_PUBLIC_INDEX）——行号精确。
  7. 关键差异化已验证：词法面 searchDocuments（research-remote-adapter.ts:273-306）纯 D1 查询，不触碰 ai/vectorize（grep 全文件无 .ai/deps.index 直连）；语义面恰好多出 Workers AI+Vectorize 两个外部依赖——"语义抖而词法好"的穿插形态在代码机制上成立。
  - 已执行检查：`node --experimental-strip-types --test tests/research-semantic-index.test.mjs` → 33 pass / 0 fail；套件 :1140-1153 "index outages surface as STORE_UNAVAILABLE, never as an empty result" 直接注入 fake.ai.fail 与 fake.index.queryFail，两次均断言 STORE_UNAVAILABLE && retryable===true——假设的失败语义有测试锁定。
  - **瑕疵a**："任一抖动即 retryable=true"对抛错型抖动与向量索引形状异常成立，但嵌入输出形状/维度异常是 retryable=false（:316-318 MODEL_RESPONSE_INVALID、:349-356 MODEL_DIMENSION_MISMATCH）——AI 返回畸形输出时该面是非重试形态而非 DEGRADED，措辞略有过度覆盖。
  - **瑕疵b**："09-28 间歇 DEGRADED 穿插 documents=OK"的生产观测是 GPT 侧记录、不在本仓（同前两假设边界），已验证的是机制不是观测本身。
  - **瑕疵c**：生产日志验证（tool=search_documents_semantic 的 research_read_failure 计数对齐 DEGRADED 轮）需生产访问，未跑；另注：该面失败的 research_read_failure 事件 failure_class=TRANSIENT、diagnostic_code=BOUNDARY_STORE_UNAVAILABLE，与一般边界抖动同形，日志区分只能靠 tool 字段（恰好支持修复建议的统计方法）。
  - **瑕疵d（交叉事实，上一会话 git log 亲读）**：语义面由 f16de97 "feat(collector): PUBLIC semantic index (Vectorize + Workers AI BGE-M3)" 引入，紧邻 fcc3e05 之前——若与 fcc3e05 同窗口部署，则 09-28 起读面净增两个外部依赖，为假设 1 的"标签翻转"叠加了"新故障源"的候选解释，但部署时点仓内无证据钉死（同假设 1 的瑕疵1）。

#### 假设 4：绑定/配置类确定性 STORE_UNAVAILABLE（只能解释个别整轮 BLOCKED）

- **复核判定**：confirmed（置信度 low）
- **白话**：如果云平台的某个存储/服务没绑上，每次读都必失败——这属于配置问题，只可能在部署窗口出现，解释不了"时好时坏"。另外行情控制面另有一个名字不同但同样叫"降级"的 KV 绑定问题，排查时别把两处混为一谈。
- **机制**：绑定/配置类确定性 STORE_UNAVAILABLE：研究面 D1/R2 绑定解析为 null、AI/Vectorize 绑定缺失、或内部端点缺 token 时抛非重试 STORE_UNAVAILABLE/503；只在部署窗口或配置漂移时与观测重合，可解释个别整轮 BLOCKED，无法解释"正常轮穿插"。另注意：wrangler.jsonc 的 KV 绑定（PORTFOLIO_UNIVERSE）完全不参与 research 文档库，其缺失只会造成 index.ts:721-733 行情控制面的 DEGRADED——排查时勿把两处 DEGRADED 混为一谈。
- **证据链**：
  - `src/index.ts:834-844` researchAdapter 无 storage→`ResearchReadBackendError("DETERMINISTIC","REPLICA_BINDING_UNAVAILABLE",…)`,经 `src/research-read-retry.ts:221-228` 归一为 retryable=false 的 STORE_UNAVAILABLE。
  - :845-849 researchWorkflowDb 直接 `throw new ResearchBoundaryError("STORE_UNAVAILABLE")`。
  - :2341-2345 storage 双绑定判空；:2365-2374 semanticIndexDeps 缺 AI/RESEARCH_PUBLIC_INDEX→非重试 STORE_UNAVAILABLE（注释明言 must never look like no matches）；:2431-2433/:2514-2517/:2553-2556/:2574-2577/:2601-2604 五处内部端点缺 storage/token→503。
  - 现行 `wrangler.jsonc:23-29`（D1 RESEARCH_REPLICA）、:30-35（R2 RESEARCH_OBJECTS）、:39-47（AI+Vectorize）绑定齐全，配置本身不缺。
- **修复建议**：部署后自检门：把研究面四绑定在位检查加进只读探针（扩展 /api/control-plane-status 或复用 /internal/research-semantic-index/probe，`src/index.ts`），并用 CF_VERSION_METADATA+DEPLOYED_GIT_SHA（wrangler.jsonc:58-60、src/index.ts:156-162 已有绑定）对齐每个观测窗口实际运行的版本。验证：部署记录与观测时间窗比对，排除/坐实异构部署。
- **独立核实记录**：证据链成立，全部锚点本会话亲读，另跑了一个针对性运行探针。逐条：
  1. `src/index.ts:834-844` researchAdapter 无 storage → `ResearchReadBackendError("DETERMINISTIC","REPLICA_BINDING_UNAVAILABLE","ConfigurationError")`——逐字吻合；【运行探针】把该精确错误喂给真模块 withResearchReadRetry（node --experimental-strip-types）：attempts=1、无重试、终态 `{error_code:"STORE_UNAVAILABLE", retryable:false, safe_message:"research read backend failed; retry is not advised"}`——经 research-read-retry.ts:221-228 归一为非重试 STORE_UNAVAILABLE 的链条实测成立（tests/research-read-retry.test.mjs:116-117,217-218 与 research-remote-adapter.test.mjs:311-312 也有 DETERMINISTIC 分类断言，前会话已见 11/11 与 27/27 全绿）。
  2. :845-849 researchWorkflowDb 直接 `throw new ResearchBoundaryError("STORE_UNAVAILABLE")`——存在，但注意该裸抛经 research-outbound-v2.ts:367-369 默认 retryable=true（与其他确定性路径不同，命中时呈可重试形态而非 BLOCKED）——机制原话未明说此点，是一处可补的精度。
  3. :2341-2345 researchReplicaStorage 对 RESEARCH_REPLICA+RESEARCH_OBJECTS 双绑定判空——精确。
  4. :2365-2374 semanticIndexDeps 缺 AI/RESEARCH_PUBLIC_INDEX → 非重试 STORE_UNAVAILABLE，:2362-2363 注释明言 "must never look like \"no matches\""——精确（前会话已验）。
  5. 五处内部端点缺 storage/token → 503：:2430-2433（ingest）、:2514-2517（semantic run）、:2553-2556（status）、:2575-2577（probe，仅 token 判空）、:2601-2604（receipts）——五处逐一亲读，均 `ResearchBoundaryError("STORE_UNAVAILABLE"), 503`。
  6. `wrangler.jsonc:23-29` d1（RESEARCH_REPLICA）、:30-35 r2（RESEARCH_OBJECTS）、:39-41 ai、:42-47 vectorize——仓内配置四绑定齐全，"配置本身不缺"在仓内文件层面成立（生产实际绑定状态仓内无法验证）。
  7. KV 区分：PORTFOLIO_UNIVERSE 全部用点在行情面（index.ts:441-444 quote_catalog、:467-468 live presentation、:1194-1204 live universe、:2634-2638 universe 鉴权），研究面四绑定不含它；缺失时 get_control_plane_status 走 :721-733 DEGRADED 分支（kv_bound:false）——"两处 DEGRADED 勿混淆"的提醒有代码依据。
  8. 版本核验绑定：`wrangler.jsonc:58-60` CF_VERSION_METADATA、index.ts:157 DEPLOYED_GIT_SHA + :158-162 CF_VERSION_METADATA 类型——修复建议所引锚点在位。
  - **边界**：（a）"只在部署窗口或配置漂移时与观测重合、无法解释正常轮穿插"是机制层推理且成立：绑定解析（:2341-2345、:2365-2374）每次调用确定性返回，缺失绑定会在整个部署生命周期内每次读都失败，天然产生不了间歇穿插形态——推理与代码一致。（b）"09-27 个别整轮 BLOCKED/正常轮穿插"的生产观测仍是 GPT 侧记录、不在本仓（四假设同一边界），"是否真有部署窗口重合"需生产部署记录对时，仓内无法执行，未跑。（c）"生产配置绑定齐全"仅核到仓内 wrangler.jsonc，实际部署面（dashboard 绑定状态）未验证，如实报告。

#### 假设 5【放大器而非独立形态】写面 catch-all 归类 + 读写共享同一 D1

- **复核判定**：confirmed（置信度 low）
- **白话**：写入侧把任何数据库错误一律报成"可重试的不可用"，上游 RIWS 按这个记欠账、退避重试；回填补件的批量写和 automation 的读挤同一个数据库，写高峰可能放大读侧瞬态失败——它是放大器，不是独立病因。
- **机制**：写面 ingest 的 catch-all 把任意 D1/R2 写错误一律归为 retryable=true 的 STORE_UNAVAILABLE（HTTP 503），RIWS outbox 据此记债并退避重试；回填批量写与 automation 读共享同一 D1，写高峰可放大读面瞬态失败，助长 H1 的"频度不低"。对 automation 只读观测轮而言它不是直接来源。
- **证据链**：
  - `src/research-replica.ts:322-335` ingest catch-all：任何非 ResearchBoundaryError → health 行置 `last_error_code='STORE_UNAVAILABLE'`（:327）→ `safeFailure("STORE_UNAVAILABLE")`（:334，默认 retryable=true）；:338-353 readResearchReplicaHealth 读失败/无行同样兜底。
  - `index.ts:2496-2500` retryable 错误回 503。
  - RIWS 侧 `quantpro-research/research/riws/src/riws/collector/outbox.py:316-317`（status>=500→STORE_UNAVAILABLE 回执）、:346-353（httpx.RequestError/裸 Exception→STORE_UNAVAILABLE）、:600-615 指数退避重试、:56 `_RETRYABLE_SINK_ERROR_CODES` 含 STORE_UNAVAILABLE。
  - `research-workflow.ts` 写面另有 :553（claim CAS 循环耗尽）、:778、:1220-1224、:1263-1271、:1295-1310 五处 `fail("STORE_UNAVAILABLE")`。
- **修复建议**：ingest catch-all 把底层错误类别记入 health 行（现在只记固定码，:327），RIWS 回填脚本限速错峰避开读高峰（`src/research-replica.ts` + riws scripts）。验证：查 D1 research_replica_health.last_error_code 与 RIWS outbound_outbox 中 STORE_UNAVAILABLE 债务行的时间分布是否与读失败窗口重叠（需生产数据，见"没验证"栏）。
- **独立核实记录**：证据链成立，全部引用本会话亲读核实，套件已跑。逐条：
  1. `src/research-replica.ts:322-335` ingest catch-all：:323 边界错误原样重抛，其余任何错误 → :325-330 健康行置 `last_error_code='STORE_UNAVAILABLE'`（SQL 在 :327，行号精确）→ :334 `safeFailure("STORE_UNAVAILABLE")`；safeFailure（:52-56）是裸 `new ResearchBoundaryError(code)`，经 research-outbound-v2.ts:367-369 默认 retryable=true——"默认 retryable=true"成立。
  2. :338-353 readResearchReplicaHealth：无行 :347、读失败非边界 :351，同样兜底 safeFailure(STORE_UNAVAILABLE)——精确。
  3. `index.ts:2496-2500` `retryable ? 503 : 400`——逐字吻合，retryable=true 即回 503。
  4. RIWS 侧 `quantpro-research/research/riws/src/riws/collector/outbox.py`：:316-317 `status >= 500 or status <= 0` → STORE_UNAVAILABLE 回执——精确；:347-348 httpx.RequestError → STORE_UNAVAILABLE、:352-353 裸 Exception → STORE_UNAVAILABLE（:349-351 本地畸形才 INTEGRITY_FAILED）；:54-57 `_RETRYABLE_SINK_ERROR_CODES` 含 STORE_UNAVAILABLE（恰在 :56）；:603-618 `_handle_rejection` 非重试/超 5 次→mark_outbound_failed，否则 :615 `outbox_backoff_seconds(attempts)`、:617 `mark_outbound_retry`——退避公式 :76-77 `min(MAX, BASE * 2**attempts)` 确为指数封顶，"记债并退避重试"成立（"债"的提法另见 backfill_requeue_failed_outbox.py:5，前会话已验）。
  5. `research-workflow.ts` 写面 `fail("STORE_UNAVAILABLE")` 亲读确认：:553（job claim 租约 CAS 循环耗尽，:528 "raced; retry once" 循环尾）、:778（后台 finish .catch→fail）、:1223（deferral 插入无并发回放可依）、:1269 与 :1271（映射完整性/查询 catch，两处都在 :1263-1271 区间内）、:1310（receipts 查询 catch）——五区间全覆盖且行号准确。
  6. 共享 D1 结构性成立：单一 RESEARCH_REPLICA 绑定同时服务 ingest 写（research-replica.ts:244+ 的 D1 batch）与 automation 读（researchAdapter→researchReplicaStorage，index.ts:2341-2345/834-844），回填经 /internal/research-replica/v2/ingest（outbox.py:59 常量）打进同一库——"写高峰可放大读面瞬态失败"的管道存在。
  - 已执行检查：`node --experimental-strip-types --test tests/research-replica.test.mjs` → 12 pass / 0 fail。
  - **瑕疵a**：ingest catch-all 路径在 tests/research-replica.test.mjs 无专门断言（该文件 grep STORE_UNAVAILABLE 零命中；STORE_UNAVAILABLE 断言在 test_research_receipts.mjs:127 走的是别的入口），该行为仅读码核实，无测试锁定。
  - **瑕疵b**："写高峰可放大读面瞬态失败"是机制可能性：回填是否真在 09-27/28 读失败窗口产生写高峰，需生产 D1 health 表与 RIWS outbox 债务行时间分布对时，仓内无此数据，未跑；假设自身已正确定位为"放大器而非独立形态/对只读观测轮非直接来源"，与证据范围自洽。
  - **瑕疵c**："09-27 三连 BLOCKED/间歇 DEGRADED"的生产观测仍是 GPT 侧记录、不在本仓（五个假设同一边界）。

### 2.2 unconfirmed 组

无。五条候选原因均判定 confirmed。

---

## 三、验证了什么 / 没验证什么

### 3.1 验证了什么（各会话实际执行，凭据见上文各"独立核实记录"）

**信封契约修复侧：**

- 修复前探针复现：终态更新后 `collector_build_sha`/`cloudflare_version_id` 两列均为 `"2026-09-28T20:08:17.799Z"`（与复核指认一致；复核阶段探针测得 `"2026-09-28T20:03:36.258Z"`，系两次独立探针运行，结论一致）。
- 修复后同探针返回 `BUILD_MARKER_1234`/`VER_MARKER_5678` 且 `updated_at` 正常；新增用例 build attribution survives the terminal update（心跳+PERSISTED 双路径）。
- `tests/run-envelope.test.mjs` 18/18；`npx tsc --noEmit` 绿；`npm test` 全量 327/327（基线 297+新增 30）；复核修复后重跑门禁 test exit 0 / type-check exit 0。
- `insertUnknownRunRow`/`insertInvalidRunRow` 的 `?11,?11` 复用经逐参核对为有意绑定同一 nowIso，无同类错位。

**根因调查侧（代码与 git 证据，均在调查会话亲读/实跑）：**

- 现行代码逐行亲读：`src/research-read-retry.ts`（:9 重试预算 [500,1500]ms、:138-143 UNKNOWN 分类、:192-193 单次重试闸、:221-228 兜底 retryable）、`src/research-remote-adapter.ts`（:74-79 非重试缺对象错误、:355-377 getDocument、:425-428 getEvidence）、`src/research-semantic-index.ts`（:311-314/:372-384/:139-141/:1209-1239）、`src/index.ts`（:834-849、:2341-2345、:2365-2374、五处内部端点 503、:2496-2500、读面接线 :2077-2164）、`src/research-replica.ts`（:322-335 ingest catch-all、:338-353、:234-242 写入顺序）、`src/research-workflow.ts`（五处 fail("STORE_UNAVAILABLE") 行号逐一核对）、`wrangler.jsonc` 四绑定（:23-47）与版本核验绑定（:58-60）。
- fcc3e05 diff（git show 亲读）：UNKNOWN 类 retryable 由 false→true 翻转 + 两个 prompt 新增 RESEARCH_DEGRADED 规则；fcc3e05^ 时点 5 个 prompt 源文件（编译 6 个生产任务）grep -c STORE_UNAVAILABLE 全为 0。
- 双版本对照探针（node --experimental-strip-types 跑真模块非复刻）：
  - 现行码：`'D1_ERROR: internal error: INTERNAL'` / `'D1_ERROR: too many requests'` / `'database session was terminated'` → UNKNOWN → 终态 `{STORE_UNAVAILABLE, retryable:true}`（2 次尝试/1 次重试）；`'Network connection lost'`/`'fetch failed'` → TRANSIENT（3 次尝试/2 次重试）；`'no such table'` → DETERMINISTIC（retryable=false）。
  - fcc3e05^ 源码同探针：同样三条 UNKNOWN 消息 → 1 次尝试、will_retry=false、retryable=false（BLOCKED 形态）。
  - REPLICA_BINDING_UNAVAILABLE 喂真模块 → attempts=1 不重试、终态 retryable=false。
- 写入顺序反证：`src/research-replica.ts:234-242` 先写 R2 再写 D1 batch——同码序内崩溃只会留下相反方向缺口（R2 有对象/D1 无元数据），产生不了"元数据有/对象无"。
- 词法 vs 语义依赖差异：searchDocuments（research-remote-adapter.ts:273-306）纯 D1、全文件无 ai/index 直连；语义面恰好多 Workers AI + Vectorize。
- 测试套件实跑全绿（均为 `node --experimental-strip-types --test` 实跑）：`tests/research-read-retry.test.mjs` 11/11、`tests/research-remote-adapter.test.mjs` 27/27（含 C8"全缺对象→STORE_UNAVAILABLE 且 retryable=false"断言）、`tests/research-semantic-index.test.mjs` 33/33（含"索引故障以 STORE_UNAVAILABLE 呈现、绝不冒充空结果"断言）、`tests/research-replica.test.mjs` 12/12。
- RIWS 侧债务文档亲读：`backfill_public_replica.py:1-9`（"Why this tool exists (2026-09-28 task E)"，--limit 默认 500 投影窗口）、`backfill_requeue_failed_outbox.py:5`（"STORE_UNAVAILABLE debt"，债务早于 09-27）；`outbox.py` 回执与指数退避逻辑（:316-353、:600-618、:76-77）。

### 3.2 没验证什么（仓内无法执行 / 本会话未跑）

- **生产观测记录本身**："09-27 三连 BLOCKED（retryable=false）/ 09-28 间歇 DEGRADED（retryable=true）/ 正常轮穿插"是 GPT 侧 automation 会话观察，不在本仓（observers/ 与 .sdd 均无原文）——已验证的是代码机制在这两个时点必然产出这两种形态，不是观测记录本身。
- **生产日志对账类验证均未跑**（需生产访问）：
  - 生产 research_read_failure 事件频度在修复前后的对比（假设 1 修复建议的验证手段）；
  - 对当轮 BLOCKED 涉及的 document_id 逐个 get_document 读回抽样 / 日志 grep "research replica object is unavailable; retry is not advised" 固定特征（假设 2 的验证手段）；
  - tool=search_documents_semantic 的 research_read_failure 计数与 DEGRADED 轮时间点对齐（假设 3 的验证手段）。
- **fcc3e05 的实际部署时刻"约 02:31 UTC"属未验证推断**：仓内无钉死证据；production-health.md:45 记录的 2026-09-28T10:31:55Z（Cloudflare Version ID 8cb754e8）实为另一次更晚的 HOST_SAFETY 修复部署，疑为时间误换算——该瑕疵不参与因果链（代码翻转与两版形态已直接实测）。
- **f16de97（语义索引引入）与 fcc3e05 是否同窗口部署**：部署时点仓内无证据（假设 3 瑕疵d）。
- **部署面实际绑定状态**：仅核到仓内 wrangler.jsonc，Cloudflare dashboard 侧绑定未验证（假设 4 边界c）。
- **部署记录与观测窗口的对时**："是否真有部署窗口重合"需生产部署记录，仓内无法执行（假设 4 边界b）。
- **写高峰假设的对时**：回填是否真在 09-27/28 读失败窗口产生写高峰，需生产 D1 research_replica_health.last_error_code 与 RIWS outbound_outbox 债务行时间分布，仓内无数据（假设 5 瑕疵b）。
- **两处仅有读码核实、无测试锁定的路径**：getEvidence 缺对象分支（getDocument 有 C8 两条、getEvidence 无专门测试）；ingest catch-all 转 STORE_UNAVAILABLE（research-replica.test.mjs 无断言）。
