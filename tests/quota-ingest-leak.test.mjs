// Post gate-removal regression tests (quota redesign 2026-10-02).
//
// The old #48 leak class is structurally gone: there are no reservation slots
// left to leak, because nothing admits or settles any more.  What these tests
// pin instead is the NEW contract at the exact routes that used to be gated:
//   1. every business outcome is unchanged (validation refusals stay refusals,
//      successes stay successes -- nothing is converted into a quota refusal);
//   2. metering has observations: the pure observers record the measured D1/R2
//      usage and the request reports it asynchronously (`quota_observation`
//      log), without ever touching the business response.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";

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

const worker = (await import("../src/index.ts")).default;
const { createResearchWorkflowDb } = await import("./helpers/d1-sqlite-shim.mjs");

function contextCollector() {
	const background = [];
	return { ctx: { waitUntil: (promise) => background.push(promise) }, background };
}

async function captureConsoleLog(run) {
	const original = console.log;
	const lines = [];
	console.log = (...parts) => lines.push(parts.join(" "));
	try {
		await run();
	} finally {
		console.log = original;
	}
	return lines;
}

function observationEvents(lines) {
	return lines
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return null;
			}
		})
		.filter((event) => event?.event === "quota_observation");
}

function env() {
	return {
		RESEARCH_REPLICA: createResearchWorkflowDb(),
		RESEARCH_OBJECTS: { put: async () => undefined, get: async () => undefined },
		RESEARCH_REPLICA_INGEST_TOKEN: "internal-token",
		// The legacy admission switch is inert: it must change nothing.
		QUOTA_ADMISSION_MODE: "enforce",
	};
}

test("malformed ingest is a plain validation refusal, and a valid record passes with observed metering", async () => {
	const e = env();
	const { ctx, background } = contextCollector();

	// Malformed JSON: the 400 business refusal is unchanged (never a quota 503).
	for (const body of ["{{{not-json", JSON.stringify({ bogus_key: true })]) {
		const response = await worker.fetch(
			new Request("https://worker.example/internal/research-replica/v2/ingest", {
				method: "POST",
				headers: {
					Authorization: "Bearer internal-token",
					"Content-Type": "application/json",
				},
				body,
			}),
			e,
			ctx,
		);
		assert.equal(response.status, 400, `${body} must stay a 400 INTEGRITY_FAILED`);
	}

	// A valid market_signal record applies end to end...
	const payload = {
		subject_key: "market:000001.SZ",
		as_of: "2026-09-16",
		status: "READY",
		benchmark_mapping_version: "market-benchmarks.v1",
		mapping_id: "cn-a-share-stock-v1",
		primary_benchmark: "510300.SH",
		secondary_benchmark: "510500.SH",
		source: { provider: "amazingdata", snapshot_hash: "a".repeat(64), snapshot_as_of: "2026-09-16T17:44:28+08:00" },
		quality: { valid_trading_days: 10, required_trading_days: 10, future_rows_dropped: 0, missing_sessions: 0 },
		returns: Object.fromEntries([1, 3, 5, 10].map((window) => [`${window}D`, { window_complete: true, valid_trading_days: window, subject_return: 0.1, primary_benchmark_return: 0.05, secondary_benchmark_return: 0.04 }])),
		relative_strength: { primary_pct_points: { "1D": 5, "3D": 5, "5D": 5, "10D": 5 }, secondary_pct_points: { "1D": 6, "3D": 6, "5D": 6, "10D": 6 } },
		volume_price_structure: { up_volume_ratio_5d: 1.25, pullback_volume_ratio_5d: null, volume_up: true, pullback_volume_contraction: false },
		continuous_market_structure: { required_sessions: 3, observed_sessions: 3, relative_positive_sessions: 3, status: "CONFIRMED" },
		visibility: "PUBLIC",
	};
	const record = {
		record_type: "market_signal",
		message_id: "",
		schema_version: "collector-market-signal-v1",
		policy_version: "market-signal-v1",
		visibility: "PUBLIC",
		payload,
		generated_at: "2026-09-16T18:00:00Z",
	};
	const { computeOutboundV2MessageId } = await import("../src/research-outbound-v2.ts");
	record.message_id = await computeOutboundV2MessageId(record);

	const lines = await captureConsoleLog(async () => {
		const response = await worker.fetch(
			new Request("https://worker.example/internal/research-replica/v2/ingest", {
				method: "POST",
				headers: { Authorization: "Bearer internal-token", "Content-Type": "application/json" },
				body: JSON.stringify({ record }),
			}),
			e,
			ctx,
		);
		const body = await response.text();
		assert.equal(response.status, 200, body);
		assert.equal(JSON.parse(body).status, "APPLIED");
	});

	// ...and the metering observed the actual D1 work asynchronously.
	await Promise.all(background);
	const events = observationEvents(lines);
	assert.equal(events.length, 1, "one observation per request");
	assert.equal(events[0].route, "http:/internal/research-replica/v2/ingest");
	const observed = new Map(
		events[0].observed.map((entry) => [entry.dimension_key, entry.units]),
	);
	assert.ok(
		(observed.get("d1.rows_written") ?? 0) > 0,
		`rows_written must be observed, saw ${JSON.stringify(events[0].observed)}`,
	);
	// This route's reads live inside conditional batch statements, which the
	// platform reports as rows_read=0 -- the observer records the measured value,
	// never a fabricated read count.
	assert.equal(observed.get("d1.rows_read") ?? 0, 0);
	assert.ok(
		(observed.get("r2.class_a") ?? 0) >= 1,
		`the journal object write must be observed, saw ${JSON.stringify(events[0].observed)}`,
	);

	// The old leak surface is structurally gone: zero live reservations remain
	// because nothing reserves any more.
	const count = await e.RESEARCH_REPLICA.prepare(`SELECT COUNT(*) AS n FROM quota_reservations`).first();
	assert.equal(count?.n ?? 0, 0);
});

test("vector ingest REJECTED results stay business rejections and still report observations", async () => {
	const e = env();
	e.AI = {};
	e.RESEARCH_PUBLIC_INDEX = {};
	const { ctx, background } = contextCollector();
	// Seed a registered PUBLIC state row whose document is EXPIRED by retention:
	// the lookup reads one real row, then the retention guard rejects the push.
	await e.RESEARCH_REPLICA.prepare(
		`INSERT INTO research_records (record_type, record_key, message_id, visibility, schema_version, payload_json, generated_at, updated_at)
		 VALUES ('document_version', 'ver_expired', 'msg_expired', 'PUBLIC', 'collector-outbound-v4', ?, '2026-09-20T00:00:00Z', '2026-09-20T00:00:00Z')`,
	)
		.bind(
			JSON.stringify({
				document: { document_id: "doc_expired", title: "Expired doc" },
				version: { version_id: "ver_expired", document_id: "doc_expired", version_number: 1 },
			}),
		)
		.run();
	await e.RESEARCH_REPLICA.prepare(
		`INSERT INTO research_semantic_index_state (document_id, version_id, visibility, state, model_id, registered_at, updated_at)
		 VALUES ('doc_expired', 'ver_expired', 'PUBLIC', 'PENDING', '@cf/baai/bge-m3', '2026-09-20T00:00:00Z', '2026-09-20T00:00:00Z')`,
	).run();
	await e.RESEARCH_REPLICA.prepare(
		`INSERT INTO research_document_retention
		 (document_id, visibility, reason, version_ids_json, journal_message_ids_json, content_sha256s_json, status, marked_at)
		 VALUES ('doc_expired', 'PUBLIC', 'AGE_90D', '["ver_expired"]', '[]', '[]', 'EXPIRED', '2026-09-21T00:00:00Z')`,
	).run();

	const lines = await captureConsoleLog(async () => {
		const response = await worker.fetch(
			new Request("https://worker.example/internal/research-semantic-index/ingest-vectors", {
				method: "POST",
				headers: { Authorization: "Bearer internal-token", "Content-Type": "application/json" },
				body: JSON.stringify({
					document_id: "doc_expired",
					version_id: "ver_expired",
					content_sha256: null,
					vectors: [{ ordinal: 0, values: Array(1024).fill(0.5) }],
				}),
			}),
			e,
			ctx,
		);
		assert.equal(response.status, 200);
		const body = await response.json();
		assert.equal(body.status, "REJECTED");
		assert.match(body.reason, /EXPIRED by retention/);
	});
	await Promise.all(background);
	// The REJECTED path performed exactly one read (the state-row lookup) and no
	// writes: the observation reports exactly that, never a fabricated number.
	const events = observationEvents(lines);
	assert.equal(events.length, 1, "one observation per request");
	assert.equal(events[0].route, "http:/internal/research-semantic-index/ingest-vectors");
	const observed = new Map(
		events[0].observed.map((entry) => [entry.dimension_key, entry.units]),
	);
	assert.ok(
		(observed.get("d1.rows_read") ?? 0) > 0,
		`the state-row read must be observed, saw ${JSON.stringify(events[0].observed)}`,
	);
	assert.equal(observed.get("d1.rows_written") ?? 0, 0, "a rejection writes nothing");
});

test("the sealed run route answers with the local-GPU pointer and never touches Workers AI", async () => {
	const e = env();
	e.AI = { run: async () => ({ data: [] }) };
	e.RESEARCH_PUBLIC_INDEX = {};
	const { ctx } = contextCollector();
	let aiCalls = 0;
	e.AI.run = async (...args) => {
		aiCalls += 1;
		return { data: [] };
	};
	const lines = await captureConsoleLog(async () => {
		const response = await worker.fetch(
			new Request("https://worker.example/internal/research-semantic-index/run", {
				method: "POST",
				headers: { Authorization: "Bearer internal-token", "Content-Type": "application/json" },
				body: JSON.stringify({ max_docs: 10 }),
			}),
			e,
			ctx,
		);
		assert.equal(response.status, 200);
		const body = await response.json();
		assert.equal(body.status, "BATCH_DISABLED");
		assert.match(body.reason, /local RTX 5080 GPU pipeline/);
		assert.match(body.push_path, /ingest-vectors/);
		assert.equal(body.workers_ai_calls, 0);
	});
	assert.equal(aiCalls, 0, "the sealed route must not spend a single neuron");
	assert.equal(
		observationEvents(lines).length,
		0,
		"a sealed route does no paid work, so it reports no observation",
	);
});

test("the 40 16 * * * cron fires a structured no-op and never touches Workers AI", async () => {
	const e = env();
	e.AI = {
		run: async () => {
			throw new Error("Workers AI must not be called by the sealed cron");
		},
	};
	e.RESEARCH_PUBLIC_INDEX = {};
	const lines = await captureConsoleLog(async () => {
		await worker.scheduled(
			{ cron: "40 16 * * *", scheduledTime: Date.now() },
			e,
			{ waitUntil: () => undefined },
		);
	});
	const events = lines
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return null;
			}
		})
		.filter((event) => event?.stage === "scheduled_skipped");
	assert.equal(events.length, 1, "exactly one structured skip");
	assert.equal(events[0].task, "research_semantic_index");
	assert.match(events[0].reason, /permanently disabled/);
	assert.equal(events[0].workers_ai_calls, 0);
});
