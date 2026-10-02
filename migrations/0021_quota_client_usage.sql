-- 0021: post-hoc per-client usage ledger + resource circuit state
-- (quota redesign 2026-10-02, spec section 3 contracts 1 and 2, Phase 2).
--
-- Design shift (spec section 1): the former front admission gate is gone.  The
-- Collector now MEASURES after the fact and only breaks a circuit when the 12h
-- official-meter reconcile (Phase 3, an out-of-repo script holding the account
-- API token) detects a real 95% breach.  These two tables are the ledger the
-- accounting middleware writes and the single state row set that gate reads.
--
-- Contract highlights:
--   * quota_client_usage_hourly aggregates per (hour, client, route): one UPSERT
--     per request that measured paid-resource usage, never one row per request.
--     Requests whose observers measured nothing (auth refusals, zero-usage
--     tools) write nothing, so anonymous traffic cannot inject rows.
--     client_id comes ONLY from a verified credential identity (bridge-stamped
--     principal, static registered principal, or the internal transport
--     credential); callers that cannot be distinguished are recorded as
--     'unattributed'.  IP headers are never an identity input.
--   * Column coverage is deliberate: d1.rows_read / d1.rows_written are the
--     dimensions the in-process observers can actually measure today.
--     ai.neurons has a column for future in-process accounting, but the
--     authoritative neuron truth is the official Cloudflare meter, reconciled
--     every 12h.  Dimensions without a column here (R2 classes, KV, ...) stay in
--     the structured 'quota_observation' log lines.
--   * quota_circuit_state is written ONLY by the reconcile program.  No
--     production code path flips it.  state = 'OPEN' blocks exactly the high
--     compute query surface (mcp:search_documents_semantic, dimensions
--     ai.neurons + vectorize.queried_dims); lifeline reads (quotes, heartbeat,
--     status probes, get_document / lexical search) never consult this table.

-- Per-hour, per-client, per-route usage aggregate (spec contract 1).
CREATE TABLE IF NOT EXISTS quota_client_usage_hourly (
	period_hour TEXT NOT NULL, -- 'YYYY-MM-DDTHH:00:00Z', UTC hour bucket
	client_id TEXT NOT NULL, -- verified identity or 'unattributed'
	route TEXT NOT NULL, -- 'mcp:search_documents_semantic', 'http:/internal/...' ...
	call_count INTEGER NOT NULL DEFAULT 0 CHECK (call_count >= 0),
	d1_rows_read INTEGER NOT NULL DEFAULT 0
		CHECK (d1_rows_read >= 0 AND d1_rows_read <= 9007199254740991),
	d1_rows_written INTEGER NOT NULL DEFAULT 0
		CHECK (d1_rows_written >= 0 AND d1_rows_written <= 9007199254740991),
	ai_neurons REAL NOT NULL DEFAULT 0 CHECK (ai_neurons >= 0),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (period_hour, client_id, route)
);

CREATE INDEX IF NOT EXISTS idx_quota_usage_hour ON quota_client_usage_hourly (period_hour);

-- Resource-level circuit state (spec contract 2).  Row absence = CLOSED by
-- construction: the gate treats a missing row (or an unreadable table) as
-- allowed, because a broken breaker must never become a new front-gate outage.
CREATE TABLE IF NOT EXISTS quota_circuit_state (
	dimension_key TEXT PRIMARY KEY, -- ai.neurons | vectorize.queried_dims | d1.rows_read | ...
	state TEXT NOT NULL CHECK (state IN ('CLOSED', 'OPEN')),
	-- Official meter truth; -1 sentinel = the dimension has NO official meter
	-- (e.g. Vectorize query counts): reconcile writes the sentinel, keeps the
	-- row CLOSED and never trips the gate on it.  Not a non-negative CHECK on
	-- purpose -- the sentinel must be storable (P1-2 contract, 2026-10-02).
	current_usage REAL NOT NULL,
	threshold_95 REAL NOT NULL CHECK (threshold_95 >= 0), -- the 95% line that tripped
	as_of TEXT NOT NULL, -- reconcile timestamp the values were read at
	updated_at TEXT NOT NULL
);
