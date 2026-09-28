/**
 * PUBLIC document data retention (owner ruling 2026-09-29):
 *
 * 1. A PUBLIC document is expired when its earliest version `ingested_at` is
 *    older than 90 days.  `source_id='E02-gelonghui-live'` original snapshots
 *    are legacy violations and are expired regardless of age.
 * 2. Orchestration reuses the semantic-index retire→`deleteByIds` mechanism
 *    (`research_semantic_index.ts`): first D1 logical invalidation (the
 *    document is marked EXPIRED in `research_document_retention` and every
 *    semantic state row of the document is retired, so search_documents,
 *    get_document and search_documents_semantic stop serving it immediately),
 *    then R2 object deletion, then D1 row deletion (version rows, their
 *    record_object links, unreferenced object metadata rows and the semantic
 *    state rows), and finally the Vectorize `deleteByIds` reclaim - D1 was
 *    authoritative before the vectors were deleted, so the eventual Vectorize
 *    consistency window can never expose a purged version.
 * 3. Triggers: the daily scheduled cron (`RETENTION_CRON`) and the internal
 *    token-gated POST endpoint (`/internal/research-retention/run`), which
 *    accepts `?dry_run=1` to list the expiry candidates and the pending-purge
 *    backlog without deleting anything.
 * 4. Every run writes one `research_retention_audit` row: counts and
 *    identifier lists (document/version/message ids, content hashes) only,
 *    never document content.
 *
 * Scope guardrails (red lines): all D1 tables touched here carry the
 * `research_` prefix, and R2 deletions are limited to content objects under
 * `research-objects/sha256/` plus the ingest journals of the purged versions
 * under `research-replica-journal/`.  A content object shared with another
 * live record is never deleted (reference guard).  `research_ingest_messages`
 * rows are deliberately kept: they are the replay ledger that turns a delayed
 * redelivery of a purged message into a no-op REPLAY instead of a resurrection.
 */
import { ResearchBoundaryError } from "./research-outbound-v2.ts";
import { deleteSemanticVersionVectors } from "./research-semantic-index.ts";

/** Owner ruling: PUBLIC replica retention window in days. */
export const RETENTION_DAYS = 90;

/** Daily scheduled trigger (20:30 UTC, distinct from every bridge cron). */
export const RETENTION_CRON = "30 20 * * *";

/** Sources whose snapshots are legacy violations: always expired. */
export const RETENTION_FORCE_EXPIRED_SOURCE_IDS: ReadonlySet<string> = new Set([
	"E02-gelonghui-live",
]);

export const RETENTION_REASON_AGE = "AGE_90D";
export const RETENTION_REASON_SOURCE = "SOURCE_E02_GELONGHUI_LIVE";
/** Semantic dead-letter code stamped on state rows retired by retention. */
export const RETENTION_EXPIRED_ERROR_CODE = "EXPIRED_RETENTION";

/** Bounded work per run (resumable; the daily cron converges the backlog). */
export const RETENTION_SCAN_PAGE = 200;
export const RETENTION_SCAN_MAX_PAGES = 10;
export const RETENTION_MARK_PAGE = 100;
export const RETENTION_MARK_PAGE_MAX = 500;
export const RETENTION_PURGE_PAGE = 20;
export const RETENTION_PURGE_PAGE_MAX = 100;
/** D1 bound-parameter ceiling is 100; stay well below it for IN (...) lists. */
const PARAM_CHUNK = 50;
const STATEMENT_CHUNK = 50;

export type RetentionStorage = { db: D1Database; objects: R2Bucket };
export type RetentionDeps = { index: Vectorize | null };

export type RetentionCandidate = {
	document_id: string;
	source_id: string | null;
	first_ingested_at: string | null;
	reason: typeof RETENTION_REASON_AGE | typeof RETENTION_REASON_SOURCE;
	version_count: number;
};

export type RetentionPurgeDetail = {
	document_id: string;
	reason: string;
	versions_deleted: number;
	record_object_rows_deleted: number;
	object_rows_deleted: number;
	object_record_rows_deleted: number;
	state_rows_deleted: number;
	r2_objects_deleted: number;
	r2_journals_deleted: number;
	vectors_deleted: number;
	objects_kept_shared: number;
	versions: string[];
	objects_deleted: string[];
	objects_kept_shared_hashes: string[];
	journals: string[];
};

export type RetentionRunReport = {
	schema_version: "research-retention-run-v1";
	trigger: "scheduled" | "manual";
	dry_run: boolean;
	cutoff: string;
	scanned_documents: number;
	/** dry run only: documents this run would mark EXPIRED. */
	would_mark: RetentionCandidate[];
	/** dry run only: documents already EXPIRED and awaiting purge. */
	already_expired_pending_purge: Array<{
		document_id: string;
		reason: string;
		marked_at: string;
		version_count: number;
	}>;
	marked_expired: number;
	purge_candidates: number;
	purged_documents: number;
	purge: RetentionPurgeDetail[];
	purge_skipped: string | null;
};

type ScanRow = {
	document_id: string;
	first_ingested_at: string | null;
	source_id: string | null;
	version_count: number;
};

type MarkedVersionCapture = {
	version_ids: string[];
	journal_message_ids: string[];
	content_sha256s: string[];
};

type RetentionRow = {
	document_id: string;
	source_id: string | null;
	reason: string;
	first_ingested_at: string | null;
	version_ids_json: string;
	journal_message_ids_json: string;
	content_sha256s_json: string;
	status: string;
	marked_at: string;
	purged_at: string | null;
};

function integrityFailure(): never {
	throw new ResearchBoundaryError("INTEGRITY_FAILED");
}

function boundaryFailure(error: unknown): never {
	if (error instanceof ResearchBoundaryError) throw error;
	throw new ResearchBoundaryError("STORE_UNAVAILABLE", undefined, {
		retryable: true,
		safeMessage: "retention backend is unavailable; retry later",
	});
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
	if (value === undefined || value === null) return fallback;
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) return fallback;
	return Math.min(Math.max(Math.trunc(numeric), min), max);
}

export function retentionCutoff(now: string): string {
	const timestamp = Date.parse(now);
	if (!Number.isFinite(timestamp)) integrityFailure();
	return new Date(timestamp - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

function objectKey(contentSha256: string): string {
	return `research-objects/sha256/${contentSha256}`;
}

function journalKey(messageId: string): string {
	return `research-replica-journal/v2/${messageId}.json`;
}

function parseJsonList(value: unknown): string[] {
	const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
	if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
		integrityFailure();
	}
	return parsed as string[];
}

/**
 * The per-version ingestion time: the producer-declared `ingested_at`, with the
 * Collector's own first-receipt time (and finally the record update time) as
 * fallbacks for legacy rows.  Used only as a retention signal, never rewritten.
 */
const FIRST_INGESTED_AT_SQL =
	"COALESCE(json_extract(research_records.payload_json, '$.version.ingested_at'), ingest.received_at, research_records.updated_at)";

/**
 * One keyset page of grouped PUBLIC documents.  Documents already marked
 * EXPIRED are excluded from the grouping (they are the purge queue's job, not
 * the mark scan's), while still advancing the cursor so the scan always makes
 * progress across runs.
 */
async function scanRetentionPage(
	storage: RetentionStorage,
	cursor: string,
	limit: number,
): Promise<ScanRow[]> {
	const result = await storage.db
		.prepare(
			`SELECT json_extract(research_records.payload_json, '$.document.document_id') AS document_id, MIN(${FIRST_INGESTED_AT_SQL}) AS first_ingested_at, MIN(json_extract(research_records.payload_json, '$.document.source_id')) AS source_id, COUNT(*) AS version_count FROM research_records LEFT JOIN research_ingest_messages AS ingest ON ingest.record_type='document_version' AND ingest.record_key=research_records.record_key WHERE research_records.record_type='document_version' AND research_records.visibility='PUBLIC' AND json_extract(research_records.payload_json, '$.document.document_id') IS NOT NULL AND json_extract(research_records.payload_json, '$.document.document_id') > ? GROUP BY 1 HAVING NOT EXISTS (SELECT 1 FROM research_document_retention ret WHERE ret.document_id=json_extract(research_records.payload_json, '$.document.document_id') AND ret.status='EXPIRED') ORDER BY 1 LIMIT ?`,
		)
		.bind(cursor, limit)
		.all<ScanRow>();
	return result.results ?? [];
}

/**
 * Expiry judgment (requirement 1): the force-expired source always expires;
 * otherwise the earliest version ingestion time must parse and fall strictly
 * before the cutoff.  An unparseable timestamp never expires by age
 * (fail-safe: garbage time can never become a deletion reason).
 */
export function retentionExpiryReason(
	sourceId: string | null,
	firstIngestedAt: string | null,
	cutoff: string,
): RetentionCandidate["reason"] | null {
	if (sourceId !== null && RETENTION_FORCE_EXPIRED_SOURCE_IDS.has(sourceId)) {
		return RETENTION_REASON_SOURCE;
	}
	const timestamp = Date.parse(firstIngestedAt ?? "");
	if (!Number.isFinite(timestamp)) return null;
	return timestamp < Date.parse(cutoff) ? RETENTION_REASON_AGE : null;
}

/**
 * Scan bounded keyset pages and return up to `limit` expired documents with
 * their judgment.  Purely read-only: the dry run reports exactly this list.
 */
export async function scanRetentionCandidates(
	storage: RetentionStorage,
	now: string,
	options: { limit?: number } = {},
): Promise<{ candidates: RetentionCandidate[]; scanned: number }> {
	const cutoff = retentionCutoff(now);
	const limit = clampInt(options.limit, RETENTION_MARK_PAGE, 1, RETENTION_MARK_PAGE_MAX);
	const candidates: RetentionCandidate[] = [];
	let scanned = 0;
	let cursor = "";
	for (let page = 0; page < RETENTION_SCAN_MAX_PAGES; page += 1) {
		const rows = await scanRetentionPage(storage, cursor, RETENTION_SCAN_PAGE);
		if (rows.length === 0) break;
		scanned += rows.length;
		for (const row of rows) cursor = row.document_id;
		for (const row of rows) {
			const reason = retentionExpiryReason(row.source_id, row.first_ingested_at, cutoff);
			if (!reason) continue;
			candidates.push({
				document_id: row.document_id,
				source_id: row.source_id,
				first_ingested_at: row.first_ingested_at,
				reason,
				version_count: Number(row.version_count ?? 0),
			});
			if (candidates.length >= limit) return { candidates, scanned };
		}
		if (rows.length < RETENTION_SCAN_PAGE) break;
	}
	return { candidates, scanned };
}

async function chunkedAll<T>(
	storage: RetentionStorage,
	sql: string,
	values: string[],
	leadingBinds: string[] = [],
): Promise<T[]> {
	const rows: T[] = [];
	for (let start = 0; start < values.length; start += PARAM_CHUNK) {
		const slice = values.slice(start, start + PARAM_CHUNK);
		if (slice.length === 0) continue;
		const result = await storage.db
			.prepare(`${sql}${slice.map(() => "?").join(", ")})`)
			.bind(...leadingBinds, ...slice)
			.all<T>();
		rows.push(...(result.results ?? []));
	}
	return rows;
}

/** Capture the immutable id lists the purge needs, before anything is deleted. */
async function captureVersions(
	storage: RetentionStorage,
	documentId: string,
): Promise<MarkedVersionCapture> {
	const versionRows = await chunkedAll<{ version_id: string; message_id: string }>(
		storage,
		"SELECT record_key AS version_id, message_id FROM research_records WHERE record_type='document_version' AND visibility='PUBLIC' AND json_extract(payload_json, '$.document.document_id') IN (",
		[documentId],
	);
	const versionIds = versionRows.map((row) => row.version_id);
	const journalRows = await chunkedAll<{ message_id: string }>(
		storage,
		"SELECT DISTINCT message_id FROM research_ingest_messages WHERE record_type='document_version' AND record_key IN (",
		versionIds,
	);
	const hashRows = await chunkedAll<{ content_sha256: string }>(
		storage,
		"SELECT DISTINCT content_sha256 FROM research_record_objects WHERE record_type='document_version' AND record_key IN (",
		versionIds,
	);
	return {
		version_ids: versionIds,
		journal_message_ids: journalRows.map((row) => row.message_id),
		content_sha256s: hashRows.map((row) => row.content_sha256),
	};
}

/**
 * Step 1 of the orchestration: mark EXPIRED (invisible) and retire the
 * document's semantic state rows with `EXPIRED_RETENTION` - the same
 * retire-in-D1-first shape the superseded-version cleanup uses.  Idempotent;
 * the captured id lists make the purge replayable after any crash.
 */
async function markExpiredDocument(
	storage: RetentionStorage,
	candidate: RetentionCandidate,
	now: string,
): Promise<boolean> {
	const capture = await captureVersions(storage, candidate.document_id);
	const insert = await storage.db
		.prepare(
			"INSERT INTO research_document_retention (document_id, visibility, source_id, reason, first_ingested_at, version_ids_json, journal_message_ids_json, content_sha256s_json, status, marked_at, purged_at, purge_detail_json) VALUES (?, 'PUBLIC', ?, ?, ?, ?, ?, ?, 'EXPIRED', ?, NULL, NULL) ON CONFLICT(document_id) DO NOTHING",
		)
		.bind(
			candidate.document_id,
			candidate.source_id,
			candidate.reason,
			candidate.first_ingested_at,
			JSON.stringify(capture.version_ids),
			JSON.stringify(capture.journal_message_ids),
			JSON.stringify(capture.content_sha256s),
			now,
		)
		.run();
	const retire = await storage.db
		.prepare(
			"UPDATE research_semantic_index_state SET state='FAILED', expected_chunks=0, confirmed_chunks=0, last_error_code=?, retired_at=COALESCE(retired_at, ?), updated_at=? WHERE visibility='PUBLIC' AND document_id=?",
		)
		.bind(RETENTION_EXPIRED_ERROR_CODE, now, now, candidate.document_id)
		.run();
	void retire;
	return Number(insert.meta?.changes ?? 0) === 1;
}

async function listExpiredPendingPurge(
	storage: RetentionStorage,
	limit: number,
): Promise<RetentionRow[]> {
	const result = await storage.db
		.prepare(
			"SELECT document_id, source_id, reason, first_ingested_at, version_ids_json, journal_message_ids_json, content_sha256s_json, status, marked_at, purged_at FROM research_document_retention WHERE status='EXPIRED' ORDER BY marked_at, document_id LIMIT ?",
		)
		.bind(limit)
		.all<RetentionRow>();
	return result.results ?? [];
}

/**
 * Steps 2-4 for one EXPIRED document, in the ruled order: R2 objects (with a
 * cross-document reference guard) and the versions' ingest journals, then the
 * D1 rows (attachment links, version rows, unreferenced object metadata,
 * semantic state rows), then the Vectorize deleteByIds reclaim, and only then
 * the bookkeeping flip to PURGED - a crash before the flip leaves the
 * EXPIRED row in place and the next run replays every idempotent delete.
 */
async function purgeExpiredDocument(
	storage: RetentionStorage,
	deps: RetentionDeps,
	row: RetentionRow,
	now: string,
): Promise<RetentionPurgeDetail> {
	const versionIds = parseJsonList(row.version_ids_json);
	const journalMessageIds = parseJsonList(row.journal_message_ids_json);
	const contentSha256s = parseJsonList(row.content_sha256s_json);
	const detail: RetentionPurgeDetail = {
		document_id: row.document_id,
		reason: row.reason,
		versions_deleted: 0,
		record_object_rows_deleted: 0,
		object_rows_deleted: 0,
		object_record_rows_deleted: 0,
		state_rows_deleted: 0,
		r2_objects_deleted: 0,
		r2_journals_deleted: 0,
		vectors_deleted: 0,
		objects_kept_shared: 0,
		versions: versionIds,
		objects_deleted: [],
		objects_kept_shared_hashes: [],
		journals: journalMessageIds,
	};

	// Step 2a: content objects.  An object still referenced by any other record
	// (any visibility) must survive, so the guard counts references outside this
	// document's version keys instead of trusting the link rows.  record_key is
	// the version id for document_version link rows (the only writer today);
	// excluding by key alone keeps a byte in the worst case, never deletes a
	// byte that is still referenced.
	for (const contentSha256 of contentSha256s) {
		const references = await chunkedAll<{ foreign_refs: number }>(
			storage,
			"SELECT COUNT(*) AS foreign_refs FROM research_record_objects WHERE content_sha256=? AND record_key NOT IN (",
			versionIds,
			[contentSha256],
		);
		const foreignReferences = references.reduce(
			(total, item) => total + Number(item.foreign_refs ?? 0),
			0,
		);
		if (foreignReferences > 0) {
			detail.objects_kept_shared += 1;
			detail.objects_kept_shared_hashes.push(contentSha256);
			continue;
		}
		await storage.objects.delete(objectKey(contentSha256));
		detail.r2_objects_deleted += 1;
		detail.objects_deleted.push(contentSha256);
	}

	// Step 2b: the ingest journals still carry the payload bytes of the purged
	// versions; every message id ever received for these versions is deleted.
	for (const messageId of journalMessageIds) {
		await storage.objects.delete(journalKey(messageId));
		detail.r2_journals_deleted += 1;
	}

	// Step 3: D1 row deletion.  Every delete is scoped to the captured keys and
	// the PUBLIC visibility; non-research tables are structurally unreachable.
	for (const statement of [
		{
			sql: "DELETE FROM research_record_objects WHERE record_type='document_version' AND record_key IN (",
			values: versionIds,
			count: (changes: number) => {
				detail.record_object_rows_deleted += changes;
			},
		},
		{
			sql: "DELETE FROM research_records WHERE record_type='document_version' AND visibility='PUBLIC' AND record_key IN (",
			values: versionIds,
			count: (changes: number) => {
				detail.versions_deleted += changes;
			},
		},
		{
			sql: "DELETE FROM research_records WHERE record_type='object' AND record_key IN (",
			values: detail.objects_deleted,
			count: (changes: number) => {
				detail.object_record_rows_deleted += changes;
			},
		},
	]) {
		for (let start = 0; start < statement.values.length; start += PARAM_CHUNK) {
			const slice = statement.values.slice(start, start + PARAM_CHUNK);
			if (slice.length === 0) continue;
			const result = await storage.db
				.prepare(`${statement.sql}${slice.map(() => "?").join(", ")})`)
				.bind(...slice)
				.run();
			statement.count(Number(result.meta?.changes ?? 0));
		}
	}
	for (const contentSha256 of detail.objects_deleted) {
		const result = await storage.db
			.prepare("DELETE FROM research_objects WHERE content_sha256=?")
			.bind(contentSha256)
			.run();
		detail.object_rows_deleted += Number(result.meta?.changes ?? 0);
	}
	const stateDelete = await storage.db
		.prepare(
			"DELETE FROM research_semantic_index_state WHERE visibility='PUBLIC' AND document_id=?",
		)
		.bind(row.document_id)
		.run();
	detail.state_rows_deleted = Number(stateDelete.meta?.changes ?? 0);

	// Step 4: Vectorize deleteByIds last (reused deterministic-id mechanism).
	if (deps.index) {
		for (const versionId of versionIds) {
			detail.vectors_deleted += await deleteSemanticVersionVectors(
				deps.index,
				row.document_id,
				versionId,
			);
		}
	}

	const flip = await storage.db
		.prepare(
			"UPDATE research_document_retention SET status='PURGED', purged_at=?, purge_detail_json=? WHERE document_id=? AND status='EXPIRED'",
		)
		.bind(now, JSON.stringify(detail), row.document_id)
		.run();
	if (Number(flip.meta?.changes ?? 0) !== 1) integrityFailure();
	return detail;
}

async function writeRetentionAudit(
	storage: RetentionStorage,
	report: RetentionRunReport,
	now: string,
): Promise<void> {
	const dryRunDocuments = report.would_mark.length + report.already_expired_pending_purge.length;
	const versionCount = report.dry_run
		? [...report.would_mark, ...report.already_expired_pending_purge].reduce(
				(total, item) => total + Number(item.version_count ?? 0),
				0,
			)
		: report.purge.reduce((total, item) => total + item.versions_deleted, 0);
	const r2ObjectCount = report.purge.reduce(
		(total, item) => total + item.r2_objects_deleted,
		0,
	);
	const vectorCount = report.purge.reduce((total, item) => total + item.vectors_deleted, 0);
	const documentCount = report.dry_run
		? dryRunDocuments
		: report.marked_expired + report.purged_documents;
	await storage.db
		.prepare(
			"INSERT INTO research_retention_audit (run_at, trigger_source, dry_run, document_count, version_count, r2_object_count, vector_count, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.bind(
			now,
			report.trigger,
			report.dry_run ? 1 : 0,
			documentCount,
			versionCount,
			r2ObjectCount,
			vectorCount,
			JSON.stringify(report),
		)
		.run();
}

/**
 * One bounded, resumable retention run.  `dry_run` lists the expiry
 * candidates and the pending-purge backlog and deletes nothing; a real run
 * marks the scanned candidates EXPIRED (invisible immediately), then purges
 * the oldest backlog up to the page bound.  Every run ends with one audit row.
 */
export async function runRetentionSweep(
	storage: RetentionStorage,
	deps: RetentionDeps,
	options: {
		trigger: "scheduled" | "manual";
		dryRun?: boolean;
		now?: string;
		maxMark?: number;
		maxPurge?: number;
	},
): Promise<RetentionRunReport> {
	const now = options.now ?? new Date().toISOString();
	const dryRun = options.dryRun === true;
	const maxMark = clampInt(options.maxMark, RETENTION_MARK_PAGE, 1, RETENTION_MARK_PAGE_MAX);
	const maxPurge = clampInt(options.maxPurge, RETENTION_PURGE_PAGE, 1, RETENTION_PURGE_PAGE_MAX);
	const report: RetentionRunReport = {
		schema_version: "research-retention-run-v1",
		trigger: options.trigger,
		dry_run: dryRun,
		cutoff: retentionCutoff(now),
		scanned_documents: 0,
		would_mark: [],
		already_expired_pending_purge: [],
		marked_expired: 0,
		purge_candidates: 0,
		purged_documents: 0,
		purge: [],
		purge_skipped: null,
	};
	try {
		const { candidates, scanned } = await scanRetentionCandidates(storage, now, {
			limit: maxMark,
		});
		report.scanned_documents = scanned;
		if (dryRun) {
			report.would_mark = candidates;
			const pending = await listExpiredPendingPurge(storage, maxPurge);
			report.already_expired_pending_purge = pending.map((row) => ({
				document_id: row.document_id,
				reason: row.reason,
				marked_at: row.marked_at,
				version_count: parseJsonList(row.version_ids_json).length,
			}));
			await writeRetentionAudit(storage, report, now);
			return report;
		}
		for (const candidate of candidates) {
			if (await markExpiredDocument(storage, candidate, now)) report.marked_expired += 1;
		}
		const purgeable = await listExpiredPendingPurge(storage, maxPurge);
		report.purge_candidates = purgeable.length;
		if (!deps.index) {
			// Fail-closed: without the Vectorize binding the purge would strand
			// orphan vectors forever, so the documents stay EXPIRED (invisible)
			// until the binding exists.  The skip is visible in the report.
			report.purge_skipped = "VECTORIZE_BINDING_UNAVAILABLE";
		} else {
			for (const row of purgeable) {
				report.purge.push(await purgeExpiredDocument(storage, deps, row, now));
			}
			report.purged_documents = report.purge.length;
		}
		await writeRetentionAudit(storage, report, now);
		return report;
	} catch (error) {
		// Server-side structured diagnosis only: the client-facing envelope stays
		// the safe STORE_UNAVAILABLE boundary error, never this detail.
		console.warn(
			JSON.stringify({
				event: "research_retention_sweep_failure",
				timestamp: new Date().toISOString(),
				error_code: error instanceof ResearchBoundaryError ? error.error_code : "UNKNOWN",
				detail: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? (error.stack ?? "").split("\n").slice(0, 6) : null,
			}),
		);
		boundaryFailure(error);
	}
}
