from __future__ import annotations

import copy
import json
from pathlib import Path
import tempfile
import unittest

import build_prompts as b
import promote
import verify_deployment as v

REF = "a" * 40


def payloads() -> dict[str, str]:
    result = {b.CONFIG: (b.ROOT / b.CONFIG).read_text(encoding="utf-8"),
              b.COMPILER: (b.ROOT / b.COMPILER).read_text(encoding="utf-8")}
    for prefix in ("automation/prompts", "automation/fragments", "automation/modes", "automation_guidance", "research_guidance"):
        for path in (b.ROOT / prefix).rglob("*.md"):
            result[path.relative_to(b.ROOT).as_posix()] = path.read_text(encoding="utf-8")
    return result


def loader_for(data: dict[str, str]):
    def load(path):
        if path not in data:
            raise FileNotFoundError(path)
        return data[path]
    return load


class Response:
    status = 200
    def __init__(self, text, url):
        self.text, self.url = text, url
    def __enter__(self):
        return self
    def __exit__(self, *_):
        return False
    def read(self):
        return self.text.encode("utf-8")
    def geturl(self):
        return self.url


def opener_for(data, calls=None):
    def open_url(url, timeout=20):
        prefix = f"{b.RAW_BASE}/{REF}/"
        if not url.startswith(prefix):
            raise AssertionError("not an exact-ref fetch")
        if calls is not None:
            calls.append(url)
        return Response(loader_for(data)(url[len(prefix):]), url)
    return open_url


def control_fixture():
    return {
        "schema_version": "quantpro-automation-control-v2", "status": "PRODUCTION", "content_ref": "b" * 40,
        "registry": {key: {"prompt_id": value[0], "write_scope": value[1], "mode": value[2],
                           "production_ref": "b" * 40, "schedule": "UNCHANGED"}
                     for key, value in b.CONTRACTS.items()}
    }


def service_snapshots(manifest, prompts):
    # Test fixtures only. Production verification must consume real service objects.
    after = [{"id": entry["automation_id"], "prompt": prompts[key], "title": key,
              "schedule": "BEGIN:VEVENT\nRRULE:FREQ=HOURLY\nEND:VEVENT", "is_enabled": True,
              "default_timezone": "Asia/Shanghai", "timing_mode": "exact_schedule",
              "notifications_enabled": False, "email_enabled": False}
             for key, entry in manifest["registry"].items()]
    before = copy.deepcopy(after)
    for item in before:
        item["prompt"] = "previous static prompt\n"
    return before, after


class CompilerTests(unittest.TestCase):
    def setUp(self):
        self.data = payloads()
    def compile(self, data=None, **kwargs):
        return b.compile_all(REF, loader_for(self.data if data is None else data), **kwargs)
    def test_all_six_full_artifacts_under_budget(self):
        manifest, prompts = self.compile()
        self.assertEqual(set(prompts), set(b.CONTRACTS))
        for key, prompt in prompts.items():
            with self.subTest(key=key):
                entry = manifest["registry"][key]
                self.assertLessEqual(len(prompt), entry["max_chars"])
                self.assertEqual(len(prompt), entry["compiled_prompt_chars"])
                self.assertEqual(b.digest(prompt), entry["compiled_prompt_sha256"])
                self.assertTrue(prompt.startswith(f"DEPLOYED_FROM_GIT_REF={REF}\n"))
                self.assertTrue(prompt.endswith("\n") and not prompt.endswith("\n\n"))
                self.assertNotIn("{{", prompt)
                self.assertNotIn("raw.githubusercontent.com", prompt)
    def test_deterministic_and_cross_platform_line_endings(self):
        m1, p1 = self.compile()
        m2, p2 = self.compile({key: "\ufeff" + text.replace("\n", "\r\n") for key, text in self.data.items()})
        self.assertEqual(m1, m2)
        self.assertEqual(p1, p2)
    def test_full_ref_changes_artifact_hash(self):
        m1, _ = self.compile()
        m2, _ = b.compile_all("b" * 40, loader_for(self.data))
        for key in m1["registry"]:
            self.assertNotEqual(m1["registry"][key]["compiled_prompt_sha256"], m2["registry"][key]["compiled_prompt_sha256"])
    def test_ref_must_not_be_head_or_short_sha(self):
        for ref in ("main", "HEAD", "abc123", "A" * 40, "a" * 39):
            with self.subTest(ref=ref), self.assertRaises(b.BuildError):
                b.compile_all(ref, loader_for(self.data))
    def test_guidance_is_mandatory_and_missing_or_empty_fails(self):
        path = b.GUIDANCE["industry-research"][1][0]
        for value in (None, " \n"):
            data = dict(self.data)
            if value is None:
                del data[path]
            else:
                data[path] = value
            with self.assertRaises((b.BuildError, FileNotFoundError)):
                self.compile(data)
    def test_config_rejects_scope_mode_channel_id_and_budget_changes(self):
        for key, field, value in [
            ("company-facts", "write_scope", "READ_ONLY"),
            ("company-facts", "channel", "INDUSTRY"),
            ("holding-assistant-intraday", "mode", "PREOPEN_CLOSE"),
            ("company-facts", "automation_id", "c" * 32),
            ("company-facts", "max_chars", 99999),
            ("company-facts", "max_chars", True),
            ("industry-research", "research_guidance", []),
            ("company-facts", "path", "../secret.md"),
            ("holding-assistant-intraday", "mode_sources", []),
        ]:
            with self.subTest(field=field):
                data = dict(self.data)
                cfg = json.loads(data[b.CONFIG]); cfg["registry"][key][field] = value
                data[b.CONFIG] = json.dumps(cfg)
                with self.assertRaises(b.BuildError):
                    self.compile(data)
    def test_unsafe_paths_rejected(self):
        for path in ("../secret.md", "/etc/passwd", "automation/prompts/../secret.md", "automation//prompts/x.md", "automation\\prompts\\x.md", "https://x/y.md", "automation/control/production.json"):
            with self.subTest(path=path), self.assertRaises(b.BuildError):
                b.safe_path(path)
    def test_local_symlink_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root / "automation/prompts").mkdir(parents=True)
            target = root / "target.md"; target.write_text("secret", encoding="utf-8")
            link = root / "automation/prompts/x.md"
            try:
                link.symlink_to(target)
            except (OSError, NotImplementedError):
                self.skipTest("OS symlink privilege unavailable")
            with self.assertRaises(b.BuildError):
                b.local_loader(root)("automation/prompts/x.md")
    def test_header_mismatch_and_unknown_template_fail(self):
        path = "automation/prompts/company-facts.md"
        for text in (self.data[path].replace("PROMPT_ID=company-facts", "PROMPT_ID=wrong"), self.data[path] + "\n{{UNKNOWN}}\n"):
            data = dict(self.data); data[path] = text
            with self.assertRaises(b.BuildError):
                self.compile(data)
    def test_compiler_must_match_pinned_source(self):
        data = dict(self.data); data[b.COMPILER] += "\n# source drift\n"
        with self.assertRaisesRegex(b.BuildError, "compiler differs"):
            self.compile(data)
    def test_complete_artifact_length_not_source_length(self):
        data = dict(self.data)
        data[b.OUTPUT] += "加" * 6000
        with self.assertRaisesRegex(b.BuildError, "complete prompt"):
            self.compile(data)
    def test_obsolete_api_is_not_silently_carried_forward(self):
        for token in ("get_market_checkpoints", "append_market_checkpoint", "get_automation_control_bundle"):
            data = dict(self.data); data[b.OUTPUT] += token
            with self.subTest(token=token), self.assertRaises(b.BuildError):
                self.compile(data)
    def test_invalid_or_duplicate_selection(self):
        for keys in ([], ["unknown"], ["company-facts", "company-facts"]):
            with self.assertRaises(b.BuildError):
                self.compile(keys=keys)
    def test_mode_specialization_keeps_unreachable_workflow_out(self):
        _, prompts = self.compile()
        self.assertNotIn("## 盘前、补建、收盘", prompts["holding-assistant-intraday"])
        self.assertNotIn("## 盘中执行与输出", prompts["holding-assistant-preclose"])
        self.assertIn("不得执行盘前、10:10补建或收盘", prompts["holding-assistant-intraday"])
        self.assertIn("不得执行盘中任务", prompts["holding-assistant-preclose"])
    def test_read_only_profiles_have_no_state_write_instructions(self):
        _, prompts = self.compile()
        for key in ("central-policy", "ai-financing-rates"):
            self.assertNotIn("STATE_CHANNEL=", prompts[key])
            self.assertNotIn("append_state_batch", prompts[key])
            self.assertIn("WRITE_SCOPE=READ_ONLY", prompts[key])
    def test_all_profiles_have_two_phase_run_audit_without_business_scope_expansion(self):
        _, prompts = self.compile()
        for key, prompt in prompts.items():
            with self.subTest(key=key):
                self.assertIn("record_automation_run", prompt)
                self.assertIn("phase=STARTED", prompt)
                self.assertIn("phase=FINAL", prompt)
                self.assertIn("SILENT", prompt)
                self.assertIn("BLOCKED", prompt)
                self.assertIn("FAILED", prompt)
                self.assertIn("正常 SILENT 只有在 FINAL 审计成功后才真正静默", prompt)
        for key in ("central-policy", "ai-financing-rates"):
            self.assertNotIn("append_state_batch", prompts[key])
            self.assertIn("WRITE_SCOPE=READ_ONLY", prompts[key])
            self.assertIn("即使 WRITE_SCOPE=READ_ONLY 也只允许此例外", prompts[key])

    def test_holding_premarket_wire_enum_not_workflow_label(self):
        _, prompts = self.compile()
        for key in ("holding-assistant-preclose", "holding-assistant-intraday"):
            self.assertIn("observation_type=PREMARKET（不是PREOPEN）", prompts[key])
            self.assertNotIn("observation_type按PREOPEN", prompts[key])
            self.assertNotIn("observation_type=PREOPEN", prompts[key])
        # Read the actual domain contract: no production write is needed.
        domain = (b.ROOT / "src/market-ledger.ts").read_text(encoding="utf-8")
        self.assertIn('observation_type: z.enum(["PREMARKET", "INTRADAY", "CLOSE"])', domain)
    def test_business_invariant_regression_net(self):
        _, p = self.compile()
        checks = {
            "holding-assistant-preclose": ["MAPPING_ONLY", "全部 ACTIVE", "官方确认全部", "混合市场", "get_market_signal_state", "固定比较基准", "action_gate_id", "original_condition", "幂等键不变", "严禁用10:10", "INCONCLUSIVE", "previous_checkpoint", "universe_transition"],
            "holding-assistant-intraday": ["previous_checkpoint", "午休", "两类独立证据", "持续独立超额", "不临时换基准"],
            "industry-research": ["每轮最多1个", "historical_backfill=false", "lease_generation", "expected_generation", "get_research_job_context", "submit ACCEPTED", "defer成功", "recheck_at", "findings[].evidence_ids", "5,500", "48,000", "event_first_known_time", "不构成公司确认"],
            "company-facts": ["50%/80%/95%/100%", "最低承诺", "停滞后恢复", "不单独升级", "尚未官方确认", "订单可撤销", "company_validation"],
            "central-policy": ["权威叙事", "30–90", "正式政策工具", "地方试点", "不对政策排名", "不证明政策原因"],
            "ai-financing-rates": ["替代解释", "10Y/30Y", "不足以单独解释", "财政赤字", "期限溢价", "认购", "不自动等于个股买卖信号"],
        }
        # These are regression sentinels, not a claim of automated semantic proof.
        for key, needles in checks.items():
            for needle in needles:
                with self.subTest(key=key, needle=needle):
                    self.assertIn(needle, p[key])
        for key in ("company-facts", "industry-research", "holding-assistant-intraday", "holding-assistant-preclose"):
            for needle in ("validate_state_batch", "append_state_batch", "get_state_write_receipt", "read_state_snapshot_v2", "OUTCOME_UNKNOWN", "禁止覆盖/改键重投/换运输"):
                self.assertIn(needle, p[key])


class VerificationTests(unittest.TestCase):
    def setUp(self):
        self.data = payloads()
        self.manifest, self.prompts = b.compile_all(REF, loader_for(self.data))
        self.before, self.after = service_snapshots(self.manifest, self.prompts)
    def test_service_readback_matches_full_text(self):
        receipt = v.verify(self.manifest, self.prompts, self.before, {"jawbones": self.after})
        self.assertEqual(receipt["status"], "VERIFIED")
        self.assertEqual(len(receipt["registry"]), 6)
    def test_same_header_typo_truncation_crlf_and_final_newline_are_drift(self):
        original = self.after[0]["prompt"]
        for changed in (original + " ", original[:-1], original[:100], original.replace("\n", "\r\n"), original.replace("完整静态指令", "错误静态指令")):
            after = copy.deepcopy(self.after); after[0]["prompt"] = changed
            with self.assertRaises(b.BuildError):
                v.verify(self.manifest, self.prompts, self.before, after)
    def test_all_protected_settings_are_checked(self):
        for field in v.PROTECTED:
            after = copy.deepcopy(self.after)
            value = after[0][field]
            after[0][field] = not value if isinstance(value, bool) else value + "changed"
            with self.subTest(field=field), self.assertRaises(b.BuildError):
                v.verify(self.manifest, self.prompts, self.before, after)
    def test_missing_actual_prompt_or_setting_fails(self):
        for field in ("prompt", *v.PROTECTED):
            after = copy.deepcopy(self.after); del after[0][field]
            with self.assertRaises(b.BuildError):
                v.verify(self.manifest, self.prompts, self.before, after)
    def test_equal_utc_offset_does_not_hide_timezone_metadata_drift(self):
        after = copy.deepcopy(self.after)
        after[0]["default_timezone"] = "Australia/Perth"
        with self.assertRaisesRegex(b.BuildError, "protected setting changed: default_timezone"):
            v.verify(self.manifest, self.prompts, self.before, after)
    def test_update_request_is_not_actual_readback(self):
        requests = [{"jawbone_id": item["id"], "prompt": item["prompt"]} for item in self.after]
        with self.assertRaises(b.BuildError):
            v.verify(self.manifest, self.prompts, self.before, requests)
    def test_duplicate_or_missing_task_fails(self):
        for after in (self.after[:-1], self.after + [self.after[0]]):
            with self.assertRaises(b.BuildError):
                v.verify(self.manifest, self.prompts, self.before, after)
    def test_manifest_hash_cannot_override_full_candidate(self):
        manifest = copy.deepcopy(self.manifest)
        next(iter(manifest["registry"].values()))["compiled_prompt_sha256"] = "0" * 64
        with self.assertRaises(b.BuildError):
            v.verify(manifest, self.prompts, self.before, self.after)


class PromoteTests(unittest.TestCase):
    def setUp(self):
        self.data = payloads()
        self.manifest, self.prompts = b.compile_all(REF, loader_for(self.data))
        self.before, self.after = service_snapshots(self.manifest, self.prompts)
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "production.json"
        b.atomic_json(self.path, control_fixture())
    def call(self, **kwargs):
        return promote.promote(REF, control_path=self.path, opener=opener_for(self.data), **kwargs)
    def test_prepare_reads_public_exact_sources_but_never_changes_control(self):
        before = self.path.read_bytes(); calls = []
        result = promote.promote(REF, apply=False, control_path=self.path, opener=opener_for(self.data, calls))
        self.assertEqual(result["status"], "PREPARED")
        self.assertEqual(before, self.path.read_bytes())
        self.assertTrue(all(f"/{REF}/" in url for url in calls))
        self.assertEqual(len(calls), len(set(calls)))
    def test_apply_without_actual_readback_is_rejected(self):
        before = self.path.read_bytes()
        with self.assertRaises(b.BuildError):
            self.call(apply=True)
        self.assertEqual(before, self.path.read_bytes())
    def test_apply_verifies_and_stores_hashes(self):
        result = self.call(apply=True, before=self.before, after=self.after)
        self.assertEqual(result["status"], "VERIFIED")
        saved = json.loads(self.path.read_text(encoding="utf-8"))
        for key, entry in saved["registry"].items():
            self.assertEqual(entry["compiled_prompt_sha256"], b.digest(self.prompts[key]))
            self.assertEqual(entry["schedule"], "UNCHANGED")
    def test_failure_does_not_advance_control(self):
        before = self.path.read_bytes(); self.after[0]["prompt"] += "BAD"
        with self.assertRaises(b.BuildError):
            self.call(apply=True, before=self.before, after=self.after)
        self.assertEqual(before, self.path.read_bytes())
    def test_bad_candidate_header_cannot_be_promoted(self):
        before = self.path.read_bytes()
        p = "automation/prompts/industry-research.md"
        self.data[p] = self.data[p].replace("PROMPT_ID=industry-research", "PROMPT_ID=wrong")
        with self.assertRaises(b.BuildError):
            self.call(apply=True, before=self.before, after=self.after)
        self.assertEqual(before, self.path.read_bytes())
    def test_partial_release_keeps_other_refs_truthful(self):
        self.call(apply=True, keys=["company-facts"], before=self.before, after=self.after)
        saved = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertIsNone(saved["content_ref"])
        self.assertEqual(saved["registry"]["company-facts"]["production_ref"], REF)
        self.assertEqual(saved["registry"]["central-policy"]["production_ref"], "b" * 40)
    def test_remote_failure_keeps_control(self):
        before = self.path.read_bytes(); del self.data[b.GUIDANCE["company-facts"][0][0]]
        with self.assertRaises(FileNotFoundError):
            self.call(apply=True, before=self.before, after=self.after)
        self.assertEqual(before, self.path.read_bytes())


if __name__ == "__main__":
    unittest.main()
