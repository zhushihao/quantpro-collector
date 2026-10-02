-- 0022: per-client Vectorize query accounting column
-- (quota redesign 2026-10-02, P1-3 ledger item).
--
-- One unit = one semantic-search query against the PUBLIC index (queried
-- dimensions / 1024).  Values are measured in-process by the request
-- observer; the official Vectorize meter does not expose monthly query
-- counts, so these columns feed the attribution reports, not the breaker.
ALTER TABLE quota_client_usage_hourly
	ADD COLUMN vectorize_queries INTEGER NOT NULL DEFAULT 0;
