import assert from "node:assert/strict";
import test from "node:test";

import {
	appendInvestmentCommand,
	buildInvestmentCommandBatch,
	buildMarketObservationBatch,
} from "../src/state-commands.ts";
import { StateGatewayError } from "../src/state-gateway.ts";
import { createResearchWorkflowDb } from "./helpers/d1-sqlite-shim.mjs";

function companyCommand(extra = {}) {
	return {
		as_of: "2026-09-27T20:10:00+08:00",
		run_id: "run_test_company",
		server_owned_top_level: "ignored",
		events: [
			{
				symbol: "CN:605376",
				event_type: "EVIDENCE_UPDATE",
				company_thesis: "质押续作不改变经营主逻辑。",
				company_validation: "新增质押仅作为低价值资本行为留痕。",
				r_proposal: null,
				evidence_types: ["C", "C"],
				evidence_keys: ["20260921|BOQIAN|PLEDGE|RENEWAL", "20260921|BOQIAN|PLEDGE|RENEWAL"],
				counter_evidence: ["未形成订单、利润或现金流新增证据"],
				confidence: 0.92,
				next_validation: "只跟踪质押比例是否跨新风险阈值。",
				effective_r_state: "R4",
				industry_thesis: "wrong-owner field",
				producer: "caller-must-not-own",
				dimension: "CLOSE",
				foo: "bar",
			},
		],
		...extra,
	};
}

test("#37 COMPANY command projects owned fields and ignores other-owner/system fields", async () => {
	const prepared = await buildInvestmentCommandBatch({
		channel: "COMPANY",
		command: companyCommand(),
		portfolioVersion: "live:sha256:portfolio-a",
	});
	const event = prepared.batch.events[0];
	assert.equal(event.symbol, "CN:605376");
	assert.equal(event.company_thesis, "质押续作不改变经营主逻辑。");
	assert.equal("effective_r_state" in event, false);
	assert.equal("industry_thesis" in event, false);
	assert.equal("producer" in event, false);
	assert.equal("dimension" in event, false);
	assert.equal("foo" in event, false);
	assert.equal("server_owned_top_level" in prepared.batch, false);
	assert.deepEqual(event.evidence_types, ["C"]);
	assert.deepEqual(event.evidence_keys, ["20260921|BOQIAN|PLEDGE|RENEWAL"]);
	assert.match(prepared.batch.event_id, /^CMD:[0-9a-f]{64}\|company_validation\|BATCH$/);
});

test("#37 ignored fields and run_id do not change the business write identity", async () => {
	const left = await buildInvestmentCommandBatch({
		channel: "COMPANY",
		command: companyCommand(),
		portfolioVersion: "live:sha256:portfolio-a",
	});
	const right = await buildInvestmentCommandBatch({
		channel: "COMPANY",
		command: companyCommand({
			run_id: "run_other",
			another_unknown: 42,
		}),
		portfolioVersion: "live:sha256:portfolio-b",
	});
	assert.equal(left.writeKey, right.writeKey);
	assert.equal(left.payloadSha256, right.payloadSha256);
	assert.equal(left.batch.event_id, right.batch.event_id);
	assert.notEqual(left.batch.portfolio_version, right.batch.portfolio_version);
});

test("#37 core COMPANY input remains strict", async () => {
	await assert.rejects(
		buildInvestmentCommandBatch({
			channel: "COMPANY",
			command: companyCommand({
				events: [{ ...companyCommand().events[0], symbol: "605376" }],
			}),
			portfolioVersion: "live:sha256:test",
		}),
		(error) =>
			error instanceof StateGatewayError &&
			error.code === "STATE_VALIDATION_FAILED" &&
			error.phase === "VALIDATE" &&
			error.retryable === false,
	);
	await assert.rejects(
		buildInvestmentCommandBatch({
			channel: "COMPANY",
			command: companyCommand({
				events: [{ ...companyCommand().events[0], r_proposal: "R1" }],
			}),
			portfolioVersion: "live:sha256:test",
		}),
		(error) => error instanceof StateGatewayError && error.code === "STATE_VALIDATION_FAILED",
	);
});

function jsonResponse(body, { status = 200, headers = {} } = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

test("#37 owner command persists once and replays across server metadata drift", async () => {
	const db = createResearchWorkflowDb();
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
				id: 9901,
				created_at: "2026-09-27T12:10:00Z",
				html_url:
					"https://github.com/zhushihao/quantpro-collector/issues/3#issuecomment-9901",
				body: ````json\n${JSON.stringify(payload, null, 2)}\n````,
			};
			return jsonResponse(created, { status: 201 });
		}
		if (url.endsWith("/issues/comments/9901")) return jsonResponse(created);
		return jsonResponse([]);
	};

	const first = await appendInvestmentCommand({
		db,
		token: "fake",
		channel: "COMPANY",
		command: companyCommand(),
		portfolioVersion: "live:sha256:first",
		fetchImpl,
		now: "2026-09-27T12:10:00Z",
		requestId: "owner-command-one",
	});
	assert.equal(first.status, "PERSISTED");
	assert.equal(postCount, 1);

	const replay = await appendInvestmentCommand({
		db,
		token: "fake",
		channel: "COMPANY",
		command: companyCommand({ run_id: "run_retry" }),
		portfolioVersion: "live:sha256:changed-after-first-write",
		fetchImpl: async () => {
			throw new Error("receipt replay must not reach GitHub");
		},
		now: "2026-09-27T12:11:00Z",
		requestId: "owner-command-two",
	});
	assert.equal(replay.status, "IDEMPOTENT_REPLAY");
	assert.equal(postCount, 1);
	assert.equal(first.write_key, replay.write_key);
	assert.equal(first.payload_sha256, replay.payload_sha256);
});

test("#37 MARKET command derives routing and chain metadata server-side", async () => {
	let reads = 0;
	const built = await buildMarketObservationBatch({
		token: "fake",
		command: {
			trading_date: "2026-09-28",
			as_of: "2026-09-28T09:10:00+08:00",
			scheduled_slot: "09:10",
			production_ref: "a".repeat(40),
			records: [{ subject_key: "605376.SH", holding_status: "ACTIVE" }],
			run_id: "run_market",
			producer: "caller-ignored",
			idempotency_key: "caller-ignored",
			live_universe_hash: "caller-ignored",
		},
		portfolioVersion: "live:sha256:server-portfolio",
		liveUniverseHash: "sha256:server-universe",
		fetchImpl: async () => {
			reads += 1;
			return jsonResponse([]);
		},
	});
	assert.ok(reads >= 1);
	assert.equal(built.batch.prompt_id, "holding-assistant");
	assert.equal(built.batch.producer, "holding-assistant");
	assert.equal(built.batch.source_task, "持仓助手");
	assert.equal(built.batch.idempotency_key, "holding-assistant:2026-09-28:09:10");
	assert.equal(built.batch.live_universe_hash, "sha256:server-universe");
	assert.equal(built.batch.previous_checkpoint_comment_id, null);
	assert.equal(built.batch.preopen_comment_id, null);
});
