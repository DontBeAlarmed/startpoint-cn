from __future__ import annotations

import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PATCH_ROOT = ROOT / "client-patch" / "dual-form-v1"
PATCH_MODULE = PATCH_ROOT / "patch_pcode.py"
ABC_MODULE = PATCH_ROOT / "abc_methods.py"
PURE_MANIFEST = PATCH_ROOT / "patch-manifest-pure-pcode.json"
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
    ROOT
    / "work"
    / "character_packs"
    / "seris_dragon_king"
    / "client-pcode-baseline-6217-exact"
    / "scripts"
)


BASELINE_SHA256 = "6217b2dacbb083eb76e260574c08eee732b38f3c9b5620caae1867c5e62e08e2"
METHODS = (
    {
        "method_name": (
            "pinball.common.data.character:BattleCharacterLogic/"
            "resolvePathCollection"
        ),
        "pcode_path": "pinball/common/data/character/BattleCharacterLogic.pcode",
        "code_sha256": (
            "e89d17f76514e9ccb053aff7d17b5a76d6ad5bdc2d7168466e8bdc6d8f31635e"
        ),
        "patches": ["preload_rarity4_special_animation"],
        "required_maxstack": 7,
        "required_localcount": 15,
    },
    {
        "method_name": "pinball.scene.battle.battle.squad.member:MemberView/draw",
        "pcode_path": (
            "pinball/scene/battle/battle/squad/member/MemberView.pcode"
        ),
        "code_sha256": (
            "2749c95ba3f18e3693c47795f7e3f556e1a129442b734485a5363bc922866190"
        ),
        "patches": ["swap_mod_dual_form_special_animation"],
        "required_maxstack": 4,
        "required_localcount": 25,
    },
)
METHOD_NAMES = [entry["method_name"] for entry in METHODS]
METHOD_KEYS = {
    "method_name",
    "pcode_path",
    "code_sha256",
    "patches",
    "required_maxstack",
    "required_localcount",
}
FORBIDDEN_FINAL_TOKENS = (
    "DualFormPresentationController",
    "DualFormRuntimeMarker",
    "MemberHealthPointIndicatorPeek",
    "findpropstrict QName(PackageInternalNs",
)
ADD_ANIMATION_LAYOUT_CALL = (
    'callpropvoid QName(Namespace("pinball.asset.logic:'
    'IAssetPathCollectionBuilder"),"addAnimationLayout"), 1'
)
GET_RARITY_CALL = (
    'callproperty QName(PackageNamespace(""),"get_rarity"), 0'
)
GET_SPECIAL_ANIMATION_CALL = (
    'callproperty QName(PackageNamespace(""),'
    '"getSpecialPixelArtAnimationPath"), 0'
)
SPECIAL_PRELOAD_REJOIN_LABEL = "ofs7fff"
SKILL_CUTIN_PERMIT_ANCHOR = (
    '            getscopeobject 1\n'
    '            getslot 3\n'
    '            getproperty QName(PackageNamespace(""),"displaysSkillCutin")\n'
    '            iffalse ofs006b'
)


def load_module(name: str, path: Path):
    if not path.is_file():
        raise FileNotFoundError(path)
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def manifest_value(*, baseline_sha256: str = BASELINE_SHA256) -> dict:
    return {
        "schema_version": 3,
        "injection_strategy": "pure_pcode_existing_classes",
        "baseline": {
            "main_swf_sha256": baseline_sha256,
            "resource_version": "1.4.54",
        },
        "methods": [dict(entry) for entry in METHODS],
    }


def write_manifest(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def method_block(entry: dict, *, extra: str = "") -> str:
    trait_name = entry["method_name"].rsplit("/", 1)[1]
    extra_line = f"            {extra}\n" if extra else ""
    return (
        f'trait method QName(PackageNamespace(""),"{trait_name}")\n'
        "    method\n"
        f'        name "{trait_name}"\n'
        "        body\n"
        f"            maxstack {entry['required_maxstack']}\n"
        f"            localcount {entry['required_localcount']}\n"
        "            initscopedepth 1\n"
        "            maxscopedepth 1\n"
        f"{extra_line}"
        "            returnvoid\n"
        "        end ; body\n"
        "    end ; method\n"
        "end ; trait\n"
    )


def write_pcode_tree(root: Path, *, extras: dict[str, str] | None = None) -> None:
    extras = extras or {}
    for entry in METHODS:
        destination = root / entry["pcode_path"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        extra = extras.get(entry["method_name"], "")
        destination.write_text(method_block(entry, extra=extra), encoding="utf-8")


class TestPurePcodeManifest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.patch = load_module("dual_form_pcode_patch", PATCH_MODULE)

    def test_pure_pcode_manifest_has_no_carrier_or_import_script(self) -> None:
        self.assertTrue(PURE_MANIFEST.is_file(), "pure-P-code manifest is missing")
        manifest = self.patch.load_manifest(PURE_MANIFEST)

        self.assertEqual(
            manifest["injection_strategy"], "pure_pcode_existing_classes"
        )
        self.assertNotIn("carrier", manifest)
        self.assertEqual(METHOD_NAMES, [m["method_name"] for m in manifest["methods"]])
        self.assertEqual(
            {"schema_version", "injection_strategy", "baseline", "methods"},
            set(manifest),
        )
        self.assertEqual(
            {"main_swf_sha256", "resource_version"}, set(manifest["baseline"])
        )
        self.assertEqual(BASELINE_SHA256, manifest["baseline"]["main_swf_sha256"])
        self.assertEqual("1.4.54", manifest["baseline"]["resource_version"])
        for entry in manifest["methods"]:
            self.assertEqual(METHOD_KEYS, set(entry))
        self.assertEqual(
            [
                ["preload_rarity4_special_animation"],
                ["swap_mod_dual_form_special_animation"],
            ],
            [entry["patches"] for entry in manifest["methods"]],
        )
        self.assertEqual(25, manifest["methods"][1]["required_localcount"])

    def test_schema_3_validation_is_exact_and_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "manifest.json"
            write_manifest(path, manifest_value())
            try:
                loaded = self.patch.load_manifest(path)
            except self.patch.PcodePatchError as exc:
                self.fail(f"valid schema-3 manifest was rejected: {exc}")
            self.assertEqual(3, loaded["schema_version"])

            invalid_cases = []
            extra_top_level = manifest_value()
            extra_top_level["carrier"] = {}
            invalid_cases.append(("unexpected top-level key", extra_top_level))
            missing_localcount = manifest_value()
            del missing_localcount["methods"][0]["required_localcount"]
            invalid_cases.append(("missing method key", missing_localcount))
            uppercase_hash = manifest_value()
            uppercase_hash["methods"][0]["code_sha256"] = "A" * 64
            invalid_cases.append(("uppercase hash", uppercase_hash))
            unsupported_strategy = manifest_value()
            unsupported_strategy["injection_strategy"] = "pcode_method_trampolines"
            invalid_cases.append(("unsupported strategy", unsupported_strategy))
            wrong_resource_version = manifest_value()
            wrong_resource_version["baseline"]["resource_version"] = "1.4.55"
            invalid_cases.append(("wrong resource version", wrong_resource_version))
            extra_method_key = manifest_value()
            extra_method_key["methods"][0]["body_index"] = 17692
            invalid_cases.append(("legacy body index", extra_method_key))

            for label, invalid in invalid_cases:
                with self.subTest(label=label):
                    write_manifest(path, invalid)
                    with self.assertRaises(self.patch.PcodePatchError):
                        self.patch.load_manifest(path)

    def test_required_localcount_only_increases_and_fails_on_bad_declarations(self) -> None:
        original = "method\n    localcount 3\nend ; method\n"
        self.assertIn("localcount 5", self.patch._set_required_localcount(original, 5))
        self.assertEqual(original, self.patch._set_required_localcount(original, 2))
        for damaged in (
            "method\nend ; method\n",
            "method\n    localcount 3\n    localcount 4\nend ; method\n",
        ):
            with self.subTest(damaged=damaged):
                with self.assertRaisesRegex(
                    self.patch.PcodePatchError, "one localcount declaration"
                ):
                    self.patch._set_required_localcount(damaged, 5)

    @unittest.skipUnless(BASELINE_SWF.is_file(), "exact 6217 SWF fixture is absent")
    def test_pure_manifest_locks_exact_two_baseline_method_codes(self) -> None:
        manifest = self.patch.load_manifest(PURE_MANIFEST)
        abc = load_module("dual_form_abc_patch_test", ABC_MODULE)
        index = abc.index_swf_methods(BASELINE_SWF)
        resolved_indices = []
        for entry in manifest["methods"]:
            ref = index.require_ref(entry["method_name"])
            self.assertEqual(entry["code_sha256"], hashlib.sha256(ref.code).hexdigest())
            resolved_indices.append(ref.body_index)
        self.assertEqual(2, len(set(resolved_indices)))

    @unittest.skipUnless(
        BASELINE_SWF.is_file() and PCODE_ROOT.is_dir(),
        "exact 6217 SWF/P-code fixtures are absent",
    )
    def test_schema_3_generator_applies_candidate_b_patches(self) -> None:
        with tempfile.TemporaryDirectory(dir=ROOT / "work") as temporary:
            output = Path(temporary)
            report = self.patch.generate_patch_set(
                BASELINE_SWF,
                PCODE_ROOT,
                output,
                PURE_MANIFEST,
            )
            self.assertEqual("generated", report["status"])
            self.assertEqual(2, report["method_count"])
            self.assertEqual(2, len(list(output.glob("*.pcode"))))
            generated_preload = Path(report["outputs"][0]["output"]).read_text(
                encoding="utf-8"
            )
            generated_swap = Path(report["outputs"][1]["output"]).read_text(
                encoding="utf-8"
            )
            self.assertEqual(1, generated_preload.count(GET_SPECIAL_ANIMATION_CALL))
            self.assertEqual(1, generated_swap.count('pushstring "ModDualForm"'))
            self.assertEqual(1, generated_swap.count("localcount 25"))

    @unittest.skipUnless(BASELINE_SWF.is_file(), "exact 6217 SWF fixture is absent")
    def test_replacement_body_indexes_are_resolved_from_the_baseline_copy(self) -> None:
        targets = self.patch.resolve_replacement_targets(BASELINE_SWF, PURE_MANIFEST)
        self.assertEqual(METHOD_NAMES, [target["method_name"] for target in targets])
        self.assertEqual([17692, 61044], [target["replacement_body_index"] for target in targets])


class TestPurePcodeCandidateA(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.patch = load_module("dual_form_pcode_candidate_a", PATCH_MODULE)

    def baseline_and_entry(self) -> tuple[str, dict]:
        manifest = self.patch.load_manifest(PURE_MANIFEST)
        entry = manifest["methods"][0]
        block = self.patch.read_baseline_method(PCODE_ROOT, entry)
        return block, entry

    @unittest.skipUnless(
        BASELINE_SWF.is_file() and PCODE_ROOT.is_dir(),
        "exact 6217 SWF/P-code fixtures are absent",
    )
    def test_preload_special_uses_only_existing_numeric_rarity_api(self) -> None:
        baseline, entry = self.baseline_and_entry()
        self.assertEqual(5, baseline.count(ADD_ANIMATION_LAYOUT_CALL))
        self.assertEqual(0, baseline.count(GET_RARITY_CALL))
        self.assertEqual(0, baseline.count(GET_SPECIAL_ANIMATION_CALL))
        self.assertNotIn(f"{SPECIAL_PRELOAD_REJOIN_LABEL}:", baseline)

        try:
            final = self.patch.patch_method_block(baseline, entry)
        except self.patch.PcodePatchError as exc:
            self.fail(str(exc))

        self.assertEqual(1, final.count(GET_RARITY_CALL))
        self.assertEqual(1, final.count("pushbyte 4"))
        self.assertEqual(1, final.count(GET_SPECIAL_ANIMATION_CALL))
        self.assertEqual(6, final.count(ADD_ANIMATION_LAYOUT_CALL))
        self.assertEqual(
            baseline.count(ADD_ANIMATION_LAYOUT_CALL) + 1,
            final.count(ADD_ANIMATION_LAYOUT_CALL),
        )
        self.assertNotIn("ModDualForm", final)
        self.assertNotIn("DualForm", final)

        injected_and_rejoin = self.patch._code(
            'findproperty QName(PackageNamespace(""),"get_rarity")',
            GET_RARITY_CALL,
            "convert_i",
            "pushbyte 4",
            f"iflt {SPECIAL_PRELOAD_REJOIN_LABEL}",
            "getscopeobject 1",
            "getslot 1",
            'findproperty QName(PackageNamespace(""),'
            '"getSpecialPixelArtAnimationPath")',
            GET_SPECIAL_ANIMATION_CALL,
            'coerce QName(PackageNamespace(""),"String")',
            ADD_ANIMATION_LAYOUT_CALL,
        ) + f"\n   {SPECIAL_PRELOAD_REJOIN_LABEL}:"
        expected_prefix = (
            self.patch.PRELOAD_ANCHOR
            + "\n"
            + injected_and_rejoin
            + "\n"
            + SKILL_CUTIN_PERMIT_ANCHOR
        )
        self.assertIn(expected_prefix, final)

        normal_start = final.index(self.patch.PRELOAD_ANCHOR)
        rejoin_start = final.index(
            f"   {SPECIAL_PRELOAD_REJOIN_LABEL}:", normal_start
        )
        local_prefix = final[normal_start:rejoin_start]
        self.assertEqual(2, local_prefix.count(ADD_ANIMATION_LAYOUT_CALL))
        self.assertEqual(1, local_prefix.count(f"iflt {SPECIAL_PRELOAD_REJOIN_LABEL}"))

        baseline_suffix_start = baseline.index(
            SKILL_CUTIN_PERMIT_ANCHOR,
            baseline.index(self.patch.PRELOAD_ANCHOR),
        )
        final_suffix_start = final.index(SKILL_CUTIN_PERMIT_ANCHOR, rejoin_start)
        self.assertEqual(
            baseline[baseline_suffix_start:],
            final[final_suffix_start:],
        )
        self.assertEqual(
            4,
            final[final_suffix_start:].count(ADD_ANIMATION_LAYOUT_CALL),
        )

        self.assertEqual(1, final.count("maxstack 7"))
        self.assertEqual(1, final.count("localcount 15"))
        self.assertEqual(0, final.count("maxstack 8"))
        self.assertEqual(0, final.count("localcount 16"))

        character_base = (
            PCODE_ROOT
            / "pinball"
            / "common"
            / "data"
            / "battle"
            / "squadMember"
            / "CharacterBaseImpl.pcode"
        ).read_text(encoding="utf-8")
        self.assertIn(
            'trait method QName(PackageNamespace(""),'
            '"getSpecialPixelArtAnimationPath")',
            character_base,
        )
        battle_logic_source = (
            PCODE_ROOT / entry["pcode_path"]
        ).read_text(encoding="utf-8")
        self.assertIn(GET_RARITY_CALL, battle_logic_source)

    @unittest.skipUnless(PCODE_ROOT.is_dir(), "exact 6217 P-code fixture is absent")
    def test_preload_special_fails_closed_on_duplicate_anchor_or_marker(self) -> None:
        baseline, entry = self.baseline_and_entry()
        duplicated = baseline.replace(
            self.patch.PRELOAD_ANCHOR,
            self.patch.PRELOAD_ANCHOR + "\n" + self.patch.PRELOAD_ANCHOR,
            1,
        )
        with self.assertRaisesRegex(
            self.patch.PcodePatchError,
            "anchor count 2; expected 1",
        ):
            self.patch.patch_method_block(duplicated, entry)

        marked = baseline.replace(
            self.patch.PRELOAD_ANCHOR,
            self.patch.PRELOAD_ANCHOR
            + "\n"
            + self.patch._code(
                'findproperty QName(PackageNamespace(""),'
                '"getSpecialPixelArtAnimationPath")',
                GET_SPECIAL_ANIMATION_CALL,
                "pop",
            ),
            1,
        )
        with self.assertRaisesRegex(
            self.patch.PcodePatchError,
            "already contains patch marker",
        ):
            self.patch.patch_method_block(marked, entry)


class TestPurePcodeCandidateB(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.patch = load_module("dual_form_pcode_candidate_b", PATCH_MODULE)

    def baseline_and_entry(self) -> tuple[str, dict]:
        manifest = self.patch.load_manifest(PURE_MANIFEST)
        entry = dict(manifest["methods"][1])
        entry["patches"] = ["swap_mod_dual_form_special_animation"]
        entry["required_localcount"] = 25
        baseline = self.patch.read_baseline_method(PCODE_ROOT, entry)
        return baseline, entry

    def patch_one(self) -> tuple[str, str, dict]:
        baseline, entry = self.baseline_and_entry()
        try:
            final = self.patch.patch_method_block(baseline, entry)
        except self.patch.PcodePatchError as exc:
            self.fail(str(exc))
        return baseline, final, entry

    @unittest.skipUnless(PCODE_ROOT.is_dir(), "exact 6217 P-code fixture is absent")
    def test_member_view_swap_is_generic_existing_api_only(self) -> None:
        _baseline, final, _entry = self.patch_one()
        required = (
            'pushstring "ModDualForm"',
            'callproperty QName(Namespace("http://adobe.com/AS3/2006/builtin"),"indexOf"), 1',
            'callproperty QName(Namespace("pinball.scene.battle.battle.squad.member:MemberPeek"),"getCharacter"), 0',
            'getproperty QName(PackageNamespace(""),"characterTags")',
            'pushbyte 22',
            'callproperty QName(PackageNamespace(""),"Unique"), 1',
            'callproperty QName(PackageNamespace(""),"matchCondition"), 1',
            'pushstring "character/"',
            'getproperty QName(PackageNamespace(""),"mainCharacterStringId")',
            'pushstring "/pixelart/special"',
            'callproperty QName(Namespace("pinball.scene.battle.battle.squad.member:MemberPeek"),"getCharacterAnimation"), 0',
            'callproperty QName(PackageNamespace(""),"get_path"), 0',
            'callproperty QName(PackageNamespace(""),"getAnimation"), 1',
            'callpropvoid QName(PackageNamespace(""),"removeChild"), 2',
            'pushtrue',
            'callpropvoid QName(PackageNamespace(""),"addChild"), 1',
        )
        for token in required:
            with self.subTest(token=token):
                self.assertIn(token, final)
        for token in (
            "129999",
            "seris_dragon_king",
            "DualFormPresentationController",
            "DualFormRuntimeMarker",
        ):
            with self.subTest(forbidden=token):
                self.assertNotIn(token, final)

    @unittest.skipUnless(PCODE_ROOT.is_dir(), "exact 6217 P-code fixture is absent")
    def test_member_view_swap_preserves_suffix_and_structural_contract(self) -> None:
        baseline, final, _entry = self.patch_one()
        suffix_anchor = self.patch._code(
            'findproperty QName(PackageNamespace(""),"member")',
            'getproperty QName(PackageNamespace(""),"member")',
            'callproperty QName(Namespace('
            '"pinball.scene.battle.battle.squad.member:MemberPeek"),'
            '"canDisplay"), 0',
            "convert_b",
        )
        baseline_suffix_start = baseline.index(
            suffix_anchor,
            baseline.index(self.patch.SELECT_VIEW_ANCHOR),
        )
        final_suffix_start = final.index(
            suffix_anchor,
            final.index(f"   {self.patch.DUAL_FORM_SWAP_REJOIN_LABEL}:"),
        )
        self.assertEqual(
            baseline[baseline_suffix_start:],
            final[final_suffix_start:],
        )

        injection_start = final.index(
            self.patch.SELECT_VIEW_ANCHOR.rsplit("\n", 1)[0]
        )
        injected = final[injection_start:final_suffix_start]
        expected_counts = {
            'pushstring "ModDualForm"': 1,
            'callproperty QName(Namespace("http://adobe.com/AS3/2006/builtin"),"indexOf"), 1': 1,
            "pushbyte 22": 1,
            'callproperty QName(PackageNamespace(""),"Unique"), 1': 1,
            'callproperty QName(PackageNamespace(""),"matchCondition"), 1': 1,
            'pushstring "character/"': 1,
            'pushstring "/pixelart/special"': 1,
            'callproperty QName(PackageNamespace(""),"get_path"), 0': 1,
            'callproperty QName(PackageNamespace(""),"getAnimation"), 1': 1,
            'callpropvoid QName(PackageNamespace(""),"removeChild"), 2': 1,
            "pushtrue": 1,
            'callpropvoid QName(PackageNamespace(""),"addChild"), 1': 1,
        }
        for token, count in expected_counts.items():
            with self.subTest(token=token):
                self.assertEqual(count, injected.count(token))
        self.assertEqual(
            1,
            injected.count(
                'setproperty QName(PackageNamespace(""),"character")'
            ),
        )
        self.assertEqual(
            0,
            injected.count(
                'initproperty QName(PackageNamespace(""),"character")'
            ),
        )
        self.assertEqual(1, final.count("maxstack 4"))
        self.assertEqual(1, final.count("localcount 25"))

        for label, reference_count in (
            (self.patch.DUAL_FORM_SWAP_HUMAN_LABEL, 1),
            (self.patch.DUAL_FORM_SWAP_PATH_READY_LABEL, 1),
            (self.patch.DUAL_FORM_SWAP_REJOIN_LABEL, 2),
        ):
            with self.subTest(label=label):
                self.assertEqual(1, injected.count(f"{label}:"))
                self.assertEqual(reference_count + 1, injected.count(label))
        try:
            self.patch._canonicalize_offset_labels(final)
        except self.patch.PcodePatchError as exc:
            self.fail(f"generated branch topology was rejected: {exc}")

        for forbidden in (
            "129999",
            "seris_dragon_king",
            "DualFormPresentationController",
            "DualFormRuntimeMarker",
            "MemberHealthPointIndicatorPeek",
            "getTimer",
            "addCondition",
            "removeCondition",
            "invokeSkill",
            "startSkill",
            "gotoAndPlay",
        ):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, injected)

        original_frame_fingerprint = self.patch._code(
            'findproperty QName(PackageNamespace(""),"character")',
            'getproperty QName(PackageNamespace(""),"character")',
            'findproperty QName(PackageNamespace(""),"member")',
            'getproperty QName(PackageNamespace(""),"member")',
            'callproperty QName(Namespace('
            '"pinball.scene.battle.battle.squad.member:MemberPeek"),'
            '"getCurrentFrameCharacterAnimation"), 0',
            "convert_i",
            'callpropvoid QName(PackageNamespace(""),"gotoAndStop"), 1',
        )
        position_red_z_fingerprint = self.patch._code(
            'findproperty QName(PackageNamespace(""),"character")',
            'getproperty QName(PackageNamespace(""),"character")',
            "getlocal 13",
            'initproperty QName(PackageNamespace(""),"x")',
            'findproperty QName(PackageNamespace(""),"character")',
            'getproperty QName(PackageNamespace(""),"character")',
            "getlocal 14",
            "getlocal 15",
            "subtract",
            'initproperty QName(PackageNamespace(""),"y")',
            'findproperty QName(PackageNamespace(""),"character")',
            'getproperty QName(PackageNamespace(""),"character")',
            'findproperty QName(PackageNamespace(""),"member")',
            'getproperty QName(PackageNamespace(""),"member")',
            'callproperty QName(Namespace('
            '"pinball.scene.battle.battle.squad.member:MemberPeek"),'
            '"isDamageFlashing"), 0',
            "convert_b",
            'callpropvoid QName(PackageNamespace(""),"red"), 1',
            'findproperty QName(PackageNamespace(""),"character")',
            'getproperty QName(PackageNamespace(""),"character")',
            "getlocal 14",
            'initproperty QName(PackageNamespace(""),"zIndex1")',
        )
        self.assertIn(original_frame_fingerprint, final)
        self.assertIn(position_red_z_fingerprint, final)

    @unittest.skipUnless(PCODE_ROOT.is_dir(), "exact 6217 P-code fixture is absent")
    def test_member_view_swap_fails_closed_on_duplicate_anchor_or_marker(self) -> None:
        baseline, entry = self.baseline_and_entry()
        duplicated = baseline.replace(
            self.patch.SELECT_VIEW_ANCHOR,
            self.patch.SELECT_VIEW_ANCHOR
            + "\n"
            + self.patch.SELECT_VIEW_ANCHOR,
            1,
        )
        with self.assertRaisesRegex(
            self.patch.PcodePatchError,
            "anchor count 2; expected 1",
        ):
            self.patch.patch_method_block(duplicated, entry)

        marked = baseline.replace(
            self.patch.SELECT_VIEW_ANCHOR,
            self.patch.SELECT_VIEW_ANCHOR
            + "\n"
            + self.patch._code(
                self.patch.DUAL_FORM_SWAP_MARKER,
                "pop",
            ),
            1,
        )
        with self.assertRaisesRegex(
            self.patch.PcodePatchError,
            "already contains patch marker",
        ):
            self.patch.patch_method_block(marked, entry)

    @unittest.skipUnless(PCODE_ROOT.is_dir(), "exact 6217 P-code fixture is absent")
    def test_member_view_swap_structural_verifier_rejects_tampered_output(self) -> None:
        baseline, entry = self.baseline_and_entry()
        patch_id = "swap_mod_dual_form_special_animation"
        original = self.patch.PATCH_SPECS[patch_id]

        def tampered(anchor: str) -> str:
            return original.replace(anchor).replace("pushbyte 22", "pushbyte 21", 1)

        self.patch.PATCH_SPECS[patch_id] = original._replace(replace=tampered)
        try:
            with self.assertRaisesRegex(
                self.patch.PcodePatchError,
                "dual-form swap structural contract",
            ):
                self.patch.patch_method_block(baseline, entry)
        finally:
            self.patch.PATCH_SPECS[patch_id] = original


class TestPurePcodeFinalVerifier(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.patch = load_module("dual_form_pcode_verifier", PATCH_MODULE)

    def verify_fixture(
        self,
        temporary: Path,
        *,
        forbidden_method: str = "",
        token: str = "",
        final_matches_baseline: bool = False,
        final_pcode_matches_baseline: bool = False,
        patched_method_extra: str = "nop",
        generated_method_extra: str = "nop",
        swap_method_extra: str = "pushnull",
        generated_swap_method_extra: str = "pushnull",
        targets: list[dict] | None = None,
    ) -> dict:
        baseline_pcode = temporary / "baseline-pcode"
        final_pcode = temporary / "final-pcode"
        write_pcode_tree(baseline_pcode)
        final_extras = {
            METHODS[0]["method_name"]: (
                "" if final_pcode_matches_baseline else patched_method_extra
            ),
            METHODS[1]["method_name"]: swap_method_extra,
        }
        if forbidden_method:
            final_extras[forbidden_method] = token
        write_pcode_tree(final_pcode, extras=final_extras)
        generated_preload_pcode = temporary / "generated-resolvePathCollection.pcode"
        generated_preload_pcode.write_text(
            method_block(
                METHODS[0], extra=generated_method_extra
            ).removesuffix("end ; trait\n"),
            encoding="utf-8",
        )
        generated_swap_pcode = temporary / "generated-draw.pcode"
        generated_swap_pcode.write_text(
            method_block(
                METHODS[1], extra=generated_swap_method_extra
            ).removesuffix("end ; trait\n"),
            encoding="utf-8",
        )
        baseline_swf = temporary / "baseline.swf"
        final_swf = temporary / "final.swf"
        baseline_swf.write_bytes(b"locked baseline")
        final_swf.write_bytes(
            b"locked baseline" if final_matches_baseline else b"patched output"
        )
        manifest_path = temporary / "manifest.json"
        write_manifest(
            manifest_path,
            manifest_value(
                baseline_sha256=hashlib.sha256(baseline_swf.read_bytes()).hexdigest()
            ),
        )
        if targets is None:
            targets = [
                {
                    "method_name": METHODS[0]["method_name"],
                    "replacement_body_index": 17692,
                    "generated_pcode": str(generated_preload_pcode),
                },
                {
                    "method_name": METHODS[1]["method_name"],
                    "replacement_body_index": 61044,
                    "generated_pcode": str(generated_swap_pcode),
                },
            ]
        return self.patch.verify_pcode_export(
            baseline_pcode,
            final_pcode,
            manifest_path,
            baseline_swf=baseline_swf,
            final_swf=final_swf,
            replacement_targets=targets,
        )

    def test_final_verifier_records_exact_two_replacement_body_indices(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            report = self.verify_fixture(Path(temporary))
        self.assertEqual(
            {
                METHODS[0]["method_name"]: 17692,
                METHODS[1]["method_name"]: 61044,
            },
            report["replacement_body_indices"],
        )
        self.assertEqual(2, report["method_count"])
        self.assertTrue(report["device_canary_required"])

    def test_final_verifier_rejects_unchanged_swf(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(
                self.patch.PcodePatchError, "final SWF sha256 matches baseline"
            ):
                self.verify_fixture(Path(temporary), final_matches_baseline=True)

    def test_final_verifier_rejects_unchanged_target_method_bodies(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(
                self.patch.PcodePatchError, "target method body is unchanged"
            ):
                self.verify_fixture(
                    Path(temporary), final_pcode_matches_baseline=True
                )

    def test_final_verifier_rejects_second_body_that_differs_from_generated_replacement(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(
                self.patch.PcodePatchError,
                "does not match generated replacement",
            ):
                self.verify_fixture(
                    Path(temporary),
                    swap_method_extra="pushnull",
                    generated_swap_method_extra="nop",
                )

    def test_final_verifier_rejects_body_that_differs_from_generated_replacement(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(
                self.patch.PcodePatchError, "does not match generated replacement"
            ):
                self.verify_fixture(
                    Path(temporary), patched_method_extra="pushnull"
                )

    def test_final_verifier_accepts_ffdec_offset_label_renumbering(self) -> None:
        generated = (
            "jump ofs03f0\n"
            "ofs03e5:\n"
            "            jump ofs03e5\n"
            "ofs03f0:\n"
            "            nop"
        )
        exported = (
            "jump ofs03f2\n"
            "ofs03e7:\n"
            "            jump ofs03e7\n"
            "ofs03f2:\n"
            "            nop"
        )
        with tempfile.TemporaryDirectory() as temporary:
            try:
                report = self.verify_fixture(
                    Path(temporary),
                    patched_method_extra=exported,
                    generated_method_extra=generated,
                )
            except self.patch.PcodePatchError as exc:
                self.fail(f"FFDec label renumbering was rejected: {exc}")
        self.assertEqual("verified-offline-only", report["status"])

    def test_label_canonicalization_uses_definition_order(self) -> None:
        source = (
            "jump ofs0020\n"
            "ofs0010:\n"
            "    jump ofs0010\n"
            "ofs0020:\n"
            "    nop\n"
        )
        self.assertEqual(
            "jump L1\nL0:\n    jump L0\nL1:\n    nop\n",
            self.patch._canonicalize_offset_labels(source),
        )

    def test_final_verifier_rejects_changed_branch_target_topology(self) -> None:
        generated = (
            "jump ofs03f0\n"
            "ofs03e5:\n"
            "            jump ofs03e5\n"
            "ofs03f0:\n"
            "            nop"
        )
        wrong_export = (
            "jump ofs03e7\n"
            "ofs03e7:\n"
            "            jump ofs03e7\n"
            "ofs03f2:\n"
            "            nop"
        )
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(
                self.patch.PcodePatchError, "does not match generated replacement"
            ):
                self.verify_fixture(
                    Path(temporary),
                    patched_method_extra=wrong_export,
                    generated_method_extra=generated,
                )

    def test_final_verifier_rejects_carrier_tokens_in_either_method(self) -> None:
        for entry in METHODS:
            for token in FORBIDDEN_FINAL_TOKENS:
                with self.subTest(method=entry["method_name"], token=token):
                    with tempfile.TemporaryDirectory() as temporary:
                        with self.assertRaisesRegex(
                            self.patch.PcodePatchError, "forbidden carrier token"
                        ):
                            self.verify_fixture(
                                Path(temporary),
                                forbidden_method=entry["method_name"],
                                token=token,
                            )

    def test_final_verifier_rejects_non_exact_target_set(self) -> None:
        bad_targets = [
            {
                "method_name": METHODS[0]["method_name"],
                "replacement_body_index": 17692,
            }
        ]
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(
                self.patch.PcodePatchError, "replacement target methods"
            ):
                self.verify_fixture(Path(temporary), targets=bad_targets)


if __name__ == "__main__":
    unittest.main()
