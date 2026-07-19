# -*- coding: utf-8 -*-
"""Character-package manifest contract tests (temporary directories only)."""
from __future__ import annotations

import copy
import dataclasses
import hashlib
import importlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "schemas" / "character-pack-v1.schema.json"
ROOTS = ("common", "medium", "android", "server")


def base_manifest() -> dict:
    return {
        "schema_version": 1,
        "package_id": "seris_dragon_king",
        "character_id": 129999,
        "code_name": "seris_dragon_king",
        "package_version": "1.0.0",
        "requires_client_base": "dual_form_v1",
        "required_capabilities": ["ModDualForm", "MatchedCutin", "MatchedPixelart"],
        "roots": {root: [] for root in ROOTS},
        "tables": [],
        "skills": {},
        "unique_condition": {},
        "qa": {},
        "snapshot": {},
    }


def add_file(package_dir: Path, manifest: dict, root: str, logical_path: str,
             data: bytes = b"fixture") -> dict:
    path = package_dir / "roots" / root / Path(*logical_path.split("/"))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    entry = {
        "logical_path": logical_path,
        "sha256": hashlib.sha256(data).hexdigest(),
        "size": len(data),
    }
    manifest["roots"][root].append(entry)
    return entry


def file_entry(logical_path: str, data: bytes) -> dict:
    return {
        "logical_path": logical_path,
        "sha256": hashlib.sha256(data).hexdigest(),
        "size": len(data),
    }


def make_directory_link(link: Path, target: Path) -> None:
    """Create a temporary directory symlink, with a Windows junction fallback."""
    try:
        link.symlink_to(target, target_is_directory=True)
        return
    except OSError as symlink_error:
        if os.name != "nt":
            raise
        result = subprocess.run(
            ["cmd", "/d", "/c", "mklink", "/J", str(link), str(target)],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            raise symlink_error


class TestManifestContract(unittest.TestCase):
    def _module(self):
        try:
            return importlib.import_module("wf_character_pack")
        except ModuleNotFoundError:
            self.fail("missing character-pack contract module: wf_character_pack")

    def test_schema_is_checked_in_and_strict(self):
        self.assertTrue(SCHEMA_PATH.is_file(), "missing character-pack-v1.schema.json")
        schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
        self.assertEqual(schema["properties"]["schema_version"]["const"], 1)
        self.assertFalse(schema["additionalProperties"])
        self.assertEqual(set(schema["required"]), set(base_manifest()))
        roots = schema["properties"]["roots"]
        self.assertFalse(roots["additionalProperties"])
        self.assertEqual(set(roots["required"]), set(ROOTS))
        self.assertIn("$defs", schema, "schema must define one reusable file/path contract")
        self.assertIn("fileEntry", schema["$defs"])
        self.assertIn("logicalPath", schema["$defs"])
        file_schema = schema["$defs"]["fileEntry"]
        self.assertFalse(file_schema["additionalProperties"])
        self.assertEqual(set(file_schema["required"]), {"logical_path", "sha256", "size"})
        self.assertEqual(
            file_schema["properties"]["logical_path"],
            {"$ref": "#/$defs/logicalPath"},
        )
        for root in ROOTS:
            self.assertEqual(
                roots["properties"][root]["items"],
                {"$ref": "#/$defs/fileEntry"},
            )

    def test_schema_and_runtime_enforce_the_same_path_policy(self):
        pack = self._module()
        schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
        if "$defs" in schema:
            pattern = schema["$defs"]["logicalPath"]["pattern"]
        else:
            pattern = schema["properties"]["roots"]["properties"]["common"][
                "items"
            ]["properties"]["logical_path"]["pattern"]

        invalid = (
            "",
            "/absolute/file.bin",
            "C:/absolute/file.bin",
            "C:drive-relative/file.bin",
            r"\\server\share\file.bin",
            "//server/share/file.bin",
            r"character\seris\asset.bin",
            "character/../secret.bin",
            "character/./asset.bin",
            "character//asset.bin",
            "asset/",
            ".",
            "..",
            "character/seris/story/asset.bin",
            "character/seris/StOrY/asset.bin",
            "character/seris/words/asset.bin",
            "character/seris/WoRdS/asset.bin",
            "character/seris/login/asset.bin",
            "character/seris/LOGIN/asset.bin",
            "character/seris/expression/asset.bin",
            "character/seris/Expression/asset.bin",
            "character/seris/expressions/asset.bin",
            "character/seris/EXPRESSIONS/asset.bin",
        )
        with tempfile.TemporaryDirectory() as td:
            package_dir = Path(td)
            for logical_path in invalid:
                with self.subTest(logical_path=logical_path):
                    self.assertIsNone(
                        re.fullmatch(pattern, logical_path),
                        f"schema accepted forbidden path: {logical_path!r}",
                    )
                    manifest = base_manifest()
                    manifest["roots"]["common"].append({
                        "logical_path": logical_path,
                        "sha256": "0" * 64,
                        "size": 0,
                    })
                    errors = pack.validate_manifest(manifest, package_dir)
                    self.assertTrue(
                        any("roots.common[0].logical_path" in error for error in errors),
                        errors,
                    )

            allowed = base_manifest()
            allowed_paths = (
                "metadata/backstory/asset.bin",
                "metadata/wordsmith/asset.bin",
                "metadata/login_bonus/asset.bin",
                "metadata/expressionist/asset.bin",
            )
            for logical_path in allowed_paths:
                self.assertIsNotNone(
                    re.fullmatch(pattern, logical_path),
                    f"schema rejected legal near-match: {logical_path!r}",
                )
                add_file(package_dir, allowed, "common", logical_path,
                         logical_path.encode("utf-8"))
            self.assertEqual(pack.validate_manifest(allowed, package_dir), [])

    def test_valid_manifest_loads_validates_and_hashes_canonically(self):
        pack = self._module()
        with tempfile.TemporaryDirectory() as td:
            package_dir = Path(td)
            manifest = base_manifest()
            add_file(package_dir, manifest, "common", "character/seris/icon.png", b"png")
            manifest["qa"] = {"说明": "稳定 UTF-8"}
            path = package_dir / "manifest.json"
            path.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
            before = copy.deepcopy(manifest)

            loaded = pack.load_manifest(path)
            errors = pack.validate_manifest(loaded, package_dir)
            canonical = pack.canonical_manifest_bytes(loaded)

            self.assertEqual(loaded, manifest)
            self.assertEqual(errors, [])
            self.assertEqual(loaded, before, "validation must not mutate its input")
            self.assertEqual(
                canonical,
                json.dumps(manifest, ensure_ascii=False, sort_keys=True,
                           separators=(",", ":")).encode("utf-8"),
            )
            self.assertFalse(canonical.endswith(b"\n"))
            self.assertEqual(
                pack.PackFile("common", "a/b", "0" * 64, 1).root,
                "common",
            )

    def test_production_manifest_requires_wf_storage_png_signature_in_client_roots(self):
        pack = self._module()
        import wf_assets

        standard_png = b"\x89PNG\r\n\x1a\n" + b"payload"
        stored_png = wf_assets.PNG_FAKE + b"payload"
        with tempfile.TemporaryDirectory() as td:
            package_dir = Path(td)
            for root in ("android", "common", "medium"):
                logical_path = f"character/seris/ui/{root}.png"
                with self.subTest(root=root, signature="standard"):
                    manifest = base_manifest()
                    manifest["qa"] = {
                        "delivery_mode": "production",
                        "release_ready": True,
                        "required_assets_total": 37,
                        "required_assets_present": 37,
                    }
                    entry = add_file(
                        package_dir, manifest, root, logical_path, standard_png
                    )
                    self.assertEqual(
                        hashlib.sha256(standard_png).hexdigest(), entry["sha256"]
                    )
                    self.assertEqual(
                        [],
                        pack.validate_manifest(manifest, package_dir),
                        "legacy installed packages must remain usable as repair input",
                    )
                    errors = pack.validate_manifest(
                        manifest,
                        package_dir,
                        require_referenced_assets=True,
                    )
                    self.assertTrue(
                        any(
                            logical_path in error
                            and "WF storage signature" in error
                            for error in errors
                        ),
                        errors,
                    )

                with self.subTest(root=root, signature="storage"):
                    manifest = base_manifest()
                    manifest["qa"] = {
                        "delivery_mode": "production",
                        "release_ready": True,
                        "required_assets_total": 37,
                        "required_assets_present": 37,
                    }
                    add_file(package_dir, manifest, root, logical_path, stored_png)
                    self.assertEqual(
                        [],
                        pack.validate_manifest(
                            manifest,
                            package_dir,
                            require_referenced_assets=True,
                        ),
                    )

            server_manifest = base_manifest()
            server_manifest["qa"] = {
                "delivery_mode": "production",
                "release_ready": True,
                "required_assets_total": 37,
                "required_assets_present": 37,
            }
            add_file(
                package_dir,
                server_manifest,
                "server",
                "cdndata/preview.png",
                standard_png,
            )
            self.assertEqual(
                [],
                pack.validate_manifest(
                    server_manifest,
                    package_dir,
                    require_referenced_assets=True,
                ),
                "server root is not WF client storage and must remain exempt",
            )

    def test_unique_condition_claim_requires_declared_icon_asset(self):
        pack = self._module()
        import wf_mod_tool as core

        with tempfile.TemporaryDirectory() as td:
            package_dir = Path(td)
            manifest = base_manifest()
            logical_table = "master/character/unique_condition.orderedmap"
            logical_icon = (
                "battle/common/unique_condition/unique_seris_wet.png"
            )
            table_raw = core.build_orderedmap(core.OrderedMap(
                logical_table,
                ["23"],
                [(
                    "unique_seris_wet,湿润,"
                    "battle/common/unique_condition/unique_seris_wet,1800,1"
                ).encode("utf-8")],
                Path("<memory>"),
            ))
            add_file(package_dir, manifest, "common", logical_table, table_raw)
            manifest["tables"].append({
                "root": "common",
                "logical_path": logical_table,
                "codec_id": "flat",
                "outer_keys": ["23"],
                "inner_keys": [],
                "semantic_claims": [],
            })

            self.assertEqual(
                pack.validate_manifest(manifest, package_dir),
                [],
                "an already-installed legacy package must remain usable as repair input",
            )
            errors = pack.validate_manifest(
                manifest,
                package_dir,
                require_referenced_assets=True,
            )
            self.assertIn(
                "tables[0].outer_keys[0]: referenced asset is not declared "
                f"in roots.common: {logical_icon}",
                errors,
            )

            add_file(package_dir, manifest, "common", logical_icon, b"stored-png")
            self.assertEqual(
                pack.validate_manifest(
                    manifest,
                    package_dir,
                    require_referenced_assets=True,
                ),
                [],
            )

    def test_load_rejects_non_json_constants_and_duplicate_object_keys(self):
        pack = self._module()
        invalid_sources = (
            ('{"qa":{"score":NaN}}', "non-JSON constant NaN"),
            ('{"qa":{"score":Infinity}}', "non-JSON constant Infinity"),
            ('{"qa":{"score":-Infinity}}', "non-JSON constant -Infinity"),
            ('{"schema_version":1,"schema_version":1}',
             "duplicate JSON object key 'schema_version'"),
            ('{"qa":{"score":1,"score":2}}', "duplicate JSON object key 'score'"),
        )
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "manifest.json"
            for source, expected in invalid_sources:
                with self.subTest(source=source):
                    path.write_text(source, encoding="utf-8")
                    with self.assertRaisesRegex(ValueError, expected):
                        pack.load_manifest(path)

    def test_direct_manifest_rejects_non_finite_and_non_json_values(self):
        pack = self._module()
        cyclic: list = []
        cyclic.append(cyclic)
        invalid_values = (
            (float("nan"), "non-finite number"),
            (float("inf"), "non-finite number"),
            (float("-inf"), "non-finite number"),
            ({"set-member"}, "not a JSON value"),
            (b"bytes", "not a JSON value"),
            (("tuple",), "not a JSON value"),
            ({1: "non-string-key"}, "object key must be a string"),
            ("\ud800", "not valid UTF-8"),
            (cyclic, "circular reference"),
        )
        with tempfile.TemporaryDirectory() as td:
            for value, expected in invalid_values:
                with self.subTest(value=repr(value)):
                    manifest = base_manifest()
                    manifest["qa"] = {"bad": value}
                    errors = pack.validate_manifest(manifest, Path(td))
                    self.assertEqual(errors, sorted(errors))
                    self.assertTrue(
                        any("qa.bad" in error and expected in error for error in errors),
                        errors,
                    )

    def test_every_valid_manifest_has_canonical_bytes(self):
        pack = self._module()
        manifest = base_manifest()
        manifest["qa"] = {
            "score": 1.25,
            "flags": [True, False, None],
            "nested": {"text": "赛瑞斯"},
        }
        with tempfile.TemporaryDirectory() as td:
            self.assertEqual(pack.validate_manifest(manifest, Path(td)), [])
        first = pack.canonical_manifest_bytes(manifest)
        second = pack.canonical_manifest_bytes(copy.deepcopy(manifest))
        self.assertEqual(first, second)

        unencodable = base_manifest()
        unencodable["qa"] = {"oversized_integer": 10 ** 5000}
        with tempfile.TemporaryDirectory() as td:
            errors = pack.validate_manifest(unencodable, Path(td))
        self.assertTrue(any("cannot be canonicalized" in error for error in errors), errors)

    def test_rejects_absolute_parent_and_noncanonical_paths(self):
        pack = self._module()
        invalid = (
            "/absolute/file.png",
            r"C:\absolute\file.png",
            r"\\server\share\file.png",
            "character/../secret.png",
            "character/./icon.png",
            "character//icon.png",
            r"character\icon.png",
        )
        with tempfile.TemporaryDirectory() as td:
            for logical_path in invalid:
                with self.subTest(logical_path=logical_path):
                    manifest = base_manifest()
                    manifest["roots"]["common"].append({
                        "logical_path": logical_path,
                        "sha256": "0" * 64,
                        "size": 0,
                    })
                    errors = pack.validate_manifest(manifest, Path(td))
                    self.assertTrue(any("logical_path" in error for error in errors), errors)

    def test_rejects_duplicate_paths_within_and_across_roots(self):
        pack = self._module()
        with tempfile.TemporaryDirectory() as td:
            package_dir = Path(td)
            manifest = base_manifest()
            entry = add_file(package_dir, manifest, "common", "character/shared.bin")
            manifest["roots"]["common"].append(dict(entry))
            manifest["roots"]["android"].append(dict(entry))

            errors = pack.validate_manifest(manifest, package_dir)

            duplicate_errors = [error for error in errors if "duplicate logical_path" in error]
            self.assertGreaterEqual(len(duplicate_errors), 2, errors)

    def test_rejects_root_level_and_nested_links_outside_package_before_hashing(self):
        pack = self._module()
        payload = b"external-payload"
        with tempfile.TemporaryDirectory() as td:
            workspace = Path(td)
            external = workspace / "external"
            external.mkdir()
            (external / "payload.bin").write_bytes(payload)

            root_link_package = workspace / "root-link-package"
            (root_link_package / "roots").mkdir(parents=True)
            make_directory_link(root_link_package / "roots" / "common", external)
            root_manifest = base_manifest()
            root_manifest["roots"]["common"].append(file_entry("payload.bin", payload))

            with mock.patch.object(pack, "_sha256_file", wraps=pack._sha256_file) as hasher:
                first = pack.validate_manifest(root_manifest, root_link_package)
            with mock.patch.object(pack, "_sha256_file", wraps=pack._sha256_file) as repeated_hasher:
                second = pack.validate_manifest(root_manifest, root_link_package)

            self.assertEqual(first, sorted(first))
            self.assertEqual(first, second)
            self.assertTrue(any("roots.common" in error and "outside" in error for error in first), first)
            hasher.assert_not_called()
            repeated_hasher.assert_not_called()

            nested_link_package = workspace / "nested-link-package"
            common = nested_link_package / "roots" / "common"
            common.mkdir(parents=True)
            make_directory_link(common / "escape", external)
            nested_manifest = base_manifest()
            nested_manifest["roots"]["common"].append(
                file_entry("escape/payload.bin", payload)
            )
            with mock.patch.object(pack, "_sha256_file", wraps=pack._sha256_file) as nested_hasher:
                nested_errors = pack.validate_manifest(nested_manifest, nested_link_package)
            self.assertTrue(
                any("roots.common[0].logical_path" in error and "outside" in error
                    for error in nested_errors),
                nested_errors,
            )
            nested_hasher.assert_not_called()

    def test_filesystem_failures_become_stable_field_errors(self):
        pack = self._module()
        with tempfile.TemporaryDirectory() as td:
            package_dir = Path(td)
            manifest = base_manifest()
            add_file(package_dir, manifest, "common", "payload.bin", b"payload")
            payload_path = package_dir / "roots" / "common" / "payload.bin"

            original_resolve = Path.resolve
            original_is_file = Path.is_file

            def fail_payload_resolve(path: Path, *args, **kwargs):
                if path.name == payload_path.name:
                    raise RuntimeError("synthetic resolve loop")
                return original_resolve(path, *args, **kwargs)

            def fail_payload_is_file(path: Path):
                if path.name == payload_path.name:
                    raise OSError("synthetic is_file failure")
                return original_is_file(path)

            operations = (
                ("resolve", mock.patch.object(Path, "resolve", fail_payload_resolve)),
                ("is_file", mock.patch.object(Path, "is_file", fail_payload_is_file)),
                ("stat", mock.patch.object(Path, "is_file", return_value=True),
                 mock.patch.object(Path, "stat", side_effect=OSError("synthetic stat failure"))),
                ("sha256", mock.patch.object(pack, "_sha256_file",
                                              side_effect=OSError("synthetic hash failure"))),
            )
            for operation in operations:
                label, *patchers = operation
                with self.subTest(operation=label):
                    try:
                        for patcher in patchers:
                            patcher.start()
                        try:
                            first = pack.validate_manifest(manifest, package_dir)
                        except (OSError, RuntimeError) as exc:
                            self.fail(f"validator leaked {label} failure: {exc}")
                    finally:
                        for patcher in reversed(patchers):
                            patcher.stop()
                    self.assertEqual(first, sorted(first))
                    self.assertTrue(
                        any("roots.common[0]" in error and "cannot" in error for error in first),
                        first,
                    )

    def test_rejects_missing_or_bad_hash_size_and_file(self):
        pack = self._module()
        with tempfile.TemporaryDirectory() as td:
            package_dir = Path(td)
            manifest = base_manifest()
            missing_hash = {"logical_path": "a/missing-hash.bin", "size": 1}
            bad_hash = {"logical_path": "a/bad-hash.bin", "sha256": "ABC", "size": 1}
            missing_file = {"logical_path": "a/missing.bin", "sha256": "0" * 64, "size": 1}
            manifest["roots"]["common"].extend([missing_hash, bad_hash, missing_file])
            entry = add_file(package_dir, manifest, "server", "assets/data.json", b"actual")
            entry["size"] += 1
            entry["sha256"] = "f" * 64

            errors = pack.validate_manifest(manifest, package_dir)

            joined = "\n".join(errors)
            self.assertIn("sha256 is required", joined)
            self.assertIn("invalid sha256", joined)
            self.assertIn("file does not exist", joined)
            self.assertIn("size mismatch", joined)
            self.assertIn("sha256 mismatch", joined)

    def test_rejects_unknown_schema_and_top_level_shape(self):
        pack = self._module()
        with tempfile.TemporaryDirectory() as td:
            manifest = base_manifest()
            manifest["schema_version"] = 2
            manifest["unexpected"] = True
            del manifest["snapshot"]

            errors = pack.validate_manifest(manifest, Path(td))

            joined = "\n".join(errors)
            self.assertIn("unsupported schema_version", joined)
            self.assertIn("unexpected top-level field", joined)
            self.assertIn("snapshot is required", joined)

    def test_rejects_story_words_login_and_expression_segments_only(self):
        pack = self._module()
        forbidden = ("story", "words", "login", "expression", "expressions")
        with tempfile.TemporaryDirectory() as td:
            package_dir = Path(td)
            for segment in forbidden:
                with self.subTest(segment=segment):
                    manifest = base_manifest()
                    entry = {
                        "logical_path": f"character/seris/{segment}/asset.bin",
                        "sha256": "0" * 64,
                        "size": 0,
                    }
                    manifest["roots"]["common"].append(entry)
                    errors = pack.validate_manifest(manifest, package_dir)
                    self.assertTrue(any("forbidden asset segment" in error for error in errors), errors)

            allowed = base_manifest()
            for name in ("backstory", "wordsmith", "login_bonus", "expressionist"):
                add_file(package_dir, allowed, "common", f"metadata/{name}/asset.bin", name.encode())
            self.assertEqual(pack.validate_manifest(allowed, package_dir), [])

    def test_errors_are_complete_sorted_deterministic_and_input_is_unchanged(self):
        pack = self._module()
        manifest = base_manifest()
        manifest["schema_version"] = 9
        manifest["roots"]["common"].append({
            "logical_path": "/story/file.bin",
            "size": -1,
        })
        before = copy.deepcopy(manifest)
        with tempfile.TemporaryDirectory() as td:
            first = pack.validate_manifest(manifest, Path(td))
            second = pack.validate_manifest(manifest, Path(td))

        self.assertEqual(first, sorted(first))
        self.assertEqual(first, second)
        self.assertGreaterEqual(len(first), 4, first)
        self.assertEqual(manifest, before)


class _FakeReleaseBaseProvider:
    def __init__(self, state):
        self.state = state
        self.calls = 0

    def read_validated_base(self):
        self.calls += 1
        if isinstance(self.state, Exception):
            raise self.state
        return self.state


class _JsonFixtureCodec:
    """Explicit test codec; transaction code must never infer CSV columns."""

    def __init__(self, pack):
        self.pack = pack

    @staticmethod
    def _value_bytes(value) -> bytes:
        return json.dumps(
            value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")

    def inspect(self, raw: bytes, claim, semantic_claims):
        def reject_duplicates(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError(f"duplicate JSON key {key}")
                result[key] = value
            return result

        payload = json.loads(
            raw.decode("utf-8"), object_pairs_hook=reject_duplicates
        )
        outer = tuple(
            (str(key), self._value_bytes(value))
            for key, value in payload.get("outer", {}).items()
        )
        inner = tuple(
            (str(outer_key), str(key), self._value_bytes(value))
            for outer_key, rows in payload.get("inner", {}).items()
            for key, value in rows.items()
        )
        semantic_values = tuple(
            (str(namespace), str(value))
            for namespace, values in payload.get("semantics", {}).items()
            for value in values
        )
        return self.pack.TableImage(outer, inner, semantic_values)


class _FilteringJsonFixtureCodec(_JsonFixtureCodec):
    """Valid claim-scoped codec used to expose candidate-only inspection bugs."""

    def inspect(self, raw: bytes, claim, semantic_claims):
        complete = super().inspect(raw, claim, semantic_claims)
        outer_requested = set(claim.outer_keys)
        inner_requested = {
            (outer_key, key)
            for outer_key, keys in claim.inner_keys for key in keys
        }
        semantic_requested = {
            (item.namespace, item.value) for item in semantic_claims
        }
        return self.pack.TableImage(
            tuple(item for item in complete.outer_rows if item[0] in outer_requested),
            tuple(item for item in complete.inner_rows
                  if (item[0], item[1]) in inner_requested),
            tuple(item for item in complete.semantic_values
                  if item in semantic_requested),
        )


class _ControllableJsonFixtureCodec(_JsonFixtureCodec):
    def __init__(self, pack):
        super().__init__(pack)
        self.calls = []
        self.fail = False

    def inspect(self, raw: bytes, claim, semantic_claims):
        self.calls.append((claim.root, claim.logical_path, raw))
        if self.fail:
            raise ValueError("synthetic snapshot decode failure")
        return super().inspect(raw, claim, semantic_claims)


class _TransactionFixtureMixin:
    TABLE_SPECS = (
        ("master/character.orderedmap", ("129999",), (),
         (("character_id", "129999"), ("character_code_name", "seris_dragon_king"))),
        ("master/ability.orderedmap",
         tuple(str(1299990 + index) for index in range(1, 7)), (),
         tuple(("ability_id", str(1299990 + index)) for index in range(1, 7))),
        ("master/leader.orderedmap", ("129999",), (),
         (("leader_id", "129999"),)),
        ("master/action.orderedmap", ("seris_human",),
         (("seris_human", ("1", "2")),),
         (("action_skill_outer_key", "seris_human"),)),
        ("master/switched.orderedmap", ("seris_dragon",),
         (("seris_dragon", ("1", "2")),),
         (("switched_skill_outer_key", "seris_dragon"),)),
        ("master/unique.orderedmap", ("22",), (),
         (("unique_id", "22"), ("unique_string_id", "seris_form"))),
    )
    SERVER_PATHS = (
        "cdndata/character.json",
        "cdndata/character_text.json",
        "character.json",
        "mana_node.json",
    )

    def _require_api(self):
        required = (
            "PackTransaction", "LiveRoots", "ReleaseBaseState", "TableImage",
            "PackPreflightError", "PackStagingError",
        )
        missing = [name for name in required if not hasattr(self.pack, name)]
        self.assertEqual(missing, [], f"missing Task-2 transaction API: {missing}")

    def setUp(self):
        self.pack = importlib.import_module("wf_character_pack")
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.package_dir = self.root / "package"
        self.common = self.root / "live" / "production" / "upload"
        self.medium = self.common.parent / "medium_upload"
        self.android = self.common.parent / "android_upload"
        self.server = self.root / "project" / "assets"
        self.active_dir = self.root / "cdn" / "character-releases"
        self.staging_root = self.root / "staging"
        self.snapshot_root = self.root / "snapshots"
        for path in (
            self.package_dir, self.common, self.medium, self.android,
            self.server, self.active_dir, self.staging_root, self.snapshot_root,
        ):
            path.mkdir(parents=True, exist_ok=True)

        self.manifest = base_manifest()
        self.manifest["tables"] = []
        for logical_path, outer_keys, inner_keys, semantics in self.TABLE_SPECS:
            live_payload = {
                "outer": {"official": {"value": logical_path}},
                "inner": {},
                "semantics": {"official_code": ["official"]},
            }
            candidate_payload = copy.deepcopy(live_payload)
            for key in outer_keys:
                candidate_payload["outer"][key] = {"owner": "seris", "key": key}
            for outer_key, keys in inner_keys:
                candidate_payload["inner"][outer_key] = {
                    key: {"program": f"{outer_key}/{key}"} for key in keys
                }
            for namespace, value in semantics:
                candidate_payload["semantics"].setdefault(namespace, []).append(value)

            live_bytes = json.dumps(
                live_payload, ensure_ascii=False, separators=(",", ":")
            ).encode("utf-8")
            candidate_bytes = json.dumps(
                candidate_payload, ensure_ascii=False, separators=(",", ":")
            ).encode("utf-8")
            self._write_live("common", logical_path, live_bytes)
            add_file(self.package_dir, self.manifest, "common", logical_path,
                     candidate_bytes)
            self.manifest["tables"].append({
                "root": "common",
                "logical_path": logical_path,
                "codec_id": "fixture_json",
                "outer_keys": list(outer_keys),
                "inner_keys": [
                    {"outer_key": outer_key, "keys": list(keys)}
                    for outer_key, keys in inner_keys
                ],
                "semantic_claims": [
                    {
                        "namespace": namespace,
                        "value": value,
                        "source_logical_path": logical_path,
                    }
                    for namespace, value in semantics
                ],
            })

        add_file(
            self.package_dir, self.manifest, "common",
            "character/seris/voice/battle/skill.mp3", b"storage-ready-mp3",
        )
        add_file(
            self.package_dir, self.manifest, "medium",
            "character/seris/ui/full_shot.png", b"storage-ready-png",
        )
        add_file(
            self.package_dir, self.manifest, "android",
            "character/seris/ui/skill_cutin.atf", b"storage-ready-atf",
        )
        for logical_path in self.SERVER_PATHS:
            live_payload = {
                "outer": {"official": {"value": logical_path}},
                "inner": {},
                "semantics": {},
            }
            candidate_payload = copy.deepcopy(live_payload)
            candidate_payload["outer"]["129999"] = {
                "owner": "seris", "path": logical_path,
            }
            live_bytes = json.dumps(
                live_payload, separators=(",", ":")
            ).encode("utf-8")
            candidate_bytes = json.dumps(
                candidate_payload, separators=(",", ":")
            ).encode("utf-8")
            add_file(
                self.package_dir, self.manifest, "server", logical_path,
                candidate_bytes,
            )
            server_path = self.server / Path(*logical_path.split("/"))
            server_path.parent.mkdir(parents=True, exist_ok=True)
            server_path.write_bytes(live_bytes)
            self.manifest["tables"].append({
                "root": "server",
                "logical_path": logical_path,
                "codec_id": "fixture_json",
                "outer_keys": ["129999"],
                "inner_keys": [],
                "semantic_claims": [],
            })

        active_raw = b'{"release_id":"previous"}'
        (self.active_dir / "active.json").write_bytes(active_raw)
        self.release_state = None
        self.provider = None
        self._active_raw = active_raw

    def _finish_setup(self, *, active_manifest_hash=None):
        self._require_api()
        self.release_state = self.pack.ReleaseBaseState(
            active_raw=self._active_raw,
            active_sha256=hashlib.sha256(self._active_raw).hexdigest(),
            current_release_id="previous",
            validated_chain_tail="1.4.54",
            expected_from_version="1.4.54",
            active_package_manifest_sha256=active_manifest_hash,
        )
        self.provider = _FakeReleaseBaseProvider(self.release_state)

    def _write_live(self, root_name: str, logical_path: str, data: bytes):
        import wf_mod_tool as core
        root = {"common": self.common, "medium": self.medium,
                "android": self.android}[root_name]
        path = core.table_path(root, logical_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def _tx(self, *, manifest=None, provider=None, installed_manifest=None,
            installed_package_dir=None, capabilities=("dual_form_v1",),
            degraded=False, codec_registry=None, filesystem_boundary_hook=None):
        self._require_api()
        if self.provider is None:
            self._finish_setup()
        live_roots = self.pack.LiveRoots(
            common=self.common,
            medium=self.medium,
            android=self.android,
            server=self.server,
            protected=(self.active_dir,),
        )
        return self.pack.PackTransaction(
            self.package_dir,
            manifest or self.manifest,
            live_roots=live_roots,
            release_base_provider=provider or self.provider,
            codec_registry=(codec_registry or {
                "fixture_json": _JsonFixtureCodec(self.pack)
            }),
            installed_manifest=installed_manifest,
            installed_package_dir=installed_package_dir,
            available_capabilities=capabilities,
            degraded_data_confirmed=degraded,
            snapshot_roots=(self.snapshot_root,),
            filesystem_boundary_hook=filesystem_boundary_hook,
        )

    def _tree_bytes(self, root: Path):
        return {
            path.relative_to(root).as_posix(): path.read_bytes()
            for path in sorted(root.rglob("*")) if path.is_file()
        }

    def _protected_trees(self):
        return {
            name: self._tree_bytes(path)
            for name, path in {
                "common": self.common,
                "medium": self.medium,
                "android": self.android,
                "server": self.server,
                "active": self.active_dir,
            }.items()
        }

    def _occupy_claims(self):
        import wf_mod_tool as core
        for claim in self.manifest["tables"]:
            root = claim["root"]
            logical_path = claim["logical_path"]
            source = self.package_dir / "roots" / root / Path(*logical_path.split("/"))
            target = (
                self.server / Path(*logical_path.split("/"))
                if root == "server" else core.table_path(self.common, logical_path)
            )
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(source.read_bytes())

    def _set_package_bytes(self, manifest, root, logical_path, data):
        source = self.package_dir / "roots" / root / Path(
            *logical_path.split("/")
        )
        source.write_bytes(data)
        entry = next(
            item for item in manifest["roots"][root]
            if item["logical_path"] == logical_path
        )
        entry["size"] = len(data)
        entry["sha256"] = hashlib.sha256(data).hexdigest()

    def _installed_copy(self, *, package_id="seris_dragon_king", version="0.9.0"):
        installed_dir = self.root / f"installed-{package_id}"
        shutil.copytree(self.package_dir, installed_dir)
        installed = copy.deepcopy(self.manifest)
        installed["package_id"] = package_id
        installed["package_version"] = version
        return installed, installed_dir


class TestPackPreflight(_TransactionFixtureMixin, unittest.TestCase):
    def test_production_preflight_rejects_rehashed_standard_png(self):
        self._finish_setup()
        manifest = copy.deepcopy(self.manifest)
        manifest["qa"] = {
            "delivery_mode": "production",
            "release_ready": True,
            "required_assets_total": 37,
            "required_assets_present": 37,
        }
        logical_path = "character/seris/ui/full_shot.png"
        standard_png = b"\x89PNG\r\n\x1a\n" + b"payload"
        self._set_package_bytes(manifest, "medium", logical_path, standard_png)

        with self.assertRaises(self.pack.PackPreflightError) as caught:
            self._tx(manifest=manifest).preflight()
        message = str(caught.exception)
        self.assertIn(logical_path, message)
        self.assertIn("WF storage signature", message)

    def test_non_container_asset_paths_require_exact_manifest_ownership(self):
        self._finish_setup()
        import wf_mod_tool as core

        table_paths = {
            item["logical_path"] for item in self.manifest["tables"]
        }
        asset_entries = {
            root: next(
                item for item in self.manifest["roots"][root]
                if item["logical_path"] not in table_paths
            )
            for root in ("common", "medium", "android")
        }
        roots = {
            "common": self.common, "medium": self.medium, "android": self.android
        }

        for root, entry in asset_entries.items():
            with self.subTest(first_install_root=root):
                live = core.table_path(roots[root], entry["logical_path"])
                live.parent.mkdir(parents=True, exist_ok=True)
                source = self.package_dir / "roots" / root / Path(
                    *entry["logical_path"].split("/")
                )
                live.write_bytes(source.read_bytes())  # equal bytes are not ownership
                report = self._tx().preflight()
                conflicts = {(item["kind"], item["claim"])
                             for item in report.conflicts}
                self.assertIn(
                    ("asset_path", f"{root}:{entry['logical_path']}"), conflicts
                )
                live.unlink()

        installed, installed_dir = self._installed_copy()
        installed_hash = hashlib.sha256(
            self.pack.canonical_manifest_bytes(installed)
        ).hexdigest()
        owned_state = self.pack.ReleaseBaseState(
            **{**self.release_state.__dict__,
               "active_package_manifest_sha256": installed_hash}
        )
        for root, entry in asset_entries.items():
            live = core.table_path(roots[root], entry["logical_path"])
            live.parent.mkdir(parents=True, exist_ok=True)
            live.write_bytes(b"occupied-upgrade-path")
        owned = self._tx(
            provider=_FakeReleaseBaseProvider(owned_state),
            installed_manifest=installed,
            installed_package_dir=installed_dir,
        ).preflight()
        self.assertFalse(any(item["kind"] == "asset_path"
                             for item in owned.conflicts), owned.conflicts)

        for root, entry in asset_entries.items():
            with self.subTest(new_upgrade_path=root):
                unowned = copy.deepcopy(installed)
                unowned["roots"][root] = [
                    item for item in unowned["roots"][root]
                    if item["logical_path"] != entry["logical_path"]
                ]
                unowned_hash = hashlib.sha256(
                    self.pack.canonical_manifest_bytes(unowned)
                ).hexdigest()
                unowned_state = self.pack.ReleaseBaseState(
                    **{**self.release_state.__dict__,
                       "active_package_manifest_sha256": unowned_hash}
                )
                report = self._tx(
                    provider=_FakeReleaseBaseProvider(unowned_state),
                    installed_manifest=unowned,
                    installed_package_dir=installed_dir,
                ).preflight()
                conflicts = {(item["kind"], item["claim"])
                             for item in report.conflicts}
                self.assertIn(
                    ("asset_path", f"{root}:{entry['logical_path']}"), conflicts
                )

    def test_first_install_rejects_every_occupied_declared_claim(self):
        self._finish_setup()
        self._occupy_claims()
        report = self._tx().preflight()
        conflict_ids = {(item["kind"], item["claim"]) for item in report.conflicts}
        expected_values = {
            ("outer_key", f"{path}:{key}")
            for path, outer, _, _ in self.TABLE_SPECS for key in outer
        }
        expected_values |= {
            ("semantic", f"{namespace}:{value}")
            for _, _, _, semantics in self.TABLE_SPECS
            for namespace, value in semantics
        }
        self.assertTrue(expected_values.issubset(conflict_ids), report.conflicts)
        self.assertFalse(report.can_prepare)

    def test_upgrade_requires_hash_bound_same_package_prior_ownership(self):
        installed, installed_dir = self._installed_copy()
        installed_hash = hashlib.sha256(
            self.pack.canonical_manifest_bytes(installed)
        ).hexdigest() if hasattr(self.pack, "ReleaseBaseState") else "0" * 64
        self._finish_setup(active_manifest_hash=installed_hash)
        self._occupy_claims()

        owned = self._tx(installed_manifest=installed,
                         installed_package_dir=installed_dir).preflight()
        self.assertEqual(owned.conflicts, ())
        self.assertEqual(owned.version_diff,
                         {"installed": "0.9.0", "candidate": "1.0.0", "relation": "upgrade"})

        bad_state = self.pack.ReleaseBaseState(
            **{**self.release_state.__dict__,
               "active_package_manifest_sha256": "f" * 64}
        )
        with self.assertRaises(self.pack.PackPreflightError):
            self._tx(provider=_FakeReleaseBaseProvider(bad_state),
                     installed_manifest=installed,
                     installed_package_dir=installed_dir).preflight()

        other, other_dir = self._installed_copy(package_id="someone_else")
        other_hash = hashlib.sha256(self.pack.canonical_manifest_bytes(other)).hexdigest()
        other_state = self.pack.ReleaseBaseState(
            **{**self.release_state.__dict__,
               "active_package_manifest_sha256": other_hash}
        )
        with self.assertRaises(self.pack.PackPreflightError):
            self._tx(provider=_FakeReleaseBaseProvider(other_state),
                     installed_manifest=other,
                     installed_package_dir=other_dir).preflight()

    def _multi_owner_state(self, owners, *, tail_hash=None):
        if self.release_state is None:
            self._finish_setup(active_manifest_hash=tail_hash)
        return self.pack.ReleaseBaseState(
            **{**self.release_state.__dict__, "package_owners": tuple(owners)}
        )

    def test_multi_owner_fresh_install_alongside_foreign_owner(self):
        # 链尾归他包所有，但候选包在 owners 里没有条目 → 免 installed manifest
        state = self._multi_owner_state(
            (("other_pkg", "a" * 64),), tail_hash="a" * 64
        )
        report = self._tx(provider=_FakeReleaseBaseProvider(state)).preflight()
        self.assertEqual(report.conflicts, ())
        self.assertTrue(report.can_prepare)
        self.assertEqual(
            report.version_diff,
            {"installed": None, "candidate": "1.0.0", "relation": "install"},
        )

    def test_multi_owner_fresh_install_still_rejects_occupied_claims(self):
        state = self._multi_owner_state(
            (("other_pkg", "a" * 64),), tail_hash="a" * 64
        )
        self._occupy_claims()
        report = self._tx(provider=_FakeReleaseBaseProvider(state)).preflight()
        self.assertTrue(any(
            item.get("reason") == "occupied_without_hash_bound_prior_ownership"
            for item in report.conflicts
        ), report.conflicts)
        self.assertFalse(report.can_prepare)

    def test_multi_owner_upgrade_binds_to_own_entry_not_chain_tail(self):
        installed, installed_dir = self._installed_copy()
        installed_hash = hashlib.sha256(
            self.pack.canonical_manifest_bytes(installed)
        ).hexdigest()
        state = self._multi_owner_state(
            (("other_pkg", "b" * 64), ("seris_dragon_king", installed_hash)),
            tail_hash="b" * 64,
        )
        self._occupy_claims()
        report = self._tx(
            provider=_FakeReleaseBaseProvider(state),
            installed_manifest=installed,
            installed_package_dir=installed_dir,
        ).preflight()
        self.assertEqual(report.conflicts, ())
        self.assertEqual(
            report.version_diff,
            {"installed": "0.9.0", "candidate": "1.0.0", "relation": "upgrade"},
        )

    def test_multi_owner_owned_package_requires_installed_manifest(self):
        state = self._multi_owner_state(
            (("other_pkg", "b" * 64), ("seris_dragon_king", "c" * 64)),
            tail_hash="b" * 64,
        )
        with self.assertRaisesRegex(
            self.pack.PackPreflightError, "installed manifest was not supplied"
        ):
            self._tx(provider=_FakeReleaseBaseProvider(state)).preflight()

    def test_multi_owner_rejects_installed_manifest_without_own_entry(self):
        installed, installed_dir = self._installed_copy()
        state = self._multi_owner_state(
            (("other_pkg", "b" * 64),), tail_hash="b" * 64
        )
        with self.assertRaisesRegex(
            self.pack.PackPreflightError, "not hash-bound"
        ):
            self._tx(
                provider=_FakeReleaseBaseProvider(state),
                installed_manifest=installed,
                installed_package_dir=installed_dir,
            ).preflight()

    def test_candidate_rollback_suffix_package_id_is_rejected(self):
        self._finish_setup()
        manifest = copy.deepcopy(self.manifest)
        manifest["package_id"] = "seris_dragon_king-rollback"
        with self.assertRaisesRegex(
            self.pack.PackPreflightError, "-rollback"
        ):
            self._tx(manifest=manifest).preflight()

    def test_multi_owner_state_invariants_fail_closed(self):
        self._finish_setup()
        base = self.release_state.__dict__
        cases = (
            {"package_owners": (("other_pkg", "zz"),)},
            {"package_owners": (
                ("other_pkg", "a" * 64), ("other_pkg", "b" * 64)
            )},
            {"package_owners": (("", "a" * 64),)},
        )
        for overrides in cases:
            state = self.pack.ReleaseBaseState(**{**base, **overrides})
            with self.subTest(overrides=overrides), \
                    self.assertRaises(self.pack.PackPreflightError):
                self._tx(provider=_FakeReleaseBaseProvider(state)).preflight()
        empty_active = self.pack.ReleaseBaseState(
            active_raw=None, active_sha256=None, current_release_id=None,
            validated_chain_tail="1.4.54", expected_from_version="1.4.54",
            active_package_manifest_sha256=None,
            package_owners=(("other_pkg", "a" * 64),),
        )
        with self.assertRaises(self.pack.PackPreflightError):
            self._tx(provider=_FakeReleaseBaseProvider(empty_active)).preflight()

    def test_provider_invariants_fail_closed(self):
        self._finish_setup()
        cases = (
            self.pack.ReleaseBaseState(None, "0" * 64, None, "1", "1", None),
            self.pack.ReleaseBaseState(self._active_raw, "0" * 64, "previous", "1", "1", None),
            self.pack.ReleaseBaseState(self._active_raw,
                                       hashlib.sha256(self._active_raw).hexdigest(),
                                       "previous", "1", "2", None),
        )
        for state in cases:
            with self.subTest(state=state), self.assertRaises(self.pack.PackPreflightError):
                self._tx(provider=_FakeReleaseBaseProvider(state)).preflight()
        with self.assertRaises(self.pack.PackPreflightError):
            self._tx(provider=_FakeReleaseBaseProvider(ValueError("detached chain"))).preflight()

    @unittest.skipUnless(os.name == "nt", "exact named staging unavailable")
    def test_prepare_maps_exact_roots_and_captures_complete_base(self):
        self._finish_setup()
        tx = self._tx()
        report = tx.preflight()
        self.assertEqual(report.conflicts, ())
        first = report.canonical_bytes()
        self.assertEqual(first, tx.preflight().canonical_bytes())
        self.assertFalse(first.endswith(b"\n"))

        prepared = tx.prepare(self.staging_root)
        self.assertTrue(prepared.transaction_dir.is_relative_to(self.staging_root))
        self.assertEqual(prepared.release_base.active_raw, self._active_raw)
        self.assertEqual(prepared.release_base.expected_from_version, "1.4.54")
        self.assertFalse(hasattr(prepared, "version"))
        self.assertFalse(hasattr(prepared, "release_id"))
        self.assertFalse(hasattr(prepared, "archive_name"))
        server_targets = {
            item["live_path"] for item in prepared.file_changes
            if item["root"] == "server"
        }
        self.assertEqual(server_targets, {
            str(self.server / Path(*path.split("/"))) for path in self.SERVER_PATHS
        })
        for item in prepared.file_changes:
            if item["root"] in ("common", "medium", "android"):
                self.assertTrue(Path(item["live_path"]).is_relative_to(
                    {"common": self.common, "medium": self.medium,
                     "android": self.android}[item["root"]]))
            self.assertIn("before", item)
            self.assertIn("after_sha256", item)

    @unittest.skipUnless(os.name == "nt", "exact named staging unavailable")
    def test_snapshot_preserves_exact_files_outer_and_nested_keys(self):
        self._finish_setup()
        tx = self._tx()
        prepared = tx.prepare(self.staging_root)
        snapshot = tx.snapshot(self.snapshot_root)
        self.assertEqual(snapshot.transaction_id, prepared.transaction_id)
        self.assertEqual(snapshot.release_base.active_raw, self._active_raw)
        self.assertTrue(snapshot.snapshot_dir.is_relative_to(self.snapshot_root))
        self.assertEqual(
            {item["logical_path"] for item in snapshot.file_before
             if item["root"] == "server"},
            set(self.SERVER_PATHS),
        )
        self.assertEqual(
            {item["logical_path"] for item in snapshot.table_before
             if item["root"] == "server" and item["kind"] == "outer"},
            set(self.SERVER_PATHS),
        )
        prepared_server = {
            item["logical_path"] for item in prepared.table_key_changes
            if item["root"] == "server" and item["kind"] == "outer"
        }
        self.assertEqual(prepared_server, set(self.SERVER_PATHS))
        nested = {
            (item["logical_path"], item.get("outer_key"), item.get("inner_key"))
            for item in snapshot.table_before if item.get("inner_key") is not None
        }
        self.assertTrue({
            ("master/action.orderedmap", "seris_human", "1"),
            ("master/action.orderedmap", "seris_human", "2"),
            ("master/switched.orderedmap", "seris_dragon", "1"),
            ("master/switched.orderedmap", "seris_dragon", "2"),
        }.issubset(nested))
        raw_table_before = [
            item for item in snapshot.table_before if item["kind"] != "semantic"
        ]
        for item in (*raw_table_before, *snapshot.file_before):
            self.assertIn("exists", item)
            self.assertIn("bytes", item)
            self.assertIn("sha256", item)
        self.assertFalse(hasattr(snapshot, "restore"))

    @unittest.skipUnless(os.name == "nt", "exact named staging unavailable")
    def test_prepared_and_snapshot_address_semantic_claims_explicitly(self):
        self._finish_setup()
        tx = self._tx()
        prepared = tx.prepare(self.staging_root)
        semantic_changes = {
            (item.get("namespace"), item.get("value"))
            for item in prepared.table_key_changes if item["kind"] == "semantic"
        }
        self.assertTrue({
            ("character_code_name", "seris_dragon_king"),
            ("unique_string_id", "seris_form"),
        }.issubset(semantic_changes))
        for item in prepared.table_key_changes:
            if item["kind"] == "semantic":
                self.assertEqual(item["evidence_kind"], "codec_semantic_occupancy")
                self.assertIn("occupied", item["before"])
                self.assertIn("declared", item["after"])
                self.assertIn("source_table_before", item)
                self.assertNotIn("bytes", item["before"])

        snapshot = tx.snapshot(self.snapshot_root)
        semantic_before = {
            (item.get("namespace"), item.get("value"))
            for item in snapshot.table_before if item["kind"] == "semantic"
        }
        self.assertTrue(semantic_changes.issubset(semantic_before))
        for item in snapshot.table_before:
            if item["kind"] == "semantic":
                self.assertIn("occupied", item)
                self.assertIn("source_table_before", item)
                self.assertNotIn("bytes", item)

    @unittest.skipUnless(os.name == "nt", "exact named staging unavailable")
    def test_snapshot_captures_each_live_file_once_and_decodes_those_bytes(self):
        codec = _ControllableJsonFixtureCodec(self.pack)
        self._finish_setup()
        tx = self._tx(codec_registry={"fixture_json": codec})
        prepared = tx.prepare(self.staging_root)
        codec.calls.clear()
        original_read = self.pack._read_bytes_or_none
        reads = []

        def counted(path):
            reads.append(str(path))
            return original_read(path)

        with mock.patch.object(self.pack, "_read_bytes_or_none", side_effect=counted):
            snapshot = tx.snapshot(self.snapshot_root)

        expected_paths = {item["live_path"] for item in prepared.file_changes}
        self.assertEqual(set(reads), expected_paths)
        self.assertEqual(len(reads), len(expected_paths))
        self.assertEqual(
            {(root, path) for root, path, _ in codec.calls},
            {(item["root"], item["logical_path"])
             for item in self.manifest["tables"]},
        )
        captured = {
            (item["root"], item["logical_path"]): item["bytes"]
            for item in snapshot.file_before
        }
        for root, logical_path, raw in codec.calls:
            self.assertEqual(raw, captured[(root, logical_path)])
        self.assertEqual(
            [path for path in self.snapshot_root.iterdir()
             if path.name.endswith(".tmp")],
            [],
        )
        marker = json.loads(
            (snapshot.snapshot_dir / self.pack.SNAPSHOT_MARKER).read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(marker["kind"], "character_pack_snapshot")
        self.assertRegex(marker["snapshot_sha256"], r"^[0-9a-f]{64}$")
        self.assertEqual(
            marker["snapshot_sha256"],
            hashlib.sha256((snapshot.snapshot_dir / "snapshot.json").read_bytes()).hexdigest(),
        )

    @unittest.skipUnless(os.name == "nt", "exact named staging unavailable")
    def test_snapshot_retains_server_key_bytes_and_exact_whole_file_image(self):
        installed, installed_dir = self._installed_copy()
        installed_hash = hashlib.sha256(
            self.pack.canonical_manifest_bytes(installed)
        ).hexdigest()
        self._finish_setup(active_manifest_hash=installed_hash)
        self._occupy_claims()
        tx = self._tx(
            installed_manifest=installed,
            installed_package_dir=installed_dir,
        )
        tx.prepare(self.staging_root)
        snapshot = tx.snapshot(self.snapshot_root)
        codec = _JsonFixtureCodec(self.pack)
        for logical_path in self.SERVER_PATHS:
            file_record = next(
                item for item in snapshot.file_before
                if item["root"] == "server"
                and item["logical_path"] == logical_path
            )
            key_record = next(
                item for item in snapshot.table_before
                if item["root"] == "server"
                and item["logical_path"] == logical_path
                and item["kind"] == "outer"
                and item["outer_key"] == "129999"
            )
            payload = json.loads(file_record["bytes"].decode("utf-8"))
            self.assertEqual(
                key_record["bytes"],
                codec._value_bytes(payload["outer"]["129999"]),
            )
            self.assertEqual(
                key_record["sha256"],
                hashlib.sha256(key_record["bytes"]).hexdigest(),
            )

    @unittest.skipUnless(os.name == "nt", "exact named staging unavailable")
    def test_snapshot_decode_and_write_failures_remove_only_temporary_child(self):
        self._finish_setup()
        sibling = self.snapshot_root / "keep.bin"
        sibling.write_bytes(b"keep")

        codec = _ControllableJsonFixtureCodec(self.pack)
        tx = self._tx(codec_registry={"fixture_json": codec})
        tx.prepare(self.staging_root)
        codec.fail = True
        with self.assertRaises(self.pack.PackPreflightError):
            tx.snapshot(self.snapshot_root)
        self.assertEqual(sibling.read_bytes(), b"keep")
        self.assertEqual(
            [path for path in self.snapshot_root.iterdir() if path != sibling], []
        )

        codec.fail = False
        def corrupt_after_write(event, context):
            if (event == "before_output_verify"
                    and context["kind"] == "snapshot_json"):
                authority = context["authority"]
                authority.owner._write(authority.handle, b"corrupt")

        def fail_finalize(event, context):
            if event == "before_finalize":
                raise OSError("synthetic snapshot finalize failure")

        def fail_metadata_open(event, context):
            if (event == "before_output_open"
                    and context["kind"] == "snapshot_json"):
                raise OSError("synthetic snapshot metadata failure")

        for label, hook in (
            ("hash", corrupt_after_write),
            ("finalize", fail_finalize),
            ("write", fail_metadata_open),
        ):
            failing_tx = self._tx(
                codec_registry={"fixture_json": codec},
                filesystem_boundary_hook=hook,
            )
            failing_tx.prepare(self.staging_root / label)
            with self.assertRaises(self.pack.PackPreflightError):
                failing_tx.snapshot(self.snapshot_root)
            self.assertEqual(sibling.read_bytes(), b"keep")
            self.assertEqual(
                [path for path in self.snapshot_root.iterdir() if path != sibling], []
            )

    @unittest.skipUnless(os.name == "nt", "exact named staging unavailable")
    def test_snapshot_drift_at_each_file_capture_never_publishes_a_child(self):
        self._finish_setup()
        tx = self._tx()
        prepared = tx.prepare(self.staging_root)
        original_read = self.pack._read_bytes_or_none
        sibling = self.snapshot_root / "keep.bin"
        sibling.write_bytes(b"keep")

        for changed in prepared.file_changes:
            with self.subTest(root=changed["root"], path=changed["logical_path"]):
                def drift(path, target=changed["live_path"]):
                    raw = original_read(path)
                    return b"drift" if str(path) == target else raw

                with mock.patch.object(
                    self.pack, "_read_bytes_or_none", side_effect=drift
                ):
                    with self.assertRaises(self.pack.PackPreflightError):
                        tx.snapshot(self.snapshot_root)
                self.assertEqual(sibling.read_bytes(), b"keep")
                self.assertEqual(
                    [path for path in self.snapshot_root.iterdir() if path != sibling], []
                )

    def test_missing_client_base_requires_explicit_degraded_confirmation(self):
        self._finish_setup()
        blocked = self._tx(capabilities=()).preflight()
        self.assertFalse(blocked.can_prepare)
        warning = " ".join(item["message"] for item in blocked.capability_warnings)
        self.assertIn("pixel/cut-in matched visuals", warning)
        self.assertIn("cross-zone Unique persistence", warning)
        self.assertNotIn("full dual-form", blocked.delivery_status)
        with self.assertRaises(self.pack.PackPreflightError):
            self._tx(capabilities=()).prepare(self.staging_root)

        confirmed = self._tx(capabilities=(), degraded=True).preflight()
        self.assertTrue(confirmed.can_prepare)
        self.assertEqual(confirmed.delivery_status, "degraded_data_only")

    def test_rejects_unclaimed_table_changes_unknown_codec_and_extra_server_path(self):
        self._finish_setup()
        manifest = copy.deepcopy(self.manifest)
        table_entry = manifest["roots"]["common"][0]
        source = self.package_dir / "roots" / "common" / Path(*table_entry["logical_path"].split("/"))
        payload = json.loads(source.read_text(encoding="utf-8"))
        payload["outer"]["official"] = {"unexpected": True}
        data = json.dumps(payload, separators=(",", ":")).encode()
        source.write_bytes(data)
        table_entry["size"] = len(data)
        table_entry["sha256"] = hashlib.sha256(data).hexdigest()
        report = self._tx(manifest=manifest).preflight()
        self.assertTrue(any(item["kind"] == "unclaimed_change" for item in report.conflicts))

        unknown = copy.deepcopy(manifest)
        unknown["tables"][0]["codec_id"] = "unknown"
        with self.assertRaises(self.pack.PackPreflightError):
            self._tx(manifest=unknown).preflight()

        extra = copy.deepcopy(manifest)
        add_file(self.package_dir, extra, "server", "assets/extra.json", b"bad")
        with self.assertRaises(self.pack.PackPreflightError):
            self._tx(manifest=extra).preflight()

    def test_server_json_tables_require_explicit_claims_and_exact_four_files(self):
        self._finish_setup()
        missing_claim = copy.deepcopy(self.manifest)
        missing_claim["tables"] = [
            item for item in missing_claim["tables"]
            if not (item["root"] == "server"
                    and item["logical_path"] == self.SERVER_PATHS[0])
        ]
        with self.assertRaisesRegex(
            self.pack.PackPreflightError, "server tables must claim exactly"
        ):
            self._tx(manifest=missing_claim).preflight()

        missing_file = copy.deepcopy(self.manifest)
        missing_file["roots"]["server"] = [
            item for item in missing_file["roots"]["server"]
            if item["logical_path"] != self.SERVER_PATHS[0]
        ]
        with self.assertRaisesRegex(
            self.pack.PackPreflightError, "server root must contain exactly"
        ):
            self._tx(manifest=missing_file).preflight()

    def test_server_json_codec_rejects_malformed_and_duplicate_object_keys(self):
        self._finish_setup()
        logical_path = self.SERVER_PATHS[0]
        original = (
            self.package_dir / "roots" / "server"
            / Path(*logical_path.split("/"))
        ).read_bytes()
        cases = (
            b'{"outer":',
            b'{"outer":{"129999":1,"129999":2},"inner":{},"semantics":{}}',
        )
        for data in cases:
            with self.subTest(data=data):
                manifest = copy.deepcopy(self.manifest)
                self._set_package_bytes(manifest, "server", logical_path, data)
                with self.assertRaises(self.pack.PackPreflightError):
                    self._tx(manifest=manifest).preflight()
        self._set_package_bytes(self.manifest, "server", logical_path, original)

    def test_server_unowned_key_and_unrelated_record_diffs_fail_closed(self):
        self._finish_setup()
        logical_path = self.SERVER_PATHS[0]
        source = (
            self.package_dir / "roots" / "server"
            / Path(*logical_path.split("/"))
        )
        live = self.server / Path(*logical_path.split("/"))

        live.write_bytes(source.read_bytes())
        occupied = self._tx().preflight()
        self.assertIn(
            ("outer_key", f"{logical_path}:129999"),
            {(item["kind"], item["claim"]) for item in occupied.conflicts},
        )

        live_payload = json.loads(live.read_text(encoding="utf-8"))
        live_payload["outer"].pop("129999")
        live.write_text(json.dumps(live_payload, separators=(",", ":")), encoding="utf-8")
        original = source.read_bytes()
        for operation in ("add", "update", "delete"):
            with self.subTest(operation=operation):
                manifest = copy.deepcopy(self.manifest)
                payload = json.loads(original.decode("utf-8"))
                if operation == "add":
                    payload["outer"]["undeclared"] = {"unexpected": True}
                    expected_key = "undeclared"
                elif operation == "update":
                    payload["outer"]["official"] = {"unexpected": True}
                    expected_key = "official"
                else:
                    payload["outer"].pop("official")
                    expected_key = "official"
                data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
                self._set_package_bytes(manifest, "server", logical_path, data)
                report = self._tx(manifest=manifest).preflight()
                conflicts = {(item["kind"], item["claim"])
                             for item in report.conflicts}
                self.assertIn(
                    ("unclaimed_change", f"{logical_path}:{expected_key}"),
                    conflicts,
                )
        self._set_package_bytes(self.manifest, "server", logical_path, original)

    def test_duplicate_claims_and_overlapping_live_roots_fail_closed(self):
        self._finish_setup()
        duplicate = copy.deepcopy(self.manifest)
        duplicate["tables"][0]["outer_keys"].append("129999")
        with self.assertRaises(self.pack.PackPreflightError):
            self._tx(manifest=duplicate).preflight()

        overlapping = self.pack.LiveRoots(
            common=self.common,
            medium=self.common,
            android=self.android,
            server=self.server,
            protected=(self.active_dir,),
        )
        tx = self.pack.PackTransaction(
            self.package_dir,
            self.manifest,
            live_roots=overlapping,
            release_base_provider=self.provider,
            codec_registry={"fixture_json": _JsonFixtureCodec(self.pack)},
            available_capabilities=("dual_form_v1",),
            snapshot_roots=(self.snapshot_root,),
        )
        with self.assertRaises(self.pack.PackPreflightError):
            tx.preflight()

    def test_builtin_codecs_inspect_flat_raw_action_and_switched_tables(self):
        self._finish_setup()
        import wf_mod_tool as core

        flat_raw = core.build_orderedmap(core.OrderedMap(
            "master/test_flat.orderedmap", ["k"], [b"value"], Path("<memory>")
        ))
        flat_claim = self.pack.TableClaim(
            "common", "master/test_flat.orderedmap", "flat", ("k",)
        )
        self.assertEqual(
            self.pack.DEFAULT_CODECS["flat"].inspect(flat_raw, flat_claim, ()).outer_rows,
            (("k", b"value"),),
        )

        raw_payload = b"raw-outer-row"
        raw_table = core.build_orderedmap_raw_rows(core.OrderedMap(
            "master/test_raw.orderedmap", ["k"], [raw_payload], Path("<memory>")
        ))
        raw_claim = self.pack.TableClaim(
            "common", "master/test_raw.orderedmap", "raw_outer", ("k",)
        )
        self.assertEqual(
            self.pack.DEFAULT_CODECS["raw_outer"].inspect(
                raw_table, raw_claim, ()
            ).outer_rows,
            (("k", raw_payload),),
        )

        nested_cases = (
            (core.ACTION_SKILL_LOGICAL, "action_nested", b"n,d,a,0,0,0,0,program"),
            (core.SWITCHED_ACTION_SKILL_LOGICAL, "switched_nested", b"program"),
        )
        for logical_path, codec_id, row in nested_cases:
            with self.subTest(codec=codec_id):
                inner = core.OrderedMap(
                    f"{logical_path}#skill", ["1"], [row], Path("<memory>")
                )
                nested = core.NestedOrderedMap(logical_path, {"skill": inner})
                raw = core.build_nested_table(nested, logical_path)
                claim = self.pack.TableClaim(
                    "common", logical_path, codec_id, ("skill",),
                    (("skill", ("1",)),)
                )
                image = self.pack.DEFAULT_CODECS[codec_id].inspect(raw, claim, ())
                self.assertEqual(image.inner_rows, (("skill", "1", row),))

    def test_same_package_id_does_not_own_a_newly_claimed_occupied_key(self):
        installed, installed_dir = self._installed_copy()
        installed["tables"][0]["outer_keys"].remove("129999")
        installed["tables"][0]["semantic_claims"] = []
        installed_hash = hashlib.sha256(
            self.pack.canonical_manifest_bytes(installed)
        ).hexdigest()
        self._finish_setup(active_manifest_hash=installed_hash)
        self._occupy_claims()
        report = self._tx(
            installed_manifest=installed,
            installed_package_dir=installed_dir,
        ).preflight()
        claims = {(item["kind"], item["claim"]) for item in report.conflicts}
        self.assertIn(("outer_key", "master/character.orderedmap:129999"), claims)
        self.assertIn(("semantic", "character_code_name:seris_dragon_king"), claims)

    @unittest.skipUnless(os.name == "nt", "exact named staging unavailable")
    def test_omitted_prior_claim_is_delete_only_when_payload_removes_it(self):
        installed, installed_dir = self._installed_copy()
        installed_hash = hashlib.sha256(
            self.pack.canonical_manifest_bytes(installed)
        ).hexdigest()
        self._finish_setup(active_manifest_hash=installed_hash)
        self._occupy_claims()

        candidate = copy.deepcopy(self.manifest)
        candidate["tables"][0]["outer_keys"].remove("129999")
        candidate["tables"][0]["semantic_claims"] = []
        action_claim = next(
            item for item in candidate["tables"]
            if item["logical_path"] == "master/action.orderedmap"
        )
        action_claim["inner_keys"][0]["keys"].remove("2")
        with self.assertRaises(self.pack.PackPreflightError):
            self._tx(
                manifest=candidate,
                installed_manifest=installed,
                installed_package_dir=installed_dir,
            ).preflight()

        entry = next(
            item for item in candidate["roots"]["common"]
            if item["logical_path"] == "master/character.orderedmap"
        )
        source = self.package_dir / "roots" / "common" / "master" / "character.orderedmap"
        payload = json.loads(source.read_text(encoding="utf-8"))
        del payload["outer"]["129999"]
        del payload["semantics"]["character_id"]
        del payload["semantics"]["character_code_name"]
        data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        source.write_bytes(data)
        entry["size"] = len(data)
        entry["sha256"] = hashlib.sha256(data).hexdigest()

        action_entry = next(
            item for item in candidate["roots"]["common"]
            if item["logical_path"] == "master/action.orderedmap"
        )
        action_source = self.package_dir / "roots" / "common" / "master" / "action.orderedmap"
        action_payload = json.loads(action_source.read_text(encoding="utf-8"))
        del action_payload["inner"]["seris_human"]["2"]
        action_data = json.dumps(action_payload, separators=(",", ":")).encode("utf-8")
        action_source.write_bytes(action_data)
        action_entry["size"] = len(action_data)
        action_entry["sha256"] = hashlib.sha256(action_data).hexdigest()

        report = self._tx(
            manifest=candidate,
            installed_manifest=installed,
            installed_package_dir=installed_dir,
        ).preflight()
        delete_claims = {(item["kind"], item["claim"]) for item in report.deletes}
        self.assertIn(
            ("outer", "common:master/character.orderedmap:129999"), delete_claims
        )
        self.assertIn(
            ("semantic", "character_code_name:seris_dragon_king"), delete_claims
        )
        self.assertIn(
            ("inner", "common:master/action.orderedmap:seris_human/2"), delete_claims
        )
        deleted_keys = {
            (item["kind"], item.get("outer_key"), item.get("inner_key"),
             item.get("namespace"))
            for item in self._tx(
                manifest=candidate,
                installed_manifest=installed,
                installed_package_dir=installed_dir,
            ).prepare(self.staging_root).table_key_changes
            if item["operation"] == "delete"
        }
        self.assertIn(("outer", "129999", None, None), deleted_keys)
        self.assertIn(("semantic", None, None, "character_code_name"), deleted_keys)
        self.assertIn(("inner", "seris_human", "2", None), deleted_keys)

    def test_filtering_codec_uses_candidate_and_installed_claim_union_for_deletes(self):
        installed, installed_dir = self._installed_copy()
        installed_hash = hashlib.sha256(
            self.pack.canonical_manifest_bytes(installed)
        ).hexdigest()
        self._finish_setup(active_manifest_hash=installed_hash)
        self._occupy_claims()
        candidate = copy.deepcopy(self.manifest)
        character_claim = candidate["tables"][0]
        character_claim["outer_keys"].remove("129999")
        character_claim["semantic_claims"] = [
            item for item in character_claim["semantic_claims"]
            if item["namespace"] != "character_code_name"
        ]
        action_claim = next(
            item for item in candidate["tables"]
            if item["logical_path"] == "master/action.orderedmap"
        )
        action_claim["inner_keys"][0]["keys"].remove("2")
        registry = {"fixture_json": _FilteringJsonFixtureCodec(self.pack)}

        with self.assertRaises(self.pack.PackPreflightError):
            self._tx(
                manifest=candidate,
                installed_manifest=installed,
                installed_package_dir=installed_dir,
                codec_registry=registry,
            ).preflight()

        changes = (
            ("master/character.orderedmap", lambda payload: (
                payload["outer"].pop("129999"),
                payload["semantics"]["character_code_name"].remove(
                    "seris_dragon_king"
                ),
            )),
            ("master/action.orderedmap", lambda payload: (
                payload["inner"]["seris_human"].pop("2"),
            )),
        )
        for logical_path, mutate in changes:
            entry = next(
                item for item in candidate["roots"]["common"]
                if item["logical_path"] == logical_path
            )
            source = self.package_dir / "roots" / "common" / Path(
                *logical_path.split("/")
            )
            payload = json.loads(source.read_text(encoding="utf-8"))
            mutate(payload)
            data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
            source.write_bytes(data)
            entry["size"] = len(data)
            entry["sha256"] = hashlib.sha256(data).hexdigest()

        report = self._tx(
            manifest=candidate,
            installed_manifest=installed,
            installed_package_dir=installed_dir,
            codec_registry=registry,
        ).preflight()
        deletes = {(item["kind"], item["claim"]) for item in report.deletes}
        self.assertIn(("outer", "common:master/character.orderedmap:129999"), deletes)
        self.assertIn(("inner", "common:master/action.orderedmap:seris_human/2"), deletes)
        self.assertIn(
            ("semantic", "character_code_name:seris_dragon_king"), deletes
        )

    def test_absent_active_state_cannot_carry_installed_ownership(self):
        self._require_api()
        installed, installed_dir = self._installed_copy()
        installed_hash = hashlib.sha256(
            self.pack.canonical_manifest_bytes(installed)
        ).hexdigest()
        absent = self.pack.ReleaseBaseState(
            None, None, None, "1.4.54", "1.4.54", installed_hash
        )
        with self.assertRaises(self.pack.PackPreflightError):
            self._tx(
                provider=_FakeReleaseBaseProvider(absent),
                installed_manifest=installed,
                installed_package_dir=installed_dir,
            ).preflight()


class TestOwnedFilesystemPlatformContract(unittest.TestCase):
    def setUp(self):
        self.pack = importlib.import_module("wf_character_pack")

    def test_posix_named_staging_is_explicitly_unsupported(self):
        self.assertFalse(
            self.pack._OwnedFilesystem.POSIX_EXACT_NAMED_STAGING_SUPPORTED
        )

    def test_posix_cleanup_closes_authority_and_never_deletes_a_name(self):
        owned = mock.Mock()
        owned.closed = False
        owned.identity = (1, 2, 3)
        directory = mock.Mock()
        directory.closed = False
        directory.path = Path("owned-orphan")
        directory.handle = 12
        directory.name = "owned-orphan"
        directory.files = {"payload": owned}
        root = mock.Mock()
        root.closed = False
        root.handle = 11

        owned_fs = object.__new__(self.pack._OwnedFilesystem)
        owned_fs.windows = False
        owned_fs.hook = None
        owned_fs.root = root
        owned_fs.children = [directory]

        def close_file(value):
            value.closed = True

        def close_directory(value):
            value.closed = True

        stat_result = mock.Mock(st_dev=1, st_ino=2, st_mode=3)
        with (
            mock.patch.object(owned_fs, "_close_file", side_effect=close_file),
            mock.patch.object(
                owned_fs, "_close_directory", side_effect=close_directory
            ),
            mock.patch.object(
                os, "listdir", return_value=["payload"]
            ) as listdir,
            mock.patch.object(os, "stat", return_value=stat_result) as stat,
            mock.patch.object(os, "unlink") as unlink,
            mock.patch.object(os, "rmdir") as rmdir,
        ):
            with self.assertRaisesRegex(
                self.pack.PackStagingError,
                "exact POSIX cleanup unavailable.*owned orphan retained",
            ):
                owned_fs.delete_directory(directory, "posix_cleanup")

        unlink.assert_not_called()
        rmdir.assert_not_called()
        listdir.assert_not_called()
        stat.assert_not_called()
        self.assertTrue(owned.closed)
        self.assertTrue(directory.closed)
        self.assertTrue(root.closed)


@unittest.skipUnless(os.name != "nt", "POSIX fail-closed contract")
class TestPosixStagingFailClosed(_TransactionFixtureMixin, unittest.TestCase):
    def test_prepare_fails_before_owned_output_and_preserves_every_tree(self):
        self._finish_setup()
        self.staging_root.mkdir()
        unrelated = self.staging_root / "unrelated.bin"
        unrelated.write_bytes(b"preserve")
        protected_before = self._protected_trees()
        boundary_events = []

        tx = self._tx(
            filesystem_boundary_hook=lambda event, context: boundary_events.append(
                (event, context.get("kind"))
            )
        )
        with self.assertRaisesRegex(
            self.pack.PackPreflightError,
            "POSIX exact named staging unavailable.*no owned output was written",
        ):
            tx.prepare(self.staging_root)

        self.assertEqual(boundary_events, [])
        self.assertEqual(unrelated.read_bytes(), b"preserve")
        self.assertEqual(
            {path.name for path in self.staging_root.iterdir()},
            {"unrelated.bin"},
        )
        self.assertEqual(self._protected_trees(), protected_before)


@unittest.skipUnless(os.name == "nt", "exact named staging unavailable")
class TestPackStagingRecovery(_TransactionFixtureMixin, unittest.TestCase):
    @unittest.skipUnless(os.name == "nt", "Windows handle-sharing contract")
    def test_windows_owned_output_open_modes_are_split_and_defensive(self):
        self._finish_setup()
        api = self.pack._WIN_OWNED_API
        self.assertIsNotNone(api)

        retained = api.relative_open_contract("retained_output")
        identity = api.relative_open_contract("identity_reopen")
        cleanup = api.relative_open_contract("cleanup_delete_reopen")

        self.assertTrue(retained.access & api.FILE_READ_DATA)
        self.assertTrue(retained.access & api.FILE_WRITE_DATA)
        self.assertFalse(retained.access & api.DELETE)
        self.assertEqual(retained.share, api.FILE_SHARE_READ)
        self.assertEqual(retained.disposition, api.FILE_CREATE)

        self.assertEqual(
            identity.access,
            api.FILE_READ_ATTRIBUTES | api.SYNCHRONIZE,
        )
        self.assertTrue(identity.share & api.FILE_SHARE_READ)
        self.assertTrue(identity.share & api.FILE_SHARE_WRITE)
        self.assertFalse(identity.share & api.FILE_SHARE_DELETE)
        self.assertEqual(identity.disposition, api.FILE_OPEN)

        self.assertTrue(cleanup.access & api.DELETE)
        self.assertTrue(cleanup.access & api.FILE_READ_ATTRIBUTES)
        self.assertFalse(cleanup.access & api.FILE_WRITE_DATA)
        self.assertFalse(cleanup.share & api.FILE_SHARE_WRITE)
        self.assertFalse(cleanup.share & api.FILE_SHARE_DELETE)
        self.assertEqual(cleanup.disposition, api.FILE_OPEN)

        for method in (
            "create_retained_output",
            "reopen_output_identity",
            "reopen_output_cleanup",
        ):
            self.assertTrue(callable(getattr(api, method, None)), method)

    @unittest.skipUnless(os.name == "nt", "Windows handle-sharing contract")
    def test_windows_output_name_is_locked_through_final_readback(self):
        self._finish_setup()
        moved = self.root / "retained-output-moved"
        observed = {"hook": False}

        def hook(event, context):
            if (event == "before_output_verify"
                    and context["kind"] == "prepare_marker"):
                observed["hook"] = True
                authority = context["authority"]
                with self.assertRaises(OSError):
                    with open(context["path"], "r+b"):
                        pass
                with self.assertRaises(OSError):
                    os.rename(context["path"], moved)
                authority.validate()
                self.assertEqual(
                    authority.owner._identity(
                        authority.handle, directory=False
                    ),
                    authority.identity,
                )

        tx = self._tx(filesystem_boundary_hook=hook)
        prepared = tx.prepare(self.staging_root)
        staged = tx.materialize_staging(prepared)
        self.assertTrue(observed["hook"])
        self.assertFalse(moved.exists())
        tx.discard_staging(staged)

    def _hardlink_boundary_hook(self, target_kind, sentinel):
        fired = {"value": False}

        def hook(event, context):
            if (event == "before_output_open"
                    and context["kind"] == target_kind
                    and not fired["value"]):
                fired["value"] = True
                os.link(sentinel, context["path"])

        return hook, fired

    def test_owned_prepare_outputs_never_open_a_changed_pathname(self):
        self._finish_setup()
        for kind in ("prepare_marker", "prepare_metadata"):
            with self.subTest(kind=kind):
                sentinel = self.root / f"unrelated-{kind}.bin"
                sentinel.write_bytes(b"preserve")
                before = self._protected_trees()
                hook, fired = self._hardlink_boundary_hook(kind, sentinel)
                tx = self._tx(filesystem_boundary_hook=hook)
                with self.assertRaises(self.pack.PackPreflightError):
                    tx.prepare(self.staging_root / kind)
                self.assertTrue(fired["value"])
                self.assertEqual(sentinel.read_bytes(), b"preserve")
                self.assertEqual(self._protected_trees(), before)

    def test_owned_materialization_outputs_never_open_a_changed_pathname(self):
        self._finish_setup()
        for kind in ("payload_table", "payload_asset", "provisional_zip"):
            with self.subTest(kind=kind):
                sentinel = self.root / f"unrelated-{kind}.bin"
                sentinel.write_bytes(b"preserve")
                before = self._protected_trees()
                hook, fired = self._hardlink_boundary_hook(kind, sentinel)
                tx = self._tx(filesystem_boundary_hook=hook)
                prepared = tx.prepare(self.staging_root / kind)
                with self.assertRaises(self.pack.PackStagingError):
                    tx.materialize_staging(prepared)
                self.assertTrue(fired["value"])
                self.assertEqual(sentinel.read_bytes(), b"preserve")
                self.assertEqual(self._protected_trees(), before)

    def test_owned_snapshot_outputs_never_open_a_changed_pathname(self):
        self._finish_setup()
        for kind in ("snapshot_marker", "snapshot_file", "snapshot_json"):
            with self.subTest(kind=kind):
                sentinel = self.root / f"unrelated-{kind}.bin"
                sentinel.write_bytes(b"preserve")
                before = self._protected_trees()
                hook, fired = self._hardlink_boundary_hook(kind, sentinel)
                tx = self._tx(filesystem_boundary_hook=hook)
                tx.prepare(self.staging_root / kind)
                with self.assertRaises(self.pack.PackPreflightError):
                    tx.snapshot(self.snapshot_root / kind)
                self.assertTrue(fired["value"])
                self.assertEqual(sentinel.read_bytes(), b"preserve")
                self.assertEqual(self._protected_trees(), before)

    def test_snapshot_finalize_uses_exact_owned_directory_authority(self):
        self._finish_setup()
        unrelated = self.root / "unrelated-finalize-tree"
        unrelated.mkdir()
        sentinel = unrelated / "sentinel.bin"
        sentinel.write_bytes(b"preserve")
        protected_before = self._protected_trees()
        owned_orphan = self.root / "owned-finalize-orphan"
        fired = False

        def hook(event, context):
            nonlocal fired
            if event == "before_finalize":
                fired = True
                os.rename(context["path"], owned_orphan)
                os.rename(unrelated, context["path"])

        tx = self._tx(filesystem_boundary_hook=hook)
        tx.prepare(self.staging_root / "finalize")
        with self.assertRaises(self.pack.PackPreflightError):
            tx.snapshot(self.snapshot_root / "finalize")
        self.assertTrue(fired)
        self.assertTrue(unrelated.is_dir())
        self.assertEqual(sentinel.read_bytes(), b"preserve")
        self.assertEqual(self._protected_trees(), protected_before)

    def test_cleanup_never_deletes_a_changed_pathname_occupant(self):
        self._finish_setup()
        for cleanup_kind, failure_kind, operation in (
            ("prepare_cleanup", "prepare_metadata", "prepare"),
            ("materialization_cleanup", "payload_asset", "materialize"),
            ("snapshot_cleanup", "snapshot_json", "snapshot"),
        ):
            with self.subTest(cleanup=cleanup_kind):
                unrelated = self.root / f"unrelated-{cleanup_kind}-tree"
                unrelated.mkdir()
                sentinel = unrelated / "sentinel.bin"
                sentinel.write_bytes(b"preserve")
                protected_before = self._protected_trees()
                owned_orphan = self.root / f"owned-{cleanup_kind}-orphan"
                fired = {"failure": False, "cleanup": False}

                def hook(event, context):
                    if (event == "before_output_open"
                            and context["kind"] == failure_kind):
                        fired["failure"] = True
                        raise OSError("synthetic owned output failure")
                    if (event == "before_cleanup_delete"
                            and context["kind"] == cleanup_kind):
                        fired["cleanup"] = True
                        owned_orphan.mkdir()
                        victim = next(
                            path for path in context["path"].iterdir()
                            if path.is_file()
                        )
                        os.rename(victim, owned_orphan / victim.name)
                        os.link(sentinel, victim)

                tx = self._tx(filesystem_boundary_hook=hook)
                staging = self.staging_root / cleanup_kind
                if operation == "prepare":
                    call = lambda: tx.prepare(staging)
                    error = self.pack.PackPreflightError
                else:
                    prepared = tx.prepare(staging)
                    if operation == "materialize":
                        call = lambda: tx.materialize_staging(prepared)
                        error = self.pack.PackStagingError
                    else:
                        call = lambda: tx.snapshot(
                            self.snapshot_root / cleanup_kind
                        )
                        error = self.pack.PackPreflightError
                with self.assertRaises(error):
                    call()
                self.assertTrue(fired["failure"])
                self.assertTrue(fired["cleanup"])
                self.assertTrue(unrelated.is_dir())
                self.assertEqual(sentinel.read_bytes(), b"preserve")
                self.assertEqual(self._protected_trees(), protected_before)

    def test_boundary_records_are_deeply_immutable_and_manifest_is_canonical_copied(self):
        self._finish_setup()
        caller_manifest = copy.deepcopy(self.manifest)
        tx = self._tx(manifest=caller_manifest)
        caller_manifest["package_id"] = "caller_mutated"
        caller_manifest["roots"]["medium"][0]["logical_path"] = "../../mutated"

        report = tx.preflight()
        self.assertEqual(report.package_id, "seris_dragon_king")
        prepared = tx.prepare(self.staging_root)
        staged = tx.materialize_staging(prepared)
        snapshot = tx.snapshot(self.snapshot_root)

        mutations = (
            lambda: report.expected_base_hashes.__setitem__("active_sha256", "f" * 64),
            lambda: report.creates[0].__setitem__("claim", "forged"),
            lambda: prepared.file_changes[0].__setitem__("logical_path", "../../escape"),
            lambda: prepared.table_key_changes[0].__setitem__("operation", "delete"),
            lambda: staged.staged_files[0].__setitem__("path", "forged"),
            lambda: staged.provisional_archives[0].__setitem__("members", ("forged",)),
            lambda: snapshot.file_before[0].__setitem__("bytes", b"forged"),
            lambda: snapshot.table_before[0].__setitem__("bytes", b"forged"),
        )
        for mutation in mutations:
            with self.subTest(mutation=mutation), self.assertRaises(
                (AttributeError, TypeError)
            ):
                mutation()
        self.assertRegex(prepared.prepared_digest, r"^[0-9a-f]{64}$")

    def test_mutated_prepared_record_cannot_escape_owned_transaction_child(self):
        self._finish_setup()
        tx = self._tx()
        prepared = tx.prepare(self.staging_root)
        medium = next(
            item for item in prepared.file_changes if item["root"] == "medium"
        )
        escaped = self.root / "prepared-mutability-escape.bin"
        with self.assertRaises((AttributeError, TypeError)):
            medium["logical_path"] = "../../../../prepared-mutability-escape.bin"
        forged_changes = list(prepared.file_changes)
        index = forged_changes.index(medium)
        forged_changes[index] = {
            **dict(medium),
            "logical_path": "../../../../prepared-mutability-escape.bin",
        }
        forged = dataclasses.replace(prepared, file_changes=tuple(forged_changes))
        with self.assertRaises(self.pack.PackStagingError):
            tx.materialize_staging(forged, fail_after="asset_copy")
        self.assertFalse(escaped.exists(), "mutated plan escaped the owned child")

    def test_same_transaction_forged_sibling_is_never_deleted(self):
        self._finish_setup()
        tx = self._tx()
        prepared = tx.prepare(self.staging_root)
        staged = tx.materialize_staging(prepared)
        marker = (staged.transaction_dir / self.pack.TRANSACTION_MARKER).read_bytes()
        sibling = self.staging_root / "unrelated-sibling"
        sibling.mkdir()
        (sibling / self.pack.TRANSACTION_MARKER).write_bytes(marker)
        sentinel = sibling / "sentinel.bin"
        sentinel.write_bytes(b"preserve")
        forged = dataclasses.replace(staged, transaction_dir=sibling)

        with self.assertRaises(self.pack.PackStagingError):
            tx.discard_staging(forged)
        self.assertEqual(sentinel.read_bytes(), b"preserve")
        self.assertTrue(sibling.exists())

    def test_discard_tombstone_never_deletes_recreated_transaction_directory(self):
        self._finish_setup()
        tx = self._tx()
        prepared = tx.prepare(self.staging_root)
        staged = tx.materialize_staging(prepared)
        marker = (staged.transaction_dir / self.pack.TRANSACTION_MARKER).read_bytes()
        transaction_dir = staged.transaction_dir
        tx.discard_staging(staged)
        transaction_dir.mkdir()
        (transaction_dir / self.pack.TRANSACTION_MARKER).write_bytes(marker)
        sentinel = transaction_dir / "recreated.bin"
        sentinel.write_bytes(b"must-survive")

        tx.discard_staging(staged)
        self.assertEqual(sentinel.read_bytes(), b"must-survive")
        self.assertTrue(transaction_dir.exists())

    def test_replacing_staging_root_with_link_preserves_unrelated_target(self):
        self._finish_setup()
        tx = self._tx()
        prepared = tx.prepare(self.staging_root)
        staged = tx.materialize_staging(prepared)
        moved_root = self.root / "original-staging-moved"
        target = self.root / "replacement-target"
        target.mkdir()
        sentinel = target / "target.bin"
        sentinel.write_bytes(b"must-survive")
        with self.assertRaises(OSError):
            os.rename(self.staging_root, moved_root)
        tx.discard_staging(staged)
        self.assertEqual(sentinel.read_bytes(), b"must-survive")
        self.assertTrue(target.exists())

    def test_replacing_owned_child_with_link_preserves_unrelated_target(self):
        self._finish_setup()
        tx = self._tx()
        prepared = tx.prepare(self.staging_root)
        staged = tx.materialize_staging(prepared)
        moved_child = self.root / "owned-child-moved"
        target = self.root / "unrelated-child-target"
        target.mkdir()
        sentinel = target / "must-survive.bin"
        sentinel.write_bytes(b"preserve")
        with self.assertRaises(OSError):
            os.rename(staged.transaction_dir, moved_child)
        tx.discard_staging(staged)
        self.assertEqual(sentinel.read_bytes(), b"preserve")
        self.assertTrue(target.exists())

    def test_each_materialization_failpoint_cleans_only_owned_child(self):
        self._finish_setup()
        before = {
            root: self._tree_bytes(path) for root, path in {
                "common": self.common, "medium": self.medium,
                "android": self.android, "server": self.server,
                "active": self.active_dir,
            }.items()
        }
        for failpoint in (
            "table_materialization", "asset_copy", "readback",
            "hash_verification", "provisional_zip_content",
        ):
            with self.subTest(failpoint=failpoint):
                tx = self._tx()
                prepared = tx.prepare(self.staging_root)
                sibling = self.staging_root / "keep.txt"
                sibling.write_bytes(b"keep")
                with self.assertRaises(self.pack.PackStagingError):
                    tx.materialize_staging(prepared, fail_after=failpoint)
                self.assertFalse(prepared.transaction_dir.exists())
                self.assertEqual(sibling.read_bytes(), b"keep")
                for root, path in {
                    "common": self.common, "medium": self.medium,
                    "android": self.android, "server": self.server,
                    "active": self.active_dir,
                }.items():
                    self.assertEqual(self._tree_bytes(path), before[root])
                self.assertEqual(self.provider.state.active_raw, self._active_raw)

    def test_concurrent_payload_link_injection_never_writes_or_deletes_target(self):
        self._finish_setup()
        target = self.root / "concurrent-link-target"
        target.mkdir()
        sentinel = target / "sentinel.bin"
        sentinel.write_bytes(b"preserve")
        injected = False
        moved = self.root / "concurrent-owned-moved"

        def inject_link(event, context):
            nonlocal injected
            if (not injected and event == "before_output_open"
                    and context["kind"] == "payload_asset"):
                injected = True
                os.rename(prepared.transaction_dir, moved)

        tx = self._tx(filesystem_boundary_hook=inject_link)
        prepared = tx.prepare(self.staging_root)
        with self.assertRaises(self.pack.PackStagingError):
            tx.materialize_staging(prepared)
        self.assertTrue(injected)
        self.assertEqual(sentinel.read_bytes(), b"preserve")
        self.assertEqual(self._tree_bytes(target), {"sentinel.bin": b"preserve"})

    def test_successful_materialization_reads_tables_and_builds_three_generic_archives(self):
        self._finish_setup()
        tx = self._tx()
        prepared = tx.prepare(self.staging_root)
        staged = tx.materialize_staging(prepared)
        self.assertEqual(staged.transaction_id, prepared.transaction_id)
        self.assertEqual(len(staged.table_readback), len(self.manifest["tables"]))
        self.assertEqual(
            {item["logical_path"] for item in staged.table_readback
             if item["root"] == "server"},
            set(self.SERVER_PATHS),
        )
        for item in staged.table_readback:
            if item["root"] == "server":
                self.assertIn("129999", item["outer_keys"])
        self.assertEqual(
            [item["root"] for item in staged.provisional_archives],
            ["common", "medium", "android"],
        )
        for item in staged.provisional_archives:
            self.assertNotIn("version", item)
            self.assertNotIn("release_id", item)
            self.assertTrue(Path(item["path"]).is_relative_to(prepared.transaction_dir))
            prefix = {
                "common": "production/upload/",
                "medium": "production/medium_upload/",
                "android": "production/android_upload/",
            }[item["root"]]
            self.assertTrue(all(member.startswith(prefix) for member in item["members"]))
        import wf_mod_tool as core
        for item in prepared.file_changes:
            if item["root"] in ("common", "medium", "android"):
                expected = core.table_path(
                    {"common": self.common, "medium": self.medium,
                     "android": self.android}[item["root"]],
                    item["logical_path"],
                )
                self.assertEqual(Path(item["live_path"]), expected)
        tx.discard_staging(staged)
        self.assertFalse(prepared.transaction_dir.exists())
        tx.discard_staging(staged)  # safe/idempotent

    def test_source_toctou_is_detected_and_cleans_staging(self):
        self._finish_setup()
        tx = self._tx()
        prepared = tx.prepare(self.staging_root)
        entry = self.manifest["roots"]["medium"][0]
        source = self.package_dir / "roots" / "medium" / Path(*entry["logical_path"].split("/"))
        source.write_bytes(b"changed-after-prepare")
        with self.assertRaises(self.pack.PackStagingError):
            tx.materialize_staging(prepared)
        self.assertFalse(prepared.transaction_dir.exists())

    def test_protected_overlap_and_forged_or_cross_transaction_cleanup_fail_closed(self):
        self._finish_setup()
        tx = self._tx()
        for unsafe in (self.package_dir, self.common, self.server, self.active_dir,
                       self.snapshot_root):
            with self.subTest(unsafe=unsafe), self.assertRaises(self.pack.PackPreflightError):
                tx.prepare(unsafe)

        prepared = tx.prepare(self.staging_root)
        staged = tx.materialize_staging(prepared)
        marker = staged.transaction_dir / ".character-pack-transaction.json"
        with self.assertRaises(OSError):
            marker.write_text('{"transaction_id":"forged"}', encoding="utf-8")
        authority = tx._transactions[prepared.transaction_id]
        authority.marker_file.write_bytes(b'{"transaction_id":"forged"}')
        with self.assertRaises(self.pack.PackStagingError):
            tx.discard_staging(staged)
        self.assertTrue(staged.transaction_dir.exists())

    def test_staging_root_link_and_cross_transaction_discard_are_rejected(self):
        self._finish_setup()
        target = self.root / "linked-staging-target"
        target.mkdir()
        link = self.root / "linked-staging"
        make_directory_link(link, target)
        with self.assertRaises(self.pack.PackPreflightError):
            self._tx().prepare(link)
        with self.assertRaises(self.pack.PackPreflightError):
            self._tx().prepare(link / "new-child")

        first = self._tx()
        first_prepared = first.prepare(self.staging_root)
        first_staged = first.materialize_staging(first_prepared)
        second = self._tx()
        with self.assertRaises(self.pack.PackStagingError):
            second.discard_staging(first_staged)
        self.assertTrue(first_staged.transaction_dir.exists())
        first.discard_staging(first_staged)

    def test_snapshot_refuses_release_or_live_drift(self):
        self._finish_setup()
        tx = self._tx()
        tx.prepare(self.staging_root)
        changed_raw = b'{"release_id":"changed"}'
        self.provider.state = self.pack.ReleaseBaseState(
            changed_raw, hashlib.sha256(changed_raw).hexdigest(), "changed",
            "1.4.55", "1.4.55", None,
        )
        with self.assertRaises(self.pack.PackPreflightError):
            tx.snapshot(self.snapshot_root)



if __name__ == "__main__":
    unittest.main(verbosity=2)
