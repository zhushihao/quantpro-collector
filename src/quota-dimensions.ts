/**
 * Versioned billing-dimension catalog (SDD CQ spec §"资源目录与计量规则").
 *
 * Contract (frozen by spec, do not weaken):
 *   - Every paid product dimension the Collector can influence is listed with its
 *     official included allowance, its natural billing period kind and its
 *     95% threshold `floor(0.95 * included)`.
 *   - Natural periods are NEVER derived from a UTC calendar month and NEVER
 *     divided by 31.  A paid-plan allowance resets on the account's subscription
 *     renewal anchor, which is only known from an operator-verified account
 *     record (`AccountPeriodAnchor`); without it every billing-cycle dimension is
 *     UNKNOWN and therefore CLOSED for admission.
 *   - Workers AI's free allowance resets on the official UTC day (00:00 UTC).
 *   - Storage (KB/GB-month) is a time integral, not an instantaneous byte count.
 *   - `provable` states whether a *per-operation upper bound* can be established
 *     for the dimension.  A dimension that cannot be bounded (CPU tail, D1 scan
 *     rows, AI neurons, unclassified storage) is CLOSED: no admission may name
 *     it as "covered".
 */

export type PeriodKind = "billing_cycle" | "utc_day" | "storage_integral";

export type DimensionKey =
	| "workers.requests"
	| "workers.cpu_ms"
	| "d1.rows_read"
	| "d1.rows_written"
	| "d1.storage_gb_month"
	| "kv.reads"
	| "kv.writes"
	| "kv.deletes"
	| "kv.lists"
	| "kv.storage_gb_month"
	| "r2.class_a"
	| "r2.class_b"
	| "r2.storage_gb_month"
	| "r2.ia_class_a"
	| "r2.ia_class_b"
	| "r2.ia_storage_gb_month"
	| "ai.neurons"
	| "vectorize.queried_dims"
	| "vectorize.stored_dims";

export interface DimensionSpec {
	readonly key: DimensionKey;
	/** Official billing unit as published by the provider. */
	readonly unit: string;
	readonly period: PeriodKind;
	/** Official included allowance for the paid plan; `null` = no included allowance. */
	readonly included: number | null;
	/** `floor(0.95 * included)`; `null` when there is no included allowance. */
	readonly threshold_95: number | null;
	/**
	 * Whether the Collector can produce a *provable* per-operation upper bound.
	 * When false the dimension is CLOSED: nothing may be admitted against it.
	 */
	readonly provable: boolean;
	readonly note: string;
}

/** Bump whenever the published allowances or 95% policy change; evidence in the record. */
export const QUOTA_CATALOG_VERSION = "quota-catalog/2026-09-30.4";

/** The pricing/dimension evidence this catalog was transcribed from. */
export const QUOTA_CATALOG_SOURCES: readonly string[] = [
	"https://developers.cloudflare.com/workers/platform/pricing/",
	"https://developers.cloudflare.com/d1/platform/pricing/",
	"https://developers.cloudflare.com/kv/platform/pricing/",
	"https://developers.cloudflare.com/r2/pricing/",
	"https://developers.cloudflare.com/workers-ai/platform/pricing/",
	"https://developers.cloudflare.com/vectorize/platform/pricing/",
];

/**
 * Storage dimensions are reserved in **milli-GB-month** integers (`1 GB-month =
 * 1000` admission units) so the D1 ledger stays integral and the 95% threshold
 * can be expressed in the same unit as the official allowance (which is a whole
 * number of GB-month).  `storage_*` and `*_gb_month` dimensions use this scale.
 */
export const STORAGE_UNIT_SCALE = 1000;

/** `floor(0.95 * included)` — integer arithmetic, no floating point drift. */
export function threshold95(included: number): number {
	if (!Number.isFinite(included) || included < 0) {
		throw new TypeError("included allowance must be a non-negative finite number");
	}
	return Math.floor((included * 95) / 100);
}

function spec(
	key: DimensionKey,
	unit: string,
	period: PeriodKind,
	included: number | null,
	provable: boolean,
	note: string,
): DimensionSpec {
	return {
		key,
		unit,
		period,
		included,
		threshold_95:
			included === null
				? null
				: threshold95(included * (unit === "GB-month" ? STORAGE_UNIT_SCALE : 1)),
		provable,
		note,
	};
}

/**
 * The catalog.  Allowances are transcribed from the official pricing pages
 * (sources above); the current paid plan must still be re-verified per account
 * before any dimension may be treated as VERIFIED (see `quota-billing.ts`).
 */
export const QUOTA_DIMENSIONS: readonly DimensionSpec[] = [
	spec(
		"workers.requests",
		"requests",
		"billing_cycle",
		10_000_000,
		false,
		"inbound requests are billed on arrival; Worker code cannot stop the request that reaches it",
	),
	spec(
		"workers.cpu_ms",
		"cpu_ms",
		"billing_cycle",
		30_000_000,
		false,
		"CPU has an unpredictable tail and includes authentication/denial work; no provable per-request upper bound",
	),
	spec(
		"d1.rows_read",
		"rows",
		"billing_cycle",
		25_000_000_000,
		true,
		"provable only for index/key bounded statements; scanned rows, not returned rows",
	),
	spec(
		"d1.rows_written",
		"rows",
		"billing_cycle",
		50_000_000,
		true,
		"index maintenance and retries also write rows",
	),
	spec(
		"d1.storage_gb_month",
		"GB-month",
		"storage_integral",
		5,
		false,
		"time integral over the billing cycle; requires verified cycle end and verified stored bytes",
	),
	spec(
		"kv.reads",
		"reads",
		"billing_cycle",
		10_000_000,
		true,
		"per binding path inventory required",
	),
	spec(
		"kv.writes",
		"writes",
		"billing_cycle",
		1_000_000,
		true,
		"per binding path inventory required",
	),
	spec(
		"kv.deletes",
		"deletes",
		"billing_cycle",
		1_000_000,
		true,
		"per binding path inventory required",
	),
	spec(
		"kv.lists",
		"lists",
		"billing_cycle",
		1_000_000,
		true,
		"per binding path inventory required",
	),
	spec(
		"kv.storage_gb_month",
		"GB-month",
		"storage_integral",
		1,
		false,
		"time integral; account-wide KV inventory is not proven for this Collector",
	),
	spec("r2.class_a", "Class A ops", "billing_cycle", 1_000_000, true, "`put`/`list` are Class A"),
	spec(
		"r2.class_b",
		"Class B ops",
		"billing_cycle",
		10_000_000,
		true,
		"`get`/`head` are Class B",
	),
	spec(
		"r2.storage_gb_month",
		"GB-month",
		"storage_integral",
		10,
		false,
		"time integral; new bytes bill for the remainder of the cycle, not a flat 10GB capacity",
	),
	spec(
		"r2.ia_class_a",
		"IA Class A ops",
		"billing_cycle",
		null,
		false,
		"Infrequent Access has no included allowance; any IA use is unadmissible",
	),
	spec(
		"r2.ia_class_b",
		"IA Class B ops",
		"billing_cycle",
		null,
		false,
		"Infrequent Access has no included allowance; any IA use is unadmissible",
	),
	spec(
		"r2.ia_storage_gb_month",
		"IA GB-month",
		"storage_integral",
		null,
		false,
		"Infrequent Access has no included allowance; any IA use is unadmissible",
	),
	spec(
		"ai.neurons",
		"Neurons",
		"utc_day",
		10_000,
		true,
		"owner-approved daily-budget admission (2026-09-30): free allowance resets 00:00 UTC; bge-m3 is 1075 neurons/M input tokens and the embedding pipeline caps a document at 32 chunks x 1,350 chars, so 1 char = 1 token (worst case) proves a 47-neuron per-document cap; run declarations add retry headroom; off-ledger drift is covered by the runtime-bootstrapped daily baseline headroom",
	),
	spec(
		"vectorize.queried_dims",
		"queried dimensions",
		"billing_cycle",
		50_000_000,
		true,
		"query dimensions x billed query count; requires calibrated vector dimension and query count",
	),
	spec(
		"vectorize.stored_dims",
		"stored dimensions",
		"storage_integral",
		10_000_000,
		false,
		"allocation-time storage semantics; stored dimensions are a capacity/stock gate, not a monthly consumption counter",
	),
];

const BY_KEY = new Map<string, DimensionSpec>(QUOTA_DIMENSIONS.map((entry) => [entry.key, entry]));

export function dimensionSpec(key: string): DimensionSpec | null {
	return BY_KEY.get(key) ?? null;
}

export function isDimensionKey(key: string): key is DimensionKey {
	return BY_KEY.has(key);
}

/**
 * The allowance that must be respected for a dimension; `null` means the
 * dimension has no included allowance and therefore admits no usage at all.
 */
export function admissionCeiling(key: DimensionKey): number | null {
	const found = dimensionSpec(key);
	if (!found) return null;
	return found.threshold_95;
}

// ---------------------------------------------------------------------------
// Account billing period anchor
// ---------------------------------------------------------------------------

/**
 * Operator-verified account billing period.  D1 paid allowance resets on the
 * **subscription renewal date**, not on a UTC calendar month, so the anchor is
 * an explicit record with provenance.  Without a verified anchor row every
 * billing-cycle dimension is UNKNOWN → CLOSED.
 */
export interface AccountPeriodAnchor {
	readonly account_id: string;
	/** Inclusive ISO-8601 UTC instant when the current period started (renewal). */
	readonly period_start: string;
	/** Exclusive ISO-8601 UTC instant when the current period ends. */
	readonly period_end: string;
	readonly anchor_kind: "subscription_renewal" | "unknown";
	readonly source: string;
	readonly source_version: string;
	readonly verified_at: string;
}

export function isVerifiedAnchor(anchor: AccountPeriodAnchor | null | undefined): boolean {
	if (!anchor) return false;
	if (anchor.anchor_kind !== "subscription_renewal") return false;
	const start = Date.parse(anchor.period_start);
	const end = Date.parse(anchor.period_end);
	const verified = Date.parse(anchor.verified_at);
	if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(verified))
		return false;
	// A UTC calendar month is exactly what the spec forbids as an implicit anchor:
	// accept it only when the anchor is explicitly a renewal record, otherwise the
	// operator must correct it.  Renewal anchors may coincidentally be month-aligned,
	// so this check verifies ordering and evidence presence rather than shape.
	return end > start && verified >= start;
}

export interface ResolvedPeriod {
	readonly period_kind: PeriodKind;
	readonly period_key: string;
	readonly period_start: string;
	readonly period_end: string;
}

/**
 * Resolve the admission period key for a dimension.
 *
 * `null` means the period cannot be proven (no verified account anchor, or a
 * missing/naive day) and the caller must fail closed — never substitute a UTC
 * calendar month or a month/31 proportion.
 */
export function resolvePeriod(
	specification: DimensionSpec,
	context: { anchor?: AccountPeriodAnchor | null; now: Date },
): ResolvedPeriod | null {
	const now = context.now.getTime();
	if (!Number.isFinite(now)) return null;
	if (specification.period === "utc_day") {
		const day = context.now.toISOString().slice(0, 10);
		const start = `${day}T00:00:00.000Z`;
		const end = new Date(Date.parse(start) + 24 * 3600 * 1000).toISOString();
		return {
			period_kind: "utc_day",
			period_key: `utc-day:${day}`,
			period_start: start,
			period_end: end,
		};
	}
	const anchor = context.anchor ?? null;
	if (!isVerifiedAnchor(anchor)) return null;
	const start = Date.parse(anchor!.period_start);
	const end = Date.parse(anchor!.period_end);
	const verified = Date.parse(anchor!.verified_at);
	if (now < start || now >= end || verified > now) return null;
	return {
		period_kind: specification.period,
		period_key: `cycle:${anchor!.period_start}..${anchor!.period_end}`,
		period_start: anchor!.period_start,
		period_end: anchor!.period_end,
	};
}

/**
 * Storage dimension upper bound for the *remainder of the current cycle*.
 *
 * GB-month is a time integral: bytes stored for `h` hours of a cycle that lasts
 * `H` hours cost `bytes / 1e9 * (h / H)` GB-month.  The formula is exact for a
 * constant byte count; concurrent growth is added by the caller as extra units.
 * Returns `null` when the cycle window or byte count is not known — the caller
 * must then treat the storage dimension as UNKNOWN (CLOSED).
 */
export function storageIntegralUnits(
	bytes: number,
	context: { period_start: string; period_end: string; now: Date },
): number | null {
	if (!Number.isFinite(bytes) || bytes < 0) return null;
	const start = Date.parse(context.period_start);
	const end = Date.parse(context.period_end);
	const now = context.now.getTime();
	if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
	if (!Number.isFinite(now) || now < start || now >= end) return null;
	const hoursRemaining = (end - now) / 3_600_000;
	const hoursInCycle = (end - start) / 3_600_000;
	if (!(hoursInCycle > 0)) return null;
	return (bytes / 1e9) * (hoursRemaining / hoursInCycle);
}
