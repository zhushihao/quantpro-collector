import assert from "node:assert/strict";
import test from "node:test";

import {
	AutomationRunLedgerError,
	beginAutomationRun,
	endAutomationRun,
	getAutomationRunHistory,
	recordAutomationRunEvent,
} from "../src/automation-run-ledger.ts";
import { ensureRunEnvelopeTables } from "../src/automation-run-ledger.ts";
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
		// The observation clock cannot fabricate newer audit records.
		now: "2026-09-27T12:03:00Z",
		since: "2026-09-27T00:00:00Z",
	});
	// Only actual audit records are returned.
	const run = history.runs.find((entry) => entry.source_contract === "run-v2");
	assert.ok(run, "the stored run-v2 row must be present");
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
	const history = await getAutomationRunHistory({
		db,
		limit: 5,
		now: "2026-09-27T12:01:00Z",
		since: "2026-09-27T00:00:00Z",
	});
	const run = history.runs.find((entry) => entry.source_contract === "run-v2");
	assert.ok(run, "the unfinished run-v2 row must be present");
	assert.equal(run.effective_status, "IN_PROGRESS");
	assert.equal(run.final_recorded, false);
	assert.equal(run.result_semantics, "RESULT_UNKNOWN");
	assert.equal(run.finished_at, null);
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

async function insertRunV3Row(db, overrides = {}) {
	const row = {
		task_name: "industry-research",
		run_id: "run_" + "a".repeat(32),
		envelope_key: "E:INDUSTRY:" + "b".repeat(64),
		channel: "INDUSTRY",
		write_key: "CMD:INDUSTRY:" + "c".repeat(64),
		as_of: null,
		received_at: "2026-09-27T12:00:00Z",
		slot: null,
		slot_date: null,
		fresh_delta_count: 1,
		event_count: 3,
		outcome: "COMPLETED",
		blocker_code: null,
		summary: "信封一轮",
		prompt_version: null,
		...overrides,
	};
	await db
		.prepare(
			`INSERT INTO automation_runs_v3 (
				task_name, run_id, envelope_key, channel, write_key, as_of,
				received_at, slot, slot_date, fresh_delta_count, event_count,
				outcome, blocker_code, summary, prompt_version,
				collector_build_sha, cloudflare_version_id, created_at, updated_at
			) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 'build-x', 'cf-x', ?7, ?7)`,
		)
		.bind(
			row.task_name,
			row.run_id,
			row.envelope_key,
			row.channel,
			row.write_key,
			row.as_of,
			row.received_at,
			row.slot,
			row.slot_date,
			row.fresh_delta_count,
			row.event_count,
			row.outcome,
			row.blocker_code,
			row.summary,
			row.prompt_version,
		)
		.run();
	return row;
}

test("run-v3 rows merge into get_automation_run_history with server-derived semantics (spec §4.3.3/§5)", async () => {
	const db = createResearchWorkflowDb();
	await ensureRunEnvelopeTables(db);

	const fresh = await insertRunV3Row(db, {
		as_of: "2026-09-27T19:55:00+08:00",
		prompt_version: "f".repeat(40),
	});
	const stale = await insertRunV3Row(db, {
		run_id: "run_" + "d".repeat(32),
		envelope_key: "E:INDUSTRY:" + "e".repeat(64),
		write_key: "CMD:INDUSTRY:" + "f".repeat(64),
		as_of: "2026-09-25T19:55:00+08:00",
		received_at: "2026-09-27T12:05:00Z",
		fresh_delta_count: 0,
		outcome: "SILENT",
	});
	const unknown = await insertRunV3Row(db, {
		run_id: "run_" + "1".repeat(32),
		envelope_key: "E:INDUSTRY:" + "2".repeat(64),
		write_key: null,
		channel: null,
		outcome: "UNKNOWN",
		fresh_delta_count: null,
		event_count: null,
		received_at: "2026-09-27T12:10:00Z",
	});

	const history = await getAutomationRunHistory({
		db,
		taskName: "industry-research",
		limit: 100,
		now: "2026-09-27T12:11:00Z",
		since: "2026-09-27T00:00:00Z",
	});
	const contracts = new Set(history.runs.map((entry) => entry.source_contract));
	assert.ok(contracts.has("run-v3"));
	assert.equal(history.runs.some((entry) => entry.source_contract === "schedule-derivation"), false);

	// Descending received_at across sources: UNKNOWN (12:10) → SILENT (12:05)
	// → COMPLETED (12:00), without synthetic missing receipts.
	const v3Rows = history.runs.filter((entry) => entry.source_contract === "run-v3");
	assert.deepEqual(
		v3Rows.map((entry) => entry.run_id),
		[unknown.run_id, stale.run_id, fresh.run_id],
	);

	const freshRow = v3Rows.find((entry) => entry.run_id === fresh.run_id);
	assert.equal(freshRow.effective_status, "COMPLETED");
	assert.equal(freshRow.final_recorded, true);
	assert.equal(freshRow.result_semantics, "TERMINAL_RECORDED");
	assert.equal(freshRow.fresh_delta_semantics, "SERVER_COUNTED");
	assert.equal(freshRow.notification_required, true);
	// Non-MARKET run-v3 values have no verified Prompt source; old stored
	// deployment stamps must not continue to masquerade as Prompt versions.
	assert.equal(freshRow.prompt_version, null);
	assert.equal(freshRow.notification_semantics, "SERVER_DERIVED_FLOOR");
	assert.equal(freshRow.delivery, "MODEL_DELIVERY_UNVERIFIED");
	assert.equal(freshRow.event_count, 3);
	assert.equal(freshRow.as_of_stale, false);
	assert.equal(freshRow.timeliness, "FRESH");
	assert.equal(freshRow.trace_id, fresh.run_id);

	const staleRow = v3Rows.find((entry) => entry.run_id === stale.run_id);
	assert.equal(staleRow.effective_status, "SILENT");
	assert.equal(staleRow.notification_required, false);
	assert.equal(staleRow.as_of_stale, true);
	assert.equal(staleRow.timeliness, "STALE");
	assert.equal(staleRow.prompt_version, null);

	const unknownRow = v3Rows.find((entry) => entry.run_id === unknown.run_id);
	assert.equal(unknownRow.effective_status, "UNKNOWN");
	assert.equal(unknownRow.final_recorded, false);
	assert.equal(unknownRow.result_semantics, "RESULT_UNKNOWN");

	assert.equal(history.runs.length, 3, "only the three received rows exist");
	assert.equal(history.runs.some((row) => row.effective_status === "MISSED_SLOT"), false);
});

test("run-v2, legacy-event-v1 and run-v3 rows coexist in one merged history (spec §4.3.3)", async () => {
	const db = createResearchWorkflowDb();
	await ensureRunEnvelopeTables(db);
	await beginAutomationRun({
		db,
		begin: begin(),
		principal: "chatgpt-production",
		now: "2026-09-27T12:00:03Z",
	});
	await recordAutomationRunEvent({
		db,
		event: legacyStarted({ task_name: "industry-research" }),
		now: "2026-09-27T10:00:03Z",
	});
	await insertRunV3Row(db);

	const history = await getAutomationRunHistory({
		db,
		taskName: "industry-research",
		limit: 100,
		now: "2026-09-27T12:11:00Z",
		since: "2026-09-27T00:00:00Z",
	});
	const contracts = new Set(history.runs.map((entry) => entry.source_contract));
	assert.ok(contracts.has("run-v2"));
	assert.ok(contracts.has("legacy-event-v1"));
	assert.ok(contracts.has("run-v3"));
	assert.equal(contracts.has("schedule-derivation"), false);

	// v2 rows keep their legacy output shape untouched (spec §4.3.3).
	const v2Row = history.runs.find((entry) => entry.source_contract === "run-v2");
	assert.equal(v2Row.fresh_delta_semantics, "CALLER_REPORTED");
	assert.equal(v2Row.notification_semantics, "INTENDED_ONLY");
	const legacyRow = history.runs.find((entry) => entry.source_contract === "legacy-event-v1");
	assert.equal(legacyRow.fresh_delta_semantics, "CALLER_REPORTED");
	assert.equal(legacyRow.notification_semantics, "CALLER_REPORTED_SENT");
});
