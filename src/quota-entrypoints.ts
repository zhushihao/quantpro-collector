/**
 * Entrypoint cost catalog and the outward refusal contract (spec §"模块与接口
 * 清单" last two rows, §5 response contract).
 *
 * The catalog is the single place where every reachable entrypoint (HTTP path,
 * MCP tool, Cron expression, OAuth route) is classified. Candidate bounds are
 * not admission authority until the physical per-call upper bound is proven.
 * `tests/quota-entrypoints.test.mjs` enumerates the real
 * registrations out of `src/index.ts` / `src/oauth-*.ts` and fails when a route
 * or tool is missing here — a new unclassified entrypoint cannot ship silently.
 *
 * Classes:
 *   control          - inbound request bookkeeping; billed on arrival and cannot
 *                      be prevented from inside the Worker.  Declared as a known
 *                      gap, never presented as a guarantee.
 *   light_read       - keyed read with a declared D1 row bound; may degrade
 *                      safely, but is still billed.
 *   heavy_bounded    - declares every affected paid dimension with a provable
 *                      upper bound; must pass the admission ledger.
 *   heavy_unbounded  - no provable upper bound (unbounded scan, AI neurons,
 *                      Vectorize stock).  ALWAYS refused in enforce mode.
 */

import type { AdmissionDimension } from "./quota-admission.ts";

export type EntrypointKind = "http" | "mcp_tool" | "cron" | "oauth";

export type RouteCostClass = "control" | "light_read" | "heavy_bounded" | "heavy_unbounded";

export interface RouteCostProfile {
	readonly route: string;
	readonly kind: EntrypointKind;
	readonly cost_class: RouteCostClass;
	/** Declared per-call upper bounds; required for `heavy_bounded`. */
	readonly dimensions: readonly AdmissionDimension[];
	readonly note: string;
}

function profile(
	kind: EntrypointKind,
	route: string,
	cost_class: RouteCostClass,
	dimensions: readonly AdmissionDimension[],
	note: string,
): RouteCostProfile {
	// `heavy_bounded` declarations are CAP reservations: every declared unit count
	// exceeds any real per-call cost the handler can generate, so settlement can
	// only stay at or below the reservation and a batch of caps stays far below
	// the 95% headroom (owner 95%-per-product directive 2026-09-29).  Without a
	// VERIFIED baseline the ledger refuses exactly like an unbounded route.
	return { route, kind, cost_class, dimensions, note };
}

const d1Read = (units: number): AdmissionDimension => ({ dimension_key: "d1.rows_read", units });
const d1Write = (units: number): AdmissionDimension => ({
	dimension_key: "d1.rows_written",
	units,
});
const r2A = (units: number): AdmissionDimension => ({ dimension_key: "r2.class_a", units });
const r2B = (units: number): AdmissionDimension => ({ dimension_key: "r2.class_b", units });
const aiNeurons = (units: number): AdmissionDimension => ({ dimension_key: "ai.neurons", units });
const vectorizeQueried = (units: number): AdmissionDimension => ({
	dimension_key: "vectorize.queried_dims",
	units,
});

/** HTTP entrypoints served by `src/index.ts`, `src/oauth-entry.ts`, `src/oauth-diagnostics-entry.ts`. */
export const QUOTA_HTTP_ROUTES: readonly RouteCostProfile[] = [
	profile(
		"http",
		"http:/api/github-auth/probe",
		"control",
		[],
		"GitHub auth probe; no Collector paid resource beyond inbound billing",
	),
	profile(
		"http",
		"http:/api/github-auth/quote-universe",
		"light_read",
		[d1Read(8)],
		"D1-backed universe read",
	),
	profile(
		"http",
		"http:/api/github-auth/portfolio-status",
		"light_read",
		[d1Read(8)],
		"D1-backed status read",
	),
	profile(
		"http",
		"http:/api/control-plane-status",
		"light_read",
		[d1Read(8)],
		"read-only diagnostics",
	),
	profile(
		"http",
		"http:/api/quote-universe",
		"light_read",
		[d1Read(8)],
		"universe snapshot read",
	),
	profile(
		"http",
		"http:/api/public/quotes",
		"light_read",
		[],
		"upstream quote proxy; no Collector paid dimension",
	),
	profile(
		"http",
		"http:/api/portfolio-quotes",
		"light_read",
		[],
		"upstream quote proxy; no Collector paid dimension",
	),
	profile(
		"http",
		"http:/internal/research-replica/v2/ingest",
		"heavy_bounded",
		[d1Read(10_000), d1Write(1_000), r2A(4), r2B(4)],
		"replica ingest: journal+object R2 writes and one D1 batch per record. Caps, not estimates: the batch is keyed lookups plus bounded FTS/semantic maintenance, and even the full frozen backfill (~7.5k records x caps) stays under 0.5% of every monthly 95% headroom; real platform meta is observed by the guarded adapters and over-cap actuals keep the reservation and halt the route. In enforce mode no AI embedding is scheduled on this path.",
	),
	profile(
		"http",
		"http:/internal/research-replica/v2/receipts",
		"light_read",
		[d1Read(8)],
		"receipt read by message id",
	),
	profile(
		"http",
		"http:/internal/research-semantic-index/run",
		"heavy_bounded",
		[aiNeurons(940), d1Read(2_000), d1Write(1_000)],
		"embedding run with a daily neuron budget (owner approved 2026-09-30): handler clamps max_docs to SEMANTIC_BATCH_MAX_DOCS (10); 940 = 10 docs x 47-neuron document cap x 2x retry headroom; the daily booked ledger stops runs once the UTC-day 9,500 threshold would be crossed. Vectorize upserts grow stored dimensions (a stock dimension with no provable per-call bound, ~$0.01/month at this scale) and stay on the direct binding, as disclosed.",
	),
	profile(
		"http",
		"http:/internal/research-semantic-index/status",
		"light_read",
		[d1Read(16)],
		"index state read",
	),
	profile(
		"http",
		"http:/internal/research-semantic-index/probe",
		"light_read",
		[d1Read(16)],
		"deployment probe read",
	),
	profile(
		"http",
		"http:/internal/research-retention/run",
		"heavy_unbounded",
		[],
		"retention sweep combines an unbounded records scan with Vectorize stock deletion",
	),
	profile(
		"oauth",
		"oauth:/authorize",
		"control",
		[d1Read(32), d1Write(32)],
		"OAuth/KV table writes served from D1",
	),
	profile(
		"oauth",
		"oauth:/oauth/token",
		"control",
		[d1Read(32), d1Write(32)],
		"token issue/refresh writes",
	),
	profile(
		"oauth",
		"oauth:/mcp",
		"control",
		[d1Read(16)],
		"dispatch to the MCP surface; per-tool class applies",
	),
	profile(
		"oauth",
		"oauth:/__oauth_diag/latest",
		"light_read",
		[d1Read(8), d1Write(4)],
		"diagnostic D1 writes are billed",
	),
];

/** MCP tools registered in `src/index.ts` (enumerated by the coverage test). */
const TOOL_CLASSES: Record<
	string,
	{ cost_class: RouteCostClass; dimensions: readonly AdmissionDimension[]; note: string }
> = {
	calculate: {
		cost_class: "light_read",
		dimensions: [],
		note: "connectivity probe; no paid dimension",
	},
	get_portfolio_quotes: {
		cost_class: "light_read",
		dimensions: [],
		note: "upstream quote proxy",
	},
	get_public_quotes: { cost_class: "light_read", dimensions: [], note: "upstream quote proxy" },
	get_control_plane_status: {
		cost_class: "light_read",
		dimensions: [],
		note: "read-only status",
	},
	get_state_snapshot: { cost_class: "light_read", dimensions: [d1Read(32)], note: "ledger read" },
	read_state_snapshot: {
		cost_class: "light_read",
		dimensions: [d1Read(32)],
		note: "ledger read",
	},
	read_state_snapshot_v2: {
		cost_class: "light_read",
		dimensions: [d1Read(32)],
		note: "ledger read",
	},
	append_company_events: {
		cost_class: "heavy_bounded",
		dimensions: [d1Read(32), d1Write(32)],
		note: "ledger append",
	},
	append_industry_events: {
		cost_class: "heavy_bounded",
		dimensions: [d1Read(32), d1Write(32)],
		note: "ledger append",
	},
	append_close_events: {
		cost_class: "heavy_bounded",
		dimensions: [d1Read(32), d1Write(32)],
		note: "ledger append",
	},
	append_market_observation: {
		cost_class: "heavy_bounded",
		dimensions: [d1Read(32), d1Write(32)],
		note: "ledger append",
	},
	submit_run_envelope: {
		cost_class: "heavy_bounded",
		dimensions: [d1Read(32), d1Write(32)],
		note: "ledger append",
	},
	validate_state_batch: {
		cost_class: "light_read",
		dimensions: [d1Read(16)],
		note: "validation only",
	},
	append_state_batch: {
		cost_class: "heavy_bounded",
		dimensions: [d1Read(64), d1Write(64)],
		note: "state gateway write",
	},
	begin_run: {
		cost_class: "heavy_bounded",
		dimensions: [d1Read(16), d1Write(16)],
		note: "run audit write",
	},
	end_run: {
		cost_class: "heavy_bounded",
		dimensions: [d1Read(16), d1Write(16)],
		note: "run audit write",
	},
	record_automation_run: {
		cost_class: "heavy_bounded",
		dimensions: [d1Read(16), d1Write(16)],
		note: "run audit write",
	},
	get_automation_run_history: {
		cost_class: "light_read",
		dimensions: [d1Read(32)],
		note: "run audit read",
	},
	get_production_health_snapshot: {
		cost_class: "light_read",
		dimensions: [d1Read(32)],
		note: "#50 bounded read-only health projection",
	},
	submit_issue_bookkeeping: {
		cost_class: "heavy_bounded",
		dimensions: [d1Read(16), d1Write(16)],
		note: "issue #52 controlled bookkeeping: one dedupe read+write; the GitHub call is not a D1 dimension",
	},
	get_state_write_receipt: {
		cost_class: "light_read",
		dimensions: [d1Read(16)],
		note: "receipt read",
	},
	get_gateway_status: {
		cost_class: "light_read",
		dimensions: [d1Read(16)],
		note: "gateway diagnostics",
	},
	get_market_checkpoints: {
		cost_class: "light_read",
		dimensions: [d1Read(32)],
		note: "checkpoint read",
	},
	append_market_checkpoint: {
		cost_class: "heavy_bounded",
		dimensions: [d1Read(32), d1Write(32)],
		note: "checkpoint write",
	},
	search_documents: {
		cost_class: "heavy_bounded",
		dimensions: [d1Read(128)],
		note: "FTS index read",
	},
	get_document: { cost_class: "light_read", dimensions: [d1Read(16)], note: "document read" },
	search_documents_semantic: {
		cost_class: "heavy_bounded",
		dimensions: [d1Read(32), aiNeurons(94), vectorizeQueried(1_024)],
		note: "semantic query: one bge-m3 embedding + one 1024-dim index query + index lookups. aiNeurons(94) derives from the owner-approved 47-neuron per-document unit (see the index run entry) x 2x retry headroom — a single query embeds at most one document equivalent; vectorizeQueried(1024) is the index dimensionality x exactly one query per call. Read face: admitted on arrival, billed by declaration.",
	},
	search_evidence: { cost_class: "light_read", dimensions: [d1Read(32)], note: "evidence read" },
	get_evidence: { cost_class: "light_read", dimensions: [d1Read(16)], note: "evidence read" },
	get_theme_accumulator: {
		cost_class: "light_read",
		dimensions: [d1Read(16)],
		note: "accumulator read",
	},
	get_company_evidence_state: {
		cost_class: "light_read",
		dimensions: [d1Read(16)],
		note: "accumulator read",
	},
	get_coverage_status: {
		cost_class: "light_read",
		dimensions: [d1Read(32)],
		note: "coverage read",
	},
	get_source_health: {
		cost_class: "light_read",
		dimensions: [d1Read(32)],
		note: "source health read",
	},
	get_market_signal_state: {
		cost_class: "light_read",
		dimensions: [d1Read(16)],
		note: "market signal read",
	},
	list_research_jobs: {
		cost_class: "light_read",
		dimensions: [d1Read(64)],
		note: "job index read",
	},
	get_research_job_context: {
		cost_class: "light_read",
		dimensions: [d1Read(32)],
		note: "job context read",
	},
	claim_research_job: {
		cost_class: "heavy_bounded",
		dimensions: [d1Read(32), d1Write(32)],
		note: "lease claim write",
	},
	submit_research_result_proposal: {
		cost_class: "heavy_bounded",
		dimensions: [d1Read(32), d1Write(32), r2A(2)],
		note: "proposal write plus durable journal object",
	},
	defer_research_job: {
		cost_class: "heavy_bounded",
		dimensions: [d1Read(32), d1Write(32)],
		note: "lease defer write",
	},
};

export const QUOTA_MCP_TOOLS: readonly RouteCostProfile[] = Object.entries(TOOL_CLASSES).map(
	([tool, value]) =>
		profile("mcp_tool", `mcp:${tool}`, value.cost_class, value.dimensions, value.note),
);

/** Cron expressions from `wrangler.jsonc`.  `30 20 * * *` is the retention sweep. */
export const QUOTA_CRONS: readonly RouteCostProfile[] = [
	profile(
		"cron",
		"cron:55 0 * * mon-fri",
		"control",
		[],
		"quote bridge schedule; upstream calls only",
	),
	profile("cron", "cron:39,44,49 1,2,3,5,6 * * mon-fri", "control", [], "quote bridge schedule"),
	profile("cron", "cron:24,29,54,59 7 * * mon-fri", "control", [], "quote bridge schedule"),
	profile("cron", "cron:4,9,24,29 8 * * mon-fri", "control", [], "quote bridge schedule"),
	profile(
		"cron",
		"cron:30 20 * * *",
		"heavy_unbounded",
		[],
		"daily retention sweep: unbounded documents scan plus Vectorize deletion; must report a structured skip",
	),
];

export const QUOTA_ENTRYPOINTS: readonly RouteCostProfile[] = [
	...QUOTA_HTTP_ROUTES,
	...QUOTA_MCP_TOOLS,
	...QUOTA_CRONS,
];

const BY_ROUTE = new Map(QUOTA_ENTRYPOINTS.map((entry) => [entry.route, entry]));

export function routeCostProfile(route: string): RouteCostProfile | null {
	return BY_ROUTE.get(route) ?? null;
}

/**
 * Catalog routes of a kind that are absent from `observed`, and separately the
 * observed routes that the catalog does not classify.  Both directions matter: a
 * deleted route must be removed from the catalog, and a new route must be
 * classified before it can run.
 */
export function missingEntrypoints(observed: readonly string[], kind?: EntrypointKind): string[] {
	const seen = new Set(observed);
	return QUOTA_ENTRYPOINTS.filter((entry) => (kind ? entry.kind === kind : true))
		.filter((entry) => !seen.has(entry.route))
		.map((entry) => entry.route);
}

export function unclassifiedEntrypoints(observed: readonly string[]): string[] {
	return observed.filter((route) => !BY_ROUTE.has(route));
}

// ---------------------------------------------------------------------------
// Outward refusal contract (spec §5)
// ---------------------------------------------------------------------------

export type QuotaRefusalErrorCode = "QUOTA_CIRCUIT_OPEN" | "QUOTA_GUARD_UNAVAILABLE";

export interface QuotaRefusalBody {
	readonly error_code: QuotaRefusalErrorCode;
	readonly safe_message: string;
	readonly retryable: boolean;
	readonly request_id: string;
}

/**
 * Safe messages.  Deliberately free of any "UTC day reset" promise: the monthly
 * period can only be re-opened when a verified account baseline for the next
 * period exists, and no automated recovery instant can be proven today.
 */
const REFUSAL_MESSAGES: Record<QuotaRefusalErrorCode, string> = {
	QUOTA_CIRCUIT_OPEN:
		"platform usage budget circuit is open; heavy work is paused until an operator verifies the account baseline",
	QUOTA_GUARD_UNAVAILABLE:
		"usage guard cannot prove a safe upper bound; heavy work is paused until the guard is available",
};

export function quotaRefusalBody(
	errorCode: QuotaRefusalErrorCode,
	requestId: string,
	options: { retryable?: boolean } = {},
): QuotaRefusalBody {
	return {
		error_code: errorCode,
		safe_message: REFUSAL_MESSAGES[errorCode],
		retryable: options.retryable ?? false,
		request_id: requestId,
	};
}

export interface SafeHttpRefusal {
	readonly status: 503;
	readonly body: QuotaRefusalBody;
	/** Only present when the recovery instant is provable from a verified baseline. */
	readonly retry_after_seconds: number | null;
}

export function quotaHttpRefusal(
	errorCode: QuotaRefusalErrorCode,
	requestId: string,
	provenRecoveryAt: Date | null = null,
	now = new Date(),
): SafeHttpRefusal {
	let retryAfter: number | null = null;
	if (provenRecoveryAt && Number.isFinite(provenRecoveryAt.getTime())) {
		const seconds = Math.ceil((provenRecoveryAt.getTime() - now.getTime()) / 1000);
		if (seconds > 0) retryAfter = seconds;
	}
	return {
		status: 503,
		body: quotaRefusalBody(errorCode, requestId, { retryable: retryAfter !== null }),
		retry_after_seconds: retryAfter,
	};
}

/** MCP tools keep the existing envelope: `isError: true` plus the machine-readable body. */
export function quotaMcpRefusal(
	errorCode: QuotaRefusalErrorCode,
	requestId: string,
): { isError: true; content: Array<{ type: "text"; text: string }> } {
	return {
		isError: true,
		content: [
			{ type: "text", text: JSON.stringify(quotaRefusalBody(errorCode, requestId), null, 2) },
		],
	};
}

export type CronQuotaOutcome =
	| { readonly status: "skipped"; readonly reason: QuotaRefusalErrorCode; readonly task: string }
	| { readonly status: "failed"; readonly reason: QuotaRefusalErrorCode; readonly task: string };

/** Cron must never fabricate a success receipt when the guard refuses the work. */
export function cronQuotaOutcome(errorCode: QuotaRefusalErrorCode, task: string): CronQuotaOutcome {
	return errorCode === "QUOTA_CIRCUIT_OPEN"
		? { status: "skipped", reason: errorCode, task }
		: { status: "failed", reason: errorCode, task };
}
