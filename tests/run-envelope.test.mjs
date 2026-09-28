import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

// The MCP end-to-end section imports src/index.ts, which uses extensionless
// relative imports; reuse the repo's resolve hook convention.
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

import { RunEnvelopeError, processRunEnvelope } from "../src/run-envelope.ts";
import { ensureRunEnvelopeTables } from "../src/automation-schedule.ts";
import { StateGatewayError } from "../src/state-gateway.ts";
import { createResearchWorkflowDb } from "./helpers/d1-sqlite-shim.mjs";

function industryEvent(extra = {}) {
	return {
		symbol: "CN:300308",
		event_type: "EVIDENCE_ADD",
		research_priority: "P0",
		industry_thesis: "envelope probe",
		r_proposal: "R1",
		evidence_types: ["D"],
		evidence_keys: ["20260928|TEST|FACT"],
		counter_evidence: [],
		confidence: 0.9,
		next_validation: "next",
		...extra,
	};
}

function industryEnvelope(extra = {}) {
	return {
		task_name: "industry-research",
		summary: "本轮产业新增一条",
		channel_payload: {
			channel: "INDUSTRY",
			as_of: "2026-09-28T10:45:00+08:00",
			events: [industryEvent()],
		},
		...extra,
	};
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

function recordingFetch({ postStatus = 201, onPost } = {}) {
	const state = { postCount: 0, created: null };
	const fetchImpl = async (target, init) => {
		const url = String(target);
		const method = init?.method ?? "GET";
		if (method === "POST") {
			state.postCount += 1;
			if (onPost) return onPost(url, init, state);
			const posted = JSON.parse(init.body);
			const payload = JSON.parse(posted.body.match(/```json\s*([\s\S]*?)\s*```/)[1]);
			state.created = {
				id: 9900 + state.postCount,
				created_at: "2026-09-28T02:45:30Z",
				html_url: `https://github.com/zhushihao/quantpro-collector/issues/3#issuecomment-${9900 + state.postCount}`,
				body: "```json\n" + JSON.stringify(payload, null, 2) + "\n```",
			};
			return jsonResponse(state.created, { status: postStatus });
		}
		if (state.created && url.endsWith(`/issues/comments/${state.created.id}`)) {
			return jsonResponse(state.created);
		}
		return jsonResponse([]);
	};
	return { fetchImpl, state };
}

const OWNER_CONTEXT = async () => ({
	portfolioVersion: "live:sha256:portfolio-test",
	liveUniverseHash: "sha256:universe-test",
});

const NOW = "2026-09-28T02:45:00Z"; // Shanghai 2026-09-28 (Mon) 10:45 — industry-research slot.

async function runEnvelope(db, envelope, overrides = {}) {
	return processRunEnvelope({
		db,
		token: "fake",
		envelope,
		resolveOwnerContext: overrides.resolveOwnerContext ?? OWNER_CONTEXT,
		fetchImpl: overrides.fetchImpl,
		now: overrides.now ?? NOW,
		requestId: overrides.requestId,
	});
}

async function countRunRows(db, where = "1=1", ...binds) {
	const rows = await db
		.prepare(`SELECT * FROM automation_runs_v3 WHERE ${where}`)
		.bind(...binds)
		.all();
	return rows.results ?? [];
}

test("envelope schema rejections (direct path) record one E:INVALID FAILED row and replay it verbatim", async () => {
	const db = createResearchWorkflowDb();
	const badEnvelopes = [
		industryEnvelope({ extra_top_level: true }),
		industryEnvelope({ channel_payload: { channel: "UNKNOWN", as_of: "x", events: [] } }),
		industryEnvelope({
			channel_payload: { channel: "INDUSTRY", as_of: "2026-09-28T10:45:00+08:00", events: [] },
		}),
		industryEnvelope({
			channel_payload: {
				channel: "MARKET",
				trading_date: "2026-09-28",
				scheduled_slot: "09:10",
				production_ref: "a".repeat(40),
				records: [],
			},
		}),
		industryEnvelope({
			channel_payload: {
				channel: "MARKET",
				trading_date: "2026-09-28",
				as_of: "2026-09-28T10:45:00+08:00",
				scheduled_slot: "10:11",
				production_ref: "a".repeat(40),
				records: [],
			},
		}),
		industryEnvelope({
			channel_payload: {
				channel: "MARKET",
				trading_date: "2026-09-28",
				as_of: "2026-09-28T10:45:00+08:00",
				scheduled_slot: "09:10",
				production_ref: "not-a-sha",
				records: [],
			},
		}),
		industryEnvelope({ summary: "" }),
	];

	for (const bad of badEnvelopes) {
		const { fetchImpl } = recordingFetch();
		await assert.rejects(
			runEnvelope(db, bad, { fetchImpl }),
			(error) =>
				error instanceof RunEnvelopeError &&
				error.code === "STATE_VALIDATION_FAILED" &&
				error.retryable === false,
		);
		const rows = await countRunRows(db, "task_name=?1", "industry-research");
		assert.equal(rows.length, 1, "one FAILED row per distinct bad envelope");
		const row = rows[0];
		assert.match(row.envelope_key, /^E:INVALID:[0-9a-f]{64}$/);
		assert.equal(row.event_count, null);
		assert.equal(row.outcome, "FAILED");
		// Same bad envelope bytes resubmitted → verbatim ENVELOPE_REPLAY (F2).
		const replay = await runEnvelope(db, bad, {
			fetchImpl: async () => {
				throw new Error("schema-reject replay must not touch the ledger");
			},
		});
		assert.equal(replay.status, "ENVELOPE_REPLAY");
		assert.equal(replay.outcome, "FAILED");
		assert.equal(replay.run_id, row.run_id);
		assert.equal(replay.event_count, null);
		// Each distinct bad envelope owns its own row; collapse back to one for
		// the next case.
		await db.prepare("DELETE FROM automation_runs_v3").run();
	}
});

test("unparseable task_name has no envelope key: error only, zero rows", async () => {
	const db = createResearchWorkflowDb();
	await assert.rejects(
		runEnvelope(db, { task_name: "nonexistent-task", summary: "x" }),
		(error) => error instanceof RunEnvelopeError && error.code === "STATE_VALIDATION_FAILED",
	);
	const rows = await countRunRows(db);
	assert.equal(rows.length, 0);
});

test("envelope identity excludes as_of and summary: same events replay, new events get a new key", async () => {
	const db = createResearchWorkflowDb();
	const { fetchImpl, state } = recordingFetch();

	const first = await runEnvelope(db, industryEnvelope(), { fetchImpl });
	assert.equal(first.status, "ENVELOPE_RECORDED");
	assert.equal(first.outcome, "COMPLETED");
	assert.equal(state.postCount, 1);

	// Same events, different as_of + summary → same key, zero GitHub POST.
	// (Unknown caller fields cannot reach identity at all: the envelope surface
	// is strict and rejects them — spec §2.3's "unknown fields stay out of the
	// identity" is enforced earlier, at schema level.)
	const restamped = await runEnvelope(
		db,
		industryEnvelope({
			summary: "换了个说法",
			channel_payload: {
				channel: "INDUSTRY",
				as_of: "2026-09-28T11:20:00+08:00",
				events: [industryEvent()],
			},
		}),
		{
			fetchImpl: async () => {
				throw new Error("identity replay must not reach GitHub");
			},
		},
	);
	assert.equal(restamped.status, "ENVELOPE_REPLAY");
	assert.equal(restamped.outcome, "COMPLETED");
	assert.equal(restamped.envelope_key, first.envelope_key);
	assert.equal(state.postCount, 1, "ENVELOPE_REPLAY must not re-POST");

	// Different events → different envelope key and a fresh run row.
	const second = await runEnvelope(
		db,
		industryEnvelope({
			channel_payload: {
				channel: "INDUSTRY",
				as_of: "2026-09-28T10:45:00+08:00",
				events: [industryEvent({ symbol: "CN:600519" })],
			},
		}),
		{ fetchImpl },
	);
	assert.equal(second.status, "ENVELOPE_RECORDED");
	assert.notEqual(second.envelope_key, first.envelope_key);
	assert.equal(state.postCount, 2);
	const rows = await countRunRows(db);
	assert.equal(rows.length, 2);
});

test("heartbeat bucketing: same UTC hour merges into one run row, a new hour starts a new row", async () => {
	const db = createResearchWorkflowDb();
	const heartbeat = { task_name: "industry-research", summary: "心跳：本轮无可入账新增" };

	const first = await runEnvelope(db, heartbeat, { now: "2026-09-28T02:10:00Z" });
	const replay = await runEnvelope(db, heartbeat, { now: "2026-09-28T02:50:00Z" });
	assert.equal(first.status, "ENVELOPE_RECORDED");
	assert.equal(replay.status, "ENVELOPE_REPLAY");
	assert.equal(replay.run_id, first.run_id);
	assert.match(first.envelope_key, /^HB:2026-09-28T02$/);
	assert.equal(first.outcome, "SILENT");
	assert.equal(first.fresh_delta_count, 0);
	assert.equal(first.event_count, 0);
	assert.deepEqual(first.ledger, {
		status: "SKIPPED_HEARTBEAT",
		channel: null,
		write_key: null,
		comment_id: null,
		url: null,
	});
	assert.equal(first.notification_required, false);
	assert.equal(first.delivery, "MODEL_DELIVERY_UNVERIFIED");

	const nextHour = await runEnvelope(db, heartbeat, { now: "2026-09-28T03:05:00Z" });
	assert.equal(nextHour.status, "ENVELOPE_RECORDED");
	assert.notEqual(nextHour.envelope_key, first.envelope_key);

	const rows = await countRunRows(db);
	assert.equal(rows.length, 2);
});

test("outcome matrix: PERSISTED→COMPLETED, replay→SILENT, CLOSE chain gate→BLOCKED", async () => {
	const db = createResearchWorkflowDb();

	const persisted = await runEnvelope(
		db,
		{
			task_name: "industry-research",
			summary: "新增",
			channel_payload: {
				channel: "INDUSTRY",
				as_of: "2026-09-28T10:45:00+08:00",
				events: [industryEvent()],
			},
		},
		{ fetchImpl: recordingFetch().fetchImpl },
	);
	assert.equal(persisted.outcome, "COMPLETED");
	assert.equal(persisted.fresh_delta_count, 1);
	assert.equal(persisted.notification_required, true);
	assert.equal(persisted.ledger.status, "PERSISTED");

	const silent = await runEnvelope(db, industryEnvelope(), {
		fetchImpl: recordingFetch().fetchImpl,
	});
	assert.equal(silent.status, "ENVELOPE_REPLAY", "same envelope replays the COMPLETED row");
	assert.equal(silent.outcome, "COMPLETED");

	// A different batch that content-replays at the ledger layer → SILENT:
	// wipe only the run-v3 row (receipts survive) so the same content takes a
	// fresh run row and short-circuits at the D1 receipt.
	const silentEnvelope = {
		task_name: "industry-research",
		summary: "重复内容",
		channel_payload: {
			channel: "INDUSTRY",
			as_of: "2026-09-28T10:45:00+08:00",
			events: [industryEvent({ symbol: "CN:600036" })],
		},
	};
	const silentLedgerFirst = await runEnvelope(db, silentEnvelope, {
		fetchImpl: recordingFetch().fetchImpl,
	});
	assert.equal(silentLedgerFirst.outcome, "COMPLETED");
	await db.prepare("DELETE FROM automation_runs_v3").run();
	const ledgerReplay = await runEnvelope(db, silentEnvelope, {
		fetchImpl: async () => {
			throw new Error("ledger-level replay must not reach GitHub");
		},
	});
	assert.equal(ledgerReplay.status, "ENVELOPE_RECORDED");
	assert.equal(ledgerReplay.outcome, "SILENT");
	assert.equal(ledgerReplay.fresh_delta_count, 0);
	assert.equal(ledgerReplay.notification_required, false);
	assert.equal(ledgerReplay.ledger.status, "IDEMPOTENT_REPLAY");

	// CLOSE R1 without an upstream INDUSTRY R1 → BLOCKED, row recorded, error
	// carries run fields (record first, then throw).
	const closeFetch = async (target, init) => {
		const method = init?.method ?? "GET";
		if (method === "POST") throw new Error("CLOSE chain gate must fail before POST");
		return jsonResponse([]);
	};
	await assert.rejects(
		runEnvelope(
			db,
			{
				task_name: "industry-research",
				summary: "CLOSE R1",
				channel_payload: {
					channel: "CLOSE",
					as_of: "2026-09-28T16:45:00+08:00",
					events: [
						{
							symbol: "CN:300308",
							event_type: "STATE_CHANGE",
							effective_r_state: "R1",
							close_thesis_view: "probe",
							evidence_types: [],
							evidence_keys: [],
							counter_evidence: [],
							confidence: 0.8,
							next_validation: "next",
						},
					],
				},
			},
			{ fetchImpl: closeFetch },
		),
		(error) =>
			error instanceof RunEnvelopeError &&
			error.code === "STATE_CHAIN_MISMATCH" &&
			error.outcome === "BLOCKED" &&
			typeof error.runId === "string",
	);
	const blockedRows = await countRunRows(db, "outcome='BLOCKED'");
	assert.equal(blockedRows.length, 1);
	assert.equal(blockedRows[0].blocker_code, "STATE_CHAIN_MISMATCH:VALIDATE");
});

test("UNKNOWN injection: network failure stays retryable and the same envelope flips to COMPLETED with a stable run_id", async () => {
	const db = createResearchWorkflowDb();
	const { fetchImpl, state } = recordingFetch();
	const brokenFirst = async (target, init) => {
		if ((init?.method ?? "GET") === "POST") throw new TypeError("network down");
		return fetchImpl(target, init);
	};

	await assert.rejects(
		runEnvelope(db, industryEnvelope(), { fetchImpl: brokenFirst }),
		(error) =>
			error instanceof RunEnvelopeError &&
			error.outcome === "UNKNOWN" &&
			error.retryable === true,
	);
	const unknownRows = await countRunRows(db, "outcome='UNKNOWN'");
	assert.equal(unknownRows.length, 1);
	const unknownRunId = unknownRows[0].run_id;

	// Same envelope retried after recovery (later server clock so the previous
	// attempt's receipt lease has expired): re-executes, flips the SAME row to
	// COMPLETED, stable run_id.
	const recovered = await runEnvelope(db, industryEnvelope(), {
		fetchImpl,
		now: "2026-09-28T02:48:00Z",
	});
	assert.equal(recovered.status, "ENVELOPE_RECORDED");
	assert.equal(recovered.outcome, "COMPLETED");
	assert.equal(recovered.run_id, unknownRunId);
	const rows = await countRunRows(db);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].outcome, "COMPLETED");
	assert.ok(state.postCount >= 1);
});

test("retryable split: ledger auth rejection (401) lands FAILED, not UNKNOWN", async () => {
	const db = createResearchWorkflowDb();
	const { fetchImpl } = recordingFetch({
		onPost: () => jsonResponse({ message: "Bad credentials" }, { status: 401 }),
	});
	await assert.rejects(
		runEnvelope(db, industryEnvelope(), { fetchImpl }),
		(error) =>
			error instanceof RunEnvelopeError && error.outcome === "FAILED" && !error.retryable,
	);
	const rows = await countRunRows(db, "outcome='FAILED'");
	assert.equal(rows.length, 1);
	assert.match(rows[0].blocker_code, /STATE_OUTCOME_UNKNOWN:WRITE/);
});

test("receipt-missing deadlock (spec §10.6): same events re-stamped as_of blocks, and the envelope replay pins BLOCKED", async () => {
	const db = createResearchWorkflowDb();
	const { fetchImpl, state } = recordingFetch();

	const first = await runEnvelope(db, industryEnvelope(), { fetchImpl });
	assert.equal(first.outcome, "COMPLETED");

	// Simulate full D1 rebuild: receipt rows and run-v3 rows are gone, the
	// GitHub ledger comment survives.
	await db.prepare("DELETE FROM state_write_receipts_v1").run();
	await db.prepare("DELETE FROM automation_runs_v3").run();

	// Same events, different as_of: ledger event_id pre-check sees the same
	// event_id with a different full payload (batchEquals includes as_of) →
	// STATE_CONFLICT → BLOCKED.
	await assert.rejects(
		runEnvelope(
			db,
			industryEnvelope({
				channel_payload: {
					channel: "INDUSTRY",
					as_of: "2026-09-28T11:30:00+08:00",
					events: [industryEvent()],
				},
			}),
			{ fetchImpl: async () => jsonResponse(state.created ? [state.created] : []) },
		),
		(error) => error instanceof RunEnvelopeError && error.outcome === "BLOCKED",
	);
	const blocked = await countRunRows(db, "outcome='BLOCKED'");
	assert.equal(blocked.length, 1);

	// Same envelope retry → ENVELOPE_REPLAY forever replays the BLOCKED row
	// (behavior pinned by spec §10.6; detectable afterwards by comparing the
	// ledger comment and run row events verbatim).
	const replay = await runEnvelope(
		db,
		industryEnvelope({
			channel_payload: {
				channel: "INDUSTRY",
				as_of: "2026-09-28T11:30:00+08:00",
				events: [industryEvent()],
			},
		}),
		{ fetchImpl: async () => jsonResponse([state.created]) },
	);
	assert.equal(replay.status, "ENVELOPE_REPLAY");
	assert.equal(replay.outcome, "BLOCKED");
});

test("timeliness: STALE follows the task schedule window, heartbeat is FRESH, delivery stays MODEL_DELIVERY_UNVERIFIED", async () => {
	const db = createResearchWorkflowDb();
	const { fetchImpl } = recordingFetch();

	// as_of a full day older than received_at → far beyond window_minutes (40).
	const stale = await runEnvelope(
		db,
		industryEnvelope({
			channel_payload: {
				channel: "INDUSTRY",
				as_of: "2026-09-27T10:45:00+08:00",
				events: [industryEvent()],
			},
		}),
		{ fetchImpl },
	);
	assert.equal(stale.timeliness, "STALE");
	assert.equal(stale.delivery, "MODEL_DELIVERY_UNVERIFIED");

	const fresh = await runEnvelope(
		db,
		industryEnvelope({
			channel_payload: {
				channel: "INDUSTRY",
				as_of: "2026-09-28T10:50:00+08:00",
				events: [industryEvent({ symbol: "CN:600519" })],
			},
		}),
		{ fetchImpl },
	);
	assert.equal(fresh.timeliness, "FRESH");

	const heartbeat = await runEnvelope(
		db,
		{ task_name: "industry-research", summary: "心跳" },
		{ now: "2026-09-28T03:30:00Z" },
	);
	assert.equal(heartbeat.timeliness, "FRESH");
});

test("receipt correlation columns: PERSISTED envelope fills envelope_key/event_count, server-counted", async () => {
	const db = createResearchWorkflowDb();
	const { fetchImpl } = recordingFetch();

	const result = await runEnvelope(db, industryEnvelope(), { fetchImpl });
	assert.equal(result.outcome, "COMPLETED");
	const receipts = await db.prepare("SELECT * FROM state_write_receipts_v1").all();
	assert.equal(receipts.results.length, 1);
	assert.equal(receipts.results[0].envelope_key, result.envelope_key);
	assert.equal(receipts.results[0].event_count, 1);
});

test("build attribution survives the terminal update: collector_build_sha/cloudflare_version_id keep the deployment markers", async () => {
	const db = createResearchWorkflowDb();
	const { fetchImpl } = recordingFetch();

	const executed = await processRunEnvelope({
		db,
		token: "fake",
		envelope: industryEnvelope(),
		resolveOwnerContext: OWNER_CONTEXT,
		collectorBuildSha: "BUILD_MARKER_1234",
		cloudflareVersionId: "VER_MARKER_5678",
		fetchImpl,
		now: NOW,
		requestId: "attribution-executed",
	});
	assert.equal(executed.outcome, "COMPLETED");

	const heartbeat = await processRunEnvelope({
		db,
		token: "fake",
		envelope: { task_name: "industry-research", summary: "心跳" },
		collectorBuildSha: "BUILD_MARKER_1234",
		cloudflareVersionId: "VER_MARKER_5678",
		now: "2026-09-28T03:45:00Z",
		requestId: "attribution-heartbeat",
	});
	assert.equal(heartbeat.outcome, "SILENT");

	const rows = await db
		.prepare("SELECT run_id, outcome, collector_build_sha, cloudflare_version_id, updated_at FROM automation_runs_v3")
		.all();
	assert.equal(rows.results.length, 2);
	for (const row of rows.results) {
		assert.equal(row.collector_build_sha, "BUILD_MARKER_1234", `run ${row.run_id} build sha`);
		assert.equal(row.cloudflare_version_id, "VER_MARKER_5678", `run ${row.run_id} version id`);
		assert.notEqual(row.collector_build_sha, row.updated_at);
		assert.notEqual(row.cloudflare_version_id, row.updated_at);
	}
});

test("step-5 branches: unique-index loser adopts the incumbent UNKNOWN run; non-conflict insert failure is retryable STATE_UNAVAILABLE", async () => {
	const db = createResearchWorkflowDb();

	// (a) Unique-index competition with an incumbent UNKNOWN row: the INSERT
	// loses, the loser adopts the incumbent run_id and carries the SAME row to
	// COMPLETED (the terminal-winner variant is the replay gate, §② tests).
	const firstAttempt = await runEnvelope(db, industryEnvelope(), {
		resolveOwnerContext: async () => {
			throw new StateGatewayError({
				code: "STATE_UNAVAILABLE",
				phase: "READ",
				message: "LIVE universe is unavailable",
				retryable: true,
			});
		},
		fetchImpl: recordingFetch().fetchImpl,
	}).catch((error) => error);
	assert.equal(firstAttempt.outcome, "UNKNOWN");
	const incumbent = await countRunRows(db, "outcome='UNKNOWN'");
	assert.equal(incumbent.length, 1);

	const adopted = await runEnvelope(db, industryEnvelope(), {
		fetchImpl: recordingFetch().fetchImpl,
		now: "2026-09-28T02:50:00Z",
	});
	assert.equal(adopted.status, "ENVELOPE_RECORDED");
	assert.equal(adopted.outcome, "COMPLETED");
	assert.equal(adopted.run_id, incumbent[0].run_id);
	const rows = await countRunRows(db);
	assert.equal(rows.length, 1);

	// (b) Fresh envelope whose reservation INSERT fails non-conflictually →
	// retryable STATE_UNAVAILABLE with the envelope key attached.
	const failingInsertDb = new Proxy(db, {
		get(target, prop, receiver) {
			if (prop !== "prepare") return Reflect.get(target, prop, receiver);
			return (sql) => {
				if (sql.includes("INSERT INTO automation_runs_v3")) {
					return {
						bind: () => ({
							run: async () => {
								throw new Error("simulated storage failure");
							},
						}),
					};
				}
				return target.prepare(sql);
			};
		},
	});
	await assert.rejects(
		runEnvelope(
			failingInsertDb,
			industryEnvelope({
				summary: "其它批次",
				channel_payload: {
					channel: "INDUSTRY",
					as_of: "2026-09-28T10:45:00+08:00",
					events: [industryEvent({ symbol: "CN:600036" })],
				},
			}),
			{
				fetchImpl: recordingFetch().fetchImpl,
			},
		),
		(error) =>
			error instanceof RunEnvelopeError &&
			error.code === "STATE_UNAVAILABLE" &&
			error.retryable === true,
	);
});

test("owner-context failure (spec §1.4 step 0) records an UNKNOWN row and returns a retryable error", async () => {
	const db = createResearchWorkflowDb();
	await assert.rejects(
		runEnvelope(db, industryEnvelope(), {
			resolveOwnerContext: async () => {
				throw new StateGatewayError({
					code: "STATE_UNAVAILABLE",
					phase: "READ",
					message: "LIVE universe is unavailable",
					retryable: true,
				});
			},
			fetchImpl: recordingFetch().fetchImpl,
		}),
		(error) =>
			error instanceof RunEnvelopeError &&
			error.outcome === "UNKNOWN" &&
			error.retryable === true,
	);
	const rows = await countRunRows(db, "outcome='UNKNOWN'");
	assert.equal(rows.length, 1);
});

test("slot binding: an in-window envelope stores the schedule slot, out-of-window stays NULL", async () => {
	const db = createResearchWorkflowDb();
	const { fetchImpl } = recordingFetch();

	const inWindow = await runEnvelope(db, industryEnvelope(), { fetchImpl });
	assert.equal(inWindow.slot, "10:45");
	assert.equal(inWindow.slot_date, "2026-09-28");

	const outOfWindow = await runEnvelope(
		db,
		industryEnvelope({
			summary: "窗口外",
			channel_payload: {
				channel: "INDUSTRY",
				as_of: "2026-09-28T13:30:00+08:00",
				events: [industryEvent({ symbol: "CN:600519" })],
			},
		}),
		{ now: "2026-09-28T05:30:00Z", fetchImpl }, // Shanghai 13:30 — between industry slots.
	);
	assert.equal(outOfWindow.status, "ENVELOPE_RECORDED");
	assert.equal(outOfWindow.slot, null);
	assert.equal(outOfWindow.slot_date, null);
});

test("512-record MARKET envelope smoke (spec §九 待验②, node-side): max-size payload processes end to end", async () => {
	const db = createResearchWorkflowDb();
	const { fetchImpl } = recordingFetch();
	const records = Array.from({ length: 512 }, (_, index) => ({
		subject_key: `CN:${String(600000 + index)}`,
		holding_status: "ACTIVE",
		observation: `probe-${index}`,
	}));
	const result = await runEnvelope(
		db,
		{
			task_name: "holding-assistant-intraday",
			summary: "满额 512 records 冒烟",
			channel_payload: {
				channel: "MARKET",
				trading_date: "2026-09-28",
				as_of: "2026-09-28T09:50:00+08:00",
				scheduled_slot: "09:50",
				production_ref: "a".repeat(40),
				records,
			},
		},
		{ fetchImpl },
	);
	assert.equal(result.status, "ENVELOPE_RECORDED");
	assert.equal(result.outcome, "COMPLETED");
	assert.equal(result.event_count, 512);
	assert.equal(result.ledger.status, "PERSISTED");
	// Same envelope resubmitted: replay, no second write.
	const replay = await runEnvelope(
		db,
		{
			task_name: "holding-assistant-intraday",
			summary: "满额 512 records 冒烟",
			channel_payload: {
				channel: "MARKET",
				trading_date: "2026-09-28",
				as_of: "2026-09-28T09:50:00+08:00",
				scheduled_slot: "09:50",
				production_ref: "a".repeat(40),
				records,
			},
		},
		{
			fetchImpl: async () => {
				throw new Error("512-record replay must not reach GitHub");
			},
		},
	);
	assert.equal(replay.status, "ENVELOPE_REPLAY");
	assert.equal(replay.outcome, "COMPLETED");
	const receipts = await db.prepare("SELECT envelope_key, event_count FROM state_write_receipts_v1").all();
	assert.equal(receipts.results.length, 1);
	assert.equal(receipts.results[0].event_count, 512);
});

// ---- MCP layer (two-layer validation contract, review F1) ------------------

const { createServer } = await import("../src/index.ts");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { computeLiveUniverseHash } = await import("../src/live-universe.ts");

async function startServer(env) {
	const server = createServer(
		env,
		"ENABLED",
		new Set(["market:read", "state:read", "state:write"]),
		"chatgpt-production",
		"https://cn-hk-quotes-mcp.zhushihao710.workers.dev",
	);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "run-envelope-mcp-test", version: "0.0.0" });
	await Promise.all([server.server.connect(serverTransport), client.connect(clientTransport)]);
	return {
		client,
		close: async () => {
			await client.close();
			await server.server.close();
		},
	};
}

test("MCP layer rejects schema-violating envelopes before the handler: no run rows, ledger untouched (review F1)", async () => {
	const db = createResearchWorkflowDb();
	const { client, close } = await startServer({ GITHUB_TOKEN: "fake", RESEARCH_REPLICA: db });
	try {
		// Server 2.0 validates input schemas BEFORE the tool handler and
		// converts the InvalidParams rejection into an isError result, so the
		// handler (and processRunEnvelope) never runs. Assert the observable
		// contract: rejected call, no run-v3 row, no ledger attempt.
		const result = await client.callTool({
			name: "submit_run_envelope",
			arguments: industryEnvelope({ extra_top_level: true }),
		});
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /Input validation error/);
		const rows = await countRunRows(db);
		assert.equal(rows.length, 0, "SDK-level rejection must never record a run row");
	} finally {
		await close();
	}
});

test("MCP end-to-end heartbeat and registered_tools advertisement", async () => {
	const db = createResearchWorkflowDb();
	const { client, close } = await startServer({ GITHUB_TOKEN: "fake", RESEARCH_REPLICA: db });
	try {
		const result = await client.callTool({
			name: "submit_run_envelope",
			arguments: { task_name: "industry-research", summary: "心跳：无新增" },
		});
		assert.equal(result.isError, undefined);
		const body = JSON.parse(result.content[0].text);
		assert.equal(body.status, "ENVELOPE_RECORDED");
		assert.equal(body.outcome, "SILENT");
		assert.equal(body.notification_required, false);
		assert.equal(body.notification_semantics, "SERVER_DERIVED_FLOOR");
		assert.equal(body.delivery, "MODEL_DELIVERY_UNVERIFIED");
		assert.match(body.run_id, /^run_[0-9a-f]{32}$/);
		assert.match(body.envelope_key, /^HB:/);

		const status = await client.callTool({ name: "get_gateway_status", arguments: {} });
		const statusBody = JSON.parse(status.content[0].text);
		assert.ok(statusBody.registered_tools.includes("submit_run_envelope"));
		assert.equal(statusBody.state_gateway_version, "1.2.0");
	} finally {
		await close();
	}
});

test("MCP end-to-end PERSISTED envelope via LIVE universe context returns the §1.5 receipt", async () => {
	const db = createResearchWorkflowDb();
	const contentHash = await computeLiveUniverseHash([
		{ market: "CN", exchange: "SZ", code: "300308" },
	]);
	const universe = {
		schema_version: "quote-universe/1",
		generated_at: "2026-09-28T09:00:00+08:00",
		source_manifest_hash: `sha256:${"1".repeat(64)}`,
		active: [{ market: "CN", exchange: "SZ", code: "300308" }],
		content_hash: contentHash,
	};
	const kv = {
		get: async () => JSON.stringify({ ...universe, received_at: "2026-09-28T09:00:01Z" }),
		put: async () => {},
	};
	const { fetchImpl } = recordingFetch();
	const { client, close } = await startServer({
		GITHUB_TOKEN: "fake",
		RESEARCH_REPLICA: db,
		PORTFOLIO_UNIVERSE: kv,
	});
	try {
		// The MCP handler uses the ambient fetch (production wiring); stub it
		// for the duration of the call so the e2e stays offline.
		const realFetch = globalThis.fetch;
		globalThis.fetch = fetchImpl;
		let result;
		try {
			result = await client.callTool({
				name: "submit_run_envelope",
				arguments: industryEnvelope(),
			});
		} finally {
			globalThis.fetch = realFetch;
		}
		assert.equal(result.isError, undefined, result.isError ? result.content[0].text : "");
		const body = JSON.parse(result.content[0].text);
		assert.equal(body.status, "ENVELOPE_RECORDED");
		assert.equal(body.outcome, "COMPLETED");
		assert.equal(body.fresh_delta_count, 1);
		assert.equal(body.event_count, 1);
		assert.equal(body.notification_required, true);
		assert.equal(body.ledger.status, "PERSISTED");
		assert.equal(body.ledger.channel, "INDUSTRY");
		assert.match(body.envelope_key, /^E:INDUSTRY:[0-9a-f]{64}$/);
		// The MCP lane uses the real server clock, so the slot depends on when
		// this runs; assert the shape instead of a fixed slot.
		assert.ok(body.slot === null || /^\d{2}:\d{2}$/.test(body.slot));
		assert.ok(body.slot_date === null || /^\d{4}-\d{2}-\d{2}$/.test(body.slot_date));
	} finally {
		await close();
	}
});
