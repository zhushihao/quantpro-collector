import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

const remote = await import("../src/research-remote-adapter.ts");
const replica = await import("../src/research-replica.ts");
const outbound = await import("../src/research-outbound-v2.ts");
const readRetry = await import("../src/research-read-retry.ts");

const encoder = new TextEncoder();

function sha256HexOf(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * FakeD1 dispatches on the SQL text shape, mirroring the two query families
 * the read adapter issues:
 *  - list queries ("record_type=? AND visibility=? ... LIMIT ?") -> .all()
 *  - document queries ("json_extract(payload_json, ...)") -> .all() multi-row
 *  - key queries ("record_key=?") -> .first()
 */
class FakeD1 {
	constructor(records) {
		this.records = records;
		/**
		 * Retention (owner ruling 2026-09-29): the read faces exclude documents
		 * marked EXPIRED in research_document_retention.  The real shim-based
		 * suites prove that SQL against the production schema; this fake mirrors
		 * the same semantics with an explicit id set (empty by default).
		 */
		this.expiredDocumentIds = new Set();
	}

	documentRows(visibility, documentId) {
		return this.records.filter(
			(row) =>
				row.record_type === "document_version" &&
				row.visibility === visibility &&
				JSON.parse(row.payload_json).document.document_id === documentId,
		);
	}

	excludeRetentionExpired(rows) {
		return this.expiredDocumentIds.size === 0
			? rows
			: rows.filter(
					(row) =>
						!this.expiredDocumentIds.has(
							JSON.parse(row.payload_json).document.document_id,
						),
				);
	}

	prepare(sql) {
		const db = this;
		return {
			params: [],
			bind(...params) {
				this.params = params;
				return this;
			},
			async all() {
				if (sql.includes("json_extract")) {
					if (sql.includes("research_documents_fts WHERE research_documents_fts MATCH")) {
						// FTS5 fast path: params are [visibility, phrase, limit].
						// Simulate trigram substring semantics over titles.
						const [visibility, phrase, limit] = this.params;
						const needle = String(phrase).replaceAll('"', "").toLowerCase();
						const rows = db.records.filter((row) =>
							row.record_type === "document_version" &&
							row.visibility === visibility &&
							String(JSON.parse(row.payload_json).document.title ?? "").toLowerCase().includes(needle),
						);
						const filtered = db.excludeRetentionExpired(rows);
						return { results: typeof limit === "number" ? filtered.slice(0, limit) : filtered };
					}
					if (sql.includes("lower(json_extract(payload_json, '$.document.title'))")) {
						const [visibility, titleNeedle, limit] = this.params;
						const rows = db.records.filter((row) =>
							row.record_type === "document_version" &&
							row.visibility === visibility &&
							String(JSON.parse(row.payload_json).document.title ?? "").toLocaleLowerCase()
								.includes(String(titleNeedle).replaceAll("%", "").toLocaleLowerCase()),
						);
						const filtered = db.excludeRetentionExpired(rows);
						return { results: typeof limit === "number" ? filtered.slice(0, limit) : filtered };
					}
					if (sql.includes("'$.document.document_id')=?")) {
						// getDocument: params are [visibility, documentId].
						const [visibility, documentId] = this.params;
						return { results: db.excludeRetentionExpired(db.documentRows(visibility, documentId)) };
					}
					if (sql.includes("research_document_retention")) {
						// Needle-less searchDocuments with the retention filter:
						// params are [visibility, limit].
						const [visibility, limit] = this.params;
						const rows = db.excludeRetentionExpired(
							db.records.filter(
								(row) => row.record_type === "document_version" && row.visibility === visibility,
							),
						);
						return { results: typeof limit === "number" ? rows.slice(0, limit) : rows };
					}
					const [visibility, documentId] = this.params;
					return { results: db.excludeRetentionExpired(db.documentRows(visibility, documentId)) };
				}
				if (sql.includes("record_type='document_version'")) {
					const [visibility, limit] = this.params;
					const rows = db.records.filter(
						(row) => row.record_type === "document_version" && row.visibility === visibility,
					);
					return { results: typeof limit === "number" ? rows.slice(0, limit) : rows };
				}
				const [recordType, visibility, limit] = this.params;
				const rows = db.records.filter(
					(row) => row.record_type === recordType && row.visibility === visibility,
				);
				return { results: typeof limit === "number" ? rows.slice(0, limit) : rows };
			},
			async first() {
				if (sql.includes("accumulator_subject_key")) {
					const [visibility, subjectKey] = this.params;
					return db.records
						.filter((row) => row.record_type === "accumulator" && row.visibility === visibility && row.accumulator_subject_key === subjectKey)
					.sort((a, b) => {
						const byCreated = String(b.accumulator_created_at).localeCompare(String(a.accumulator_created_at));
						return byCreated || String(b.record_key).localeCompare(String(a.record_key));
						})[0] ?? null;
				}
				if (sql.includes("json_extract")) {
					const [visibility, documentId] = this.params;
					return db.excludeRetentionExpired(db.documentRows(visibility, documentId))[0] ?? null;
				}
				if (sql.includes("record_key=?")) {
					const [recordType, recordKey, visibility] = this.params;
					return (
						db.records.find(
							(row) =>
								row.record_type === recordType &&
								row.record_key === recordKey &&
								row.visibility === visibility,
						) ?? null
					);
				}
				return null;
			},
		};
	}
}

function accumulatorRow({
	snapshotId,
	subjectKey = "ai-compute",
	createdAt,
	updatedAt = "2026-09-18T00:00:00.000Z",
	status = "OBSERVED",
	schemaVersion = "collector-outbound-v4",
}) {
	return {
		record_type: "accumulator",
		record_key: snapshotId,
		message_id: `outbound_${snapshotId}`,
		visibility: "PUBLIC",
		schema_version: schemaVersion,
		payload_json: JSON.stringify({ snapshot_id: snapshotId, subject_key: subjectKey, created_at: createdAt, status }),
		generated_at: "2099-01-01T00:00:00.000Z",
		updated_at: updatedAt,
		accumulator_subject_key: subjectKey,
		accumulator_created_at: new Date(createdAt).toISOString(),
	};
}

async function accumulatorEnvelope({ snapshotId, createdAt, status }) {
	const record = {
		record_type: "accumulator",
		message_id: "",
		schema_version: "collector-outbound-v3",
		policy_version: "accumulator-v1",
		visibility: "PUBLIC",
		generated_at: "2099-01-01T00:00:00+00:00",
		payload: {
			snapshot_id: snapshotId,
			subject_key: "ai-compute",
			evidence_ids: [],
			total_weight: 0,
			dimensions: { C: 0, D: 0, E: 0, M: 0, P: 0, S: 0 },
			independent_cluster_count: 0,
			unknown_cluster_count: 0,
			conflict_count: 0,
			last_evidence_at: null,
			rule_version: "accumulator-v1",
			status,
			created_at: createdAt,
			visibility: "PUBLIC",
		},
	};
	record.message_id = await outbound.computeOutboundV2MessageId(record);
	return record;
}

class FakeR2 {
	constructor(objects) {
		this.objects = objects;
	}

	async get(key) {
		const bytes = this.objects.get(key);
		return bytes
			? {
					arrayBuffer: async () =>
						bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
				}
			: null;
	}

	async put(key, body) {
		const bytes = typeof body === "string" ? encoder.encode(body) : new Uint8Array(body);
		this.objects.set(key, bytes);
	}
}

function documentRow({ visibility = "PUBLIC", documentId = "doc-public", content }) {
	const hash = createHash("sha256").update(content).digest("hex");
	return {
		record_type: "document_version",
		record_key: `version-${documentId}`,
		message_id: `outbound_${"a".repeat(40)}`,
		visibility,
		payload_json: JSON.stringify({
			document: { document_id: documentId, visibility, title: "Synthetic remote document" },
			version: {
				content_sha256: hash,
				media_type: "text/plain",
				byte_size: content.byteLength,
			},
			attachments: [],
		}),
		generated_at: "2026-09-13T00:00:00Z",
		updated_at: "2026-09-13T00:00:00Z",
	};
}

/**
 * Build one synthetic document_version replica row plus the R2 objects its
 * references resolve to.  All data is code-inline synthetic; the frozen
 * fixtures directory is never touched.
 */
function documentVersionRow({
	documentId = "doc-1",
	versionId = "ver-1",
	versionNumber = 1,
	revisionKind = "ORIGINAL",
	storedReadable = false,
	ownMediaType = "application/pdf",
	ownContent = null,
	projectionText = null,
	projectionStoredBytes = null,
	visibility = "PUBLIC",
	title = "Synthetic document",
}) {
	const own = ownContent ?? encoder.encode(`synthetic own bytes for ${versionId}`);
	const attachments = [];
	let projection = null;
	if (projectionText !== null) {
		const bytes = encoder.encode(projectionText);
		projection = { bytes, sha: sha256HexOf(bytes) };
		attachments.push({
			attachment_id: `att-${versionId}`,
			attachment_locator: `urn:riws:text-extraction:${versionId}`,
			content_sha256: projection.sha,
			byte_size: bytes.byteLength,
			media_type: "text/plain",
			display_name: "extracted-text",
			role: "text_extraction",
			attachment_status: "FETCHED",
			outcome: null,
			failure_class: null,
		});
	}
	const payload = {
		document: { document_id: documentId, title, visibility },
		version: {
			version_id: versionId,
			document_id: documentId,
			version_number: versionNumber,
			content_sha256: sha256HexOf(own),
			byte_size: own.byteLength,
			media_type: ownMediaType,
			revision_kind: revisionKind,
			readable: storedReadable,
		},
		attachments,
	};
	const row = {
		record_type: "document_version",
		record_key: versionId,
		message_id: `outbound_${payload.version.content_sha256.slice(0, 40)}`,
		visibility,
		payload_json: JSON.stringify(payload),
		generated_at: "2026-09-13T00:00:00Z",
		updated_at: "2026-09-13T00:00:00Z",
	};
	const objects = new Map([[`research-objects/sha256/${payload.version.content_sha256}`, own]]);
	if (projection) {
		objects.set(
			`research-objects/sha256/${projection.sha}`,
			projectionStoredBytes ?? projection.bytes,
		);
	}
	return { row, payload, objects };
}

function storageFrom(...parts) {
	const objects = new Map();
	for (const part of parts) {
		for (const [key, value] of part.objects) {
			if (!objects.has(key)) objects.set(key, value);
		}
	}
	return {
		db: new FakeD1(parts.map((part) => part.row)),
		objects: new FakeR2(objects),
	};
}

test("C6 remote adapter reads verified Collector-owned object bytes without a local adapter", async () => {
	const body = new TextEncoder().encode("real replica body, synthetic test source");
	const row = documentRow({ content: body });
	const contentSha = JSON.parse(row.payload_json).version.content_sha256;
	const storage = {
		db: new FakeD1([row]),
		objects: new FakeR2(new Map([[`research-objects/sha256/${contentSha}`, body]])),
	};
	const adapter = new remote.CollectorResearchRemoteAdapter(storage, { visibility: "PUBLIC" });
	const document = await adapter.getDocument("doc-public");
	assert.equal(document.document.document_id, "doc-public");
	assert.equal(document.body_text, "real replica body, synthetic test source");
	assert.equal(document.source, "COLLECTOR_REPLICA");
});

test("#34 remote adapter preserves deterministic D1 classification instead of flattening it to STORE_UNAVAILABLE", async () => {
	const storage = {
		db: {
			prepare() {
				return {
					bind() { return this; },
					async all() { throw new Error("D1_ERROR: no such table: research_records"); },
				};
			},
		},
		objects: new FakeR2(new Map()),
	};
	const adapter = new remote.CollectorResearchRemoteAdapter(storage, { visibility: "PUBLIC" });
	await assert.rejects(
		() => adapter.searchDocuments("financing", 10),
		(error) =>
			error instanceof readRetry.ResearchReadBackendError &&
			error.failure_class === "DETERMINISTIC" &&
			error.diagnostic_code === "DETERMINISTIC_BACKEND_QUERY_OR_CONFIG",
	);
});

test("C6 remote adapter is visibility fail-closed and emits only the common safe error model", async () => {
	const privateBody = new TextEncoder().encode("private body");
	const row = documentRow({
		visibility: "PRIVATE",
		documentId: "doc-private",
		content: privateBody,
	});
	const contentSha = JSON.parse(row.payload_json).version.content_sha256;
	const storage = {
		db: new FakeD1([row]),
		objects: new FakeR2(new Map([[`research-objects/sha256/${contentSha}`, privateBody]])),
	};
	const publicAdapter = new remote.CollectorResearchRemoteAdapter(storage, {
		visibility: "PUBLIC",
	});
	await assert.rejects(
		() => publicAdapter.getDocument("doc-private"),
		(error) =>
			error?.error_code === "NOT_FOUND" &&
			Object.keys(error.asError()).sort().join(",") ===
				"error_code,request_id,retryable,safe_message",
	);
});

test("#25 current accumulator uses producer created_at, not late replica arrival", async () => {
	const newer = accumulatorRow({
		snapshotId: "snap_b49b_new",
		createdAt: "2026-09-17T10:00:00+00:00",
		updatedAt: "2026-09-17T10:01:00.000Z",
		status: "ACCUMULATING",
	});
	const oldLate = accumulatorRow({
		snapshotId: "snap_6242_old",
		createdAt: "2026-09-17T09:00:00+00:00",
		updatedAt: "2026-09-18T12:00:00.000Z",
		status: "OBSERVED",
		schemaVersion: "collector-outbound-v2",
	});
	const adapter = new remote.CollectorResearchRemoteAdapter({ db: new FakeD1([newer, oldLate]), objects: new FakeR2(new Map()) });
	const current = await adapter.getThemeAccumulator("ai-compute");
	assert.equal(current.record_key, "snap_b49b_new");
	assert.equal(current.payload.status, "ACCUMULATING");
});

test("#25 accumulator semantic ordering is replay-safe, generation-safe, stable on ties, and not globally windowed", async () => {
	const targetNew = accumulatorRow({ snapshotId: "snap-z", createdAt: "2026-09-18T10:00:00Z", status: "ACCUMULATING" });
	const targetReplay = accumulatorRow({ snapshotId: "snap-z", createdAt: "2026-09-18T10:00:00Z", updatedAt: "2099-01-01T00:00:00Z", status: "ACCUMULATING" });
	const targetSameTimeOlderTie = accumulatorRow({ snapshotId: "snap-a", createdAt: "2026-09-18T10:00:00Z", updatedAt: "2100-01-01T00:00:00Z", status: "OBSERVED", schemaVersion: "collector-outbound-v3" });
	const targetLateOld = accumulatorRow({ snapshotId: "snap-old", createdAt: "2026-09-18T09:00:00Z", updatedAt: "2200-01-01T00:00:00Z", status: "ESCALATED" });
	const unrelated = Array.from({ length: 150 }, (_, index) => accumulatorRow({
		snapshotId: `other-${String(index).padStart(3, "0")}`,
		subjectKey: `other-${index}`,
		createdAt: "2026-09-19T00:00:00Z",
		updatedAt: "2200-01-01T00:00:00Z",
	}));
	const adapter = new remote.CollectorResearchRemoteAdapter({
		db: new FakeD1([...unrelated, targetLateOld, targetSameTimeOlderTie, targetReplay, targetNew]),
		objects: new FakeR2(new Map()),
	});
	const current = await adapter.getThemeAccumulator("ai-compute");
	assert.equal(current.record_key, "snap-z"); // snapshot id is deterministic tie-break.
	assert.equal(current.payload.status, "ACCUMULATING"); // semantic state may legally decline after a correction.
});

test("issue #10 FTS5: migrated trigram table supports CJK substring MATCH and replay update", async () => {
	const db = createResearchWorkflowDb();
	// Real migrated DDL (0015) creates research_documents_fts with the trigram
	// tokenizer; exercise the exact SQL shapes the production faces run.
	await db.batch([
		db.prepare("INSERT INTO research_documents_fts(record_key, document_id, text) VALUES (?, ?, ?)")
			.bind("ver-1", "doc-1", "电子布高端需求挤压普通供给"),
	]);
	const hit = await db
		.prepare("SELECT record_key FROM research_documents_fts WHERE research_documents_fts MATCH ?")
		.bind('"子布高"')
		.all();
	assert.deepEqual(hit.results.map((r) => r.record_key), ["ver-1"], ">=3-char substring matches via trigram");
	// Replay: delete-then-insert keeps exactly one shadow row with new text.
	await db.batch([
		db.prepare("DELETE FROM research_documents_fts WHERE record_key = ?").bind("ver-1"),
		db.prepare("INSERT INTO research_documents_fts(record_key, document_id, text) VALUES (?, ?, ?)")
			.bind("ver-1", "doc-1", "电子布涨价向板厂传导"),
	]);
	const stale = await db
		.prepare("SELECT record_key FROM research_documents_fts WHERE research_documents_fts MATCH ?")
		.bind('"挤压普通"')
		.all();
	assert.equal(stale.results.length, 0, "shadow text mirrors the newest accepted title only");
	// The joined read shape the adapter uses: visibility/expiry ownership stays
	// on research_records; the FTS table only narrows the hit set.
	const joined = await db
		.prepare(
			"SELECT record_type, record_key FROM research_records WHERE record_type='document_version' AND visibility='PUBLIC' AND record_key IN (SELECT record_key FROM research_documents_fts WHERE research_documents_fts MATCH ?)",
		)
		.bind('"涨价"')
		.all();
	assert.deepEqual(joined.results, [], "no records row was inserted, so the join cannot widen");
});

test("#25 replica ingest new then old keeps semantic-current state in real migrated D1 SQL", async () => {
	const storage = { db: createResearchWorkflowDb(), objects: new FakeR2(new Map()) };
	const newer = await accumulatorEnvelope({ snapshotId: "snap-new", createdAt: "2026-09-18T10:00:00+00:00", status: "ACCUMULATING" });
	const oldLate = await accumulatorEnvelope({ snapshotId: "snap-old", createdAt: "2026-09-18T09:00:00+00:00", status: "OBSERVED" });
	await replica.ingestResearchReplicaRecord(storage, newer, null, "2026-09-18T10:01:00+00:00");
	await replica.ingestResearchReplicaRecord(storage, oldLate, null, "2099-01-01T00:00:00+00:00");
	const current = await new remote.CollectorResearchRemoteAdapter(storage).getThemeAccumulator("ai-compute");
	assert.equal(current.record_key, "snap-new");
	assert.equal(current.payload.status, "ACCUMULATING");
});

test("C8 PDF version with a FETCHED text-extraction projection serves projection bytes", async () => {
	const projectionText = "extracted research narrative, synthetic projection body";
	const part = documentVersionRow({
		documentId: "doc-pdf",
		versionId: "ver-pdf-1",
		projectionText,
	});
	const adapter = new remote.CollectorResearchRemoteAdapter(storageFrom(part), {
		visibility: "PUBLIC",
	});
	const document = await adapter.getDocument("doc-pdf");
	assert.equal(document.version.version_id, "ver-pdf-1");
	assert.equal(document.body_text, projectionText);
	assert.equal(document.body_source, "projection");
	assert.equal(document.version.readable, true);
	assert.equal(document.source, "COLLECTOR_REPLICA");
	assert.equal(document.attachments[0].role, "text_extraction");
	assert.equal(document.attachments[0].attachment_locator, "urn:riws:text-extraction:ver-pdf-1");
});

test("C8 own servable body wins over an available projection", async () => {
	const ownText = "own text/plain body bytes, synthetic";
	const part = documentVersionRow({
		documentId: "doc-text",
		versionId: "ver-text-1",
		ownMediaType: "text/plain",
		ownContent: encoder.encode(ownText),
		projectionText: "projection that must not be served when the own body is servable",
	});
	const adapter = new remote.CollectorResearchRemoteAdapter(storageFrom(part), {
		visibility: "PUBLIC",
	});
	const document = await adapter.getDocument("doc-text");
	assert.equal(document.version.version_id, "ver-text-1");
	assert.equal(document.body_text, ownText);
	assert.equal(document.body_source, "own");
	assert.equal(document.version.readable, true);
});

test("C8 PDF version without a projection is UNSUPPORTED_OPERATION", async () => {
	const part = documentVersionRow({
		documentId: "doc-bare-pdf",
		versionId: "ver-bare-pdf",
	});
	const adapter = new remote.CollectorResearchRemoteAdapter(storageFrom(part), {
		visibility: "PUBLIC",
	});
	await assert.rejects(
		() => adapter.getDocument("doc-bare-pdf"),
		(error) => error?.error_code === "UNSUPPORTED_OPERATION" && error.retryable === false,
	);
});

test("C8 multi-version selection is deterministic on version_number DESC regardless of insert order", async () => {
	const projectionText = "newest version projection body, synthetic";
	const v1 = documentVersionRow({
		documentId: "doc-multi",
		versionId: "ver-multi-1",
		versionNumber: 1,
	});
	const v2 = documentVersionRow({
		documentId: "doc-multi",
		versionId: "ver-multi-2",
		versionNumber: 2,
		projectionText,
	});
	// Out of order: newest row inserted first.
	const adapter = new remote.CollectorResearchRemoteAdapter(storageFrom(v2, v1), {
		visibility: "PUBLIC",
	});
	for (let call = 0; call < 2; call += 1) {
		const document = await adapter.getDocument("doc-multi");
		assert.equal(document.version.version_id, "ver-multi-2");
		assert.equal(document.body_source, "projection");
		assert.equal(document.body_text, projectionText);
	}
});

test("C8 missing projection object falls back to the next servable version", async () => {
	const ownText = "fallback own body, synthetic";
	const v2 = documentVersionRow({
		documentId: "doc-fallback",
		versionId: "ver-fallback-2",
		versionNumber: 2,
		projectionText: "projection whose R2 object is missing",
	});
	const v1 = documentVersionRow({
		documentId: "doc-fallback",
		versionId: "ver-fallback-1",
		versionNumber: 1,
		ownMediaType: "text/plain",
		ownContent: encoder.encode(ownText),
	});
	const storage = storageFrom(v2, v1);
	for (const key of v2.objects.keys()) {
		if (key !== `research-objects/sha256/${v2.payload.version.content_sha256}`) {
			storage.objects.objects.delete(key);
		}
	}
	const adapter = new remote.CollectorResearchRemoteAdapter(storage, { visibility: "PUBLIC" });
	const document = await adapter.getDocument("doc-fallback");
	assert.equal(document.version.version_id, "ver-fallback-1");
	assert.equal(document.body_source, "own");
	assert.equal(document.body_text, ownText);
});

test("C8 every candidate object missing is STORE_UNAVAILABLE", async () => {
	const part = documentVersionRow({
		documentId: "doc-gone",
		versionId: "ver-gone-1",
		projectionText: "projection whose R2 object is missing",
	});
	const storage = storageFrom(part);
	for (const key of part.objects.keys()) {
		if (key !== `research-objects/sha256/${part.payload.version.content_sha256}`) {
			storage.objects.objects.delete(key);
		}
	}
	const adapter = new remote.CollectorResearchRemoteAdapter(storage, { visibility: "PUBLIC" });
	await assert.rejects(
		() => adapter.getDocument("doc-gone"),
		(error) => error?.error_code === "STORE_UNAVAILABLE" && error.retryable === false,
	);
});

test("C8 tampered projection bytes fail integrity immediately without fallback", async () => {
	const tampered = encoder.encode("tampered projection bytes, synthetic");
	const v2 = documentVersionRow({
		documentId: "doc-tamper",
		versionId: "ver-tamper-2",
		versionNumber: 2,
		projectionText: "honest projection body",
		projectionStoredBytes: tampered,
	});
	const v1 = documentVersionRow({
		documentId: "doc-tamper",
		versionId: "ver-tamper-1",
		versionNumber: 1,
		ownMediaType: "text/plain",
		ownContent: encoder.encode("intact fallback body that must not be reached"),
	});
	const adapter = new remote.CollectorResearchRemoteAdapter(storageFrom(v2, v1), {
		visibility: "PUBLIC",
	});
	await assert.rejects(
		() => adapter.getDocument("doc-tamper"),
		(error) => error?.error_code === "INTEGRITY_FAILED" && error.retryable === false,
	);
});

test("C8 searchDocuments overrides effective readable without rewriting stored payload_json", async () => {
	const unreadableStoredTrue = documentVersionRow({
		documentId: "doc-stored-true",
		versionId: "ver-stored-true",
		storedReadable: true,
	});
	const readableStoredFalse = documentVersionRow({
		documentId: "doc-stored-false",
		versionId: "ver-stored-false",
		projectionText: "projection makes this PDF readable",
	});
	const storage = storageFrom(unreadableStoredTrue, readableStoredFalse);
	const storedBefore = storage.db.records.map((row) => row.payload_json);
	const adapter = new remote.CollectorResearchRemoteAdapter(storage, { visibility: "PUBLIC" });
	const views = await adapter.searchDocuments();
	assert.equal(views.length, 2);
	const byId = new Map(views.map((view) => [view.payload.version.version_id, view]));
	assert.equal(byId.get("ver-stored-true").payload.version.readable, false);
	assert.equal(byId.get("ver-stored-false").payload.version.readable, true);
	assert.deepEqual(
		storage.db.records.map((row) => row.payload_json),
		storedBefore,
	);
});

test("#25 searchDocuments applies its title filter before the result limit", async () => {
	const newerUnrelated = Array.from({ length: 10 }, (_, index) => documentVersionRow({
		documentId: `doc-newer-${index}`,
		versionId: `ver-newer-${index}`,
		title: `Unrelated newer document ${index}`,
	}));
	const huawei = documentVersionRow({
		documentId: "doc-huawei-960",
		versionId: "ver-huawei-960",
		title: "Huawei Ascend 960 Hi-ONE official announcement",
	});
	const adapter = new remote.CollectorResearchRemoteAdapter(storageFrom(...newerUnrelated, huawei), {
		visibility: "PUBLIC",
	});
	const views = await adapter.searchDocuments("960", 10);
	assert.equal(views.length, 1);
	assert.equal(views[0].payload.document.document_id, "doc-huawei-960");
});

test("C8 WITHDRAWAL-only document is never servable on either read face", async () => {
	const part = documentVersionRow({
		documentId: "doc-withdrawn",
		versionId: "ver-withdrawn",
		revisionKind: "WITHDRAWAL",
		storedReadable: false,
		projectionText: "projection that cannot rescue a WITHDRAWAL version",
	});
	const adapter = new remote.CollectorResearchRemoteAdapter(storageFrom(part), {
		visibility: "PUBLIC",
	});
	await assert.rejects(
		() => adapter.getDocument("doc-withdrawn"),
		(error) => error?.error_code === "UNSUPPORTED_OPERATION",
	);
	const views = await adapter.searchDocuments();
	assert.equal(views.length, 1);
	assert.equal(views[0].payload.version.readable, false);
});

test("C8 media type parameters are stripped before exact-match servability", async () => {
	const ownText = '{"synthetic":"json body with a parameterized media type"}';
	const part = documentVersionRow({
		documentId: "doc-json-params",
		versionId: "ver-json-params",
		ownMediaType: "application/json; charset=utf-8",
		ownContent: encoder.encode(ownText),
	});
	const adapter = new remote.CollectorResearchRemoteAdapter(storageFrom(part), {
		visibility: "PUBLIC",
	});
	const document = await adapter.getDocument("doc-json-params");
	assert.equal(document.version.version_id, "ver-json-params");
	assert.equal(document.body_source, "own");
	assert.equal(document.body_text, ownText);
	assert.equal(document.version.readable, true);
	const views = await adapter.searchDocuments();
	assert.equal(views.length, 1);
	assert.equal(views[0].payload.version.readable, true);
});

test("C8 fabricated document id is NOT_FOUND", async () => {
	const part = documentVersionRow({
		documentId: "doc-real",
		versionId: "ver-real",
		projectionText: "projection body",
	});
	const adapter = new remote.CollectorResearchRemoteAdapter(storageFrom(part), {
		visibility: "PUBLIC",
	});
	await assert.rejects(
		() => adapter.getDocument("doc-fabricated"),
		(error) => error?.error_code === "NOT_FOUND",
	);
});

test("C9 v4 Evidence returns only verified immutable provenance and timestamps", async () => {
	const content = encoder.encode("synthetic evidence span content");
	const part = documentVersionRow({
		documentId: "doc-evidence-v4",
		versionId: "ver-evidence-v4",
		ownMediaType: "text/plain",
		ownContent: content,
	});
	part.row.schema_version = "collector-outbound-v4";
	const start = 10;
	const end = 18;
	const spanSha256 = sha256HexOf(content.slice(start, end));
	const evidenceRow = {
		record_type: "evidence",
		record_key: "evidence-v4",
		message_id: `outbound_${"e".repeat(40)}`,
		visibility: "PUBLIC",
		schema_version: "collector-outbound-v4",
		payload_json: JSON.stringify({
			evidence_id: "evidence-v4",
			source_reference: {
				document_id: "doc-evidence-v4",
				document_version_id: "ver-evidence-v4",
				attachment_id: null,
				content_sha256: part.payload.version.content_sha256,
				byte_start: start,
				byte_end: end,
				span_sha256: spanSha256,
			},
			event_time: null,
			published_at: "2026-09-15T00:00:00Z",
			first_seen_at: "2026-09-15T00:01:00Z",
			ingested_at: "2026-09-15T00:02:00Z",
		}),
		generated_at: "2026-09-15T00:03:00Z",
		updated_at: "2026-09-15T00:03:00Z",
	};
	const adapter = new remote.CollectorResearchRemoteAdapter(
		{
			db: new FakeD1([evidenceRow, part.row]),
			objects: new FakeR2(part.objects),
		},
		{ visibility: "PUBLIC" },
	);
	const evidence = await adapter.getEvidence("evidence-v4");
	assert.equal(evidence.source_reference_status, "VERIFIED");
	assert.equal(evidence.payload.source_reference.span_sha256, spanSha256);
	assert.equal(evidence.payload.event_time, null);
	assert.equal(evidence.payload.published_at, "2026-09-15T00:00:00Z");
	assert.equal("body_text" in evidence, false);
	assert.equal("content" in evidence.payload, false);
});

test("C9 v4 Evidence refuses a tampered referenced object instead of serving unverifiable provenance", async () => {
	const content = encoder.encode("synthetic evidence tamper source");
	const part = documentVersionRow({
		documentId: "doc-evidence-tamper",
		versionId: "ver-evidence-tamper",
		ownMediaType: "text/plain",
		ownContent: content,
	});
	const evidenceRow = {
		record_type: "evidence",
		record_key: "evidence-tamper",
		message_id: `outbound_${"f".repeat(40)}`,
		visibility: "PUBLIC",
		schema_version: "collector-outbound-v4",
		payload_json: JSON.stringify({
			source_reference: {
				document_id: "doc-evidence-tamper",
				document_version_id: "ver-evidence-tamper",
				attachment_id: null,
				content_sha256: part.payload.version.content_sha256,
				byte_start: 0,
				byte_end: 1,
				span_sha256: sha256HexOf(content.slice(0, 1)),
			},
		}),
		generated_at: null,
		updated_at: "2026-09-15T00:00:00Z",
	};
	const tampered = new Map(part.objects);
	tampered.set(
		`research-objects/sha256/${part.payload.version.content_sha256}`,
		encoder.encode("tampered"),
	);
	const adapter = new remote.CollectorResearchRemoteAdapter(
		{
			db: new FakeD1([evidenceRow, part.row]),
			objects: new FakeR2(tampered),
		},
		{ visibility: "PUBLIC" },
	);
	await assert.rejects(
		() => adapter.getEvidence("evidence-tamper"),
		(error) => error?.error_code === "INTEGRITY_FAILED",
	);
});

// ---------------------------------------------------------------------------
// #5 research-backend additions (matrix B15/B16): market namespace projection,
// real source_health rows, and the server_state job derivation.  These run on
// the node:sqlite shim over the real 0001-0004 DDL so lease/terminal lookups
// are exercised against production SQL.
// ---------------------------------------------------------------------------
const workflowModule = await import("../src/research-workflow.ts");
const scopesModule = await import("../src/research-scopes.ts");
const { createResearchWorkflowDb } = await import("./helpers/d1-sqlite-shim.mjs");

// The workflow owner identity is the origin `oauth-client:<sha256(issuer\0clientId)>`
// form (isFormalResearchOwner).  The adapter B15 lifecycle drives a formal claim,
// so it uses a valid formal owner derived from the production issuer + client id.
const FORMAL_OWNER_B15 = `oauth-client:${"c".repeat(64)}`;

function shimStorage() {
	return {
		db: createResearchWorkflowDb(),
		objects: { async put() {} },
	};
}

async function insertRecord(
	db,
	recordType,
	recordKey,
	payload,
	{ updatedAt = "2026-09-15T00:00:00Z" } = {},
) {
	// Outbound contract: the row visibility mirrors the payload's own field.
	const visibility = typeof payload?.visibility === "string" ? payload.visibility : "PUBLIC";
	await db
		.prepare(
			"INSERT INTO research_records (record_type, record_key, message_id, visibility, schema_version, payload_json, generated_at, updated_at) VALUES (?, ?, ?, ?, 'collector-outbound-v3', ?, ?, ?)",
		)
		.bind(
			recordType,
			recordKey,
			`msg-${recordType}-${recordKey}`,
			visibility,
			JSON.stringify(payload),
			updatedAt,
			updatedAt,
		)
		.run();
}

function nowIsoPlus(ms) {
	return new Date(Date.now() + ms).toISOString();
}

function syntheticJobPayload(jobId) {
	return {
		job_id: jobId,
		dedupe_key: `dedupe-${jobId}`,
		status: "QUEUED",
		priority: 2,
		theme: "theme",
		company: null,
		question: "q",
		missing_dimensions_json: "[]",
		counter_evidence_request: null,
		accumulator_snapshot_id: "snap-1",
		coverage_gap_json: {},
		priority_reason: "r",
		deadline: null,
		recheck_at: null,
		budget_hint: null,
		historical_backfill: false,
		created_at: "2026-09-15T00:00:00Z",
		updated_at: "2026-09-15T00:00:00Z",
		policy_version: "collector-policy-v1",
		visibility: "PUBLIC",
		trigger_evidence_ids: ["ev-1"],
	};
}

test("B15 market signal state returns the honest NO_DATA domain result", async () => {
	const storage = shimStorage();
	const adapter = new remote.CollectorResearchRemoteAdapter(storage, { visibility: "PUBLIC" });
	for (const key of ["synthetic-index", "market:synthetic-index"]) {
		const state = await adapter.getMarketSignalState(key);
		assert.deepEqual(state, {
			status: "NO_DATA",
			subject_key: "market:synthetic-index",
			source: "COLLECTOR_REPLICA",
			note: "MARKET_SIGNAL_NOT_AVAILABLE",
		});
	}
});

test("B15 market signal state returns the independent numeric record view on a hit", async () => {
	const storage = shimStorage();
	await insertRecord(storage.db, "market_signal", "market:synthetic-index", {
		as_of: "2026-09-15",
		benchmark_mapping_version: "market-benchmarks.v1",
		continuous_market_structure: { required_sessions: 3, observed_sessions: 3, relative_positive_sessions: 3, status: "CONFIRMED" },
		mapping_id: "synthetic-v1",
		primary_benchmark: "510300.SH",
		quality: { valid_trading_days: 10, required_trading_days: 10, future_rows_dropped: 0, missing_sessions: 0 },
		relative_strength: { primary_pct_points: { "1D": 1, "3D": 2, "5D": 3, "10D": 4 }, secondary_pct_points: { "1D": 1, "3D": 2, "5D": 3, "10D": 4 } },
		returns: Object.fromEntries(["1D", "3D", "5D", "10D"].map((window) => [window, { window_complete: true, valid_trading_days: Number.parseInt(window, 10), subject_return: 0.1, primary_benchmark_return: 0.05, secondary_benchmark_return: 0.04 }])),
		secondary_benchmark: "510500.SH",
		source: { provider: "amazingdata", snapshot_hash: "a".repeat(64), snapshot_as_of: "2026-09-15T18:00:00+08:00" },
		status: "READY",
		subject_key: "market:synthetic-index",
		volume_price_structure: { up_volume_ratio_5d: 1.2, pullback_volume_ratio_5d: null, volume_up: true, pullback_volume_contraction: false },
		visibility: "PUBLIC",
	});
	const adapter = new remote.CollectorResearchRemoteAdapter(storage, { visibility: "PUBLIC" });
	for (const key of ["synthetic-index", "market:synthetic-index"]) {
		const view = await adapter.getMarketSignalState(key);
		assert.equal(view.subject_kind, "MARKET");
		assert.equal(view.signal_kind, "R3_R4_PRICE_INPUT");
		assert.equal(view.record_key, "market:synthetic-index");
		assert.equal(view.payload.subject_key, "market:synthetic-index");
		assert.equal(view.source, "COLLECTOR_REPLICA");
	}
	// A different market subject is still NO_DATA.
	const miss = await adapter.getMarketSignalState("market:other-index");
	assert.equal(miss.status, "NO_DATA");
});

test("B16 getSourceHealth serves real source_health rows under the PUBLIC clamp", async () => {
	const storage = shimStorage();
	const health = (sourceId, visibility, reachable) => ({
		source_id: sourceId,
		provider: "rss",
		checked_at: "2026-09-15T01:30:00+00:00",
		reachable,
		outcome: reachable ? "OK" : "UNAVAILABLE",
		failure_class: reachable ? null : "TIMEOUT",
		consecutive_failures: reachable ? 0 : 2,
		last_success_at: reachable ? "2026-09-15T01:30:00+00:00" : "2026-09-14T22:00:00+00:00",
		last_error_code: reachable ? null : "UNAVAILABLE",
		visibility,
	});
	await insertRecord(
		storage.db,
		"source_health",
		"src-public",
		health("src-public", "PUBLIC", true),
	);
	await insertRecord(
		storage.db,
		"source_health",
		"src-private",
		health("src-private", "PRIVATE", false),
	);
	const adapter = new remote.CollectorResearchRemoteAdapter(storage, { visibility: "PUBLIC" });
	const rows = await adapter.getSourceHealth();
	assert.equal(rows.length, 1);
	assert.equal(rows[0].record_key, "src-public");
	assert.equal(rows[0].payload.outcome, "OK");
	assert.equal(JSON.stringify(rows).includes("src-private"), false);
});

test("B15 job server_state derivation: terminal over unexpired lease over record, claimable_only filter", async () => {
	const storage = shimStorage();
	await insertRecord(storage.db, "job", "job-b15", syntheticJobPayload("job-b15"));
	const adapter = new remote.CollectorResearchRemoteAdapter(storage, { visibility: "PUBLIC" });

	// 1. No lease, no terminal -> QUEUED.
	let jobs = await adapter.listResearchJobs();
	assert.equal(jobs[0].server_state.effective_status, "QUEUED");
	assert.equal(jobs[0].server_state.lease_owner, null);

	// 2. Unexpired lease -> CLAIMED with owner; filtered out by claimable_only.
	const lease = await workflowModule.claimResearchJob(storage.db, {
		jobId: "job-b15",
		leaseOwner: FORMAL_OWNER_B15,
		requestId: "req-b15",
		now: nowIsoPlus(0),
	});
	assert.equal(lease.status, "CLAIMED");
	jobs = await adapter.listResearchJobs();
	assert.equal(jobs[0].server_state.effective_status, "CLAIMED");
	assert.equal(jobs[0].server_state.lease_owner, FORMAL_OWNER_B15);
	assert.equal(jobs[0].server_state.lease_expires_at, lease.lease_expires_at);
	assert.equal((await adapter.listResearchJobs(50, { claimableOnly: true })).length, 0);

	// 3. Formal completion wins over everything -> COMPLETED, not claimable.
	const formal = await workflowModule.submitResearchResultProposal(storage.db, {
		jobId: "job-b15",
		expectedGeneration: lease.lease_generation,
		origin: "CHATGPT",
		idempotencyKey: "key-b15-formal",
		proposal: {
			job_id: "job-b15",
			summary: "s",
			findings: [],
			recommendation_hint: "NONE",
			sources_consulted: [],
			completed_at: "2026-09-15T00:00:00Z",
		},
		callerPrincipal: FORMAL_OWNER_B15,
		requestId: "req-b15-formal",
		now: nowIsoPlus(1_000),
	});
	assert.equal(formal.status, "ACCEPTED");
	jobs = await adapter.listResearchJobs();
	assert.equal(jobs[0].server_state.effective_status, "COMPLETED");
	assert.equal(jobs[0].server_state.lease_owner, null);
	assert.equal((await adapter.listResearchJobs(50, { claimableOnly: true })).length, 0);
});

test("B15 context exposes proposals but never the claim token", async () => {
	const storage = shimStorage();
	await insertRecord(storage.db, "job", "job-b15c", syntheticJobPayload("job-b15c"));
	const lease = await workflowModule.claimResearchJob(storage.db, {
		jobId: "job-b15c",
		leaseOwner: "client-a",
		requestId: "req-b15c",
		now: nowIsoPlus(0),
	});
	// #19: the claim outcome itself must not carry a credential-like token.
	assert.equal(Object.keys(lease).includes("claim_token"), false);
	// The internal row token (still stored server-side) is captured from the
	// database BEFORE the submit releases the lease, to prove it never
	// crosses the read plane.
	const leaseRow = await storage.db
		.prepare("SELECT claim_token FROM research_job_leases WHERE job_id=?")
		.bind("job-b15c")
		.first();
	assert.match(leaseRow.claim_token, /^clt_[a-f0-9]{32}$/);
	await workflowModule.submitResearchResultProposal(storage.db, {
		jobId: "job-b15c",
		expectedGeneration: lease.lease_generation,
		idempotencyKey: "key-b15c-synth",
		origin: "SYNTHETIC",
		proposal: {
			job_id: "job-b15c",
			summary: "shadow summary",
			findings: [],
			recommendation_hint: "INSUFFICIENT_DATA",
			sources_consulted: [],
			completed_at: "2026-09-15T00:00:00Z",
		},
		callerPrincipal: "client-a",
		requestId: "req-b15c-synth",
		now: nowIsoPlus(1_000),
	});
	const adapter = new remote.CollectorResearchRemoteAdapter(storage, { visibility: "PUBLIC" });
	const context = await adapter.getResearchJobContext("job-b15c");
	assert.equal(context.proposals.length, 1);
	assert.deepEqual(Object.keys(context.proposals[0]).sort(), [
		"created_at",
		"origin",
		"payload",
		"proposal_id",
		"status",
	]);
	assert.equal(context.proposals[0].payload.summary, "shadow summary");
	// The capability never crosses the read plane.
	assert.equal(JSON.stringify(context).includes(leaseRow.claim_token), false);
	assert.equal(JSON.stringify(context).includes("clt_"), false);
});

test("Task D: the exported servable predicate is the single definition the list face uses", async () => {
	const servable = documentVersionRow({
		documentId: "doc-exported-servable",
		versionId: "ver-exported-servable",
		ownContent: encoder.encode("synthetic own bytes"),
	});
	const projectionOnly = documentVersionRow({
		documentId: "doc-exported-projection",
		versionId: "ver-exported-projection",
		projectionText: "projection body",
	});
	const blocked = documentVersionRow({
		documentId: "doc-exported-blocked",
		versionId: "ver-exported-blocked",
		storedReadable: false,
	});
	const adapter = new remote.CollectorResearchRemoteAdapter(
		storageFrom(servable, projectionOnly, blocked),
		{ visibility: "PUBLIC" },
	);
	const views = await adapter.searchDocuments(undefined, 50);
	for (const view of views) {
		const documentId = view.payload.document.document_id;
		const row = [servable, projectionOnly, blocked].find(
			(candidate) => candidate.payload.document.document_id === documentId,
		);
		assert.equal(
			view.payload.version.readable,
			remote.isVersionServable(row.payload),
			`${documentId} readable must equal the exported servable predicate`,
		);
		assert.equal(remote.servableBody(row.payload) !== null, remote.isVersionServable(row.payload));
	}
	// A WITHDRAWAL version is never servable, whatever its attachments.
	const withdrawn = documentVersionRow({
		documentId: "doc-exported-withdrawal",
		versionId: "ver-exported-withdrawal",
		revisionKind: "WITHDRAWAL",
		ownContent: encoder.encode("synthetic own bytes"),
	});
	assert.equal(remote.isVersionServable(withdrawn.payload), false);
	assert.equal(remote.servableBody(withdrawn.payload), null);
});

test("Task D: semantic search is refused on the PRIVATE read face before any binding is used", async () => {
	const part = documentVersionRow({
		documentId: "doc-semantic-private",
		versionId: "ver-semantic-private",
		ownContent: encoder.encode("synthetic own bytes"),
	});
	const adapter = new remote.CollectorResearchRemoteAdapter(storageFrom(part), {
		visibility: "PRIVATE",
	});
	await assert.rejects(
		() =>
			adapter.searchDocumentsSemantic("synthetic", {
				limit: 5,
				deps: {
					ai: { run: async () => { throw new Error("must not be called"); } },
					index: { query: async () => ({ matches: [], count: 0 }) },
				},
			}),
		(error) => error?.error_code === "UNSUPPORTED_OPERATION",
	);
});
