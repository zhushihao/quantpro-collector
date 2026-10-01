"""Read-only Cloudflare usage reconciliation + baseline refresh SQL generator.

Issue #54, stage 1 (2026-10-01/02): the admission guard's 26h freshness window
had expired (last operator refresh 2026-09-30T03:30:51Z) so every billing-cycle
dimension read CLOSED.  This script re-reads the official Cloudflare sources for
the current subscription cycle and emits the UPDATE/INSERT SQL for
`quota_period_baselines` (executed separately via wrangler for auditability).

Sources (all read-only, token from CLOUDFLARE_API_TOKEN, never printed):
  * GET  /accounts/{id}/subscriptions          -> cycle anchor re-verification
  * GET  /accounts/{id}/billable-usage         -> provider billing rows
  * POST /graphql  workersInvocationsAdaptive  -> requests, cpuTimeUs
  * POST /graphql  d1AnalyticsAdaptiveGroups   -> rowsRead, rowsWritten
  * POST /graphql  d1StorageAdaptiveGroups     -> databaseSizeBytes
  * POST /graphql  kvOperationsAdaptiveGroups  -> read/write/delete/list
  * POST /graphql  kvStorageAdaptiveGroups     -> byteCount
  * POST /graphql  r2OperationsAdaptiveGroups  -> Class A/B by actionType
  * POST /graphql  r2StorageAdaptiveGroups     -> payload+metadata bytes
  * POST /graphql  vectorizeV2QueriesAdaptiveGroups -> queried dims (by DAY)
  * POST /graphql  vectorizeV2StorageAdaptiveGroups -> stored dims
  * POST /graphql  aiInferenceAdaptiveGroups   -> neurons (record only)

Grain discipline (observed 2026-10-01, documented in the evidence file):
  `d1AnalyticsAdaptiveGroups` day-grain equals the billable-usage row EXACTLY on
  2026-09-30; `vectorizeV2QueriesAdaptiveGroups` hour-grain total (28.66M) is
  6-20x larger than both its own day-grain (4.52M) and billable (1.01M) and is
  treated as a sampling artifact and NOT used.  Day grain is the trusted grain.

Conservative watermark policy (fail-closed):
  * used = max(previous_verified_used, fresh_observation) - a recorded value is
    never lowered, so a lower fresh read can never widen the headroom.
  * unobserved_upper_bound = max(previous_tail, rule_tail) with the operator's
    documented tail rule (2026-09-29 seed): ceil(max(daily_avg * remaining_days
    * 3, used * 0.25)); daily_avg = fresh / elapsed_cycle_days.
  * coverage_end = as_of = recorded_at = now, state = VERIFIED.

Usage:
  python scripts/quota_reconcile_refresh.py            # print summary + SQL
  python scripts/quota_reconcile_refresh.py --write    # also write the SQL and
                                                       # raw evidence JSON
"""

from __future__ import annotations

import json
import math
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ACCOUNT = "4b0901ceeeef89ac3b8414d56c50c946"
PERIOD_START = "2026-09-13T15:01:34Z"  # subscription anchor, re-verified below
PERIOD_END = "2026-10-13T00:00:00Z"
API = "https://api.cloudflare.com/client/v4"
GRAPHQL = API + "/graphql"
OUT_DIR = Path(__file__).resolve().parent.parent / "docs" / "reports"

# Previous operator-verified rows, read from production D1 2026-10-01T16:20Z.
PREV = {
    "workers.requests": (101409, 266000),
    "workers.cpu_ms": (1148306, 3014000),
    "d1.rows_read": (491844015, 131000000),
    "d1.rows_written": (10686563, 1570000),
    "d1.storage_gb_month": (35, 270),
    "kv.reads": (2624, 26600),
    "kv.writes": (2279, 23100),
    "kv.deletes": (0, 10000),
    "kv.lists": (2, 500),
    "kv.storage_gb_month": (1, 10),
    "r2.class_a": (96504, 153000),
    "r2.class_b": (39648, 3700),
    "r2.storage_gb_month": (160, 900),
    "vectorize.queried_dims": (824320, 2125000),
}

TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN")


def http_json(url: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method="POST" if body is not None else "GET",
        headers={
            "Authorization": "Bearer " + (TOKEN or ""),
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"HTTP {exc.code} from {url.split('?')[0]}") from None


def gql(query: str, variables: dict) -> dict:
    payload = http_json(GRAPHQL, {"query": query, "variables": variables})
    if payload.get("errors"):
        raise RuntimeError("graphql errors: " + json.dumps(payload["errors"])[:300])
    return payload["data"]["viewer"]["accounts"][0]


def main() -> int:
    if not TOKEN:
        print("CLOUDFLARE_API_TOKEN is not set", file=sys.stderr)
        return 1
    now = datetime.now(timezone.utc)
    # Millisecond `Z` format, byte-identical to the guard's own
    # `new Date().toISOString()` comparisons (SQLite compares these as TEXT;
    # a bare `...:00Z` sorts AFTER `...:00.000Z`, which would fail the
    # `as_of BETWEEN coverage_end AND now` check inside the same second).
    now_iso = now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"
    now = now.replace(microsecond=0)
    tomorrow = (now + timedelta(days=1)).strftime("%Y-%m-%d")  # include today's bucket
    today = now.strftime("%Y-%m-%d")
    p_start = datetime.fromisoformat(PERIOD_START.replace("Z", "+00:00"))
    p_end = datetime.fromisoformat(PERIOD_END.replace("Z", "+00:00"))
    elapsed_days = (now - p_start).total_seconds() / 86400.0
    remaining_days = (p_end - now).total_seconds() / 86400.0

    # --- anchor re-verification -------------------------------------------
    subs = http_json(f"{API}/accounts/{ACCOUNT}/subscriptions")
    anchors = {
        (s["current_period_start"], s["current_period_end"])
        for s in subs.get("result", [])
    }
    if (PERIOD_START, PERIOD_END) not in anchors:
        print(f"cycle anchor changed: {sorted(anchors)}", file=sys.stderr)
        return 1

    raw: dict = {"as_of": now_iso, "cycle": {"start": PERIOD_START, "end": PERIOD_END},
                 "anchor_reverified": True}

    # --- billable usage ----------------------------------------------------
    bill = http_json(f"{API}/accounts/{ACCOUNT}/billable-usage")
    bill_totals: dict[str, float] = {}
    for row in bill.get("result", []):
        name = str(row.get("ServiceName", ""))
        bill_totals[name] = bill_totals.get(name, 0.0) + float(row.get("ConsumedQuantity") or 0)
    raw["billable_usage"] = bill_totals

    # --- Workers -----------------------------------------------------------
    # NOTE: workersInvocationsAdaptive rejects the `count` field, so no `count`.
    acc = gql(
        """query($a:String!,$f:WorkersInvocationsAdaptiveFilter_InputObject){
             viewer{accounts(filter:{accountTag:$a}){w:workersInvocationsAdaptive(
               limit:10000,filter:$f){dimensions{date} sum{requests cpuTimeUs}}}}}""",
        {"a": ACCOUNT, "f": {"date_geq": "2026-09-13", "date_lt": tomorrow}},
    )
    wr = acc["w"]
    if wr is None:
        raise RuntimeError("workers dataset returned no account block")
    workers = {
        "requests": sum(x["sum"]["requests"] for x in wr),
        "cpu_ms": round(sum(x["sum"]["cpuTimeUs"] for x in wr) / 1000),
    }
    raw["workers_day_grain"] = workers

    # --- D1 read/write -----------------------------------------------------
    acc = gql(
        """query($a:String!,$f:D1AnalyticsAdaptiveGroupsFilter_InputObject){
             viewer{accounts(filter:{accountTag:$a}){d:d1AnalyticsAdaptiveGroups(
               limit:10000,filter:$f){dimensions{date} sum{rowsRead rowsWritten}}}}}""",
        {"a": ACCOUNT, "f": {"date_geq": "2026-09-13", "date_lt": tomorrow}},
    )
    d1rows = acc["d"]
    d1 = {
        "rows_read": sum(x["sum"]["rowsRead"] for x in d1rows),
        "rows_written": sum(x["sum"]["rowsWritten"] for x in d1rows),
    }
    raw["d1_day_grain"] = d1
    # Second official reading from the query-level dataset
    # (`d1QueriesAdaptiveGroups`).  Both datasets describe the same account; on
    # 2026-09-30 the pair agreed exactly with the billable-usage row
    # (9,614,443 rows read) while earlier days diverge by a few percent — the
    # larger of the two is kept (fail-closed).
    acc = gql(
        """query($a:String!,$f:D1QueriesAdaptiveGroupsFilter_InputObject){
             viewer{accounts(filter:{accountTag:$a}){d:d1QueriesAdaptiveGroups(
               limit:10000,filter:$f){dimensions{date} sum{rowsRead rowsWritten}}}}}""",
        {"a": ACCOUNT, "f": {"date_geq": "2026-09-13", "date_lt": tomorrow}},
    )
    d1q_rows = acc["d"]
    if d1q_rows is None:
        raise RuntimeError("d1QueriesAdaptiveGroups returned no account block")
    raw["d1_queries_dataset"] = {
        "rows_read": sum(x["sum"]["rowsRead"] for x in d1q_rows),
        "rows_written": sum(x["sum"]["rowsWritten"] for x in d1q_rows),
    }
    d1["rows_read"] = max(d1["rows_read"], raw["d1_queries_dataset"]["rows_read"])
    d1["rows_written"] = max(d1["rows_written"], raw["d1_queries_dataset"]["rows_written"])

    acc = gql(
        """query($a:String!,$f:D1StorageAdaptiveGroupsFilter_InputObject){
             viewer{accounts(filter:{accountTag:$a}){s:d1StorageAdaptiveGroups(
               limit:1000,filter:$f,orderBy:[date_ASC]){
               dimensions{date} max{databaseSizeBytes}}}}}""",
        {"a": ACCOUNT, "f": {"date_geq": "2026-09-13"}},
    )
    d1_storage_rows = acc["s"]
    if d1_storage_rows is None:
        raise RuntimeError("d1StorageAdaptiveGroups returned no account block")
    d1_bytes = max((x["max"]["databaseSizeBytes"] or 0) for x in d1_storage_rows)
    raw["d1_storage_bytes_max"] = d1_bytes

    # --- KV ----------------------------------------------------------------
    acc = gql(
        """query($a:String!,$f:KvOperationsAdaptiveGroupsFilter_InputObject){
             viewer{accounts(filter:{accountTag:$a}){k:kvOperationsAdaptiveGroups(
               limit:10000,filter:$f){dimensions{actionType date} sum{requests}}}}}""",
        {"a": ACCOUNT, "f": {"date_geq": "2026-09-13", "date_lt": tomorrow}},
    )
    kv_ops: dict[str, int] = {}
    for x in acc["k"]:
        action = x["dimensions"]["actionType"] or "unknown"
        kv_ops[action] = kv_ops.get(action, 0) + x["sum"]["requests"]
    raw["kv_ops_day_grain"] = kv_ops

    acc = gql(
        """query($a:String!,$f:KvStorageAdaptiveGroupsFilter_InputObject){
             viewer{accounts(filter:{accountTag:$a}){s:kvStorageAdaptiveGroups(
               limit:1000,filter:$f,orderBy:[date_ASC]){
               dimensions{date} max{byteCount}}}}}""",
        {"a": ACCOUNT, "f": {"date_geq": "2026-09-13"}},
    )
    kv_rows = acc["s"]
    if kv_rows is None:
        raise RuntimeError("kvStorageAdaptiveGroups returned no account block")
    kv_bytes = max((x["max"]["byteCount"] or 0) for x in kv_rows)
    raw["kv_storage_bytes_max"] = kv_bytes

    # --- R2 ----------------------------------------------------------------
    acc = gql(
        """query($a:String!,$f:R2OperationsAdaptiveGroupsFilter_InputObject){
             viewer{accounts(filter:{accountTag:$a}){o:r2OperationsAdaptiveGroups(
               limit:10000,filter:$f){dimensions{actionType storageClass} sum{requests}}}}}""",
        {"a": ACCOUNT, "f": {"datetimeHour_geq": PERIOD_START, "datetimeHour_lt": now_iso}},
    )
    r2 = {"class_a": 0, "class_b": 0}
    for x in acc["o"]:
        action = x["dimensions"]["actionType"] or ""
        # R2 classes: PUT/POST/PATCH/DELETE/LIST are Class A; GET/HEAD are Class B.
        bucket = (
            "class_b"
            if action in ("GetObject", "HeadObject", "HeadBucket")
            else "class_a"
        )
        r2[bucket] += x["sum"]["requests"]
    raw["r2_ops_hour_grain"] = r2

    acc = gql(
        """query($a:String!,$f:R2StorageAdaptiveGroupsFilter_InputObject){
             viewer{accounts(filter:{accountTag:$a}){s:r2StorageAdaptiveGroups(
               limit:1000,filter:$f,orderBy:[date_ASC]){
               dimensions{date} max{payloadSize metadataSize}}}}}""",
        {"a": ACCOUNT, "f": {"date_geq": "2026-09-13"}},
    )
    r2_rows = acc["s"]
    if r2_rows is None:
        raise RuntimeError("r2StorageAdaptiveGroups returned no account block")
    r2_bytes = max((x["max"]["payloadSize"] or 0) + (x["max"]["metadataSize"] or 0)
                   for x in r2_rows)
    raw["r2_storage_bytes_max"] = r2_bytes

    # --- Vectorize ---------------------------------------------------------
    # Grain note (2026-10-01, discriminating probe): the `datetimeHour` buckets
    # of this dataset are CUMULATIVE WITHIN THE UTC DAY (09-30: last bucket
    # 1,771,520 ~= day value 1,827,840; summing buckets would inflate 6.5x), so
    # only the `date` grain is summed.  Billable-usage rows lag (2 of 4 days
    # posted) and are NOT used for the total.
    acc = gql(
        """query($a:String!,$f:VectorizeV2QueriesAdaptiveGroupsFilter_InputObject){
             viewer{accounts(filter:{accountTag:$a}){q:vectorizeV2QueriesAdaptiveGroups(
               limit:10000,filter:$f){dimensions{date} sum{queriedVectorDimensions}}}}}""",
        {"a": ACCOUNT, "f": {"date_geq": "2026-09-13"}},
    )
    vec_day = sum(x["sum"]["queriedVectorDimensions"] for x in acc["q"])
    raw["vectorize_queried_dims_day_grain"] = vec_day
    raw["vectorize_queried_dims_billable"] = bill_totals.get(
        "Vectorize - Queried Dimensions (First 50 million included)", 0.0
    )

    acc = gql(
        """query($a:String!,$f:VectorizeV2StorageAdaptiveGroupsFilter_InputObject){
             viewer{accounts(filter:{accountTag:$a}){s:vectorizeV2StorageAdaptiveGroups(
               limit:1000,filter:$f,orderBy:[date_ASC]){
               dimensions{date} max{storedVectorDimensions}}}}}""",
        {"a": ACCOUNT, "f": {"date_geq": "2026-09-13"}},
    )
    vec_rows = acc["s"]
    if vec_rows is None:
        raise RuntimeError("vectorizeV2StorageAdaptiveGroups returned no account block")
    vec_stored = max((x["max"]["storedVectorDimensions"] or 0) for x in vec_rows)
    raw["vectorize_stored_dims_max"] = vec_stored

    # --- AI neurons (record only; utc_day rows are runtime-bootstrapped) ---
    acc = gql(
        """query($a:String!,$f:AccountAiInferenceAdaptiveGroupsFilter_InputObject){
             viewer{accounts(filter:{accountTag:$a}){ai:aiInferenceAdaptiveGroups(
               limit:10000,filter:$f){dimensions{datetimeHour} sum{totalNeurons}}}}}""",
        {"a": ACCOUNT, "f": {"datetimeHour_geq": PERIOD_START, "datetimeHour_lt": now_iso}},
    )
    raw["ai_neurons_cycle"] = round(sum(x["sum"]["totalNeurons"] for x in acc["ai"]), 3)

    # --- fresh observations per dimension ----------------------------------
    milli = 1000.0
    span = elapsed_days / 30.44  # GB-month fraction of the cycle elapsed
    fresh = {
        "workers.requests": workers["requests"],
        "workers.cpu_ms": workers["cpu_ms"],
        "d1.rows_read": d1["rows_read"],
        "d1.rows_written": d1["rows_written"],
        "d1.storage_gb_month": math.floor(d1_bytes / 1e9 * milli * span),
        "kv.reads": kv_ops.get("read", 0),
        "kv.writes": kv_ops.get("write", 0),
        "kv.deletes": kv_ops.get("delete", 0),
        "kv.lists": kv_ops.get("list", 0),
        "kv.storage_gb_month": math.floor(kv_bytes / 1e9 * milli * span),
        "r2.class_a": r2["class_a"],
        "r2.class_b": r2["class_b"],
        "r2.storage_gb_month": math.floor(r2_bytes / 1e9 * milli * span),
        "vectorize.queried_dims": vec_day,
    }
    raw["fresh_observations"] = fresh
    raw["elapsed_days"] = round(elapsed_days, 3)
    raw["remaining_days"] = round(remaining_days, 3)

    # --- compute rows with the conservative watermark policy ---------------
    rows = []
    for key, (prev_used, prev_tail) in PREV.items():
        observed = fresh[key]
        used = max(prev_used, observed)
        daily_avg = observed / elapsed_days if elapsed_days > 0 else 0.0
        rule_tail = math.ceil(max(daily_avg * remaining_days * 3.0, used * 0.25))
        tail = max(prev_tail, rule_tail)
        rows.append({
            "dimension_key": key,
            "prev_used": prev_used,
            "observed": observed,
            "used": used,
            "prev_tail": prev_tail,
            "rule_tail": rule_tail,
            "tail": tail,
        })

    print(json.dumps({"as_of": now_iso, "days": [round(elapsed_days, 3),
                                                 round(remaining_days, 3)]}, indent=1))
    for r in rows:
        print(f"{r['dimension_key']:<24} obs={r['observed']:>14,} "
              f"used {r['prev_used']:>12,} -> {r['used']:>12,}   "
              f"tail {r['prev_tail']:>12,} -> {r['tail']:>12,}")

    source_suffix = (
        f" | reconcile refresh {now_iso} (fresh provider read; monotonic fail-closed "
        f"retention, coverage advanced to now)"
    )
    values = []
    for r in rows:
        values.append(
            "('{key}', '{period}', 'VERIFIED', {used}, {tail}, "
            "'graphql+billable-usage cycle re-read as_of {now}{suffix}', "
            "'reconcile_usage_{stamp} ({evid})', '{now}', '{now}', '{now}')".format(
                key=r["dimension_key"],
                period=f"cycle:{PERIOD_START}..{PERIOD_END}",
                used=r["used"],
                tail=r["tail"],
                now=now_iso,
                suffix=source_suffix,
                stamp=now.strftime("%Y%m%dT%H%MZ"),
                evid="docs/reports/2026-10-02-quota-unblock-raw.json",
            )
        )
    sql = (
        "-- Generated by scripts/quota_reconcile_refresh.py (issue #54 stage 1).\n"
        f"-- as_of {now_iso}; cycle {PERIOD_START}..{PERIOD_END}.\n"
        f"-- elapsed {elapsed_days:.3f} d, remaining {remaining_days:.3f} d.\n"
        "INSERT INTO quota_period_baselines\n"
        " (dimension_key, period_key, state, used, unobserved_upper_bound, source,\n"
        "  source_version, as_of, coverage_end, recorded_at)\nVALUES\n"
        + ",\n".join(values)
        + "\nON CONFLICT(dimension_key, period_key) DO UPDATE SET\n"
        " state=excluded.state, used=excluded.used,\n"
        " unobserved_upper_bound=excluded.unobserved_upper_bound,\n"
        " source=excluded.source, source_version=excluded.source_version,\n"
        " as_of=excluded.as_of, coverage_end=excluded.coverage_end,\n"
        " recorded_at=excluded.recorded_at;\n"
    )
    print()
    print(sql)

    if "--write" in sys.argv:
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        sql_path = OUT_DIR / "2026-10-02-quota-unblock-refresh.sql"
        raw_path = OUT_DIR / "2026-10-02-quota-unblock-raw.json"
        sql_path.write_text(sql, encoding="utf-8")
        raw_path.write_text(json.dumps(raw, indent=1, ensure_ascii=False), encoding="utf-8")
        print(f"WROTE {sql_path}")
        print(f"WROTE {raw_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
