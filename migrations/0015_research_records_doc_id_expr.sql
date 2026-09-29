-- Expression index for the semantic index work queue (ops finding 2026-09-28).
--
-- The semantic index batch (runSemanticIndexBatch) runs auditReadyRows over 50
-- READY rows per run; each audit row resolves its document's versions via
-- documentVersions(), which filters research_records by
-- json_extract(payload_json, '$.document.document_id') = ?.  Without this
-- expression index that predicate is a full table scan (25k+ rows) per lookup:
-- ~1.3M rows read per batch run and ~23s of the 30s run budget spent in D1
-- round trips, leaving only 2-3 documents indexed per run.
--
-- With the index the lookup is an index search (O(log n)), the audit phase
-- collapses to a few hundred row reads, and a run reaches its full
-- SEMANTIC_BATCH_MAX_DOCS = 10 budget.
--
-- Applied to production manually on 2026-09-28 via wrangler d1 execute
-- (CREATE INDEX IF NOT EXISTS research_records_doc_id_expr ...); this file
-- codifies it so a fresh database converges to the same schema.
--
-- Additive only: no table rewrite, no data deletion.  SQLite uses expression
-- indexes automatically when the query expression matches the indexed
-- expression (verified via EXPLAIN QUERY PLAN:
-- "SEARCH research_records USING INDEX research_records_doc_id_expr (<expr>=?)").

CREATE INDEX IF NOT EXISTS research_records_doc_id_expr
	ON research_records (json_extract(payload_json, '$.document.document_id'));
