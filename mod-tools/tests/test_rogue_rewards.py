# -*- coding: utf-8 -*-
"""深渊武装纯数据构建器测试（合成行，不读取真实 CN store）。"""
from __future__ import annotations

import dataclasses
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
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


class TestApiSurface(unittest.TestCase):
    def test_canonical_builder_api_exists(self):
        self.assertEqual((), MISSING_API)


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
    def test_canonical_columns_replace_only_equipment_metadata(self):
        donor = [f"donor-{index}" for index in range(12)]
        leaf = rewards.build_equipment_leaf(core.write_csv_lines([donor]), rewards.WEAPONS[0])
        rows = core.read_csv_lines(leaf)

        self.assertEqual(1, len(rows))
        row = rows[0]
        self.assertEqual("item/equipment/mod/abyss/fire_01", row[0])
        self.assertEqual("灰烬巨剑", row[1])
        self.assertEqual("donor-2", row[2])
        self.assertEqual("donor-5", row[5])
        self.assertEqual(rewards.MODE_DESCRIPTION, row[6])
        self.assertEqual("0", row[7])
        self.assertEqual("5", row[8])
        self.assertEqual("true", row[9])
        self.assertEqual("8000101", row[10])
        self.assertEqual("5", row[11])

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


if __name__ == "__main__":
    unittest.main(verbosity=2)
