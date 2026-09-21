import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith("./") && !path.extname(specifier)) {
			try {
				return nextResolve(`${specifier}.ts`, context);
			} catch {
				// Fall through to the default resolver.
			}
		}
		return nextResolve(specifier, context);
	},
});

const { createServer } = await import("../src/index.ts");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

async function connectedClient() {
	const server = createServer(
		undefined,
		"ENABLED",
		new Set(["market:read"]),
		"chatgpt-production",
		"https://cn-hk-quotes-mcp.zhushihao710.workers.dev",
	);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "market-ledger-contract-test", version: "0.0.0" });
	await Promise.all([server.server.connect(serverTransport), client.connect(clientTransport)]);
	return { client, server };
}

test("market ledger MCP tools expose only narrow structured inputs", async () => {
	const { client, server } = await connectedClient();
	try {
		const listed = await client.listTools();
		const tools = Object.fromEntries(
			listed.tools
				.filter((tool) =>
					["get_market_checkpoints", "append_market_checkpoint"].includes(tool.name),
				)
				.map((tool) => [tool.name, tool]),
		);
		assert.deepEqual(
			Object.keys(tools).sort(),
			["append_market_checkpoint", "get_market_checkpoints"],
		);

		assert.deepEqual(
			Object.keys(tools.get_market_checkpoints.inputSchema.properties).sort(),
			["scheduled_slot", "trading_date"],
		);

		assert.deepEqual(
			Object.keys(tools.append_market_checkpoint.inputSchema.properties),
			["checkpoint"],
		);
		const checkpointSchema =
			tools.append_market_checkpoint.inputSchema.properties.checkpoint;
		assert.deepEqual(
			Object.keys(checkpointSchema.properties).sort(),
			[
				"as_of",
				"event_id",
				"idempotency_key",
				"live_universe_hash",
				"observation_type",
				"portfolio_version",
				"preopen_comment_id",
				"previous_checkpoint_comment_id",
				"producer",
				"production_ref",
				"prompt_id",
				"records",
				"scheduled_slot",
				"schema_version",
				"source_task",
				"trading_date",
			],
		);
		const serialized = JSON.stringify(tools.append_market_checkpoint.inputSchema);
		assert.equal(serialized.includes('"token"'), false);
		assert.equal(serialized.includes('"repo"'), false);
		assert.equal(serialized.includes('"issue"'), false);
	} finally {
		await client.close();
		await server.server.close();
	}
});
