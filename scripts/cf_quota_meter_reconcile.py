#!/usr/bin/env python3
"""Cloudflare official-meter quota reconcile (Phase 3).

Spec: .sdd/2026-10-01-collector-quota-redesign/spec-plan-collector-quota-reconcile.md
(quota redesign: abolish front admission, 12h official-meter reconcile, 95%
circuit as a backstop).  This script is the ONLY writer of
``quota_circuit_state``; the Worker reads that table to intercept the few
high-compute routes when a dimension truly crosses the 95% line.

What it does, per run:
  1. Pull OFFICIAL truth (never internal telemetry) from Cloudflare:
       - GraphQL d1AnalyticsAdaptiveGroups, date granularity,
         sum.rowsRead / sum.rowsWritten over the current Workers Paid
         subscription period (billing_cycle; never a UTC calendar month);
       - GraphQL aiInferenceAdaptiveGroups, datetimeHour granularity,
         sum.totalNeurons (measured field name: totalNeurons, NOT neurons)
         over the current UTC day (ai.neurons resets at 00:00 UTC);
       - REST /accounts/{id}/vectorize/v2/indexes/{index}/info
         (dimensions / vectorCount / processedUpToDatetime) - the monthly
         QUERIED-dimension meter is NOT exposed by any official API (probed
         2026-10-01: GraphQL has no vectorize dataset), so vectorize.queries
         is carried as CLOSED with the UNMETERED sentinel, never tripped;
       - REST /accounts/{id}/subscriptions to anchor the Workers Paid period
         (product.name == "prod_workers", rate_plan.id == "workers_paid").
  2. Compare each dimension against its 95% threshold.  Only a real
     usage >= threshold_95 flips the dimension to OPEN; every other outcome
     refreshes the row to CLOSED with the fresh official value.
  3. Persist quota_circuit_state via
     `wrangler d1 execute RESEARCH_REPLICA --remote` (idempotent UPSERT).
     The table is created on first run if missing.  Schema keeps
     current_usage REAL NOT NULL (spec contract), so an unmetered dimension
     stores -1.0 as an explicit sentinel - never 0 (0 would read as
     "officially measured zero", which we do not have).
  4. Read quota_client_usage_hourly (Phase 2 middleware table) and emit the
     multi-client allocation report (JSON + Markdown) under
     reports/quota-reconcile/.

Safety downgrade: if ANY official API call fails, print a WARNING, exit 3,
and change NOTHING (no circuit-state write, no zero-fill, no report file).
The next scheduled run re-judges from fresh truth.

Exit codes: 0 success | 1 configuration error (missing token) |
3 official API failure (nothing written) | 4 D1 persistence failure.

Usage:
  python scripts/cf_quota_meter_reconcile.py [--dry-run] [--allocation-hours 24] [--json]

Credentials come ONLY from the CLOUDFLARE_API_TOKEN environment variable;
the token is never printed, never logged, never written to disk.
Console/report output is ASCII-only (Windows Task Scheduler safe).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

# ---------------------------------------------------------------------------
# Configuration (single Collector account; mirrors src/quota-breaker.ts)
# ---------------------------------------------------------------------------
ACCOUNT_TAG = "4b0901ceeeef89ac3b8414d56c50c946"
D1_DATABASE_ID = "0e20aca4-c394-4f41-aa46-d98831b81836"
D1_BINDING = "RESEARCH_REPLICA"
VECTORIZE_INDEX = "research-public-bge-m3-v1"
WORKERS_PRODUCT_NAME = "prod_workers"
WORKERS_RATE_PLAN_ID = "workers_paid"
CF_API = "https://api.cloudflare.com/client/v4"

# Included allowances + 95% thresholds (spec plan section 3.2 / Phase 3 task).
# threshold_95 = floor(0.95 * included), integer-safe.
DIMENSIONS = {
    "ai.neurons": {
        "included": 10_000,            # Neurons / UTC day (Workers Paid)
        "threshold_95": 9_500,
        "window": "utc_day",
    },
    "d1.rows_read": {
        "included": 25_000_000_000,    # rows / billing cycle
        "threshold_95": 23_750_000_000,
        "window": "billing_cycle",
    },
    "d1.rows_written": {
        "included": 50_000_000,        # rows / billing cycle
        "threshold_95": 47_500_000,
        "window": "billing_cycle",
    },
    # Spec contract key.  src/quota-dimensions.ts names it vectorize.queried_dims
    # with a 50M allowance; the reconcile follows the spec's 30M/month figure.
    "vectorize.queried_dims": {
        "included": 30_000_000,        # queried vector dimensions / billing cycle
        "threshold_95": 28_500_000,
        "window": "billing_cycle",
    },
}
# Official meter availability per dimension.  vectorize.queries has NO monthly
# queried-dimension meter (REST info carries stock only; no GraphQL dataset).
METERED = {
    "ai.neurons": True,
    "d1.rows_read": True,
    "d1.rows_written": True,
    "vectorize.queried_dims": False,
}
UNMETERED_SENTINEL = -1.0

# Informational estimate inputs for vectorize.queries (never gates):
# topK bound from src/research-semantic-index.ts:55, dims from live index info.
VECTORIZE_ESTIMATE_TOPK = 50

EXIT_OK = 0
EXIT_CONFIG = 1
EXIT_OFFICIAL_FAILURE = 3
EXIT_D1_FAILURE = 4

REPO_ROOT = Path(__file__).resolve().parents[1]
REPORT_DIR = REPO_ROOT / "reports" / "quota-reconcile"


class OfficialApiError(RuntimeError):
    """Any failure while pulling official Cloudflare truth."""


# ---------------------------------------------------------------------------
# Time helpers
# ---------------------------------------------------------------------------
def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso_z(moment: dt.datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def compact_stamp(moment: dt.datetime) -> str:
    return moment.strftime("%Y%m%dT%H%M%SZ")


# ---------------------------------------------------------------------------
# Official Cloudflare API (REST + GraphQL)
# ---------------------------------------------------------------------------
def http_json(url: str, token: str, payload: dict | None = None) -> dict:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(
        url,
        data=data,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:400]
        raise OfficialApiError(f"HTTP {exc.code} from {url}: {detail}") from exc
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise OfficialApiError(f"request failed for {url}: {exc}") from exc


def graphql(token: str, query: str) -> dict:
    body = http_json(f"{CF_API}/graphql", token, {"query": query})
    if body.get("errors"):
        raise OfficialApiError(f"GraphQL errors: {json.dumps(body['errors'])[:400]}")
    data = body.get("data")
    if not isinstance(data, dict):
        raise OfficialApiError("GraphQL response carried no data object")
    return data


def fetch_workers_paid_period(token: str) -> dict:
    """Anchor the billing_cycle window on the Workers Paid subscription."""
    body = http_json(f"{CF_API}/accounts/{ACCOUNT_TAG}/subscriptions", token)
    subs = body.get("result") or []
    for sub in subs:
        product = (sub.get("product") or {}).get("name", "")
        rate_plan = (sub.get("rate_plan") or {}).get("id", "")
        if product == WORKERS_PRODUCT_NAME and rate_plan == WORKERS_RATE_PLAN_ID:
            start = sub.get("current_period_start")
            end = sub.get("current_period_end")
            if not start or not end:
                raise OfficialApiError("Workers Paid subscription has no current_period")
            return {
                "product": product,
                "public_name": (sub.get("product") or {}).get("public_name", ""),
                "state": sub.get("state", ""),
                "start": start,
                "end": end,
            }
    raise OfficialApiError(
        f"no Workers Paid subscription found "
        f"(product={WORKERS_PRODUCT_NAME}, rate_plan={WORKERS_RATE_PLAN_ID})"
    )


def fetch_d1_cycle(token: str, start: str, end: str) -> dict:
    """rowsRead/rowsWritten per day over [start, end); caller sums to usage."""
    # Official API hard limit: time range must not exceed 4w4d (32 days).
    # A monthly subscription period fits; clamp defensively anyway.
    start_dt = dt.datetime.strptime(start, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
    end_dt = dt.datetime.strptime(end, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
    if end_dt - start_dt > dt.timedelta(days=32):
        start_dt = end_dt - dt.timedelta(days=32)
        start = iso_z(start_dt)
    query = (
        "query { viewer { accounts(filter: {accountTag: \"%s\"}) { "
        "d1AnalyticsAdaptiveGroups(filter: {datetime_geq: \"%s\", datetime_lt: \"%s\", "
        "databaseId: \"%s\"}, limit: 100, orderBy: [date_ASC]) { "
        "dimensions { date } sum { rowsRead rowsWritten } } } } }"
        % (ACCOUNT_TAG, start, end, D1_DATABASE_ID)
    )
    data = graphql(token, query)
    accounts = data.get("viewer", {}).get("accounts") or []
    if not accounts:
        raise OfficialApiError("GraphQL d1: account returned no rows")
    groups = accounts[0].get("d1AnalyticsAdaptiveGroups") or []
    days = [
        {
            "date": group["dimensions"]["date"],
            "rows_read": int(group["sum"]["rowsRead"]),
            "rows_written": int(group["sum"]["rowsWritten"]),
        }
        for group in groups
    ]
    return {
        "window_start": start,
        "window_end": end,
        "days": days,
        "rows_read": sum(day["rows_read"] for day in days),
        "rows_written": sum(day["rows_written"] for day in days),
    }


def fetch_ai_day(token: str, day_start: str, end: str) -> dict:
    """totalNeurons per hour over the current UTC day (spec: utc_day window)."""
    query = (
        "query { viewer { accounts(filter: {accountTag: \"%s\"}) { "
        "aiInferenceAdaptiveGroups(filter: {datetime_geq: \"%s\", datetime_lt: \"%s\"}, "
        "limit: 48, orderBy: [datetimeHour_ASC]) { "
        "dimensions { datetimeHour } sum { totalNeurons } } } } }"
        % (ACCOUNT_TAG, day_start, end)
    )
    data = graphql(token, query)
    accounts = data.get("viewer", {}).get("accounts") or []
    if not accounts:
        raise OfficialApiError("GraphQL ai: account returned no rows")
    groups = accounts[0].get("aiInferenceAdaptiveGroups") or []
    hours = [
        {
            "datetime_hour": group["dimensions"]["datetimeHour"],
            "total_neurons": float(group["sum"]["totalNeurons"]),
        }
        for group in groups
    ]
    return {
        "window_start": day_start,
        "window_end": end,
        "hours": hours,
        "total_neurons": sum(hour["total_neurons"] for hour in hours),
    }


def fetch_vectorize_info(token: str) -> dict:
    body = http_json(
        f"{CF_API}/accounts/{ACCOUNT_TAG}/vectorize/v2/indexes/{VECTORIZE_INDEX}/info",
        token,
    )
    if not body.get("success"):
        raise OfficialApiError(f"vectorize info failed: {json.dumps(body.get('errors'))[:400]}")
    result = body.get("result") or {}
    for key in ("dimensions", "vectorCount", "processedUpToDatetime"):
        if key not in result:
            raise OfficialApiError(f"vectorize info missing key: {key}")
    return {
        "index": VECTORIZE_INDEX,
        "dimensions": int(result["dimensions"]),
        "vector_count": int(result["vectorCount"]),
        "processed_up_to_datetime": result["processedUpToDatetime"],
    }


# ---------------------------------------------------------------------------
# wrangler (D1 reads + writes go through the same door as the Worker)
# ---------------------------------------------------------------------------
def wrangler_command() -> list[str]:
    """Resolve a non-interactive wrangler invocation for this repo."""
    direct = shutil.which("wrangler")
    if direct:
        return [direct]
    local_bin = REPO_ROOT / "node_modules" / "wrangler" / "bin" / "wrangler.js"
    node = shutil.which("node")
    if local_bin.exists() and node:
        return [node, str(local_bin)]
    npx = shutil.which("npx.cmd") or shutil.which("npx")
    if npx:
        return [npx, "wrangler"]
    raise RuntimeError("wrangler not found (wrangler, node, or npx on PATH)")


def run_wrangler_d1(args: list[str], timeout: int = 120) -> str:
    env = dict(os.environ)
    # Avoid the interactive account picker when the token sees many accounts.
    env["CLOUDFLARE_ACCOUNT_ID"] = ACCOUNT_TAG
    env.setdefault("CI", "true")
    argv = wrangler_command() + ["d1", "execute", D1_BINDING, "--remote"] + args
    completed = subprocess.run(
        argv,
        cwd=str(REPO_ROOT),
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )
    if completed.returncode != 0:
        raise RuntimeError(
            f"wrangler d1 execute failed (exit {completed.returncode}): "
            f"{(completed.stderr or completed.stdout)[-500:]}"
        )
    return completed.stdout


def parse_wrangler_json(stdout: str) -> list:
    """wrangler --json prints a JSON array; tolerate leading banner lines."""
    text = stdout.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    for index, line in enumerate(text.splitlines()):
        if line.lstrip().startswith("["):
            return json.loads("\n".join(text.splitlines()[index:]))
    raise RuntimeError("wrangler --json output carried no JSON array")


def d1_query(sql: str) -> list[dict]:
    stdout = run_wrangler_d1(["--json", "--command", sql])
    statements = parse_wrangler_json(stdout)
    if not statements:
        return []
    return statements[0].get("results") or []


def sql_str(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def sql_num(value: float) -> str:
    return repr(float(value))


CIRCUIT_TABLE_SQL = (
    "CREATE TABLE IF NOT EXISTS quota_circuit_state ("
    "dimension_key TEXT PRIMARY KEY, "
    "state TEXT NOT NULL, "
    "current_usage REAL NOT NULL, "
    "threshold_95 REAL NOT NULL, "
    "as_of TEXT NOT NULL, "
    "updated_at TEXT NOT NULL)"
)

ALLOC_TABLE_COLUMNS = (
    "period_hour TEXT NOT NULL, "
    "client_id TEXT NOT NULL, "
    "route TEXT NOT NULL, "
    "call_count INTEGER NOT NULL DEFAULT 0, "
    "d1_rows_read INTEGER NOT NULL DEFAULT 0, "
    "d1_rows_written INTEGER NOT NULL DEFAULT 0, "
    "ai_neurons REAL NOT NULL DEFAULT 0, "
    "created_at TEXT NOT NULL, "
    "updated_at TEXT NOT NULL, "
    "PRIMARY KEY (period_hour, client_id, route)"
)


def read_client_allocation(cutoff_hour: str) -> dict:
    """Aggregate quota_client_usage_hourly per client over the last N hours."""
    per_client_sql = (
        "SELECT client_id, SUM(call_count) AS call_count, "
        "SUM(d1_rows_read) AS d1_rows_read, SUM(d1_rows_written) AS d1_rows_written, "
        "SUM(ai_neurons) AS ai_neurons "
        f"FROM quota_client_usage_hourly WHERE period_hour >= {sql_str(cutoff_hour)} "
        "GROUP BY client_id ORDER BY ai_neurons DESC, call_count DESC"
    )
    per_route_sql = (
        "SELECT route, SUM(call_count) AS calls, SUM(ai_neurons) AS ai_neurons "
        f"FROM quota_client_usage_hourly WHERE period_hour >= {sql_str(cutoff_hour)} "
        "GROUP BY route ORDER BY calls DESC LIMIT 20"
    )
    try:
        per_client = d1_query(per_client_sql)
        per_route = d1_query(per_route_sql)
    except RuntimeError as exc:
        message = str(exc)
        if "no such table" in message.lower():
            return {
                "available": False,
                "window_hours": None,
                "reason": "quota_client_usage_hourly table missing (Phase 2 middleware not deployed yet)",
            }
        return {"available": False, "window_hours": None, "reason": message[-300:]}
    total_calls = sum(int(row.get("call_count") or 0) for row in per_client)
    clients = []
    for row in per_client:
        calls = int(row.get("call_count") or 0)
        clients.append(
            {
                "client_id": row.get("client_id", ""),
                "call_count": calls,
                "d1_rows_read": int(row.get("d1_rows_read") or 0),
                "d1_rows_written": int(row.get("d1_rows_written") or 0),
                "ai_neurons": float(row.get("ai_neurons") or 0.0),
                "call_share_pct": round(100.0 * calls / total_calls, 2) if total_calls else 0.0,
            }
        )
    return {
        "available": True,
        "window_start": cutoff_hour,
        "clients": clients,
        "routes": [
            {
                "route": row.get("route", ""),
                "calls": int(row.get("calls") or 0),
                "ai_neurons": float(row.get("ai_neurons") or 0.0),
            }
            for row in per_route
        ],
    }


def read_current_circuit_states() -> list[dict]:
    try:
        return d1_query(
            "SELECT dimension_key, state, current_usage, as_of FROM quota_circuit_state"
        )
    except RuntimeError:
        return []


# ---------------------------------------------------------------------------
# Report rendering
# ---------------------------------------------------------------------------
def fmt_int(value: int | float) -> str:
    return f"{int(value):,}"


def fmt_num(value: float) -> str:
    if value >= 1000:
        return f"{value:,.2f}"
    return f"{value:.4f}".rstrip("0").rstrip(".") or "0"


def render_markdown(report: dict) -> str:
    lines: list[str] = []
    lines.append("# Cloudflare Official-Meter Quota Reconcile Report")
    lines.append("")
    lines.append(f"- as_of: `{report['as_of']}`")
    lines.append(f"- authority: {report['authority']}")
    lines.append(
        f"- billing period: {report['billing_period']['public_name']} "
        f"({report['billing_period']['product']}) "
        f"{report['billing_period']['start']} .. {report['billing_period']['end']}"
    )
    lines.append(f"- exit semantics: {report['exit_semantics']}")
    lines.append("")
    lines.append("## Circuit dimensions (official meters, 95% line)")
    lines.append("")
    lines.append("| dimension | window | current_usage | included | threshold_95 | pct_of_95 | state | meter |")
    lines.append("|---|---|---:|---:|---:|---:|---|---|")
    for entry in report["circuit"]:
        usage = entry["current_usage"]
        usage_text = "UNMETERED (-1 in D1)" if usage is None else fmt_int(usage)
        pct = entry.get("pct_of_threshold_95")
        pct_text = "-" if pct is None else f"{pct:.3f}%"
        lines.append(
            f"| {entry['dimension_key']} | {entry['window']} | {usage_text} "
            f"| {fmt_int(entry['included'])} | {fmt_int(entry['threshold_95'])} "
            f"| {pct_text} | {entry['state']} | {entry['meter']} |"
        )
    lines.append("")
    for note in report["circuit_notes"]:
        lines.append(f"- note: {note}")
    lines.append("")
    lines.append("## Official meter evidence")
    lines.append("")
    d1 = report["official"]["d1"]
    lines.append(
        f"- D1 database `{D1_DATABASE_ID}` over {d1['days']} day(s): "
        f"rowsRead={fmt_int(d1['rows_read'])}, rowsWritten={fmt_int(d1['rows_written'])}"
    )
    ai = report["official"]["ai"]
    lines.append(
        f"- Workers AI UTC day {ai['window_start']}..{ai['window_end']}: "
        f"totalNeurons={fmt_num(ai['total_neurons'])} over {len(ai['hours'])} hour bucket(s)"
    )
    vect = report["official"]["vectorize"]
    lines.append(
        f"- Vectorize `{vect['index']}`: dims={vect['dimensions']}, "
        f"vectorCount={fmt_int(vect['vector_count'])}, "
        f"processedUpToDatetime={vect['processed_up_to_datetime']}"
    )
    lines.append("")
    lines.append("## Client allocation (last %d h, internal telemetry)" % report["allocation_window_hours"])
    lines.append("")
    alloc = report["client_allocation"]
    if alloc.get("available"):
        lines.append("| client_id | calls | share% | d1_rows_read | d1_rows_written | ai_neurons |")
        lines.append("|---|---:|---:|---:|---:|---:|")
        for client in alloc["clients"]:
            lines.append(
                f"| {client['client_id']} | {client['call_count']} "
                f"| {client['call_share_pct']:.2f} | {fmt_int(client['d1_rows_read'])} "
                f"| {fmt_int(client['d1_rows_written'])} | {fmt_num(client['ai_neurons'])} |"
            )
        lines.append("")
        if alloc.get("routes"):
            lines.append("Top routes in the same window:")
            lines.append("")
            for route in alloc["routes"][:10]:
                lines.append(
                    f"- `{route['route']}` calls={route['calls']} "
                    f"ai_neurons={fmt_num(route['ai_neurons'])}"
                )
            lines.append("")
    else:
        lines.append(f"- unavailable: {alloc.get('reason', 'unknown')}")
        lines.append("")
    lines.append("## D1 persistence")
    lines.append("")
    lines.append(f"- quota_circuit_state upsert: {report['d1_write']}")
    lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="pull official meters and print only; no D1 write, no report file",
    )
    parser.add_argument(
        "--allocation-hours",
        type=int,
        default=24,
        help="client-allocation window in hours (default 24)",
    )
    parser.add_argument("--json", action="store_true", help="print the machine report too")
    args = parser.parse_args()

    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    if not token:
        print("ERROR: CLOUDFLARE_API_TOKEN is not set in the environment")
        return EXIT_CONFIG

    now = utc_now()
    official_failures: list[str] = []

    subscriptions: dict | None = None
    d1_data: dict | None = None
    ai_data: dict | None = None
    vect_data: dict | None = None

    try:
        subscriptions = fetch_workers_paid_period(token)
    except OfficialApiError as exc:
        official_failures.append(f"subscriptions: {exc}")
    if subscriptions is not None:
        try:
            d1_data = fetch_d1_cycle(token, subscriptions["start"], iso_z(now))
        except OfficialApiError as exc:
            official_failures.append(f"d1AnalyticsAdaptiveGroups: {exc}")
    day_start = iso_z(now.replace(hour=0, minute=0, second=0, microsecond=0))
    try:
        ai_data = fetch_ai_day(token, day_start, iso_z(now))
    except OfficialApiError as exc:
        official_failures.append(f"aiInferenceAdaptiveGroups: {exc}")
    try:
        vect_data = fetch_vectorize_info(token)
    except OfficialApiError as exc:
        official_failures.append(f"vectorize info: {exc}")

    if official_failures:
        # Safety downgrade (spec section 1.4): warn, exit 3, change NOTHING,
        # never fill zeros, never touch the circuit table.
        print("WARNING: official Cloudflare API failure; reconcile aborted, "
              "quota_circuit_state untouched, nothing zero-filled")
        for failure in official_failures:
            print(f"  - {failure}")
        return EXIT_OFFICIAL_FAILURE

    assert subscriptions and d1_data and ai_data and vect_data  # for type checkers

    # Circuit evaluation: OPEN only on a real official reading >= threshold_95.
    official_usage = {
        "ai.neurons": ai_data["total_neurons"],
        "d1.rows_read": d1_data["rows_read"],
        "d1.rows_written": d1_data["rows_written"],
    }
    circuit: list[dict] = []
    circuit_notes: list[str] = []
    as_of = iso_z(now)
    for key, spec in DIMENSIONS.items():
        threshold = float(spec["threshold_95"])
        if METERED[key]:
            usage = float(official_usage[key])
            pct = 100.0 * usage / threshold if threshold > 0 else None
            state = "OPEN" if usage >= threshold else "CLOSED"
            circuit.append(
                {
                    "dimension_key": key,
                    "window": spec["window"],
                    "included": spec["included"],
                    "threshold_95": spec["threshold_95"],
                    "current_usage": usage,
                    "pct_of_threshold_95": pct,
                    "state": state,
                    "meter": "official",
                }
            )
        else:
            # vectorize.queries: monthly queried dims are not exposed by any
            # official meter.  CLOSED (never tripped without truth); the D1 row
            # carries the UNMETERED sentinel because the column is NOT NULL.
            circuit.append(
                {
                    "dimension_key": key,
                    "window": spec["window"],
                    "included": spec["included"],
                    "threshold_95": spec["threshold_95"],
                    "current_usage": None,
                    "pct_of_threshold_95": None,
                    "state": "CLOSED",
                    "meter": "none",
                }
            )
            circuit_notes.append(
                "vectorize.queries has no official monthly meter (REST info carries "
                "stock only; GraphQL exposes no vectorize dataset, probed 2026-10-01). "
                "Stored sentinel -1.0; never trips on its own. Index stock: "
                f"dims={vect_data['dimensions']}, vectorCount={vect_data['vector_count']}. "
                "Informational internal estimate only (topK bound 50): "
                f"{VECTORIZE_ESTIMATE_TOPK * vect_data['dimensions']:,} dims per "
                "semantic query at the ceiling."
            )

    # Client allocation from the Phase 2 telemetry table (internal, non-gating).
    cutoff = (now.replace(minute=0, second=0, microsecond=0)
              - dt.timedelta(hours=args.allocation_hours))
    cutoff_hour = iso_z(cutoff)
    if args.dry_run:
        allocation: dict = {
            "available": False,
            "window_hours": args.allocation_hours,
            "reason": "skipped in --dry-run (no D1 access at all)",
        }
    else:
        allocation = read_client_allocation(cutoff_hour)
        allocation["window_hours"] = args.allocation_hours

    previous_states = [] if args.dry_run else read_current_circuit_states()

    report: dict = {
        "script": "scripts/cf_quota_meter_reconcile.py",
        "spec": "spec-plan-collector-quota-reconcile.md Phase 3",
        "as_of": as_of,
        "authority": "OFFICIAL_CF_METERS",
        "exit_semantics": "0 ok | 1 config | 3 official-API-failure(nothing written) | 4 d1-failure",
        "billing_period": subscriptions,
        "circuit": circuit,
        "circuit_notes": circuit_notes,
        "official": {
            "d1": d1_data,
            "ai": ai_data,
            "vectorize": vect_data,
        },
        "allocation_window_hours": args.allocation_hours,
        "client_allocation": allocation,
        "previous_circuit_states": previous_states,
        "d1_write": "skipped (--dry-run)" if args.dry_run else "pending",
        "reports": [],
    }

    if args.dry_run:
        report["d1_write"] = "skipped (--dry-run)"
        print("DRY-RUN: official meters pulled; NO D1 write, NO report file")
    else:
        # Persist: ensure table, then idempotent UPSERT of all four dimensions.
        values = []
        for entry in circuit:
            usage = (
                float(entry["current_usage"])
                if entry["current_usage"] is not None
                else UNMETERED_SENTINEL
            )
            values.append(
                f"({sql_str(entry['dimension_key'])}, {sql_str(entry['state'])}, "
                f"{sql_num(usage)}, {sql_num(float(entry['threshold_95']))}, "
                f"{sql_str(as_of)}, {sql_str(as_of)})"
            )
        upsert_sql = (
            "INSERT INTO quota_circuit_state "
            "(dimension_key, state, current_usage, threshold_95, as_of, updated_at) VALUES "
            + ", ".join(values)
            + " ON CONFLICT(dimension_key) DO UPDATE SET "
            "state=excluded.state, current_usage=excluded.current_usage, "
            "threshold_95=excluded.threshold_95, as_of=excluded.as_of, "
            "updated_at=excluded.updated_at"
        )
        try:
            run_wrangler_d1(["--command", CIRCUIT_TABLE_SQL])
            run_wrangler_d1(["--command", upsert_sql])
        except (RuntimeError, subprocess.TimeoutExpired) as exc:
            print(f"ERROR: D1 persistence failed: {str(exc)[-400:]}")
            print("quota_circuit_state may be stale; next scheduled run re-judges from fresh truth")
            report["d1_write"] = f"failed: {str(exc)[-300:]}"
            # Still emit the report files: they carry the official truth even
            # when persistence failed, and exit 4 flags the persistence gap.
            _write_reports(report)
            return EXIT_D1_FAILURE
        report["d1_write"] = "upserted (4 dimensions)"
        transitions = _state_transitions(previous_states, circuit)
        for transition in transitions:
            print(f"  state change: {transition}")
        _write_reports(report)

    # Console summary (ASCII only).
    print(f"as_of: {as_of}")
    print(
        f"billing period: {report['billing_period']['public_name']} "
        f"{report['billing_period']['start']} .. {report['billing_period']['end']}"
    )
    for entry in circuit:
        usage = entry["current_usage"]
        usage_text = "UNMETERED" if usage is None else fmt_num(usage)
        pct = entry.get("pct_of_threshold_95")
        pct_text = "-" if pct is None else f"{pct:.3f}%"
        print(
            f"  {entry['dimension_key']:<18} usage={usage_text:>16} "
            f"threshold_95={fmt_int(entry['threshold_95']):>16} "
            f"pct={pct_text:>9} state={entry['state']}"
        )
    if allocation.get("available"):
        print(f"client allocation (last {args.allocation_hours}h):")
        for client in allocation["clients"]:
            print(
                f"  {client['client_id']:<24} calls={client['call_count']:<8} "
                f"share={client['call_share_pct']:.2f}% "
                f"d1_read={client['d1_rows_read']} d1_written={client['d1_rows_written']} "
                f"ai_neurons={fmt_num(client['ai_neurons'])}"
            )
    else:
        print(f"client allocation: unavailable ({allocation.get('reason', 'unknown')})")
    if args.dry_run:
        print("dry-run complete; nothing was written")
    elif report["reports"]:
        print("reports:")
        for path in report["reports"]:
            print(f"  {path}")

    if args.json:
        print(json.dumps(report, ensure_ascii=True, indent=2, sort_keys=False))
    return EXIT_OK


def _state_transitions(previous: list[dict], circuit: list[dict]) -> list[str]:
    before = {row.get("dimension_key"): row for row in previous}
    out = []
    for entry in circuit:
        old = before.get(entry["dimension_key"])
        if old and old.get("state") != entry["state"]:
            out.append(
                f"{entry['dimension_key']} {old.get('state')} -> {entry['state']} "
                f"(official usage {entry['current_usage']}, threshold_95 "
                f"{entry['threshold_95']})"
            )
    return out


def _write_reports(report: dict) -> None:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = compact_stamp(utc_now())
    json_path = REPORT_DIR / f"reconcile-{stamp}.json"
    md_path = REPORT_DIR / f"reconcile-{stamp}.md"
    json_path.write_text(
        json.dumps(report, ensure_ascii=True, indent=2, sort_keys=False) + "\n",
        encoding="ascii",
    )
    md_path.write_text(render_markdown(report), encoding="ascii")
    report["reports"] = [str(json_path.relative_to(REPO_ROOT)), str(md_path.relative_to(REPO_ROOT))]


if __name__ == "__main__":
    sys.exit(main())
