# #47 收件事实与 Prompt 版本真实性修复

## 范围与基线

仅处理 2026-10-02 用户授权的两项：删除影子排班推算；非 MARKET Prompt 版本无真实来源时保持未知。实施前核对 Issue 正文及最新补充评论 5902718196。基于线上同版 `fdcb616810ae68615086f135b997d9fb4981c9c6`，Cloudflare 版本 `7258a935-41f0-4f24-a86d-cddf597dd7ab`。

发布目录为 RESEARCH 的 `D:\quantpro-collector`。原目录仅有 5 个未跟踪文件：package-lock.json、两份 SQL、两份 wrangler.deploy-*.jsonc；记录 SHA-256 后保留，不包含在本提交中。旧 `D:\QuantPro\cn-hk-quotes-mcp` 未修改。

线上前置证据：central-policy `run_c4c7e05b82584202bf6838452e133472` 收于 `2026-10-01T22:29:31.745Z`（北京 10 月 2 日 06:29），SILENT、无阻断。旧历史接口同时合成 05:00 MISSED_SLOT，且该真实行的 prompt_version 被填成 Collector build SHA。本次不排查宿主安全拦截。

## 实现边界

- 删除 `src/automation-schedule.ts`、所有生产排班读写/种子初始化、运行归槽、MISSED_SLOT 派生及 Worker 定时收尾对账。Worker 的实际 cron 配置不变。
- v3 收件表与索引初始化搬入现有 automation-run-ledger；历史 migration 和已有 schedule 表/行保持原状，不重写历史。
- 历史只返回实际审计行。健康快照保留最后真实 received_at 并计算距今秒数；无记录为 null/未知，不推断宿主触发、漏跑、扫描完成或通知送达。
- 兼容输出字段 slot/slot_date 固定 null，schedule_basis 固定 UNKNOWN，不再展示旧推算结果。MARKET 业务 payload 的 trading_date/scheduled_slot/production_ref 原样传给既有业务写入口，未删除或改门禁。
- 新非 MARKET v3 行 prompt_version=null。当前交件合同没有非 MARKET Prompt 来源，不能靠 Collector build 或当前仓库 HEAD 补造；collector_build_sha/cloudflare_version_id 仍单独保留。
- 对历史 v3 记录做只读来源投影：仅 MARKET 信封身份下的合法 production_ref 可展示。MARKET UNKNOWN/失败前尚未保存 channel 时也依据 E:MARKET 身份保留真实版本。非 MARKET 历史错误值不改库，读出为未知；v1/v2 原有实际传入版本不变。
- 既有 as_of 数据年龄提示保留固定 40 分钟 / 未来 5 分钟容差，与任务排班无关，不作为漏跑结论或业务硬门。

未修改 Automation Prompt/调度/title/enabled/notifications、业务账本、业务校验、HB/OB/BL 幂等粒度、旧接口生命周期或配额实现；无新增 MCP 接口/入参、无 LIVE 操作、无生产写探针。#47 其他减法项及全面自然验收不在这次两项授权内。

## 验证与发布

回归覆盖：无排班表的初始化与交件/历史/健康读取；空历史不造漏跑；迟到、非整点、周末收件；旧错误版本/槽位只读隐藏且原行不变；所有任务心跳、观察、前置拒绝和非法信封无版本伪造；MARKET 真实版本和业务时点保留；生产源码无影子排班依赖。保留既有业务幂等、并发、回执、失败与 MCP 权限测试。

正式命令：`npm run type-check`（等价执行 node node_modules/typescript/bin/tsc --noEmit），`npm test`，`npm run deploy`。只通过既有 deploy-with-sha.mjs 注入 Collector 构建 SHA，禁止裸 wrangler deploy。

最终测试汇总、提交 SHA、线上新版本、真实回读样本及未验证项追加到 #47，不在部署之前把自然运行验收写成完成，不提前关单。
