import assert from "node:assert/strict";
import test from "node:test";

import {
	appendMarketCheckpoint,
	getMarketCheckpoints,
	MarketLedgerError,
} from "../src/market-ledger.ts";

const PROD_REF = "a".repeat(40);
const UNIVERSE_HASH = "sha256:test-universe";

function payload({
	date,
	slot,
	previous = null,
	preopen = null,
	records = [],
	productionRef = PROD_REF,
	universeHash = UNIVERSE_HASH,
}) {
	const premarket = slot === "09:10";
	const close = slot === "16:45";
	return {
		schema_version: premarket
			? "premarket_plan_batch_v1"
			: "market_observation_batch_v1",
		prompt_id: "holding-assistant",
		production_ref: productionRef,
		portfolio_version: "live:test",
		event_id: `${date}T${slot}|holding-assistant|BATCH`,
		idempotency_key: `holding-assistant:${date}:${slot}`,
		trading_date: date,
		as_of: `${date}T${slot}:00+08:00`,
		scheduled_slot: slot,
		producer: "holding-assistant",
		observation_type: premarket ? "PREMARKET" : close ? "CLOSE" : "INTRADAY",
		previous_checkpoint_comment_id: previous,
		preopen_comment_id: preopen,
		live_universe_hash: universeHash,
		source_task: "持仓助手",
		records,
	};
}

function comment(id, checkpoint, createdAt = "2026-09-21T01:10:00Z") {
	return {
		id,
		html_url: `https://github.com/zhushihao/quantpro-collector/issues/2#issuecomment-${id}`,
		url: `https://api.github.com/repos/zhushihao/quantpro-collector/issues/comments/${id}`,
		created_at: createdAt,
		body: `\`\`\`json\n${JSON.stringify(checkpoint, null, 2)}\n\`\`\``,
	};
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

const previousClose = comment(
	90,
	payload({
		date: "2026-09-18",
		slot: "16:45",
		previous: "89",
		preopen: "80",
	}),
	"2026-09-18T08:45:00Z",
);
const preopen = comment(
	100,
	payload({ date: "2026-09-21", slot: "09:10" }),
	"2026-09-21T01:10:00Z",
);
const firstIntraday = comment(
	101,
	payload({
		date: "2026-09-21",
		slot: "09:50",
		previous: "100",
		preopen: "100",
	}),
	"2026-09-21T01:50:00Z",
);

test("get_market_checkpoints resolves preopen, previous checkpoint and prior close server-side", async () => {
	const requests = [];
	const state = await getMarketCheckpoints({
		token: "fake-server-secret",
		tradingDate: "2026-09-21",
		scheduledSlot: "10:50",
		fetchImpl: async (input, init) => {
			requests.push({ url: String(input), method: init?.method ?? "GET" });
			return jsonResponse([previousClose, preopen, firstIntraday]);
		},
	});
	assert.equal(state.status, "OK");
	assert.equal(state.preopen.comment_id, "100");
	assert.equal(state.previous_checkpoint.comment_id, "101");
	assert.equal(state.previous_close.comment_id, "90");
	assert.equal(state.current_slot, null);
	assert.equal(requests.length, 1);
	assert.match(requests[0].url, /per_page=100/);
	assert.match(requests[0].url, /since=/);
});

test("get_market_checkpoints follows GitHub pagination without exposing it to the caller", async () => {
	let calls = 0;
	const nextUrl =
		"https://api.github.com/repos/zhushihao/quantpro-collector/issues/2/comments?page=2";
	const state = await getMarketCheckpoints({
		token: "fake-server-secret",
		tradingDate: "2026-09-21",
		scheduledSlot: "09:50",
		fetchImpl: async (input) => {
			calls += 1;
			if (String(input).includes("page=2")) {
				return jsonResponse([preopen]);
			}
			return jsonResponse([previousClose], {
				headers: { Link: `<${nextUrl}>; rel="next"` },
			});
		},
	});
	assert.equal(calls, 2);
	assert.equal(state.previous_close.comment_id, "90");
	assert.equal(state.previous_checkpoint.comment_id, "100");
});

test("append_market_checkpoint returns idempotent replay for identical existing slot", async () => {
	let writes = 0;
	const result = await appendMarketCheckpoint({
		token: "fake-server-secret",
		checkpoint: firstIntraday.body
			? JSON.parse(firstIntraday.body.match(/\`\`\`json\s*([\s\S]*?)\s*\`\`\`/)[1])
			: null,
		fetchImpl: async (_input, init) => {
			if (init?.method === "POST") writes += 1;
			return jsonResponse([previousClose, preopen, firstIntraday]);
		},
	});
	assert.equal(result.status, "IDEMPOTENT_REPLAY");
	assert.equal(result.comment_id, "101");
	assert.equal(writes, 0);
});

test("append_market_checkpoint rejects same idempotency key with different content", async () => {
	const proposed = payload({
		date: "2026-09-21",
		slot: "09:50",
		previous: "100",
		preopen: "100",
		records: [{ instrument_key: "300308.SZ", note: "new-content" }],
	});
	await assert.rejects(
		appendMarketCheckpoint({
			token: "fake-server-secret",
			checkpoint: proposed,
			fetchImpl: async () =>
				jsonResponse([previousClose, preopen, firstIntraday]),
		}),
		(error) =>
			error instanceof MarketLedgerError &&
			error.code === "CHECKPOINT_CONFLICT",
	);
});

test("append_market_checkpoint appends fixed Issue #2 and verifies readback", async () => {
	const proposed = payload({
		date: "2026-09-21",
		slot: "09:50",
		previous: "100",
		preopen: "100",
		records: [{ instrument_key: "300308.SZ", gate_status: "PENDING" }],
	});
	const created = comment(
		102,
		proposed,
		"2026-09-21T01:50:05Z",
	);
	const requests = [];
	const result = await appendMarketCheckpoint({
		token: "fake-server-secret",
		checkpoint: proposed,
		fetchImpl: async (input, init) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			requests.push({ url, method, body: init?.body ?? null });
			if (method === "POST") {
				assert.equal(
					url,
					"https://api.github.com/repos/zhushihao/quantpro-collector/issues/2/comments",
				);
				return jsonResponse(created, { status: 201 });
			}
			if (url.endsWith("/issues/comments/102")) {
				return jsonResponse(created);
			}
			return jsonResponse([previousClose, preopen]);
		},
	});
	assert.equal(result.status, "PERSISTED");
	assert.equal(result.comment_id, "102");
	assert.equal(requests.filter((request) => request.method === "POST").length, 1);
	assert.equal(
		requests.some((request) => request.url.includes("/issues/1")),
		false,
	);
});

test("append_market_checkpoint fails closed when checkpoint chain is stale", async () => {
	const proposed = payload({
		date: "2026-09-21",
		slot: "09:50",
		previous: "stale-comment-id",
		preopen: "100",
	});
	await assert.rejects(
		appendMarketCheckpoint({
			token: "fake-server-secret",
			checkpoint: proposed,
			fetchImpl: async () => jsonResponse([previousClose, preopen]),
		}),
		(error) =>
			error instanceof MarketLedgerError &&
			error.code === "CHECKPOINT_CHAIN_MISMATCH",
	);
});
