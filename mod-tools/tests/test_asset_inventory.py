# -*- coding: utf-8 -*-
from __future__ import annotations

import hashlib
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import wf_asset_inventory as inventory


class AssetInventoryTests(unittest.TestCase):
    def _make_directory_link(self, link: Path, target: Path) -> None:
        try:
            os.symlink(target, link, target_is_directory=True)
            return
        except (NotImplementedError, OSError):
            if os.name != "nt":
                self.skipTest("directory links are unavailable")
        completed = subprocess.run(
            ["cmd.exe", "/d", "/c", "mklink", "/J", str(link), str(target)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
        if completed.returncode != 0:
            self.skipTest(f"directory junctions are unavailable: {completed.stderr.strip()}")

    def test_scan_root_hashes_files_without_following_directory_links(self) -> None:
        with tempfile.TemporaryDirectory() as td, tempfile.TemporaryDirectory() as outside_td:
            root = Path(td)
            outside = Path(outside_td)
            (root / "safe.bin").write_bytes(b"safe")
            (outside / "secret.bin").write_bytes(b"must not be read")
            self._make_directory_link(root / "linked", outside)

            entries = list(inventory.scan_root(root))

            self.assertEqual(["linked", "safe.bin"], [item.relative_path for item in entries])
            self.assertEqual("reparse", entries[0].kind)
            self.assertTrue(entries[0].reparse)
            self.assertIsNone(entries[0].sha256)
            self.assertEqual("file", entries[1].kind)
            self.assertEqual(hashlib.sha256(b"safe").hexdigest(), entries[1].sha256)
            self.assertFalse(any("secret.bin" in item.relative_path for item in entries))

    def test_scan_root_is_stable_and_includes_normal_directories(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "b").mkdir()
            (root / "A").mkdir()
            (root / "b" / "z.bin").write_bytes(b"z")
            (root / "A" / "a.bin").write_bytes(b"a")

            entries = list(inventory.scan_root(root))

            self.assertEqual(
                ["A", "A/a.bin", "b", "b/z.bin"],
                [item.relative_path for item in entries],
            )
            self.assertEqual(["directory", "file", "directory", "file"], [item.kind for item in entries])
            self.assertTrue(all(item.absolute_path.is_absolute() for item in entries))

    def test_tree_manifest_changes_when_content_or_path_changes(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "a.bin").write_bytes(b"first")
            first = inventory.tree_manifest(root)

            (root / "a.bin").write_bytes(b"changed")
            second = inventory.tree_manifest(root)
            self.assertNotEqual(first.tree_sha256, second.tree_sha256)

            (root / "a.bin").rename(root / "renamed.bin")
            third = inventory.tree_manifest(root)
            self.assertNotEqual(second.tree_sha256, third.tree_sha256)
            self.assertEqual(1, third.file_count)
            self.assertEqual(len(b"changed"), third.total_size)

    def test_sha256_file_streams_large_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            target = Path(td) / "large.bin"
            raw = (b"0123456789abcdef" * 8192) + b"tail"
            target.write_bytes(raw)
            self.assertEqual(
                hashlib.sha256(raw).hexdigest(),
                inventory.sha256_file(target, chunk_size=1021),
            )

    def test_missing_root_is_rejected_without_creating_it(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            missing = Path(td) / "missing"
            with self.assertRaisesRegex(inventory.InventoryError, "scan root"):
                list(inventory.scan_root(missing))
            self.assertFalse(missing.exists())

    def test_explicit_exclusion_is_not_descended_or_hashed(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "safe.bin").write_bytes(b"safe")
            output = root / "run"
            output.mkdir()
            (output / "growing-scan.jsonl").write_bytes(b"mutable")
            entries = list(inventory.scan_root(root, exclude_roots=[output]))
            self.assertEqual(["safe.bin"], [entry.relative_path for entry in entries])


if __name__ == "__main__":
    unittest.main()
