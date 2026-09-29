-- 受控 Issue 记账去重表（issue #52，2026-09-30）。
-- Scheduled Task 只提交记账意图；GitHub 副作用由 Collector 代做并留回执。
-- 运行时 ensure（src/issue-bookkeeping.ts）与本迁移使用同一表结构。
-- 五个回执态中仅三个落表：IDEMPOTENT_REPLAY 是"命中已有行"的应答派生，
-- REJECTED_TARGET 在白名单/形状校验阶段确定性拒绝、不入账（fail-fast，不养重试垃圾）。
CREATE TABLE IF NOT EXISTS issue_bookkeeping (
	dedupe_key TEXT PRIMARY KEY,
	source_task TEXT NOT NULL,
	target_key TEXT NOT NULL,
	operation TEXT NOT NULL CHECK (operation IN ('COMMENT','CLOSE')),
	status TEXT NOT NULL CHECK (status IN ('PERSISTED','DELIVERY_BLOCKED','OUTCOME_UNKNOWN')),
	issue_comment_id TEXT,
	url TEXT,
	detail TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
) WITHOUT ROWID;
