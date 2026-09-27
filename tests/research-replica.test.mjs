import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith("./") && !path.extname(specifier)) {
			try {
				return nextResolve(`${specifier}.ts`, context);
			} catch {
				// Let the default resolver report the original error for non-TS imports.
			}
		}
		return nextResolve(specifier, context);
	},
});

const fixtureDir = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"fixtures",
	"outbound_v2",
);
const replica = await import("../src/research-replica.ts");
const outbound = await import("../src/research-outbound-v2.ts");
const worker = (await import("../src/index.ts")).default;

async function fixture(name) {
	return JSON.parse(await readFile(path.join(fixtureDir, name), "utf8"));
}

class FakeD1 {
	messages = new Set();
	batches = [];
	records = new Map();
	health = {
		last_attempt_at: null,
		last_success_at: null,
		last_message_id: null,
		last_error_code: null,
		accepted_messages: 0,
	};
	usage = { usage_period: "1970-01", stored_bytes: 0, r2_write_ops: 0 };

	prepare(sql) {
		const db = this;
		return {
			sql,
			params: [],
			bind(...params) {
				this.params = params;
				return this;
			},
			async run() {
				if (sql.includes("SET stored_bytes=stored_bytes+")) {
					const [bytes, writes, , maxBytes, , maxWrites] = this.params;
					if (
						db.usage.stored_bytes + bytes > maxBytes ||
						db.usage.r2_write_ops + writes > maxWrites
					) {
						return { meta: { changes: 0 } };
					}
					db.usage.stored_bytes += bytes;
					db.usage.r2_write_ops += writes;
				}
				if (sql.includes("SET usage_period=?")) {
					const [period] = this.params;
					if (db.usage.usage_period !== period) {
						db.usage.usage_period = period;
						db.usage.r2_write_ops = 0;
					}
				}
				if (sql.includes("accepted_messages")) {
					db.health.last_attempt_at = this.params[0];
					db.health.last_success_at = this.params[1];
					db.health.last_message_id = this.params[2];
					db.health.accepted_messages += this.params[3];
				}
				return { meta: { changes: 1 } };
			},
			async first() {
				if (sql.includes("FROM research_ingest_messages")) {
					return db.messages.has(this.params[0]) ? { message_id: this.params[0] } : null;
				}
				return db.health;
			},
		};
	}

	async batch(statements) {
		this.batches.push(statements);
		const messageId = statements[0].params[0];
		const inserted = !this.messages.has(messageId);
		if (inserted) this.messages.add(messageId);
		const current = statements.find((statement) => statement.sql.includes("INSERT INTO research_records"));
		if (current) {
			const [recordType, recordKey, , , schemaVersion, payloadJson] = current.params;
			const key = `${recordType}:${recordKey}`;
			const previous = this.records.get(key);
			// Mirrors migration 0004's forward-only evidence guard: a delayed
			// v2/v3 envelope may journal, but must not replace a complete v4 row.
			if (!(recordType === "evidence" && previous?.schemaVersion === "collector-outbound-v4" && schemaVersion !== "collector-outbound-v4")) {
				this.records.set(key, { schemaVersion, payloadJson });
			}
		}
		return statements.map((_, index) => ({
			meta: { changes: index === 0 && inserted ? 1 : 0 },
		}));
	}
}

class FakeR2 {
	objects = new Map();

	async put(key, body, options) {
		this.objects.set(key, { body, options });
	}
}

function storage() {
	return { db: new FakeD1(), objects: new FakeR2() };
}

async function marketSignalRecord(subjectKey = "market:000001.SZ") {
	const payload = {
		subject_key: subjectKey,
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
	record.message_id = await outbound.computeOutboundV2MessageId(record);
	return record;
}

test("C5 ingests an independently versioned market_signal record without an Evidence accumulator", async () => {
	const store = storage();
	const record = await marketSignalRecord();
	const result = await replica.ingestResearchReplicaRecord(store, record, null, "2026-09-16T18:00:01Z");
	assert.equal(result.status, "APPLIED");
	assert.equal(result.record_type, "market_signal");
	const saved = store.db.records.get("market_signal:market:000001.SZ");
	assert.equal(saved.schemaVersion, "collector-market-signal-v1");
	assert.equal(JSON.parse(saved.payloadJson).returns["10D"].valid_trading_days, 10);
	assert.equal(JSON.stringify(saved.payloadJson).includes("evidence_ids"), false);
});

test("C5 preserves Python market-signal 0.0 and 1.0 spellings in the message id", async () => {
	const record = await marketSignalRecord("market:canonical-float.SZ");
	record.payload.mapping_id = "canonical-float-v1";
	for (const window of ["1D", "3D", "5D", "10D"]) {
		record.payload.returns[window] = {
			window_complete: true,
			valid_trading_days: Number.parseInt(window, 10),
			subject_return: 0,
			primary_benchmark_return: 1,
			secondary_benchmark_return: 0,
		};
		record.payload.relative_strength.primary_pct_points[window] = 0;
		record.payload.relative_strength.secondary_pct_points[window] = 1;
	}
	record.payload.volume_price_structure = {
		up_volume_ratio_5d: 1,
		pullback_volume_ratio_5d: 0,
		volume_up: true,
		pullback_volume_contraction: false,
	};
	record.message_id = await outbound.computeOutboundV2MessageId(record);
	assert.equal(record.message_id, "outbound_c314986b1f1f182d9e17ec92f0ccd5cfbdf2e681");
	await assert.doesNotReject(() => outbound.verifyOutboundV2Record(record));
});

test("C5 preserves Python market-signal scientific notation in the message id", async () => {
	const record = await marketSignalRecord("market:canonical-scientific.SZ");
	record.payload.mapping_id = "canonical-scientific-v1";
	record.payload.returns["5D"].subject_return = 1.0000100000961964e-5;
	// This id was independently computed with Python json.dumps(sort_keys=True,
	// separators=(",", ":")); JS JSON.stringify would expand the number to
	// 0.000010000100000961964 and therefore produce a different immutable id.
	record.message_id = "outbound_461811327524e95c7f8ce11dd364488e6e073e3f";
	const computed = await outbound.computeOutboundV2MessageId(record);
	assert.equal(computed, record.message_id);
	await assert.doesNotReject(() => outbound.verifyOutboundV2Record(record));
});

test("C5 accepts legacy NO_VALID_BENCHMARK records with empty relative maps only", async () => {
	const legacy = await marketSignalRecord("market:legacy-no-benchmark.SZ");
	legacy.payload.status = "NO_VALID_BENCHMARK";
	legacy.payload.benchmark_mapping_version = null;
	legacy.payload.mapping_id = null;
	legacy.payload.primary_benchmark = null;
	legacy.payload.secondary_benchmark = null;
	for (const window of ["1D", "3D", "5D", "10D"]) {
		legacy.payload.returns[window].primary_benchmark_return = null;
		legacy.payload.returns[window].secondary_benchmark_return = null;
	}
	legacy.payload.relative_strength = { primary_pct_points: {}, secondary_pct_points: {} };
	legacy.message_id = await outbound.computeOutboundV2MessageId(legacy);
	await assert.doesNotReject(() => outbound.verifyOutboundV2Record(legacy));

	const strict = structuredClone(legacy);
	strict.payload.status = "READY";
	strict.message_id = await outbound.computeOutboundV2MessageId(strict);
	await assert.rejects(() => outbound.verifyOutboundV2Record(strict));
});

test("C5 stores path-free metadata, document links, and an immutable recovery journal", async () => {
	const store = storage();
	const document = (await fixture("metadata_document_version.public.json"))[0];
	const result = await replica.ingestResearchReplicaRecord(
		store,
		document,
		null,
		"2026-09-13T14:00:00Z",
	);
	assert.equal(result.status, "APPLIED");
	assert.equal(result.record_type, "document_version");
	assert.equal(store.db.batches.length, 1);
	assert.equal(
		store.db.batches[0].length,
		6,
		"message + current record + body + attachment links + task D semantic pending row + supersede",
	);
	assert.equal(store.objects.objects.size, 1, "only the journal is written for metadata");
	assert.ok(
		[...store.objects.objects.keys()][0].startsWith("research-replica-journal/v2/outbound_"),
	);
	// Task D: the PUBLIC index-pending registration rides in the same
	// transaction, so no crash window exists between "stored" and "planned".
	assert.deepEqual(result.semantic_target, {
		documentId: document.payload.document.document_id,
		versionId: document.payload.version.version_id,
	});
	const semanticStatements = store.db.batches[0].filter((statement) =>
		statement.sql.includes("research_semantic_index_state"),
	);
	assert.equal(semanticStatements.length, 2);
	assert.match(semanticStatements[0].sql, /INSERT INTO research_semantic_index_state/);
	assert.equal(semanticStatements[0].params[2], document.payload.version.content_sha256);
	assert.equal(
		semanticStatements[1].sql.includes("version_id<>?"),
		true,
		"a servable incoming version supersedes the document's other versions",
	);
});

test("C5 registers no semantic state for PRIVATE or non-document records", async () => {
	const store = storage();
	for (const name of ["metadata_document_version.private.json", "metadata_evidence.json", "metadata_source.public.json"]) {
		const record = (await fixture(name))[0];
		const result = await replica.ingestResearchReplicaRecord(store, record, null, "2026-09-13T14:00:00Z");
		assert.equal(result.semantic_target, null, name);
	}
	for (const batch of store.db.batches) {
		assert.equal(
			batch.some((statement) => statement.sql.includes("research_semantic_index_state")),
			false,
		);
	}
});

test("C5 v4 Evidence wins over a delayed legacy envelope with the same logical key", async () => {
	const store = storage();
	const legacy = structuredClone((await fixture("metadata_evidence.json"))[0]);
	const document = (await fixture("metadata_document_version.public.json"))[0];
	const v4 = structuredClone(legacy);
	v4.schema_version = "collector-outbound-v4";
	v4.payload.source_reference = {
		document_id: document.payload.document.document_id,
		document_version_id: document.payload.version.version_id,
		attachment_id: null,
		content_sha256: "a".repeat(64),
		byte_start: 0,
		byte_end: 1,
		span_sha256: "b".repeat(64),
	};
	v4.payload.event_time = null;
	v4.payload.published_at = "2026-09-13T00:00:00Z";
	v4.payload.first_seen_at = "2026-09-13T00:01:00Z";
	v4.payload.ingested_at = "2026-09-13T00:02:00Z";
	v4.message_id = await outbound.computeOutboundV2MessageId(v4);
	legacy.schema_version = "collector-outbound-v3";
	legacy.message_id = await outbound.computeOutboundV2MessageId(legacy);
	await replica.ingestResearchReplicaRecord(store, v4, null, "2026-09-15T00:00:00Z");
	await replica.ingestResearchReplicaRecord(store, legacy, null, "2026-09-15T00:01:00Z");
	const saved = store.db.records.get(`evidence:${v4.payload.evidence_id}`);
	assert.equal(saved.schemaVersion, "collector-outbound-v4");
	assert.ok(JSON.parse(saved.payloadJson).source_reference);
});

test("C5 validates object bytes before private R2 storage and replays without a new logical message", async () => {
	const store = storage();
	const bytes = new TextEncoder().encode("synthetic raw document for C5 object test");
	const hash = await crypto.subtle.digest("SHA-256", bytes);
	const digest = [...new Uint8Array(hash)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	const object = structuredClone((await fixture("object_small.json"))[0]);
	object.payload.byte_size = bytes.byteLength;
	object.payload.chunking = {
		chunked: false,
		chunk_size: bytes.byteLength,
		total_chunks: 1,
		chunk_sha256: [digest],
	};
	object.payload.content_sha256 = digest;
	object.payload.object_id = digest;
	object.payload.manifest_message_id = "pending";
	object.message_id = await outbound.computeOutboundV2MessageId(object);
	object.payload.manifest_message_id = object.message_id;

	const first = await replica.ingestResearchReplicaRecord(
		store,
		object,
		[bytes],
		"2026-09-13T14:01:00Z",
	);
	const replay = await replica.ingestResearchReplicaRecord(
		store,
		object,
		[bytes],
		"2026-09-13T14:02:00Z",
	);
	assert.equal(first.status, "APPLIED");
	assert.equal(replay.status, "REPLAY");
	assert.equal(store.db.messages.size, 1);
	assert.equal(store.objects.objects.size, 2, "journal plus content-addressed raw object");
	assert.equal(store.db.health.accepted_messages, 1);
});

test("C5 fails closed before storage on corrupted body or forbidden metadata", async () => {
	const store = storage();
	const corruption = await fixture("corruption_tampered_chunk.json");
	await assert.rejects(
		() =>
			replica.ingestResearchReplicaRecord(
				store,
				corruption.record,
				corruption.chunks_hex.map((chunk) => Buffer.from(chunk, "hex")),
			),
		(error) => error?.error_code === "INTEGRITY_FAILED",
	);
	assert.equal(store.db.batches.length, 0);
	assert.equal(store.objects.objects.size, 0);

	const source = structuredClone((await fixture("metadata_source.public.json"))[0]);
	source.payload.local_path = "D:\\Research\\secret.db";
	await assert.rejects(
		() => replica.ingestResearchReplicaRecord(store, source),
		(error) => error?.error_code === "INTEGRITY_FAILED",
	);
});

test("C5 hard quota rejects a new record before it writes any R2 object", async () => {
	const store = storage();
	store.db.usage.stored_bytes = replica.RESEARCH_REPLICA_MAX_STORED_BYTES;
	const source = (await fixture("metadata_source.public.json"))[0];
	await assert.rejects(
		() => replica.ingestResearchReplicaRecord(store, source),
		(error) => error?.error_code === "RATE_LIMITED",
	);
	assert.equal(store.objects.objects.size, 0);
	assert.equal(store.db.batches.length, 0);
});

test("C5 exposes health for observation and makes its recovery path the same idempotent ingest", async () => {
	const store = storage();
	const source = (await fixture("metadata_source.private.json"))[0];
	await replica.ingestResearchReplicaRecord(store, source, null, "2026-09-13T14:03:00Z");
	assert.deepEqual(await replica.readResearchReplicaHealth(store), {
		last_attempt_at: "2026-09-13T14:03:00Z",
		last_success_at: "2026-09-13T14:03:00Z",
		last_message_id: source.message_id,
		last_error_code: null,
		accepted_messages: 1,
	});
	assert.equal((await replica.ingestResearchReplicaRecord(store, source)).status, "REPLAY");
});

test("C5 internal transport is separate from MCP and fails closed without its own scope and storage", async () => {
	const response = await worker.fetch(
		new Request("https://worker.example/internal/research-replica/v2/ingest", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ record: (await fixture("metadata_source.public.json"))[0] }),
		}),
		{},
		{},
	);
	assert.equal(response.status, 503);
	assert.deepEqual(Object.keys(await response.json()).sort(), [
		"error_code",
		"request_id",
		"retryable",
		"safe_message",
	]);
});
