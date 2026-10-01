import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

const { registerHooks } = await import("node:module");
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

import { getProductionHealthSnapshot } from "../src/production-health.ts";
import { AUTOMATION_REGISTRY_KEYS } from "../src/automation-run-ledger.ts";
import { ensureRunEnvelopeTables } from "../src/automation-run-ledger.ts";
import { createResearchWorkflowDb } from "./helpers/d1-sqlite-shim.mjs";

async function insertV3Row(db, overrides = {}) {
	const row = {
		task_name: "industry-research",
		run_id: "run_" + "a".repeat(32),
		envelope_key: "E:INDUSTRY:" + "b".repeat(64),
		channel: "INDUSTRY",
		write_key: null,
		as_of: null,
		received_at: "2026-09-29T02:50:00Z",
		slot: "10:45",
		slot_date: "2026-09-29",
		fresh_delta_count: 1,
		event_count: 2,
		outcome: "COMPLETED",
		blocker_code: null,
		summary: "一轮",
		prompt_version: null,
		collector_build_sha: null,
		cloudflare_version_id: "cf-ver-1",
		created_at: "2026-09-29T02:50:00Z",
		updated_at: "2026-09-29T02:50:00Z",
		...overrides,
	};
	await db
		.prepare(
			`INSERT INTO automation_runs_v3 (
				task_name, run_id, envelope_key, channel, write_key, as_of,
				received_at, slot, slot_date, fresh_delta_count, event_count,
				outcome, blocker_code, summary, prompt_version,
				collector_build_sha, cloudflare_version_id, created_at, updated_at
			) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)`,
		)
		.bind(
			row.task_name,
			row.run_id,
			row.envelope_key,
			row.channel,
			row.write_key,
			row.as_of,
			row.received_at,
			row.slot,
			row.slot_date,
			row.fresh_delta_count,
			row.event_count,
			row.outcome,
			row.blocker_code,
			row.summary,
			row.prompt_version,
			row.collector_build_sha,
			row.cloudflare_version_id,
			row.created_at,
			row.updated_at,
		)
		.run();
	return row;
}

function countingDb(db, tally) {
	return new Proxy(db, {
		get(target, prop, receiver) {
			if (prop !== "prepare") return Reflect.get(target, prop, receiver);
			return (sql) => {
				const kind = sql.trimStart().toUpperCase();
				if (kind.startsWith("SELECT")) tally.selects += 1;
				else tally.writes += 1;
				if (/CREATE|INSERT|DROP|ALTER/.test(kind)) tally.ddlOrInsert += 1;
				return target.prepare(sql);
			};
		},
	});
}

test("health snapshot: seeded-but-empty ledger reports six registry rows as UNKNOWN, zero writes", async () => {
	const db = createResearchWorkflowDb();
	await ensureRunEnvelopeTables(db);
	const tally = { selects: 0, writes: 0, ddlOrInsert: 0 };
	const snapshot = await getProductionHealthSnapshot({ db: countingDb(db, tally) });
	assert.equal(snapshot.status, "OK");
	assert.deepEqual(
		snapshot.tasks.map((task) => task.registry_key),
		[...AUTOMATION_REGISTRY_KEYS],
	);
	for (const task of snapshot.tasks) {
		assert.equal(task.latest_run_id, null);
		assert.equal(task.latest_received_at, null);
		assert.equal(task.seconds_since_last_received, null);
		assert.equal(task.outcome, null);
		assert.equal(task.prompt_version, null);
		assert.equal(task.schedule_basis, "UNKNOWN");
	}
	assert.equal(tally.writes, 0, "the entry point performs no DML");
	assert.equal(tally.ddlOrInsert, 0, "the entry point performs no DDL (no lazy bootstrap)");
	assert.ok(tally.selects <= 6, `bounded reads only, got ${tally.selects}`);
});

test("health snapshot: real receipt time and age are shown without false Prompt or schedule provenance", async () => {
	const db = createResearchWorkflowDb();
	await ensureRunEnvelopeTables(db);
	await insertV3Row(db, { prompt_version: "c".repeat(40) });
	const snapshot = await getProductionHealthSnapshot({ db, cloudflareVersionId: "ver-x" });
	const industry = snapshot.tasks.find((task) => task.registry_key === "industry-research");
	assert.equal(industry.latest_run_id, "run_" + "a".repeat(32));
	assert.equal(industry.outcome, "COMPLETED");
	assert.equal(industry.prompt_version, null);
	assert.equal(industry.cloudflare_version_id, "cf-ver-1");
	assert.equal(industry.latest_received_at, "2026-09-29T02:50:00Z");
	assert.equal(industry.seconds_since_last_received,
		Math.floor((Date.parse(snapshot.as_of) - Date.parse(industry.latest_received_at)) / 1000));
	assert.equal(industry.schedule_basis, "UNKNOWN");
	assert.equal(industry.slot, null);
	assert.equal(industry.slot_date, null);
	assert.equal(snapshot.cloudflare_version_id, "ver-x");
	// Other tasks stay UNKNOWN facts, never synthesized failures.
	const central = snapshot.tasks.find((task) => task.registry_key === "central-policy");
	assert.equal(central.outcome, null);
	assert.equal(central.schedule_basis, "UNKNOWN");
});

test("health snapshot: slot drift past the window and unseeded tables are reported honestly", async () => {
	const db = createResearchWorkflowDb();
	await ensureRunEnvelopeTables(db);
	await insertV3Row(db, {
		slot: "10:45",
		// Shanghai 12:00 — 75 minutes past the 10:45 slot, beyond its 40min row.
		received_at: "2026-09-29T04:00:00Z",
		outcome: "SILENT",
	});
	const snapshot = await getProductionHealthSnapshot({ db });
	const industry = snapshot.tasks.find((task) => task.registry_key === "industry-research");
	assert.equal(industry.schedule_basis, "UNKNOWN");
	assert.equal(industry.outcome, "SILENT", "the stored terminal stays a fact");

	// No expected version or schedule is inferred for a non-MARKET receipt.
	const noSlot = await insertV3Row(db, {
		task_name: "ai-financing-rates",
		run_id: "run_" + "f".repeat(32),
		envelope_key: "HB:2026-09-29T04",
		channel: null,
		slot: null,
		slot_date: null,
		prompt_version: null,
	});
	const recheck = await getProductionHealthSnapshot({ db });
	const rates = recheck.tasks.find((task) => task.registry_key === "ai-financing-rates");
	assert.equal(rates.latest_run_id, noSlot.run_id);
	assert.equal(rates.schedule_basis, "UNKNOWN");
});

test("health snapshot: unseeded ledger answers NOT_SEEDED without creating anything", async () => {
	const db = createResearchWorkflowDb();
	await db.prepare("DROP TABLE IF EXISTS automation_schedule_v1").run();
	await db.prepare("DROP TABLE IF EXISTS automation_runs_v3").run();
	const tally = { selects: 0, writes: 0, ddlOrInsert: 0 };
	const snapshot = await getProductionHealthSnapshot({ db: countingDb(db, tally) });
	assert.equal(snapshot.status, "NOT_SEEDED");
	assert.deepEqual(snapshot.tasks, []);
	assert.match(snapshot.message ?? "", /not present/);
	assert.equal(tally.ddlOrInsert, 0, "NOT_SEEDED must not lazily bootstrap the tables");
});

// ---- MCP wiring (#50): discoverable, state:read-gated, side-effect free ----

const { createServer } = await import("../src/index.ts");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

async function startServer(env, scopes) {
	const server = createServer(
		env,
		"ENABLED",
		new Set(scopes),
		"chatgpt-production",
		"https://cn-hk-quotes-mcp.zhushihao710.workers.dev",
	);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "production-health-test", version: "0.0.0" });
	await Promise.all([server.server.connect(serverTransport), client.connect(clientTransport)]);
	return {
		client,
		close: async () => {
			await client.close();
			await server.server.close();
		},
	};
}

test("MCP exposes get_production_health_snapshot for state:read and denies it without the scope", async () => {
	const db = createResearchWorkflowDb();
	await ensureRunEnvelopeTables(db);
	await insertV3Row(db, { prompt_version: "d".repeat(40) });
	const { client, close } = await startServer(
		{ GITHUB_TOKEN: "fake", RESEARCH_REPLICA: db },
		["market:read", "state:read", "state:write"],
	);
	try {
		const listed = await client.listTools();
		const tool = listed.tools.find((entry) => entry.name === "get_production_health_snapshot");
		assert.ok(tool, "tool discoverable via tools/list");
		assert.equal(tool.annotations?.readOnlyHint, true);
		assert.equal(tool.annotations?.destructiveHint, false);
		const call = await client.callTool({ name: "get_production_health_snapshot", arguments: {} });
		assert.equal(call.isError, undefined);
		const body = JSON.parse(call.content[0].text);
		assert.equal(body.status, "OK");
		assert.equal(body.tasks.length, 6);
		const industry = body.tasks.find((task) => task.registry_key === "industry-research");
		assert.equal(industry.prompt_version, null);
	} finally {
		await close();
	}

	const deniedSession = await startServer(
		{ GITHUB_TOKEN: "fake", RESEARCH_REPLICA: db },
		["research:submit"],
	);
	try {
		const denied = await deniedSession.client.callTool({
			name: "get_production_health_snapshot",
			arguments: {},
		});
		assert.equal(denied.isError, true);
		assert.match(denied.content[0].text, /STATE_FORBIDDEN/);
	} finally {
		await deniedSession.close();
	}
});
