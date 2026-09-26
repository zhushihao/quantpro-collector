#!/usr/bin/env python3
"""Verify actual Automation readback, not an update request or an echoed hash.

Input snapshots are captured from the Automation service (list or update result).
No service credentials are accepted and this program performs no remote writes.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from build_prompts import BuildError, CONTRACT, atomic_json, digest

PROTECTED = ("title", "schedule", "is_enabled", "default_timezone", "timing_mode", "notifications_enabled", "email_enabled")


def snapshots(value: object) -> dict[str, dict]:
    if isinstance(value, dict):
        if "jawbones" in value:
            value = value["jawbones"]
        elif "jawbone" in value:
            value = [value["jawbone"]]
        elif "id" in value:
            value = [value]
    if not isinstance(value, list):
        raise BuildError("snapshot must contain actual Automation objects")
    result = {}
    for item in value:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            raise BuildError("invalid actual Automation snapshot")
        if item["id"] in result:
            raise BuildError("duplicate Automation id in snapshot")
        result[item["id"]] = item
    return result


def verify(manifest: dict, prompts: dict[str, str], before: object, after: object) -> dict:
    if manifest.get("contract_version") != CONTRACT:
        raise BuildError("unsupported manifest contract")
    baseline, observed = snapshots(before), snapshots(after)
    if set(prompts) != set(manifest["registry"]):
        raise BuildError("manifest/prompt key mismatch")
    results = {}
    for key, expected in manifest["registry"].items():
        task_id = expected["automation_id"]
        if task_id not in baseline or task_id not in observed:
            raise BuildError(f"{key}: actual baseline/readback missing")
        original, actual = baseline[task_id], observed[task_id]
        for field in PROTECTED:
            if field not in original or field not in actual:
                raise BuildError(f"{key}: protected field not observed: {field}")
            if type(original[field]) is not type(actual[field]) or original[field] != actual[field]:
                raise BuildError(f"{key}: protected setting changed: {field}")
        for field in ("is_enabled", "notifications_enabled", "email_enabled"):
            if type(actual[field]) is not bool:
                raise BuildError(f"{key}: invalid actual boolean: {field}")
        for field in ("title", "schedule", "default_timezone", "timing_mode"):
            if not isinstance(actual[field], str) or not actual[field]:
                raise BuildError(f"{key}: invalid actual setting: {field}")
        prompt = actual.get("prompt")
        if not isinstance(prompt, str):
            raise BuildError(f"{key}: actual saved full prompt was not returned")
        candidate = prompts[key]
        if digest(candidate) != expected["compiled_prompt_sha256"] or len(candidate) != expected["compiled_prompt_chars"]:
            raise BuildError(f"{key}: expected artifact differs from manifest")
        # Deliberately no normalization: CRLF, truncation, typo, or missing final LF is drift.
        if prompt != candidate or digest(prompt) != expected["compiled_prompt_sha256"]:
            raise BuildError(f"{key}: actual saved prompt differs from compiled full text")
        if len(prompt) > expected["max_chars"]:
            raise BuildError(f"{key}: actual saved prompt exceeds budget")
        results[key] = {
            "automation_id": task_id, "status": "MATCH", "production_ref": expected["production_ref"],
            "compiled_prompt_sha256": digest(prompt), "compiled_prompt_chars": len(prompt),
            "protected_settings": {field: actual[field] for field in PROTECTED},
            "protected_settings_unchanged": True,
        }
        if isinstance(original.get("prompt"), str):
            results[key]["previous_prompt_sha256"] = digest(original["prompt"])
            results[key]["previous_prompt_chars"] = len(original["prompt"])
    return {"contract_version": CONTRACT, "source_ref": manifest["source_ref"], "status": "VERIFIED", "registry": results}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build-dir", type=Path, required=True)
    parser.add_argument("--before", type=Path, required=True)
    parser.add_argument("--after", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        manifest = json.loads((args.build_dir / "manifest.json").read_text(encoding="utf-8"))
        prompts = {key: (args.build_dir / f"{key}.txt").read_bytes().decode("utf-8") for key in manifest["registry"]}
        receipt = verify(manifest, prompts, json.loads(args.before.read_text(encoding="utf-8")), json.loads(args.after.read_text(encoding="utf-8")))
        atomic_json(args.receipt, receipt)
        print(json.dumps(receipt, ensure_ascii=False))
        return 0
    except (BuildError, OSError, ValueError, KeyError) as exc:
        print(f"DEPLOYMENT_VERIFY=FAIL {type(exc).__name__}: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
