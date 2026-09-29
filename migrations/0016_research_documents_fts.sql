-- 0016: FTS5 trigram search index over PUBLIC document_version searchable text.
--
-- Why (2026-09-28, issue #10 owner ruling "方案①, no paid plan"): the word
-- search face (searchDocuments) ran a case-folded LIKE over
-- json_extract(payload_json,'$.document.title') on every query — a full
-- 25k-row table scan per search, several searches per automation round, which
-- blew through D1's free-tier daily row-read limit and degraded every task's
-- documents= health signal.
--
-- FTS5 with the trigram tokenizer gives substring matching over CJK and Latin
-- alike (queries of >= 3 characters) while reading only the index hits.  The
-- shadow rows are written in the same transaction as the record upsert (same
-- crash-window argument as semanticIndexIngestStatements) and are backfilled
-- for the existing corpus below.  Rows are never deleted from the FTS table:
-- visibility, retention expiry and current-version semantics stay owned by
-- the records query that consumes the hit set, so FTS can never widen what a
-- reader may see.
--
-- Backfill: one INSERT..SELECT over research_records (title from the frozen
-- payload JSON) — D1-internal, no R2 reads, completes in one statement.

CREATE VIRTUAL TABLE IF NOT EXISTS research_documents_fts USING fts5(
  record_key UNINDEXED,
  document_id UNINDEXED,
  text,
  tokenize = 'trigram'
);

INSERT INTO research_documents_fts(record_key, document_id, text)
SELECT record_key,
       json_extract(payload_json, '$.document.document_id'),
       COALESCE(json_extract(payload_json, '$.document.title'), '')
FROM research_records
WHERE record_type = 'document_version'
  AND visibility = 'PUBLIC';
