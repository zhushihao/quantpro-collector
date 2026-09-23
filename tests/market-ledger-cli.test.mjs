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

test("market-ledger get uses fixed transport without exposing credential", async () => {
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

test("market-ledger get returns bounded slot summary instead of duplicating full day history", async () => {
	const historicalOnlyRecord = "historical-record-must-not-be-projected";
	const h = harness({
		getMarketCheckpoints: async () => ({
			status: "OK",
			trading_date: "2026-09-23",
			scheduled_slot: "13:50",
			preopen: null,
			previous_checkpoint: null,
			previous_close: {
				comment_id: "400",
				created_at: "2026-09-22T08:45:00Z",
				payload: {
					trading_date: "2026-09-22",
					scheduled_slot: "16:45",
					idempotency_key: "holding-assistant:2026-09-22:16:45",
					production_ref: "b".repeat(40),
					live_universe_hash: "sha256:previous-close",
					records: [{ note: "previous-close-record-must-not-be-projected" }],
				},
			},
			current_slot: null,
			current_day_checkpoints: [
				{
					comment_id: "501",
					created_at: "2026-09-23T01:50:00Z",
					payload: {
						scheduled_slot: "09:50",
						idempotency_key: "holding-assistant:2026-09-23:09:50",
						live_universe_hash: "sha256:slot-0950",
						records: [{ note: historicalOnlyRecord }],
					},
				},
			],
			conflicts: [],
		}),
	});
	const code = await runMarketLedgerCli(
		["get", "--trading-date", "2026-09-23", "--scheduled-slot", "13:50"],
		h.deps,
	);
	assert.equal(code, 0);
	const output = JSON.parse(h.stdout[0]);
	assert.equal("current_day_checkpoints" in output, false);
	assert.deepEqual(output.current_day_slots, [
		{
			scheduled_slot: "09:50",
			comment_id: "501",
			created_at: "2026-09-23T01:50:00Z",
			idempotency_key: "holding-assistant:2026-09-23:09:50",
			live_universe_hash: "sha256:slot-0950",
		},
	]);
	assert.deepEqual(output.previous_close, {
		comment_id: "400",
		created_at: "2026-09-22T08:45:00Z",
		payload: {
			trading_date: "2026-09-22",
			scheduled_slot: "16:45",
			idempotency_key: "holding-assistant:2026-09-22:16:45",
			production_ref: "b".repeat(40),
			live_universe_hash: "sha256:previous-close",
		},
	});
	assert.equal(
		h.stdout[0].includes("previous-close-record-must-not-be-projected"),
		false,
	);
	assert.equal(h.stdout[0].includes(historicalOnlyRecord), false);
});


test("market-ledger get compacts preopen and previous records to execution essentials", async () => {
	const h = harness({
		getMarketCheckpoints: async () => ({
			status: "OK",
			trading_date: "2026-09-23",
			scheduled_slot: "13:50",
			preopen: {
				comment_id: "700",
				created_at: "2026-09-23T01:10:00Z",
				payload: {
					schema_version: "premarket_plan_batch_v1",
					prompt_id: "holding-assistant",
					production_ref: "c".repeat(40),
					portfolio_version: "live:test",
					event_id: "preopen",
					idempotency_key: "holding-assistant:2026-09-23:09:10",
					trading_date: "2026-09-23",
					as_of: "2026-09-23T09:10:00+08:00",
					scheduled_slot: "09:10",
					observation_type: "PREMARKET",
					previous_checkpoint_comment_id: null,
					preopen_comment_id: null,
					live_universe_hash: "sha256:preopen",
					records: [{
						instrument_key: "300489.SZ",
						name: "光智科技",
						group: "Watch",
						holding_status: "ACTIVE",
						previous_close_pct_change: 4.27,
						action_gates: [{
							action_gate_id: "g1",
							original_condition: "承接条件",
						}],
						large_internal_blob: "must-not-project",
					}],
				},
			},
			previous_checkpoint: {
				comment_id: "701",
				created_at: "2026-09-23T03:50:00Z",
				payload: {
					schema_version: "market_observation_batch_v1",
					prompt_id: "holding-assistant",
					production_ref: "c".repeat(40),
					portfolio_version: "live:test",
					event_id: "intraday",
					idempotency_key: "holding-assistant:2026-09-23:11:50",
					trading_date: "2026-09-23",
					as_of: "2026-09-23T11:50:00+08:00",
					scheduled_slot: "11:50",
					observation_type: "INTRADAY",
					previous_checkpoint_comment_id: "700",
					preopen_comment_id: "700",
					live_universe_hash: "sha256:intraday",
					records: [{
						subject_key: "300489.SZ",
						name: "光智科技",
						group: "Watch",
						holding_status: "ACTIVE",
						price: 244.78,
						pct_change: -1.7,
						market_data_time: "2026-09-23T11:49:51+08:00",
						gate_status: "FAIL",
						large_market_blob: "must-not-project-either",
					}],
				},
			},
			previous_close: null,
			current_slot: null,
			current_day_checkpoints: [],
			conflicts: [],
		}),
	});
	const code = await runMarketLedgerCli(
		["get", "--trading-date", "2026-09-23", "--scheduled-slot", "13:50"],
		h.deps,
	);
	assert.equal(code, 0);
	const output = JSON.parse(h.stdout[0]);
	assert.equal(output.preopen.payload.records[0].action_gates[0].action_gate_id, "g1");
	assert.equal(output.previous_checkpoint.payload.records[0].price, 244.78);
	assert.equal(h.stdout[0].includes("must-not-project"), false);
	assert.equal(h.stdout[0].includes("must-not-project-either"), false);
});

test("market-ledger append accepts checkpoint only from stdin and keeps target fixed", async () => {
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

test("market-ledger append drops server-owned universe_transition before validation", async () => {
	const serverEnrichedCheckpoint = {
		...checkpoint,
		universe_transition: {
			status: "MEMBERSHIP_CHANGED",
			previous_live_universe_hash: "sha256:before",
			current_live_universe_hash: "sha256:after",
			hash_changed: true,
			membership_changed: true,
			added_active: [],
			removed_active: ["300394.SZ"],
		},
	};
	const h = harness({
		readStdin: async () => JSON.stringify(serverEnrichedCheckpoint),
		appendMarketCheckpoint: async (input) => {
			assert.equal("universe_transition" in input.checkpoint, false);
			assert.deepEqual(input.checkpoint, checkpoint);
			return { status: "PERSISTED", persisted: true, comment_id: "124" };
		},
	});
	const code = await runMarketLedgerCli(["append"], h.deps);
	assert.equal(code, 0);
	assert.equal(h.stderr.length, 0);
});

test("market-ledger transport rejects repo issue token and arbitrary append arguments", async () => {
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
