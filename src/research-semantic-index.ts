/**
 * Task D: Collector PUBLIC semantic index over the D1/R2 research replica.
 *
 * Contract (spec §"向量范围、增量与存量一致性", plan task D):
 *
 * 1. Scope is the Collector **PUBLIC** `document_version` current servable
 *    version.  Text comes only from D1 metadata plus the R2 object whose
 *    SHA-256 is re-verified before use; PRIVATE rows are structurally
 *    excluded (the D1 sidecar constrains visibility to PUBLIC, and the read
 *    side never leaves the PUBLIC visibility).
 * 2. One Vectorize index (`research-public-bge-m3-v1`, 1024 dims, cosine)
 *    built with Workers AI `@cf/baai/bge-m3`.  Vector ids are deterministic
 *    and carry no identifier: sha256(document_id ‖ version_id ‖ chunk
 *    ordinal).  Vector metadata carries only PUBLIC identifiers plus the
 *    model id.
 * 3. `research_semantic_index_state` (migration 0012) is the authoritative
 *    queue and the query-time validation sidecar.  Ingest registers PUBLIC
 *    pending rows inside the same D1 batch that persists the record, so no
 *    crash window exists between "record stored" and "index pending"; the
 *    compensation sweep covers REPLAY, pre-migration rows, object-before-
 *    metadata and metadata-before-object orderings.
 * 4. Vectorize mutations are eventually consistent.  A replaced or withdrawn
 *    version first becomes invisible in D1 (`retired_at` plus the live
 *    current-version re-resolution at query time) and only then has its
 *    vectors deleted asynchronously.  Query results are always re-validated
 *    against D1, so a stale vector can never be served.
 * 5. Batches are bounded: <=10 documents per Worker run, <=100 vectors per
 *    embed/upsert call, <=30s wall-clock budget, resumable (claim marker +
 *    idempotent upsert by deterministic id).
 */
import { ResearchBoundaryError } from "./research-outbound-v2.ts";
import type { OutboundV2Record } from "./research-outbound-v2.ts";
import { isVersionServable, servableBody } from "./research-remote-adapter.ts";

/** Workers AI embedding model (spec Q3). */
export const SEMANTIC_MODEL_ID = "@cf/baai/bge-m3";
/** The single PUBLIC Vectorize index bound as RESEARCH_PUBLIC_INDEX. */
export const SEMANTIC_INDEX_NAME = "research-public-bge-m3-v1";
/** bge-m3 output dimensions (deployment-time probe verifies the real value). */
export const SEMANTIC_VECTOR_DIMENSIONS = 1024;
/** Index metric locked at creation time; the binding API cannot read it back. */
export const SEMANTIC_INDEX_METRIC = "cosine";

export const SEMANTIC_CHUNK_CHARS = 1200;
export const SEMANTIC_CHUNK_OVERLAP_CHARS = 150;
export const SEMANTIC_MAX_CHUNKS = 32;
export const SEMANTIC_EMBED_BATCH_LIMIT = 100;
export const SEMANTIC_BATCH_MAX_DOCS = 10;
export const SEMANTIC_BATCH_BUDGET_MS = 30_000;
export const SEMANTIC_MAX_ATTEMPTS = 5;
export const SEMANTIC_CLAIM_STALE_MS = 5 * 60 * 1000;
export const SEMANTIC_DEAD_LETTER_RETRY_MS = 6 * 60 * 60 * 1000;
export const SEMANTIC_REGISTER_PAGE = 200;
export const SEMANTIC_REVIVE_PAGE = 50;
export const SEMANTIC_AUDIT_PAGE = 50;
export const SEMANTIC_CLEANUP_PAGE = 10;
export const SEMANTIC_QUERY_MAX_LIMIT = 20;
export const SEMANTIC_QUERY_MAX_QUERY_CHARS = 500;
export const SEMANTIC_QUERY_OVERFETCH_FACTOR = 4;
/**
 * Over-fetch ceiling.  Kept at the conservative Vectorize topK bound (50) and
 * below the metadata-retrieval limit so the deployment cannot hit a service
 * ceiling for any accepted `limit` (<=20).
 */
export const SEMANTIC_QUERY_OVERFETCH_MAX = 50;
/**
 * `indexed` retrieval is the free level and returns exactly the short PUBLIC
 * identifiers this module attaches at upsert time; `all` would pay extra reads
 * for un-indexed metadata the semantic face never stores.
 */
export const SEMANTIC_METADATA_RETRIEVAL = "indexed";
export const SEMANTIC_SNIPPET_CHARS = 240;
export const SEMANTIC_TITLE_CHARS = 200;
export const SEMANTIC_VECTOR_ID_PREFIX = "rsv1_";

/** By-design dead letters that the retry sweep never revives. */
export const SEMANTIC_SUPERSEDED_CODE = "SUPERSEDED";
export const SEMANTIC_TEXT_UNAVAILABLE_CODE = "TEXT_UNAVAILABLE";
export const SEMANTIC_OBJECT_PENDING_CODE = "OBJECT_PENDING";
export const SEMANTIC_RECORD_PENDING_CODE = "RECORD_PENDING";
export const SEMANTIC_IN_PROGRESS_CODE = "IN_PROGRESS";

export type SemanticIndexStorage = { db: D1Database; objects: R2Bucket };
export type SemanticIndexDeps = { ai: Ai; index: Vectorize };

export type SemanticIndexStateRow = {
	document_id: string;
	version_id: string;
	visibility: string;
	state: string;
	content_sha256: string | null;
	model_id: string;
	title_only: number;
	truncated: number;
	expected_chunks: number;
	confirmed_chunks: number;
	attempts: number;
	last_error_code: string | null;
	retired_at: string | null;
	vector_deleted_at: string | null;
	registered_at: string;
	updated_at: string;
};

export type SemanticChunk = { ordinal: number; text: string };

export type SemanticSearchMatch = {
	document_id: string;
	version_id: string;
	title: string;
	score: number;
	snippet: string;
	source_kind: string | null;
	published_at: string | null;
};

export type SemanticSearchResult = {
	matches: SemanticSearchMatch[];
	index_status: "READY" | "PARTIAL";
};

export type SemanticBatchReport = {
	registered: number;
	revived: number;
	ready: number;
	pending: number;
	failed: number;
	superseded: number;
	vectors_upserted: number;
	vectors_deleted: number;
};

type SemanticFailureCode =
	| "EMBEDDING_UNAVAILABLE"
	| "INDEX_UNAVAILABLE"
	| "MODEL_RESPONSE_INVALID"
	| "MODEL_DIMENSION_MISMATCH";

function fail(code: SemanticFailureCode, retryable: boolean, safeMessage: string): never {
	throw new ResearchBoundaryError("STORE_UNAVAILABLE", undefined, { retryable, safeMessage });
}

function boundaryFailure(error: unknown): never {
	if (error instanceof ResearchBoundaryError) throw error;
	fail("INDEX_UNAVAILABLE", true, "semantic index backend is unavailable; retry later");
}

/** Internal option parsing: out-of-range values clamp instead of failing. */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
	if (value === undefined || value === null) return fallback;
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) return fallback;
	return Math.min(Math.max(Math.trunc(numeric), min), max);
}

function isHexSha256(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

async function sha256HexOfText(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function objectKey(contentSha256: string): string {
	return `research-objects/sha256/${contentSha256}`;
}

/* ------------------------------------------------------------------ */
/* Text normalization, chunking and deterministic vector ids           */
/* ------------------------------------------------------------------ */

/**
 * Unicode NFC, drop control characters (keeping paragraph breaks), collapse
 * runs of blanks.  Applied before chunking so the same bytes always produce
 * the same chunks on both sides of the index.
 */
export function normalizeSemanticText(value: string): string {
	return (
		value
			.normalize("NFC")
			// eslint-disable-next-line no-control-regex -- control characters are exactly what must be stripped
			.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
			.replace(/\t/g, " ")
			.replace(/[ \u00a0]{2,}/g, " ")
			.replace(/ *\n */g, "\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim()
	);
}

/** Sentence/paragraph boundaries preferred over mid-sentence hard cuts. */
const SEMANTIC_BOUNDARY = /[。！？；!?;.\n]["'”’）)】\]」』]?/g;

function segmentText(text: string, maxSegment: number): string[] {
	const segments: string[] = [];
	let start = 0;
	SEMANTIC_BOUNDARY.lastIndex = 0;
	for (let match = SEMANTIC_BOUNDARY.exec(text); match; match = SEMANTIC_BOUNDARY.exec(text)) {
		const end = match.index + match[0].length;
		if (end - start > maxSegment) continue;
		segments.push(text.slice(start, end));
		start = end;
	}
	if (start < text.length) segments.push(text.slice(start));
	const bounded: string[] = [];
	for (const segment of segments) {
		let value = segment;
		while (value.length > maxSegment) {
			bounded.push(value.slice(0, maxSegment));
			value = value.slice(maxSegment);
		}
		if (value) bounded.push(value);
	}
	return bounded;
}

function overlapTail(text: string): string {
	if (text.length <= SEMANTIC_CHUNK_OVERLAP_CHARS) return text;
	const tailStart = text.length - SEMANTIC_CHUNK_OVERLAP_CHARS;
	const boundary = text.indexOf("\n", tailStart);
	if (boundary >= 0 && boundary - tailStart <= SEMANTIC_CHUNK_OVERLAP_CHARS / 2) {
		return text.slice(boundary + 1);
	}
	return text.slice(tailStart);
}

/**
 * Split normalized text into chunks of at most SEMANTIC_CHUNK_CHARS with a
 * SEMANTIC_CHUNK_OVERLAP_CHARS tail overlap, then enforce SEMANTIC_MAX_CHUNKS
 * by head+tail sampling.  Sampling renumbers ordinals deterministically and
 * reports `truncated` so no caller can mistake the result for full coverage.
 */
export function chunkSemanticDocument(text: string): {
	chunks: SemanticChunk[];
	truncated: boolean;
} {
	const normalized = normalizeSemanticText(text);
	if (!normalized) return { chunks: [], truncated: false };
	const maxSegment = SEMANTIC_CHUNK_CHARS - SEMANTIC_CHUNK_OVERLAP_CHARS;
	const segments = segmentText(normalized, maxSegment);
	const chunks: string[] = [];
	let current = "";
	for (const segment of segments) {
		if (current && current.length + segment.length > SEMANTIC_CHUNK_CHARS) {
			chunks.push(current);
			current = overlapTail(current) + segment;
		} else {
			current += segment;
		}
	}
	if (current) chunks.push(current);
	let ordered = chunks.map((value, ordinal) => ({ ordinal, text: value }));
	let truncated = false;
	if (ordered.length > SEMANTIC_MAX_CHUNKS) {
		const head = Math.ceil(SEMANTIC_MAX_CHUNKS / 2);
		const tail = SEMANTIC_MAX_CHUNKS - head;
		ordered = [...ordered.slice(0, head), ...ordered.slice(ordered.length - tail)];
		ordered = ordered.map((chunk, ordinal) => ({ ordinal, text: chunk.text }));
		truncated = true;
	}
	return { chunks: ordered, truncated };
}

/**
 * Deterministic, identifier-free vector id: sha256 over the PUBLIC
 * document/version ids plus the chunk ordinal.  Deleting a version's vectors
 * needs only the ordinal range, never a stored mapping.
 */
export async function semanticVectorId(
	documentId: string,
	versionId: string,
	ordinal: number,
): Promise<string> {
	const digest = await sha256HexOfText(`${documentId}\u001f${versionId}\u001f${ordinal}`);
	return `${SEMANTIC_VECTOR_ID_PREFIX}${digest.slice(0, 32)}`;
}

async function semanticVectorIds(
	documentId: string,
	versionId: string,
	ordinals: number,
): Promise<string[]> {
	const ids: string[] = [];
	for (let ordinal = 0; ordinal < ordinals; ordinal += 1) {
		ids.push(await semanticVectorId(documentId, versionId, ordinal));
	}
	return ids;
}

/* ------------------------------------------------------------------ */
/* Workers AI / Vectorize adapters                                     */
/* ------------------------------------------------------------------ */

/** Provider call plus shape validation only; dimension policy lives in callers. */
async function runEmbedding(ai: Ai, texts: string[]): Promise<number[][]> {
	if (texts.length < 1 || texts.length > SEMANTIC_EMBED_BATCH_LIMIT) {
		fail(
			"MODEL_RESPONSE_INVALID",
			false,
			"embedding batch size is outside the supported range",
		);
	}
	let raw: unknown;
	try {
		raw = await ai.run(SEMANTIC_MODEL_ID, { text: texts, truncate_inputs: false });
	} catch {
		fail("EMBEDDING_UNAVAILABLE", true, "embedding provider is unavailable; retry later");
	}
	const data = (raw as { data?: unknown } | null)?.data;
	if (!Array.isArray(data) || data.length !== texts.length) {
		fail("MODEL_RESPONSE_INVALID", false, "embedding provider returned an unexpected shape");
	}
	const vectors: number[][] = [];
	for (const candidate of data) {
		if (
			!Array.isArray(candidate) ||
			candidate.length === 0 ||
			!candidate.every((value) => typeof value === "number" && Number.isFinite(value))
		) {
			fail(
				"MODEL_RESPONSE_INVALID",
				false,
				"embedding provider returned a non-numeric vector",
			);
		}
		vectors.push(candidate as number[]);
	}
	return vectors;
}

async function embedTexts(ai: Ai, texts: string[]): Promise<number[][]> {
	for (const text of texts) {
		if (typeof text !== "string" || text.length === 0 || text.length > SEMANTIC_CHUNK_CHARS) {
			fail(
				"MODEL_RESPONSE_INVALID",
				false,
				"embedding input is outside the supported size range",
			);
		}
	}
	const vectors = await runEmbedding(ai, texts);
	for (const vector of vectors) {
		if (vector.length !== SEMANTIC_VECTOR_DIMENSIONS) {
			fail(
				"MODEL_DIMENSION_MISMATCH",
				false,
				`embedding provider returned ${vector.length} dimensions; the index expects ${SEMANTIC_VECTOR_DIMENSIONS}`,
			);
		}
	}
	return vectors;
}

type SemanticVectorMatch = {
	id: string;
	score: number;
	metadata: Record<string, unknown> | null;
};

async function queryVectorIndex(
	index: Vectorize,
	vector: number[],
	topK: number,
): Promise<SemanticVectorMatch[]> {
	let raw: unknown;
	try {
		raw = await index.query(vector, {
			topK,
			returnMetadata: SEMANTIC_METADATA_RETRIEVAL,
			returnValues: false,
		});
	} catch {
		fail("INDEX_UNAVAILABLE", true, "vector index is unavailable; retry later");
	}
	const matches = (raw as { matches?: unknown } | null)?.matches;
	if (!Array.isArray(matches)) {
		fail("INDEX_UNAVAILABLE", true, "vector index returned an unexpected shape");
	}
	const parsed: SemanticVectorMatch[] = [];
	for (const match of matches) {
		const candidate = match as { id?: unknown; score?: unknown; metadata?: unknown };
		if (typeof candidate?.id !== "string") continue;
		const score =
			typeof candidate.score === "number" && Number.isFinite(candidate.score)
				? candidate.score
				: 0;
		const metadata =
			candidate.metadata &&
			typeof candidate.metadata === "object" &&
			!Array.isArray(candidate.metadata)
				? (candidate.metadata as Record<string, unknown>)
				: null;
		parsed.push({ id: candidate.id, score, metadata });
	}
	return parsed;
}

/* ------------------------------------------------------------------ */
/* Ingest-time registration (runs inside the replica D1 batch)         */
/* ------------------------------------------------------------------ */

export type SemanticIndexTarget = { documentId: string; versionId: string };

/** The PUBLIC document_version target of a validated outbound record, if any. */
export function semanticIndexIngestTarget(record: OutboundV2Record): SemanticIndexTarget | null {
	if (record.record_type !== "document_version" || record.visibility !== "PUBLIC") return null;
	const payload = record.payload as {
		document?: Record<string, unknown>;
		version?: Record<string, unknown>;
	};
	const documentId = payload?.document?.document_id;
	const versionId = payload?.version?.version_id;
	if (typeof documentId !== "string" || !documentId) return null;
	if (typeof versionId !== "string" || !versionId) return null;
	return { documentId, versionId };
}

/**
 * Keep an already-READY row only when the incoming version is byte-identical
 * for the same model and its chunk accounting is complete; every other case
 * (content change, model change, previous failure, superseded row) returns to
 * PENDING so the work queue and the read path converge.
 */
const KEEP_READY_CONDITION =
	"research_semantic_index_state.state='READY' AND research_semantic_index_state.confirmed_chunks=research_semantic_index_state.expected_chunks AND research_semantic_index_state.confirmed_chunks>0 AND research_semantic_index_state.content_sha256 IS excluded.content_sha256 AND research_semantic_index_state.model_id=excluded.model_id";

/**
 * D1 statements appended to the replica ingest batch for a PUBLIC
 * document_version: (1) register/refresh the pending row, (2) when the
 * incoming version is servable, invalidate the document's other versions so
 * superseded vector ids stop being eligible before any asynchronous delete.
 * Runs in the same transaction as the record write, so a crash cannot leave a
 * stored PUBLIC version without its index-pending registration.
 */
export function semanticIndexIngestStatements(
	db: D1Database,
	record: OutboundV2Record,
	now: string,
): D1PreparedStatement[] {
	const target = semanticIndexIngestTarget(record);
	if (!target) return [];
	const version = (record.payload as { version?: Record<string, unknown> }).version ?? {};
	const contentSha256 = isHexSha256(version.content_sha256) ? version.content_sha256 : null;
	const statements = [
		db
			.prepare(
				`INSERT INTO research_semantic_index_state (document_id, version_id, visibility, state, content_sha256, model_id, title_only, truncated, expected_chunks, confirmed_chunks, attempts, last_error_code, retired_at, vector_deleted_at, registered_at, updated_at) VALUES (?, ?, 'PUBLIC', 'PENDING', ?, ?, 0, 0, 0, 0, 0, NULL, NULL, NULL, ?, ?) ON CONFLICT(document_id, version_id) DO UPDATE SET content_sha256=excluded.content_sha256, model_id=excluded.model_id, retired_at=NULL, vector_deleted_at=NULL, state=CASE WHEN ${KEEP_READY_CONDITION} THEN 'READY' ELSE 'PENDING' END, expected_chunks=CASE WHEN ${KEEP_READY_CONDITION} THEN research_semantic_index_state.expected_chunks ELSE 0 END, confirmed_chunks=CASE WHEN ${KEEP_READY_CONDITION} THEN research_semantic_index_state.confirmed_chunks ELSE 0 END, attempts=CASE WHEN ${KEEP_READY_CONDITION} THEN research_semantic_index_state.attempts ELSE 0 END, last_error_code=CASE WHEN ${KEEP_READY_CONDITION} THEN research_semantic_index_state.last_error_code ELSE NULL END, updated_at=excluded.updated_at`,
			)
			.bind(target.documentId, target.versionId, contentSha256, SEMANTIC_MODEL_ID, now, now),
	];
	if (!isVersionServable(record.payload)) return statements;
	statements.push(
		db
			.prepare(
				"UPDATE research_semantic_index_state SET state='FAILED', expected_chunks=0, confirmed_chunks=0, last_error_code=?, retired_at=?, updated_at=? WHERE visibility='PUBLIC' AND document_id=? AND version_id<>? AND retired_at IS NULL",
			)
			.bind(SEMANTIC_SUPERSEDED_CODE, now, now, target.documentId, target.versionId),
	);
	return statements;
}

/* ------------------------------------------------------------------ */
/* Work queue: claim, reconcile, revive, cleanup                       */
/* ------------------------------------------------------------------ */

const STATE_COLUMNS =
	"document_id, version_id, visibility, state, content_sha256, model_id, title_only, truncated, expected_chunks, confirmed_chunks, attempts, last_error_code, retired_at, vector_deleted_at, registered_at, updated_at";

/**
 * Retention (owner ruling): a document marked EXPIRED in
 * `research_document_retention` must never be claimed for indexing, even when
 * a re-ingest un-retired one of its state rows between the mark and the purge.
 * The expired doc is already invisible to every read face; indexing it would
 * only burn embeddings for vectors that the purge deletes.
 */
const NOT_EXPIRED_BY_RETENTION =
	"NOT EXISTS (SELECT 1 FROM research_document_retention ret WHERE ret.document_id=research_semantic_index_state.document_id AND ret.status='EXPIRED')";

async function claimPendingRow(
	storage: SemanticIndexStorage,
	row: SemanticIndexStateRow,
	now: string,
): Promise<boolean> {
	const staleBefore = new Date(Date.parse(now) - SEMANTIC_CLAIM_STALE_MS).toISOString();
	const result = await storage.db
		.prepare(
			"UPDATE research_semantic_index_state SET updated_at=?, last_error_code=? WHERE visibility='PUBLIC' AND document_id=? AND version_id=? AND state='PENDING' AND retired_at IS NULL AND (last_error_code IS NULL OR last_error_code<>? OR updated_at<?)",
		)
		.bind(
			now,
			SEMANTIC_IN_PROGRESS_CODE,
			row.document_id,
			row.version_id,
			SEMANTIC_IN_PROGRESS_CODE,
			staleBefore,
		)
		.run();
	return Number(result.meta?.changes ?? 0) === 1;
}

/**
 * Compensation registration: every PUBLIC document_version without a state
 * row becomes PENDING.  Pure SQL with a stable keyset (`record_key`, i.e. the
 * version id), so repeated bounded runs advance past already-registered rows
 * and the tail of a 10k+ set can never be permanently outside a window.
 */
export async function registerMissingPublicVersions(
	storage: SemanticIndexStorage,
	now: string,
	limit = SEMANTIC_REGISTER_PAGE,
): Promise<number> {
	const page = clampInt(limit, SEMANTIC_REGISTER_PAGE, 1, 5000);
	const result = await storage.db
		.prepare(
			`INSERT INTO research_semantic_index_state (document_id, version_id, visibility, state, content_sha256, model_id, title_only, truncated, expected_chunks, confirmed_chunks, attempts, last_error_code, retired_at, vector_deleted_at, registered_at, updated_at) SELECT json_extract(research_records.payload_json, '$.document.document_id'), research_records.record_key, 'PUBLIC', 'PENDING', NULL, ?, 0, 0, 0, 0, 0, NULL, NULL, NULL, ?, ? FROM research_records WHERE research_records.record_type='document_version' AND research_records.visibility='PUBLIC' AND json_extract(research_records.payload_json, '$.document.document_id') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM research_semantic_index_state existing WHERE existing.document_id=json_extract(research_records.payload_json, '$.document.document_id') AND existing.version_id=research_records.record_key) ORDER BY research_records.record_key LIMIT ?`,
		)
		.bind(SEMANTIC_MODEL_ID, now, now, page)
		.run();
	return Number(result.meta?.changes ?? 0);
}

/**
 * Revive expired dead letters that are not permanent by design, so a
 * transient embedding/upsert outage self-heals without operator action.
 */
export async function reviveExpiredDeadLetters(
	storage: SemanticIndexStorage,
	now: string,
	limit = SEMANTIC_REVIVE_PAGE,
): Promise<number> {
	const page = clampInt(limit, SEMANTIC_REVIVE_PAGE, 1, 500);
	const cutoff = new Date(Date.parse(now) - SEMANTIC_DEAD_LETTER_RETRY_MS).toISOString();
	const result = await storage.db
		.prepare(
			"UPDATE research_semantic_index_state SET state='PENDING', attempts=0, expected_chunks=0, confirmed_chunks=0, last_error_code=NULL, updated_at=? WHERE visibility='PUBLIC' AND state='FAILED' AND retired_at IS NULL AND (last_error_code IS NULL OR (last_error_code<>? AND last_error_code<>?)) AND updated_at<? AND (document_id, version_id) IN (SELECT document_id, version_id FROM research_semantic_index_state WHERE visibility='PUBLIC' AND state='FAILED' AND retired_at IS NULL AND updated_at<? ORDER BY updated_at, document_id, version_id LIMIT ?)",
		)
		.bind(now, SEMANTIC_SUPERSEDED_CODE, SEMANTIC_TEXT_UNAVAILABLE_CODE, cutoff, cutoff, page)
		.run();
	return Number(result.meta?.changes ?? 0);
}

/**
 * A version that was superseded earlier may be current again (for example a
 * withdrawal of the newer version).  Re-resolve the document and move the row
 * back into the work queue, discarding any deleted-vector marker.
 */
async function reviveCurrentSupersededRows(
	storage: SemanticIndexStorage,
	now: string,
	limit = SEMANTIC_REVIVE_PAGE,
): Promise<number> {
	const candidates = await storage.db
		.prepare(
			`SELECT ${STATE_COLUMNS} FROM research_semantic_index_state WHERE visibility='PUBLIC' AND state='FAILED' AND retired_at IS NOT NULL AND last_error_code=? ORDER BY updated_at, document_id, version_id LIMIT ?`,
		)
		.bind(SEMANTIC_SUPERSEDED_CODE, clampInt(limit, SEMANTIC_REVIVE_PAGE, 1, 500))
		.all<SemanticIndexStateRow>();
	let revived = 0;
	for (const row of candidates.results ?? []) {
		const current = await currentServableVersion(storage, row.document_id);
		if (!current || current.versionId !== row.version_id) continue;
		const result = await storage.db
			.prepare(
				"UPDATE research_semantic_index_state SET state='PENDING', retired_at=NULL, vector_deleted_at=NULL, expected_chunks=0, confirmed_chunks=0, attempts=0, last_error_code=NULL, updated_at=? WHERE visibility='PUBLIC' AND document_id=? AND version_id=? AND state='FAILED'",
			)
			.bind(now, row.document_id, row.version_id)
			.run();
		revived += Number(result.meta?.changes ?? 0);
	}
	return revived;
}

type VersionCandidate = {
	versionId: string;
	payload: Record<string, unknown>;
	version: Record<string, unknown>;
	document: Record<string, unknown>;
};

function versionOrdering(candidates: VersionCandidate[]): VersionCandidate[] {
	return [...candidates].sort((a, b) => {
		const left = Number(a.version.version_number);
		const right = Number(b.version.version_number);
		const leftValue = Number.isFinite(left) ? left : Number.NEGATIVE_INFINITY;
		const rightValue = Number.isFinite(right) ? right : Number.NEGATIVE_INFINITY;
		if (rightValue !== leftValue) return rightValue - leftValue;
		return a.versionId < b.versionId ? -1 : a.versionId > b.versionId ? 1 : 0;
	});
}

async function documentVersions(
	storage: SemanticIndexStorage,
	documentId: string,
): Promise<VersionCandidate[]> {
	const result = await storage.db
		.prepare(
			"SELECT record_key, payload_json FROM research_records WHERE record_type='document_version' AND visibility='PUBLIC' AND json_extract(payload_json, '$.document.document_id')=?",
		)
		.bind(documentId)
		.all<{ record_key: string; payload_json: string }>();
	const candidates: VersionCandidate[] = [];
	for (const row of result.results ?? []) {
		let payload: Record<string, unknown>;
		try {
			const parsed = JSON.parse(row.payload_json);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
			payload = parsed as Record<string, unknown>;
		} catch {
			continue;
		}
		const document = (payload.document ?? {}) as Record<string, unknown>;
		const version = (payload.version ?? {}) as Record<string, unknown>;
		if (typeof version.version_id !== "string") continue;
		candidates.push({ versionId: version.version_id, payload, version, document });
	}
	return versionOrdering(candidates);
}

/** The version `get_document` would serve: highest version_number, first servable. */
async function currentServableVersion(
	storage: SemanticIndexStorage,
	documentId: string,
): Promise<VersionCandidate | null> {
	return (await currentVersionCandidate(storage, documentId)).candidate;
}

/**
 * The current candidate plus whether it is actually servable.  When no version
 * of the document is servable at all, the highest-numbered version is still
 * "current" for indexing purposes: it must become a counted TEXT_UNAVAILABLE
 * dead letter instead of being dismissed as merely superseded.
 */
async function currentVersionCandidate(
	storage: SemanticIndexStorage,
	documentId: string,
): Promise<{ candidate: VersionCandidate | null; servable: boolean }> {
	const candidates = await documentVersions(storage, documentId);
	const servable = candidates.find((item) => isVersionServable(item.payload)) ?? null;
	if (servable) return { candidate: servable, servable: true };
	return { candidate: candidates[0] ?? null, servable: false };
}

/* ------------------------------------------------------------------ */
/* Per-document indexing                                               */
/* ------------------------------------------------------------------ */

type DocumentText = { text: string; titleOnly: boolean };

function documentTitle(candidate: VersionCandidate): string {
	const title = candidate.document.title;
	return typeof title === "string"
		? normalizeSemanticText(title).slice(0, SEMANTIC_TITLE_CHARS)
		: "";
}

/**
 * The single composition rule shared by the indexer and the query face:
 * normalized title + readable body, or a title-only chunk.  Both sides must
 * derive byte-identical text, otherwise a re-chunked snippet would not match
 * the chunk the vector was built from.
 */
function composeSemanticText(title: string, bodyText: string | null): DocumentText | null {
	const normalizedBody = bodyText === null ? "" : normalizeSemanticText(bodyText);
	if (normalizedBody) {
		return {
			text: title ? `${title}\n\n${normalizedBody}` : normalizedBody,
			titleOnly: false,
		};
	}
	return title ? { text: title, titleOnly: true } : null;
}

/**
 * Embedding text is "title + readable body".  A version without a readable
 * body still contributes a title-only chunk (marked `title_only`); when there
 * is neither body nor usable title the version is skipped and counted, never
 * replaced with invented text (no OCR fabrication).
 */
async function loadDocumentText(
	storage: SemanticIndexStorage,
	candidate: VersionCandidate,
): Promise<{
	text: DocumentText | null;
	contentSha256: string | null;
	dependencyMissing: boolean;
}> {
	const title = documentTitle(candidate);
	const body = servableBody(candidate.payload);
	if (!body) {
		return {
			text: composeSemanticText(title, null),
			contentSha256: null,
			dependencyMissing: false,
		};
	}
	const object = await storage.objects.get(objectKey(body.contentSha256));
	if (!object) {
		return { text: null, contentSha256: body.contentSha256, dependencyMissing: true };
	}
	const bytes = await object.arrayBuffer();
	if ((await sha256Hex(bytes)) !== body.contentSha256) {
		throw new ResearchBoundaryError("INTEGRITY_FAILED");
	}
	const decoded = new TextDecoder().decode(bytes);
	if (!normalizeSemanticText(decoded)) {
		return {
			text: composeSemanticText(title, null),
			contentSha256: body.contentSha256,
			dependencyMissing: false,
		};
	}
	return {
		text: composeSemanticText(title, decoded),
		contentSha256: body.contentSha256,
		dependencyMissing: false,
	};
}

export type DocumentOutcome = {
	status: "READY" | "PENDING" | "FAILED" | "SUPERSEDED";
	vectors: number;
};

async function markRow(
	storage: SemanticIndexStorage,
	row: SemanticIndexStateRow,
	now: string,
	patch: {
		state: "PENDING" | "READY" | "FAILED";
		contentSha256?: string | null;
		titleOnly?: number;
		truncated?: number;
		expectedChunks?: number;
		confirmedChunks?: number;
		attempts?: number;
		lastErrorCode: string | null;
		retired?: boolean;
	},
): Promise<number> {
	const result = await storage.db
		.prepare(
			"UPDATE research_semantic_index_state SET state=?, content_sha256=?, title_only=?, truncated=?, expected_chunks=?, confirmed_chunks=?, attempts=?, last_error_code=?, model_id=?, updated_at=?, retired_at=CASE WHEN ?=1 THEN COALESCE(retired_at, ?) ELSE retired_at END WHERE visibility='PUBLIC' AND document_id=? AND version_id=? AND retired_at IS NULL",
		)
		.bind(
			patch.state,
			patch.contentSha256 === undefined ? row.content_sha256 : patch.contentSha256,
			patch.titleOnly ?? row.title_only,
			patch.truncated ?? row.truncated,
			patch.expectedChunks ?? row.expected_chunks,
			patch.confirmedChunks ?? row.confirmed_chunks,
			patch.attempts ?? row.attempts,
			patch.lastErrorCode,
			SEMANTIC_MODEL_ID,
			now,
			patch.retired ? 1 : 0,
			now,
			row.document_id,
			row.version_id,
		)
		.run();
	return Number(result.meta?.changes ?? 0);
}

/**
 * Index one claimed row.  Dependency-missing outcomes stay PENDING without
 * spending the retry budget (the object or record may still arrive); embed or
 * upsert failures spend it and dead-letter after SEMANTIC_MAX_ATTEMPTS.
 */
async function indexClaimedRow(
	storage: SemanticIndexStorage,
	deps: SemanticIndexDeps,
	row: SemanticIndexStateRow,
	now: string,
): Promise<DocumentOutcome> {
	const candidates = await documentVersions(storage, row.document_id);
	const candidate = candidates.find((item) => item.versionId === row.version_id) ?? null;
	if (!candidate) {
		await markRow(storage, row, now, {
			state: "PENDING",
			lastErrorCode: SEMANTIC_RECORD_PENDING_CODE,
		});
		return { status: "PENDING", vectors: 0 };
	}
	const current = (await currentVersionCandidate(storage, row.document_id)).candidate;
	if (!current || current.versionId !== row.version_id) {
		await markRow(storage, row, now, {
			state: "FAILED",
			expectedChunks: 0,
			confirmedChunks: 0,
			lastErrorCode: SEMANTIC_SUPERSEDED_CODE,
			retired: true,
		});
		return { status: "SUPERSEDED", vectors: 0 };
	}
	const loaded = await loadDocumentText(storage, candidate);
	if (loaded.dependencyMissing) {
		await markRow(storage, row, now, {
			state: "PENDING",
			contentSha256: loaded.contentSha256,
			lastErrorCode: SEMANTIC_OBJECT_PENDING_CODE,
		});
		return { status: "PENDING", vectors: 0 };
	}
	if (!loaded.text) {
		await markRow(storage, row, now, {
			state: "FAILED",
			contentSha256: null,
			titleOnly: 0,
			truncated: 0,
			expectedChunks: 0,
			confirmedChunks: 0,
			lastErrorCode: SEMANTIC_TEXT_UNAVAILABLE_CODE,
		});
		return { status: "FAILED", vectors: 0 };
	}
	const { chunks, truncated } = chunkSemanticDocument(loaded.text.text);
	if (chunks.length === 0) {
		await markRow(storage, row, now, {
			state: "FAILED",
			expectedChunks: 0,
			confirmedChunks: 0,
			lastErrorCode: SEMANTIC_TEXT_UNAVAILABLE_CODE,
		});
		return { status: "FAILED", vectors: 0 };
	}
	// A previous build may have left vectors at higher ordinals (model change
	// or shorter current chunking).  Delete them so no stale vector survives.
	if (row.expected_chunks > chunks.length || row.model_id !== SEMANTIC_MODEL_ID) {
		await deleteVectorRange(deps, row, chunks.length, SEMANTIC_MAX_CHUNKS);
	}
	let upserted = 0;
	try {
		for (let start = 0; start < chunks.length; start += SEMANTIC_EMBED_BATCH_LIMIT) {
			const batch = chunks.slice(start, start + SEMANTIC_EMBED_BATCH_LIMIT);
			const vectors = await embedTexts(
				deps.ai,
				batch.map((chunk) => chunk.text),
			);
			const entries = [];
			for (let index = 0; index < batch.length; index += 1) {
				entries.push({
					id: await semanticVectorId(
						row.document_id,
						row.version_id,
						batch[index].ordinal,
					),
					values: vectors[index],
					metadata: {
						document_id: row.document_id,
						version_id: row.version_id,
						chunk: batch[index].ordinal,
						model_id: SEMANTIC_MODEL_ID,
					},
				});
			}
			await deps.index.upsert(entries);
			upserted += entries.length;
		}
	} catch (error) {
		if (error instanceof ResearchBoundaryError && !error.retryable) throw error;
		const attempts = row.attempts + 1;
		const terminal = attempts >= SEMANTIC_MAX_ATTEMPTS;
		await markRow(storage, row, now, {
			state: terminal ? "FAILED" : "PENDING",
			contentSha256: loaded.contentSha256,
			titleOnly: loaded.text.titleOnly ? 1 : 0,
			truncated: truncated ? 1 : 0,
			expectedChunks: chunks.length,
			confirmedChunks: 0,
			attempts,
			lastErrorCode: terminal ? "INDEX_WRITE_FAILED" : "INDEX_WRITE_RETRY",
		});
		return { status: terminal ? "FAILED" : "PENDING", vectors: upserted };
	}
	const applied = await markRow(storage, row, now, {
		state: "READY",
		contentSha256: loaded.contentSha256,
		titleOnly: loaded.text.titleOnly ? 1 : 0,
		truncated: truncated ? 1 : 0,
		expectedChunks: chunks.length,
		confirmedChunks: chunks.length,
		attempts: 0,
		lastErrorCode: null,
	});
	// The row was retired while embedding: its vectors are orphaned and the
	// cleanup pass reclaims them.
	return { status: applied === 1 ? "READY" : "SUPERSEDED", vectors: upserted };
}

async function deleteVectorRange(
	deps: SemanticIndexDeps,
	row: { document_id: string; version_id: string },
	from: number,
	to: number,
): Promise<number> {
	const ids = await semanticVectorIds(row.document_id, row.version_id, to);
	const slice = ids.slice(from);
	if (slice.length === 0) return 0;
	await deps.index.deleteByIds(slice);
	return slice.length;
}

/**
 * Retention reuse point: the same deterministic-id `deleteByIds` mechanism the
 * retired-row cleanup uses, exposed for the PUBLIC document retention purge,
 * which deletes the version rows before reclaiming vectors (D1 was already
 * authoritative, so the eventual Vectorize consistency window cannot expose a
 * deleted version).  Returns the number of vector ids submitted for deletion.
 */
export async function deleteSemanticVersionVectors(
	index: Vectorize,
	documentId: string,
	versionId: string,
): Promise<number> {
	const ids = await semanticVectorIds(documentId, versionId, SEMANTIC_MAX_CHUNKS);
	if (ids.length === 0) return 0;
	await index.deleteByIds(ids);
	return ids.length;
}

/**
 * Bounded rolling audit of READY rows: a version that is no longer the
 * document's servable version (a later version arrived out of order, or the
 * version itself stopped being servable) must be invalidated in D1 before its
 * vectors are reclaimed.  Rows confirmed as current are touched so the audit
 * rotates instead of re-examining the same head every run.
 */
async function auditReadyRows(
	storage: SemanticIndexStorage,
	now: string,
	limit = SEMANTIC_AUDIT_PAGE,
): Promise<number> {
	const candidates = await storage.db
		.prepare(
			`SELECT ${STATE_COLUMNS} FROM research_semantic_index_state WHERE visibility='PUBLIC' AND state='READY' AND retired_at IS NULL ORDER BY updated_at, document_id, version_id LIMIT ?`,
		)
		.bind(clampInt(limit, SEMANTIC_AUDIT_PAGE, 1, 500))
		.all<SemanticIndexStateRow>();
	let retired = 0;
	for (const row of candidates.results ?? []) {
		const current = await currentServableVersion(storage, row.document_id);
		if (current && current.versionId === row.version_id) {
			await storage.db
				.prepare(
					"UPDATE research_semantic_index_state SET updated_at=? WHERE visibility='PUBLIC' AND document_id=? AND version_id=? AND state='READY' AND retired_at IS NULL",
				)
				.bind(now, row.document_id, row.version_id)
				.run();
			continue;
		}
		await markRow(storage, row, now, {
			state: "FAILED",
			expectedChunks: 0,
			confirmedChunks: 0,
			lastErrorCode: SEMANTIC_SUPERSEDED_CODE,
			retired: true,
		});
		retired += 1;
	}
	return retired;
}

/**
 * Delete vectors for rows whose ids must no longer be visible.  D1 was
 * already authoritative before this runs (retired_at), so an eventual
 * Vectorize consistency window cannot expose a retired version.
 */
async function cleanupRetiredVectors(
	storage: SemanticIndexStorage,
	deps: SemanticIndexDeps,
	now: string,
	limit = SEMANTIC_CLEANUP_PAGE,
): Promise<number> {
	const candidates = await storage.db
		.prepare(
			`SELECT ${STATE_COLUMNS} FROM research_semantic_index_state WHERE visibility='PUBLIC' AND retired_at IS NOT NULL AND vector_deleted_at IS NULL ORDER BY retired_at, document_id, version_id LIMIT ?`,
		)
		.bind(clampInt(limit, SEMANTIC_CLEANUP_PAGE, 1, 100))
		.all<SemanticIndexStateRow>();
	let deleted = 0;
	for (const row of candidates.results ?? []) {
		deleted += await deleteVectorRange(deps, row, 0, SEMANTIC_MAX_CHUNKS);
		await storage.db
			.prepare(
				"UPDATE research_semantic_index_state SET vector_deleted_at=?, updated_at=? WHERE visibility='PUBLIC' AND document_id=? AND version_id=?",
			)
			.bind(now, now, row.document_id, row.version_id)
			.run();
	}
	return deleted;
}

/* ------------------------------------------------------------------ */
/* Batch runner                                                        */
/* ------------------------------------------------------------------ */

/**
 * One bounded, resumable indexing run: compensate registrations, revive
 * expired dead letters and superseded-but-current rows, index up to
 * `maxDocs` pending documents, then reclaim retired vectors.  Never one HTTP
 * request for a whole corpus.
 */
export async function runSemanticIndexBatch(
	storage: SemanticIndexStorage,
	deps: SemanticIndexDeps,
	options: { now?: string; maxDocs?: number; maxRegister?: number; budgetMs?: number } = {},
): Promise<SemanticBatchReport> {
	const now = options.now ?? new Date().toISOString();
	const maxDocs = clampInt(options.maxDocs, SEMANTIC_BATCH_MAX_DOCS, 1, SEMANTIC_BATCH_MAX_DOCS);
	const deadline =
		Date.now() + clampInt(options.budgetMs, SEMANTIC_BATCH_BUDGET_MS, 1_000, 120_000);
	const report: SemanticBatchReport = {
		registered: 0,
		revived: 0,
		ready: 0,
		pending: 0,
		failed: 0,
		superseded: 0,
		vectors_upserted: 0,
		vectors_deleted: 0,
	};
	try {
		report.registered = await registerMissingPublicVersions(
			storage,
			now,
			options.maxRegister ?? SEMANTIC_REGISTER_PAGE,
		);
		report.revived += await reviveExpiredDeadLetters(storage, now);
		report.revived += await reviveCurrentSupersededRows(storage, now);
		report.superseded += await auditReadyRows(storage, now);
		const staleBefore = new Date(Date.parse(now) - SEMANTIC_CLAIM_STALE_MS).toISOString();
		const candidates = await storage.db
			.prepare(
				`SELECT ${STATE_COLUMNS} FROM research_semantic_index_state WHERE visibility='PUBLIC' AND state='PENDING' AND retired_at IS NULL AND ${NOT_EXPIRED_BY_RETENTION} AND (last_error_code IS NULL OR last_error_code<>? OR updated_at<?) ORDER BY updated_at, document_id, version_id LIMIT ?`,
			)
			.bind(SEMANTIC_IN_PROGRESS_CODE, staleBefore, maxDocs * 3)
			.all<SemanticIndexStateRow>();
		let processed = 0;
		for (const row of candidates.results ?? []) {
			if (processed >= maxDocs || Date.now() >= deadline) break;
			if (!(await claimPendingRow(storage, row, now))) continue;
			processed += 1;
			const outcome = await indexClaimedRow(storage, deps, row, now);
			report.vectors_upserted += outcome.vectors;
			if (outcome.status === "READY") report.ready += 1;
			else if (outcome.status === "FAILED") report.failed += 1;
			else if (outcome.status === "SUPERSEDED") report.superseded += 1;
			else report.pending += 1;
		}
		report.vectors_deleted = await cleanupRetiredVectors(storage, deps, now);
		return report;
	} catch (error) {
		// The boundaryFailure conversion erases the root cause; name it for the
		// operator log (no secrets, no document ids in the error text).
		console.log(
			JSON.stringify({
				event: "semantic_run_failed",
				timestamp: new Date().toISOString(),
				error_type: error instanceof Error ? error.name : typeof error,
				error_message: (error instanceof Error ? error.message : String(error)).slice(0, 300),
				error_stack: ((error instanceof Error ? error.stack : "") ?? "").slice(0, 600),
			}),
		);
		boundaryFailure(error);
	}
}

/** Targeted index attempt for one PUBLIC document version (ingest hook). */
export async function indexSemanticDocument(
	storage: SemanticIndexStorage,
	deps: SemanticIndexDeps,
	options: { documentId: string; versionId: string; now?: string },
): Promise<DocumentOutcome> {
	const now = options.now ?? new Date().toISOString();
	try {
		const row = await storage.db
			.prepare(
				`SELECT ${STATE_COLUMNS} FROM research_semantic_index_state WHERE visibility='PUBLIC' AND document_id=? AND version_id=? AND ${NOT_EXPIRED_BY_RETENTION} LIMIT 1`,
			)
			.bind(options.documentId, options.versionId)
			.first<SemanticIndexStateRow>();
		if (!row || row.state !== "PENDING" || row.retired_at !== null) {
			return { status: "PENDING", vectors: 0 };
		}
		if (!(await claimPendingRow(storage, row, now))) return { status: "PENDING", vectors: 0 };
		return await indexClaimedRow(storage, deps, row, now);
	} catch (error) {
		boundaryFailure(error);
	}
}

/* ------------------------------------------------------------------ */
/* Query face                                                          */
/* ------------------------------------------------------------------ */

async function semanticIndexStatus(storage: SemanticIndexStorage): Promise<"READY" | "PARTIAL"> {
	const result = await storage.db
		.prepare(
			"SELECT state, retired_at, COUNT(*) AS n FROM research_semantic_index_state WHERE visibility='PUBLIC' GROUP BY state, retired_at",
		)
		.all<{ state: string; retired_at: string | null; n: number }>();
	let pendingActive = 0;
	let readyActive = 0;
	for (const row of result.results ?? []) {
		const count = Number(row.n ?? 0);
		if (row.retired_at !== null) continue;
		if (row.state === "PENDING") pendingActive += count;
		if (row.state === "READY") readyActive += count;
	}
	return pendingActive > 0 || readyActive === 0 ? "PARTIAL" : "READY";
}

function boundedText(value: unknown, limit: number): string {
	if (typeof value !== "string") return "";
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}

type ValidatedHit = {
	title: string;
	snippet: string;
	source_kind: string | null;
	published_at: string | null;
};

/**
 * Re-validate one vector candidate against D1 and R2.  Returns null when the
 * candidate must be filtered (not PUBLIC/READY here, no longer the current
 * servable version, body hash drift, or its object is not readable); a
 * corrupted object is surfaced as INTEGRITY_FAILED rather than skipped, the
 * same policy `get_document` applies.
 */
async function validateSemanticHit(
	storage: SemanticIndexStorage,
	meta: { document_id: string; version_id: string; chunk: number },
): Promise<ValidatedHit | null> {
	const row = await storage.db
		.prepare(
			`SELECT ${STATE_COLUMNS} FROM research_semantic_index_state WHERE visibility='PUBLIC' AND document_id=? AND version_id=? AND ${NOT_EXPIRED_BY_RETENTION} LIMIT 1`,
		)
		.bind(meta.document_id, meta.version_id)
		.first<SemanticIndexStateRow>();
	if (!row) return null;
	if (row.state !== "READY" || row.retired_at !== null) return null;
	if (row.model_id !== SEMANTIC_MODEL_ID) return null;
	if (row.expected_chunks < 1 || row.confirmed_chunks !== row.expected_chunks) return null;
	// The hit must belong to the version that is current for this document: the
	// first servable version, or - for a document with no servable version at
	// all - the highest-numbered version whose title-only chunk was indexed.
	const { candidate: current, servable } = await currentVersionCandidate(
		storage,
		meta.document_id,
	);
	if (!current || current.versionId !== meta.version_id) return null;
	const title = documentTitle(current);
	const body = servable ? servableBody(current.payload) : null;
	if (row.title_only === 1) {
		// Title-only chunks exist exactly when there is no readable body: the
		// indexed row must agree, otherwise the hit is stale.
		if (servable || !title || row.content_sha256 !== null) return null;
		return {
			title,
			snippet:
				title.length > SEMANTIC_SNIPPET_CHARS
					? `${title.slice(0, SEMANTIC_SNIPPET_CHARS)}…`
					: title,
			source_kind:
				typeof current.document.source_kind === "string"
					? current.document.source_kind
					: null,
			published_at:
				typeof current.version.published_at === "string"
					? current.version.published_at
					: null,
		};
	}
	if (!body || body.contentSha256 !== row.content_sha256) return null;
	const object = await storage.objects.get(objectKey(body.contentSha256));
	if (!object) return null;
	const bytes = await object.arrayBuffer();
	if ((await sha256Hex(bytes)) !== body.contentSha256) {
		throw new ResearchBoundaryError("INTEGRITY_FAILED");
	}
	const text = composeSemanticText(title, new TextDecoder().decode(bytes));
	if (!text || text.titleOnly) return null;
	const { chunks } = chunkSemanticDocument(text.text);
	if (chunks.length === 0) return null;
	const chunk = chunks[Math.min(Math.max(meta.chunk, 0), chunks.length - 1)];
	return {
		title,
		snippet: boundedText(chunk.text, SEMANTIC_SNIPPET_CHARS),
		source_kind:
			typeof current.document.source_kind === "string" ? current.document.source_kind : null,
		published_at:
			typeof current.version.published_at === "string" ? current.version.published_at : null,
	};
}

function parseMatchMetadata(value: Record<string, unknown> | null): {
	document_id: string;
	version_id: string;
	chunk: number;
	model_id: string;
} | null {
	if (!value) return null;
	const documentId = value.document_id;
	const versionId = value.version_id;
	const chunk = Number(value.chunk);
	const modelId = value.model_id;
	if (typeof documentId !== "string" || !documentId) return null;
	if (typeof versionId !== "string" || !versionId) return null;
	if (!Number.isInteger(chunk) || chunk < 0 || chunk >= SEMANTIC_MAX_CHUNKS) return null;
	if (typeof modelId !== "string" || modelId !== SEMANTIC_MODEL_ID) return null;
	return { document_id: documentId, version_id: versionId, chunk, model_id: modelId };
}

/**
 * Semantic search over the PUBLIC index.  Over-fetches, re-validates every
 * candidate against D1/R2, deduplicates per document and reports READY or
 * PARTIAL.  A missing binding, a failing model call or a failing Vectorize
 * query is an explicit safe error: an unavailable index is never reported as
 * "no matches".
 */
export async function searchPublicDocumentsSemantic(
	storage: SemanticIndexStorage,
	deps: SemanticIndexDeps,
	options: { query: string; limit?: number },
): Promise<SemanticSearchResult> {
	const query = typeof options.query === "string" ? options.query.trim() : "";
	if (!query) fail("MODEL_RESPONSE_INVALID", false, "semantic query must not be empty");
	if (query.length > SEMANTIC_QUERY_MAX_QUERY_CHARS) {
		fail("MODEL_RESPONSE_INVALID", false, "semantic query exceeds the supported length");
	}
	const limit = options.limit ?? 10;
	if (!Number.isInteger(limit) || limit < 1 || limit > SEMANTIC_QUERY_MAX_LIMIT) {
		fail(
			"MODEL_RESPONSE_INVALID",
			false,
			"semantic result limit is outside the supported range",
		);
	}
	try {
		const [vector] = await embedTexts(deps.ai, [query]);
		const topK = Math.min(
			Math.max(limit * SEMANTIC_QUERY_OVERFETCH_FACTOR, limit),
			SEMANTIC_QUERY_OVERFETCH_MAX,
		);
		const candidates = await queryVectorIndex(deps.index, vector, topK);
		const status = await semanticIndexStatus(storage);
		const matches: SemanticSearchMatch[] = [];
		const seen = new Set<string>();
		for (const candidate of candidates) {
			const meta = parseMatchMetadata(candidate.metadata);
			if (!meta || seen.has(meta.document_id)) continue;
			const hit = await validateSemanticHit(storage, meta);
			if (!hit) continue;
			seen.add(meta.document_id);
			matches.push({
				document_id: meta.document_id,
				version_id: meta.version_id,
				title: hit.title,
				score: candidate.score,
				snippet: hit.snippet,
				source_kind: hit.source_kind,
				published_at: hit.published_at,
			});
			if (matches.length >= limit) break;
		}
		return { matches, index_status: status };
	} catch (error) {
		boundaryFailure(error);
	}
}

/* ------------------------------------------------------------------ */
/* Operations face (internal token-gated transport, not an MCP tool)   */
/* ------------------------------------------------------------------ */

export type SemanticIndexCoverage = {
	index_status: "READY" | "PARTIAL";
	model_id: string;
	states: Array<{ state: string; active: number; total: number }>;
	failure_codes: Array<{ last_error_code: string; count: number }>;
	oldest_pending_at: string | null;
	indexed_chunks: number;
};

/**
 * Read-only coverage counters for operators (task E accounting).  Counts
 * only: no document ids, no text, nothing that could reconstruct PRIVATE
 * content.
 */
export async function readSemanticIndexCoverage(
	storage: SemanticIndexStorage,
): Promise<SemanticIndexCoverage> {
	const states = await storage.db
		.prepare(
			"SELECT state, retired_at, COUNT(*) AS n, SUM(confirmed_chunks) AS chunks FROM research_semantic_index_state WHERE visibility='PUBLIC' GROUP BY state, retired_at",
		)
		.all<{ state: string; retired_at: string | null; n: number; chunks: number | null }>();
	const grouped = new Map<string, { active: number; total: number }>();
	let indexedChunks = 0;
	for (const row of states.results ?? []) {
		const count = Number(row.n ?? 0);
		const bucket = grouped.get(row.state) ?? { active: 0, total: 0 };
		bucket.total += count;
		if (row.retired_at === null) {
			bucket.active += count;
			if (row.state === "READY") indexedChunks += Number(row.chunks ?? 0);
		}
		grouped.set(row.state, bucket);
	}
	const failures = await storage.db
		.prepare(
			"SELECT COALESCE(last_error_code, 'UNKNOWN') AS last_error_code, COUNT(*) AS n FROM research_semantic_index_state WHERE visibility='PUBLIC' AND state='FAILED' AND retired_at IS NULL GROUP BY last_error_code ORDER BY n DESC, last_error_code LIMIT 20",
		)
		.all<{ last_error_code: string; n: number }>();
	const pending = await storage.db
		.prepare(
			"SELECT MIN(updated_at) AS oldest FROM research_semantic_index_state WHERE visibility='PUBLIC' AND state='PENDING' AND retired_at IS NULL",
		)
		.first<{ oldest: string | null }>();
	const indexStatus = await semanticIndexStatus(storage);
	return {
		index_status: indexStatus,
		model_id: SEMANTIC_MODEL_ID,
		states: [...grouped.entries()]
			.map(([state, value]) => ({ state, active: value.active, total: value.total }))
			.sort((a, b) => (a.state < b.state ? -1 : a.state > b.state ? 1 : 0)),
		failure_codes: (failures.results ?? []).map((row) => ({
			last_error_code: row.last_error_code,
			count: Number(row.n ?? 0),
		})),
		oldest_pending_at: pending?.oldest ?? null,
		indexed_chunks: indexedChunks,
	};
}

/**
 * Deployment probe (G3): verifies the real Workers AI output dimensions and
 * the bound index configuration before the semantic tool is enabled.  The
 * index metric is fixed at creation time and is not readable through the
 * binding, so it is reported from the configuration constant with an explicit
 * source marker.
 */
export async function probeSemanticIndex(
	deps: SemanticIndexDeps,
): Promise<Record<string, unknown>> {
	const [vector] = await runEmbedding(deps.ai, ["semantic index dimensions probe"]);
	let info: { dimensions?: unknown; vectorCount?: unknown } | null = null;
	try {
		info = (await deps.index.describe()) as { dimensions?: unknown; vectorCount?: unknown };
	} catch {
		fail("INDEX_UNAVAILABLE", true, "vector index metadata is unavailable");
	}
	const indexDimensions = Number(info?.dimensions ?? Number.NaN);
	return {
		index_name: SEMANTIC_INDEX_NAME,
		model_id: SEMANTIC_MODEL_ID,
		embedding_dimensions: vector.length,
		expected_dimensions: SEMANTIC_VECTOR_DIMENSIONS,
		embedding_dimensions_match: vector.length === SEMANTIC_VECTOR_DIMENSIONS,
		index_dimensions: Number.isFinite(indexDimensions) ? indexDimensions : null,
		index_dimensions_match: indexDimensions === SEMANTIC_VECTOR_DIMENSIONS,
		index_metric: SEMANTIC_INDEX_METRIC,
		index_metric_source: "configuration_constant",
		vector_count: Number(info?.vectorCount ?? 0),
	};
}
