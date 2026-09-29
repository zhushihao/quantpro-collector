-- 0017: multi-dimension 95% admission ledger for the Collector (SDD CQ spec
-- §"准入、原子性、异步和恢复合同").
--
-- Why a ledger and not a counter:
--   * Admission must be atomic across EVERY affected billing dimension before the
--     first paid side effect.  The reservation is a single conditional
--     INSERT..SELECT over `quota_reservation_units`; the seal row in
--     `quota_reservations` carries a CHECK(applied = expected) where `applied`
--     is computed in-database, so a partially admitted reservation aborts the
--     whole D1 batch (verified against real local workerd D1, see
--     scripts/quota_d1_local_check.mjs).
--   * The live unit table is the authoritative "reserved" aggregate, so the guard
--     never needs a separate counter that could drift.
--
-- Bounded reads (spec §5): the live tables only ever hold ADMITTED rows; settled
-- and released reservations are moved to `quota_reservation_journal` and deleted
-- from the live tables.  The admission statement refuses to add rows once the
-- live row count would exceed the configured cap, which bounds every guard
-- subquery by that cap.  The journal is only ever read by (operation_id,
-- reservation_id) index lookups for replay, never scanned by the guard.
--
-- Period model: no UTC calendar month and no month/31 anywhere.  Billing-cycle
-- dimensions use the operator-verified account period anchor; `ai.neurons` uses
-- the official UTC day; storage dimensions are reserved as milli-GB-month
-- integers against the current cycle window.

-- Operator-verified account billing period (subscription renewal anchor).
CREATE TABLE IF NOT EXISTS quota_account_periods (
	account_id TEXT PRIMARY KEY,
	period_start TEXT NOT NULL,
	period_end TEXT NOT NULL,
	anchor_kind TEXT NOT NULL CHECK (anchor_kind IN ('subscription_renewal', 'unknown')),
	source TEXT NOT NULL,
	source_version TEXT NOT NULL,
	verified_at TEXT NOT NULL,
	recorded_at TEXT NOT NULL,
	CHECK (period_end > period_start)
);

-- Authoritative watermark per dimension and period.  A row is only usable for
-- admission when state = 'VERIFIED'; `used` is provider-reported usage in
-- admission units and `unobserved_upper_bound` is the explicit, operator
-- registered bound for everything the provider report cannot see yet (including
-- inbound requests and in-flight asynchronous work).  Missing rows are UNKNOWN,
-- never zero.
CREATE TABLE IF NOT EXISTS quota_period_baselines (
	dimension_key TEXT NOT NULL,
	period_key TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('VERIFIED', 'UNVERIFIED', 'STALE', 'DENIED', 'INCOMPLETE')),
	used INTEGER NOT NULL CHECK (used >= 0),
	unobserved_upper_bound INTEGER NOT NULL CHECK (unobserved_upper_bound >= 0),
	source TEXT NOT NULL,
	source_version TEXT NOT NULL,
	as_of TEXT NOT NULL,
	coverage_end TEXT,
	recorded_at TEXT NOT NULL,
	PRIMARY KEY (dimension_key, period_key)
);

-- In-database audit copy of the code catalog.  The admission guard requires a
-- matching, provable, current-version row here, so a stale or hand-edited
-- catalog fails closed instead of widening the ceiling.
CREATE TABLE IF NOT EXISTS quota_dimension_catalog (
	dimension_key TEXT PRIMARY KEY,
	unit TEXT NOT NULL,
	period_kind TEXT NOT NULL CHECK (period_kind IN ('billing_cycle', 'utc_day', 'storage_integral')),
	included INTEGER,
	threshold_95 INTEGER,
	provable INTEGER NOT NULL CHECK (provable IN (0, 1)),
	catalog_version TEXT NOT NULL,
	recorded_at TEXT NOT NULL
);

-- Reservation header.  `applied` is computed in-database by the seal statement;
-- CHECK(applied = expected) turns a partially guarded reservation into a batch
-- abort (all-or-nothing).  `expires_at` is informational only: a reservation is
-- never released by timeout, because an unknown asynchronous outcome must stay
-- reserved (spec §3).
CREATE TABLE IF NOT EXISTS quota_reservations (
	reservation_id TEXT PRIMARY KEY,
	operation_id TEXT NOT NULL,
	fingerprint TEXT NOT NULL,
	route TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('ADMITTED')),
	admitted_at TEXT NOT NULL,
	expires_at TEXT,
	expected INTEGER NOT NULL CHECK (expected > 0),
	applied INTEGER NOT NULL CHECK (applied >= 0),
	CHECK (applied = expected)
);

-- One logical operation can hold at most one live reservation: a replay with the
-- same operation id and fingerprint re-reads the receipt instead of reserving a
-- second physical cost; a different fingerprint for a known operation id is
-- rejected.
CREATE UNIQUE INDEX IF NOT EXISTS quota_reservations_operation
	ON quota_reservations (operation_id);

-- Live reserved units.  Only ADMITTED rows exist: settle/release moves them to
-- the journal and deletes them, which is what bounds the guard subqueries.
CREATE TABLE IF NOT EXISTS quota_reservation_units (
	reservation_id TEXT NOT NULL,
	dimension_key TEXT NOT NULL,
	period_key TEXT NOT NULL,
	units INTEGER NOT NULL CHECK (units >= 0),
	state TEXT NOT NULL DEFAULT 'ADMITTED' CHECK (state IN ('ADMITTED')),
	PRIMARY KEY (reservation_id, dimension_key)
);

-- Guard aggregate lookup (per dimension/period) and live-row cap lookup.
CREATE INDEX IF NOT EXISTS quota_reservation_units_guard
	ON quota_reservation_units (dimension_key, period_key, state);
CREATE INDEX IF NOT EXISTS quota_reservation_units_live
	ON quota_reservation_units (state);

-- Completed reservations (settled with observed actuals, or released with a
-- proof that no provider call was sent).  Keeps replay receipts and the audit
-- trail without leaving rows in the live guard tables.
CREATE TABLE IF NOT EXISTS quota_reservation_journal (
	journal_id INTEGER PRIMARY KEY AUTOINCREMENT,
	reservation_id TEXT NOT NULL,
	operation_id TEXT NOT NULL,
	fingerprint TEXT NOT NULL,
	route TEXT NOT NULL,
	outcome TEXT NOT NULL CHECK (outcome IN ('SETTLED', 'RELEASED')),
	outcome_reason TEXT NOT NULL,
	expected_units_json TEXT NOT NULL,
	observed_units_json TEXT NOT NULL,
	recorded_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS quota_reservation_journal_operation
	ON quota_reservation_journal (operation_id);
CREATE INDEX IF NOT EXISTS quota_reservation_journal_reservation
	ON quota_reservation_journal (reservation_id);
