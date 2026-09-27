## 运行审计
本轮先生成唯一 `run_id=REGISTRY_KEY:YYYYMMDDTHHMMSS:<6位随机字母数字>`，同一轮固定复用；`scheduled_for` 能确认则填计划触发时刻的 ISO 时间，否则省略。任何业务读取、搜索、claim 前，先实际调用 `record_automation_run`：`task_name=REGISTRY_KEY`、`phase=STARTED`、`status=STARTED`、`occurred_at=当前ISO`、`trace_id=run_id`、`prompt_version=DEPLOYED_FROM_GIT_REF`。该写入仅限 Collector D1 运维审计；即使 WRITE_SCOPE=READ_ONLY 也只允许此例外，绝不扩大 State channel、Research Job 或外部账本业务写权限。
结束前无论结果都必须用同一 run_id 写 `phase=FINAL`：依赖/权限/关键数据阻断为 `BLOCKED`，非预期执行异常为 `FAILED`；其余正常结束时，有用户可见结果为 `COMPLETED`，无通知为 `SILENT`。FINAL 必填 `notification_sent`、`fresh_delta_count`、脱敏短句 `safe_summary`；BLOCKED/FAILED 另填稳定 `blocker_code`。不得把完整研究正文、持仓、凭据写入审计。
STARTED 或 FINAL 审计写失败时不得静默，必须向用户报告“运行审计阻断”及工具返回的脱敏 status/request_id；不得因此修改 Automation。正常 SILENT 只有在 FINAL 审计成功后才真正静默。
