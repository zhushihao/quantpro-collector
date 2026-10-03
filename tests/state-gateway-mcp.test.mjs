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
			} catch {}
		}
		return nextResolve(specifier, context);
	},
});

const { createServer } = await import("../src/index.ts");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { createResearchWorkflowDb } = await import("./helpers/d1-sqlite-shim.mjs");

test("#35 validate_state_batch declares VALIDATE/non-retry fallback for unclassified exceptions", async () => {
	const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
	const start = source.indexOf('"validate_state_batch"');
	const end = source.indexOf('"append_state_batch"', start + 1);
	assert.ok(start >= 0 && end > start);
	const section = source.slice(start, end);
	assert.match(section, /tool: "validate_state_batch"/);
	assert.match(section, /phase: "VALIDATE"/);
	assert.match(section, /retryable: false/);
	assert.match(source, /event: "state_gateway_unclassified_error"/);
});

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

		const gatewayStatus = await client.callTool({ name: "get_gateway_status", arguments: {} });
		assert.equal(gatewayStatus.isError, undefined);
		const gatewayStatusBody = JSON.parse(gatewayStatus.content[0].text);
		assert.equal(gatewayStatusBody.state_read_authorized, true);
		assert.equal(gatewayStatusBody.state_write_authorized, true);

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

test("#37 stable append_state_batch ABI routes envelope-free payload into owner command core", async () => {
	const db = createResearchWorkflowDb();
	const server = createServer(
		{
			GITHUB_TOKEN: "fake-token",
			RESEARCH_REPLICA: db,
		},
		"ENABLED",
		new Set(["market:read", "state:read", "state:write"]),
		"chatgpt-production",
		"https://cn-hk-quotes-mcp.zhushihao710.workers.dev",
	);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "stable-state-abi-test", version: "0.0.0" });
	await Promise.all([server.server.connect(serverTransport), client.connect(clientTransport)]);
	try {
		const result = await client.callTool({
			name: "append_state_batch",
			arguments: {
				channel: "COMPANY",
				batch: {
					as_of: "2026-09-27T21:55:00+08:00",
					events: [
						{
							symbol: "CN:605376",
							event_type: "EVIDENCE_UPDATE",
							company_thesis: "probe",
							company_validation: "probe",
							r_proposal: null,
							evidence_types: ["C"],
							evidence_keys: ["probe"],
							counter_evidence: [],
							confidence: 0.5,
							next_validation: "probe",
							effective_r_state: "R4",
						},
					],
				},
			},
		});
		assert.equal(result.isError, true);
		const body = JSON.parse(result.content[0].text);
		assert.equal(body.status, "STATE_UNAVAILABLE");
		assert.equal(body.phase, "READ");
		assert.match(body.message, /LIVE universe/);
		assert.doesNotMatch(body.message, /schema_version/);
		assert.doesNotMatch(body.message, /effective_r_state/);
	} finally {
		await client.close();
		await server.server.close();
	}
});

test("#37 stable record_automation_run ABI bridges SERVER_AUTO to v2 begin/end", async () => {
	const db = createResearchWorkflowDb();
	const server = createServer(
		{ GITHUB_TOKEN: "fake-token", RESEARCH_REPLICA: db },
		"ENABLED",
		new Set(["market:read", "state:read", "state:write"]),
		"chatgpt-production",
		"https://cn-hk-quotes-mcp.zhushihao710.workers.dev",
	);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "stable-audit-abi-test", version: "0.0.0" });
	await Promise.all([server.server.connect(serverTransport), client.connect(clientTransport)]);
	try {
		const started = await client.callTool({
			name: "record_automation_run",
			arguments: {
				task_name: "industry-research",
				run_id: "SERVER_AUTO",
				phase: "STARTED",
				status: "STARTED",
				occurred_at: "SERVER",
				prompt_version: "5f023477a8c16612914e8ed3a6d06132a0dd413b",
			},
		});
		assert.equal(started.isError, undefined);
		const startedBody = JSON.parse(started.content[0].text);
		assert.equal(startedBody.compat_contract, "run-v2");
		assert.match(startedBody.run_id, /^run_[0-9a-f]{32}$/);

		const finished = await client.callTool({
			name: "record_automation_run",
			arguments: {
				task_name: "industry-research",
				run_id: startedBody.run_id,
				phase: "FINAL",
				status: "SILENT",
				occurred_at: "SERVER",
				notification_sent: false,
				fresh_delta_count: 0,
				safe_summary: "normal silent run",
			},
		});
		assert.equal(finished.isError, undefined);
		const finishedBody = JSON.parse(finished.content[0].text);
		assert.equal(finishedBody.compat_contract, "run-v2");
		assert.equal(finishedBody.outcome, "SILENT");

		const history = await client.callTool({
			name: "get_automation_run_history",
			arguments: { task_name: "industry-research", limit: 5 },
		});
		const historyBody = JSON.parse(history.content[0].text);
		// Spec §6.2 merges MISSED_SLOT schedule-derivation rows into the same
		// list; this run is the newest real row, so locate it by contract.
		const run = historyBody.runs.find((entry) => entry.source_contract === "run-v2");
		assert.ok(run, "the fresh run-v2 row must be present");
		assert.equal(run.effective_status, "SILENT");
		assert.equal(run.notification_sent, null);
		assert.equal(run.notification_intended, false);
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

		const gatewayStatus = await client.callTool({ name: "get_gateway_status", arguments: {} });
		assert.equal(gatewayStatus.isError, undefined);
		const gatewayStatusBody = JSON.parse(gatewayStatus.content[0].text);
		assert.equal(gatewayStatusBody.state_read_authorized, true);
		assert.equal(gatewayStatusBody.state_write_authorized, false);
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
			"append_company_events",
			"append_industry_events",
			"append_close_events",
			"append_market_observation",
			"submit_run_envelope",
			"begin_run",
			"end_run",
			"get_gateway_status",
			"get_automation_run_history",
			"get_production_health_snapshot",
			"get_state_snapshot",
			"read_state_snapshot",
			"read_state_snapshot_v2",
			"record_automation_run",
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
		for (const name of ["get_state_snapshot", "read_state_snapshot", "read_state_snapshot_v2"]) {
			const snapshot = tools[name].inputSchema;
			assert.equal(snapshot.properties.symbols.items.pattern, undefined);
			assert.equal(snapshot.properties.trading_date.pattern, undefined);
		}
		for (const name of [
			"append_company_events",
			"append_industry_events",
			"append_close_events",
			"append_market_observation",
		]) {
			assert.equal(tools[name].annotations.readOnlyHint, false);
			assert.equal(tools[name].annotations.destructiveHint, false);
			assert.equal(tools[name].annotations.idempotentHint, true);
			assert.equal(tools[name].annotations.openWorldHint, false);
			const schema = tools[name].inputSchema;
			assert.equal(
				schema.additionalProperties,
				false,
				`${name} must expose a closed host-safe top-level schema`,
			);
			if (schema.properties.events?.items) {
				assert.equal(
					schema.properties.events.items.additionalProperties,
					false,
					`${name} event items must expose a closed host-safe schema`,
				);
			}
			const serialized = JSON.stringify(schema);
			for (const serverOwned of [
				"schema_version",
				"event_id",
				"write_key",
				"producer",
				"dimension",
				"source_task",
				"portfolio_version",
				"live_universe_hash",
			]) {
				if (name === "append_market_observation" && serverOwned === "live_universe_hash") {
					assert.equal(serialized.includes(`"${serverOwned}"`), false);
				} else {
					assert.equal(serialized.includes(`"${serverOwned}"`), false);
				}
			}
		}
		assert.equal(tools.begin_run.annotations.readOnlyHint, false);
		assert.equal(tools.begin_run.annotations.idempotentHint, true);
		assert.equal(tools.end_run.annotations.readOnlyHint, false);
		assert.equal(tools.end_run.annotations.idempotentHint, true);
		assert.equal(tools.record_automation_run.annotations.readOnlyHint, false);
		assert.equal(tools.record_automation_run.annotations.idempotentHint, true);
		assert.equal(tools.get_automation_run_history.annotations.readOnlyHint, true);
		assert.equal(tools.get_automation_run_history.annotations.openWorldHint, false);
		assert.equal(tools.append_state_batch.annotations.readOnlyHint, false);
		assert.equal(tools.append_state_batch.annotations.destructiveHint, false);
		assert.equal(tools.append_state_batch.annotations.idempotentHint, true);
		assert.equal(tools.append_state_batch.annotations.openWorldHint, true);
		// submit_run_envelope mirrors the narrow-write annotation triple (A8).
		assert.equal(tools.submit_run_envelope.annotations.readOnlyHint, false);
		assert.equal(tools.submit_run_envelope.annotations.destructiveHint, false);
		assert.equal(tools.submit_run_envelope.annotations.idempotentHint, true);
		assert.equal(tools.submit_run_envelope.annotations.openWorldHint, false);
		const envelopeDescription = tools.submit_run_envelope.description;
		for (const fragment of [
			"写入目的地由 Collector 固定映射",
			"空心跳只记录本轮运行审计/终态",
			"不追加 INDUSTRY/COMPANY/CLOSE/MARKET 业务账本",
			"带 channel_payload 时才",
			"固定映射追加对应业务账本",
			"不能指定 repo、issue、URL、credential 或其他外部目标",
			"不修改、暂停、停用或删除 Automation",
			"追加式账本写入",
		]) {
			assert.ok(
				envelopeDescription.includes(fragment),
				`submit_run_envelope description must disclose: ${fragment}`,
			);
		}
		const envelopeSchema = tools.submit_run_envelope.inputSchema;
		assert.equal(
			envelopeSchema.additionalProperties,
			false,
			"submit_run_envelope must expose a closed host-safe top-level schema",
		);
		// Union-member closure (spec §八, review six): the existing event-items
		// loop sees no `events` at the envelope top level, so the
		// channel_payload oneOf members must be walked explicitly.
		const union = envelopeSchema.properties.channel_payload.oneOf;
		assert.ok(Array.isArray(union) && union.length === 4);
		for (const member of union) {
			assert.equal(
				member.additionalProperties,
				false,
				"every channel member must be a closed object schema",
			);
			if (member.properties.events?.items) {
				assert.equal(
					member.properties.events.items.additionalProperties,
					false,
					"investment channel event items must expose a closed host-safe schema",
				);
			}
		}
		const envelopeSerialized = JSON.stringify(envelopeSchema);
		for (const serverOwned of [
			"schema_version",
			"event_id",
			"write_key",
			"producer",
			"dimension",
			"source_task",
			"portfolio_version",
			"live_universe_hash",
		]) {
			assert.equal(
				envelopeSerialized.includes(`"${serverOwned}"`),
				false,
				`submit_run_envelope leaks ${serverOwned}`,
			);
		}
		assert.equal(
			union.filter((member) => member.properties.events?.items).length,
			3,
			"INDUSTRY/COMPANY/CLOSE carry closed event item schemas",
		);
	} finally {
		await client.close();
		await server.server.close();
	}
});

test("get_gateway_status.registered_tools never drifts from the real MCP registry (#50)", async () => {
	const server = createServer(
		undefined,
		"ENABLED",
		new Set(["market:read", "state:read", "state:write"]),
		"chatgpt-production",
		"https://cn-hk-quotes-mcp.zhushihao710.workers.dev",
	);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "registered-tools-drift-test", version: "0.0.0" });
	await Promise.all([server.server.connect(serverTransport), client.connect(clientTransport)]);
	try {
		const listed = await client.listTools();
		const listedNames = new Set(listed.tools.map((tool) => tool.name));
		const status = await client.callTool({ name: "get_gateway_status", arguments: {} });
		const body = JSON.parse(status.content[0].text);
		assert.ok(Array.isArray(body.registered_tools) && body.registered_tools.length > 0);
		for (const name of body.registered_tools) {
			assert.ok(
				listedNames.has(name),
				`registered_tools advertises "${name}" but tools/list does not register it`,
			);
		}
		assert.ok(body.registered_tools.includes("get_production_health_snapshot"));
		assert.equal(body.state_gateway_version, "1.4.0");
	} finally {
		await client.close();
		await server.server.close();
	}
});
