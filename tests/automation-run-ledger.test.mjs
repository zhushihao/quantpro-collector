import assert from "node:assert/strict";
import test from "node:test";

import {
	AutomationRunLedgerError,
	getAutomationRunHistory,
	recordAutomationRunEvent,
} from "../src/automation-run-ledger.ts";
import { createResearchWorkflowDb } from "./helpers/d1-sqlite-shim.mjs";

function started(overrides = {}) {
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

function final(status = "SILENT", overrides = {}) {
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

test("#36 STARTED + SILENT are queryable as one completed run", async () => {
	const db = createResearchWorkflowDb();
	const start = await recordAutomationRunEvent({
		db,
		event: started(),
		collectorBuildSha: "build-a",
		cloudflareVersionId: "cf-a",
		now: "2026-09-27T10:00:03Z",
	});
	assert.equal(start.status, "RECORDED");

	const done = await recordAutomationRunEvent({
		db,
		event: final("SILENT"),
		collectorBuildSha: "build-a",
		cloudflareVersionId: "cf-a",
		now: "2026-09-27T10:02:00Z",
	});
	assert.equal(done.status, "RECORDED");

	const history = await getAutomationRunHistory({
		db,
		taskName: "产业趋势与研究",
		limit: 5,
	});
	assert.equal(history.runs.length, 1);
	assert.equal(history.runs[0].effective_status, "SILENT");
	assert.equal(history.runs[0].notification_sent, false);
	assert.equal(history.runs[0].fresh_delta_count, 0);
	assert.equal(history.runs[0].final_recorded, true);
	assert.equal(history.runs[0].collector_build_sha, "build-a");
});

test("#36 same phase replay is idempotent and different payload conflicts", async () => {
	const db = createResearchWorkflowDb();
	const event = started();
	const first = await recordAutomationRunEvent({
		db,
		event,
		collectorBuildSha: "build-before",
		cloudflareVersionId: "cf-before",
		now: "2026-09-27T10:00:03Z",
	});
	const replay = await recordAutomationRunEvent({
		db,
		event,
		collectorBuildSha: "build-after",
		cloudflareVersionId: "cf-after",
		now: "2026-09-27T10:10:03Z",
	});
	assert.equal(first.status, "RECORDED");
	assert.equal(replay.status, "IDEMPOTENT_REPLAY");

	await assert.rejects(
		recordAutomationRunEvent({
			db,
			event: started({ safe_summary: "different start payload" }),
			now: "2026-09-27T10:00:03Z",
		}),
		(error) =>
			error instanceof AutomationRunLedgerError &&
			error.code === "AUTOMATION_RUN_CONFLICT" &&
			error.retryable === false,
	);
});

test("#36 BLOCKED and COMPLETED runs retain bounded final diagnostics", async () => {
	const db = createResearchWorkflowDb();
	for (const [suffix, status] of [
		["blocked", "BLOCKED"],
		["completed", "COMPLETED"],
	]) {
		const runId = `industry-trend:20260927T11${suffix === "blocked" ? "00" : "30"}00Z`;
		await recordAutomationRunEvent({
			db,
			event: started({ run_id: runId, occurred_at: "2026-09-27T19:00:01+08:00" }),
		});
		await recordAutomationRunEvent({
			db,
			event: final(status, {
				run_id: runId,
				occurred_at: suffix === "blocked" ? "2026-09-27T19:01:00+08:00" : "2026-09-27T19:31:00+08:00",
				safe_summary:
					status === "BLOCKED"
						? "Collector Research 来源健康检查阻断。"
						: "发现 1 条 Fresh-Delta 并已通知。",
			}),
		});
	}

	const history = await getAutomationRunHistory({
		db,
		taskName: "产业趋势与研究",
		since: "2026-09-27T18:30:00+08:00",
		limit: 10,
	});
	assert.deepEqual(
		new Set(history.runs.map((run) => run.effective_status)),
		new Set(["BLOCKED", "COMPLETED"]),
	);
	const blocked = history.runs.find((run) => run.effective_status === "BLOCKED");
	assert.equal(blocked.blocker_code, "SOURCE_UNAVAILABLE");
	const completed = history.runs.find((run) => run.effective_status === "COMPLETED");
	assert.equal(completed.notification_sent, true);
	assert.equal(completed.fresh_delta_count, 1);
});

test("#36 unfinished STARTED run is visible as IN_PROGRESS", async () => {
	const db = createResearchWorkflowDb();
	await recordAutomationRunEvent({ db, event: started() });
	const history = await getAutomationRunHistory({ db, limit: 5 });
	assert.equal(history.runs[0].effective_status, "IN_PROGRESS");
	assert.equal(history.runs[0].final_recorded, false);
	assert.equal(history.runs[0].finished_at, null);
});

test("#36 phase/status contract fails closed", async () => {
	const db = createResearchWorkflowDb();
	await assert.rejects(
		recordAutomationRunEvent({
			db,
			event: started({ status: "SILENT" }),
		}),
		(error) =>
			error instanceof AutomationRunLedgerError &&
			error.code === "AUTOMATION_RUN_VALIDATION_FAILED",
	);
	await assert.rejects(
		recordAutomationRunEvent({
			db,
			event: final("BLOCKED", { blocker_code: null }),
		}),
		(error) =>
			error instanceof AutomationRunLedgerError &&
			error.code === "AUTOMATION_RUN_VALIDATION_FAILED",
	);
});
