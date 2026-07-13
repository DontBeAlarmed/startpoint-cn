# -*- coding: utf-8 -*-
"""Character-package manifest contract tests (temporary directories only)."""
from __future__ import annotations

import copy
import hashlib
import importlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

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
        file_schema = roots["properties"]["common"]["items"]
        self.assertFalse(file_schema["additionalProperties"])
        self.assertEqual(set(file_schema["required"]), {"logical_path", "sha256", "size"})

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
