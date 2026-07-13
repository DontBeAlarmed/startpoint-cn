# -*- coding: utf-8 -*-
"""Fail-closed abyss equipment client-patch regression tests."""
from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
PATCH_PATH = ROOT / "client-patch/abyss-mode-equipment/patch.py"
SPEC = importlib.util.spec_from_file_location("abyss_mode_equipment_patch", PATCH_PATH)
if SPEC is None or SPEC.loader is None:  # pragma: no cover - importlib guard
    raise ImportError(f"cannot load patch module: {PATCH_PATH}")
abyss_patch = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = abyss_patch
SPEC.loader.exec_module(abyss_patch)


ALLOWED = [
    (0, 17, 700099001),
    (0, 17, 700099099),
    (0, 8, 2001),
    (0, 10, 1),
    (0, 10, 97),
]
DENIED = [
    (1, 17, 700099001),
    (0, 17, 700098001),
    (0, 8, 2002),
    (0, 8, 2006),
    (0, 10, 0),
    (0, 10, 98),
    (0, 10, 1001),
    (0, 0, 110101),
    (0, 3, 1),
    (0, 11, 1),
]

TARGET_SIGNATURE = (
    "public function getAvailableAbilities(param1:BattlePartyLogic, param2:int, "
    "param3:QuestIdGroupKind, param4:Array) : BattleAbilitySource"
)
WITH_COND_SIGNATURE = (
    "public function getAvailableAbilitiesWithCond(param1:BattlePartyLogic, "
    "param2:int, param3:Function, param4:Array, param5:Boolean, "
    "param6:Boolean) : BattleAbilitySource"
)
ACTION_SKILLS_PREFIX = "public function getActionSkills"
ANCHOR = "_loc14_ = Boolean(_loc5_(_loc13_.questKind));"
ANCHOR_LINE = f"            {ANCHOR}"

EXPECTED_BLOCK = """            // WF_ABYSS_MODE_EQUIPMENT_GATE_V1_BEGIN
            if(_loc13_ is AbilitySoulAbilityLogic)
            {
               _loc12_ = _loc13_ as AbilitySoulAbilityLogic;
               if(_loc12_.id >= 8000101 && _loc12_.id <= 8000115)
               {
                  _loc14_ = false;
                  if(param3.index == 0)
                  {
                     _loc15_ = int(param3.params[0].params[0]);
                     switch(param3.params[0].index)
                     {
                        case 8:
                           _loc14_ = _loc15_ == 2001;
                           break;
                        case 10:
                           _loc14_ = _loc15_ >= 1 && _loc15_ <= 97;
                           break;
                        case 17:
                           _loc14_ = int(Math.floor(_loc15_ / 1000 + 1e-10)) == 700099;
                     }
                  }
               }
            }
            // WF_ABYSS_MODE_EQUIPMENT_GATE_V1_END"""


def source_text(newline: str = "\n") -> str:
    lines = [
        "package",
        "{",
        "   public class BattleCharacterLogic",
        "   {",
        f"      {WITH_COND_SIGNATURE}",
        "      {",
        "         var _loc12_:* = null as AbilitySoulAbilityLogic;",
        "         var _loc13_:* = null as BattleAbilityPeek;",
        "         var _loc14_:Boolean = false;",
        "         _loc14_ = Boolean(param3(_loc13_.questKind));",
        "      }",
        "",
        f"      {TARGET_SIGNATURE}",
        "      {",
        "         var _loc12_:* = null as AbilitySoulAbilityLogic;",
        "         var _loc13_:* = null as BattleAbilityPeek;",
        "         var _loc14_:Boolean = false;",
        "         var _loc15_:int = 0;",
        ANCHOR_LINE,
        "         if(_loc14_)",
        "         {",
        "            useAbility(_loc13_);",
        "         }",
        "      }",
        "",
        "      public function getActionSkills() : Array",
        "      {",
        "         return [];",
        "      }",
        "   }",
        "}",
        "",
    ]
    return newline.join(lines)


def markerless(text: str) -> str:
    lines = [
        line for line in text.splitlines(keepends=True)
        if "WF_ABYSS_MODE_EQUIPMENT_GATE_V1_" not in line
    ]
    return "".join(lines)


class TestAllowedQuest(unittest.TestCase):
    def test_exact_whitelist_is_allowed(self):
        for values in ALLOWED:
            with self.subTest(values=values):
                self.assertTrue(abyss_patch.allowed_quest(*values))

    def test_every_out_of_scope_quest_is_denied(self):
        for values in DENIED:
            with self.subTest(values=values):
                self.assertFalse(abyss_patch.allowed_quest(*values))


class TestPatchText(unittest.TestCase):
    def test_inserts_the_exact_block_once_and_only_changes_target_method(self):
        source = source_text()

        actual, insertions = abyss_patch.patch_text(source)

        expected = source.replace(
            ANCHOR_LINE + "\n",
            ANCHOR_LINE + "\n" + EXPECTED_BLOCK + "\n",
            1,
        )
        self.assertEqual(1, insertions)
        self.assertEqual(expected, actual)
        source_before, source_rest = source.split(TARGET_SIGNATURE, 1)
        actual_before, actual_rest = actual.split(TARGET_SIGNATURE, 1)
        source_method, source_after = source_rest.split(ACTION_SKILLS_PREFIX, 1)
        actual_method, actual_after = actual_rest.split(ACTION_SKILLS_PREFIX, 1)
        self.assertEqual(source_before, actual_before)
        self.assertEqual(source_after, actual_after)
        self.assertNotEqual(source_method, actual_method)

    def test_second_application_is_byte_identical(self):
        once, first_count = abyss_patch.patch_text(source_text())

        twice, second_count = abyss_patch.patch_text(once)

        self.assertEqual(1, first_count)
        self.assertEqual(0, second_count)
        self.assertEqual(once.encode("utf-8"), twice.encode("utf-8"))

    def test_crlf_is_preserved_without_bare_lf(self):
        source = source_text("\r\n")

        actual, insertions = abyss_patch.patch_text(source)

        self.assertEqual(1, insertions)
        self.assertNotIn("\n", actual.replace("\r\n", ""))
        self.assertEqual(
            source.count("\r\n") + EXPECTED_BLOCK.count("\n") + 1,
            actual.count("\r\n"),
        )

    def test_method_and_anchor_counts_must_each_be_exactly_one(self):
        source = source_text()
        malformed = {
            "missing method": source.replace(TARGET_SIGNATURE, "missingTarget"),
            "duplicate method": source + source,
            "missing boundary": source.replace(ACTION_SKILLS_PREFIX, "missingBoundary"),
            "missing anchor": source.replace(ANCHOR, "missingAnchor"),
            "duplicate anchor": source.replace(
                ANCHOR_LINE, ANCHOR_LINE + "\n" + ANCHOR_LINE, 1),
        }
        for name, text in malformed.items():
            with self.subTest(name=name), self.assertRaises(abyss_patch.PatchError):
                abyss_patch.patch_text(text)

    def test_corrupt_marked_patch_is_not_treated_as_idempotent(self):
        patched, _ = abyss_patch.patch_text(source_text())
        corrupted = patched.replace("_loc15_ <= 97", "_loc15_ <= 98", 1)

        with self.assertRaises(abyss_patch.PatchError):
            abyss_patch.patch_text(corrupted)


class TestSemanticVerification(unittest.TestCase):
    def test_verifies_with_markers_and_after_ffdec_drops_comments(self):
        patched, _ = abyss_patch.patch_text(source_text())

        abyss_patch.verify_text(patched, require_markers=True)
        abyss_patch.verify_text(markerless(patched), require_markers=False)

        with self.assertRaises(abyss_patch.PatchError):
            abyss_patch.verify_text(markerless(patched), require_markers=True)

    def test_every_gate_bound_is_semantically_required_without_markers(self):
        patched, _ = abyss_patch.patch_text(source_text())
        clean = markerless(patched)
        mutations = {
            "reserved lower": ("8000101", "8000102"),
            "reserved upper": ("8000115", "8000114"),
            "outer group": ("param3.index == 0", "param3.index == 1"),
            "single 8": ("case 8:", "case 7:"),
            "single 10": ("case 10:", "case 9:"),
            "single 17": ("case 17:", "case 16:"),
            "quest 2001": ("_loc15_ == 2001", "_loc15_ == 2002"),
            "quest lower": ("_loc15_ >= 1", "_loc15_ >= 0"),
            "quest upper": ("_loc15_ <= 97", "_loc15_ <= 98"),
            "abyss class": ("== 700099", "== 700098"),
        }
        for name, (old, new) in mutations.items():
            with self.subTest(name=name):
                changed = clean.replace(old, new, 1)
                self.assertNotEqual(clean, changed)
                with self.assertRaises(abyss_patch.PatchError):
                    abyss_patch.verify_text(changed, require_markers=False)

    def test_rejects_a_similar_gate_in_get_available_abilities_with_cond(self):
        patched, _ = abyss_patch.patch_text(source_text())
        block_without_markers = "\n".join(
            line for line in EXPECTED_BLOCK.splitlines()
            if "WF_ABYSS_MODE_EQUIPMENT_GATE_V1_" not in line
        )
        duplicate = patched.replace(
            "         _loc14_ = Boolean(param3(_loc13_.questKind));\n",
            "         _loc14_ = Boolean(param3(_loc13_.questKind));\n"
            + block_without_markers
            + "\n",
            1,
        )

        with self.assertRaises(abyss_patch.PatchError):
            abyss_patch.verify_text(duplicate, require_markers=False)


class TestAtomicFilePatching(unittest.TestCase):
    def test_count_or_anchor_failure_creates_no_output(self):
        malformed = {
            "method": source_text().replace(TARGET_SIGNATURE, "missingTarget"),
            "duplicate method": source_text() + source_text(),
            "anchor": source_text().replace(ANCHOR, "missingAnchor"),
            "duplicate anchor": source_text().replace(
                ANCHOR_LINE, ANCHOR_LINE + "\n" + ANCHOR_LINE, 1
            ),
        }
        for name, content in malformed.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as td:
                root = Path(td)
                source = root / "source.as"
                output = root / "output.as"
                source.write_bytes(content.encode("utf-8"))

                with self.assertRaises(abyss_patch.PatchError):
                    abyss_patch.patch_file(source, output)

                self.assertFalse(output.exists())
                self.assertEqual([source], list(root.iterdir()))

    def test_failure_leaves_existing_output_untouched(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source = root / "source.as"
            output = root / "output.as"
            source.write_bytes(
                source_text().replace(ANCHOR, "missingAnchor").encode("utf-8")
            )
            output.write_bytes(b"prior-output\r\n")
            before = output.read_bytes()

            with self.assertRaises(abyss_patch.PatchError):
                abyss_patch.patch_file(source, output)

            self.assertEqual(before, output.read_bytes())
            self.assertEqual({source, output}, set(root.iterdir()))

    def test_success_uses_a_sibling_temp_and_atomic_replace(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source = root / "source.as"
            output = root / "nested/output.as"
            source.write_bytes(source_text("\r\n").encode("utf-8"))
            output.parent.mkdir()
            real_replace = os.replace

            with mock.patch.object(
                abyss_patch.os, "replace", wraps=real_replace
            ) as replace:
                insertions = abyss_patch.patch_file(source, output)

            self.assertEqual(1, insertions)
            replace.assert_called_once()
            temporary, destination = map(Path, replace.call_args.args)
            self.assertEqual(output.parent, temporary.parent)
            self.assertEqual(output, destination)
            self.assertFalse(temporary.exists())
            output_text = output.read_bytes().decode("utf-8")
            self.assertNotIn("\n", output_text.replace("\r\n", ""))

    def test_cancellation_cleans_temp_and_keeps_existing_output(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source = root / "source.as"
            output = root / "output.as"
            source.write_bytes(source_text().encode("utf-8"))
            output.write_bytes(b"prior-output")

            with mock.patch.object(
                abyss_patch.os, "replace", side_effect=KeyboardInterrupt
            ), self.assertRaises(KeyboardInterrupt):
                abyss_patch.patch_file(source, output)

            self.assertEqual(b"prior-output", output.read_bytes())
            self.assertEqual({source, output}, set(root.iterdir()))


class TestCli(unittest.TestCase):
    def test_patch_and_verify_report_the_exact_allowed_quest_classes(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source = root / "source.as"
            output = root / "output.as"
            source.write_bytes(source_text().encode("utf-8"))
            stdout = StringIO()

            with redirect_stdout(stdout):
                result = abyss_patch.main(
                    ["--source", str(source), "--output", str(output)]
                )
                verify_result = abyss_patch.main(["--verify", str(output)])

            report = stdout.getvalue()
            self.assertEqual(0, result)
            self.assertEqual(0, verify_result)
            self.assertIn("insertions=1", report)
            self.assertIn("single[8]=2001", report)
            self.assertIn("single[10]=1..97", report)
            self.assertIn("single[17]=700099xxx", report)


if __name__ == "__main__":
    unittest.main(verbosity=2)
