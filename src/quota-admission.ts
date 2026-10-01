/**
 * Legacy quota-ledger read and operator-record surface.
 *
 * The front admission gate was removed on 2026-10-02 (quota redesign, spec
 * section 1.1): no request path reserves, settles or releases anything any more,
 * and `BASELINE_COVERAGE_AGE_MS` (the 26h baseline hard timeout whose absence
 * used to force dimensions CLOSED) is abolished.  The legacy D1 tables
 * (`quota_account_periods`, `quota_period_baselines`, `quota_dimension_catalog`,
 * `quota_reservations`, `quota_reservation_units`, `quota_reservation_journal`,
 * `quota_booked_usage`) are retained read-only; the 12-hour official-meter
 * reconcile writes verified baselines through `recordBaseline` below.
 *
 * What remains here:
 *   - `recordAccountPeriod` / `recordBaseline` / `syncDimensionCatalog`:
 *     operator and reconcile writes for the legacy tables;
 *   - `quotaStatus` / `readBookedUsage`: read-only projections for the
 *     `get_gateway_status` diagnostics face.
 *
 * Status semantics after the redesign: a dimension is CLOSED only when real
 * committed usage (baseline used + unobserved tail + booked) has actually
 * reached the 95% threshold.  A missing, stale or unverified baseline is
 * reported informationally and NEVER forces CLOSED.
 */

import {
	type DimensionKey,
	QUOTA_CATALOG_VERSION,
	QUOTA_DIMENSIONS,
	type AccountPeriodAnchor,
	type ResolvedPeriod,
	dimensionSpec,
	resolvePeriod,
} from "./quota-dimensions.ts";

export type RawQuotaDb = Pick<D1Database, "prepare" | "batch">;

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

// ---------------------------------------------------------------------------
// Operator-side records
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

/** Register one dimension baseline (reconcile writes VERIFIED rows here). */
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

/** Copy the code catalog into D1 so status readers see the exact ceilings. */
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
	/**
	 * OPEN = committed usage is under the 95% threshold; CLOSED = committed usage
	 * actually reached the threshold; UNKNOWN = the period cannot be resolved.
	 * A missing or unverified baseline never forces CLOSED (2026-10-02 redesign).
	 */
	readonly state: "OPEN" | "CLOSED" | "UNKNOWN";
	readonly period_key: string | null;
	readonly used: number | null;
	readonly unobserved_upper_bound: number | null;
	readonly reserved: number | null;
	/**
	 * Cumulative booked units of the legacy ledger for this period (historical
	 * data only; nothing books new units since the gate removal).
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
 * Read the cumulative booked bound for one (dimension, period).  One row by
 * primary key; `null` (no row) means zero historical bookings.
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
		const period: ResolvedPeriod | null = resolvePeriod(specification, { anchor, now });
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
`SELECT state, used, unobserved_upper_bound FROM quota_period_baselines
				 WHERE dimension_key = ? AND period_key = ?`,
			)
			.bind(dimension.key, period.period_key)
			.first<{ state: string; used: number; unobserved_upper_bound: number }>()
			.catch(() => null);
		const reserved = await db
			.prepare(
				`SELECT COALESCE(SUM(units), 0) AS reserved FROM quota_reservation_units
				 WHERE dimension_key = ? AND period_key = ?`,
			)
			.bind(dimension.key, period.period_key)
			.first<{ reserved: number }>()
			.catch(() => null);
		const booked = await readBookedUsage(db, dimension.key, period.period_key).catch(
			() => null,
		);
		// Real committed usage only.  A missing baseline row contributes zero --
		// it never fabricates a CLOSED state (the pre-2026-10-02 suicide path).
		const committed =
			Number(row?.used ?? 0) + Number(row?.unobserved_upper_bound ?? 0) + Number(booked ?? 0);
		const threshold = Number(specification.threshold_95);
		const breached = Number.isFinite(threshold) && threshold > 0 && committed >= threshold;
		dimensions.push({
			dimension_key: dimension.key,
			state: breached ? "CLOSED" : "OPEN",
			period_key: period.period_key,
			used: row ? Number(row.used) : null,
			unobserved_upper_bound: row ? Number(row.unobserved_upper_bound) : null,
			reserved: reserved ? Number(reserved.reserved) : null,
			booked,
			threshold_95: specification.threshold_95,
			reason: breached
				? "committed usage reached the 95% threshold (baseline plus booked)"
				: row
					? `baseline state is ${row.state}; informational only since the gate removal`
					: "no baseline row yet; informational only since the gate removal",
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
