# -*- coding: utf-8 -*-
"""Character-package manifest contract tests (temporary directories only)."""
from __future__ import annotations

import copy
import hashlib
import importlib
import json
import os
import re
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
