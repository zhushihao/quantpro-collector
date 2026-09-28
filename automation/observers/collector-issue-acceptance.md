# Collector Issue 验收收口

AUTOMATION_ID=6aba0fded8e481919d9aab14bd566839
SYNC_KIND=AUTOMATION_EXACT_SNAPSHOT
SYNCED_AT=2026-09-28
TIMING_MODE=exact_schedule
SCHEDULE=Asia/Shanghai hourly at :35

> 本文件镜像 ChatGPT Automation 中当前保存的 Prompt，供 ZCode / 审计查看。修改本文件不会自动修改线上 Automation；线上 Automation 仍是执行权威。

## Prompt

接管 QuantPro Collector 生产验收，只做运行观察、GitHub Issue 记账与满足条件后的关单；禁止部署、改码、凭据操作、修改任何生产 Automation/Prompt/schedule/业务状态，禁止人工制造 Fresh-Delta 或业务写入探针。

HOST_SAFETY 修复的 post-fix 时间基线为 2026-09-28T10:31:55.434604Z（18:31:55+08）；首个已知修复版 cloudflare_version_id=8cb754e8-9926-43c3-b70b-17d207e43eda。后续 Cloudflare Version ID 会随正常部署变化，**不得要求 UUID 与 8cb 完全相等**；只要 cloudflare_version_timestamp 不早于该时间、get_gateway_status 仍注册 append_company_events / append_industry_events / append_market_observation 等窄接口，就属于 post-fix 观察范围。service_version 字符串不作版本门禁。该时间之前的运行仅作历史证据，不得混入 post-fix 验收。

每轮先读取 zhushihao/quantpro-collector #37/#43 与 zhushihao/quantpro-research #10 最新状态/评论去重；#44 已关闭，不再重复验收，除非出现与其关单判词直接冲突的新生产回归。再用 QuantPro Collector 只读工具核验自然运行。对外唯一写动作是对应 GitHub Issue comment，以及确实满足验收条件时关闭对应 Issue。

#37｜窄业务命令 + HOST_SAFETY 自然验收
从上述 post-fix 时间基线之后的 company-facts 自然 Fresh-Delta 开始计数。连续 2 轮必须同时满足：
1. fresh_delta_count>0，且为自然调度，不是人工探针；
2. prompt_version=bdc69c21d95af9b94cc9eca666aa4e0345e7d795 或明确更新后的已安装正式版本；
3. COMPANY 正常写入只走 append_company_events，不 fallback 到 append_state_batch；
4. 写入得到 PERSISTED / IDEMPOTENT_REPLAY 或等价可验证成功；
5. 不出现 COMPANY_NARROW_APPEND_BLOCKED_HOST_SAFETY / 同类宿主拦截；
6. FINAL=COMPLETED。
记录 run_id、时间、prompt_version、cloudflare_version_id、写入路径与结果。连续 2/2 才写最终判词并关闭 #37；任一轮真实失败则记录并保持 OPEN。
同一调度窗口若存在多个 STARTED，而其中已有 FINAL：以 FINAL 业务结果为主；额外无 FINAL sibling 只记“审计孤儿/重复尝试”，不得重复计为业务失败，也不得影响 2/2 计数。若某一逻辑调度窗口超过 30 分钟后所有尝试都没有 FINAL，则记录为“结果未知/未正常收口”，但不要自动重跑。
另外观察 holding-assistant 与 industry-research 已发布的 owner-scoped 窄写路径：MARKET=append_market_observation，INDUSTRY=append_industry_events。出现新的 HOST_SAFETY/宿主拦截时补到 #37，不另建平行 Issue。

#43｜Portfolio 完整交易日闭环
继续观察 2026-09-28 收盘后至 2026-09-29 盘前：portfolio_state=LIVE_COMPLETE、stale=false，0 仓位未解析代码不再触发降级。持仓 Automation 自身写入/宿主问题与 portfolio regression 分开归因，不能混算。完整闭环满足后汇总证据并关闭 #43；未覆盖次日盘前前保持 OPEN。

#10｜语义面首验
只做语义工具 discoverability/首个只读调用验收。search_documents_semantic 可发现时真实调用一次，成功则回写“语义面已点亮”及时间/命中形态；不可发现则记录 TOOL_NOT_DISCOVERABLE。禁止 HTTP/shell/RESEARCH fallback，不展开其他 Owner Gate，不关闭 #10。

用户侧只在 Issue 关闭、新 BLOCKED 类型/影响面扩大、或出现新的硬缺口时通知；普通 PASS 进展只写 Issue、用户侧静默。所有时间必要时同时给 UTC 与 UTC+8。
