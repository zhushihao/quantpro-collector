#!/usr/bin/env python3
"""Release-time deterministic static Prompt compiler. Standard library only.

No runtime fetches, dynamic includes, LLM calls, or Automation mutations.
Full artifact hashes include the exact source-ref header; hashes live outside
of the artifact to avoid circular/self-referential hashes.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tempfile
import time
from typing import Callable
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
REPO = "zhushihao/quantpro-collector"
RAW_BASE = f"https://raw.githubusercontent.com/{REPO}"
CONFIG = "automation/build-config.json"
COMPILER = "automation/build_prompts.py"
AUTOMATION_IDS = {
    "holding-assistant-intraday": "6aba13a9be90819191840692ed697bb1",
    "holding-assistant-preclose": "6aaa80041c74819191a7d6eb5d3568d8",
    "industry-research": "6a8471af3b688191b076a7bb50bf956f",
    "company-facts": "6aba138166f48191967e6a6124b7a282",
    "central-policy": "6ab94a7c724881919729edb2ccc7fb58",
    "ai-financing-rates": "6ab94a0c00c88191a1a3b302295723bf",
}
CONTRACT = "automation-v3"
SHA40 = re.compile(r"[0-9a-f]{40}\Z")
COMMON = [
    "automation/fragments/common-safety.md",
    "automation/fragments/run-audit.md",
    "automation/fragments/fresh-delta.md",
]
OUTPUT = "automation/fragments/output-style.md"
STATE = "automation/fragments/state-gateway.md"
INVESTMENT = "automation/fragments/investment-input.md"
# Deliberate release contract: changing permissions/modes/budgets requires review.
CONTRACTS = {
    "holding-assistant-intraday": ("holding-assistant", "MARKET_LEDGER_APPEND_ONLY", "INTRADAY", "MARKET", 6500),
    "holding-assistant-preclose": ("holding-assistant", "MARKET_LEDGER_APPEND_ONLY", "PREOPEN_CLOSE", "MARKET", 6500),
    "industry-research": ("industry-research", "RESEARCH_JOB_AND_INDUSTRY_LEDGER", None, "INDUSTRY", 5600),
    "company-facts": ("company-facts", "COMPANY_LEDGER_APPEND_ONLY", None, "COMPANY", 4700),
    "central-policy": ("central-policy", "READ_ONLY", None, None, 4200),
    "ai-financing-rates": ("ai-financing-rates", "READ_ONLY", None, None, 4200),
}
GUIDANCE = {
    "holding-assistant": (["automation_guidance/holding-assistant/mode-discipline.md"], []),
    "industry-research": (["automation_guidance/industry-research/system-bom-fresh-delta.md"], ["research_guidance/industry-research/fresh-delta-event-time.md"]),
    "company-facts": (["automation_guidance/company-facts/capital-action-milestones.md"], []),
    "central-policy": (["automation_guidance/central-policy/authority-narrative-fresh-delta.md"], []),
    "ai-financing-rates": (["automation_guidance/ai-financing-rates/causal-discipline.md"], []),
}
MODES = {
    "INTRADAY": ["automation/modes/holding-intraday.md"],
    "PREOPEN_CLOSE": ["automation/modes/holding-preclose.md"],
    None: [],
}
Loader = Callable[[str], str]


class BuildError(RuntimeError):
    pass


def require_ref(ref: str) -> str:
    if not isinstance(ref, str) or not SHA40.fullmatch(ref):
        raise BuildError("ref must be a full lowercase 40-character commit SHA")
    return ref


def safe_path(path: str) -> str:
    if not isinstance(path, str) or not path or "\\" in path or ":" in path:
        raise BuildError(f"unsafe source path: {path!r}")
    p = PurePosixPath(path)
    if p.is_absolute() or str(p) != path or any(part in (".", "..") for part in path.split("/")):
        raise BuildError(f"non-canonical source path: {path!r}")
    prefixes = ("automation/prompts/", "automation/fragments/", "automation/modes/", "automation_guidance/", "research_guidance/")
    if path not in (CONFIG, COMPILER) and not (path.startswith(prefixes) and path.endswith(".md")):
        raise BuildError(f"source path outside allowlist: {path}")
    return path


def normalize(text: str) -> str:
    if not isinstance(text, str) or "\x00" in text:
        raise BuildError("source is not valid text")
    text = text.removeprefix("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    text = "\n".join(line.rstrip() for line in text.split("\n")).strip("\n")
    if not text.strip():
        raise BuildError("empty source")
    try:
        text.encode("utf-8", "strict")
    except UnicodeError as exc:
        raise BuildError("source is not UTF-8 encodable") from exc
    return text + "\n"


def digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def local_loader(root: Path) -> Loader:
    root = root.resolve()
    def load(path: str) -> str:
        target = root / safe_path(path)
        # Reject symlinks even if they happen to resolve inside the repository.
        if any(p.is_symlink() for p in [target, *target.parents] if p != root and root in p.parents):
            raise BuildError(f"symlink source forbidden: {path}")
        if root not in target.resolve().parents:
            raise BuildError(f"source escapes repository: {path}")
        return target.read_bytes().decode("utf-8")
    return load


def git_loader(root: Path, ref: str) -> Loader:
    require_ref(ref)
    def load(path: str) -> str:
        path = safe_path(path)
        meta = subprocess.run(["git", "ls-tree", ref, "--", path], cwd=root, check=True, capture_output=True).stdout
        if not meta.startswith(b"100644 ") and not meta.startswith(b"100755 "):
            raise BuildError(f"missing/non-regular Git source: {path}")
        return subprocess.run(["git", "show", f"{ref}:{path}"], cwd=root, check=True, capture_output=True).stdout.decode("utf-8")
    return load


def fetch_raw(ref: str, path: str, *, opener=urllib.request.urlopen, attempts: int = 3) -> str:
    url = f"{RAW_BASE}/{require_ref(ref)}/{safe_path(path)}"
    last = None
    for attempt in range(attempts):
        try:
            with opener(url, timeout=20) as response:
                if getattr(response, "status", 200) != 200:
                    raise BuildError(f"non-200 source: {path}")
                if hasattr(response, "geturl") and response.geturl() != url:
                    raise BuildError(f"unexpected source redirect: {path}")
                body = response.read()
                if not body or len(body) > 262144:
                    raise BuildError(f"empty/oversized source: {path}")
                return body.decode("utf-8")
        except (urllib.error.URLError, TimeoutError) as exc:
            last = exc
            if attempt + 1 < attempts:
                time.sleep(2 ** attempt)
    raise BuildError(f"exact-ref source unavailable: {path}: {last}")


def raw_loader(ref: str, *, opener=urllib.request.urlopen) -> Loader:
    require_ref(ref)
    return lambda path: fetch_raw(ref, path, opener=opener)


def load_config(loader: Loader) -> dict:
    config = json.loads(normalize(loader(CONFIG)))
    if not isinstance(config, dict) or not isinstance(config.get("registry"), dict):
        raise BuildError("build config must be an object with a registry")
    if config.get("contract_version") != CONTRACT or set(config["registry"]) != set(CONTRACTS):
        raise BuildError("build registry/contract differs from the approved six-task contract")
    ids = set()
    for key, entry in config["registry"].items():
        if not isinstance(entry, dict):
            raise BuildError(f"{key}: registry entry must be an object")
        pid, scope, mode, channel, ceiling = CONTRACTS[key]
        expected = {"prompt_id": pid, "write_scope": scope, "mode": mode, "channel": channel,
                    "path": f"automation/prompts/{pid}.md", "mode_sources": MODES[mode],
                    "automation_guidance": GUIDANCE[pid][0], "research_guidance": GUIDANCE[pid][1]}
        for field, value in expected.items():
            if entry.get(field) != value:
                raise BuildError(f"{key}: invalid {field}")
        if set(entry) != set(expected) | {"automation_id", "max_chars"}:
            raise BuildError(f"{key}: unknown/missing build fields")
        budget = entry["max_chars"]
        if type(budget) is not int or not 1 <= budget <= ceiling:
            raise BuildError(f"{key}: invalid length budget")
        task_id = entry["automation_id"]
        if task_id != AUTOMATION_IDS[key] or task_id in ids:
            raise BuildError(f"{key}: invalid/duplicate automation id")
        ids.add(task_id)
    return config


def compile_all(ref: str, loader: Loader, *, keys: list[str] | None = None, provenance: str = "UNVERIFIED") -> tuple[dict, dict[str, str]]:
    require_ref(ref)
    cache: dict[str, str] = {}
    def read(path: str) -> str:
        path = safe_path(path)
        if path not in cache:
            cache[path] = normalize(loader(path))
        return cache[path]
    config = load_config(read)
    compiler_source = read(COMPILER)
    if compiler_source != normalize(Path(__file__).read_bytes().decode("utf-8")):
        raise BuildError("running compiler differs from candidate exact-ref compiler")
    selected = sorted(config["registry"] if keys is None else keys)
    if not selected or len(selected) != len(set(selected)) or set(selected) - set(CONTRACTS):
        raise BuildError("invalid/duplicate selected registry keys")
    manifest = {"contract_version": CONTRACT, "source_ref": ref, "source_provenance": provenance,
                "build_config_sha256": digest(read(CONFIG)), "compiler_sha256": digest(compiler_source), "registry": {}}
    prompts = {}
    for key in selected:
        entry = config["registry"][key]
        sources = [entry["path"], *COMMON]
        if entry["channel"]:
            sources += [STATE]
        if entry["channel"] in ("INDUSTRY", "COMPANY"):
            sources += [INVESTMENT]
        sources += entry["mode_sources"] + [OUTPUT] + entry["automation_guidance"] + entry["research_guidance"]
        if len(sources) != len(set(sources)):
            raise BuildError(f"{key}: duplicate source")
        body = read(entry["path"])
        head = body.splitlines()[:10]
        for marker in (f"PROMPT_ID={entry['prompt_id']}", "STATUS=PRODUCTION", f"WRITE_SCOPE={entry['write_scope']}"):
            if head.count(marker) != 1:
                raise BuildError(f"{key}: source header mismatch: {marker}")
        metadata = [f"DEPLOYED_FROM_GIT_REF={ref}", f"REGISTRY_KEY={key}", f"CONTRACT_VERSION={CONTRACT}"]
        if entry["mode"]:
            metadata.append(f"TASK_MODE={entry['mode']}")
        if entry["channel"]:
            metadata.append(f"STATE_CHANNEL={entry['channel']}")
        pieces = []
        for path in sources:
            text = read(path)
            if path == STATE:
                text = text.replace("{{STATE_CHANNEL}}", entry["channel"])
            if "{{" in text or "}}" in text:
                raise BuildError(f"{key}: unresolved template in {path}")
            pieces.append(text.rstrip("\n"))
        prompt = "\n".join(metadata) + "\n\n" + "\n\n".join(pieces) + "\n"
        # Single-envelope contract (2026-09-29): legacy two-phase run
        # registration tools must never re-enter production prompts.
        for obsolete in ("begin_run", "end_run", "record_automation_run", "get_market_checkpoints", "append_market_checkpoint", "get_automation_control_bundle", "raw.githubusercontent.com"):
            if obsolete in prompt:
                raise BuildError(f"{key}: obsolete/runtime-loading reference: {obsolete}")
        if len(prompt) > entry["max_chars"]:
            raise BuildError(f"{key}: complete prompt {len(prompt)} chars > budget {entry['max_chars']}")
        prompts[key] = prompt
        manifest["registry"][key] = {**entry, "production_ref": ref,
            "compiled_prompt_sha256": digest(prompt), "compiled_prompt_chars": len(prompt),
            "source_sha256": {p: digest(read(p)) for p in sources}}
    return manifest, prompts


def atomic_json(path: Path, value: dict | list) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def emit(out: Path, manifest: dict, prompts: dict[str, str]) -> None:
    out.mkdir(parents=True, exist_ok=True)
    for key, text in prompts.items():
        (out / f"{key}.txt").write_bytes(text.encode("utf-8"))
    atomic_json(out / "manifest.json", manifest)
    atomic_json(out / "update-payloads.json", [
        {"jawbone_id": manifest["registry"][k]["automation_id"], "prompt": v}
        for k, v in prompts.items()
    ])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ref", required=True)
    parser.add_argument("--source", choices=("local", "git", "raw"), default="git")
    parser.add_argument("--keys", nargs="+")
    parser.add_argument("--out", type=Path, default=ROOT / "automation/_build/candidate")
    args = parser.parse_args(argv)
    try:
        loaders = {"local": lambda: local_loader(ROOT), "git": lambda: git_loader(ROOT, args.ref), "raw": lambda: raw_loader(args.ref)}
        provenance = {"local": "WORKTREE_PREVIEW", "git": "GIT_EXACT", "raw": "PUBLIC_RAW_EXACT"}[args.source]
        manifest, prompts = compile_all(args.ref, loaders[args.source](), keys=args.keys, provenance=provenance)
        emit(args.out, manifest, prompts)
        print(json.dumps({"BUILD": "PASS", "provenance": provenance, "registry": {
            k: {f: e[f] for f in ("compiled_prompt_chars", "max_chars", "compiled_prompt_sha256")}
            for k, e in manifest["registry"].items()}}, ensure_ascii=False))
        return 0
    except (BuildError, OSError, ValueError, subprocess.SubprocessError) as exc:
        print(f"BUILD=FAIL {type(exc).__name__}: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
