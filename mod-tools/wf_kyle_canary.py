# -*- coding: utf-8 -*-
"""Build and install the Kyle visual skin for the 119999 canary."""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import tempfile
import time
import zipfile
import zlib
from pathlib import Path

from PIL import Image

import wf_assets
import wf_atf
import wf_canary_skin as skin
import wf_ui_derive as ui_derive


ROOT = Path(__file__).resolve().parent.parent
CANARY_ID = "119999"
PIXEL_TEMPLATE_ID = "111007"
PIXEL_TEMPLATE_CODE = "black_wolf_knight"
CURRENT_CODE = "resistance_princess_3halfanv"
NEW_CODE = "kyle_wolf_knight"
WORK = ROOT / "work" / "ai_canary" / NEW_CODE

TARGET_CHARACTER_FIELDS = {
    "code_name": NEW_CODE,
    "name": "雨果",
    "name_en": "HUGO",
    "race": "Beast",
    "gender": "Male",
    "role": "Tank",
}

_KYLE_DERIVATIVE_SIZES = {
    "ui/skill_cutin_{n}.png": (1024, 512),
    "ui/square_{n}.png": (212, 212),
    "ui/square_132_132_{n}.png": (132, 132),
    "ui/square_round_95_95_{n}.png": (95, 95),
    "ui/square_round_136_136_{n}.png": (136, 136),
    "ui/thumb_level_up_{n}.png": (252, 329),
    "ui/thumb_party_main_{n}.png": (186, 392),
    "ui/thumb_party_unison_{n}.png": (144, 188),
    "ui/battle_control_board_{n}.png": (104, 268),
    "ui/battle_member_status_{n}.png": (58, 58),
    "ui/cutin_skill_chain_{n}.png": (276, 319),
}
DERIVATIVES = {
    template: {**spec, "size": _KYLE_DERIVATIVE_SIZES[template]}
    for template, spec in ui_derive.DERIVATIVES.items()
}

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

# Template-specific canonical inventories.  These are source contracts, not
# filtered discovery results: every entry must resolve before prepare starts.
BLACK_WOLF_VISUAL_RELATIVES = (
    "ui/full_shot_1440_1920_0.png",
    "ui/full_shot_1440_1920_1.png",
    "ui/skill_cutin_0.png",
    "ui/skill_cutin_1.png",
    "ui/illustration_setting_sprite_sheet.png",
    "pixelart/sprite_sheet.png",
    "pixelart/special_sprite_sheet.png",
    "ui/square_0.png",
    "ui/square_1.png",
    "ui/square_132_132_0.png",
    "ui/square_132_132_1.png",
    "ui/square_round_95_95_0.png",
    "ui/square_round_95_95_1.png",
    "ui/square_round_136_136_0.png",
    "ui/square_round_136_136_1.png",
    "ui/thumb_level_up_0.png",
    "ui/thumb_level_up_1.png",
    "ui/thumb_party_main_0.png",
    "ui/thumb_party_main_1.png",
    "ui/thumb_party_unison_0.png",
    "ui/thumb_party_unison_1.png",
    "ui/battle_control_board_0.png",
    "ui/battle_control_board_1.png",
    "ui/battle_member_status_0.png",
    "ui/battle_member_status_1.png",
    "ui/cutin_skill_chain_0.png",
    "ui/cutin_skill_chain_1.png",
    "ui/episode_banner_0.png",
    "ui/story/anger.png",
    "ui/story/base_0.png",
    "ui/story/base_1.png",
    "ui/story/normal.png",
    "ui/story/sad.png",
    "ui/story/surprise.png",
    "ui/story/surprise_b.png",
    "ui/illustration_setting_sprite_sheet.atlas.amf3.deflate",
    *PIXEL_AMF3_RELATIVES,
    "ui/skill_cutin_0.atf.deflate",
    "ui/skill_cutin_1.atf.deflate",
    "battle/character_detail_skill_preview.battle.amf3.deflate",
)

CANARY_VOICE_RELATIVES = (
    "ally/evolution.mp3",
    "ally/join.mp3",
    "battle/battle_start_0.mp3",
    "battle/battle_start_1.mp3",
    "battle/outhole_0.mp3",
    "battle/outhole_1.mp3",
    "battle/power_flip_0.mp3",
    "battle/power_flip_1.mp3",
    "battle/skill_0.mp3",
    "battle/skill_1.mp3",
    "battle/skill_ready.mp3",
    "battle/win_0.mp3",
    "battle/win_1.mp3",
    "home/fufufu_shintenchi.mp3",
    "home/maunto.mp3",
    "home/roakutekina.mp3",
    "home/tamiomichibiku.mp3",
    "home/teotazusaeru.mp3",
    "home/watashiwayokubukaki.mp3",
)

CANONICAL_TARGET_RELATIVES = (
    *BLACK_WOLF_VISUAL_RELATIVES,
    *(f"voice/{relative}" for relative in CANARY_VOICE_RELATIVES),
)
CANONICAL_AMF3_RELATIVES = tuple(
    relative for relative in BLACK_WOLF_VISUAL_RELATIVES
    if relative.endswith(".amf3.deflate"))
CANONICAL_ATF_RELATIVES = tuple(
    relative for relative in BLACK_WOLF_VISUAL_RELATIVES
    if relative.endswith(".atf.deflate"))


def canonical_source(relative: str) -> str:
    if relative.startswith("voice/"):
        return f"character/{CURRENT_CODE}/{relative}"
    return f"character/{PIXEL_TEMPLATE_CODE}/{relative}"


def canonical_source_root(relative: str) -> str:
    if relative.startswith("voice/"):
        return "upload"
    if relative.endswith(".atf.deflate"):
        return "android"
    if relative.startswith("ui/") and relative.endswith(".png"):
        return "medium"
    return "upload"


def canonical_contract() -> dict[str, dict[str, str]]:
    return {
        relative: {
            "source": canonical_source(relative),
            "source_root": canonical_source_root(relative),
        }
        for relative in CANONICAL_TARGET_RELATIVES
    }


def inventory_contract_digest(entries: list[dict]) -> str:
    payload = [
        {key: entry[key] for key in (
            "relative", "source", "source_root", "source_sha256")}
        for entry in entries
    ]
    return hashlib.sha256(json.dumps(
        payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


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


def profile_binding(runtime=None) -> dict:
    profile = require_cn_profile(runtime)
    payload = {
        key: profile[key]
        for key in ("profile_id", "upload", "medium", "android", "cdndata")
    }
    payload["root_fingerprint"] = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    return payload


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


def build_source_inventory(runtime=None) -> dict:
    """Resolve the canonical 45 visual + current-canary voice source contract."""
    gui = _resolve_gui(runtime)
    profile = require_cn_profile(gui)
    entries = []
    for relative, expected in canonical_contract().items():
        source = expected["source"]
        located = wf_assets.locate(gui.TARGET_STORE, source)
        if not located:
            raise FileNotFoundError(source)
        source_root, source_path = located
        if source_root != expected["source_root"]:
            raise ValueError(
                f"canonical source root mismatch for {source}: "
                f"{source_root} != {expected['source_root']}")
        data = source_path.read_bytes()
        entries.append({
            "relative": relative,
            "source": source,
            "source_root": source_root,
            "source_sha256": hashlib.sha256(data).hexdigest(),
        })
    result = {
        "version": 2,
        "profile_id": profile["profile_id"],
        "visual_template": PIXEL_TEMPLATE_CODE,
        "voice_source": CURRENT_CODE,
        "entries": entries,
    }
    result["contract_sha256"] = inventory_contract_digest(entries)
    return result


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
    work.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".pack-staging-", dir=work))
    copied = []
    try:
        inventory = build_source_inventory(gui)
        for entry in inventory["entries"]:
            source = entry["source"]
            located = wf_assets.locate(gui.TARGET_STORE, source)
            if not located:
                raise FileNotFoundError(
                    f"inventory source disappeared during prepare: {source}")
            data = located[1].read_bytes()
            digest = hashlib.sha256(data).hexdigest()
            if digest != entry["source_sha256"]:
                raise ValueError(f"inventory source changed during prepare: {source}")
            if source.endswith(".png"):
                data = wf_assets.png_decode(data)
            elif source.endswith(".mp3"):
                data = wf_assets.mp3_decode(data)
            elif source.endswith(".amf3.deflate"):
                data = skin.remap_amf3_deflate(
                    data,
                    f"character/{PIXEL_TEMPLATE_CODE}/",
                    f"character/{NEW_CODE}/",
                )
            relative = entry["relative"]
            destination = staging / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
            relative = destination.relative_to(staging).as_posix()
            copied.append(relative)
        build_visual_derivatives(
            work / "source/base.png", work / "source/awake.png", staging)
        rebuild_illustration_sheet(staging)
        recolor_pixel_sheets(staging)
        validate_kyle_pack(staging, inventory=inventory)
        _replace_pack_and_inventory(staging, pack, inventory, work)
    finally:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
    return {
        "pack": str(pack),
        "files": len(copied),
        "inventory": str(_inventory_path(work)),
    }


def _atomic_replace_file(source: Path, destination: Path) -> None:
    source.replace(destination)


def _rename_path(source: Path, destination: Path) -> None:
    source.rename(destination)


def _replace_pack_and_inventory(staging: Path, pack: Path,
                                inventory: dict, work: Path) -> None:
    """Atomically advance or restore the pack + inventory sidecar as a pair."""
    sidecar = _inventory_path(work)
    staged_sidecar = work / f".{INVENTORY_FILE}.staging-{time.time_ns()}"
    staged_sidecar.write_text(
        json.dumps(inventory, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    old_pack = work / f".pack-old-{time.time_ns()}"
    old_sidecar = work / f".{INVENTORY_FILE}.old-{time.time_ns()}"
    had_pack = pack.exists()
    had_sidecar = sidecar.exists()
    moved_pack = False
    moved_sidecar = False
    installed_pack = False
    try:
        if had_pack:
            _rename_path(pack, old_pack)
            moved_pack = True
        if had_sidecar:
            _rename_path(sidecar, old_sidecar)
            moved_sidecar = True
        _rename_path(staging, pack)
        installed_pack = True
        _atomic_replace_file(staged_sidecar, sidecar)
    except BaseException:
        if installed_pack and pack.exists():
            shutil.rmtree(pack, ignore_errors=True)
        if moved_sidecar and sidecar.exists():
            sidecar.unlink()
        if moved_pack and old_pack.exists():
            old_pack.rename(pack)
        if moved_sidecar and old_sidecar.exists():
            old_sidecar.rename(sidecar)
        if staged_sidecar.exists():
            staged_sidecar.unlink()
        raise
    if old_pack.exists():
        shutil.rmtree(old_pack, ignore_errors=True)
    if old_sidecar.exists():
        old_sidecar.unlink()


def build_visual_derivatives(base_path: Path, awake_path: Path,
                             pack: Path) -> None:
    """Create all fixed-size UI assets from the two Kyle masters."""
    sizes = {
        f"ui/full_shot_1440_1920_{n}.png": (1440, 1920)
        for n in (0, 1)
    }
    sizes.update({
        template.format(n=n): spec["size"]
        for template, spec in DERIVATIVES.items()
        for n in (0, 1)
    })
    ui_derive.build_visual_derivatives(base_path, awake_path, pack, sizes)
    with Image.open(base_path) as base_image, Image.open(awake_path) as awake_image:
        masters = [base_image.convert("RGBA"), awake_image.convert("RGBA")]
    for n, master in enumerate(masters):
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
    ui_derive.rebuild_illustration_sheet(pack, (361, 806))


def recolor_pixel_sheets(pack: Path) -> None:
    """Apply Kyle's ice/silver palette without changing pixel atlases."""
    for relative in (
            "pixelart/sprite_sheet.png",
            "pixelart/special_sprite_sheet.png"):
        path = pack / relative
        with Image.open(path) as image:
            recolored = skin.recolor_kyle_pixel_sheet(image)
        recolored.save(path)


def _validate_canonical_manifest(inventory: dict) -> None:
    if inventory.get("version") != 2:
        raise ValueError("canonical inventory requires version 2")
    if inventory.get("profile_id") != "cn":
        raise ValueError("canonical inventory requires profile_id=cn")
    entries = inventory.get("entries")
    if not isinstance(entries, list):
        raise ValueError("canonical inventory entries missing")
    by_relative = {str(entry.get("relative", "")): entry for entry in entries}
    expected = canonical_contract()
    if len(by_relative) != len(entries) or set(by_relative) != set(expected):
        raise ValueError(
            "canonical inventory paths mismatch: expected exact declared contract")
    for relative, contract in expected.items():
        entry = by_relative[relative]
        if entry.get("source") != contract["source"]:
            raise ValueError(f"canonical source mismatch: {relative}")
        if entry.get("source_root") != contract["source_root"]:
            raise ValueError(f"canonical source_root mismatch: {relative}")
        digest = str(entry.get("source_sha256", ""))
        if (len(digest) != 64 or
                any(c not in "0123456789abcdef" for c in digest) or
                set(digest) == {"0"}):
            raise ValueError(f"canonical source_sha256 invalid: {relative}")
    if inventory.get("contract_sha256") != inventory_contract_digest(entries):
        raise ValueError("canonical inventory contract_sha256 mismatch")


def _validate_kyle_pack(
        pack: Path,
        required_sizes: dict[str, tuple[int, int]] | None = None,
        inventory: dict | None = None,
        strict: bool = False) -> dict:
    """Decode and reconcile every pack file against its exact inventory."""
    required_sizes = REQUIRED_SIZES if required_sizes is None else required_sizes
    if inventory is None:
        inventory = _load_inventory(pack.parent)
    if strict:
        _validate_canonical_manifest(inventory)
    entries = inventory.get("entries")
    if not isinstance(entries, list):
        raise ValueError("invalid inventory entries")
    expected = [str(item.get("relative", "")) for item in entries]
    if any(not relative for relative in expected):
        raise ValueError("inventory contains an empty relative path")
    if len(expected) != len(set(expected)):
        raise ValueError("inventory contains duplicate relative paths")
    if inventory.get("version", 1) >= 2:
        for entry in entries:
            if entry.get("source_root") not in {"upload", "medium", "android"}:
                raise ValueError(
                    f"inventory missing source_root: {entry.get('relative')}")
            digest = str(entry.get("source_sha256", ""))
            if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
                raise ValueError(
                    f"inventory missing source_sha256: {entry.get('relative')}")
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
    atf_count = 0
    stale = []
    needle = f"character/{PIXEL_TEMPLATE_CODE}/".encode()

    def inflate_exact(path: Path, relative: str) -> bytes:
        decoder = zlib.decompressobj(-15)
        try:
            plain = decoder.decompress(path.read_bytes()) + decoder.flush()
        except zlib.error as error:
            raise ValueError(f"bad deflate {relative}: {error}") from error
        if not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
            raise ValueError(f"bad deflate framing {relative}")
        return plain

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
        if relative.endswith(".atf.deflate"):
            try:
                plain = inflate_exact(path, relative)
                if (len(plain) < 12 or
                        int.from_bytes(plain[8:12], "big") != len(plain) - 12):
                    raise ValueError("ATF declared length mismatch")
                wf_atf.parse_atf(plain)
            except Exception as error:
                raise ValueError(f"bad ATF {relative}: {error}") from error
            atf_count += 1
            continue
        if not relative.endswith(".amf3.deflate"):
            continue
        try:
            plain = inflate_exact(path, relative)
        except ValueError as error:
            raise ValueError(f"bad AMF3 {relative}: {error}") from error
        if needle in plain:
            stale.append(relative)
        try:
            reader = skin.core.AMF3Reader(plain)
            reader.read_value()
            if reader.pos != len(plain):
                raise ValueError(
                    f"trailing bytes: decoded {reader.pos}/{len(plain)}")
        except Exception as error:
            raise ValueError(f"bad AMF3 {relative}: {error}") from error
        if relative.startswith("pixelart/"):
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
        "atf": atf_count,
    }
    if strict:
        if result["inventory"]["amf3"] != len(CANONICAL_AMF3_RELATIVES):
            raise ValueError("canonical AMF3 inventory count mismatch")
        if result["inventory"]["atf"] != len(CANONICAL_ATF_RELATIVES):
            raise ValueError("canonical ATF inventory count mismatch")
    return result


def validate_kyle_pack(
        pack: Path,
        required_sizes: dict[str, tuple[int, int]] | None = None,
        inventory: dict | None = None) -> dict:
    """Production validation: canonical CN v2 inventory is mandatory."""
    return _validate_kyle_pack(
        pack, required_sizes=required_sizes,
        inventory=inventory, strict=True)


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
                      runtime=None, inventory: dict | None = None) -> list[dict]:
    """Plan deterministic hashed-store writes without writing any files."""
    if inventory is not None:
        roots = {
            entry["relative"]: entry["source_root"]
            for entry in inventory["entries"]
        }
    else:
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
                          roots: dict[str, str] | None = None,
                          backup_timestamp: str | None = None) -> None:
    """Write the new logical paths with per-file overwrite backups."""
    gui = _resolve_gui(runtime)
    roots = _root_by_relative_path(gui) if roots is None else roots
    backup_timestamp = backup_timestamp or time.strftime("%Y%m%d-%H%M%S")
    for path in sorted(item for item in pack.rglob("*") if item.is_file()):
        relative = path.relative_to(pack).as_posix()
        root = roots.get(relative, "upload")
        logical = f"character/{NEW_CODE}/{relative}"
        destination = wf_assets.path_in_root(gui.TARGET_STORE, root, logical)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            backup = destination.with_name(
                destination.name + ".bak-wfmod-kyle-" +
                backup_timestamp)
            shutil.copy2(destination, backup)
        destination.write_bytes(_store_bytes(path))
        gui.add_pending(destination)


def clone_template_metadata(src_id: str, dst_id: str, src_code: str,
                            dst_code: str, runtime=None,
                            backup_timestamp: str | None = None) -> None:
    """Clone trim and full-shot metadata without changing combat tables."""
    gui = _resolve_gui(runtime)
    backup_timestamp = backup_timestamp or time.strftime("%Y%m%d-%H%M%S")
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
        ".bak-wfmod-kyle-trim-" + backup_timestamp,
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


class _FixedTimeProxy:
    """Pin backup/snapshot filename timestamps inside the imported GUI module."""

    def __init__(self, wrapped, timestamp: str) -> None:
        self._wrapped = wrapped
        self._timestamp = timestamp

    def strftime(self, fmt: str, *args):
        if fmt == "%Y%m%d-%H%M%S" and not args:
            return self._timestamp
        return self._wrapped.strftime(fmt, *args)

    def __getattr__(self, name):
        return getattr(self._wrapped, name)


def write_rollback_snapshot(paths, snapshot_dir: Path,
                            binding: dict | None = None,
                            scope: dict | None = None,
                            destination: Path | None = None) -> Path:
    """Persist exact before-images, including files that do not yet exist."""
    snapshot_dir = Path(snapshot_dir)
    snapshot_dir.mkdir(parents=True, exist_ok=True)
    destination = (Path(destination) if destination is not None else
                   snapshot_dir /
                   f"{CANARY_ID}-kyle-rollback-{time.time_ns()}.zip")
    if destination.parent.resolve() != snapshot_dir.resolve():
        raise ValueError("rollback snapshot destination outside snapshot directory")
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
                "version": 2,
                "character_id": CANARY_ID,
                "binding": binding,
                "scope": scope,
                "entries": entries,
            }, ensure_ascii=False, indent=2),
        )
    return destination


def _restore_snapshot_entry(entry: dict, data: bytes | None) -> None:
    path = Path(entry["path"]).absolute()
    if entry["existed"]:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    elif path.exists():
        if not path.is_file():
            raise ValueError(f"new rollback target is not a file: {path}")
        path.unlink()


def _read_rollback_snapshot(snapshot: Path, allowed_roots=None,
                            allowed_paths=(),
                            expected_binding: dict | None = None):
    snapshot = Path(snapshot)
    with zipfile.ZipFile(snapshot) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        if manifest.get("character_id") != CANARY_ID:
            raise ValueError("rollback snapshot belongs to another character")
        if expected_binding is not None and manifest.get("binding") != expected_binding:
            raise ValueError("snapshot profile binding does not match active CN profile")
        roots = ([Path(root).resolve() for root in allowed_roots]
                 if allowed_roots is not None else None)
        exact_paths = {Path(path).resolve() for path in allowed_paths}
        entries = manifest.get("entries")
        if not isinstance(entries, list):
            raise ValueError("invalid rollback snapshot entries")
        seen_paths = set()
        expected_members = {"manifest.json"}
        payloads = {}
        for entry in entries:
            path = Path(entry["path"]).absolute()
            key = str(path).casefold()
            if key in seen_paths:
                raise ValueError(f"duplicate rollback snapshot path: {path}")
            seen_paths.add(key)
            if roots is not None:
                resolved = path.resolve()
                in_root = any(resolved == root or root in resolved.parents
                              for root in roots)
                if not in_root and resolved not in exact_paths:
                    raise ValueError(
                        f"rollback path outside exact whitelist: {path}")
            member = entry.get("member")
            if entry.get("existed"):
                if not member:
                    raise ValueError(f"rollback member missing for {path}")
                expected_members.add(member)
                payloads[member] = archive.read(member)
            elif member is not None:
                raise ValueError(f"unexpected rollback member for new path: {path}")
        actual_members = set(archive.namelist())
        if (actual_members != expected_members or
                len(archive.namelist()) != len(expected_members)):
            raise ValueError(
                f"rollback zip members mismatch: expected {sorted(expected_members)}, "
                f"got {sorted(actual_members)}")
        bad_member = archive.testzip()
        if bad_member is not None:
            raise ValueError(f"rollback zip CRC failure: {bad_member}")
    return manifest, payloads


def restore_rollback_snapshot(
        snapshot: Path, allowed_roots=None,
        allowed_paths=(),
        expected_binding: dict | None = None,
        extra_journal_paths=(), after_restore=None) -> dict:
    """Prevalidate, then transactionally restore one persistent snapshot."""
    manifest, payloads = _read_rollback_snapshot(
        snapshot, allowed_roots=allowed_roots,
        allowed_paths=allowed_paths,
        expected_binding=expected_binding)
    entries = manifest["entries"]
    paths = [Path(entry["path"]) for entry in entries]
    journal = _FileRollbackJournal([*paths, *extra_journal_paths])
    try:
        for entry in reversed(entries):
            _restore_snapshot_entry(entry, payloads.get(entry.get("member")))
        if after_restore is not None:
            after_restore(entries)
    except BaseException:
        journal.restore()
        raise
    return {
        "snapshot": str(snapshot),
        "restored": len(entries),
        "restored_existing_paths": [
            entry["path"] for entry in entries if entry["existed"]],
    }


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

    core_obj = getattr(gui, "core", None)
    table_path = getattr(core_obj, "table_path", None)
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
    current_fields = gui.get_char_fields(CANARY_ID)["fields"]
    current = current_fields["code_name"]
    if current not in {CURRENT_CODE, NEW_CODE}:
        raise ValueError(f"unexpected canary code_name: {current}")
    pack = work / "pack"
    inventory = _load_inventory(work)
    validation = validate_kyle_pack(pack, inventory=inventory)
    writes = plan_store_writes(
        pack, roots=roots, runtime=gui, inventory=inventory)
    mutation_paths = _prevalidate_apply(gui, pack, writes)
    backup_timestamp = time.strftime("%Y%m%d-%H%M%S")
    operation_id = f"{backup_timestamp}-{time.time_ns()}"
    for item in writes:
        destination = wf_assets.path_in_root(
            gui.TARGET_STORE, item["root"], item["logical"])
        item["destination"] = str(destination.absolute())
        item["destination_exists"] = destination.exists()
    materialize_backups = []
    for item in writes:
        destination = Path(item["destination"])
        backup = destination.with_name(
            destination.name + ".bak-wfmod-kyle-" + backup_timestamp)
        materialize_backups.append({
            "logical": item["logical"],
            "destination": str(backup),
            "source_exists": item["destination_exists"],
            "backup_exists": backup.exists(),
            "will_create": item["destination_exists"] and not backup.exists(),
        })
    replace_logicals = [
        item["logical"] for item in writes
        if item["relative"].endswith(".png")
    ]
    replace_logicals.extend(
        f"character/{NEW_CODE}/ui/skill_cutin_{level}.atf.deflate"
        for level in (0, 1))
    replace_backups = []
    write_by_logical = {item["logical"]: item for item in writes}
    for logical in dict.fromkeys(replace_logicals):
        item = write_by_logical[logical]
        destination = Path(item["destination"])
        backup = destination.with_name(
            destination.name + ".bak-wfmod-asset-" + backup_timestamp)
        replace_backups.append({
            "logical": logical,
            "destination": str(backup),
            "source_exists_before_apply": item["destination_exists"],
            "source_exists_before_replace": True,
            "backup_exists": backup.exists(),
            "will_create": not backup.exists(),
        })

    metadata_backups = []
    table_path = getattr(getattr(gui, "core", None), "table_path", None)
    if table_path is not None:
        for logical, suffix in (
                (gui.TRIMMED_LOGICAL, ".bak-wfmod-kyle-trim-"),
                (gui.CHAR_IMAGE_LOGICAL, ".bak-wfmod-nested-"),
                (gui.FS_ATTR_LOGICAL, ".bak-wfmod-nested-")):
            destination = Path(table_path(gui.TARGET_STORE, logical))
            backup = destination.with_name(
                destination.name + suffix + backup_timestamp)
            metadata_backups.append({
                "logical": logical,
                "destination": str(backup.absolute()),
                "source_exists": destination.exists(),
                "backup_exists": backup.exists(),
            })
    snapshot_dir = Path(getattr(gui, "SNAP_DIR",
                                work / "char_snapshots")).absolute()
    character_snapshot_path = snapshot_dir / (
        f"{CANARY_ID}-{backup_timestamp}.zip")
    persistent_snapshot_path = (
        work / "rollback_snapshots" /
        f"{CANARY_ID}-kyle-rollback-{operation_id}.zip")
    changelog_files = [
        {"path": str(Path(getattr(gui, attribute)).absolute()),
         "exists": Path(getattr(gui, attribute)).exists()}
        for attribute in ("CHANGELOG_FILE", "CHANGELOG_MD")
        if getattr(gui, attribute, None) is not None
    ]
    root_counts = {
        name: sum(1 for item in writes if item["root"] == name)
        for name in ("upload", "medium", "android")
    }
    return {
        "operation_id": operation_id,
        "backup_timestamp": backup_timestamp,
        "profile": profile,
        "code_name": {
            "character_id": CANARY_ID,
            "from": current,
            "to": NEW_CODE,
        },
        "character_fields": {
            "character_id": CANARY_ID,
            "from": {
                field: current_fields.get(field, "")
                for field in TARGET_CHARACTER_FIELDS
            },
            "to": dict(TARGET_CHARACTER_FIELDS),
        },
        "snapshot": {
            "character_snapshot": True,
            "rollback_directory": str(work / "rollback_snapshots"),
            "character_artifact_template":
                f"{CANARY_ID}-YYYYMMDD-HHMMSS.zip",
            "persistent_artifact_template":
                f"{CANARY_ID}-kyle-rollback-<time_ns>.zip",
            "character_artifact": str(character_snapshot_path),
            "persistent_artifact": str(persistent_snapshot_path.absolute()),
            "files": len({str(Path(path).absolute()).casefold()
                          for path in mutation_paths}),
        },
        "backups": {
            "asset_backup_template": ".bak-wfmod-kyle-YYYYMMDD-HHMMSS",
            "asset_overwrite_candidates": [
                item["logical"] for item in writes
            ],
            "materialize": materialize_backups,
            "replace_asset": replace_backups,
            "metadata_destinations": metadata_backups,
            "metadata": {
                "trimmed_image": ".bak-wfmod-kyle-trim-YYYYMMDD-HHMMSS",
                "character_image": ".bak-wfmod-*-YYYYMMDD-HHMMSS",
                "full_shot_image_attribute":
                    ".bak-wfmod-*-YYYYMMDD-HHMMSS",
                "layer1": ".bak-charfields-YYYYMMDD-HHMMSS",
            },
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
        "changelog": {
            "files": changelog_files,
            "semantic_writes": [
                "trimmed_image clone",
                "character_image clone",
                "full_shot_image_attribute clone",
                "character identity/profile update",
                "Kyle asset writes and derived ATF/trim updates",
            ],
        },
        "operations": [
            "profile-check",
            "validate-inventory",
            "character-snapshot",
            "persistent-rollback-snapshot",
            "clone-trimmed-image",
            "clone-character-image",
            "clone-full-shot-attribute",
            "materialize-assets",
            "update-character-fields",
            "replace-png-and-derived-metadata",
            "changelog-writes",
            "pending-writes",
        ],
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
        mutation_paths, work / "rollback_snapshots",
        binding=profile_binding(gui),
        scope={
            "character_id": CANARY_ID,
            "old_code_name": plan["code_name"]["from"],
        },
        destination=Path(plan["snapshot"]["persistent_artifact"]))
    observed_operations = ["persistent-rollback-snapshot"]
    original_time = getattr(gui, "time", None)
    if original_time is not None:
        gui.time = _FixedTimeProxy(original_time, plan["backup_timestamp"])
    try:
        snapshot = gui.char_snapshot(CANARY_ID, "before Kyle visual skin")
        observed_operations.append("character-snapshot")
        clone_template_metadata(
            PIXEL_TEMPLATE_ID,
            CANARY_ID,
            PIXEL_TEMPLATE_CODE,
            NEW_CODE,
            runtime=gui,
            backup_timestamp=plan["backup_timestamp"],
        )
        observed_operations.extend([
            "clone-trimmed-image",
            "clone-character-image",
            "clone-full-shot-attribute",
        ])
        materialize_new_paths(
            pack, runtime=gui, roots=resolved_roots,
            backup_timestamp=plan["backup_timestamp"])
        observed_operations.append("materialize-assets")
        gui.save_char_fields(
            CANARY_ID, dict(TARGET_CHARACTER_FIELDS), dry_run=False)
        observed_operations.append("update-character-fields")
        for png in sorted(pack.rglob("*.png")):
            logical = (
                f"character/{NEW_CODE}/"
                f"{png.relative_to(pack).as_posix()}"
            )
            gui.replace_asset(
                logical, png.read_bytes(), force=True, dry_run=False)
        observed_operations.extend([
            "replace-png-and-derived-metadata",
            "changelog-writes",
            "pending-writes",
        ])
    except BaseException as error:
        try:
            journal.restore()
        except Exception as rollback_error:
            if hasattr(error, "add_note"):
                error.add_note(f"Kyle rollback failed: {rollback_error}")
        raise
    finally:
        if original_time is not None:
            gui.time = original_time
    return {
        "dry_run": False,
        "snapshot": snapshot,
        "rollback_snapshot": str(rollback_snapshot),
        "writes": len(plan["writes"]),
        "plan": plan,
        "observed_operations": observed_operations,
    }


def rollback(snapshot: Path, runtime=None) -> dict:
    """Explicitly restore an apply snapshot under the active CN profile."""
    gui = _resolve_gui(runtime)
    profile = require_cn_profile(gui)
    binding = profile_binding(gui)
    manifest, _payloads = _read_rollback_snapshot(
        snapshot, expected_binding=binding)
    scope = manifest.get("scope")
    if not isinstance(scope, dict):
        raise ValueError("rollback snapshot scope missing")
    if (scope.get("character_id") != CANARY_ID or
            scope.get("old_code_name") not in {CURRENT_CODE, NEW_CODE}):
        raise ValueError("rollback snapshot scope invalid")
    publish_roots = [
        Path(profile[name]).resolve()
        for name in ("upload", "medium", "android")
    ]
    allowed_paths = set()
    for relative in CANONICAL_TARGET_RELATIVES:
        logical = f"character/{NEW_CODE}/{relative}"
        allowed_paths.add(wf_assets.path_in_root(
            gui.TARGET_STORE, canonical_source_root(relative), logical).resolve())
    if scope["old_code_name"] == CURRENT_CODE:
        for relative in CANARY_VOICE_RELATIVES:
            logical = f"character/{CURRENT_CODE}/voice/{relative}"
            allowed_paths.add(wf_assets.path_in_root(
                gui.TARGET_STORE, "upload", logical).resolve())

    core_obj = getattr(gui, "core", None)
    table_path = getattr(core_obj, "table_path", None)
    if table_path is not None:
        logicals = [
            gui.TRIMMED_LOGICAL,
            gui.CHAR_IMAGE_LOGICAL,
            gui.FS_ATTR_LOGICAL,
        ]
        character_logical = getattr(core_obj, "CHARACTER_LOGICAL", None)
        if character_logical is not None:
            logicals.append(character_logical)
        character_text_logical = getattr(gui, "CHAR_TEXT2_LOGICAL", None)
        if character_text_logical is not None:
            logicals.append(character_text_logical)
        allowed_paths.update(
            Path(table_path(gui.TARGET_STORE, logical)).resolve()
            for logical in logicals)

    cdndata = Path(profile["cdndata"]).resolve()
    allowed_paths.update({
        cdndata / "character.json",
        cdndata / "character_text.json",
        cdndata.parent / "character.json",
    })
    char_json_paths = getattr(gui, "_char_json_paths", None)
    if char_json_paths is not None:
        allowed_paths.update(Path(path).resolve()
                             for path in char_json_paths())
    server_json_path = getattr(gui, "_server_char_json_path", None)
    if server_json_path is not None:
        allowed_paths.add(Path(server_json_path()).resolve())
    for attribute in ("PENDING_FILE", "CHANGELOG_FILE", "CHANGELOG_MD"):
        path = getattr(gui, attribute, None)
        if path is not None:
            allowed_paths.add(Path(path).resolve())
    queued = []

    def requeue(entries):
        for entry in entries:
            if not entry["existed"]:
                continue
            path = Path(entry["path"]).resolve()
            if not any(path == root or root in path.parents
                       for root in publish_roots):
                continue
            gui.add_pending(path)
            queued.append(path)

    pending_file = getattr(gui, "PENDING_FILE", None)
    result = restore_rollback_snapshot(
        snapshot,
        allowed_roots=[],
        allowed_paths=allowed_paths,
        expected_binding=binding,
        extra_journal_paths=([Path(pending_file)] if pending_file else []),
        after_restore=requeue,
    )
    result["pending_requeued"] = len(queued)
    result["pending_paths"] = [str(path) for path in queued]
    return result


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
