/**
 * PUBLIC document data retention (owner ruling 2026-09-29):
 * PUBLIC replica documents are kept 90 days by their earliest version
 * ingested_at; source_id='E02-gelonghui-live' snapshots are legacy violations
 * and are all expired.
 *
 * The database half runs the REAL migration chain (0001-0013) on the
 * node:sqlite shim, so the retention tables' constraints, the keyset scan, the
 * reference-guard COUNT and the tombstone flip are proven against production
 * SQL.  R2/Vectorize are deterministic synthetic fakes with event recording,
 * so the ruled orchestration order (mark EXPIRED -> R2 -> D1 rows ->
 * deleteByIds -> PURGED) is asserted as an actual call sequence, not a
 * pattern match.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

const retention = await import("../src/research-retention.ts");
const semantic = await import("../src/research-semantic-index.ts");
const replica = await import("../src/research-replica.ts");
const outbound = await import("../src/research-outbound-v2.ts");
const remote = await import("../src/research-remote-adapter.ts");
const worker = (await import("../src/index.ts")).default;
const { createResearchWorkflowDb } = await import("./helpers/d1-sqlite-shim.mjs");

const encoder = new TextEncoder();
const NOW = "2026-09-29T00:00:00.000Z";
// 2026-09-29 minus 90 days.
const CUTOFF = "2026-07-01T00:00:00.000Z";
const OLD_INGESTED_AT = "2026-06-30T00:00:00+00:00";
const FRESH_INGESTED_AT = "2026-07-02T00:00:00+00:00";

function sha256HexOf(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

/* ---------------------------------------------------------------- */
/* Synthetic fakes (R2 with deletion recording, Vectorize, AI)      */
/* ---------------------------------------------------------------- */

function embedText(text, dims = 1024) {
	const vector = new Array(dims).fill(0);
	for (const char of [...text.normalize("NFC")]) vector[char.codePointAt(0) % dims] += 1;
	const norm = Math.hypot(...vector) || 1;
	return vector.map((value) => value / norm);
}

class FakeAi {
	constructor() {
		this.calls = 0;
	}

	async run(model, inputs) {
		this.calls += 1;
		const texts = Array.isArray(inputs.text) ? inputs.text : [inputs.text];
		return { shape: [texts.length, 1024], data: texts.map((text) => embedText(text)) };
	}
}

class FakeVectorize {
	constructor(events = null) {
		this.vectors = new Map();
		this.events = events;
	}

	async upsert(entries) {
		for (const entry of entries) {
			this.vectors.set(entry.id, { values: entry.values, metadata: entry.metadata });
		}
	}

	async deleteByIds(ids) {
		this.events?.push({ kind: "vectors_delete", ids: [...ids] });
		for (const id of ids) this.vectors.delete(id);
	}

	async describe() {
		return { dimensions: 1024, vectorCount: this.vectors.size };
	}

	async query(values, options = {}) {
		const cosine = (left, right) =>
			left.reduce((total, value, index) => total + value * right[index], 0);
		const matches = [...this.vectors.entries()]
			.map(([id, entry]) => ({ id, score: cosine(values, entry.values), metadata: entry.metadata }))
			.sort((left, right) => right.score - left.score || (left.id < right.id ? -1 : 1));
		return { matches: matches.slice(0, options.topK ?? 10), count: matches.length };
	}
}

class FakeR2 {
	constructor(events = null) {
		this.objects = new Map();
		this.events = events;
	}

	async put(key, body) {
		this.objects.set(key, typeof body === "string" ? encoder.encode(body) : new Uint8Array(body));
	}

	async get(key) {
		const bytes = this.objects.get(key);
		if (!bytes) return null;
		return {
			arrayBuffer: async () =>
				bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
		};
	}

	async delete(key) {
		this.events?.push({ kind: "r2_delete", key });
		this.objects.delete(key);
	}
}

/**
 * D1 recording wrapper: prepare().bind() returns a delegating facade that
 * logs every executed SQL (run/all/first) into the shared event list while
 * keeping `execBound` so `db.batch` keeps working through the shim.
 */
function recordingDb(db, events) {
	const record = (sql, fn) => async () => {
		events.push({ kind: "d1", sql });
		return fn();
	};
	return {
		prepare(sql) {
			const statement = db.prepare(sql);
			return {
				bind(...params) {
					const bound = statement.bind(...params);
					return {
						execBound: bound.execBound.bind(bound),
						run: record(sql, () => bound.run()),
						first: record(sql, () => bound.first()),
						all: record(sql, () => bound.all()),
					};
				},
				run: record(sql, () => statement.run()),
				first: record(sql, () => statement.first()),
				all: record(sql, () => statement.all()),
			};
		},
		batch(statements) {
			return db.batch(statements);
		},
	};
}

function storage({ events = null } = {}) {
	return {
		db: events ? recordingDb(createResearchWorkflowDb(), events) : createResearchWorkflowDb(),
		objects: new FakeR2(events),
	};
}

/* ---------------------------------------------------------------- */
/* Synthetic replica rows (frozen outbound-v4 key sets)             */
/* ---------------------------------------------------------------- */

function documentVersionPayload({
	documentId = "doc_synthetic_1",
	versionId = "ver_synthetic_1",
	versionNumber = 1,
	mediaType = "text/plain",
	body = "synthetic body",
	title = "Synthetic title",
	sourceId = "fixture-source-public",
	ingestedAt = FRESH_INGESTED_AT,
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
	return {
		document: {
			document_id: documentId,
			source_id: sourceId,
			source_identity_key: `identity-${documentId}`,
			canonical_locator: "lead://synthetic/item",
			origin_locator: "lead://synthetic/origin",
			first_seen_at: ingestedAt,
			title,
			source_kind: "RSS",
			visibility: "PUBLIC",
			historical_backfill: false,
		},
		version: {
			version_id: versionId,
			document_id: documentId,
			version_number: versionNumber,
			content_sha256: sha256HexOf(bodyBytes),
			byte_size: bodyBytes.byteLength,
			media_type: mediaType,
			ingested_at: ingestedAt,
			published_at: ingestedAt,
			event_time: null,
			source_updated_at: null,
			response_headers: {},
			revision_kind: "ORIGINAL",
			corrects_version_id: null,
			historical_backfill: false,
			readable: mediaType.startsWith("text/"),
		},
		attachments,
	};
}

/** A validated outbound-v4 envelope for one payload (exercises the C5 path). */
async function envelopeFor(payload, { generatedAt = NOW } = {}) {
	const record = {
		record_type: "document_version",
		message_id: "",
		schema_version: "collector-outbound-v4",
		policy_version: "collector-policy-v1",
		visibility: "PUBLIC",
		payload,
		generated_at: generatedAt,
	};
	record.message_id = await outbound.computeOutboundV2MessageId(record);
	return record;
}

/** Ingest through the real C5 chain: records, links, journal, ingest message. */
async function ingestDocument(store, payload, now = NOW) {
	const record = await envelopeFor(payload, { generatedAt: now });
	const result = await replica.ingestResearchReplicaRecord(store, record, null, now);
	assert.equal(result.status, "APPLIED");
	return record;
}

async function seedContentObject(store, bytes, messageId = "outbound_object_synthetic") {
	const hash = sha256HexOf(bytes);
	await store.objects.put(`research-objects/sha256/${hash}`, bytes);
	await store.db
		.prepare(
			"INSERT OR IGNORE INTO research_objects (content_sha256, message_id, visibility, media_type, byte_size, state, received_at) VALUES (?, ?, 'PUBLIC', 'text/plain', ?, 'READY', ?)",
		)
		.bind(hash, messageId, bytes.byteLength, NOW)
		.run();
	return hash;
}

/** Full synthetic lifecycle: ingest the version, seed its body object, index it. */
async function seedIndexedDocument(
	store,
	fake,
	options,
	{ index = true } = {},
) {
	const payload = documentVersionPayload(options);
	const record = await ingestDocument(store, payload);
	const bodyHash = await seedContentObject(store, encoder.encode(options.body ?? "synthetic body"));
	if (index) {
		// Local RTX 5080 pipeline in miniature (quota redesign 2026-10-02): chunk
		// locally with the shared composition rule and push through the REAL
		// precomputed-vector path.  No cloud embedding exists any more.
		const title = payload.document.title ?? "";
		const body = options.body ?? "synthetic body";
		const composed = title ? `${title}\n\n${body}` : body;
		const { chunks } = semantic.chunkSemanticDocument(composed);
		const outcome = await semantic.ingestPrecomputedVectors(
			store,
			{ index: fake.index },
			{
				document_id: payload.document.document_id,
				version_id: payload.version.version_id,
				content_sha256: bodyHash,
				vectors: chunks.map((chunk) => ({
					ordinal: chunk.ordinal,
					values: embedText(chunk.text),
				})),
			},
		);
		assert.equal(outcome.status, "READY");
	}
	return { payload, record, bodyHash };
}

function publicAdapter(store) {
	return new remote.CollectorResearchRemoteAdapter(store, { visibility: "PUBLIC" });
}

async function tableCount(store, table, where = "") {
	const row = await store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).first();
	return Number(row.n);
}

async function documentRowCount(store, documentId) {
	const row = await store.db
		.prepare(
			"SELECT COUNT(*) AS n FROM research_records WHERE record_type='document_version' AND json_extract(payload_json, '$.document.document_id')=?",
		)
		.bind(documentId)
		.first();
	return Number(row.n);
}

async function retentionRow(store, documentId) {
	return store.db
		.prepare("SELECT * FROM research_document_retention WHERE document_id=?")
		.bind(documentId)
		.first();
}

async function auditRows(store) {
	return (
		await store.db.prepare("SELECT * FROM research_retention_audit ORDER BY audit_id").all()
	).results;
}

/* ---------------------------------------------------------------- */
/* 1. Expiry judgment                                               */
/* ---------------------------------------------------------------- */

test("超期判定：90 天严格边界、强制超期源、坏时间 fail-safe", () => {
	assert.equal(retention.retentionCutoff(NOW), CUTOFF);
	// 过期：早于截止时刻一个可分辨的最小步长。
	assert.equal(
		retention.retentionExpiryReason("src-normal", "2026-06-30T23:59:59+00:00", CUTOFF),
		"AGE_90D",
	);
	// 边界时刻本身不删（严格小于）。
	assert.equal(
		retention.retentionExpiryReason("src-normal", "2026-07-01T00:00:00+00:00", CUTOFF),
		null,
	);
	assert.equal(
		retention.retentionExpiryReason("src-normal", "2026-07-02T00:00:00+00:00", CUTOFF),
		null,
	);
	// 坏时间戳永远不构成删除理由（除非命中强制超期源）。
	assert.equal(retention.retentionExpiryReason("src-normal", "not-a-timestamp", CUTOFF), null);
	assert.equal(retention.retentionExpiryReason("src-normal", null, CUTOFF), null);
	// E02-gelonghui-live 与年龄无关，全部超期。
	assert.equal(
		retention.retentionExpiryReason("E02-gelonghui-live", "2026-09-28T00:00:00+00:00", CUTOFF),
		"SOURCE_E02_GELONGHUI_LIVE",
	);
	assert.equal(
		retention.retentionExpiryReason("E02-gelonghui-live", null, CUTOFF),
		"SOURCE_E02_GELONGHUI_LIVE",
	);
});

test("扫描判定：超期文档入清单，新鲜文档不入，计数正确", async () => {
	const store = storage();
	await ingestDocument(store, documentVersionPayload({
		documentId: "doc_scan_old",
		versionId: "ver_scan_old",
		ingestedAt: OLD_INGESTED_AT,
	}));
	await ingestDocument(store, documentVersionPayload({
		documentId: "doc_scan_fresh",
		versionId: "ver_scan_fresh",
		ingestedAt: FRESH_INGESTED_AT,
	}));
	await ingestDocument(store, documentVersionPayload({
		documentId: "doc_scan_e02",
		versionId: "ver_scan_e02",
		sourceId: "E02-gelonghui-live",
		ingestedAt: FRESH_INGESTED_AT,
	}));
	const { candidates, scanned } = await retention.scanRetentionCandidates(store, NOW);
	assert.equal(scanned, 3);
	assert.deepEqual(
		candidates.map((candidate) => candidate.document_id).sort(),
		["doc_scan_e02", "doc_scan_old"],
	);
	const byId = new Map(candidates.map((candidate) => [candidate.document_id, candidate]));
	assert.equal(byId.get("doc_scan_old").reason, "AGE_90D");
	assert.equal(byId.get("doc_scan_e02").reason, "SOURCE_E02_GELONGHUI_LIVE");
	assert.equal(byId.get("doc_scan_old").version_count, 1);
});

/* ---------------------------------------------------------------- */
/* 2. EXPIRED invisibility on all three read faces                  */
/* ---------------------------------------------------------------- */

test("EXPIRED 对 search_documents / get_document / search_documents_semantic 不可见（标记后、清除前）", async () => {
	const fake = { ai: new FakeAi(), index: new FakeVectorize() };
	fake.deps = { ai: fake.ai, index: fake.index };
	const store = storage();
	const seeded = await seedIndexedDocument(store, fake, {
		documentId: "doc_hidden",
		versionId: "ver_hidden",
		ingestedAt: OLD_INGESTED_AT,
		body: "过期可见性合成正文",
		title: "过期可见性合成标题",
	});
	const adapter = publicAdapter(store);
	// 前提：未标记时三个面都可见。
	assert.equal((await adapter.searchDocuments("")).length, 1);
	assert.equal((await adapter.searchDocuments("过期可见性合成标题")).length, 1);
	await adapter.getDocument("doc_hidden");
	const before = await semantic.searchPublicDocumentsSemantic(store, fake.deps, {
		query: "过期可见性合成正文",
		limit: 5,
	});
	assert.equal(before.matches.length, 1);

	// index=null 的运行只标记不清除：EXPIRED 窗口。
	const report = await retention.runRetentionSweep(store, { index: null }, {
		trigger: "manual",
		now: NOW,
	});
	assert.equal(report.marked_expired, 1);
	assert.equal(report.purge_skipped, "VECTORIZE_BINDING_UNAVAILABLE");
	assert.equal((await retentionRow(store, "doc_hidden")).status, "EXPIRED");

	assert.equal((await adapter.searchDocuments("")).length, 0);
	assert.equal((await adapter.searchDocuments("过期可见性合成标题")).length, 0);
	await assert.rejects(
		() => adapter.getDocument("doc_hidden"),
		(error) =>
			error instanceof outbound.ResearchBoundaryError && error.error_code === "NOT_FOUND",
	);
	// 向量还在（清除前），但语义面必须已不可见：D1 复核先于返回。
	assert.ok(fake.index.vectors.size > 0);
	const during = await semantic.searchPublicDocumentsSemantic(store, fake.deps, {
		query: "过期可见性合成正文",
		limit: 5,
	});
	assert.equal(during.matches.length, 0);

	// 数据行在 EXPIRED 窗口内原样保留，只是不可见。
	assert.equal(await documentRowCount(store, "doc_hidden"), 1);
	assert.ok(
		store.objects.objects.has(`research-objects/sha256/${seeded.bodyHash}`),
		"EXPIRED 窗口内 R2 对象尚未删除",
	);
});

test("EXPIRED 文档绝不接受本地向量推送（re-ingest 复活防护迁移到 precomputed 路径）", async () => {
	const fake = { ai: new FakeAi(), index: new FakeVectorize() };
	fake.deps = { ai: fake.ai, index: fake.index };
	const store = storage();
	const seeded = await seedIndexedDocument(store, fake, {
		documentId: "doc_reclaim",
		versionId: "ver_reclaim",
		ingestedAt: OLD_INGESTED_AT,
		body: "复活防护合成正文",
	});
	await retention.runRetentionSweep(store, { index: null }, { trigger: "manual", now: NOW });
	// 模拟 re-ingest 把状态行解退役（ingest upsert 的 ON CONFLICT 行为）。
	await store.db
		.prepare(
			"UPDATE research_semantic_index_state SET state='PENDING', retired_at=NULL, last_error_code=NULL WHERE document_id='doc_reclaim'",
		)
		.run();
	// EXPIRED 文档的推送被拒收：向量绝不重新附着，也绝不消耗任何 embedding。
	const outcome = await semantic.ingestPrecomputedVectors(
		store,
		{ index: fake.index },
		{
			document_id: "doc_reclaim",
			version_id: "ver_reclaim",
			content_sha256: seeded.bodyHash,
			vectors: [{ ordinal: 0, values: embedText("复活防护合成正文") }],
		},
	);
	assert.equal(outcome.status, "REJECTED");
	assert.match(outcome.reason, /EXPIRED by retention/);
	assert.equal(fake.ai.calls, 0, "EXPIRED 文档绝不消耗 embedding");
});

/* ---------------------------------------------------------------- */
/* 3. Purge orchestration call sequence                             */
/* ---------------------------------------------------------------- */

test("删除编排调用序列：标记退役 → R2 → D1 行删除 → deleteByIds 收尾 → PURGED", async () => {
	const events = [];
	const store = storage({ events });
	const fake = { ai: new FakeAi(), index: new FakeVectorize(events) };
	fake.deps = { ai: fake.ai, index: fake.index };
	const seeded = await seedIndexedDocument(store, fake, {
		documentId: "doc_seq",
		versionId: "ver_seq",
		ingestedAt: OLD_INGESTED_AT,
		body: "编排序列合成正文",
	});
	events.length = 0;
	const report = await retention.runRetentionSweep(store, fake.deps, {
		trigger: "manual",
		now: NOW,
	});
	assert.equal(report.purged_documents, 1);
	const find = (predicate) => events.findIndex(predicate);
	const retire = find(
		(event) =>
			event.kind === "d1" &&
			/UPDATE research_semantic_index_state SET state='FAILED', expected_chunks=0/.test(event.sql),
	);
	const r2Object = find(
		(event) => event.kind === "r2_delete" && event.key === `research-objects/sha256/${seeded.bodyHash}`,
	);
	const journal = find((event) => event.kind === "r2_delete" && event.key.includes("research-replica-journal/"));
	const links = find((event) => event.kind === "d1" && /DELETE FROM research_record_objects/.test(event.sql));
	const versions = find(
		(event) =>
			event.kind === "d1" &&
			/DELETE FROM research_records WHERE record_type='document_version'/.test(event.sql),
	);
	const state = find(
		(event) => event.kind === "d1" && /DELETE FROM research_semantic_index_state/.test(event.sql),
	);
	const vectors = find((event) => event.kind === "vectors_delete");
	const flip = find(
		(event) => event.kind === "d1" && /SET status='PURGED'/.test(event.sql),
	);
	for (const [name, index] of [
		["retire", retire],
		["r2Object", r2Object],
		["journal", journal],
		["links", links],
		["versions", versions],
		["state", state],
		["vectors", vectors],
		["flip", flip],
	]) {
		assert.notEqual(index, -1, `${name} step must have run`);
	}
	assert.ok(retire < r2Object, "D1 逻辑失效先于 R2 删除");
	assert.ok(r2Object < links, "R2 对象删除先于 D1 行删除");
	assert.ok(journal > -1 && journal < links, "journal 删除在 D1 行删除之前（同属 R2 段）");
	assert.ok(links < versions, "附件链接行先删，版本行后删");
	assert.ok(versions < state, "版本行先删，语义状态行后删");
	assert.ok(state < vectors, "deleteByIds 收尾");
	assert.ok(vectors < flip, "收尾之后才翻 PURGED 墓碑");
	// 向量 id 是确定性 id，且全部被提交删除。
	const tombstone = await retentionRow(store, "doc_seq");
	assert.equal(tombstone.status, "PURGED");
	assert.ok(tombstone.purged_at);
	const detail = JSON.parse(tombstone.purge_detail_json);
	assert.deepEqual(detail.versions, ["ver_seq"]);
	assert.deepEqual(detail.objects_deleted, [seeded.bodyHash]);
	assert.equal(detail.vectors_deleted, semantic.SEMANTIC_MAX_CHUNKS);
	const vectorEvent = events[vectors];
	assert.equal(vectorEvent.ids.length, semantic.SEMANTIC_MAX_CHUNKS);
	assert.equal(fake.index.vectors.size, 0);
	// 全部行清除。
	assert.equal(await documentRowCount(store, "doc_seq"), 0);
	assert.equal(await tableCount(store, "research_semantic_index_state"), 0);
	assert.equal(await tableCount(store, "research_objects"), 0);
});

/* ---------------------------------------------------------------- */
/* 4. Dry run lists without deleting                                */
/* ---------------------------------------------------------------- */

test("dry_run 只列清单不删，随后真实运行照常清除", async () => {
	const fake = { ai: new FakeAi(), index: new FakeVectorize() };
	fake.deps = { ai: fake.ai, index: fake.index };
	const store = storage();
	await seedIndexedDocument(store, fake, {
		documentId: "doc_dry_age",
		versionId: "ver_dry_age",
		ingestedAt: OLD_INGESTED_AT,
	});
	await seedIndexedDocument(store, fake, {
		documentId: "doc_dry_e02",
		versionId: "ver_dry_e02",
		sourceId: "E02-gelonghui-live",
		ingestedAt: FRESH_INGESTED_AT,
	});
	await seedIndexedDocument(store, fake, {
		documentId: "doc_dry_keep",
		versionId: "ver_dry_keep",
		ingestedAt: FRESH_INGESTED_AT,
	});
	const snapshot = {
		records: await tableCount(store, "research_records"),
		links: await tableCount(store, "research_record_objects"),
		objects: await tableCount(store, "research_objects"),
		state: await tableCount(store, "research_semantic_index_state"),
		messages: await tableCount(store, "research_ingest_messages"),
		r2Keys: [...store.objects.objects.keys()].sort(),
		vectors: fake.index.vectors.size,
	};
	const report = await retention.runRetentionSweep(store, { index: fake.index }, {
		trigger: "manual",
		dryRun: true,
		now: NOW,
	});
	assert.equal(report.dry_run, true);
	assert.deepEqual(
		report.would_mark.map((candidate) => candidate.document_id).sort(),
		["doc_dry_age", "doc_dry_e02"],
	);
	assert.deepEqual(
		report.would_mark.map((candidate) => candidate.reason).sort(),
		["AGE_90D", "SOURCE_E02_GELONGHUI_LIVE"],
	);
	assert.equal(report.already_expired_pending_purge.length, 0);
	// 什么都不删：所有表、R2、向量与 dry-run 前完全一致。
	assert.equal(await tableCount(store, "research_records"), snapshot.records);
	assert.equal(await tableCount(store, "research_record_objects"), snapshot.links);
	assert.equal(await tableCount(store, "research_objects"), snapshot.objects);
	assert.equal(await tableCount(store, "research_semantic_index_state"), snapshot.state);
	assert.deepEqual([...store.objects.objects.keys()].sort(), snapshot.r2Keys);
	assert.equal(fake.index.vectors.size, snapshot.vectors);
	assert.equal(await retentionRow(store, "doc_dry_age"), null, "dry run 不写 EXPIRED 标记");
	const audits = await auditRows(store);
	assert.equal(audits.length, 1);
	assert.equal(audits[0].dry_run, 1);
	assert.equal(audits[0].document_count, 2);
	// dry-run 没有消耗任何候选：真实运行立即完成全部清除。
	const real = await retention.runRetentionSweep(store, { index: fake.index }, {
		trigger: "manual",
		now: NOW,
	});
	assert.equal(real.marked_expired, 2);
	assert.equal(real.purged_documents, 2);
	assert.equal(await documentRowCount(store, "doc_dry_keep"), 1);
	assert.equal(await documentRowCount(store, "doc_dry_age"), 0);
	assert.equal(await documentRowCount(store, "doc_dry_e02"), 0);
});

/* ---------------------------------------------------------------- */
/* 5. E02-gelonghui-live: full purge regardless of age              */
/* ---------------------------------------------------------------- */

test("E02-gelonghui-live 全部清除（新旧都清），正常源不受影响，重放保护保留", async () => {
	const fake = { ai: new FakeAi(), index: new FakeVectorize() };
	fake.deps = { ai: fake.ai, index: fake.index };
	const store = storage();
	const e02Old = await seedIndexedDocument(store, fake, {
		documentId: "doc_e02_old",
		versionId: "ver_e02_old",
		sourceId: "E02-gelonghui-live",
		ingestedAt: OLD_INGESTED_AT,
		body: "E02 旧文合成正文",
	});
	const e02Fresh = await seedIndexedDocument(store, fake, {
		documentId: "doc_e02_fresh",
		versionId: "ver_e02_fresh",
		sourceId: "E02-gelonghui-live",
		ingestedAt: FRESH_INGESTED_AT,
		body: "E02 新文合成正文",
	});
	const normal = await seedIndexedDocument(store, fake, {
		documentId: "doc_e02_keep",
		versionId: "ver_e02_keep",
		ingestedAt: FRESH_INGESTED_AT,
		body: "正常源合成正文",
	});
	const messagesBefore = await tableCount(store, "research_ingest_messages");
	const report = await retention.runRetentionSweep(store, fake.deps, {
		trigger: "scheduled",
		now: NOW,
	});
	assert.equal(report.trigger, "scheduled");
	assert.equal(report.purged_documents, 2);
	assert.equal(report.purge_skipped, null);
	for (const purged of [e02Old, e02Fresh]) {
		const documentId = purged.payload.document.document_id;
		assert.equal(await documentRowCount(store, documentId), 0);
		assert.equal(
			await tableCount(
				store,
				"research_record_objects",
				`WHERE record_key='${purged.payload.version.version_id}'`,
			),
			0,
		);
		assert.equal(
			store.objects.objects.has(`research-objects/sha256/${purged.bodyHash}`),
			false,
			"E02 正文对象必须删除",
		);
		assert.equal(
			store.objects.objects.has(`research-replica-journal/v2/${purged.record.message_id}.json`),
			false,
			"E02 原文 journal 必须删除（违规存量不得残留在 R2）",
		);
		const tombstone = await retentionRow(store, documentId);
		assert.equal(tombstone.status, "PURGED");
		assert.equal(tombstone.reason, "SOURCE_E02_GELONGHUI_LIVE");
	}
	// 正常源文档毫发无损。
	assert.equal(await documentRowCount(store, "doc_e02_keep"), 1);
	assert.ok(store.objects.objects.has(`research-objects/sha256/${normal.bodyHash}`));
	// 语义状态行只剩正常文档的。
	assert.equal(await tableCount(store, "research_semantic_index_state"), 1);
	// 重放保护账本保留：延迟重投是 REPLAY，不会复活已清除内容。
	assert.equal(await tableCount(store, "research_ingest_messages"), messagesBefore);
	const replay = await replica.ingestResearchReplicaRecord(store, e02Old.record, null, NOW);
	assert.equal(replay.status, "REPLAY");
	assert.equal(await documentRowCount(store, "doc_e02_old"), 0);
});

/* ---------------------------------------------------------------- */
/* 6. Audit content: counts + id lists, never document content      */
/* ---------------------------------------------------------------- */

test("审计内容：计数与 id 清单入账，正文与标题绝不入账", async () => {
	const fake = { ai: new FakeAi(), index: new FakeVectorize() };
	fake.deps = { ai: fake.ai, index: fake.index };
	const store = storage();
	const secretBody = "绝密审计正文标记串XYZ";
	const secretTitle = "绝密审计标题标记串ABC";
	await seedIndexedDocument(store, fake, {
		documentId: "doc_audit",
		versionId: "ver_audit",
		ingestedAt: OLD_INGESTED_AT,
		body: secretBody,
		title: secretTitle,
	});
	await retention.runRetentionSweep(store, fake.deps, { trigger: "manual", now: NOW });
	const audits = await auditRows(store);
	const last = audits[audits.length - 1];
	assert.equal(last.dry_run, 0);
	assert.equal(last.trigger_source, "manual");
	assert.ok(last.document_count >= 1);
	assert.ok(last.version_count >= 1);
	assert.ok(last.r2_object_count >= 1);
	assert.ok(last.vector_count >= 1);
	const detail = JSON.parse(last.detail_json);
	assert.equal(detail.schema_version, "research-retention-run-v1");
	assert.equal(detail.purge.length, 1);
	assert.equal(detail.purge[0].document_id, "doc_audit");
	assert.deepEqual(detail.purge[0].versions, ["ver_audit"]);
	assert.ok(detail.purge[0].objects_deleted.length >= 1);
	assert.ok(detail.purge[0].journals.length >= 1);
	// 内容零落账：正文、标题、body_text 都不能出现在审计里。
	assert.ok(!last.detail_json.includes(secretBody));
	assert.ok(!last.detail_json.includes(secretTitle));
	assert.ok(!JSON.stringify(detail).includes("body_text"));
});

/* ---------------------------------------------------------------- */
/* 7. Shared object guard                                           */
/* ---------------------------------------------------------------- */

test("共享附件对象受引用保护：一方清除不删共享字节", async () => {
	const fake = { ai: new FakeAi(), index: new FakeVectorize() };
	fake.deps = { ai: fake.ai, index: fake.index };
	const store = storage();
	const sharedProjection = "共享提取文本投影内容";
	const expired = await seedIndexedDocument(store, fake, {
		documentId: "doc_share_old",
		versionId: "ver_share_old",
		ingestedAt: OLD_INGESTED_AT,
		body: "过期共享方合成正文",
		projection: sharedProjection,
	});
	const keeper = await seedIndexedDocument(store, fake, {
		documentId: "doc_share_keep",
		versionId: "ver_share_keep",
		ingestedAt: FRESH_INGESTED_AT,
		body: "保留方合成正文",
		projection: sharedProjection,
	});
	const sharedHash = sha256HexOf(encoder.encode(sharedProjection));
	// 共享投影对象的字节与其元数据行（ingest 只写链接，不写正文对象）。
	assert.equal(await seedContentObject(store, encoder.encode(sharedProjection), "outbound_object_shared"), sharedHash);
	const report = await retention.runRetentionSweep(store, fake.deps, {
		trigger: "manual",
		now: NOW,
	});
	assert.equal(report.purged_documents, 1);
	const detail = report.purge[0];
	assert.equal(detail.document_id, "doc_share_old");
	assert.equal(detail.objects_kept_shared, 1);
	assert.deepEqual(detail.objects_kept_shared_hashes, [sharedHash]);
	// 过期方自己的正文对象删除，共享投影对象保留。
	assert.equal(store.objects.objects.has(`research-objects/sha256/${expired.bodyHash}`), false);
	assert.ok(store.objects.objects.has(`research-objects/sha256/${sharedHash}`));
	assert.equal(await tableCount(store, "research_objects", `WHERE content_sha256='${sharedHash}'`), 1);
	// 未过期方完好：版本行、链接行都在。
	assert.equal(await documentRowCount(store, "doc_share_keep"), 1);
	assert.equal(
		await tableCount(
			store,
			"research_record_objects",
			`WHERE record_key='${keeper.payload.version.version_id}'`,
		),
		2,
		"keeper 的正文链接 + 共享附件链接都在",
	);
});

/* ---------------------------------------------------------------- */
/* 8. Internal token-gated manual trigger (?dry_run=1)              */
/* ---------------------------------------------------------------- */

test("内部端点 POST /internal/research-retention/run：token 门控与 ?dry_run=1", async () => {
	const fake = { ai: new FakeAi(), index: new FakeVectorize() };
	fake.deps = { ai: fake.ai, index: fake.index };
	const store = storage();
	await seedIndexedDocument(store, fake, {
		documentId: "doc_endpoint",
		versionId: "ver_endpoint",
		ingestedAt: OLD_INGESTED_AT,
	});
	const env = {
		RESEARCH_REPLICA: store.db,
		RESEARCH_OBJECTS: store.objects,
		RESEARCH_REPLICA_INGEST_TOKEN: "internal-token",
		RESEARCH_PUBLIC_INDEX: fake.index,
	};
	const base = "https://worker.example/internal/research-retention/run";
	const recordsBefore = await tableCount(store, "research_records");

	const unauthorized = await worker.fetch(new Request(base, { method: "POST" }), env, {});
	assert.equal(unauthorized.status, 401);
	assert.equal((await unauthorized.json()).error_code, "FILTERED");

	const wrongMethod = await worker.fetch(
		new Request(base, { headers: { Authorization: "Bearer internal-token" } }),
		env,
		{},
	);
	assert.equal(wrongMethod.status, 405);

	const badParam = await worker.fetch(
		new Request(`${base}?dry_run=yes`, {
			method: "POST",
			headers: { Authorization: "Bearer internal-token" },
		}),
		env,
		{},
	);
	assert.equal(badParam.status, 400);

	const badBody = await worker.fetch(
		new Request(base, {
			method: "POST",
			headers: { Authorization: "Bearer internal-token" },
			body: JSON.stringify({ document_id: "doc_endpoint" }),
		}),
		env,
		{},
	);
	assert.equal(badBody.status, 400, "运维端点不接受文档选择器");

	// dry_run：只列清单，不删。
	const dry = await worker.fetch(
		new Request(`${base}?dry_run=1`, {
			method: "POST",
			headers: { Authorization: "Bearer internal-token", "Content-Type": "application/json" },
			body: "{}",
		}),
		env,
		{},
	);
	assert.equal(dry.status, 200);
	const dryReport = await dry.json();
	assert.equal(dryReport.dry_run, true);
	assert.deepEqual(
		dryReport.would_mark.map((candidate) => candidate.document_id),
		["doc_endpoint"],
	);
	assert.equal(await tableCount(store, "research_records"), recordsBefore);

	// 真实运行：清除并返回编排报告。
	const real = await worker.fetch(
		new Request(base, {
			method: "POST",
			headers: { Authorization: "Bearer internal-token", "Content-Type": "application/json" },
			body: JSON.stringify({ max_mark: 10, max_purge: 10 }),
		}),
		env,
		{},
	);
	assert.equal(real.status, 200);
	const realReport = await real.json();
	assert.equal(realReport.dry_run, false);
	assert.equal(realReport.purged_documents, 1);
	assert.equal(await documentRowCount(store, "doc_endpoint"), 0);
});

/* ---------------------------------------------------------------- */
/* 9. Daily scheduled trigger routing                               */
/* ---------------------------------------------------------------- */

test("每日 scheduled 触发按 RETENTION_CRON 路由到 retention 编排", async () => {
	const fake = { ai: new FakeAi(), index: new FakeVectorize() };
	fake.deps = { ai: fake.ai, index: fake.index };
	const store = storage();
	await seedIndexedDocument(store, fake, {
		documentId: "doc_cron",
		versionId: "ver_cron",
		ingestedAt: OLD_INGESTED_AT,
	});
	const env = {
		RESEARCH_REPLICA: store.db,
		RESEARCH_OBJECTS: store.objects,
		RESEARCH_PUBLIC_INDEX: fake.index,
	};
	await worker.scheduled({ cron: retention.RETENTION_CRON }, env);
	assert.equal(await documentRowCount(store, "doc_cron"), 0);
	const tombstone = await retentionRow(store, "doc_cron");
	assert.equal(tombstone.status, "PURGED");
	const audits = await auditRows(store);
	assert.equal(audits.length, 1);
	assert.equal(audits[0].trigger_source, "scheduled");
	assert.equal(audits[0].dry_run, 0);
});
