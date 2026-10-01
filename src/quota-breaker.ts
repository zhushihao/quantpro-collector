/**
 * Quota admission contract owner for the Collector.
 *
 * This module is the single import surface for the multi-dimension 95% admission
 * system.  It replaces the staged D1 daily prototype whose rules were:
 *   - a UTC-day line computed as `included * 0.95 / 31` (repealed: the paid
 *     allowance resets on the account subscription renewal anchor, not on a UTC
 *     calendar month, and a month/31 proportion is not a 95% guarantee);
 *   - a local D1 watermark treated as a spending cap (repealed: local counters are
 *     not an account baseline);
 *   - a "retry after UTC day reset" message (repealed: no automated recovery
 *     instant can be proven).
 *
 * The prototype files were never deployed and QUOTA_BREAKER_ENABLED was never
 * enabled in production; `legacyBreakerFlag()` exists only to report that a
 * leftover flag must not be mistaken for protection.
 *
 * Contract, in one line each:
 *   - `quota-dimensions.ts`  catalog + natural periods (renewal anchor / UTC day / storage integral);
 *   - `quota-billing.ts`     strict read-only baseline interpretation (403/empty/partial = not zero);
 *   - `quota-admission.ts`   atomic multi-dimension reservation ledger in D1, with the
 *     monotonic per-(dimension, period) booked upper bound that keeps settled spend
 *     counting against the 95% ceiling until the period rolls (audit S1 repair);
 *   - `quota-resource-adapters.ts`  guarded D1/R2/AI/Vectorize proxies;
 *   - `quota-entrypoints.ts` entrypoint catalog + HTTP/MCP/Cron refusal contract.
 *
 * Guarantee boundary (spec §"问题定义"): this is a stop-loss for the *controllable
 * increment* of heavy Collector work.  It is NOT a physical spending cap: the
 * inbound request that reaches the Worker is already billed, CPU has an
 * unpredictable tail, and stored data keeps billing as a time integral.  The
 * system deliberately reports `UNKNOWN` (never zero) when it cannot prove a
 * baseline, and stays CLOSED in that state.
 */

export const QUOTA_ACCOUNT_TAG = "4b0901ceeeef89ac3b8414d56c50c946";
export const QUOTA_D1_DATABASE_ID = "0e20aca4-c394-4f41-aa46-d98831b81836";

export type QuotaAdmissionMode = "off" | "enforce";

/**
 * Admission switch.  `off` (default) performs no gating; `enforce` requires an
 * ADMITTED reservation for every heavy route.  With no verified account baseline
 * `enforce` refuses heavy work by construction (`QUOTA_GUARD_UNAVAILABLE`).
 */
export function admissionMode(env?: { QUOTA_ADMISSION_MODE?: string }): QuotaAdmissionMode {
	return env?.QUOTA_ADMISSION_MODE === "enforce" ? "enforce" : "off";
}

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
	MAX_BOOKED_UNITS,
	MAX_DIMENSIONS_PER_ADMISSION,
	QUOTA_GUARD_SCAN_CAP,
	QUOTA_LIVE_UNITS_CAP,
	admitOperation,
	baselineStaleAfterMs,
	baselineWarnings,
	bookedParameterValues,
	buildBookedSql,
	buildDiagnosisSql,
	buildGuardSql,
	buildReleaseStatements,
	buildSealSql,
	buildSettleStatements,
	guardParameterValues,
	ledgerLifecycleReads,
	ledgerLifecycleWrites,
	ledgerSelfReads,
	ledgerSelfWrites,
	mergeDimensions,
	prepareStatements,
	quotaStatus,
	readBookedUsage,
	recordAccountPeriod,
	recordBaseline,
	releaseReservation,
	sealParameterValues,
	settleReservation,
	syncDimensionCatalog,
	withLedgerSelfCost,
	type AdmissionContext,
	type AdmissionDenialReason,
	type BaselineWarning,
	type AdmissionDimension,
	type AdmissionRequest,
	type AdmissionResult,
	type DimensionStatus,
	type ObservedDimension,
	type QuotaStatus,
	type RawQuotaDb,
	type ReleaseResult,
	type SettleResult,
	type StatementSpec,
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
	NEURON_BOUND,
	QuotaGuardError,
	VECTORIZE_QUERY_DIMENSIONS,
	ReservationBudget,
	admissionHandle,
	createGuardedAi,
	createGuardedD1,
	createGuardedR2,
	createGuardedVectorize,
	neuronUpperBound,
	type NeuronBoundProof,
	type QuotaObservationSink,
	type QuotaRefusalCode,
	type ReservationHandle,
} from "./quota-resource-adapters.ts";

export {
	QUOTA_CRONS,
	QUOTA_ENTRYPOINTS,
	QUOTA_HTTP_ROUTES,
	QUOTA_MCP_TOOLS,
	cronQuotaOutcome,
	missingEntrypoints,
	quotaHttpRefusal,
	quotaMcpRefusal,
	quotaRefusalBody,
	routeCostProfile,
	unclassifiedEntrypoints,
	type CronQuotaOutcome,
	type EntrypointKind,
	type QuotaRefusalBody,
	type QuotaRefusalErrorCode,
	type RouteCostClass,
	type RouteCostProfile,
	type SafeHttpRefusal,
} from "./quota-entrypoints.ts";
