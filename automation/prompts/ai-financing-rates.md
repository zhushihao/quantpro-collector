# AI 融资与长端利率
PROMPT_ID=ai-financing-rates
STATUS=PRODUCTION
WRITE_SCOPE=READ_ONLY

研究AI基础设施融资与美国长期资本成本的边际关系，不预设结论。全程只读，不写任何State Gateway通道/外部账本；禁止claim_research_job、submit_research_result_proposal、defer_research_job。

## 每轮核验
实际调用 get_control_plane_status，读PUBLIC Research replica的get_source_health/get_coverage_status，按ai-compute/AI基建融资查询可用documents/evidence/accumulator；研究副本补长期证据链，搜索数量不等于证据强度。仅需组合或市场映射时调用get_portfolio_quotes，用本轮live_universe相关ACTIVE，MAPPING_ONLY不算持仓。riws-leads主题线索（kind=lead）同为候选入口：涉及融资/债券发行/利率/资本开支/数据中心电力等资金面的线索，按其terms检索历史documents，判别是新话题还是已有话题的补充（补充须引用历史口径对比后再输出）；lead仅为发现入口，正式事实仍须按下方来源联网核验，原文与身份不出线索层。
必须联网核验美国国债2年/10年/30年与期限结构、通胀和Fed路径、财政部发行/净供给、公司债一级发行与信用利差、AI/云厂商/数据中心/电力融资，以及项目期限、规模、认购需求。优先财政部、Federal Reserve、SEC、公司公告和债券发行文件，辅以高可信一手报道。
PUBLIC Research历史只读检索返回STORE_UNAVAILABLE时，标记RESEARCH_DEGRADED，继续独立的官方联网发现与核验。riws-leads为NO_NEW_CONTENT时无需历史去重，本轮以summary空包正常交件（终态由服务端派生），不因这次检索整轮阻断；有lead且历史是必要判断依据时仅将该lead标为INCONCLUSIVE并延后，其他候选继续。只有官方发现、必要Collector事实源及历史判定路径都无法完成本轮正确判断时，才整轮阻断。

## 因果判断
核心问题：AI资本开支偏好长久期资金，新增公司债/项目融资是否挤压长期资金供给并影响长端资本成本。严格执行末尾因果Guidance；分别列已确认事实、投资推断、替代解释、尚缺证据。
只处理上次观察后的新发行、融资结构、期限延长、利差/发行节奏/认购、项目规模、期限溢价或供给结构变化。旧融资、旧新闻、旧财报仅背景；趋势不自动等于个股买卖信号。宏观/融资关键链不可用且关键事实不能确认，或Collector研究面断裂影响证据链时阻断；非关键缺口、backlog、单笔暂缺第二来源为警告。

## 输出
每个变化：【AI融资与长端利率】主题；一句话结论（融资改善/恶化/分化，挤出假设置信度上升/下降/不变）；发生了什么（1–3新规模/期限/利差/认购/风险转移事实）；为什么重要（钱更难拿/更贵/仅高信用可得/长钱压力）；美债这边发生什么（仅相关2/10/30年与期限结构，注明时间/口径）；对核心假设影响（时间和机制证据，为什么替代解释不足）；还有哪些更可能解释（1–3项及解释力）；对组合影响（必要时仅相关ACTIVE，讲兑现节奏/资本成本不作买卖信号）；接下来只盯什么（1–3可改变判断的长期发行/利差/认购、风险转移、实际通电/再融资指标）。不堆债券术语，不把单次美债涨跌归因于AI。
