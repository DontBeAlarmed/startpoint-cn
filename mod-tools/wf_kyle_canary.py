# -*- coding: utf-8 -*-
"""Build and install the Kyle visual skin for the 119999 canary."""
from __future__ import annotations

import argparse
import json
import shutil
import time
import zlib
from pathlib import Path

from PIL import Image

import wf_assets
import wf_canary_skin as skin


ROOT = Path(__file__).resolve().parent.parent
CANARY_ID = "119999"
PIXEL_TEMPLATE_ID = "111007"
PIXEL_TEMPLATE_CODE = "black_wolf_knight"
CURRENT_CODE = "resistance_princess_3halfanv"
NEW_CODE = "kyle_wolf_knight"
WORK = ROOT / "work" / "ai_canary" / NEW_CODE

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

STORY_OVERLAYS = (
    "anger", "normal", "normal_b", "sad", "sad_b", "serious",
    "serious_b", "shame", "smile", "smile_b", "smile_c", "smile_d",
    "surprise", "sweat", "think",
)

REQUIRED_SIZES = {
    "ui/full_shot_1440_1920_0.png": (1440, 1920),
    "ui/full_shot_1440_1920_1.png": (1440, 1920),
    "ui/skill_cutin_0.png": (1024, 512),
    "ui/skill_cutin_1.png": (1024, 512),
    "ui/illustration_setting_sprite_sheet.png": (361, 806),
    "pixelart/sprite_sheet.png": (252, 351),
    "pixelart/special_sprite_sheet.png": (512, 512),
}


def build_copy_plan(visual_logicals: list[str],
                    voice_logicals: list[str]) -> list[tuple[str, str]]:
    """Map wolf visuals and current-canary voices into the Kyle pack."""
    plan = []
    for logical in visual_logicals:
        if "/voice/" in logical:
            continue
        plan.append((logical, logical.replace(
            f"character/{PIXEL_TEMPLATE_CODE}/",
            f"character/{NEW_CODE}/", 1)))
    for logical in voice_logicals:
        if "/voice/" not in logical:
            continue
        plan.append((logical, logical.replace(
            f"character/{CURRENT_CODE}/",
            f"character/{NEW_CODE}/", 1)))
    return plan


def prepare(runtime=None, work: Path = WORK) -> dict:
    """Decode source-store assets and build the offline Kyle pack."""
    gui = _resolve_gui(runtime)
    pack = work / "pack"
    pack.mkdir(parents=True, exist_ok=True)
    visual_logicals = wf_assets.all_asset_logicals(
        gui.TARGET_STORE, PIXEL_TEMPLATE_CODE)
    voice_logicals = [
        asset["logical"]
        for asset in wf_assets.char_asset_manifest(gui.TARGET_STORE, CURRENT_CODE)
        if asset["exists"] and asset["logical"].endswith(".mp3")
    ]
    copied = []
    for source, target in build_copy_plan(visual_logicals, voice_logicals):
        located = wf_assets.locate(gui.TARGET_STORE, source)
        if not located:
            continue
        data = located[1].read_bytes()
        if source.endswith(".png"):
            data = wf_assets.png_decode(data)
        elif source.endswith(".mp3"):
            data = wf_assets.mp3_decode(data)
        elif source.endswith(".amf3.deflate"):
            try:
                data = skin.remap_amf3_deflate(
                    data,
                    f"character/{PIXEL_TEMPLATE_CODE}/",
                    f"character/{NEW_CODE}/",
                )
            except (ValueError, zlib.error):
                pass
        relative = target.split(f"character/{NEW_CODE}/", 1)[1]
        destination = pack / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
        copied.append(destination.relative_to(pack).as_posix())
    build_visual_derivatives(
        work / "source/base.png", work / "source/awake.png", pack)
    rebuild_illustration_sheet(pack)
    recolor_pixel_sheets(pack)
    return {"pack": str(pack), "files": len(copied)}


def build_visual_derivatives(base_path: Path, awake_path: Path,
                             pack: Path) -> None:
    """Create all fixed-size UI assets from the two Kyle masters."""
    with Image.open(base_path) as base_image, Image.open(awake_path) as awake_image:
        masters = [base_image.convert("RGBA"), awake_image.convert("RGBA")]
    for n, master in enumerate(masters):
        full = skin.fit_rgba(master, (1440, 1920), (0.5, 0.5))
        full_path = pack / f"ui/full_shot_1440_1920_{n}.png"
        full_path.parent.mkdir(parents=True, exist_ok=True)
        full.save(full_path)
        for template, (size, focus) in DERIVATIVES.items():
            path = pack / template.format(n=n)
            path.parent.mkdir(parents=True, exist_ok=True)
            skin.fit_rgba(master, size, focus).save(path)
        story_size = (520, 616) if n == 0 else (570, 690)
        story_path = pack / f"ui/story/base_{n}.png"
        story_path.parent.mkdir(parents=True, exist_ok=True)
        skin.fit_rgba(master, story_size, (0.5, 0.34)).save(story_path)
    for overlay in STORY_OVERLAYS:
        target = pack / f"ui/story/{overlay}.png"
        with Image.open(target) as old:
            size = old.size
        Image.new("RGBA", size, (0, 0, 0, 0)).save(target)


def rebuild_illustration_sheet(pack: Path) -> None:
    """Rebuild the template's fixed illustration atlas from Kyle masters."""
    sheet = Image.new("RGBA", (361, 806), (0, 0, 0, 0))
    with Image.open(pack / "ui/full_shot_1440_1920_1.png") as image:
        awake = image.convert("RGBA")
    with Image.open(pack / "ui/full_shot_1440_1920_0.png") as image:
        base = image.convert("RGBA")
    sheet.alpha_composite(
        skin.fit_rgba(awake, (360, 372), (0.5, 0.33)), (0, 0))
    sheet.alpha_composite(
        skin.fit_rgba(base, (359, 365), (0.5, 0.33)), (0, 373))
    sheet.save(pack / "ui/illustration_setting_sprite_sheet.png")


def recolor_pixel_sheets(pack: Path) -> None:
    """Apply Kyle's ice/silver palette without changing pixel atlases."""
    for relative in (
            "pixelart/sprite_sheet.png",
            "pixelart/special_sprite_sheet.png"):
        path = pack / relative
        with Image.open(path) as image:
            recolored = skin.recolor_kyle_pixel_sheet(image)
        recolored.save(path)


def validate_kyle_pack(pack: Path) -> dict:
    """Validate fixed geometry and reject decodable old template paths."""
    result = skin.validate_pack(pack, REQUIRED_SIZES)
    stale = []
    needle = f"character/{PIXEL_TEMPLATE_CODE}/".encode()
    for path in pack.rglob("*.amf3.deflate"):
        try:
            plain = zlib.decompress(path.read_bytes(), -15)
        except zlib.error:
            continue
        if needle in plain:
            stale.append(path.relative_to(pack).as_posix())
    if stale:
        raise ValueError(f"old code references remain: {stale}")
    result["old_code_references"] = []
    return result


def _resolve_gui(runtime=None):
    """Resolve live GUI/store bindings only when a live operation needs them."""
    if runtime is not None:
        return runtime
    import wf_gui  # Lazy: import resolves profiles/store at module load time.
    return wf_gui


def _root_by_relative_path(runtime=None) -> dict[str, str]:
    gui = _resolve_gui(runtime)
    rows = wf_assets.char_asset_manifest(gui.TARGET_STORE, PIXEL_TEMPLATE_CODE)
    prefix = f"character/{PIXEL_TEMPLATE_CODE}/"
    return {
        asset["logical"].split(prefix, 1)[1]: asset["root"]
        for asset in rows
        if asset["exists"] and asset["logical"].startswith(prefix)
    }


def plan_store_writes(pack: Path, roots: dict[str, str] | None = None,
                      runtime=None) -> list[dict]:
    """Plan deterministic hashed-store writes without writing any files."""
    roots = _root_by_relative_path(runtime) if roots is None else roots
    writes = []
    for path in sorted(item for item in pack.rglob("*") if item.is_file()):
        relative = path.relative_to(pack).as_posix()
        root = roots.get(relative, "upload")
        writes.append({
            "relative": relative,
            "root": root,
            "logical": f"character/{NEW_CODE}/{relative}",
        })
    return writes


def _store_bytes(path: Path) -> bytes:
    data = path.read_bytes()
    if path.suffix.lower() == ".png":
        return wf_assets.png_encode(data)
    if path.suffix.lower() == ".mp3":
        return wf_assets.mp3_encode(data)
    return data


def materialize_new_paths(pack: Path, runtime=None,
                          roots: dict[str, str] | None = None) -> None:
    """Write the new logical paths with per-file overwrite backups."""
    gui = _resolve_gui(runtime)
    roots = _root_by_relative_path(gui) if roots is None else roots
    for path in sorted(item for item in pack.rglob("*") if item.is_file()):
        relative = path.relative_to(pack).as_posix()
        root = roots.get(relative, "upload")
        logical = f"character/{NEW_CODE}/{relative}"
        destination = wf_assets.path_in_root(gui.TARGET_STORE, root, logical)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            backup = destination.with_name(
                destination.name + ".bak-wfmod-kyle-" +
                time.strftime("%Y%m%d-%H%M%S"))
            shutil.copy2(destination, backup)
        destination.write_bytes(_store_bytes(path))
        gui.add_pending(destination)


def clone_template_metadata(src_id: str, dst_id: str, src_code: str,
                            dst_code: str, runtime=None) -> None:
    """Clone trim and full-shot metadata without changing combat tables."""
    gui = _resolve_gui(runtime)
    trimmed = gui.core.load_table(
        gui.TRIMMED_LOGICAL, gui.TARGET_STORE, gui.SOURCE_STORE)
    rows = trimmed.text_rows()
    prefix = f"character/{src_code}/"
    additions = {
        key.replace(prefix, f"character/{dst_code}/", 1): value
        for key, value in rows.items()
        if key.startswith(prefix)
    }
    trimmed.set_text_rows(additions)
    written = gui.core.write_table(
        trimmed,
        gui.TARGET_STORE,
        ".bak-wfmod-kyle-trim-" + time.strftime("%Y%m%d-%H%M%S"),
        no_backup=False,
    )
    gui.add_pending(written)
    for logical in (gui.CHAR_IMAGE_LOGICAL, gui.FS_ATTR_LOGICAL):
        table = gui._load_nested_opt(logical)
        if src_id not in table.keys or dst_id not in table.keys:
            raise ValueError(f"{logical}: missing {src_id} or {dst_id}")
        table.rows[table.keys.index(dst_id)] = table.rows[table.keys.index(src_id)]
        gui._write_nested(
            table, logical, f"Kyle visual metadata {src_id}->{dst_id}")


def apply(dry_run: bool, runtime=None, work: Path = WORK,
          roots: dict[str, str] | None = None) -> dict:
    """Preview or transactionally install the Kyle pack into the live store."""
    gui = _resolve_gui(runtime)
    current = gui.get_char_fields(CANARY_ID)["fields"]["code_name"]
    if current not in {CURRENT_CODE, NEW_CODE}:
        raise ValueError(f"unexpected canary code_name: {current}")
    pack = work / "pack"
    validate_kyle_pack(pack)
    resolved_roots = (
        _root_by_relative_path(gui) if roots is None else roots)
    preview = plan_store_writes(pack, roots=resolved_roots)
    if dry_run:
        return {"dry_run": True, "writes": preview}
    snapshot = gui.char_snapshot(CANARY_ID, "before Kyle visual skin")
    clone_template_metadata(
        PIXEL_TEMPLATE_ID,
        CANARY_ID,
        PIXEL_TEMPLATE_CODE,
        NEW_CODE,
        runtime=gui,
    )
    materialize_new_paths(pack, runtime=gui, roots=resolved_roots)
    gui.save_char_fields(CANARY_ID, {"code_name": NEW_CODE}, dry_run=False)
    for png in sorted(pack.rglob("*.png")):
        logical = (
            f"character/{NEW_CODE}/"
            f"{png.relative_to(pack).as_posix()}"
        )
        gui.replace_asset(
            logical, png.read_bytes(), force=True, dry_run=False)
    return {
        "dry_run": False,
        "snapshot": snapshot,
        "writes": len(preview),
    }


def verify(work: Path = WORK) -> dict:
    pack = work / "pack"
    result = validate_kyle_pack(pack)
    result["pack"] = str(pack)
    return result


def main(argv=None) -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="cmd", required=True)
    subparsers.add_parser("prepare")
    subparsers.add_parser("dry-run")
    subparsers.add_parser("apply")
    subparsers.add_parser("verify")
    args = parser.parse_args(argv)
    result = (
        prepare() if args.cmd == "prepare" else
        apply(True) if args.cmd == "dry-run" else
        apply(False) if args.cmd == "apply" else
        verify()
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
