/**
 * Entrypoint coverage tests (post gate-removal directory, 2026-10-02).
 *
 * The catalog has NO admission authority any more -- nothing is refused because
 * of it.  It survives as the cost/dimension directory the post-hoc accounting
 * middleware reuses for per-route dimension aggregation.  The coverage half
 * enumerates the REAL registrations out of `src/index.ts` / `src/oauth-*.ts` /
 * `wrangler.jsonc` and fails when a route, tool or cron is not classified, so a
 * new unclassified entrypoint cannot ship silently.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith("./") && !path.extname(specifier)) {
			try {
				return nextResolve(`${specifier}.ts`, context);
			} catch {
				// Fall back to the default resolver for other imports.
			}
		}
		return nextResolve(specifier, context);
	},
});

import {
	QUOTA_CRONS,
	QUOTA_ENTRYPOINTS,
	QUOTA_HTTP_ROUTES,
	QUOTA_MCP_TOOLS,
	missingEntrypoints,
	routeCostProfile,
	unclassifiedEntrypoints,
} from "../src/quota-breaker.ts";

async function source(path) {
	return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

const SOURCE_FILES = ["src/index.ts", "src/oauth-entry.ts", "src/oauth-diagnostics-entry.ts"];

async function observedHttpRoutes() {
	const routes = new Set();
	for (const file of SOURCE_FILES) {
		const text = await source(file);
		for (const match of text.matchAll(/url\.pathname === "([^"]+)"/g)) {
			routes.add(`${file.includes("oauth") ? "oauth" : "http"}:${match[1]}`);
		}
	}
	return [...routes].sort();
}

async function observedTools() {
	const text = await source("src/index.ts");
	return [...text.matchAll(/registerTool\(\s*"([a-z_0-9]+)"/g)]
		.map((match) => `mcp:${match[1]}`)
		.sort();
}

async function observedCrons() {
	const text = await source("wrangler.jsonc");
	const block = text.slice(text.indexOf('"crons"'), text.indexOf("]", text.indexOf('"crons"')));
	return [...block.matchAll(/"([^"]*\*[^"]*)"/g)].map((match) => `cron:${match[1]}`).sort();
}

test("every HTTP/OAuth path in the source is classified in the cost catalog", async () => {
	const observed = await observedHttpRoutes();
	assert.ok(observed.length >= 15, `expected the full route surface, saw ${observed.length}`);
	assert.deepEqual(
		unclassifiedEntrypoints(observed),
		[],
		"unclassified entrypoints must fail the gate",
	);
	assert.deepEqual(
		missingEntrypoints(observed, "http"),
		[],
		"the catalog must not describe HTTP routes that no longer exist",
	);
	assert.deepEqual(
		missingEntrypoints(observed, "oauth"),
		[],
		"the catalog must not describe OAuth routes that no longer exist",
	);
});

test("every MCP tool in the source is classified, and the catalog has no extra tools", async () => {
	const observed = await observedTools();
	assert.equal(observed.length, 39, "the registered tool count changed; classify the new tool");
	assert.deepEqual(unclassifiedEntrypoints(observed), []);
	assert.deepEqual(missingEntrypoints(observed, "mcp_tool"), []);
});

test("every Cron expression in wrangler.jsonc is classified", async () => {
	const observed = await observedCrons();
	assert.ok(observed.length >= 5);
	assert.deepEqual(unclassifiedEntrypoints(observed), []);
	assert.deepEqual(missingEntrypoints(observed, "cron"), []);
	assert.equal(
		QUOTA_CRONS.filter((entry) => entry.cost_class === "heavy_unbounded").length,
		1,
		"the retention sweep must be the only bounded-but-unprovable cron",
	);
});

test("declared dimension caps survive as the accounting aggregation vocabulary", () => {
	const ingest = routeCostProfile("http:/internal/research-replica/v2/ingest");
	assert.equal(ingest?.cost_class, "heavy_bounded");
	assert.deepEqual(
		ingest.dimensions
			.map((dimension) => [dimension.dimension_key, dimension.units])
			.sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
		[
			["d1.rows_read", 10_000],
			["d1.rows_written", 1_000],
			["r2.class_a", 4],
			["r2.class_b", 4],
		],
		"per-route dimension declarations are what the accounting middleware aggregates",
	);
	for (const route of [
		"mcp:submit_research_result_proposal",
		"mcp:append_state_batch",
		"mcp:search_documents",
	]) {
		assert.equal(routeCostProfile(route)?.cost_class, "heavy_bounded", route);
	}
	// The semantic query face keeps its read-cap declaration: the single-shot
	// query-to-vector path is the ONLY remaining cloud AI spend and stays
	// untouched (quota redesign 2026-10-02).
	assert.deepEqual(
		routeCostProfile("mcp:search_documents_semantic").dimensions.map(
			(dimension) => [dimension.dimension_key, dimension.units],
		),
		[["d1.rows_read", 32]],
	);
	for (const route of ["mcp:get_state_snapshot", "mcp:get_gateway_status"]) {
		assert.equal(routeCostProfile(route)?.cost_class, "light_read", route);
		assert.ok((routeCostProfile(route)?.dimensions.length ?? 0) > 0, route);
	}
	const unbounded = QUOTA_ENTRYPOINTS.filter((entry) => entry.cost_class === "heavy_unbounded");
	assert.ok(unbounded.length >= 1, "retention keeps its unbounded scan");
	for (const entry of unbounded) {
		assert.equal(entry.dimensions.length, 0, `${entry.route} must not claim a bound`);
	}
	assert.equal(
		routeCostProfile("http:/internal/research-retention/run")?.cost_class,
		"heavy_unbounded",
		"retention keeps its unbounded scan",
	);
});

test("cloud batch AI routes are reclassified as sealed control routes with zero AI dims", () => {
	// G2 (quota redesign 2026-10-02): the run route and the 40 16 * * * cron are
	// physically sealed -- they may no longer carry an ai.neurons declaration,
	// because nothing on those paths can spend neurons any more.
	const run = routeCostProfile("http:/internal/research-semantic-index/run");
	assert.equal(run?.cost_class, "control", "the sealed run route is control-class");
	assert.deepEqual(run.dimensions, [], "a sealed route must not declare AI dimensions");
	assert.match(run.note, /SEALED|sealed/);
	const cron = routeCostProfile("cron:40 16 * * *");
	assert.equal(cron?.cost_class, "control", "the sealed cron is control-class");
	assert.deepEqual(cron.dimensions, []);
	assert.match(cron.note, /no-op/);
});

test("the local-embedding ingest route is bounded and AI-free", () => {
	const route = routeCostProfile("http:/internal/research-semantic-index/ingest-vectors");
	assert.equal(route?.cost_class, "heavy_bounded");
	assert.deepEqual(
		route.dimensions.map((dimension) => [dimension.dimension_key, dimension.units]),
		[
			["d1.rows_read", 500],
			["d1.rows_written", 300],
		],
		"local vectors cost zero neurons; only the D1 work is declared",
	);
});

test("every heavy tool handler is behind a scope guard or research gate", async () => {
	const text = await source("src/index.ts");
	const chunks = text.split("registerTool(");
	const bodies = new Map();
	for (const chunk of chunks.slice(1)) {
		const name = chunk.match(/^\s*"([a-z_0-9]+)"/);
		if (name) bodies.set(name[1], chunk);
	}
	const guardPattern =
		/(require[A-Za-z]*Scope|isStateScopeAuthorized|requireMarketLedgerAppend|requireResearchScope|researchRead\(|researchWrite|researchDomain\()/;
	for (const entry of QUOTA_MCP_TOOLS) {
		if (entry.cost_class !== "heavy_bounded") continue;
		const toolName = entry.route.slice("mcp:".length);
		const body = bodies.get(toolName);
		assert.ok(body, `registration for ${toolName} not found`);
		assert.match(body, guardPattern, `${toolName} has no scope/research gate`);
	}
});

test("the removed gate machinery appears nowhere in src (G1: no refusal path can return)", async () => {
	for (const file of [
		"src/index.ts",
		"src/quota-breaker.ts",
		"src/quota-admission.ts",
		"src/quota-entrypoints.ts",
		"src/quota-resource-adapters.ts",
		"src/oauth-diagnostics-entry.ts",
	]) {
		const text = await source(file);
		// Comments may NAME what was abolished (prose evidence); executable code
		// must not contain any of it.
		const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ 	]*\/\/.*$/gm, "");
		assert.doesNotMatch(code, /admissionMode\s*\(/, `${file}: no admissionMode call`);
		assert.doesNotMatch(code, /QUOTA_GUARD_UNAVAILABLE/, `${file}: no guard-unavailable code`);
		assert.doesNotMatch(code, /QUOTA_CIRCUIT_OPEN/, `${file}: no circuit-open code`);
		assert.doesNotMatch(code, /admitHeavyRouteForEnv/, `${file}: no route admission`);
		assert.doesNotMatch(code, /createGuarded(Ai|D1|R2|Vectorize)/, `${file}: no guarded wrapper`);
		assert.doesNotMatch(code, /BASELINE_COVERAGE_AGE_MS/, `${file}: no 26h baseline timeout`);
	}
	// The env switch itself is inert: setting it changes no behavior.
	const { default: worker } = await import("../src/index.ts");
	const response = await worker.fetch(
		new Request("https://collector.example/api/quote-universe"),
		{ QUOTA_ADMISSION_MODE: "enforce" },
		{},
	);
	const body = await response.json();
	assert.notEqual(
		body?.error_code,
		"QUOTA_GUARD_UNAVAILABLE",
		"the request must reach the handler (missing binding), never a quota refusal",
	);
});

test("the legacy day/31 prototype stays inert and cannot gate work", async () => {
	const text = await source("src/quota-breaker.ts");
	// Comments may quote the repealed rule; executable code must not contain it.
	const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ 	]*\/\/.*$/gm, "");
	assert.doesNotMatch(code, /\/\s*31/, "no month/31 divisor may survive in code");
	assert.doesNotMatch(code, /DEFAULT_READ_DAILY_LINE|DEFAULT_WRITE_DAILY_LINE/);
	assert.match(text, /legacyPrototypeGatesWork\(\): false/);
	const index = await source("src/index.ts");
	assert.doesNotMatch(
		index,
		/maybeReconcileQuota|reconcileQuotaFromAnalytics|recordQuotaUsage|meterD1/,
	);
	assert.match(index, /legacyBreakerFlag\(env\)/);
});

test("the entrypoint catalog covers both directions for HTTP routes", () => {
	const httpRoutes = QUOTA_HTTP_ROUTES.map((entry) => entry.route.split(":")[0]);
	assert.ok(httpRoutes.includes("http"));
	assert.ok(httpRoutes.includes("oauth"));
	for (const entry of QUOTA_HTTP_ROUTES) {
		assert.equal(routeCostProfile(entry.route)?.route, entry.route);
	}
	assert.equal(routeCostProfile("http:/not-a-real-route"), null);
	assert.ok(QUOTA_ENTRYPOINTS.length >= QUOTA_HTTP_ROUTES.length + QUOTA_MCP_TOOLS.length);
});

test("#54 error codes are decoupled: only the real ceiling is QUOTA_CIRCUIT_OPEN", () => {
	const limit = quotaRefusalBody("QUOTA_CIRCUIT_OPEN", "req-limit");
	const guard = quotaRefusalBody("QUOTA_GUARD_UNAVAILABLE", "req-guard");
	assert.match(limit.safe_message, /budget circuit|baseline/i);
	assert.match(guard.safe_message, /cannot prove a safe upper bound/i);
	assert.notEqual(limit.safe_message, guard.safe_message);
	// A read-cap / proof failure must never be presented as a spend circuit.
	assert.doesNotMatch(guard.safe_message, /95%|budget circuit/i);
});

test("#54 unknown routes still fall back to QUOTA_GUARD_UNAVAILABLE, never the circuit", async () => {
	const text = await source("src/index.ts");
	// The only place that may map to QUOTA_CIRCUIT_OPEN is the `limit` reason.
	assert.match(text, /result\.reason === "limit" \? "QUOTA_CIRCUIT_OPEN"/);
	assert.doesNotMatch(
		text,
		/result\.reason === "cap" \? "QUOTA_CIRCUIT_OPEN"/,
		"a live-row read cap must not be reported as the spend circuit",
	);
});

test("#54 the lifeline split is structural and exempts only payload-free envelopes", async () => {
	const { isLifelineEnvelope, runEnvelopeAdmissionRoute, LIFELINE_MAINTENANCE_RESERVE } =
		await import("../src/quota-entrypoints.ts");
	// Payload-free shapes: heartbeat, blocked_by report, read-only observations.
	assert.equal(isLifelineEnvelope({ task_name: "x", summary: "s" }), true);
	assert.equal(isLifelineEnvelope({ blocked_by: "PORTFOLIO_NOT_CONFIRMED" }), true);
	assert.equal(isLifelineEnvelope({ observations: { fresh_count: 3 } }), true);
	assert.equal(isLifelineEnvelope({ channel_payload: { channel: "INDUSTRY" } }), false);
	assert.equal(isLifelineEnvelope(null), false);
	assert.equal(isLifelineEnvelope(undefined), false);

	// Only submit_run_envelope has a lifeline route; every other heavy tool keeps
	// its full multi-dimension gate.
	const lifeline = runEnvelopeAdmissionRoute("mcp:submit_run_envelope", { summary: "s" });
	assert.equal(lifeline.exempt, true);
	assert.equal(lifeline.envelope_has_payload, false);
	const heavy = runEnvelopeAdmissionRoute("mcp:submit_run_envelope", {
		channel_payload: { channel: "INDUSTRY" },
	});
	assert.equal(heavy.exempt, false);
	assert.equal(heavy.envelope_has_payload, true);
	const other = runEnvelopeAdmissionRoute("mcp:append_state_batch", { summary: "s" });
	assert.equal(other.exempt, false);

	// The reported maintenance reserve is a real, non-zero, Collector-owned bound.
	assert.equal(LIFELINE_MAINTENANCE_RESERVE.dimension_key, "d1.rows_written");
	assert.ok(LIFELINE_MAINTENANCE_RESERVE.units > 0);
});
