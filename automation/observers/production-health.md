# 生产任务健康检查

AUTOMATION_ID=6ab945aaa9448191915faea313c93bcc
SYNC_KIND=AUTOMATION_SEMANTIC_SNAPSHOT
SYNCED_AT=2026-09-28
TIMING_MODE=exact_schedule
SCHEDULE=Asia/Shanghai hourly at :55

> 本文件记录当前长期健康检查规则的语义快照，供 ZCode / 审计查看。该观察器历史上做过 prompt-only 热修，而当前接口无法按单任务导出可校验的完整保存正文，因此这里明确标记为 semantic snapshot，不冒充逐字节镜像。线上 Automation 仍是执行权威。

## 当前规则

只读检查六个生产 REGISTRY_KEY 的 Scheduler 状态与 Collector Automation Run Audit：
- industry-research
- ai-financing-rates
- central-policy
- company-facts
- holding-assistant-intraday
- holding-assistant-preclose

禁止自动重跑、重建、启停或修改任何生产 Automation；禁止修改业务状态。健康检查只负责识别异常和给出短中文说明。

### 逻辑调度窗口

1. 优先使用 `scheduled_for` 归并同一逻辑调度窗口。
2. `scheduled_for=null` 时，只在以下条件同时成立时保守归并：
   - REGISTRY_KEY 相同；
   - prompt_version 相同；
   - 属于同一实际计划窗口；
   - STARTED 时间相差不超过 15 分钟。
3. 同一逻辑窗口存在 FINAL：
   - FINAL=SILENT / COMPLETED：该业务窗口正常收口；额外超过 30 分钟仍无 FINAL 的 STARTED sibling 只记为“审计孤儿/重复尝试”，不得记作“运行未正常收口”，不得增加业务失败次数。
   - FINAL=BLOCKED / FAILED：以真实 FINAL 故障为主；孤儿 sibling 仅作为次级审计异常。
4. 只有某一逻辑窗口的所有尝试在计划时间 +30 分钟后仍都没有 FINAL，才判定“运行未正常收口”。
5. 同窗出现多个 STARTED 可以报告“重复尝试/审计孤儿”；数量增加时写“审计孤儿数量扩大”，不得写成“第 N 条业务运行失败”。

### Scheduler 与执行体区分

- Scheduler 的 last_run 已推进，但计划窗口 +30 分钟后 Collector 仍没有 STARTED：判定“运行未进入执行体”。
- 计划时间已过 +30 分钟，Scheduler last_run 也没有推进：判定“疑似漏调度”。
- 不根据单条 Collector 孤儿记录推断 Scheduler 漏调度。

### company-facts 特殊基线

- HOST_SAFETY 修复的 post-fix 时间基线：2026-09-28T10:31:55.434604Z（18:31:55+08）。
- 首个已知修复版 Cloudflare Version ID：`8cb754e8-9926-43c3-b70b-17d207e43eda`，仅作为历史锚点；后续正常部署可产生新的 Version ID。
- 该时间之前的 `COMPANY_NARROW_APPEND_BLOCKED_HOST_SAFETY` 只属于 pre-fix 历史，不计为修复后回归。
- 该时间之后的自然 Fresh-Delta 若再次出现同类宿主拦截，才是新的真实 BLOCKED。

### 输出

- 面向非技术用户，中文短报。
- 只报告真正的新异常、影响范围扩大、状态恢复或需要人工处理的硬缺口。
- 不自动修复，不自动重跑，不自动重建。
