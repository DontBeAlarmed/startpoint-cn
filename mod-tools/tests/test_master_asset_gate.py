# -*- coding: utf-8 -*-
"""master 表资产引用门禁测试(2026-07-16 unique_seris_wet F1009 事故回归)。

纯逻辑(提取/报告)与 flow 适配层都只用临时目录 + 合成 orderedmap/DSL,不碰真实 store。
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
import zlib
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import wf_character_flow as flow  # noqa: E402
import wf_character_requirements as requirements  # noqa: E402
import wf_character_workspace as workspace_module  # noqa: E402
import wf_dsl  # noqa: E402
import wf_mod_tool as core  # noqa: E402

INCIDENT_ICON = "battle/common/unique_condition/unique_seris_wet"
INCIDENT_ROW = "unique_seris_wet,湿润,battle/common/unique_condition/unique_seris_wet,1800,1"
EFFECT_REF = "battle/effect/skill_unique/seris_dragon_king/seris_dragon_king"


def flat_table_bytes(logical: str, rows: dict[str, str]) -> bytes:
    return core.build_orderedmap(core.OrderedMap(
        logical,
        list(rows),
        [text.encode("utf-8") for text in rows.values()],
        Path("<memory>"),
    ))


def nested_table_bytes(logical: str, outer: dict[str, dict[str, str]]) -> bytes:
    inner_blobs = [flat_table_bytes(logical, inner) for inner in outer.values()]
    return core.build_orderedmap_raw_rows(core.OrderedMap(
        logical, list(outer), inner_blobs, Path("<memory>"),
    ))


def dsl_file_bytes(tree) -> bytes:
    compressor = zlib.compressobj(9, zlib.DEFLATED, -15)
    return compressor.compress(wf_dsl.encode_amf3(tree)) + compressor.flush()


def sparse_row(assignments: dict[int, str], ncols: int = 126) -> str:
    row = [""] * ncols
    for index, value in assignments.items():
        row[index] = value
    return ",".join(row)


def put_package_file(package_dir: Path, logical: str, data: bytes) -> None:
    path = package_dir / "roots" / "common" / Path(*logical.split("/"))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def put_store_file(store: Path, logical: str, data: bytes = b"asset") -> None:
    path = core.table_path(store, logical)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def write_manifest(package_dir: Path, declared_common: list[str] = ()) -> None:
    manifest = {"roots": {
        "common": [
            {"logical_path": logical, "sha256": "0" * 64, "size": 1}
            for logical in declared_common
        ],
        "medium": [], "android": [], "server": [],
    }}
    package_dir.mkdir(parents=True, exist_ok=True)
    (package_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False), encoding="utf-8",
    )


class TestReferenceExtraction(unittest.TestCase):
    def test_unique_condition_id_columns_match_reversed_layout(self):
        self.assertEqual(
            (12, 19, 26, 37, 45, 68, 95, 104, 118),
            requirements.unique_condition_id_columns(
                "master/ability/ability.orderedmap"
            ),
        )
        self.assertEqual(
            (10, 17, 24, 35, 43, 66, 93, 102, 116),
            requirements.unique_condition_id_columns(
                "master/ability/leader_ability.orderedmap"
            ),
        )

    def test_extracts_icon_ability_ids_programs_and_effects(self):
        flat = {
            requirements.UNIQUE_CONDITION_TABLE: {"23": INCIDENT_ROW},
            # 列 68 = instant_content.unique_condition_id;列 12 前置块留 0 应忽略
            "master/ability/ability.orderedmap": {
                "1299991": sparse_row({12: "0", 68: "23"}),
            },
            # leader 头部少 2 列:列 66 = instant_content.unique_condition_id
            "master/ability/leader_ability.orderedmap": {
                "129999": sparse_row({66: "7"}, ncols=124),
            },
        }
        nested = {
            requirements.ACTION_SKILL_TABLE: {
                "seris_dragon_king": {
                    "1": sparse_row(
                        {7: "battle/action/skill/action/rare5/seris$seris_1"},
                        ncols=8,
                    ),
                },
            },
        }
        trees = {
            "battle/action/skill/action/rare5/seris$seris_1.action.dsl.amf3.deflate": [
                "Block",
                [["Command", ["ShowEffect", "全体演出",
                              ["SpecifyEffectDirectly", EFFECT_REF]]]],
            ],
        }

        references = requirements.extract_master_asset_references(flat, nested, trees)

        by_kind = {}
        for item in references:
            by_kind.setdefault(item.kind, []).append(item.value)
        self.assertEqual([INCIDENT_ICON], by_kind["unique_condition_icon"])
        self.assertEqual({"23", "7"}, set(by_kind["unique_condition_id"]))
        self.assertEqual(
            ["battle/action/skill/action/rare5/seris$seris_1"],
            by_kind["skill_program"],
        )
        self.assertEqual([EFFECT_REF], by_kind["skill_effect"])

    def test_duplicate_references_collapse_and_bare_prefix_is_ignored(self):
        flat = {requirements.UNIQUE_CONDITION_TABLE: {
            "23": INCIDENT_ROW,
            "24": "again,再次," + INCIDENT_ICON + ",1,1",
        }}
        trees = {"a.action.dsl.amf3.deflate": ["battle/effect/", "battle/effect/x"]}

        references = requirements.extract_master_asset_references(flat, None, trees)

        icons = [item for item in references if item.kind == "unique_condition_icon"]
        self.assertEqual(1, len(icons))
        self.assertEqual(f"{requirements.UNIQUE_CONDITION_TABLE}:23", icons[0].source)
        self.assertEqual(
            [], [item for item in references if item.kind == "skill_effect"],
            "缺目录/效果两段的 battle/effect/ 字符串不算特效引用",
        )

    def test_required_asset_paths_expand_per_kind(self):
        icon = requirements.MasterAssetReference(
            "unique_condition_icon", INCIDENT_ICON, "t:23",
        )
        self.assertEqual((INCIDENT_ICON + ".png",), requirements.required_asset_paths(icon))
        already_png = requirements.MasterAssetReference(
            "unique_condition_icon", INCIDENT_ICON + ".png", "t:23",
        )
        self.assertEqual(
            (INCIDENT_ICON + ".png",), requirements.required_asset_paths(already_png),
        )
        effect = requirements.MasterAssetReference("skill_effect", EFFECT_REF, "d")
        self.assertEqual(
            (
                EFFECT_REF + ".parts.amf3.deflate",
                EFFECT_REF + ".timeline.amf3.deflate",
                "battle/effect/skill_unique/seris_dragon_king/seris_dragon_king.png",
                "battle/effect/skill_unique/seris_dragon_king/"
                "seris_dragon_king.atlas.amf3.deflate",
            ),
            requirements.required_asset_paths(effect),
        )
        program = requirements.MasterAssetReference("skill_program", "a/b$c", "t")
        self.assertEqual(
            ("a/b$c.action.dsl.amf3.deflate",), requirements.required_asset_paths(program),
        )
        condition = requirements.MasterAssetReference("unique_condition_id", "23", "t")
        self.assertEqual((), requirements.required_asset_paths(condition))


class TestMasterReferenceReport(unittest.TestCase):
    def test_missing_everywhere_blocks_and_lists_each_path(self):
        references = (
            requirements.MasterAssetReference(
                "unique_condition_icon", INCIDENT_ICON,
                f"{requirements.UNIQUE_CONDITION_TABLE}:23",
            ),
            requirements.MasterAssetReference("unique_condition_id", "99", "a:1"),
        )

        report = requirements.build_master_reference_report(references)

        self.assertFalse(report["release_ready"])
        self.assertEqual(2, report["checked_references"])
        self.assertEqual(
            {INCIDENT_ICON + ".png", "99"},
            {item["missing"] for item in report["missing"]},
        )

    def test_package_declaration_or_store_hit_satisfies(self):
        references = (
            requirements.MasterAssetReference("unique_condition_icon", INCIDENT_ICON, "t:23"),
            requirements.MasterAssetReference("skill_program", "p/q", "t:1"),
            requirements.MasterAssetReference("unique_condition_id", "23", "a:1"),
            requirements.MasterAssetReference("unique_condition_id", "7", "a:2"),
        )

        report = requirements.build_master_reference_report(
            references,
            package_asset_paths={INCIDENT_ICON + ".png"},
            package_condition_ids={"23"},
            asset_exists=lambda logical: logical == "p/q.action.dsl.amf3.deflate",
            condition_id_exists=lambda cid: cid == "7",
        )

        self.assertTrue(report["release_ready"])
        self.assertEqual([], report["missing"])


class TestFlowAdapterReport(unittest.TestCase):
    def _package_with_incident_table(self, base: Path) -> Path:
        package_dir = base / "package"
        write_manifest(package_dir)
        put_package_file(
            package_dir,
            requirements.UNIQUE_CONDITION_TABLE,
            flat_table_bytes(requirements.UNIQUE_CONDITION_TABLE, {"23": INCIDENT_ROW}),
        )
        return package_dir

    def test_incident_regression_missing_icon_blocks_until_store_ships_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            package_dir = self._package_with_incident_table(base)
            store = base / "store"
            store.mkdir()

            report = flow.master_reference_report(package_dir, (store,))

            self.assertFalse(report["release_ready"])
            self.assertEqual(
                [INCIDENT_ICON + ".png"],
                [item["missing"] for item in report["missing"]],
            )
            self.assertEqual(
                f"{requirements.UNIQUE_CONDITION_TABLE}:23",
                report["missing"][0]["source"],
            )

            put_store_file(store, INCIDENT_ICON + ".png")
            self.assertTrue(flow.master_reference_report(package_dir, (store,))["release_ready"])

    def test_manifest_declared_icon_satisfies_without_store(self):
        with tempfile.TemporaryDirectory() as tmp:
            package_dir = Path(tmp) / "package"
            write_manifest(package_dir, [INCIDENT_ICON + ".png"])
            put_package_file(
                package_dir,
                requirements.UNIQUE_CONDITION_TABLE,
                flat_table_bytes(requirements.UNIQUE_CONDITION_TABLE, {"23": INCIDENT_ROW}),
            )

            report = flow.master_reference_report(package_dir, ())

            self.assertTrue(report["release_ready"])

    def test_ability_condition_ids_check_package_table_then_store_table(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            package_dir = base / "package"
            write_manifest(package_dir, [INCIDENT_ICON + ".png"])
            put_package_file(
                package_dir,
                requirements.UNIQUE_CONDITION_TABLE,
                flat_table_bytes(requirements.UNIQUE_CONDITION_TABLE, {"23": INCIDENT_ROW}),
            )
            put_package_file(
                package_dir,
                "master/ability/ability.orderedmap",
                flat_table_bytes("master/ability/ability.orderedmap", {
                    "1299991": sparse_row({68: "23"}),  # 包内 unique_condition 表自带
                    "1299992": sparse_row({68: "7"}),   # 只有 live store 表里有
                    "1299993": sparse_row({68: "99"}),  # 两边都没有
                }),
            )
            store = base / "store"
            put_store_file(
                store,
                requirements.UNIQUE_CONDITION_TABLE,
                flat_table_bytes(requirements.UNIQUE_CONDITION_TABLE, {
                    "7": "unique_poison,毒,battle/common/unique_condition/unique_poison,1,1",
                }),
            )
            put_store_file(store, "battle/common/unique_condition/unique_poison.png")

            report = flow.master_reference_report(package_dir, (store,))

            self.assertFalse(report["release_ready"])
            missing_ids = [
                item["missing"] for item in report["missing"]
                if item["kind"] == "unique_condition_id"
            ]
            self.assertEqual(["99"], missing_ids)

    def test_dsl_effect_requires_parts_timeline_and_directory_sheet(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            package_dir = base / "package"
            write_manifest(package_dir)
            program = "battle/action/skill/action/rare5/seris$seris_1"
            put_package_file(
                package_dir,
                f"{program}.action.dsl.amf3.deflate",
                dsl_file_bytes(["Block", [["Command", [
                    "ShowEffect", "全体演出", ["SpecifyEffectDirectly", EFFECT_REF],
                ]]]]),
            )
            store = base / "store"
            directory, _, name = EFFECT_REF.rpartition("/")
            directory_name = directory.rsplit("/", 1)[-1]
            expected = [
                f"{EFFECT_REF}.parts.amf3.deflate",
                f"{EFFECT_REF}.timeline.amf3.deflate",
                f"{directory}/{directory_name}.png",
                f"{directory}/{directory_name}.atlas.amf3.deflate",
            ]
            for logical in expected:
                put_store_file(store, logical)

            self.assertTrue(flow.master_reference_report(package_dir, (store,))["release_ready"])

            core.table_path(store, f"{EFFECT_REF}.timeline.amf3.deflate").unlink()
            report = flow.master_reference_report(package_dir, (store,))
            self.assertFalse(report["release_ready"])
            self.assertEqual(
                [f"{EFFECT_REF}.timeline.amf3.deflate"],
                [item["missing"] for item in report["missing"]],
            )

    def test_nested_skill_table_program_path_must_resolve(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            package_dir = base / "package"
            write_manifest(package_dir)
            program = "battle/action/skill/action/rare5/seris$seris_1"
            put_package_file(
                package_dir,
                requirements.ACTION_SKILL_TABLE,
                nested_table_bytes(requirements.ACTION_SKILL_TABLE, {
                    "seris_dragon_king": {"1": sparse_row({7: program}, ncols=8)},
                }),
            )
            store = base / "store"
            store.mkdir()

            report = flow.master_reference_report(package_dir, (store,))
            self.assertFalse(report["release_ready"])
            self.assertEqual(
                [f"{program}.action.dsl.amf3.deflate"],
                [item["missing"] for item in report["missing"]],
            )

            put_store_file(store, f"{program}.action.dsl.amf3.deflate")
            self.assertTrue(flow.master_reference_report(package_dir, (store,))["release_ready"])

    def test_baseline_rows_identical_to_store_are_exempt(self):
        # CN 基线本就有悬空引用(rare4/alk DSL 从未进国服包);整表随包时
        # 与 live store 逐行一致的行不归包负责,只有新增/修改行进门禁。
        baseline_row = "unique_legacy,遗留,battle/common/unique_condition/unique_legacy,1,1"
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            package_dir = base / "package"
            write_manifest(package_dir)
            store = base / "store"
            put_store_file(
                store,
                requirements.UNIQUE_CONDITION_TABLE,
                flat_table_bytes(requirements.UNIQUE_CONDITION_TABLE, {"7": baseline_row}),
            )
            put_package_file(
                package_dir,
                requirements.UNIQUE_CONDITION_TABLE,
                flat_table_bytes(requirements.UNIQUE_CONDITION_TABLE, {
                    "7": baseline_row,      # 与 store 相同:其悬空图标不追责
                    "23": INCIDENT_ROW,     # 新增行:必须检查
                }),
            )

            report = flow.master_reference_report(package_dir, (store,))

            self.assertFalse(report["release_ready"])
            self.assertEqual(
                [INCIDENT_ICON + ".png"],
                [item["missing"] for item in report["missing"]],
            )

    def test_modified_baseline_row_reenters_the_gate(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            package_dir = base / "package"
            write_manifest(package_dir)
            store = base / "store"
            put_store_file(
                store,
                requirements.UNIQUE_CONDITION_TABLE,
                flat_table_bytes(requirements.UNIQUE_CONDITION_TABLE, {
                    "23": "unique_seris_wet,湿润,battle/common/unique_condition/old_icon,1,1",
                }),
            )
            put_package_file(
                package_dir,
                requirements.UNIQUE_CONDITION_TABLE,
                flat_table_bytes(requirements.UNIQUE_CONDITION_TABLE, {"23": INCIDENT_ROW}),
            )

            report = flow.master_reference_report(package_dir, (store,))

            self.assertFalse(report["release_ready"])
            self.assertEqual(
                [INCIDENT_ICON + ".png"],
                [item["missing"] for item in report["missing"]],
            )

    def test_undecodable_table_is_reported_and_blocks(self):
        with tempfile.TemporaryDirectory() as tmp:
            package_dir = Path(tmp) / "package"
            write_manifest(package_dir)
            put_package_file(
                package_dir, requirements.UNIQUE_CONDITION_TABLE, b"not-an-orderedmap",
            )

            report = flow.master_reference_report(package_dir, ())

            self.assertFalse(report["release_ready"])
            self.assertTrue(any(
                requirements.UNIQUE_CONDITION_TABLE in problem
                for problem in report["problems"]
            ))


class RecordingReleaseModule:
    def __init__(self):
        self.preflight_calls = []
        self.publish_calls = []

    def preflight_package(self, package_dir, profile_id, installed_package_dir=None):
        self.preflight_calls.append((Path(package_dir), profile_id))
        return {"can_prepare": False, "conflicts": []}

    def publish_package(self, package_dir, profile_id, confirmation, installed_package_dir=None):
        self.publish_calls.append((Path(package_dir), profile_id, confirmation))
        return SimpleNamespace(
            committed=True,
            release_id="release-1",
            from_version="1.4.142",
            version="1.4.143",
            active_manifest_sha256="a" * 64,
            archive_paths=(),
            snapshot_dir=None,
        )


class TestFlowGateWiring(unittest.TestCase):
    def _workspace_with_incident_table(self, base: Path):
        workspace = workspace_module.init_workspace(
            base / "packs", 111165, 129999, "seris_dragon_king", "seris",
        )
        put_package_file(
            workspace.package_dir,
            requirements.UNIQUE_CONDITION_TABLE,
            flat_table_bytes(requirements.UNIQUE_CONDITION_TABLE, {"23": INCIDENT_ROW}),
        )
        return workspace

    def test_preflight_blocks_production_package_with_dangling_reference(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = self._workspace_with_incident_table(Path(tmp))
            fake = RecordingReleaseModule()
            with patch.object(flow, "_master_gate_stores", return_value=()):
                code, result = flow.run_command([
                    "preflight", "--workspace", str(workspace.root),
                ], release_module=fake)

            self.assertEqual(3, code)
            self.assertFalse(result["release_ready"])
            self.assertIn("master 表引用缺失资产", " ".join(result["errors"]))
            self.assertIn(INCIDENT_ICON + ".png", " ".join(result["errors"]))
            self.assertEqual(
                [INCIDENT_ICON + ".png"],
                [item["missing"] for item in result["master_reference_report"]["missing"]],
            )
            self.assertEqual([], fake.preflight_calls,
                             "门禁失败必须发生在 release preflight 之前")

    def test_preflight_clean_package_reports_zero_references_and_delegates(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = workspace_module.init_workspace(
                Path(tmp) / "packs", 111165, 129999, "seris_dragon_king", "seris",
            )
            fake = RecordingReleaseModule()
            with patch.object(flow, "_master_gate_stores", return_value=()):
                code, result = flow.run_command([
                    "preflight", "--workspace", str(workspace.root),
                ], release_module=fake)

            self.assertEqual(3, code)  # fixture preflight 本身 can_prepare=False
            self.assertEqual(1, len(fake.preflight_calls))
            self.assertEqual(
                0, result["master_reference_report"]["checked_references"],
            )
            self.assertTrue(result["master_reference_report"]["release_ready"])

    def test_publish_blocks_production_package_with_dangling_reference(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = self._workspace_with_incident_table(Path(tmp))
            fake = RecordingReleaseModule()
            ready = SimpleNamespace(
                release_ready=True,
                to_dict=lambda: {"release_ready": True},
            )
            with patch.object(
                flow.workspace_module, "workspace_status", return_value=ready
            ), patch.object(flow, "_master_gate_stores", return_value=()):
                code, result = flow.run_command([
                    "publish", "--workspace", str(workspace.root),
                    "--confirm", "PUBLISH_CHARACTER_PACKAGE",
                ], release_module=fake)

            self.assertEqual(2, code)
            self.assertIn("master 表资产引用门禁未通过", " ".join(result["errors"]))
            self.assertEqual([], fake.publish_calls)

    def test_runtime_test_publish_skips_master_gate(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = self._workspace_with_incident_table(Path(tmp))
            manifest_path = workspace.package_dir / "manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["qa"] = {
                "delivery_mode": "runtime_test",
                "release_ready": False,
                "user_authorized_direct_real_test": True,
            }
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            fake = RecordingReleaseModule()
            with patch.object(flow, "_master_gate_stores", return_value=()):
                code, result = flow.run_command([
                    "publish", "--workspace", str(workspace.root),
                    "--confirm", "DIRECT_REAL_TEST",
                ], release_module=fake)

            self.assertEqual(0, code)
            self.assertEqual(1, len(fake.publish_calls))


if __name__ == "__main__":
    unittest.main()
