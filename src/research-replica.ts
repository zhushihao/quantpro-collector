/**
 * C5 Collector-owned Research replica.  Research sends validated outbound-v2
 * records to this boundary; it never exposes its SQLite file, file paths, or
 * a remote database connection.  R2 is private storage, not a public origin.
 */
import {
	ResearchBoundaryError,
	outboundV2RecordKey,
	verifyOutboundV2ObjectChunks,
	verifyOutboundV2Record,
	type OutboundV2Record,
} from "./research-outbound-v2.ts";
import {
	semanticIndexIngestStatements,
	semanticIndexIngestTarget,
	type SemanticIndexTarget,
} from "./research-semantic-index.ts";
import { ftsIngestStatements } from "./research-fts.ts";

export type ResearchReplicaStorage = {
	db: D1Database;
	objects: R2Bucket;
};

export type ReplicaIngestResult = {
	status: "APPLIED" | "REPLAY";
	message_id: string;
	record_type: string;
	content_sha256: string | null;
	/**
	 * Task D: the PUBLIC document_version that now has an index-pending row.
	 * In-process only - the internal HTTP envelope stays the frozen four-key
	 * shape, and embedding never blocks the ingest receipt.
	 */
	semantic_target: SemanticIndexTarget | null;
};

// Keep the Collector below the published R2 Standard free tier while using it
// efficiently: 9.8 decimal GB of retained content (including journals) and
// 990k monthly Class A writes.  Provider billing rounds upward, so this leaves
// a small but explicit margin below 10 GB / 1m operations.
export const RESEARCH_REPLICA_MAX_STORED_BYTES = 9_800_000_000;
export const RESEARCH_REPLICA_MAX_MONTHLY_R2_WRITES = 990_000;

type ReplicaHealthRow = {
	last_attempt_at: string | null;
	last_success_at: string | null;
	last_message_id: string | null;
	last_error_code: string | null;
	accepted_messages: number;
};

function safeFailure(
	code: "INTEGRITY_FAILED" | "STORE_UNAVAILABLE" | "UNSUPPORTED_OPERATION" | "RATE_LIMITED",
): never {
	throw new ResearchBoundaryError(code);
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const object = value as Record<string, unknown>;
		return `{${Object.keys(object)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function usagePeriod(now: string): string {
	if (!/^\d{4}-\d{2}-\d{2}T/.test(now)) safeFailure("INTEGRITY_FAILED");
	return now.slice(0, 7);
}

async function reserveR2Quota(
	storage: ResearchReplicaStorage,
	bytes: number,
	writes: number,
	now: string,
): Promise<void> {
	const period = usagePeriod(now);
	await storage.db
		.prepare(
			"INSERT OR IGNORE INTO research_replica_usage (name, usage_period) VALUES ('primary', ?)",
		)
		.bind(period)
		.run();
	await storage.db
		.prepare(
			"UPDATE research_replica_usage SET usage_period=?, r2_write_ops=0 WHERE name='primary' AND usage_period<>?",
		)
		.bind(period, period)
		.run();
	const result = await storage.db
		.prepare(
			"UPDATE research_replica_usage SET stored_bytes=stored_bytes+?, r2_write_ops=r2_write_ops+? WHERE name='primary' AND stored_bytes+?<=? AND r2_write_ops+?<=?",
		)
		.bind(
			bytes,
			writes,
			bytes,
			RESEARCH_REPLICA_MAX_STORED_BYTES,
			writes,
			RESEARCH_REPLICA_MAX_MONTHLY_R2_WRITES,
		)
		.run();
	if (Number(result.meta.changes ?? 0) !== 1) safeFailure("RATE_LIMITED");
}

async function isReplay(storage: ResearchReplicaStorage, messageId: string): Promise<boolean> {
	const row = await storage.db
		.prepare("SELECT message_id FROM research_ingest_messages WHERE message_id=?")
		.bind(messageId)
		.first<{ message_id: string }>();
	return Boolean(row);
}

function objectKey(contentSha256: string): string {
	return `research-objects/sha256/${contentSha256}`;
}

function journalKey(messageId: string): string {
	return `research-replica-journal/v2/${messageId}.json`;
}

function documentObjectLinks(record: OutboundV2Record): Array<[string, string]> {
	if (record.record_type !== "document_version") return [];
	const version = record.payload.version as Record<string, unknown>;
	const attachments = record.payload.attachments as Array<Record<string, unknown>>;
	return [
		["document_body", String(version.content_sha256)],
		...attachments.map((attachment): [string, string] => [
			`attachment:${String(attachment.attachment_id)}`,
			String(attachment.content_sha256),
		]),
	];
}

function objectContentHash(record: OutboundV2Record): string | null {
	return record.record_type === "object" ? String(record.payload.content_sha256) : null;
}

/**
 * Accumulator ordering is semantic, not replica-arrival based.  The outbound
 * contract has carried created_at since v2 and the producer sets it from
 * snapshot.calculated_at.  Validate it at the boundary so malformed legacy
 * payloads cannot accidentally participate in a latest-state query.
 */
function accumulatorOrdering(record: OutboundV2Record): { subject: string | null; createdAt: string | null } {
	if (record.record_type !== "accumulator") return { subject: null, createdAt: null };
	const subject = String(record.payload.subject_key ?? "").trim();
	const createdAt = String(record.payload.created_at ?? "");
	if (!subject || !/^\d{4}-\d{2}-\d{2}T/.test(createdAt) || Number.isNaN(Date.parse(createdAt))) {
		safeFailure("INTEGRITY_FAILED");
	}
	// Canonical outbound payloads are UTC ISO timestamps.  This closes the
	// ordering surface to local-time strings and keeps D1 lexical ordering safe.
	if (!/(Z|[+-]00:00)$/.test(createdAt)) safeFailure("INTEGRITY_FAILED");
	return { subject, createdAt: new Date(createdAt).toISOString() };
}

/**
 * Store one verified message.  Re-applying the same message is a no-op for
 * logical state and reports REPLAY.  The immutable R2 journal permits safe
 * D1 recovery by sending the same record again through this function.
 */
export async function ingestResearchReplicaRecord(
	storage: ResearchReplicaStorage,
	rawRecord: unknown,
	objectChunks: Iterable<Uint8Array> | null = null,
	now = new Date().toISOString(),
): Promise<ReplicaIngestResult> {
	let record: OutboundV2Record;
	const chunks =
		objectChunks === null ? null : [...objectChunks].map((chunk) => new Uint8Array(chunk));
	try {
		const rawRecordType =
			rawRecord && typeof rawRecord === "object"
				? (rawRecord as { record_type?: unknown }).record_type
				: undefined;
		record =
			rawRecordType === "object"
				? await verifyOutboundV2ObjectChunks(rawRecord, chunks ?? [])
				: await verifyOutboundV2Record(rawRecord);
	} catch (error) {
		if (error instanceof ResearchBoundaryError) throw error;
		safeFailure("INTEGRITY_FAILED");
	}

	if (record.record_type !== "object" && chunks !== null) safeFailure("UNSUPPORTED_OPERATION");
	const key = outboundV2RecordKey(record);
	const payloadJson = canonicalJson(record.payload);
	const payloadSha256 = await sha256Hex(payloadJson);
	const contentSha256 = objectContentHash(record);
	const accumulator = accumulatorOrdering(record);
	const journal = canonicalJson(record);
	const journalBytes = new TextEncoder().encode(journal).byteLength;
	let objectBody: Uint8Array | null = null;
	if (contentSha256) {
		const size = chunks?.reduce((total, chunk) => total + chunk.byteLength, 0) ?? 0;
		objectBody = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks ?? []) {
			objectBody.set(chunk, offset);
			offset += chunk.byteLength;
		}
	}

	try {
		if (await isReplay(storage, record.message_id)) {
			return {
				status: "REPLAY",
				message_id: record.message_id,
				record_type: record.record_type,
				content_sha256: contentSha256,
				// A replay writes nothing: convergence for pre-migration rows is
				// the compensation sweep's job, never a second logical write here.
				semantic_target: null,
			};
		}
		await reserveR2Quota(
			storage,
			journalBytes + (objectBody?.byteLength ?? 0),
			contentSha256 ? 2 : 1,
			now,
		);
		// The journal is the recovery source for metadata.  It contains the
		// validated, path-free outbound envelope and is idempotent by message id.
		await storage.objects.put(journalKey(record.message_id), journal, {
			httpMetadata: { contentType: "application/json; charset=utf-8" },
		});
		if (contentSha256 && objectBody) {
			await storage.objects.put(objectKey(contentSha256), objectBody, {
				httpMetadata: { contentType: String(record.payload.media_type) },
				customMetadata: { content_sha256: contentSha256, visibility: record.visibility },
			});
		}

		const statements = [
			storage.db
				.prepare(
					"INSERT OR IGNORE INTO research_ingest_messages (message_id, record_type, record_key, visibility, payload_sha256, generated_at, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				)
				.bind(
					record.message_id,
					record.record_type,
					key,
					record.visibility,
					payloadSha256,
					record.generated_at,
					now,
				),
		storage.db
			.prepare(
				"INSERT INTO research_records (record_type, record_key, message_id, visibility, schema_version, payload_json, generated_at, updated_at, accumulator_subject_key, accumulator_created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(record_type, record_key) DO UPDATE SET message_id=excluded.message_id, visibility=excluded.visibility, schema_version=excluded.schema_version, payload_json=excluded.payload_json, generated_at=excluded.generated_at, updated_at=excluded.updated_at, accumulator_subject_key=excluded.accumulator_subject_key, accumulator_created_at=excluded.accumulator_created_at WHERE NOT (research_records.record_type='evidence' AND research_records.schema_version='collector-outbound-v4' AND excluded.schema_version<>'collector-outbound-v4')",
				)
				.bind(
					record.record_type,
					key,
					record.message_id,
					record.visibility,
					record.schema_version,
					payloadJson,
					record.generated_at,
					now,
					accumulator.subject,
					accumulator.createdAt,
				),
		];
		if (contentSha256) {
			statements.push(
				storage.db
					.prepare(
						"INSERT INTO research_objects (content_sha256, message_id, visibility, media_type, byte_size, state, received_at) VALUES (?, ?, ?, ?, ?, 'READY', ?) ON CONFLICT(content_sha256) DO UPDATE SET message_id=excluded.message_id, visibility=excluded.visibility, media_type=excluded.media_type, byte_size=excluded.byte_size, state='READY', received_at=excluded.received_at",
					)
					.bind(
						contentSha256,
						record.message_id,
						record.visibility,
						String(record.payload.media_type),
						Number(record.payload.byte_size),
						now,
					),
			);
		}
		for (const [role, linkedHash] of documentObjectLinks(record)) {
			statements.push(
				storage.db
					.prepare(
						"INSERT INTO research_record_objects (record_type, record_key, role, content_sha256, visibility) VALUES (?, ?, ?, ?, ?) ON CONFLICT(record_type, record_key, role, content_sha256) DO UPDATE SET visibility=excluded.visibility",
					)
					.bind(record.record_type, key, role, linkedHash, record.visibility),
			);
		}
		// Task D: PUBLIC document versions register their semantic-index pending
		// row in this same transaction (no crash window between "stored" and
		// "index pending"), and a servable incoming version invalidates the
		// document's other versions so superseded vector ids stop being
		// eligible before any asynchronous delete.  Embedding itself is never
		// part of the ingest receipt.
		statements.push(...semanticIndexIngestStatements(storage.db, record, now));
		statements.push(...ftsIngestStatements(storage.db, record, key));
		const results = await storage.db.batch(statements);
		const inserted = Number(results[0]?.meta.changes ?? 0) === 1;
		await storage.db
			.prepare(
				"UPDATE research_replica_health SET last_attempt_at=?, last_success_at=?, last_message_id=?, last_error_code=NULL, accepted_messages=accepted_messages + ? WHERE name='primary'",
			)
			.bind(now, now, record.message_id, inserted ? 1 : 0)
			.run();
		return {
			status: inserted ? "APPLIED" : "REPLAY",
			message_id: record.message_id,
			record_type: record.record_type,
			content_sha256: contentSha256,
			semantic_target: semanticIndexIngestTarget(record),
		};
	} catch (error) {
		if (error instanceof ResearchBoundaryError) throw error;
		try {
			await storage.db
				.prepare(
					"UPDATE research_replica_health SET last_attempt_at=?, last_error_code='STORE_UNAVAILABLE' WHERE name='primary'",
				)
				.bind(now)
				.run();
		} catch {
			// The caller still gets the same closed error if health itself is unavailable.
		}
		safeFailure("STORE_UNAVAILABLE");
	}
}

export async function readResearchReplicaHealth(
	storage: ResearchReplicaStorage,
): Promise<ReplicaHealthRow> {
	try {
		const row = await storage.db
			.prepare(
				"SELECT last_attempt_at, last_success_at, last_message_id, last_error_code, accepted_messages FROM research_replica_health WHERE name='primary'",
			)
			.first<ReplicaHealthRow>();
		if (!row) safeFailure("STORE_UNAVAILABLE");
		return row;
	} catch (error) {
		if (error instanceof ResearchBoundaryError) throw error;
		safeFailure("STORE_UNAVAILABLE");
	}
}
