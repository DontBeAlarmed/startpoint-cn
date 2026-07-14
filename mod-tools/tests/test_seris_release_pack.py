# -*- coding: utf-8 -*-
from __future__ import annotations

import hashlib
import importlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def _canonical(value: object) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def _entry(path: str, raw: bytes) -> dict[str, object]:
    return {
        "logical_path": path,
        "sha256": hashlib.sha256(raw).hexdigest(),
        "size": len(raw),
    }


def _minimal_cbr_mp3_frame() -> bytes:
    # MPEG-1 Layer III, 128 kbps, 44.1 kHz: one 417-byte frame.
    return bytes.fromhex("fffb9064") + bytes(413)


def _write_offline_fixture(root: Path) -> Path:
    package = root / "offline"
    roots: dict[str, list[dict[str, object]]] = {
        "common": [], "medium": [], "android": [], "server": [],
    }
    payloads = {
        "common": {
            "master/character/character.orderedmap": b"table-bytes",
            "master/character/character_status.orderedmap": b"recursive-table-bytes",
            "character/seris_dragon_king/voice/ally/join.mp3": _minimal_cbr_mp3_frame(),
        },
        "medium": {
            "character/seris_dragon_king/ui/square_0.png": (
                bytes.fromhex("89504e470d0a1a0a") + b"png-payload"
            )
        },
        "android": {
            "character/seris_dragon_king/ui/skill_cutin_0.atf.deflate": b"atf"
        },
        "server": {
            "cdndata/character.json": _canonical({"129999": [["row"]]}),
            "cdndata/character_text.json": _canonical({"129999": [["text"]]}),
            "character.json": _canonical({"129999": {"name": "赛瑞斯"}}),
            "mana_node.json": _canonical({"129999": {"1": {}}}),
        },
    }
    for root_name, files in payloads.items():
        for logical, raw in files.items():
            path = package / "roots" / root_name / Path(*logical.split("/"))
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
            roots[root_name].append(_entry(logical, raw))
    qa_raw = _canonical({"offline_validation_status": "pass"})
    (package / "qa").mkdir(parents=True)
    (package / "qa" / "index.json").write_bytes(qa_raw)
    manifest = {
        "format": "seris-offline-handoff/v1",
        "schema_version": 1,
        "artifact_kind": "offline_handoff",
        "status": "offline_validated_awaiting_user_runtime_test",
        "package_id": "seris_dragon_king",
        "package_version": "1.0.0",
        "character_id": "129999",
        "code_name": "seris_dragon_king",
        "roots": roots,
        "tables": [
            {
                "root": "common",
                "logical_path": "master/character/character.orderedmap",
                "kind": "flat",
                "keys": ["129999"],
            },
            {
                "root": "common",
                "logical_path": "master/character/character_status.orderedmap",
                "kind": "recursive",
                "keys": ["129999"],
            },
        ],
        "skills": [],
        "unique_condition": {"id": "22"},
        "qa": [{
            "path": "qa/index.json",
            "sha256": hashlib.sha256(qa_raw).hexdigest(),
            "offline_status": "pass",
            "runtime_status": "not_required",
        }],
        "client_base": {
            "capability": "dual_form_v1",
            "installed": True,
            "candidate_b_sha256": "7" * 64,
        },
    }
    (package / "manifest.json").write_bytes(_canonical(manifest))
    return package


class TestSerisRuntimeTestPackage(unittest.TestCase):
    def _module(self):
        return importlib.import_module("wf_seris_release_pack")

    def test_requires_explicit_direct_real_test_confirmation(self):
        module = self._module()
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            offline = _write_offline_fixture(root)
            with self.assertRaisesRegex(module.ReleasePackError, "DIRECT_REAL_TEST"):
                module.assemble_runtime_test_package(
                    offline,
                    root / "formal",
                    git_head="a" * 40,
                    confirmation="yes",
                    offline_validator=lambda _path: [],
                )
            self.assertFalse((root / "formal").exists())

    def test_assembles_formal_manifest_and_exact_four_root_copy_atomically(self):
        module = self._module()
        character_pack = importlib.import_module("wf_character_pack")
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            offline = _write_offline_fixture(root)
            result = module.assemble_runtime_test_package(
                offline,
                root / "formal",
                git_head="b" * 40,
                confirmation="DIRECT_REAL_TEST",
                offline_validator=lambda _path: [],
            )
            manifest = json.loads((result.output_dir / "manifest.json").read_bytes())
            self.assertEqual([], character_pack.validate_manifest(manifest, result.output_dir))
            self.assertEqual("runtime_test", manifest["qa"]["delivery_mode"])
            self.assertFalse(manifest["qa"]["release_ready"])
            self.assertTrue(manifest["qa"]["user_authorized_direct_real_test"])
            self.assertEqual("dual_form_v1", manifest["requires_client_base"])
            self.assertEqual(129999, manifest["character_id"])
            self.assertEqual(
                hashlib.sha256((offline / "manifest.json").read_bytes()).hexdigest(),
                manifest["snapshot"]["offline_manifest_sha256"],
            )
            self.assertEqual(
                {name: len(manifest["roots"][name]) for name in module.ROOT_NAMES},
                dict(result.root_counts),
            )
            self.assertEqual(6, len(manifest["tables"]))
            self.assertEqual(
                "raw_outer",
                next(
                    item["codec_id"] for item in manifest["tables"]
                    if item["logical_path"]
                    == "master/character/character_status.orderedmap"
                ),
            )
            self.assertEqual(
                {
                    "cdndata/character.json",
                    "cdndata/character_text.json",
                    "character.json",
                    "mana_node.json",
                },
                {
                    item["logical_path"]
                    for item in manifest["tables"]
                    if item["root"] == "server"
                },
            )
            stored_png = (
                result.output_dir
                / "roots/medium/character/seris_dragon_king/ui/square_0.png"
            ).read_bytes()
            self.assertEqual(bytes.fromhex("89706e670d0a1a0a"), stored_png[:8])
            stored_mp3 = (
                result.output_dir
                / "roots/common/character/seris_dragon_king/voice/ally/join.mp3"
            ).read_bytes()
            self.assertEqual(0x7F, stored_mp3[0])
            untouched_atf = (
                result.output_dir
                / "roots/android/character/seris_dragon_king/ui/skill_cutin_0.atf.deflate"
            ).read_bytes()
            self.assertEqual(b"atf", untouched_atf)
            self.assertEqual([], module.validate_runtime_test_package(result.output_dir))
            self.assertFalse(any(result.output_dir.parent.glob(".formal.runtime-test-*")))

    def test_validator_rejects_tamper_and_undeclared_extra(self):
        module = self._module()
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            offline = _write_offline_fixture(root)
            result = module.assemble_runtime_test_package(
                offline,
                root / "formal",
                git_head="c" * 40,
                confirmation="DIRECT_REAL_TEST",
                offline_validator=lambda _path: [],
            )
            payload = result.output_dir / "roots" / "medium" / "extra.bin"
            payload.write_bytes(b"extra")
            errors = module.validate_runtime_test_package(result.output_dir)
            self.assertTrue(any("undeclared" in error for error in errors), errors)

    def test_validator_rejects_authoring_png_even_when_manifest_matches(self):
        module = self._module()
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            offline = _write_offline_fixture(root)
            result = module.assemble_runtime_test_package(
                offline,
                root / "formal",
                git_head="d" * 40,
                confirmation="DIRECT_REAL_TEST",
                offline_validator=lambda _path: [],
            )
            payload = (
                result.output_dir
                / "roots/medium/character/seris_dragon_king/ui/square_0.png"
            )
            raw = bytes.fromhex("89504e470d0a1a0a") + payload.read_bytes()[8:]
            payload.write_bytes(raw)
            manifest_path = result.output_dir / "manifest.json"
            manifest = json.loads(manifest_path.read_bytes())
            entry = next(
                item for item in manifest["roots"]["medium"]
                if item["logical_path"].endswith("/square_0.png")
            )
            entry["sha256"] = hashlib.sha256(raw).hexdigest()
            entry["size"] = len(raw)
            manifest_path.write_bytes(_canonical(manifest))
            errors = module.validate_runtime_test_package(result.output_dir)
            self.assertTrue(any("WF storage PNG" in error for error in errors), errors)

    def test_validator_rejects_authoring_mp3_even_when_manifest_matches(self):
        module = self._module()
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            offline = _write_offline_fixture(root)
            result = module.assemble_runtime_test_package(
                offline,
                root / "formal",
                git_head="e" * 40,
                confirmation="DIRECT_REAL_TEST",
                offline_validator=lambda _path: [],
            )
            payload = (
                result.output_dir
                / "roots/common/character/seris_dragon_king/voice/ally/join.mp3"
            )
            raw = _minimal_cbr_mp3_frame()
            payload.write_bytes(raw)
            manifest_path = result.output_dir / "manifest.json"
            manifest = json.loads(manifest_path.read_bytes())
            entry = next(
                item for item in manifest["roots"]["common"]
                if item["logical_path"].endswith("/join.mp3")
            )
            entry["sha256"] = hashlib.sha256(raw).hexdigest()
            entry["size"] = len(raw)
            manifest_path.write_bytes(_canonical(manifest))
            errors = module.validate_runtime_test_package(result.output_dir)
            self.assertTrue(any("WF storage MP3" in error for error in errors), errors)


if __name__ == "__main__":
    unittest.main()
