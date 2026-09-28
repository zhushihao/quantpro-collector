-- 单次交件契约的运行审计（spec docs/specs/2026-09-29-envelope-spec.md §4.1/§6.1）。
-- 终态由 Collector 从信封处理结果派生，模型不再自报。
-- 运行时 ensure（src/automation-schedule.ts）与本迁移使用同一表结构与同六行排班种子。
CREATE TABLE IF NOT EXISTS automation_runs_v3 (
	task_name TEXT NOT NULL,
	run_id TEXT NOT NULL,
	envelope_key TEXT NOT NULL,
	channel TEXT,
	write_key TEXT,
	as_of TEXT,
	received_at TEXT NOT NULL,
	slot TEXT,
	slot_date TEXT,
	fresh_delta_count INTEGER CHECK (fresh_delta_count IS NULL OR fresh_delta_count >= 0),
	event_count INTEGER CHECK (event_count IS NULL OR event_count >= 0),
	outcome TEXT NOT NULL CHECK (outcome IN ('COMPLETED','SILENT','BLOCKED','FAILED','UNKNOWN')),
	blocker_code TEXT,
	summary TEXT,
	prompt_version TEXT,
	collector_build_sha TEXT,
	cloudflare_version_id TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (task_name, run_id)
) WITHOUT ROWID;

CREATE UNIQUE INDEX IF NOT EXISTS automation_runs_v3_envelope
	ON automation_runs_v3 (task_name, envelope_key);

CREATE INDEX IF NOT EXISTS automation_runs_v3_task_time
	ON automation_runs_v3 (task_name, received_at DESC);

CREATE INDEX IF NOT EXISTS automation_runs_v3_time
	ON automation_runs_v3 (received_at DESC);

-- 排班表：MISSED_SLOT 读时派生与 slot 绑定的事实源；enabled/window_minutes 可运行时修正。
CREATE TABLE IF NOT EXISTS automation_schedule_v1 (
	task_name TEXT PRIMARY KEY,
	slot_times TEXT NOT NULL,
	weekdays TEXT NOT NULL,
	window_minutes INTEGER NOT NULL DEFAULT 40,
	enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
	updated_at TEXT NOT NULL
) WITHOUT ROWID;

-- 六行排班种子 = automation/control/production.json 排班实况（Asia/Shanghai；0=周日）。
-- src/automation-schedule.ts 的运行时 ensure 使用同一常数（INSERT OR IGNORE，幂等）。
INSERT OR IGNORE INTO automation_schedule_v1 (task_name, slot_times, weekdays, window_minutes, enabled, updated_at)
VALUES
	('holding-assistant-preclose', '["09:10","10:10","16:45"]', '[1,2,3,4,5]', 40, 1, '2026-09-29T00:00:00Z'),
	('holding-assistant-intraday', '["09:50","10:50","11:50","13:50","14:50"]', '[1,2,3,4,5]', 40, 1, '2026-09-29T00:00:00Z'),
	('industry-research', '["00:45","01:45","02:45","03:45","04:45","05:45","06:45","07:45","08:45","09:45","10:45","11:45","12:45","13:45","14:45","15:45","16:45","17:45","18:45","19:45","20:45","21:45","22:45","23:45"]', '[0,1,2,3,4,5,6]', 40, 1, '2026-09-29T00:00:00Z'),
	('company-facts', '["00:00","01:00","02:00","03:00","04:00","05:00","06:00","07:00","08:00","09:00","10:00","11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00","20:00","21:00","22:00","23:00"]', '[0,1,2,3,4,5,6]', 40, 1, '2026-09-29T00:00:00Z'),
	('central-policy', '["00:00","01:00","02:00","03:00","04:00","05:00","06:00","07:00","08:00","09:00","10:00","11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00","20:00","21:00","22:00","23:00"]', '[0,1,2,3,4,5,6]', 40, 1, '2026-09-29T00:00:00Z'),
	('ai-financing-rates', '["00:00","04:00","08:00","12:00","16:00","20:00"]', '[0,1,2,3,4,5,6]', 40, 1, '2026-09-29T00:00:00Z');
