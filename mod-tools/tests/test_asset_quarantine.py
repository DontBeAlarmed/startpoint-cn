# -*- coding: utf-8 -*-
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from wf_asset_inventory import tree_manifest
import wf_asset_quarantine as quarantine_module


class AssetQuarantineTests(unittest.TestCase):
    def _plan(
        self,
        root: Path,
        source: Path,
        category: str = "stale_cache",
    ) -> quarantine_module.PlanRecord:
        entry = quarantine_module.build_plan_entry(
            source,
            category=category,
            reason="test evidence",
            auto_approved=category in quarantine_module.AUTO_CATEGORIES,
        )
        return quarantine_module.write_plan([entry], root / "run", run_id="fixture-run")

    def test_quarantine_rejects_modified_or_unknown_plan(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source = root / "unknown.bin"
            source.write_bytes(b"keep")
            plan = self._plan(root, source, category="unknown")
            with self.assertRaisesRegex(quarantine_module.QuarantineError, "not auto-approved"):
                quarantine_module.quarantine(plan.path, root / "quarantine")
            self.assertEqual(b"keep", source.read_bytes())

            approved = root / "approved.pyc"
            approved.write_bytes(b"before")
            approved_plan = self._plan(root, approved)
            approved.write_bytes(b"after")
            with self.assertRaisesRegex(quarantine_module.QuarantineError, "digest"):
                quarantine_module.quarantine(approved_plan.path, root / "quarantine-2")
            self.assertEqual(b"after", approved.read_bytes())

    def test_restore_round_trip_preserves_file_and_tree_digests(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source_tree = root / "__pycache__"
            source_tree.mkdir()
            (source_tree / "a.pyc").write_bytes(b"a")
            (source_tree / "nested").mkdir()
            (source_tree / "nested" / "b.pyc").write_bytes(b"b")
            before = tree_manifest(source_tree).tree_sha256
            plan = self._plan(root, source_tree)

            summary = quarantine_module.quarantine(plan.path, root / "quarantine")
            self.assertFalse(source_tree.exists())
            self.assertEqual(1, summary.moved_count)
            verified = quarantine_module.verify_manifest(summary.manifest_path)
            self.assertTrue(verified.ok, verified.issues)

            restored = quarantine_module.restore(summary.manifest_path)
            self.assertEqual(1, restored.restored_count)
            self.assertTrue(source_tree.is_dir())
            self.assertEqual(before, tree_manifest(source_tree).tree_sha256)

            resumed = quarantine_module.resume_quarantine(summary.manifest_path)
            self.assertEqual(1, resumed.moved_count)
            self.assertFalse(source_tree.exists())
            records = quarantine_module.read_manifest(summary.manifest_path)
            self.assertEqual(1, len({record["id"] for record in records}))

    def test_tree_plan_ignores_directory_mtime_but_quarantine_still_checks_digest(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source = root / "__pycache__"
            source.mkdir()
            child = source / "cache.pyc"
            child.write_bytes(b"before")
            manifest = tree_manifest(source)
            scanned_mtime = source.stat().st_mtime_ns
            os.utime(source, ns=(scanned_mtime + 1_000_000, scanned_mtime + 1_000_000))

            entry = quarantine_module.build_plan_entry_from_evidence(
                source,
                kind="tree",
                digest=manifest.tree_sha256,
                size=manifest.total_size,
                mtime_ns=scanned_mtime,
                category="stale_cache",
                reason="test evidence",
                auto_approved=True,
            )
            plan = quarantine_module.write_plan([entry], root / "run", run_id="fixture-run")
            child.write_bytes(b"after")
            with self.assertRaisesRegex(quarantine_module.QuarantineError, "digest mismatch"):
                quarantine_module.quarantine(plan.path, root / "quarantine")
            self.assertTrue(source.is_dir())

    def test_existing_destination_and_cross_volume_move_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source = root / "cache.pyc"
            source.write_bytes(b"cache")
            plan = self._plan(root, source)
            payload = json.loads(plan.path.read_text(encoding="utf-8"))
            entry_id = payload["entries"][0]["id"]
            target = root / "quarantine" / "data" / entry_id
            target.parent.mkdir(parents=True)
            target.write_bytes(b"do not overwrite")
            with self.assertRaisesRegex(quarantine_module.QuarantineError, "destination exists"):
                quarantine_module.quarantine(plan.path, root / "quarantine")
            self.assertTrue(source.exists())
            self.assertEqual(b"do not overwrite", target.read_bytes())

        if os.name == "nt":
            with self.assertRaisesRegex(quarantine_module.QuarantineError, "cross-volume"):
                quarantine_module.atomic_move(Path(r"C:\source.bin"), Path(r"D:\target.bin"))

    def test_target_layout_is_compact_and_does_not_repeat_source_name(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source = root / "restored_readable"
            source.mkdir()
            plan = self._plan(root, source)
            payload = json.loads(plan.path.read_text(encoding="utf-8"))
            entry = payload["entries"][0]
            self.assertEqual(
                root / "quarantine" / "data" / entry["id"],
                quarantine_module._target_for(root / "quarantine", entry),
            )

    def test_windows_target_budget_is_rejected_before_any_quarantine_mutation(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            first = root / "a.pyc"
            second = root / "b.pyc"
            first.write_bytes(b"a")
            second.write_bytes(b"b")
            entries = [
                quarantine_module.build_plan_entry(
                    source,
                    category="stale_cache",
                    reason="test evidence",
                    auto_approved=True,
                )
                for source in (first, second)
            ]
            plan = quarantine_module.write_plan(entries, root / "run", run_id="fixture-run")
            quarantine_root = root / "quarantine"
            with mock.patch.object(
                quarantine_module,
                "_validate_target_path_budget",
                side_effect=[None, quarantine_module.QuarantineError("Windows MAX_PATH budget")],
            ):
                with self.assertRaisesRegex(quarantine_module.QuarantineError, "MAX_PATH"):
                    quarantine_module.quarantine(plan.path, quarantine_root)
            self.assertTrue(first.is_file())
            self.assertTrue(second.is_file())
            self.assertFalse(quarantine_root.exists())

    def test_windows_target_budget_counts_descendant_paths_before_move(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source = root / "tree"
            nested = source / "nested"
            nested.mkdir(parents=True)
            (nested / "file.bin").write_bytes(b"x")
            long_target = root / ("q" * 250)
            with mock.patch.object(quarantine_module, "_IS_WINDOWS", True):
                with self.assertRaisesRegex(quarantine_module.QuarantineError, "MAX_PATH"):
                    quarantine_module._validate_target_path_budget(source, long_target, "tree")

    def test_manifest_tampering_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source = root / "cache.pyc"
            source.write_bytes(b"cache")
            summary = quarantine_module.quarantine(
                self._plan(root, source).path,
                root / "quarantine",
            )
            lines = summary.manifest_path.read_text(encoding="utf-8").splitlines()
            first = json.loads(lines[0])
            first["category"] = "unknown"
            lines[0] = json.dumps(first, ensure_ascii=False, sort_keys=True)
            summary.manifest_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(quarantine_module.QuarantineError, "record digest"):
                quarantine_module.verify_manifest(summary.manifest_path)

    def test_post_move_digest_mismatch_rolls_source_back(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source = root / "cache.pyc"
            source.write_bytes(b"cache")
            plan = self._plan(root, source)
            expected = quarantine_module.sha256_file(source)
            with mock.patch.object(
                quarantine_module,
                "_digest_path",
                side_effect=[(expected, len(b"cache")), ("0" * 64, len(b"cache"))],
            ):
                with self.assertRaisesRegex(quarantine_module.QuarantineError, "post-move digest"):
                    quarantine_module.quarantine(plan.path, root / "quarantine")
            self.assertTrue(source.is_file())
            self.assertEqual(b"cache", source.read_bytes())

    def test_interrupted_planned_record_can_resume_without_duplicate_identity(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source = root / "cache.pyc"
            source.write_bytes(b"cache")
            plan = self._plan(root, source)
            real_replace = os.replace
            failed = False

            def fail_first_source_move(old: str | bytes | os.PathLike[str] | os.PathLike[bytes], new: str | bytes | os.PathLike[str] | os.PathLike[bytes]) -> None:
                nonlocal failed
                if Path(old) == source and not failed:
                    failed = True
                    raise OSError("injected interruption")
                real_replace(old, new)

            with mock.patch.object(quarantine_module.os, "replace", side_effect=fail_first_source_move):
                with self.assertRaisesRegex(quarantine_module.QuarantineError, "injected interruption"):
                    quarantine_module.quarantine(plan.path, root / "quarantine")
            self.assertTrue(source.exists())

            summary = quarantine_module.quarantine(plan.path, root / "quarantine")
            self.assertFalse(source.exists())
            records = quarantine_module.read_manifest(summary.manifest_path)
            self.assertEqual(1, len({record["id"] for record in records}))
            self.assertEqual("quarantined", records[-1]["state"])

    def test_interrupted_restore_and_requarantine_records_can_resume(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source = root / "cache.pyc"
            source.write_bytes(b"cache")
            summary = quarantine_module.quarantine(
                self._plan(root, source).path,
                root / "quarantine",
            )
            target = Path(quarantine_module.read_manifest(summary.manifest_path)[-1]["target"])
            real_replace = os.replace
            failed_restore = False

            def fail_restore_once(old: str | bytes | os.PathLike[str] | os.PathLike[bytes], new: str | bytes | os.PathLike[str] | os.PathLike[bytes]) -> None:
                nonlocal failed_restore
                if Path(old) == target and not failed_restore:
                    failed_restore = True
                    raise OSError("restore interruption")
                real_replace(old, new)

            with mock.patch.object(quarantine_module.os, "replace", side_effect=fail_restore_once):
                with self.assertRaisesRegex(quarantine_module.QuarantineError, "restore interruption"):
                    quarantine_module.restore(summary.manifest_path)
            restored = quarantine_module.restore(summary.manifest_path)
            self.assertEqual(1, restored.restored_count)
            self.assertTrue(source.exists())

            failed_requarantine = False

            def fail_requarantine_once(old: str | bytes | os.PathLike[str] | os.PathLike[bytes], new: str | bytes | os.PathLike[str] | os.PathLike[bytes]) -> None:
                nonlocal failed_requarantine
                if Path(old) == source and not failed_requarantine:
                    failed_requarantine = True
                    raise OSError("requarantine interruption")
                real_replace(old, new)

            with mock.patch.object(quarantine_module.os, "replace", side_effect=fail_requarantine_once):
                with self.assertRaisesRegex(quarantine_module.QuarantineError, "requarantine interruption"):
                    quarantine_module.resume_quarantine(summary.manifest_path)
            resumed = quarantine_module.resume_quarantine(summary.manifest_path)
            self.assertEqual(1, resumed.moved_count)
            self.assertFalse(source.exists())
            self.assertTrue(target.exists())

    def test_restore_wrapper_is_literal_and_purge_requires_exact_confirmation(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source = root / "cache.pyc"
            source.write_bytes(b"cache")
            summary = quarantine_module.quarantine(
                self._plan(root, source).path,
                root / "quarantine",
            )
            wrapper = summary.manifest_path.parent / "restore.ps1"
            text = wrapper.read_text(encoding="utf-8")
            self.assertIn(str(summary.manifest_path.resolve()), text)
            self.assertNotIn("Remove-Item", text)
            with self.assertRaisesRegex(quarantine_module.QuarantineError, "PERMANENT_DELETE"):
                quarantine_module.purge(summary.manifest_path, confirmation="delete")
            self.assertTrue(verify_target(summary.manifest_path))

            quoted = root / "quote'root"
            quoted.mkdir()
            quoted_manifest = quoted / "manifest.jsonl"
            quoted_manifest.write_text("", encoding="utf-8")
            with self.assertRaisesRegex(quarantine_module.QuarantineError, "single quote"):
                quarantine_module.generate_restore_wrapper(quoted_manifest)


def verify_target(manifest: Path) -> bool:
    records = quarantine_module.read_manifest(manifest)
    latest = records[-1]
    return Path(latest["target"]).exists()


if __name__ == "__main__":
    unittest.main()
