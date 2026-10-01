-- Issue #54 stage 1 verification probe (read-only).
-- Mirrors the four conjuncts of buildGuardSql (src/quota-admission.ts:326-366)
-- with the CURRENT catalog version and a live `now`, for the routes that were
-- returning QUOTA_GUARD_UNAVAILABLE before the 2026-10-01 baseline refresh.
--
-- billing_cycle baseline_cutoff = now - 26h (BASELINE_COVERAGE_AGE_MS).
-- Replace :cutoff / :now when re-running (both are derived from the wall clock).
WITH req(dimension_key, period_key, period_kind, units, baseline_cutoff) AS (VALUES
 ('d1.rows_read',    'cycle:2026-09-13T15:01:34Z..2026-10-13T00:00:00Z', 'billing_cycle', 32,     '2026-09-30T14:55:00Z'),
 ('d1.rows_written', 'cycle:2026-09-13T15:01:34Z..2026-10-13T00:00:00Z', 'billing_cycle', 32,     '2026-09-30T14:55:00Z'),
 ('kv.reads',        'cycle:2026-09-13T15:01:34Z..2026-10-13T00:00:00Z', 'billing_cycle', 32,     '2026-09-30T14:55:00Z'),
 ('r2.class_a',      'cycle:2026-09-13T15:01:34Z..2026-10-13T00:00:00Z', 'billing_cycle', 2,      '2026-09-30T14:55:00Z'),
 ('vectorize.queried_dims','cycle:2026-09-13T15:01:34Z..2026-10-13T00:00:00Z','billing_cycle', 1024, '2026-09-30T14:55:00Z'))
SELECT r.dimension_key,
 EXISTS(SELECT 1 FROM quota_dimension_catalog c
        WHERE c.dimension_key=r.dimension_key AND c.provable=1
          AND c.threshold_95 IS NOT NULL AND c.period_kind=r.period_kind
          AND c.catalog_version='quota-catalog/2026-09-30.5') AS catalog_ok,
 EXISTS(SELECT 1 FROM quota_period_baselines b
        WHERE b.dimension_key=r.dimension_key AND b.period_key=r.period_key
          AND b.state='VERIFIED'
          AND b.coverage_end BETWEEN r.baseline_cutoff AND '2026-10-01T16:55:00Z'
          AND b.as_of BETWEEN b.coverage_end AND '2026-10-01T16:55:00Z') AS baseline_ok,
 COALESCE((SELECT bu.booked_units FROM quota_booked_usage bu
           WHERE bu.dimension_key=r.dimension_key AND bu.period_key=r.period_key),0)
  + (SELECT b.used + b.unobserved_upper_bound FROM quota_period_baselines b
     WHERE b.dimension_key=r.dimension_key AND b.period_key=r.period_key)
  + r.units AS committed,
 (SELECT c.threshold_95 FROM quota_dimension_catalog c
  WHERE c.dimension_key=r.dimension_key) AS thr,
 (SELECT b.coverage_end FROM quota_period_baselines b
  WHERE b.dimension_key=r.dimension_key AND b.period_key=r.period_key) AS coverage_end
FROM req r;
