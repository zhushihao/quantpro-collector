/**
 * Quota module facade for the Collector.
 *
 * 2026-10-02 quota redesign (spec section 1.1): every front gate is removed.
 * There is no admission switch, no reservation ledger in the request path, no
 * 26h baseline hard timeout (`BASELINE_COVERAGE_AGE_MS` abolished) and no
 * "missing baseline = CLOSED" path.  Business requests pass after
 * authorization; paid-resource usage is observed post-hoc by pure observers and
 * will be persisted by the accounting middleware; the 12h official-meter
 * reconcile (Phase 3) and the 95% circuit table (Phase 4) build on that.
 *
 * Contract, in one line each:
 *   - `quota-dimensions.ts`  dimension catalog + natural periods (renewal anchor
 *     / UTC day / storage integral);
 *   - `quota-billing.ts`     strict read-only baseline interpretation (403/empty/partial = not zero);
 *   - `quota-admission.ts`   legacy ledger read + operator-record surface (tables retained read-only;
 *     CLOSED only after a real 95% threshold breach);
 *   - `quota-resource-adapters.ts`  pure D1/R2 observers (never throw, never re-judge);
 *   - `quota-entrypoints.ts` entrypoint catalog reused by the accounting
 *     middleware for per-route dimension aggregation.
 *
 * Guarantee boundary: nothing here gates work any more.  The old admission mode
 * (`QUOTA_ADMISSION_MODE`) is inert: setting it changes no behavior anywhere.
 */

export const QUOTA_ACCOUNT_TAG = "4b0901ceeeef89ac3b8414d56c50c946";
export const QUOTA_D1_DATABASE_ID = "0e20aca4-c394-4f41-aa46-d98831b81836";

export interface LegacyFlagReport {
	readonly flag: "QUOTA_BREAKER_ENABLED";
	readonly present: boolean;
	/** The legacy day/31 prototype is inert; this value never opens a gate. */
	readonly prototype_state: "disabled";
}

export function legacyBreakerFlag(env?: { QUOTA_BREAKER_ENABLED?: string }): LegacyFlagReport {
	return {
		flag: "QUOTA_BREAKER_ENABLED",
		present: env?.QUOTA_BREAKER_ENABLED === "true",
		prototype_state: "disabled",
	};
}

/** Always false: there is no code path in which the legacy prototype gates work. */
export function legacyPrototypeGatesWork(): false {
	return false;
}

export {
	QUOTA_CATALOG_SOURCES,
	QUOTA_CATALOG_VERSION,
	QUOTA_DIMENSIONS,
	STORAGE_UNIT_SCALE,
	admissionCeiling,
	dimensionSpec,
	isDimensionKey,
	isVerifiedAnchor,
	resolvePeriod,
	storageIntegralUnits,
	threshold95,
	type AccountPeriodAnchor,
	type DimensionKey,
	type DimensionSpec,
	type PeriodKind,
	type ResolvedPeriod,
} from "./quota-dimensions.ts";

export {
	recordAccountPeriod,
	recordBaseline,
	quotaStatus,
	readBookedUsage,
	syncDimensionCatalog,
	type AnchorRow,
	type DimensionStatus,
	type QuotaStatus,
	type RawQuotaDb,
} from "./quota-admission.ts";

export {
	BILLING_DIMENSION_MAPPINGS,
	interpretBillableUsage,
	isDimensionCoveredByMappings,
	isValidDimensionKey,
	storageAdmissionUnits,
	type BaselineObservation,
	type BaselineState,
	type BillingDimensionMapping,
	type BillingReadInput,
	type BillingReadResult,
} from "./quota-billing.ts";

export {
	UsageObserver,
	createObservedAI,
	createObservedD1,
	createObservedR2,
	createObservedVectorize,
	type ObservedDimension,
	type QuotaObservationSink,
} from "./quota-resource-adapters.ts";

export {
	QUOTA_CRONS,
	QUOTA_ENTRYPOINTS,
	QUOTA_HTTP_ROUTES,
	QUOTA_MCP_TOOLS,
	missingEntrypoints,
	routeCostProfile,
	unclassifiedEntrypoints,
	type EntrypointKind,
	type RouteCostClass,
	type RouteCostProfile,
	type RouteDimension,
} from "./quota-entrypoints.ts";
