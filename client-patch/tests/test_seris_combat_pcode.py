from __future__ import annotations

import hashlib
import importlib.util
import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PATCH_ROOT = ROOT / "client-patch" / "dual-form-v1"
PATCH_MODULE = PATCH_ROOT / "patch_pcode.py"
ABC_MODULE = PATCH_ROOT / "abc_methods.py"
MANIFEST = PATCH_ROOT / "patch-manifest-seris-combat.json"
BASELINE_SWF = (
    ROOT
    / "work"
    / "character_packs"
    / "seris_dragon_king"
    / "canary-runtime"
    / "ffdec-probe"
    / "input.swf"
)
PCODE_ROOT = (
    ROOT / "work" / "seris-combat" / "evidence" / "fresh-baseline-six" / "scripts"
)

BASELINE_SHA256 = "6217b2dacbb083eb76e260574c08eee732b38f3c9b5620caae1867c5e62e08e2"
METHODS = (
    {
        "method_name": "pinball.common.data.character:BattleCharacterLogic/resolvePathCollection",
        "pcode_path": "pinball/common/data/character/BattleCharacterLogic.pcode",
        "body_index": 17692,
        "code_sha256": "e89d17f76514e9ccb053aff7d17b5a76d6ad5bdc2d7168466e8bdc6d8f31635e",
        "patches": ["preload_rarity4_special_animation"],
        "required_maxstack": 7,
        "required_localcount": 15,
    },
    {
        "method_name": "pinball.scene.battle.battle.squad.member:MemberView/draw",
        "pcode_path": "pinball/scene/battle/battle/squad/member/MemberView.pcode",
        "body_index": 61044,
        "code_sha256": "2749c95ba3f18e3693c47795f7e3f556e1a129442b734485a5363bc922866190",
        "patches": ["swap_mod_dual_form_special_animation"],
        "required_maxstack": 4,
        "required_localcount": 25,
    },
    {
        "method_name": "pinball.online.battle.impact.attack:NormalAttackCalculator/_calculate",
        "pcode_path": "pinball/online/battle/impact/attack/NormalAttackCalculator.pcode",
        "body_index": 45447,
        "code_sha256": "7dddd5147a3e7d51a7ebd4fbdf2897513d8341ef980f185c7f05e19229378bfd",
        "patches": ["wet_thunder_final_multiplier"],
        "required_maxstack": 90,
        "required_localcount": 131,
    },
    {
        "method_name": "pinball.scene.battle.battle.condition:ConditionSlot/update",
        "pcode_path": "pinball/scene/battle/battle/condition/ConditionSlot.pcode",
        "body_index": 57024,
        "code_sha256": "68f7ca773222d9cee8bc6921cba6a538107fb06f1a9a679dc42c5d79408e15a6",
        "patches": ["seris_unique22_natural_exit_team_gauge"],
        "required_maxstack": 11,
        "required_localcount": 43,
    },
    {
        "method_name": "pinball.scene.battle.battle.squad.member:MemberImpl/enterEncoffinmentState",
        "pcode_path": "pinball/scene/battle/battle/squad/member/MemberImpl.pcode",
        "body_index": 60914,
        "code_sha256": "60958e4a5e91a88ddb6ef82571866d0c27c66585f776a03840303ed6c6e30220",
        "patches": ["seris_unique22_death_exit_team_gauge"],
        "required_maxstack": 3,
        "required_localcount": 5,
    },
    {
        "method_name": "pinball.scene.battle.battle.squad.member:MemberImpl/getStatModifierConditionExtention",
        "pcode_path": "pinball/scene/battle/battle/squad/member/MemberImpl.pcode",
        "body_index": 60770,
        "code_sha256": "c870bc992b097c518491a7f62d3163ea9d7b1f3abe2672e25f68f83b54986a27",
        "patches": ["seris_manifestation_debuff_extension"],
        "required_maxstack": 3,
        "required_localcount": 19,
    },
)


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestSerisCombatLocks(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.patch = load_module("seris_combat_patch", PATCH_MODULE)
        cls.abc = load_module("seris_combat_abc", ABC_MODULE)

    @unittest.skipUnless(BASELINE_SWF.is_file(), "exact 6217 SWF fixture is absent")
    def test_six_method_bytecode_locks_are_exact(self) -> None:
        self.assertEqual(BASELINE_SHA256, hashlib.sha256(BASELINE_SWF.read_bytes()).hexdigest())
        index = self.abc.index_swf_methods(BASELINE_SWF)
        for expected in METHODS:
            with self.subTest(method=expected["method_name"]):
                ref = index.require_ref(expected["method_name"])
                self.assertEqual(expected["body_index"], ref.body_index)
                self.assertEqual(expected["code_sha256"], hashlib.sha256(ref.code).hexdigest())

    @unittest.skipUnless(PCODE_ROOT.is_dir(), "fresh five-method P-code export is absent")
    def test_fresh_export_stack_and_local_locks_are_exact(self) -> None:
        for expected in METHODS:
            entry = {key: value for key, value in expected.items() if key != "body_index"}
            block = self.patch.read_baseline_method(PCODE_ROOT, entry)
            with self.subTest(method=expected["method_name"]):
                self.assertEqual(
                    [str(expected["required_maxstack"])],
                    re.findall(r"^\s*maxstack (\d+)\s*$", block, re.MULTILINE),
                )
                self.assertEqual(
                    [
                        {
                            "pinball.scene.battle.battle.squad.member:MemberView/draw": "23",
                            "pinball.scene.battle.battle.condition:ConditionSlot/update": "38",
                            "pinball.scene.battle.battle.squad.member:MemberImpl/enterEncoffinmentState": "2",
                        }.get(
                            expected["method_name"],
                            str(expected["required_localcount"]),
                        )
                    ],
                    re.findall(r"^\s*localcount (\d+)\s*$", block, re.MULTILINE),
                )

    def test_combined_manifest_is_exactly_the_locked_six_methods(self) -> None:
        self.assertTrue(MANIFEST.is_file(), "Seris combat manifest is missing")
        manifest = self.patch.load_manifest(MANIFEST)
        actual = manifest["methods"]
        expected = [{key: value for key, value in item.items() if key != "body_index"} for item in METHODS]
        self.assertEqual(expected, actual)


@unittest.skipUnless(PCODE_ROOT.is_dir(), "fresh five-method P-code export is absent")
class TestWetThunderFinalMultiplier(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.patch = load_module("seris_wet_patch", PATCH_MODULE)
        cls.entry = {key: value for key, value in METHODS[2].items() if key != "body_index"}
        cls.baseline = cls.patch.read_baseline_method(PCODE_ROOT, cls.entry)

    def test_wet_transform_is_thunder_and_unique23_guarded_before_floor(self) -> None:
        final = self.patch.patch_method_block(self.baseline, self.entry)
        anchor = final.index(self.patch.WET_DAMAGE_SUBTRACTION_ANCHOR)
        element = final.index('getproperty QName(PackageNamespace(""),"element")', anchor)
        thunder = final.index("pushbyte 3", element)
        unique = final.index("pushbyte 23", thunder)
        match = final.index('callproperty QName(Namespace("pinball.online.battle.impact:ImpactTarget"),"matchCondition"), 1', unique)
        multiply = final.index("pushdouble 1.3", match)
        floor = final.index('callproperty QName(PackageNamespace(""),"floor"), 1', multiply)
        self.assertLess(anchor, element)
        self.assertLess(element, thunder)
        self.assertLess(thunder, unique)
        self.assertLess(unique, match)
        self.assertLess(match, multiply)
        self.assertLess(multiply, floor)
        self.assertEqual(1, final.count("pushdouble 1.3"))
        self.assertEqual(1, final.count(f"{self.patch.WET_REJOIN_LABEL}:"))
        self.assertEqual(3, final.count(self.patch.WET_REJOIN_LABEL))
        self.assertNotIn("seris_dragon_king", final)
        self.assertNotIn("129999", final)

    def test_wet_transform_fails_closed_on_missing_or_duplicate_anchor(self) -> None:
        missing = self.baseline.replace(self.patch.WET_DAMAGE_SUBTRACTION_ANCHOR, "", 1)
        with self.assertRaisesRegex(self.patch.PcodePatchError, "anchor count 0"):
            self.patch.patch_method_block(missing, self.entry)

        duplicate = self.baseline.replace(
            self.patch.WET_DAMAGE_SUBTRACTION_ANCHOR,
            self.patch.WET_DAMAGE_SUBTRACTION_ANCHOR + "\n" + self.patch.WET_DAMAGE_SUBTRACTION_ANCHOR,
            1,
        )
        with self.assertRaisesRegex(self.patch.PcodePatchError, "anchor count 2"):
            self.patch.patch_method_block(duplicate, self.entry)


@unittest.skipUnless(PCODE_ROOT.is_dir(), "fresh six-method P-code export is absent")
class TestManifestationDebuffExtension(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.patch = load_module("seris_ability4_patch", PATCH_MODULE)
        cls.entry = {key: value for key, value in METHODS[5].items() if key != "body_index"}
        cls.baseline = cls.patch.read_baseline_method(PCODE_ROOT, cls.entry)

    def test_sentinel_is_exactly_half_only_while_source_member_has_unique22(self) -> None:
        final = self.patch.patch_method_block(self.baseline, self.entry)
        sentinel = final.index("pushdouble 0.625")
        unique = final.index("pushbyte 22", sentinel)
        active = final.index(
            'callproperty QName(PackageNamespace(""),"matchCondition"), 1', unique
        )
        exact_half = final.index("pushdouble 0.5", active)
        native_add = final.index(
            f"{self.patch.SERIS_DEBUFF_NATIVE_ADD_LABEL}:", exact_half
        )
        rejoin = final.index(f"{self.patch.SERIS_DEBUFF_REJOIN_LABEL}:", native_add)
        self.assertLess(sentinel, unique)
        self.assertLess(unique, active)
        self.assertLess(active, exact_half)
        self.assertLess(exact_half, native_add)
        self.assertLess(native_add, rejoin)
        self.assertLess(
            native_add,
            final.index(self.patch.SERIS_DEBUFF_EXTENSION_ADD_ANCHOR, native_add),
        )
        self.assertEqual(1, final.count("pushdouble 0.625"))
        self.assertEqual(1, final.count("pushdouble 0.5"))
        self.assertEqual(1, final.count("pushbyte 22"))
        self.assertNotIn("seris_dragon_king", final)
        self.assertNotIn("1299994", final)

    def test_transform_fails_closed_on_missing_or_duplicate_add_anchor(self) -> None:
        missing = self.baseline.replace(
            self.patch.SERIS_DEBUFF_EXTENSION_ADD_ANCHOR, "", 1
        )
        with self.assertRaisesRegex(self.patch.PcodePatchError, "anchor count 0"):
            self.patch.patch_method_block(missing, self.entry)

        duplicate = self.baseline.replace(
            self.patch.SERIS_DEBUFF_EXTENSION_ADD_ANCHOR,
            self.patch.SERIS_DEBUFF_EXTENSION_ADD_ANCHOR
            + "\n"
            + self.patch.SERIS_DEBUFF_EXTENSION_ADD_ANCHOR,
            1,
        )
        with self.assertRaisesRegex(self.patch.PcodePatchError, "anchor count 2"):
            self.patch.patch_method_block(duplicate, self.entry)


@unittest.skipUnless(PCODE_ROOT.is_dir(), "fresh six-method P-code export is absent")
class TestNaturalManifestationExitGauge(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.patch = load_module("seris_natural_exit_patch", PATCH_MODULE)
        cls.entry = {key: value for key, value in METHODS[3].items() if key != "body_index"}
        cls.baseline = cls.patch.read_baseline_method(PCODE_ROOT, cls.entry)

    def test_natural_expiry_grants_point_three_once_to_each_member(self) -> None:
        final = self.patch.patch_method_block(self.baseline, self.entry)
        removed = final.index(self.patch.SERIS_NATURAL_EXIT_ANCHOR)
        unique_kind = final.index("pushbyte 31", removed)
        unique_id = final.index("pushbyte 22", unique_kind)
        ability6 = final.index("pushshort 6000", unique_id)
        first_award = final.index("pushdouble 0.3", ability6)
        rejoin = final.index(f"{self.patch.SERIS_NATURAL_EXIT_REJOIN_LABEL}:", first_award)
        self.assertLess(removed, unique_kind)
        self.assertLess(unique_kind, unique_id)
        self.assertLess(unique_id, ability6)
        self.assertLess(ability6, first_award)
        self.assertLess(first_award, rejoin)
        self.assertEqual(3, final[ability6:rejoin].count("pushdouble 0.3"))
        self.assertEqual(3, final[ability6:rejoin].count('"addSkillPoint"'))
        self.assertEqual(1, final.count(f"{self.patch.SERIS_NATURAL_EXIT_REJOIN_LABEL}:"))
        self.assertNotIn("seris_dragon_king", final)
        self.assertNotIn("1299996", final)

    def test_natural_exit_transform_fails_closed_on_anchor_drift(self) -> None:
        missing = self.baseline.replace(self.patch.SERIS_NATURAL_EXIT_ANCHOR, "", 1)
        with self.assertRaisesRegex(self.patch.PcodePatchError, "anchor count 0"):
            self.patch.patch_method_block(missing, self.entry)

        duplicate = self.baseline.replace(
            self.patch.SERIS_NATURAL_EXIT_ANCHOR,
            self.patch.SERIS_NATURAL_EXIT_ANCHOR
            + "\n"
            + self.patch.SERIS_NATURAL_EXIT_ANCHOR,
            1,
        )
        with self.assertRaisesRegex(self.patch.PcodePatchError, "anchor count 2"):
            self.patch.patch_method_block(duplicate, self.entry)


@unittest.skipUnless(PCODE_ROOT.is_dir(), "fresh six-method P-code export is absent")
class TestDeathManifestationExitGauge(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.patch = load_module("seris_death_exit_patch", PATCH_MODULE)
        cls.entry = {key: value for key, value in METHODS[4].items() if key != "body_index"}
        cls.baseline = cls.patch.read_baseline_method(PCODE_ROOT, cls.entry)

    def test_death_grants_before_purge_only_when_unique22_and_ability6_exist(self) -> None:
        final = self.patch.patch_method_block(self.baseline, self.entry)
        unique = final.index("pushbyte 22")
        match = final.index('"matchConditions"', unique)
        ability6 = final.index("pushshort 6000", match)
        first_award = final.index("pushdouble 0.3", ability6)
        purge = final.index(self.patch.SERIS_DEATH_EXIT_PURGE_ANCHOR, first_award)
        self.assertLess(unique, match)
        self.assertLess(match, ability6)
        self.assertLess(ability6, first_award)
        self.assertLess(first_award, purge)
        self.assertEqual(3, final[ability6:purge].count("pushdouble 0.3"))
        self.assertEqual(3, final[ability6:purge].count('"addSkillPoint"'))
        self.assertNotIn("seris_dragon_king", final)
        self.assertNotIn("1299996", final)

    def test_death_exit_transform_fails_closed_on_purge_anchor_drift(self) -> None:
        missing = self.baseline.replace(self.patch.SERIS_DEATH_EXIT_PURGE_ANCHOR, "", 1)
        with self.assertRaisesRegex(self.patch.PcodePatchError, "anchor count 0"):
            self.patch.patch_method_block(missing, self.entry)

        duplicate = self.baseline.replace(
            self.patch.SERIS_DEATH_EXIT_PURGE_ANCHOR,
            self.patch.SERIS_DEATH_EXIT_PURGE_ANCHOR
            + "\n"
            + self.patch.SERIS_DEATH_EXIT_PURGE_ANCHOR,
            1,
        )
        with self.assertRaisesRegex(self.patch.PcodePatchError, "anchor count 2"):
            self.patch.patch_method_block(duplicate, self.entry)


if __name__ == "__main__":
    unittest.main()
