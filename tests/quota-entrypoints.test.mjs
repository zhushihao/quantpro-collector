/**
 * Entrypoint coverage + outward refusal contract tests (SDD CQ spec P0-C, G01/G02
 * "entrypoint matrix" evidence).
 *
 * The coverage half enumerates the REAL registrations out of the source and fails
 * when a route, tool or cron is not classified in `src/quota-entrypoints.ts`, so a
 * new unclassified entrypoint cannot ship silently (the spec forbids "only gate
 * ingest/retention").  The contract half pins the 503/isError/skipped behaviour
 * and the absence of any UTC-reset promise.
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
	cronQuotaOutcome,
	missingEntrypoints,
	quotaHttpRefusal,
	quotaMcpRefusal,
	quotaRefusalBody,
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
	assert.equal(observed.length, 38, "the registered tool count changed; classify the new tool");
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

test("cap-reserved routes admit through the ledger; unproven AI/vectorize/retention stay unbounded", () => {
	const ingest = routeCostProfile("http:/internal/research-replica/v2/ingest");
	assert.equal(ingest?.cost_class, "heavy_bounded", "ingest must run behind the ledger");
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
		"per-record caps must exceed any real per-record cost; batch x cap stays far below the 95% headroom",
	);
	// Keyed ledger tools keep their declared caps: without a VERIFIED baseline they
	// are refused exactly like before, with a baseline they pay their own way.
	for (const route of [
		"mcp:submit_research_result_proposal",
		"mcp:append_state_batch",
		"mcp:search_documents",
	]) {
		assert.equal(routeCostProfile(route)?.cost_class, "heavy_bounded", route);
	}
	// Keyed reads are light_read with declared caps: never refused by the guard,
	// always billed on arrival.
	for (const route of ["mcp:get_state_snapshot", "mcp:get_gateway_status"]) {
		assert.equal(routeCostProfile(route)?.cost_class, "light_read", route);
		assert.ok((routeCostProfile(route)?.dimensions.length ?? 0) > 0, route);
	}
	const unbounded = QUOTA_ENTRYPOINTS.filter((entry) => entry.cost_class === "heavy_unbounded");
	assert.ok(unbounded.length >= 2, "AI/vectorize/retention paths must be explicitly unbounded");
	for (const entry of unbounded) {
		assert.equal(entry.dimensions.length, 0, `${entry.route} must not claim a bound`);
	}
	assert.equal(
		routeCostProfile("http:/internal/research-semantic-index/run")?.cost_class,
		"heavy_unbounded",
		"embedding has no provable neuron bound",
	);
	assert.equal(
		routeCostProfile("http:/internal/research-retention/run")?.cost_class,
		"heavy_unbounded",
		"retention keeps its unbounded scan",
	);
});

test("every admitted heavy tool handler is behind a scope guard or research gate", async () => {
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

test("enforce mode does not refuse a declared light_read; an unclassified route would 503", async () => {
	const { default: worker } = await import("../src/index.ts");
	const response = await worker.fetch(
		new Request("https://collector.example/api/quote-universe"),
		{ QUOTA_ADMISSION_MODE: "enforce" },
		{},
	);
	// /api/quote-universe is light_read with a declared cap: the guard no longer
	// downgrades it, so the request reaches the handler (which fails on the
	// missing binding, not on quota).  Any quota refusal here would be a
	// regression to the blanket downgrade.
	const body = await response.json();
	assert.notEqual(body?.error_code, "QUOTA_GUARD_UNAVAILABLE");
});

test("the legacy day/31 prototype is inert and cannot gate work", async () => {
	const text = await source("src/quota-breaker.ts");
	// Comments may quote the repealed rule; executable code must not contain it.
	const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ 	]*\/\/.*$/gm, "");
	assert.doesNotMatch(code, /\/\s*31/, "no month/31 divisor may survive in code");
	assert.doesNotMatch(code, /DEFAULT_READ_DAILY_LINE|DEFAULT_WRITE_DAILY_LINE/);
	assert.match(text, /legacyPrototypeGatesWork\(\): false/);
	const index = await source("src/index.ts");
	assert.doesNotMatch(
		index,
		/maybeReconcileQuota|reconcileQuotaFromAnalytics|recordQuotaUsage|meterD1/,
	);
	assert.match(index, /legacyBreakerFlag\(env\)/);
});

test("HTTP refusals are 503 with the fixed four-key body and no fabricated Retry-After", () => {
	const refusal = quotaHttpRefusal("QUOTA_CIRCUIT_OPEN", "req-1", null);
	assert.equal(refusal.status, 503);
	assert.equal(refusal.retry_after_seconds, null);
	assert.deepEqual(Object.keys(refusal.body).sort(), [
		"error_code",
		"request_id",
		"retryable",
		"safe_message",
	]);
	assert.equal(refusal.body.error_code, "QUOTA_CIRCUIT_OPEN");

	const timed = quotaHttpRefusal(
		"QUOTA_CIRCUIT_OPEN",
		"req-2",
		new Date("2026-09-20T01:00:00.000Z"),
		new Date("2026-09-20T00:00:00.000Z"),
	);
	assert.equal(timed.retry_after_seconds, 3600, "a proven recovery instant may be reported");
	assert.equal(timed.body.retryable, true);

	const past = quotaHttpRefusal(
		"QUOTA_CIRCUIT_OPEN",
		"req-3",
		new Date("2026-09-19T00:00:00.000Z"),
		new Date("2026-09-20T00:00:00.000Z"),
	);
	assert.equal(past.retry_after_seconds, null, "a past instant is not a retry promise");
});

test("refusal messages never promise a UTC-day reset and are distinct per code", () => {
	for (const code of ["QUOTA_CIRCUIT_OPEN", "QUOTA_GUARD_UNAVAILABLE"]) {
		const body = quotaRefusalBody(code, "req");
		assert.doesNotMatch(body.safe_message, /UTC|utc|midnight|day reset/i);
		assert.doesNotMatch(body.safe_message, /429|rate limit/i);
	}
	assert.notEqual(
		quotaRefusalBody("QUOTA_CIRCUIT_OPEN", "x").safe_message,
		quotaRefusalBody("QUOTA_GUARD_UNAVAILABLE", "x").safe_message,
	);
	assert.equal(quotaRefusalBody("QUOTA_CIRCUIT_OPEN", "x").retryable, false);
	assert.equal(quotaRefusalBody("QUOTA_GUARD_UNAVAILABLE", "x").retryable, false);
});

test("MCP refusals keep the envelope with isError true and a machine-readable code", () => {
	const refusal = quotaMcpRefusal("QUOTA_GUARD_UNAVAILABLE", "req-7");
	assert.equal(refusal.isError, true);
	const body = JSON.parse(refusal.content[0].text);
	assert.equal(body.error_code, "QUOTA_GUARD_UNAVAILABLE");
	assert.equal(body.request_id, "req-7");
	assert.ok(!("quota" in body));
});

test("Cron refusals are structured skipped/failed outcomes, never a success receipt", () => {
	const skipped = cronQuotaOutcome("QUOTA_CIRCUIT_OPEN", "research_retention");
	assert.deepEqual(skipped, {
		status: "skipped",
		reason: "QUOTA_CIRCUIT_OPEN",
		task: "research_retention",
	});
	const failed = cronQuotaOutcome("QUOTA_GUARD_UNAVAILABLE", "research_retention");
	assert.equal(failed.status, "failed");
});

test("the outbound error contract exposes both quota codes without a reset promise", async () => {
	const text = await source("src/research-outbound-v2.ts");
	assert.match(text, /QUOTA_CIRCUIT_OPEN:/);
	assert.match(text, /QUOTA_GUARD_UNAVAILABLE:/);
	assert.doesNotMatch(text, /retry after UTC day reset/);
	assert.doesNotMatch(text, /daily platform budget circuit/);
});

test("the entrypoint catalog covers both directions for HTTP routes", () => {
	const httpRoutes = QUOTA_HTTP_ROUTES.map((entry) => entry.route.split(":")[0]);
	assert.ok(httpRoutes.includes("http"));
	assert.ok(httpRoutes.includes("oauth"));
	for (const entry of QUOTA_HTTP_ROUTES) {
		assert.equal(routeCostProfile(entry.route)?.route, entry.route);
	}
	assert.equal(routeCostProfile("http:/not-a-real-route"), null);
});
