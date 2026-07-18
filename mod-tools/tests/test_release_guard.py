# -*- coding: utf-8 -*-
"""重锚防孤儿门禁(wf_release_guard)回归:2026-07-18 链重锚事故不再复现。"""
from __future__ import annotations

import importlib
import hashlib
import io
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def _zip(member: str, raw: bytes) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(member, raw)
    return output.getvalue()


class AtomicPublisherFixture:
    def __init__(self, module, root: Path):
        self.module = module
        self.root = root
        self.cdn = root / "cdn" / "cn"
        live = root / "live" / "file.bin"
        staged = root / "staged" / "file.bin"
        live.parent.mkdir(parents=True)
        staged.parent.mkdir(parents=True)
        before = b"before"
        after = b"after"
        live.write_bytes(before)
        staged.write_bytes(after)
        release_file = module.ReleaseFile(
            root="common",
            logical_path="file.bin",
            live_path=live,
            staged_path=staged,
            before_raw=before,
            after_sha256=hashlib.sha256(after).hexdigest(),
            after_size=len(after),
        )
        prefixes = {
            "common": "production/upload/aa/common",
            "medium": "production/medium_upload/bb/medium",
            "android": "production/android_upload/cc/android",
        }
        archives = []
        for root_name, member in prefixes.items():
            raw = _zip(member, root_name.encode())
            path = root / "provisional" / f"{root_name}.zip"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
            archives.append(module.ProvisionalArchive(
                root=root_name,
                path=path,
                sha256=hashlib.sha256(raw).hexdigest(),
                size=len(raw),
                members=(member,),
            ))
        store = module.ActiveReleaseStore(
            self.cdn, canonical_base_version="1.4.54"
        )
        self.payload = module.ReleasePayload(
            package_id="fixture",
            package_manifest_sha256="a" * 64,
            expected_base=store.read_validated_base(),
            files=(release_file,),
            provisional_archives=tuple(archives),
        )

    def publisher(self):
        return self.module.AtomicReleasePublisher(
            self.cdn,
            canonical_base_version="1.4.54",
            release_id_factory=lambda: "20260718t000000z-guard",
        )

    def seed_stranded_history(self, guard) -> None:
        common = self.cdn / guard.wf_release.ROOT_DIRS["common"]
        common.mkdir(parents=True, exist_ok=True)
        (common / "pinball-1.4.0-1.4.54-1-full.zip").write_bytes(b"full")
        for root_dir in guard.wf_release.ROOT_DIRS.values():
            directory = self.cdn / root_dir
            directory.mkdir(parents=True, exist_ok=True)
            (directory / (
                "pinball-1.4.54-1.4.55-1-charpkg-fixture-old.zip"
            )).write_bytes(root_dir.encode())

    def bridge_guard(self, guard, repo: Path):
        def prepare():
            report = guard.ensure_charpkg_history_bridged(
                self.cdn, repo, assume_lock_held=True
            )
            receipts = tuple(report["bridge_receipts"])
            return lambda: guard.rollback_charpkg_bridges(
                receipts, self.cdn, assume_lock_held=True
            )

        return prepare


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

    def test_postcopy_reachability_failure_removes_new_bridges_and_temps(self):
        module = self._module()
        with tempfile.TemporaryDirectory() as td:
            f = self._fixture(module, td)
            f.write_archive("archive-common-diff", "1.4.0", "1.4.133", "full")
            f.write_charpkg("1.4.140", "1.4.141")

            with self.assertRaises(module.wf_release.ReleaseError):
                module.ensure_charpkg_history_bridged(f.cdn, f.repo)

            self.assertEqual([], list(f.cdn.rglob("*-charbridge-*")))
            self.assertEqual([], [
                path for path in f.cdn.rglob("*") if path.name.endswith(".tmp")
            ])

    def test_partial_fallback_failure_removes_prior_bridge_and_partial_temp(self):
        module = self._module()
        with tempfile.TemporaryDirectory() as td:
            f = self._fixture(module, td)
            f.write_archive("archive-common-diff", "1.4.0", "1.4.133", "full")
            f.write_charpkg("1.4.133", "1.4.134")
            real_link = module.os.link
            calls = 0

            def fail_second_link(source, target):
                nonlocal calls
                calls += 1
                if calls == 2:
                    raise OSError("force fallback")
                return real_link(source, target)

            def partial_copy(_source, target):
                Path(target).write_bytes(b"partial")
                raise OSError("copy interrupted")

            with (
                mock.patch.object(module.os, "link", side_effect=fail_second_link),
                mock.patch.object(module.shutil, "copy2", side_effect=partial_copy),
            ):
                with self.assertRaisesRegex(OSError, "copy interrupted"):
                    module.ensure_charpkg_history_bridged(f.cdn, f.repo)

            self.assertEqual([], list(f.cdn.rglob("*-charbridge-*")))
            self.assertEqual([], [
                path for path in f.cdn.rglob("*") if path.name.endswith(".tmp")
            ])

    def test_receipt_failure_removes_the_just_created_untracked_bridge(self):
        module = self._module()
        with tempfile.TemporaryDirectory() as td:
            f = self._fixture(module, td)
            f.write_archive("archive-common-diff", "1.4.0", "1.4.133", "full")
            f.write_charpkg("1.4.133", "1.4.134")
            real_receipt = module._bridge_receipt
            calls = 0

            def fail_second_receipt(path):
                nonlocal calls
                calls += 1
                if calls == 2:
                    raise OSError("receipt interrupted")
                return real_receipt(path)

            with mock.patch.object(
                module, "_bridge_receipt", side_effect=fail_second_receipt
            ):
                with self.assertRaisesRegex(OSError, "receipt interrupted"):
                    module.ensure_charpkg_history_bridged(f.cdn, f.repo)

            self.assertEqual([], list(f.cdn.rglob("*-charbridge-*")))

    def test_initial_created_target_stat_failure_leaves_no_bridge_or_temp(self):
        module = self._module()
        with tempfile.TemporaryDirectory() as td:
            f = self._fixture(module, td)
            f.write_archive("archive-common-diff", "1.4.0", "1.4.133", "full")
            f.write_charpkg("1.4.133", "1.4.134")
            real_stat = Path.stat
            injected = False

            def fail_first_created_bridge_stat(path, *args, **kwargs):
                nonlocal injected
                stat = real_stat(path, *args, **kwargs)
                if not injected and module.CHARBRIDGE_MARK in path.name:
                    injected = True
                    raise PermissionError("created bridge stat denied")
                return stat

            with mock.patch.object(
                Path, "stat", side_effect=fail_first_created_bridge_stat,
                autospec=True,
            ):
                with self.assertRaisesRegex(
                    PermissionError, "created bridge stat denied"
                ):
                    module.ensure_charpkg_history_bridged(f.cdn, f.repo)

            self.assertTrue(injected)
            self.assertEqual([], list(f.cdn.rglob("*-charbridge-*")))
            self.assertEqual([], [
                path for path in f.cdn.rglob("*") if path.name.endswith(".tmp")
            ])

    def test_fallback_does_not_clobber_foreign_target_created_during_copy(self):
        module = self._module()
        with tempfile.TemporaryDirectory() as td:
            f = self._fixture(module, td)
            f.write_archive("archive-common-diff", "1.4.0", "1.4.133", "full")
            f.write_charpkg("1.4.133", "1.4.134")
            original_copy2 = module.shutil.copy2
            inserted: list[Path] = []

            def inject_foreign_target(source, temp_target):
                target = Path(source).with_name(
                    Path(source).name.replace(
                        module.CHARPKG_MARK, module.CHARBRIDGE_MARK, 1
                    )
                )
                target.write_bytes(b"foreign-writer")
                inserted.append(target)
                return original_copy2(source, temp_target)

            with (
                mock.patch.object(
                    module.os, "link", side_effect=OSError("force fallback")
                ),
                mock.patch.object(
                    module.shutil, "copy2", side_effect=inject_foreign_target
                ),
            ):
                report = module.ensure_charpkg_history_bridged(f.cdn, f.repo)

            self.assertEqual([], report["bridged_archives"])
            self.assertEqual(3, len(inserted))
            self.assertTrue(all(
                path.read_bytes() == b"foreign-writer" for path in inserted
            ))
            self.assertEqual([], [
                path for path in f.cdn.rglob("*") if path.name.endswith(".tmp")
            ])

    def test_rollback_receipt_preserves_a_replaced_bridge(self):
        module = self._module()
        with tempfile.TemporaryDirectory() as td:
            f = self._fixture(module, td)
            f.write_archive("archive-common-diff", "1.4.0", "1.4.133", "full")
            f.write_charpkg("1.4.133", "1.4.134")
            report = module.ensure_charpkg_history_bridged(f.cdn, f.repo)
            replaced = Path(report["bridged_archives"][0])
            replaced.write_bytes(b"foreign-replacement")

            module.rollback_charpkg_bridges(
                report["bridge_receipts"], f.cdn
            )

            self.assertTrue(replaced.is_file())
            self.assertEqual(b"foreign-replacement", replaced.read_bytes())
            self.assertEqual(
                [replaced], list(f.cdn.rglob("*-charbridge-*.zip"))
            )

    def test_standalone_gate_uses_the_shared_release_lock(self):
        module = self._module()
        with tempfile.TemporaryDirectory() as td:
            f = self._fixture(module, td)
            f.write_archive("archive-common-diff", "1.4.0", "1.4.133", "full")
            f.write_charpkg("1.4.133", "1.4.134")
            lock_path = f.cdn / ".character-release.lock"

            with module.wf_release._release_lock(lock_path):
                with self.assertRaisesRegex(
                    module.wf_release.ReleaseError, "CHARACTER_RELEASE_LOCKED"
                ):
                    module.ensure_charpkg_history_bridged(f.cdn, f.repo)
                report = module.ensure_charpkg_history_bridged(
                    f.cdn, f.repo, assume_lock_held=True
                )
                with self.assertRaisesRegex(
                    module.wf_release.ReleaseError, "CHARACTER_RELEASE_LOCKED"
                ):
                    module.rollback_charpkg_bridges(
                        report["bridge_receipts"], f.cdn
                    )
                module.rollback_charpkg_bridges(
                    report["bridge_receipts"], f.cdn, assume_lock_held=True
                )

            self.assertEqual(3, len(report["bridged_archives"]))
            self.assertEqual([], list(f.cdn.rglob("*-charbridge-*")))

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

    def test_prepare_failure_happens_before_the_strand_gate(self):
        release = self._release()
        guard = importlib.import_module("wf_release_guard")
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            live_roots = release.character_pack.LiveRoots(
                root / "common", root / "medium", root / "android", root / "server"
            )
            with (
                mock.patch.object(
                    release.character_pack, "load_manifest",
                    return_value={"requires_client_base": "1.4.136"},
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
                    side_effect=release.ReleaseError("SHOULD_NOT_RUN"),
                ) as gate,
                mock.patch.object(release, "_production_workspace_status"),
                mock.patch.object(
                    release, "_reachable_client_base", return_value="1.4.136"
                ),
                mock.patch.object(
                    release, "_prepare_production_release",
                    side_effect=release.ReleaseError("PREPARE_TEST"),
                ) as prepare,
            ):
                with self.assertRaises(release.ReleaseError) as raised:
                    release.publish_package(
                        root / "package", "cn", "PUBLISH_CHARACTER_PACKAGE"
                    )
            self.assertEqual("PREPARE_TEST", str(raised.exception))
            prepare.assert_called_once()
            gate.assert_not_called()

    def test_publisher_failure_removes_only_this_invocations_bridges(self):
        release = self._release()
        guard = importlib.import_module("wf_release_guard")
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            fixture = AtomicPublisherFixture(release, root)
            fixture.seed_stranded_history(guard)
            preexisting = (
                fixture.cdn / release.ROOT_DIRS["common"]
                / "pinball-1.4.10-1.4.11-1-charbridge-preexisting.zip"
            )
            preexisting.write_bytes(b"keep")

            with self.assertRaisesRegex(release.ReleaseError, "injected"):
                fixture.publisher().publish(
                    fixture.payload,
                    server_running=lambda: False,
                    fail_after="after_journal_fsync",
                    prepare_live_guard=fixture.bridge_guard(guard, root / "repo"),
                )

            self.assertTrue(preexisting.is_file())
            self.assertEqual(
                [preexisting], list(fixture.cdn.rglob("*-charbridge-*.zip"))
            )

    def test_successful_publish_retains_new_bridges(self):
        release = self._release()
        guard = importlib.import_module("wf_release_guard")
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            fixture = AtomicPublisherFixture(release, root)
            fixture.seed_stranded_history(guard)

            result = fixture.publisher().publish(
                fixture.payload,
                server_running=lambda: False,
                prepare_live_guard=fixture.bridge_guard(guard, root / "repo"),
            )

            self.assertTrue(result.committed)
            self.assertEqual(3, len(list(fixture.cdn.rglob("*-charbridge-*.zip"))))

    def test_committed_failure_plus_cleanup_failure_stays_committed(self):
        release = self._release()
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            live_roots = release.character_pack.LiveRoots(
                root / "common", root / "medium", root / "android", root / "server"
            )
            prepared = SimpleNamespace(
                payload=object(),
                snapshot=SimpleNamespace(snapshot_dir=root / "snapshot"),
            )
            publisher = mock.Mock()
            publisher.publish.side_effect = release.CommittedReleaseError(
                "COMMITTED_TEST"
            )
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
                mock.patch.object(release, "_server_running", return_value=False),
                mock.patch.object(
                    release, "detect_canonical_base_version", return_value="1.4.54"
                ),
                mock.patch.object(
                    release, "prepare_runtime_release", return_value=prepared
                ),
                mock.patch.object(
                    release, "AtomicReleasePublisher", return_value=publisher
                ),
                mock.patch.object(
                    release, "close_prepared_runtime_release",
                    side_effect=release.ReleaseError("CLEANUP_TEST"),
                ),
            ):
                with self.assertRaises(release.CommittedReleaseError) as raised:
                    release.publish_package(root / "package", "cn", "DIRECT_REAL_TEST")

            self.assertIn("COMMITTED_TEST", str(raised.exception))
            self.assertIn("CLEANUP_TEST", str(raised.exception))

    def test_successful_commit_plus_cleanup_failure_is_recovery_only(self):
        release = self._release()
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            live_roots = release.character_pack.LiveRoots(
                root / "common", root / "medium", root / "android", root / "server"
            )
            prepared = SimpleNamespace(
                payload=object(),
                snapshot=SimpleNamespace(snapshot_dir=root / "snapshot"),
            )
            result = release.ReleaseResult(
                committed=True,
                release_id="release-test",
                from_version="1.4.54",
                version="1.4.55",
                active_manifest_sha256="a" * 64,
                archive_paths=(),
            )
            publisher = mock.Mock()
            publisher.publish.return_value = result
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
                mock.patch.object(release, "_server_running", return_value=False),
                mock.patch.object(
                    release, "detect_canonical_base_version", return_value="1.4.54"
                ),
                mock.patch.object(
                    release, "prepare_runtime_release", return_value=prepared
                ),
                mock.patch.object(
                    release, "AtomicReleasePublisher", return_value=publisher
                ),
                mock.patch.object(
                    release, "close_prepared_runtime_release",
                    side_effect=release.ReleaseError("CLEANUP_TEST"),
                ),
            ):
                with self.assertRaises(release.CommittedReleaseError) as raised:
                    release.publish_package(root / "package", "cn", "DIRECT_REAL_TEST")

            self.assertIn("release committed", str(raised.exception))
            self.assertIn("CLEANUP_TEST", str(raised.exception))

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
