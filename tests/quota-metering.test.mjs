/**
 * Phase 2 quota metering tests (quota redesign 2026-10-02, spec sections 1/3).
 *
 * Everything here runs on SYNTHETIC data: the real migration chain (now
 * including 0021) executes on the node:sqlite shim, and Workers AI / Vectorize /
 * R2 are deterministic in-memory fakes.  Contracts proven:
 *   - hourly UPSERT aggregation accumulates per (hour, client, route);
 *   - the single surviving gate refuses `search_documents_semantic` with a
 *     structured QUOTA_CIRCUIT_OPEN payload when a guarded dimension is OPEN,
 *     and fails OPEN when the gate itself cannot be read;
 *   - lifeline tools never consult the circuit table;
 *   - a metering write failure never reaches a business response;
 *   - client_id comes only from a verified credential identity (unattributed
 *     otherwise); IP headers are never an identity input.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith("./") && !path.extname(specifier)) {
			try {
				return nextResolve(`${specifier}.ts`, context);
			} catch {
				// Let the default resolver report the original error for non-TS imports.
			}
		}
		return nextResolve(specifier, context);
	},
});

const metering = await import("../src/quota-metering.ts");
const adapters = await import("../src/quota-resource-adapters.ts");
const indexModule = await import("../src/index.ts");
const worker = indexModule.default;
const { createServer, scheduleQuotaMetering } = indexModule;
const { createResearchWorkflowDb } = await import("./helpers/d1-sqlite-shim.mjs");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

const AS_OF = "2026-10-02T00:05:00.000Z";
const ENCODER = new TextEncoder();
const NOW = "2026-10-02T00:00:00.000Z";

function sha256HexOf(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Seed one synthetic PUBLIC document version the way the C5 ingest leaves it
 * (one research_records row + the servable R2 body), so a `get_document` call
 * really reads D1 rows for the metering assertions.
 */
async function seedPublicDocument(db, objects, documentId) {
	const body = ENCODER.encode(`synthetic body of ${documentId}`);
	const payload = {
		document: {
			document_id: documentId,
			source_id: "fixture-source-public",
			source_identity_key: `identity-${documentId}`,
			canonical_locator: "lead://synthetic/item",
			origin_locator: "lead://synthetic/origin",
			first_seen_at: "2026-10-01T00:00:00+00:00",
			title: `Synthetic ${documentId}`,
			source_kind: "RSS",
			visibility: "PUBLIC",
			historical_backfill: false,
		},
		version: {
			version_id: `ver_${documentId}`,
			document_id: documentId,
			version_number: 1,
			content_sha256: sha256HexOf(body),
			byte_size: body.byteLength,
			media_type: "text/plain",
			ingested_at: "2026-10-01T00:00:00+00:00",
			published_at: "2026-10-01T00:00:00+00:00",
			event_time: null,
			source_updated_at: null,
			response_headers: {},
			revision_kind: "ORIGINAL",
			corrects_version_id: null,
			historical_backfill: false,
			readable: true,
		},
		attachments: [],
	};
	await db
		.prepare(
			"INSERT INTO research_records (record_type, record_key, message_id, visibility, schema_version, payload_json, generated_at, updated_at) VALUES ('document_version', ?, ?, 'PUBLIC', 'collector-outbound-v4', ?, ?, ?)",
		)
		.bind(
			payload.version.version_id,
			`outbound_${sha256HexOf(ENCODER.encode(payload.version.version_id)).slice(0, 40)}`,
			JSON.stringify(payload),
			NOW,
			NOW,
		)
		.run();
	await objects.put(`research-objects/sha256/${payload.version.content_sha256}`, body);
	await db
		.prepare(
			"INSERT OR IGNORE INTO research_objects (content_sha256, message_id, visibility, media_type, byte_size, state, received_at) VALUES (?, ?, 'PUBLIC', 'text/plain', ?, 'READY', ?)",
		)
		.bind(
			payload.version.content_sha256,
			`outbound_object_${payload.version.content_sha256.slice(0, 16)}`,
			body.byteLength,
			NOW,
		)
		.run();
}

/* ---------------------------------------------------------------- */
/* Synthetic bindings (same discipline as research-semantic-index)  */
/* ---------------------------------------------------------------- */

class FakeAi {
	constructor() {
		this.calls = 0;
		this.models = [];
	}

	async run(model, inputs) {
		this.calls += 1;
		this.models.push(model);
		const texts = Array.isArray(inputs.text) ? inputs.text : [inputs.text];
		return {
			shape: [texts.length, 1024],
			data: texts.map(() => new Array(1024).fill(0)),
		};
	}
}

class FakeVectorize {
	constructor() {
		this.vectors = new Map();
	}

	async upsert(entries) {
		for (const entry of entries) this.vectors.set(entry.id, entry);
	}

	async deleteByIds(ids) {
		for (const id of ids) this.vectors.delete(id);
	}

	async getByIds(ids) {
		return ids.flatMap((id) => (this.vectors.has(id) ? [{ id, ...this.vectors.get(id) }] : []));
	}

	async describe() {
		return { dimensions: 1024, vectorCount: this.vectors.size };
	}

	async query() {
		return { matches: [], count: 0 };
	}
}

class FakeR2 {
	constructor() {
		this.objects = new Map();
	}

	async put(key, body) {
		this.objects.set(
			key,
			typeof body === "string" ? ENCODER.encode(body) : new Uint8Array(body),
		);
	}

	async get(key) {
		const bytes = this.objects.get(key);
		if (!bytes) return null;
		return {
			arrayBuffer: async () =>
				bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
		};
	}
}

/* ---------------------------------------------------------------- */
/* Small helpers                                                    */
/* ---------------------------------------------------------------- */

async function seedCircuit(db, dimension, state, currentUsage, threshold) {
	await db
		.prepare(
			`INSERT INTO quota_circuit_state
				(dimension_key, state, current_usage, threshold_95, as_of, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.bind(dimension, state, currentUsage, threshold, AS_OF, AS_OF)
		.run();
}

async function usageRows(db) {
	const result = await db
		.prepare(
			`SELECT period_hour, client_id, route, call_count, d1_rows_read, d1_rows_written,
					ai_neurons, created_at, updated_at
			 FROM quota_client_usage_hourly
			 ORDER BY period_hour, client_id, route`,
		)
		.all();
	return result.results;
}

function stubCtx() {
	const promises = [];
	return {
		promises,
		waitUntil(promise) {
			promises.push(promise);
		},
		passThroughOnException() {},
	};
}

async function drain(ctx) {
	const pending = ctx.promises.splice(0);
	await Promise.all(pending);
}

/** D1 wrapper whose ONLY broken statement is the metering UPSERT. */
class MeteringOutageDb {
	constructor(inner) {
		this.inner = inner;
	}

	prepare(sql) {
		if (sql.includes("quota_client_usage_hourly")) {
			throw new Error("synthetic metering outage");
		}
		return this.inner.prepare(sql);
	}
}

/* ---------------------------------------------------------------- */
/* Hour bucket + UPSERT aggregation                                 */
/* ---------------------------------------------------------------- */

test("quotaPeriodHour buckets to the UTC hour in the frozen contract format", () => {
	assert.equal(
		metering.quotaPeriodHour(new Date("2026-10-02T13:45:12.345Z")),
		"2026-10-02T13:00:00Z",
	);
	assert.equal(
		metering.quotaPeriodHour(new Date("2026-10-02T00:00:00.000Z")),
		"2026-10-02T00:00:00Z",
	);
	// Non-UTC input must not leak local time into the bucket.
	assert.equal(
		metering.quotaPeriodHour(new Date("2026-10-02T08:59:59+08:00")),
		"2026-10-02T00:00:00Z",
	);
});

test("same hour/client/route accumulates into ONE row (never one row per request)", async () => {
	const db = createResearchWorkflowDb();
	const first = new Date("2026-10-02T09:10:00.000Z");
	const second = new Date("2026-10-02T09:50:00.000Z");
	await metering.recordClientUsage(db, {
		route: "mcp:search_documents_semantic",
		client_id: "chatgpt-production",
		observed: [
			{ dimension_key: "d1.rows_read", units: 12 },
			{ dimension_key: "d1.rows_written", units: 3 },
			{ dimension_key: "ai.neurons", units: 0.8 },
		],
		now: first,
	});
	await metering.recordClientUsage(db, {
		route: "mcp:search_documents_semantic",
		// Same client/route/hour as the first write, different values: proves SUM
		// not overwrite.
		client_id: "chatgpt-production",
		observed: [
			{ dimension_key: "d1.rows_read", units: 8 },
			{ dimension_key: "d1.rows_written", units: 2 },
			{ dimension_key: "ai.neurons", units: 0.7 },
		],
		now: second,
	});
	const rows = await usageRows(db);
	assert.equal(rows.length, 1, "one aggregate row, not one row per request");
	const row = rows[0];
	assert.equal(row.period_hour, "2026-10-02T09:00:00Z");
	assert.equal(row.client_id, "chatgpt-production");
	assert.equal(row.route, "mcp:search_documents_semantic");
	assert.equal(row.call_count, 2);
	assert.equal(row.d1_rows_read, 20);
	assert.equal(row.d1_rows_written, 5);
	assert.ok(Math.abs(row.ai_neurons - 1.5) < 1e-9, `ai_neurons must sum: ${row.ai_neurons}`);
	assert.equal(row.created_at, first.toISOString(), "created_at keeps the first write");
	assert.equal(row.updated_at, second.toISOString(), "updated_at moves to the last write");
});

test("different hour, client or route never mix aggregates", async () => {
	const db = createResearchWorkflowDb();
	const hour = (h) => new Date(`2026-10-02T${h}:00:00.000Z`);
	await metering.recordClientUsage(db, {
		route: "mcp:search_documents_semantic",
		client_id: "chatgpt-production",
		observed: [{ dimension_key: "d1.rows_read", units: 5 }],
		now: hour("09"),
	});
	await metering.recordClientUsage(db, {
		route: "mcp:search_documents_semantic",
		client_id: "chatgpt-production",
		observed: [{ dimension_key: "d1.rows_read", units: 7 }],
		now: hour("10"),
	});
	await metering.recordClientUsage(db, {
		route: "mcp:search_documents_semantic",
		client_id: "research-runner",
		observed: [{ dimension_key: "d1.rows_read", units: 9 }],
		now: hour("09"),
	});
	await metering.recordClientUsage(db, {
		route: "http:/internal/research-replica/v2/ingest",
		client_id: "research-runner",
		observed: [{ dimension_key: "d1.rows_written", units: 11 }],
		now: hour("09"),
	});
	const rows = await usageRows(db);
	assert.equal(rows.length, 4);
	const byKey = new Map(
		rows.map((row) => [`${row.period_hour}|${row.client_id}|${row.route}`, row]),
	);
	assert.equal(
		byKey.get("2026-10-02T09:00:00Z|chatgpt-production|mcp:search_documents_semantic")
			.d1_rows_read,
		5,
	);
	assert.equal(
		byKey.get("2026-10-02T10:00:00Z|chatgpt-production|mcp:search_documents_semantic")
			.d1_rows_read,
		7,
	);
	assert.equal(
		byKey.get("2026-10-02T09:00:00Z|research-runner|mcp:search_documents_semantic")
			.d1_rows_read,
		9,
	);
	assert.equal(
		byKey.get("2026-10-02T09:00:00Z|research-runner|http:/internal/research-replica/v2/ingest")
			.d1_rows_written,
		11,
	);
});

/* ---------------------------------------------------------------- */
/* The single surviving gate                                        */
/* ---------------------------------------------------------------- */

test("circuit CLOSED / absent rows allow the semantic tool (refusal is null)", async () => {
	const db = createResearchWorkflowDb();
	assert.equal(await metering.semanticSearchCircuitRefusal(db), null, "empty table = allow");
	await seedCircuit(db, "ai.neurons", "CLOSED", 100, 9500);
	await seedCircuit(db, "vectorize.queried_dims", "CLOSED", 2000, 47_500_000);
	assert.equal(await metering.semanticSearchCircuitRefusal(db), null, "all CLOSED = allow");
});

test("an OPEN guarded dimension returns the structured QUOTA_CIRCUIT_OPEN refusal", async () => {
	const db = createResearchWorkflowDb();
	await seedCircuit(db, "ai.neurons", "OPEN", 9501, 9500);
	await seedCircuit(db, "vectorize.queried_dims", "CLOSED", 2000, 47_500_000);
	const refusal = await metering.semanticSearchCircuitRefusal(db);
	assert.ok(refusal, "OPEN must refuse");
	assert.equal(refusal.error_code, "QUOTA_CIRCUIT_OPEN");
	assert.equal(refusal.retryable, false);
	assert.match(refusal.request_id, /^[0-9a-f]{32}$/);
	assert.deepEqual(
		refusal.open_dimensions.map((entry) => entry.dimension_key),
		["ai.neurons"],
		"only the OPEN dimension is listed",
	);
	assert.equal(refusal.open_dimensions[0].current_usage, 9501);
	assert.equal(refusal.open_dimensions[0].threshold_95, 9500);
	assert.equal(refusal.open_dimensions[0].as_of, AS_OF);
});

test("the gate fails OPEN when it cannot be read (never a new front-gate outage)", async () => {
	const db = createResearchWorkflowDb();
	// Simulate the migration not being applied yet / a D1 outage.
	db.sqlite.exec("DROP TABLE quota_circuit_state");
	assert.equal(await metering.semanticSearchCircuitRefusal(db), null);
	const broken = {
		prepare: () => {
			throw new Error("synthetic d1 outage");
		},
	};
	assert.equal(await metering.semanticSearchCircuitRefusal(broken), null);
	assert.equal(await metering.semanticSearchCircuitRefusal(null), null);
});

test("MCP search_documents_semantic is refused when the circuit is OPEN and served when CLOSED", async () => {
	const build = async () => {
		const db = createResearchWorkflowDb();
		const ai = new FakeAi();
		const index = new FakeVectorize();
		const server = createServer(
			{
				RESEARCH_REPLICA: db,
				RESEARCH_OBJECTS: new FakeR2(),
				AI: ai,
				RESEARCH_PUBLIC_INDEX: index,
			},
			"SKIPPED_UNAUTHORIZED",
			new Set(),
			null,
			null,
		);
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "quota-metering-gate-test", version: "0.0.0" });
		await Promise.all([
			server.server.connect(serverTransport),
			client.connect(clientTransport),
		]);
		return { db, ai, client, close: () => server.close() };
	};

	// OPEN: refusal before the query embedding is spent.
	{
		const state = await build();
		try {
			await seedCircuit(state.db, "ai.neurons", "OPEN", 9999, 9500);
			const answer = await state.client.callTool({
				name: "search_documents_semantic",
				arguments: { query: "synthetic query" },
			});
			assert.equal(answer.isError, true, "OPEN circuit must refuse");
			const payload = JSON.parse(answer.content[0].text);
			assert.equal(payload.error_code, "QUOTA_CIRCUIT_OPEN");
			assert.deepEqual(
				payload.open_dimensions.map((entry) => entry.dimension_key),
				["ai.neurons"],
			);
			assert.equal(state.ai.calls, 0, "the refused call must not spend any embedding");
		} finally {
			await state.close();
		}
	}

	// CLOSED: the tool executes normally (embedding spent, 0 matches is fine).
	{
		const state = await build();
		try {
			await seedCircuit(state.db, "ai.neurons", "CLOSED", 100, 9500);
			const answer = await state.client.callTool({
				name: "search_documents_semantic",
				arguments: { query: "synthetic query" },
			});
			assert.equal(answer.isError ?? false, false, "CLOSED circuit must allow");
			const payload = JSON.parse(answer.content[0].text);
			assert.deepEqual(Object.keys(payload).sort(), ["index_status", "matches"]);
			assert.ok(state.ai.calls >= 1, "the query embedding ran");
		} finally {
			await state.close();
		}
	}
});

test("lifeline tools never consult the circuit: they answer normally while a dimension is OPEN", async () => {
	const db = createResearchWorkflowDb();
	await seedCircuit(db, "ai.neurons", "OPEN", 9999, 9500);
	const server = createServer(
		{ RESEARCH_REPLICA: db, RESEARCH_OBJECTS: new FakeR2() },
		"SKIPPED_UNAUTHORIZED",
		new Set(),
		null,
		null,
	);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "quota-lifeline-test", version: "0.0.0" });
	await Promise.all([server.server.connect(serverTransport), client.connect(clientTransport)]);
	try {
		const calc = await client.callTool({
			name: "calculate",
			arguments: { operation: "add", a: 2, b: 3 },
		});
		assert.equal(calc.isError ?? false, false, "heartbeat-style control tool must pass");
		assert.equal(calc.content[0].text, "5");

		const doc = await client.callTool({
			name: "get_document",
			arguments: { document_id: "doc_missing" },
		});
		const text = doc.content[0].text;
		assert.match(
			text,
			/NOT_FOUND/,
			"the read-only document lifeline reaches its normal handler",
		);
		assert.doesNotMatch(text, /QUOTA_CIRCUIT_OPEN/, "the lifeline is never circuit-blocked");
	} finally {
		await server.close();
	}
});

/* ---------------------------------------------------------------- */
/* Settle path: persistence + failure isolation                     */
/* ---------------------------------------------------------------- */

test("scheduleQuotaMetering persists the observed totals under the verified client id", async () => {
	const db = createResearchWorkflowDb();
	const observer = new adapters.UsageObserver();
	observer.record("d1.rows_read", 12);
	observer.record("d1.rows_written", 4);
	observer.record("r2.class_b", 2); // no column in the ledger; log-only dimension
	const ctx = stubCtx();
	scheduleQuotaMetering(ctx, {
		route: "http:/internal/research-replica/v2/ingest",
		clientId: "research-runner",
		observer,
		db,
	});
	await drain(ctx);
	const rows = await usageRows(db);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].client_id, "research-runner");
	assert.equal(rows[0].call_count, 1);
	assert.equal(rows[0].d1_rows_read, 12);
	assert.equal(rows[0].d1_rows_written, 4);
	assert.equal(rows[0].ai_neurons, 0, "unmeasured dimensions stay at zero, never fabricated");
});

test("a metering write failure is swallowed after the response: no throw, business row untouched", async () => {
	const db = createResearchWorkflowDb();
	const observer = new adapters.UsageObserver();
	observer.record("d1.rows_read", 5);
	const ctx = stubCtx();
	scheduleQuotaMetering(ctx, {
		route: "mcp:search_documents_semantic",
		clientId: "chatgpt-production",
		observer,
		db: new MeteringOutageDb(db),
	});
	await drain(ctx); // must resolve, never reject
	assert.equal((await usageRows(db)).length, 0, "the failed write wrote nothing");
});

test("scheduleQuotaMetering is a no-op without an ExecutionContext waitUntil", async () => {
	const db = createResearchWorkflowDb();
	const observer = new adapters.UsageObserver();
	observer.record("d1.rows_read", 5);
	scheduleQuotaMetering(undefined, {
		route: "mcp:get_document",
		clientId: "unattributed",
		observer,
		db,
	});
	assert.equal((await usageRows(db)).length, 0);
});

/* ---------------------------------------------------------------- */
/* Fetch-level wiring (worker.fetch + synthetic JSON-RPC)           */
/* ---------------------------------------------------------------- */

const MCP_HEADERS = {
	accept: "application/json, text/event-stream",
	"content-type": "application/json",
	"mcp-protocol-version": "2025-03-26",
};

function jsonRpcRequest(id, method, params, extraHeaders = {}) {
	return new Request("https://worker.example/mcp", {
		method: "POST",
		headers: { ...MCP_HEADERS, ...extraHeaders },
		body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
	});
}

function rpcPayload(raw, contentType) {
	if (!contentType.includes("text/event-stream")) return JSON.parse(raw);
	const line = raw.split("\n").find((candidate) => candidate.startsWith("data:"));
	assert.ok(line, "MCP SSE response must contain a JSON-RPC data frame");
	return JSON.parse(line.slice("data:".length).trim());
}

async function mcpInitialize(env, ctx, extraHeaders = {}) {
	const response = await worker.fetch(
		jsonRpcRequest(
			1,
			"initialize",
			{
				protocolVersion: "2025-03-26",
				capabilities: {},
				clientInfo: { name: "quota-metering-fetch-test", version: "1" },
			},
			extraHeaders,
		),
		env,
		ctx,
	);
	assert.equal(response.status, 200, "initialize must reach the MCP endpoint");
	await drain(ctx);
	return response.headers.get("mcp-session-id");
}

async function mcpCallTool(env, ctx, sessionId, name, args, extraHeaders = {}) {
	const response = await worker.fetch(
		jsonRpcRequest(
			2,
			"tools/call",
			{ name, arguments: args },
			{ ...(sessionId ? { "mcp-session-id": sessionId } : {}), ...extraHeaders },
		),
		env,
		ctx,
	);
	assert.equal(response.status, 200, `${name} must reach the MCP endpoint`);
	const payload = rpcPayload(await response.text(), response.headers.get("content-type") ?? "");
	await drain(ctx);
	return payload.result;
}

function fetchEnv(db, overrides = {}) {
	return {
		RESEARCH_REPLICA: db,
		RESEARCH_OBJECTS: new FakeR2(),
		AI: new FakeAi(),
		RESEARCH_PUBLIC_INDEX: new FakeVectorize(),
		...overrides,
	};
}

test("fetch-level: a served tool call lands in the ledger with the verified principal and route", async () => {
	const db = createResearchWorkflowDb();
	const objects = new FakeR2();
	await seedPublicDocument(db, objects, "doc_seed");
	const env = fetchEnv(db, {
		RESEARCH_OBJECTS: objects,
		// Verified static-direct credential: the principal is the configured
		// durable identity, presented via a byte-exact token match.
		COLLECTOR_MCP_CLIENT_TOKEN: "synthetic-mcp-token",
		COLLECTOR_STATIC_CLIENT_PRINCIPAL: "chatgpt-production",
	});
	const ctx = stubCtx();
	const sessionId = await mcpInitialize(env, ctx);
	const result = await mcpCallTool(
		env,
		ctx,
		sessionId,
		"get_document",
		{ document_id: "doc_seed" },
		{ authorization: "Bearer synthetic-mcp-token" },
	);
	assert.equal(result.isError ?? false, false, "the seeded document must be served");
	const payload = JSON.parse(result.content[0].text);
	assert.equal(payload.document.document_id, "doc_seed");
	const rows = await usageRows(db);
	assert.equal(rows.length, 1, "exactly one ledger row for the request");
	assert.equal(rows[0].client_id, "chatgpt-production", "verified principal is the client id");
	assert.equal(rows[0].route, "mcp:get_document", "JSON-RPC probe names the tool");
	assert.ok(rows[0].d1_rows_read >= 1, "the tool's D1 reads are measured");
});

test("fetch-level: unverifiable caller with X-Forwarded-For is unattributed, never IP-attributed", async () => {
	const db = createResearchWorkflowDb();
	const objects = new FakeR2();
	await seedPublicDocument(db, objects, "doc_seed_ip");
	const env = fetchEnv(db, { RESEARCH_OBJECTS: objects }); // no token: nobody verifies
	const ctx = stubCtx();
	const sessionId = await mcpInitialize(env, ctx, { "x-forwarded-for": "203.0.113.9" });
	const result = await mcpCallTool(
		env,
		ctx,
		sessionId,
		"get_document",
		{ document_id: "doc_seed_ip" },
		{ "x-forwarded-for": "203.0.113.9" },
	);
	assert.equal(result.isError ?? false, false);
	const rows = await usageRows(db);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].client_id, "unattributed");
	assert.equal(JSON.stringify(rows).includes("203.0.113.9"), false, "IPs never enter the ledger");
});

test("fetch-level: a metering outage cannot touch the served response", async () => {
	const db = createResearchWorkflowDb();
	const env = fetchEnv(db, {
		// Only the metering UPSERT breaks; reads and the circuit gate still work.
		RESEARCH_REPLICA: new MeteringOutageDb(db),
	});
	const ctx = stubCtx();
	const sessionId = await mcpInitialize(env, ctx);
	const result = await mcpCallTool(env, ctx, sessionId, "search_documents_semantic", {
		query: "synthetic query",
	});
	assert.equal(result.isError ?? false, false, "the business response must be unaffected");
	const payload = JSON.parse(result.content[0].text);
	assert.deepEqual(Object.keys(payload).sort(), ["index_status", "matches"]);
	// The underlying store is healthy but the ledger write failed.
	const direct = await usageRows(db);
	assert.equal(direct.length, 0, "the failed metering write wrote nothing");
});

/* ---------------------------------------------------------------- */
/* Source-level privacy pin                                         */
/* ---------------------------------------------------------------- */

test("the metering face never reads IP headers (X-Forwarded-For et al.)", async () => {
	const srcRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
	for (const name of ["index.ts", "quota-metering.ts"]) {
		const source = await readFile(path.join(srcRoot, name), "utf8");
		for (const header of ["X-Forwarded-For", "CF-Connecting-IP", "X-Real-IP"]) {
			assert.equal(
				source.includes(header),
				false,
				`${name} must not read ${header}: identity comes from verified credentials only`,
			);
		}
	}
});
