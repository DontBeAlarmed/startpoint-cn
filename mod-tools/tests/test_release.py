# -*- coding: utf-8 -*-
from __future__ import annotations

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


def _zip(member: str, raw: bytes) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(member, raw)
    return output.getvalue()


class AtomicReleaseFixture:
    def __init__(self, module, root: Path):
        self.module = module
        self.root = root
        self.cdn = root / "cdn" / "cn"
        self.active = self.cdn / "character-releases" / "active.json"
        self.files = []
        prefixes = {
            "common": "production/upload/aa/common",
            "medium": "production/medium_upload/bb/medium",
            "android": "production/android_upload/cc/android",
        }
        for index, root_name in enumerate(("common", "medium", "android", "server")):
            live = root / "live" / root_name / f"file-{index}.bin"
            staged = root / "staged" / root_name / f"file-{index}.bin"
            live.parent.mkdir(parents=True, exist_ok=True)
            staged.parent.mkdir(parents=True, exist_ok=True)
            before = f"before-{root_name}".encode()
            after = f"after-{root_name}".encode()
            live.write_bytes(before)
            staged.write_bytes(after)
            self.files.append(module.ReleaseFile(
                root=root_name,
                logical_path=f"file-{index}.bin",
                live_path=live,
                staged_path=staged,
                before_raw=before,
                after_sha256=hashlib.sha256(after).hexdigest(),
                after_size=len(after),
            ))
        self.archives = []
        for root_name, member in prefixes.items():
            raw = _zip(member, f"archive-{root_name}".encode())
            path = root / "provisional" / f"{root_name}.zip"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
            self.archives.append(module.ProvisionalArchive(
                root=root_name,
                path=path,
                sha256=hashlib.sha256(raw).hexdigest(),
                size=len(raw),
                members=(member,),
            ))
        self.store = module.ActiveReleaseStore(self.cdn, canonical_base_version="1.4.54")
        self.payload = module.ReleasePayload(
            package_id="seris_dragon_king",
            package_manifest_sha256="a" * 64,
            expected_base=self.store.read_validated_base(),
            files=tuple(self.files),
            provisional_archives=tuple(self.archives),
        )

    def publisher(self):
        return self.module.AtomicReleasePublisher(
            self.cdn,
            canonical_base_version="1.4.54",
            release_id_factory=lambda: "20260714t230000z-test0001",
        )


class TestAtomicCharacterRelease(unittest.TestCase):
    def _module(self):
        return importlib.import_module("wf_release")

    def test_detect_canonical_base_preserves_active_anchor_after_late_legacy_edge(self):
        module = self._module()
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            cdn = root / "cdn"
            repo = root / "repo"
            common = cdn / module.ROOT_DIRS["common"]
            common.mkdir(parents=True)
            (common / "pinball-1.4.132-1.4.133-1-before.zip").write_bytes(b"before")
            (common / "pinball-1.4.138-1.4.139-1-late.zip").write_bytes(b"late")
            active_path = cdn / "character-releases" / "active.json"
            active_path.parent.mkdir(parents=True)
            active_path.write_text(json.dumps({
                "schema_version": 1,
                "base_version": "1.4.133",
                "releases": [{
                    "release_id": "release-1",
                    "package_id": "fixture",
                    "from_version": "1.4.133",
                    "version": "1.4.134",
                    "package_manifest_sha256": "a" * 64,
                    "archives": [],
                }],
            }), encoding="utf-8")

            detected = module.detect_canonical_base_version(cdn, repo)

            self.assertEqual("1.4.133", detected)

    def test_new_transaction_supplies_validated_installed_package_for_upgrade(self):
        module = self._module()
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            candidate_dir = root / "candidate"
            installed_dir = root / "installed"
            candidate_dir.mkdir()
            installed_dir.mkdir()
            candidate_manifest = {"package_id": "seris_dragon_king", "candidate": True}
            installed_manifest = {"package_id": "seris_dragon_king", "installed": True}
            live_roots = module.character_pack.LiveRoots(
                root / "common", root / "medium", root / "android", root / "server"
            )
            transaction = object()
            release_pack = importlib.import_module("wf_seris_release_pack")
            with (
                mock.patch.object(
                    release_pack, "validate_runtime_test_package", return_value=[]
                ),
                mock.patch.object(
                    module.character_pack,
                    "load_manifest",
                    side_effect=[candidate_manifest, installed_manifest],
                ),
                mock.patch.object(
                    module.character_pack, "validate_manifest", return_value=[]
                ) as validate_manifest,
                mock.patch.object(
                    module.character_pack, "PackTransaction", return_value=transaction
                ) as pack_transaction,
            ):
                manifest, result = module._new_transaction(
                    candidate_dir,
                    live_roots,
                    root / "cdn",
                    "1.4.134",
                    installed_package_dir=installed_dir,
                )

            self.assertIs(candidate_manifest, manifest)
            self.assertIs(transaction, result)
            validate_manifest.assert_called_once_with(installed_manifest, installed_dir)
            self.assertIs(
                installed_manifest,
                pack_transaction.call_args.kwargs["installed_manifest"],
            )
            self.assertEqual(
                installed_dir,
                pack_transaction.call_args.kwargs["installed_package_dir"],
            )

    def test_new_transaction_rejects_invalid_installed_package(self):
        module = self._module()
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            candidate_dir = root / "candidate"
            installed_dir = root / "installed"
            candidate_dir.mkdir()
            installed_dir.mkdir()
            candidate_manifest = {"package_id": "seris_dragon_king", "candidate": True}
            installed_manifest = {"package_id": "seris_dragon_king", "installed": True}
            live_roots = module.character_pack.LiveRoots(
                root / "common", root / "medium", root / "android", root / "server"
            )
            release_pack = importlib.import_module("wf_seris_release_pack")
            with (
                mock.patch.object(
                    release_pack, "validate_runtime_test_package", return_value=[]
                ),
                mock.patch.object(
                    module.character_pack,
                    "load_manifest",
                    side_effect=[candidate_manifest, installed_manifest],
                ),
                mock.patch.object(
                    module.character_pack,
                    "validate_manifest",
                    return_value=["hash mismatch"],
                ),
            ):
                with self.assertRaisesRegex(
                    module.ReleaseError,
                    r"installed package invalid:[\s\S]*hash mismatch",
                ):
                    module._new_transaction(
                        candidate_dir,
                        live_roots,
                        root / "cdn",
                        "1.4.134",
                        installed_package_dir=installed_dir,
                    )

    def test_absent_active_state_binds_exact_legacy_tail(self):
        module = self._module()
        with tempfile.TemporaryDirectory() as td:
            store = module.ActiveReleaseStore(Path(td), canonical_base_version="1.4.54")
            state = store.read_validated_base()
            self.assertIsNone(state.active_raw)
            self.assertEqual("1.4.54", state.validated_chain_tail)
            self.assertEqual("1.4.54", state.expected_from_version)

    def test_server_running_gate_has_zero_production_writes(self):
        module = self._module()
        with tempfile.TemporaryDirectory() as td:
            fixture = AtomicReleaseFixture(module, Path(td))
            before = {item.live_path: item.live_path.read_bytes() for item in fixture.files}
            with self.assertRaisesRegex(module.ReleaseError, "SERVER_RESTART_REQUIRED"):
                fixture.publisher().publish(
                    fixture.payload, server_running=lambda: True
                )
            self.assertFalse(fixture.active.exists())
            self.assertEqual(before, {path: path.read_bytes() for path in before})
            self.assertEqual([], list(fixture.cdn.rglob("*-charpkg-*.zip")))
            self.assertEqual([], list((fixture.cdn / "character-releases").glob("journal-*.json")))

    def test_precommit_failure_restores_every_live_file_and_archive(self):
        module = self._module()
        with tempfile.TemporaryDirectory() as td:
            fixture = AtomicReleaseFixture(module, Path(td))
            before = {item.live_path: item.live_path.read_bytes() for item in fixture.files}
            with self.assertRaisesRegex(module.ReleaseError, "injected"):
                fixture.publisher().publish(
                    fixture.payload,
                    server_running=lambda: False,
                    fail_after="after_archive_moves",
                )
            self.assertFalse(fixture.active.exists())
            self.assertEqual(before, {path: path.read_bytes() for path in before})
            self.assertEqual([], list(fixture.cdn.rglob("*-charpkg-*.zip")))
            self.assertEqual([], list((fixture.cdn / "character-releases").glob("journal-*.json")))

    def test_every_precommit_mutation_checkpoint_restores_exact_before_state(self):
        module = self._module()
        phases = (
            "after_journal_fsync",
            "after_live_0", "after_live_1", "after_live_2", "after_live_3",
            "after_archive_0", "after_archive_1", "after_archive_2",
            "before_active_replace",
        )
        for phase in phases:
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as td:
                fixture = AtomicReleaseFixture(module, Path(td))
                before = {
                    item.live_path: item.live_path.read_bytes() for item in fixture.files
                }
                with self.assertRaisesRegex(module.ReleaseError, "injected"):
                    fixture.publisher().publish(
                        fixture.payload,
                        server_running=lambda: False,
                        fail_after=phase,
                    )
                self.assertFalse(fixture.active.exists())
                self.assertEqual(before, {path: path.read_bytes() for path in before})
                self.assertEqual([], list(fixture.cdn.rglob("*-charpkg-*.zip")))
                self.assertEqual(
                    [],
                    list((fixture.cdn / "character-releases").rglob("journal-*.json")),
                )

    def test_failure_after_journal_fsync_does_not_rewrite_live_files(self):
        module = self._module()
        with tempfile.TemporaryDirectory() as td:
            fixture = AtomicReleaseFixture(module, Path(td))
            mtimes = {
                item.live_path: item.live_path.stat().st_mtime_ns for item in fixture.files
            }
            with self.assertRaisesRegex(module.ReleaseError, "injected"):
                fixture.publisher().publish(
                    fixture.payload,
                    server_running=lambda: False,
                    fail_after="after_journal_fsync",
                )
            self.assertEqual(
                mtimes,
                {path: path.stat().st_mtime_ns for path in mtimes},
            )

    def test_active_parent_fsync_failure_is_postcommit_and_never_rewinds(self):
        module = self._module()
        with tempfile.TemporaryDirectory() as td:
            fixture = AtomicReleaseFixture(module, Path(td))
            active_parent = fixture.active.parent.resolve()
            original = module._fsync_directory

            def fail_active_parent(path: Path) -> None:
                if Path(path).resolve() == active_parent:
                    raise OSError("injected active directory fsync failure")
                original(path)

            with mock.patch.object(module, "_fsync_directory", side_effect=fail_active_parent):
                with self.assertRaisesRegex(module.CommittedReleaseError, "committed"):
                    fixture.publisher().publish(
                        fixture.payload, server_running=lambda: False
                    )
            self.assertTrue(fixture.active.is_file())
            self.assertEqual(
                {item.live_path: item.staged_path.read_bytes() for item in fixture.files},
                {item.live_path: item.live_path.read_bytes() for item in fixture.files},
            )
            self.assertEqual(3, len(list(fixture.cdn.rglob("*-charpkg-*.zip"))))

    def test_live_parent_fsync_failure_restores_the_replaced_live_file(self):
        module = self._module()
        with tempfile.TemporaryDirectory() as td:
            fixture = AtomicReleaseFixture(module, Path(td))
            before = {item.live_path: item.live_path.read_bytes() for item in fixture.files}
            failing_parent = fixture.files[0].live_path.parent.resolve()
            original = module._fsync_directory
            injected = False

            def fail_once(path: Path) -> None:
                nonlocal injected
                if not injected and Path(path).resolve() == failing_parent:
                    injected = True
                    raise OSError("injected live directory fsync failure")
                original(path)

            with mock.patch.object(module, "_fsync_directory", side_effect=fail_once):
                with self.assertRaisesRegex(module.ReleaseError, "live directory"):
                    fixture.publisher().publish(
                        fixture.payload, server_running=lambda: False
                    )
            self.assertTrue(injected)
            self.assertEqual(before, {path: path.read_bytes() for path in before})
            self.assertFalse(fixture.active.exists())
            self.assertEqual([], list(fixture.cdn.rglob("*-charpkg-*.zip")))

    def test_archive_parent_fsync_failure_removes_the_replaced_archive(self):
        module = self._module()
        with tempfile.TemporaryDirectory() as td:
            fixture = AtomicReleaseFixture(module, Path(td))
            before = {item.live_path: item.live_path.read_bytes() for item in fixture.files}
            failing_parent = (fixture.cdn / "archive-android-diff").resolve()
            original = module._fsync_directory
            injected = False

            def fail_once(path: Path) -> None:
                nonlocal injected
                if not injected and Path(path).resolve() == failing_parent:
                    injected = True
                    raise OSError("injected archive directory fsync failure")
                original(path)

            with mock.patch.object(module, "_fsync_directory", side_effect=fail_once):
                with self.assertRaisesRegex(module.ReleaseError, "archive directory"):
                    fixture.publisher().publish(
                        fixture.payload, server_running=lambda: False
                    )
            self.assertTrue(injected)
            self.assertEqual(before, {path: path.read_bytes() for path in before})
            self.assertFalse(fixture.active.exists())
            self.assertEqual([], list(fixture.cdn.rglob("*-charpkg-*.zip")))

    def test_active_replace_is_commit_point_and_postcommit_failure_does_not_rewind(self):
        module = self._module()
        with tempfile.TemporaryDirectory() as td:
            fixture = AtomicReleaseFixture(module, Path(td))
            after = {item.live_path: item.staged_path.read_bytes() for item in fixture.files}
            with self.assertRaisesRegex(module.CommittedReleaseError, "committed"):
                fixture.publisher().publish(
                    fixture.payload,
                    server_running=lambda: False,
                    fail_after="after_active_replace",
                )
            self.assertTrue(fixture.active.is_file())
            self.assertEqual(after, {path: path.read_bytes() for path in after})
            active = json.loads(fixture.active.read_bytes())
            self.assertEqual("1.4.54", active["base_version"])
            self.assertEqual("1.4.55", active["releases"][0]["version"])
            self.assertEqual(3, len(active["releases"][0]["archives"]))
            self.assertEqual(3, len(list(fixture.cdn.rglob("*-charpkg-*.zip"))))
            state = fixture.store.read_validated_base()
            self.assertEqual("1.4.55", state.validated_chain_tail)
            self.assertEqual("seris_dragon_king", active["releases"][0]["package_id"])

    def test_stale_base_rejects_before_journal_or_mutation(self):
        module = self._module()
        with tempfile.TemporaryDirectory() as td:
            fixture = AtomicReleaseFixture(module, Path(td))
            stale = module.ReleasePayload(
                package_id=fixture.payload.package_id,
                package_manifest_sha256=fixture.payload.package_manifest_sha256,
                expected_base=module.character_pack.ReleaseBaseState(
                    active_raw=None,
                    active_sha256=None,
                    current_release_id=None,
                    validated_chain_tail="1.4.53",
                    expected_from_version="1.4.53",
                ),
                files=fixture.payload.files,
                provisional_archives=fixture.payload.provisional_archives,
            )
            with self.assertRaisesRegex(module.ReleaseError, "STALE_RELEASE_BASE"):
                fixture.publisher().publish(stale, server_running=lambda: False)
            self.assertFalse(fixture.active.exists())
            self.assertEqual([], list(fixture.cdn.rglob("*-charpkg-*.zip")))

    def test_second_writer_with_same_prepared_base_reports_stale_after_first_commits(self):
        module = self._module()
        with tempfile.TemporaryDirectory() as td:
            fixture = AtomicReleaseFixture(module, Path(td))
            publisher = fixture.publisher()
            first = publisher.publish(fixture.payload, server_running=lambda: False)
            active_before = fixture.active.read_bytes()
            archive_before = {
                path: path.read_bytes() for path in fixture.cdn.rglob("*-charpkg-*.zip")
            }
            with self.assertRaisesRegex(module.ReleaseError, "STALE_RELEASE_BASE"):
                publisher.publish(fixture.payload, server_running=lambda: False)
            self.assertEqual(active_before, fixture.active.read_bytes())
            self.assertEqual(
                archive_before,
                {path: path.read_bytes() for path in archive_before},
            )
            self.assertEqual("1.4.55", first.version)

    def test_active_chain_fails_closed_for_detached_or_hash_bad_archive(self):
        module = self._module()
        with tempfile.TemporaryDirectory() as td:
            fixture = AtomicReleaseFixture(module, Path(td))
            fixture.publisher().publish(fixture.payload, server_running=lambda: False)
            first_archive = next(fixture.cdn.rglob("*-charpkg-*.zip"))
            first_archive.write_bytes(b"tampered")
            with self.assertRaisesRegex(module.ReleaseError, "archive"):
                fixture.store.read_validated_base()
            active = json.loads(fixture.active.read_bytes())
            active["base_version"] = "1.4.53"
            fixture.active.write_text(json.dumps(active), encoding="utf-8")
            with self.assertRaisesRegex(module.ReleaseError, "base_version"):
                fixture.store.read_validated_base()

    def test_json_object_codec_exposes_exact_outer_rows(self):
        module = self._module()
        claim = module.character_pack.TableClaim(
            "server", "character.json", "json_object", ("129999",)
        )
        image = module.JsonObjectCodec().inspect(
            b'{"1":{"name":"old"},"129999":{"name":"Seris"}}', claim, ()
        )
        self.assertEqual(("1", "129999"), tuple(key for key, _raw in image.outer_rows))
        self.assertEqual(
            b'{"name":"Seris"}', dict(image.outer_rows)["129999"]
        )
        with self.assertRaisesRegex(module.ReleaseError, "JSON object"):
            module.JsonObjectCodec().inspect(b"[]", claim, ())

    def test_live_rebase_preserves_unclaimed_rows_for_every_table_codec(self):
        module = self._module()
        core = importlib.import_module("wf_mod_tool")

        def ordered(keys, rows, *, raw_outer=False):
            table = core.OrderedMap("<fixture>", keys, rows, Path("<memory>"))
            return (
                core.build_orderedmap_raw_rows(table)
                if raw_outer else core.build_orderedmap(table)
            )

        flat_claim = module.character_pack.TableClaim(
            "common", "master/character/character.orderedmap", "flat", ("129999",)
        )
        flat = module._merge_claimed_table_bytes(
            flat_claim,
            ordered(["1", "129999"], [b"stale", b"seris"]),
            ordered(["1", "119998"], [b"live", b"hugo"]),
        )
        flat_keys, flat_rows = core._strict_orderedmap_rows(
            flat, label="flat", compressed_rows=True
        )
        self.assertEqual(["1", "119998", "129999"], flat_keys)
        self.assertEqual([b"live", b"hugo", b"seris"], flat_rows)

        raw_claim = module.character_pack.TableClaim(
            "common", "master/character/character_status.orderedmap",
            "raw_outer", ("129999",),
        )
        raw_outer = module._merge_claimed_table_bytes(
            raw_claim,
            ordered(["1", "129999"], [b"stale-inner", b"seris-inner"], raw_outer=True),
            ordered(["1", "119998"], [b"live-inner", b"hugo-inner"], raw_outer=True),
        )
        raw_keys, raw_rows = core._strict_orderedmap_rows(
            raw_outer, label="raw", compressed_rows=False
        )
        self.assertEqual(["1", "119998", "129999"], raw_keys)
        self.assertEqual([b"live-inner", b"hugo-inner", b"seris-inner"], raw_rows)

        candidate_inner = ordered(["old", "skill"], [b"stale", b"seris-skill"])
        live_inner = ordered(["old", "hugo"], [b"live", b"hugo-skill"])
        nested_claim = module.character_pack.TableClaim(
            "common", "master/skill/action_skill.orderedmap", "action_nested",
            ("seris_dragon_king",), (("seris_dragon_king", ("skill",)),),
        )
        nested = module._merge_claimed_table_bytes(
            nested_claim,
            ordered(["seris_dragon_king"], [candidate_inner], raw_outer=True),
            ordered(["seris_dragon_king"], [live_inner], raw_outer=True),
        )
        nested_outer_keys, nested_outer_rows = core._strict_orderedmap_rows(
            nested, label="nested", compressed_rows=False
        )
        self.assertEqual(["seris_dragon_king"], nested_outer_keys)
        nested_keys, nested_rows = core._strict_orderedmap_rows(
            nested_outer_rows[0], label="nested-inner", compressed_rows=True
        )
        self.assertEqual(["old", "hugo", "skill"], nested_keys)
        self.assertEqual([b"live", b"hugo-skill", b"seris-skill"], nested_rows)

        json_claim = module.character_pack.TableClaim(
            "server", "character.json", "json_object", ("129999",)
        )
        merged_json = json.loads(module._merge_claimed_table_bytes(
            json_claim,
            b'{"1":{"name":"stale"},"129999":{"name":"Seris"}}',
            b'{"1":{"name":"live"},"119998":{"name":"Hugo"}}',
        ))
        self.assertEqual(
            {"1": {"name": "live"}, "119998": {"name": "Hugo"},
             "129999": {"name": "Seris"}},
            merged_json,
        )

    def test_transaction_records_convert_to_hash_bound_release_payload(self):
        module = self._module()
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            staged_file = root / "staged.bin"
            staged_file.write_bytes(b"after")
            archive_path = root / "common.zip"
            archive_raw = _zip("production/upload/aa/file", b"after")
            archive_path.write_bytes(archive_raw)
            base = module.character_pack.ReleaseBaseState(
                None, None, None, "1.4.54", "1.4.54", None
            )
            prepared = SimpleNamespace(
                package_manifest_sha256="d" * 64,
                release_base=base,
            )
            staged = SimpleNamespace(
                staged_files=({
                    "root": "common",
                    "logical_path": "asset.bin",
                    "path": str(staged_file),
                    "sha256": hashlib.sha256(b"after").hexdigest(),
                    "size": 5,
                    "operation": "update",
                },),
                provisional_archives=({
                    "root": "common",
                    "path": str(archive_path),
                    "sha256": hashlib.sha256(archive_raw).hexdigest(),
                    "size": len(archive_raw),
                    "members": ["production/upload/aa/file"],
                },),
            )
            snapshot = SimpleNamespace(file_before=({
                "root": "common",
                "logical_path": "asset.bin",
                "live_path": str(root / "live.bin"),
                "bytes": b"before",
                "exists": True,
                "sha256": hashlib.sha256(b"before").hexdigest(),
                "size": 6,
            },))
            payload = module.release_payload_from_records(
                {"package_id": "seris_dragon_king"}, prepared, staged, snapshot
            )
            self.assertEqual("d" * 64, payload.package_manifest_sha256)
            self.assertEqual(b"before", payload.files[0].before_raw)
            self.assertEqual(staged_file, payload.files[0].staged_path)
            self.assertEqual(("production/upload/aa/file",), payload.provisional_archives[0].members)

    def test_prepare_runtime_release_uses_pack_transaction_without_live_writes(self):
        module = self._module()
        core = importlib.import_module("wf_mod_tool")
        release_pack = importlib.import_module("wf_seris_release_pack")
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            package = root / "package"
            live = {
                name: root / "live" / name
                for name in ("common", "medium", "android", "server")
            }
            for directory in live.values():
                directory.mkdir(parents=True)

            logical = "master/character/character.orderedmap"
            live_table = core.build_orderedmap(core.OrderedMap(
                logical, ["1"], [b"old"], Path("<memory>")
            ))
            candidate_table = core.build_orderedmap(core.OrderedMap(
                logical, ["1", "129999"], [b"stale", b"seris"], Path("<memory>")
            ))
            core_path = core.table_path(live["common"], logical)
            core_path.parent.mkdir(parents=True, exist_ok=True)
            core_path.write_bytes(live_table)

            roots = {name: [] for name in ("common", "medium", "android", "server")}

            def add(root_name: str, logical_path: str, raw: bytes) -> None:
                output = package / "roots" / root_name / Path(*logical_path.split("/"))
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_bytes(raw)
                roots[root_name].append({
                    "logical_path": logical_path,
                    "sha256": hashlib.sha256(raw).hexdigest(),
                    "size": len(raw),
                })

            add("common", logical, candidate_table)
            add(
                "medium",
                "character/seris_dragon_king/ui/square_0.png",
                b"\x89png\r\n\x1a\n",
            )
            add("android", "character/seris_dragon_king/ui/skill_cutin_0.atf.deflate", b"atf")
            server_paths = (
                "cdndata/character.json", "cdndata/character_text.json",
                "character.json", "mana_node.json",
            )
            for server_path in server_paths:
                before = json.dumps({"1": {"old": True}}, separators=(",", ":")).encode()
                after = json.dumps(
                    {"1": {"stale": True}, "129999": {"seris": True}},
                    separators=(",", ":"),
                ).encode()
                live_path = live["server"] / Path(*server_path.split("/"))
                live_path.parent.mkdir(parents=True, exist_ok=True)
                live_path.write_bytes(before)
                add("server", server_path, after)
            qa_raw = b'{"pass":true}'
            (package / "qa").mkdir(parents=True)
            (package / "qa" / "index.json").write_bytes(qa_raw)
            tables = [{
                "root": "common", "logical_path": logical, "codec_id": "flat",
                "outer_keys": ["129999"], "inner_keys": [], "semantic_claims": [],
            }]
            tables.extend({
                "root": "server", "logical_path": server_path,
                "codec_id": "json_object", "outer_keys": ["129999"],
                "inner_keys": [], "semantic_claims": [],
            } for server_path in server_paths)
            manifest = {
                "schema_version": 1,
                "package_id": "seris_dragon_king",
                "character_id": 129999,
                "code_name": "seris_dragon_king",
                "package_version": "1.0.0-runtime-test",
                "requires_client_base": "dual_form_v1",
                "required_capabilities": ["ModDualForm"],
                "roots": roots,
                "tables": tables,
                "skills": {},
                "unique_condition": {"id": 22},
                "qa": {
                    "delivery_mode": "runtime_test", "release_ready": False,
                    "user_authorized_direct_real_test": True,
                    "files": [{
                        "logical_path": "index.json",
                        "sha256": hashlib.sha256(qa_raw).hexdigest(),
                        "size": len(qa_raw),
                    }],
                },
                "snapshot": {"offline_manifest_sha256": "e" * 64},
            }
            (package / "manifest.json").write_bytes(
                module.character_pack.canonical_manifest_bytes(manifest)
            )
            self.assertEqual([], release_pack.validate_runtime_test_package(package))
            before_facts = {
                path: path.read_bytes()
                for directory in live.values()
                for path in directory.rglob("*") if path.is_file()
            }
            live_roots = module.character_pack.LiveRoots(
                live["common"], live["medium"], live["android"], live["server"],
                (root / "cdn",),
            )
            rebased = root / "rebased"
            module.rebase_runtime_package(
                package,
                rebased,
                live_roots=live_roots,
                generator_git_head="f" * 40,
            )
            production_manifest = json.loads(json.dumps(manifest))
            production_manifest["qa"] = {
                "delivery_mode": "production",
                "release_ready": True,
                "required_assets_total": 37,
                "required_assets_present": 37,
                "workspace_input_sha256": "a" * 64,
            }
            (package / "manifest.json").write_bytes(
                module.character_pack.canonical_manifest_bytes(production_manifest)
            )
            production_rebased = root / "rebased-production"
            module.rebase_runtime_package(
                package,
                production_rebased,
                live_roots=live_roots,
                generator_git_head="f" * 40,
            )
            self.assertTrue((production_rebased / "manifest.json").is_file())
            rebased_flat = core.read_orderedmap_file(
                rebased / "roots" / "common" / Path(*logical.split("/")), logical
            )
            self.assertEqual(b"old", dict(zip(rebased_flat.keys, rebased_flat.rows))["1"])
            for server_path in server_paths:
                self.assertEqual(
                    {"old": True},
                    json.loads(
                        (rebased / "roots" / "server" / server_path).read_bytes()
                    )["1"],
                )
            prepared = module.prepare_runtime_release(
                rebased,
                live_roots=live_roots,
                cdn_root=root / "cdn",
                canonical_base_version="1.4.54",
                staging_root=root / "staging",
                snapshot_root=root / "snapshots",
                available_capabilities=("dual_form_v1",),
            )
            self.assertTrue(prepared.preflight.can_prepare)
            self.assertEqual(7, len(prepared.payload.files))
            self.assertEqual(3, len(prepared.payload.provisional_archives))
            self.assertEqual(before_facts, {path: path.read_bytes() for path in before_facts})
            module.close_prepared_runtime_release(prepared, discard_staging=True)


if __name__ == "__main__":
    unittest.main()
