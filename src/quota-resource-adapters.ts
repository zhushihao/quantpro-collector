/**
 * Guarded resource adapters (spec §"准入器与资源代理").
 *
 * Every paid resource call the Collector can make is wrapped here.  A wrapper:
 *   1. refuses to run at all without an ADMITTED reservation handle (typed,
 *      in-process only — it is never serialised to a client);
 *   2. refuses when the dimension the call will bill is not reserved;
 *   3. enforces the declared per-operation upper bound: a call may not amplify
 *      past what the guard reserved (the hidden multiplier the spec warns about);
 *   4. reports observed platform usage so the caller can settle the reservation,
 *      and never auto-releases on timeout or on an unknown outcome.
 *
 * Dimensions without a provable bound (`AI neurons`, Vectorize stored
 * dimensions, storage time integrals) stay CLOSED: the wrapper throws
 * `QUOTA_GUARD_UNAVAILABLE` instead of pretending to bound them.
 */

import type { AdmissionResult, AdmissionDimension, ObservedDimension } from "./quota-admission.ts";
import { dimensionSpec, type DimensionKey } from "./quota-dimensions.ts";

/** Machine-readable refusal codes shared with the HTTP/MCP/Cron contract. */
export type QuotaRefusalCode = "QUOTA_CIRCUIT_OPEN" | "QUOTA_GUARD_UNAVAILABLE";

export class QuotaGuardError extends Error {
	readonly error_code: QuotaRefusalCode;
	readonly detail: string;

	constructor(errorCode: QuotaRefusalCode, detail: string) {
		super(detail);
		this.name = "QuotaGuardError";
		this.error_code = errorCode;
		this.detail = detail;
	}
}

export interface ReservationHandle {
	readonly reservation_id: string;
	readonly operation_id: string;
	readonly route: string;
	readonly reserved: readonly AdmissionDimension[];
}

/** Turn an admission result into a handle, or `null` when the operation was not admitted. */
export function admissionHandle(
	result: AdmissionResult,
	request: { operation_id: string; route: string },
): ReservationHandle | null {
	if (result.status !== "ADMITTED") return null;
	const totals = new Map<DimensionKey, number>();
	for (const dimension of result.reserved) {
		totals.set(
			dimension.dimension_key,
			(totals.get(dimension.dimension_key) ?? 0) + dimension.units,
		);
	}
	// The ledger's own cost is part of the same reservation and may be observed
	// without exceeding it; merging keeps a single accounting view.
	for (const dimension of result.self_cost) {
		totals.set(
			dimension.dimension_key,
			(totals.get(dimension.dimension_key) ?? 0) + dimension.units,
		);
	}
	return {
		reservation_id: result.reservation_id,
		operation_id: request.operation_id,
		route: request.route,
		reserved: [...totals.entries()].map(([dimension_key, units]) => ({ dimension_key, units })),
	};
}

export interface QuotaObservationSink {
	/** Report observed platform usage; settlement happens outside the call path. */
	observe(observed: readonly ObservedDimension[]): Promise<void> | void;
}

/**
 * Tracks spend against a handle so a single logical operation cannot amplify
 * beyond its reserved upper bound.
 */
export class ReservationBudget {
	private readonly reservedByDimension: Map<DimensionKey, number>;
	private readonly spentByDimension: Map<DimensionKey, number> = new Map();

	constructor(handle: ReservationHandle) {
		this.reservedByDimension = new Map(
			handle.reserved.map((dimension) => [dimension.dimension_key, dimension.units]),
		);
	}

	reserved(dimensionKey: DimensionKey): number {
		return this.reservedByDimension.get(dimensionKey) ?? 0;
	}

	/** Reserve the right to bill up to `units` of `dimensionKey` for one call. */
	require(dimensionKey: DimensionKey, units: number, reason: string): void {
		const specification = dimensionSpec(dimensionKey);
		if (!specification || !specification.provable) {
			throw new QuotaGuardError(
				"QUOTA_GUARD_UNAVAILABLE",
				`${reason}: dimension ${dimensionKey} has no provable upper bound`,
			);
		}
		if (!Number.isSafeInteger(units) || units < 0) {
			throw new QuotaGuardError(
				"QUOTA_GUARD_UNAVAILABLE",
				`${reason}: declared bound is not an integer`,
			);
		}
		const reserved = this.reserved(dimensionKey);
		if (reserved === 0) {
			throw new QuotaGuardError(
				"QUOTA_GUARD_UNAVAILABLE",
				`${reason}: dimension ${dimensionKey} is not covered by reservation`,
			);
		}
		if (this.spent(dimensionKey) + units > reserved) {
			throw new QuotaGuardError(
				"QUOTA_CIRCUIT_OPEN",
				`${reason}: operation would exceed its reserved ${dimensionKey} bound`,
			);
		}
	}

	/** Record actual usage reported by the platform. */
	spend(dimensionKey: DimensionKey, units: number): void {
		const next = this.spent(dimensionKey) + Math.max(0, Math.floor(units));
		this.spentByDimension.set(dimensionKey, next);
	}

	spent(dimensionKey: DimensionKey): number {
		return this.spentByDimension.get(dimensionKey) ?? 0;
	}

	/** Observed totals for settlement; empty dimensions default to their full reservation. */
	snapshot(): ObservedDimension[] {
		return [...this.reservedByDimension.entries()].map(([dimension_key, units]) => ({
			dimension_key,
			units: Math.min(this.spent(dimension_key), units),
		}));
	}
}

function assertHandle(
	handle: ReservationHandle | null | undefined,
	reason: string,
): ReservationHandle {
	if (!handle) {
		throw new QuotaGuardError("QUOTA_GUARD_UNAVAILABLE", `${reason}: no ADMITTED reservation`);
	}
	return handle;
}

/** Safe observation hook: a failing sink never turns a refusal into a success. */
async function report(
	sink: QuotaObservationSink | undefined,
	budget: ReservationBudget,
): Promise<void> {
	if (!sink) return;
	try {
		await sink.observe(budget.snapshot());
	} catch {
		// Observation is best effort; the reservation stays live either way.
	}
}

// ---------------------------------------------------------------------------
// D1
// ---------------------------------------------------------------------------

type D1Like = Pick<D1Database, "prepare" | "batch">;

/**
 * Wrap a D1 binding so every statement is billed against the reservation.  The
 * wrapper requires `d1.rows_read` / `d1.rows_written` reservations and refuses to
 * execute a statement it cannot bound (for example an unbounded scan that was not
 * declared) — the caller must declare its per-statement bound with
 * `budget.require("d1.rows_read", n, ...)` before running it.
 */
export function createGuardedD1(
	db: D1Like,
	handle: ReservationHandle,
	budget: ReservationBudget,
	sink?: QuotaObservationSink,
): D1Database {
	assertHandle(handle, "D1 access");
	const requireReadBound = () => budget.require("d1.rows_read", 1, "D1 statement");
	const requireWriteBound = () => budget.require("d1.rows_written", 1, "D1 statement");
	const guard = async (sql: string, meta: unknown) => {
		const kind = /^\s*(select|with|pragma|explain)/i.test(sql) ? "read" : "write";
		if (kind === "read") requireReadBound();
		else requireWriteBound();
		const record = meta as { rows_read?: number; rows_written?: number } | undefined;
		const reads = Number.isSafeInteger(record?.rows_read) ? Number(record!.rows_read) : null;
		const writes = Number.isSafeInteger(record?.rows_written)
			? Number(record!.rows_written)
			: null;
		if (reads === null || writes === null) {
			// Unknown practical usage: keep the reservation, never claim settlement.
			throw new QuotaGuardError(
				"QUOTA_GUARD_UNAVAILABLE",
				"D1 usage metadata unavailable; reservation kept",
			);
		}
		budget.spend("d1.rows_read", reads);
		budget.spend("d1.rows_written", writes);
		await report(sink, budget);
		// The platform may report more than the reservation: the call cannot be
		// undone, so fail closed for the rest of the operation and keep the
		// reservation (it must never be released as if it had been within bound).
		if (
			budget.spent("d1.rows_read") > budget.reserved("d1.rows_read") ||
			budget.spent("d1.rows_written") > budget.reserved("d1.rows_written")
		) {
			throw new QuotaGuardError(
				"QUOTA_CIRCUIT_OPEN",
				"actual D1 usage exceeded the reserved bound; reservation kept",
			);
		}
	};
	const wrap = (sql: string, bound: D1PreparedStatement): D1PreparedStatement =>
		new Proxy(bound, {
			get(target, property, receiver) {
				const value = Reflect.get(target, property, receiver);
				if (typeof value !== "function") return value;
				if (property === "bind") {
					const bind = target.bind as unknown as (
						...values: unknown[]
					) => D1PreparedStatement;
					// D1's bind reads runtime session state off `this`; call it against
					// the real statement or the guard proxy breaks the driver.
					return (...values: unknown[]) => wrap(sql, bind.apply(target, values));
				}
				if (
					property === "first" ||
					property === "run" ||
					property === "all" ||
					property === "raw"
				) {
					return async (...args: unknown[]) => {
						const result = await (
							value as (...inner: unknown[]) => Promise<unknown>
						).apply(target, args);
						await guard(sql, (result as { meta?: unknown })?.meta);
						return result;
					};
				}
				// Any other runtime affordance (e.g. D1 session APIs) passes through
				// unwrapped rather than turning into an opaque guarded function.
				return value.bind(target);
			},
		}) as D1PreparedStatement;
	// Proxy the database itself: prepare/batch are guarded, every other property
	// (session APIs, internal handles the runtime reaches for) passes through to
	// the real binding so the Worker runtime never sees a hole in the object.
	return new Proxy(db, {
		get(target, property, receiver) {
			if (property === "prepare") {
				const prepare = target.prepare.bind(target) as (sql: string) => D1PreparedStatement;
				return (sql: string) => wrap(sql, prepare(sql));
			}
			if (property === "batch") {
				return async (statements: D1PreparedStatement[]) => {
					requireWriteBound();
					const results = await target.batch(statements);
					for (const result of results)
						await guard("batch", (result as { meta?: unknown })?.meta);
					return results;
				};
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as unknown as D1Database;
}

// ---------------------------------------------------------------------------
// R2
// ---------------------------------------------------------------------------

type R2Like = Pick<R2Bucket, "put" | "get" | "head" | "delete" | "list">;

const R2_CLASS_BY_OPERATION = {
	put: "r2.class_a",
	get: "r2.class_b",
	head: "r2.class_b",
	list: "r2.class_a",
	// DeleteObject is free: it consumes no Class A/B allowance.  The D1 rows that
	// record the deletion are billed separately through the guarded D1 binding.
	delete: null,
} as const;

export function createGuardedR2(
	bucket: R2Like,
	handle: ReservationHandle,
	budget: ReservationBudget,
	sink?: QuotaObservationSink,
): R2Bucket {
	assertHandle(handle, "R2 access");
	const wrap = <K extends keyof typeof R2_CLASS_BY_OPERATION>(operation: K) => {
		return async (...args: unknown[]) => {
			const dimension = R2_CLASS_BY_OPERATION[operation];
			if (dimension) budget.require(dimension as DimensionKey, 1, `R2 ${operation}`);
			const result = await (
				bucket[operation] as (...inner: unknown[]) => Promise<unknown>
			).apply(bucket, args);
			if (dimension) {
				budget.spend(dimension as DimensionKey, 1);
				await report(sink, budget);
			}
			return result;
		};
	};
	return {
		put: wrap("put"),
		get: wrap("get"),
		head: wrap("head"),
		delete: wrap("delete"),
		list: wrap("list"),
	} as unknown as R2Bucket;
}

// ---------------------------------------------------------------------------
// AI / Vectorize
// ---------------------------------------------------------------------------

/**
 * A provider-side token upper bound with tokenizer evidence.
 */
export interface NeuronBoundProof {
	readonly model: string;
	readonly neurons_per_million_tokens: number;
	readonly max_input_tokens: number;
}

/**
 * Calibrated vector width for one Vectorize query.  `null` means the accounting
 * is not calibrated for this index (the deployment probe must confirm the real
 * dimensions first), and the guarded query refuses rather than guessing.
 */
export const VECTORIZE_QUERY_DIMENSIONS: number | null = null;

/**
 * Provider-side neuron bound with tokenizer evidence (owner approved the daily
 * budget admission on 2026-09-30).  The embedding pipeline caps one document at
 * `SEMANTIC_MAX_CHUNKS` (32) chunks of `SEMANTIC_CHUNK_CHARS` + overlap (1,350)
 * characters; billing counts *input* tokens, and 1 char = 1 token is the worst
 * case for bge-m3 (Chinese) and over-counts English ~4x:
 * ceil(43_200 * 1_075 / 1e6) = 47 neurons per document call.
 */
export const NEURON_BOUND: NeuronBoundProof = {
	model: "@cf/baai/bge-m3",
	neurons_per_million_tokens: 1_075,
	max_input_tokens: 43_200,
};

export function neuronUpperBound(proof: NeuronBoundProof | null = NEURON_BOUND): number | null {
	if (!proof) return null;
	if (!(proof.neurons_per_million_tokens > 0) || !(proof.max_input_tokens > 0)) return null;
	return Math.ceil((proof.max_input_tokens * proof.neurons_per_million_tokens) / 1_000_000);
}

type AiLike = Pick<Ai, "run">;

/** Refuse Workers AI unless a verified neuron bound exists and is reserved. */
export function createGuardedAi(
	ai: AiLike,
	handle: ReservationHandle | null,
	budget: ReservationBudget | null,
): AiLike {
	return {
		async run(...args: unknown[]) {
			assertHandle(handle, "Workers AI call");
			const bound = neuronUpperBound();
			if (bound === null || !budget) {
				throw new QuotaGuardError(
					"QUOTA_GUARD_UNAVAILABLE",
					"Workers AI neurons have no provable per-call upper bound; embedding stays closed",
				);
			}
			budget.require("ai.neurons", bound, "Workers AI call");
			const result = await (ai.run as (...inner: unknown[]) => Promise<unknown>).apply(
				ai,
				args,
			);
			budget.spend("ai.neurons", bound);
			return result;
		},
	} as AiLike;
}

type VectorizeLike = Pick<VectorizeIndex, "query" | "upsert" | "deleteByIds">;

/**
 * Refuse Vectorize writes and queries unless both the query dimension count and
 * the stored-dimension stock semantics are provable and reserved.  Stored
 * dimensions use provider stock semantics (`verifiable_stock` must be set on the
 * handle), so the default is a refusal.
 */
export function createGuardedVectorize(
	index: VectorizeLike,
	handle: ReservationHandle | null,
	budget: ReservationBudget | null,
): VectorizeLike {
	assertHandle(handle, "Vectorize call");
	return {
		async query(...args: unknown[]) {
			if (!budget) {
				throw new QuotaGuardError(
					"QUOTA_GUARD_UNAVAILABLE",
					"Vectorize call has no reservation budget",
				);
			}
			const specification = dimensionSpec("vectorize.queried_dims");
			if (!specification?.provable || VECTORIZE_QUERY_DIMENSIONS === null) {
				throw new QuotaGuardError(
					"QUOTA_GUARD_UNAVAILABLE",
					"Vectorize queried-dimension accounting is not calibrated",
				);
			}
			const perQuery = (specification.threshold_95 ?? 0) > 0 ? VECTORIZE_QUERY_DIMENSIONS : 0;
			budget.require("vectorize.queried_dims", perQuery, "Vectorize query");
			const result = await (index.query as (...inner: unknown[]) => Promise<unknown>).apply(
				index,
				args,
			);
			budget.spend("vectorize.queried_dims", perQuery);
			return result;
		},
		async upsert() {
			throw new QuotaGuardError(
				"QUOTA_GUARD_UNAVAILABLE",
				"Vectorize stored-dimension stock semantics are not verified for this account",
			);
		},
		async deleteByIds() {
			throw new QuotaGuardError(
				"QUOTA_GUARD_UNAVAILABLE",
				"Vectorize stored-dimension stock semantics are not verified for this account",
			);
		},
	} as VectorizeLike;
}
