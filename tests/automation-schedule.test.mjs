import assert from "node:assert/strict";
import test from "node:test";

import {
	SCHEDULE_SEEDS,
	computeTimeliness,
	deriveMissedSlots,
	deriveMissedSlotsFromRawRows,
	ensureRunEnvelopeTables,
	readScheduleRows,
	resolveSlotBinding,
	runScheduleReconciliation,
} from "../src/automation-schedule.ts";
import { createResearchWorkflowDb } from "./helpers/d1-sqlite-shim.mjs";

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

function shanghaiMs(dateKey, clock) {
	const [year, month, day] = dateKey.split("-").map(Number);
	const [hour, minute] = clock.split(":").map(Number);
	return Date.UTC(year, month - 1, day, hour, minute) - SHANGHAI_OFFSET_MS;
}

test("schedule ensure seeds exactly the six production rows and stays idempotent (review F3)", async () => {
	const db = createResearchWorkflowDb();
	await ensureRunEnvelopeTables(db);
	let rows = await readScheduleRows(db);
	assert.equal(rows.length, 6);
	assert.deepEqual(
		rows.map((row) => row.task_name).sort(),
		SCHEDULE_SEEDS.map((seed) => seed.task_name).sort(),
	);
	const intraday = rows.find((row) => row.task_name === "holding-assistant-intraday");
	assert.deepEqual(intraday.slot_times, ["09:50", "10:50", "11:50", "13:50", "14:50"]);
	assert.deepEqual(intraday.weekdays, [1, 2, 3, 4, 5]);
	assert.equal(intraday.window_minutes, 40);
	const industry = rows.find((row) => row.task_name === "industry-research");
	assert.equal(industry.slot_times.length, 24);
	assert.deepEqual(industry.weekdays, [0, 1, 2, 3, 4, 5, 6]);

	// Re-ensure: still six rows, no duplication.
	await ensureRunEnvelopeTables(db);
	rows = await readScheduleRows(db);
	assert.equal(rows.length, 6);
});

test("empty database (no migrations at all) still ends up with six seeds after ensure (review F3)", async () => {
	const db = createResearchWorkflowDb();
	// Simulate a migration-less environment: drop whatever the shim chain built.
	await db.prepare("DROP TABLE IF EXISTS automation_schedule_v1").run();
	await db.prepare("DROP TABLE IF EXISTS automation_runs_v3").run();
	await ensureRunEnvelopeTables(db);
	const rows = await readScheduleRows(db);
	assert.equal(rows.length, 6);
	const tables = await db
		.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('automation_runs_v3','automation_schedule_v1')")
		.all();
	assert.equal(tables.results.length, 2);
});

test("slot window math: [slot, slot+window) inclusive start, exclusive end, +08:00 date rollover, weekday filter", async () => {
	const db = createResearchWorkflowDb();
	await ensureRunEnvelopeTables(db);
	const rows = await readScheduleRows(db);

	// Start boundary is inclusive.
	assert.deepEqual(resolveSlotBinding(rows, "holding-assistant-preclose", shanghaiMs("2026-09-28", "09:10")), {
		slot: "09:10",
		slot_date: "2026-09-28",
		window_minutes: 40,
	});
	// Last minute inside the window still binds.
	assert.equal(
		resolveSlotBinding(rows, "holding-assistant-preclose", shanghaiMs("2026-09-28", "09:49"))?.slot,
		"09:10",
	);
	// End boundary is exclusive: 09:50 belongs to the NEXT preclose-adjacent
	// task (intraday) or nothing for preclose.
	assert.equal(
		resolveSlotBinding(rows, "holding-assistant-preclose", shanghaiMs("2026-09-28", "09:50")),
		null,
	);

	// Asia/Shanghai date rollover: UTC 2026-09-28T16:30Z is Shanghai
	// 2026-09-29 00:30 — inside ai-financing-rates' 00:00 window, slot_date on
	// the rolled-over day.
	assert.deepEqual(
		resolveSlotBinding(rows, "ai-financing-rates", Date.UTC(2026, 8, 28, 16, 30)),
		{ slot: "00:00", slot_date: "2026-09-29", window_minutes: 40 },
	);

	// Weekday filter: 2026-10-03 is a Saturday — trading-week tasks unbound.
	assert.equal(
		resolveSlotBinding(rows, "holding-assistant-intraday", shanghaiMs("2026-10-03", "09:55")),
		null,
	);
	// …while the daily hourly task still binds on Saturday.
	assert.equal(
		resolveSlotBinding(rows, "company-facts", shanghaiMs("2026-10-03", "09:05"))?.slot,
		"09:00",
	);
});

test("timeliness: within window FRESH, beyond window STALE, future beyond 5min STALE, no as_of FRESH", () => {
	const receivedAt = shanghaiMs("2026-09-28", "10:45");
	assert.equal(computeTimeliness("2026-09-28T10:40:00+08:00", receivedAt, 40), "FRESH");
	assert.equal(computeTimeliness("2026-09-28T10:04:00+08:00", receivedAt, 40), "STALE");
	assert.equal(computeTimeliness("2026-09-28T10:04:00+08:00", receivedAt, null), "STALE");
	assert.equal(computeTimeliness("2026-09-28T10:41:00+08:00", receivedAt, 40), "FRESH");
	// Future tolerance is a fixed 5 minutes regardless of W.
	assert.equal(computeTimeliness("2026-09-28T10:51:00+08:00", receivedAt, 40), "STALE");
	assert.equal(computeTimeliness("2026-09-28T10:42:00+08:00", receivedAt, 40), "FRESH");
	assert.equal(computeTimeliness(null, receivedAt, 40), "FRESH");
});

function rawV3Row(taskName, receivedAt) {
	return { task_name: taskName, received_at: receivedAt };
}

function rawV2Row(taskName, { started_at = null, finished_at = null, updated_at = null }) {
	return { task_name: taskName, started_at, finished_at, updated_at };
}

test("MISSED_SLOT derivation: satisfied windows are excluded, v2 rows count during the transition", () => {
	const rows = [
		{
			task_name: "industry-research",
			slot_times: ["10:45", "11:45"],
			weekdays: [0, 1, 2, 3, 4, 5, 6],
			window_minutes: 40,
			enabled: true,
		},
	];
	const day = "2026-09-28";
	const derivationStartMs = shanghaiMs(day, "00:00");
	const nowMs = shanghaiMs(day, "12:00");

	// v3 row inside the 10:45 window and a v2 row inside the 11:45 window:
	// both satisfied, nothing missed.
	const { missed, truncated } = deriveMissedSlotsFromRawRows({
		scheduleRows: rows,
		v3Rows: [rawV3Row("industry-research", new Date(shanghaiMs(day, "10:50")).toISOString())],
		v2Rows: [rawV2Row("industry-research", { started_at: new Date(shanghaiMs(day, "11:50")).toISOString() })],
		derivationStartMs,
		nowMs,
	});
	assert.equal(truncated, false);
	assert.deepEqual(missed, []);

	// Remove both: each completed window becomes a synthetic MISSED_SLOT row.
	const allMissed = deriveMissedSlotsFromRawRows({
		scheduleRows: rows,
		v3Rows: [],
		v2Rows: [],
		derivationStartMs,
		nowMs,
	});
	assert.equal(allMissed.truncated, false);
	// Windows ending at or before 12:00: 10:45..11:25 and 11:45..12:25 is NOT
	// complete yet (ends 12:25 > 12:00), so only one completed window missed.
	assert.equal(allMissed.missed.length, 1);
	assert.deepEqual(allMissed.missed[0], {
		task_name: "industry-research",
		effective_status: "MISSED_SLOT",
		slot: "10:45",
		slot_date: day,
		window: "10:45..11:25",
		window_end: new Date(shanghaiMs(day, "11:25")).toISOString(),
		derivation: "SCHEDULE_WINDOW",
		source_contract: "schedule-derivation",
	});
});

test("MISSED_SLOT derivation: since truncation and the 200-row earliest-truncation cap", () => {
	const rows = [
		{
			task_name: "industry-research",
			slot_times: ["10:45"],
			weekdays: [0, 1, 2, 3, 4, 5, 6],
			window_minutes: 40,
			enabled: true,
		},
	];
	const hourlyRows = [
		{
			task_name: "industry-research",
			slot_times: Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, "0")}:00`),
			weekdays: [0, 1, 2, 3, 4, 5, 6],
			window_minutes: 40,
			enabled: true,
		},
	];
	const nowMs = shanghaiMs("2026-09-28", "23:59");

	// since truncation: derivation starts at max(since, lookback).
	const sinceMs = shanghaiMs("2026-09-28", "12:00");
	const limited = deriveMissedSlotsFromRawRows({
		scheduleRows: rows,
		v3Rows: [],
		v2Rows: [],
		derivationStartMs: Math.max(nowMs - 7 * 24 * 60 * 60 * 1000, sinceMs),
		nowMs,
	});
	// Completed windows on 09-28 after 12:00 with slot 10:45: none (slot is
	// earlier than since on the last day) — but earlier days are excluded too.
	assert.deepEqual(limited.missed, []);

	// 200 cap: one hourly task over 14 days yields ~330 completed windows; the
	// earliest are truncated and the flag set.
	const wide = deriveMissedSlotsFromRawRows({
		scheduleRows: hourlyRows,
		v3Rows: [],
		v2Rows: [],
		derivationStartMs: nowMs - 14 * 24 * 60 * 60 * 1000,
		nowMs,
		maxRows: 200,
	});
	assert.equal(wide.truncated, true);
	assert.equal(wide.missed.length, 200);
	for (let i = 1; i < wide.missed.length; i += 1) {
		assert.ok(wide.missed[i - 1].window_end <= wide.missed[i].window_end);
	}
});

test("review F6 query shape: one derivation issues exactly one SELECT per (table), never per window", async () => {
	const db = createResearchWorkflowDb();
	await ensureRunEnvelopeTables(db);
	const counts = { schedule: 0, v3: 0, v2: 0 };
	const countingDb = new Proxy(db, {
		get(target, prop, receiver) {
			if (prop !== "prepare") return Reflect.get(target, prop, receiver);
			return (sql) => {
				if (!sql.trimStart().toUpperCase().startsWith("SELECT")) {
					return target.prepare(sql); // DDL/seed statements don't count (F6 is about reads).
				}
				if (sql.includes("automation_schedule_v1")) counts.schedule += 1;
				else if (sql.includes("automation_runs_v3")) counts.v3 += 1;
				else if (sql.includes("automation_runs_v2")) counts.v2 += 1;
				return target.prepare(sql);
			};
		},
	});
	const { missed } = await deriveMissedSlots(countingDb, {
		taskName: "industry-research",
		now: new Date(shanghaiMs("2026-09-28", "12:00")).toISOString(),
		lookbackDays: 1,
	});
	// Empty history: every completed industry window of the lookback day.
	assert.ok(missed.length >= 20);
	assert.equal(counts.schedule, 1, "schedule table read exactly once");
	assert.equal(counts.v3, 1, "run-v3 read exactly once");
	assert.equal(counts.v2, 1, "run-v2 read exactly once");
});

test("deriveMissedSlots over the shim database: v3 rows satisfy their window, holidays surface as MISSED_SLOT", async () => {
	const db = createResearchWorkflowDb();
	await ensureRunEnvelopeTables(db);
	// Saturday 2026-10-03, 12:00 Shanghai. No rows at all: hourly tasks derive
	// misses for their completed windows of that day (weekend included — the
	// documented residual behavior; the fix is a schedule row update, not code).
	const { missed } = await deriveMissedSlots(db, {
		taskName: "company-facts",
		since: new Date(shanghaiMs("2026-10-03", "00:00")).toISOString(),
		now: new Date(shanghaiMs("2026-10-03", "12:00")).toISOString(),
		lookbackDays: 1,
	});
	// Completed windows on 10-03 up to 12:00: slots 00:00..11:00 = 12 windows;
	// the 12:00 window is still in progress.
	assert.equal(missed.length, 12);
	assert.equal(missed[0].slot_date, "2026-10-03");

	// Insert a v3 row inside the 09:00 window → that window is satisfied.
	await db
		.prepare(
			`INSERT INTO automation_runs_v3 (
				task_name, run_id, envelope_key, channel, write_key, as_of,
				received_at, slot, slot_date, fresh_delta_count, event_count,
				outcome, blocker_code, summary, prompt_version,
				collector_build_sha, cloudflare_version_id, created_at, updated_at
			) VALUES (?1, ?2, ?3, NULL, NULL, NULL, ?4, NULL, NULL, 0, 0, 'SILENT', NULL, NULL, NULL, NULL, NULL, ?4, ?4)`,
		)
		.bind(
			"company-facts",
			"run_probe_sat",
			"HB:probe",
			new Date(shanghaiMs("2026-10-03", "09:10")).toISOString(),
		)
		.run();
	const after = await deriveMissedSlots(db, {
		taskName: "company-facts",
		since: new Date(shanghaiMs("2026-10-03", "00:00")).toISOString(),
		now: new Date(shanghaiMs("2026-10-03", "12:00")).toISOString(),
		lookbackDays: 1,
	});
	assert.equal(after.missed.length, 11);
	assert.equal(
		after.missed.some((row) => row.slot === "09:00"),
		false,
	);
});

test("runScheduleReconciliation emits automation_missed_slot lines and never rethrows internal failures", async () => {
	const db = createResearchWorkflowDb();
	await ensureRunEnvelopeTables(db);
	const logs = [];
	const originalLog = console.log;
	const originalWarn = console.warn;
	console.log = (...args) => logs.push(...args);
	try {
		await runScheduleReconciliation(
			{ RESEARCH_REPLICA: db },
			{ runId: "cron:test" },
			{ now: new Date(shanghaiMs("2026-10-03", "12:00")).toISOString(), lookbackHours: 24 },
		);
	} finally {
		console.log = originalLog;
	}
	const events = logs
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return null;
			}
		})
		.filter((entry) => entry?.event === "automation_missed_slot");
	assert.ok(events.length >= 11);
	assert.equal(events[0].run_id, "cron:test");
	assert.equal(events[0].source_contract, "schedule-derivation");

	// Internal failure (storage explodes) → warn only, resolves normally.
	const warns = [];
	console.warn = (...args) => warns.push(...args);
	try {
		const brokenDb = new Proxy(db, {
			get(target, prop, receiver) {
				if (prop !== "prepare") return Reflect.get(target, prop, receiver);
				return () => {
					throw new Error("storage exploded");
				};
			},
		});
		await runScheduleReconciliation(
			{ RESEARCH_REPLICA: brokenDb },
			{ runId: "cron:broken" },
			{ now: new Date(shanghaiMs("2026-10-03", "12:00")).toISOString() },
		);
	} finally {
		console.warn = originalWarn;
	}
	assert.ok(warns.length >= 1);
	assert.match(String(warns[0]), /automation_schedule_reconciliation_failed/);

	// Missing D1 binding: no-op, no throw.
	await runScheduleReconciliation({}, { runId: "cron:empty" }, {});
});
