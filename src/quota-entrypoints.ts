/**
 * Entrypoint cost catalog (post-redesign directory, 2026-10-02).
 *
 * The catalog is the single place where every reachable entrypoint (HTTP path,
 * MCP tool, Cron expression, OAuth route) is classified together with the paid
 * dimensions it can touch.  Since the front admission gate was removed (quota
 * redesign, spec section 1.1) this catalog has NO admission authority and
 * NOTHING is refused because of it: the declared dimensions and caps are the
 * dimension-aggregation vocabulary the post-hoc accounting middleware
 * (`quota_client_usage_hourly`, Phase 2) reuses to bucket measured usage per
 * route.
 *
 * `tests/quota-entrypoints.test.mjs` enumerates the real registrations out of
 * `src/index.ts` / `src/oauth-*.ts` / `wrangler.jsonc` and fails when a route or
 * tool is missing here -- a new unclassified entrypoint cannot ship silently.
 *
 * Classes (informational, for accounting priority -- never a gate):
 *   control          - inbound bookkeeping only; no Collector paid resource.
 *   light_read       - keyed read with a small declared D1 row bound.
 *   heavy_bounded    - touches paid dimensions with declared per-call caps.
 *   heavy_unbounded  - touches dimensions without a per-call bound (unbounded
 *                      scan, Vectorize stock).  Informational only.
 */

import type { DimensionKey } from "./quota-dimensions.ts";

export type EntrypointKind = "http" | "mcp_tool" | "cron" | "oauth";

export type RouteCostClass = "control" | "light_read" | "heavy_bounded" | "heavy_unbounded";

/** One declared paid dimension with its per-call cap, in catalog units. */
export interface RouteDimension {
	readonly dimension_key: DimensionKey;
	readonly units: number;
}

export interface RouteCostProfile {
	readonly route: string;
	readonly kind: EntrypointKind;
	readonly cost_class: RouteCostClass;
	/** Declared per-call dimension caps; used by the accounting middleware. */
	readonly dimensions: readonly RouteDimension[];
	readonly note: string;
}

function profile(
	kind: EntrypointKind,
	route: string,
	cost_class: RouteCostClass,
	dimensions: readonly RouteDimension[],
	note: string,
): RouteCostProfile {
	return { route, kind, cost_class, dimensions, note };
}

const d1Read = (units: number): RouteDimension => ({ dimension_key: "d1.rows_read", units });
const d1Write = (units: number): RouteDimension => ({
	dimension_key: "d1.rows_written",
	units,
});
const r2A = (units: number): RouteDimension => ({ dimension_key: "r2.class_a", units });
const r2B = (units: number): RouteDimension => ({ dimension_key: "r2.class_b", units });

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
		"replica ingest: journal+object R2 writes and one D1 batch per record. Declared caps are the accounting aggregation hints; actual usage is observed post-hoc by the pure resource observers.",
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
		"control",
		[],
		"SEALED (quota redesign 2026-10-02, G2): cloud batch embedding is permanently disabled and the route returns a structured pointer to the local RTX 5080 GPU pipeline; zero Workers AI calls",
	),
	profile(
		"http",
		"http:/internal/research-semantic-index/pending",
		"light_read",
		[d1Read(500_000)],
		"read-only cursor page of at most 128 already-registered versions using the forced (state,document,version) index; the local GPU pipeline polls this to plan its embedding work",
	),
	profile(
		"http",
		"http:/internal/research-semantic-index/ingest-vectors",
		"heavy_bounded",
		[d1Read(500), d1Write(300)],
		"locally-computed embeddings (owner approved 2026-09-30): zero Workers AI cost; the declaration covers the state-row read/write and one Vectorize upsert per document; Vectorize stored-dimension growth stays on the direct binding",
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
		"deployment probe read (one single-query embedding, operator-triggered only)",
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
	{ cost_class: RouteCostClass; dimensions: readonly RouteDimension[]; note: string }
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
		dimensions: [d1Read(32)],
		note: "semantic query: one bge-m3 query embedding (<1 Neuron, the ONLY remaining cloud AI spend) + one 1024-dim index query + index lookups; the single-shot query-to-vector path is preserved untouched (quota redesign 2026-10-02)",
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
		"daily retention sweep: unbounded documents scan plus Vectorize deletion",
	),
	profile(
		"cron",
		"cron:40 16 * * *",
		"control",
		[],
		"SEALED (quota redesign 2026-10-02, G2): registration kept so the cron catalog stays complete, but the handler is a structured no-op log; cloud batch embedding belongs to the local GPU pipeline",
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
