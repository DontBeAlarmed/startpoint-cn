# -*- coding: utf-8 -*-
"""Snapshot-to-increment rollback tests; every mutation stays under temp roots."""
from __future__ import annotations

import base64
import hashlib
import importlib
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

import wf_character_pack as character_pack  # noqa: E402
import wf_mod_tool as core  # noqa: E402
import wf_release  # noqa: E402


def _zip(entries: list[tuple[str, bytes]]) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for member, raw in entries:
            info = zipfile.ZipInfo(member, (1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, raw)
    return output.getvalue()


class RollbackFixture:
    ROOTS = ("common", "medium", "android", "server")

    def __init__(self, module, root: Path):
        self.module = module
        self.root = root
        self.repo = root / "repo"
        self.cdn = root / "cdn"
        self.snapshot_root = self.repo / "work" / "character_releases" / "snapshots"
        self.staging_root = self.repo / "work" / "character_releases" / "rollback-staging"
        self.installed = root / "installed"
        self.live_paths: dict[str, Path] = {}
        self.original: dict[str, bytes] = {}
        self.modified: dict[str, bytes] = {}
        root_paths = {name: root / "live" / name for name in self.ROOTS}
        for path in root_paths.values():
            path.mkdir(parents=True)
        self.live_roots = character_pack.LiveRoots(
            common=root_paths["common"],
            medium=root_paths["medium"],
            android=root_paths["android"],
            server=root_paths["server"],
            protected=(self.cdn,),
        )
        logicals = {
            "common": "character/fixture/common.bin",
            "medium": "character/fixture/medium.bin",
            "android": "character/fixture/android.bin",
            "server": "fixture/server.json",
        }
        manifest = {
            "schema_version": 1,
            "package_id": "fixture",
            "character_id": 129999,
            "code_name": "fixture_character",
            "package_version": "1.0.0",
            "requires_client_base": "dual_form_v1",
            "required_capabilities": [],
            "roots": {name: [] for name in self.ROOTS},
            "tables": [],
            "skills": {},
            "unique_condition": {},
            "qa": {},
            "snapshot": {},
        }
        forward_files = []
        archive_entries: dict[str, list[tuple[str, bytes]]] = {
            name: [] for name in ("common", "medium", "android")
        }
        for index, root_name in enumerate(self.ROOTS):
            logical = logicals[root_name]
            root_path = Path(getattr(self.live_roots, root_name))
            live = (
                root_path / Path(*logical.split("/"))
                if root_name == "server"
                else core.table_path(root_path, logical)
            )
            live.parent.mkdir(parents=True, exist_ok=True)
            before = f"original-{root_name}".encode()
            after = f"modified-{root_name}".encode()
            live.write_bytes(before)
            staged = root / "forward-staging" / root_name / f"{index}.bin"
            staged.parent.mkdir(parents=True, exist_ok=True)
            staged.write_bytes(after)
            package_file = self.installed / "roots" / root_name / Path(*logical.split("/"))
            package_file.parent.mkdir(parents=True, exist_ok=True)
            package_file.write_bytes(after)
            manifest["roots"][root_name].append({
                "logical_path": logical,
                "sha256": hashlib.sha256(after).hexdigest(),
                "size": len(after),
            })
            forward_files.append(wf_release.ReleaseFile(
                root=root_name,
                logical_path=logical,
                live_path=live,
                staged_path=staged,
                before_raw=before,
                after_sha256=hashlib.sha256(after).hexdigest(),
                after_size=len(after),
            ))
            self.live_paths[root_name] = live
            self.original[root_name] = before
            self.modified[root_name] = after
            if root_name != "server":
                member = character_pack.ARCHIVE_PREFIXES[root_name] + live.relative_to(root_path).as_posix()
                archive_entries[root_name].append((member, after))

        manifest_raw = character_pack.canonical_manifest_bytes(manifest)
        (self.installed / "manifest.json").write_bytes(manifest_raw)
        self.manifest_sha256 = hashlib.sha256(manifest_raw).hexdigest()
        self.store = wf_release.ActiveReleaseStore(
            self.cdn, canonical_base_version="1.4.54"
        )
        self.base_before = self.store.read_validated_base()
        archives = []
        for root_name, entries in archive_entries.items():
            raw = _zip(entries)
            path = root / "forward-staging" / f"{root_name}.zip"
            path.write_bytes(raw)
            archives.append(wf_release.ProvisionalArchive(
                root=root_name,
                path=path,
                sha256=hashlib.sha256(raw).hexdigest(),
                size=len(raw),
                members=tuple(member for member, _raw in entries),
            ))
        payload = wf_release.ReleasePayload(
            package_id="fixture",
            package_manifest_sha256=self.manifest_sha256,
            expected_base=self.base_before,
            files=tuple(forward_files),
            provisional_archives=tuple(archives),
        )
        self.forward = wf_release.AtomicReleasePublisher(
            self.cdn,
            canonical_base_version="1.4.54",
            release_id_factory=lambda: "20260715t000000z-forward",
        ).publish(payload, server_running=lambda: False)
        self.snapshot_dir = self._write_snapshot(logicals)

    def _write_snapshot(self, logicals: dict[str, str]) -> Path:
        transaction_id = "1" * 32
        snapshot_dir = self.snapshot_root / f"character-pack-snapshot-{transaction_id}-{'2' * 32}"
        snapshot_dir.mkdir(parents=True)
        records = []
        for root_name in self.ROOTS:
            logical = logicals[root_name]
            raw = self.original[root_name]
            records.append({
                "root": root_name,
                "logical_path": logical,
                "live_path": str(self.live_paths[root_name]),
                "exists": True,
                "bytes": base64.b64encode(raw).decode("ascii"),
                "sha256": hashlib.sha256(raw).hexdigest(),
                "size": len(raw),
            })
            leaf = "file-{}-{}".format(
                root_name,
                hashlib.sha256(f"{root_name}\0{logical}".encode()).hexdigest(),
            )
            (snapshot_dir / leaf).write_bytes(raw)
        base = self.base_before
        snapshot = {
            "transaction_id": transaction_id,
            "release_base": {
                "active_raw_base64": (
                    base64.b64encode(base.active_raw).decode("ascii")
                    if base.active_raw is not None else None
                ),
                "active_sha256": base.active_sha256,
                "current_release_id": base.current_release_id,
                "validated_chain_tail": base.validated_chain_tail,
                "expected_from_version": base.expected_from_version,
                "active_package_manifest_sha256": base.active_package_manifest_sha256,
            },
            "table_before": [],
            "file_before": records,
        }
        snapshot_raw = wf_release._canonical(snapshot)
        (snapshot_dir / "snapshot.json").write_bytes(snapshot_raw)
        marker = {
            "kind": "character_pack_snapshot",
            "transaction_id": transaction_id,
            "snapshot_nonce": "2" * 32,
            "prepared_digest": "3" * 64,
            "snapshot_sha256": hashlib.sha256(snapshot_raw).hexdigest(),
        }
        (snapshot_dir / character_pack.SNAPSHOT_MARKER).write_bytes(
            wf_release._canonical(marker)
        )
        return snapshot_dir

    def rollback_publisher(self):
        return wf_release.AtomicReleasePublisher(
            self.cdn,
            canonical_base_version="1.4.54",
            release_id_factory=lambda: "20260715t000001z-rollback",
        )

    def rewrite_snapshot(self, mutate) -> None:
        snapshot_path = self.snapshot_dir / "snapshot.json"
        snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
        mutate(snapshot)
        snapshot_raw = wf_release._canonical(snapshot)
        snapshot_path.write_bytes(snapshot_raw)
        marker_path = self.snapshot_dir / character_pack.SNAPSHOT_MARKER
        marker = json.loads(marker_path.read_text(encoding="utf-8"))
        marker["snapshot_sha256"] = hashlib.sha256(snapshot_raw).hexdigest()
        marker_path.write_bytes(wf_release._canonical(marker))


class TestCharacterRollback(unittest.TestCase):
    def _module(self):
        return importlib.import_module("wf_character_rollback")

    def test_first_release_binding_preserves_zero_release_base_owner_anchor(self):
        module = self._module()
        with tempfile.TemporaryDirectory() as tmp:
            fixture = RollbackFixture(module, Path(tmp))
            active = json.loads(fixture.store.active_path.read_bytes())
            owners = [["seris", "a" * 64]]
            active["base_package_owners"] = owners
            fixture.store.active_path.write_bytes(wf_release._canonical(active))
            anchor_raw = wf_release._canonical({
                "schema_version": 1,
                "base_version": "1.4.54",
                "base_package_owners": owners,
                "releases": [],
            })
            snapshot = SimpleNamespace(release_base=character_pack.ReleaseBaseState(
                active_raw=anchor_raw,
                active_sha256=hashlib.sha256(anchor_raw).hexdigest(),
                current_release_id=None,
                validated_chain_tail="1.4.54",
                expected_from_version="1.4.54",
                active_package_manifest_sha256=None,
                package_owners=(("seris", "a" * 64),),
            ))

            bound = module._bind_to_current_release(snapshot, fixture.store)

            self.assertEqual("fixture", bound["package_id"])

    def test_snapshot_rollback_publishes_before_bytes_as_new_release(self):
        module = self._module()
        with tempfile.TemporaryDirectory() as tmp:
            fixture = RollbackFixture(module, Path(tmp))
            payload = module.prepare_snapshot_rollback(
                fixture.snapshot_dir,
                fixture.live_roots,
                fixture.store,
                fixture.staging_root,
            )
            result = fixture.rollback_publisher().publish(
                payload, server_running=lambda: False
            )

            self.assertEqual("1.4.56", result.version)
            self.assertEqual("fixture-rollback", payload.package_id)
            for root_name, path in fixture.live_paths.items():
                self.assertEqual(fixture.original[root_name], path.read_bytes())
            self.assertTrue(all("rollback" in path.name for path in result.archive_paths))
            active = json.loads(fixture.store.active_path.read_text(encoding="utf-8"))
            self.assertEqual(2, len(active["releases"]))

    def test_rollback_failure_restores_current_live_state(self):
        module = self._module()
        with tempfile.TemporaryDirectory() as tmp:
            fixture = RollbackFixture(module, Path(tmp))
            payload = module.prepare_snapshot_rollback(
                fixture.snapshot_dir,
                fixture.live_roots,
                fixture.store,
                fixture.staging_root,
            )
            active_before = fixture.store.active_path.read_bytes()

            with self.assertRaises(wf_release.ReleaseError):
                fixture.rollback_publisher().publish(
                    payload,
                    server_running=lambda: False,
                    fail_after="after_archive_moves",
                )

            for root_name, path in fixture.live_paths.items():
                self.assertEqual(fixture.modified[root_name], path.read_bytes())
            self.assertEqual(active_before, fixture.store.active_path.read_bytes())

    def test_snapshot_absence_deletes_new_live_file_and_keeps_empty_root_archive(self):
        module = self._module()
        with tempfile.TemporaryDirectory() as tmp:
            fixture = RollbackFixture(module, Path(tmp))
            snapshot_path = fixture.snapshot_dir / "snapshot.json"
            snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
            common = next(item for item in snapshot["file_before"] if item["root"] == "common")
            logical = common["logical_path"]
            common.update({"exists": False, "bytes": None, "sha256": None, "size": None})
            leaf = "file-common-{}".format(
                hashlib.sha256(f"common\0{logical}".encode()).hexdigest()
            )
            (fixture.snapshot_dir / leaf).unlink()
            snapshot_raw = wf_release._canonical(snapshot)
            snapshot_path.write_bytes(snapshot_raw)
            marker_path = fixture.snapshot_dir / character_pack.SNAPSHOT_MARKER
            marker = json.loads(marker_path.read_text(encoding="utf-8"))
            marker["snapshot_sha256"] = hashlib.sha256(snapshot_raw).hexdigest()
            marker_path.write_bytes(wf_release._canonical(marker))

            payload = module.prepare_snapshot_rollback(
                fixture.snapshot_dir,
                fixture.live_roots,
                fixture.store,
                fixture.staging_root,
            )
            common_change = next(item for item in payload.files if item.root == "common")
            self.assertTrue(common_change.delete_after)
            result = fixture.rollback_publisher().publish(
                payload, server_running=lambda: False
            )

            self.assertFalse(fixture.live_paths["common"].exists())
            common_archive = next(path for path in result.archive_paths if path.name.endswith("common.zip"))
            with zipfile.ZipFile(common_archive, "r") as archive:
                self.assertEqual([], archive.namelist())

    def test_tampered_or_unfinalized_snapshot_is_rejected_before_staging(self):
        module = self._module()
        with tempfile.TemporaryDirectory() as tmp:
            fixture = RollbackFixture(module, Path(tmp))
            (fixture.snapshot_dir / "snapshot.json").write_bytes(b"{}")

            with self.assertRaisesRegex(wf_release.ReleaseError, "snapshot.*digest"):
                module.prepare_snapshot_rollback(
                    fixture.snapshot_dir,
                    fixture.live_roots,
                    fixture.store,
                    fixture.staging_root,
                )

            self.assertFalse(fixture.staging_root.exists())
            for root_name, path in fixture.live_paths.items():
                self.assertEqual(fixture.modified[root_name], path.read_bytes())

    def test_snapshot_rejects_mismatched_identity_base64_and_foreign_live_path(self):
        module = self._module()
        cases = (
            (
                "transaction",
                lambda payload: payload.update({"transaction_id": "9" * 32}),
                "transaction_id does not match",
            ),
            (
                "base64",
                lambda payload: payload["file_before"][0].update({"bytes": "***"}),
                "base64 is invalid",
            ),
            (
                "foreign_live",
                lambda payload: payload["file_before"][0].update({
                    "live_path": str(Path(tempfile.gettempdir()) / "outside.bin")
                }),
                "outside configured roots",
            ),
        )
        for label, mutate, expected in cases:
            with self.subTest(case=label), tempfile.TemporaryDirectory() as tmp:
                fixture = RollbackFixture(module, Path(tmp))
                fixture.rewrite_snapshot(mutate)
                with self.assertRaisesRegex(wf_release.ReleaseError, expected):
                    module.prepare_snapshot_rollback(
                        fixture.snapshot_dir,
                        fixture.live_roots,
                        fixture.store,
                        fixture.staging_root,
                    )
                self.assertFalse(fixture.staging_root.exists())

    def test_public_rollback_requires_installed_binding_and_exact_confirmation(self):
        module = self._module()
        with tempfile.TemporaryDirectory() as tmp:
            fixture = RollbackFixture(module, Path(tmp))
            with mock.patch.object(
                wf_release,
                "_repo_paths",
                return_value=(fixture.repo, fixture.live_roots, fixture.cdn),
            ), mock.patch.object(
                wf_release, "_server_running", return_value=False
            ), mock.patch.object(
                wf_release, "detect_canonical_base_version", return_value="1.4.54"
            ):
                with self.assertRaisesRegex(wf_release.ReleaseError, "ROLLBACK_CHARACTER_PACKAGE"):
                    module.publish_snapshot_rollback(
                        fixture.snapshot_dir, "cn", "yes", fixture.installed
                    )
                with self.assertRaisesRegex(wf_release.ReleaseError, "installed package"):
                    module.publish_snapshot_rollback(
                        fixture.snapshot_dir,
                        "cn",
                        "ROLLBACK_CHARACTER_PACKAGE",
                        None,
                    )

                result = module.publish_snapshot_rollback(
                    fixture.snapshot_dir,
                    "cn",
                    "ROLLBACK_CHARACTER_PACKAGE",
                    fixture.installed,
                )

            self.assertEqual("1.4.56", result.version)
            for root_name, path in fixture.live_paths.items():
                self.assertEqual(fixture.original[root_name], path.read_bytes())


if __name__ == "__main__":
    unittest.main()
