import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const { registerHooks } = await import("node:module");
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith("./") && !path.extname(specifier)) {
			try { return nextResolve(`${specifier}.ts`, context); } catch {}
		}
		return nextResolve(specifier, context);
	},
});

import {
	AUTOMATION_REGISTRY_KEYS, computeTimeliness, ensureRunEnvelopeTables,
	getAutomationRunHistory, receiptPromptVersion,
} from "../src/automation-run-ledger.ts";
import { processRunEnvelope } from "../src/run-envelope.ts";
import { getProductionHealthSnapshot } from "../src/production-health.ts";
import { StateGatewayError } from "../src/state-gateway.ts";
import { createResearchWorkflowDb } from "./helpers/d1-sqlite-shim.mjs";

const RECEIVED = "2026-10-01T22:29:31.745Z";
const BUILD = "c".repeat(40);

function withoutScheduleAccess(db) {
	return new Proxy(db, {
		get(target, prop, receiver) {
			if (prop !== "prepare") return Reflect.get(target, prop, receiver);
			return (sql) => {
				assert.doesNotMatch(sql, /automation_schedule_v1|slot_times|window_minutes/i);
				return target.prepare(sql);
			};
		},
	});
}

async function heartbeat(db, overrides = {}) {
	return processRunEnvelope({
		db, token: "fake", collectorBuildSha: BUILD, now: RECEIVED,
		envelope: { task_name: "central-policy", summary: "隔离测试，无新增" },
		...overrides,
	});
}

test("receipt bootstrap without migrations creates only the v3 table and indexes; repeat is idempotent", async () => {
	const db = createResearchWorkflowDb();
	await db.prepare("DROP TABLE IF EXISTS automation_schedule_v1").run();
	await db.prepare("DROP TABLE IF EXISTS automation_runs_v3").run();
	const guarded = withoutScheduleAccess(db);
	await ensureRunEnvelopeTables(guarded);
	await ensureRunEnvelopeTables(guarded);
	assert.ok(await db.prepare("SELECT name FROM sqlite_master WHERE name='automation_runs_v3'").first());
	assert.equal(await db.prepare("SELECT name FROM sqlite_master WHERE name='automation_schedule_v1'").first(), null);
});

test("empty receipt history never invents missed runs; health reports six unknown tasks without a schedule", async () => {
	const db = createResearchWorkflowDb();
	await db.prepare("DROP TABLE IF EXISTS automation_schedule_v1").run();
	const guarded = withoutScheduleAccess(db);
	const history = await getAutomationRunHistory({
		db: guarded, since: "2026-01-01T00:00:00Z", now: "2026-10-03T12:00:00Z", limit: 100,
	});
	assert.deepEqual(history.runs, []);
	const health = await getProductionHealthSnapshot({ db: guarded });
	assert.equal(health.status, "OK");
	assert.equal(health.tasks.length, 6);
	for (const row of health.tasks) {
		assert.equal(row.outcome, null);
		assert.equal(row.latest_received_at, null);
		assert.equal(row.seconds_since_last_received, null);
		assert.equal(row.schedule_basis, "UNKNOWN");
	}
});

test("late/hour-offset/weekend receipts remain real timestamps, with no inferred slots or missed rows", async () => {
	const db = createResearchWorkflowDb();
	await db.prepare("DROP TABLE IF EXISTS automation_schedule_v1").run();
	const guarded = withoutScheduleAccess(db);
	const stamps = [RECEIVED, "2026-10-03T05:49:00Z", "2026-10-04T16:59:00Z"];
	for (const stamp of stamps) {
		const receipt = await heartbeat(guarded, { now: stamp });
		assert.equal(receipt.outcome, "SILENT");
		assert.equal(receipt.slot, null);
		assert.equal(receipt.slot_date, null);
	}
	const history = await getAutomationRunHistory({ db: guarded, taskName: "central-policy", limit: 100 });
	assert.deepEqual(history.runs.map((row) => row.received_at), [...stamps].reverse());
	assert.ok(history.runs.every((row) => row.source_contract === "run-v3" && row.prompt_version === null));
	assert.ok(history.runs.every((row) => row.collector_build_sha === BUILD && row.slot === null));
});

test("historical false version and slot are masked, without changing raw historical records or replay identity", async () => {
	const db = createResearchWorkflowDb();
	const receipt = await heartbeat(db);
	// This represents a pre-fix stored row; it is not a production write.
	await db.prepare("UPDATE automation_runs_v3 SET prompt_version=?1, slot='06:00', slot_date='2026-10-02' WHERE run_id=?2")
		.bind(BUILD, receipt.run_id).run();
	const before = await db.prepare("SELECT * FROM automation_runs_v3 WHERE run_id=?1").bind(receipt.run_id).first();
	const guarded = withoutScheduleAccess(db);
	const history = await getAutomationRunHistory({ db: guarded, taskName: "central-policy" });
	assert.equal(history.runs.length, 1);
	assert.equal(history.runs[0].received_at, RECEIVED);
	assert.equal(history.runs[0].prompt_version, null);
	assert.equal(history.runs[0].slot, null);
	const snapshot = await getProductionHealthSnapshot({ db: guarded });
	const row = snapshot.tasks.find((item) => item.registry_key === "central-policy");
	assert.equal(row.latest_received_at, RECEIVED);
	assert.equal(row.prompt_version, null);
	assert.equal(row.slot, null);
	assert.equal(row.slot_date, null);
	assert.equal(row.schedule_basis, "UNKNOWN");
	const replay = await heartbeat(guarded);
	assert.equal(replay.status, "ENVELOPE_REPLAY");
	assert.equal(replay.run_id, receipt.run_id);
	assert.equal(replay.slot, null);
	assert.equal(replay.slot_date, null);
	const after = await db.prepare("SELECT * FROM automation_runs_v3 WHERE run_id=?1").bind(receipt.run_id).first();
	assert.deepEqual(after, before, "read projections and terminal replay cannot rewrite history");
});

test("all bare task receipts, observations, refusals and invalid envelopes never inherit the Collector build as Prompt", async () => {
	const db = createResearchWorkflowDb();
	const guarded = withoutScheduleAccess(db);
	for (const task of AUTOMATION_REGISTRY_KEYS) {
		await heartbeat(guarded, { envelope: { task_name: task, summary: "本轮无新增" } });
	}
	await heartbeat(guarded, { envelope: { task_name: "central-policy", summary: "观察", observations: { fresh_count: 1 } } });
	await heartbeat(guarded, { envelope: { task_name: "central-policy", summary: "来源不可用", blocked_by: "DATA_UNAVAILABLE" } });
	await assert.rejects(heartbeat(guarded, { envelope: { task_name: "central-policy", summary: "非法", extra: true } }));
	const rows = (await db.prepare("SELECT * FROM automation_runs_v3").all()).results;
	assert.equal(rows.length, 9);
	assert.ok(rows.every((row) => row.prompt_version === null && row.collector_build_sha === BUILD));
	assert.ok(rows.every((row) => row.slot === null && row.slot_date === null));
});

test("MARKET submitted Prompt remains readable through pre-write UNKNOWN even before channel is saved", async () => {
	const db = createResearchWorkflowDb();
	const guarded = withoutScheduleAccess(db);
	await assert.rejects(heartbeat(guarded, {
		envelope: {
			task_name: "holding-assistant-intraday", summary: "隔离测试",
			channel_payload: {
				channel: "MARKET", trading_date: "2026-10-02", scheduled_slot: "09:50",
				as_of: "2026-10-02T09:50:00+08:00", production_ref: "a".repeat(40), records: [],
			},
		},
		resolveOwnerContext: async () => {
			throw new StateGatewayError({ code: "STATE_UNAVAILABLE", phase: "READ", message: "test only", retryable: true });
		},
	}));
	const history = await getAutomationRunHistory({ db: guarded, taskName: "holding-assistant-intraday" });
	assert.equal(history.runs[0].effective_status, "UNKNOWN");
	assert.equal(history.runs[0].prompt_version, "a".repeat(40));
	assert.equal(history.runs[0].collector_build_sha, BUILD);
	const health = await getProductionHealthSnapshot({ db: guarded });
	assert.equal(health.tasks.find((row) => row.registry_key === "holding-assistant-intraday").prompt_version, "a".repeat(40));
});

test("Prompt provenance is structural, never a guessed comparison against the current deployment", () => {
	assert.equal(receiptPromptVersion({ envelope_key: "HB:test", prompt_version: "a".repeat(40), collector_build_sha: BUILD }), null);
	assert.equal(receiptPromptVersion({ envelope_key: "E:MARKET:test", prompt_version: BUILD, collector_build_sha: BUILD }), BUILD);
	assert.equal(receiptPromptVersion({ envelope_key: "E:MARKET:test", prompt_version: "garbled" }), null);
});

test("data-age diagnostic retains fixed bounds but has no dependency on task schedules", () => {
	const received = Date.parse("2026-10-02T02:45:00Z");
	assert.equal(computeTimeliness("2026-10-02T02:40:00Z", received), "FRESH");
	assert.equal(computeTimeliness("2026-10-02T02:04:00Z", received), "STALE");
	assert.equal(computeTimeliness("2026-10-02T02:51:00Z", received), "STALE");
	assert.equal(computeTimeliness(null, received), "FRESH");
});

test("production code contains no shadow schedule table, slot derivation, or scheduled reconciliation", () => {
	const root = new URL("../src/", import.meta.url);
	for (const file of fs.readdirSync(root).filter((name) => name.endsWith(".ts"))) {
		const source = fs.readFileSync(new URL(file, root), "utf8");
		assert.doesNotMatch(source, /automation_schedule_v1|deriveMissedSlots|resolveSlotBinding|runScheduleReconciliation|MISSED_SLOT/, file);
	}
	assert.equal(fs.existsSync(new URL("automation-schedule.ts", root)), false);
});
