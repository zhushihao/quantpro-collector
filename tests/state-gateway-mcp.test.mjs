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

test("State Gateway MCP exposes five narrow tools without caller-controlled external targets", async () => {
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
		assert.equal(tools.append_state_batch.annotations.readOnlyHint, false);
		assert.equal(tools.append_state_batch.annotations.destructiveHint, false);
		assert.equal(tools.append_state_batch.annotations.idempotentHint, true);
		assert.equal(tools.append_state_batch.annotations.openWorldHint, true);
	} finally {
		await client.close();
		await server.server.close();
	}
});
