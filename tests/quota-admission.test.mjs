/**
 * Legacy quota-ledger surface tests (post gate-removal, 2026-10-02).
 *
 * The admission/settlement machinery is gone: no request path reserves,
 * settles or releases any more, and `BASELINE_COVERAGE_AGE_MS` (the 26h
 * baseline hard timeout) is abolished.  What is tested here:
 *   - the D1 shim guarantees the legacy tests were built on (CTE writes apply
 *     exactly once; first() binds columns);
 *   - the retained read-only tables' schema guarantees (migrations 0017/0018
 *     are NEVER edited; old tables stay read-only);
 *   - the operator-record surface (recordAccountPeriod / recordBaseline /
 *     syncDimensionCatalog) the 12h official-meter reconcile writes through;
 *   - the redesigned `quotaStatus` semantics: a dimension is CLOSED only after
 *     a real 95% threshold breach -- a missing, stale or unverified baseline
 *     NEVER forces CLOSED (the pre-2026-10-02 suicide path).
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	QUOTA_DIMENSIONS,
	recordAccountPeriod,
	recordBaseline,
	quotaStatus,
	readBookedUsage,
	syncDimensionCatalog,
} from "../src/quota-breaker.ts";
import { createResearchWorkflowDb } from "./helpers/d1-sqlite-shim.mjs";

const ACCOUNT = "test-account";
const PERIOD = {
	period_start: "2026-09-14T00:00:00.000Z",
	period_end: "2026-10-14T00:00:00.000Z",
};
const PERIOD_KEY = `cycle:${PERIOD.period_start}..${PERIOD.period_end}`;
const NOW = new Date("2026-09-20T00:00:00.000Z");
/** Mirrors the CHECK in migration 0018 (old tables are never edited). */
const MAX_BOOKED_UNITS = 9_007_199_254_740_991;

test("the D1 shim executes a CTE write exactly once", async () => {
	// migrate 0017/0018 build the settle batch from CTE statements
	// ("WITH obs(...) AS ... DELETE ..."); a shim that ran the statement twice
	// (or classified a CTE write as a read) would double-apply them.
	const db = createResearchWorkflowDb();
	await db.prepare("CREATE TABLE shim_cte (id INTEGER PRIMARY KEY)").run();
	await db.prepare("INSERT INTO shim_cte(id) VALUES (1)").run();
	await db.prepare("INSERT INTO shim_cte(id) VALUES (2)").run();
	await db
		.prepare("WITH obs(x) AS (VALUES (1)) DELETE FROM shim_cte WHERE id IN (SELECT x FROM obs)")
		.run();
	const left = await db.prepare("SELECT COUNT(*) AS n FROM shim_cte").first();
	assert.equal(Number(left.n), 1, "a CTE write must apply exactly once");
	const first = await db.prepare("SELECT id FROM shim_cte").first();
	assert.equal(Number(first.id), 2, "first() returns the row, not a projection");
});

test("the D1 shim binds first() column parameters and executes run() exactly once", async () => {
	const db = createResearchWorkflowDb();
	const selected = await db.prepare("SELECT ? AS selected_value").bind("bound-value").first();
	assert.equal(selected.selected_value, "bound-value");

	await db.prepare("CREATE TABLE shim_once (value TEXT NOT NULL)").run();
	await db.prepare("INSERT INTO shim_once(value) VALUES (?)").bind("one-write").run();
	const count = await db.prepare("SELECT COUNT(*) AS n FROM shim_once").first();
	assert.equal(Number(count.n), 1, "run() must not repeat a bound write");
});

// ---------------------------------------------------------------------------
// Operator-record surface (12h official-meter reconcile writes through these)
// ---------------------------------------------------------------------------

async function seed(db, { anchor = true } = {}) {
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
}

test("recordAccountPeriod upserts the verified renewal anchor by account id", async () => {
	const db = createResearchWorkflowDb();
	await seed(db);
	const row = await db
		.prepare("SELECT account_id, period_start, anchor_kind FROM quota_account_periods")
		.first();
	assert.equal(row.account_id, ACCOUNT);
	assert.equal(row.period_start, PERIOD.period_start);
	assert.equal(row.anchor_kind, "subscription_renewal");
	// A re-registration replaces the row (ON CONFLICT update), never duplicates.
	await recordAccountPeriod(db, {
		account_id: ACCOUNT,
		...PERIOD,
		anchor_kind: "subscription_renewal",
		source: "operator-2026-10",
		source_version: "billing-portal@2026-10",
		verified_at: PERIOD.period_start,
	});
	const count = await db.prepare("SELECT COUNT(*) AS n FROM quota_account_periods").first();
	assert.equal(Number(count.n), 1);
});

test("recordBaseline upserts one row per (dimension, period) with its state", async () => {
	const db = createResearchWorkflowDb();
	await seed(db);
	await recordBaseline(db, {
		dimension_key: "r2.class_a",
		period_key: PERIOD_KEY,
		state: "VERIFIED",
		used: 1_000,
		unobserved_upper_bound: 50,
		source: "cloudflare-graphql",
		source_version: "meter@1",
		as_of: NOW.toISOString(),
		coverage_end: NOW.toISOString(),
	});
	await recordBaseline(db, {
		dimension_key: "r2.class_a",
		period_key: PERIOD_KEY,
		state: "VERIFIED",
		used: 2_000,
		unobserved_upper_bound: 0,
		source: "cloudflare-graphql",
		source_version: "meter@2",
		as_of: NOW.toISOString(),
		coverage_end: NOW.toISOString(),
	});
	const rows = await db.prepare("SELECT * FROM quota_period_baselines").all();
	assert.equal(rows.results.length, 1, "upsert, never duplicate");
	assert.equal(Number(rows.results[0].used), 2_000);
	assert.equal(rows.results[0].source_version, "meter@2");
});

test("syncDimensionCatalog copies the code catalog so readers see the exact ceilings", async () => {
	const db = createResearchWorkflowDb();
	await seed(db);
	const rows = await db
		.prepare("SELECT dimension_key, threshold_95, catalog_version FROM quota_dimension_catalog")
		.all();
	assert.equal(rows.results.length, QUOTA_DIMENSIONS.length);
	const byKey = new Map(rows.results.map((row) => [row.dimension_key, row]));
	assert.equal(String(byKey.get("d1.rows_read").threshold_95), "23750000000");
});

// ---------------------------------------------------------------------------
// quotaStatus: CLOSED only after a real 95% breach (never on a missing baseline)
// ---------------------------------------------------------------------------

test("a missing baseline is informational and NEVER forces CLOSED", async () => {
	const db = createResearchWorkflowDb();
	await seed(db);
	const status = await quotaStatus(db, { account_id: ACCOUNT, now: NOW });
	assert.equal(status.anchor_verified, true);
	const entry = status.dimensions.find((row) => row.dimension_key === "r2.class_a");
	assert.equal(entry.period_key, PERIOD_KEY);
	assert.equal(entry.used, null, "no baseline row exists");
	assert.equal(entry.state, "OPEN", "absence of a baseline must not close a dimension");
	assert.match(entry.reason, /informational only/);
});

test("without a verified anchor the period is UNKNOWN, never a UTC calendar month", async () => {
	const db = createResearchWorkflowDb();
	await seed(db, { anchor: false });
	const status = await quotaStatus(db, { account_id: ACCOUNT, now: NOW });
	assert.equal(status.anchor_verified, false);
	assert.equal(status.period, null);
	const entry = status.dimensions.find((row) => row.dimension_key === "r2.class_a");
	assert.equal(entry.state, "UNKNOWN");
	assert.equal(entry.period_key, null);
});

test("a verified baseline with headroom is OPEN", async () => {
	const db = createResearchWorkflowDb();
	await seed(db);
	await recordBaseline(db, {
		dimension_key: "r2.class_a",
		period_key: PERIOD_KEY,
		state: "VERIFIED",
		used: 400_000,
		unobserved_upper_bound: 10_000,
		source: "cloudflare-graphql",
		source_version: "meter@1",
		as_of: NOW.toISOString(),
		coverage_end: NOW.toISOString(),
	});
	const status = await quotaStatus(db, { account_id: ACCOUNT, now: NOW });
	const entry = status.dimensions.find((row) => row.dimension_key === "r2.class_a");
	assert.equal(entry.state, "OPEN");
	assert.equal(entry.used, 400_000);
});

test("CLOSED means a real 95% threshold breach (baseline used + booked), nothing else", async () => {
	const db = createResearchWorkflowDb();
	await seed(db);
	// threshold_95(r2.class_a) = 950_000.  Baseline alone stays under.
	await recordBaseline(db, {
		dimension_key: "r2.class_a",
		period_key: PERIOD_KEY,
		state: "VERIFIED",
		used: 900_000,
		unobserved_upper_bound: 0,
		source: "cloudflare-graphql",
		source_version: "meter@1",
		as_of: NOW.toISOString(),
		coverage_end: NOW.toISOString(),
	});
	await db
		.prepare(
			`INSERT INTO quota_booked_usage
			 (dimension_key, period_key, booked_units, booked_reservations, first_booked_at, last_booked_at, updated_at)
			 VALUES ('r2.class_a', ?, 49_999, 1, ?, ?, ?)`,
		)
		.bind(PERIOD_KEY, NOW.toISOString(), NOW.toISOString(), NOW.toISOString())
		.run();
	const before = await quotaStatus(db, { account_id: ACCOUNT, now: NOW });
	const entryBefore = before.dimensions.find((row) => row.dimension_key === "r2.class_a");
	assert.equal(entryBefore.state, "OPEN", "949_999 total is one under the line");
	// Historical legacy spend is retained (old tables stay read-only, values kept).
	assert.equal(await readBookedUsage(db, "r2.class_a", PERIOD_KEY), 50_000 - 1);

	// Touching the line closes the dimension: "touching the 95% red line" is the
	// breaker condition, matching the pre-removal `< threshold` admission rule.
	await db
		.prepare(
			"UPDATE quota_booked_usage SET booked_units = booked_units + 1 WHERE dimension_key = 'r2.class_a'",
		)
		.run();
	const after = await quotaStatus(db, { account_id: ACCOUNT, now: NOW });
	const entryAfter = after.dimensions.find((row) => row.dimension_key === "r2.class_a");
	assert.equal(entryAfter.state, "CLOSED");
	assert.match(entryAfter.reason, /95% threshold/);
});

test("an UNVERIFIED baseline row is reported informationally and does not close the dimension", async () => {
	const db = createResearchWorkflowDb();
	await seed(db);
	await recordBaseline(db, {
		dimension_key: "d1.rows_read",
		period_key: PERIOD_KEY,
		state: "STALE",
		used: 100,
		unobserved_upper_bound: 0,
		source: "cloudflare-graphql",
		source_version: "meter@0",
		as_of: NOW.toISOString(),
		coverage_end: NOW.toISOString(),
	});
	const status = await quotaStatus(db, { account_id: ACCOUNT, now: NOW });
	const entry = status.dimensions.find((row) => row.dimension_key === "d1.rows_read");
	assert.equal(entry.state, "OPEN");
	assert.match(entry.reason, /baseline state is STALE/);
});

test("quota status reports the retained booked bound and the historical reservation count", async () => {
	const db = createResearchWorkflowDb();
	await seed(db);
	// Seed the legacy tables the way the removed ledger left them.
	await db
		.prepare(
			`INSERT INTO quota_reservation_units (reservation_id, dimension_key, period_key, units, state)
			 VALUES ('res-legacy', 'r2.class_a', ?, 1234, 'ADMITTED')`,
		)
		.bind(PERIOD_KEY)
		.run();
	await db
		.prepare(
			`INSERT INTO quota_booked_usage
			 (dimension_key, period_key, booked_units, booked_reservations, first_booked_at, last_booked_at, updated_at)
			 VALUES ('r2.class_a', ?, 900_000, 1, ?, ?, ?)`,
		)
		.bind(PERIOD_KEY, NOW.toISOString(), NOW.toISOString(), NOW.toISOString())
		.run();
	const status = await quotaStatus(db, { account_id: ACCOUNT, now: NOW });
	const entry = status.dimensions.find((row) => row.dimension_key === "r2.class_a");
	assert.equal(entry.booked, 900_000);
	assert.equal(entry.reserved, 1234, "the historical live rows are still visible");
	assert.equal(status.live_reservations, 1);
	assert.equal(status.legacy_prototype, "disabled");
});

// ---------------------------------------------------------------------------
// Retained tables: the accumulator CHECK and migration guarantees never change
// ---------------------------------------------------------------------------

test("a missing booked row is absent (not zero), and the accumulator CHECK rejects corruption", async () => {
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
