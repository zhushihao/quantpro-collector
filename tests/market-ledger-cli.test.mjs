import assert from "node:assert/strict";
import test from "node:test";

import { runMarketLedgerCli } from "../scripts/market-ledger-cli.mjs";

const checkpoint = {
	schema_version: "premarket_plan_batch_v1",
	prompt_id: "holding-assistant",
	production_ref: "a".repeat(40),
	portfolio_version: "live:test",
	event_id: "preopen-test",
	idempotency_key: "holding-assistant:2026-09-21:09:10",
	trading_date: "2026-09-21",
	as_of: "2026-09-21T10:10:00+08:00",
	scheduled_slot: "09:10",
	producer: "holding-assistant",
	observation_type: "PREMARKET",
	previous_checkpoint_comment_id: null,
	preopen_comment_id: null,
	live_universe_hash: "sha256:test",
	source_task: "持仓助手｜盘前+收盘",
	records: [],
};

function harness(overrides = {}) {
	const stdout = [];
	const stderr = [];
	return {
		stdout,
		stderr,
		deps: {
			tokenProvider: async () => "secret-token-that-must-not-leak",
			writeStdout: (text) => stdout.push(text),
			writeStderr: (text) => stderr.push(text),
			...overrides,
		},
	};
}

test("compat get uses fixed market-ledger API without exposing credential", async () => {
	const h = harness({
		getMarketCheckpoints: async (input) => {
			assert.equal(input.token, "secret-token-that-must-not-leak");
			assert.equal(input.tradingDate, "2026-09-21");
			assert.equal(input.scheduledSlot, "09:10");
			return { status: "OK", preopen: null };
		},
	});
	const code = await runMarketLedgerCli(
		["get", "--trading-date", "2026-09-21", "--scheduled-slot", "09:10"],
		h.deps,
	);
	assert.equal(code, 0);
	assert.equal(h.stderr.length, 0);
	assert.equal(JSON.parse(h.stdout[0]).status, "OK");
	assert.equal(h.stdout.join("\n").includes("secret-token"), false);
});

test("compat append accepts checkpoint only from stdin and keeps target fixed", async () => {
	const h = harness({
		readStdin: async () => JSON.stringify(checkpoint),
		appendMarketCheckpoint: async (input) => {
			assert.equal(input.token, "secret-token-that-must-not-leak");
			assert.deepEqual(input.checkpoint, checkpoint);
			return { status: "PERSISTED", persisted: true, comment_id: "123" };
		},
	});
	const code = await runMarketLedgerCli(["append"], h.deps);
	assert.equal(code, 0);
	assert.equal(h.stderr.length, 0);
	assert.equal(JSON.parse(h.stdout[0]).status, "PERSISTED");
	assert.equal(h.stdout.join("\n").includes("secret-token"), false);
});

test("compat bridge rejects repo issue token and arbitrary append arguments", async () => {
	for (const args of [
		["get", "--repo", "other/repo", "--scheduled-slot", "09:10"],
		["get", "--trading-date", "2026-09-21", "--issue", "99"],
		["get", "--trading-date", "2026-09-21", "--token", "bad"],
		["append", "--repo", "other/repo"],
	]) {
		const h = harness();
		const code = await runMarketLedgerCli(args, h.deps);
		assert.equal(code, 1);
		assert.equal(h.stdout.length, 0);
		assert.equal(JSON.parse(h.stderr[0]).status, "CHECKPOINT_VALIDATION_FAILED");
	}
});

test("unexpected credential failures are redacted", async () => {
	const h = harness({
		tokenProvider: async () => {
			throw new Error("raw-secret-should-never-appear");
		},
	});
	const code = await runMarketLedgerCli(
		["get", "--trading-date", "2026-09-21", "--scheduled-slot", "09:10"],
		h.deps,
	);
	assert.equal(code, 1);
	assert.equal(h.stdout.length, 0);
	assert.equal(h.stderr.join("\n").includes("raw-secret"), false);
	assert.equal(JSON.parse(h.stderr[0]).status, "MARKET_LEDGER_UNAVAILABLE");
});
