# Kyle Canary Visual Assets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert World Flipper CN canary character `119999` into the reference-image white wolf knight Kyle with isolated UI art and complete playable pixel animation assets.

**Architecture:** Keep all production logic outside the already-modified `wf_gui.py`. A pure `wf_canary_skin.py` module builds and validates standard-format asset packs, while `wf_kyle_canary.py` performs the CN-store transaction by reusing existing snapshot, character-field, pending-publication, and asset-replacement functions. GPT Image produces two identity-consistent master illustrations; Pillow deterministically derives every UI image and recolors the `black_wolf_knight` atlas without changing animation geometry.

**Tech Stack:** Python 3, Pillow 12, `unittest`, existing `wf_mod_tool`/`wf_assets`/`wf_dsl`/`wf_gui` modules, built-in GPT Image generation, existing `wf_publish.py` CN CDN publisher.

## Global Constraints

- Keep character ID `119999` and its current combat data, abilities, leader ability, and skill effects.
- Set the isolated asset code to exactly `kyle_wolf_knight`.
- Use character `111007` / `black_wolf_knight` as the pixel animation and visual-layout template.
- Do not modify assets belonging to `resistance_princess_3halfanv` or `black_wolf_knight`.
- Copy the canary's current voice files into `character/kyle_wolf_knight/voice/`; do not generate new speech in this plan.
- Preserve all atlas rectangles, timeline intervals, collision circles, anchors, and AMF3 key order.
- Perform every store mutation as dry-run first, then snapshot/backup before write.
- Work only against the active `cn` profile in `mod-tools/profiles.json`.
- Do not edit or stage the existing uncommitted `mod-tools/wf_gui.py` change.
- Keep generated images and packs under `work/ai_canary/kyle_wolf_knight/`; do not commit them.
- Do not commit `web/dist`, `admin/node_modules`, stores, CDN archives, or reverse-engineering workspaces.

---

## File Map

- Create `mod-tools/wf_canary_skin.py`: pure image, AMF3-path, and pack-building helpers; never opens the live store.
- Create `mod-tools/wf_kyle_canary.py`: Kyle-specific CLI and transactional live-store adapter.
- Create `mod-tools/tests/test_canary_skin.py`: isolated tests using synthetic images and AMF3 fixtures.
- Create `work/ai_canary/kyle_wolf_knight/source/base-key.png`: built-in GPT Image base form on chroma key.
- Create `work/ai_canary/kyle_wolf_knight/source/awake-key.png`: built-in GPT Image awakened form on chroma key.
- Create `work/ai_canary/kyle_wolf_knight/source/base.png`: alpha-clean base master.
- Create `work/ai_canary/kyle_wolf_knight/source/awake.png`: alpha-clean awakened master.
- Create `work/ai_canary/kyle_wolf_knight/pack/`: standard PNG/MP3/raw-AMF3 import tree.
- Modify live CN store only through `python mod-tools/wf_kyle_canary.py apply` after dry-run passes.

### Task 1: Pure pack transformation helpers

**Files:**
- Create: `mod-tools/wf_canary_skin.py`
- Create: `mod-tools/tests/test_canary_skin.py`

**Interfaces:**
- Consumes: standard RGBA PNGs, AMF3 raw-deflate bytes, source and target code-name prefixes.
- Produces: `remap_tree(value, old, new)`, `remap_amf3_deflate(data, old, new)`, `recolor_kyle_pixel_sheet(image)`, `fit_rgba(image, size, focus)`, and `validate_pack(pack_dir)`.

- [ ] **Step 1: Write failing tests for recursive path remapping and AMF3 round-trip**

```python
class TestPathRemap(unittest.TestCase):
    def test_recursive_remap_preserves_container_shape(self):
        tree = [{"n": "character/black_wolf_knight/pixelart/pixelart0002",
                 "meta": [1, "unchanged"]}]
        got = skin.remap_tree(tree, "character/black_wolf_knight/",
                              "character/kyle_wolf_knight/")
        self.assertEqual(got[0]["n"],
                         "character/kyle_wolf_knight/pixelart/pixelart0002")
        self.assertEqual(got[0]["meta"], [1, "unchanged"])

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
```

- [ ] **Step 2: Run the two tests and confirm the missing-module failure**

Run: `cd mod-tools; python -m unittest tests.test_canary_skin.TestPathRemap -v`

Expected: `ERROR` with `ModuleNotFoundError: No module named 'wf_canary_skin'`.

- [ ] **Step 3: Implement recursive remapping and AMF3 raw-deflate encoding**

```python
import colorsys
import zlib
from pathlib import Path

from PIL import Image

import wf_dsl
import wf_mod_tool as core


def remap_tree(value, old: str, new: str):
    if isinstance(value, str):
        return value.replace(old, new)
    if isinstance(value, list):
        return [remap_tree(v, old, new) for v in value]
    if isinstance(value, dict):
        return {k: remap_tree(v, old, new) for k, v in value.items()}
    return value


def remap_amf3_deflate(data: bytes, old: str, new: str) -> bytes:
    plain = zlib.decompress(data, -15)
    original = core.AMF3Reader(plain).read_value()
    mapped = remap_tree(original, old, new)
    encoded = wf_dsl.encode_amf3(mapped)
    if core.AMF3Reader(encoded).read_value() != mapped:
        raise ValueError("AMF3 remap round-trip mismatch")
    co = zlib.compressobj(9, zlib.DEFLATED, -15)
    return co.compress(encoded) + co.flush()
```

- [ ] **Step 4: Write failing image tests for deterministic sizing and palette conversion**

```python
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
        self.assertEqual(got.getpixel((1, 0))[3], 0)
```

- [ ] **Step 5: Run the image tests and confirm missing-function failures**

Run: `cd mod-tools; python -m unittest tests.test_canary_skin.TestImages -v`

Expected: both tests fail with `AttributeError` for the unimplemented functions.

- [ ] **Step 6: Implement deterministic RGBA fit and Kyle palette conversion**

```python
def fit_rgba(image: Image.Image, size: tuple[int, int],
             focus: tuple[float, float] = (0.5, 0.42)) -> Image.Image:
    src = image.convert("RGBA")
    scale = min(size[0] / src.width, size[1] / src.height)
    scaled = src.resize((max(1, round(src.width * scale)),
                         max(1, round(src.height * scale))), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", size, (0, 0, 0, 0))
    x = round(size[0] * focus[0] - scaled.width * focus[0])
    y = round(size[1] * focus[1] - scaled.height * focus[1])
    canvas.alpha_composite(scaled, (x, y))
    return canvas


def recolor_kyle_pixel_sheet(image: Image.Image) -> Image.Image:
    out = Image.new("RGBA", image.size)
    pixels = []
    for r, g, b, a in image.convert("RGBA").getdata():
        if a == 0:
            pixels.append((0, 0, 0, 0))
            continue
        h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
        if s > 0.38 and (h < 0.12 or h > 0.96):
            h, s, v = 0.58, min(0.78, s), min(1.0, v * 1.08)
        elif s < 0.22 and 0.10 < v < 0.52:
            s, v = 0.08, 0.66 + (v - 0.10) / 0.42 * 0.28
        nr, ng, nb = colorsys.hsv_to_rgb(h, s, v)
        pixels.append((round(nr * 255), round(ng * 255), round(nb * 255), a))
    out.putdata(pixels)
    return out
```

- [ ] **Step 7: Add pack validation tests and implementation**

```python
def test_validate_pack_rejects_wrong_sheet_size(self):
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "pixelart").mkdir()
        Image.new("RGBA", (10, 10)).save(root / "pixelart/sprite_sheet.png")
        with self.assertRaisesRegex(ValueError, "sprite_sheet.png"):
            skin.validate_pack(root, {"pixelart/sprite_sheet.png": (252, 421)})
```

```python
def validate_pack(pack_dir: Path, required_sizes: dict[str, tuple[int, int]]) -> dict:
    missing, bad = [], []
    for rel, expected in required_sizes.items():
        path = pack_dir / rel
        if not path.exists():
            missing.append(rel)
            continue
        with Image.open(path) as im:
            if im.size != expected:
                bad.append(f"{rel}: {im.size} != {expected}")
    if missing or bad:
        raise ValueError("; ".join([*(f"missing {x}" for x in missing), *bad]))
    return {"required": len(required_sizes), "missing": 0, "bad": 0}
```

- [ ] **Step 8: Run the pure helper suite**

Run: `cd mod-tools; python -m unittest tests.test_canary_skin -v`

Expected: all tests pass.

- [ ] **Step 9: Commit the pure helper**

```bash
git add -- mod-tools/wf_canary_skin.py mod-tools/tests/test_canary_skin.py
git commit -m "feat(mod-tools): add canary skin pack transforms"
```

### Task 2: Kyle pack builder and live-store transaction

**Files:**
- Create: `mod-tools/wf_kyle_canary.py`
- Modify: `mod-tools/tests/test_canary_skin.py`

**Interfaces:**
- Consumes: `wf_canary_skin` helpers, canary `119999`, visual template `111007`, source masters under `work/ai_canary/kyle_wolf_knight/source/`.
- Produces: CLI commands `prepare`, `dry-run`, `apply`, and `verify`; standard pack under `work/ai_canary/kyle_wolf_knight/pack/`.

- [ ] **Step 1: Write failing tests for logical-path rewriting and voice-source selection**

```python
class TestKylePlan(unittest.TestCase):
    def test_visual_assets_use_black_wolf_but_voice_uses_current_canary(self):
        plan = kyle.build_copy_plan(
            visual_logicals=["character/black_wolf_knight/ui/square_0.png",
                             "character/black_wolf_knight/voice/ally/join.mp3"],
            voice_logicals=["character/resistance_princess_3halfanv/voice/ally/join.mp3"])
        self.assertIn(("character/black_wolf_knight/ui/square_0.png",
                       "character/kyle_wolf_knight/ui/square_0.png"), plan)
        self.assertIn(("character/resistance_princess_3halfanv/voice/ally/join.mp3",
                       "character/kyle_wolf_knight/voice/ally/join.mp3"), plan)
        self.assertNotIn(("character/black_wolf_knight/voice/ally/join.mp3",
                          "character/kyle_wolf_knight/voice/ally/join.mp3"), plan)
```

- [ ] **Step 2: Run the test and confirm the module failure**

Run: `cd mod-tools; python -m unittest tests.test_canary_skin.TestKylePlan -v`

Expected: `ImportError` for `wf_kyle_canary`.

- [ ] **Step 3: Implement the immutable Kyle configuration and copy plan**

```python
import argparse
import json
import shutil
import time
import zlib
from pathlib import Path

from PIL import Image

import wf_assets
import wf_canary_skin as skin
import wf_gui as gui


CANARY_ID = "119999"
PIXEL_TEMPLATE_ID = "111007"
PIXEL_TEMPLATE_CODE = "black_wolf_knight"
CURRENT_CODE = "resistance_princess_3halfanv"
NEW_CODE = "kyle_wolf_knight"
WORK = ROOT / "work" / "ai_canary" / NEW_CODE


def build_copy_plan(visual_logicals: list[str], voice_logicals: list[str]):
    plan = []
    for logical in visual_logicals:
        if "/voice/" in logical:
            continue
        plan.append((logical, logical.replace(
            f"character/{PIXEL_TEMPLATE_CODE}/", f"character/{NEW_CODE}/", 1)))
    for logical in voice_logicals:
        if "/voice/" not in logical:
            continue
        plan.append((logical, logical.replace(
            f"character/{CURRENT_CODE}/", f"character/{NEW_CODE}/", 1)))
    return plan
```

- [ ] **Step 4: Implement `prepare` without touching the live store**

`prepare` must decode source PNG/MP3 files into the standard pack, remap every decodable AMF3 path prefix, recolor the two pixel sheets, copy current canary voices, and then overwrite visual files with derivatives from `base.png` and `awake.png`.

```python
def prepare() -> dict:
    pack = WORK / "pack"
    pack.mkdir(parents=True, exist_ok=True)
    visual = wf_assets.all_asset_logicals(gui.TARGET_STORE, PIXEL_TEMPLATE_CODE)
    voices = [a["logical"] for a in wf_assets.char_asset_manifest(
        gui.TARGET_STORE, CURRENT_CODE) if a["exists"] and a["logical"].endswith(".mp3")]
    copied = []
    for source, target in build_copy_plan(visual, voices):
        loc = wf_assets.locate(gui.TARGET_STORE, source)
        if not loc:
            continue
        data = loc[1].read_bytes()
        if source.endswith(".png"):
            data = wf_assets.png_decode(data)
        elif source.endswith(".mp3"):
            data = wf_assets.mp3_decode(data)
        elif source.endswith(".amf3.deflate"):
            try:
                data = skin.remap_amf3_deflate(
                    data, f"character/{PIXEL_TEMPLATE_CODE}/",
                    f"character/{NEW_CODE}/")
            except (ValueError, zlib.error):
                pass
        dest = pack / target.split(f"character/{NEW_CODE}/", 1)[1]
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        copied.append(dest.relative_to(pack).as_posix())
    build_visual_derivatives(WORK / "source/base.png", WORK / "source/awake.png", pack)
    rebuild_illustration_sheet(pack)
    recolor_pixel_sheets(pack)
    return {"pack": str(pack), "files": len(copied)}
```

- [ ] **Step 5: Implement deterministic UI derivatives**

Use exact target sizes already present in the `black_wolf_knight` manifest. The two full-shot masters are normalized to `1440x1920`; portrait assets use the specified focus values. Story expression overlays are transparent so no old wolf face fragments survive; `base_0.png` and `base_1.png` remain visible.

```python
DERIVATIVES = {
    "ui/skill_cutin_{n}.png": ((1024, 512), (0.50, 0.30)),
    "ui/square_{n}.png": ((212, 212), (0.50, 0.24)),
    "ui/square_132_132_{n}.png": ((132, 132), (0.50, 0.24)),
    "ui/square_round_95_95_{n}.png": ((95, 95), (0.50, 0.23)),
    "ui/square_round_136_136_{n}.png": ((136, 136), (0.50, 0.23)),
    "ui/thumb_level_up_{n}.png": ((252, 329), (0.50, 0.30)),
    "ui/thumb_party_main_{n}.png": ((186, 392), (0.50, 0.38)),
    "ui/thumb_party_unison_{n}.png": ((144, 188), (0.50, 0.32)),
    "ui/battle_control_board_{n}.png": ((104, 268), (0.50, 0.35)),
    "ui/battle_member_status_{n}.png": ((58, 58), (0.50, 0.22)),
    "ui/cutin_skill_chain_{n}.png": ((276, 319), (0.50, 0.30)),
}


def build_visual_derivatives(base_path: Path, awake_path: Path, pack: Path):
    masters = [Image.open(base_path).convert("RGBA"), Image.open(awake_path).convert("RGBA")]
    for n, master in enumerate(masters):
        full = skin.fit_rgba(master, (1440, 1920), (0.5, 0.5))
        full.save(pack / f"ui/full_shot_1440_1920_{n}.png")
        for template, (size, focus) in DERIVATIVES.items():
            path = pack / template.format(n=n)
            path.parent.mkdir(parents=True, exist_ok=True)
            skin.fit_rgba(master, size, focus).save(path)
        skin.fit_rgba(master, (520 if n == 0 else 570, 616 if n == 0 else 690),
                      (0.5, 0.34)).save(pack / f"ui/story/base_{n}.png")
    for overlay in ("anger", "normal", "normal_b", "sad", "sad_b", "serious",
                    "serious_b", "shame", "smile", "smile_b", "smile_c",
                    "smile_d", "surprise", "sweat", "think"):
        target = pack / f"ui/story/{overlay}.png"
        with Image.open(target) as old:
            Image.new("RGBA", old.size, (0, 0, 0, 0)).save(target)
```

- [ ] **Step 6: Add illustration sprite-sheet rebuild and pixel recolor**

```python
def rebuild_illustration_sheet(pack: Path):
    sheet = Image.new("RGBA", (361, 806), (0, 0, 0, 0))
    awake = Image.open(pack / "ui/full_shot_1440_1920_1.png").convert("RGBA")
    base = Image.open(pack / "ui/full_shot_1440_1920_0.png").convert("RGBA")
    sheet.alpha_composite(skin.fit_rgba(awake, (360, 372), (0.5, 0.33)), (0, 0))
    sheet.alpha_composite(skin.fit_rgba(base, (359, 365), (0.5, 0.33)), (0, 373))
    sheet.save(pack / "ui/illustration_setting_sprite_sheet.png")


def recolor_pixel_sheets(pack: Path):
    for rel in ("pixelart/sprite_sheet.png", "pixelart/special_sprite_sheet.png"):
        path = pack / rel
        with Image.open(path) as image:
            skin.recolor_kyle_pixel_sheet(image).save(path)
```

- [ ] **Step 7: Implement store apply as snapshot + dry-run + isolated writes**

The command must refuse to apply unless `get_char_fields("119999")` still reports `resistance_princess_3halfanv` or already reports `kyle_wolf_knight`. It snapshots first, clones trimmed-image keys and the `character_image`/`full_shot_image_attribute` rows from `111007` to `119999`, writes new hashed paths with backup-on-overwrite, changes only `code_name`, and calls existing `replace_asset` for generated PNGs so trim and ATF synchronization remain centralized.

```python
REQUIRED_SIZES = {
    "ui/full_shot_1440_1920_0.png": (1440, 1920),
    "ui/full_shot_1440_1920_1.png": (1440, 1920),
    "ui/skill_cutin_0.png": (1024, 512),
    "ui/skill_cutin_1.png": (1024, 512),
    "ui/illustration_setting_sprite_sheet.png": (361, 806),
    "pixelart/sprite_sheet.png": (252, 351),
    "pixelart/special_sprite_sheet.png": (512, 512),
}


def validate_kyle_pack(pack: Path) -> dict:
    result = skin.validate_pack(pack, REQUIRED_SIZES)
    stale = []
    needle = f"character/{PIXEL_TEMPLATE_CODE}/".encode()
    for path in pack.rglob("*.amf3.deflate"):
        try:
            if needle in zlib.decompress(path.read_bytes(), -15):
                stale.append(path.relative_to(pack).as_posix())
        except zlib.error:
            continue
    if stale:
        raise ValueError(f"old code references remain: {stale}")
    result["old_code_references"] = []
    return result


def _root_by_relative_path() -> dict[str, str]:
    rows = wf_assets.char_asset_manifest(gui.TARGET_STORE, PIXEL_TEMPLATE_CODE)
    prefix = f"character/{PIXEL_TEMPLATE_CODE}/"
    return {a["logical"].split(prefix, 1)[1]: a["root"] for a in rows
            if a["exists"] and a["logical"].startswith(prefix)}


def plan_store_writes(pack: Path) -> list[dict]:
    roots = _root_by_relative_path()
    writes = []
    for path in sorted(p for p in pack.rglob("*") if p.is_file()):
        rel = path.relative_to(pack).as_posix()
        root = roots.get(rel, "upload")
        logical = f"character/{NEW_CODE}/{rel}"
        writes.append({"relative": rel, "root": root, "logical": logical})
    return writes


def _store_bytes(path: Path) -> bytes:
    data = path.read_bytes()
    if path.suffix.lower() == ".png":
        return wf_assets.png_encode(data)
    if path.suffix.lower() == ".mp3":
        return wf_assets.mp3_encode(data)
    return data


def materialize_new_paths(pack: Path):
    roots = _root_by_relative_path()
    for path in sorted(p for p in pack.rglob("*") if p.is_file()):
        rel = path.relative_to(pack).as_posix()
        root = roots.get(rel, "upload")
        logical = f"character/{NEW_CODE}/{rel}"
        dest = wf_assets.path_in_root(gui.TARGET_STORE, root, logical)
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.exists():
            backup = dest.with_name(dest.name + ".bak-wfmod-kyle-" +
                                    time.strftime("%Y%m%d-%H%M%S"))
            shutil.copy2(dest, backup)
        dest.write_bytes(_store_bytes(path))
        gui.add_pending(dest)


def clone_template_metadata(src_id: str, dst_id: str, src_code: str, dst_code: str):
    trimmed = gui.core.load_table(gui.TRIMMED_LOGICAL, gui.TARGET_STORE, gui.SOURCE_STORE)
    rows = trimmed.text_rows()
    prefix = f"character/{src_code}/"
    additions = {key.replace(prefix, f"character/{dst_code}/", 1): value
                 for key, value in rows.items() if key.startswith(prefix)}
    trimmed.set_text_rows(additions)
    written = gui.core.write_table(trimmed, gui.TARGET_STORE,
                                   ".bak-wfmod-kyle-trim-" + time.strftime("%Y%m%d-%H%M%S"),
                                   no_backup=False)
    gui.add_pending(written)
    for logical in (gui.CHAR_IMAGE_LOGICAL, gui.FS_ATTR_LOGICAL):
        table = gui._load_nested_opt(logical)
        if src_id not in table.keys or dst_id not in table.keys:
            raise ValueError(f"{logical}: missing {src_id} or {dst_id}")
        table.rows[table.keys.index(dst_id)] = table.rows[table.keys.index(src_id)]
        gui._write_nested(table, logical, f"Kyle visual metadata {src_id}->{dst_id}")


def apply(dry_run: bool) -> dict:
    current = gui.get_char_fields(CANARY_ID)["fields"]["code_name"]
    if current not in {CURRENT_CODE, NEW_CODE}:
        raise ValueError(f"unexpected canary code_name: {current}")
    pack = WORK / "pack"
    validate_kyle_pack(pack)
    preview = plan_store_writes(pack)
    if dry_run:
        return {"dry_run": True, "writes": preview}
    snapshot = gui.char_snapshot(CANARY_ID, "before Kyle visual skin")
    clone_template_metadata(PIXEL_TEMPLATE_ID, CANARY_ID, PIXEL_TEMPLATE_CODE, NEW_CODE)
    materialize_new_paths(pack)
    gui.save_char_fields(CANARY_ID, {"code_name": NEW_CODE}, dry_run=False)
    for png in sorted(pack.rglob("*.png")):
        logical = f"character/{NEW_CODE}/{png.relative_to(pack).as_posix()}"
        gui.replace_asset(logical, png.read_bytes(), force=True, dry_run=False)
    return {"dry_run": False, "snapshot": snapshot, "writes": len(preview)}


def verify() -> dict:
    pack = WORK / "pack"
    result = validate_kyle_pack(pack)
    result["pack"] = str(pack)
    return result
```

- [ ] **Step 8: Add CLI parsing and exact refusal defaults**

```python
def main(argv=None):
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("prepare")
    sub.add_parser("dry-run")
    sub.add_parser("apply")
    sub.add_parser("verify")
    args = parser.parse_args(argv)
    result = (prepare() if args.cmd == "prepare" else
              apply(True) if args.cmd == "dry-run" else
              apply(False) if args.cmd == "apply" else verify())
    print(json.dumps(result, ensure_ascii=False, indent=2))
```

- [ ] **Step 9: Run tests and CLI help**

Run: `cd mod-tools; python -m unittest tests.test_canary_skin -v`

Expected: all tests pass.

Run: `python mod-tools/wf_kyle_canary.py --help`

Expected: lists `prepare`, `dry-run`, `apply`, and `verify` without touching the store.

- [ ] **Step 10: Commit the Kyle adapter**

```bash
git add -- mod-tools/wf_kyle_canary.py mod-tools/tests/test_canary_skin.py
git commit -m "feat(mod-tools): add Kyle canary asset pipeline"
```

### Task 3: Generate the two Kyle master illustrations

**Files:**
- Create: `work/ai_canary/kyle_wolf_knight/source/base-key.png`
- Create: `work/ai_canary/kyle_wolf_knight/source/awake-key.png`
- Create: `work/ai_canary/kyle_wolf_knight/source/base.png`
- Create: `work/ai_canary/kyle_wolf_knight/source/awake.png`

**Interfaces:**
- Consumes: user reference image at `E:/sora——picture/OC/角色设计/狼骑士/早期凯尔/ChatGPT Image 2026年7月11日 09_42_19.png`.
- Produces: two transparent, identity-consistent full-body RGBA masters.

- [ ] **Step 1: Generate the base form with built-in image generation**

Use the user image as a reference image, not an edit target. Use this exact prompt:

```text
Use case: stylized-concept
Asset type: mobile fantasy RPG full-body character illustration
Input images: Image 1 is the identity, anatomy, costume, palette, and material reference for Kyle
Primary request: create a polished full-body hero illustration of the same adult male anthropomorphic white wolf knight, standing in a calm three-quarter combat-ready pose
Subject: tall muscular white wolf man; long layered white fur; upright wolf ears; ice-blue eyes; silver-white open long coat; slate-blue shoulder cape and hanging cloth; ornate silver filigree and small blue crystals; dark belt; white trousers; black armored knee-high boots; large white tail; no helmet and no weapon obscuring the body
Style/medium: crisp high-end 2D cel-shaded fantasy mobile RPG character art, clean readable silhouette, controlled painterly highlights
Composition/framing: entire body including ears, boots, and tail visible; centered; generous padding; no cropping
Scene/backdrop: perfectly flat solid #ff00ff chroma-key background
Constraints: preserve the reference character identity and costume; one character only; background is one uniform color with no shadow, gradient, texture, floor, reflection, or lighting variation; do not use #ff00ff on the subject; no text; no watermark
Avoid: human face, black wolf fur, red armor, extra limbs, extra tail, cropped boots, photorealistic rendering
```

- [ ] **Step 2: Inspect identity and reject if any invariant fails**

Check: one white wolf, blue eyes, both boots, both ears, one tail, silver-white/blue outfit, no magenta in the subject, no shadow, no weapon blocking the torso.

Expected: all checks pass before continuing.

- [ ] **Step 3: Generate the awakened form as a single targeted variation**

```text
Use case: identity-preserve
Asset type: awakened mobile fantasy RPG full-body character illustration
Input images: Image 1 is the approved base Kyle illustration; Image 2 is the original character reference
Primary request: keep exactly the same Kyle identity, anatomy, white fur, face, outfit construction, silver filigree, blue crystals, boots, and tail; change only the pose to a more forceful heroic stance and add restrained ice-blue magical energy around the shoulders and one raised hand
Composition/framing: entire body including ears, boots, and tail visible; centered; generous padding
Scene/backdrop: perfectly flat solid #ff00ff chroma-key background
Constraints: one character only; background is one uniform color with no shadow, gradient, texture, floor, reflection, or lighting variation; do not use #ff00ff on the subject; no text; no watermark
Avoid: costume redesign, different face, extra limbs, extra tail, large effects covering the silhouette, photorealistic rendering
```

- [ ] **Step 4: Remove chroma key with the installed helper**

```powershell
python "$env:USERPROFILE\.codex\skills\.system\imagegen\scripts\remove_chroma_key.py" --input "work\ai_canary\kyle_wolf_knight\source\base-key.png" --out "work\ai_canary\kyle_wolf_knight\source\base.png" --auto-key border --soft-matte --transparent-threshold 12 --opaque-threshold 220 --despill
python "$env:USERPROFILE\.codex\skills\.system\imagegen\scripts\remove_chroma_key.py" --input "work\ai_canary\kyle_wolf_knight\source\awake-key.png" --out "work\ai_canary\kyle_wolf_knight\source\awake.png" --auto-key border --soft-matte --transparent-threshold 12 --opaque-threshold 220 --despill
```

Expected: both outputs are RGBA, all four corners have alpha `0`, subject coverage is between 25% and 85%, and no visible magenta fringe remains. If fur edges fail, stop and request explicit approval before the true-transparency CLI fallback.

### Task 4: Build and visually QA the complete offline pack

**Files:**
- Modify generated outputs only under `work/ai_canary/kyle_wolf_knight/pack/`.

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: a standard-format pack that passes structural and visual validation without touching the live store.

- [ ] **Step 1: Build the pack**

Run: `python mod-tools/wf_kyle_canary.py prepare`

Expected: reports at least 74 copied/generated files and writes both pixel sheets plus six remapped pixel AMF3 documents.

- [ ] **Step 2: Run pure pack validation**

Run: `python mod-tools/wf_kyle_canary.py verify`

Expected: `missing_required: []`, `bad_dimensions: []`, `old_code_references: []`, and both sprite sheets preserve template dimensions `252x351` and `512x512`.

- [ ] **Step 3: Inspect a contact sheet**

Generate `work/ai_canary/kyle_wolf_knight/qa/ui-contact.png` containing base/awake full shots, all square portraits, party thumbnails, battle UI, and cut-ins. Inspect it at original resolution.

Expected: every visible asset depicts Kyle; no princess or black-wolf remnants; face and outfit remain consistent.

- [ ] **Step 4: Inspect pixel animation preview**

Use the existing pixel animation preview logic with the remapped atlas/timeline and new sheets. Check `neutral`, `walk_back`, `walk_front`, `skill_ready`, `kachidoki`, `special_land`, and `special_pose` at 6× nearest-neighbor scale.

Expected: no frame exits its `fw/fh=256` canvas, no magenta pixels, no old red flame remains, no transparent blank frame where the template had visible pixels.

### Task 5: Apply, publish, and verify the live canary

**Files:**
- Modify live CN store through the CLI only.
- Create CDN diff archives through existing `wf_publish.py` only.

**Interfaces:**
- Consumes: QA-approved offline pack from Task 4.
- Produces: isolated `119999` Kyle assets delivered through CN incremental CDN.

- [ ] **Step 1: Run live-store dry-run**

Run: `python mod-tools/wf_kyle_canary.py dry-run`

Expected: reports `119999: resistance_princess_3halfanv -> kyle_wolf_knight`, a snapshot action, new hashed files in common/medium/android roots, cloned trim keys, and no writes.

- [ ] **Step 2: Apply with automatic snapshot and backups**

Run: `python mod-tools/wf_kyle_canary.py apply`

Expected: returns a snapshot zip path, `code_name=kyle_wolf_knight`, necessary assets 100%, and pending entries for all three roots. It must not report any write whose logical path begins with `character/resistance_princess_3halfanv/` or `character/black_wolf_knight/`.

- [ ] **Step 3: Run focused regression tests**

Run: `cd mod-tools; python -m unittest discover tests -v`

Expected: all tests pass.

Run: `python mod-tools/wf_selftest.py`

Expected: all environment and functional checks pass; no live-store corruption warning.

- [ ] **Step 4: Publish pending assets**

Run: `python mod-tools/wf_publish.py`

Expected: creates incremental archives in common, medium, and android diff directories; target asset version advances by exactly one patch step; no full package is rebuilt.

- [ ] **Step 5: Restart the game and smoke test**

Use the existing GUI “发布并重启游戏” restart path or the configured MuMu fallback. Verify in order: mail receipt, character list, detail screen, party screen, normal battle, skill cut-in, victory animation.

Expected: Kyle appears in every UI location; all seven pixel sequences animate; skill cut-in uses the regenerated ATF; no `C7050`, `U0000`, `H400`, or missing-asset error occurs.

- [ ] **Step 6: Roll back on any client failure**

If any smoke-test step fails, stop publication work, restore the snapshot returned by `apply`, republish the restored pending files, restart the game, and confirm `119999` returns to the pre-Kyle state before debugging.

### Task 6: Final verification and handoff

**Files:**
- Modify: `docs/superpowers/specs/2026-07-13-kyle-canary-visual-assets-design.md` only if actual verified behavior differs from the approved design.

**Interfaces:**
- Consumes: successful client smoke test.
- Produces: reproducible command list, saved QA artifacts, and clean code commits without generated/store files staged.

- [ ] **Step 1: Verify git scope explicitly**

Run: `git diff --name-only -- mod-tools/wf_canary_skin.py mod-tools/wf_kyle_canary.py mod-tools/tests/test_canary_skin.py docs/superpowers`

Expected: only the planned source, test, spec, and plan files appear. `mod-tools/wf_gui.py` remains outside this task's staged scope.

- [ ] **Step 2: Re-run final verification**

Run: `cd mod-tools; python -m unittest discover tests -v`

Expected: all tests pass.

Run: `python mod-tools/wf_kyle_canary.py verify`

Expected: necessary assets 100%, no old code references, all target dimensions valid.

- [ ] **Step 3: Commit any remaining source/test changes explicitly**

```bash
git add -- mod-tools/wf_canary_skin.py mod-tools/wf_kyle_canary.py mod-tools/tests/test_canary_skin.py docs/superpowers/plans/2026-07-13-kyle-canary-visual-assets.md
git commit -m "feat(mod-tools): complete Kyle visual canary"
```

Do not stage `work/`, stores, CDN archives, backups, or the existing `wf_gui.py` change.
