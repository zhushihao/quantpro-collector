-- #37: one-row-per-run Automation audit.
-- Operational telemetry only; never writes investment state.
CREATE TABLE IF NOT EXISTS automation_runs_v2 (
	task_name TEXT NOT NULL,
	run_id TEXT NOT NULL,
	principal TEXT,
	invocation_key TEXT,
	scheduled_for TEXT,
	started_at TEXT,
	finished_at TEXT,
	outcome TEXT CHECK (outcome IS NULL OR outcome IN ('COMPLETED','SILENT','BLOCKED','FAILED')),
	fresh_delta_count INTEGER CHECK (fresh_delta_count IS NULL OR fresh_delta_count >= 0),
	notification_intended INTEGER CHECK (notification_intended IS NULL OR notification_intended IN (0,1)),
	notification_sent_legacy INTEGER CHECK (notification_sent_legacy IS NULL OR notification_sent_legacy IN (0,1)),
	reason TEXT,
	prompt_version TEXT,
	collector_build_sha TEXT,
	cloudflare_version_id TEXT,
	source_contract TEXT NOT NULL CHECK (source_contract IN ('run-v2','legacy-event-v1')),
	legacy_trace_id TEXT,
	legacy_started_sha256 TEXT,
	legacy_final_sha256 TEXT,
	final_payload_sha256 TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (task_name, run_id)
) WITHOUT ROWID;

CREATE UNIQUE INDEX IF NOT EXISTS automation_runs_v2_invocation
	ON automation_runs_v2 (principal, task_name, invocation_key)
	WHERE principal IS NOT NULL AND invocation_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS automation_runs_v2_task_time
	ON automation_runs_v2 (task_name, started_at DESC, finished_at DESC);

CREATE INDEX IF NOT EXISTS automation_runs_v2_time
	ON automation_runs_v2 (started_at DESC, finished_at DESC);

INSERT OR IGNORE INTO automation_runs_v2 (
	task_name, run_id, principal, invocation_key, scheduled_for,
	started_at, finished_at, outcome, fresh_delta_count,
	notification_intended, notification_sent_legacy, reason, prompt_version,
	collector_build_sha, cloudflare_version_id, source_contract,
	legacy_trace_id, legacy_started_sha256, legacy_final_sha256,
	final_payload_sha256, created_at, updated_at
)
SELECT
	task_name,
	run_id,
	NULL,
	NULL,
	MAX(scheduled_for),
	MAX(CASE WHEN phase='STARTED' THEN occurred_at END),
	MAX(CASE WHEN phase='FINAL' THEN occurred_at END),
	MAX(CASE WHEN phase='FINAL' THEN status END),
	MAX(CASE WHEN phase='FINAL' THEN fresh_delta_count END),
	NULL,
	MAX(CASE WHEN phase='FINAL' THEN notification_sent END),
	COALESCE(
		MAX(CASE WHEN phase='FINAL' THEN blocker_code END),
		MAX(CASE WHEN phase='FINAL' THEN safe_summary END)
	),
	COALESCE(
		MAX(CASE WHEN phase='FINAL' THEN prompt_version END),
		MAX(CASE WHEN phase='STARTED' THEN prompt_version END)
	),
	COALESCE(
		MAX(CASE WHEN phase='FINAL' THEN collector_build_sha END),
		MAX(CASE WHEN phase='STARTED' THEN collector_build_sha END)
	),
	COALESCE(
		MAX(CASE WHEN phase='FINAL' THEN cloudflare_version_id END),
		MAX(CASE WHEN phase='STARTED' THEN cloudflare_version_id END)
	),
	'legacy-event-v1',
	COALESCE(
		MAX(CASE WHEN phase='FINAL' THEN trace_id END),
		MAX(CASE WHEN phase='STARTED' THEN trace_id END)
	),
	MAX(CASE WHEN phase='STARTED' THEN payload_sha256 END),
	MAX(CASE WHEN phase='FINAL' THEN payload_sha256 END),
	NULL,
	MIN(created_at),
	MAX(created_at)
FROM automation_run_events_v1
GROUP BY task_name, run_id;
