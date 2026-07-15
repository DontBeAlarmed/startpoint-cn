# -*- coding: utf-8 -*-
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from wf_asset_inventory import InventoryEntry
import wf_asset_policy as policy_module


def write_policy(root: Path, **overrides: object) -> Path:
    payload: dict[str, object] = {
        "schema_version": 1,
        "scan_roots": ["work"],
        "protected_roots": ["work/protected"],
        "backup_keep_latest": 3,
        "backup_markers": [".bak-wfmod-", ".bak-charfields-"],
        "auto_categories": [
            "exact_duplicate",
            "proven_regenerable",
            "stale_cache",
            "retention_expired",
        ],
        "stale_cache_directory_names": ["__pycache__", ".pytest_cache"],
        "stale_cache_suffixes": [".pyc", ".pyo"],
    }
    payload.update(overrides)
    target = root / "policy.json"
    target.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return target


def fake_entry(root: Path, relative: str, *, kind: str = "file", error: str | None = None) -> InventoryEntry:
    absolute = root / Path(relative.replace("/", os.sep))
    return InventoryEntry(
        root=root,
        absolute_path=absolute,
        relative_path=relative,
        kind=kind,
        size=7,
        sha256="a" * 64 if kind == "file" else None,
        mtime_ns=1,
        reparse=False,
        error=error,
    )


class AssetPolicyTests(unittest.TestCase):
    def test_unknown_and_live_referenced_override_cache_rules(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td).resolve()
            policy = policy_module.Policy.load(write_policy(root), repo_root=root)
            referenced = fake_entry(root, "work/active/__pycache__/needed.pyc")
            refs = policy_module.ReferenceIndex(paths={referenced.absolute_path})
            decision = policy_module.classify(referenced, refs, policy)
            self.assertEqual("live_referenced", decision.category)
            self.assertFalse(decision.auto_approved)

            unknown = fake_entry(root, "work/unclassified.bin")
            self.assertEqual("unknown", policy_module.classify(unknown, refs, policy).category)

    def test_classification_precedence_is_fixed(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td).resolve()
            policy = policy_module.Policy.load(write_policy(root), repo_root=root)
            refs = policy_module.ReferenceIndex()

            protected = fake_entry(root, "work/protected/__pycache__/x.pyc", kind="error", error="bad")
            self.assertEqual("protected", policy_module.classify(protected, refs, policy).category)

            corrupt = fake_entry(root, "work/cache/__pycache__/bad.pyc", kind="error", error="unreadable")
            self.assertEqual("corrupt", policy_module.classify(corrupt, refs, policy).category)

            duplicate = fake_entry(root, "work/duplicate.bin")
            self.assertEqual(
                "exact_duplicate",
                policy_module.classify(
                    duplicate,
                    refs,
                    policy,
                    exact_duplicates={duplicate.absolute_path: "sha256 match"},
                    proven_regenerable={duplicate.absolute_path: "generator"},
                ).category,
            )

            regenerated = fake_entry(root, "work/generated")
            self.assertEqual(
                "proven_regenerable",
                policy_module.classify(
                    regenerated,
                    refs,
                    policy,
                    proven_regenerable={regenerated.absolute_path: "generator and inputs verified"},
                ).category,
            )

            cache = fake_entry(root, "work/cache/__pycache__", kind="directory")
            cache_decision = policy_module.classify(cache, refs, policy)
            self.assertEqual("stale_cache", cache_decision.category)
            self.assertTrue(cache_decision.auto_approved)

    def test_backup_retention_keeps_latest_three_references_and_last_success(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            backups: list[Path] = []
            for index in range(6):
                item = root / f"character.json.bak-wfmod-{index:02d}"
                item.write_bytes(str(index).encode("ascii"))
                os.utime(item, ns=(index + 1, index + 1))
                backups.append(item)

            decisions = policy_module.classify_backup_group(
                backups,
                keep_latest=3,
                referenced={backups[0]},
                last_success=backups[1],
            )
            kept = {item.path for item in decisions if item.category == "protected"}
            expired = {item.path for item in decisions if item.category == "retention_expired"}
            self.assertTrue(set(backups[-3:]).issubset(kept))
            self.assertIn(backups[0], kept)
            self.assertIn(backups[1], kept)
            self.assertEqual({backups[2]}, expired)

    def test_policy_rejects_unknown_keys_and_quarantine_inside_scan_root(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td).resolve()
            unknown = write_policy(root, surprise=True)
            with self.assertRaisesRegex(policy_module.PolicyError, "unknown policy keys"):
                policy_module.Policy.load(unknown, repo_root=root)

            valid = write_policy(root)
            with self.assertRaisesRegex(policy_module.PolicyError, "quarantine"):
                policy_module.Policy.load(
                    valid,
                    repo_root=root,
                    quarantine_root=root / "work" / "quarantine",
                )

    def test_reference_index_collects_profiles_manifests_graph_and_pathlists(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td).resolve()
            store_file = root / "弹国服" / "WorldFlipper" / "upload" / "aa" / "hash"
            store_file.parent.mkdir(parents=True)
            store_file.write_bytes(b"store")
            profiles = root / "mod-tools" / "profiles.json"
            profiles.parent.mkdir(parents=True)
            profiles.write_text(
                json.dumps({"profiles": {"cn": {"store": "弹国服/WorldFlipper/upload"}}}, ensure_ascii=False),
                encoding="utf-8",
            )

            character_archive = root / ".cdn" / "cn" / "archive-common-diff" / "char.zip"
            character_archive.parent.mkdir(parents=True)
            character_archive.write_bytes(b"character")
            active = root / ".cdn" / "cn" / "character-releases" / "active.json"
            active.parent.mkdir(parents=True)
            active.write_text(
                json.dumps({
                    "base_version": "1.4.1",
                    "releases": [{"archives": [{"relative_path": "archive-common-diff/char.zip"}]}],
                }),
                encoding="utf-8",
            )

            patch_archive = root / "assets" / "asset-patch" / "active" / "patch.zip"
            patch_archive.parent.mkdir(parents=True)
            patch_archive.write_bytes(b"patch")
            graph = root / "graph.json"
            graph.write_text(
                json.dumps({
                    "edges": [{"archives": [{"relativePath": "asset-patch/active/patch.zip"}]}],
                }),
                encoding="utf-8",
            )
            pathlist = root / "mod-tools" / "WF_PATHLIST_recovered.csv"
            pathlist.write_text("path\n", encoding="utf-8")

            refs = policy_module.ReferenceIndex.from_project(root, graph)
            self.assertTrue(refs.is_referenced(store_file))
            self.assertTrue(refs.is_referenced(character_archive))
            self.assertTrue(refs.is_referenced(patch_archive))
            self.assertTrue(refs.is_referenced(pathlist))
            self.assertTrue(refs.is_referenced(active))


if __name__ == "__main__":
    unittest.main()
