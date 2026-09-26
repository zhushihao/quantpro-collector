import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith("./") && !path.extname(specifier)) {
			try {
				return nextResolve(`${specifier}.ts`, context);
			} catch {}
		}
		return nextResolve(specifier, context);
	},
});

const { createServer } = await import("../src/index.ts");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

test("legacy production OAuth scopes remain compatible only for verified chatgpt-production", async () => {
	const server = createServer(
		undefined,
		"ENABLED",
		new Set(["market:read", "research:submit"]),
		"chatgpt-production",
		"https://cn-hk-quotes-mcp.zhushihao710.workers.dev",
	);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "state-gateway-legacy-scope-test", version: "0.0.0" });
	await Promise.all([server.server.connect(serverTransport), client.connect(clientTransport)]);
	try {
		const validate = await client.callTool({
			name: "validate_state_batch",
			arguments: {
				channel: "INDUSTRY",
				batch: {
					schema_version: "investment_state_batch_v1",
					portfolio_version: "live:sha256:test",
					event_id: "20260926T224500+08|industry_trend|BATCH",
					as_of: "2026-09-26T22:45:00+08:00",
					events: [
						{
							symbol: "CN:300308",
							event_type: "EVIDENCE_ADD",
							research_priority: "P0",
							industry_thesis: "probe",
							r_proposal: "R1",
							evidence_types: [],
							evidence_keys: [],
							counter_evidence: [],
							confidence: 0.5,
							next_validation: "probe",
						},
					],
				},
			},
		});
		assert.equal(validate.isError, undefined);
		assert.match(validate.content[0].text, /"status": "VALID"/);

		const append = await client.callTool({
			name: "append_state_batch",
			arguments: {
				channel: "INDUSTRY",
				batch: {
					schema_version: "investment_state_batch_v1",
					portfolio_version: "live:sha256:test",
					event_id: "20260926T224500+08|industry_trend|BATCH",
					as_of: "2026-09-26T22:45:00+08:00",
					events: [],
				},
			},
		});
		assert.equal(append.isError, true);
		assert.doesNotMatch(append.content[0].text, /STATE_FORBIDDEN/);
		assert.match(append.content[0].text, /STATE_UNAVAILABLE|STATE_VALIDATION_FAILED/);
	} finally {
		await client.close();
		await server.server.close();
	}
});

test("legacy scope compatibility never grants state write to market-read-only callers", async () => {
	const server = createServer(
		undefined,
		"ENABLED",
		new Set(["market:read"]),
		"chatgpt-production",
		"https://cn-hk-quotes-mcp.zhushihao710.workers.dev",
	);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "state-gateway-deny-test", version: "0.0.0" });
	await Promise.all([server.server.connect(serverTransport), client.connect(clientTransport)]);
	try {
		const append = await client.callTool({
			name: "append_state_batch",
			arguments: {
				channel: "INDUSTRY",
				batch: {},
			},
		});
		assert.equal(append.isError, true);
		assert.match(append.content[0].text, /STATE_FORBIDDEN/);
	} finally {
		await client.close();
		await server.server.close();
	}
});

test("State Gateway MCP exposes narrow tools without caller-controlled external targets", async () => {
	const server = createServer(
		undefined,
		"ENABLED",
		new Set(["market:read", "state:read", "state:write"]),
		"chatgpt-production",
		"https://cn-hk-quotes-mcp.zhushihao710.workers.dev",
	);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "state-gateway-contract-test", version: "0.0.0" });
	await Promise.all([server.server.connect(serverTransport), client.connect(clientTransport)]);
	try {
		const listed = await client.listTools();
		const names = [
			"append_state_batch",
			"get_gateway_status",
			"get_state_snapshot",
			"read_state_snapshot",
			"get_state_write_receipt",
			"validate_state_batch",
		];
		const tools = Object.fromEntries(
			listed.tools
				.filter((tool) => names.includes(tool.name))
				.map((tool) => [tool.name, tool]),
		);
		assert.deepEqual(Object.keys(tools).sort(), names.sort());
		for (const tool of Object.values(tools)) {
			const serialized = JSON.stringify(tool.inputSchema);
			for (const forbidden of [
				"repo",
				"issue",
				"url",
				"token",
				"credential",
				"producer",
				"dimension",
			]) {
				assert.equal(
					serialized.includes(`"${forbidden}"`),
					false,
					`${tool.name} leaks ${forbidden}`,
				);
			}
		}
		assert.deepEqual(Object.keys(tools.append_state_batch.inputSchema.properties).sort(), [
			"batch",
			"channel",
		]);
		const snapshotSchema = JSON.stringify(tools.get_state_snapshot.inputSchema);
		assert.match(snapshotSchema, /CN:\[0-9\]\{6\}/);
		assert.match(snapshotSchema, /HK:\[0-9\]\{5\}/);
		assert.doesNotMatch(snapshotSchema, /\\\\d/);
		const compatibleSnapshot = tools.read_state_snapshot.inputSchema;
		assert.equal(compatibleSnapshot.properties.symbols.items.pattern, undefined);
		assert.equal(compatibleSnapshot.properties.trading_date.pattern, undefined);
		assert.equal(tools.append_state_batch.annotations.readOnlyHint, false);
		assert.equal(tools.append_state_batch.annotations.destructiveHint, false);
		assert.equal(tools.append_state_batch.annotations.idempotentHint, true);
		assert.equal(tools.append_state_batch.annotations.openWorldHint, true);
	} finally {
		await client.close();
		await server.server.close();
	}
});
