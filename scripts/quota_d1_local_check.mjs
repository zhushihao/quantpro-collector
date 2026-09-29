#!/usr/bin/env node
// Local, offline evidence run for the quota admission SQL against the REAL D1
// engine (workerd via wrangler), never the network.
//
//   node --experimental-strip-types scripts/quota_d1_local_check.mjs
//
// What it proves, all inside an isolated `--persist-to` directory under the OS
// temp dir (the deployed database is never touched):
//   1. `migrations/0017_quota_admission.sql` and
//      `migrations/0018_quota_booked_usage.sql` apply to a fresh local D1;
//   2. the real guard statement admits a request that fits, and (together with the
//      seal and the booking statement) writes exactly one unit row per dimension,
//      one header row and one booked-usage row per dimension;
//   3. a request past the 95% ceiling is denied and leaves NO row behind;
//   4. a seal whose `expected` does not match the rows the guard actually inserted
//      aborts the whole batch (CHECK(applied = expected)) and rolls back both the
//      unit rows and the booking — the all-or-nothing property the design depends
//      on;
//   5. the per-dimension scan cap refuses to grow the guard's own read bound;
//   6. S1 repair: a settled reservation keeps constraining the ceiling.  Two
//      sequential `admit -> settle` cycles of 400k on a 950k dimension leave the
//      third 400k DENIED, with the booked row still at 800k (the old live-row
//      guard admitted it);
//   7. re-running the same reservation batch cannot double-book, and a failed
//      booking write rolls the whole admission back;
//   8. the booked accumulator rejects an overflow write (safe-integer CHECK);
//   9. migration 0018 backfills live unit rows that predate it, so `live <= booked`
//      holds across the upgrade.
//
// Concurrency (requests racing for the same headroom, including settle-then-
// readmit under concurrency) is exercised against a local `wrangler dev` D1
// binding by `scripts/quota_d1_concurrency_check.mjs`.
//
// Exit code 0 = every check matched; 1 = a check failed or wrangler is missing;
// 2 = usage error (for example a `--remote` attempt).

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { QUOTA_CATALOG_VERSION, QUOTA_DIMENSIONS } from "../src/quota-dimensions.ts";
import {
	QUOTA_GUARD_SCAN_CAP,
	bookedParameterValues,
	buildBookedSql,
	buildGuardSql,
	buildSealSql,
	buildSettleStatements,
	guardParameterValues,
	sealParameterValues,
} from "../src/quota-admission.ts";

// Invoke the wrangler JS entry directly: spawning the .cmd shim from Node throws
// EINVAL on Windows, and this keeps the script shell-free.
const WRANGLER = join(process.cwd(), "node_modules", "wrangler", "bin", "wrangler.js");
const DATABASE = "quantpro-collector-research-replica";
const MIGRATIONS = ["0017_quota_admission.sql", "0018_quota_booked_usage.sql"].map((name) =>
	join(process.cwd(), "migrations", name),
);
const ACCOUNT = "local-check-account";
const PERIOD = {
	period_start: "2026-09-14T00:00:00.000Z",
	period_end: "2026-10-14T00:00:00.000Z",
};
const PERIOD_KEY = `cycle:${PERIOD.period_start}..${PERIOD.period_end}`;
const NOW = "2026-09-20T00:00:00.000Z";
const ROUTE = "http:/internal/research-replica/v2/ingest";

if (process.argv.includes("--remote")) {
	console.error("quota_d1_local_check: refusing to run with --remote; this script is local-only");
	process.exit(2);
}

function lit(value) {
	if (value === null || value === undefined) return "NULL";
	if (typeof value === "number") return String(value);
	return `'${String(value).replaceAll("'", "''")}'`;
}

function run(sql, persistTo) {
	const dir = persistTo;
	const file = join(dir, `check-${Date.now()}-${Math.floor(Math.random() * 1e6)}.sql`);
	writeFileSync(file, sql, "utf8");
	try {
		const output = execFileSync(
			process.execPath,
			[
				WRANGLER,
				"d1",
				"execute",
				DATABASE,
				"--local",
				"--persist-to",
				dir,
				"--file",
				file,
				"--json",
			],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, CI: "1" },
			},
		);
		return { ok: true, output };
	} catch (error) {
		return {
			ok: false,
			output: `${error.stdout ?? ""}${error.stderr ?? ""}${error.message ?? ""}`,
		};
	}
}

/**
 * Apply a migration file.  A fresh workerd/CLI invocation can fail transiently
 * (observed once under load), and every statement here is `IF NOT EXISTS` or
 * idempotent, so one retry is applied; the result of the last attempt is returned
 * and the failing output stays in the check detail, so a real failure is still
 * visible instead of being smoothed over.
 */
function applyMigrationFile(file, persistTo, attempts = 2) {
	let result = run(readFileSync(file, "utf8"), persistTo);
	for (let index = 1; index < attempts && !result.ok; index += 1) {
		result = run(readFileSync(file, "utf8"), persistTo);
	}
	return result;
}

function selectRows(sql, persistTo) {
	const result = run(sql, persistTo);
	if (!result.ok) return null;
	const parsed = JSON.parse(result.output.slice(result.output.indexOf("[")));
	return parsed[0]?.results ?? [];
}

/** Render a numbered-parameter statement with literals (CLI has no bind API). */
function renderWithLiterals(sql, values) {
	return sql.replace(/\?(\d+)/g, (_match, position) => lit(values[Number(position) - 1] ?? null));
}

function guardStatement(entries, reservationId) {
	const values = guardParameterValues({
		reservation_id: reservationId,
		entries: entries.map((entry) => ({
			...entry,
			// Match the production per-period window (26h for cycle/storage).
			baseline_cutoff: new Date(Date.parse(NOW) - 26 * 60 * 60 * 1000).toISOString(),
		})),
		catalog_version: QUOTA_CATALOG_VERSION,
		scan_cap: QUOTA_GUARD_SCAN_CAP,
		live_cap: 4096,
		now: NOW,
	});
	return `${renderWithLiterals(buildGuardSql(entries.length), values)};`;
}

function sealStatement(args) {
	const values = sealParameterValues(args);
	return `${renderWithLiterals(buildSealSql(), values)};`;
}

function bookedStatement(reservationId, bookedAt = NOW) {
	const values = bookedParameterValues({ reservation_id: reservationId, booked_at: bookedAt });
	return `${renderWithLiterals(buildBookedSql(), values)};`;
}

/** The production settlement batch, rendered with literals for the CLI. */
function settleStatements(
	reservationId,
	operationId,
	observed,
	fingerprint,
	reason = "local-check-settle",
) {
	const specs = buildSettleStatements({
		reservation_id: reservationId,
		operation_id: operationId,
		fingerprint,
		route: ROUTE,
		reason,
		expected_units_json: JSON.stringify(
			observed.map(({ dimension_key, units }) => ({ dimension_key, units })),
		),
		observed_units_json: JSON.stringify(observed),
		recorded_at: NOW,
		observed,
	});
	return specs.map((spec) => `${renderWithLiterals(spec.sql, spec.values)};`).join("\n");
}

function admissionBatch(
	reservationId,
	operationId,
	entries,
	expected,
	fingerprint = "a".repeat(32),
) {
	return [
		guardStatement(entries, reservationId),
		sealStatement({
			reservation_id: reservationId,
			operation_id: operationId,
			fingerprint,
			route: ROUTE,
			admitted_at: NOW,
			expires_at: null,
			expected,
		}),
		bookedStatement(reservationId),
	].join("\n");
}

function liveUnits(reservationId, persistTo) {
	return (
		selectRows(
			`SELECT dimension_key, units FROM quota_reservation_units WHERE reservation_id = ${lit(reservationId)};`,
			persistTo,
		) ?? []
	);
}

function bookedUnits(dimensionKey, persistTo, periodKey = PERIOD_KEY) {
	const rows = selectRows(
		`SELECT booked_units FROM quota_booked_usage WHERE dimension_key = ${lit(dimensionKey)} AND period_key = ${lit(periodKey)};`,
		persistTo,
	);
	if (!rows || rows.length === 0) return null;
	return Number(rows[0].booked_units);
}

function unitRowCount(reservationId, persistTo) {
	const rows = selectRows(
		`SELECT COUNT(*) AS units FROM quota_reservation_units WHERE reservation_id = ${lit(reservationId)};`,
		persistTo,
	);
	return Number(rows?.[0]?.units ?? -1);
}

function headerRowCount(reservationId, persistTo) {
	const rows = selectRows(
		`SELECT COUNT(*) AS n FROM quota_reservations WHERE reservation_id = ${lit(reservationId)};`,
		persistTo,
	);
	return Number(rows?.[0]?.n ?? -1);
}

function entry(key, units, periodKind = "billing_cycle") {
	return { dimension_key: key, period_key: PERIOD_KEY, period_kind: periodKind, units };
}

function baselineStatements(usedByKey = {}) {
	const statements = [];
	for (const dimension of QUOTA_DIMENSIONS) {
		if (!dimension.provable || dimension.threshold_95 === null) continue;
		const used = usedByKey[dimension.key] ?? 0;
		statements.push(
			`INSERT INTO quota_period_baselines (dimension_key, period_key, state, used, unobserved_upper_bound, source, source_version, as_of, coverage_end, recorded_at) VALUES (${[
				lit(dimension.key),
				lit(PERIOD_KEY),
				lit("VERIFIED"),
				lit(used),
				lit(0),
				lit("local-check"),
				lit("local-check@1"),
				lit(NOW),
				lit(NOW),
				lit(NOW),
			].join(", ")});`,
		);
	}
	return statements.join("\n");
}

function catalogStatements() {
	return QUOTA_DIMENSIONS.map(
		(dimension) =>
			`INSERT INTO quota_dimension_catalog (dimension_key, unit, period_kind, included, threshold_95, provable, catalog_version, recorded_at) VALUES (${[
				lit(dimension.key),
				lit(dimension.unit),
				lit(dimension.period),
				dimension.included === null ? "NULL" : lit(dimension.included),
				dimension.threshold_95 === null ? "NULL" : lit(dimension.threshold_95),
				lit(dimension.provable ? 1 : 0),
				lit(QUOTA_CATALOG_VERSION),
				lit(NOW),
			].join(", ")});`,
	).join("\n");
}

const checks = [];
function check(name, condition, detail) {
	checks.push({ name, pass: Boolean(condition), detail });
	if (!condition) console.error(`✖ ${name}: ${detail}`);
	else console.log(`✔ ${name}`);
}

const persistTo = mkdtempSync(join(tmpdir(), "quota-d1-local-"));
console.log(`local D1 persist dir: ${persistTo}`);

// 1. Apply the real migration chain.
for (const migration of MIGRATIONS) {
	const applied = applyMigrationFile(migration, persistTo);
	check(
		`${migration.split(/[\\/]/).pop()} applies on a fresh local D1`,
		applied.ok,
		applied.ok ? "" : applied.output.trim().slice(0, 400),
	);
}

// Seed: catalog + verified anchor + zero-usage baselines for every provable dimension.
const seed = run(
	[
		`INSERT INTO quota_account_periods (account_id, period_start, period_end, anchor_kind, source, source_version, verified_at, recorded_at) VALUES (${[
			lit(ACCOUNT),
			lit(PERIOD.period_start),
			lit(PERIOD.period_end),
			lit("subscription_renewal"),
			lit("local-check"),
			lit("local-check@1"),
			lit(PERIOD.period_start),
			lit(NOW),
		].join(", ")});`,
		catalogStatements(),
		baselineStatements(),
	].join("\n"),
	persistTo,
);
check(
	"catalog, anchor and VERIFIED baselines seed",
	seed.ok,
	seed.ok ? "" : seed.output.trim().slice(0, 400),
);

// 2. A request that fits is admitted with one row per dimension plus the seal,
//    and the booking statement books exactly the admitted units.
const fits = run(
	admissionBatch(
		"res-fit",
		"op-fit-local",
		[entry("d1.rows_read", 1000), entry("r2.class_a", 2)],
		2,
	),
	persistTo,
);
check(
	"guard + seal admit a request inside the 95% ceiling",
	fits.ok,
	fits.ok ? "" : fits.output.trim().slice(0, 300),
);
const fitRows = selectRows(
	`SELECT COUNT(*) AS units FROM quota_reservation_units WHERE reservation_id = 'res-fit';`,
	persistTo,
);
const fitSeal = selectRows(
	`SELECT expected, applied FROM quota_reservations WHERE reservation_id = 'res-fit';`,
	persistTo,
);
check(
	"two unit rows and one seal row exist for the admitted reservation",
	fitRows?.[0]?.units === 2 && fitSeal?.[0]?.expected === fitSeal?.[0]?.applied,
	JSON.stringify({ fitRows, fitSeal }),
);
check(
	"the admission books exactly the admitted units (cumulative accumulator)",
	bookedUnits("d1.rows_read", persistTo) === 1000 && bookedUnits("r2.class_a", persistTo) === 2,
	JSON.stringify({
		d1_rows_read: bookedUnits("d1.rows_read", persistTo),
		r2_class_a: bookedUnits("r2.class_a", persistTo),
	}),
);

// 2b. Re-running the same reservation batch must fail and must not double-book.
const replayBatch = run(
	admissionBatch(
		"res-fit",
		"op-fit-local",
		[entry("d1.rows_read", 1000), entry("r2.class_a", 2)],
		2,
	),
	persistTo,
);
check(
	"re-running a committed reservation batch is refused (no second booking)",
	!replayBatch.ok &&
		bookedUnits("d1.rows_read", persistTo) === 1000 &&
		bookedUnits("r2.class_a", persistTo) === 2,
	JSON.stringify({
		ok: replayBatch.ok,
		d1_rows_read: bookedUnits("d1.rows_read", persistTo),
		r2_class_a: bookedUnits("r2.class_a", persistTo),
	}),
);

// 3. The step past the ceiling is denied and leaves nothing behind.
const over = run(
	[
		guardStatement([entry("r2.class_a", 950_000)], "res-over"),
		sealStatement({
			reservation_id: "res-over",
			operation_id: "op-over-local",
			fingerprint: "b".repeat(32),
			route: ROUTE,
			admitted_at: NOW,
			expires_at: null,
			expected: 1,
		}),
		bookedStatement("res-over"),
	].join("\n"),
	persistTo,
);
check(
	"a request past the 95% ceiling is rolled back entirely",
	unitRowCount("res-over", persistTo) === 0,
	JSON.stringify({
		error: over.ok ? null : over.output.trim().slice(0, 200),
		rows: unitRowCount("res-over", persistTo),
	}),
);

// 4. S1 repair: two settled cycles must keep constraining the ceiling.
const settleCycle = (reservationId, operationId, units) => {
	const fingerprint = "e".repeat(32);
	const admitted = run(
		admissionBatch(reservationId, operationId, [entry("r2.class_a", units)], 1, fingerprint),
		persistTo,
	);
	if (!admitted.ok) return { admitted: false, detail: admitted.output.trim().slice(0, 200) };
	const observed = liveUnits(reservationId, persistTo).map((row) => ({
		dimension_key: row.dimension_key,
		units: Number(row.units),
	}));
	const settled = run(
		settleStatements(reservationId, operationId, observed, fingerprint),
		persistTo,
	);
	return {
		admitted: true,
		settled: settled.ok,
		detail: settled.ok ? "" : settled.output.slice(0, 200),
	};
};
const cycleOne = settleCycle("res-seq-1", "op-seq-1", 400_000);
const cycleTwo = settleCycle("res-seq-2", "op-seq-2", 400_000);
const bookedAfterTwo = bookedUnits("r2.class_a", persistTo);
const cycleThree = run(
	admissionBatch("res-seq-3", "op-seq-3", [entry("r2.class_a", 400_000)], 1),
	persistTo,
);
check(
	"two settled 400k cycles are admitted and settled",
	cycleOne.admitted && cycleOne.settled && cycleTwo.admitted && cycleTwo.settled,
	JSON.stringify({ cycleOne, cycleTwo }),
);
check(
	"settlement does not decrement the booked accumulator (800k booked, no live rows)",
	bookedAfterTwo === 800_002 && liveUnits("res-seq-2", persistTo).length === 0,
	JSON.stringify({ booked: bookedAfterTwo, live: liveUnits("res-seq-2", persistTo).length }),
);
check(
	"the third 400k admit is DENIED after the first two settled (S1: live-row guard would admit it)",
	unitRowCount("res-seq-3", persistTo) === 0 && bookedUnits("r2.class_a", persistTo) === 800_002,
	JSON.stringify({
		error: cycleThree.ok ? null : cycleThree.output.trim().slice(0, 200),
		rows: unitRowCount("res-seq-3", persistTo),
		booked: bookedUnits("r2.class_a", persistTo),
	}),
);

// 4b. Red/green on the same real engine: the PRE-REPAIR predicate (live reserved
//     rows only, `SUM(u.units)`) still admits the third 400k — this is the S1
//     escape the repaired guard closes.  The pre-fix statement is reconstructed
//     here (it was never committed, so there is no VCS copy); the authoritative
//     red evidence is the unit test run recorded in work-REPAIR-S1.md.
const legacyGuard = `WITH req(dimension_key, period_key, period_kind, units) AS (VALUES (${[
	lit("r2.class_a"),
	lit(PERIOD_KEY),
	lit("billing_cycle"),
	lit(400_000),
].join(", ")}))
INSERT INTO quota_reservation_units (reservation_id, dimension_key, period_key, units, state)
SELECT 'res-seq-3-legacy', r.dimension_key, r.period_key, r.units, 'ADMITTED'
FROM req r
WHERE (SELECT COUNT(DISTINCT dimension_key) FROM req) = (SELECT COUNT(*) FROM req)
	AND EXISTS (
		SELECT 1 FROM quota_dimension_catalog c
		WHERE c.dimension_key = r.dimension_key AND c.provable = 1
			AND c.threshold_95 IS NOT NULL AND c.period_kind = r.period_kind
			AND c.catalog_version = ${lit(QUOTA_CATALOG_VERSION)}
	)
	AND EXISTS (
		SELECT 1 FROM quota_period_baselines b
		WHERE b.dimension_key = r.dimension_key AND b.period_key = r.period_key
			AND b.state = 'VERIFIED'
	)
	AND COALESCE((
			SELECT SUM(u.units) FROM quota_reservation_units u
			WHERE u.dimension_key = r.dimension_key AND u.period_key = r.period_key
				AND u.state = 'ADMITTED'
		), 0)
		+ (
			SELECT b.used + b.unobserved_upper_bound FROM quota_period_baselines b
			WHERE b.dimension_key = r.dimension_key AND b.period_key = r.period_key
		)
		+ r.units <= (
			SELECT c.threshold_95 FROM quota_dimension_catalog c
			WHERE c.dimension_key = r.dimension_key
		);`;
const legacyEscape = run(legacyGuard, persistTo);
const legacyRows = unitRowCount("res-seq-3-legacy", persistTo);
check(
	"red/green: the pre-repair live-row predicate still admits the third 400k (S1 escape reproduced)",
	legacyEscape.ok && legacyRows === 1,
	JSON.stringify({ ok: legacyEscape.ok, rows: legacyRows }),
);
run(`DELETE FROM quota_reservation_units WHERE reservation_id = 'res-seq-3-legacy';`, persistTo);

// 5. All-or-nothing: a seal that expects more rows than the guard inserted aborts
//    the batch and leaves no booking behind.
const mismatch = run(
	[
		guardStatement([entry("d1.rows_written", 5)], "res-mismatch"),
		sealStatement({
			reservation_id: "res-mismatch",
			operation_id: "op-mismatch-local",
			fingerprint: "c".repeat(32),
			route: ROUTE,
			admitted_at: NOW,
			expires_at: null,
			expected: 3,
		}),
		bookedStatement("res-mismatch"),
	].join("\n"),
	persistTo,
);
check(
	"a seal whose applied count does not match aborts the batch (no partial reservation)",
	!mismatch.ok && unitRowCount("res-mismatch", persistTo) === 0,
	JSON.stringify({
		ok: mismatch.ok,
		rows: unitRowCount("res-mismatch", persistTo),
		output: mismatch.ok ? null : mismatch.output.trim().slice(0, 200),
	}),
);
check(
	"the aborted batch leaves no booking behind",
	bookedUnits("d1.rows_written", persistTo) === null,
	JSON.stringify({ booked: bookedUnits("d1.rows_written", persistTo) }),
);

// 6. A booking write failure aborts the whole admission (fail closed).
const bookingDown = run(
	`CREATE TRIGGER booking_unavailable BEFORE INSERT ON quota_booked_usage BEGIN SELECT RAISE(ABORT, 'booked ledger unavailable'); END;`,
	persistTo,
);
const failedBooking = run(
	admissionBatch("res-bookfail", "op-bookfail-local", [entry("kv.reads", 1)], 1),
	persistTo,
);
run(`DROP TRIGGER booking_unavailable;`, persistTo);
check(
	"a failed booking write rolls back the guard rows and the seal (fail closed)",
	bookingDown.ok &&
		!failedBooking.ok &&
		unitRowCount("res-bookfail", persistTo) === 0 &&
		headerRowCount("res-bookfail", persistTo) === 0 &&
		bookedUnits("kv.reads", persistTo) === null,
	JSON.stringify({
		error: failedBooking.ok ? null : failedBooking.output.trim().slice(0, 200),
		units: unitRowCount("res-bookfail", persistTo),
		headers: headerRowCount("res-bookfail", persistTo),
	}),
);

// 7. The accumulator rejects an overflow write (safe-integer CHECK).
const overflowAttempt = run(
	`UPDATE quota_booked_usage SET booked_units = 9007199254740992 WHERE dimension_key = 'r2.class_a';`,
	persistTo,
);
check(
	"an overflow write to booked_units is rejected by the CHECK constraint",
	!overflowAttempt.ok && bookedUnits("r2.class_a", persistTo) === 800_002,
	JSON.stringify({
		ok: overflowAttempt.ok,
		booked: bookedUnits("r2.class_a", persistTo),
		output: overflowAttempt.ok ? null : overflowAttempt.output.trim().slice(0, 160),
	}),
);

// 8. The scan cap refuses further reservations for a saturated dimension/period.
const filler = [];
for (let index = 0; index < QUOTA_GUARD_SCAN_CAP; index += 1) {
	filler.push(
		`INSERT INTO quota_reservation_units (reservation_id, dimension_key, period_key, units, state) VALUES ('filler-${index}', 'r2.class_b', ${lit(PERIOD_KEY)}, 0, 'ADMITTED');`,
	);
}
const filled = run(filler.join("\n"), persistTo);
check(
	"scan-cap filler rows insert",
	filled.ok,
	filled.ok ? "" : filled.output.trim().slice(0, 200),
);
const capped = run(
	[
		guardStatement([entry("r2.class_b", 0)], "res-cap"),
		sealStatement({
			reservation_id: "res-cap",
			operation_id: "op-cap-local",
			fingerprint: "d".repeat(32),
			route: ROUTE,
			admitted_at: NOW,
			expires_at: null,
			expected: 1,
		}),
		bookedStatement("res-cap"),
	].join("\n"),
	persistTo,
);
check(
	"the per-dimension scan cap blocks the reservation instead of widening the read bound",
	unitRowCount("res-cap", persistTo) === 0,
	JSON.stringify({ ok: capped.ok, rows: unitRowCount("res-cap", persistTo) }),
);

// 8b. Access-path evidence for the guard's own read bound.  The per-dimension
//     `COUNT(*)` is charged the whole live-table cap in the declaration, and
//     `INDEXED BY` additionally pins the plan to the (dimension_key, period_key)
//     index, which is what makes the 256-row per-period invariant a real scan
//     bound rather than a planner assumption.  D1 bills scanned rows.
const guardPlan = selectRows(
	`EXPLAIN QUERY PLAN ${renderWithLiterals(buildGuardSql(2), guardParameterValues({ reservation_id: "plan-probe", entries: [entry("d1.rows_read", 0), entry("r2.class_a", 0)].map((item) => ({ ...item, baseline_cutoff: new Date(Date.parse(NOW) - 26 * 60 * 60 * 1000).toISOString() })), catalog_version: QUOTA_CATALOG_VERSION, scan_cap: QUOTA_GUARD_SCAN_CAP, live_cap: 4096, now: NOW }))};`,
	persistTo,
);
const guardPlanDetails = (guardPlan ?? []).map((row) => String(row.detail ?? ""));
check(
	"EXPLAIN QUERY PLAN shows the guard's live-row count using the guard index",
	guardPlanDetails.some((detail) => /quota_reservation_units_guard/.test(detail)),
	JSON.stringify(guardPlanDetails.slice(0, 6)),
);
const bookKeepPlan = selectRows(
	`EXPLAIN QUERY PLAN ${renderWithLiterals(buildBookedSql(), bookedParameterValues({ reservation_id: "plan-probe", booked_at: NOW }))};`,
	persistTo,
);
const bookedPlanDetails = (bookKeepPlan ?? []).map((row) => String(row.detail ?? ""));
check(
	"EXPLAIN QUERY PLAN shows the booking reading the reservation's own unit rows by primary key",
	bookedPlanDetails.some((detail) => /quota_reservation_units/.test(detail)),
	JSON.stringify(bookedPlanDetails.slice(0, 6)),
);

// 9. Migration 0018 backfills live rows that predate it (`live <= booked` across an upgrade).
const backfillPersist = mkdtempSync(join(tmpdir(), "quota-d1-backfill-"));
const olderSchema = applyMigrationFile(MIGRATIONS[0], backfillPersist);
const backfillSeed = run(
	[
		`INSERT INTO quota_account_periods (account_id, period_start, period_end, anchor_kind, source, source_version, verified_at, recorded_at) VALUES (${[
			lit(ACCOUNT),
			lit(PERIOD.period_start),
			lit(PERIOD.period_end),
			lit("subscription_renewal"),
			lit("local-check"),
			lit("local-check@1"),
			lit(PERIOD.period_start),
			lit(NOW),
		].join(", ")});`,
		catalogStatements(),
		baselineStatements(),
	].join("\n"),
	backfillPersist,
);
// The pre-0018 guard did not read the accumulator, so the legacy state is seeded
// as the raw rows it would have written (the new guard cannot even parse against
// a 0017-only schema — which is itself the reason the backfill must exist).
const legacyAdmission = run(
	[
		`INSERT INTO quota_reservations (reservation_id, operation_id, fingerprint, route, state, admitted_at, expires_at, expected, applied) VALUES (${[
			lit("res-legacy"),
			lit("op-legacy-local"),
			lit("f".repeat(32)),
			lit(ROUTE),
			lit("ADMITTED"),
			lit(NOW),
			"NULL",
			lit(1),
			lit(1),
		].join(", ")});`,
		`INSERT INTO quota_reservation_units (reservation_id, dimension_key, period_key, units, state) VALUES (${[
			lit("res-legacy"),
			lit("r2.class_a"),
			lit(PERIOD_KEY),
			lit(1234),
			lit("ADMITTED"),
		].join(", ")});`,
	].join("\n"),
	backfillPersist,
);
const applied0018 = applyMigrationFile(MIGRATIONS[1], backfillPersist);
check(
	"0018 backfills the live units that predate the accumulator (migration-order safety)",
	olderSchema.ok &&
		backfillSeed.ok &&
		legacyAdmission.ok &&
		applied0018.ok &&
		bookedUnits("r2.class_a", backfillPersist) === 1234,
	JSON.stringify({
		legacyAdmission: legacyAdmission.ok,
		migration: applied0018.ok,
		booked: bookedUnits("r2.class_a", backfillPersist),
		output: applied0018.ok ? null : applied0018.output.trim().slice(0, 200),
	}),
);

// 10. Migration safety: a 0017 database that already settled reservations cannot be
//     initialized by 0018 (its settled spend is not reconstructable), so 0018 must
//     refuse instead of silently dropping it.
const unsafePersist = mkdtempSync(join(tmpdir(), "quota-d1-unsafe-"));
const unsafeSchema = applyMigrationFile(MIGRATIONS[0], unsafePersist);
const unsafeHistory = run(
	[
		`INSERT INTO quota_reservations (reservation_id, operation_id, fingerprint, route, state, admitted_at, expires_at, expected, applied) VALUES (${[
			lit("res-settled"),
			lit("op-settled-local"),
			lit("e".repeat(32)),
			lit(ROUTE),
			lit("ADMITTED"),
			lit(NOW),
			"NULL",
			lit(1),
			lit(1),
		].join(", ")});`,
		`INSERT INTO quota_reservation_journal (reservation_id, operation_id, fingerprint, route, outcome, outcome_reason, expected_units_json, observed_units_json, recorded_at) VALUES (${[
			lit("res-settled"),
			lit("op-settled-local"),
			lit("e".repeat(32)),
			lit(ROUTE),
			lit("SETTLED"),
			lit("pre-0018 settlement"),
			lit('[{"dimension_key":"r2.class_a","units":400000}]'),
			lit('[{"dimension_key":"r2.class_a","units":400000}]'),
			lit(NOW),
		].join(", ")});`,
	].join("\n"),
	unsafePersist,
);
const refused0018 = run(readFileSync(MIGRATIONS[1], "utf8"), unsafePersist);
// A refused migration may roll the whole file back (no table) or leave an empty
// accumulator; both are acceptable, a booked row is not.
const unsafeTable = selectRows(
	`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'quota_booked_usage';`,
	unsafePersist,
);
const unsafeBookedRows =
	(unsafeTable?.length ?? 0) === 0
		? 0
		: Number(
				selectRows(`SELECT COUNT(*) AS n FROM quota_booked_usage;`, unsafePersist)?.[0]
					?.n ?? -1,
			);
check(
	"0018 refuses a 0017 database with settled history (no silent loss of settled spend)",
	unsafeSchema.ok &&
		unsafeHistory.ok &&
		!refused0018.ok &&
		/quota_0018_requires_no_settled_history/.test(refused0018.output) &&
		unsafeBookedRows === 0,
	JSON.stringify({
		schema_applied: unsafeSchema.ok,
		history_seeded: unsafeHistory.ok,
		migration_refused: !refused0018.ok,
		booked_rows: unsafeBookedRows,
		schema_output: unsafeSchema.ok ? null : unsafeSchema.output.trim().slice(0, 200),
		history_output: unsafeHistory.ok ? null : unsafeHistory.output.trim().slice(0, 200),
		refusal_output: refused0018.output.trim().slice(0, 200),
	}),
);

const failed = checks.filter((entry) => !entry.pass);
console.log(
	JSON.stringify(
		{
			checks: checks.length,
			failed: failed.length,
			catalog_version: QUOTA_CATALOG_VERSION,
			persist_dir: persistTo,
			backfill_persist_dir: backfillPersist,
			unsafe_persist_dir: unsafePersist,
			authority: "local-only; this run cannot prove account usage",
		},
		null,
		2,
	),
);
process.exit(failed.length === 0 ? 0 : 1);
