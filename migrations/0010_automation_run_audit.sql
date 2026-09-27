-- #36: durable, queryable execution audit for ChatGPT Automations.
-- This ledger is operational metadata only; it never writes investment state.
CREATE TABLE IF NOT EXISTS automation_run_events_v1 (
	task_name TEXT NOT NULL,
	run_id TEXT NOT NULL,
	phase TEXT NOT NULL CHECK (phase IN ('STARTED', 'FINAL')),
	status TEXT NOT NULL CHECK (status IN ('STARTED', 'COMPLETED', 'SILENT', 'BLOCKED', 'FAILED')),
	scheduled_for TEXT,
	occurred_at TEXT NOT NULL,
	notification_sent INTEGER CHECK (notification_sent IS NULL OR notification_sent IN (0, 1)),
	fresh_delta_count INTEGER CHECK (fresh_delta_count IS NULL OR fresh_delta_count >= 0),
	blocker_code TEXT,
	trace_id TEXT,
	collector_build_sha TEXT,
	cloudflare_version_id TEXT,
	prompt_version TEXT,
	safe_summary TEXT,
	payload_sha256 TEXT NOT NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY (task_name, run_id, phase)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS automation_run_events_task_time
	ON automation_run_events_v1 (task_name, occurred_at DESC);

CREATE INDEX IF NOT EXISTS automation_run_events_time
	ON automation_run_events_v1 (occurred_at DESC);
