# -*- coding: utf-8 -*-
"""Build and install the Kyle visual skin for the 119999 canary."""
from __future__ import annotations

import argparse
import json
import shutil
import tempfile
import time
import zipfile
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

# Compact UI must show a readable face/upper body.  Only full shots and story
# bases retain contain semantics; every standard UI derivative is focal-cover.
COVER_DERIVATIVES = frozenset(DERIVATIVES)

REQUIRED_SIZES = {
    "ui/full_shot_1440_1920_0.png": (1440, 1920),
    "ui/full_shot_1440_1920_1.png": (1440, 1920),
    "ui/skill_cutin_0.png": (1024, 512),
    "ui/skill_cutin_1.png": (1024, 512),
    "ui/illustration_setting_sprite_sheet.png": (361, 806),
    "pixelart/sprite_sheet.png": (252, 351),
    "pixelart/special_sprite_sheet.png": (512, 512),
}

PIXEL_AMF3_RELATIVES = (
    "pixelart/sprite_sheet.atlas.amf3.deflate",
    "pixelart/special_sprite_sheet.atlas.amf3.deflate",
    "pixelart/pixelart.frame.amf3.deflate",
    "pixelart/pixelart.timeline.amf3.deflate",
    "pixelart/special.frame.amf3.deflate",
    "pixelart/special.timeline.amf3.deflate",
)

INVENTORY_FILE = "inventory-manifest.json"


def require_cn_profile(runtime=None) -> dict:
    """Refuse every store-aware operation unless all roots belong to CN."""
    gui = _resolve_gui(runtime)
    profile = getattr(gui, "_PROFILE", None)
    if profile is None:
        profile = getattr(gui, "PROFILE", None)
    profile_id = getattr(profile, "id", None)
    if profile_id != "cn":
        raise ValueError(
            f"active profile must be cn (got {profile_id or 'none'})")

    target_store = Path(gui.TARGET_STORE).resolve()
    profile_store = Path(profile.store).resolve()
    if target_store != profile_store:
        raise ValueError(
            f"TARGET_STORE does not match cn profile: {target_store} != "
            f"{profile_store}")
    profile_cdndata = getattr(profile, "cdndata", None)
    actual_cdndata = getattr(gui, "CDNDATA", None)
    if profile_cdndata is None or actual_cdndata is None:
        raise ValueError("CN profile and runtime must both define CDNDATA")
    if Path(actual_cdndata).resolve() != Path(profile_cdndata).resolve():
        raise ValueError(
            f"CDNDATA does not match cn profile: {actual_cdndata} != "
            f"{profile_cdndata}")

    roots = {name: path.resolve()
             for name, path in wf_assets.roots(target_store).items()}
    expected_parent = profile_store.parent
    expected_roots = {
        "upload": profile_store,
        "medium": expected_parent / "medium_upload",
        "android": expected_parent / "android_upload",
    }
    for name, expected in expected_roots.items():
        if roots[name] != expected.resolve():
            raise ValueError(f"{name} root is outside cn profile")
    return {
        "profile_id": "cn",
        "upload": str(roots["upload"]),
        "medium": str(roots["medium"]),
        "android": str(roots["android"]),
        "cdndata": str(Path(actual_cdndata).resolve()),
    }


def _inventory_path(work: Path) -> Path:
    return work / INVENTORY_FILE


def _load_inventory(work: Path) -> dict:
    path = _inventory_path(work)
    if not path.is_file():
        raise ValueError(f"inventory manifest missing: {path}")
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data.get("entries"), list):
        raise ValueError(f"invalid inventory manifest: {path}")
    return data


def _write_inventory(work: Path, inventory: dict) -> Path:
    path = _inventory_path(work)
    path.parent.mkdir(parents=True, exist_ok=True)
    staged = path.with_name(path.name + ".tmp")
    staged.write_text(
        json.dumps(inventory, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    staged.replace(path)
    return path


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
    profile = require_cn_profile(gui)
    pack = work / "pack"
    work.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".pack-staging-", dir=work))
    copied = []
    try:
        visual_manifest = wf_assets.char_asset_manifest(
            gui.TARGET_STORE, PIXEL_TEMPLATE_CODE)
        visual_by_logical = {
            asset["logical"]: asset for asset in visual_manifest
            if "/voice/" not in asset["logical"]
        }
        required_template_relatives = (
            set(REQUIRED_SIZES) | set(PIXEL_AMF3_RELATIVES))
        missing_visuals = [
            f"character/{PIXEL_TEMPLATE_CODE}/{relative}"
            for relative in sorted(required_template_relatives)
            if not visual_by_logical.get(
                f"character/{PIXEL_TEMPLATE_CODE}/{relative}", {}
            ).get("exists")
        ]
        if missing_visuals:
            raise FileNotFoundError(
                f"required template inventory sources missing: "
                f"{missing_visuals}")
        visual_logicals = [
            asset["logical"] for asset in visual_manifest
            if asset["exists"] and "/voice/" not in asset["logical"]
        ]
        voice_manifest = wf_assets.char_asset_manifest(
            gui.TARGET_STORE, CURRENT_CODE)
        voice_logicals = [
            asset["logical"]
            for asset in voice_manifest
            if asset["exists"] and asset["logical"].endswith(".mp3")
        ]
        copy_plan = build_copy_plan(visual_logicals, voice_logicals)
        inventory_entries = []
        for source, target in copy_plan:
            located = wf_assets.locate(gui.TARGET_STORE, source)
            if not located:
                raise FileNotFoundError(
                    f"inventory source disappeared during prepare: {source}")
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
            destination = staging / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
            relative = destination.relative_to(staging).as_posix()
            copied.append(relative)
            inventory_entries.append({
                "relative": relative,
                "source": source,
                "source_root": located[0],
            })
        build_visual_derivatives(
            work / "source/base.png", work / "source/awake.png", staging)
        rebuild_illustration_sheet(staging)
        recolor_pixel_sheets(staging)
        inventory = {
            "version": 1,
            "profile_id": profile["profile_id"],
            "visual_template": PIXEL_TEMPLATE_CODE,
            "voice_source": CURRENT_CODE,
            "entries": sorted(inventory_entries,
                              key=lambda item: item["relative"]),
        }
        validate_kyle_pack(staging, inventory=inventory)
        _replace_pack_directory(staging, pack)
        _write_inventory(work, inventory)
    finally:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
    return {
        "pack": str(pack),
        "files": len(copied),
        "inventory": str(_inventory_path(work)),
    }


def _replace_pack_directory(staging: Path, pack: Path) -> None:
    """Swap a validated staging directory into place with rollback."""
    backup = None
    if pack.exists():
        backup = Path(tempfile.mkdtemp(prefix=".pack-old-", dir=pack.parent))
        backup.rmdir()
        pack.rename(backup)
    try:
        staging.rename(pack)
    except Exception:
        if backup is not None and backup.exists():
            backup.rename(pack)
        raise
    if backup is not None:
        shutil.rmtree(backup, ignore_errors=True)


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
            transform = (
                skin.cover_rgba if template in COVER_DERIVATIVES
                else skin.fit_rgba
            )
            transform(master, size, focus).save(path)
        story_size = (520, 616) if n == 0 else (570, 690)
        story_path = pack / f"ui/story/base_{n}.png"
        story_path.parent.mkdir(parents=True, exist_ok=True)
        skin.fit_rgba(master, story_size, (0.5, 0.34)).save(story_path)
    story_dir = pack / "ui/story"
    for target in sorted(story_dir.glob("*.png")):
        if target.name in {"base_0.png", "base_1.png"}:
            continue
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


def validate_kyle_pack(
        pack: Path,
        required_sizes: dict[str, tuple[int, int]] | None = None,
        inventory: dict | None = None) -> dict:
    """Decode and reconcile every pack file against its exact inventory."""
    required_sizes = REQUIRED_SIZES if required_sizes is None else required_sizes
    if inventory is None:
        inventory = _load_inventory(pack.parent)
    entries = inventory.get("entries")
    if not isinstance(entries, list):
        raise ValueError("invalid inventory entries")
    expected = [str(item.get("relative", "")) for item in entries]
    if any(not relative for relative in expected):
        raise ValueError("inventory contains an empty relative path")
    if len(expected) != len(set(expected)):
        raise ValueError("inventory contains duplicate relative paths")
    missing_pixel_documents = sorted(
        set(PIXEL_AMF3_RELATIVES) - set(expected))
    if missing_pixel_documents:
        raise ValueError(
            f"inventory missing pixel AMF3 documents: "
            f"{missing_pixel_documents}")
    actual = sorted(
        path.relative_to(pack).as_posix()
        for path in pack.rglob("*") if path.is_file()
    )
    missing = sorted(set(expected) - set(actual))
    extra = sorted(set(actual) - set(expected))
    if missing:
        raise ValueError(f"inventory missing pack files: {missing}")
    if extra:
        raise ValueError(f"inventory has unexpected pack files: {extra}")

    png_count = 0
    mp3_count = 0
    pixel_amf3_count = 0
    stale = []
    needle = f"character/{PIXEL_TEMPLATE_CODE}/".encode()
    for relative in actual:
        path = pack / relative
        if relative.endswith(".png"):
            try:
                with Image.open(path) as image:
                    image.verify()
                with Image.open(path) as image:
                    image.load()
            except Exception as error:
                raise ValueError(f"bad PNG {relative}: {error}") from error
            png_count += 1
        elif relative.endswith(".mp3"):
            try:
                wf_assets.mp3_encode(path.read_bytes())
            except Exception as error:
                raise ValueError(f"bad MP3 {relative}: {error}") from error
            mp3_count += 1
        if not relative.endswith(".amf3.deflate"):
            continue
        try:
            plain = zlib.decompress(path.read_bytes(), -15)
        except zlib.error as error:
            raise ValueError(f"bad AMF3 deflate {relative}: {error}") from error
        if needle in plain:
            stale.append(relative)
        if relative.startswith("pixelart/"):
            try:
                skin.core.AMF3Reader(plain).read_value()
            except Exception as error:
                raise ValueError(f"bad pixel AMF3 {relative}: {error}") from error
            pixel_amf3_count += 1
    if stale:
        raise ValueError(f"old code references remain: {stale}")

    try:
        result = skin.validate_pack(pack, required_sizes)
    except Exception as error:
        raise ValueError(f"required asset validation failed: {error}") from error
    result["old_code_references"] = []
    result["inventory"] = {
        "expected": len(expected),
        "actual": len(actual),
        "png": png_count,
        "mp3": mp3_count,
        "amf3": sum(1 for path in actual
                    if path.endswith(".amf3.deflate")),
        "pixel_amf3": pixel_amf3_count,
    }
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


class _FileRollbackJournal:
    """In-memory before-images for the finite live-file mutation set."""

    def __init__(self, paths) -> None:
        self.entries = []
        seen = set()
        for candidate in paths:
            path = Path(candidate).absolute()
            key = str(path).casefold()
            if key in seen:
                continue
            seen.add(key)
            existed = path.exists()
            if existed and not path.is_file():
                raise ValueError(f"rollback target is not a file: {path}")
            self.entries.append(
                (path, existed, path.read_bytes() if existed else None))

    def restore(self) -> None:
        for path, existed, data in reversed(self.entries):
            if existed:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
            elif path.exists():
                if not path.is_file():
                    raise ValueError(f"new rollback target is not a file: {path}")
                path.unlink()


def write_rollback_snapshot(paths, snapshot_dir: Path) -> Path:
    """Persist exact before-images, including files that do not yet exist."""
    snapshot_dir = Path(snapshot_dir)
    snapshot_dir.mkdir(parents=True, exist_ok=True)
    destination = snapshot_dir / (
        f"{CANARY_ID}-kyle-rollback-{time.time_ns()}.zip")
    entries = []
    seen = set()
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as archive:
        for candidate in paths:
            path = Path(candidate).absolute()
            key = str(path).casefold()
            if key in seen:
                continue
            seen.add(key)
            existed = path.exists()
            if existed and not path.is_file():
                raise ValueError(f"rollback target is not a file: {path}")
            entry = {
                "path": str(path),
                "existed": existed,
                "member": None,
            }
            if existed:
                member = f"files/{len(entries):04d}.bin"
                archive.writestr(member, path.read_bytes())
                entry["member"] = member
            entries.append(entry)
        archive.writestr(
            "manifest.json",
            json.dumps({
                "version": 1,
                "character_id": CANARY_ID,
                "entries": entries,
            }, ensure_ascii=False, indent=2),
        )
    return destination


def restore_rollback_snapshot(snapshot: Path,
                              allowed_roots=None) -> dict:
    """Restore one persistent Kyle snapshot byte-for-byte."""
    snapshot = Path(snapshot)
    with zipfile.ZipFile(snapshot) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        if manifest.get("character_id") != CANARY_ID:
            raise ValueError("rollback snapshot belongs to another character")
        roots = ([Path(root).resolve() for root in allowed_roots]
                 if allowed_roots is not None else None)
        restored = 0
        for entry in reversed(manifest.get("entries", [])):
            path = Path(entry["path"]).absolute()
            if roots is not None:
                resolved = path.resolve()
                if not any(resolved == root or root in resolved.parents
                           for root in roots):
                    raise ValueError(
                        f"rollback path outside active CN profile: {path}")
            if entry["existed"]:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(archive.read(entry["member"]))
            elif path.exists():
                if not path.is_file():
                    raise ValueError(
                        f"new rollback target is not a file: {path}")
                path.unlink()
            restored += 1
    return {"snapshot": str(snapshot), "restored": restored}


def _prevalidate_apply(gui, pack: Path, preview: list[dict]) -> list[Path]:
    """Validate every live input and return the complete mutation path set."""
    trimmed = gui.core.load_table(
        gui.TRIMMED_LOGICAL, gui.TARGET_STORE, gui.SOURCE_STORE)
    source_prefix = f"character/{PIXEL_TEMPLATE_CODE}/"
    if not any(key.startswith(source_prefix) for key in trimmed.keys):
        raise ValueError(
            f"{gui.TRIMMED_LOGICAL}: no metadata for {PIXEL_TEMPLATE_CODE}")

    for logical in (gui.CHAR_IMAGE_LOGICAL, gui.FS_ATTR_LOGICAL):
        table = gui._load_nested_opt(logical)
        missing = [
            cid for cid in (PIXEL_TEMPLATE_ID, CANARY_ID)
            if cid not in table.keys
        ]
        if missing:
            raise ValueError(f"{logical}: missing {', '.join(missing)}")

    character_logical = getattr(gui.core, "CHARACTER_LOGICAL", None)
    if character_logical is not None:
        character = gui.core.load_table(
            character_logical, gui.TARGET_STORE, gui.SOURCE_STORE)
        if CANARY_ID not in character.keys:
            raise ValueError(f"{character_logical}: missing {CANARY_ID}")

    files = {
        path.relative_to(pack).as_posix(): path
        for path in pack.rglob("*") if path.is_file()
    }
    if set(files) != {item["relative"] for item in preview}:
        raise ValueError("pack/store write plan does not cover every staged file")

    mutation_paths = []
    planned_logicals = set()
    for item in preview:
        source = files[item["relative"]]
        _store_bytes(source)
        destination = wf_assets.path_in_root(
            gui.TARGET_STORE, item["root"], item["logical"])
        mutation_paths.append(destination)
        planned_logicals.add(item["logical"])

    for png in sorted(pack.rglob("*.png")):
        relative = png.relative_to(pack).as_posix()
        if "/skill_cutin_" not in f"/{relative}":
            continue
        atf_logical = (
            f"character/{NEW_CODE}/{relative[:-4]}.atf.deflate")
        if atf_logical in planned_logicals:
            continue
        located = wf_assets.locate(gui.TARGET_STORE, atf_logical)
        if located:
            located[1].read_bytes()
            mutation_paths.append(located[1])

    table_path = getattr(gui.core, "table_path", None)
    if table_path is not None:
        table_logicals = [
            gui.TRIMMED_LOGICAL,
            gui.CHAR_IMAGE_LOGICAL,
            gui.FS_ATTR_LOGICAL,
        ]
        if character_logical is not None:
            table_logicals.append(character_logical)
        character_text_logical = getattr(gui, "CHAR_TEXT2_LOGICAL", None)
        if character_text_logical is not None:
            table_logicals.append(character_text_logical)
        mutation_paths.extend(
            table_path(gui.TARGET_STORE, logical)
            for logical in table_logicals
        )

    char_json_paths = getattr(gui, "_char_json_paths", None)
    if char_json_paths is not None:
        master_json, text_json = map(Path, char_json_paths())
        for path in (master_json, text_json):
            if not path.is_file():
                raise FileNotFoundError(path)
            path.read_bytes()
            mutation_paths.append(path)
    server_json_path = getattr(gui, "_server_char_json_path", None)
    if server_json_path is not None:
        server_json = Path(server_json_path())
        if server_json.exists():
            server_json.read_bytes()
        mutation_paths.append(server_json)
    pending_file = getattr(gui, "PENDING_FILE", None)
    if pending_file is not None:
        mutation_paths.append(Path(pending_file))
    for attribute in ("CHANGELOG_FILE", "CHANGELOG_MD"):
        changelog = getattr(gui, attribute, None)
        if changelog is not None:
            mutation_paths.append(Path(changelog))
    return mutation_paths


def plan_apply(runtime=None, work: Path = WORK,
               roots: dict[str, str] | None = None) -> dict:
    """Build the complete read-only audit plan shared by dry-run and apply."""
    gui = _resolve_gui(runtime)
    profile = require_cn_profile(gui)
    current = gui.get_char_fields(CANARY_ID)["fields"]["code_name"]
    if current not in {CURRENT_CODE, NEW_CODE}:
        raise ValueError(f"unexpected canary code_name: {current}")
    pack = work / "pack"
    validation = validate_kyle_pack(pack)
    resolved_roots = (
        _root_by_relative_path(gui) if roots is None else roots)
    writes = plan_store_writes(pack, roots=resolved_roots)
    mutation_paths = _prevalidate_apply(gui, pack, writes)
    root_counts = {
        name: sum(1 for item in writes if item["root"] == name)
        for name in ("upload", "medium", "android")
    }
    return {
        "profile": profile,
        "code_name": {
            "character_id": CANARY_ID,
            "from": current,
            "to": NEW_CODE,
        },
        "snapshot": {
            "character_snapshot": True,
            "rollback_directory": str(work / "rollback_snapshots"),
            "files": len({str(Path(path).absolute()).casefold()
                          for path in mutation_paths}),
        },
        "metadata": {
            "trimmed_image": {
                "from": f"character/{PIXEL_TEMPLATE_CODE}/",
                "to": f"character/{NEW_CODE}/",
            },
            "nested_tables": [
                getattr(gui, "CHAR_IMAGE_LOGICAL", "character_image"),
                getattr(gui, "FS_ATTR_LOGICAL",
                        "full_shot_image_attribute"),
            ],
        },
        "layer1": {
            "character_id": CANARY_ID,
            "paths": [str(path) for path in (
                getattr(gui, "_char_json_paths", lambda: ())() or ())],
        },
        "pending": {
            "file": (str(gui.PENDING_FILE)
                     if getattr(gui, "PENDING_FILE", None) else None),
            "by_root": root_counts,
        },
        "writes": writes,
        "validation": validation,
        "mutation_paths": [str(Path(path).absolute())
                           for path in mutation_paths],
    }


def apply(dry_run: bool, runtime=None, work: Path = WORK,
          roots: dict[str, str] | None = None) -> dict:
    """Preview or transactionally install the Kyle pack into the live store."""
    gui = _resolve_gui(runtime)
    plan = plan_apply(gui, work=work, roots=roots)
    pack = work / "pack"
    if dry_run:
        return {"dry_run": True, **plan}
    resolved_roots = {
        item["relative"]: item["root"] for item in plan["writes"]
    }
    mutation_paths = [Path(path) for path in plan["mutation_paths"]]
    journal = _FileRollbackJournal(mutation_paths)
    rollback_snapshot = write_rollback_snapshot(
        mutation_paths, work / "rollback_snapshots")
    try:
        snapshot = gui.char_snapshot(CANARY_ID, "before Kyle visual skin")
        clone_template_metadata(
            PIXEL_TEMPLATE_ID,
            CANARY_ID,
            PIXEL_TEMPLATE_CODE,
            NEW_CODE,
            runtime=gui,
        )
        materialize_new_paths(pack, runtime=gui, roots=resolved_roots)
        gui.save_char_fields(
            CANARY_ID, {"code_name": NEW_CODE}, dry_run=False)
        for png in sorted(pack.rglob("*.png")):
            logical = (
                f"character/{NEW_CODE}/"
                f"{png.relative_to(pack).as_posix()}"
            )
            gui.replace_asset(
                logical, png.read_bytes(), force=True, dry_run=False)
    except BaseException as error:
        try:
            journal.restore()
        except Exception as rollback_error:
            if hasattr(error, "add_note"):
                error.add_note(f"Kyle rollback failed: {rollback_error}")
        raise
    return {
        "dry_run": False,
        "snapshot": snapshot,
        "rollback_snapshot": str(rollback_snapshot),
        "writes": len(plan["writes"]),
        "plan": plan,
    }


def rollback(snapshot: Path, runtime=None) -> dict:
    """Explicitly restore an apply snapshot under the active CN profile."""
    gui = _resolve_gui(runtime)
    profile = require_cn_profile(gui)
    allowed_roots = [
        Path(profile["upload"]).parent,
        Path(profile["cdndata"]).parent,
    ]
    for attribute in ("PENDING_FILE", "CHANGELOG_FILE", "CHANGELOG_MD"):
        path = getattr(gui, attribute, None)
        if path is not None:
            allowed_roots.append(Path(path).parent.resolve())
    return restore_rollback_snapshot(snapshot, allowed_roots=allowed_roots)


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
    rollback_parser = subparsers.add_parser("rollback")
    rollback_parser.add_argument("--snapshot", required=True)
    args = parser.parse_args(argv)
    result = (
        prepare() if args.cmd == "prepare" else
        apply(True) if args.cmd == "dry-run" else
        apply(False) if args.cmd == "apply" else
        rollback(Path(args.snapshot)) if args.cmd == "rollback" else
        verify()
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
