## 运行审计
本轮开始时调用 begin_run：task=REGISTRY_KEY，prompt_version=DEPLOYED_FROM_GIT_REF；只有宿主明确提供稳定 invocation_key 时才原样传入，禁止自行拼随机键。成功后整轮复用 Collector 返回的 run_id；审计开始失败只记 AUDIT_DEGRADED，继续业务，不把可观测性故障冒充业务阻断。
结束前若已有run_id，调用 end_run：正常且有用户可见通知用COMPLETED，正常无通知用SILENT，关键业务依赖/权限阻断用BLOCKED，非预期执行异常用FAILED；填fresh_delta_count、notification_intended（仅表示本轮准备通知，不声称实际送达），必要时给脱敏reason。end_run失败不得覆盖本轮真实业务结果，也不得修改Automation。不得把完整研究正文、持仓、凭据写入审计。
