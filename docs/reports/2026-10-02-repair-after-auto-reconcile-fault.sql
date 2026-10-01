-- Repair after the faulty auto-reconcile column-order write (2026-10-01T18:43:20.758Z).
--
-- A commit-time bug in scripts/auto_reconcile_quota.py emitted
--   VALUES (?, <period_key>, 'VERIFIED', ?, ?, <source>, <source_version>, ...)
-- but bound the values as (dimension_key, used, tail).  The real column order is
--   (dimension_key, period_key, state, used, unobserved_upper_bound, source,
--    source_version, as_of, coverage_end, recorded_at)
-- so every value after `dimension_key` shifted two positions left:
--
--   column                    | written value          | correct value
--   --------------------------+------------------------+----------------
--   period_key                | (correct)              | period_key
--   state                     | (correct)              | VERIFIED
--   used                      | source TEXT            | integer
--   unobserved_upper_bound    | source_version TEXT    | integer
--   source                    | as_of ISO              | provenance TEXT
--   source_version            | as_of ISO              | provenance TEXT
--   as_of                     | as_of ISO              | timestamp
--   coverage_end              | integer  <- USED       | timestamp
--   recorded_at               | integer  <- TAIL       | timestamp
--
-- Impact: `used` and `unobserved_upper_bound` became TEXT.  SQLite evaluates
-- `text + text` as 0 and `text >= 0` as TRUE, so the guard's ceiling check
--   booked + used + unobserved_upper_bound + units <= threshold
-- passed vacuously -- the 95% circuit was FAIL-OPEN for the 9 minutes between
-- the faulty write and this repair.  The two real integers survived in
-- coverage_end (used) and recorded_at (tail) and are restored from there.
--
-- This statement is deliberately self-verifying: the WHERE clause only touches
-- rows whose numeric columns are still non-numeric, so re-running it is a no-op
-- and it cannot overwrite a later, healthy reconcile.
UPDATE quota_period_baselines SET
 state = 'VERIFIED',
 used = CAST(coverage_end AS INTEGER),
 unobserved_upper_bound = CAST(recorded_at AS INTEGER),
 source = 'operator repair 2026-10-02T02:53+08: corrected the 18:43:20.758Z auto-reconcile column-order fault; numeric watermark restored from the shifted integers',
 source_version = 'repair_after_auto_reconcile_column_fault_20261002',
 as_of = '2026-10-01T18:53:00.000Z',
 coverage_end = '2026-10-01T18:53:00.000Z',
 recorded_at = '2026-10-01T18:53:00.000Z'
WHERE period_key LIKE 'cycle:%'
  AND typeof(used) <> 'integer'
  AND typeof(coverage_end) = 'text'
  AND CAST(coverage_end AS INTEGER) > 0;
