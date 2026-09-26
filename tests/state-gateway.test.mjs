import assert from "node:assert/strict";
import test from "node:test";

import { appendStateBatch, StateGatewayError, validateStateBatch } from "../src/state-gateway.ts";
import { getStateWriteReceipt, getStateWriteReceiptSummary } from "../src/state-receipts.ts";

class FakeD1 {
	constructor() {
		this.rows = new Map();
		this.tableExists = false;
	}
	prepare(sql) {
		const db = this;
		return {
			args: [],
			bind(...args) {
				this.args = args;
				return this;
			},
			async run() {
				const args = this.args;
				if (sql.startsWith("CREATE TABLE")) {
					db.tableExists = true;
					return { success: true };
				}
				if (sql.includes("INSERT OR IGNORE")) {
					const [writeKey, channel, hash, now] = args;
					if (!db.rows.has(writeKey)) {
						db.rows.set(writeKey, {
							write_key: writeKey,
							channel,
							payload_sha256: hash,
							status: "PENDING",
							comment_id: null,
							comment_url: null,
							attempt_count: 0,
							lease_owner: null,
							lease_until: null,
							created_at: now,
							updated_at: now,
							last_error_code: null,
							last_error_phase: null,
							last_http_status: null,
						});
					}
					return { success: true };
				}
				if (sql.includes("SET status='PENDING'")) {
					const [writeKey, owner, leaseUntil, now, hash, channel] = args;
					const row = db.rows.get(writeKey);
					if (
						row &&
						row.payload_sha256 === hash &&
						row.channel === channel &&
						!["PERSISTED", "IDEMPOTENT_REPLAY", "CONFLICT"].includes(row.status) &&
						(!row.lease_owner ||
							!row.lease_until ||
							row.lease_until < now ||
							row.lease_owner === owner)
					) {
						Object.assign(row, {
							status: "PENDING",
							attempt_count: row.attempt_count + 1,
							lease_owner: owner,
							lease_until: leaseUntil,
							updated_at: now,
						});
					}
					return { success: true };
				}
				if (sql.includes("SET status=?3")) {
					const [
						writeKey,
						owner,
						status,
						commentId,
						commentUrl,
						updatedAt,
						errorCode,
						phase,
						http,
					] = args;
					const row = db.rows.get(writeKey);
					if (row?.lease_owner === owner) {
						Object.assign(row, {
							status,
							comment_id: commentId,
							comment_url: commentUrl,
							lease_owner: null,
							lease_until: null,
							updated_at: updatedAt,
							last_error_code: errorCode,
							last_error_phase: phase,
							last_http_status: http,
						});
					}
					return { success: true };
				}
				throw new Error(`unsupported fake D1 run SQL: ${sql}`);
			},
			async first() {
				if (sql.includes("sqlite_master")) {
					return db.tableExists ? { name: "state_write_receipts_v1" } : null;
				}
				if (sql.includes("WHERE write_key = ?1")) {
					return db.rows.get(this.args[0]) ?? null;
				}
				if (sql.includes("MAX(CASE WHEN status")) {
					const rows = [...db.rows.values()];
					const max = (statuses) => {
						const values = rows
							.filter((r) => statuses.includes(r.status))
							.map((r) => r.updated_at)
							.sort();
						return values.at(-1) ?? null;
					};
					return {
						last_successful_state_write_at: max(["PERSISTED", "IDEMPOTENT_REPLAY"]),
						last_failed_state_write_at: max(["OUTCOME_UNKNOWN", "CONFLICT", "FAILED"]),
					};
				}
				throw new Error(`unsupported fake D1 first SQL: ${sql}`);
			},
		};
	}
}

test("receipt read helpers are genuinely read-only before the receipt table exists", async () => {
	const db = new FakeD1();
	assert.equal(db.tableExists, false);
	assert.equal(await getStateWriteReceipt(db, "missing"), null);
	assert.deepEqual(await getStateWriteReceiptSummary(db), {
		last_successful_state_write_at: null,
		last_failed_state_write_at: null,
	});
	assert.equal(db.tableExists, false);
});

function industryBatch() {
	return {
		schema_version: "investment_state_batch_v1",
		portfolio_version: "live:sha256:test",
		event_id: "20260926T203000+08|industry_trend|BATCH",
		as_of: "2026-09-26T20:30:00+08:00",
		events: [
			{
				symbol: "CN:300308",
				event_type: "EVIDENCE_ADD",
				research_priority: "P0",
				industry_thesis: "fresh industrial fact",
				r_proposal: "R1",
				evidence_types: ["D", "P"],
				evidence_keys: ["20260926|TEST|FACT"],
				counter_evidence: ["counter"],
				confidence: 0.9,
				next_validation: "next",
			},
		],
	};
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

test("validate_state_batch fixes channel semantics and never accepts caller-owned routing keys", async () => {
	const valid = await validateStateBatch("INDUSTRY", industryBatch());
	assert.equal(valid.status, "VALID");
	assert.equal(valid.write_key, "20260926T203000+08|industry_trend|BATCH");
	assert.equal(valid.payload_sha256.length, 64);

	await assert.rejects(
		validateStateBatch("INDUSTRY", { ...industryBatch(), repo: "other/repo" }),
		(error) => error instanceof StateGatewayError && error.code === "STATE_VALIDATION_FAILED",
	);
});

test("append_state_batch persists once, records receipt and replays without a second GitHub write", async () => {
	const db = new FakeD1();
	const batch = industryBatch();
	let postCount = 0;
	let created = null;
	const fetchImpl = async (target, init) => {
		const url = String(target);
		const method = init?.method ?? "GET";
		if (method === "POST") {
			postCount += 1;
			const posted = JSON.parse(init.body);
			const payload = JSON.parse(posted.body.match(/```json\s*([\s\S]*?)\s*```/)[1]);
			created = {
				id: 9001,
				created_at: "2026-09-26T12:30:00Z",
				html_url:
					"https://github.com/zhushihao/quantpro-collector/issues/3#issuecomment-9001",
				body: `\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``,
			};
			return jsonResponse(created, { status: 201 });
		}
		if (url.endsWith("/issues/comments/9001")) return jsonResponse(created);
		return jsonResponse([]);
	};

	const first = await appendStateBatch({
		db,
		token: "fake",
		channel: "INDUSTRY",
		batch,
		fetchImpl,
		now: "2026-09-26T12:30:00Z",
		requestId: "request-one",
	});
	assert.equal(first.status, "PERSISTED");
	assert.equal(first.receipt.status, "PERSISTED");
	assert.equal(first.receipt.comment_id, "9001");
	assert.equal(postCount, 1);

	const replay = await appendStateBatch({
		db,
		token: "fake",
		channel: "INDUSTRY",
		batch,
		fetchImpl: async () => {
			throw new Error("replay must be satisfied from persisted receipt");
		},
		now: "2026-09-26T12:31:00Z",
		requestId: "request-two",
	});
	assert.equal(replay.status, "IDEMPOTENT_REPLAY");
	assert.equal(postCount, 1);
});

test("CLOSE profile fails closed without upstream COMPANY R2", async () => {
	const db = new FakeD1();
	const close = {
		schema_version: "investment_state_batch_v1",
		portfolio_version: "live:sha256:test",
		event_id: "20260926T204500+08|close_review|BATCH",
		as_of: "2026-09-26T20:45:00+08:00",
		events: [
			{
				symbol: "CN:300308",
				event_type: "STATE_CHANGE",
				effective_r_state: "R3",
				market_confirmation: "waiting for sustained confirmation",
				r4_candidate: false,
				close_thesis_view: "unchanged",
				evidence_types: [],
				evidence_keys: [],
				counter_evidence: [],
				confidence: 0.8,
				next_validation: "next close",
			},
		],
	};
	await assert.rejects(
		appendStateBatch({
			db,
			token: "fake",
			channel: "CLOSE",
			batch: close,
			fetchImpl: async () => jsonResponse([]),
			requestId: "close-no-r2",
		}),
		(error) => error instanceof StateGatewayError && error.code === "STATE_CHAIN_MISMATCH",
	);
	assert.equal(db.rows.size, 0, "dependency failure must happen before receipt reservation");
});

function closeBatch({ effectiveR = "R4", candidate = true } = {}) {
	return {
		schema_version: "investment_state_batch_v1",
		portfolio_version: "live:sha256:test",
		event_id: "20260926T204500+08|close_review|BATCH",
		as_of: "2026-09-26T20:45:00+08:00",
		events: [
			{
				symbol: "CN:300308",
				event_type: "STATE_CHANGE",
				effective_r_state: effectiveR,
				market_confirmation: "sustained market confirmation",
				r4_candidate: candidate,
				close_thesis_view: "confirmed",
				evidence_types: [],
				evidence_keys: [],
				counter_evidence: [],
				confidence: 0.9,
				next_validation: "next close",
			},
		],
	};
}

function companyR2Comment() {
	const payload = {
		schema_version: "investment_state_batch_v1",
		portfolio_version: "live:sha256:test",
		event_id: "20260925T180000+08|company_validation|BATCH",
		as_of: "2026-09-25T18:00:00+08:00",
		producer: "company_validation",
		source_task: "公司事实监控",
		events: [
			{
				symbol: "CN:300308",
				dimension: "COMPANY",
				event_type: "CONFIRMATION",
				r_proposal: "R2",
				evidence_types: ["P"],
				evidence_keys: ["20260925|TEST|R2"],
				counter_evidence: [],
				confidence: 0.9,
				next_validation: "market confirmation",
			},
		],
	};
	return {
		id: 7001,
		created_at: "2026-09-25T10:00:00Z",
		html_url: "https://github.com/zhushihao/quantpro-collector/issues/3#issuecomment-7001",
		body: "```json\n" + JSON.stringify(payload, null, 2) + "\n```",
	};
}

function marketCloseComment(id, tradingDate, confirmationStatus) {
	const payload = {
		schema_version: "market_observation_batch_v1",
		prompt_id: "holding-assistant",
		production_ref: "1".repeat(40),
		portfolio_version: `live:${tradingDate}`,
		event_id: `${tradingDate.replaceAll("-", "")}T164500+08|holding-assistant|BATCH`,
		idempotency_key: `holding-assistant:${tradingDate}:16:45`,
		trading_date: tradingDate,
		as_of: `${tradingDate}T16:45:00+08:00`,
		scheduled_slot: "16:45",
		producer: "holding-assistant",
		observation_type: "CLOSE",
		previous_checkpoint_comment_id: null,
		preopen_comment_id: null,
		live_universe_hash: `hash-${tradingDate}`,
		source_task: "持仓助手",
		records: [
			{
				subject_key: "300308.SZ",
				holding_status: "ACTIVE",
				continuous_market_structure: {
					status: confirmationStatus,
					observed_sessions: 3,
					relative_positive_sessions: confirmationStatus === "CONFIRMED" ? 3 : 2,
					required_sessions: 3,
				},
			},
		],
	};
	return {
		id,
		created_at: `${tradingDate}T08:45:00Z`,
		html_url: `https://github.com/zhushihao/quantpro-collector/issues/2#issuecomment-${id}`,
		body: "```json\n" + JSON.stringify(payload, null, 2) + "\n```",
	};
}

function closeDependencyFetch(previousStatus, currentStatus) {
	const company = companyR2Comment();
	const previous = marketCloseComment(8001, "2026-09-25", previousStatus);
	const current = marketCloseComment(8002, "2026-09-26", currentStatus);
	return async (target) => {
		const url = String(target);
		if (url.includes("/issues/3/comments")) return jsonResponse([company]);
		if (url.includes("/issues/2/comments")) return jsonResponse([previous, current]);
		return jsonResponse([]);
	};
}

test("CLOSE R4 candidate requires same-symbol sustained confirmation at the current close", async () => {
	const db = new FakeD1();
	await assert.rejects(
		appendStateBatch({
			db,
			token: "fake",
			channel: "CLOSE",
			batch: closeBatch({ effectiveR: "R3", candidate: true }),
			fetchImpl: closeDependencyFetch("CONFIRMED", "NOT_CONFIRMED"),
			requestId: "candidate-not-confirmed",
		}),
		(error) => error instanceof StateGatewayError && error.code === "STATE_CHAIN_MISMATCH",
	);
	assert.equal(db.rows.size, 0);
});

test("formal CLOSE R4 requires the same symbol confirmed at two closes", async () => {
	const db = new FakeD1();
	await assert.rejects(
		appendStateBatch({
			db,
			token: "fake",
			channel: "CLOSE",
			batch: closeBatch(),
			fetchImpl: closeDependencyFetch("NOT_CONFIRMED", "CONFIRMED"),
			requestId: "formal-r4-one-close",
		}),
		(error) => error instanceof StateGatewayError && error.code === "STATE_CHAIN_MISMATCH",
	);
	assert.equal(db.rows.size, 0);
});

test("CLOSE R1 requires an explicit upstream INDUSTRY R1", async () => {
	const db = new FakeD1();
	await assert.rejects(
		appendStateBatch({
			db,
			token: "fake",
			channel: "CLOSE",
			batch: closeBatch({ effectiveR: "R1", candidate: false }),
			fetchImpl: async () => jsonResponse([]),
			requestId: "close-r1-without-industry",
		}),
		(error) => error instanceof StateGatewayError && error.code === "STATE_CHAIN_MISMATCH",
	);
	assert.equal(db.rows.size, 0);
});

test("CLOSE R2 requires an explicit upstream COMPANY R2", async () => {
	const db = new FakeD1();
	await assert.rejects(
		appendStateBatch({
			db,
			token: "fake",
			channel: "CLOSE",
			batch: closeBatch({ effectiveR: "R2", candidate: false }),
			fetchImpl: async () => jsonResponse([]),
			requestId: "close-r2-without-company",
		}),
		(error) => error instanceof StateGatewayError && error.code === "STATE_CHAIN_MISMATCH",
	);
	assert.equal(db.rows.size, 0);
});
