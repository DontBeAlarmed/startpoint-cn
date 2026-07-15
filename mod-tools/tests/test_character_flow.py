# -*- coding: utf-8 -*-
"""Unified character-flow CLI tests (temporary roots and injected release API)."""
from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import wf_character_flow as flow  # noqa: E402
import wf_character_workspace as workspace_module  # noqa: E402
import wf_release  # noqa: E402


def tree_digest(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*"), key=lambda item: item.as_posix()):
        digest.update(path.relative_to(root).as_posix().encode())
        if path.is_file():
            digest.update(path.read_bytes())
    return digest.hexdigest()


class FakeReleaseModule:
    def __init__(self):
        self.preflight_calls = []
        self.publish_calls = []

    def preflight_package(self, package_dir, profile_id, installed_package_dir=None):
        self.preflight_calls.append((Path(package_dir), profile_id, installed_package_dir))
        return {"can_prepare": False, "conflicts": [{"kind": "fixture"}]}

    def publish_package(self, package_dir, profile_id, confirmation, installed_package_dir=None):
        self.publish_calls.append((Path(package_dir), profile_id, confirmation, installed_package_dir))
        return SimpleNamespace(
            committed=True,
            release_id="release-1",
            from_version="1.4.139",
            version="1.4.140",
            active_manifest_sha256="a" * 64,
            archive_paths=(Path("common.zip"),),
            snapshot_dir=Path("snapshot-1"),
        )


class TestCharacterFlow(unittest.TestCase):
    def test_rollback_requires_distinct_confirmation_before_release_call(self):
        code, result = flow.run_command([
            "rollback", "--snapshot-dir", "missing", "--confirm", "yes",
        ])

        self.assertEqual(2, code)
        self.assertIn("ROLLBACK_CHARACTER_PACKAGE", " ".join(result["errors"]))

    def test_rollback_delegates_to_snapshot_release_api(self):
        released = SimpleNamespace(
            committed=True,
            release_id="rollback-1",
            from_version="1.4.140",
            version="1.4.141",
            active_manifest_sha256="b" * 64,
            archive_paths=(Path("rollback-common.zip"),),
            snapshot_dir=None,
        )
        with patch(
            "wf_character_rollback.publish_snapshot_rollback",
            return_value=released,
        ) as delegated:
            code, result = flow.run_command([
                "rollback",
                "--snapshot-dir", "snapshot-1",
                "--profile", "cn",
                "--installed-package-dir", "installed",
                "--confirm", "ROLLBACK_CHARACTER_PACKAGE",
            ])

        self.assertEqual(0, code)
        self.assertEqual("1.4.141", result["version"])
        delegated.assert_called_once_with(
            Path("snapshot-1"),
            profile_id="cn",
            confirmation="ROLLBACK_CHARACTER_PACKAGE",
            installed_package_dir=Path("installed"),
        )

    def test_init_and_status_write_only_inside_workspace(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            live = base / "live"
            live.mkdir()
            before = tree_digest(live)

            code, initialized = flow.run_command([
                "init", "--root", str(base / "packs"),
                "--template-id", "111165", "--character-id", "129999",
                "--code-name", "seris_dragon_king", "--package-id", "seris",
            ])
            status_code, status = flow.run_command([
                "status", "--workspace", initialized["workspace"],
            ])

            self.assertEqual(0, code)
            self.assertEqual(0, status_code)
            self.assertTrue(initialized["ok"])
            self.assertEqual("status", status["stage"])
            self.assertFalse(status["release_ready"])
            self.assertEqual(before, tree_digest(live))

    def test_preflight_never_writes_live_roots_or_cdn(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            workspace = workspace_module.init_workspace(
                base / "packs", 111165, 129999, "seris_dragon_king", "seris",
            )
            live = base / "live"
            cdn = base / "cdn"
            live.mkdir()
            cdn.mkdir()
            (live / "keep.bin").write_bytes(b"live")
            before_live = tree_digest(live)
            before_cdn = tree_digest(cdn)
            fake = FakeReleaseModule()

            code, result = flow.run_command([
                "preflight", "--workspace", str(workspace.root),
            ], release_module=fake)

            self.assertEqual(3, code)
            self.assertFalse(result["release_ready"])
            self.assertEqual(1, len(fake.preflight_calls))
            self.assertEqual(before_live, tree_digest(live))
            self.assertEqual(before_cdn, tree_digest(cdn))

    def test_publish_requires_exact_confirmation_before_release_call(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = workspace_module.init_workspace(
                Path(tmp), 111165, 129999, "seris_dragon_king", "seris",
            )
            fake = FakeReleaseModule()

            code, result = flow.run_command([
                "publish", "--workspace", str(workspace.root), "--confirm", "yes",
            ], release_module=fake)

            self.assertEqual(2, code)
            self.assertIn("PUBLISH_CHARACTER_PACKAGE", " ".join(result["errors"]))
            self.assertEqual([], fake.publish_calls)

    def test_runtime_test_preserves_direct_real_test_contract(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = workspace_module.init_workspace(
                Path(tmp), 111165, 129999, "seris_dragon_king", "seris",
            )
            manifest_path = workspace.package_dir / "manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["qa"] = {
                "delivery_mode": "runtime_test",
                "release_ready": False,
                "user_authorized_direct_real_test": True,
            }
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            fake = FakeReleaseModule()

            code, result = flow.run_command([
                "publish", "--workspace", str(workspace.root),
                "--confirm", "DIRECT_REAL_TEST",
            ], release_module=fake)

            self.assertEqual(0, code)
            self.assertEqual("runtime_test", result["delivery_mode"])
            self.assertEqual("DIRECT_REAL_TEST", fake.publish_calls[0][2])

    def test_production_ready_status_delegates_publish(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = workspace_module.init_workspace(
                Path(tmp), 111165, 129999, "seris_dragon_king", "seris",
            )
            fake = FakeReleaseModule()
            ready = SimpleNamespace(
                release_ready=True,
                to_dict=lambda: {"release_ready": True, "manifest_errors": []},
            )
            with patch.object(flow.workspace_module, "workspace_status", return_value=ready):
                code, result = flow.run_command([
                    "publish", "--workspace", str(workspace.root),
                    "--confirm", "PUBLISH_CHARACTER_PACKAGE",
                ], release_module=fake)

            self.assertEqual(0, code)
            self.assertTrue(result["ok"])
            self.assertEqual("production", result["delivery_mode"])
            self.assertEqual("PUBLISH_CHARACTER_PACKAGE", fake.publish_calls[0][2])


class TestReleaseQaContract(unittest.TestCase):
    def test_public_rebase_api_delegates_without_live_writes(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            roots = SimpleNamespace(
                common=base / "common",
                medium=base / "medium",
                android=base / "android",
                server=base / "server",
            )
            expected = SimpleNamespace(output_dir=base / "out")
            with patch.object(
                wf_release, "_repo_paths", return_value=(base, roots, base / "cdn")
            ), patch.object(
                wf_release, "_current_git_head", return_value="a" * 40
            ), patch.object(
                wf_release, "rebase_runtime_package", return_value=expected
            ) as delegated:
                result = wf_release.rebase_package(
                    base / "package", "cn", output_dir=base / "out"
                )

            self.assertIs(expected, result)
            delegated.assert_called_once_with(
                base / "package",
                base / "out",
                live_roots=roots,
                generator_git_head="a" * 40,
            )

    def test_checked_in_schema_documents_both_release_gates(self):
        schema_path = Path(__file__).resolve().parent.parent / "schemas" / "character-pack-v1.schema.json"
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        qa = schema["properties"]["qa"]
        self.assertEqual({"delivery_mode", "release_ready"}, set(qa["required"]))
        self.assertEqual({"production", "runtime_test"}, set(
            qa["properties"]["delivery_mode"]["enum"]
        ))
        conditions = schema["allOf"]
        production = conditions[0]["then"]["properties"]["qa"]
        runtime_test = conditions[1]["then"]["properties"]["qa"]
        self.assertEqual(37, production["properties"]["required_assets_total"]["const"])
        self.assertEqual(37, production["properties"]["required_assets_present"]["const"])
        self.assertTrue(production["properties"]["release_ready"]["const"])
        self.assertFalse(runtime_test["properties"]["release_ready"]["const"])
        self.assertTrue(
            runtime_test["properties"]["user_authorized_direct_real_test"]["const"]
        )

    def test_production_contract_requires_37_assets_and_workspace_digest(self):
        manifest = {
            "qa": {
                "delivery_mode": "production",
                "release_ready": True,
                "required_assets_total": 37,
                "required_assets_present": 37,
                "workspace_input_sha256": "a" * 64,
            }
        }
        wf_release._validate_qa_contract(manifest, confirmation="PUBLISH_CHARACTER_PACKAGE")

        manifest["qa"]["required_assets_present"] = 36
        with self.assertRaisesRegex(wf_release.ReleaseError, "37/37"):
            wf_release._validate_qa_contract(manifest, confirmation="PUBLISH_CHARACTER_PACKAGE")

    def test_runtime_contract_keeps_legacy_authorization_and_confirmation(self):
        manifest = {"qa": {
            "delivery_mode": "runtime_test",
            "release_ready": False,
            "user_authorized_direct_real_test": True,
        }}
        wf_release._validate_qa_contract(manifest, confirmation="DIRECT_REAL_TEST")
        with self.assertRaisesRegex(wf_release.ReleaseError, "DIRECT_REAL_TEST"):
            wf_release._validate_qa_contract(manifest, confirmation="PUBLISH_CHARACTER_PACKAGE")


if __name__ == "__main__":
    unittest.main()
