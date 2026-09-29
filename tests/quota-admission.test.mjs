/**
 * Admission ledger tests (SDD CQ spec P0-B, test matrix §"准入标准与测试矩阵").
 *
 * These run against the real migration chain (through the node:sqlite shim, whose
 * `batch()` is BEGIN/COMMIT like D1) so the atomicity argument is exercised as
 * SQL, not as a model.  Real workerd D1 semantics for the same statements are
 * checked separately by `scripts/quota_d1_local_check.mjs`.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	MAX_BOOKED_UNITS,
	QUOTA_CATALOG_VERSION,
	QUOTA_DIMENSIONS,
	QUOTA_GUARD_SCAN_CAP,
	QUOTA_LIVE_UNITS_CAP,
	admitOperation,
	buildBookedSql,
	buildDiagnosisSql,
	buildGuardSql,
	buildSealSql,
	ledgerLifecycleReads,
	ledgerLifecycleWrites,
	ledgerSelfReads,
	ledgerSelfWrites,
	quotaStatus,
	readBookedUsage,
	recordAccountPeriod,
	recordBaseline,
	releaseReservation,
	settleReservation,
	syncDimensionCatalog,
	withLedgerSelfCost,
} from "../src/quota-breaker.ts";
import { createResearchWorkflowDb } from "./helpers/d1-sqlite-shim.mjs";

const ACCOUNT = "test-account";
const PERIOD = {
	period_start: "2026-09-14T00:00:00.000Z",
	period_end: "2026-10-14T00:00:00.000Z",
};
const PERIOD_KEY = `cycle:${PERIOD.period_start}..${PERIOD.period_end}`;
const NOW = new Date("2026-09-20T00:00:00.000Z");

function dimension(key) {
	return QUOTA_DIMENSIONS.find((entry) => entry.key === key);
}

async function seed(db, options = {}) {
	const { usedRatio = 0, unobservedRatio = 0, anchor = true } = options;
	await syncDimensionCatalog(db, QUOTA_DIMENSIONS);
	if (anchor) {
		await recordAccountPeriod(db, {
			account_id: ACCOUNT,
			...PERIOD,
			anchor_kind: "subscription_renewal",
			source: "test",
			source_version: "test@1",
			verified_at: PERIOD.period_start,
		});
	}
	for (const entry of QUOTA_DIMENSIONS) {
		if (!entry.provable || entry.threshold_95 === null) continue;
		const periodKey =
			entry.period === "utc_day" ? `utc-day:${NOW.toISOString().slice(0, 10)}` : PERIOD_KEY;
		await recordBaseline(db, {
			dimension_key: entry.key,
			period_key: periodKey,
			state: "VERIFIED",
			used: Math.floor(entry.threshold_95 * usedRatio),
			unobserved_upper_bound: Math.floor(entry.threshold_95 * unobservedRatio),
			source: "test",
			source_version: "test@1",
			as_of: NOW.toISOString(),
			coverage_end: NOW.toISOString(),
		});
	}
}

function request(operationId, dimensions, fingerprint = "a".repeat(32)) {
	return {
		operation_id: operationId,
		fingerprint,
		route: "http:/internal/research-replica/v2/ingest",
		dimensions,
	};
}

async function liveUnits(db, reservationId) {
	const rows = await db
		.prepare(
			"SELECT dimension_key, units FROM quota_reservation_units WHERE reservation_id = ?",
		)
		.bind(reservationId)
		.all();
	return rows.results ?? [];
}

test("admission is denied without a verified account period anchor (never a UTC month)", async () => {
	const db = createResearchWorkflowDb();
	await seed(db, { anchor: false });
	const result = await admitOperation(
		db,
		request("op-no-anchor", [{ dimension_key: "d1.rows_written", units: 1 }]),
		{ account_id: ACCOUNT, now: NOW },
	);
	assert.equal(result.status, "DENIED");
	assert.equal(result.reason, "baseline");
	assert.match(result.detail, /billing period anchor is not verified/);
	const rows = await db.prepare("SELECT COUNT(*) AS n FROM quota_reservation_units").first();
	assert.equal(Number(rows.n), 0, "no reservation row may exist after a denial");
});

test("admission is denied when the dimension has no VERIFIED baseline (absence is not zero)", async () => {
	const db = createResearchWorkflowDb();
	await syncDimensionCatalog(db, QUOTA_DIMENSIONS);
	await recordAccountPeriod(db, {
		account_id: ACCOUNT,
		...PERIOD,
		anchor_kind: "subscription_renewal",
		source: "test",
		source_version: "test@1",
		verified_at: PERIOD.period_start,
	});
	const result = await admitOperation(
		db,
		request("op-no-baseline", [{ dimension_key: "d1.rows_read", units: 10 }]),
		{ account_id: ACCOUNT, now: NOW },
	);
	assert.equal(result.status, "DENIED");
	assert.equal(result.reason, "baseline");
	assert.match(result.detail, /no VERIFIED baseline/);
});

test("missing, stale or future baseline coverage cannot admit an operation", async () => {
	for (const coverageEnd of [null, "2026-09-18T20:00:00.000Z", "2026-09-20T00:01:00.000Z"]) {
		const db = createResearchWorkflowDb();
		await seed(db);
		await recordBaseline(db, {
			dimension_key: "d1.rows_read",
			period_key: PERIOD_KEY,
			state: "VERIFIED",
			used: 0,
			unobserved_upper_bound: 0,
			source: "test",
			source_version: "test@1",
			as_of: NOW.toISOString(),
			coverage_end: coverageEnd,
		}, NOW);
		const result = await admitOperation(
			db,
			request("op-expired-baseline", [{ dimension_key: "d1.rows_written", units: 1 }]),
			{ account_id: ACCOUNT, now: NOW },
		);
		assert.equal(result.status, "DENIED", coverageEnd);
		assert.equal(result.reason, "baseline", coverageEnd);
		const status = await quotaStatus(db, { account_id: ACCOUNT, now: NOW });
		assert.equal(status.dimensions.find((entry) => entry.dimension_key === "d1.rows_read").state, "CLOSED");
		const units = await db.prepare("SELECT COUNT(*) AS n FROM quota_reservation_units").first();
		assert.equal(Number(units.n), 0);
	}
});

test("a cycle baseline inside the 26h guard window still admits (ledger covers the gap)", async () => {
	const db = createResearchWorkflowDb();
	await seed(db);
	// 24h old: outside the repealed 5-minute window, inside the daily-source
	// window.  Every unit this guard admits is booked, so the window only bounds
	// off-ledger drift, not the 95% invariant.
	await recordBaseline(db, {
		dimension_key: "d1.rows_read",
		period_key: PERIOD_KEY,
		state: "VERIFIED",
		used: 0,
		unobserved_upper_bound: 0,
		source: "test",
		source_version: "test@1",
		as_of: "2026-09-19T00:00:00.000Z",
		coverage_end: "2026-09-19T00:00:00.000Z",
	}, NOW);
	const result = await admitOperation(
		db,
		request("op-window-baseline", [{ dimension_key: "d1.rows_written", units: 1 }]),
		{ account_id: ACCOUNT, now: NOW },
	);
	assert.equal(result.status, "ADMITTED");
});

test("admission reserves every dimension atomically and includes the ledger's own cost", async () => {
	const db = createResearchWorkflowDb();
	await seed(db);
	const result = await admitOperation(
		db,
		request("op-atomic-reserve", [
			{ dimension_key: "d1.rows_written", units: 12 },
			{ dimension_key: "r2.class_a", units: 2 },
		]),
		{ account_id: ACCOUNT, now: NOW },
	);
	assert.equal(result.status, "ADMITTED");
	const units = await liveUnits(db, result.reservation_id);
	const byKey = new Map(units.map((row) => [row.dimension_key, Number(row.units)]));
	assert.equal(byKey.get("d1.rows_written"), 12 + ledgerSelfWrites(3));
	assert.equal(byKey.get("r2.class_a"), 2);
	assert.equal(
		result.self_cost.length,
		1,
		"the ledger self-cost is reported separately from the business dims",
	);
	assert.equal(byKey.get("d1.rows_read"), ledgerSelfReads(3));
	const seal = await db
		.prepare("SELECT expected, applied FROM quota_reservations WHERE reservation_id = ?")
		.bind(result.reservation_id)
		.first();
	assert.equal(Number(seal.expected), Number(seal.applied), "the seal is computed in-database");
});

test("with_ledger_self_cost merges duplicates instead of double counting a dimension", () => {
	const merged = withLedgerSelfCost([
		{ dimension_key: "d1.rows_read", units: 5 },
		{ dimension_key: "d1.rows_read", units: 7 },
	]);
	const byKey = new Map(merged.map((entry) => [entry.dimension_key, entry.units]));
	assert.equal(byKey.get("d1.rows_read"), 12 + ledgerSelfReads(2));
	assert.equal(byKey.get("d1.rows_written"), ledgerSelfWrites(2));
});

test("ledger self-cost counts all final dimensions, including its own D1 dimensions", () => {
	const merged = withLedgerSelfCost([{ dimension_key: "r2.class_a", units: 1 }]);
	const byKey = new Map(merged.map((entry) => [entry.dimension_key, entry.units]));
	assert.equal(merged.length, 3);
	assert.equal(byKey.get("d1.rows_read"), ledgerSelfReads(3));
	assert.equal(byKey.get("d1.rows_written"), ledgerSelfWrites(3));
});

test("the guard denies the step past 95% and leaves no partial reservation", async () => {
	const db = createResearchWorkflowDb();
	await seed(db, { usedRatio: 0.949 });
	const entry = dimension("d1.rows_written");
	const headroom = entry.threshold_95 - Math.floor(entry.threshold_95 * 0.949);
	const ok = await admitOperation(
		db,
		request("op-at-line", [{ dimension_key: "r2.class_a", units: 0 }]),
		{ account_id: ACCOUNT, now: NOW },
	);
	assert.equal(ok.status, "ADMITTED");
	const over = await admitOperation(
		db,
		request(
			"op-over-line",
			[
				{ dimension_key: "d1.rows_written", units: headroom + 1 },
				{ dimension_key: "r2.class_a", units: 1 },
			],
			"b".repeat(32),
		),
		{ account_id: ACCOUNT, now: NOW },
	);
	assert.equal(over.status, "DENIED");
	assert.equal(over.reason, "limit");
	const leftovers = await db
		.prepare("SELECT COUNT(*) AS n FROM quota_reservation_units WHERE reservation_id = ?")
		.bind("op-over-line")
		.first();
	assert.equal(Number(leftovers.n), 0, "a partially admitted request must roll back entirely");
});

test("the unobserved upper bound counts against the ceiling", async () => {
	const db = createResearchWorkflowDb();
	await seed(db, { usedRatio: 0.5, unobservedRatio: 0.45 });
	const entry = dimension("r2.class_b");
	const remaining =
		entry.threshold_95 -
		Math.floor(entry.threshold_95 * 0.5) -
		Math.floor(entry.threshold_95 * 0.45);
	const denied = await admitOperation(
		db,
		request("op-unobserved", [{ dimension_key: "r2.class_b", units: remaining + 1 }]),
		{ account_id: ACCOUNT, now: NOW },
	);
	assert.equal(denied.status, "DENIED");
	assert.equal(denied.reason, "limit");
});

test("non-provable dimensions are refused instead of bounded by guesswork", async () => {
	const db = createResearchWorkflowDb();
	await seed(db);
	for (const key of ["ai.neurons", "d1.storage_gb_month", "r2.storage_gb_month"]) {
		const result = await admitOperation(
			db,
			request(`op-unprovable-${key}`, [{ dimension_key: key, units: 1 }]),
			{ account_id: ACCOUNT, now: NOW },
		);
		assert.equal(result.status, "DENIED", `${key} must be refused`);
		assert.equal(result.reason, "bound", `${key} must be refused as unprovable`);
	}
});

test("unknown dimensions and malformed requests fail closed as faults", async () => {
	const db = createResearchWorkflowDb();
	await seed(db);
	const unknown = await admitOperation(
		db,
		request("op-unknown-dim", [{ dimension_key: "mystery.dimension", units: 1 }]),
		{ account_id: ACCOUNT, now: NOW },
	);
	assert.equal(unknown.status, "DENIED");
	assert.equal(unknown.reason, "bound");
	const badId = await admitOperation(
		db,
		request("x", [{ dimension_key: "d1.rows_read", units: 1 }]),
		{
			account_id: ACCOUNT,
			now: NOW,
		},
	);
	assert.equal(badId.status, "DENIED");
	assert.equal(badId.reason, "fault");
	const badFingerprint = await admitOperation(
		db,
		request("op-bad-fingerprint", [{ dimension_key: "d1.rows_read", units: 1 }], "not-hex"),
		{ account_id: ACCOUNT, now: NOW },
	);
	assert.equal(badFingerprint.status, "DENIED");
	assert.equal(badFingerprint.reason, "fault");
});

test("the same operation id and fingerprint reuses the reservation; a different fingerprint conflicts", async () => {
	const db = createResearchWorkflowDb();
	await seed(db);
	const first = await admitOperation(
		db,
		request("op-idempotent", [{ dimension_key: "r2.class_a", units: 3 }], "c".repeat(32)),
		{ account_id: ACCOUNT, now: NOW },
	);
	assert.equal(first.status, "ADMITTED");
	const replay = await admitOperation(
		db,
		request("op-idempotent", [{ dimension_key: "r2.class_a", units: 3 }], "c".repeat(32)),
		{ account_id: ACCOUNT, now: NOW },
	);
	assert.equal(replay.status, "ADMITTED");
	assert.equal(replay.reservation_id, first.reservation_id, "no second physical cost");
	const conflict = await admitOperation(
		db,
		request("op-idempotent", [{ dimension_key: "r2.class_a", units: 9 }], "d".repeat(32)),
		{ account_id: ACCOUNT, now: NOW },
	);
	assert.equal(conflict.status, "DENIED");
	assert.equal(conflict.reason, "conflict");
});

test("settlement only accepts observed usage within the reservation and frees the live rows", async () => {
	const db = createResearchWorkflowDb();
	await seed(db);
	const admitted = await admitOperation(
		db,
		request("op-settle", [{ dimension_key: "r2.class_b", units: 40 }]),
		{ account_id: ACCOUNT, now: NOW },
	);
	assert.equal(admitted.status, "ADMITTED");
	const units = await liveUnits(db, admitted.reservation_id);
	const observed = units.map((row) => ({
		dimension_key: row.dimension_key,
		units: row.dimension_key === "r2.class_b" ? 1 : Number(row.units),
	}));

	// An under-reported observed value stays conservative: the full reservation is
	// charged (observed > reserved is the only thing rejected).
	const over = await settleReservation(db, {
		reservation_id: admitted.reservation_id,
		observed: units.map((row) => ({
			dimension_key: row.dimension_key,
			units: Number(row.units) + 1,
		})),
		reason: "test-over",
	});
	assert.equal(over.status, "REJECTED");
	assert.equal(
		(await liveUnits(db, admitted.reservation_id)).length > 0,
		true,
		"reservation kept",
	);

	const settled = await settleReservation(db, {
		reservation_id: admitted.reservation_id,
		observed,
		reason: "test",
	});
	assert.equal(settled.status, "SETTLED");
	assert.equal((await liveUnits(db, admitted.reservation_id)).length, 0);
	const journal = await db
		.prepare("SELECT outcome FROM quota_reservation_journal WHERE reservation_id = ?")
		.bind(admitted.reservation_id)
		.first();
	assert.equal(journal.outcome, "SETTLED");

	// A completed operation replays as REPLAY: the business call must not repeat.
	const replay = await admitOperation(
		db,
		request("op-settle", [{ dimension_key: "r2.class_b", units: 40 }]),
		{ account_id: ACCOUNT, now: NOW },
	);
	assert.equal(replay.status, "REPLAY");
	assert.equal(replay.outcome, "SETTLED");
});

/** Settle a reservation at its full reserved amount (the conservative observed value). */
async function settleFully(db, reservationId, reason) {
	const units = await liveUnits(db, reservationId);
	const settled = await settleReservation(db, {
		reservation_id: reservationId,
		observed: units.map((row) => ({
			dimension_key: row.dimension_key,
			units: Number(row.units),
		})),
		reason,
	});
	assert.equal(settled.status, "SETTLED", settled.detail ?? "settlement must succeed");
	return units;
}

test("a settled reservation keeps constraining the ceiling: released live rows must not release the spend", async () => {
	const db = createResearchWorkflowDb();
	await seed(db);
	const entry = dimension("r2.class_a");
	assert.equal(entry.threshold_95, 950_000);
	const chunk = 400_000;

	const first = await admitOperation(
		db,
		request("op-sequential-1", [{ dimension_key: "r2.class_a", units: chunk }]),
		{ account_id: ACCOUNT, now: NOW },
	);
	assert.equal(first.status, "ADMITTED");
	await settleFully(db, first.reservation_id, "sequential-1");
	assert.equal((await liveUnits(db, first.reservation_id)).length, 0, "live rows are released");

	const second = await admitOperation(
		db,
		request("op-sequential-2", [{ dimension_key: "r2.class_a", units: chunk }], "b".repeat(32)),
		{ account_id: ACCOUNT, now: NOW },
	);
	assert.equal(second.status, "ADMITTED");
	await settleFully(db, second.reservation_id, "sequential-2");

	// 800_000 booked + 400_000 would be 1_200_000 > 950_000: the second settlement
	// must NOT have returned the headroom it already consumed.
	const third = await admitOperation(
		db,
		request("op-sequential-3", [{ dimension_key: "r2.class_a", units: chunk }], "c".repeat(32)),
		{ account_id: ACCOUNT, now: NOW },
	);
	assert.equal(third.status, "DENIED", "settled spend must stay booked until the period rolls");
	assert.equal(third.reason, "limit");

	// The exact remaining headroom is still admissible, and one unit past it is not.
	const exact = await admitOperation(
		db,
		request(
			"op-sequential-4",
			[{ dimension_key: "r2.class_a", units: 150_000 }],
			"d".repeat(32),
		),
		{ account_id: ACCOUNT, now: NOW },
	);
	assert.equal(
		exact.status,
		"ADMITTED",
		"the remaining 150_000 of headroom is usable exactly once",
	);
	await settleFully(db, exact.reservation_id, "sequential-4");
	const over = await admitOperation(
		db,
		request("op-sequential-5", [{ dimension_key: "r2.class_a", units: 1 }], "e".repeat(32)),
		{ account_id: ACCOUNT, now: NOW },
	);
	assert.equal(over.status, "DENIED");
	assert.equal(over.reason, "limit");
});

test("release requires the no-call proof; anything else keeps the reservation", async () => {
	const db = createResearchWorkflowDb();
	await seed(db);
	const admitted = await admitOperation(
		db,
		request("op-release", [{ dimension_key: "r2.class_a", units: 1 }]),
		{ account_id: ACCOUNT, now: NOW },
	);
	assert.equal(admitted.status, "ADMITTED");
	const refused = await releaseReservation(db, {
		reservation_id: admitted.reservation_id,
		proof: "observed_zero_by_provider",
		reason: "test",
	});
	assert.equal(refused.status, "REJECTED");
	assert.equal((await liveUnits(db, admitted.reservation_id)).length > 0, true);
	const released = await releaseReservation(db, {
		reservation_id: admitted.reservation_id,
		proof: "provider_call_not_sent",
		reason: "validation failed before the call",
	});
	assert.equal(released.status, "RELEASED");
	assert.equal((await liveUnits(db, admitted.reservation_id)).length, 0);
});

test("the per-dimension scan cap bounds the guard's own reads and denies at the cap", async () => {
	const db = createResearchWorkflowDb();
	await seed(db);
	// Fill the live table for one dimension/period to the cap with settled-less rows.
	const statements = [];
	for (let index = 0; index < QUOTA_GUARD_SCAN_CAP; index += 1) {
		statements.push(
			db
				.prepare(
					"INSERT INTO quota_reservation_units (reservation_id, dimension_key, period_key, units, state) VALUES (?, 'r2.class_a', ?, 0, 'ADMITTED')",
				)
				.bind(`filler-${index}`, PERIOD_KEY),
		);
	}
	await db.batch(statements);
	const denied = await admitOperation(
		db,
		request("op-scan-cap", [{ dimension_key: "r2.class_a", units: 0 }]),
		{ account_id: ACCOUNT, now: NOW },
	);
	assert.equal(denied.status, "DENIED");
	assert.equal(denied.reason, "limit");
	assert.match(denied.detail, /live-row cap|scan bound/);
});

test("status reports CLOSED until a verified baseline exists and never claims a quantified guarantee", async () => {
	const db = createResearchWorkflowDb();
	await syncDimensionCatalog(db, QUOTA_DIMENSIONS);
	const before = await quotaStatus(db, { account_id: ACCOUNT, now: NOW });
	assert.equal(before.anchor_verified, false);
	assert.equal(before.legacy_prototype, "disabled");
	const d1 = before.dimensions.find((entry) => entry.dimension_key === "d1.rows_read");
	assert.equal(d1.state, "UNKNOWN", "no anchor means the period cannot be proven");
	await seed(db);
	const after = await quotaStatus(db, { account_id: ACCOUNT, now: NOW });
	assert.equal(after.anchor_verified, true);
	assert.equal(after.period.period_start, PERIOD.period_start);
	const d1After = after.dimensions.find((entry) => entry.dimension_key === "d1.rows_read");
	assert.equal(d1After.state, "OPEN");
	assert.equal(d1After.threshold_95, dimension("d1.rows_read").threshold_95);
	const neurons = after.dimensions.find((entry) => entry.dimension_key === "ai.neurons");
	assert.equal(neurons.state, "CLOSED", "AI has no provable bound");
});

test("no UTC calendar month, no month/31 divisor, and no timeout release exist in the SQL", () => {
	const guard = buildGuardSql(2);
	const seal = buildSealSql();
	for (const sql of [guard, seal]) {
		assert.doesNotMatch(sql, /\/\s*31\b/, "a month/31 divisor must not exist");
		assert.doesNotMatch(sql, /strftime\([^)]*%m/, "no calendar-month derivation");
		assert.doesNotMatch(sql, /\bexpires_at\b.*\)\s*$/i, "expiry must not drive release");
	}
	assert.match(guard, /quota_period_baselines/);
	assert.match(guard, /quota_dimension_catalog/);
	assert.match(seal, /applied/);
	assert.equal(QUOTA_CATALOG_VERSION.includes("2026-09-29"), true);
});

// ---------------------------------------------------------------------------
// S1 repair: the cumulative booked upper bound
// ---------------------------------------------------------------------------

test("the guard spends against the cumulative booking, never against live rows only", () => {
	const guard = buildGuardSql(2);
	assert.match(guard, /quota_booked_usage/, "the ceiling term must read the booking");
	assert.doesNotMatch(
		guard,
		/SUM\(u\.units\)/,
		"live reserved units must not be the spend term: settlement deletes them",
	);
	// Row caps stay in place (bounded reads); caps were not lowered, and the
	// per-dimension count is pinned to the guard index so its scan stays bounded.
	assert.match(
		guard,
		/COUNT\(\*\) FROM quota_reservation_units AS u INDEXED BY quota_reservation_units_guard/,
		"the per-dimension count must pin the (dimension_key, period_key) index",
	);
	assert.match(
		guard,
		/\(\s*SELECT COUNT\(\*\) FROM quota_reservation_units\s*\)/,
		"the global live-row cap must stay in the guard",
	);
	assert.match(guard, /\+\s*1 <= \?\d/);
	assert.equal(QUOTA_GUARD_SCAN_CAP, 256);
	assert.equal(QUOTA_LIVE_UNITS_CAP, 4096);

	const booked = buildBookedSql();
	assert.match(booked, /INSERT INTO quota_booked_usage/);
	assert.match(
		booked,
		/WHERE u\.reservation_id = \?1/,
		"the booking derives from the admitted rows",
	);
	assert.match(booked, /ON CONFLICT\(dimension_key, period_key\) DO UPDATE SET/);
	assert.match(
		booked,
		/booked_units = booked_units \+ excluded\.booked_units/,
		"the accumulator only ever grows",
	);
	assert.doesNotMatch(
		booked,
		/booked_units\s*=\s*booked_units\s*-/,
		"no decrement path may exist",
	);
});

test("self-cost accounting covers the guard's scans and the settle lifecycle (audit I3/I5)", () => {
	// I3: the old formula declared 1 + n*(2+256) = 1033 reads for four dimensions
	// while the guard really issues a per-dimension COUNT(*) and a global COUNT(*).
	assert.ok(
		ledgerSelfReads(4) >= 6152,
		`declared self reads must cover the real scans (got ${ledgerSelfReads(4)})`,
	);
	assert.equal(
		ledgerSelfReads(1),
		3 + (3 + QUOTA_GUARD_SCAN_CAP + QUOTA_LIVE_UNITS_CAP * 2) + ledgerLifecycleReads(),
	);
	// A matching-row cap is not a scanned-row bound (D1 bills scanned rows), so both
	// COUNT(*) scans are charged the whole live table per dimension.
	assert.ok(ledgerSelfReads(4) >= 3 + 4 * (3 + 2 * QUOTA_LIVE_UNITS_CAP));
	// The per-dimension count pins its access path, so the 256-row invariant is real
	// plan-level evidence, not a planner assumption; the declaration above does not
	// depend on it.
	assert.match(buildGuardSql(1), /INDEXED BY quota_reservation_units_guard/);
	assert.match(buildDiagnosisSql(1), /INDEXED BY quota_reservation_units_guard/);
	// I5: the settle/release that follows an admission is prepaid in the same
	// reservation (unit rows + seal + booked rows + lifecycle).
	assert.equal(
		ledgerSelfWrites(4),
		4 + 1 + 4 + ledgerLifecycleWrites(),
		"writes = unit rows + seal + booked rows + prepaid lifecycle",
	);
	assert.ok(ledgerLifecycleReads() > 0 && ledgerLifecycleWrites() > 0);
});

test("a booking failure aborts the whole admission batch: no partial reservation, no booking", async () => {
	const db = createResearchWorkflowDb();
	await seed(db);
	// The table exists but every booking write fails, so only the atomicity of the
	// three-statement batch can decide the outcome.
	await db
		.prepare(
			`CREATE TRIGGER booking_unavailable BEFORE INSERT ON quota_booked_usage
			 BEGIN SELECT RAISE(ABORT, 'booked ledger unavailable'); END`,
		)
		.run();
	const result = await admitOperation(
		db,
		request("op-booking-down", [{ dimension_key: "r2.class_a", units: 1 }]),
		{ account_id: ACCOUNT, now: NOW },
	);
	assert.equal(result.status, "DENIED");
	assert.equal(
		result.reason,
		"fault",
		"a ledger fault is never reported as a limit or as success",
	);
	const units = await db.prepare("SELECT COUNT(*) AS n FROM quota_reservation_units").first();
	const headers = await db.prepare("SELECT COUNT(*) AS n FROM quota_reservations").first();
	assert.equal(Number(units.n), 0, "the guard's rows must roll back with the failed booking");
	assert.equal(Number(headers.n), 0, "no seal row may survive");
});

test("the booked accumulator is monotonic across settle and release", async () => {
	const db = createResearchWorkflowDb();
	await seed(db);
	const settledOp = await admitOperation(
		db,
		request("op-mono-settle", [{ dimension_key: "r2.class_b", units: 5_000 }]),
		{ account_id: ACCOUNT, now: NOW },
	);
	assert.equal(settledOp.status, "ADMITTED");
	assert.equal(await readBookedUsage(db, "r2.class_b", PERIOD_KEY), 5_000);
	await settleFully(db, settledOp.reservation_id, "mono-settle");
	assert.equal(
		await readBookedUsage(db, "r2.class_b", PERIOD_KEY),
		5_000,
		"settlement must not decrement the booking",
	);
	assert.equal((await liveUnits(db, settledOp.reservation_id)).length, 0);

	const releasedOp = await admitOperation(
		db,
		request("op-mono-release", [{ dimension_key: "r2.class_b", units: 7_000 }], "b".repeat(32)),
		{ account_id: ACCOUNT, now: NOW },
	);
	assert.equal(releasedOp.status, "ADMITTED");
	const released = await releaseReservation(db, {
		reservation_id: releasedOp.reservation_id,
		proof: "provider_call_not_sent",
		reason: "mono-release",
	});
	assert.equal(released.status, "RELEASED");
	assert.equal(
		await readBookedUsage(db, "r2.class_b", PERIOD_KEY),
		12_000,
		"a release must not return the booked spend either",
	);
});

test("a released operation still consumes the ceiling: released spend is not free headroom", async () => {
	const db = createResearchWorkflowDb();
	await seed(db);
	const entry = dimension("r2.class_b");
	assert.equal(entry.threshold_95, 9_500_000);
	const nearCeiling = entry.threshold_95 - 1;
	const admitted = await admitOperation(
		db,
		request("op-release-ceiling", [{ dimension_key: "r2.class_b", units: nearCeiling }]),
		{ account_id: ACCOUNT, now: NOW },
	);
	assert.equal(admitted.status, "ADMITTED");
	const released = await releaseReservation(db, {
		reservation_id: admitted.reservation_id,
		proof: "provider_call_not_sent",
		reason: "no provider call was sent",
	});
	assert.equal(released.status, "RELEASED");
	const over = await admitOperation(
		db,
		request("op-release-over", [{ dimension_key: "r2.class_b", units: 2 }], "b".repeat(32)),
		{ account_id: ACCOUNT, now: NOW },
	);
	assert.equal(over.status, "DENIED");
	assert.equal(over.reason, "limit");
	const exact = await admitOperation(
		db,
		request("op-release-exact", [{ dimension_key: "r2.class_b", units: 1 }], "c".repeat(32)),
		{ account_id: ACCOUNT, now: NOW },
	);
	assert.equal(exact.status, "ADMITTED", "the last unit of headroom is still exact");
});

test("replays never book twice: neither the live-reservation reuse nor the completed REPLAY", async () => {
	const db = createResearchWorkflowDb();
	await seed(db);
	const first = await admitOperation(
		db,
		request("op-replay-live", [{ dimension_key: "r2.class_a", units: 500 }], "a".repeat(32)),
		{ account_id: ACCOUNT, now: NOW },
	);
	assert.equal(first.status, "ADMITTED");
	assert.equal(await readBookedUsage(db, "r2.class_a", PERIOD_KEY), 500);
	const reuse = await admitOperation(
		db,
		request("op-replay-live", [{ dimension_key: "r2.class_a", units: 500 }], "a".repeat(32)),
		{ account_id: ACCOUNT, now: NOW },
	);
	assert.equal(reuse.status, "ADMITTED");
	assert.equal(reuse.reservation_id, first.reservation_id);
	assert.equal(
		await readBookedUsage(db, "r2.class_a", PERIOD_KEY),
		500,
		"a reused live reservation must not book a second time",
	);
	assert.equal(
		(await liveUnits(db, first.reservation_id)).length,
		3,
		"still one live row per reserved dimension (r2.class_a plus the two ledger dims)",
	);

	await settleFully(db, first.reservation_id, "replay-live");
	const bookedAfterSettle = await readBookedUsage(db, "r2.class_a", PERIOD_KEY);
	const replay = await admitOperation(
		db,
		request("op-replay-live", [{ dimension_key: "r2.class_a", units: 500 }], "a".repeat(32)),
		{ account_id: ACCOUNT, now: NOW },
	);
	assert.equal(replay.status, "REPLAY");
	assert.equal(
		await readBookedUsage(db, "r2.class_a", PERIOD_KEY),
		bookedAfterSettle,
		"a completed operation replays without a new physical cost and without a new booking",
	);
});

test("booked usage is scoped by the natural period: a new verified period starts a fresh accumulator", async () => {
	const db = createResearchWorkflowDb();
	await seed(db);
	const a1 = await admitOperation(
		db,
		request("op-period-a1", [{ dimension_key: "r2.class_a", units: 400_000 }]),
		{ account_id: ACCOUNT, now: NOW },
	);
	assert.equal(a1.status, "ADMITTED");
	await settleFully(db, a1.reservation_id, "period-a1");
	const a2 = await admitOperation(
		db,
		request("op-period-a2", [{ dimension_key: "r2.class_a", units: 400_000 }], "b".repeat(32)),
		{ account_id: ACCOUNT, now: NOW },
	);
	assert.equal(a2.status, "ADMITTED");
	await settleFully(db, a2.reservation_id, "period-a2");
	assert.equal(await readBookedUsage(db, "r2.class_a", PERIOD_KEY), 800_000);

	const NEXT = {
		period_start: "2026-10-14T00:00:00.000Z",
		period_end: "2026-11-14T00:00:00.000Z",
	};
	const NEXT_KEY = `cycle:${NEXT.period_start}..${NEXT.period_end}`;
	const nextNow = new Date("2026-10-20T00:00:00.000Z");
	await recordAccountPeriod(db, {
		account_id: ACCOUNT,
		...NEXT,
		anchor_kind: "subscription_renewal",
		source: "test",
		source_version: "test@1",
		verified_at: NEXT.period_start,
	});
	// A new period key is not opened by the mere absence of a booked row: it needs
	// its own VERIFIED baseline, exactly like the first period did.
	const unguarded = await admitOperation(
		db,
		request("op-period-b0", [{ dimension_key: "r2.class_a", units: 1 }], "c".repeat(32)),
		{ account_id: ACCOUNT, now: nextNow },
	);
	assert.equal(unguarded.status, "DENIED");
	assert.equal(unguarded.reason, "baseline");
	await recordBaseline(db, {
		dimension_key: "r2.class_a",
		period_key: NEXT_KEY,
		state: "VERIFIED",
		used: 0,
		unobserved_upper_bound: 0,
		source: "test",
		source_version: "test@1",
		as_of: nextNow.toISOString(),
		coverage_end: nextNow.toISOString(),
	});
	// The ledger's own dimensions are reserved on every admission, so they need a
	// VERIFIED baseline for the new period too — the rollover is fail-closed.
	for (const key of ["d1.rows_read", "d1.rows_written"]) {
		await recordBaseline(db, {
			dimension_key: key,
			period_key: NEXT_KEY,
			state: "VERIFIED",
			used: 0,
			unobserved_upper_bound: 0,
			source: "test",
			source_version: "test@1",
			as_of: nextNow.toISOString(),
			coverage_end: nextNow.toISOString(),
		});
	}
	const staleClock = await admitOperation(
		db,
		request("op-period-b-stale-clock", [{ dimension_key: "r2.class_a", units: 1 }], "e".repeat(32)),
		{ account_id: ACCOUNT, now: NOW },
	);
	assert.equal(staleClock.status, "DENIED");
	assert.equal(staleClock.reason, "baseline");
	const fresh = await admitOperation(
		db,
		request("op-period-b1", [{ dimension_key: "r2.class_a", units: 400_000 }], "d".repeat(32)),
		{ account_id: ACCOUNT, now: nextNow },
	);
	assert.equal(fresh.status, "ADMITTED");
	assert.equal(
		await readBookedUsage(db, "r2.class_a", PERIOD_KEY),
		800_000,
		"the previous period's booking is retained, not reset",
	);
	assert.equal(await readBookedUsage(db, "r2.class_a", NEXT_KEY), 400_000);
});

test("a missing booked row is zero only for an unadmitted period, and the CHECK rejects corruption", async () => {
	const db = createResearchWorkflowDb();
	await seed(db);
	assert.equal(
		await readBookedUsage(db, "r2.class_a", PERIOD_KEY),
		null,
		"no booking yet is reported as absent, not as a verified zero",
	);
	await db
		.prepare(
			`INSERT INTO quota_booked_usage
			 (dimension_key, period_key, booked_units, booked_reservations, first_booked_at, last_booked_at, updated_at)
			 VALUES ('r2.class_a', ?, 1, 1, '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z')`,
		)
		.bind(PERIOD_KEY)
		.run();
	await assert.rejects(
		() =>
			db
				.prepare(
					"UPDATE quota_booked_usage SET booked_units = ? WHERE dimension_key = 'r2.class_a'",
				)
				.bind(MAX_BOOKED_UNITS + 1)
				.run(),
		/CHECK/i,
		"the safe-integer upper CHECK must reject an overflow write",
	);
	await assert.rejects(
		() =>
			db
				.prepare(
					"UPDATE quota_booked_usage SET booked_units = -1 WHERE dimension_key = 'r2.class_a'",
				)
				.run(),
		/CHECK/i,
		"a negative accumulator must be rejected",
	);
});

test("the migration carries the accumulator, its safe-integer CHECK and the live-row backfill", () => {
	const sql = readFileSync(
		new URL("../migrations/0018_quota_booked_usage.sql", import.meta.url),
		"utf8",
	);
	assert.match(sql, /CREATE TABLE IF NOT EXISTS quota_booked_usage/);
	assert.match(sql, /PRIMARY KEY \(dimension_key, period_key\)/);
	assert.match(sql, /booked_units >= 0 AND booked_units <= 9007199254740991/);
	assert.match(
		sql,
		/INSERT INTO quota_booked_usage[\s\S]*FROM quota_reservation_units/,
		"existing live rows must be backed into the accumulator so `live <= booked` holds",
	);
	assert.match(
		sql,
		/quota_0018_requires_no_settled_history/,
		"the migration must refuse a database whose settled history cannot be reconstructed",
	);
	assert.doesNotMatch(
		sql,
		/DELETE FROM quota_booked_usage/,
		"no reset path may exist in the schema",
	);
});

// ---------------------------------------------------------------------------
// Migration safety: settled 0017 history must never be dropped silently
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);
const MIGRATION_FILES = readdirSync(fileURLToPath(MIGRATIONS_DIR)).sort();

function applyMigration(sqlite, prefix) {
	const name = MIGRATION_FILES.find((file) => file.startsWith(prefix) && file.endsWith(".sql"));
	assert.ok(name, `missing migration ${prefix}`);
	sqlite.exec(readFileSync(fileURLToPath(new URL(name, MIGRATIONS_DIR)), "utf8"));
}

function applyThrough(sqlite, lastPrefix) {
	for (let index = 1; index <= Number(lastPrefix); index += 1) {
		applyMigration(sqlite, String(index).padStart(4, "0"));
	}
}

function tableCount(sqlite, name) {
	return sqlite
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
		.all(name).length;
}

test("0018 refuses to initialize over 0017 history that already settled reservations", () => {
	const sqlite = new DatabaseSync(":memory:");
	applyThrough(sqlite, "0017");
	assert.equal(tableCount(sqlite, "quota_booked_usage"), 0, "0017 has no accumulator");
	// The dangerous state: spend that already left the live table for the journal.
	sqlite.exec(
		`INSERT INTO quota_reservation_journal
		 (reservation_id, operation_id, fingerprint, route, outcome, outcome_reason, expected_units_json, observed_units_json, recorded_at)
		 VALUES ('res-legacy', 'op-legacy', '${"a".repeat(32)}', 'http:/internal/research-replica/v2/ingest',
			'SETTLED', 'pre-0018 settlement', '[{"dimension_key":"r2.class_a","units":400000}]',
			'[{"dimension_key":"r2.class_a","units":400000}]', '2026-09-19T00:00:00.000Z')`,
	);
	assert.throws(
		() => applyMigration(sqlite, "0018"),
		/quota_0018_requires_no_settled_history/,
		"a database with unreconstructable settled spend must not be initialized",
	);
	assert.equal(
		sqlite.prepare("SELECT COUNT(*) AS n FROM quota_reservation_journal").get().n,
		1,
		"the journal audit trail is untouched",
	);
	if (tableCount(sqlite, "quota_booked_usage") === 1) {
		assert.equal(
			sqlite.prepare("SELECT COUNT(*) AS n FROM quota_booked_usage").get().n,
			0,
			"a refused migration must not leave a partially booked accumulator",
		);
	}

	// A partial manual booking cannot certify all historical dimensions or periods.
	sqlite
		.prepare(
			`INSERT INTO quota_booked_usage
			 (dimension_key, period_key, booked_units, booked_reservations, first_booked_at, last_booked_at, updated_at)
			 VALUES ('r2.class_a', 'cycle:x..y', 400000, 1, '2026-09-19T00:00:00.000Z', '2026-09-19T00:00:00.000Z', '2026-09-19T00:00:00.000Z')`,
		)
		.run();
	assert.throws(
		() => applyMigration(sqlite, "0018"),
		/quota_0018_requires_no_settled_history/,
		"even a nonempty accumulator cannot waive the historical settlement check",
	);
});

test("0018 backfills a 0017 database that only has live reservations", () => {
	const sqlite = new DatabaseSync(":memory:");
	applyThrough(sqlite, "0017");
	sqlite.exec(
		`INSERT INTO quota_reservation_units (reservation_id, dimension_key, period_key, units, state)
		 VALUES ('res-live', 'r2.class_a', 'cycle:2026-09-14T00:00:00.000Z..2026-10-14T00:00:00.000Z', 1234, 'ADMITTED')`,
	);
	applyMigration(sqlite, "0018");
	assert.equal(
		sqlite
			.prepare(
				"SELECT booked_units FROM quota_booked_usage WHERE dimension_key = 'r2.class_a'",
			)
			.get().booked_units,
		1234,
		"live rows that predate the accumulator are booked, so `live <= booked` holds",
	);
	// Re-applying the file is a no-op: the backfill must not double count.
	applyMigration(sqlite, "0018");
	assert.equal(
		sqlite
			.prepare(
				"SELECT booked_units FROM quota_booked_usage WHERE dimension_key = 'r2.class_a'",
			)
			.get().booked_units,
		1234,
		"a second apply must not double count the same live rows",
	);
});

test("0018 backfills every live dimension when the booked table is partially populated", () => {
	const sqlite = new DatabaseSync(":memory:");
	applyThrough(sqlite, "0017");
	sqlite.exec(
		`CREATE TABLE quota_booked_usage (
		 dimension_key TEXT NOT NULL, period_key TEXT NOT NULL, booked_units INTEGER NOT NULL,
		 booked_reservations INTEGER NOT NULL, first_booked_at TEXT NOT NULL,
		 last_booked_at TEXT NOT NULL, updated_at TEXT NOT NULL,
		 PRIMARY KEY (dimension_key, period_key));
		 INSERT INTO quota_booked_usage VALUES
		 ('r2.class_a', 'cycle:x..y', 500, 1, '2026-09-19', '2026-09-19', '2026-09-19');
		 INSERT INTO quota_reservation_units (reservation_id, dimension_key, period_key, units, state)
		 VALUES ('res-a', 'r2.class_a', 'cycle:x..y', 200, 'ADMITTED'),
		        ('res-b', 'd1.rows_read', 'cycle:x..y', 300, 'ADMITTED')`,
	);
	applyMigration(sqlite, "0018");
	assert.deepEqual(
		sqlite.prepare("SELECT dimension_key, booked_units FROM quota_booked_usage ORDER BY dimension_key").all().map((row) => ({ ...row })),
		[
			{ dimension_key: "d1.rows_read", booked_units: 300 },
			{ dimension_key: "r2.class_a", booked_units: 500 },
		],
	);
	applyMigration(sqlite, "0018");
	assert.equal(
		sqlite.prepare("SELECT booked_units FROM quota_booked_usage WHERE dimension_key = 'd1.rows_read'").get().booked_units,
		300,
	);
});

test("quota status reports the booked bound, not just the live reservations", async () => {
	const db = createResearchWorkflowDb();
	await seed(db);
	const admitted = await admitOperation(
		db,
		request("op-status-booked", [{ dimension_key: "r2.class_a", units: 900_000 }]),
		{ account_id: ACCOUNT, now: NOW },
	);
	assert.equal(admitted.status, "ADMITTED");
	await settleFully(db, admitted.reservation_id, "status-booked");
	const status = await quotaStatus(db, { account_id: ACCOUNT, now: NOW });
	const entry = status.dimensions.find((row) => row.dimension_key === "r2.class_a");
	assert.equal(entry.booked, 900_000, "the booked bound survives settlement in the status view");
	assert.equal(entry.reserved, 0, "no live reservation remains");
	assert.equal(entry.state, "OPEN");
	const exhausted = await admitOperation(
		db,
		request(
			"op-status-exhausted",
			[{ dimension_key: "r2.class_a", units: 50_000 }],
			"b".repeat(32),
		),
		{ account_id: ACCOUNT, now: NOW },
	);
	assert.equal(exhausted.status, "ADMITTED");
	await settleFully(db, exhausted.reservation_id, "status-exhausted");
	const after = await quotaStatus(db, { account_id: ACCOUNT, now: NOW });
	const entryAfter = after.dimensions.find((row) => row.dimension_key === "r2.class_a");
	assert.equal(entryAfter.booked, 950_000);
	assert.equal(entryAfter.state, "CLOSED");
	assert.match(entryAfter.reason, /headroom exhausted/);
	const refused = await admitOperation(
		db,
		request("op-status-refused", [{ dimension_key: "r2.class_a", units: 1 }], "c".repeat(32)),
		{ account_id: ACCOUNT, now: NOW },
	);
	assert.equal(refused.status, "DENIED");
	assert.equal(refused.reason, "limit");
});
