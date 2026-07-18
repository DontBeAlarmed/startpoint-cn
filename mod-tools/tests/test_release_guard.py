# -*- coding: utf-8 -*-
"""重锚防孤儿门禁(wf_release_guard)回归:2026-07-18 链重锚事故不再复现。"""
from __future__ import annotations

import importlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


class StrandGateFixture:
    def __init__(self, module, root: Path):
        self.module = module
        self.root = root
        self.cdn = root / "cdn" / "cn"
        self.repo = root / "repo"
        for directory in module.wf_release.ROOT_DIRS.values():
            (self.cdn / directory).mkdir(parents=True, exist_ok=True)
        (self.repo / "assets" / "asset-patch" / "active").mkdir(parents=True, exist_ok=True)

    def write_archive(self, root_dir: str, from_version: str, to_version: str, label: str) -> Path:
        name = f"pinball-{from_version}-{to_version}-1-{label}.zip"
        path = self.cdn / root_dir / name
        path.write_bytes(f"{root_dir}:{name}".encode())
        return path

    def write_charpkg(self, from_version: str, to_version: str, tag: str = "old") -> list[Path]:
        return [
            self.write_archive(
                root_dir, from_version, to_version,
                f"charpkg-fixture-{tag}-{root_dir.split('-')[1]}",
            )
            for root_dir in self.module.wf_release.ROOT_DIRS.values()
        ]

    def write_active(self, base_version: str, releases: list[dict] | None = None) -> None:
        path = self.cdn / "character-releases" / "active.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({
            "schema_version": 1,
            "base_version": base_version,
            "releases": releases or [],
        }), encoding="utf-8")


class TestCharpkgStrandGate(unittest.TestCase):
    def _module(self):
        return importlib.import_module("wf_release_guard")

    def _fixture(self, module, td: str) -> StrandGateFixture:
        return StrandGateFixture(module, Path(td))

    def test_reanchored_orphans_are_bridged_and_reach_the_new_tail(self):
        module = self._module()
        with tempfile.TemporaryDirectory() as td:
            f = self._fixture(module, td)
            f.write_archive("archive-common-diff", "1.4.0", "1.4.133", "full")
            f.write_charpkg("1.4.133", "1.4.134")
            f.write_charpkg("1.4.134", "1.4.135")
            f.write_archive("archive-common-diff", "1.4.135", "1.4.136", "late")
            f.write_active("1.4.136")

            report = module.ensure_charpkg_history_bridged(f.cdn, f.repo)

            self.assertEqual("1.4.136", report["tail"])
            self.assertEqual([], report["stranded_archives"])
            self.assertEqual(
                ["1.4.133->1.4.134", "1.4.134->1.4.135"], report["orphan_edges"]
            )
            self.assertEqual(6, len(report["bridged_archives"]))
            for raw in report["bridged_archives"]:
                bridge = Path(raw)
                self.assertIn("-charbridge-", bridge.name)
                original = bridge.with_name(
                    bridge.name.replace("-charbridge-", "-charpkg-", 1)
                )
                self.assertEqual(original.read_bytes(), bridge.read_bytes())

            again = module.ensure_charpkg_history_bridged(f.cdn, f.repo)
            self.assertEqual([], again["bridged_archives"])
            self.assertEqual([], again["stranded_archives"])

    def test_gate_raises_when_history_cannot_reach_tail_even_with_bridges(self):
        module = self._module()
        with tempfile.TemporaryDirectory() as td:
            f = self._fixture(module, td)
            f.write_archive("archive-common-diff", "1.4.0", "1.4.133", "full")
            f.write_charpkg("1.4.140", "1.4.141")

            with self.assertRaises(module.wf_release.ReleaseError) as raised:
                module.ensure_charpkg_history_bridged(f.cdn, f.repo)
            self.assertIn("1.4.140->1.4.141", str(raised.exception))

    def test_partially_bridged_edge_fills_the_missing_roots_only(self):
        module = self._module()
        with tempfile.TemporaryDirectory() as td:
            f = self._fixture(module, td)
            f.write_archive("archive-common-diff", "1.4.0", "1.4.133", "full")
            f.write_charpkg("1.4.133", "1.4.134")
            f.write_archive(
                "archive-common-diff", "1.4.133", "1.4.134",
                "charbridge-fixture-old-common",
            )

            report = module.ensure_charpkg_history_bridged(f.cdn, f.repo)

            self.assertEqual([], report["stranded_archives"])
            bridged_dirs = sorted(Path(raw).parent.name for raw in report["bridged_archives"])
            self.assertEqual(
                ["archive-android-diff", "archive-medium-diff"], bridged_dirs
            )

    def test_covered_history_needs_no_bridges(self):
        module = self._module()
        with tempfile.TemporaryDirectory() as td:
            f = self._fixture(module, td)
            f.write_archive("archive-common-diff", "1.4.0", "1.4.133", "full")
            f.write_charpkg("1.4.133", "1.4.134")
            for root_dir in module.wf_release.ROOT_DIRS.values():
                f.write_archive(root_dir, "1.4.133", "1.4.134", "recut")

            report = module.ensure_charpkg_history_bridged(f.cdn, f.repo)

            self.assertEqual([], report["bridged_archives"])
            self.assertEqual([], report["stranded_archives"])
            for root_dir in module.wf_release.ROOT_DIRS.values():
                bridges = list((f.cdn / root_dir).glob("*-charbridge-*"))
                self.assertEqual([], bridges)

    def test_chain_edges_in_active_json_are_not_orphans(self):
        module = self._module()
        with tempfile.TemporaryDirectory() as td:
            f = self._fixture(module, td)
            f.write_archive("archive-common-diff", "1.4.0", "1.4.133", "full")
            f.write_charpkg("1.4.133", "1.4.134", tag="live")
            f.write_active("1.4.133", releases=[{
                "release_id": "live-1",
                "package_id": "fixture",
                "from_version": "1.4.133",
                "version": "1.4.134",
                "package_manifest_sha256": "a" * 64,
                "archives": [],
            }])

            report = module.ensure_charpkg_history_bridged(f.cdn, f.repo)

            self.assertEqual([], report["orphan_edges"])
            self.assertEqual([], report["bridged_archives"])
            self.assertEqual("1.4.134", report["tail"])


class TestReleaseWiring(unittest.TestCase):
    def _release(self):
        return importlib.import_module("wf_release")

    def test_publish_package_runs_the_strand_gate_before_preparing(self):
        release = self._release()
        guard = importlib.import_module("wf_release_guard")
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            live_roots = release.character_pack.LiveRoots(
                root / "common", root / "medium", root / "android", root / "server"
            )
            with (
                mock.patch.object(
                    release.character_pack, "load_manifest", return_value={}
                ),
                mock.patch.object(
                    release, "_validate_qa_contract", return_value="production"
                ),
                mock.patch.object(
                    release, "_repo_paths",
                    return_value=(root, live_roots, root / "cdn"),
                ),
                mock.patch.object(release, "_server_running", return_value=False),
                mock.patch.object(
                    release, "detect_canonical_base_version", return_value="1.4.136"
                ),
                mock.patch.object(
                    guard, "ensure_charpkg_history_bridged",
                    side_effect=release.ReleaseError("STRANDED_TEST"),
                ) as gate,
                mock.patch.object(release, "_production_workspace_status") as status,
                mock.patch.object(release, "_prepare_production_release") as prepare,
            ):
                with self.assertRaises(release.ReleaseError) as raised:
                    release.publish_package(
                        root / "package", "cn", "PUBLISH_CHARACTER_PACKAGE"
                    )
            self.assertEqual("STRANDED_TEST", str(raised.exception))
            gate.assert_called_once_with(root / "cdn", root)
            status.assert_not_called()
            prepare.assert_not_called()

    def test_preflight_report_carries_the_strand_report(self):
        release = self._release()
        guard = importlib.import_module("wf_release_guard")
        strand = {"tail": "1.4.136", "stranded_edges": ["1.4.133->1.4.134"]}
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            live_roots = release.character_pack.LiveRoots(
                root / "common", root / "medium", root / "android", root / "server"
            )
            preflight_result = mock.Mock()
            preflight_result.canonical_bytes.return_value = b'{"can_prepare": true}'
            transaction = mock.Mock()
            transaction.preflight.return_value = preflight_result
            base = mock.Mock()
            base.validated_chain_tail = "1.4.136"
            store = mock.Mock()
            store.read_validated_base.return_value = base
            with (
                mock.patch.object(
                    release.character_pack, "load_manifest", return_value={}
                ),
                mock.patch.object(
                    release, "_validate_qa_contract", return_value="runtime_test"
                ),
                mock.patch.object(
                    release, "_repo_paths",
                    return_value=(root, live_roots, root / "cdn"),
                ),
                mock.patch.object(
                    release, "detect_canonical_base_version", return_value="1.4.136"
                ),
                mock.patch.object(
                    guard, "charpkg_strand_report", return_value=strand
                ) as gate,
                mock.patch.object(release, "ActiveReleaseStore", return_value=store),
                mock.patch.object(
                    release, "_new_transaction", return_value=({}, transaction)
                ),
            ):
                report = release.preflight_package(root / "package", "cn")
            self.assertEqual(strand, report["charpkg_strand"])
            gate.assert_called_once_with(root / "cdn", root)


if __name__ == "__main__":
    unittest.main()
