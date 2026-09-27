-- Task D: Collector PUBLIC semantic index state (spec §"向量范围、增量与存量一致性").
--
-- This table is the authoritative work queue and the query-time validation
-- sidecar for the single Vectorize index `research-public-bge-m3-v1`
-- (Workers AI `@cf/baai/bge-m3`, 1024 dimensions, cosine).
--
-- It never stores document bodies, snippets, PRIVATE locators, or signed
-- URLs: only PUBLIC document/version identifiers, the sha256 of the indexed
-- content, per-version chunk accounting, the embedding model id, and retry
-- bookkeeping.  `visibility` is constrained to PUBLIC so a bug that tries to
-- index a private record fails at the database instead of silently feeding
-- the public search surface.
--
-- Lifecycle:
--   PENDING  - registered (ingest batch or compensation sweep), awaiting a
--              vector build; dependency-missing rows legitimately stay here.
--   READY    - every expected chunk was confirmed upserted for this exact
--              content hash and model.
--   FAILED   - dead letter (retry budget exhausted) or by-design non-current
--              version (`last_error_code='SUPERSEDED'`) / unindexable content
--              (`last_error_code='TEXT_UNAVAILABLE'`).
--
-- `retired_at` is the "old vector ids must stop being visible" marker; it is
-- set before any asynchronous `deleteByIds`.  Query validation never trusts
-- this table alone: every candidate is re-resolved against research_records.

CREATE TABLE IF NOT EXISTS research_semantic_index_state (
	document_id TEXT NOT NULL,
	version_id TEXT NOT NULL,
	visibility TEXT NOT NULL CHECK (visibility IN ('PUBLIC')),
	state TEXT NOT NULL CHECK (state IN ('PENDING', 'READY', 'FAILED')),
	content_sha256 TEXT,
	model_id TEXT NOT NULL,
	title_only INTEGER NOT NULL DEFAULT 0 CHECK (title_only IN (0, 1)),
	truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
	expected_chunks INTEGER NOT NULL DEFAULT 0,
	confirmed_chunks INTEGER NOT NULL DEFAULT 0,
	attempts INTEGER NOT NULL DEFAULT 0,
	last_error_code TEXT,
	retired_at TEXT,
	vector_deleted_at TEXT,
	registered_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (document_id, version_id)
);

-- Work-queue scan (oldest first) and coverage counts.
CREATE INDEX IF NOT EXISTS research_semantic_index_pending
	ON research_semantic_index_state (state, retired_at, updated_at, document_id, version_id);

-- Vector cleanup scan (retired rows whose vectors still exist).
CREATE INDEX IF NOT EXISTS research_semantic_index_retired
	ON research_semantic_index_state (visibility, retired_at, vector_deleted_at, updated_at);
