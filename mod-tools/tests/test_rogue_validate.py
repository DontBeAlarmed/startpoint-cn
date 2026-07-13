# -*- coding: utf-8 -*-
"""深渊武装发布门禁的端到端校验测试。"""
from __future__ import annotations

import copy
import contextlib
import csv
import hashlib
import importlib.util
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import wf_assets  # noqa: E402
import wf_describe  # noqa: E402
import wf_mod_tool as core  # noqa: E402
import wf_quest_lib as q  # noqa: E402
import wf_rogue_rewards as rewards  # noqa: E402
import wf_rogue_shop as shop  # noqa: E402
import wf_rogue_validate as validate  # noqa: E402


ROOT = Path(__file__).resolve().parents[2]
BUILDER_PATH = ROOT / "client-patch/abyss-mode-equipment/build_apk.py"
BUILDER_SPEC = importlib.util.spec_from_file_location(
    "abyss_task8_fixture_builder", BUILDER_PATH
)
if BUILDER_SPEC is None or BUILDER_SPEC.loader is None:  # pragma: no cover
    raise ImportError(f"cannot load Task 7 builder: {BUILDER_PATH}")
builder = importlib.util.module_from_spec(BUILDER_SPEC)
sys.modules[BUILDER_SPEC.name] = builder
BUILDER_SPEC.loader.exec_module(builder)


def _leaf(rows: list[list[str]]) -> str:
    return core.write_csv_lines(rows)


def _ability_template(effect_kind: str, template_id: str) -> str:
    row = [""] * 123
    row[0], row[1], row[2] = "9", "9", "9"
    row[3] = template_id
    row[44], row[45], row[46] = effect_kind, "1", "Donor"
    row[48], row[49] = "100", "200"
    return _leaf([row])


def _base_master_tables() -> rewards.MasterTables:
    item_row = [f"item-{index}" for index in range(23)]
    item_row[1] = rewards.TOKEN_TEMPLATE
    item_row[2] = "激战代币"
    equipment: dict[str, object] = {}
    status: dict[str, object] = {}
    for index, spec in enumerate(rewards.WEAPONS):
        donor = [f"donor-{spec.id}-{column}" for column in range(16)]
        donor[0] = f"donor_{spec.donor}"
        donor[1] = f"供体 {spec.donor}"
        donor[6] = f"item/equipment/donor/{spec.donor}"
        donor[7] = f"供体描述 {spec.donor}"
        donor[8], donor[9], donor[10], donor[11] = "4", "true", spec.donor, "4"
        equipment[spec.donor] = _leaf([donor])
        status[spec.donor] = {
            "1": _leaf([[spec.donor, str(index + 100), str(index + 200)]]),
            "100": {
                "normal": _leaf(
                    [[spec.donor, str(index + 1000), str(index + 2000)]]
                )
            },
        }

    template_kinds = {
        effect.template_id: effect.effect_kind
        for spec in rewards.WEAPONS
        for effect in spec.effects
    }
    ability_soul = {
        template_id: _ability_template(effect_kind, template_id)
        for template_id, effect_kind in template_kinds.items()
    }
    rush_row = [f"rush-{index}" for index in range(18)]
    rush_row[10] = rewards.TOKEN_TEMPLATE
    return rewards.MasterTables(
        items={rewards.TOKEN_TEMPLATE: _leaf([item_row])},
        equipment=equipment,
        equipment_status=status,
        ability_soul=ability_soul,
        rush_event={
            rewards.EVENT_ID: _leaf([rush_row]),
            "700001": _leaf([["unrelated"]]),
        },
    )


def _base_server_mirrors() -> rewards.ServerMirrors:
    max_level: dict[str, object] = {"42": 3}
    element: dict[str, object] = {"42": 9}
    lookup: dict[str, object] = {
        "42": {"name": "保留装备", "rarity": "3", "category": "测试"}
    }
    for index, spec in enumerate(rewards.WEAPONS):
        max_level[spec.donor] = index + 1
        element[spec.donor] = 99
        lookup[spec.donor] = {
            "name": f"供体 {spec.donor}",
            "rarity": "4",
            "category": f"供体类别 {index}",
        }
    return rewards.ServerMirrors(
        equipment_max_level=max_level,
        equipment_element=element,
        equipment_lookup=lookup,
        equipment_ids=[42],
        item_ids=[7],
    )


def _write_table(store: Path, logical: str, table: dict[str, object]) -> None:
    path = store / q.hashed_rel(logical)
    path.parent.mkdir(parents=True, exist_ok=True)
    q.save_table(logical, table, path=path, backup=False)


def _read_table(store: Path, logical: str) -> dict[str, object]:
    return q.load_table(logical, path=store / q.hashed_rel(logical))


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _source_text() -> str:
    target = (
        "public function getAvailableAbilities(param1:BattlePartyLogic, param2:int, "
        "param3:QuestIdGroupKind, param4:Array) : BattleAbilitySource"
    )
    with_cond = (
        "public function getAvailableAbilitiesWithCond(param1:BattlePartyLogic, "
        "param2:int, param3:Function, param4:Array, param5:Boolean, "
        "param6:Boolean) : BattleAbilitySource"
    )
    return "\n".join(
        [
            "package",
            "{",
            "   public class BattleCharacterLogic",
            "   {",
            f"      {with_cond}",
            "      {",
            "         var _loc12_:* = null as AbilitySoulAbilityLogic;",
            "         var _loc13_:* = null as BattleAbilityPeek;",
            "         var _loc14_:Boolean = false;",
            "         _loc14_ = Boolean(param3(_loc13_.questKind));",
            "      }",
            f"      {target}",
            "      {",
            "         var _loc12_:* = null as AbilitySoulAbilityLogic;",
            "         var _loc13_:* = null as BattleAbilityPeek;",
            "         var _loc14_:Boolean = false;",
            "         var _loc15_:int = 0;",
            "         _loc14_ = Boolean(_loc5_(_loc13_.questKind));",
            "         if(_loc14_)",
            "         {",
            "            _loc10_ = _loc13_.getTriggers();",
            "            _loc7_.add(_loc18_,_loc10_[_loc17_],this,param1,param2,false);",
            "         }",
            "      }",
            "      public function getActionSkills() : Array",
            "      {",
            "         return [];",
            "      }",
            "   }",
            "}",
            "",
        ]
    )


def _verified_reexport_text() -> str:
    patched_text, insertions = builder.abyss_patch.patch_text(_source_text())
    if insertions != 1:  # pragma: no cover - fixture invariant
        raise AssertionError(f"expected one fixture insertion, got {insertions}")
    return (
        "\n".join(
            line
            for line in patched_text.splitlines()
            if builder.abyss_patch.BEGIN_MARKER not in line
            and builder.abyss_patch.END_MARKER not in line
        )
        + "\n"
    )


def _write_fake_export(export_dir: Path) -> Path:
    output = export_dir / "scripts/pinball/common/data/character"
    output.mkdir(parents=True, exist_ok=True)
    reexport = output / "BattleCharacterLogic.as"
    reexport.write_text(_verified_reexport_text(), encoding="utf-8")
    return reexport


def _write_client_verification(root: Path) -> Path:
    artifact_dir = root / "out/abyss-client-patch"
    artifact_dir.mkdir(parents=True, exist_ok=True)
    patched_text, insertions = builder.abyss_patch.patch_text(_source_text())
    if insertions != 1:  # pragma: no cover - fixture invariant
        raise AssertionError(f"expected one fixture insertion, got {insertions}")
    patched_as = artifact_dir / "BattleCharacterLogic.as"
    reexported_as = artifact_dir / "work/verify_export/BattleCharacterLogic.as"
    injected_swf = artifact_dir / "work/injected.swf"
    signed_apk = artifact_dir / "wf_abyss_gate.apk"
    reexported_as.parent.mkdir(parents=True, exist_ok=True)
    patched_as.write_text(patched_text, encoding="utf-8")
    reexported_as.write_text(_verified_reexport_text(), encoding="utf-8")
    injected_swf.write_bytes(b"FWS task-8 verified injected swf")
    with zipfile.ZipFile(signed_apk, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(builder.TARGET_SWF_MEMBER, injected_swf.read_bytes())
        archive.writestr("assets/other.bin", b"untouched")

    artifacts = {}
    for name, path in (
        ("patched_as", patched_as),
        ("injected_swf", injected_swf),
        ("signed_apk", signed_apk),
        ("reexported_as", reexported_as),
    ):
        resolved = path.resolve()
        artifacts[name] = {
            "path": str(resolved),
            "sha256": hashlib.sha256(resolved.read_bytes()).hexdigest(),
        }
    report = artifact_dir / "gate-verification.json"
    _write_json(
        report,
        {
            "schema_version": 1,
            "status": "verified",
            "class_name": builder.TARGET_CLASS,
            "artifacts": artifacts,
        },
    )
    return report


def _build_complete_fixture(root: Path) -> None:
    store = root / "store"
    assets_dir = root / "assets"
    source_dir = root / "mod-tools/assets/abyss-equipment"
    store.mkdir(parents=True)
    assets_dir.mkdir(parents=True)
    source_dir.mkdir(parents=True)
    tools = root / "tools"
    tools.mkdir()
    (tools / "ffdec.jar").write_bytes(b"fixture ffdec")
    (tools / "java.exe").write_bytes(b"fixture java")

    changes = rewards.build_master_changes(_base_master_tables())
    for logical, table in (
        (rewards.ITEM_T, changes.items),
        (rewards.EQUIP_T, changes.equipment),
        (rewards.EQUIP_STATUS_T, changes.equipment_status),
        (rewards.SOUL_T, changes.ability_soul),
        (rewards.RUSH_EVENT_T, changes.rush_event),
    ):
        _write_table(store, logical, table)

    client_template = [f"template-{index}" for index in range(shop.CLIENT_COLUMNS)]
    client_shop = shop.build_client_shop(
        {shop.SHOP_TEMPLATE: _leaf([client_template])}, rewards.WEAPONS
    )
    _write_table(store, shop.SHOP_T, client_shop)

    mirrors = rewards.apply_server_mirrors(_base_server_mirrors())
    for name in (
        "equipment_max_level",
        "equipment_element",
        "equipment_lookup",
        "equipment_ids",
        "item_ids",
    ):
        _write_json(assets_dir / f"{name}.json", getattr(mirrors, name))
    server_shop, id_map = shop.build_server_shop({}, {}, rewards.WEAPONS)
    _write_json(assets_dir / shop.SHOP_JSON, server_shop)
    _write_json(assets_dir / shop.SHOP_ID_MAP_JSON, id_map)

    for index, spec in enumerate(rewards.WEAPONS):
        image = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
        image.paste(
            (
                20 + (index * 37) % 220,
                20 + (index * 67) % 220,
                20 + (index * 97) % 220,
                255,
            ),
            (32, 32, 992, 992),
        )
        image.save(source_dir / f"{spec.image_slug}.png", format="PNG")
    sources = rewards.validate_source_assets(source_dir, rewards.WEAPONS)
    rewards.install_source_assets(store, sources, rewards.WEAPONS)
    _write_client_verification(root)


class CompleteFixtureCase(unittest.TestCase):
    baseline_temp: tempfile.TemporaryDirectory[str]
    baseline_root: Path

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.baseline_temp = tempfile.TemporaryDirectory()
        cls.baseline_root = Path(cls.baseline_temp.name) / "baseline"
        _build_complete_fixture(cls.baseline_root)

    @classmethod
    def tearDownClass(cls):
        cls.baseline_temp.cleanup()
        super().tearDownClass()

    def setUp(self):
        self.fixture_temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.fixture_temp.cleanup)
        self.root = Path(self.fixture_temp.name) / "fixture"
        shutil.copytree(self.baseline_root, self.root)
        self.store = self.root / "store"
        self.assets_dir = self.root / "assets"
        self.report_path = self.root / "out/abyss-client-patch/gate-verification.json"
        self.ffdec = self.root / "tools/ffdec.jar"
        self.java = self.root / "tools/java.exe"
        report = json.loads(self.report_path.read_text(encoding="utf-8"))
        for record in report["artifacts"].values():
            old_path = Path(record["path"])
            relative = old_path.relative_to(self.baseline_root)
            record["path"] = str((self.root / relative).resolve())
        _write_json(self.report_path, report)

    def validate(self):
        def fake_export(swf, export_dir, ffdec, java):
            self.assertEqual(self.ffdec, Path(ffdec))
            self.assertEqual(self.java, Path(java))
            self.assertTrue(Path(swf).read_bytes().startswith(b"FWS"))
            output = Path(export_dir) / "scripts/pinball/common/data/character"
            output.mkdir(parents=True, exist_ok=True)
            reexport = output / "BattleCharacterLogic.as"
            reexport.write_text(_verified_reexport_text(), encoding="utf-8")
            return reexport

        with mock.patch.object(
            validate.apk_builder,
            "export_verified_class",
            side_effect=fake_export,
        ):
            return validate.validate_release(
                self.store,
                self.assets_dir,
                self.report_path,
                ffdec=self.ffdec,
                java=self.java,
            )

    def assert_error(self, result, prefix: str):
        self.assertTrue(
            any(error.startswith(prefix) for error in result.errors),
            f"missing error prefix {prefix!r}: {result.errors}",
        )

    def mutate_leaf(
        self, logical: str, key: str, changes: dict[int, str]
    ) -> None:
        table = _read_table(self.store, logical)
        original = table[key]
        text = original.decode("utf-8") if isinstance(original, bytes) else original
        rows = core.read_csv_lines(text)
        for column, value in changes.items():
            rows[0][column] = value
        rendered = core.write_csv_lines(rows)
        table[key] = rendered.encode("utf-8") if isinstance(original, bytes) else rendered
        _write_table(self.store, logical, table)


class TestValidatorSurface(unittest.TestCase):
    def test_release_allowlist_is_exactly_six_tables_and_fifteen_pngs(self):
        expected = [
            rewards.ITEM_T,
            rewards.EQUIP_T,
            rewards.EQUIP_STATUS_T,
            rewards.SOUL_T,
            rewards.RUSH_EVENT_T,
            shop.SHOP_T,
            *[
                f"{rewards.IMAGE_PREFIX}/{spec.image_slug}.png"
                for spec in rewards.WEAPONS
            ],
        ]

        self.assertEqual(expected, validate.release_logicals())
        self.assertEqual(21, len(validate.release_logicals()))
        self.assertEqual(21, len(set(validate.release_logicals())))

    def test_validator_api_is_present(self):
        self.assertTrue(hasattr(validate, "ValidationResult"))
        self.assertTrue(hasattr(validate, "validate_release"))
        self.assertTrue(hasattr(validate, "require_release_ready"))


class TestCompleteRelease(CompleteFixtureCase):
    def test_complete_fixture_returns_all_fifteen_description_readbacks(self):
        result = self.validate()

        self.assertEqual((), result.errors)
        self.assertEqual(15, len(result.descriptions))
        for spec, description in zip(rewards.WEAPONS, result.descriptions):
            self.assertIn(spec.id, description)
            self.assertNotIn("<unavailable>", description.lower())

    def test_require_release_ready_raises_with_every_collected_error(self):
        equipment = _read_table(self.store, rewards.EQUIP_T)
        equipment.pop(rewards.WEAPONS[0].id)
        _write_table(self.store, rewards.EQUIP_T, equipment)
        (self.assets_dir / "equipment_element.json").write_text(
            "not-json", encoding="utf-8"
        )
        (self.root / "mod-tools/assets/abyss-equipment/fire_01.png").unlink()
        self.report_path.unlink()

        result = self.validate()
        self.assertGreaterEqual(len(result.errors), 4)
        self.assert_error(result, "equipment[8000101].missing")
        self.assert_error(result, "assets.equipment_element.invalid")
        self.assert_error(result, "png.sources.invalid")
        self.assert_error(result, "client_verification.report.missing")
        stdout = io.StringIO()
        stderr = io.StringIO()
        with (
            contextlib.redirect_stdout(stdout),
            contextlib.redirect_stderr(stderr),
            self.assertRaisesRegex(RuntimeError, r"\d+ error"),
        ):
            with mock.patch.object(
                validate.apk_builder,
                "export_verified_class",
                side_effect=lambda _swf, export_dir, _ffdec, _java: _write_fake_export(
                    Path(export_dir)
                ),
            ):
                validate.require_release_ready(
                    self.store,
                    self.assets_dir,
                    self.report_path,
                    ffdec=self.ffdec,
                    java=self.java,
                )
        self.assertEqual(15, stdout.getvalue().count("[ABILITY]"))
        self.assertIn("equipment[8000101].missing", stderr.getvalue())


class TestMasterBoundaries(CompleteFixtureCase):
    def test_missing_equipment_status_soul_shop_item_and_rush_rows_are_named(self):
        first = rewards.WEAPONS[0]
        for logical, key in (
            (rewards.EQUIP_T, first.id),
            (rewards.EQUIP_STATUS_T, first.id),
            (rewards.SOUL_T, first.id),
            (shop.SHOP_T, shop.RESERVED_SHOP_IDS[0]),
            (rewards.ITEM_T, rewards.TOKEN_ID),
            (rewards.RUSH_EVENT_T, rewards.EVENT_ID),
        ):
            table = _read_table(self.store, logical)
            table.pop(key)
            _write_table(self.store, logical, table)

        result = self.validate()

        for prefix in (
            "equipment[8000101].missing",
            "equipment_status[8000101].missing",
            "ability_soul[8000101].missing",
            "shop.client[9700101].missing",
            "item[2370099].missing",
            "rush_event[700099].missing",
        ):
            self.assert_error(result, prefix)

    def test_wrong_equipment_columns_are_reported_by_semantic_name(self):
        self.mutate_leaf(
            rewards.EQUIP_T,
            rewards.WEAPONS[0].id,
            {
                1: "错误名称",
                6: "item/equipment/wrong",
                7: "错误描述",
                8: "4",
                9: "false",
                10: "123",
                11: "4",
            },
        )

        result = self.validate()

        for suffix in (
            "name",
            "image_path",
            "description",
            "max_level",
            "ability_enabled",
            "ability_column",
            "rarity",
        ):
            self.assert_error(result, f"equipment[8000101].{suffix}")

    def test_wrong_status_donor_map_and_server_mirrors_are_named(self):
        first = rewards.WEAPONS[0]
        status = _read_table(self.store, rewards.EQUIP_STATUS_T)
        status[first.id] = {"wrong": "status"}
        _write_table(self.store, rewards.EQUIP_STATUS_T, status)

        max_level = json.loads(
            (self.assets_dir / "equipment_max_level.json").read_text(encoding="utf-8")
        )
        element = json.loads(
            (self.assets_dir / "equipment_element.json").read_text(encoding="utf-8")
        )
        lookup = json.loads(
            (self.assets_dir / "equipment_lookup.json").read_text(encoding="utf-8")
        )
        max_level[first.id] = -99
        element[first.id] = 99
        lookup[first.id]["name"] = "错误镜像名称"
        lookup[first.id]["rarity"] = "1"
        _write_json(self.assets_dir / "equipment_max_level.json", max_level)
        _write_json(self.assets_dir / "equipment_element.json", element)
        _write_json(self.assets_dir / "equipment_lookup.json", lookup)

        result = self.validate()

        self.assert_error(result, "equipment_status[8000101].donor_map")
        self.assert_error(result, "assets.equipment_max_level[8000101].value")
        self.assert_error(result, "assets.equipment_element[8000101].value")
        self.assert_error(result, "assets.equipment_lookup[8000101].name")
        self.assert_error(result, "assets.equipment_lookup[8000101].rarity")

    def test_boolean_mirror_values_do_not_equal_integer_contract_values(self):
        max_level_spec = rewards.WEAPONS[0]
        element_spec = rewards.WEAPONS[2]
        max_level_path = self.assets_dir / "equipment_max_level.json"
        element_path = self.assets_dir / "equipment_element.json"
        max_level = json.loads(max_level_path.read_text(encoding="utf-8"))
        element = json.loads(element_path.read_text(encoding="utf-8"))
        self.assertEqual(1, max_level[max_level_spec.donor])
        self.assertEqual(1, element_spec.element)
        max_level[max_level_spec.id] = True
        element[element_spec.id] = True
        _write_json(max_level_path, max_level)
        _write_json(element_path, element)

        result = self.validate()

        self.assert_error(
            result, f"assets.equipment_max_level[{max_level_spec.id}].value"
        )
        self.assert_error(
            result, f"assets.equipment_element[{element_spec.id}].value"
        )

    def test_wrong_soul_effect_columns_and_empty_descriptions_are_named(self):
        self.mutate_leaf(
            rewards.SOUL_T,
            rewards.WEAPONS[0].id,
            {44: "999", 48: "1", 49: "2"},
        )
        with mock.patch.object(
            wf_describe,
            "describe_rows",
            return_value=[""],
        ):
            result = self.validate()

        self.assert_error(result, "ability_soul[8000101].canonical_rows")
        self.assert_error(result, "ability_soul[8000101].description.empty")
        self.assertEqual(15, len(result.descriptions))

    def test_wrong_rush_token_is_named(self):
        self.mutate_leaf(
            rewards.RUSH_EVENT_T,
            rewards.EVENT_ID,
            {10: rewards.TOKEN_TEMPLATE},
        )

        result = self.validate()

        self.assert_error(result, "rush_event[700099].token")

    def test_corrupt_master_and_json_inputs_do_not_crash_or_hide_other_errors(self):
        (self.store / q.hashed_rel(rewards.EQUIP_T)).write_bytes(b"corrupt")
        (self.assets_dir / "equipment_ids.json").write_bytes(b"{broken")
        self.report_path.unlink()

        result = self.validate()

        self.assert_error(result, "table.master/item/equipment.orderedmap.invalid")
        self.assert_error(result, "assets.equipment_ids.invalid")
        self.assert_error(result, "client_verification.report.missing")
        self.assertEqual(15, len(result.descriptions))

    def test_valid_json_with_wrong_root_shapes_is_named(self):
        for name, value in (
            ("equipment_max_level", []),
            ("equipment_element", "wrong-root"),
            ("equipment_lookup", 7),
            ("event_item_shop", []),
            ("event_item_shop_id_map", []),
        ):
            _write_json(self.assets_dir / f"{name}.json", value)

        result = self.validate()

        for name in (
            "equipment_max_level",
            "equipment_element",
            "equipment_lookup",
            "event_item_shop",
            "event_item_shop_id_map",
        ):
            self.assert_error(result, f"assets.{name}.invalid")

    def test_csv_parser_error_is_collected_without_exception_escape(self):
        with mock.patch.object(
            core,
            "read_csv_lines",
            side_effect=csv.Error("corrupt CSV leaf"),
        ):
            result = self.validate()

        self.assert_error(result, "item[2370099].invalid")
        self.assert_error(result, "shop.contract.invalid")
        self.assertEqual(15, len(result.descriptions))

    def test_empty_donor_and_soul_template_errors_are_collected(self):
        first = rewards.WEAPONS[0]
        equipment = _read_table(self.store, rewards.EQUIP_T)
        equipment[first.donor] = ""
        _write_table(self.store, rewards.EQUIP_T, equipment)
        souls = _read_table(self.store, rewards.SOUL_T)
        souls[first.effects[0].template_id] = ""
        _write_table(self.store, rewards.SOUL_T, souls)

        result = self.validate()

        self.assert_error(result, "equipment[8000101].expected.invalid")
        self.assert_error(result, "ability_soul[8000101].templates")
        self.assertEqual(15, len(result.descriptions))

    def test_ability_description_overflow_is_collected(self):
        self.mutate_leaf(
            rewards.SOUL_T,
            rewards.WEAPONS[0].id,
            {43: "9" * 1000},
        )

        result = self.validate()

        self.assert_error(result, "ability_soul[8000101].canonical_rows")
        self.assert_error(result, "ability_soul[8000101].description.invalid")
        self.assertEqual(15, len(result.descriptions))


class TestPngBoundaries(CompleteFixtureCase):
    def test_missing_source_png_is_named(self):
        source = self.root / "mod-tools/assets/abyss-equipment/fire_01.png"
        source.unlink()

        result = self.validate()

        self.assert_error(result, "png.sources.invalid")
        self.assertTrue(any("fire_01.png" in error for error in result.errors))

    def test_invalid_source_png_is_named(self):
        source = self.root / "mod-tools/assets/abyss-equipment/fire_01.png"
        source.write_bytes(b"not-a-png")

        result = self.validate()

        self.assert_error(result, "png.sources.invalid")
        self.assertTrue(any("fire_01.png" in error for error in result.errors))

    def test_duplicate_source_png_is_named(self):
        source_dir = self.root / "mod-tools/assets/abyss-equipment"
        shutil.copyfile(source_dir / "fire_01.png", source_dir / "fire_02.png")

        result = self.validate()

        self.assert_error(result, "png.sources.invalid")
        self.assertTrue(any("重复" in error or "duplicate" in error for error in result.errors))

    def test_missing_hashed_store_png_is_named(self):
        logical = f"{rewards.IMAGE_PREFIX}/{rewards.WEAPONS[0].image_slug}.png"
        (self.store / q.hashed_rel(logical)).unlink()

        result = self.validate()

        self.assert_error(result, f"png.store[{logical}].missing")

    def test_wrong_hashed_store_bytes_are_named(self):
        logical = f"{rewards.IMAGE_PREFIX}/{rewards.WEAPONS[0].image_slug}.png"
        (self.store / q.hashed_rel(logical)).write_bytes(b"wrong-store-bytes")

        result = self.validate()

        self.assert_error(result, f"png.store[{logical}].bytes")

    def test_raw_standard_png_bytes_are_not_accepted_as_store_encoding(self):
        first = rewards.WEAPONS[0]
        logical = f"{rewards.IMAGE_PREFIX}/{first.image_slug}.png"
        source = self.root / f"mod-tools/assets/abyss-equipment/{first.image_slug}.png"
        (self.store / q.hashed_rel(logical)).write_bytes(source.read_bytes())

        result = self.validate()

        self.assert_error(result, f"png.store[{logical}].bytes")


class TestShopBoundaries(CompleteFixtureCase):
    def test_wrong_shop_cost_stock_reward_ordering_nesting_and_id_map_are_named(self):
        client = _read_table(self.store, shop.SHOP_T)
        last = client.pop(shop.RESERVED_SHOP_IDS[-1])
        first = client.pop(shop.RESERVED_SHOP_IDS[0])
        client[shop.RESERVED_SHOP_IDS[-1]] = last
        client[shop.RESERVED_SHOP_IDS[0]] = first
        _write_table(self.store, shop.SHOP_T, client)

        server_path = self.assets_dir / shop.SHOP_JSON
        id_map_path = self.assets_dir / shop.SHOP_ID_MAP_JSON
        server = json.loads(server_path.read_text(encoding="utf-8"))
        id_map = json.loads(id_map_path.read_text(encoding="utf-8"))
        product = server[shop.EVENT_TYPE][shop.EVENT_ID][shop.RESERVED_SHOP_IDS[0]]
        product["costs"][0]["amount"] = 999
        product["stock"] = 999
        product["rewards"][0]["id"] = 1
        misplaced = server[shop.EVENT_TYPE][shop.EVENT_ID].pop(
            shop.RESERVED_SHOP_IDS[1]
        )
        server.setdefault("99", {}).setdefault("1", {})[
            shop.RESERVED_SHOP_IDS[1]
        ] = misplaced
        id_map[shop.RESERVED_SHOP_IDS[0]] = {"eventType": 99, "eventId": 1}
        _write_json(server_path, server)
        _write_json(id_map_path, id_map)

        result = self.validate()

        for prefix in (
            "shop.client.ordering",
            "shop.server[9700101].cost",
            "shop.server[9700101].stock",
            "shop.server[9700101].reward",
            "shop.server[9700102].nesting",
            "shop.id_map[9700101].value",
        ):
            self.assert_error(result, prefix)

    def test_boolean_reward_count_does_not_equal_integer_one(self):
        server_path = self.assets_dir / shop.SHOP_JSON
        server = json.loads(server_path.read_text(encoding="utf-8"))
        shop_id = shop.RESERVED_SHOP_IDS[0]
        server[shop.EVENT_TYPE][shop.EVENT_ID][shop_id]["rewards"][0][
            "count"
        ] = True
        _write_json(server_path, server)

        result = self.validate()

        self.assert_error(result, f"shop.server[{shop_id}].reward")


class TestClientVerificationBoundaries(CompleteFixtureCase):
    def load_report(self) -> dict[str, object]:
        return json.loads(self.report_path.read_text(encoding="utf-8"))

    def save_report(self, report: dict[str, object]) -> None:
        _write_json(self.report_path, report)

    def artifact_path(self, name: str) -> Path:
        report = self.load_report()
        return Path(report["artifacts"][name]["path"])

    def test_malformed_client_report_is_named_without_crashing(self):
        self.report_path.write_text("{broken", encoding="utf-8")

        result = self.validate()

        self.assert_error(result, "client_verification.report.invalid")

    def test_nul_artifact_path_is_named_without_exception_escape(self):
        report = self.load_report()
        report["artifacts"]["patched_as"]["path"] = "invalid\x00path"
        self.save_report(report)

        result = self.validate()

        self.assert_error(result, "client_verification.report.invalid")

    def test_stale_report_newer_artifact_is_named(self):
        artifact = self.artifact_path("signed_apk")
        report_time = self.report_path.stat().st_mtime_ns
        newer = report_time + 2_000_000_000
        os.utime(artifact, ns=(newer, newer))

        result = self.validate()

        self.assert_error(
            result, "client_verification.report.stale[signed_apk]"
        )

    def test_tampered_report_schema_or_class_is_named(self):
        report = self.load_report()
        report["class_name"] = "wrong.BattleCharacterLogic"
        self.save_report(report)

        result = self.validate()

        self.assert_error(result, "client_verification.report.invalid")

    def test_boolean_report_schema_version_is_rejected(self):
        report = self.load_report()
        report["schema_version"] = True
        self.save_report(report)

        result = self.validate()

        self.assert_error(result, "client_verification.report.invalid")

    def test_tampered_signed_apk_hash_is_named(self):
        self.artifact_path("signed_apk").write_bytes(b"tampered apk")

        result = self.validate()

        self.assert_error(result, "client_verification.report.invalid")
        self.assertTrue(any("signed_apk" in error for error in result.errors))

    def test_tampered_reexport_hash_is_named(self):
        reexported = self.artifact_path("reexported_as")
        reexported.write_text(
            reexported.read_text(encoding="utf-8") + "// tampered\n",
            encoding="utf-8",
        )

        result = self.validate()

        self.assert_error(result, "client_verification.report.invalid")
        self.assertTrue(any("reexported_as" in error for error in result.errors))

    def test_reexport_with_matching_hash_but_wrong_gate_semantics_is_named(self):
        report = self.load_report()
        reexported = Path(report["artifacts"]["reexported_as"]["path"])
        text = reexported.read_text(encoding="utf-8")
        self.assertIn("8000115", text)
        reexported.write_text(text.replace("8000115", "8000116"), encoding="utf-8")
        report["artifacts"]["reexported_as"]["sha256"] = hashlib.sha256(
            reexported.read_bytes()
        ).hexdigest()
        self.save_report(report)

        result = self.validate()

        self.assert_error(result, "client_verification.reexport.semantic")

    def test_self_consistent_mixed_swf_and_reexport_report_is_rejected(self):
        report = self.load_report()
        original = Path(report["artifacts"]["reexported_as"]["path"])
        substituted = original.with_name("substituted-BattleCharacterLogic.as")
        substituted.write_text(
            original.read_text(encoding="utf-8") + "// different valid export\n",
            encoding="utf-8",
        )
        report["artifacts"]["reexported_as"] = {
            "path": str(substituted.resolve()),
            "sha256": hashlib.sha256(substituted.read_bytes()).hexdigest(),
        }
        self.save_report(report)

        result = self.validate()

        self.assert_error(result, "client_verification.reexport.binding")

    def test_apk_embedded_swf_must_match_reported_injected_swf(self):
        report = self.load_report()
        apk = Path(report["artifacts"]["signed_apk"]["path"])
        with zipfile.ZipFile(apk, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(builder.TARGET_SWF_MEMBER, b"different embedded swf")
        report["artifacts"]["signed_apk"]["sha256"] = hashlib.sha256(
            apk.read_bytes()
        ).hexdigest()
        self.save_report(report)

        result = self.validate()

        self.assert_error(result, "client_verification.apk.embedded_swf")

    def test_missing_reexport_artifact_is_named_without_exception_escape(self):
        self.artifact_path("reexported_as").unlink()

        result = self.validate()

        self.assert_error(result, "client_verification.report.invalid")
        self.assert_error(result, "client_verification.reexport.missing")


class TestValidatorCli(CompleteFixtureCase):
    def run_cli(self) -> tuple[int, str, str]:
        profile = core.VersionProfile(
            id="cn", label="CN", store=self.store, fallback=None
        )
        stdout = io.StringIO()
        stderr = io.StringIO()
        with (
            mock.patch.object(validate.rewards, "require_cn_profile", return_value=profile),
            mock.patch.object(validate, "ASSETS_DIR", self.assets_dir),
            mock.patch.object(
                validate.apk_builder,
                "export_verified_class",
                side_effect=lambda _swf, export_dir, _ffdec, _java: _write_fake_export(
                    Path(export_dir)
                ),
            ),
            mock.patch.object(
                sys,
                "argv",
                [
                    "wf_rogue_validate.py",
                    "--client-verification",
                    str(self.report_path),
                    "--ffdec",
                    str(self.ffdec),
                    "--java",
                    str(self.java),
                ],
            ),
            contextlib.redirect_stdout(stdout),
            contextlib.redirect_stderr(stderr),
        ):
            result = validate.main()
        return result, stdout.getvalue(), stderr.getvalue()

    def test_valid_cli_prints_all_fifteen_readbacks(self):
        result, stdout, stderr = self.run_cli()

        self.assertEqual(0, result, stderr)
        self.assertEqual(15, stdout.count("[ABILITY]"))
        self.assertIn("[OK] abyss release validation passed", stdout)

    def test_invalid_cli_prints_all_readbacks_and_all_errors(self):
        equipment = _read_table(self.store, rewards.EQUIP_T)
        equipment.pop(rewards.WEAPONS[0].id)
        _write_table(self.store, rewards.EQUIP_T, equipment)
        self.report_path.unlink()

        result, stdout, stderr = self.run_cli()

        self.assertNotEqual(0, result)
        self.assertEqual(15, stdout.count("[ABILITY]"))
        self.assertIn("equipment[8000101].missing", stderr)
        self.assertIn("client_verification.report.missing", stderr)


if __name__ == "__main__":
    unittest.main()
