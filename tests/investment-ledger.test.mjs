import assert from "node:assert/strict";
import test from "node:test";

import {
	appendInvestmentLedgerBatch,
	getInvestmentLedgerState,
	InvestmentLedgerError,
} from "../src/investment-ledger.ts";
import { runInvestmentLedgerCli } from "../scripts/investment-ledger-cli.mjs";

function jsonResponse(body, { status = 200, headers = {} } = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

function industryInput(overrides = {}) {
	return {
		schema_version: "investment_state_batch_v1",
		portfolio_version: "live:sha256:test",
		event_id: "20260926T200000+08|industry_trend|BATCH",
		as_of: "2026-09-26T20:00:00+08:00",
		events: [
			{
				symbol: "CN:300308",
				event_type: "EVIDENCE_ADD",
				research_priority: "P0",
				industry_thesis: "test thesis",
				r_proposal: "R1",
				evidence_types: ["D", "P"],
				evidence_keys: ["20260926|TEST|NEW_FACT"],
				counter_evidence: ["counter"],
				confidence: 0.9,
				next_validation: "next",
			},
		],
		...overrides,
	};
}

function companyInput(overrides = {}) {
	return {
		schema_version: "investment_state_batch_v1",
		portfolio_version: "live:sha256:test",
		event_id: "20260926T200100+08|company_validation|BATCH",
		as_of: "2026-09-26T20:01:00+08:00",
		events: [
			{
				symbol: "CN:300489",
				event_type: "CONFIRMATION",
				research_priority: "P1",
				company_thesis: "company thesis",
				company_validation: "formal fact",
				r_proposal: "R2",
				evidence_types: ["P"],
				evidence_keys: ["20260926|TEST|COMPANY_FACT"],
				counter_evidence: ["counter"],
				confidence: 0.95,
				next_validation: "next",
			},
		],
		...overrides,
	};
}

function persisted(role, input) {
	const industry = role === "industry";
	return {
		...input,
		producer: industry ? "industry_trend" : "company_validation",
		source_task: industry ? "产业趋势与研究" : "公司事实监控",
		events: input.events.map((event) => ({
			...event,
			dimension: industry ? "INDUSTRY" : "COMPANY",
		})),
	};
}

function comment(id, batch, { codeBlock = true, createdAt = "2026-09-26T12:00:00Z" } = {}) {
	const body = codeBlock
		? `\`\`\`json\n${JSON.stringify(batch, null, 2)}\n\`\`\``
		: JSON.stringify(batch);
	return {
		id,
		created_at: createdAt,
		html_url: `https://github.com/zhushihao/quantpro-collector/issues/3#issuecomment-${id}`,
		body,
	};
}

test("get investment state fully paginates fixed Issue #3 and dedupes evidence keys", async () => {
	const older = persisted(
		"industry",
		industryInput({
			event_id: "20260925T200000+08|industry_trend|BATCH",
			as_of: "2026-09-25T20:00:00+08:00",
		}),
	);
	const newer = persisted("industry", industryInput());
	let calls = 0;
	const state = await getInvestmentLedgerState({
		token: "fake-token",
		role: "industry",
		symbols: ["CN:300308"],
		fetchImpl: async (input) => {
			calls += 1;
			assert.match(String(input), /issues\/3\/comments/);
			if (calls === 1) {
				return jsonResponse([comment(1, older, { codeBlock: false })], {
					headers: {
						Link: '<https://api.github.com/repos/zhushihao/quantpro-collector/issues/3/comments?page=2>; rel="next"',
					},
				});
			}
			return jsonResponse([comment(2, newer, { createdAt: "2026-09-26T12:01:00Z" })]);
		},
	});
	assert.equal(calls, 2);
	assert.equal(state.fully_paginated, true);
	assert.equal(state.latest_by_symbol["CN:300308"].comment_id, "2");
	assert.deepEqual(state.evidence_keys_by_symbol["CN:300308"], ["20260926|TEST|NEW_FACT"]);
	assert.equal(state.event_count_by_symbol["CN:300308"], 2);
});

test("append industry batch fixes producer/dimension/target and verifies readback", async () => {
	const input = industryInput();
	let created = null;
	const requests = [];
	const result = await appendInvestmentLedgerBatch({
		token: "fake-token",
		role: "industry",
		batch: input,
		fetchImpl: async (target, init) => {
			const url = String(target);
			const method = init?.method ?? "GET";
			requests.push({ url, method });
			if (method === "POST") {
				assert.equal(
					url,
					"https://api.github.com/repos/zhushihao/quantpro-collector/issues/3/comments",
				);
				const posted = JSON.parse(init.body);
				const body = JSON.parse(posted.body.match(/```json\s*([\s\S]*?)\s*```/)[1]);
				assert.equal(body.producer, "industry_trend");
				assert.equal(body.source_task, "产业趋势与研究");
				assert.equal(body.events[0].dimension, "INDUSTRY");
				created = comment(99, body);
				return jsonResponse(created, { status: 201 });
			}
			if (url.endsWith("/issues/comments/99")) return jsonResponse(created);
			return jsonResponse([]);
		},
	});
	assert.equal(result.status, "PERSISTED");
	assert.equal(result.comment_id, "99");
	assert.equal(requests.filter((request) => request.method === "POST").length, 1);
	assert.equal(
		requests.some((request) => /issues\/(?:1|2)\/comments/.test(request.url)),
		false,
	);
});

test("append is idempotent on identical event_id and conflicts on changed content", async () => {
	const input = industryInput();
	const existing = comment(50, persisted("industry", input));
	let posts = 0;
	const replay = await appendInvestmentLedgerBatch({
		token: "fake-token",
		role: "industry",
		batch: input,
		fetchImpl: async (_target, init) => {
			if (init?.method === "POST") posts += 1;
			return jsonResponse([existing]);
		},
	});
	assert.equal(replay.status, "IDEMPOTENT_REPLAY");
	assert.equal(posts, 0);
	await assert.rejects(
		appendInvestmentLedgerBatch({
			token: "fake-token",
			role: "industry",
			batch: industryInput({ events: [{ ...input.events[0], confidence: 0.5 }] }),
			fetchImpl: async () => jsonResponse([existing]),
		}),
		(error) =>
			error instanceof InvestmentLedgerError &&
			error.code === "INVESTMENT_LEDGER_EVENT_ID_CONFLICT",
	);
});

test("role schema fails closed on cross-dimension fields and forbidden R state", async () => {
	await assert.rejects(
		appendInvestmentLedgerBatch({
			token: "fake-token",
			role: "industry",
			batch: industryInput({
				events: [{ ...industryInput().events[0], company_thesis: "not allowed" }],
			}),
			fetchImpl: async () => {
				throw new Error("must not fetch");
			},
		}),
		(error) =>
			error instanceof InvestmentLedgerError &&
			error.code === "INVESTMENT_LEDGER_VALIDATION_FAILED",
	);
	await assert.rejects(
		appendInvestmentLedgerBatch({
			token: "fake-token",
			role: "company",
			batch: companyInput({ events: [{ ...companyInput().events[0], r_proposal: "R4" }] }),
			fetchImpl: async () => {
				throw new Error("must not fetch");
			},
		}),
		(error) =>
			error instanceof InvestmentLedgerError &&
			error.code === "INVESTMENT_LEDGER_VALIDATION_FAILED",
	);
});

test("exact schema rejects caller-controlled producer/dimension/repo fields without echoing values", async () => {
	const secret = "must-not-leak";
	await assert.rejects(
		appendInvestmentLedgerBatch({
			token: "fake-token",
			role: "industry",
			batch: { ...industryInput(), producer: "company_validation", repo: secret },
			fetchImpl: async () => {
				throw new Error("must not fetch");
			},
		}),
		(error) =>
			error instanceof InvestmentLedgerError &&
			error.code === "INVESTMENT_LEDGER_VALIDATION_FAILED" &&
			error.message.includes("unrecognized_keys") &&
			!error.message.includes(secret),
	);
	await assert.rejects(
		appendInvestmentLedgerBatch({
			token: "fake-token",
			role: "industry",
			batch: industryInput({
				events: [{ ...industryInput().events[0], dimension: "COMPANY" }],
			}),
			fetchImpl: async () => {
				throw new Error("must not fetch");
			},
		}),
		(error) =>
			error instanceof InvestmentLedgerError &&
			error.code === "INVESTMENT_LEDGER_VALIDATION_FAILED",
	);
});

test("CLI exposes only fixed role commands and JSON-over-stdin", async () => {
	const stdout = [];
	const stderr = [];
	const getCode = await runInvestmentLedgerCli(["get-industry"], {
		tokenProvider: async () => "fake-token",
		readStdin: async () => JSON.stringify({ symbols: ["CN:300308"] }),
		writeStdout: (line) => stdout.push(line),
		writeStderr: (line) => stderr.push(line),
		getInvestmentLedgerState: async ({ role, symbols }) => ({ status: "OK", role, symbols }),
	});
	assert.equal(getCode, 0);
	assert.equal(JSON.parse(stdout[0]).role, "industry");
	assert.equal(stderr.length, 0);

	const badCode = await runInvestmentLedgerCli(["append-industry", "--repo", "other/repo"], {
		writeStderr: (line) => stderr.push(line),
	});
	assert.equal(badCode, 1);
	assert.equal(JSON.parse(stderr.at(-1)).status, "INVESTMENT_LEDGER_VALIDATION_FAILED");
});
