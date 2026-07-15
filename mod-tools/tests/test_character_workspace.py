# -*- coding: utf-8 -*-
"""Resumable character workspace tests (temporary directories only)."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import wf_character_workspace as workspace_module  # noqa: E402


class TestCharacterWorkspace(unittest.TestCase):
    def test_init_writes_only_inside_workspace_and_status_is_resumable(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            live_root = base / "live"
            live_root.mkdir()

            workspace = workspace_module.init_workspace(
                base / "character_packs", 111165, 129999,
                "seris_dragon_king", "seris_dragon_king",
            )

            self.assertEqual([], list(live_root.rglob("*")))
            self.assertTrue((workspace.root / "workspace.json").is_file())
            for root_name in ("common", "medium", "android", "server"):
                self.assertTrue((workspace.package_dir / "roots" / root_name).is_dir())

            first = workspace_module.workspace_status(workspace)
            logical = "character/seris_dragon_king/ui/full_shot_1440_1920_0.png"
            package_file = workspace.package_dir / "roots" / "medium" / Path(logical)
            package_file.parent.mkdir(parents=True)
            package_file.write_bytes(b"asset")
            second = workspace_module.workspace_status(workspace)

            self.assertNotEqual(first.input_digest, second.input_digest)
            self.assertIn(logical, second.completed_paths)
            self.assertEqual(37, second.requirement_report["required_total"])
            self.assertFalse(second.release_ready)
            self.assertEqual([], list(live_root.rglob("*")))

    def test_status_reuses_hash_for_unchanged_size_and_mtime(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = workspace_module.init_workspace(
                Path(tmp), 111165, 129999, "seris_dragon_king", "seris",
            )
            package_file = workspace.package_dir / "roots" / "common" / "master" / "table.bin"
            package_file.parent.mkdir(parents=True)
            package_file.write_bytes(b"same")

            first = workspace_module.workspace_status(workspace)
            second = workspace_module.workspace_status(workspace)

            self.assertEqual(first.file_count, second.file_count)
            self.assertEqual(second.file_count, second.hash_cache_hits)
            self.assertEqual(first.input_digest, second.input_digest)

    def test_status_contains_no_secret_or_absolute_live_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = workspace_module.init_workspace(
                Path(tmp), 111165, 129999, "seris_dragon_king", "seris",
            )
            status = workspace_module.workspace_status(workspace)
            payload = json.dumps(status.to_dict(), ensure_ascii=False)

            self.assertNotIn(str(Path(tmp).resolve()), payload)
            self.assertNotIn("api_key", payload.lower())
            self.assertEqual("seris", status.workspace)
            self.assertTrue((workspace.root / "evidence" / "status.json").is_file())

    def test_init_rejects_invalid_identity_nonempty_destination_and_reparse(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            with self.assertRaisesRegex(workspace_module.WorkspaceError, "code_name"):
                workspace_module.init_workspace(base, 111165, 129999, "Bad-Code", "seris")
            with self.assertRaisesRegex(workspace_module.WorkspaceError, "character ID"):
                workspace_module.init_workspace(base, 0, 129999, "seris", "seris")
            with self.assertRaisesRegex(workspace_module.WorkspaceError, "package_id"):
                workspace_module.init_workspace(base, 111165, 129999, "seris", "../escape")

            destination = base / "occupied"
            destination.mkdir()
            (destination / "keep.txt").write_text("user", encoding="utf-8")
            with self.assertRaisesRegex(workspace_module.WorkspaceError, "non-empty"):
                workspace_module.init_workspace(base, 111165, 129999, "seris", "occupied")

            with patch.object(workspace_module, "_path_has_reparse_component", return_value=True):
                with self.assertRaisesRegex(workspace_module.WorkspaceError, "reparse"):
                    workspace_module.init_workspace(base, 111165, 129999, "seris", "reparse")

    def test_workspace_loader_rejects_identity_tampering(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = workspace_module.init_workspace(
                Path(tmp), 111165, 129999, "seris_dragon_king", "seris",
            )
            config_path = workspace.root / "workspace.json"
            payload = json.loads(config_path.read_text(encoding="utf-8"))
            payload["package_dir"] = "../escape"
            config_path.write_text(json.dumps(payload), encoding="utf-8")

            with self.assertRaisesRegex(workspace_module.WorkspaceError, "package_dir"):
                workspace_module.load_workspace(workspace.root)

    def test_status_rejects_reparse_directories_before_traversal(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = workspace_module.init_workspace(
                Path(tmp), 111165, 129999, "seris_dragon_king", "seris",
            )
            suspicious = workspace.package_dir / "roots" / "medium" / "linkdir"
            suspicious.mkdir()

            original = workspace_module._is_reparse

            def mark_directory(path: Path) -> bool:
                return path == suspicious or original(path)

            with patch.object(workspace_module, "_is_reparse", side_effect=mark_directory):
                with self.assertRaisesRegex(workspace_module.WorkspaceError, "reparse"):
                    workspace_module.workspace_status(workspace)


if __name__ == "__main__":
    unittest.main()
