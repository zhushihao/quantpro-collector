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

function activeRecord(subjectKey) {
	return {
		subject_key: subjectKey,
		holding_status: "ACTIVE",
	};
}

function activeInstrumentRecord(instrumentKey) {
	return {
		instrument_key: instrumentKey,
		holding_status: "ACTIVE",
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
	let created = null;
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
				const posted = JSON.parse(init.body);
				const persisted = JSON.parse(
					posted.body.match(/```json\s*([\s\S]*?)\s*```/)[1],
				);
				created = comment(102, persisted, "2026-09-21T01:50:05Z");
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

test("append_market_checkpoint treats PREMARKET instrument_key and INTRADAY subject_key as the same ACTIVE membership", async () => {
	const mixedPreopen = comment(
		230,
		payload({
			date: "2026-09-24",
			slot: "09:10",
			records: [activeInstrumentRecord("300308.SZ"), activeInstrumentRecord("300502.SZ")],
			universeHash: "sha256:mixed-same",
		}),
		"2026-09-24T01:10:00Z",
	);
	const proposed = payload({
		date: "2026-09-24",
		slot: "09:50",
		previous: "230",
		preopen: "230",
		records: [activeRecord("300308.SZ"), activeRecord("300502.SZ")],
		universeHash: "sha256:mixed-same",
	});
	let created = null;
	const result = await appendMarketCheckpoint({
		token: "fake-server-secret",
		checkpoint: proposed,
		fetchImpl: async (input, init) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			if (method === "POST") {
				const posted = JSON.parse(init.body);
				const persisted = JSON.parse(
					posted.body.match(/```json\s*([\s\S]*?)\s*```/)[1],
				);
				assert.equal(persisted.universe_transition.status, "UNCHANGED");
				assert.equal(persisted.universe_transition.membership_changed, false);
				created = comment(231, persisted, "2026-09-24T01:50:05Z");
				return jsonResponse(created, { status: 201 });
			}
			if (url.endsWith("/issues/comments/231")) return jsonResponse(created);
			return jsonResponse([previousClose, mixedPreopen]);
		},
	});
	assert.equal(result.status, "PERSISTED");
	assert.equal(result.checkpoint.universe_transition.status, "UNCHANGED");
});

test("append_market_checkpoint supports instrument_key-only ACTIVE records across checkpoints", async () => {
	const instrumentPreopen = comment(
		240,
		payload({
			date: "2026-09-24",
			slot: "09:10",
			records: [activeInstrumentRecord("300308.SZ"), activeInstrumentRecord("300502.SZ")],
			universeHash: "sha256:instrument-only",
		}),
		"2026-09-24T01:10:00Z",
	);
	const proposed = payload({
		date: "2026-09-24",
		slot: "09:50",
		previous: "240",
		preopen: "240",
		records: [activeInstrumentRecord("300308.SZ"), activeInstrumentRecord("300502.SZ")],
		universeHash: "sha256:instrument-only",
	});
	let created = null;
	const result = await appendMarketCheckpoint({
		token: "fake-server-secret",
		checkpoint: proposed,
		fetchImpl: async (input, init) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			if (method === "POST") {
				const posted = JSON.parse(init.body);
				const persisted = JSON.parse(
					posted.body.match(/```json\s*([\s\S]*?)\s*```/)[1],
				);
				assert.equal(persisted.universe_transition.status, "UNCHANGED");
				created = comment(241, persisted, "2026-09-24T01:50:05Z");
				return jsonResponse(created, { status: 201 });
			}
			if (url.endsWith("/issues/comments/241")) return jsonResponse(created);
			return jsonResponse([previousClose, instrumentPreopen]);
		},
	});
	assert.equal(result.status, "PERSISTED");
});

test("append_market_checkpoint fails closed when subject_key and instrument_key conflict", async () => {
	const conflictPreopen = comment(
		250,
		payload({
			date: "2026-09-24",
			slot: "09:10",
			records: [activeInstrumentRecord("300308.SZ")],
			universeHash: "sha256:conflict",
		}),
	);
	const proposed = payload({
		date: "2026-09-24",
		slot: "09:50",
		previous: "250",
		preopen: "250",
		records: [
			{
				subject_key: "300308.SZ",
				instrument_key: "300502.SZ",
				holding_status: "ACTIVE",
			},
		],
		universeHash: "sha256:conflict",
	});
	await assert.rejects(
		appendMarketCheckpoint({
			token: "fake-server-secret",
			checkpoint: proposed,
			fetchImpl: async () => jsonResponse([previousClose, conflictPreopen]),
		}),
		(error) =>
			error instanceof MarketLedgerError &&
			error.code === "CHECKPOINT_VALIDATION_FAILED" &&
			error.message.includes("subject_key conflicts with instrument_key"),
	);
});


test("append_market_checkpoint allows ACTIVE removal and persists universe transition", async () => {
	const stablePreopen = comment(
		200,
		payload({
			date: "2026-09-22",
			slot: "09:10",
			records: [activeRecord("A"), activeRecord("B"), activeRecord("C")],
			universeHash: "sha256:abc",
		}),
		"2026-09-22T01:10:00Z",
	);
	const stable0950 = comment(
		201,
		payload({
			date: "2026-09-22",
			slot: "09:50",
			previous: "200",
			preopen: "200",
			records: [activeRecord("A"), activeRecord("B"), activeRecord("C")],
			universeHash: "sha256:abc",
		}),
		"2026-09-22T01:50:00Z",
	);
	const proposed = payload({
		date: "2026-09-22",
		slot: "10:50",
		previous: "201",
		preopen: "200",
		records: [activeRecord("A"), activeRecord("B")],
		universeHash: "sha256:ab",
	});
	let created = null;
	const result = await appendMarketCheckpoint({
		token: "fake-server-secret",
		checkpoint: proposed,
		fetchImpl: async (input, init) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			if (method === "POST") {
				const posted = JSON.parse(init.body);
				const persisted = JSON.parse(
					posted.body.match(/```json\s*([\s\S]*?)\s*```/)[1],
				);
				assert.equal(persisted.universe_transition.status, "MEMBERSHIP_CHANGED");
				assert.equal(persisted.universe_transition.membership_changed, true);
				assert.equal(persisted.universe_transition.hash_changed, true);
				assert.deepEqual(persisted.universe_transition.added_active, []);
				assert.deepEqual(persisted.universe_transition.removed_active, ["C"]);
				created = comment(202, persisted, "2026-09-22T02:50:05Z");
				return jsonResponse(created, { status: 201 });
			}
			if (url.endsWith("/issues/comments/202")) return jsonResponse(created);
			return jsonResponse([previousClose, stablePreopen, stable0950]);
		},
	});
	assert.equal(result.status, "PERSISTED");
	assert.equal(result.checkpoint.live_universe_hash, "sha256:ab");
	assert.deepEqual(result.checkpoint.universe_transition.removed_active, ["C"]);
});

test("append_market_checkpoint rejects ACTIVE membership drift when hash is unchanged", async () => {
	const stablePreopen = comment(
		210,
		payload({
			date: "2026-09-22",
			slot: "09:10",
			records: [activeRecord("A"), activeRecord("B"), activeRecord("C")],
			universeHash: "sha256:same",
		}),
	);
	const stable0950 = comment(
		211,
		payload({
			date: "2026-09-22",
			slot: "09:50",
			previous: "210",
			preopen: "210",
			records: [activeRecord("A"), activeRecord("B"), activeRecord("C")],
			universeHash: "sha256:same",
		}),
	);
	const proposed = payload({
		date: "2026-09-22",
		slot: "10:50",
		previous: "211",
		preopen: "210",
		records: [activeRecord("A"), activeRecord("B")],
		universeHash: "sha256:same",
	});
	await assert.rejects(
		appendMarketCheckpoint({
			token: "fake-server-secret",
			checkpoint: proposed,
			fetchImpl: async () => jsonResponse([previousClose, stablePreopen, stable0950]),
		}),
		(error) =>
			error instanceof MarketLedgerError &&
			error.code === "CHECKPOINT_VALIDATION_FAILED",
	);
});

test("append_market_checkpoint reports unknown top-level schema keys without echoing values", async () => {
	const proposed = {
		...payload({
			date: "2026-09-22",
			slot: "14:50",
			previous: "211",
			preopen: "210",
		}),
		unexpected_private_field: "secret-value-must-not-leak",
	};
	await assert.rejects(
		appendMarketCheckpoint({
			token: "fake-server-secret",
			checkpoint: proposed,
			fetchImpl: async () => {
				throw new Error("fetch must not run for schema rejection");
			},
		}),
		(error) =>
			error instanceof MarketLedgerError &&
			error.code === "CHECKPOINT_VALIDATION_FAILED" &&
			error.message.includes("unrecognized_keys") &&
			error.message.includes("unexpected_private_field") &&
			!error.message.includes("secret-value-must-not-leak"),
	);
});

test("append_market_checkpoint preserves idempotent replay after server-owned transition enrichment", async () => {
	const stablePreopen = comment(
		220,
		payload({
			date: "2026-09-22",
			slot: "09:10",
			records: [activeRecord("A"), activeRecord("B")],
			universeHash: "sha256:ab",
		}),
	);
	const raw = payload({
		date: "2026-09-22",
		slot: "09:50",
		previous: "220",
		preopen: "220",
		records: [activeRecord("A"), activeRecord("B")],
		universeHash: "sha256:ab",
	});
	const enriched = {
		...raw,
		universe_transition: {
			status: "UNCHANGED",
			previous_live_universe_hash: "sha256:ab",
			current_live_universe_hash: "sha256:ab",
			hash_changed: false,
			membership_changed: false,
			added_active: [],
			removed_active: [],
		},
	};
	const existing = comment(221, enriched, "2026-09-22T01:50:00Z");
	let writes = 0;
	const result = await appendMarketCheckpoint({
		token: "fake-server-secret",
		checkpoint: raw,
		fetchImpl: async (_input, init) => {
			if (init?.method === "POST") writes += 1;
			return jsonResponse([previousClose, stablePreopen, existing]);
		},
	});
	assert.equal(result.status, "IDEMPOTENT_REPLAY");
	assert.equal(writes, 0);
});

test("market ledger E2E keeps strict chain across remove, add, replace and CLOSE", async () => {
	const comments = [previousClose];
	let nextId = 300;
	const fetchImpl = async (input, init) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		if (method === "POST") {
			const posted = JSON.parse(init.body);
			const persisted = JSON.parse(
				posted.body.match(/```json\s*([\s\S]*?)\s*```/)[1],
			);
			const created = comment(nextId++, persisted, new Date().toISOString());
			comments.push(created);
			return jsonResponse(created, { status: 201 });
		}
		const match = url.match(/\/issues\/comments\/(\d+)$/);
		if (match) {
			const found = comments.find((item) => String(item.id) === match[1]);
			return jsonResponse(found);
		}
		return jsonResponse(comments);
	};

	const date = "2026-09-23";
	const steps = [
		{ slot: "09:10", keys: ["A", "B", "C"], hash: "sha256:abc" },
		{ slot: "09:50", keys: ["A", "B", "C"], hash: "sha256:abc" },
		{ slot: "10:50", keys: ["A", "B"], hash: "sha256:ab" },
		{ slot: "11:50", keys: ["A", "B", "D"], hash: "sha256:abd" },
		{ slot: "13:50", keys: ["A", "D"], hash: "sha256:ad" },
		{ slot: "16:45", keys: ["A", "D"], hash: "sha256:ad" },
	];

	let previous = null;
	let preopenId = null;
	const transitions = [];
	for (const step of steps) {
		const proposed = payload({
			date,
			slot: step.slot,
			previous,
			preopen: step.slot === "09:10" ? null : preopenId,
			records: step.keys.map(activeRecord),
			universeHash: step.hash,
		});
		const result = await appendMarketCheckpoint({
			token: "fake-server-secret",
			checkpoint: proposed,
			fetchImpl,
		});
		assert.equal(result.status, "PERSISTED");
		if (step.slot === "09:10") preopenId = result.comment_id;
		previous = result.comment_id;
		transitions.push(result.checkpoint.universe_transition);
	}

	assert.equal(transitions[0].status, "BASELINE");
	assert.equal(transitions[1].status, "UNCHANGED");
	assert.deepEqual(transitions[2].removed_active, ["C"]);
	assert.deepEqual(transitions[3].added_active, ["D"]);
	assert.deepEqual(transitions[4].removed_active, ["B"]);
	assert.equal(transitions[5].status, "UNCHANGED");
	const close = comments[comments.length - 1].body;
	assert.match(close, /"observation_type": "CLOSE"/);
});
