/**
 * Read-only Cloudflare billing adapter (spec §"权威水位适配").
 *
 * This module never performs network I/O: the caller supplies an already-fetched
 * payload (the Collector Worker must not call the Cloudflare API on every
 * business request).  Its only job is to decide, strictly, whether the payload is
 * authoritative enough to become a `VERIFIED` baseline row, or whether the
 * dimension must stay `UNVERIFIED / STALE / DENIED / INCOMPLETE` (and therefore
 * CLOSED for admission).
 *
 * Hard rules (frozen by spec — do not relax):
 *   - HTTP 403/401 means DENIED. A missing row, empty response or 403 is NEVER 0
 *     usage.
 *   - The Billable Usage API is updated daily and has **no known maximum lateness
 *     bound**; a payload is only fresh if its provider coverage end is inside the
 *     caller's explicit windows *and* the reader proves complete pagination.
 *   - Only dimensions with a **registered, evidence-backed mapping** (usage type,
 *     unit, scale) can be extracted.  An unknown or unit-mismatched row makes the
 *     whole read INCOMPLETE rather than being silently dropped.
 */

import {
	type DimensionKey,
	STORAGE_UNIT_SCALE,
	dimensionSpec,
	isDimensionKey,
} from "./quota-dimensions.ts";

export type BaselineState = "VERIFIED" | "UNVERIFIED" | "STALE" | "DENIED" | "INCOMPLETE";

/**
 * Mapping from a provider usage type to a catalog dimension.  Empty until an
 * authorized, verified read establishes the real field names/units for this
 * account.  The 2026-09-29 read returned only R2 daily charge rows, not a
 * complete cross-product baseline. Never guess a mapping.
 */
export interface BillingDimensionMapping {
	readonly provider_usage_type: string;
	readonly dimension_key: DimensionKey;
	/** Multiplier applied to the provider's numeric value to reach admission units. */
	readonly scale: number;
	readonly evidence: string;
}

export const BILLING_DIMENSION_MAPPINGS: readonly BillingDimensionMapping[] = [];

export interface BillingReadInput {
	/** HTTP status of the billing read; 0 means transport failure. */
	readonly http_status: number;
	readonly fetched_at: string;
	/** Parsed JSON body (or `null` when the body was empty/unparseable). */
	readonly body: unknown;
	readonly account_id: string;
	/** Provider billing cycle the Collector believes is current; `null` = unknown. */
	readonly expected_period: { period_start: string; period_end: string } | null;
	/** True only when the reader proved it consumed every page of the response. */
	readonly pagination_complete: boolean;
	/** Provider coverage end (latest instant the payload accounts for). */
	readonly coverage_end: string | null;
	/** Maximum accepted lag between `coverage_end` and `now`. */
	readonly max_age_ms: number;
	readonly now: Date;
}

export interface BaselineObservation {
	readonly dimension_key: DimensionKey;
	readonly period_key: string;
	/** Provider-reported usage in admission units. */
	readonly used: number;
	readonly state: BaselineState;
	readonly source: string;
	readonly source_version: string;
	readonly as_of: string;
	readonly coverage_end: string | null;
}

export interface BillingReadResult {
	readonly state: BaselineState;
	/** Billing-cycle period key both sides agree on; `null` when unproven. */
	readonly period_key: string | null;
	readonly observations: readonly BaselineObservation[];
	readonly reasons: readonly string[];
	/**
	 * `NONE` — the read can never by itself authorise production admission; a
	 * human/operator must register the verified baseline row with an explicit
	 * unobserved-tail upper bound.
	 */
	readonly gate_authority: "NONE";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isoOrNull(value: unknown): string | null {
	if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return null;
	return new Date(value).toISOString();
}

/**
 * Interpret one already-fetched Billable Usage payload.
 * Fail-closed: any doubt yields a non-VERIFIED state with reasons, never 0 usage.
 */
export function interpretBillableUsage(
	input: BillingReadInput,
	mappings: readonly BillingDimensionMapping[] = BILLING_DIMENSION_MAPPINGS,
): BillingReadResult {
	const reasons: string[] = [];
	const deny = (state: BaselineState, reason: string): BillingReadResult => ({
		state,
		period_key: null,
		observations: [],
		reasons: [reason, ...reasons],
		gate_authority: "NONE",
	});

	if (input.http_status === 401 || input.http_status === 403) {
		return deny("DENIED", `billing read denied with HTTP ${input.http_status}`);
	}
	if (input.http_status === 0 || input.http_status === 429 || input.http_status >= 500) {
		return deny("INCOMPLETE", `billing read unavailable with HTTP ${input.http_status}`);
	}
	if (input.http_status !== 200) {
		return deny("INCOMPLETE", `unexpected billing read status ${input.http_status}`);
	}
	if (!isRecord(input.body)) return deny("INCOMPLETE", "billing body is not a JSON object");
	if (input.body.success !== true) {
		const errors = Array.isArray(input.body.errors) ? input.body.errors.length : 0;
		return deny("DENIED", `billing body reported success=false (${errors} errors)`);
	}
	const result = input.body.result;
	if (!isRecord(result)) return deny("INCOMPLETE", "billing body has no result object");

	const cycleStart = isoOrNull(result.billing_cycle_start ?? result.period_start);
	const cycleEnd = isoOrNull(result.billing_cycle_end ?? result.period_end);
	if (!cycleStart || !cycleEnd) {
		return deny("INCOMPLETE", "billing body does not carry an explicit billing cycle window");
	}
	if (!input.expected_period) {
		return deny("INCOMPLETE", "account billing cycle anchor is not verified for this account");
	}
	if (
		cycleStart !== new Date(input.expected_period.period_start).toISOString() ||
		cycleEnd !== new Date(input.expected_period.period_end).toISOString()
	) {
		return deny(
			"INCOMPLETE",
			"billing cycle window does not match the verified account anchor",
		);
	}
	const periodKey = `cycle:${cycleStart}..${cycleEnd}`;

	if (!input.pagination_complete) {
		return deny("INCOMPLETE", "billing pagination is not proven complete");
	}
	if (!input.coverage_end) {
		return deny("INCOMPLETE", "billing coverage end is unknown");
	}
	const coverageEnd = isoOrNull(input.coverage_end);
	if (!coverageEnd) return deny("INCOMPLETE", "billing coverage end is not an ISO instant");
	const lag = input.now.getTime() - Date.parse(coverageEnd);
	if (!Number.isFinite(lag) || lag < 0) {
		return deny("INCOMPLETE", "billing coverage end is not in the past");
	}
	if (lag > input.max_age_ms) {
		return deny("STALE", `billing coverage lags now by ${Math.round(lag / 1000)}s`);
	}
	const fetchedAt = Date.parse(input.fetched_at);
	if (!Number.isFinite(fetchedAt)) return deny("INCOMPLETE", "billing fetch time is invalid");

	// Provider account identity must match: a payload for another account is not evidence.
	const accountId =
		(typeof result.account_id === "string" && result.account_id) ||
		(typeof result.account_tag === "string" && result.account_tag) ||
		"";
	if (!accountId || accountId !== input.account_id) {
		return deny("INCOMPLETE", "billing account identity does not match the configured account");
	}
	if (result.currency !== undefined && typeof result.currency !== "string") {
		return deny("INCOMPLETE", "billing currency field is not a string");
	}

	const rawUsage = result.usage ?? result.total_usage;
	if (!Array.isArray(rawUsage)) {
		return deny("INCOMPLETE", "billing body carries no usage array");
	}
	if (mappings.length === 0) {
		return deny(
			"INCOMPLETE",
			"no verified provider-to-dimension mapping is registered (partial billing rows cannot authorize admission)",
		);
	}

	const observations: BaselineObservation[] = [];
	for (const row of rawUsage) {
		if (!isRecord(row)) return deny("INCOMPLETE", "billing usage row is not an object");
		const usageType =
			typeof row.usage_type === "string"
				? row.usage_type
				: typeof row.type === "string"
					? row.type
					: null;
		if (!usageType) return deny("INCOMPLETE", "billing usage row has no usage type");
		const mapping = mappings.find((entry) => entry.provider_usage_type === usageType);
		if (!mapping) {
			return deny("INCOMPLETE", `unmapped provider usage type present: ${usageType}`);
		}
		const specification = dimensionSpec(mapping.dimension_key);
		if (!specification) {
			return deny(
				"INCOMPLETE",
				`mapping points at unknown dimension ${mapping.dimension_key}`,
			);
		}
		const value = row.value ?? row.quantity ?? row.used ?? row.usage;
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
			return deny(
				"INCOMPLETE",
				`billing usage value for ${usageType} is not a non-negative number`,
			);
		}
		const scaled = Math.ceil(value * mapping.scale);
		observations.push({
			dimension_key: mapping.dimension_key,
			period_key:
				specification.period === "utc_day"
					? `utc-day:${coverageEnd.slice(0, 10)}`
					: periodKey,
			used: scaled,
			state: "VERIFIED",
			source: "cloudflare-billable-usage",
			source_version: `billable-usage@${input.fetched_at}`,
			as_of: coverageEnd,
			coverage_end: coverageEnd,
		});
	}
	if (observations.length === 0) {
		return deny("INCOMPLETE", "billing usage array is empty; absence is not zero");
	}
	return {
		state: "VERIFIED",
		period_key: periodKey,
		observations,
		reasons,
		gate_authority: "NONE",
	};
}

/** Storage usage reported as instant bytes still needs the cycle window to become GB-month. */
export function storageAdmissionUnits(bytes: number): number | null {
	if (!Number.isFinite(bytes) || bytes < 0) return null;
	return Math.ceil((bytes / 1e9) * STORAGE_UNIT_SCALE);
}

export function isDimensionCoveredByMappings(dimensionKey: string): boolean {
	return BILLING_DIMENSION_MAPPINGS.some((entry) => entry.dimension_key === dimensionKey);
}

export function isValidDimensionKey(key: string): key is DimensionKey {
	return isDimensionKey(key);
}
