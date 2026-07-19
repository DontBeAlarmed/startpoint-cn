# -*- coding: utf-8 -*-
"""夜班组包放置器:把生成产物/模板容器放进 white_wolf_gerald workspace 的 package/roots,
并维护 manifest 的 roots 条目(logical_path/sha256/size)。全程只写 workspace。

  python mod-tools/wf_night_pack.py amf3      # 模板 AMF3 容器(重映射路径)→ common
  python mod-tools/wf_night_pack.py visual    # build/visual UI PNG(store混淆)→ medium;ATF → android
  python mod-tools/wf_night_pack.py pixel     # build/pixel 两张 sheet(store混淆)→ common
  python mod-tools/wf_night_pack.py voice     # build/voice mp3(严格校验+混淆)→ common
  python mod-tools/wf_night_pack.py manifest  # 重扫 roots,更新 manifest roots/qa 骨架
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import wf_assets  # noqa: E402
import wf_canary_skin as skin  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
NIGHT = ROOT / "work" / "night_run_20260717"
PKG = ROOT / "work" / "character_packs" / "white_wolf_gerald" / "package"

TEMPLATE_CODE = "black_wolf_knight"
NEW_CODE = "white_wolf_gerald"

# 模板直带的 AMF3 容器(内部路径引用重映射)。root=common
AMF3_RELATIVES = (
    "ui/illustration_setting_sprite_sheet.atlas.amf3.deflate",
    "pixelart/sprite_sheet.atlas.amf3.deflate",
    "pixelart/special_sprite_sheet.atlas.amf3.deflate",
    "pixelart/pixelart.frame.amf3.deflate",
    "pixelart/pixelart.timeline.amf3.deflate",
    "pixelart/special.frame.amf3.deflate",
    "pixelart/special.timeline.amf3.deflate",
    "battle/character_detail_skill_preview.battle.amf3.deflate",
)


def _store():
    import wf_gui as gui
    return gui.TARGET_STORE


def _write(root_name: str, logical: str, data: bytes) -> str:
    dst = PKG / "roots" / root_name / logical
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(data)
    return f"{root_name}/{logical} ({len(data)}B)"


def cmd_amf3() -> list[str]:
    store = _store()
    out = []
    for rel in AMF3_RELATIVES:
        src_logical = f"character/{TEMPLATE_CODE}/{rel}"
        loc = wf_assets.locate(store, src_logical)
        if not loc:
            out.append(f"MISSING {src_logical}")
            continue
        raw = loc[1].read_bytes()
        remapped = skin.remap_amf3_deflate(
            raw, f"character/{TEMPLATE_CODE}/", f"character/{NEW_CODE}/")
        out.append(_write("common", f"character/{NEW_CODE}/{rel}", remapped))
    return out


def cmd_visual() -> list[str]:
    src = NIGHT / "build" / "visual"
    out = []
    for p in sorted(src.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(src).as_posix()
        if "/story/" in rel or "episode_banner" in rel:
            continue
        logical = f"character/{NEW_CODE}/{rel}"
        if rel.endswith(".png"):
            out.append(_write("medium", logical, wf_assets.png_encode(p.read_bytes())))
        elif rel.endswith(".atf.deflate"):
            out.append(_write("android", logical, p.read_bytes()))
    return out


def cmd_pixel() -> list[str]:
    src = NIGHT / "build" / "pixel"
    out = []
    for name in ("sprite_sheet.png", "special_sprite_sheet.png"):
        p = src / name
        if not p.exists():
            out.append(f"MISSING build/pixel/{name}")
            continue
        logical = f"character/{NEW_CODE}/pixelart/{name}"
        out.append(_write("common", logical, wf_assets.png_encode(p.read_bytes())))
    return out


def cmd_voice() -> list[str]:
    src = NIGHT / "build" / "voice"
    out = []
    for p in sorted(src.rglob("*.mp3")):
        rel = p.relative_to(src).as_posix()
        logical = f"character/{NEW_CODE}/voice/{rel}"
        out.append(_write("common", logical, wf_assets.mp3_encode(p.read_bytes())))
    return out


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def cmd_manifest() -> dict:
    mpath = PKG / "manifest.json"
    manifest = json.loads(mpath.read_text(encoding="utf-8"))
    roots: dict[str, list] = {}
    for root_name in ("common", "medium", "android", "server"):
        entries = []
        base = PKG / "roots" / root_name
        if base.exists():
            for p in sorted(base.rglob("*")):
                if p.is_file():
                    entries.append({
                        "logical_path": p.relative_to(base).as_posix(),
                        "sha256": _sha256(p),
                        "size": p.stat().st_size,
                    })
        roots[root_name] = entries
    manifest["roots"] = roots
    mpath.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8")
    counts = {k: len(v) for k, v in roots.items()}
    print(json.dumps({"ok": True, "roots": counts}, ensure_ascii=False))
    return manifest


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["amf3", "visual", "pixel", "voice", "manifest"])
    args = ap.parse_args()
    if args.cmd == "manifest":
        cmd_manifest()
        return 0
    fn = {"amf3": cmd_amf3, "visual": cmd_visual, "pixel": cmd_pixel,
          "voice": cmd_voice}[args.cmd]
    for line in fn():
        print(line)
    return 0


if __name__ == "__main__":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    raise SystemExit(main())
