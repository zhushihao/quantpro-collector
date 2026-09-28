-- PUBLIC document retention (owner ruling 2026-09-29):
--   * PUBLIC replica documents are retained 90 days, judged by the earliest
--     version ingested_at of the document.
--   * source_id='E02-gelonghui-live' original snapshots are legacy violations
--     and are expired regardless of age.
--
-- research_document_retention is the EXPIRED marker that makes a document
-- invisible to search_documents / get_document / search_documents_semantic
-- before any byte is deleted, and the replayable purge queue: at mark time it
-- captures the version ids, every ingest journal message id and the linked
-- content hashes, so a purge can always resume to completion (idempotent
-- deletes) even after a crash between steps, without reading the deleted
-- research_records rows back.
--
-- Lifecycle:
--   EXPIRED - marked and logically invalidated (semantic state rows retired
--             with last_error_code='EXPIRED_RETENTION'); invisible to reads;
--             awaiting purge.
--   PURGED  - R2 objects/journals deleted, D1 version/attachment/state rows
--             deleted, Vectorize vectors deleted.  The row remains as a
--             tombstone for audit only; it never hides a document again (a
--             re-ingested document starts a fresh retention lifecycle).
--
-- This table only ever holds PUBLIC identifiers; no titles, no content bytes.

CREATE TABLE IF NOT EXISTS research_document_retention (
	document_id TEXT PRIMARY KEY,
	visibility TEXT NOT NULL CHECK (visibility IN ('PUBLIC')),
	source_id TEXT,
	reason TEXT NOT NULL CHECK (reason IN ('AGE_90D', 'SOURCE_E02_GELONGHUI_LIVE')),
	first_ingested_at TEXT,
	version_ids_json TEXT NOT NULL,
	journal_message_ids_json TEXT NOT NULL,
	content_sha256s_json TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('EXPIRED', 'PURGED')),
	marked_at TEXT NOT NULL,
	purged_at TEXT,
	purge_detail_json TEXT
);

-- Purge queue scan (oldest backlog first) and mark-scan exclusion.
CREATE INDEX IF NOT EXISTS research_document_retention_status
	ON research_document_retention (status, marked_at, document_id);

-- One audit row per retention run: counts and identifier lists only, never
-- document content (the same policy as the semantic index operations face).
CREATE TABLE IF NOT EXISTS research_retention_audit (
	audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
	run_at TEXT NOT NULL,
	trigger_source TEXT NOT NULL,
	dry_run INTEGER NOT NULL CHECK (dry_run IN (0, 1)),
	document_count INTEGER NOT NULL,
	version_count INTEGER NOT NULL,
	r2_object_count INTEGER NOT NULL,
	vector_count INTEGER NOT NULL,
	detail_json TEXT NOT NULL
);
