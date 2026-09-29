// Issue #52 — controlled GitHub issue bookkeeping sink.
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

import { ensureIssueBookkeepingTable, submitIssueBookkeeping } from "../src/issue-bookkeeping.ts";
import { createResearchWorkflowDb } from "./helpers/d1-sqlite-shim.mjs";

const TARGETS = JSON.stringify({
	"collector-acceptance": { repo: "zhushihao/quantpro-collector", issue: 47 },
	"portfolio-regression": { repo: "zhushihao/quantpro-collector", issue: 51 },
});

function command(extra = {}) {
	return {
		source_task: "production-observer",
		target_key: "collector-acceptance",
		operation: "COMMENT",
		dedupe_key: "obs:2026-09-30:night-matrix",
		body: "夜间异常矩阵（记账正文）",
		...extra,
	};
}

function githubOk(extra = {}) {
	return {
		ok: true,
		status: 201,
		json: async () => ({ id: 5899999999, html_url: "https://github.com/zhushihao/quantpro-collector/issues/47#issuecomment-5899999999", ...extra }),
	};
}

async function submit(db, commandArg, overrides = {}) {
	return submitIssueBookkeeping({
		db,
		command: commandArg,
		token: "token" in overrides ? overrides.token : "fake-token",
		targetsRaw: "targetsRaw" in overrides ? overrides.targetsRaw : TARGETS,
		fetchImpl: overrides.fetchImpl,
		now: "2026-09-30T01:30:00.000Z",
	});
}

test("COMMENT persists via the server-side GitHub sink and returns a PERSISTED receipt", async () => {
	const db = createResearchWorkflowDb();
	let seen;
	const receipt = await submit(db, command(), {
		fetchImpl: async (url, init) => {
			seen = { url, init };
			return githubOk();
		},
	});
	assert.equal(receipt.status, "PERSISTED");
	assert.equal(receipt.issue_comment_id, "5899999999");
	assert.match(receipt.url, /#issuecomment-/);
	assert.deepEqual(receipt.target, { repo: "zhushihao/quantpro-collector", issue: 47 });
	assert.equal(seen.url, "https://api.github.com/repos/zhushihao/quantpro-collector/issues/47/comments");
	assert.equal(seen.init.method, "POST");
	const body = JSON.parse(seen.init.body);
	assert.match(body.body, /夜间异常矩阵/);
});

test("same dedupe_key replays the stored receipt instead of re-throwing at GitHub", async () => {
	const db = createResearchWorkflowDb();
	let calls = 0;
	const fetchImpl = async () => {
		calls += 1;
		return githubOk();
	};
	const first = await submit(db, command(), { fetchImpl });
	const second = await submit(db, command(), { fetchImpl });
	assert.equal(first.status, "PERSISTED");
	assert.equal(second.status, "IDEMPOTENT_REPLAY");
	assert.equal(second.issue_comment_id, "5899999999");
	assert.equal(calls, 1);
});

test("CLOSE patches the issue state closed", async () => {
	const db = createResearchWorkflowDb();
	let seen;
	const receipt = await submit(
		db,
		command({ operation: "CLOSE", target_key: "portfolio-regression", dedupe_key: "close:51:natural-pass", body: undefined }),
		{
			fetchImpl: async (url, init) => {
				seen = { url, init };
				return {
					ok: true,
					status: 200,
					json: async () => ({ html_url: "https://github.com/zhushihao/quantpro-collector/issues/51" }),
				};
			},
		},
	);
	assert.equal(receipt.status, "PERSISTED");
	assert.equal(seen.init.method, "PATCH");
	assert.equal(seen.url, "https://api.github.com/repos/zhushihao/quantpro-collector/issues/51");
	assert.deepEqual(JSON.parse(seen.init.body), { state: "closed" });
	assert.equal(receipt.issue_comment_id, null);
});

test("unknown target_key and missing whitelist are deterministic REJECTED_TARGET with no row", async () => {
	const db = createResearchWorkflowDb();
	await ensureIssueBookkeepingTable(db);
	const miss = await submit(db, command({ target_key: "arbitrary-repo" }));
	assert.equal(miss.status, "REJECTED_TARGET");
	const noTargets = await submit(db, command(), { targetsRaw: null });
	assert.equal(noTargets.status, "REJECTED_TARGET");
	const badJson = await submit(db, command(), { targetsRaw: "{not json" });
	assert.equal(badJson.status, "REJECTED_TARGET");
	const rows = await db.prepare("SELECT * FROM issue_bookkeeping").all();
	assert.equal((rows.results ?? []).length, 0);
});

test("COMMENT without body and bad dedupe_key shapes are schema rejections", async () => {
	const db = createResearchWorkflowDb();
	await assert.rejects(
		() => submit(db, command({ body: undefined })),
		(error) => error.code === "STATE_VALIDATION_FAILED",
	);
	await assert.rejects(
		() => submit(db, command({ dedupe_key: "short" })),
		(error) => error.code === "STATE_VALIDATION_FAILED",
	);
});

test("GitHub 4xx is DELIVERY_BLOCKED; transport loss and 5xx stay OUTCOME_UNKNOWN and replay", async () => {
	const db = createResearchWorkflowDb();
	const blocked = await submit(db, command({ dedupe_key: "blocked:case:00000001" }), {
		fetchImpl: async () => ({ ok: false, status: 422, json: async () => ({}) }),
	});
	assert.equal(blocked.status, "DELIVERY_BLOCKED");
	assert.equal(blocked.detail, "github_refused_http_422");

	const unknown = await submit(db, command({ dedupe_key: "unknown:case:0000001" }), {
		fetchImpl: async () => {
			throw new Error("tunnel blackhole");
		},
	});
	assert.equal(unknown.status, "OUTCOME_UNKNOWN");
	const replay = await submit(db, command({ dedupe_key: "unknown:case:0000001" }), {
		fetchImpl: async () => githubOk(),
	});
	assert.equal(replay.status, "IDEMPOTENT_REPLAY");

	const serverError = await submit(db, command({ dedupe_key: "server:case:00000001" }), {
		fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
	});
	assert.equal(serverError.status, "OUTCOME_UNKNOWN");
});

test("missing token is a deterministic DELIVERY_BLOCKED, recorded once", async () => {
	const db = createResearchWorkflowDb();
	const receipt = await submit(db, command({ dedupe_key: "token:case:000000001" }), { token: null });
	assert.equal(receipt.status, "DELIVERY_BLOCKED");
	assert.equal(receipt.detail, "token_not_configured");
	const replay = await submit(db, command({ dedupe_key: "token:case:000000001" }), { token: null });
	assert.equal(replay.status, "IDEMPOTENT_REPLAY");
});
