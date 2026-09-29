-- 0018: monotonic per-(dimension, period) booked-usage upper bound.
--
-- Audit repair S1 (2026-09-29, independent verification finding 1):
--   0017's guard summed only the LIVE rows of `quota_reservation_units`, but
--   settlement deletes those rows into `quota_reservation_journal`.  Between two
--   VERIFIED account snapshots, spend that had already been admitted and settled
--   therefore vanished from the admission inequality, so the 95% ceiling degraded
--   into a concurrency limiter: N sequential `admit -> settle` cycles could exceed
--   the ceiling with no denial (only the in-flight reservation was ever counted).
--
-- This table is the *cumulative* upper bound the spec §2 calls
-- `unreconciled_reserved`: one row per (dimension, period), incremented in the
-- SAME D1 batch as the reservation it accounts for, and never decremented by
-- settlement or release.  Rows are never scanned for the guard: the admission
-- guard reads exactly one row by primary key per requested dimension, so
-- thousands of backfill operations stay bounded (nothing here grows with history
-- the way the journal does, which the guard never reads).
--
-- Reset semantics (reviewed deliberately): the accumulator is scoped by the
-- natural period key, so a period rollover (`cycle:<start>..<end>` from the
-- operator-verified renewal anchor, or `utc-day:<date>` for Workers AI) starts a
-- new row at zero.  A rollover can only be admitted when a VERIFIED baseline row
-- exists for the new period key, so a new period never silently starts unguarded.
-- Rows are deliberately NOT pruned: keeping the old periods means an anchor that
-- is corrected back to a previous period still finds its spend booked instead of
-- reading a missing row as zero.  Cardinality is operator-controlled (one row per
-- catalog dimension per period the verified anchor ever named), not attacker
-- controlled, so this cannot be used to grow the table.
--
-- Double counting is deliberate and conservative (spec §2 "不确定时保留双计作保守拒绝"):
-- `quota_period_baselines.used` may already include amounts this table also
-- holds, because no proof exists that a provider snapshot accounted for a given
-- Collector reservation.  The inequality therefore counts both; the cost of the
-- double count is earlier refusal, never a false "safe".
--
-- Overflow: `booked_units` is a 64-bit SQLite INTEGER and carries an explicit
-- safe-integer CHECK, so a corrupt or hostile write cannot silently wrap into a
-- value that would look like headroom.

-- Migration safety precondition (FAIL CLOSED).
--
-- The one-time backfill below can only reconstruct spend from `quota_reservation_units`
-- (the live rows).  A reservation that was already SETTLED under 0017 has left the
-- live table and lives only in `quota_reservation_journal`, which does not carry
-- the period key needed to attribute its units to a period.  Applying this
-- migration to an uninitialized database with such history would silently drop
-- that settled spend — the same class of hole this migration exists to close — so
-- it must abort instead.
--
-- Any SETTLED legacy journal row aborts this migration, even when the booked
-- table has been partially populated.  A non-empty accumulator alone cannot
-- prove complete reconciliation across all dimensions and periods.  Reconcile
-- such history separately with an audited, complete migration and independent
-- verification; never delete journal rows to bypass this precondition.
CREATE TABLE IF NOT EXISTS quota_booked_usage (
	dimension_key TEXT NOT NULL,
	period_key TEXT NOT NULL,
	-- Cumulative admitted units for this dimension and period.  Monotonic within
	-- the period: only the admission batch and the operator reconciliation above
	-- ever write it.
	booked_units INTEGER NOT NULL CHECK (booked_units >= 0 AND booked_units <= 9007199254740991),
	-- How many reservations contributed; diagnostic only, never used by the guard.
	booked_reservations INTEGER NOT NULL DEFAULT 0 CHECK (booked_reservations >= 0),
	first_booked_at TEXT NOT NULL,
	last_booked_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (dimension_key, period_key)
);

CREATE TABLE IF NOT EXISTS quota_migration_precondition (
	unreconciled_settled_rows INTEGER NOT NULL,
	CONSTRAINT quota_0018_requires_no_settled_history CHECK (unreconciled_settled_rows = 0)
);
INSERT INTO quota_migration_precondition (unreconciled_settled_rows)
SELECT COUNT(*) FROM quota_reservation_journal WHERE outcome = 'SETTLED';
DROP TABLE quota_migration_precondition;

-- Migration-time backfill: if this migration is ever applied to a database that
-- already carries live reservations from the 0017 guard, treat every live unit
-- row as booked at that instant.  That is the conservative direction (booked >=
-- live) and keeps the invariant `live <= booked` for reservations admitted before
-- this migration.  A partially populated booked table is not proof that other
-- dimension/period live rows were covered: upsert every live group using MAX,
-- which remains idempotent if a migration runner retries after interruption.
INSERT INTO quota_booked_usage
	(dimension_key, period_key, booked_units, booked_reservations, first_booked_at, last_booked_at, updated_at)
SELECT dimension_key,
	period_key,
	SUM(units),
	COUNT(*),
	COALESCE(MIN(a.admitted_at), '1970-01-01T00:00:00.000Z'),
	COALESCE(MAX(a.admitted_at), '1970-01-01T00:00:00.000Z'),
	COALESCE(MAX(a.admitted_at), '1970-01-01T00:00:00.000Z')
FROM quota_reservation_units u
LEFT JOIN quota_reservations a ON a.reservation_id = u.reservation_id
GROUP BY dimension_key, period_key
ON CONFLICT(dimension_key, period_key) DO UPDATE SET
	booked_units = MAX(booked_units, excluded.booked_units),
	booked_reservations = MAX(booked_reservations, excluded.booked_reservations);
