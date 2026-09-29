/**
 * FTS5 trigram shadow index over PUBLIC document_version search text
 * (2026-09-28, issue #10 owner ruling 方案① — no paid plan).
 *
 * Why: the word-search face ran a case-folded LIKE over
 * json_extract(payload_json,'$.document.title') on every query — a full
 * 25k-row scan per search, several searches per automation round, which blew
 * through D1's free-tier daily row-read limit. FTS5 + the trigram tokenizer
 * gives case-insensitive substring matching over CJK and Latin alike (for
 * queries of at least three characters) while reading only the index hits.
 *
 * Invariants:
 * - Shadow rows ride the same ingest transaction as the record upsert, so a
 *   stored PUBLIC version is searchable without a full-table scan and a crash
 *   cannot leave a stored row unsynced (same argument as
 *   semanticIndexIngestStatements).
 * - The FTS table is a pure accelerator: visibility, retention-expiry and
 *   record existence are still owned by the records query that consumes the
 *   hit set, so a match here can never widen what a reader may see.
 * - Rows are keyed by record_key (the version id); replays delete-then-insert,
 *   so the shadow text always mirrors the newest accepted payload.
 */
import type { OutboundV2Record } from "./research-outbound-v2.ts";

/** Minimum query length the trigram tokenizer can match (shorter falls back to LIKE). */
export const FTS_TRIGRAM_MIN = 3;

/**
 * D1 statements maintaining the FTS shadow row for a validated outbound
 * record. Empty for anything but PUBLIC document_version rows.
 */
export function ftsIngestStatements(
	db: D1Database,
	record: OutboundV2Record,
	recordKey: string,
): D1PreparedStatement[] {
	if (record.record_type !== "document_version" || record.visibility !== "PUBLIC") return [];
	const payload = record.payload as { document?: Record<string, unknown> };
	const document = payload?.document;
	const documentId = typeof document?.document_id === "string" ? document.document_id : "";
	if (!documentId) return [];
	const title = typeof document?.title === "string" ? document.title : "";
	return [
		db.prepare("DELETE FROM research_documents_fts WHERE record_key = ?").bind(recordKey),
		db
			.prepare("INSERT INTO research_documents_fts(record_key, document_id, text) VALUES (?, ?, ?)")
			.bind(recordKey, documentId, title),
	];
}

/** Quote a raw query as an FTS5 phrase so it matches as a literal substring. */
export function ftsPhraseQuery(needle: string): string {
	const trimmed = needle.trim();
	if (!trimmed) return "";
	return `"${trimmed.replace(/"/g, '""')}"`;
}
