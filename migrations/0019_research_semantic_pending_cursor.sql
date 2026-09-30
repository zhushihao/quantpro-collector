-- Bounded semantic maintenance queue cursor (2026-09-30).
-- The local-GPU runner pages registered PENDING/READY versions by immutable
-- (document_id, version_id); this covering prefix avoids a full scan at the
-- current 15k+ version scale and keeps D1 row reads inside the declared cap.
CREATE INDEX IF NOT EXISTS research_semantic_index_state_cursor
    ON research_semantic_index_state (state, document_id, version_id, retired_at, updated_at, content_sha256);
