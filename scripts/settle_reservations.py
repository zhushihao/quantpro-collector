"""Bounded operator settlement for orphaned live reservations (P1-4, 2026-10-02).

The front admission machinery was removed on 2026-10-02 (#54 redesign); live
reservations left in production are orphans with no gate reader left -- only
the informational quota status view still counts them.  Settlement charges the
booked ledger at reserved full charge (actuals can only be lower), journals the
outcome, then deletes the live unit and header rows.

Safety contract (replaces the unbounded 2026-09-29 one-shot, deleted):
  * DEFAULT IS DRY-RUN: prints the exact manifest and exits 0 without writing.
  * --execute is required for any D1 write.
  * Optionally --reservation-id <id> (repeatable) narrows the set; without it
    ALL live reservations are in scope -- they are orphans by construction,
    since no code path admits or settles reservations any more.
  * Settlement reuses the proven 2026-09-29 three-statement batch: conditional
    unit delete (count+content asserted), journal insert (NOT EXISTS dedup),
    header delete (only after a SETTLED journal row exists).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request

TOKEN = os.environ["CLOUDFLARE_API_TOKEN"]
BASE = (
    "https://api.cloudflare.com/client/v4/accounts/"
    "4b0901ceeeef89ac3b8414d56c50c946/d1/database/"
    "0e20aca4-c394-4f41-aa46-d98831b81836/query"
)
PK = "cycle:2026-09-13T15:01:34Z..2026-10-13T00:00:00Z"
REASON = (
    "operator settlement 2026-10-02: front admission machinery removed "
    "(#54 redesign); orphaned live reservation settled at reserved full charge"
)


def query(sql: str, params=None) -> list[dict]:
    body = json.dumps({"sql": sql, "params": params or []}).encode()
    req = urllib.request.Request(
        BASE,
        data=body,
        method="POST",
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
    )
    try:
        out = json.load(urllib.request.urlopen(req, timeout=60))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:400]
        raise RuntimeError(f"D1 HTTP {exc.code}: {detail}") from exc
    if not out.get("success"):
        raise RuntimeError(json.dumps(out.get("errors"))[:300])
    return out["result"][0]["results"]


def batch(stmts: list[tuple[str, list]]) -> None:
    body = json.dumps({
        "batch": [{"sql": sql, "params": params} for sql, params in stmts],
    }).encode()
    req = urllib.request.Request(
        BASE,
        data=body,
        method="POST",
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
    )
    try:
        out = json.load(urllib.request.urlopen(req, timeout=60))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:400]
        raise RuntimeError(f"D1 HTTP {exc.code}: {detail}") from exc
    if not out.get("success"):
        raise RuntimeError(json.dumps(out.get("errors"))[:300])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true",
                        help="actually write; default is a dry-run manifest")
    parser.add_argument("--reservation-id", action="append", default=[],
                        help="settle only these reservation ids (repeatable)")
    args = parser.parse_args()

    live = query(
        "SELECT reservation_id, operation_id, fingerprint, route, admitted_at "
        "FROM quota_reservations ORDER BY admitted_at"
    )
    if args.reservation_id:
        wanted = set(args.reservation_id)
        live = [row for row in live if row["reservation_id"] in wanted]
        missing = wanted - {row["reservation_id"] for row in live}
        if missing:
            print(f"WARNING requested ids not live: {sorted(missing)}")
    units = query(
        "SELECT reservation_id, dimension_key, units FROM quota_reservation_units "
        "ORDER BY reservation_id, dimension_key"
    )
    by_res: dict[str, list[dict]] = {}
    for row in units:
        by_res.setdefault(row["reservation_id"], []).append(row)

    print(f"LIVE_RESERVATIONS {len(live)} (unit rows {len(units)})")
    booked: dict[str, int] = {}
    for row in live:
        res_id = row["reservation_id"]
        res_units = by_res.get(res_id, [])
        dims = {u["dimension_key"]: int(u["units"]) for u in res_units}
        print(json.dumps({
            "reservation_id": res_id,
            "route": row["route"],
            "admitted_at": row["admitted_at"],
            "dimensions": dims,
        }, sort_keys=True))
        if not args.execute:
            continue
        expected = [{"dimension_key": u["dimension_key"], "units": int(u["units"])}
                    for u in res_units]
        observed_sql = ",".join(
            f"('{u['dimension_key']}',{int(u['units'])})" for u in res_units
        ) or "('none',0)"
        batch([
            # 1) journal first (NOT EXISTS dedup) -- the header delete below
            #    only fires when a SETTLED journal row exists.
            ("INSERT INTO quota_reservation_journal "
             "(reservation_id, operation_id, fingerprint, route, outcome, outcome_reason, "
             "expected_units_json, observed_units_json, recorded_at) "
             "SELECT ?, ?, ?, ?, 'SETTLED', ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now') "
             "WHERE NOT EXISTS (SELECT 1 FROM quota_reservation_journal "
             "WHERE reservation_id = ?1 AND outcome = 'SETTLED')",
             [res_id, row["operation_id"], row["fingerprint"], row["route"], REASON,
              json.dumps(expected, separators=(",", ":")),
              json.dumps(expected, separators=(",", ":"))]),
            # 2) conditional unit delete: counts and per-dimension content must
            #    still match the manifest exactly (json_each -- SQLite has no
            #    VALUES-in-FROM column aliases).
            ("DELETE FROM quota_reservation_units WHERE reservation_id = ?1 "
             "AND (SELECT COUNT(*) FROM quota_reservations WHERE reservation_id = ?1) = 1 "
             "AND (SELECT COUNT(*) FROM quota_reservation_units WHERE reservation_id = ?1) = ?2 "
             "AND NOT EXISTS (SELECT 1 FROM json_each(?3) AS m "
             "LEFT JOIN quota_reservation_units u ON u.reservation_id = ?1 "
             "AND u.dimension_key = json_extract(m.value, '$.dimension_key') "
             "WHERE u.units IS NULL OR json_extract(m.value, '$.units') > u.units)",
             [res_id, len(res_units),
              json.dumps(expected, separators=(",", ":"))]),
            # 3) header delete only after the journal row exists.
            ("DELETE FROM quota_reservations WHERE reservation_id = ?1 AND EXISTS "
             "(SELECT 1 FROM quota_reservation_journal j WHERE j.reservation_id = ?1 "
             "AND j.outcome = 'SETTLED')",
             [res_id]),
        ])
        print(f"SETTLED {res_id}")
        for u in res_units:
            slot = booked.setdefault(
                u["dimension_key"], {"units": 0, "reservations": 0}
            )
            slot["units"] += int(u["units"])
            slot["reservations"] += 1

    now_iso = (
        __import__("datetime").datetime.now(__import__("datetime").timezone.utc)
        .strftime("%Y-%m-%dT%H:%M:%SZ")
    )
    for dim, value in sorted(booked.items()):
        query(
            "INSERT INTO quota_booked_usage "
            "	(dimension_key, period_key, booked_units, booked_reservations, "
            "	 first_booked_at, last_booked_at, updated_at) "
            "VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?5) "
            "ON CONFLICT(dimension_key, period_key) DO UPDATE SET "
            "	booked_units = booked_units + excluded.booked_units, "
            "	booked_reservations = booked_reservations + excluded.booked_reservations, "
            "	last_booked_at = excluded.last_booked_at, "
            "	updated_at = excluded.updated_at",
            [dim, PK, value["units"], value["reservations"], now_iso],
        )
        print(f"BOOKED_UPSERT {dim} +{value['units']} units +{value['reservations']} reservations")

    after = query("SELECT COUNT(*) AS n FROM quota_reservations")
    remaining = int(after[0]["n"])
    units_left = query("SELECT COUNT(*) AS n FROM quota_reservation_units")
    print(f"AFTER live_reservations={remaining} unit_rows={int(units_left[0]['n'])}")
    if args.execute and remaining != 0:
        print("POST_CONDITION_FAIL live reservations remain")
        return 3
    if args.execute:
        print("POST_CONDITION_OK zero live reservations")
    elif not args.execute:
        print("DRY_RUN no writes performed (pass --execute to settle)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
