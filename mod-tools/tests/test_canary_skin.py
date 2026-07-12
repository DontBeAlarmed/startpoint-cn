# -*- coding: utf-8 -*-
"""Kyle canary skin pure-helper tests (synthetic data only; no live store)."""
from __future__ import annotations

import sys
import tempfile
import unittest
import warnings
import zlib
from contextlib import redirect_stdout
from io import BytesIO, StringIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import wf_assets  # noqa: E402
import wf_canary_skin as skin  # noqa: E402
import wf_kyle_canary as kyle  # noqa: E402
import wf_dsl  # noqa: E402
import wf_mod_tool as core  # noqa: E402


def png_bytes(size: tuple[int, int], color=(0, 0, 0, 0)) -> bytes:
    out = BytesIO()
    Image.new("RGBA", size, color).save(out, format="PNG")
    return out.getvalue()


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
    for relative, size in required.items():
        path = pack / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGBA", size, (20, 40, 60, 255)).save(path)


class TestKylePlan(unittest.TestCase):
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
            stale = b"character/black_wolf_knight/pixelart/sprite_sheet"
            (pack / "pixelart/stale.amf3.deflate").write_bytes(
                co.compress(stale) + co.flush())

            with self.assertRaisesRegex(ValueError, "old code references remain"):
                kyle.validate_kyle_pack(pack)

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
            for relative, size in (
                    ("pixelart/sprite_sheet.png", (252, 351)),
                    ("pixelart/special_sprite_sheet.png", (512, 512))):
                logical = f"character/black_wolf_knight/{relative}"
                visual_logicals.append(logical)
                add_stored(logical, wf_assets.png_encode(
                    png_bytes(size, (220, 35, 25, 255))))
            amf_logical = (
                "character/black_wolf_knight/"
                "pixelart/sprite_sheet.atlas.amf3.deflate"
            )
            visual_logicals.append(amf_logical)
            plain = wf_dsl.encode_amf3([{
                "n": "character/black_wolf_knight/pixelart/pixelart0002",
                "x": 3,
            }])
            compressor = zlib.compressobj(9, zlib.DEFLATED, -15)
            add_stored(amf_logical, compressor.compress(plain) + compressor.flush())
            wolf_voice = "character/black_wolf_knight/voice/ally/join.mp3"
            visual_logicals.append(wolf_voice)
            add_stored(wolf_voice, b"wolf voice")
            canary_voice = (
                "character/resistance_princess_3halfanv/voice/ally/join.mp3"
            )
            add_stored(canary_voice, b"current canary voice")
            manifest = [{
                "logical": canary_voice,
                "exists": True,
                "root": "upload",
            }]
            runtime = SimpleNamespace(TARGET_STORE=root / "unused-upload")

            with patch.object(wf_assets, "all_asset_logicals",
                              return_value=visual_logicals), \
                    patch.object(wf_assets, "char_asset_manifest",
                                 return_value=manifest), \
                    patch.object(wf_assets, "locate",
                                 side_effect=lambda _store, logical:
                                 ("upload", source_paths[logical])), \
                    patch.object(wf_assets, "mp3_decode", side_effect=lambda data: data):
                result = kyle.prepare(runtime=runtime, work=work)

            pack = work / "pack"
            self.assertEqual(result["pack"], str(pack))
            self.assertFalse((pack / "obsolete-from-prior-build.bin").exists())
            self.assertEqual(
                result["files"],
                len(kyle.build_copy_plan(visual_logicals, [canary_voice])),
            )
            self.assertEqual(
                (pack / "voice/ally/join.mp3").read_bytes(),
                b"current canary voice",
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
            runtime = SimpleNamespace(TARGET_STORE=root / "unused-upload")

            def fail_after_writing(staged_base, _staged_awake, staged_pack):
                self.assertNotEqual(staged_pack, pack)
                (staged_pack / "prior-pack.bin").write_bytes(b"corrupted")
                raise RuntimeError("injected prepare failure")

            with patch.object(wf_assets, "all_asset_logicals", return_value=[]), \
                    patch.object(wf_assets, "char_asset_manifest", return_value=[]), \
                    patch.object(kyle, "build_visual_derivatives",
                                 side_effect=fail_after_writing):
                with self.assertRaisesRegex(RuntimeError,
                                            "injected prepare failure"):
                    kyle.prepare(runtime=runtime, work=work)

            self.assertEqual(sentinel.read_bytes(), b"known-good")
            self.assertEqual(list(work.glob(".pack-staging-*")), [])


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
    def test_apply_snapshots_before_isolated_writes_and_changes_only_code_name(self):
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

            result = kyle.apply(
                False, runtime=runtime, work=work, roots={})

            self.assertFalse(result["dry_run"])
            self.assertEqual(result["snapshot"], {"path": "snapshot.zip"})
            self.assertEqual(events[0], "snapshot")
            self.assertEqual(
                saved,
                [("119999", {"code_name": "kyle_wolf_knight"}, False)],
            )
            self.assertEqual(len(replaced), 7)
            self.assertTrue(all(item[2:] == (True, False) for item in replaced))
            self.assertLess(events.index("save-code"), events.index("replace-png"))

    def test_dry_run_has_no_mutations_and_refuses_unexpected_canary(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            work = root / "work"
            write_required_kyle_pack(work / "pack")
            allowed = SimpleNamespace(
                get_char_fields=lambda _cid: {
                    "fields": {"code_name": "kyle_wolf_knight"}},
            )

            preview = kyle.apply(True, runtime=allowed, work=work, roots={})

            self.assertTrue(preview["dry_run"])
            self.assertEqual(len(preview["writes"]), 7)
            refused = SimpleNamespace(
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
            (pack / atf_relative).write_bytes(b"staged-atf")
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
                    (pending_json, b"[]")):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
                originals[path] = data

            preview = kyle.plan_store_writes(pack, roots={})
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
                self.assertEqual(fields, {"code_name": "kyle_wolf_knight"})
                self.assertFalse(dry_run)
                master_json.write_bytes(b"mutated-master-json")
                text_json.write_bytes(b"mutated-text-json")
                server_json.write_bytes(b"mutated-server-json")
                table_path(target_store, character_logical).write_bytes(
                    b"mutated-character-table")

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
        for command in ("prepare", "dry-run", "apply", "verify"):
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
