# -*- coding: utf-8 -*-
"""Kyle canary skin pure-helper tests (synthetic data only; no live store)."""
from __future__ import annotations

import sys
import tempfile
import unittest
import warnings
import zlib
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import wf_canary_skin as skin  # noqa: E402
import wf_dsl  # noqa: E402
import wf_mod_tool as core  # noqa: E402


class TestPathRemap(unittest.TestCase):
    def test_recursive_remap_preserves_container_shape(self):
        tree = [{"n": "character/black_wolf_knight/pixelart/pixelart0002",
                 "meta": [1, "unchanged"]}]
        got = skin.remap_tree(tree, "character/black_wolf_knight/",
                              "character/kyle_wolf_knight/")
        self.assertEqual(got[0]["n"],
                         "character/kyle_wolf_knight/pixelart/pixelart0002")
        self.assertEqual(got[0]["meta"], [1, "unchanged"])
        self.assertEqual(list(got[0]), ["n", "meta"])

    def test_amf3_deflate_remap_decodes_to_expected_tree(self):
        tree = [{"n": "character/black_wolf_knight/ui/portrait", "x": 3}]
        plain = wf_dsl.encode_amf3(tree)
        co = zlib.compressobj(9, zlib.DEFLATED, -15)
        encoded = co.compress(plain) + co.flush()
        out = skin.remap_amf3_deflate(
            encoded, "character/black_wolf_knight/", "character/kyle_wolf_knight/")
        decoded = core.AMF3Reader(zlib.decompress(out, -15)).read_value()
        self.assertEqual(decoded,
                         [{"n": "character/kyle_wolf_knight/ui/portrait", "x": 3}])
        self.assertEqual(list(decoded[0]), ["n", "x"])


class TestImages(unittest.TestCase):
    def test_fit_rgba_returns_exact_transparent_canvas(self):
        src = Image.new("RGBA", (40, 80), (240, 240, 240, 255))
        got = skin.fit_rgba(src, (104, 268), focus=(0.5, 0.42))
        self.assertEqual(got.size, (104, 268))
        self.assertEqual(got.mode, "RGBA")

    def test_red_effect_becomes_ice_blue_and_alpha_is_preserved(self):
        src = Image.new("RGBA", (2, 1))
        src.putdata([(220, 35, 25, 255), (0, 0, 0, 0)])
        got = skin.recolor_kyle_pixel_sheet(src)
        r, g, b, a = got.getpixel((0, 0))
        self.assertGreater(b, r)
        self.assertGreater(g, r)
        self.assertEqual(a, 255)
        self.assertEqual(got.getpixel((1, 0))[3], 0)

    def test_recolor_emits_no_deprecation_warnings(self):
        src = Image.new("RGBA", (1, 1), (220, 35, 25, 255))
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always", DeprecationWarning)
            skin.recolor_kyle_pixel_sheet(src)
        self.assertEqual(caught, [])


class TestPackValidation(unittest.TestCase):
    def test_validate_pack_rejects_wrong_sheet_size(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "pixelart").mkdir()
            Image.new("RGBA", (10, 10)).save(root / "pixelart/sprite_sheet.png")
            with self.assertRaisesRegex(ValueError, "sprite_sheet.png"):
                skin.validate_pack(root, {"pixelart/sprite_sheet.png": (252, 421)})


if __name__ == "__main__":
    unittest.main(verbosity=2)
