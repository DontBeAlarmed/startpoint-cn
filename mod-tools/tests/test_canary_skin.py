# -*- coding: utf-8 -*-
"""Kyle canary skin pure-helper tests (synthetic data only; no live store)."""
from __future__ import annotations

import sys
import hashlib
import json
import tempfile
import unittest
import warnings
import zipfile
import zlib
from contextlib import redirect_stdout
from io import BytesIO, StringIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import wf_assets  # noqa: E402
import wf_atf  # noqa: E402
import wf_canary_skin as skin  # noqa: E402
import wf_kyle_canary as kyle  # noqa: E402
import wf_dsl  # noqa: E402
import wf_mod_tool as core  # noqa: E402


def png_bytes(size: tuple[int, int], color=(0, 0, 0, 0)) -> bytes:
    out = BytesIO()
    Image.new("RGBA", size, color).save(out, format="PNG")
    return out.getvalue()


def mp3_bytes() -> bytes:
    """One valid MPEG1 Layer3 128kbps/44.1kHz CBR frame."""
    frame = bytearray(417)
    frame[:4] = bytes.fromhex("fffb9000")
    return bytes(frame)


def cn_runtime(root: Path, **extra):
    store = root / "profile" / "upload"
    cdndata = root / "assets" / "cdndata"
    store.mkdir(parents=True, exist_ok=True)
    cdndata.mkdir(parents=True, exist_ok=True)
    values = {
        "_PROFILE": SimpleNamespace(id="cn", store=store, cdndata=cdndata),
        "TARGET_STORE": store,
        "CDNDATA": cdndata,
    }
    values.update(extra)
    return SimpleNamespace(**values)


def mark_cn(runtime, root: Path):
    cdndata = root / "assets/cdndata"
    cdndata.mkdir(parents=True, exist_ok=True)
    runtime._PROFILE = SimpleNamespace(
        id="cn", store=Path(runtime.TARGET_STORE), cdndata=cdndata)
    runtime.CDNDATA = cdndata
    return runtime


def write_required_kyle_pack(pack: Path) -> None:
    required = {
        "ui/full_shot_1440_1920_0.png": (1440, 1920),
        "ui/full_shot_1440_1920_1.png": (1440, 1920),
        "ui/skill_cutin_0.png": (1024, 512),
        "ui/skill_cutin_1.png": (1024, 512),
        "ui/illustration_setting_sprite_sheet.png": (361, 806),
        "pixelart/sprite_sheet.png": (252, 351),
        "pixelart/special_sprite_sheet.png": (512, 512),
    }
    tree = [{"n": "character/kyle_wolf_knight/pixelart/frame"}]
    compressor_data = wf_dsl.encode_amf3(tree)
    tiny_atf = wf_atf.deflate(wf_atf.build_cutin_atf(png_bytes((4, 4))))
    for relative in kyle.CANONICAL_TARGET_RELATIVES:
        path = pack / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        if relative.endswith(".png"):
            Image.new(
                "RGBA", required.get(relative, (4, 4)),
                (20, 40, 60, 255)).save(path)
        elif relative.endswith(".mp3"):
            path.write_bytes(mp3_bytes())
        elif relative.endswith(".amf3.deflate"):
            compressor = zlib.compressobj(9, zlib.DEFLATED, -15)
            path.write_bytes(
                compressor.compress(compressor_data) + compressor.flush())
        elif relative.endswith(".atf.deflate"):
            path.write_bytes(tiny_atf)
    inventory = {
        "version": 2,
        "profile_id": "cn",
        "entries": [
            {
                "relative": relative,
                "source": kyle.canonical_source(relative),
                "source_root": kyle.canonical_source_root(relative),
                "source_sha256": hashlib.sha256(
                    kyle.canonical_source(relative).encode()).hexdigest(),
            }
            for relative in kyle.CANONICAL_TARGET_RELATIVES
        ],
    }
    inventory["contract_sha256"] = kyle.inventory_contract_digest(
        inventory["entries"])
    pack.parent.mkdir(parents=True, exist_ok=True)
    (pack.parent / kyle.INVENTORY_FILE).write_text(
        json.dumps(inventory), encoding="utf-8")


class TestKylePlan(unittest.TestCase):
    def test_target_identity_fields_are_explicit_and_leave_combat_class_unchanged(self):
        self.assertEqual(kyle.TARGET_CHARACTER_FIELDS, {
            "code_name": "kyle_wolf_knight",
            "name": "雨果",
            "name_en": "HUGO",
            "race": "Beast",
            "gender": "Male",
            "role": "Tank",
        })
        for untouched in ("element", "speciality_type", "rarity"):
            self.assertNotIn(untouched, kyle.TARGET_CHARACTER_FIELDS)

    def test_visual_assets_use_black_wolf_but_voice_uses_current_canary(self):
        plan = kyle.build_copy_plan(
            visual_logicals=[
                "character/black_wolf_knight/ui/square_0.png",
                "character/black_wolf_knight/voice/ally/join.mp3",
            ],
            voice_logicals=[
                "character/resistance_princess_3halfanv/voice/ally/join.mp3",
            ],
        )
        self.assertIn(
            ("character/black_wolf_knight/ui/square_0.png",
             "character/kyle_wolf_knight/ui/square_0.png"),
            plan,
        )
        self.assertIn(
            ("character/resistance_princess_3halfanv/voice/ally/join.mp3",
             "character/kyle_wolf_knight/voice/ally/join.mp3"),
            plan,
        )
        self.assertNotIn(
            ("character/black_wolf_knight/voice/ally/join.mp3",
             "character/kyle_wolf_knight/voice/ally/join.mp3"),
            plan,
        )


class TestKylePackBuild(unittest.TestCase):
    def test_compact_derivatives_use_focal_cover_not_full_body_contain(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source = root / "source"
            pack = root / "pack"
            source.mkdir()
            # Full-height master with a narrow opaque subject and ample alpha.
            master = Image.new("RGBA", (500, 1000), (0, 0, 0, 0))
            for y in range(80, 940):
                for x in range(185, 315):
                    master.putpixel((x, y), (240, 245, 250, 255))
            master.save(source / "base.png")
            master.save(source / "awake.png")

            kyle.build_visual_derivatives(
                source / "base.png", source / "awake.png", pack)

            with Image.open(pack / "ui/battle_member_status_0.png") as image:
                bbox = image.getchannel("A").getbbox()
                self.assertGreaterEqual(bbox[2] - bbox[0], 54)
                self.assertGreaterEqual(bbox[3] - bbox[1], 54)
            with Image.open(pack / "ui/full_shot_1440_1920_0.png") as image:
                # Full shot deliberately remains contain and retains padding.
                bbox = image.getchannel("A").getbbox()
                self.assertLess(bbox[2] - bbox[0], 700)

    def test_derivatives_use_exact_geometry_and_clear_story_overlays(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source = root / "source"
            pack = root / "pack"
            (pack / "ui/story").mkdir(parents=True)
            source.mkdir()
            Image.new("RGBA", (300, 500), (80, 120, 220, 255)).save(
                source / "base.png")
            Image.new("RGBA", (400, 600), (220, 180, 80, 255)).save(
                source / "awake.png")
            overlays = (
                "anger", "normal", "normal_b", "sad", "sad_b", "serious",
                "serious_b", "shame", "smile", "smile_b", "smile_c",
                "smile_d", "surprise", "sweat", "think",
            )
            for overlay in overlays:
                Image.new("RGBA", (17, 19), (255, 0, 0, 255)).save(
                    pack / f"ui/story/{overlay}.png")

            kyle.build_visual_derivatives(
                source / "base.png", source / "awake.png", pack)

            expected = {
                "ui/full_shot_1440_1920_0.png": (1440, 1920),
                "ui/full_shot_1440_1920_1.png": (1440, 1920),
                "ui/skill_cutin_0.png": (1024, 512),
                "ui/skill_cutin_1.png": (1024, 512),
                "ui/square_0.png": (212, 212),
                "ui/square_round_95_95_1.png": (95, 95),
                "ui/thumb_party_main_0.png": (186, 392),
                "ui/battle_member_status_1.png": (58, 58),
                "ui/story/base_0.png": (520, 616),
                "ui/story/base_1.png": (570, 690),
            }
            for relative, size in expected.items():
                with self.subTest(relative=relative), Image.open(pack / relative) as image:
                    self.assertEqual(image.size, size)
            with Image.open(pack / "ui/story/base_0.png") as image:
                self.assertGreater(image.getbbox()[2], 0)
            for overlay in overlays:
                with self.subTest(overlay=overlay), Image.open(
                        pack / f"ui/story/{overlay}.png") as image:
                    self.assertIsNone(image.getbbox())

    def test_derivatives_blank_only_copied_story_overlay_inventory(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source = root / "source"
            story = root / "pack/ui/story"
            source.mkdir()
            story.mkdir(parents=True)
            Image.new("RGBA", (300, 500), (80, 120, 220, 255)).save(
                source / "base.png")
            Image.new("RGBA", (400, 600), (220, 180, 80, 255)).save(
                source / "awake.png")
            overlays = {
                "anger.png": (17, 19),
                "normal.png": (21, 22),
                "sad.png": (25, 27),
                "surprise.png": (29, 31),
                "surprise_b.png": (31, 23),
            }
            for index, (name, size) in enumerate(overlays.items()):
                Image.new(
                    "RGBA", size, (255 - index * 20, index * 30, 40, 255)
                ).save(story / name)
            for name in ("base_0.png", "base_1.png"):
                Image.new("RGBA", (9, 11), (90, 100, 110, 255)).save(
                    story / name)

            kyle.build_visual_derivatives(
                source / "base.png", source / "awake.png", root / "pack")

            for name, size in overlays.items():
                with self.subTest(name=name), Image.open(story / name) as image:
                    self.assertEqual(image.size, size)
                    self.assertIsNone(image.getbbox())
            self.assertFalse((story / "normal_b.png").exists())
            for name, size in (("base_0.png", (520, 616)),
                               ("base_1.png", (570, 690))):
                with Image.open(story / name) as image:
                    self.assertEqual(image.size, size)
                    self.assertIsNotNone(image.getbbox())

    def test_illustration_and_pixel_sheets_keep_geometry(self):
        with tempfile.TemporaryDirectory() as td:
            pack = Path(td)
            (pack / "ui").mkdir()
            (pack / "pixelart").mkdir()
            for n in (0, 1):
                Image.new("RGBA", (1440, 1920), (30 + n, 60, 90, 255)).save(
                    pack / f"ui/full_shot_1440_1920_{n}.png")
            Image.new("RGBA", (252, 351), (220, 35, 25, 255)).save(
                pack / "pixelart/sprite_sheet.png")
            Image.new("RGBA", (512, 512), (220, 35, 25, 255)).save(
                pack / "pixelart/special_sprite_sheet.png")

            kyle.rebuild_illustration_sheet(pack)
            kyle.recolor_pixel_sheets(pack)

            with Image.open(pack / "ui/illustration_setting_sprite_sheet.png") as image:
                self.assertEqual(image.size, (361, 806))
                self.assertIsNotNone(image.getbbox())
            for relative, size in (
                    ("pixelart/sprite_sheet.png", (252, 351)),
                    ("pixelart/special_sprite_sheet.png", (512, 512))):
                with Image.open(pack / relative) as image:
                    self.assertEqual(image.size, size)
                    red, green, blue, alpha = image.getpixel((0, 0))
                    self.assertGreater(blue, red)
                    self.assertGreater(green, red)
                    self.assertEqual(alpha, 255)

    def test_validation_rejects_stale_template_paths(self):
        required = {
            "ui/full_shot_1440_1920_0.png": (1440, 1920),
            "ui/full_shot_1440_1920_1.png": (1440, 1920),
            "ui/skill_cutin_0.png": (1024, 512),
            "ui/skill_cutin_1.png": (1024, 512),
            "ui/illustration_setting_sprite_sheet.png": (361, 806),
            "pixelart/sprite_sheet.png": (252, 351),
            "pixelart/special_sprite_sheet.png": (512, 512),
        }
        with tempfile.TemporaryDirectory() as td:
            pack = Path(td)
            for relative, size in required.items():
                path = pack / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                Image.new("RGBA", size).save(path)
            co = zlib.compressobj(9, zlib.DEFLATED, -15)
            stale = wf_dsl.encode_amf3([{
                "n": "character/black_wolf_knight/pixelart/sprite_sheet",
            }])
            stale_path = pack / kyle.PIXEL_AMF3_RELATIVES[0]
            stale_path.parent.mkdir(parents=True, exist_ok=True)
            stale_path.write_bytes(
                co.compress(stale) + co.flush())
            clean = wf_dsl.encode_amf3([{
                "n": "character/kyle_wolf_knight/pixelart/sprite_sheet",
            }])
            for relative in kyle.PIXEL_AMF3_RELATIVES[1:]:
                compressor = zlib.compressobj(9, zlib.DEFLATED, -15)
                (pack / relative).write_bytes(
                    compressor.compress(clean) + compressor.flush())
            inventory = {"entries": [
                {"relative": path.relative_to(pack).as_posix()}
                for path in sorted(pack.rglob("*")) if path.is_file()
            ]}

            with self.assertRaisesRegex(ValueError, "old code references remain"):
                kyle._validate_kyle_pack(
                    pack, inventory=inventory, strict=False)

    def test_prepare_builds_pack_from_wolf_visuals_and_canary_voices(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            work = root / "work"
            source = work / "source"
            stored = root / "stored"
            source.mkdir(parents=True)
            stored.mkdir()
            old_pack = work / "pack"
            old_pack.mkdir()
            (old_pack / "obsolete-from-prior-build.bin").write_bytes(b"obsolete")
            Image.new("RGBA", (300, 500), (40, 80, 180, 255)).save(
                source / "base.png")
            Image.new("RGBA", (400, 600), (180, 140, 40, 255)).save(
                source / "awake.png")

            visual_logicals = []
            source_paths = {}

            def add_stored(logical: str, data: bytes) -> None:
                path = stored / str(len(source_paths))
                path.write_bytes(data)
                source_paths[logical] = path

            for overlay in (
                    "anger", "normal", "normal_b", "sad", "sad_b", "serious",
                    "serious_b", "shame", "smile", "smile_b", "smile_c",
                    "smile_d", "surprise", "sweat", "think"):
                logical = f"character/black_wolf_knight/ui/story/{overlay}.png"
                visual_logicals.append(logical)
                add_stored(logical, wf_assets.png_encode(
                    png_bytes((17, 19), (255, 0, 0, 255))))
            generated_visuals = {
                "ui/full_shot_1440_1920_0.png": (1440, 1920),
                "ui/full_shot_1440_1920_1.png": (1440, 1920),
                "ui/illustration_setting_sprite_sheet.png": (361, 806),
                "ui/story/base_0.png": (520, 616),
                "ui/story/base_1.png": (570, 690),
            }
            for template, spec in kyle.DERIVATIVES.items():
                size = spec["size"]
                for n in (0, 1):
                    generated_visuals[template.format(n=n)] = size
            for relative, size in generated_visuals.items():
                logical = f"character/black_wolf_knight/{relative}"
                visual_logicals.append(logical)
                add_stored(logical, wf_assets.png_encode(
                    png_bytes(size, (50, 70, 90, 255))))
            for relative, size in (
                    ("pixelart/sprite_sheet.png", (252, 351)),
                    ("pixelart/special_sprite_sheet.png", (512, 512))):
                logical = f"character/black_wolf_knight/{relative}"
                visual_logicals.append(logical)
                add_stored(logical, wf_assets.png_encode(
                    png_bytes(size, (220, 35, 25, 255))))
            plain = wf_dsl.encode_amf3([{
                "n": "character/black_wolf_knight/pixelart/pixelart0002",
                "x": 3,
            }])
            for relative in kyle.PIXEL_AMF3_RELATIVES:
                amf_logical = f"character/black_wolf_knight/{relative}"
                visual_logicals.append(amf_logical)
                compressor = zlib.compressobj(9, zlib.DEFLATED, -15)
                add_stored(
                    amf_logical,
                    compressor.compress(plain) + compressor.flush(),
                )
            wolf_voice = "character/black_wolf_knight/voice/ally/join.mp3"
            visual_logicals.append(wolf_voice)
            add_stored(wolf_voice, b"wolf voice")
            canary_voice = (
                "character/resistance_princess_3halfanv/voice/ally/join.mp3"
            )
            add_stored(canary_voice, mp3_bytes())
            canonical_amf = wf_dsl.encode_amf3([{
                "n": "character/black_wolf_knight/canonical",
            }])
            tiny_atf = wf_atf.deflate(
                wf_atf.build_cutin_atf(png_bytes((4, 4))))
            for relative in kyle.BLACK_WOLF_VISUAL_RELATIVES:
                logical = f"character/black_wolf_knight/{relative}"
                if logical in source_paths:
                    continue
                visual_logicals.append(logical)
                if relative.endswith(".png"):
                    add_stored(logical, wf_assets.png_encode(
                        png_bytes((10, 10), (30, 60, 90, 255))))
                elif relative.endswith(".amf3.deflate"):
                    compressor = zlib.compressobj(9, zlib.DEFLATED, -15)
                    add_stored(logical, compressor.compress(canonical_amf) +
                               compressor.flush())
                elif relative.endswith(".atf.deflate"):
                    add_stored(logical, tiny_atf)
            for relative in kyle.CANARY_VOICE_RELATIVES:
                logical = (
                    "character/resistance_princess_3halfanv/voice/" + relative)
                if logical not in source_paths:
                    add_stored(logical, mp3_bytes())
            manifest = [{
                "logical": canary_voice,
                "exists": True,
                "root": "upload",
            }]
            visual_manifest = [
                {"logical": logical, "exists": True, "root": "upload"}
                for logical in visual_logicals
            ]
            runtime = cn_runtime(root)

            def asset_manifest(_store, code):
                return (visual_manifest if code == "black_wolf_knight"
                        else manifest)

            def locate_source(_store, logical):
                if "/voice/" in logical:
                    relative = "voice/" + logical.split("/voice/", 1)[1]
                else:
                    relative = logical.split(
                        "character/black_wolf_knight/", 1)[1]
                return kyle.canonical_source_root(relative), source_paths[logical]

            with patch.object(wf_assets, "char_asset_manifest",
                              side_effect=asset_manifest), \
                    patch.object(wf_assets, "locate",
                                 side_effect=locate_source), \
                    patch.object(wf_assets, "mp3_decode", side_effect=lambda data: data):
                result = kyle.prepare(runtime=runtime, work=work)

            pack = work / "pack"
            self.assertEqual(result["pack"], str(pack))
            self.assertFalse((pack / "obsolete-from-prior-build.bin").exists())
            self.assertEqual(
                result["files"],
                len(kyle.BLACK_WOLF_VISUAL_RELATIVES) +
                len(kyle.CANARY_VOICE_RELATIVES),
            )
            self.assertEqual(
                (pack / "voice/ally/join.mp3").read_bytes(),
                mp3_bytes(),
            )
            remapped = core.AMF3Reader(zlib.decompress(
                (pack / "pixelart/sprite_sheet.atlas.amf3.deflate").read_bytes(),
                -15,
            )).read_value()
            self.assertEqual(
                remapped[0]["n"],
                "character/kyle_wolf_knight/pixelart/pixelart0002",
            )
            with Image.open(pack / "ui/full_shot_1440_1920_0.png") as image:
                self.assertEqual(image.size, (1440, 1920))
            with Image.open(pack / "ui/story/normal.png") as image:
                self.assertIsNone(image.getbbox())
            with Image.open(pack / "pixelart/sprite_sheet.png") as image:
                red, green, blue, _alpha = image.getpixel((0, 0))
                self.assertGreater(blue, red)
                self.assertGreater(green, red)

    def test_prepare_failure_keeps_prior_pack_and_cleans_staging(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            work = root / "work"
            pack = work / "pack"
            write_required_kyle_pack(pack)
            sentinel = pack / "prior-pack.bin"
            sentinel.write_bytes(b"known-good")
            runtime = cn_runtime(root)

            def fail_after_writing(staged_base, _staged_awake, staged_pack):
                self.assertNotEqual(staged_pack, pack)
                (staged_pack / "prior-pack.bin").write_bytes(b"corrupted")
                raise RuntimeError("injected prepare failure")

            empty_inventory = {
                "version": 2,
                "profile_id": "cn",
                "entries": [],
            }
            with patch.object(kyle, "build_source_inventory",
                              return_value=empty_inventory), \
                    patch.object(kyle, "build_visual_derivatives",
                                 side_effect=fail_after_writing):
                with self.assertRaisesRegex(RuntimeError,
                                            "injected prepare failure"):
                    kyle.prepare(runtime=runtime, work=work)

            self.assertEqual(sentinel.read_bytes(), b"known-good")
            self.assertEqual(list(work.glob(".pack-staging-*")), [])

    def test_prepare_refuses_when_a_planned_source_disappears(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            work = root / "work"
            runtime = cn_runtime(root)
            missing = "character/black_wolf_knight/ui/square_0.png"
            logicals = [
                *(f"character/black_wolf_knight/{relative}"
                  for relative in kyle.BLACK_WOLF_VISUAL_RELATIVES),
                *(f"character/resistance_princess_3halfanv/voice/{relative}"
                  for relative in kyle.CANARY_VOICE_RELATIVES),
            ]
            stored = root / "stored"
            stored.mkdir()
            sources = {}
            for index, logical in enumerate(logicals):
                path = stored / str(index)
                path.write_bytes(b"source")
                if "/voice/" in logical:
                    relative = "voice/" + logical.split("/voice/", 1)[1]
                else:
                    relative = logical.split("character/black_wolf_knight/", 1)[1]
                sources[logical] = (kyle.canonical_source_root(relative), path)
            sources.pop(missing)
            with patch.object(wf_assets, "locate",
                              side_effect=lambda _store, logical:
                              sources.get(logical)):
                with self.assertRaisesRegex(
                        FileNotFoundError, missing):
                    kyle.build_source_inventory(runtime)


class TestKyleStorePlan(unittest.TestCase):
    def test_store_plan_is_sorted_and_preserves_template_roots(self):
        with tempfile.TemporaryDirectory() as td:
            pack = Path(td)
            (pack / "ui").mkdir()
            (pack / "voice/ally").mkdir(parents=True)
            (pack / "voice/ally/join.mp3").write_bytes(b"voice")
            (pack / "ui/square_0.png").write_bytes(b"png")

            got = kyle.plan_store_writes(
                pack, roots={"ui/square_0.png": "medium"})

            self.assertEqual(got, [
                {
                    "relative": "ui/square_0.png",
                    "root": "medium",
                    "logical": "character/kyle_wolf_knight/ui/square_0.png",
                },
                {
                    "relative": "voice/ally/join.mp3",
                    "root": "upload",
                    "logical": "character/kyle_wolf_knight/voice/ally/join.mp3",
                },
            ])

    def test_materialize_encodes_files_backs_up_overwrites_and_marks_pending(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            pack = root / "pack"
            target_store = root / "store/upload"
            (pack / "ui").mkdir(parents=True)
            (pack / "data").mkdir()
            png = png_bytes((4, 5), (10, 20, 30, 255))
            (pack / "ui/square_0.png").write_bytes(png)
            (pack / "data/layout.amf3.deflate").write_bytes(b"new-layout")
            pending = []
            runtime = SimpleNamespace(
                TARGET_STORE=target_store,
                add_pending=pending.append,
            )
            old_logical = "character/kyle_wolf_knight/data/layout.amf3.deflate"
            old_path = wf_assets.path_in_root(target_store, "upload", old_logical)
            old_path.parent.mkdir(parents=True)
            old_path.write_bytes(b"old-layout")

            kyle.materialize_new_paths(
                pack,
                runtime=runtime,
                roots={"ui/square_0.png": "medium"},
            )

            png_path = wf_assets.path_in_root(
                target_store,
                "medium",
                "character/kyle_wolf_knight/ui/square_0.png",
            )
            self.assertEqual(wf_assets.png_decode(png_path.read_bytes()), png)
            self.assertEqual(old_path.read_bytes(), b"new-layout")
            backups = list(old_path.parent.glob(
                old_path.name + ".bak-wfmod-kyle-*"))
            self.assertEqual(len(backups), 1)
            self.assertEqual(backups[0].read_bytes(), b"old-layout")
            self.assertEqual(set(pending), {png_path, old_path})

    def test_clone_metadata_copies_trim_and_nested_template_rows(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            trimmed = core.OrderedMap(
                "trimmed",
                ["character/black_wolf_knight/ui/full_shot", "other/key"],
                [b"1,2,3,4", b"keep"],
                root / "trimmed-source",
            )
            char_image = core.OrderedMap(
                "char-image", ["111007", "119999"],
                [b"source-image-row", b"old-image-row"], root / "char-source")
            full_shot = core.OrderedMap(
                "full-shot", ["111007", "119999"],
                [b"source-attr-row", b"old-attr-row"], root / "attr-source")
            written_nested = []
            pending = []
            written_trimmed = root / "written-trimmed"

            def load_table(_logical, _target, _source):
                return trimmed

            def write_table(table, _target, _suffix, no_backup=False):
                self.assertIs(table, trimmed)
                self.assertFalse(no_backup)
                written_trimmed.write_bytes(b"written")
                return written_trimmed

            fake_core = SimpleNamespace(
                load_table=load_table,
                write_table=write_table,
            )
            tables = {"char-image": char_image, "full-shot": full_shot}
            runtime = SimpleNamespace(
                core=fake_core,
                TARGET_STORE=root / "upload",
                SOURCE_STORE=root / "source",
                TRIMMED_LOGICAL="trimmed",
                CHAR_IMAGE_LOGICAL="char-image",
                FS_ATTR_LOGICAL="full-shot",
                add_pending=pending.append,
                _load_nested_opt=lambda logical: tables[logical],
                _write_nested=lambda table, logical, tag:
                written_nested.append((table, logical, tag)),
            )

            kyle.clone_template_metadata(
                "111007", "119999", "black_wolf_knight",
                "kyle_wolf_knight", runtime=runtime)

            self.assertEqual(
                trimmed.text_rows()[
                    "character/kyle_wolf_knight/ui/full_shot"],
                "1,2,3,4",
            )
            self.assertEqual(trimmed.text_rows()["other/key"], "keep")
            self.assertEqual(char_image.rows[1], b"source-image-row")
            self.assertEqual(full_shot.rows[1], b"source-attr-row")
            self.assertEqual(pending, [written_trimmed])
            self.assertEqual(
                [item[1] for item in written_nested],
                ["char-image", "full-shot"],
            )


class TestKyleTransaction(unittest.TestCase):
    def test_apply_snapshots_before_isolated_writes_and_updates_identity_fields(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            work = root / "work"
            pack = work / "pack"
            write_required_kyle_pack(pack)
            trimmed = core.OrderedMap(
                "trimmed",
                ["character/black_wolf_knight/ui/full_shot"],
                [b"1,2,1440,1920"],
                root / "trimmed-source",
            )
            char_image = core.OrderedMap(
                "char-image", ["111007", "119999"],
                [b"source-image", b"old-image"], root / "char-source")
            full_shot = core.OrderedMap(
                "full-shot", ["111007", "119999"],
                [b"source-attr", b"old-attr"], root / "attr-source")
            events = []

            def write_table(_table, _target, _suffix, no_backup=False):
                events.append("trimmed")
                path = root / "trimmed-written"
                path.write_bytes(b"trimmed")
                return path

            fake_core = SimpleNamespace(
                load_table=lambda _logical, _target, _source: trimmed,
                write_table=write_table,
            )
            tables = {"char-image": char_image, "full-shot": full_shot}

            def snapshot(cid, note):
                events.append("snapshot")
                self.assertEqual(cid, "119999")
                self.assertIn("Kyle", note)
                return {"path": "snapshot.zip"}

            saved = []
            replaced = []
            runtime = SimpleNamespace(
                core=fake_core,
                TARGET_STORE=root / "store/upload",
                SOURCE_STORE=root / "source",
                TRIMMED_LOGICAL="trimmed",
                CHAR_IMAGE_LOGICAL="char-image",
                FS_ATTR_LOGICAL="full-shot",
                get_char_fields=lambda _cid: {
                    "fields": {"code_name": "resistance_princess_3halfanv"}},
                char_snapshot=snapshot,
                add_pending=lambda _path: events.append("asset-write"),
                _load_nested_opt=lambda logical: tables[logical],
                _write_nested=lambda _table, logical, _tag:
                events.append(f"nested:{logical}"),
                save_char_fields=lambda cid, fields, dry_run:
                (events.append("save-code"), saved.append((cid, fields, dry_run))),
                replace_asset=lambda logical, data, force, dry_run:
                (events.append("replace-png"),
                 replaced.append((logical, data, force, dry_run))),
            )
            mark_cn(runtime, root)

            result = kyle.apply(
                False, runtime=runtime, work=work, roots={})

            self.assertFalse(result["dry_run"])
            self.assertEqual(result["snapshot"], {"path": "snapshot.zip"})
            self.assertEqual(events[0], "snapshot")
            self.assertEqual(
                saved,
                [("119999", kyle.TARGET_CHARACTER_FIELDS, False)],
            )
            self.assertEqual(len(replaced), 35)
            self.assertTrue(all(item[2:] == (True, False) for item in replaced))
            self.assertLess(events.index("save-code"), events.index("replace-png"))
            installed = [
                wf_assets.path_in_root(
                    runtime.TARGET_STORE, item["root"], item["logical"])
                for item in result["plan"]["writes"]
            ]
            self.assertTrue(all(path.is_file() for path in installed))
            restored = kyle.restore_rollback_snapshot(
                Path(result["rollback_snapshot"]))
            self.assertGreaterEqual(restored["restored"], 7)
            self.assertTrue(all(not path.exists() for path in installed))
            self.assertTrue(
                set(result["observed_operations"]).issubset(
                    set(result["plan"]["operations"])))
            for operation in (
                    "character-snapshot", "persistent-rollback-snapshot",
                    "clone-trimmed-image", "materialize-assets",
                    "update-character-fields", "replace-png-and-derived-metadata"):
                self.assertIn(operation, result["observed_operations"])

    def test_dry_run_has_no_mutations_and_refuses_unexpected_canary(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            work = root / "work"
            write_required_kyle_pack(work / "pack")
            allowed = cn_runtime(
                root,
                get_char_fields=lambda _cid: {
                    "fields": {"code_name": "kyle_wolf_knight"}},
            )

            with patch.object(kyle, "_prevalidate_apply", return_value=[]):
                preview = kyle.apply(
                    True, runtime=allowed, work=work, roots={})

            self.assertTrue(preview["dry_run"])
            self.assertEqual(len(preview["writes"]), 64)
            self.assertEqual(
                preview["character_fields"]["to"],
                kyle.TARGET_CHARACTER_FIELDS)
            for section in (
                    "code_name", "character_fields", "snapshot", "metadata", "layer1",
                    "pending", "validation"):
                self.assertIn(section, preview)
            refused = cn_runtime(
                root,
                get_char_fields=lambda _cid: {
                    "fields": {"code_name": "someone_else"}},
            )
            with self.assertRaisesRegex(ValueError, "unexpected canary code_name"):
                kyle.apply(True, runtime=refused, work=root / "missing", roots={})

    def test_apply_rolls_back_all_live_files_after_late_failure(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            work = root / "work"
            pack = work / "pack"
            write_required_kyle_pack(pack)
            atf_relative = "ui/skill_cutin_0.atf.deflate"
            (pack / atf_relative).write_bytes(wf_atf.deflate(
                wf_atf.build_cutin_atf(png_bytes((4, 4)))))
            write_required_kyle_pack(pack)
            target_store = root / "store/upload"

            trimmed_logical = "trimmed"
            char_image_logical = "char-image"
            full_shot_logical = "full-shot"
            character_logical = "character"
            character_text_logical = "character-text"

            def table_path(_store, logical):
                return root / "tables" / (logical.replace("/", "__") + ".bin")

            trimmed = core.OrderedMap(
                trimmed_logical,
                ["character/black_wolf_knight/ui/full_shot"],
                [b"1,2,1440,1920"], root / "trim-source")
            char_image = core.OrderedMap(
                char_image_logical, ["111007", "119999"],
                [b"source-image", b"old-image"], root / "char-image-source")
            full_shot = core.OrderedMap(
                full_shot_logical, ["111007", "119999"],
                [b"source-attr", b"old-attr"], root / "full-shot-source")
            character = core.OrderedMap(
                character_logical, ["119999"],
                [b"resistance_princess_3halfanv"], root / "character-source")
            character_text = core.OrderedMap(
                character_text_logical, ["119999"],
                [b"Kyle"], root / "character-text-source")
            flat_tables = {
                trimmed_logical: trimmed,
                character_logical: character,
                character_text_logical: character_text,
            }

            def load_table(logical, _target, _source):
                return flat_tables[logical]

            def write_table(table, target, _suffix, no_backup=False):
                path = table_path(target, table.logical_path)
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"mutated:" + table.logical_path.encode())
                return path

            fake_core = SimpleNamespace(
                CHARACTER_LOGICAL=character_logical,
                load_table=load_table,
                write_table=write_table,
                table_path=table_path,
            )
            nested_tables = {
                char_image_logical: char_image,
                full_shot_logical: full_shot,
            }
            master_json = root / "cdndata/character.json"
            text_json = root / "cdndata/character_text.json"
            server_json = root / "assets/character.json"
            pending_json = root / "work/sync_pending.json"
            changelog_json = root / "work/changelog.jsonl"
            changelog_md = root / "work/changelog.md"

            originals = {}
            for logical in (
                    trimmed_logical, char_image_logical, full_shot_logical,
                    character_logical, character_text_logical):
                path = table_path(target_store, logical)
                path.parent.mkdir(parents=True, exist_ok=True)
                data = f"original-table:{logical}".encode()
                path.write_bytes(data)
                originals[path] = data
            for path, data in (
                    (master_json, b"original-master-json"),
                    (text_json, b"original-text-json"),
                    (server_json, b"original-server-json"),
                    (pending_json, b"[]"),
                    (changelog_json, b"original-changelog\n"),
                    (changelog_md, b"original-changelog-md\n")):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
                originals[path] = data

            inventory = json.loads(
                (work / kyle.INVENTORY_FILE).read_text(encoding="utf-8"))
            preview = kyle.plan_store_writes(pack, inventory=inventory)
            destinations = {
                item["logical"]: wf_assets.path_in_root(
                    target_store, item["root"], item["logical"])
                for item in preview
            }
            old_png_logical = (
                "character/kyle_wolf_knight/ui/full_shot_1440_1920_0.png")
            old_atf_logical = (
                "character/kyle_wolf_knight/ui/skill_cutin_0.atf.deflate")
            for logical, data in (
                    (old_png_logical, b"original-store-png"),
                    (old_atf_logical, b"original-store-atf")):
                path = destinations[logical]
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
                originals[path] = data

            def write_nested(_table, logical, _tag):
                path = table_path(target_store, logical)
                path.write_bytes(b"mutated-nested:" + logical.encode())
                return str(path)

            def save_fields(_cid, fields, dry_run):
                self.assertEqual(fields, kyle.TARGET_CHARACTER_FIELDS)
                self.assertFalse(dry_run)
                master_json.write_bytes(b"mutated-master-json")
                text_json.write_bytes(b"mutated-text-json")
                server_json.write_bytes(b"mutated-server-json")
                table_path(target_store, character_logical).write_bytes(
                    b"mutated-character-table")
                changelog_json.write_bytes(b"mutated-changelog\n")
                changelog_md.write_bytes(b"mutated-changelog-md\n")

            replace_count = 0

            def replace_asset(logical, _data, force, dry_run):
                nonlocal replace_count
                self.assertTrue(force)
                self.assertFalse(dry_run)
                replace_count += 1
                destinations[logical].write_bytes(
                    f"replaced-{replace_count}".encode())
                if logical.endswith("ui/skill_cutin_0.png"):
                    destinations[old_atf_logical].write_bytes(b"rewritten-atf")
                    raise RuntimeError("injected late replace failure")

            runtime = SimpleNamespace(
                core=fake_core,
                TARGET_STORE=target_store,
                SOURCE_STORE=root / "source",
                TRIMMED_LOGICAL=trimmed_logical,
                CHAR_IMAGE_LOGICAL=char_image_logical,
                FS_ATTR_LOGICAL=full_shot_logical,
                CHAR_TEXT2_LOGICAL=character_text_logical,
                PENDING_FILE=pending_json,
                CHANGELOG_FILE=changelog_json,
                CHANGELOG_MD=changelog_md,
                get_char_fields=lambda _cid: {
                    "fields": {"code_name": "resistance_princess_3halfanv"}},
                char_snapshot=lambda _cid, _note: {"path": "snapshot.zip"},
                add_pending=lambda path: pending_json.write_text(
                    str(path), encoding="utf-8"),
                _load_nested_opt=lambda logical: nested_tables[logical],
                _write_nested=write_nested,
                _char_json_paths=lambda: (master_json, text_json),
                _server_char_json_path=lambda: server_json,
                save_char_fields=save_fields,
                replace_asset=replace_asset,
            )
            mark_cn(runtime, root)

            with self.assertRaisesRegex(
                    RuntimeError, "injected late replace failure"):
                kyle.apply(False, runtime=runtime, work=work, roots={})

            for path, data in originals.items():
                with self.subTest(restored=path):
                    self.assertEqual(path.read_bytes(), data)
            for path in destinations.values():
                if path not in originals:
                    with self.subTest(removed=path):
                        self.assertFalse(path.exists())

    def test_verify_and_help_are_offline(self):
        with tempfile.TemporaryDirectory() as td:
            work = Path(td) / "work"
            write_required_kyle_pack(work / "pack")
            result = kyle.verify(work=work)
            self.assertEqual(result["pack"], str(work / "pack"))
            self.assertEqual(result["old_code_references"], [])

        output = StringIO()
        with self.assertRaises(SystemExit) as stopped, redirect_stdout(output):
            kyle.main(["--help"])
        help_text = output.getvalue()
        self.assertEqual(stopped.exception.code, 0)
        for command in ("prepare", "dry-run", "apply", "verify", "rollback"):
            self.assertIn(command, help_text)


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

    def test_cover_rgba_fills_small_portrait_with_alpha_subject(self):
        src = Image.new("RGBA", (400, 900), (0, 0, 0, 0))
        # A narrow full-body subject with transparent generation padding.
        for y in range(80, 850):
            for x in range(135, 265):
                src.putpixel((x, y), (235, 240, 250, 255))
        got = skin.cover_rgba(src, (58, 58), focus=(0.5, 0.20))
        bbox = got.getchannel("A").getbbox()
        self.assertIsNotNone(bbox)
        self.assertGreaterEqual(bbox[2] - bbox[0], 54)
        self.assertGreaterEqual(bbox[3] - bbox[1], 54)
        self.assertGreater(
            sum(1 for alpha in got.getchannel("A").get_flattened_data()
                if alpha),
            int(58 * 58 * 0.85),
        )

    def test_recolor_preserves_near_black_outline_and_boot_pixels(self):
        pixels = [(8 + (index % 20), 9 + (index % 20), 10 + (index % 20), 255)
                  for index in range(100)]
        src = Image.new("RGBA", (100, 1))
        src.putdata(pixels)
        got = skin.recolor_kyle_pixel_sheet(src)
        retained = sum(
            1 for before, after in zip(pixels, got.get_flattened_data())
            if before == after
        )
        self.assertGreaterEqual(retained, 95)

    def test_pixelart0002_palette_reads_as_white_wolf_with_blue_eyes(self):
        # Synthetic copy of the template's neutral-frame palette roles:
        # dark wolf fur, two green eyes, blue cloth, outline and boot pixels.
        source = Image.new("RGBA", (15, 14), (0, 0, 0, 0))
        for y in range(2, 11):
            for x in range(3, 12):
                source.putpixel((x, y), (69, 69, 59, 255))
        source.putpixel((5, 5), (3, 178, 0, 255))
        source.putpixel((9, 5), (3, 178, 0, 255))
        for x in range(5, 10):
            source.putpixel((x, 9), (64, 121, 174, 255))
        for x in range(3, 12):
            source.putpixel((x, 1), (0, 0, 0, 255))
        for x in (4, 5, 9, 10):
            source.putpixel((x, 12), (0, 0, 0, 255))

        got = skin.recolor_kyle_pixel_sheet(source)
        opaque = [pixel for pixel in got.get_flattened_data() if pixel[3]]
        white_or_silver = [
            pixel for pixel in opaque
            if min(pixel[:3]) >= 175 and max(pixel[:3]) - min(pixel[:3]) <= 45
        ]
        self.assertGreater(len(white_or_silver) / len(opaque), 0.55)
        self.assertEqual(sum(pixel[:3] == (3, 178, 0) for pixel in opaque), 0)
        self.assertEqual(
            sum(pixel[:3] == skin.KYLE_ICE_EYE for pixel in opaque), 2)
        self.assertTrue(all(got.getpixel((x, 1)) == (0, 0, 0, 255)
                            for x in range(3, 12)))
        self.assertTrue(all(got.getpixel((x, 12)) == (0, 0, 0, 255)
                            for x in (4, 5, 9, 10)))

    def test_character_palette_conversion_preserves_warm_gold_vfx_and_alpha(self):
        source = Image.new("RGBA", (5, 1))
        source.putdata([
            (69, 69, 59, 255),
            (3, 178, 0, 211),
            (229, 219, 167, 173),
            (220, 35, 25, 97),
            (0, 0, 0, 0),
        ])

        got = skin.recolor_kyle_pixel_sheet(source)

        self.assertEqual(got.getpixel((0, 0))[:3], (224, 232, 242))
        self.assertEqual(got.getpixel((1, 0))[:3], skin.KYLE_ICE_EYE)
        self.assertEqual(got.getpixel((2, 0)), (229, 219, 167, 173))
        self.assertGreater(got.getpixel((3, 0))[2], got.getpixel((3, 0))[0])
        self.assertEqual(
            [pixel[3] for pixel in got.get_flattened_data()],
            [255, 211, 173, 97, 0],
        )


class TestKyleFocalRects(unittest.TestCase):
    @staticmethod
    def _marker_master() -> Image.Image:
        image = Image.new("RGBA", (100, 200), (0, 0, 0, 0))
        # Normalized visible-subject markers: face, torso, boots.
        for y in range(0, 24):
            for x in range(20, 80):
                image.putpixel((x, y), (255, 0, 0, 255))
        for y in range(36, 112):
            for x in range(12, 88):
                image.putpixel((x, y), (0, 255, 0, 255))
        for y in range(174, 200):
            for x in range(24, 76):
                image.putpixel((x, y), (0, 0, 255, 255))
        return image

    @staticmethod
    def _has(image: Image.Image, marker: str) -> bool:
        pixels = image.convert("RGBA").get_flattened_data()
        if marker == "face":
            return any(r > 210 and g < 70 and b < 70 and a for r, g, b, a in pixels)
        if marker == "torso":
            return any(g > 210 and r < 70 and b < 70 and a for r, g, b, a in pixels)
        return any(b > 210 and r < 70 and g < 70 and a for r, g, b, a in pixels)

    def test_asset_specific_focal_rects_keep_face_and_torso_without_boots(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source = root / "source"
            pack = root / "pack"
            source.mkdir()
            master = self._marker_master()
            master.save(source / "base.png")
            master.save(source / "awake.png")

            kyle.build_visual_derivatives(
                source / "base.png", source / "awake.png", pack)

            for template in kyle.DERIVATIVES:
                relative = template.format(n=0)
                with self.subTest(relative=relative), Image.open(pack / relative) as image:
                    self.assertTrue(self._has(image, "face"))
                    self.assertTrue(self._has(image, "torso"))
                    self.assertFalse(self._has(image, "boots"))
            with Image.open(pack / "ui/full_shot_1440_1920_0.png") as image:
                self.assertTrue(self._has(image, "boots"))

    def test_each_compact_asset_declares_normalized_focal_rect(self):
        for name, spec in kyle.DERIVATIVES.items():
            with self.subTest(name=name):
                self.assertIn(spec["mode"], {
                    "face", "head_shoulders", "portrait", "upper_body"})
                rect = spec["rect"]
                self.assertEqual(len(rect), 4)
                self.assertTrue(all(0.0 <= value <= 1.0 for value in rect))
                self.assertLess(rect[0], rect[2])
                self.assertLess(rect[1], rect[3])

    def test_masked_board_and_chain_slots_are_face_led_not_full_body(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source = root / "source"
            pack = root / "pack"
            source.mkdir()
            master = self._marker_master()
            master.save(source / "base.png")
            master.save(source / "awake.png")

            kyle.build_visual_derivatives(
                source / "base.png", source / "awake.png", pack)

            expected_modes = {
                "ui/battle_control_board_{n}.png": "head_shoulders",
                "ui/cutin_skill_chain_{n}.png": "face",
            }
            for template, expected_mode in expected_modes.items():
                self.assertEqual(kyle.DERIVATIVES[template]["mode"], expected_mode)
                for n in (0, 1):
                    relative = template.format(n=n)
                    with self.subTest(relative=relative), Image.open(
                            pack / relative) as image:
                        pixels = image.convert("RGBA").get_flattened_data()
                        face = sum(r > 210 and g < 70 and b < 70 and a
                                   for r, g, b, a in pixels)
                        torso = sum(g > 210 and r < 70 and b < 70 and a
                                    for r, g, b, a in pixels)
                        boots = sum(b > 210 and r < 70 and g < 70 and a
                                    for r, g, b, a in pixels)
                        visible = face + torso + boots
                        self.assertGreater(face / visible, 0.55)
                        self.assertGreater(torso / visible, 0.05)
                        self.assertLess(torso / visible, 0.45)
                        self.assertEqual(boots, 0)

    def test_official_slot_proxy_keeps_mask_safe_face_scale(self):
        for template, expected in {
                "ui/battle_control_board_{n}.png": {
                    "aspect": 104 / 268, "max_subject_y": 0.40},
                "ui/cutin_skill_chain_{n}.png": {
                    "aspect": 276 / 319, "max_subject_y": 0.36},
        }.items():
            spec = kyle.DERIVATIVES[template]
            width, height = spec["size"]
            x0, y0, x1, y1 = spec["rect"]
            with self.subTest(template=template):
                self.assertAlmostEqual(width / height, expected["aspect"], places=4)
                self.assertEqual(y0, 0.0)
                self.assertLessEqual(y1, expected["max_subject_y"])


class TestKyleReviewBlockers(unittest.TestCase):
    def test_cn_guard_rejects_non_cn_and_mismatched_profile_paths(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            runtime = cn_runtime(root)
            self.assertEqual(kyle.require_cn_profile(runtime)["profile_id"], "cn")

            runtime._PROFILE.id = "global"
            with self.assertRaisesRegex(ValueError, "active profile must be cn"):
                kyle.require_cn_profile(runtime)

            runtime._PROFILE.id = "cn"
            runtime.CDNDATA = root / "other/cdndata"
            with self.assertRaisesRegex(ValueError, "CDNDATA"):
                kyle.require_cn_profile(runtime)

    def test_exact_inventory_decodes_every_type_and_rejects_missing_source(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            pack = root / "pack"
            (pack / "ui").mkdir(parents=True)
            (pack / "voice").mkdir()
            (pack / "pixelart").mkdir()
            (pack / "ui/icon.png").write_bytes(png_bytes((10, 10), (1, 2, 3, 255)))
            (pack / "voice/line.mp3").write_bytes(mp3_bytes())
            tree = [{"n": "character/kyle_wolf_knight/pixelart/a"}]
            co = zlib.compressobj(9, zlib.DEFLATED, -15)
            encoded = co.compress(wf_dsl.encode_amf3(tree)) + co.flush()
            for relative in kyle.PIXEL_AMF3_RELATIVES:
                (pack / relative).write_bytes(encoded)
            manifest = {
                "version": 1,
                "entries": [
                    {"relative": path.relative_to(pack).as_posix(),
                     "source": "fixture", "root": "upload"}
                    for path in sorted(pack.rglob("*")) if path.is_file()
                ],
            }

            result = kyle._validate_kyle_pack(
                pack, required_sizes={}, inventory=manifest, strict=False)
            self.assertEqual(result["inventory"]["expected"], 8)
            self.assertEqual(result["inventory"]["actual"], 8)
            self.assertEqual(result["inventory"]["png"], 1)
            self.assertEqual(result["inventory"]["mp3"], 1)
            self.assertEqual(result["inventory"]["pixel_amf3"], 6)
            self.assertEqual(result["required"], 0)
            self.assertEqual(result["missing"], 0)
            self.assertEqual(result["bad"], 0)

            (pack / "voice/line.mp3").unlink()
            with self.assertRaisesRegex(ValueError, "inventory missing"):
                kyle._validate_kyle_pack(
                    pack, required_sizes={}, inventory=manifest, strict=False)

    def test_inventory_rejects_corrupt_png_and_mp3(self):
        with tempfile.TemporaryDirectory() as td:
            pack = Path(td) / "pack"
            (pack / "ui").mkdir(parents=True)
            (pack / "voice").mkdir()
            (pack / "ui/bad.png").write_bytes(b"not-png")
            (pack / "voice/bad.mp3").write_bytes(b"not-mp3")
            clean = wf_dsl.encode_amf3([{
                "n": "character/kyle_wolf_knight/pixelart/frame",
            }])
            for relative in kyle.PIXEL_AMF3_RELATIVES:
                compressor = zlib.compressobj(9, zlib.DEFLATED, -15)
                path = pack / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(
                    compressor.compress(clean) + compressor.flush())
            manifest = {"entries": [
                {"relative": "ui/bad.png"},
                {"relative": "voice/bad.mp3"},
                *({"relative": relative}
                  for relative in kyle.PIXEL_AMF3_RELATIVES),
            ]}
            with self.assertRaisesRegex(ValueError, "bad PNG"):
                kyle._validate_kyle_pack(
                    pack, required_sizes={}, inventory=manifest, strict=False)

            (pack / "ui/bad.png").write_bytes(png_bytes((2, 2)))
            with self.assertRaisesRegex(ValueError, "bad MP3"):
                kyle._validate_kyle_pack(
                    pack, required_sizes={}, inventory=manifest, strict=False)

    def test_persistent_snapshot_restores_existing_new_and_changelog_bytes(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            existing = root / "store/existing.bin"
            created = root / "store/created.bin"
            changelog = root / "work/changelog.jsonl"
            existing.parent.mkdir(parents=True)
            changelog.parent.mkdir(parents=True)
            existing.write_bytes(b"before-existing")
            changelog.write_bytes(b"before-changelog\n")
            snapshot = kyle.write_rollback_snapshot(
                [existing, created, changelog], root / "snapshots")

            existing.write_bytes(b"after-existing")
            created.write_bytes(b"after-created")
            changelog.write_bytes(b"after-changelog\n")
            restored = kyle.restore_rollback_snapshot(snapshot)

            self.assertEqual(restored["restored"], 3)
            self.assertEqual(existing.read_bytes(), b"before-existing")
            self.assertFalse(created.exists())
            self.assertEqual(changelog.read_bytes(), b"before-changelog\n")
            with zipfile.ZipFile(snapshot) as archive:
                manifest = json.loads(archive.read("manifest.json"))
            self.assertEqual(len(manifest["entries"]), 3)

    def test_plan_apply_is_complete_shared_audit(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            work = root / "work"
            write_required_kyle_pack(work / "pack")
            pending = root / "mod-work/sync_pending.json"
            runtime = cn_runtime(
                root,
                PENDING_FILE=pending,
                CHANGELOG_FILE=root / "mod-work/changelog.jsonl",
                CHANGELOG_MD=root / "mod-work/changelog.md",
                SNAP_DIR=root / "mod-work/char_snapshots",
                CHAR_IMAGE_LOGICAL="character-image",
                FS_ATTR_LOGICAL="full-shot-attribute",
                TRIMMED_LOGICAL="trimmed-image",
                core=SimpleNamespace(table_path=core.table_path),
                get_char_fields=lambda _cid: {
                    "fields": {
                        "code_name": "resistance_princess_3halfanv"}},
                _char_json_paths=lambda: (
                    root / "assets/cdndata/character.json",
                    root / "assets/cdndata/character_text.json",
                ),
            )
            with patch.object(kyle, "_prevalidate_apply",
                              return_value=[pending]):
                plan = kyle.plan_apply(runtime, work=work, roots={})

            self.assertEqual(plan["code_name"], {
                "character_id": "119999",
                "from": "resistance_princess_3halfanv",
                "to": "kyle_wolf_knight",
            })
            self.assertTrue(plan["snapshot"]["character_snapshot"])
            self.assertEqual(
                plan["metadata"]["nested_tables"],
                ["character-image", "full-shot-attribute"],
            )
            self.assertEqual(len(plan["layer1"]["paths"]), 2)
            self.assertEqual(plan["pending"]["file"], str(pending))
            self.assertEqual(len(plan["writes"]), 64)
            self.assertEqual(plan["validation"]["inventory"]["actual"], 64)
            self.assertIn("asset_backup_template", plan["backups"])
            self.assertIn("metadata", plan["backups"])
            self.assertIn("persistent_artifact_template", plan["snapshot"])
            self.assertIn("semantic_writes", plan["changelog"])
            self.assertTrue(Path(plan["snapshot"]["character_artifact"]).is_absolute())
            self.assertTrue(Path(plan["snapshot"]["persistent_artifact"]).is_absolute())
            self.assertEqual(len(plan["backups"]["materialize"]), 64)
            self.assertEqual(len(plan["backups"]["replace_asset"]), 37)
            self.assertEqual(len(plan["backups"]["metadata_destinations"]), 3)
            self.assertEqual(len(plan["changelog"]["files"]), 2)
            for group in ("materialize", "replace_asset",
                          "metadata_destinations"):
                for entry in plan["backups"][group]:
                    self.assertTrue(Path(entry["destination"]).is_absolute())
                    self.assertIn("backup_exists", entry)
            for operation in (
                    "character-snapshot", "persistent-rollback-snapshot",
                    "clone-trimmed-image", "clone-character-image",
                    "clone-full-shot-attribute", "materialize-assets",
                    "update-character-fields", "replace-png-and-derived-metadata"):
                self.assertIn(operation, plan["operations"])


class TestKyleCanonicalInventory(unittest.TestCase):
    def test_production_validation_requires_exact_canonical_v2_contract(self):
        with tempfile.TemporaryDirectory() as td:
            pack = Path(td) / "pack"
            write_required_kyle_pack(pack)
            manifest_path = pack.parent / kyle.INVENTORY_FILE
            valid = json.loads(manifest_path.read_text(encoding="utf-8"))
            result = kyle.validate_kyle_pack(pack, inventory=valid)
            self.assertEqual(result["inventory"]["actual"], 64)
            self.assertEqual(result["inventory"]["amf3"], 8)
            self.assertEqual(result["inventory"]["atf"], 2)

            mutations = {
                "v1": lambda value: value.update(version=1),
                "shortened": lambda value: value["entries"].pop(),
                "false_source": lambda value: value["entries"][0].update(
                    source="character/fake/source.png"),
                "false_root": lambda value: value["entries"][0].update(
                    source_root="upload" if value["entries"][0]["source_root"] != "upload"
                    else "medium"),
                "zero_hash": lambda value: value["entries"][0].update(
                    source_sha256="0" * 64),
                "false_nonzero_hash": lambda value: value["entries"][0].update(
                    source_sha256="1" * 64),
            }
            for name, mutate in mutations.items():
                broken = json.loads(json.dumps(valid))
                mutate(broken)
                with self.subTest(name=name), self.assertRaises(ValueError):
                    kyle.validate_kyle_pack(pack, inventory=broken)

    def test_canonical_inventory_is_not_defined_by_source_exists_flags(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            runtime = cn_runtime(root)
            stored = root / "stored"
            stored.mkdir()
            sources = {}
            logicals = [
                *(f"character/black_wolf_knight/{relative}"
                  for relative in kyle.BLACK_WOLF_VISUAL_RELATIVES),
                *(f"character/resistance_princess_3halfanv/voice/{relative}"
                  for relative in kyle.CANARY_VOICE_RELATIVES),
            ]
            for index, logical in enumerate(logicals):
                path = stored / str(index)
                path.write_bytes(f"source-{index}".encode())
                if "/voice/" in logical:
                    relative = "voice/" + logical.split("/voice/", 1)[1]
                else:
                    relative = logical.split("character/black_wolf_knight/", 1)[1]
                sources[logical] = (kyle.canonical_source_root(relative), path)

            with patch.object(wf_assets, "locate",
                              side_effect=lambda _store, logical: sources.get(logical)):
                inventory = kyle.build_source_inventory(runtime)

            self.assertEqual(
                len(inventory["entries"]),
                len(kyle.BLACK_WOLF_VISUAL_RELATIVES) +
                len(kyle.CANARY_VOICE_RELATIVES),
            )
            self.assertEqual(
                {entry["relative"] for entry in inventory["entries"]},
                set(kyle.BLACK_WOLF_VISUAL_RELATIVES) |
                {f"voice/{relative}" for relative in kyle.CANARY_VOICE_RELATIVES},
            )
            for entry in inventory["entries"]:
                self.assertIn(entry["source_root"], {"upload", "medium", "android"})
                self.assertRegex(entry["source_sha256"], r"^[0-9a-f]{64}$")

            missing = logicals[-1]
            del sources[missing]
            with patch.object(wf_assets, "locate",
                              side_effect=lambda _store, logical: sources.get(logical)):
                with self.assertRaisesRegex(FileNotFoundError, missing):
                    kyle.build_source_inventory(runtime)

    def test_store_plan_consumes_sidecar_source_roots(self):
        with tempfile.TemporaryDirectory() as td:
            pack = Path(td) / "pack"
            path = pack / "ui/square_0.png"
            path.parent.mkdir(parents=True)
            path.write_bytes(b"x")
            inventory = {"entries": [{
                "relative": "ui/square_0.png",
                "source_root": "medium",
                "source": "canonical",
                "source_sha256": "0" * 64,
            }]}
            writes = kyle.plan_store_writes(
                pack, roots={"ui/square_0.png": "upload"},
                inventory=inventory)
            self.assertEqual(writes[0]["root"], "medium")

    def test_all_amf3_and_atf_files_are_fully_parsed(self):
        with tempfile.TemporaryDirectory() as td:
            pack = Path(td) / "pack"
            write_required_kyle_pack(pack)
            battle = pack / "battle/detail.battle.amf3.deflate"
            battle.parent.mkdir(exist_ok=True)
            co = zlib.compressobj(9, zlib.DEFLATED, -15)
            battle.write_bytes(co.compress(b"not-amf3") + co.flush())
            inventory = json.loads(
                (pack.parent / kyle.INVENTORY_FILE).read_text(encoding="utf-8"))
            inventory["entries"].append({
                "relative": battle.relative_to(pack).as_posix(),
                "source": "synthetic/battle",
                "source_root": "upload",
                "source_sha256": "1" * 64,
            })
            with self.assertRaisesRegex(ValueError, "bad AMF3"):
                kyle._validate_kyle_pack(
                    pack, inventory=inventory, strict=False)

            tree = wf_dsl.encode_amf3([{"n": "ok"}])
            co = zlib.compressobj(9, zlib.DEFLATED, -15)
            battle.write_bytes(co.compress(tree) + co.flush())
            atf = pack / "ui/skill_cutin_0.atf.deflate"
            atf.write_bytes(b"broken-atf")
            with self.assertRaisesRegex(ValueError, "bad ATF"):
                kyle._validate_kyle_pack(
                    pack, inventory=inventory, strict=False)


class TestKyleRollbackSafety(unittest.TestCase):
    def test_published_rollback_requeues_restored_store_tables(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            pending = []
            runtime = cn_runtime(root, add_pending=pending.append)
            runtime.core = SimpleNamespace(
                table_path=core.table_path,
                CHARACTER_LOGICAL="master/character/character.orderedmap")
            runtime.TRIMMED_LOGICAL = "master/generated/trimmed_image.orderedmap"
            runtime.CHAR_IMAGE_LOGICAL = "master/generated/character_image.orderedmap"
            runtime.FS_ATTR_LOGICAL = "master/character/full_shot_image_attribute.orderedmap"
            runtime.CHAR_TEXT2_LOGICAL = "master/character/character_text.orderedmap"
            character = core.table_path(
                runtime.TARGET_STORE, runtime.core.CHARACTER_LOGICAL)
            character_text = core.table_path(
                runtime.TARGET_STORE, runtime.CHAR_TEXT2_LOGICAL)
            trimmed = core.table_path(
                runtime.TARGET_STORE, runtime.TRIMMED_LOGICAL)
            layer1 = runtime.CDNDATA / "character.json"
            pending_file = root / "mod-work/sync_pending.json"
            runtime.PENDING_FILE = pending_file
            for path, data in (
                    (character, b"pre-character"),
                    (character_text, b"pre-character-text"),
                    (trimmed, b"pre-trimmed"),
                    (layer1, b"pre-layer1"),
                    (pending_file, b"[]")):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
            binding = kyle.profile_binding(runtime)
            snapshot = kyle.write_rollback_snapshot(
                [character, character_text, trimmed, layer1, pending_file],
                root / "snapshots", binding=binding,
                scope={"character_id": "119999",
                       "old_code_name": kyle.CURRENT_CODE})
            character.write_bytes(b"published-character")
            character_text.write_bytes(b"published-character-text")
            trimmed.write_bytes(b"published-trimmed")
            layer1.write_bytes(b"published-layer1")

            result = kyle.rollback(snapshot, runtime=runtime)

            self.assertEqual(character.read_bytes(), b"pre-character")
            self.assertEqual(
                character_text.read_bytes(), b"pre-character-text")
            self.assertEqual(trimmed.read_bytes(), b"pre-trimmed")
            self.assertEqual(layer1.read_bytes(), b"pre-layer1")
            self.assertGreater(result["pending_requeued"], 0)
            self.assertIn(character, pending)
            self.assertIn(character_text, pending)
            self.assertIn(trimmed, pending)

    def test_snapshot_binding_and_zip_members_are_prevalidated(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            runtime = cn_runtime(root, add_pending=lambda _path: None)
            relative = kyle.CANONICAL_TARGET_RELATIVES[0]
            target = wf_assets.path_in_root(
                runtime.TARGET_STORE, kyle.canonical_source_root(relative),
                f"character/{kyle.NEW_CODE}/{relative}")
            target.parent.mkdir(parents=True)
            target.write_bytes(b"pre")
            snapshot = kyle.write_rollback_snapshot(
                [target], root / "snapshots",
                binding=kyle.profile_binding(runtime),
                scope={"character_id": "119999",
                       "old_code_name": kyle.CURRENT_CODE})
            target.write_bytes(b"current")
            with zipfile.ZipFile(snapshot, "a") as archive:
                archive.writestr("unexpected.bin", b"bad")
            with self.assertRaisesRegex(ValueError, "zip members"):
                kyle.rollback(snapshot, runtime=runtime)
            self.assertEqual(target.read_bytes(), b"current")

            clean = kyle.write_rollback_snapshot(
                [target], root / "snapshots",
                binding=kyle.profile_binding(runtime),
                scope={"character_id": "119999",
                       "old_code_name": kyle.CURRENT_CODE})
            runtime._PROFILE.store = root / "different/upload"
            runtime.TARGET_STORE = runtime._PROFILE.store
            with self.assertRaisesRegex(ValueError, "snapshot profile binding"):
                kyle.rollback(clean, runtime=runtime)

    def test_rollback_whitelist_rejects_unrelated_hash_in_store_root(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            pending_file = root / "mod-work/sync_pending.json"
            unrelated = root / "profile/upload/aa/unrelated-hash"
            pending_file.parent.mkdir(parents=True)
            unrelated.parent.mkdir(parents=True)
            pending_file.write_bytes(b"[]")
            unrelated.write_bytes(b"pre")
            runtime = cn_runtime(
                root, PENDING_FILE=pending_file,
                add_pending=lambda _path: None)
            snapshot = kyle.write_rollback_snapshot(
                [unrelated], root / "snapshots",
                binding=kyle.profile_binding(runtime),
                scope={"character_id": "119999",
                       "old_code_name": kyle.CURRENT_CODE})
            unrelated.write_bytes(b"current")
            with self.assertRaisesRegex(ValueError, "outside exact whitelist"):
                kyle.rollback(snapshot, runtime=runtime)
            self.assertEqual(unrelated.read_bytes(), b"current")

    def test_late_restore_failure_rolls_back_the_rollback_call(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            runtime = cn_runtime(root, add_pending=lambda _path: None)
            relatives = kyle.CANONICAL_TARGET_RELATIVES[:2]
            one, two = [
                wf_assets.path_in_root(
                    runtime.TARGET_STORE, kyle.canonical_source_root(relative),
                    f"character/{kyle.NEW_CODE}/{relative}")
                for relative in relatives
            ]
            for path, data in ((one, b"pre-one"), (two, b"pre-two")):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
            snapshot = kyle.write_rollback_snapshot(
                [one, two], root / "snapshots",
                binding=kyle.profile_binding(runtime),
                scope={"character_id": "119999",
                       "old_code_name": kyle.CURRENT_CODE})
            one.write_bytes(b"current-one")
            two.write_bytes(b"current-two")
            original = kyle._restore_snapshot_entry
            calls = 0

            def fail_second(*args, **kwargs):
                nonlocal calls
                calls += 1
                if calls == 2:
                    raise RuntimeError("late restore failure")
                return original(*args, **kwargs)

            with patch.object(kyle, "_restore_snapshot_entry",
                              side_effect=fail_second):
                with self.assertRaisesRegex(RuntimeError, "late restore failure"):
                    kyle.rollback(snapshot, runtime=runtime)
            self.assertEqual(one.read_bytes(), b"current-one")
            self.assertEqual(two.read_bytes(), b"current-two")


class TestKylePackPairAtomicity(unittest.TestCase):
    def test_old_sidecar_rename_failure_restores_old_pair(self):
        with tempfile.TemporaryDirectory() as td:
            work = Path(td)
            pack = work / "pack"
            staging = work / ".pack-staging"
            pack.mkdir()
            staging.mkdir()
            (pack / "old.bin").write_bytes(b"old-pack")
            (staging / "new.bin").write_bytes(b"new-pack")
            sidecar = work / kyle.INVENTORY_FILE
            sidecar.write_bytes(b"old-sidecar")
            original = kyle._rename_path

            def fail_sidecar(source, destination):
                if Path(source) == sidecar:
                    raise RuntimeError("old sidecar rename failure")
                return original(source, destination)

            with patch.object(kyle, "_rename_path", side_effect=fail_sidecar):
                with self.assertRaisesRegex(RuntimeError,
                                            "old sidecar rename failure"):
                    kyle._replace_pack_and_inventory(
                        staging, pack, {"entries": []}, work)
            self.assertEqual((pack / "old.bin").read_bytes(), b"old-pack")
            self.assertEqual(sidecar.read_bytes(), b"old-sidecar")

    def test_sidecar_replace_failure_restores_old_pack_and_sidecar_pair(self):
        with tempfile.TemporaryDirectory() as td:
            work = Path(td)
            pack = work / "pack"
            staging = work / ".pack-staging"
            pack.mkdir()
            staging.mkdir()
            (pack / "old.bin").write_bytes(b"old-pack")
            (staging / "new.bin").write_bytes(b"new-pack")
            sidecar = work / kyle.INVENTORY_FILE
            sidecar.write_bytes(b"old-sidecar")
            inventory = {"entries": [{"relative": "new.bin"}]}

            with patch.object(kyle, "_atomic_replace_file",
                              side_effect=RuntimeError("sidecar replace failure")):
                with self.assertRaisesRegex(RuntimeError,
                                            "sidecar replace failure"):
                    kyle._replace_pack_and_inventory(
                        staging, pack, inventory, work)

            self.assertEqual((pack / "old.bin").read_bytes(), b"old-pack")
            self.assertFalse((pack / "new.bin").exists())
            self.assertEqual(sidecar.read_bytes(), b"old-sidecar")


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
