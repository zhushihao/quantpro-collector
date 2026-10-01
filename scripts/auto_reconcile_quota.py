"""Autonomous quota reconcile: read the official Cloudflare meters and write the
D1 `quota_period_baselines` watermark without any human in the loop.

Issue #54, stage 3 (owner ruling 2026-10-01: "全自动无人值守对账闭环", every 12h).
Stage 1 (`scripts/quota_reconcile_refresh.py`) proved the data shape and the
conservative watermark policy but was operator-run and emitted SQL for a manual
`wrangler d1 execute`.  This script closes the loop:

    read provider usage  ->  compute the watermark  ->  write D1 via REST

Differences from stage 1, each deliberate:
  * The previous watermark is read LIVE from `quota_period_baselines` instead of
    a hard-coded table, so the monotonic `max()` policy keeps holding as the
    values advance (a compiled-in baseline would silently become a ceiling).
  * The write goes through the D1 REST API
    (`/accounts/{id}/d1/database/{id}/query`) so a scheduled task needs only
    `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`; it does not depend on a
    checkout-relative `wrangler` install.
  * The cycle anchor is re-read from the subscriptions API every run and the
    period key is DERIVED, so a renewal rollover starts a new period by itself
    instead of writing into the previous cycle's key.

Fail-closed rules (this script can only ever RAISE the watermark, never lower it,
and never opens a gate):
  * `used = max(previous, fresh)`; `unobserved_upper_bound = max(previous, rule)`.
  * A dimension that cannot be observed is SKIPPED (its previous row, whatever it
    is, stays untouched) — never written as zero.
  * `state` is always written back as `VERIFIED` with `coverage_end = as_of =
    now`; the 95% ceiling itself lives in the guard, not here.
  * Any transport/auth/shape failure exits non-zero WITHOUT writing, so a broken
    run leaves the previous watermark in place rather than corrupting it.

Environment:
  CLOUDFLARE_API_TOKEN    required (read + D1 write scope)
  CLOUDFLARE_ACCOUNT_ID   optional; defaults to the known Collector account
  QUOTA_D1_DATABASE_ID    optional; defaults to the research replica
  QUOTA_RECONCILE_DRY_RUN set to "1" to compute and report without writing

Usage:
  python scripts/auto_reconcile_quota.py            # normal scheduled run
  python scripts/auto_reconcile_quota.py --json     # machine-readable summary
  python scripts/auto_reconcile_quota.py --dry-run  # no D1 write
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

DEFAULT_ACCOUNT = "4b0901ceeeef89ac3b8414d56c50c946"
DEFAULT_D1_DATABASE = "0e20aca4-c394-4f41-aa46-d98831b81836"
API = "https://api.cloudflare.com/client/v4"
GRAPHQL = API + "/graphql"

# Dimensions the reconcile is responsible for, in write order.  `ai.neurons` is
# deliberately absent: its period is the UTC day and it bootstraps itself inside
# the admission path (`src/quota-admission.ts` runtime bootstrap), so writing a
# cycle-scoped row here would be wrong.
DIMENSIONS: tuple[str, ...] = (
    "workers.requests",
    "workers.cpu_ms",
    "d1.rows_read",
    "d1.rows_written",
    "d1.storage_gb_month",
    "kv.reads",
    "kv.writes",
    "kv.deletes",
    "kv.lists",
    "kv.storage_gb_month",
    "r2.class_a",
    "r2.class_b",
    "r2.storage_gb_month",
    "vectorize.queried_dims",
)

# The tail rule proven in stage 1 (2026-09-29 operator seed): reserve three times
# the observed daily burn for the remaining cycle, but never less than a quarter
# of what has already been seen.  Unobserved traffic is exactly what this bounds.
TAIL_DAILY_MULTIPLIER = 3.0
TAIL_USED_FRACTION = 0.25

LOG_DIR = Path(os.environ.get("QUOTA_RECONCILE_LOG_DIR", r"D:\quantpro-collector\logs"))
LOG_NAME = "quota-auto-reconcile.log"


def log(line: str) -> None:
    """Append to the run log (best effort: a logging failure must not fail a run)."""
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        with (LOG_DIR / LOG_NAME).open("a", encoding="utf-8") as handle:
            handle.write(f"{stamp} {line}\n")
    except OSError:
        pass


class ReconcileError(RuntimeError):
    """Any condition that must abort the run without writing."""


def request_json(url: str, token: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method="POST" if body is not None else "GET",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", "replace")[:200]
        except Exception:  # noqa: BLE001 - never let error-path detail mask the status
            pass
        raise ReconcileError(f"HTTP {exc.code} from {url.split('?')[0]}: {detail}") from None
    except urllib.error.URLError as exc:
        raise ReconcileError(f"transport failure to {url.split('?')[0]}: {exc.reason}") from None


def account_of(token: str) -> str:
    return os.environ.get("CLOUDFLARE_ACCOUNT_ID") or DEFAULT_ACCOUNT


def d1_query(token: str, database_id: str, sql: str, params: list | None = None) -> dict:
    payload = {"sql": sql, "params": params or []}
    body = request_json(
        f"{API}/accounts/{account_of(token)}/d1/database/{database_id}/query", token, payload
    )
    if not body.get("success"):
        raise ReconcileError(f"D1 query failed: {json.dumps(body.get('errors'))[:300]}")
    return body


def gql(token: str, account: str, query: str, variables: dict) -> dict:
    payload = request_json(GRAPHQL, token, {"query": query, "variables": variables})
    if payload.get("errors"):
        raise ReconcileError("graphql errors: " + json.dumps(payload["errors"])[:300])
    return payload["data"]["viewer"]["accounts"][0]


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------


def read_cycle_anchor(token: str, account: str) -> tuple[str, str]:
    """Return the CURRENT subscription cycle (start, end); rollover-safe."""
    subs = request_json(f"{API}/accounts/{account}/subscriptions", token)
    if not subs.get("success"):
        raise ReconcileError("subscriptions read was not successful")
    windows: set[tuple[str, str]] = set()
    for entry in subs.get("result", []):
        start, end = entry.get("current_period_start"), entry.get("current_period_end")
        if isinstance(start, str) and isinstance(end, str) and "T" in start and "T" in end:
            windows.add((start, end))
    if not windows:
        raise ReconcileError("no subscription with a parseable current period")
    # A renewal produces several identical windows; more than one distinct window
    # means the account is mid-transition and the answer is not provable.
    if len(windows) != 1:
        raise ReconcileError(f"ambiguous subscription windows: {sorted(windows)}")
    return next(iter(windows))


def read_previous(token: str, database_id: str, period_key: str) -> dict[str, tuple[int, int]]:
    """Read the committed watermark; absence is absence, never zero."""
    body = d1_query(
        token,
        database_id,
        "SELECT dimension_key, used, unobserved_upper_bound FROM quota_period_baselines "
        "WHERE period_key = ?",
        [period_key],
    )
    rows = (body.get("result") or [{}])[0].get("results") or []
    return {
        row["dimension_key"]: (
            int(row["used"] or 0),
            int(row["unobserved_upper_bound"] or 0),
        )
        for row in rows
    }


def observe(token: str, account: str, period_start: str, now: datetime) -> dict[str, int | float]:
    """Every official meter for the cycle, in admission units."""
    today = now.strftime("%Y-%m-%d")
    tomorrow = (now + timedelta(days=1)).strftime("%Y-%m-%d")
    now_iso = now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"
    day_filter = {"date_geq": period_start[:10], "date_lt": tomorrow}

    observed: dict[str, int | float] = {}

    block = gql(
        token,
        account,
        """query($a:String!,$f:WorkersInvocationsAdaptiveFilter_InputObject){
             viewer{accounts(filter:{accountTag:$a}){w:workersInvocationsAdaptive(
               limit:10000,filter:$f){dimensions{date} sum{requests cpuTimeUs}}}}}""",
        {"a": account, "f": day_filter},
    )
    rows = block.get("w")
    if rows is None:
        raise ReconcileError("workersInvocationsAdaptive returned no account block")
    observed["workers.requests"] = sum(r["sum"]["requests"] for r in rows)
    observed["workers.cpu_ms"] = round(sum(r["sum"]["cpuTimeUs"] for r in rows) / 1000)

    # D1: two official datasets describe the same account.  Take the larger
    # (fail-closed); on 2026-09-30 both agreed exactly with the billable row.
    d1_totals: list[tuple[int, int]] = []
    for dataset in ("d1AnalyticsAdaptiveGroups", "d1QueriesAdaptiveGroups"):
        block = gql(
            token,
            account,
            f"""query($a:String!,$f:{dataset.capitalize()}Filter_InputObject){{
                 viewer{{accounts(filter:{{accountTag:$a}}){{d:{dataset}(
                   limit:10000,filter:$f){{dimensions{{date}} sum{{rowsRead rowsWritten}}}}}}}}}}""",
            {"a": account, "f": day_filter},
        )
        rows = block.get("d")
        if rows is None:
            raise ReconcileError(f"{dataset} returned no account block")
        d1_totals.append(
            (
                sum(r["sum"]["rowsRead"] for r in rows),
                sum(r["sum"]["rowsWritten"] for r in rows),
            )
        )
    observed["d1.rows_read"] = max(pair[0] for pair in d1_totals)
    observed["d1.rows_written"] = max(pair[1] for pair in d1_totals)

    block = gql(
        token,
        account,
        """query($a:String!,$f:D1StorageAdaptiveGroupsFilter_InputObject){
             viewer{accounts(filter:{accountTag:$a}){s:d1StorageAdaptiveGroups(
               limit:1000,filter:$f,orderBy:[date_ASC]){
               dimensions{date} max{databaseSizeBytes}}}}}""",
        {"a": account, "f": {"date_geq": period_start[:10]}},
    )
    rows = block.get("s")
    if rows is None:
        raise ReconcileError("d1StorageAdaptiveGroups returned no account block")
    observed["_d1_bytes"] = max((r["max"]["databaseSizeBytes"] or 0) for r in rows)

    block = gql(
        token,
        account,
        """query($a:String!,$f:KvOperationsAdaptiveGroupsFilter_InputObject){
             viewer{accounts(filter:{accountTag:$a}){k:kvOperationsAdaptiveGroups(
               limit:10000,filter:$f){dimensions{actionType date} sum{requests}}}}}""",
        {"a": account, "f": day_filter},
    )
    rows = block.get("k")
    if rows is None:
        raise ReconcileError("kvOperationsAdaptiveGroups returned no account block")
    kv_ops: dict[str, int] = {}
    for row in rows:
        action = row["dimensions"]["actionType"] or "unknown"
        kv_ops[action] = kv_ops.get(action, 0) + row["sum"]["requests"]
    observed["kv.reads"] = kv_ops.get("read", 0)
    observed["kv.writes"] = kv_ops.get("write", 0)
    observed["kv.deletes"] = kv_ops.get("delete", 0)
    observed["kv.lists"] = kv_ops.get("list", 0)

    block = gql(
        token,
        account,
        """query($a:String!,$f:KvStorageAdaptiveGroupsFilter_InputObject){
             viewer{accounts(filter:{accountTag:$a}){s:kvStorageAdaptiveGroups(
               limit:1000,filter:$f,orderBy:[date_ASC]){
               dimensions{date} max{byteCount}}}}}""",
        {"a": account, "f": {"date_geq": period_start[:10]}},
    )
    rows = block.get("s")
    if rows is None:
        raise ReconcileError("kvStorageAdaptiveGroups returned no account block")
    observed["_kv_bytes"] = max((r["max"]["byteCount"] or 0) for r in rows)

    block = gql(
        token,
        account,
        """query($a:String!,$f:R2OperationsAdaptiveGroupsFilter_InputObject){
             viewer{accounts(filter:{accountTag:$a}){o:r2OperationsAdaptiveGroups(
               limit:10000,filter:$f){dimensions{actionType storageClass} sum{requests}}}}}""",
        {"a": account, "f": {"datetimeHour_geq": period_start, "datetimeHour_lt": now_iso}},
    )
    rows = block.get("o")
    if rows is None:
        raise ReconcileError("r2OperationsAdaptiveGroups returned no account block")
    class_a = class_b = 0
    for row in rows:
        action = row["dimensions"]["actionType"] or ""
        # R2 classes: PUT/POST/PATCH/DELETE/LIST are Class A; GET/HEAD are Class B.
        if action in ("GetObject", "HeadObject", "HeadBucket"):
            class_b += row["sum"]["requests"]
        else:
            class_a += row["sum"]["requests"]
    observed["r2.class_a"] = class_a
    observed["r2.class_b"] = class_b

    block = gql(
        token,
        account,
        """query($a:String!,$f:R2StorageAdaptiveGroupsFilter_InputObject){
             viewer{accounts(filter:{accountTag:$a}){s:r2StorageAdaptiveGroups(
               limit:1000,filter:$f,orderBy:[date_ASC]){
               dimensions{date} max{payloadSize metadataSize}}}}}""",
        {"a": account, "f": {"date_geq": period_start[:10]}},
    )
    rows = block.get("s")
    if rows is None:
        raise ReconcileError("r2StorageAdaptiveGroups returned no account block")
    observed["_r2_bytes"] = max(
        (r["max"]["payloadSize"] or 0) + (r["max"]["metadataSize"] or 0) for r in rows
    )

    # Vectorize: the `datetimeHour` buckets of this dataset are cumulative within
    # the UTC day (proven 2026-10-01: day 1,827,840 vs last hour bucket
    # 1,771,520), so ONLY the `date` grain may be summed.
    block = gql(
        token,
        account,
        """query($a:String!,$f:VectorizeV2QueriesAdaptiveGroupsFilter_InputObject){
             viewer{accounts(filter:{accountTag:$a}){q:vectorizeV2QueriesAdaptiveGroups(
               limit:10000,filter:$f){dimensions{date} sum{queriedVectorDimensions}}}}}""",
        {"a": account, "f": {"date_geq": period_start[:10]}},
    )
    rows = block.get("q")
    if rows is None:
        raise ReconcileError("vectorizeV2QueriesAdaptiveGroups returned no account block")
    observed["vectorize.queried_dims"] = sum(r["sum"]["queriedVectorDimensions"] for r in rows)

    return observed


def storage_units(bytes_value: int, elapsed_days: float) -> int:
    """GB-month integral approximation in the catalog's milli-GB-month units."""
    span = elapsed_days / 30.44
    return math.floor(bytes_value / 1e9 * 1000.0 * span)


# ---------------------------------------------------------------------------
# Write
# ---------------------------------------------------------------------------


# The D1 REST endpoint rejects a statement with more than 100 bound variables
# (probed 2026-10-01: 100 OK, 101 -> "too many SQL variables").  14 dimensions x
# 9 values would be 126, so only the three per-dimension DATA values stay bound;
# the seven server-generated values (period key, state, source, timestamps) are
# inlined after strict ISO-8601 validation plus quote escaping.  Nothing a caller
# can influence reaches the SQL text.
ISO_INSTANT = r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$"
PERIOD_KEY_PATTERN = rf"^cycle:\d{{4}}-\d{{2}}-\d{{2}}T\d{{2}}:\d{{2}}:\d{{2}}Z\.\.\d{{4}}-\d{{2}}-\d{{2}}T\d{{2}}:\d{{2}}:\d{{2}}Z$"


def sql_literal(value: str) -> str:
    """A single-quoted SQL literal for an already-validated server-side string."""
    return "'" + value.replace("'", "''") + "'"


def build_upsert(
    previous: dict[str, tuple[int, int]],
    observed: dict[str, int | float],
    period_key: str,
    now_iso: str,
    elapsed_days: float,
    remaining_days: float,
    source_version: str,
) -> tuple[str, list, list[dict], list[str]]:
    """Compute the conservative rows and the single-statement UPSERT."""
    if not re.match(ISO_INSTANT, now_iso):
        raise ReconcileError(f"refusing to inline a non-ISO timestamp: {now_iso!r}")
    if not re.match(PERIOD_KEY_PATTERN, period_key):
        raise ReconcileError(f"refusing to inline a malformed period key: {period_key!r}")
    if not re.match(ISO_INSTANT, source_version.rsplit(" ", 1)[-1]):
        raise ReconcileError(f"refusing to inline a malformed source version: {source_version!r}")

    source = f"auto-reconcile {now_iso} (official Cloudflare meters; monotonic fail-closed)"
    # Column order is (dimension_key, period_key, state, used,
    # unobserved_upper_bound, source, source_version, as_of, coverage_end,
    # recorded_at).  Only the three per-row DATA values stay bound; the values
    # BEFORE `used` and AFTER `unobserved_upper_bound` are server-generated and
    # inlined (validated + escaped), because 14 rows x 9 values would exceed the
    # D1 REST 100-variable cap.
    prefix = f"{sql_literal(period_key)}, 'VERIFIED'"
    suffix = (
        f"{sql_literal(source)}, {sql_literal(source_version)}, "
        f"{sql_literal(now_iso)}, {sql_literal(now_iso)}, {sql_literal(now_iso)}"
    )

    computed: list[dict] = []
    values: list = []
    placeholders: list[str] = []
    skipped: list[str] = []

    for key in DIMENSIONS:
        if key not in observed:
            skipped.append(key)
            continue
        fresh = int(observed[key])
        prev_used, prev_tail = previous.get(key, (0, 0))
        used = max(prev_used, fresh)
        daily = fresh / elapsed_days if elapsed_days > 0 else 0.0
        rule_tail = math.ceil(
            max(daily * remaining_days * TAIL_DAILY_MULTIPLIER, used * TAIL_USED_FRACTION)
        )
        tail = max(prev_tail, rule_tail)
        computed.append(
            {
                "dimension_key": key,
                "observed": fresh,
                "used": used,
                "unobserved_upper_bound": tail,
            }
        )
        placeholders.append(f"(?, {prefix}, ?, ?, {suffix})")
        values.extend([key, used, tail])

    sql = (
        "INSERT INTO quota_period_baselines "
        "(dimension_key, period_key, state, used, unobserved_upper_bound, source, "
        " source_version, as_of, coverage_end, recorded_at) VALUES "
        + ", ".join(placeholders)
        + " ON CONFLICT(dimension_key, period_key) DO UPDATE SET "
        "state=excluded.state, used=excluded.used, "
        "unobserved_upper_bound=excluded.unobserved_upper_bound, "
        "source=excluded.source, source_version=excluded.source_version, "
        "as_of=excluded.as_of, coverage_end=excluded.coverage_end, "
        "recorded_at=excluded.recorded_at"
    )
    return sql, values, computed, skipped


def main() -> int:
    parser = argparse.ArgumentParser(description="Autonomous quota reconcile (issue #54 stage 3)")
    parser.add_argument("--json", action="store_true", help="print a machine-readable summary")
    parser.add_argument("--dry-run", action="store_true", help="compute without writing to D1")
    args = parser.parse_args()

    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    if not token:
        log("ABORT CLOUDFLARE_API_TOKEN is not set")
        print("CLOUDFLARE_API_TOKEN is not set", file=sys.stderr)
        return 2
    dry_run = args.dry_run or os.environ.get("QUOTA_RECONCILE_DRY_RUN") == "1"
    database_id = os.environ.get("QUOTA_D1_DATABASE_ID") or DEFAULT_D1_DATABASE
    account = account_of(token)

    try:
        now = datetime.now(timezone.utc)
        now_iso = now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"
        period_start, period_end = read_cycle_anchor(token, account)
        period_key = f"cycle:{period_start}..{period_end}"
        start_dt = datetime.fromisoformat(period_start.replace("Z", "+00:00"))
        end_dt = datetime.fromisoformat(period_end.replace("Z", "+00:00"))
        if not start_dt <= now < end_dt:
            raise ReconcileError(
                f"now {now_iso} is outside the subscription cycle "
                f"{period_start}..{period_end}; refusing to write"
            )
        elapsed_days = (now - start_dt).total_seconds() / 86400.0
        remaining_days = (end_dt - now).total_seconds() / 86400.0

        previous = read_previous(token, database_id, period_key)
        observed = observe(token, account, period_start, now)
        # Storage integrals need the elapsed span, so they are derived after the
        # byte peaks are known.
        observed["d1.storage_gb_month"] = storage_units(
            int(observed.pop("_d1_bytes")), elapsed_days
        )
        observed["kv.storage_gb_month"] = storage_units(
            int(observed.pop("_kv_bytes")), elapsed_days
        )
        observed["r2.storage_gb_month"] = storage_units(
            int(observed.pop("_r2_bytes")), elapsed_days
        )

        sql, values, computed, skipped = build_upsert(
            previous,
            observed,
            period_key,
            now_iso,
            elapsed_days,
            remaining_days,
            f"auto_reconcile_quota {now_iso}",
        )
        if len(computed) != len(DIMENSIONS):
            raise ReconcileError(f"refusing to write a partial refresh; skipped={skipped}")

        written = 0
        if not dry_run:
            body = d1_query(token, database_id, sql, values)
            result = (body.get("result") or [{}])[0]
            written = int(result.get("meta", {}).get("changes") or 0)
            # Post-write integrity gate.  A column-order fault on 2026-10-01 wrote
            # provenance TEXT into `used`, and SQLite turns `text + text` into 0
            # while `text >= 0` stays TRUE -- i.e. the 95% ceiling silently became
            # fail-OPEN.  Re-read the numeric columns and refuse (non-zero exit) if
            # any row is not an integer, so a recurrence is loud instead of quiet.
            verify = d1_query(
                token,
                database_id,
                "SELECT COUNT(*) AS bad FROM quota_period_baselines "
                "WHERE period_key = ? AND (typeof(used) <> 'integer' "
                "OR typeof(unobserved_upper_bound) <> 'integer')",
                [period_key],
            )
            bad = int(((verify.get("result") or [{}])[0].get("results") or [{}])[0].get("bad") or 0)
            if bad != 0:
                raise ReconcileError(
                    f"post-write verification found {bad} non-integer watermark rows "
                    f"for {period_key}; the 95% ceiling would be fail-open"
                )

        summary = {
            "as_of": now_iso,
            "period_key": period_key,
            "elapsed_days": round(elapsed_days, 3),
            "remaining_days": round(remaining_days, 3),
            "dry_run": dry_run,
            "dimensions_written": len(computed),
            "rows_changed": written,
            "dimensions": computed,
        }
        log(
            "OK "
            + json.dumps(
                {
                    "as_of": now_iso,
                    "dry_run": dry_run,
                    "dimensions": len(computed),
                    "rows_changed": written,
                    "period_key": period_key,
                }
            )
        )
        if args.json:
            print(json.dumps(summary, indent=1))
        else:
            print(f"reconcile OK as_of={now_iso} dimensions={len(computed)} "
                  f"rows_changed={written}{' (dry-run)' if dry_run else ''}")
            for record in computed:
                print(
                    f"  {record['dimension_key']:<24} observed={record['observed']:>14,} "
                    f"used={record['used']:>14,} tail={record['unobserved_upper_bound']:>13,}"
                )
        return 0
    except ReconcileError as exc:
        log(f"ABORT {exc}")
        print(f"reconcile aborted: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001 - a scheduled run must never traceback silently
        log(f"ABORT unexpected {type(exc).__name__}: {exc}")
        print(f"reconcile aborted unexpectedly: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
