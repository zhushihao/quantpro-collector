/**
 * Pure resource observers (quota redesign 2026-10-02, spec section 1.1).
 *
 * The Collector no longer gates any business call on quota metadata.  These
 * wrappers stay in the call path for exactly one job: AFTER a paid resource call
 * completes, read the platform-reported practical usage (D1 `meta.rows_read` /
 * `meta.rows_written`, R2 operation classes) and accumulate it for the post-hoc
 * accounting middleware.
 *
 * Hard contract (do not regress):
 *   - An observer NEVER throws.  Missing usage metadata is recorded as "nothing
 *     observed" -- it can never fail or re-judge the business call.  The
 *     2026-09-30 C5 outage (a guard that threw on missing D1 `first()` meta) is
 *     the failure mode this module abolishes.
 *   - An observer NEVER refuses, rewrites or re-orders a call.  The one
 *     deliberate equivalence: D1 `first()` is answered by a single bounded
 *     `.all()` execution whose meta is read (the C5 fix, driver-proven in
 *     production), because `first()` itself carries no usage meta -- with a
 *     native-`first()` fallback so the projection can never change an outcome.
 *   - Reporting to a sink is best effort: a throwing sink is swallowed.
 */

import type { DimensionKey } from "./quota-dimensions.ts";

/** One measured usage entry in catalog dimension units. */
export interface ObservedDimension {
	readonly dimension_key: DimensionKey;
	readonly units: number;
}

/**
 * Post-hoc accounting hook (Phase 2): receives the observed totals of one
 * request.  Observers only guard their own bookkeeping -- a failing sink never
 * reaches the business call path.
 */
export interface QuotaObservationSink {
	observe(observed: readonly ObservedDimension[]): Promise<void> | void;
}

/**
 * Cumulative, best-effort usage ledger for one request.  Every method is
 * failure-proof: recording can never throw and can never affect the wrapped
 * resource call.
 */
export class UsageObserver {
	private readonly totalsByDimension = new Map<DimensionKey, number>();

	record(dimensionKey: DimensionKey, units: number): void {
		try {
			if (!Number.isFinite(units) || units <= 0) return;
			// Raw float accumulation: ai.neurons arrives as fractional estimates
			// (<1 neuron per search query) and must not be floored to zero.
			// Integer dimensions (D1 rows, Vectorize dims) are integers anyway.
			this.totalsByDimension.set(
				dimensionKey,
				(this.totalsByDimension.get(dimensionKey) ?? 0) + units,
			);
		} catch {
			// Observation must never break the business call.
		}
	}

	/** Observed totals so far; dimensions with zero observations are absent. */
	totals(): ObservedDimension[] {
		try {
			return [...this.totalsByDimension.entries()].map(([dimension_key, units]) => ({
				dimension_key,
				units,
			}));
		} catch {
			return [];
		}
	}

	/** Push the current totals to a sink; a failing sink is swallowed. */
	async report(sink: QuotaObservationSink): Promise<void> {
		try {
			await sink.observe(this.totals());
		} catch {
			// Observation is best effort.
		}
	}
}

// ---------------------------------------------------------------------------
// D1
// ---------------------------------------------------------------------------

type D1Like = Pick<D1Database, "prepare" | "batch">;

/**
 * Wrap a D1 binding so every executed statement's platform-reported
 * `rows_read` / `rows_written` is accumulated into the observer.  Statements
 * run unmodified and in order; a result without usage meta records nothing and
 * never fails the call.
 */
export function createObservedD1(db: D1Like, observer?: UsageObserver): D1Database {
	const recordMeta = (meta: unknown): void => {
		if (!observer) return;
		try {
			const record = meta as { rows_read?: unknown; rows_written?: unknown } | undefined;
			const reads = Number(record?.rows_read);
			const writes = Number(record?.rows_written);
			if (Number.isFinite(reads)) observer.record("d1.rows_read", reads);
			if (Number.isFinite(writes)) observer.record("d1.rows_written", writes);
		} catch {
			// Observation must never break the business call.
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
					// the real statement or the proxy breaks the driver.
					return (...values: unknown[]) => wrap(sql, bind.apply(target, values));
				}
				if (property === "first") {
					// first() returns the row itself and never carries usage meta, so a
					// plain passthrough would leave read traffic unmeasured.  Mirror the
					// C5-2026-09-30 fix (driver-proven in production): execute the
					// bounded .all() ONCE, observe its meta, project the first row --
					// preserving the optional column-name variant.  If the projection
					// itself fails, fall back to the native first() (a read-only
					// re-execution) so the observer can never change the business
					// outcome.
					return async (...args: unknown[]) => {
						const all = target.all as unknown as (
							...inner: unknown[]
						) => Promise<{ results?: Array<Record<string, unknown>>; meta?: unknown }>;
						const first = target.first as unknown as (
							...inner: unknown[]
						) => Promise<unknown>;
						try {
							const result = await all.apply(target, args);
							recordMeta(result?.meta);
							const rows = result?.results ?? [];
							const firstRow = (rows[0] ?? null) as Record<string, unknown> | null;
							if (typeof args[0] === "string") {
								return firstRow === null ? null : (firstRow[args[0] as string] ?? null);
							}
							return firstRow;
						} catch {
							// The projection must never alter the business result: let the
							// native first() answer (and throw) -- the earlier attempt was a
							// read, so re-execution is safe.
							return await first.apply(target, args);
						}
					};
				}
				if (property === "run" || property === "all" || property === "raw") {
					return async (...args: unknown[]) => {
						const result = await (
							value as (...inner: unknown[]) => Promise<unknown>
						).apply(target, args);
						recordMeta((result as { meta?: unknown })?.meta);
						return result;
					};
				}
				// Everything else (session APIs, runtime affordances) passes through
				// UNMODIFIED.
				return value.bind(target);
			},
		}) as D1PreparedStatement;
	return new Proxy(db, {
		get(target, property, receiver) {
			if (property === "prepare") {
				const prepare = target.prepare.bind(target) as (sql: string) => D1PreparedStatement;
				return (sql: string) => wrap(sql, prepare(sql));
			}
			if (property === "batch") {
				return async (statements: D1PreparedStatement[]) => {
					const results = await target.batch(statements);
					for (const result of results) recordMeta((result as { meta?: unknown })?.meta);
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
	// DeleteObject is free: it consumes no Class A/B allowance.
	delete: null,
} as const;

/**
 * Wrap an R2 bucket so every operation counts one Class A/B operation into the
 * observer.  Calls run unmodified; counting can never fail the call.
 */
export function createObservedR2(bucket: R2Like, observer?: UsageObserver): R2Bucket {
	const wrap = <K extends keyof typeof R2_CLASS_BY_OPERATION>(operation: K) => {
		return async (...args: unknown[]) => {
			const result = await (
				bucket[operation] as (...inner: unknown[]) => Promise<unknown>
			).apply(bucket, args);
			const dimension = R2_CLASS_BY_OPERATION[operation];
			if (dimension) observer?.record(dimension as DimensionKey, 1);
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
// Workers AI + Vectorize (P1-3, 2026-10-02 ledger): client-level accounting for
// the only two paid resources behind mcp:search_documents_semantic that the
// D1/R2 observers cannot see.  Estimates are labelled as such in reports; the
// official 12h meter stays the circuit-breaker authority.
// ---------------------------------------------------------------------------

/** Minimal Workers AI surface used by the semantic search path. */
interface ObservedAiLike {
	run(model: string, input: unknown, options?: unknown): Promise<unknown>;
}

/** Minimal Vectorize surface; only `query` consumes queried-dimension units. */
interface ObservedVectorizeLike {
	query(...args: unknown[]): Promise<unknown>;
}

const NEURONS_PER_MILLION_TOKENS = 1075; // bge-m3 pricing row
const CHARS_PER_TOKEN_CONSERVATIVE = 2; // over-estimates latin, ~matches CJK

function estimateEmbeddingNeurons(texts: readonly unknown[]): number {
	const chars = texts.reduce<number>(
		(total, text) => total + (typeof text === "string" ? text.length : 0),
		0,
	);
	const tokens = Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN_CONSERVATIVE));
	return (tokens * NEURONS_PER_MILLION_TOKENS) / 1_000_000;
}

/**
 * Wraps the Workers AI binding so embedding calls record estimated
 * `ai.neurons` per request.  Preference order: the response's own usage
 * counter when the platform provides one, otherwise a conservative
 * text-volume estimate (never zero, never invented detail).  NEVER throws.
 */
export function createObservedAI(ai: ObservedAiLike, observer?: UsageObserver): ObservedAiLike {
	return new Proxy(ai, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver);
			if (typeof value !== "function") return value;
			return async (...args: unknown[]) => {
				const result = await value.apply(target, args);
				try {
					const model = String(args[0] ?? "");
					if (model.includes("bge")) {
						const input = (args[1] as { text?: unknown } | undefined)?.text;
						const texts = Array.isArray(input) ? input : [input];
						const usage = (result as { usage?: { tokens?: unknown } } | undefined)?.usage;
						const reported = Number(usage?.tokens);
						const neurons = Number.isFinite(reported)
							? (reported * NEURONS_PER_MILLION_TOKENS) / 1_000_000
							: estimateEmbeddingNeurons(texts);
						if (neurons > 0) observer?.record("ai.neurons", neurons);
					}
				} catch {
					// Observation must never break the business call.
				}
				return result;
			};
		},
	}) as ObservedAiLike;
}

/**
 * Wraps the Vectorize index so each `query` records one queried-dimensions
 * unit (the index dimensionality x exactly one query per call).  Deletes and
 * inserts are storage-side operations, not queried dimensions.
 */
export function createObservedVectorize(
	index: ObservedVectorizeLike,
	dimensions: number,
	observer?: UsageObserver,
): ObservedVectorizeLike {
	return new Proxy(index, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver);
			if (property === "query" && typeof value === "function") {
				return async (...args: unknown[]) => {
					const result = await value.apply(target, args);
					try {
						if (dimensions > 0) observer?.record("vectorize.queried_dims", dimensions);
					} catch {
						// Observation must never break the business call.
					}
					return result;
				};
			}
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as ObservedVectorizeLike;
}
