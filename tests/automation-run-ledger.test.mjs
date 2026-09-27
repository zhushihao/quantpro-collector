import assert from "node:assert/strict";
import test from "node:test";

import {
	AutomationRunLedgerError,
	beginAutomationRun,
	endAutomationRun,
	getAutomationRunHistory,
	recordAutomationRunEvent,
} from "../src/automation-run-ledger.ts";
import { createResearchWorkflowDb } from "./helpers/d1-sqlite-shim.mjs";

function begin(overrides = {}) {
	return {
		task: "industry-research",
		invocation_key: "scheduler:industry-research:2026-09-27T20:00+08",
		prompt_version: "a".repeat(40),
		...overrides,
	};
}

function end(runId, outcome = "SILENT", overrides = {}) {
	return {
		run_id: runId,
		outcome,
		fresh_delta_count: outcome === "COMPLETED" ? 1 : 0,
		notification_intended: outcome === "COMPLETED",
		reason:
			outcome === "SILENT"
				? "正常运行，无达到通知门槛的 Fresh-Delta。"
				: outcome === "BLOCKED"
					? "SOURCE_UNAVAILABLE"
					: null,
		...overrides,
	};
}

function legacyStarted(overrides = {}) {
	return {
		task_name: "产业趋势与研究",
		run_id: "industry-trend:20260927T100000Z",
		phase: "STARTED",
		status: "STARTED",
		scheduled_for: "2026-09-27T18:00:00+08:00",
		occurred_at: "2026-09-27T18:00:03+08:00",
		trace_id: "trace-industry-1",
		prompt_version: "industry-trend-v1",
		...overrides,
	};
}

function legacyFinal(status = "SILENT", overrides = {}) {
	return {
		task_name: "产业趋势与研究",
		run_id: "industry-trend:20260927T100000Z",
		phase: "FINAL",
		status,
		scheduled_for: "2026-09-27T18:00:00+08:00",
		occurred_at: "2026-09-27T18:02:00+08:00",
		notification_sent: status === "COMPLETED",
		fresh_delta_count: status === "COMPLETED" ? 1 : 0,
		blocker_code: status === "BLOCKED" || status === "FAILED" ? "SOURCE_UNAVAILABLE" : null,
		trace_id: "trace-industry-1",
		prompt_version: "industry-trend-v1",
		safe_summary:
			status === "SILENT"
				? "运行完成；没有达到 Fresh-Delta 通知门槛。"
				: "运行完成。",
		...overrides,
	};
}

test("#37 begin + end stores one SILENT run with server-owned lifecycle", async () => {
	const db = createResearchWorkflowDb();
	const started = await beginAutomationRun({
		db,
		begin: begin(),
		principal: "chatgpt-production",
		collectorBuildSha: "build-a",
		cloudflareVersionId: "cf-a",
		now: "2026-09-27T12:00:03Z",
	});
	assert.equal(started.status, "RECORDED");
	assert.match(started.run_id, /^run_[0-9a-f]{32}$/);

	const finished = await endAutomationRun({
		db,
		end: end(started.run_id),
		now: "2026-09-27T12:02:00Z",
	});
	assert.equal(finished.status, "RECORDED");
	assert.equal(finished.outcome, "SILENT");

	const history = await getAutomationRunHistory({
		db,
		taskName: "industry-research",
		limit: 5,
	});
	assert.equal(history.runs.length, 1);
	const run = history.runs[0];
	assert.equal(run.effective_status, "SILENT");
	assert.equal(run.final_recorded, true);
	assert.equal(run.notification_sent, null);
	assert.equal(run.notification_intended, false);
	assert.equal(run.notification_semantics, "INTENDED_ONLY");
	assert.equal(run.fresh_delta_semantics, "CALLER_REPORTED");
	assert.equal(run.result_semantics, "TERMINAL_RECORDED");
	assert.equal(run.source_contract, "run-v2");
	assert.equal(run.collector_build_sha, "build-a");
});

test("#37 stable invocation_key replays the same begin_run", async () => {
	const db = createResearchWorkflowDb();
	const first = await beginAutomationRun({
		db,
		begin: begin(),
		principal: "chatgpt-production",
		now: "2026-09-27T12:00:03Z",
	});
	const replay = await beginAutomationRun({
		db,
		begin: begin({ prompt_version: "b".repeat(40) }),
		principal: "chatgpt-production",
		now: "2026-09-27T12:05:03Z",
	});
	assert.equal(first.status, "RECORDED");
	assert.equal(replay.status, "IDEMPOTENT_REPLAY");
	assert.equal(replay.run_id, first.run_id);
});

test("#37 end_run is idempotent for the same terminal payload and conflicts otherwise", async () => {
	const db = createResearchWorkflowDb();
	const started = await beginAutomationRun({
		db,
		begin: begin({ invocation_key: null }),
		principal: "chatgpt-production",
		now: "2026-09-27T12:00:03Z",
	});
	const terminal = end(started.run_id, "BLOCKED", {
		reason: "SOURCE_UNAVAILABLE",
	});
	const first = await endAutomationRun({
		db,
		end: terminal,
		now: "2026-09-27T12:01:00Z",
	});
	const replay = await endAutomationRun({
		db,
		end: terminal,
		now: "2026-09-27T12:03:00Z",
	});
	assert.equal(first.status, "RECORDED");
	assert.equal(replay.status, "IDEMPOTENT_REPLAY");

	await assert.rejects(
		endAutomationRun({
			db,
			end: end(started.run_id, "FAILED", { reason: "DIFFERENT" }),
			now: "2026-09-27T12:04:00Z",
		}),
		(error) =>
			error instanceof AutomationRunLedgerError &&
			error.code === "AUTOMATION_RUN_CONFLICT" &&
			error.retryable === false,
	);
});

test("#37 unfinished run is observable but not diagnosed as a crash", async () => {
	const db = createResearchWorkflowDb();
	await beginAutomationRun({
		db,
		begin: begin(),
		principal: "chatgpt-production",
		now: "2026-09-27T12:00:03Z",
	});
	const history = await getAutomationRunHistory({ db, limit: 5 });
	assert.equal(history.runs[0].effective_status, "IN_PROGRESS");
	assert.equal(history.runs[0].final_recorded, false);
	assert.equal(history.runs[0].result_semantics, "RESULT_UNKNOWN");
	assert.equal(history.runs[0].finished_at, null);
});

test("#37 legacy record_automation_run is a thin adapter over the v2 ledger", async () => {
	const db = createResearchWorkflowDb();
	const start = await recordAutomationRunEvent({
		db,
		event: legacyStarted(),
		collectorBuildSha: "build-before",
		cloudflareVersionId: "cf-before",
		now: "2026-09-27T10:00:03Z",
	});
	const replay = await recordAutomationRunEvent({
		db,
		event: legacyStarted(),
		collectorBuildSha: "build-after",
		cloudflareVersionId: "cf-after",
		now: "2026-09-27T10:10:03Z",
	});
	assert.equal(start.status, "RECORDED");
	assert.equal(replay.status, "IDEMPOTENT_REPLAY");

	await recordAutomationRunEvent({
		db,
		event: legacyFinal("SILENT"),
		now: "2026-09-27T10:02:00Z",
	});
	const history = await getAutomationRunHistory({
		db,
		taskName: "产业趋势与研究",
		limit: 5,
	});
	assert.equal(history.runs.length, 1);
	assert.equal(history.runs[0].effective_status, "SILENT");
	assert.equal(history.runs[0].notification_sent, false);
	assert.equal(history.runs[0].notification_intended, null);
	assert.equal(history.runs[0].notification_semantics, "CALLER_REPORTED_SENT");
	assert.equal(history.runs[0].source_contract, "legacy-event-v1");

	await assert.rejects(
		recordAutomationRunEvent({
			db,
			event: legacyStarted({ safe_summary: "different legacy payload" }),
		}),
		(error) =>
			error instanceof AutomationRunLedgerError &&
			error.code === "AUTOMATION_RUN_CONFLICT",
	);
});

test("#37 legacy phase/status validation remains fail-closed during migration", async () => {
	const db = createResearchWorkflowDb();
	await assert.rejects(
		recordAutomationRunEvent({
			db,
			event: legacyStarted({ status: "SILENT" }),
		}),
		(error) =>
			error instanceof AutomationRunLedgerError &&
			error.code === "AUTOMATION_RUN_VALIDATION_FAILED",
	);
	await assert.rejects(
		recordAutomationRunEvent({
			db,
			event: legacyFinal("BLOCKED", { blocker_code: null }),
		}),
		(error) =>
			error instanceof AutomationRunLedgerError &&
			error.code === "AUTOMATION_RUN_VALIDATION_FAILED",
	);
});
