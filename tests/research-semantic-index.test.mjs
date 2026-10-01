/**
 * Task D: Collector PUBLIC semantic index and `search_documents_semantic`.
 *
 * The database half runs the REAL migration chain (0001-0012) on the
 * node:sqlite shim, so the state table's constraints, the ON CONFLICT
 * keep-READY guard, the keyset compensation page and the retired-vector
 * cleanup are proven against production SQL, not against a pattern match.
 * Workers AI and Vectorize are deterministic synthetic fakes: 1024-dimensional
 * embeddings, an in-memory vector store with real cosine ranking, and
 * injectable outages for the "an unavailable index is never an empty result"
 * contract.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

const semantic = await import("../src/research-semantic-index.ts");
const replica = await import("../src/research-replica.ts");
const outbound = await import("../src/research-outbound-v2.ts");
const remote = await import("../src/research-remote-adapter.ts");
const indexModule = await import("../src/index.ts");
const worker = indexModule.default;
const { createServer } = await import("../src/index.ts");
const { createResearchWorkflowDb } = await import("./helpers/d1-sqlite-shim.mjs");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

const encoder = new TextEncoder();
const fixtureDir = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"fixtures",
	"outbound_v2",
);
const NOW = "2026-09-28T00:00:00.000Z";

function sha256HexOf(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

/* ---------------------------------------------------------------- */
/* Synthetic Workers AI / Vectorize / R2                            */
/* ---------------------------------------------------------------- */

/**
 * Deterministic character/bigram histogram embedding.  It is not a language
 * model, but it is stable, normalized, and ranks text with shared characters
 * above unrelated text - enough to exercise over-fetch, filtering and dedup
 * with real cosine arithmetic.
 */
function embedText(text, dims) {
	const vector = new Array(dims).fill(0);
	const chars = [...text.normalize("NFC")];
	for (const char of chars) vector[char.codePointAt(0) % dims] += 1;
	for (let index = 1; index < chars.length; index += 1) {
		const bigram = (chars[index - 1].codePointAt(0) * 31 + chars[index].codePointAt(0)) % dims;
		vector[bigram] += 2;
	}
	const norm = Math.hypot(...vector) || 1;
	return vector.map((value) => value / norm);
}

function cosine(left, right) {
	let dot = 0;
	for (let index = 0; index < left.length; index += 1) dot += left[index] * right[index];
	return dot;
}

class FakeAi {
	constructor({ dims = 1024 } = {}) {
		this.dims = dims;
		this.calls = 0;
		this.models = [];
		this.fail = false;
	}

	async run(model, inputs) {
		this.calls += 1;
		this.models.push(model);
		if (this.fail) throw new Error("synthetic workers ai outage");
		const texts = Array.isArray(inputs.text) ? inputs.text : [inputs.text];
		return {
			shape: [texts.length, this.dims],
			data: texts.map((text) => embedText(text, this.dims)),
		};
	}
}

class FakeVectorize {
	constructor() {
		this.vectors = new Map();
		this.upsertCalls = 0;
		this.queryFail = false;
		this.queryOptions = [];
	}

	async upsert(entries) {
		this.upsertCalls += 1;
		for (const entry of entries) {
			this.vectors.set(entry.id, { values: entry.values, metadata: entry.metadata });
		}
	}

	async deleteByIds(ids) {
		for (const id of ids) this.vectors.delete(id);
	}

	async getByIds(ids) {
		return ids.flatMap((id) => {
			const value = this.vectors.get(id);
			return value ? [{ id, values: value.values, metadata: value.metadata }] : [];
		});
	}

	async describe() {
		return {
			dimensions: 1024,
			vectorCount: this.vectors.size,
			processedUpToDatetime: 0,
			processedUpToMutation: 0,
		};
	}

	async query(values, options = {}) {
		if (this.queryFail) throw new Error("synthetic vectorize outage");
		this.queryOptions.push(options);
		const matches = [...this.vectors.entries()]
			.map(([id, entry]) => ({
				id,
				score: cosine(values, entry.values),
				metadata: entry.metadata,
			}))
			.sort((left, right) => right.score - left.score || (left.id < right.id ? -1 : 1));
		return { matches: matches.slice(0, options.topK ?? 10), count: matches.length };
	}

	metadatas() {
		return [...this.vectors.values()].map((entry) => entry.metadata);
	}
}

class FakeR2 {
	constructor() {
		this.objects = new Map();
	}

	async put(key, body) {
		this.objects.set(
			key,
			typeof body === "string" ? encoder.encode(body) : new Uint8Array(body),
		);
	}

	async get(key) {
		const bytes = this.objects.get(key);
		if (!bytes) return null;
		return {
			arrayBuffer: async () =>
				bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
		};
	}
}

function storage() {
	return { db: createResearchWorkflowDb(), objects: new FakeR2() };
}

function fakes({ dims = 1024 } = {}) {
	const ai = new FakeAi({ dims });
	const index = new FakeVectorize();
	return { ai, index, deps: { ai, index } };
}

/* ---------------------------------------------------------------- */
/* Synthetic replica rows (frozen outbound-v2 key sets)             */
/* ---------------------------------------------------------------- */

function documentVersionPayload({
	documentId = "doc_synthetic_1",
	versionId = "ver_synthetic_1",
	versionNumber = 1,
	revisionKind = "ORIGINAL",
	mediaType = "text/plain",
	body = "synthetic body",
	title = "Synthetic title",
	visibility = "PUBLIC",
	sourceKind = "RSS",
	publishedAt = "2026-09-20T00:00:00+00:00",
	projection = null,
} = {}) {
	const bodyBytes = encoder.encode(body);
	const attachments = [];
	if (projection !== null) {
		const projectionBytes = encoder.encode(projection);
		attachments.push({
			attachment_id: `att_${versionId}`,
			attachment_locator: `urn:riws:text-extraction:${versionId}`,
			content_sha256: sha256HexOf(projectionBytes),
			byte_size: projectionBytes.byteLength,
			media_type: "text/plain",
			display_name: "extracted-text",
			role: "text_extraction",
			attachment_status: "FETCHED",
			outcome: null,
			failure_class: null,
		});
	}
	const payload = {
		document: {
			document_id: documentId,
			source_id: "fixture-source-public",
			source_identity_key: `identity-${documentId}`,
			canonical_locator: "lead://synthetic/item",
			origin_locator: "lead://synthetic/origin",
			first_seen_at: "2026-09-19T00:00:00+00:00",
			title,
			source_kind: sourceKind,
			visibility,
			historical_backfill: false,
		},
		version: {
			version_id: versionId,
			document_id: documentId,
			version_number: versionNumber,
			content_sha256: sha256HexOf(bodyBytes),
			byte_size: bodyBytes.byteLength,
			media_type: mediaType,
			ingested_at: "2026-09-20T00:00:00+00:00",
			published_at: publishedAt,
			event_time: null,
			source_updated_at: null,
			response_headers: {},
			revision_kind: revisionKind,
			corrects_version_id: null,
			historical_backfill: false,
			readable: mediaType.startsWith("text/"),
		},
		attachments,
	};
	const readable = mediaType.startsWith("text/");
	return {
		payload,
		bodyBytes,
		// Only the servable body is addressable; a non-whitelisted media type
		// without a projection has no readable object at all.
		hash: readable ? payload.version.content_sha256 : null,
	};
}

async function seedObjectR2(store, built) {
	if (!built.hash) return;
	const bytes = built.bodyBytes;
	await store.objects.put(`research-objects/sha256/${built.hash}`, bytes);
	await store.db
		.prepare(
			"INSERT OR IGNORE INTO research_objects (content_sha256, message_id, visibility, media_type, byte_size, state, received_at) VALUES (?, ?, 'PUBLIC', 'text/plain', ?, 'READY', ?)",
		)
		.bind(built.hash, `outbound_object_${built.hash.slice(0, 16)}`, bytes.byteLength, NOW)
		.run();
}

/** Insert one replica row the way C5 ingest would have left it. */
async function seedVersionRow(store, built, { visibility = "PUBLIC", updatedAt = NOW } = {}) {
	const payload = built.payload;
	await store.db
		.prepare(
			"INSERT INTO research_records (record_type, record_key, message_id, visibility, schema_version, payload_json, generated_at, updated_at) VALUES ('document_version', ?, ?, ?, 'collector-outbound-v4', ?, ?, ?)",
		)
		.bind(
			payload.version.version_id,
			`outbound_${sha256HexOf(encoder.encode(payload.version.version_id)).slice(0, 40)}`,
			visibility,
			JSON.stringify(payload),
			"2026-09-20T00:00:00+00:00",
			updatedAt,
		)
		.run();
	if (visibility === "PUBLIC") await seedObjectR2(store, built);
}

/** A validated outbound-v2 envelope for one payload (exercises the C5 path). */
async function envelopeFor(
	payload,
	{ visibility = "PUBLIC", generatedAt = "2026-09-28T00:00:00+00:00" } = {},
) {
	const record = {
		record_type: "document_version",
		message_id: "",
		schema_version: "collector-outbound-v4",
		policy_version: "collector-policy-v1",
		visibility,
		payload,
		generated_at: generatedAt,
	};
	record.message_id = await outbound.computeOutboundV2MessageId(record);
	return record;
}

async function fixtureEnvelope(name, mutate = () => {}) {
	const record = JSON.parse(await readFile(path.join(fixtureDir, name), "utf8"))[0];
	mutate(record);
	record.message_id = await outbound.computeOutboundV2MessageId(record);
	return record;
}

async function stateRow(store, documentId, versionId) {
	return store.db
		.prepare("SELECT * FROM research_semantic_index_state WHERE document_id=? AND version_id=?")
		.bind(documentId, versionId)
		.first();
}

async function stateRows(store) {
	const result = await store.db
		.prepare("SELECT * FROM research_semantic_index_state ORDER BY document_id, version_id")
		.all();
	return result.results;
}

/**
 * The local RTX 5080 GPU pipeline in miniature (quota redesign 2026-10-02):
 * chunk the composed text locally, embed with the same deterministic synthetic
 * embedder the FakeAi uses, and push through the REAL production
 * precomputed-vector path.  Cloud document embedding no longer exists.
 */
function servableHashOf(built) {
	if (built.payload.version.media_type.startsWith("text/")) {
		return built.payload.version.content_sha256;
	}
	const projection = built.payload.attachments.find(
		(attachment) =>
			attachment.role === "text_extraction" && attachment.attachment_status === "FETCHED",
	);
	return projection ? projection.content_sha256 : null;
}

async function pushDocumentVectors(store, fake, built, { bodyText = null } = {}) {
	const title = built.payload.document.title ?? "";
	const body = bodyText ?? (built.hash ? new TextDecoder().decode(built.bodyBytes) : null);
	const composed = body ? (title ? `${title}\n\n${body}` : body) : title || null;
	if (!composed) return { status: "NOTHING_TO_PUSH" };
	const { chunks } = semantic.chunkSemanticDocument(composed);
	const vectors = chunks.map((chunk) => ({
		ordinal: chunk.ordinal,
		values: embedText(chunk.text, 1024),
	}));
	return semantic.ingestPrecomputedVectors(
		store,
		{ index: fake.index },
		{
			document_id: built.payload.document.document_id,
			version_id: built.payload.version.version_id,
			content_sha256: body ? servableHashOf(built) : null,
			vectors,
		},
	);
}

/** Register the pending state row the way the ingest transaction does. */
async function registerPending(store, built, updatedAt = NOW) {
	const statements = semantic.semanticIndexIngestStatements(
		store.db,
		await envelopeFor(built.payload),
		updatedAt,
	);
	if (statements.length > 0) await store.db.batch(statements);
}

async function search(store, fake, query, limit = 5) {
	return semantic.searchPublicDocumentsSemantic(store, fake.deps, { query, limit });
}

/* ---------------------------------------------------------------- */
/* Chunking                                                         */
/* ---------------------------------------------------------------- */

test("chunking keeps 1200/150 boundaries and samples head+tail when over 32 chunks", () => {
	const sentence = `${"合成研究正文".repeat(20)}。`;
	const long = sentence.repeat(500);
	const { chunks, truncated } = semantic.chunkSemanticDocument(long);
	assert.equal(truncated, true);
	assert.equal(chunks.length, semantic.SEMANTIC_MAX_CHUNKS);
	assert.deepEqual(
		chunks.map((chunk) => chunk.ordinal),
		Array.from({ length: semantic.SEMANTIC_MAX_CHUNKS }, (_, index) => index),
	);
	for (const chunk of chunks) {
		assert.ok(chunk.text.length <= semantic.SEMANTIC_CHUNK_CHARS, chunk.text.length.toString());
	}
	// Head + tail sampling: the first chunk starts the document, the last one
	// ends it, so a very long document contributes both ends.
	assert.ok(chunks[0].text.startsWith("合成研究正文"), "head kept");
	assert.ok(chunks[chunks.length - 1].text.endsWith("。"), "tail kept");

	const short = semantic.chunkSemanticDocument("只有一句话。");
	assert.equal(short.truncated, false);
	assert.equal(short.chunks.length, 1);
	assert.equal(short.chunks[0].text, "只有一句话。");
	assert.deepEqual(semantic.chunkSemanticDocument("   "), { chunks: [], truncated: false });
});

test("chunk overlap and control-character normalization are stable", () => {
	const text = `${"段落内容".repeat(200)}\n\n${"后续段落".repeat(200)}`;
	const { chunks } = semantic.chunkSemanticDocument(text);
	assert.ok(chunks.length >= 2);
	for (let index = 1; index < chunks.length; index += 1) {
		const previous = chunks[index - 1].text;
		const current = chunks[index].text;
		const overlaps = [...previous].some((_, offset) => {
			const candidate = previous.slice(offset);
			return candidate.length > 20 && current.startsWith(candidate);
		});
		assert.ok(overlaps, "consecutive chunks must share a tail/head overlap");
	}
	assert.equal(semantic.normalizeSemanticText("a\u0000b\u0007c"), "a b c");
	assert.equal(semantic.normalizeSemanticText("x\u2028y\u2029z"), "x y z");
});

test("vector ids are deterministic, ordinal-scoped and identifier-free", async () => {
	const first = await semantic.semanticVectorId("doc_a", "ver_a", 0);
	const again = await semantic.semanticVectorId("doc_a", "ver_a", 0);
	const second = await semantic.semanticVectorId("doc_a", "ver_a", 1);
	assert.equal(first, again);
	assert.notEqual(first, second);
	assert.match(first, /^rsv1_[0-9a-f]{32}$/);
	assert.equal(first.includes("doc_a"), false);
	assert.equal(first.includes("ver_a"), false);
});

/* ---------------------------------------------------------------- */
/* Ingest-time registration                                         */
/* ---------------------------------------------------------------- */

test("ingest registers a PUBLIC pending row and supersedes older versions in the same batch", async () => {
	const store = storage();
	const first = await fixtureEnvelope("metadata_document_version.public.json");
	const documentId = first.payload.document.document_id;
	const versionId = first.payload.version.version_id;
	const applied = await replica.ingestResearchReplicaRecord(store, first, null, NOW);
	assert.equal(applied.status, "APPLIED");
	assert.deepEqual(applied.semantic_target, { documentId, versionId });
	const pending = await stateRow(store, documentId, versionId);
	assert.equal(pending.visibility, "PUBLIC");
	assert.equal(pending.state, "PENDING");
	assert.equal(pending.content_sha256, first.payload.version.content_sha256);
	assert.equal(pending.model_id, semantic.SEMANTIC_MODEL_ID);
	assert.equal(pending.registered_at, NOW);
	assert.equal(pending.retired_at, null);

	// A newer version of the same document retires the previous row in the same
	// transaction, before any asynchronous vector delete.
	const second = structuredClone(first);
	second.payload.version.version_id = "ver_newer_synthetic";
	second.payload.version.version_number = 2;
	second.message_id = await outbound.computeOutboundV2MessageId(second);
	assert.equal(
		(await replica.ingestResearchReplicaRecord(store, second, null, NOW)).status,
		"APPLIED",
	);
	const retired = await stateRow(store, documentId, versionId);
	assert.equal(retired.state, "FAILED");
	assert.equal(retired.last_error_code, semantic.SEMANTIC_SUPERSEDED_CODE);
	assert.equal(retired.retired_at, NOW);
	assert.equal(retired.expected_chunks, 0);
	assert.equal(retired.confirmed_chunks, 0);
	const current = await stateRow(store, documentId, "ver_newer_synthetic");
	assert.equal(current.state, "PENDING");
	assert.equal(current.retired_at, null);
});

test("PRIVATE document versions never register and the database rejects a PRIVATE index row", async () => {
	const store = storage();
	const privateRecord = await fixtureEnvelope("metadata_document_version.private.json");
	const result = await replica.ingestResearchReplicaRecord(store, privateRecord, null, NOW);
	assert.equal(result.status, "APPLIED");
	assert.equal(result.semantic_target, null);
	assert.equal((await stateRows(store)).length, 0);
	await assert.rejects(
		() =>
			store.db
				.prepare(
					"INSERT INTO research_semantic_index_state (document_id, version_id, visibility, state, model_id, registered_at, updated_at) VALUES ('doc_private', 'ver_private', 'PRIVATE', 'PENDING', ?, ?, ?)",
				)
				.bind(semantic.SEMANTIC_MODEL_ID, NOW, NOW)
				.run(),
		"the state table must refuse PRIVATE visibility",
	);
});

test("REPLAY and duplicate delivery never reset a READY row", async () => {
	const store = storage();
	const fake = fakes();
	const built = documentVersionPayload({
		documentId: "doc_replay",
		versionId: "ver_replay",
		body: "重放语义测试正文",
	});
	await seedObjectR2(store, built);
	const record = await envelopeFor(built.payload);
	await replica.ingestResearchReplicaRecord(store, record, null, NOW);
	assert.equal((await pushDocumentVectors(store, fake, built)).status, "READY");
	assert.equal((await stateRow(store, "doc_replay", "ver_replay")).state, "READY");

	const replayed = await replica.ingestResearchReplicaRecord(store, record, null, NOW);
	assert.equal(replayed.status, "REPLAY");
	assert.equal(replayed.semantic_target, null);
	const afterReplay = await stateRow(store, "doc_replay", "ver_replay");
	assert.equal(afterReplay.state, "READY");
	assert.equal(afterReplay.confirmed_chunks, afterReplay.expected_chunks);

	// Re-registering the identical version (out-of-order redelivery that yields a
	// new message id, or a sweep refresh) must keep the READY accounting.
	const rebuildStatements = semantic.semanticIndexIngestStatements(
		store.db,
		await envelopeFor(built.payload, { generatedAt: "2026-09-28T02:00:00+00:00" }),
		"2026-09-28T02:00:00.000Z",
	);
	assert.ok(rebuildStatements.length >= 1);
	await store.db.batch(rebuildStatements);
	const kept = await stateRow(store, "doc_replay", "ver_replay");
	assert.equal(kept.state, "READY");
	assert.ok(kept.expected_chunks > 0);
	assert.equal(kept.confirmed_chunks, kept.expected_chunks);

	// A changed content hash for the same version id can never keep READY.
	const changed = documentVersionPayload({
		documentId: "doc_replay",
		versionId: "ver_replay",
		body: "重放语义测试正文（已变更）",
	});
	const resetStatements = semantic.semanticIndexIngestStatements(
		store.db,
		await envelopeFor(changed.payload, { generatedAt: "2026-09-28T03:00:00+00:00" }),
		"2026-09-28T03:00:00.000Z",
	);
	await store.db.batch(resetStatements);
	const reset = await stateRow(store, "doc_replay", "ver_replay");
	assert.equal(reset.state, "PENDING");
	assert.equal(reset.confirmed_chunks, 0);
	assert.equal(reset.content_sha256, changed.hash);
});

/* ---------------------------------------------------------------- */
/* Indexing chain                                                   */
/* ---------------------------------------------------------------- */

test("pending semantic version listing is state-filtered and cursor bounded", async () => {
	const store = storage();
	const fake = fakes();
	const built = [];
	for (let i = 0; i < 23; i += 1) {
		const n = String(i).padStart(2, "0");
		const item = documentVersionPayload({ documentId: `doc_queue_${n}`, versionId: `ver_queue_${n}` });
		await seedVersionRow(store, item);
		await registerPending(store, item);
		built.push(item);
	}
	// One version gets its local vectors: 1 READY, 22 PENDING.
	await pushDocumentVectors(store, fake, built[0]);
	const first = await semantic.listPendingSemanticVersions(store, { limit: 20, state: "PENDING" });
	assert.equal(first.items.length, 20, "bounded page returns the requested rows");
	assert.ok(first.next);
	// Mutate the first page's state and updated_at as a successful local upload
	// would.  The immutable-ID cursor must still reach every remaining version.
	for (const item of first.items) {
		await store.db.prepare("UPDATE research_semantic_index_state SET state='READY', updated_at='2026-09-30T12:00:00Z' WHERE document_id=? AND version_id=?")
			.bind(item.document_id, item.version_id).run();
	}
	const second = await semantic.listPendingSemanticVersions(store, { limit: 20, state: "PENDING", after: first.next });
	assert.equal(first.items.length + second.items.length, 22);
	assert.equal(new Set([...first.items, ...second.items].map((item) => item.version_id)).size, 22);
	const ready = await semantic.listPendingSemanticVersions(store, { limit: 20, state: "READY" });
	assert.equal(ready.items.length, 20, "the mutated first page is now READY");
});

test("pending registration -> local vector push -> READY with deterministic ids and PUBLIC-only metadata", async () => {
	const store = storage();
	const fake = fakes();
	const built = documentVersionPayload({ documentId: "doc_chain", versionId: "ver_chain" });
	await seedVersionRow(store, built);
	await registerPending(store, built);
	assert.equal((await stateRow(store, "doc_chain", "ver_chain")).state, "PENDING");

	const pushed = await pushDocumentVectors(store, fake, built);
	assert.equal(pushed.status, "READY");
	assert.equal(pushed.upserted, 1);
	const row = await stateRow(store, "doc_chain", "ver_chain");
	assert.equal(row.state, "READY");
	assert.equal(row.expected_chunks, 1);
	assert.equal(row.confirmed_chunks, 1);
	assert.equal(row.title_only, 0);
	assert.equal(row.truncated, 0);
	assert.equal(row.content_sha256, built.payload.version.content_sha256);
	// G2: the document-vector work happens entirely off-cloud now.
	assert.equal(fake.ai.calls, 0, "no Workers AI call may embed documents any more");
	for (const metadata of fake.index.metadatas()) {
		assert.deepEqual(Object.keys(metadata).sort(), [
			"chunk",
			"document_id",
			"model_id",
			"version_id",
		]);
		assert.equal(metadata.chunk, 0);
		assert.equal(metadata.model_id, semantic.SEMANTIC_MODEL_ID);
	}
	assert.deepEqual(
		[...fake.index.vectors.keys()],
		[await semantic.semanticVectorId("doc_chain", "ver_chain", 0)],
	);
});

test("metadata before object: the local vector is inert until the object lands, then served", async () => {
	const store = storage();
	const fake = fakes();
	const built = documentVersionPayload({
		documentId: "doc_late_object",
		versionId: "ver_late_object",
		body: "迟到的正文对象",
	});
	// Metadata row without its body object (out-of-order delivery).
	await seedVersionRow(store, built, {});
	await store.db
		.prepare("DELETE FROM research_objects WHERE content_sha256=?")
		.bind(built.hash)
		.run();
	store.objects.objects.delete(`research-objects/sha256/${built.hash}`);
	await registerPending(store, built);
	assert.equal(fake.ai.calls, 0, "no cloud embedding may happen at all");

	// The local pipeline pushes before the object arrives: the state row turns
	// READY (the hash is validated against the D1 payload), but the query face
	// re-validates against R2 and refuses to serve an unreadable body.
	assert.equal((await pushDocumentVectors(store, fake, built)).status, "READY");
	const before = await search(store, fake, "迟到的正文对象");
	assert.equal(before.matches.length, 0, "a hit without its object is never served");

	// The object arrives afterwards; the same vector becomes servable with no
	// further write.
	await seedObjectR2(store, built);
	const after = await search(store, fake, "迟到的正文对象");
	assert.equal(after.matches.length, 1);
	assert.equal(after.matches[0].document_id, "doc_late_object");
});

test("object before metadata: ingest registers the pending row at write time and the local pipeline completes it", async () => {
	const store = storage();
	const fake = fakes();
	const built = documentVersionPayload({
		documentId: "doc_object_first",
		versionId: "ver_object_first",
		body: "先到对象后到元数据",
	});
	await seedObjectR2(store, built);
	const applied = await replica.ingestResearchReplicaRecord(
		store,
		await envelopeFor(built.payload),
		null,
		NOW,
	);
	assert.deepEqual(applied.semantic_target, {
		documentId: "doc_object_first",
		versionId: "ver_object_first",
	});
	assert.equal((await stateRow(store, "doc_object_first", "ver_object_first")).state, "PENDING");
	assert.equal((await pushDocumentVectors(store, fake, built)).status, "READY");
	assert.equal((await stateRow(store, "doc_object_first", "ver_object_first")).state, "READY");
});

test("no readable body and no usable title stays pending; nothing is ever fabricated", async () => {
	const store = storage();
	const fake = fakes();
	const built = documentVersionPayload({
		documentId: "doc_unreadable",
		versionId: "ver_unreadable",
		mediaType: "application/pdf",
		title: "",
	});
	await seedVersionRow(store, built);
	await registerPending(store, built);
	// There is nothing to embed: the local pipeline pushes nothing and the row
	// simply waits.  No dead-letter accounting exists on the cloud face any more,
	// and no invented text is ever embedded.
	assert.equal((await pushDocumentVectors(store, fake, built)).status, "NOTHING_TO_PUSH");
	const row = await stateRow(store, "doc_unreadable", "ver_unreadable");
	assert.equal(row.state, "PENDING");
	assert.equal(fake.ai.calls, 0);
	assert.equal(fake.index.vectors.size, 0);
	const coverage = await semantic.readSemanticIndexCoverage(store);
	assert.equal(coverage.failure_codes.length, 0);
	// The row stays queue-visible; the local pipeline inspects the payload and
	// simply has nothing to embed -- the cloud face never invents text.
	const pending = await semantic.listPendingSemanticVersions(store, { state: "PENDING" });
	assert.equal(pending.items.length, 1);
	assert.equal(pending.items[0].version_id, "ver_unreadable");
});

test("title_only versions get a marked title chunk via the local push (no OCR fabrication)", async () => {
	const store = storage();
	const fake = fakes();
	const built = documentVersionPayload({
		documentId: "doc_title_only",
		versionId: "ver_title_only",
		mediaType: "application/pdf",
		title: "只有标题的研究条目",
		body: "unreadable bytes",
	});
	await seedVersionRow(store, built);
	await registerPending(store, built);
	assert.equal((await pushDocumentVectors(store, fake, built)).status, "READY");
	const row = await stateRow(store, "doc_title_only", "ver_title_only");
	assert.equal(row.title_only, 1);
	assert.equal(row.content_sha256, null);
	assert.equal(row.expected_chunks, 1);
	const result = await search(store, fake, "只有标题的研究条目");
	assert.equal(result.index_status, "READY");
	assert.equal(result.matches.length, 1);
	assert.equal(result.matches[0].document_id, "doc_title_only");
	assert.equal(result.matches[0].snippet, "只有标题的研究条目");
});

test("a PDF version with a FETCHED text-extraction projection indexes the projection", async () => {
	const store = storage();
	const fake = fakes();
	const projection = "合成投影正文：这条 PDF 版本只通过文本抽取投影可读。";
	const built = documentVersionPayload({
		documentId: "doc_projection",
		versionId: "ver_projection",
		mediaType: "application/pdf",
		title: "投影标题",
		projection,
	});
	await seedVersionRow(store, built);
	await store.objects.put(
		`research-objects/sha256/${built.payload.attachments[0].content_sha256}`,
		encoder.encode(projection),
	);
	await registerPending(store, built);
	assert.equal(
		(await pushDocumentVectors(store, fake, built, { bodyText: projection })).status,
		"READY",
	);
	const row = await stateRow(store, "doc_projection", "ver_projection");
	assert.equal(row.content_sha256, built.payload.attachments[0].content_sha256);
	assert.equal(row.title_only, 0);
	const result = await search(store, fake, "投影正文");
	assert.equal(result.matches.length, 1);
	assert.equal(result.matches[0].document_id, "doc_projection");
});

/* ---------------------------------------------------------------- */
/* Version replacement, withdrawal, retirement                      */
/* ---------------------------------------------------------------- */

test("version replacement hides the old version immediately; the stale vector is never served", async () => {
	const store = storage();
	const fake = fakes();
	const older = documentVersionPayload({
		documentId: "doc_replace",
		versionId: "ver_replace_1",
		versionNumber: 1,
		body: "旧版本的正文内容",
	});
	await seedVersionRow(store, older);
	await registerPending(store, older);
	assert.equal((await pushDocumentVectors(store, fake, older)).status, "READY");
	const oldVectorId = await semantic.semanticVectorId("doc_replace", "ver_replace_1", 0);
	assert.ok(fake.index.vectors.has(oldVectorId));

	const newer = documentVersionPayload({
		documentId: "doc_replace",
		versionId: "ver_replace_2",
		versionNumber: 2,
		body: "新版本的正文内容",
	});
	await seedObjectR2(store, newer);
	await replica.ingestResearchReplicaRecord(
		store,
		await envelopeFor(newer.payload),
		null,
		"2026-09-28T01:00:00.000Z",
	);

	// D1 invalidates first: the old vector still exists in Vectorize, yet the
	// query face must already refuse to serve it.
	const superseded = await stateRow(store, "doc_replace", "ver_replace_1");
	assert.equal(superseded.retired_at, "2026-09-28T01:00:00.000Z");
	assert.equal(superseded.last_error_code, semantic.SEMANTIC_SUPERSEDED_CODE);
	assert.ok(
		fake.index.vectors.has(oldVectorId),
		"the stale vector may still be present before any reclaim",
	);
	const duringWindow = await search(store, fake, "正文内容");
	assert.equal(
		duringWindow.matches.some((match) => match.version_id === "ver_replace_1"),
		false,
		"a superseded version is never served, even while its vectors exist",
	);

	// The new version is completed by the local pipeline and is the only hit.
	assert.equal((await pushDocumentVectors(store, fake, newer)).status, "READY");
	const afterIndex = await search(store, fake, "正文内容");
	assert.deepEqual(
		afterIndex.matches.map((match) => match.version_id),
		["ver_replace_2"],
	);
});

test("a READY row that is no longer the current version is filtered at query time", async () => {
	const store = storage();
	const fake = fakes();
	const first = documentVersionPayload({
		documentId: "doc_audit",
		versionId: "ver_audit_1",
		versionNumber: 1,
		body: "审计用的第一版正文",
	});
	const second = documentVersionPayload({
		documentId: "doc_audit",
		versionId: "ver_audit_2",
		versionNumber: 2,
		body: "审计用的第二版正文",
	});
	await seedVersionRow(store, first);
	await registerPending(store, first);
	assert.equal((await pushDocumentVectors(store, fake, first)).status, "READY");
	// An out-of-order backfill: version 2's row arrives with no ingest-time
	// supersede visible to version 1's already-READY row (the supersede only
	// fires for rows registered in the same ingest batch).
	await seedVersionRow(store, second, { updatedAt: "2026-09-28T01:00:00.000Z" });
	await registerPending(store, second, "2026-09-28T01:00:00.000Z");
	const stale = await search(store, fake, "审计用的正文");
	assert.deepEqual(
		stale.matches.map((match) => match.version_id),
		[],
		"a READY row whose version is no longer current is never served",
	);
	// The current version is completed by the local pipeline and becomes the hit.
	assert.equal((await pushDocumentVectors(store, fake, second)).status, "READY");
	const result = await search(store, fake, "审计用的正文");
	assert.deepEqual(
		result.matches.map((match) => match.version_id),
		["ver_audit_2"],
	);
});

test("falling back to an earlier version: the local push revives the retired-but-current row", async () => {
	const store = storage();
	const fake = fakes();
	const first = documentVersionPayload({
		documentId: "doc_fallback",
		versionId: "ver_fallback_1",
		versionNumber: 1,
		body: "回退后应可检索的第一版正文",
	});
	const second = documentVersionPayload({
		documentId: "doc_fallback",
		versionId: "ver_fallback_2",
		versionNumber: 2,
		body: "回退后应不可检索的第二版正文",
	});
	await seedVersionRow(store, first);
	await registerPending(store, first);
	await seedVersionRow(store, second, { updatedAt: "2026-09-28T01:00:00.000Z" });
	await registerPending(store, second, "2026-09-28T01:00:00.000Z");
	assert.equal((await pushDocumentVectors(store, fake, second)).status, "READY");
	assert.ok((await stateRow(store, "doc_fallback", "ver_fallback_1")).retired_at);

	// The newest version itself stops being servable (a REVISION of that version
	// record).  The previous version is servable again; its state row is retired,
	// and the local push is what brings it back.
	const latest = JSON.parse(
		(
			await store.db
				.prepare(
					"SELECT payload_json FROM research_records WHERE record_type='document_version' AND record_key='ver_fallback_2'",
				)
				.first()
		).payload_json,
	);
	latest.version.revision_kind = "WITHDRAWAL";
	await store.db
		.prepare(
			"UPDATE research_records SET payload_json=? WHERE record_type='document_version' AND record_key='ver_fallback_2'",
		)
		.bind(JSON.stringify(latest))
		.run();

	const revived = await pushDocumentVectors(store, fake, first);
	assert.equal(revived.status, "READY", "a retired-but-current-again row accepts the local push");
	const row = await stateRow(store, "doc_fallback", "ver_fallback_1");
	assert.equal(row.state, "READY");
	assert.equal(row.retired_at, null);
	const result = await search(store, fake, "回退后应可检索");
	assert.deepEqual(
		result.matches.map((match) => match.version_id),
		["ver_fallback_1"],
	);
});

/* ---------------------------------------------------------------- */
/* Large-set keyset pagination of the queue                         */
/* ---------------------------------------------------------------- */

test("10768+ synthetic set: keyset pages of the pending queue reach the stable tail entry", async () => {
	const store = storage();
	const fake = fakes();
	const total = 10_768;
	const tailDocument = "doc_zz_tail_10768";
	const tailVersion = "ver_zz_tail_10768";
	const tailBody = "位于集合尾部的合成条目正文，必须仍能被队列分页覆盖";
	const tailBytes = encoder.encode(tailBody);
	const tailHash = sha256HexOf(tailBytes);
	// Bulk rows share one dummy hash: only queue pagination is under test.
	await store.db
		.prepare(
			`INSERT INTO research_records (record_type, record_key, message_id, visibility, schema_version, payload_json, generated_at, updated_at)
			 SELECT 'document_version', 'ver_' || printf('%06d', n), 'outbound_bulk_' || printf('%06d', n), 'PUBLIC', 'collector-outbound-v4',
			   json_object('document', json_object('document_id', 'doc_' || printf('%06d', n), 'title', '合成条目 ' || n, 'visibility', 'PUBLIC', 'source_kind', 'RSS'),
			               'version', json_object('version_id', 'ver_' || printf('%06d', n), 'document_id', 'doc_' || printf('%06d', n), 'version_number', 1, 'content_sha256', ?, 'media_type', 'text/plain', 'revision_kind', 'ORIGINAL', 'published_at', '2026-09-20T00:00:00+00:00'),
			               'attachments', json_array()),
			   '2026-09-20T00:00:00Z', '2026-09-20T00:00:00Z'
			 FROM (WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?) SELECT n FROM seq)`,
		)
		.bind("f".repeat(64), total)
		.run();
	// Register the bulk rows into the state table (the ingest-time registration
	// these rows would have received); the tail row is registered through the
	// real ingest statements below.
	await store.db
		.prepare(
			`INSERT INTO research_semantic_index_state (document_id, version_id, visibility, state, content_sha256, model_id, title_only, truncated, expected_chunks, confirmed_chunks, attempts, last_error_code, retired_at, vector_deleted_at, registered_at, updated_at)
			 SELECT json_extract(research_records.payload_json, '$.document.document_id'), research_records.record_key, 'PUBLIC', 'PENDING', NULL, ?, 0, 0, 0, 0, 0, NULL, NULL, NULL, ?, ?
			 FROM research_records
			 WHERE research_records.record_type='document_version' AND research_records.visibility='PUBLIC'
			   AND json_extract(research_records.payload_json, '$.document.document_id') IS NOT NULL
			   AND NOT EXISTS (SELECT 1 FROM research_semantic_index_state existing WHERE existing.document_id=json_extract(research_records.payload_json, '$.document.document_id') AND existing.version_id=research_records.record_key)`,
		)
		.bind(semantic.SEMANTIC_MODEL_ID, NOW, NOW)
		.run();
	const tail = documentVersionPayload({
		documentId: tailDocument,
		versionId: tailVersion,
		title: "尾部合成条目",
		body: tailBody,
	});
	assert.equal(tail.hash, tailHash);
	await seedVersionRow(store, tail);
	await registerPending(store, tail);

	// Walk the whole queue with bounded pages; the stable (state, document,
	// version) keyset must reach the lexicographically last entry.
	let pages = 0;
	let seen = 0;
	let tailSeen = false;
	let cursor = null;
	for (;;) {
		const page = await semantic.listPendingSemanticVersions(store, {
			limit: 500,
			state: "PENDING",
			after: cursor,
		});
		pages += 1;
		seen += page.items.length;
		if (page.items.some((item) => item.version_id === tailVersion)) tailSeen = true;
		assert.ok(pages < 100, "queue pagination must converge with bounded pages");
		if (!page.next) break;
		cursor = page.next;
	}
	assert.equal(seen, total + 1, "every registered version is reachable through the queue");
	assert.ok(pages >= 20, "the 10k set really needed many bounded pages");
	assert.ok(tailSeen, "the lexicographically last version id must be listed");

	// The tail entry is fully completable and retrievable on its own.
	assert.equal((await pushDocumentVectors(store, fake, tail)).status, "READY");
	const result = await search(store, fake, tailBody, 3);
	assert.equal(result.matches.length, 1);
	assert.equal(result.matches[0].document_id, tailDocument);
	assert.equal(result.matches[0].version_id, tailVersion);
});

/* ---------------------------------------------------------------- */
/* Query face                                                       */
/* ---------------------------------------------------------------- */

async function searchableStore(fake) {
	const store = storage();
	const built = documentVersionPayload({
		documentId: "doc_search",
		versionId: "ver_search",
		title: "合成检索标题",
		body: "这是一段关于合成材料的行业观察正文，包含多个句子。第二句用于检索。",
	});
	await seedVersionRow(store, built);
	await registerPending(store, built);
	assert.equal((await pushDocumentVectors(store, fake, built)).status, "READY");
	return store;
}

test("search re-validates each hit and returns the frozen contract shape", async () => {
	const fake = fakes();
	const store = await searchableStore(fake);
	const result = await search(store, fake, "合成材料 行业观察");
	assert.deepEqual(Object.keys(result).sort(), ["index_status", "matches"]);
	assert.equal(result.index_status, "READY");
	assert.equal(result.matches.length, 1);
	assert.deepEqual(Object.keys(result.matches[0]).sort(), [
		"document_id",
		"published_at",
		"score",
		"snippet",
		"source_kind",
		"title",
		"version_id",
	]);
	assert.equal(result.matches[0].document_id, "doc_search");
	assert.equal(result.matches[0].version_id, "ver_search");
	assert.equal(result.matches[0].title, "合成检索标题");
	assert.equal(result.matches[0].source_kind, "RSS");
	assert.equal(result.matches[0].published_at, "2026-09-20T00:00:00+00:00");
	assert.ok(result.matches[0].snippet.length <= semantic.SEMANTIC_SNIPPET_CHARS + 1);
	assert.ok(result.matches[0].snippet.length > 0);
	const serialized = JSON.stringify(result);
	for (const forbidden of [
		"attachment_locator",
		"canonical_locator",
		"origin_locator",
		"object_key",
		"content_sha256",
		"source_identity_key",
		"research-objects",
	]) {
		assert.equal(serialized.includes(forbidden), false, forbidden);
	}
});

test("search drops candidates that D1 no longer confirms (stale vector, retired row, other model)", async () => {
	const fake = fakes();
	const store = await searchableStore(fake);
	const vectorId = await semantic.semanticVectorId("doc_search", "ver_search", 0);
	const entry = fake.index.vectors.get(vectorId);
	// A vector for a document with no state row at all.
	fake.index.vectors.set(`rsv1_${"1".repeat(32)}`, {
		values: entry.values,
		metadata: { ...entry.metadata, document_id: "doc_unknown" },
	});
	// A vector whose metadata carries a different model.
	fake.index.vectors.set(`rsv1_${"2".repeat(32)}`, {
		values: entry.values,
		metadata: { ...entry.metadata, model_id: "@cf/baai/bge-small-en-v1.5" },
	});
	const filtered = await search(store, fake, "合成材料 行业观察");
	assert.deepEqual(
		filtered.matches.map((match) => match.document_id),
		["doc_search"],
		"unconfirmed candidates are filtered, not returned",
	);

	// Retiring the row in D1 (which happens before any vector delete) hides the
	// hit even though Vectorize still returns it.
	await store.db
		.prepare(
			"UPDATE research_semantic_index_state SET state='FAILED', retired_at=?, last_error_code=? WHERE document_id='doc_search'",
		)
		.bind(NOW, semantic.SEMANTIC_SUPERSEDED_CODE)
		.run();
	const retired = await search(store, fake, "合成材料 行业观察");
	assert.deepEqual(retired.matches, []);
	assert.equal(retired.index_status, "PARTIAL", "no active READY row left");
});

test("search deduplicates per document and honours the limit", async () => {
	const fake = fakes();
	const store = storage();
	let body = "";
	for (let index = 0; index < 120; index += 1) {
		body += `第${index}段合成正文，讨论同一主题的行业观察与材料进展。`;
	}
	const built = documentVersionPayload({ documentId: "doc_multi", versionId: "ver_multi", body });
	await seedVersionRow(store, built);
	await registerPending(store, built);
	assert.equal((await pushDocumentVectors(store, fake, built)).status, "READY");
	assert.ok((await stateRow(store, "doc_multi", "ver_multi")).expected_chunks >= 2);
	const all = await search(store, fake, "行业观察 材料进展", 10);
	assert.equal(all.matches.length, 1, "chunks of one document collapse into one match");
	const limited = await search(store, fake, "行业观察 材料进展", 1);
	assert.equal(limited.matches.length, 1);
});

test("index_status is PARTIAL while work is outstanding and READY once drained", async () => {
	const fake = fakes();
	const store = storage();
	const empty = await search(store, fake, "任意查询");
	assert.deepEqual(empty.matches, []);
	assert.equal(
		empty.index_status,
		"PARTIAL",
		"an unbuilt index is PARTIAL, never a silent READY",
	);

	const built = documentVersionPayload({ documentId: "doc_status", versionId: "ver_status" });
	await seedVersionRow(store, built);
	await registerPending(store, built);
	assert.equal((await search(store, fake, "任意查询")).index_status, "PARTIAL");
	assert.equal((await pushDocumentVectors(store, fake, built)).status, "READY");
	assert.equal((await search(store, fake, "任意查询")).index_status, "READY");
});

test("query and limit bounds are enforced and unusable input is rejected", async () => {
	const fake = fakes();
	const store = await searchableStore(fake);
	for (const query of ["", "   ", "x".repeat(semantic.SEMANTIC_QUERY_MAX_QUERY_CHARS + 1)]) {
		await assert.rejects(
			() => semantic.searchPublicDocumentsSemantic(store, fake.deps, { query }),
			(error) => error?.error_code === "STORE_UNAVAILABLE" && error?.retryable === false,
		);
	}
	for (const limit of [0, 21, 1.5]) {
		await assert.rejects(
			() =>
				semantic.searchPublicDocumentsSemantic(store, fake.deps, { query: "合成", limit }),
			(error) => error?.error_code === "STORE_UNAVAILABLE",
		);
	}
	const ok = await search(store, fake, "  合成材料  ", 20);
	assert.equal(ok.matches.length, 1, "a trimmed query within bounds is accepted");
});

test("index outages surface as STORE_UNAVAILABLE, never as an empty result", async () => {
	const fake = fakes();
	const store = await searchableStore(fake);
	fake.ai.fail = true;
	await assert.rejects(
		() => search(store, fake, "合成材料"),
		(error) => error?.error_code === "STORE_UNAVAILABLE" && error?.retryable === true,
	);
	fake.ai.fail = false;
	fake.index.queryFail = true;
	await assert.rejects(
		() => search(store, fake, "合成材料"),
		(error) => error?.error_code === "STORE_UNAVAILABLE" && error?.retryable === true,
	);
	fake.index.queryFail = false;
	// A storage outage must also be explicit rather than looking like no hits.
	await assert.rejects(
		() =>
			semantic.searchPublicDocumentsSemantic(
				{
					db: {
						prepare: () => {
							throw new Error("synthetic d1 outage");
						},
					},
					objects: store.objects,
				},
				fake.deps,
				{ query: "合成材料" },
			),
		(error) => error?.error_code === "STORE_UNAVAILABLE",
	);
});

test("a wrong embedding dimension aborts the query loudly instead of serving mismatches", async () => {
	const store = storage();
	const fake = fakes({ dims: 768 });
	const built = documentVersionPayload({ documentId: "doc_dims", versionId: "ver_dims" });
	await seedVersionRow(store, built);
	await registerPending(store, built);
	// The query embedding must match the index dimensionality exactly: a
	// mismatched provider answer aborts the search, it never silently serves.
	await assert.rejects(
		() => search(store, fake, "合成"),
		(error) => error?.error_code === "STORE_UNAVAILABLE" && error?.retryable === false,
	);
	assert.equal(fake.index.vectors.size, 0, "no vector may be written for a mismatched model");
	const probe = await semantic.probeSemanticIndex(fake.deps);
	assert.equal(probe.embedding_dimensions, 768);
	assert.equal(probe.embedding_dimensions_match, false);
	assert.equal(probe.index_dimensions_match, true);
});

test("search over-fetches inside the service limits and never fetches vector values", async () => {
	const fake = fakes();
	const store = await searchableStore(fake);
	fake.index.queryOptions.length = 0;
	await search(store, fake, "合成材料", semantic.SEMANTIC_QUERY_MAX_LIMIT);
	assert.equal(fake.index.queryOptions.length, 1);
	const [options] = fake.index.queryOptions;
	assert.ok(
		options.topK >= semantic.SEMANTIC_QUERY_MAX_LIMIT,
		"over-fetch must exceed the page size",
	);
	assert.ok(
		options.topK <= semantic.SEMANTIC_QUERY_OVERFETCH_MAX,
		"the over-fetch cap must stay inside the Vectorize topK bound",
	);
	assert.equal(semantic.SEMANTIC_QUERY_OVERFETCH_MAX <= 50, true);
	assert.equal(options.returnMetadata, semantic.SEMANTIC_METADATA_RETRIEVAL);
	assert.equal(options.returnValues, false, "vector values are never needed for the PUBLIC face");
	// The upsert side also stays inside the per-call vector bound.
	for (const call of fake.index.upsertCalls > 0 ? [true] : []) assert.ok(call);
	assert.equal(semantic.SEMANTIC_EMBED_BATCH_LIMIT <= 100, true);
	assert.ok(semantic.SEMANTIC_MAX_CHUNKS <= semantic.SEMANTIC_EMBED_BATCH_LIMIT);
});

test("probe reports the real embedding dimensions and the index configuration", async () => {
	const fake = fakes();
	const probe = await semantic.probeSemanticIndex(fake.deps);
	assert.equal(fake.ai.models[0], semantic.SEMANTIC_MODEL_ID);
	assert.equal(probe.model_id, semantic.SEMANTIC_MODEL_ID);
	assert.equal(probe.embedding_dimensions, semantic.SEMANTIC_VECTOR_DIMENSIONS);
	assert.equal(probe.embedding_dimensions_match, true);
	assert.equal(probe.index_dimensions, semantic.SEMANTIC_VECTOR_DIMENSIONS);
	assert.equal(probe.index_metric, "cosine");
	assert.equal(probe.index_metric_source, "configuration_constant");
	assert.equal(probe.index_name, semantic.SEMANTIC_INDEX_NAME);
});

/* ---------------------------------------------------------------- */
/* Read-plane and MCP wiring                                        */
/* ---------------------------------------------------------------- */

test("the read adapter serves semantic search only on the PUBLIC visibility", async () => {
	const fake = fakes();
	const store = await searchableStore(fake);
	const publicAdapter = new remote.CollectorResearchRemoteAdapter(store, {
		visibility: "PUBLIC",
	});
	assert.equal(
		(await publicAdapter.searchDocumentsSemantic("合成材料", { limit: 3, deps: fake.deps }))
			.matches.length,
		1,
	);
	const privateAdapter = new remote.CollectorResearchRemoteAdapter(store, {
		visibility: "PRIVATE",
	});
	await assert.rejects(
		() => privateAdapter.searchDocumentsSemantic("合成材料", { limit: 3, deps: fake.deps }),
		(error) => error?.error_code === "UNSUPPORTED_OPERATION",
	);
});

test("MCP exposes search_documents_semantic with the frozen schema and PUBLIC-only output", async () => {
	const fake = fakes();
	const store = await searchableStore(fake);
	const env = {
		RESEARCH_REPLICA: store.db,
		RESEARCH_OBJECTS: store.objects,
		AI: fake.ai,
		RESEARCH_PUBLIC_INDEX: fake.index,
	};
	const server = createServer(env, "SKIPPED_UNAUTHORIZED", new Set(), null, null);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "semantic-index-test", version: "0.0.0" });
	await Promise.all([server.server.connect(serverTransport), client.connect(clientTransport)]);
	try {
		const listed = await client.listTools();
		const tool = listed.tools.find((entry) => entry.name === "search_documents_semantic");
		assert.ok(tool, "search_documents_semantic must be published");
		assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ["limit", "query"]);
		assert.equal(JSON.stringify(tool.inputSchema).includes("visibility"), false);
		assert.equal(JSON.stringify(tool.inputSchema).includes("source_id"), false);
		assert.equal(tool.inputSchema.properties.limit.minimum, 1);
		assert.equal(tool.inputSchema.properties.limit.maximum, semantic.SEMANTIC_QUERY_MAX_LIMIT);
		assert.equal(
			tool.inputSchema.properties.query.maxLength,
			semantic.SEMANTIC_QUERY_MAX_QUERY_CHARS,
		);
		for (const entry of listed.tools) {
			assert.equal(/private/i.test(entry.name), false, entry.name);
		}

		const hit = await client.callTool({
			name: "search_documents_semantic",
			arguments: { query: "合成材料 行业观察", limit: 3 },
		});
		assert.equal(hit.isError ?? false, false);
		const payload = JSON.parse(hit.content[0].text);
		assert.deepEqual(Object.keys(payload).sort(), ["index_status", "matches"]);
		assert.equal(payload.index_status, "READY");
		assert.equal(payload.matches[0].document_id, "doc_search");
		assert.ok(fake.ai.calls >= 1, "the query embedding is the only cloud AI spend");

		for (const [label, args, rejects] of [
			["blank query", { query: "   " }, true],
			[
				"oversized query",
				{ query: "x".repeat(semantic.SEMANTIC_QUERY_MAX_QUERY_CHARS + 1) },
				true,
			],
			["oversized limit", { query: "合成", limit: 21 }, true],
			["unknown key", { query: "合成", visibility: "PRIVATE" }, false],
		]) {
			const callsBefore = fake.ai.calls;
			const answer = await client.callTool({
				name: "search_documents_semantic",
				arguments: args,
			});
			if (rejects) {
				assert.equal(answer.isError, true, label);
				assert.match(answer.content[0].text, /validation/i, label);
				assert.equal(fake.ai.calls, callsBefore, `${label} must not reach the index`);
			} else {
				// Extra keys are stripped by the published schema: the call runs as a
				// normal PUBLIC search and can never widen the visibility.
				assert.equal(answer.isError ?? false, false, label);
			}
		}
	} finally {
		await server.close();
	}
});

test("missing AI/Vectorize bindings are an explicit configuration error, not an empty result", async () => {
	const fake = fakes();
	const store = await searchableStore(fake);
	const server = createServer(
		{ RESEARCH_REPLICA: store.db, RESEARCH_OBJECTS: store.objects },
		"SKIPPED_UNAUTHORIZED",
		new Set(),
		null,
		null,
	);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "semantic-index-binding-test", version: "0.0.0" });
	await Promise.all([server.server.connect(serverTransport), client.connect(clientTransport)]);
	try {
		const callsBefore = fake.ai.calls;
		const result = await client.callTool({
			name: "search_documents_semantic",
			arguments: { query: "合成材料" },
		});
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /STORE_UNAVAILABLE/);
		assert.doesNotMatch(result.content[0].text, /matches/);
		assert.equal(fake.ai.calls, callsBefore, "the query never reaches the embedding provider");
	} finally {
		await server.close();
	}
});

test("internal run/status/probe endpoints are token-gated operations transport", async () => {
	const fake = fakes();
	const store = await searchableStore(fake);
	const env = {
		RESEARCH_REPLICA: store.db,
		RESEARCH_OBJECTS: store.objects,
		RESEARCH_REPLICA_INGEST_TOKEN: "internal-token",
		AI: fake.ai,
		RESEARCH_PUBLIC_INDEX: fake.index,
	};
	const unauthorized = await worker.fetch(
		new Request("https://worker.example/internal/research-semantic-index/status"),
		env,
		{},
	);
	assert.equal(unauthorized.status, 401);
	assert.equal((await unauthorized.json()).error_code, "FILTERED");

	const status = await worker.fetch(
		new Request("https://worker.example/internal/research-semantic-index/status", {
			headers: { Authorization: "Bearer internal-token" },
		}),
		env,
		{},
	);
	assert.equal(status.status, 200);
	const coverage = await status.json();
	assert.equal(coverage.model_id, semantic.SEMANTIC_MODEL_ID);
	assert.equal(coverage.index_status, "READY");
	assert.equal(coverage.indexed_chunks > 0, true);
	assert.equal(
		JSON.stringify(coverage).includes("doc_search"),
		false,
		"counters never list document ids",
	);

	const aiCallsBefore = fake.ai.calls;
	const run = await worker.fetch(
		new Request("https://worker.example/internal/research-semantic-index/run", {
			method: "POST",
			headers: { Authorization: "Bearer internal-token", "Content-Type": "application/json" },
			body: JSON.stringify({ max_docs: 1 }),
		}),
		env,
		{},
	);
	assert.equal(run.status, 200);
	const runBody = await run.json();
	// G2 (quota redesign 2026-10-02): the cloud batch run is physically sealed.
	assert.equal(runBody.status, "BATCH_DISABLED");
	assert.match(runBody.reason, /local RTX 5080 GPU pipeline/);
	assert.match(runBody.push_path, /ingest-vectors/);
	assert.equal(runBody.workers_ai_calls, 0);
	assert.equal(fake.ai.calls, aiCallsBefore, "the sealed route never spends a neuron");
	assert.equal((await stateRows(store)).some((row) => row.state === "READY"), true, "the queue is untouched by the sealed route");

	const probe = await worker.fetch(
		new Request("https://worker.example/internal/research-semantic-index/probe", {
			method: "POST",
			headers: { Authorization: "Bearer internal-token" },
		}),
		env,
		{},
	);
	assert.equal(probe.status, 200);
	assert.equal((await probe.json()).embedding_dimensions_match, true);

	// A missing binding reports the safe configuration error (non-retryable,
	// so 400 rather than a 503 "retry later").
	const probeWithoutBindings = await worker.fetch(
		new Request("https://worker.example/internal/research-semantic-index/probe", {
			method: "POST",
			headers: { Authorization: "Bearer internal-token" },
		}),
		{
			RESEARCH_REPLICA: store.db,
			RESEARCH_OBJECTS: store.objects,
			RESEARCH_REPLICA_INGEST_TOKEN: "internal-token",
		},
		{},
	);
	assert.equal(probeWithoutBindings.status, 400);
	assert.equal((await probeWithoutBindings.json()).error_code, "STORE_UNAVAILABLE");
});

test("the ingest route keeps its frozen envelope; cloud embedding is sealed and the queue waits for the local GPU", async () => {
	const fake = fakes();
	const store = storage();
	const built = documentVersionPayload({
		documentId: "doc_ingest_hook",
		versionId: "ver_ingest_hook",
		body: "回执先返回，向量由本地 GPU 管线推送",
	});
	await seedObjectR2(store, built);
	const record = await envelopeFor(built.payload);
	const background = [];
	const ctx = { waitUntil: (promise) => background.push(promise) };
	const response = await worker.fetch(
		new Request("https://worker.example/internal/research-replica/v2/ingest", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer internal-token" },
			body: JSON.stringify({ record }),
		}),
		{
			RESEARCH_REPLICA: store.db,
			RESEARCH_OBJECTS: store.objects,
			RESEARCH_REPLICA_INGEST_TOKEN: "internal-token",
			AI: fake.ai,
			RESEARCH_PUBLIC_INDEX: fake.index,
		},
		ctx,
	);
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.deepEqual(Object.keys(body).sort(), [
		"content_sha256",
		"message_id",
		"record_type",
		"status",
	]);
	assert.equal(body.status, "APPLIED");
	// G2: no cloud embedding is scheduled any more.  Background work is limited
	// to the harmless usage-observation log.
	await Promise.all(background);
	assert.equal(fake.ai.calls, 0, "no Workers AI call may be made by the ingest route");
	const row = await stateRow(store, "doc_ingest_hook", "ver_ingest_hook");
	assert.equal(row.state, "PENDING", "the row waits for the local GPU pipeline");

	// The local pipeline completes the row without any further cloud AI.
	assert.equal((await pushDocumentVectors({ db: store.db, objects: store.objects }, fake, built)).status, "READY");
	assert.equal((await stateRow(store, "doc_ingest_hook", "ver_ingest_hook")).state, "READY");

	// Without a background context the receipt is still served identically.
	const second = documentVersionPayload({
		documentId: "doc_ingest_plain",
		versionId: "ver_ingest_plain",
		body: "没有后台上下文时回执不变",
	});
	await seedObjectR2(store, second);
	const plain = await worker.fetch(
		new Request("https://worker.example/internal/research-replica/v2/ingest", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer internal-token" },
			body: JSON.stringify({ record: await envelopeFor(second.payload) }),
		}),
		{
			RESEARCH_REPLICA: store.db,
			RESEARCH_OBJECTS: store.objects,
			RESEARCH_REPLICA_INGEST_TOKEN: "internal-token",
			AI: fake.ai,
			RESEARCH_PUBLIC_INDEX: fake.index,
		},
		{},
	);
	assert.equal(plain.status, 200);
	assert.equal((await stateRow(store, "doc_ingest_plain", "ver_ingest_plain")).state, "PENDING");
});

test("precomputed vector ingest: gated, hash-checked, dense-ordinal, consistency probe", async () => {
	const fake = fakes();
	const store = await searchableStore(fake);
	const env = {
		RESEARCH_REPLICA: store.db,
		RESEARCH_OBJECTS: store.objects,
		RESEARCH_REPLICA_INGEST_TOKEN: "internal-token",
		AI: fake.ai,
		RESEARCH_PUBLIC_INDEX: fake.index,
	};
	const body = "这是一段关于合成材料的行业观察正文，包含多个句子。第二句用于检索。";
	const contentSha = sha256HexOf(encoder.encode(body));
	const vector = (ordinal) => ({ ordinal, values: Array.from({ length: 1024 }, (_, i) => 0.001 * (ordinal + i + 1)) });

	const unauthorized = await worker.fetch(
		new Request("https://worker.example/internal/research-semantic-index/ingest-vectors", {
			method: "POST",
			body: JSON.stringify({}),
		}),
		env,
		{},
	);
	assert.equal(unauthorized.status, 401);

	const badDims = await worker.fetch(
		new Request("https://worker.example/internal/research-semantic-index/ingest-vectors", {
			method: "POST",
			headers: { Authorization: "Bearer internal-token", "Content-Type": "application/json" },
			body: JSON.stringify({
				document_id: "doc_search",
				version_id: "ver_search",
				content_sha256: contentSha,
				vectors: [{ ordinal: 0, values: [0.1, 0.2] }],
			}),
		}),
		env,
		{},
	);
	assert.equal(badDims.status, 200);
	assert.equal((await badDims.json()).status, "REJECTED");

	const gap = await worker.fetch(
		new Request("https://worker.example/internal/research-semantic-index/ingest-vectors", {
			method: "POST",
			headers: { Authorization: "Bearer internal-token", "Content-Type": "application/json" },
			body: JSON.stringify({
				document_id: "doc_search",
				version_id: "ver_search",
				content_sha256: contentSha,
				vectors: [vector(0), vector(2)],
			}),
		}),
		env,
		{},
	);
	assert.equal((await gap.json()).status, "REJECTED", "ordinals must be dense");

	const firstVectorId = await semantic.semanticVectorId("doc_search", "ver_search", 0);
	const storedFirstVector = fake.index.vectors.get(firstVectorId);
	assert.ok(storedFirstVector, "fixture must already contain the local vector chunk 0");
	const consistency = await worker.fetch(
		new Request("https://worker.example/internal/research-semantic-index/ingest-vectors", {
			method: "POST",
			headers: { Authorization: "Bearer internal-token", "Content-Type": "application/json" },
			body: JSON.stringify({
				document_id: "doc_search",
				version_id: "ver_search",
				content_sha256: contentSha,
				vectors: [{ ordinal: 0, values: storedFirstVector.values }],
				consistency_check: true,
			}),
		}),
		env,
		{},
	);
	const probeBody = await consistency.json();
	assert.equal(probeBody.status, "CONSISTENCY");
	assert.equal(probeBody.matches, 1, "the stored cloud vector is found");
	assert.ok(probeBody.score > 0.9, `cosine against the stored vector: ${probeBody.score}`);

	const upsertsBefore = fake.index.upsertCalls;
	const ok = await worker.fetch(
		new Request("https://worker.example/internal/research-semantic-index/ingest-vectors", {
			method: "POST",
			headers: { Authorization: "Bearer internal-token", "Content-Type": "application/json" },
			body: JSON.stringify({
				document_id: "doc_search",
				version_id: "ver_search",
				content_sha256: contentSha,
				vectors: [vector(0), vector(1)],
			}),
		}),
		env,
		{},
	);
	assert.equal(ok.status, 200);
	const okBody = await ok.json();
	assert.equal(okBody.status, "READY");
	assert.equal(okBody.upserted, 2);
	assert.equal(fake.index.upsertCalls, upsertsBefore + 1);
	const row = await store.db
		.prepare("SELECT state, expected_chunks, confirmed_chunks FROM research_semantic_index_state WHERE document_id='doc_search' AND version_id='ver_search'")
		.first();
	assert.equal(row.state, "READY");
	assert.equal(row.expected_chunks, 2);
	assert.equal(row.confirmed_chunks, 2);

	const drifted = await worker.fetch(
		new Request("https://worker.example/internal/research-semantic-index/ingest-vectors", {
			method: "POST",
			headers: { Authorization: "Bearer internal-token", "Content-Type": "application/json" },
			body: JSON.stringify({
				document_id: "doc_search",
				version_id: "ver_search",
				content_sha256: "f".repeat(64),
				vectors: [vector(0)],
			}),
		}),
		env,
		{},
	);
	assert.equal((await drifted.json()).status, "REJECTED", "stale content must not attach");
});

