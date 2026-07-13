# -*- coding: utf-8 -*-
"""深渊武装纯数据构建器测试（合成行，不读取真实 CN store）。"""
from __future__ import annotations

import contextlib
import dataclasses
import copy
import io
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import wf_assets  # noqa: E402
import wf_mod_tool as core  # noqa: E402
import wf_rogue_rewards as rewards  # noqa: E402


REQUIRED_API = (
    "WEAPONS",
    "IMAGE_PREFIX",
    "MODE_DESCRIPTION",
    "build_equipment_leaf",
    "build_equipment_status",
    "build_soul_leaf",
)
MISSING_API = tuple(name for name in REQUIRED_API if not hasattr(rewards, name))

TASK2_API = (
    "EQUIP_STATUS_T",
    "RUSH_EVENT_T",
    "EVENT_ID",
    "MasterTables",
    "MasterChanges",
    "ServerMirrors",
    "assert_reserved_ownership",
    "build_master_changes",
    "apply_server_mirrors",
    "patch_rush_token",
)
MISSING_TASK2_API = tuple(name for name in TASK2_API if not hasattr(rewards, name))

TASK3_API = (
    "validate_source_assets",
    "install_source_assets",
)
MISSING_TASK3_API = tuple(name for name in TASK3_API if not hasattr(rewards, name))


EXPECTED_WEAPONS = [
    ("8000101", "灰烬巨剑", "5010060", 0, "Red", "item/equipment/mod/abyss/fire_01",
     (("3020006", "32", 3_000_000), ("5050009", "55", 5_000_000))),
    ("8000102", "熔核法杖", "5020042", 0, "Red", "item/equipment/mod/abyss/fire_02",
     (("4020013", "34", 5_000_000), ("3050010", "211", 1_000_000))),
    ("8000103", "深潮长枪", "5010075", 1, "Blue", "item/equipment/mod/abyss/water_01",
     (("3020006", "32", 3_000_000), ("5070035", "33", 5_000_000))),
    ("8000104", "冻海战锚", "5020031", 1, "Blue", "item/equipment/mod/abyss/water_02",
     (("3040003", "205", 1_000_000), ("3010013", "195", 1_000_000),
      ("3050010", "211", 1_000_000))),
    ("8000105", "雷鸣双刃", "5010077", 2, "Yellow", "item/equipment/mod/abyss/thunder_01",
     (("3020006", "32", 3_000_000), ("5070035", "33", 5_000_000))),
    ("8000106", "轰电战锤", "5020038", 2, "Yellow", "item/equipment/mod/abyss/thunder_02",
     (("4020013", "34", 5_000_000), ("3050010", "211", 1_000_000))),
    ("8000107", "裂空战镰", "5010068", 3, "Green", "item/equipment/mod/abyss/wind_01",
     (("3020006", "32", 3_000_000), ("5070035", "33", 5_000_000))),
    ("8000108", "苍岚长弓", "5020026", 3, "Green", "item/equipment/mod/abyss/wind_02",
     (("4020013", "34", 5_000_000), ("3050010", "211", 1_000_000))),
    ("8000109", "晨星圣剑", "5017716", 4, "White", "item/equipment/mod/abyss/light_01",
     (("3020006", "32", 3_000_000), ("5090029", "388", 5_000_000))),
    ("8000110", "辉环法器", "5020039", 4, "White", "item/equipment/mod/abyss/light_02",
     (("3040003", "205", 1_000_000), ("3010013", "195", 1_000_000),
      ("4020013", "34", 3_000_000))),
    ("8000111", "蚀月大剑", "5010078", 5, "Black", "item/equipment/mod/abyss/dark_01",
     (("3020006", "32", 5_000_000), ("4020013", "34", 5_000_000))),
    ("8000112", "冥灯魔杖", "5020040", 5, "Black", "item/equipment/mod/abyss/dark_02",
     (("5090029", "388", 5_000_000), ("3050010", "211", 1_000_000))),
    ("8000113", "深渊征服者", "5010057", -1, "", "item/equipment/mod/abyss/universal_01",
     (("3020006", "32", 3_000_000), ("3040003", "205", 1_000_000))),
    ("8000114", "深渊轮转核", "5020010", -1, "", "item/equipment/mod/abyss/universal_02",
     (("4020013", "34", 5_000_000), ("3050010", "211", 1_000_000))),
    ("8000115", "深渊万象铳", "5090045", -1, "", "item/equipment/mod/abyss/universal_03",
     (("5070035", "33", 3_000_000), ("5050009", "55", 3_000_000),
      ("5090029", "388", 3_000_000))),
]

TEMPLATE_KINDS = {
    "3020006": "32",
    "3040003": "205",
    "3050010": "211",
    "4020013": "34",
    "5070035": "33",
    "5050009": "55",
    "5090029": "388",
    "3010013": "195",
}


def template_row(effect_kind: str) -> list[str]:
    row = [""] * 123
    row[0], row[1], row[2] = "9", "9", "9"
    row[44], row[45], row[46] = effect_kind, "1", "Donor"
    row[48], row[49] = "100", "200"
    return row


def fake_templates() -> dict[str, str]:
    templates = {}
    for template_id, effect_kind in TEMPLATE_KINDS.items():
        requested = template_row(effect_kind)
        requested[3] = template_id
        unwanted = template_row("999")
        unwanted[3] = f"unwanted-{template_id}"
        templates[template_id] = core.write_csv_lines([requested, unwanted])
    return templates


def require_task2(name: str):
    value = getattr(rewards, name, None)
    if value is None:
        raise AssertionError(f"Task 2 API {name} is not implemented")
    return value


def require_task3(name: str):
    value = getattr(rewards, name, None)
    if value is None:
        raise AssertionError(f"Task 3 API {name} is not implemented")
    return value


def write_rgba_fixture(
    path: Path,
    *,
    color: tuple[int, int, int, int] = (200, 80, 40, 255),
    size: tuple[int, int] = (1024, 1024),
    visible_box: tuple[int, int, int, int] | None = (32, 32, 992, 992),
    background: tuple[int, int, int, int] = (0, 0, 0, 0),
) -> None:
    image = Image.new("RGBA", size, background)
    if visible_box is not None:
        image.paste(color, visible_box)
    image.save(path, format="PNG")


def write_valid_asset_set(directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    for index, spec in enumerate(rewards.WEAPONS):
        color = (
            20 + (index * 37) % 220,
            20 + (index * 67) % 220,
            20 + (index * 97) % 220,
            255,
        )
        write_rgba_fixture(directory / f"{spec.image_slug}.png", color=color)


def fake_master_tables(*, placeholders: bool = False, binary: bool = False):
    tables_type = require_task2("MasterTables")

    def leaf(rows: list[list[str]]) -> bytes | str:
        text = core.write_csv_lines(rows)
        return text.encode("utf-8") if binary else text

    item_template = [f"item-{index}" for index in range(23)]
    item_template[1] = rewards.TOKEN_TEMPLATE
    item_template[2] = "激战代币"
    items = {rewards.TOKEN_TEMPLATE: leaf([item_template])}

    equipment: dict[str, object] = {}
    equipment_status: dict[str, object] = {}
    for spec in rewards.WEAPONS:
        donor = [f"donor-{spec.id}-{index}" for index in range(16)]
        donor[0] = f"donor_{spec.donor}"
        donor[1] = f"供体 {spec.donor}"
        donor[6] = f"item/equipment/donor/{spec.donor}"
        donor[7] = f"供体描述 {spec.donor}"
        donor[8] = "4"
        donor[9] = "true"
        donor[10] = spec.donor
        donor[11] = "4"
        equipment[spec.donor] = leaf([donor])
        equipment_status[spec.donor] = {
            "1": f"{spec.donor},100",
            "5": {"normal": [spec.id, spec.donor]},
        }
        if placeholders:
            placeholder = list(donor)
            placeholder[0] = f"mod_abyss_{spec.id}"
            placeholder[1] = f"占位 {spec.id}"
            placeholder[10] = spec.id
            equipment[spec.id] = leaf([placeholder])
            equipment_status[spec.id] = {"placeholder": spec.id}

    souls = {
        key: value.encode("utf-8") if binary else value
        for key, value in fake_templates().items()
    }
    if placeholders:
        for spec in rewards.WEAPONS:
            souls[spec.id] = leaf([[f"placeholder-{spec.id}"]])

    rush_row = [f"rush-{index}" for index in range(18)]
    rush_row[10] = rewards.TOKEN_TEMPLATE
    rush_event = {"700099": leaf([rush_row]), "700001": leaf([["untouched"]])}
    return tables_type(
        items=items,
        equipment=equipment,
        equipment_status=equipment_status,
        ability_soul=souls,
        rush_event=rush_event,
    )


def fake_server_mirrors():
    mirrors_type = require_task2("ServerMirrors")
    max_level = {"42": 3}
    element = {"42": 9}
    lookup = {"42": {"name": "保留装备", "rarity": "3", "category": "测试"}}
    for index, spec in enumerate(rewards.WEAPONS):
        max_level[spec.donor] = index + 1
        element[spec.donor] = 99
        lookup[spec.donor] = {
            "name": f"供体 {spec.donor}",
            "rarity": "4",
            "category": f"供体类别 {index}",
        }
    return mirrors_type(
        equipment_max_level=max_level,
        equipment_element=element,
        equipment_lookup=lookup,
        equipment_ids=[42, 7, 42],
        item_ids=[5, 1, 5],
    )


MIRROR_FIELDS = (
    "equipment_max_level",
    "equipment_element",
    "equipment_lookup",
    "equipment_ids",
    "item_ids",
)


def write_temp_mirrors(directory: Path, mirrors) -> dict[str, bytes]:
    result = {}
    for field in MIRROR_FIELDS:
        path = directory / f"{field}.json"
        data = getattr(mirrors, field)
        path.write_text(
            json.dumps(data, ensure_ascii=False, indent=0 if isinstance(data, list) else 1),
            encoding="utf-8",
        )
        result[field] = path.read_bytes()
    return result


class TestApiSurface(unittest.TestCase):
    def test_canonical_builder_api_exists(self):
        self.assertEqual((), MISSING_API)

    def test_task2_writer_api_exists(self):
        self.assertEqual((), MISSING_TASK2_API)

    def test_task3_asset_api_exists(self):
        self.assertEqual((), MISSING_TASK3_API)


class TestSourceAssets(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._fixture_temp = tempfile.TemporaryDirectory()
        cls._fixture_dir = Path(cls._fixture_temp.name) / "valid-assets"
        write_valid_asset_set(cls._fixture_dir)

    @classmethod
    def tearDownClass(cls):
        cls._fixture_temp.cleanup()

    def setUp(self):
        self._test_temp = tempfile.TemporaryDirectory()
        self.asset_dir = Path(self._test_temp.name) / "assets"
        shutil.copytree(self._fixture_dir, self.asset_dir)

    def tearDown(self):
        self._test_temp.cleanup()

    def validate(self) -> dict[str, Path]:
        return require_task3("validate_source_assets")(
            self.asset_dir, rewards.WEAPONS
        )

    def test_valid_rgba_sources_are_returned_by_fixed_slug(self):
        sources = self.validate()

        self.assertEqual(
            [spec.image_slug for spec in rewards.WEAPONS], list(sources)
        )
        self.assertEqual(
            {
                spec.image_slug: self.asset_dir / f"{spec.image_slug}.png"
                for spec in rewards.WEAPONS
            },
            sources,
        )

    def test_wrong_dimensions_are_rejected(self):
        spec = rewards.WEAPONS[0]
        write_rgba_fixture(
            self.asset_dir / f"{spec.image_slug}.png", size=(1023, 1024)
        )

        with self.assertRaises(ValueError):
            self.validate()

    def test_rgb_without_alpha_is_rejected(self):
        spec = rewards.WEAPONS[0]
        Image.new("RGB", (1024, 1024), (20, 40, 60)).save(
            self.asset_dir / f"{spec.image_slug}.png", format="PNG"
        )

        with self.assertRaises(ValueError):
            self.validate()

    def test_fully_opaque_image_is_rejected(self):
        spec = rewards.WEAPONS[0]
        write_rgba_fixture(
            self.asset_dir / f"{spec.image_slug}.png",
            visible_box=None,
            background=(20, 40, 60, 255),
        )

        with self.assertRaises(ValueError):
            self.validate()

    def test_fully_transparent_image_is_rejected(self):
        spec = rewards.WEAPONS[0]
        write_rgba_fixture(
            self.asset_dir / f"{spec.image_slug}.png", visible_box=None
        )

        with self.assertRaises(ValueError):
            self.validate()

    def test_visible_bounds_require_at_least_24_pixels_on_every_edge(self):
        spec = rewards.WEAPONS[0]
        write_rgba_fixture(
            self.asset_dir / f"{spec.image_slug}.png",
            visible_box=(23, 32, 992, 992),
        )

        with self.assertRaises(ValueError):
            self.validate()

    def test_duplicate_sha256_content_is_rejected(self):
        first, second = rewards.WEAPONS[:2]
        shutil.copyfile(
            self.asset_dir / f"{first.image_slug}.png",
            self.asset_dir / f"{second.image_slug}.png",
        )

        with self.assertRaises(ValueError):
            self.validate()

    def test_missing_source_name_is_rejected(self):
        spec = rewards.WEAPONS[0]
        (self.asset_dir / f"{spec.image_slug}.png").unlink()

        with self.assertRaises(ValueError):
            self.validate()

    def test_unexpected_source_name_is_rejected(self):
        write_rgba_fixture(self.asset_dir / "unexpected.png")

        with self.assertRaises(ValueError):
            self.validate()

    def test_non_png_bytes_are_rejected(self):
        spec = rewards.WEAPONS[0]
        (self.asset_dir / f"{spec.image_slug}.png").write_bytes(b"not a png")

        with self.assertRaises(ValueError):
            self.validate()

    def test_install_uses_only_png_magic_encoding_and_exact_hashed_paths(self):
        sources = self.validate()
        original = {slug: path.read_bytes() for slug, path in sources.items()}
        store = Path(self._test_temp.name) / "upload"

        installed = require_task3("install_source_assets")(
            store, sources, rewards.WEAPONS
        )

        expected = [
            rewards.q.hashed_rel(
                f"{rewards.IMAGE_PREFIX}/{spec.image_slug}.png"
            )
            for spec in rewards.WEAPONS
        ]
        self.assertEqual(expected, installed)
        self.assertEqual(
            len(rewards.WEAPONS),
            sum(1 for path in store.rglob("*") if path.is_file()),
        )
        for spec, relative in zip(rewards.WEAPONS, installed):
            with self.subTest(asset=spec.image_slug):
                source_bytes = original[spec.image_slug]
                stored_bytes = (store / relative).read_bytes()
                self.assertEqual(source_bytes, sources[spec.image_slug].read_bytes())
                self.assertEqual(wf_assets.png_encode(source_bytes), stored_bytes)
                self.assertEqual(source_bytes, wf_assets.png_decode(stored_bytes))

    def test_validate_assets_flag_reports_fixed_paths_without_touching_profile(self):
        output = io.StringIO()
        with (
            mock.patch.object(rewards, "SOURCE_ASSET_DIR", self.asset_dir),
            mock.patch.object(rewards, "require_cn_profile") as require_profile,
            mock.patch.object(rewards.q, "load_table") as load_table,
            mock.patch.object(sys, "argv", ["wf_rogue_rewards.py", "--validate-assets"]),
            contextlib.redirect_stdout(output),
        ):
            result = rewards.main()

        self.assertEqual(0, result)
        require_profile.assert_not_called()
        load_table.assert_not_called()
        report = output.getvalue()
        self.assertIn("15/15 valid", report)
        self.assertIn("15 distinct SHA-256", report)
        self.assertIn("item/equipment/mod/abyss/fire_01.png", report)
        self.assertIn("item/equipment/mod/abyss/universal_03.png", report)


class TestCnProfilePreflight(unittest.TestCase):
    def test_active_global_fails_before_any_read_write_or_publish(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            active_global = core.VersionProfile(
                id="global",
                label="Global",
                store=root / "global",
                fallback=None,
            )
            explicit_cn = core.VersionProfile(
                id="cn",
                label="CN",
                store=root / "cn",
                fallback=None,
            )
            active_global.store.mkdir()
            explicit_cn.store.mkdir()

            def resolve_profile(profile_id=None):
                return explicit_cn if profile_id == "cn" else active_global

            with (
                mock.patch.object(rewards.core, "resolve_profile", side_effect=resolve_profile),
                mock.patch.object(rewards.q, "load_table", return_value={}) as load_table,
                mock.patch.object(rewards.q, "save_table") as save_table,
                mock.patch.object(rewards, "load_json", return_value={}) as load_json,
                mock.patch.object(rewards, "save_json") as save_json,
                mock.patch.object(rewards.subprocess, "run") as publish,
                mock.patch.object(sys, "argv", ["wf_rogue_rewards.py"]),
            ):
                result = rewards.main()

            self.assertNotEqual(0, result)
            load_table.assert_not_called()
            save_table.assert_not_called()
            load_json.assert_not_called()
            save_json.assert_not_called()
            publish.assert_not_called()

    def test_profile_is_rechecked_immediately_before_publish(self):
        tables = fake_master_tables(placeholders=True)
        mirrors = fake_server_mirrors()
        cn_profile = core.VersionProfile(
            id="cn", label="CN", store=Path("cn-store"), fallback=None
        )
        stored_tables = {
            rewards.ITEM_T: copy.deepcopy(tables.items),
            rewards.EQUIP_T: copy.deepcopy(tables.equipment),
            rewards.EQUIP_STATUS_T: copy.deepcopy(tables.equipment_status),
            rewards.SOUL_T: copy.deepcopy(tables.ability_soul),
            rewards.RUSH_EVENT_T: copy.deepcopy(tables.rush_event),
        }
        stored_json = {
            "equipment_max_level.json": copy.deepcopy(mirrors.equipment_max_level),
            "equipment_element.json": copy.deepcopy(mirrors.equipment_element),
            "equipment_lookup.json": copy.deepcopy(mirrors.equipment_lookup),
            "equipment_ids.json": copy.deepcopy(mirrors.equipment_ids),
            "item_ids.json": copy.deepcopy(mirrors.item_ids),
        }

        def load_table(logical):
            return copy.deepcopy(stored_tables[logical])

        def save_table(logical, data):
            stored_tables[logical] = copy.deepcopy(data)

        def load_json(name):
            return copy.deepcopy(stored_json[name])

        def save_json(name, data):
            stored_json[name] = copy.deepcopy(data)

        with (
            mock.patch.object(
                rewards,
                "require_cn_profile",
                side_effect=[cn_profile, ValueError("active changed")],
            ) as preflight,
            mock.patch.object(rewards.q, "load_table", side_effect=load_table),
            mock.patch.object(rewards.q, "save_table", side_effect=save_table),
            mock.patch.object(rewards, "load_json", side_effect=load_json),
            mock.patch.object(rewards, "save_json", side_effect=save_json),
            mock.patch.object(
                rewards,
                "validate_source_assets",
                return_value={spec.image_slug: Path(f"{spec.image_slug}.png")
                              for spec in rewards.WEAPONS},
            ),
            mock.patch.object(
                rewards,
                "install_source_assets",
                return_value=[f"hash-{index}" for index in range(15)],
            ),
            mock.patch.object(rewards, "_print_asset_validation"),
            mock.patch.object(rewards, "_print_plan"),
            mock.patch.object(rewards.subprocess, "run") as publish,
            mock.patch.object(
                sys, "argv", ["wf_rogue_rewards.py", "--write", "--publish"]
            ),
        ):
            result = rewards.main()

        self.assertNotEqual(0, result)
        self.assertEqual(2, preflight.call_count)
        publish.assert_not_called()

    def test_write_validates_and_installs_sources_in_the_cn_store(self):
        tables = fake_master_tables(placeholders=True)
        mirrors = fake_server_mirrors()
        stored_tables = {
            rewards.ITEM_T: copy.deepcopy(tables.items),
            rewards.EQUIP_T: copy.deepcopy(tables.equipment),
            rewards.EQUIP_STATUS_T: copy.deepcopy(tables.equipment_status),
            rewards.SOUL_T: copy.deepcopy(tables.ability_soul),
            rewards.RUSH_EVENT_T: copy.deepcopy(tables.rush_event),
        }
        stored_json = {
            "equipment_max_level.json": copy.deepcopy(mirrors.equipment_max_level),
            "equipment_element.json": copy.deepcopy(mirrors.equipment_element),
            "equipment_lookup.json": copy.deepcopy(mirrors.equipment_lookup),
            "equipment_ids.json": copy.deepcopy(mirrors.equipment_ids),
            "item_ids.json": copy.deepcopy(mirrors.item_ids),
        }

        def load_table(logical):
            return copy.deepcopy(stored_tables[logical])

        def save_table(logical, data):
            stored_tables[logical] = copy.deepcopy(data)

        def load_json(name):
            return copy.deepcopy(stored_json[name])

        def save_json(name, data):
            stored_json[name] = copy.deepcopy(data)

        with tempfile.TemporaryDirectory() as directory:
            profile = core.VersionProfile(
                id="cn", label="CN", store=Path(directory), fallback=None
            )
            sources = {
                spec.image_slug: Path(directory) / f"{spec.image_slug}.png"
                for spec in rewards.WEAPONS
            }
            with (
                mock.patch.object(rewards, "require_cn_profile", return_value=profile),
                mock.patch.object(rewards.q, "load_table", side_effect=load_table),
                mock.patch.object(rewards.q, "save_table", side_effect=save_table),
                mock.patch.object(rewards, "load_json", side_effect=load_json),
                mock.patch.object(rewards, "save_json", side_effect=save_json),
                mock.patch.object(
                    rewards, "validate_source_assets", return_value=sources
                ) as validate,
                mock.patch.object(
                    rewards,
                    "install_source_assets",
                    return_value=[f"hash-{index}" for index in range(15)],
                ) as install,
                mock.patch.object(rewards, "_print_asset_validation"),
                mock.patch.object(rewards, "_print_plan"),
                mock.patch.object(sys, "argv", ["wf_rogue_rewards.py", "--write"]),
            ):
                result = rewards.main()

        self.assertEqual(0, result)
        validate.assert_called_once_with(rewards.SOURCE_ASSET_DIR, rewards.WEAPONS)
        install.assert_called_once_with(profile.store, sources, rewards.WEAPONS)


@unittest.skipUnless(not MISSING_API, "canonical builder API is not implemented yet")
class TestWeaponContract(unittest.TestCase):
    def test_all_canonical_fields_are_fixed(self):
        actual = [
            (spec.id, spec.name, spec.donor, spec.element, spec.group,
             f"{rewards.IMAGE_PREFIX}/{spec.image_slug}",
             tuple((effect.template_id, effect.effect_kind, effect.strength)
                   for effect in spec.effects))
            for spec in rewards.WEAPONS
        ]
        self.assertEqual(EXPECTED_WEAPONS, actual)

    def test_specs_are_immutable(self):
        with self.assertRaises(dataclasses.FrozenInstanceError):
            rewards.WEAPONS[0].name = "changed"
        with self.assertRaises(dataclasses.FrozenInstanceError):
            rewards.WEAPONS[0].effects[0].strength = 1


@unittest.skipUnless(not MISSING_API, "canonical builder API is not implemented yet")
class TestEquipmentGeneration(unittest.TestCase):
    def test_canonical_columns_match_verified_cn_schema(self):
        donor = [f"donor-{index}" for index in range(16)]
        leaf = rewards.build_equipment_leaf(core.write_csv_lines([donor]), rewards.WEAPONS[0])
        rows = core.read_csv_lines(leaf)

        self.assertEqual(1, len(rows))
        row = rows[0]
        self.assertEqual(16, len(row))
        self.assertEqual("mod_abyss_8000101", row[0])
        self.assertEqual("灰烬巨剑", row[1])
        self.assertEqual(donor[2:6], row[2:6])
        self.assertEqual("item/equipment/mod/abyss/fire_01", row[6])
        self.assertEqual(rewards.MODE_DESCRIPTION, row[7])
        self.assertEqual("5", row[8])
        self.assertEqual("true", row[9])
        self.assertEqual("8000101", row[10])
        self.assertEqual("5", row[11])
        self.assertEqual(donor[12:16], row[12:16])

    def test_equipment_leaf_preserves_string_or_bytes_type(self):
        donor_text = core.write_csv_lines([[f"donor-{index}" for index in range(16)]])
        for template_leaf in (donor_text, donor_text.encode("utf-8")):
            with self.subTest(leaf_type=type(template_leaf).__name__):
                result = rewards.build_equipment_leaf(template_leaf, rewards.WEAPONS[0])
                self.assertIs(type(template_leaf), type(result))

    def test_equipment_status_copies_the_complete_donor_level_map(self):
        donor_levels = {
            "1": "100,200",
            "5": {"normal": ["500", "900"], "awake": ["700", "1200"]},
        }
        status_table = {rewards.WEAPONS[0].donor: donor_levels}

        result = rewards.build_equipment_status(status_table, rewards.WEAPONS[0])

        self.assertEqual(donor_levels, result)
        self.assertIsNot(donor_levels, result)
        self.assertIsNot(donor_levels["5"], result["5"])
        result["5"]["normal"].append("changed")
        self.assertEqual(["500", "900"], donor_levels["5"]["normal"])


@unittest.skipUnless(not MISSING_API, "canonical builder API is not implemented yet")
class TestSoulGeneration(unittest.TestCase):
    def test_fire_greatsword_uses_only_requested_template_lines(self):
        leaf = rewards.build_soul_leaf(fake_templates(), rewards.WEAPONS[0])
        rows = core.read_csv_lines(leaf)
        self.assertEqual(2, len(rows))
        self.assertEqual(["32", "55"], [row[44] for row in rows])
        self.assertEqual(["5", "5"], [row[45] for row in rows])
        self.assertEqual(["Red", "Red"], [row[46] for row in rows])
        self.assertEqual(["3000000", "5000000"], [row[48] for row in rows])
        self.assertEqual([row[48] for row in rows], [row[49] for row in rows])

    def test_each_effect_uses_its_templates_first_line_and_fixed_columns(self):
        templates = fake_templates()
        for spec in rewards.WEAPONS:
            with self.subTest(weapon=spec.id):
                rows = core.read_csv_lines(rewards.build_soul_leaf(templates, spec))
                self.assertEqual(len(spec.effects), len(rows))
                for slot, (row, effect) in enumerate(zip(rows, spec.effects), start=1):
                    self.assertEqual(123, len(row))
                    self.assertEqual([str(slot), "1", "0"], row[:3])
                    self.assertEqual(effect.template_id, row[3])
                    self.assertEqual(effect.effect_kind, row[44])
                    self.assertEqual("5", row[45])
                    self.assertEqual(spec.group, row[46])
                    self.assertEqual(str(effect.strength), row[48])
                    self.assertEqual(row[48], row[49])
                    self.assertFalse(row[3].startswith("unwanted-"))


class TestMasterChanges(unittest.TestCase):
    def test_first_run_materializes_exactly_fifteen_owned_rows_per_table(self):
        tables = fake_master_tables()
        result = require_task2("build_master_changes")(tables)
        generated = {spec.id for spec in rewards.WEAPONS}

        self.assertEqual(generated, generated.intersection(result.equipment))
        self.assertEqual(generated, generated.intersection(result.equipment_status))
        self.assertEqual(generated, generated.intersection(result.ability_soul))
        self.assertEqual(15, len(generated.intersection(result.equipment)))
        self.assertEqual(15, len(generated.intersection(result.equipment_status)))
        self.assertEqual(15, len(generated.intersection(result.ability_soul)))
        self.assertFalse(generated.intersection(tables.equipment))
        self.assertFalse(generated.intersection(tables.equipment_status))
        self.assertFalse(generated.intersection(tables.ability_soul))

    def test_second_run_is_byte_for_byte_idempotent(self):
        tables = fake_master_tables(placeholders=True, binary=True)
        builder = require_task2("build_master_changes")
        first = builder(tables)
        tables_type = require_task2("MasterTables")
        second = builder(tables_type(
            items=first.items,
            equipment=first.equipment,
            equipment_status=first.equipment_status,
            ability_soul=first.ability_soul,
            rush_event=first.rush_event,
        ))

        self.assertEqual(first, second)
        for spec in rewards.WEAPONS:
            self.assertIs(bytes, type(first.equipment[spec.id]))
            self.assertIs(bytes, type(first.ability_soul[spec.id]))
            self.assertEqual(first.equipment[spec.id], second.equipment[spec.id])
            self.assertEqual(first.ability_soul[spec.id], second.ability_soul[spec.id])
        self.assertEqual(first.items[rewards.TOKEN_ID], second.items[rewards.TOKEN_ID])
        self.assertEqual(first.rush_event["700099"], second.rush_event["700099"])

    def test_foreign_reserved_equipment_fails_without_mutating_any_table(self):
        tables = fake_master_tables(placeholders=True)
        spec = rewards.WEAPONS[0]
        foreign = [f"foreign-{index}" for index in range(16)]
        foreign[0] = "not_owned_by_abyss"
        tables.equipment[spec.id] = core.write_csv_lines([foreign])
        before = copy.deepcopy(tables)

        with self.assertRaisesRegex(ValueError, spec.id):
            require_task2("build_master_changes")(tables)

        self.assertEqual(before, tables)

    def test_orphan_soul_or_status_requires_an_owned_equipment_row(self):
        spec = rewards.WEAPONS[0]
        for field, occupant in (
            ("ability_soul", core.write_csv_lines([["foreign-soul"]])),
            ("equipment_status", {"foreign": "status"}),
        ):
            with self.subTest(field=field):
                tables = fake_master_tables()
                getattr(tables, field)[spec.id] = occupant
                before = copy.deepcopy(tables)

                with self.assertRaisesRegex(ValueError, spec.id):
                    require_task2("build_master_changes")(tables)

                self.assertEqual(before, tables)

    def test_recognized_placeholders_may_be_replaced(self):
        tables = fake_master_tables(placeholders=True)
        result = require_task2("build_master_changes")(tables)

        for spec in rewards.WEAPONS:
            row = core.read_csv_lines(result.equipment[spec.id])[0]
            self.assertEqual(f"mod_abyss_{spec.id}", row[0])
            self.assertEqual(spec.name, row[1])
            self.assertEqual(f"{rewards.IMAGE_PREFIX}/{spec.image_slug}", row[6])
            self.assertEqual(tables.equipment_status[spec.donor], result.equipment_status[spec.id])
            self.assertNotEqual(tables.ability_soul[spec.id], result.ability_soul[spec.id])

    def test_token_is_cloned_and_rush_reward_changes_only_c10(self):
        tables = fake_master_tables()
        result = require_task2("build_master_changes")(tables)

        template = core.read_csv_lines(tables.items[rewards.TOKEN_TEMPLATE])[0]
        token = core.read_csv_lines(result.items[rewards.TOKEN_ID])[0]
        self.assertEqual("2370099", token[1])
        self.assertEqual("深渊代币", token[2])
        self.assertEqual(
            [value for index, value in enumerate(template) if index not in (0, 1, 2, 5)],
            [value for index, value in enumerate(token) if index not in (0, 1, 2, 5)],
        )

        before = core.read_csv_lines(tables.rush_event["700099"])[0]
        after = core.read_csv_lines(result.rush_event["700099"])[0]
        self.assertEqual("2370099", after[10])
        self.assertEqual(before[:10] + before[11:], after[:10] + after[11:])
        self.assertEqual(tables.rush_event["700001"], result.rush_event["700001"])

    def test_patch_rush_token_preserves_leaf_type(self):
        row = [f"rush-{index}" for index in range(18)]
        row[10] = rewards.TOKEN_TEMPLATE
        text = core.write_csv_lines([row])
        patcher = require_task2("patch_rush_token")

        for leaf in (text, text.encode("utf-8")):
            with self.subTest(leaf_type=type(leaf).__name__):
                result = patcher(leaf)
                self.assertIs(type(leaf), type(result))
                changed = core.read_csv_lines(result.decode("utf-8") if isinstance(result, bytes) else result)[0]
                self.assertEqual(rewards.TOKEN_ID, changed[10])
                self.assertEqual(row[:10] + row[11:], changed[:10] + changed[11:])


class TestServerMirrors(unittest.TestCase):
    def test_canonical_lookup_elements_and_donor_metadata_are_applied(self):
        mirrors = fake_server_mirrors()
        result = require_task2("apply_server_mirrors")(mirrors)

        self.assertEqual(
            [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, -1, -1, -1],
            [result.equipment_element[spec.id] for spec in rewards.WEAPONS],
        )
        for spec in rewards.WEAPONS:
            donor = mirrors.equipment_lookup[spec.donor]
            self.assertEqual({
                "name": spec.name,
                "rarity": "5",
                "category": donor["category"],
            }, result.equipment_lookup[spec.id])
            self.assertEqual(
                mirrors.equipment_max_level[spec.donor],
                result.equipment_max_level[spec.id],
            )
        self.assertEqual(mirrors.equipment_lookup["42"], result.equipment_lookup["42"])

    def test_id_mirrors_are_sorted_unique_integer_arrays(self):
        result = require_task2("apply_server_mirrors")(fake_server_mirrors())

        self.assertEqual(sorted(set(result.equipment_ids)), result.equipment_ids)
        self.assertEqual(sorted(set(result.item_ids)), result.item_ids)
        self.assertTrue(all(isinstance(value, int) for value in result.equipment_ids))
        self.assertTrue(all(isinstance(value, int) for value in result.item_ids))
        self.assertEqual(
            {int(spec.id) for spec in rewards.WEAPONS},
            {int(spec.id) for spec in rewards.WEAPONS}.intersection(result.equipment_ids),
        )
        self.assertIn(int(rewards.TOKEN_ID), result.item_ids)

    def test_second_run_produces_identical_json_bytes(self):
        applier = require_task2("apply_server_mirrors")
        first = applier(fake_server_mirrors())
        second = applier(first)

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            first_bytes = write_temp_mirrors(path, first)
            second_bytes = write_temp_mirrors(path, second)

        self.assertEqual(first, second)
        self.assertEqual(first_bytes, second_bytes)


if __name__ == "__main__":
    unittest.main(verbosity=2)
