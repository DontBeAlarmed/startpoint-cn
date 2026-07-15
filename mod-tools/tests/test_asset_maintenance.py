# -*- coding: utf-8 -*-
from __future__ import annotations

import contextlib
import hashlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import wf_asset_maintenance as maintenance


def write_policy(root: Path) -> Path:
    policy = root / "policy.json"
    policy.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "scan_roots": ["work"],
                "protected_roots": ["work/protected"],
                "backup_keep_latest": 3,
                "backup_markers": [".bak-wfmod-", ".bak-charfields-"],
                "auto_categories": [
                    "exact_duplicate",
                    "proven_regenerable",
                    "stale_cache",
                    "retention_expired",
                ],
                "stale_cache_directory_names": ["__pycache__", ".pytest_cache"],
                "stale_cache_suffixes": [".pyc", ".pyo"],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    return policy


def run_cli(*arguments: str) -> tuple[int, dict[str, object], str]:
    stdout = io.StringIO()
    stderr = io.StringIO()
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        code = maintenance.main(list(arguments))
    lines = [line for line in stdout.getvalue().splitlines() if line.strip()]
    if not lines:
        raise AssertionError(f"CLI produced no JSON; stderr={stderr.getvalue()}")
    return code, json.loads(lines[-1]), stderr.getvalue()


class AssetMaintenanceCliTests(unittest.TestCase):
    def _fixture(self, root: Path) -> tuple[Path, Path, Path]:
        work = root / "work"
        (work / "__pycache__").mkdir(parents=True)
        (work / "__pycache__" / "cache.pyc").write_bytes(b"cache")
        (work / "protected").mkdir()
        (work / "protected" / "important.bin").write_bytes(b"important")
        (work / "unknown.bin").write_bytes(b"unknown")
        policy = write_policy(root)
        graph = root / "cdn-graph.json"
        graph.write_text(
            json.dumps({"tailVersion": "1.4.1", "supported": [], "issues": [], "edges": []}),
            encoding="utf-8",
        )
        run_dir = root / "run"
        return policy, graph, run_dir

    def test_plan_then_quarantine_moves_only_auto_categories(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td).resolve()
            policy, graph, run_dir = self._fixture(root)

            code, scanned, _ = run_cli(
                "scan",
                "--repo-root",
                str(root),
                "--policy",
                str(policy),
                "--run-dir",
                str(run_dir),
            )
            self.assertEqual(0, code, scanned)
            self.assertTrue(scanned["ok"])
            scan_path = Path(str(scanned["artifact"]))

            code, planned, _ = run_cli(
                "plan",
                "--scan",
                str(scan_path),
                "--cdn-graph",
                str(graph),
                "--policy",
                str(policy),
            )
            self.assertEqual(0, code, planned)
            self.assertEqual(0, planned["move_counts"].get("unknown", 0))
            self.assertEqual(1, planned["move_counts"]["stale_cache"])
            plan_path = Path(str(planned["artifact"]))

            code, preflight, _ = run_cli(
                "verify",
                "--plan",
                str(plan_path),
                "--mode",
                "preflight",
            )
            self.assertEqual(0, code, preflight)
            self.assertEqual(0, preflight["unknown_moved"])

            quarantine_root = root / "quarantine"
            code, quarantined, _ = run_cli(
                "quarantine",
                "--plan",
                str(plan_path),
                "--quarantine-root",
                str(quarantine_root),
            )
            self.assertEqual(0, code, quarantined)
            self.assertEqual({"stale_cache": 1}, quarantined["moved_by_category"])
            self.assertFalse((root / "work" / "__pycache__").exists())
            self.assertTrue((root / "work" / "unknown.bin").exists())
            self.assertTrue((root / "work" / "protected" / "important.bin").exists())

            manifest = Path(str(quarantined["artifact"]))
            code, verified, _ = run_cli("verify", "--manifest", str(manifest))
            self.assertEqual(0, code, verified)
            self.assertTrue(verified["ok"])

            code, restored, _ = run_cli("restore", "--manifest", str(manifest))
            self.assertEqual(0, code, restored)
            self.assertTrue((root / "work" / "__pycache__" / "cache.pyc").is_file())

    def test_scan_records_but_does_not_descend_into_protected_roots(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td).resolve()
            policy, _graph, run_dir = self._fixture(root)
            code, scanned, _ = run_cli(
                "scan", "--repo-root", str(root), "--policy", str(policy), "--run-dir", str(run_dir)
            )
            self.assertEqual(0, code, scanned)
            header, entries, _footer = maintenance.load_scan(Path(str(scanned["artifact"])))
            protected = str((root / "work" / "protected").resolve())
            self.assertIn(protected, header["excluded_roots"])
            self.assertFalse(
                any(Path(str(entry["absolute_path"])).is_relative_to(root / "work" / "protected") for entry in entries)
            )
            self.assertTrue(any(entry["relative_path"] == "unknown.bin" for entry in entries))

    def test_scan_and_plan_digests_gate_every_mutation(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td).resolve()
            policy, graph, run_dir = self._fixture(root)
            code, scanned, _ = run_cli(
                "scan", "--repo-root", str(root), "--policy", str(policy), "--run-dir", str(run_dir)
            )
            self.assertEqual(0, code)
            scan_path = Path(str(scanned["artifact"]))
            with scan_path.open("a", encoding="utf-8") as stream:
                stream.write("{}\n")
            code, failed_plan, _ = run_cli(
                "plan", "--scan", str(scan_path), "--cdn-graph", str(graph), "--policy", str(policy)
            )
            self.assertEqual(2, code)
            self.assertFalse(failed_plan["ok"])

            scan_path.unlink()
            code, scanned, _ = run_cli(
                "scan", "--repo-root", str(root), "--policy", str(policy), "--run-dir", str(run_dir)
            )
            self.assertEqual(0, code)
            code, planned, _ = run_cli(
                "plan",
                "--scan",
                str(scanned["artifact"]),
                "--cdn-graph",
                str(graph),
                "--policy",
                str(policy),
            )
            self.assertEqual(0, code)
            plan_path = Path(str(planned["artifact"]))
            payload = json.loads(plan_path.read_text(encoding="utf-8"))
            payload["entries"][0]["reason"] = "tampered"
            plan_path.write_text(json.dumps(payload), encoding="utf-8")
            code, failed_quarantine, _ = run_cli(
                "quarantine",
                "--plan",
                str(plan_path),
                "--quarantine-root",
                str(root / "quarantine"),
            )
            self.assertEqual(2, code)
            self.assertFalse(failed_quarantine["ok"])
            self.assertTrue((root / "work" / "__pycache__").exists())

    def test_rehashed_scan_cannot_inject_a_path_outside_its_declared_root(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td).resolve()
            policy, graph, run_dir = self._fixture(root)
            code, scanned, _ = run_cli(
                "scan", "--repo-root", str(root), "--policy", str(policy), "--run-dir", str(run_dir)
            )
            self.assertEqual(0, code)
            scan_path = Path(str(scanned["artifact"]))
            records = [json.loads(line) for line in scan_path.read_text(encoding="utf-8").splitlines()]
            entry = next(record for record in records if record["record_type"] == "entry")
            entry["absolute_path"] = str(root / "outside.bin")
            digest = hashlib.sha256()
            encoded: list[bytes] = []
            for record in records[:-1]:
                raw = maintenance._json_bytes(record)
                encoded.append(raw)
                digest.update(raw)
            records[-1]["scan_digest"] = digest.hexdigest()
            encoded.append(maintenance._json_bytes(records[-1]))
            scan_path.write_bytes(b"".join(encoded))

            code, result, _ = run_cli(
                "plan", "--scan", str(scan_path), "--cdn-graph", str(graph), "--policy", str(policy)
            )
            self.assertEqual(2, code)
            self.assertFalse(result["ok"])
            self.assertIn("does not match its root", str(result["error"]))

    def test_purge_refuses_wrong_confirmation(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td).resolve()
            policy, graph, run_dir = self._fixture(root)
            _, scanned, _ = run_cli(
                "scan", "--repo-root", str(root), "--policy", str(policy), "--run-dir", str(run_dir)
            )
            _, planned, _ = run_cli(
                "plan",
                "--scan",
                str(scanned["artifact"]),
                "--cdn-graph",
                str(graph),
                "--policy",
                str(policy),
            )
            _, quarantined, _ = run_cli(
                "quarantine",
                "--plan",
                str(planned["artifact"]),
                "--quarantine-root",
                str(root / "quarantine"),
            )
            code, result, _ = run_cli(
                "purge",
                "--manifest",
                str(quarantined["artifact"]),
                "--confirm",
                "delete",
            )
            self.assertEqual(2, code)
            self.assertFalse(result["ok"])
            self.assertTrue(any((root / "quarantine" / "data").rglob("cache.pyc")))


if __name__ == "__main__":
    unittest.main()
