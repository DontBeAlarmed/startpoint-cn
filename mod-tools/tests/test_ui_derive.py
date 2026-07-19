# -*- coding: utf-8 -*-
"""Offline tests for deterministic UI derivation from locked RGBA masters."""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image


MOD_TOOLS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MOD_TOOLS))

try:
    import wf_ui_derive as ui
except ModuleNotFoundError:
    ui = None


TEMPLATES = (
    "ui/skill_cutin_{n}.png",
    "ui/square_{n}.png",
    "ui/square_132_132_{n}.png",
    "ui/square_round_95_95_{n}.png",
    "ui/square_round_136_136_{n}.png",
    "ui/thumb_level_up_{n}.png",
    "ui/thumb_party_main_{n}.png",
    "ui/thumb_party_unison_{n}.png",
    "ui/battle_control_board_{n}.png",
    "ui/battle_member_status_{n}.png",
    "ui/cutin_skill_chain_{n}.png",
)


def fixture_sizes() -> dict[str, tuple[int, int]]:
    sizes = {
        "ui/full_shot_1440_1920_0.png": (32, 48),
        "ui/full_shot_1440_1920_1.png": (33, 49),
        "ui/illustration_setting_sprite_sheet.png": (36, 80),
    }
    for index, template in enumerate(TEMPLATES):
        for n in (0, 1):
            sizes[template.format(n=n)] = (7 + index + n, 9 + index + n)
    return sizes


class TestUiDerive(unittest.TestCase):
    def setUp(self) -> None:
        self.assertIsNotNone(ui, "wf_ui_derive shared module is not implemented")

    def test_derivative_contract_contains_only_rect_and_mode(self):
        self.assertEqual(tuple(ui.DERIVATIVES), TEMPLATES)
        for template, spec in ui.DERIVATIVES.items():
            with self.subTest(template=template):
                self.assertEqual(set(spec), {"mode", "rect"})
                self.assertIn(spec["mode"], {
                    "face", "head_shoulders", "portrait", "upper_body",
                })
                x0, y0, x1, y1 = spec["rect"]
                self.assertTrue(0 <= x0 < x1 <= 1)
                self.assertTrue(0 <= y0 < y1 <= 1)

    def test_build_uses_runtime_sizes_and_does_not_create_story_assets(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            base = root / "base.png"
            awake = root / "awake.png"
            output = root / "output"
            Image.new("RGBA", (20, 30), (30, 90, 220, 255)).save(base)
            Image.new("RGBA", (24, 36), (230, 170, 20, 255)).save(awake)
            sizes = fixture_sizes()

            ui.build_visual_derivatives(base, awake, output, sizes)

            expected = {
                "ui/full_shot_1440_1920_0.png",
                "ui/full_shot_1440_1920_1.png",
                *(template.format(n=n) for template in TEMPLATES for n in (0, 1)),
            }
            actual = {
                path.relative_to(output).as_posix()
                for path in output.rglob("*.png")
            }
            self.assertEqual(actual, expected)
            self.assertFalse((output / "ui/story").exists())
            for relative in sorted(expected):
                with self.subTest(relative=relative), Image.open(output / relative) as image:
                    self.assertEqual(image.size, sizes[relative])
                    self.assertEqual(image.mode, "RGBA")

    def test_build_rejects_incomplete_or_invalid_runtime_sizes(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            master = root / "master.png"
            Image.new("RGBA", (10, 20), (255, 255, 255, 255)).save(master)
            sizes = fixture_sizes()
            sizes.pop("ui/square_0.png")
            with self.assertRaisesRegex(ValueError, "ui/square_0.png"):
                ui.build_visual_derivatives(master, master, root / "missing", sizes)

            sizes = fixture_sizes()
            sizes["ui/square_0.png"] = (0, 12)
            with self.assertRaisesRegex(ValueError, "ui/square_0.png"):
                ui.build_visual_derivatives(master, master, root / "invalid", sizes)

    def test_illustration_sheet_uses_requested_geometry_and_both_forms(self):
        with tempfile.TemporaryDirectory() as td:
            output = Path(td)
            ui_dir = output / "ui"
            ui_dir.mkdir()
            Image.new("RGBA", (32, 48), (255, 0, 0, 255)).save(
                ui_dir / "full_shot_1440_1920_0.png")
            Image.new("RGBA", (33, 49), (0, 0, 255, 255)).save(
                ui_dir / "full_shot_1440_1920_1.png")

            target = ui.rebuild_illustration_sheet(output, (36, 80))

            self.assertEqual(target, ui_dir / "illustration_setting_sprite_sheet.png")
            with Image.open(target) as image:
                self.assertEqual(image.size, (36, 80))
                colors = set(image.convert("RGBA").get_flattened_data())
            self.assertIn((255, 0, 0, 255), colors)
            self.assertIn((0, 0, 255, 255), colors)


if __name__ == "__main__":
    unittest.main()
