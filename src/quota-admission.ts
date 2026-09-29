/**
 * Atomic multi-dimension admission ledger (spec §"准入、原子性、异步和恢复合同").
 *
 * Admission is three statements in one D1 `batch()`:
 *
 *   1. a single conditional `INSERT .. SELECT` over a `VALUES` request list whose
 *      WHERE clause requires, for EVERY requested dimension, a current catalog
 *      row (`provable = 1`), a VERIFIED baseline for the exact period, and
 *      `booked + used + unobserved_upper_bound + units <= floor(0.95*included)`;
 *   2. a seal row whose `applied` column is `COUNT(*)` of what statement 1 really
 *      inserted, with `CHECK (applied = expected)` on the table;
 *   3. the cumulative booking of exactly the rows statement 1 inserted into
 *      `quota_booked_usage` (one row per dimension and period).
 *
 * Real local D1 (workerd) proved the atomicity this depends on: a failing
 * statement in `batch()` rolls the batch back, and the computed-count CHECK
 * aborts the batch — so a partially admitted reservation can never commit, and a
 * failed batch never leaves a booking behind. A 20-way concurrent probe admitted
 * exactly 10 of 20 requests at a 1000-unit ceiling with no over-admit.
 *
 * ## Why the guard reads a cumulative booking and not the live rows (S1)
 *
 * Settlement moves a reservation's live unit rows into
 * `quota_reservation_journal`, which the guard never reads.  While the ceiling
 * was computed from live rows only, every settled operation released its spend,
 * so repeated `admit -> settle` cycles could pass the 95% ceiling between two
 * account snapshots (the guard degraded into a concurrency limiter).  Admission
 * therefore books the admitted amount into `quota_booked_usage` inside the same
 * transaction, and the inequality uses that cumulative bound:
 *
 *   `booked(dimension, period) >= sum of every admitted unit in that period`,
 *   monotonic within the period, released only by a period rollover.
 *
 * The period key is the natural one (`cycle:<anchor start>..<anchor end>` from an
 * operator-verified renewal anchor, `utc-day:<date>` for Workers AI), and a
 * rollover is only admissible once a VERIFIED baseline exists for the new key, so
 * a new period is never opened by simply "forgetting" the old spend.
 *
 * Double counting is deliberate (spec §2 "不确定时保留双计作保守拒绝"): the
 * provider baseline may already include booked amounts, and no proof exists that
 * a given snapshot accounted for a given reservation, so `used` and `booked` are
 * both counted.  The error direction is earlier refusal, never a false "safe".
 *
 * Fail-closed rules implemented here:
 *   - no verified account period anchor  -> billing-cycle dimensions DENIED;
 *   - no VERIFIED baseline row           -> DENIED (never treated as zero);
 *   - dimension not provable / storage semantics unproven -> DENIED;
 *   - ledger IO error, missing booking table or unknown failure -> DENIED
 *     (fault) with NO side effect and NO booking;
 *   - unknown asynchronous outcome       -> the reservation is KEPT (settle only
 *     with observed actuals, release only with an explicit no-call proof).
 *
 * The guard accounts for its own cost: `withLedgerSelfCost()` adds the rows this
 * transaction itself reads and writes to the same request before the guard runs.
 */

import {
	type DimensionKey,
	QUOTA_CATALOG_VERSION,
	QUOTA_DIMENSIONS,
	type AccountPeriodAnchor,
	type ResolvedPeriod,
	dimensionSpec,
	isDimensionKey,
	resolvePeriod,
} from "./quota-dimensions.ts";

export type RawQuotaDb = Pick<D1Database, "prepare" | "batch">;

/** Maximum dimensions a single operation may reserve. */
export const MAX_DIMENSIONS_PER_ADMISSION = 8;
/**
 * Per (dimension, period) live reservation cap.  This is what bounds the guard's
 * per-dimension `COUNT(*)`: the statement refuses to insert when the period is
 * already at the cap, so no guard subquery can ever scan more than this many
 * live rows for one dimension.
 */
export const QUOTA_GUARD_SCAN_CAP = 256;
/** Global live reservation-unit cap, for the same bounded-read reason. */
export const QUOTA_LIVE_UNITS_CAP = 4096;
/**
 * Largest value the booked accumulator may hold.  The migration carries the same
 * bound as a CHECK, so a corrupt or hostile write cannot wrap the monotonic
 * accumulator into a value that would look like headroom.  In practice the guard
 * keeps `booked` under the `threshold_95` of its dimension.
 */
export const MAX_BOOKED_UNITS = 9_007_199_254_740_991;

/**
 * How long a provider coverage watermark may keep admitting new work, **per
 * period kind**.  This window does NOT weaken the 95% invariant: every unit this
 * guard admits is booked into `quota_booked_usage` and charged against the
 * baseline inside the same atomic transaction, so the window only bounds
 * off-ledger drift (console actions, other workers on the account).  The values
 * match the evidence cadence of the sources an operator registers from:
 * monthly-cycle dimensions come from the daily Billable Usage feed (≤1 day lag
 * plus a 2h buffer), and the official GraphQL analytics used for daily products
 * has sub-hour granularity.
 */
const BASELINE_COVERAGE_AGE_MS: Record<string, number> = {
	billing_cycle: 26 * 60 * 60 * 1000,
	storage_integral: 26 * 60 * 60 * 1000,
	utc_day: 2 * 60 * 60 * 1000,
};

export function baselineCoverageAgeMs(periodKind: string): number {
	return BASELINE_COVERAGE_AGE_MS[periodKind] ?? 0;
}

/**
 * Conservative off-ledger headroom for the runtime-bootstrapped UTC-day
 * baseline (ai.neurons): console playground calls and any non-Collector worker
 * on the account are invisible to the ledger, so the daily budget admits at
 * most 9,500 - 500 booked neurons for ledger traffic.
 */
export const UTC_DAY_OFF_LEDGER_HEADROOM = 200;

function baselineCutoffFor(periodKind: string, now: Date): string {
	return new Date(now.getTime() - baselineCoverageAgeMs(periodKind)).toISOString();
}

/**
 * Reserved rows written by one admission: one unit row per dimension, the seal
 * row, one booked-usage row per dimension, plus the prepaid allowance for the
 * single settle-or-release this admission will eventually need (I5).
 *
 * Residual (deliberately not claimed): this counts the rows the statements write
 * to the four tables; any index-maintenance write amplification the platform
 * charges on top of them is not separately bounded here.
 */
export function ledgerSelfWrites(dimensionCount: number): number {
	return dimensionCount * 2 + 1 + ledgerLifecycleWrites();
}

/**
 * Prepaid allowance for the ledger lifecycle that follows an admission — one
 * settle or one release: the reservation's unit rows read back
 * (<= MAX_DIMENSIONS_PER_ADMISSION), its header row, the post-settle live count
 * (<= MAX_DIMENSIONS_PER_ADMISSION) and the journal/receipt probes.
 *
 * The production call graph performs exactly one settle OR one release per
 * admitted reservation (`settleObserved` / the release path in `src/index.ts`).
 * A caller that retries a REJECTED settle pays its own way outside this
 * allowance; that residual is reported, not claimed (I5 retry caveat).
 */
export function ledgerLifecycleReads(): number {
	return MAX_DIMENSIONS_PER_ADMISSION * 2 + 2;
}
export function ledgerLifecycleWrites(): number {
	return MAX_DIMENSIONS_PER_ADMISSION + 2;
}

/**
 * Reserved rows read by one admission.  Provable upper bound, not a measurement:
 *
 *   - 3 pre-reads outside the batch (live reservation by operation id, journal
 *     receipt by operation id, account period anchor by account id), one row each;
 *   - per requested dimension: catalog row (1), baseline row (1), booked row (1,
 *     primary-key lookup), the per-(dimension, period) live-row `COUNT(*)` and the
 *     global live-row `COUNT(*)`.  Both counts are charged
 *     `QUOTA_LIVE_UNITS_CAP` rows per dimension: D1 bills **scanned** rows, and
 *     `EXPLAIN QUERY PLAN` (asserted by `scripts/quota_d1_local_check.mjs`) shows
 *     the per-dimension count uses the `quota_reservation_units_guard` index —
 *     `INDEXED BY` pins that plan, so the real scan is the matching rows
 *     (<= QUOTA_GUARD_SCAN_CAP by the invariant this same statement enforces).
 *     The declaration deliberately does not depend on the planner: were the plan to
 *     change to another access path, the scan bound would be the whole live table,
 *     which `QUOTA_LIVE_UNITS_CAP` still covers.  The uncorrelated global count is
 *     charged per candidate row for the same reason (a scalar subquery is only
 *     guaranteed to be evaluated once per candidate row, not once per statement);
 *   - the two statements that re-read this reservation's own unit rows (the seal
 *     count and the booking source), <= MAX_DIMENSIONS_PER_ADMISSION rows each;
 *   - the prepaid settle-or-release allowance below.
 *
 * Historical note (audit I3): the previous formula `1 + n*(2+256)` declared 1033
 * reads for a four-dimension ingest while the guard really issues the two
 * `COUNT(*)` scans above (worst case ~6152).  The formula now charges both scans at
 * the full live-table bound and adds the lifecycle: 4 dimensions -> 33825 rows.
 */
export function ledgerSelfReads(dimensionCount: number): number {
	return (
		3 +
		dimensionCount * (3 + QUOTA_GUARD_SCAN_CAP + QUOTA_LIVE_UNITS_CAP * 2) +
		ledgerLifecycleReads()
	);
}

export interface AdmissionDimension {
	readonly dimension_key: DimensionKey;
	/** Non-negative integer in the dimension's admission unit. */
	readonly units: number;
}

export interface AdmissionRequest {
	/** Server-owned logical operation id; a client-supplied id is never trusted. */
	readonly operation_id: string;
	/** Immutable cost fingerprint of the operation (same id + different params is a conflict). */
	readonly fingerprint: string;
	/** Catalog route key (see `quota-entrypoints.ts`). */
	readonly route: string;
	readonly dimensions: readonly AdmissionDimension[];
}

export type AdmissionDenialReason =
	| "limit"
	| "baseline"
	| "bound"
	| "storage"
	| "fault"
	| "conflict";

export type AdmissionResult =
	| {
			readonly status: "ADMITTED";
			readonly reservation_id: string;
			readonly admitted_at: string;
			/** Informational only: reservations are never released by timeout. */
			readonly expires_at: string | null;
			readonly reserved: readonly AdmissionDimension[];
			readonly self_cost: readonly AdmissionDimension[];
	  }
	| {
			readonly status: "DENIED";
			readonly reason: AdmissionDenialReason;
			readonly dimension_key: DimensionKey | null;
			readonly detail: string;
			readonly request_id: string;
	  }
	| {
			/** The same operation id + fingerprint already completed; do NOT re-execute. */
			readonly status: "REPLAY";
			readonly reservation_id: string;
			readonly outcome: "SETTLED" | "RELEASED";
			readonly recorded_at: string;
	  };

function requestId(): string {
	return crypto.randomUUID().replaceAll("-", "");
}

function denied(
	reason: AdmissionDenialReason,
	dimensionKey: DimensionKey | null,
	detail: string,
): AdmissionResult {
	return {
		status: "DENIED",
		reason,
		dimension_key: dimensionKey,
		detail,
		request_id: requestId(),
	};
}

const KEY_PATTERN = /^[a-z0-9][a-z0-9._:/-]{0,191}$/;

function validIdentifier(value: string, pattern: RegExp): boolean {
	return typeof value === "string" && pattern.test(value);
}

/** Merge duplicate dimension keys by summing units; the guard then sees each dim once. */
export function mergeDimensions(dimensions: readonly AdmissionDimension[]): AdmissionDimension[] {
	const merged = new Map<DimensionKey, number>();
	for (const dimension of dimensions) {
		merged.set(
			dimension.dimension_key,
			(merged.get(dimension.dimension_key) ?? 0) + dimension.units,
		);
	}
	return [...merged.entries()].map(([dimension_key, units]) => ({ dimension_key, units }));
}

/**
 * Add the ledger's own cost to a request so the guard reserves it before the
 * transaction performs it.  Idempotent: callers may pass an already extended set.
 */
export function withLedgerSelfCost(
	dimensions: readonly AdmissionDimension[],
): AdmissionDimension[] {
	const merged = mergeDimensions(dimensions);
	const finalDimensionCount = new Set([
		...merged.map((dimension) => dimension.dimension_key),
		"d1.rows_read",
		"d1.rows_written",
	]).size;
	const selfWrites = ledgerSelfWrites(finalDimensionCount);
	const selfReads = ledgerSelfReads(finalDimensionCount);
	return mergeDimensions([
		...merged,
		{ dimension_key: "d1.rows_written", units: selfWrites },
		{ dimension_key: "d1.rows_read", units: selfReads },
	]);
}

// ---------------------------------------------------------------------------
// SQL builders (exported for tests and for the local real-D1 check script)
// ---------------------------------------------------------------------------

function valuesRows(dimensions: readonly AdmissionDimension[], firstParam: number): string {
	return dimensions
		.map((_, index) => {
			const base = firstParam + index * 5;
			return `(?${base}, ?${base + 1}, ?${base + 2}, ?${base + 3}, ?${base + 4})`;
		})
		.join(", ");
}

/**
 * The conditional multi-dimension reservation insert (statement 1 of the batch).
 *
 * The ceiling term is the cumulative `quota_booked_usage` row for the dimension
 * and period — a primary-key lookup, so the guard's cost does not grow with the
 * number of settled operations — plus the verified baseline's own
 * `used + unobserved_upper_bound`.  Live rows are still counted for the row caps
 * (bounded reads), never for the spend.
 */
export function buildGuardSql(dimensionCount: number): string {
	const values = valuesRows(
		Array.from(
			{ length: dimensionCount },
			() => ({ dimension_key: "d1.rows_read", units: 0, baseline_cutoff: "" }),
		),
		2,
	);
	const rid = "?1";
	return `WITH req(dimension_key, period_key, period_kind, units, baseline_cutoff) AS (VALUES ${values})
INSERT INTO quota_reservation_units (reservation_id, dimension_key, period_key, units, state)
SELECT ${rid}, r.dimension_key, r.period_key, r.units, 'ADMITTED'
FROM req r
WHERE (SELECT COUNT(DISTINCT dimension_key) FROM req) = (SELECT COUNT(*) FROM req)
	AND EXISTS (
		SELECT 1 FROM quota_dimension_catalog c
		WHERE c.dimension_key = r.dimension_key
			AND c.provable = 1
			AND c.threshold_95 IS NOT NULL
			AND c.period_kind = r.period_kind
			AND c.catalog_version = ?${2 + dimensionCount * 5}
	)
	AND EXISTS (
		SELECT 1 FROM quota_period_baselines b
		WHERE b.dimension_key = r.dimension_key
			AND b.period_key = r.period_key
				AND b.state = 'VERIFIED'
				AND b.coverage_end BETWEEN r.baseline_cutoff AND ?${5 + dimensionCount * 5}
				AND b.as_of BETWEEN b.coverage_end AND ?${5 + dimensionCount * 5}
		)
		AND COALESCE((
			SELECT bu.booked_units FROM quota_booked_usage bu
			WHERE bu.dimension_key = r.dimension_key
				AND bu.period_key = r.period_key
		), 0)
		+ (
			SELECT b.used + b.unobserved_upper_bound FROM quota_period_baselines b
			WHERE b.dimension_key = r.dimension_key AND b.period_key = r.period_key
		)
		+ r.units <= (
			SELECT c.threshold_95 FROM quota_dimension_catalog c
			WHERE c.dimension_key = r.dimension_key
		)
	AND (
		SELECT COUNT(*) FROM quota_reservation_units AS u INDEXED BY quota_reservation_units_guard
		WHERE u.dimension_key = r.dimension_key AND u.period_key = r.period_key
	) + 1 <= ?${3 + dimensionCount * 5}
	AND (
		SELECT COUNT(*) FROM quota_reservation_units
	) + (SELECT COUNT(*) FROM req) <= ?${4 + dimensionCount * 5}`;
}

export interface GuardParams {
	readonly reservation_id: string;
	readonly entries: readonly {
		dimension_key: string;
		period_key: string;
		period_kind: string;
		units: number;
		baseline_cutoff: string;
	}[];
	readonly catalog_version: string;
	readonly scan_cap: number;
	readonly live_cap: number;
	readonly now: string;
}

export function guardParameterValues(params: GuardParams): unknown[] {
	const values: unknown[] = [params.reservation_id];
	for (const entry of params.entries) {
		values.push(
			entry.dimension_key,
			entry.period_key,
			entry.period_kind,
			entry.units,
			entry.baseline_cutoff,
		);
	}
	values.push(params.catalog_version, params.scan_cap, params.live_cap, params.now);
	return values;
}

/**
 * The seal statement (statement 2 of the batch): `expected` is the requested
 * dimension count, `applied` is computed in-database, and the table's CHECK
 * forces the whole batch to roll back when they differ.
 */
export function buildSealSql(): string {
	return `INSERT INTO quota_reservations
	(reservation_id, operation_id, fingerprint, route, state, admitted_at, expires_at, expected, applied)
SELECT ?1, ?2, ?3, ?4, 'ADMITTED', ?5, ?6, ?7,
	(SELECT COUNT(*) FROM quota_reservation_units WHERE reservation_id = ?1)`;
}

export function sealParameterValues(args: {
	reservation_id: string;
	operation_id: string;
	fingerprint: string;
	route: string;
	admitted_at: string;
	expires_at: string | null;
	expected: number;
}): unknown[] {
	return [
		args.reservation_id,
		args.operation_id,
		args.fingerprint,
		args.route,
		args.admitted_at,
		args.expires_at,
		args.expected,
	];
}

/**
 * The cumulative booking statement (statement 3 of the batch).
 *
 * It derives its increments from the unit rows statement 1 inserted for THIS
 * reservation inside the same transaction, so it books exactly what was admitted
 * (including the ledger's own self-cost dimensions) and books nothing when the
 * guard inserted nothing.  `booked_units` only ever grows, so settlement and
 * release cannot return headroom; only a period rollover starts a new row.  A
 * failure here (missing table, overflow CHECK) aborts the whole batch, so an
 * unbooked admission is impossible — the fail-closed direction.
 */
export function buildBookedSql(): string {
	return `INSERT INTO quota_booked_usage
	(dimension_key, period_key, booked_units, booked_reservations, first_booked_at, last_booked_at, updated_at)
SELECT u.dimension_key, u.period_key, SUM(u.units), COUNT(*), ?2, ?2, ?2
FROM quota_reservation_units u
WHERE u.reservation_id = ?1
GROUP BY u.dimension_key, u.period_key
ON CONFLICT(dimension_key, period_key) DO UPDATE SET
	booked_units = booked_units + excluded.booked_units,
	booked_reservations = booked_reservations + excluded.booked_reservations,
	last_booked_at = excluded.last_booked_at,
	updated_at = excluded.updated_at`;
}

export function bookedParameterValues(args: {
	reservation_id: string;
	booked_at: string;
}): unknown[] {
	return [args.reservation_id, args.booked_at];
}

/**
 * Diagnostic statement run only after a denied admission, to attribute the
 * refusal to a specific dimension and cause. Read-only and bounded by the
 * request size plus one catalog/baseline/booked row per dimension and the two
 * live-row cap scans.
 */
export function buildDiagnosisSql(dimensionCount: number): string {
	const values = valuesRows(
		Array.from(
			{ length: dimensionCount },
			() => ({ dimension_key: "d1.rows_read", units: 0, baseline_cutoff: "" }),
		),
		1,
	);
	return `WITH req(dimension_key, period_key, period_kind, units, baseline_cutoff) AS (VALUES ${values})
SELECT r.dimension_key AS dimension_key,
	CASE
		WHEN NOT EXISTS (
			SELECT 1 FROM quota_dimension_catalog c
			WHERE c.dimension_key = r.dimension_key AND c.provable = 1
				AND c.threshold_95 IS NOT NULL AND c.period_kind = r.period_kind
				AND c.catalog_version = ?${1 + dimensionCount * 5}
		) THEN 'catalog'
		WHEN NOT EXISTS (
			SELECT 1 FROM quota_period_baselines b
			WHERE b.dimension_key = r.dimension_key AND b.period_key = r.period_key
					AND b.state = 'VERIFIED'
					AND b.coverage_end BETWEEN r.baseline_cutoff AND ?${4 + dimensionCount * 5}
					AND b.as_of BETWEEN b.coverage_end AND ?${4 + dimensionCount * 5}
			) THEN 'baseline'
		WHEN COALESCE((
				SELECT bu.booked_units FROM quota_booked_usage bu
				WHERE bu.dimension_key = r.dimension_key AND bu.period_key = r.period_key
			), 0)
			+ (
				SELECT b.used + b.unobserved_upper_bound FROM quota_period_baselines b
				WHERE b.dimension_key = r.dimension_key AND b.period_key = r.period_key
			)
			+ r.units > (
				SELECT c.threshold_95 FROM quota_dimension_catalog c
				WHERE c.dimension_key = r.dimension_key
			) THEN 'limit'
		WHEN (
			SELECT COUNT(*) FROM quota_reservation_units AS u INDEXED BY quota_reservation_units_guard
			WHERE u.dimension_key = r.dimension_key AND u.period_key = r.period_key
		) + 1 > ?${2 + dimensionCount * 5} THEN 'cap'
		WHEN (
			SELECT COUNT(*) FROM quota_reservation_units
		) + (SELECT COUNT(*) FROM req) > ?${3 + dimensionCount * 5} THEN 'cap'
		ELSE 'ok'
	END AS verdict
FROM req r`;
}

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

export interface AdmissionContext {
	readonly account_id: string;
	readonly now?: Date;
	readonly catalog_version?: string;
	/** Informational reservation TTL; never used to auto-release. */
	readonly reservation_ttl_ms?: number;
}

export type AnchorRow = AccountPeriodAnchor & { readonly account_id: string };

async function readAnchor(db: RawQuotaDb, accountId: string): Promise<AnchorRow | null> {
	return db
		.prepare(
			`SELECT account_id, period_start, period_end, anchor_kind, source, source_version, verified_at
			 FROM quota_account_periods WHERE account_id = ?`,
		)
		.bind(accountId)
		.first<AnchorRow>();
}

const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{16,64}$/;

export async function admitOperation(
	db: RawQuotaDb,
	request: AdmissionRequest,
	context: AdmissionContext,
): Promise<AdmissionResult> {
	const now = context.now ?? new Date();
	const catalogVersion = context.catalog_version ?? QUOTA_CATALOG_VERSION;

	if (!validIdentifier(request.operation_id, OPERATION_ID_PATTERN)) {
		return denied("fault", null, "operation id is not a server-owned stable identifier");
	}
	if (!validIdentifier(request.fingerprint, FINGERPRINT_PATTERN)) {
		return denied("fault", null, "cost fingerprint must be a hex digest");
	}
	if (!validIdentifier(request.route, KEY_PATTERN)) {
		return denied("fault", null, "route key is invalid");
	}
	if (request.dimensions.length === 0) {
		return denied("bound", null, "operation declares no billing dimensions to reserve");
	}

	const requested = mergeDimensions(request.dimensions);
	if (requested.length > MAX_DIMENSIONS_PER_ADMISSION) {
		return denied("bound", null, "operation declares more dimensions than the admission cap");
	}
	for (const dimension of requested) {
		if (!isDimensionKey(dimension.dimension_key)) {
			return denied(
				"bound",
				dimension.dimension_key,
				"dimension is not in the billing catalog",
			);
		}
		if (!Number.isSafeInteger(dimension.units) || dimension.units < 0) {
			return denied(
				"bound",
				dimension.dimension_key,
				"reserved units must be a non-negative integer",
			);
		}
	}
	const selfCosted = withLedgerSelfCost(requested);
	if (selfCosted.length > MAX_DIMENSIONS_PER_ADMISSION) {
		return denied(
			"bound",
			null,
			"operation plus ledger self-cost exceeds the admission dimension cap",
		);
	}
	for (const dimension of selfCosted) {
		const specification = dimensionSpec(dimension.dimension_key);
		if (!specification) {
			return denied(
				"bound",
				dimension.dimension_key,
				"dimension is not in the billing catalog",
			);
		}
		if (!specification.provable) {
			return denied(
				"bound",
				dimension.dimension_key,
				"no provable per-operation upper bound exists for this dimension",
			);
		}
	}

	// Idempotency: a known operation id is never charged twice.
	try {
		const existing = await db
			.prepare(
				`SELECT reservation_id, fingerprint, state, admitted_at FROM quota_reservations WHERE operation_id = ?`,
			)
			.bind(request.operation_id)
			.first<{
				reservation_id: string;
				fingerprint: string;
				state: string;
				admitted_at: string;
			}>();
		if (existing) {
			if (existing.fingerprint !== request.fingerprint) {
				return denied(
					"conflict",
					null,
					"operation id is already reserved with a different immutable cost fingerprint",
				);
			}
			return {
				status: "ADMITTED",
				reservation_id: existing.reservation_id,
				admitted_at: existing.admitted_at,
				expires_at: null,
				reserved: requested,
				self_cost: selfCosted.filter(
					(dimension) =>
						!requested.some((entry) => entry.dimension_key === dimension.dimension_key),
				),
			};
		}
		const completed = await db
			.prepare(
				`SELECT reservation_id, outcome, recorded_at FROM quota_reservation_journal
				 WHERE operation_id = ? ORDER BY journal_id DESC LIMIT 1`,
			)
			.bind(request.operation_id)
			.first<{
				reservation_id: string;
				outcome: "SETTLED" | "RELEASED";
				recorded_at: string;
			}>();
		if (completed) {
			return {
				status: "REPLAY",
				reservation_id: completed.reservation_id,
				outcome: completed.outcome,
				recorded_at: completed.recorded_at,
			};
		}
	} catch {
		return denied("fault", null, "admission ledger is unavailable");
	}

	// Period resolution: never a UTC calendar month, never month/31.
	const anchor = await readAnchor(db, context.account_id).catch(() => null);
	const entries: Array<{
		dimension_key: string;
		period_key: string;
		period_kind: string;
		units: number;
		baseline_cutoff: string;
	}> = [];
	for (const dimension of selfCosted) {
		const specification = dimensionSpec(dimension.dimension_key)!;
		const period: ResolvedPeriod | null = resolvePeriod(specification, { anchor, now });
		if (!period) {
			return denied(
				"baseline",
				dimension.dimension_key,
				"account billing period anchor is not verified; no period key can be proven",
			);
		}
		if (
			specification.period === "storage_integral" &&
			period.period_kind !== "storage_integral"
		) {
			return denied(
				"storage",
				dimension.dimension_key,
				"storage period semantics are not proven",
			);
		}
		entries.push({
			dimension_key: dimension.dimension_key,
			period_key: period.period_key,
			period_kind: specification.period,
			units: dimension.units,
			baseline_cutoff: baselineCutoffFor(specification.period, now),
		});
	}

	// UTC-day baseline bootstrap (owner-approved daily budget admission,
	// 2026-09-30): a utc_day period is defined by the provider (00:00 UTC reset),
	// not by an operator-verified anchor, and the only AI caller on this account
	// goes through this ledger.  The deterministic daily baseline therefore
	// bootstraps itself: used = 0 (nothing off-ledger is known) plus a fixed
	// conservative headroom for drift, with the freshness watermark refreshed on
	// every admission.  Billing-cycle and storage dimensions are NOT bootstrapped.
	const bootstrappedAt = now.toISOString();
	for (const entry of entries) {
		if (entry.period_kind !== "utc_day") continue;
		await db
			.prepare(
				`INSERT INTO quota_period_baselines
				 (dimension_key, period_key, state, used, unobserved_upper_bound, source, source_version, as_of, coverage_end, recorded_at)
				 VALUES (?, ?, 'VERIFIED', 0, ?, 'runtime-bootstrap-utc-day', ?, ?, ?, ?)
				 ON CONFLICT(dimension_key, period_key) DO UPDATE SET
					as_of = excluded.as_of,
					coverage_end = excluded.coverage_end`,
			)
			.bind(
				entry.dimension_key,
				entry.period_key,
				UTC_DAY_OFF_LEDGER_HEADROOM,
				catalogVersion,
				bootstrappedAt,
				bootstrappedAt,
				bootstrappedAt,
			)
			.run();
	}

	const reservationId = crypto.randomUUID();
	const admittedAt = now.toISOString();
	const expiresAt =
		typeof context.reservation_ttl_ms === "number" &&
		Number.isFinite(context.reservation_ttl_ms)
			? new Date(now.getTime() + context.reservation_ttl_ms).toISOString()
			: null;

	try {
		await db.batch([
			db.prepare(buildGuardSql(entries.length)).bind(
				...guardParameterValues({
					reservation_id: reservationId,
					entries,
					catalog_version: catalogVersion,
						scan_cap: QUOTA_GUARD_SCAN_CAP,
						live_cap: QUOTA_LIVE_UNITS_CAP,
						now: admittedAt,

				}),
			),
			db.prepare(buildSealSql()).bind(
				...sealParameterValues({
					reservation_id: reservationId,
					operation_id: request.operation_id,
					fingerprint: request.fingerprint,
					route: request.route,
					admitted_at: admittedAt,
					expires_at: expiresAt,
					expected: entries.length,
				}),
			),
			db.prepare(buildBookedSql()).bind(
				...bookedParameterValues({
					reservation_id: reservationId,
					booked_at: admittedAt,
				}),
			),
		]);
	} catch (error) {
		return classifyAdmissionFailure(db, entries, catalogVersion, admittedAt, error);
	}

	return {
		status: "ADMITTED",
		reservation_id: reservationId,
		admitted_at: admittedAt,
		expires_at: expiresAt,
		reserved: requested,
		self_cost: selfCosted.filter(
			(dimension) =>
				!requested.some((entry) => entry.dimension_key === dimension.dimension_key),
		),
	};
}

/**
 * Attribute a failed admission batch.  A concurrent identical operation may have
 * won the unique index: that is a replay (or a fingerprint conflict), not a limit.
 */
async function classifyAdmissionFailure(
	db: RawQuotaDb,
	entries: readonly {
		dimension_key: string;
		period_key: string;
		period_kind: string;
		units: number;
		baseline_cutoff: string;
	}[],
	catalogVersion: string,
	admittedAt: string,
	error: unknown,
): Promise<AdmissionResult> {
	const message =
		error instanceof Error ? `${error.name}: ${error.message}` : "unknown admission failure";
	if (/UNIQUE constraint failed: quota_reservations\.operation_id/i.test(message)) {
		return denied("conflict", null, "operation id is already reserved by a concurrent caller");
	}
	if (!/applied = expected/i.test(message)) {
		return denied("fault", null, "admission ledger write failed");
	}
	try {
		const rows = await db
			.prepare(buildDiagnosisSql(entries.length))
			.bind(
				...entries.flatMap((entry) => [
					entry.dimension_key,
					entry.period_key,
					entry.period_kind,
					entry.units,
					entry.baseline_cutoff,
				]),
				catalogVersion,
					QUOTA_GUARD_SCAN_CAP,
					QUOTA_LIVE_UNITS_CAP,
					admittedAt,
			)
			.all<{ dimension_key: string; verdict: string }>();
		const results = rows.results ?? [];
		const offending = results.find((row) => row.verdict !== "ok");
		const verdict = offending?.verdict ?? "limit";
		const key = (offending?.dimension_key ?? null) as DimensionKey | null;
		if (verdict === "baseline") {
			return denied(
				"baseline",
				key,
				"no VERIFIED baseline exists for this dimension and period",
			);
		}
		if (verdict === "catalog") {
			return denied("bound", key, "dimension catalog row is missing, stale or not provable");
		}
		if (verdict === "cap") {
			return denied(
				"limit",
				key,
				"ledger live-row cap reached; refusing to widen the scan bound",
			);
		}
		return denied("limit", key, "95% ceiling or unobserved-tail reserve would be exceeded");
	} catch {
		// The guard proved the request inadmissible; the diagnosis is best effort.
		return denied("limit", null, "95% ceiling or unobserved-tail reserve would be exceeded");
	}
}

// ---------------------------------------------------------------------------
// Settle / release
// ---------------------------------------------------------------------------

export interface ObservedDimension {
	readonly dimension_key: DimensionKey;
	readonly units: number;
}

export type SettleResult =
	| { readonly status: "SETTLED"; readonly reservation_id: string }
	| { readonly status: "REJECTED"; readonly detail: string };

/** One bound statement: SQL plus its positional values (exported for probes/tests). */
export interface StatementSpec {
	readonly sql: string;
	readonly values: readonly unknown[];
}

/**
 * The settlement batch as executable specs: release the live rows (only when the
 * reservation still exists and every observed value is within its reserved row),
 * write the journal receipt, then drop the header.  Exported so the local D1
 * probes exercise the production statement text instead of a paraphrase.
 */
export function buildSettleStatements(args: {
	reservation_id: string;
	operation_id: string;
	fingerprint: string;
	route: string;
	reason: string;
	expected_units_json: string;
	observed_units_json: string;
	recorded_at: string;
	observed: readonly ObservedDimension[];
}): StatementSpec[] {
	const observedValues = args.observed
		.map((_, index) => `(?${2 + index * 2}, ?${3 + index * 2})`)
		.join(", ");
	return [
		{
			sql: `WITH obs(dimension_key, units) AS (VALUES ${observedValues})
					 DELETE FROM quota_reservation_units
					 WHERE reservation_id = ?1
					   AND (SELECT COUNT(*) FROM quota_reservations WHERE reservation_id = ?1) = 1
					   AND (SELECT COUNT(*) FROM obs) = (SELECT COUNT(*) FROM quota_reservation_units WHERE reservation_id = ?1)
					   AND NOT EXISTS (
							SELECT 1 FROM obs o
							LEFT JOIN quota_reservation_units u
								ON u.reservation_id = ?1 AND u.dimension_key = o.dimension_key
							WHERE u.units IS NULL OR o.units > u.units
					   )`,
			values: [
				args.reservation_id,
				...args.observed.flatMap((entry) => [entry.dimension_key, entry.units]),
			],
		},
		{
			sql: `INSERT INTO quota_reservation_journal
					 (reservation_id, operation_id, fingerprint, route, outcome, outcome_reason, expected_units_json, observed_units_json, recorded_at)
					 SELECT ?1, ?2, ?3, ?4, 'SETTLED', ?5, ?6, ?7, ?8
					 WHERE NOT EXISTS (SELECT 1 FROM quota_reservation_units WHERE reservation_id = ?1)`,
			values: [
				args.reservation_id,
				args.operation_id,
				args.fingerprint,
				args.route,
				args.reason.slice(0, 200),
				args.expected_units_json,
				args.observed_units_json,
				args.recorded_at,
			],
		},
		{
			sql: `DELETE FROM quota_reservations WHERE reservation_id = ?1
					 AND EXISTS (
						SELECT 1 FROM quota_reservation_journal j
						WHERE j.reservation_id = ?1 AND j.outcome = 'SETTLED'
					 )`,
			values: [args.reservation_id],
		},
	];
}

/** The release batch as executable specs (journal receipt, live rows, header). */
export function buildReleaseStatements(args: {
	reservation_id: string;
	operation_id: string;
	fingerprint: string;
	route: string;
	reason: string;
	expected_units_json: string;
	recorded_at: string;
}): StatementSpec[] {
	return [
		{
			sql: `INSERT INTO quota_reservation_journal
					 (reservation_id, operation_id, fingerprint, route, outcome, outcome_reason, expected_units_json, observed_units_json, recorded_at)
					 SELECT ?1, ?2, ?3, ?4, 'RELEASED', ?5, ?6, '[]', ?7
					 WHERE EXISTS (SELECT 1 FROM quota_reservations WHERE reservation_id = ?1)`,
			values: [
				args.reservation_id,
				args.operation_id,
				args.fingerprint,
				args.route,
				args.reason.slice(0, 200),
				args.expected_units_json,
				args.recorded_at,
			],
		},
		{
			sql: `DELETE FROM quota_reservation_units WHERE reservation_id = ?1
					 AND EXISTS (
						SELECT 1 FROM quota_reservation_journal j
						WHERE j.reservation_id = ?1 AND j.outcome = 'RELEASED'
					 )`,
			values: [args.reservation_id],
		},
		{
			sql: `DELETE FROM quota_reservations WHERE reservation_id = ?1
					 AND NOT EXISTS (SELECT 1 FROM quota_reservation_units WHERE reservation_id = ?1)`,
			values: [args.reservation_id],
		},
	];
}

/** Bind exported statement specs to a D1-shaped handle. */
export function prepareStatements(
	db: RawQuotaDb,
	specs: readonly StatementSpec[],
): ReturnType<RawQuotaDb["prepare"]>[] {
	return specs.map((spec) => db.prepare(spec.sql).bind(...spec.values));
}

/**
 * Settle a reservation against the platform-reported practical usage.
 *
 * Allowed only when, for every reserved dimension, an observed value exists and
 * `observed <= reserved`.  Anything else keeps the reservation (conservative:
 * over-spend must not be "fixed" by an after-the-fact write) and reports
 * REJECTED so the caller can raise an operator alert.
 *
 * Settlement frees the live unit rows but deliberately does NOT touch
 * `quota_booked_usage`: the spend of a completed operation must keep counting
 * against the 95% ceiling until the natural period rolls over (S1 repair).
 */
export async function settleReservation(
	db: RawQuotaDb,
	args: {
		reservation_id: string;
		observed: readonly ObservedDimension[];
		reason: string;
		now?: Date;
	},
): Promise<SettleResult> {
	const now = args.now ?? new Date();
	const units = await db
		.prepare(
			`SELECT dimension_key, units FROM quota_reservation_units WHERE reservation_id = ?`,
		)
		.bind(args.reservation_id)
		.all<{ dimension_key: string; units: number }>();
	const reserved = units.results ?? [];
	const rejectLog = (detail: string): void => {
		// Settlement refusals used to be swallowed by callers; name them so the
		// operator can repair the ledger (ids truncated, no secrets).
		console.log(
			JSON.stringify({
				event: "quota_settle_rejected",
				timestamp: now.toISOString(),
				reservation_id: args.reservation_id.slice(0, 8),
				detail,
			}),
		);
	};
	if (reserved.length === 0) {
		rejectLog("reservation has no live units");
		return { status: "REJECTED", detail: "reservation has no live units" };
	}
	const observedByKey = new Map(args.observed.map((entry) => [entry.dimension_key, entry.units]));
	for (const row of reserved) {
		const observed = observedByKey.get(row.dimension_key as DimensionKey);
		if (observed === undefined) {
			rejectLog(`observed usage missing for ${row.dimension_key}`);
			return {
				status: "REJECTED",
				detail: `observed usage missing for ${row.dimension_key}`,
			};
		}
		if (!Number.isSafeInteger(observed) || observed < 0 || observed > row.units) {
			rejectLog(`observed usage for ${row.dimension_key} exceeds the reservation`);
			return {
				status: "REJECTED",
				detail: `observed usage for ${row.dimension_key} exceeds the reservation`,
			};
		}
	}
	const observedJson = JSON.stringify(
		reserved.map((row) => ({
			dimension_key: row.dimension_key,
			units: observedByKey.get(row.dimension_key as DimensionKey) ?? null,
		})),
	);
	const expectedJson = JSON.stringify(
		reserved.map((row) => ({ dimension_key: row.dimension_key, units: row.units })),
	);
	const reservation = await db
		.prepare(
			`SELECT operation_id, fingerprint, route FROM quota_reservations WHERE reservation_id = ?`,
		)
		.bind(args.reservation_id)
		.first<{ operation_id: string; fingerprint: string; route: string }>();
	if (!reservation) {
		rejectLog("reservation is not live");
		return { status: "REJECTED", detail: "reservation is not live" };
	}

	try {
		await db.batch(
			prepareStatements(
				db,
				buildSettleStatements({
					reservation_id: args.reservation_id,
					operation_id: reservation.operation_id,
					fingerprint: reservation.fingerprint,
					route: reservation.route,
					reason: args.reason,
					expected_units_json: expectedJson,
					observed_units_json: observedJson,
					recorded_at: now.toISOString(),
					observed: args.observed,
				}),
			),
		);
	} catch (error) {
		rejectLog(
			`settlement transaction failed: ${error instanceof Error ? error.message : String(error)}`.slice(
				0,
				280,
			),
		);
		return { status: "REJECTED", detail: "settlement transaction failed; reservation kept" };
	}
	const remaining = await db
		.prepare(`SELECT COUNT(*) AS live FROM quota_reservation_units WHERE reservation_id = ?`)
		.bind(args.reservation_id)
		.first<{ live: number }>();
	if (Number(remaining?.live ?? 1) !== 0) {
		rejectLog("settlement did not clear every reserved unit");
		return { status: "REJECTED", detail: "settlement did not clear every reserved unit" };
	}
	return { status: "SETTLED", reservation_id: args.reservation_id };
}

export type ReleaseResult =
	| { readonly status: "RELEASED"; readonly reservation_id: string }
	| { readonly status: "REJECTED"; readonly detail: string };

/**
 * Release a reservation early.  Only permitted with an explicit proof that the
 * provider call was never sent (`provider_call_not_sent`); an unknown
 * asynchronous outcome must stay reserved.
 *
 * Like settlement, a release frees the live rows but never decrements the booked
 * accumulator: the booking is an upper bound of what the operation *could* have
 * cost, and a no-call proof is not a proof that the account snapshot ignored it,
 * so the conservative direction (keep it booked until the period rolls) applies.
 */
export async function releaseReservation(
	db: RawQuotaDb,
	args: {
		reservation_id: string;
		proof: "provider_call_not_sent" | "observed_zero_by_provider";
		reason: string;
		now?: Date;
	},
): Promise<ReleaseResult> {
	if (args.proof !== "provider_call_not_sent") {
		return {
			status: "REJECTED",
			detail: "only a proven no-call outcome may release a reservation before settlement",
		};
	}
	const now = args.now ?? new Date();
	const reservation = await db
		.prepare(
			`SELECT operation_id, fingerprint, route FROM quota_reservations WHERE reservation_id = ?`,
		)
		.bind(args.reservation_id)
		.first<{ operation_id: string; fingerprint: string; route: string }>();
	if (!reservation) return { status: "REJECTED", detail: "reservation is not live" };
	const units = await db
		.prepare(
			`SELECT dimension_key, units FROM quota_reservation_units WHERE reservation_id = ?`,
		)
		.bind(args.reservation_id)
		.all<{ dimension_key: string; units: number }>();
	const expectedJson = JSON.stringify(units.results ?? []);
	try {
		await db.batch(
			prepareStatements(
				db,
				buildReleaseStatements({
					reservation_id: args.reservation_id,
					operation_id: reservation.operation_id,
					fingerprint: reservation.fingerprint,
					route: reservation.route,
					reason: args.reason,
					expected_units_json: expectedJson,
					recorded_at: now.toISOString(),
				}),
			),
		);
	} catch {
		return { status: "REJECTED", detail: "release transaction failed; reservation kept" };
	}
	return { status: "RELEASED", reservation_id: args.reservation_id };
}

// ---------------------------------------------------------------------------
// Operator-side records + status
// ---------------------------------------------------------------------------

/** Register/replace the verified account billing period anchor. */
export async function recordAccountPeriod(
	db: RawQuotaDb,
	anchor: {
		account_id: string;
		period_start: string;
		period_end: string;
		anchor_kind: "subscription_renewal" | "unknown";
		source: string;
		source_version: string;
		verified_at: string;
	},
	now = new Date(),
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO quota_account_periods
			 (account_id, period_start, period_end, anchor_kind, source, source_version, verified_at, recorded_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(account_id) DO UPDATE SET
				period_start = excluded.period_start,
				period_end = excluded.period_end,
				anchor_kind = excluded.anchor_kind,
				source = excluded.source,
				source_version = excluded.source_version,
				verified_at = excluded.verified_at,
				recorded_at = excluded.recorded_at`,
		)
		.bind(
			anchor.account_id,
			anchor.period_start,
			anchor.period_end,
			anchor.anchor_kind,
			anchor.source,
			anchor.source_version,
			anchor.verified_at,
			now.toISOString(),
		)
		.run();
}

/** Register one dimension baseline.  Only VERIFIED rows can admit work. */
export async function recordBaseline(
	db: RawQuotaDb,
	observation: {
		dimension_key: DimensionKey;
		period_key: string;
		state: "VERIFIED" | "UNVERIFIED" | "STALE" | "DENIED" | "INCOMPLETE";
		used: number;
		unobserved_upper_bound: number;
		source: string;
		source_version: string;
		as_of: string;
		coverage_end: string | null;
	},
	now = new Date(),
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO quota_period_baselines
			 (dimension_key, period_key, state, used, unobserved_upper_bound, source, source_version, as_of, coverage_end, recorded_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(dimension_key, period_key) DO UPDATE SET
				state = excluded.state,
				used = excluded.used,
				unobserved_upper_bound = excluded.unobserved_upper_bound,
				source = excluded.source,
				source_version = excluded.source_version,
				as_of = excluded.as_of,
				coverage_end = excluded.coverage_end,
				recorded_at = excluded.recorded_at`,
		)
		.bind(
			observation.dimension_key,
			observation.period_key,
			observation.state,
			observation.used,
			observation.unobserved_upper_bound,
			observation.source,
			observation.source_version,
			observation.as_of,
			observation.coverage_end,
			now.toISOString(),
		)
		.run();
}

/** Copy the code catalog into D1 so the guard can reject stale/edited ceilings. */
export async function syncDimensionCatalog(
	db: RawQuotaDb,
	dimensions: readonly {
		key: string;
		unit: string;
		period: string;
		included: number | null;
		threshold_95: number | null;
		provable: boolean;
	}[],
	catalogVersion = QUOTA_CATALOG_VERSION,
	now = new Date(),
): Promise<void> {
	const statements = dimensions.map((dimension) =>
		db
			.prepare(
				`INSERT INTO quota_dimension_catalog
				 (dimension_key, unit, period_kind, included, threshold_95, provable, catalog_version, recorded_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(dimension_key) DO UPDATE SET
					unit = excluded.unit,
					period_kind = excluded.period_kind,
					included = excluded.included,
					threshold_95 = excluded.threshold_95,
					provable = excluded.provable,
					catalog_version = excluded.catalog_version,
					recorded_at = excluded.recorded_at`,
			)
			.bind(
				dimension.key,
				dimension.unit,
				dimension.period,
				dimension.included,
				dimension.threshold_95,
				dimension.provable ? 1 : 0,
				catalogVersion,
				now.toISOString(),
			),
	);
	if (statements.length > 0) await db.batch(statements);
}

export interface DimensionStatus {
	readonly dimension_key: string;
	/** OPEN = verified headroom; CLOSED = no verified baseline; UNKNOWN = cannot prove. */
	readonly state: "OPEN" | "CLOSED" | "UNKNOWN";
	readonly period_key: string | null;
	readonly used: number | null;
	readonly unobserved_upper_bound: number | null;
	/** Live (not yet settled) reserved units. */
	readonly reserved: number | null;
	/**
	 * Cumulative booked units for this period: every admission since the period
	 * started, including operations that have already settled.  The provider
	 * baseline may already contain part of it, so headroom is computed from
	 * `used + unobserved_upper_bound + booked`, never from `reserved` alone.
	 */
	readonly booked: number | null;
	readonly threshold_95: number | null;
	readonly reason: string;
}

export interface QuotaStatus {
	readonly account_id: string;
	readonly catalog_version: string;
	readonly period: { period_start: string; period_end: string } | null;
	readonly anchor_verified: boolean;
	readonly live_reservations: number;
	readonly dimensions: readonly DimensionStatus[];
	/** The legacy day/31 prototype must never be presented as a 95% guarantee. */
	readonly legacy_prototype: "disabled";
}

/**
 * Read the cumulative booked upper bound for one (dimension, period).  One row by
 * primary key; `null` (no row yet) means zero bookings in a period that has not
 * seen an admission — never a missing baseline, which the guard treats
 * separately and always as a denial when absent.
 */
export async function readBookedUsage(
	db: RawQuotaDb,
	dimensionKey: string,
	periodKey: string,
): Promise<number | null> {
	const row = await db
		.prepare(
			`SELECT booked_units FROM quota_booked_usage WHERE dimension_key = ? AND period_key = ?`,
		)
		.bind(dimensionKey, periodKey)
		.first<{ booked_units: number }>();
	return row ? Number(row.booked_units) : null;
}

export async function quotaStatus(
	db: RawQuotaDb,
	context: {
		account_id: string;
		now?: Date;
		dimensions?: readonly {
			key: string;
			unit: string;
			period: string;
			included: number | null;
			threshold_95: number | null;
			provable: boolean;
		}[];
	},
): Promise<QuotaStatus> {
	const now = context.now ?? new Date();
	const catalog = context.dimensions ?? QUOTA_DIMENSIONS;
	const statusAt = now.toISOString();
	const cutoffFor = (periodKind: string): string => baselineCutoffFor(periodKind, now);
	const anchor = await readAnchor(db, context.account_id).catch(() => null);
	const anchorVerified = Boolean(
		resolvePeriod(dimensionSpec("d1.rows_read")!, { anchor, now }),
	);
	const liveRow = await db
		.prepare(`SELECT COUNT(DISTINCT reservation_id) AS live FROM quota_reservation_units`)
		.first<{ live: number }>()
		.catch(() => null);
	const dimensions: DimensionStatus[] = [];
	for (const dimension of catalog) {
		const specification = dimensionSpec(dimension.key);
		if (!specification) {
			dimensions.push({
				dimension_key: dimension.key,
				state: "UNKNOWN",
				period_key: null,
				used: null,
				unobserved_upper_bound: null,
				reserved: null,
				booked: null,
				threshold_95: null,
				reason: "dimension is not in the billing catalog",
			});
			continue;
		}
		const period = resolvePeriod(specification, { anchor, now });
		if (!period) {
			dimensions.push({
				dimension_key: dimension.key,
				state: "UNKNOWN",
				period_key: null,
				used: null,
				unobserved_upper_bound: null,
				reserved: null,
				booked: null,
				threshold_95: specification.threshold_95,
				reason: "account billing period anchor is not verified",
			});
			continue;
		}
		const row = await db
			.prepare(
`SELECT state, used, unobserved_upper_bound, as_of, coverage_end FROM quota_period_baselines
					 WHERE dimension_key = ? AND period_key = ?`,
			)
			.bind(dimension.key, period.period_key)
			.first<{ state: string; used: number; unobserved_upper_bound: number; as_of: string; coverage_end: string | null }>()
			.catch(() => null);
		const reserved = await db
			.prepare(
				`SELECT COALESCE(SUM(units), 0) AS reserved FROM quota_reservation_units
					 WHERE dimension_key = ? AND period_key = ?`,
			)
			.bind(dimension.key, period.period_key)
			.first<{ reserved: number }>()
			.catch(() => null);
		// The cumulative booking is what the guard actually spends against: it
		// covers settled operations too, so it is reported next to (and can exceed)
		// the live reservation total.
		const booked = await readBookedUsage(db, dimension.key, period.period_key).catch(
			() => null,
		);
		const committed =
			Number(row?.used ?? 0) + Number(row?.unobserved_upper_bound ?? 0) + Number(booked ?? 0);
			const baselineFresh = Boolean(
				row?.coverage_end &&
					row.coverage_end >= cutoffFor(specification.period) &&
					row.coverage_end <= statusAt &&
					row.as_of >= row.coverage_end &&
					row.as_of <= statusAt,
			);
			const baselineReason =
				row && row.state === "VERIFIED"
					? !baselineFresh
						? "baseline coverage is missing, stale or future-dated"
						: committed >= Number(specification.threshold_95)
							? "verified headroom exhausted (baseline plus booked)"
							: "verified baseline with headroom"
					: `baseline state is ${row ? row.state : "missing"}`;
		dimensions.push({
			dimension_key: dimension.key,
			state:
				row &&
					row.state === "VERIFIED" &&
					baselineFresh &&
					specification.provable &&
				committed < Number(specification.threshold_95)
					? "OPEN"
					: "CLOSED",
			period_key: period.period_key,
			used: row ? Number(row.used) : null,
			unobserved_upper_bound: row ? Number(row.unobserved_upper_bound) : null,
			reserved: reserved ? Number(reserved.reserved) : null,
			booked,
			threshold_95: specification.threshold_95,
			reason:
				row && row.state === "VERIFIED" && !specification.provable
					? "dimension has no provable per-operation bound"
					: baselineReason,
		});
	}
	return {
		account_id: context.account_id,
		catalog_version: QUOTA_CATALOG_VERSION,
		period: anchor
			? { period_start: anchor.period_start, period_end: anchor.period_end }
			: null,
		anchor_verified: anchorVerified,
		live_reservations: Number(liveRow?.live ?? 0),
		dimensions,
		legacy_prototype: "disabled",
	};
}
