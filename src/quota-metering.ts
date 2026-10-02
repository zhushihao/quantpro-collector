/**
 * Post-hoc client metering + the single surviving quota gate (quota redesign
 * 2026-10-02 Phase 2, spec sections 1 and 3).
 *
 * Two jobs, strictly separated:
 *
 * 1. ACCOUNTING (never gates): `recordClientUsage` upserts one aggregate row per
 *    (hour, client, route) into `quota_client_usage_hourly`.  Input is trusted:
 *    the caller passes a client identity resolved from a VERIFIED credential
 *    (bridge-stamped principal, registered static principal, or the internal
 *    transport credential) plus the measured `ObservedDimension` totals of the
 *    finished request.  Callers that cannot be attributed go in as
 *    `unattributed`; IP headers (forwarding/proxy headers of any kind) are
 *    never an identity input.  One UPSERT per measuring request, never one row
 *    per request.
 *
 * 2. THE LIFELINE-EXEMPT CIRCUIT GATE (the only remaining gate): the 12h
 *    official-meter reconcile program (Phase 3, out of this repo) is the ONLY
 *    writer of `quota_circuit_state`.  `semanticSearchCircuitRefusal` reads the
 *    dimensions behind the one high-compute query surface
 *    (`mcp:search_documents_semantic`: ai.neurons + vectorize.queried_dims)
 *    BEFORE that tool executes and returns a structured QUOTA_CIRCUIT_OPEN
 *    refusal when any of them is OPEN.  Lifeline surfaces (quotes, heartbeat,
 *    status probes, get_document / lexical search) NEVER call this gate.
 *
 * Failure posture (the 2026-09-30 lesson, do not regress): a gate that cannot
 * read its own state MUST fail open -- `semanticSearchCircuitRefusal` swallows
 * every read error and returns null.  A broken breaker may never recreate the
 * QUOTA_GUARD_UNAVAILABLE outage class the redesign abolished.  Accounting
 * helpers throw only D1 errors upward; the waitUntil wrappers in index.ts own
 * the try-catch that keeps metering failures away from business responses.
 */

import type { ObservedDimension } from "./quota-resource-adapters.ts";

/** Client id for requests whose verified identity cannot be determined. */
export const QUOTA_CLIENT_UNATTRIBUTED = "unattributed";

/**
 * Client id attributed to the internal transport credential
 * (RESEARCH_REPLICA_INGEST_TOKEN) holders: the research machine's document /
 * vector pipelines.  Only reachable after that token's byte-exact match, so the
 * attribution is credential-verified, never inferred.
 */
export const QUOTA_CLIENT_RESEARCH_RUNNER = "research-runner";

/** Circuit dimensions that guard `mcp:search_documents_semantic`.
 *
 * Spec section 3 names "vectorize.queries"; the code catalog
 * (`quota-dimensions.ts`) names the same resource `vectorize.queried_dims` --
 * the catalog key is authoritative (reality over spec text, recorded in the
 * implementation notes).  Any OPEN row among these blocks the tool.
 */
export const SEMANTIC_SEARCH_CIRCUIT_DIMENSIONS: readonly string[] = [
	"ai.neurons",
	"vectorize.queried_dims",
];

/** Minimal D1 surface the metering module needs (read + single-statement run). */
export type QuotaMeteringDb = Pick<D1Database, "prepare">;

/** 'YYYY-MM-DDTHH:00:00Z' -- the UTC hour bucket of `now`. */
export function quotaPeriodHour(now: Date): string {
	return `${now.toISOString().slice(0, 13)}:00:00Z`;
}

function sumDimension(observed: readonly ObservedDimension[], key: string): number {
	return observed.reduce(
		(total, entry) => (entry.dimension_key === key ? total + entry.units : total),
		0,
	);
}

const UPSERT_USAGE_SQL = `
INSERT INTO quota_client_usage_hourly
	(period_hour, client_id, route, call_count, d1_rows_read, d1_rows_written, ai_neurons, vectorize_queries, created_at, updated_at)
VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
ON CONFLICT(period_hour, client_id, route) DO UPDATE SET
	call_count = call_count + 1,
	d1_rows_read = d1_rows_read + excluded.d1_rows_read,
	d1_rows_written = d1_rows_written + excluded.d1_rows_written,
	ai_neurons = ai_neurons + excluded.ai_neurons,
	vectorize_queries = vectorize_queries + excluded.vectorize_queries,
	updated_at = excluded.updated_at
`;

export interface ClientUsageInput {
	/** Catalog route string, e.g. 'mcp:search_documents_semantic'. */
	readonly route: string;
	/** Verified credential identity, or QUOTA_CLIENT_UNATTRIBUTED. */
	readonly client_id: string;
	/** Measured totals of the finished request (observers' output). */
	readonly observed: readonly ObservedDimension[];
	/** Instant of the accounting write; fixes the hour bucket. */
	readonly now: Date;
}

/**
 * Add one request's measured usage to the hourly aggregate.  Same
 * (hour, client, route) accumulates; hours/clients/routes never mix.  Throws on
 * D1 failure -- the caller's try-catch owns converting that into a log line.
 */
export async function recordClientUsage(
	db: QuotaMeteringDb,
	input: ClientUsageInput,
): Promise<void> {
	const nowIso = input.now.toISOString();
	await db
		.prepare(UPSERT_USAGE_SQL)
		.bind(
			quotaPeriodHour(input.now),
			input.client_id,
			input.route,
			sumDimension(input.observed, "d1.rows_read"),
			sumDimension(input.observed, "d1.rows_written"),
			// Estimated in-process (platform usage counter when present, else
			// conservative text-volume pricing); the 12h official meter stays
			// the circuit-breaker authority.
			sumDimension(input.observed, "ai.neurons"),
			// queried dimensions / 1024 = one query unit per search call.
			sumDimension(input.observed, "vectorize.queried_dims") / 1024,
			nowIso,
			nowIso,
		)
		.run();
}

/** One row of `quota_circuit_state` as the gate sees it. */
export interface QuotaCircuitRow {
	readonly dimension_key: string;
	readonly state: "CLOSED" | "OPEN";
	readonly current_usage: number;
	readonly threshold_95: number;
	readonly as_of: string;
}

/**
 * Read the circuit rows for `dimensionKeys`.  Rows the table does not hold are
 * simply absent (absence = CLOSED by construction).  Throws on D1 failure; the
 * gate wrapper below owns the fail-open catch.
 */
export async function readCircuitStates(
	db: QuotaMeteringDb,
	dimensionKeys: readonly string[],
): Promise<QuotaCircuitRow[]> {
	const placeholders = dimensionKeys.map(() => "?").join(", ");
	const result = await db
		.prepare(
			`SELECT dimension_key, state, current_usage, threshold_95, as_of
			 FROM quota_circuit_state WHERE dimension_key IN (${placeholders})`,
		)
		.bind(...dimensionKeys)
		.all<{
			dimension_key: string;
			state: string;
			current_usage: number;
			threshold_95: number;
			as_of: string;
		}>();
	return (result.results ?? []).map((row) => ({
		dimension_key: row.dimension_key,
		// Anything that is not exactly OPEN is treated as CLOSED (fail-safe for
		// the business call; only the reconcile program writes this table).
		state: row.state === "OPEN" ? "OPEN" : "CLOSED",
		current_usage: Number(row.current_usage),
		threshold_95: Number(row.threshold_95),
		as_of: row.as_of,
	}));
}

/** Structured refusal payload returned by the guarded semantic tool. */
export interface QuotaCircuitRefusal {
	readonly error_code: "QUOTA_CIRCUIT_OPEN";
	readonly retryable: false;
	readonly request_id: string;
	readonly open_dimensions: readonly {
		readonly dimension_key: string;
		readonly current_usage: number;
		readonly threshold_95: number;
		readonly as_of: string;
	}[];
	readonly message: string;
}

/**
 * The ONE surviving gate: refuse `mcp:search_documents_semantic` when the
 * reconcile program has marked any of its circuit dimensions OPEN.
 *
 * Returns null (allow) when no row is OPEN AND when the gate itself cannot be
 * read (missing binding, missing table, D1 outage) -- a broken breaker must
 * never recreate the front-gate outage class.  Refusals are logged here so the
 * operator sees exactly which dimension tripped.
 */
export async function semanticSearchCircuitRefusal(
	db: QuotaMeteringDb | null | undefined,
): Promise<QuotaCircuitRefusal | null> {
	if (!db) return null;
	try {
		const rows = await readCircuitStates(db, SEMANTIC_SEARCH_CIRCUIT_DIMENSIONS);
		const open = rows.filter((row) => row.state === "OPEN");
		if (open.length === 0) return null;
		const refusal: QuotaCircuitRefusal = {
			error_code: "QUOTA_CIRCUIT_OPEN",
			retryable: false,
			request_id: crypto.randomUUID().replaceAll("-", ""),
			open_dimensions: open.map((row) => ({
				dimension_key: row.dimension_key,
				current_usage: row.current_usage,
				threshold_95: row.threshold_95,
				as_of: row.as_of,
			})),
			message:
				"the 12h official-meter reconcile marked a guarded resource dimension OPEN; search_documents_semantic is paused until the circuit closes",
		};
		console.log(
			JSON.stringify({
				event: "quota_circuit_open_refusal",
				timestamp: new Date().toISOString(),
				request_id: refusal.request_id,
				open_dimensions: refusal.open_dimensions,
			}),
		);
		return refusal;
	} catch {
		// Fail open: gate-read failure is never a refusal.
		return null;
	}
}
