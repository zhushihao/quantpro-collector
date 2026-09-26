#!/usr/bin/env python3
"""Prepare exact-ref static prompts; apply control ONLY after actual readback.

Preparation is not deployment. This CLI never calls the Automation service.
Use prompt-only payloads from the public build, capture the service responses,
then supply --before/--after to verify and record the installed version.
"""
from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path
import urllib.request

from build_prompts import BuildError, CONTRACT, ROOT, atomic_json, compile_all, emit, raw_loader
from verify_deployment import verify

CONTROL = ROOT / "automation/control/production.json"
PromotionError = BuildError


def _read_control(path: Path = CONTROL) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or value.get("status") != "PRODUCTION" or not value.get("registry"):
        raise PromotionError("invalid production audit control")
    return value


def validate_candidate(control: dict, ref: str, *, opener=urllib.request.urlopen, keys: list[str] | None = None) -> tuple[dict, dict[str, str]]:
    manifest, prompts = compile_all(ref, raw_loader(ref, opener=opener), keys=keys, provenance="PUBLIC_RAW_EXACT")
    for key, entry in manifest["registry"].items():
        old = control["registry"].get(key)
        if not isinstance(old, dict):
            raise PromotionError(f"{key}: not an existing production task")
        for field in ("prompt_id", "write_scope", "mode"):
            if old.get(field) != entry.get(field):
                raise PromotionError(f"{key}: production ownership/mode changed: {field}")
        if old.get("automation_id", entry["automation_id"]) != entry["automation_id"]:
            raise PromotionError(f"{key}: production task id changed")
    return manifest, prompts


def promote(ref: str, *, apply: bool, control_path: Path = CONTROL,
            opener=urllib.request.urlopen, keys: list[str] | None = None,
            before: object = None, after: object = None, out: Path | None = None) -> dict:
    if apply and (before is None or after is None):
        raise PromotionError("--apply requires actual Automation before and after snapshots")
    original_bytes = control_path.read_bytes()
    control = _read_control(control_path)
    manifest, prompts = validate_candidate(control, ref, opener=opener, keys=keys)
    if out is not None:
        emit(out, manifest, prompts)
    result = {"status": "PREPARED", "manifest": manifest, "control_changed": False}
    if not apply:
        return result
    receipt = verify(manifest, prompts, before, after)
    updated = copy.deepcopy(control)
    updated["schema_version"] = "quantpro-automation-control-v3"
    for key, candidate in manifest["registry"].items():
        entry = updated["registry"][key]
        for field in ("path", "production_ref", "automation_id", "automation_guidance", "research_guidance", "compiled_prompt_sha256", "compiled_prompt_chars", "max_chars"):
            entry[field] = candidate[field]
        entry["contract_version"] = CONTRACT
        entry["deployment_status"] = "VERIFIED"
        entry["source_sha256"] = candidate["source_sha256"]
    refs = {entry["production_ref"] for entry in updated["registry"].values()}
    updated["content_ref"] = next(iter(refs)) if len(refs) == 1 else None
    updated["last_verified_release_ref"] = ref
    # Guard against another release moving the control while raw verification ran.
    if control_path.read_bytes() != original_bytes:
        raise PromotionError("production control changed during verification; reread before applying")
    if out is not None:
        atomic_json(out / "deployment-receipt.json", receipt)
    atomic_json(control_path, updated)
    return {"status": "VERIFIED", "manifest": manifest, "receipt": receipt, "control_changed": True}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ref", required=True)
    parser.add_argument("--keys", nargs="+")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--before", type=Path)
    parser.add_argument("--after", type=Path)
    parser.add_argument("--out", type=Path, default=ROOT / "automation/_build/public")
    parser.add_argument("--control", type=Path, default=CONTROL)
    args = parser.parse_args(argv)
    try:
        before = json.loads(args.before.read_text(encoding="utf-8")) if args.before else None
        after = json.loads(args.after.read_text(encoding="utf-8")) if args.after else None
        result = promote(args.ref, apply=args.apply, keys=args.keys, control_path=args.control,
                         before=before, after=after, out=args.out)
        print(json.dumps({"PROMOTION_GATE": "PASS", "deployment_status": result["status"],
                          "ref": args.ref, "control_changed": result["control_changed"],
                          "registry": {key: {field: entry[field] for field in ("compiled_prompt_chars", "compiled_prompt_sha256")}
                                       for key, entry in result["manifest"]["registry"].items()}}, ensure_ascii=False))
        return 0
    except (BuildError, OSError, ValueError, KeyError, TypeError) as exc:
        print(f"PROMOTION_GATE=FAIL {type(exc).__name__}: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
