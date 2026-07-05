#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
WF 数据包全量导出器 —— 按客户端逻辑解密/解码 production/upload 里每一个文件,
导出为可读格式(PNG / MP3 / OGG / JSON / CSV / HTML)。

已逆向的格式:
  1. orderedmap 数据表          -> CSV
  2. 混淆 PNG(头3字节 +0x20)   -> .png
  3. MP3(明文 ID3 / 混淆首字节 0xff->0x7f) -> .mp3
  4. AMF3 对象(zlib,可含长度前缀) -> .json(动画 / schema / config)
  5. OGG / HTML / JPEG / 其它     -> 对应后缀

文件名用 DataCatalog.csv / PathList.csv 的已知逻辑路径,未知用 hash 位置。

用法:
  python mod-tools/wf_export_assets.py --store <upload目录> --out export --workers 16
  python mod-tools/wf_export_assets.py --limit 200      # 小样验证
"""
from __future__ import annotations
import argparse
import csv
import json
import sys
import zlib
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import wf_mod_tool as core

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def deobf_png(raw: bytes) -> bytes | None:
    if len(raw) < 8 or raw[0] != 0x89:
        return None
    fixed = bytearray(raw)
    for i in (1, 2, 3):
        fixed[i] = (fixed[i] - 0x20) & 0xFF
    return bytes(fixed) if bytes(fixed[:8]) == PNG_MAGIC else None


def deobf_mp3(raw: bytes) -> bytes | None:
    if len(raw) > 4 and raw[0] == 0x7F and (raw[1] & 0xE0) == 0xE0:
        return b"\xff" + raw[1:]
    return None


def try_inflate(raw: bytes) -> bytes | None:
    for buf in (raw, raw[4:]):
        for args in ((), (-15,)):
            try:
                return zlib.decompress(buf, *args)
            except Exception:
                pass
    return None


def jsonable(o):
    if isinstance(o, dict):
        return {str(k): jsonable(v) for k, v in o.items()}
    if isinstance(o, list):
        return [jsonable(v) for v in o]
    if isinstance(o, bytes):
        return o.decode("utf-8", "replace")
    return o


def classify_and_export(raw: bytes, out_base: Path) -> str:
    # 1) orderedmap
    try:
        keys, _, _ = core.parse_index(raw)
        if keys:
            om = core.read_orderedmap_file_from_bytes(raw)
            rows = []
            for k, t in om.items():
                lines = core.read_csv_lines(t)
                if not lines:
                    rows.append([k])
                for line in lines:
                    rows.append([k] + line)
            with out_base.with_suffix(".csv").open("w", newline="", encoding="utf-8-sig") as fh:
                csv.writer(fh).writerows(rows)
            return "table"
    except Exception:
        pass
    # 2) MP3
    if raw[:3] == b"ID3" or raw[:2] == b"\xff\xfb":
        out_base.with_suffix(".mp3").write_bytes(raw)
        return "mp3"
    mp3 = deobf_mp3(raw)
    if mp3:
        out_base.with_suffix(".mp3").write_bytes(mp3)
        return "mp3"
    # 3) OGG
    if raw[:4] == b"OggS":
        out_base.with_suffix(".ogg").write_bytes(raw)
        return "ogg"
    # 4) PNG / JPEG(明文或混淆)
    png = deobf_png(raw)
    if png:
        out_base.with_suffix(".png").write_bytes(png)
        return "png"
    if raw[:8] == PNG_MAGIC:
        out_base.with_suffix(".png").write_bytes(raw)
        return "png"
    if raw[:3] == b"\xff\xd8\xff":
        out_base.with_suffix(".jpg").write_bytes(raw)
        return "jpg"
    # 5) zlib 包(AMF3 / 内嵌PNG / HTML)
    dec = try_inflate(raw)
    if dec is not None:
        png = deobf_png(dec)
        if png:
            out_base.with_suffix(".png").write_bytes(png)
            return "png(zlib)"
        if dec[:8] == PNG_MAGIC:
            out_base.with_suffix(".png").write_bytes(dec)
            return "png(zlib)"
        stripped = dec[:16].lstrip().lower()
        if stripped[:9] == b"<!doctype" or stripped[:5] == b"<html":
            out_base.with_suffix(".html").write_bytes(dec)
            return "html"
        try:
            obj = core.AMF3Reader(dec).read_value()
        except Exception:
            obj = None
        if obj is not None:
            with out_base.with_suffix(".json").open("w", encoding="utf-8") as fh:
                json.dump(jsonable(obj), fh, ensure_ascii=False, indent=1)
            return "amf3"
        out_base.with_suffix(".bin").write_bytes(dec)
        return "zlib-bin"
    # 6) 兜底
    out_base.with_suffix(".bin").write_bytes(raw)
    return "raw"


def load_names(mod_dir: Path) -> dict[str, str]:
    loc2name: dict[str, str] = {}
    for fn in ("DataCatalog.csv", "PathList.csv"):
        p = mod_dir / fn
        if not p.exists():
            continue
        with p.open(encoding="utf-8-sig") as fh:
            for row in csv.DictReader(fh):
                loc = row.get("存储位置") or row.get("存储位置(hash)")
                name = row.get("逻辑路径(已知)") or row.get("逻辑路径")
                if loc and name:
                    loc2name.setdefault(loc, name.split("  ")[0])
    return loc2name


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--store")
    ap.add_argument("--out", default="export")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--workers", type=int, default=1)
    args = ap.parse_args()

    mod_dir = Path(__file__).resolve().parent
    store = Path(args.store) if args.store else core.find_world_upload(mod_dir.parent)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    loc2name = load_names(mod_dir)

    files = []
    for d in sorted(store.iterdir()):
        if d.is_dir() and len(d.name) == 2:
            for f in d.iterdir():
                if ".bak" not in f.name:
                    files.append((d.name, f))
    if args.limit:
        files = files[:args.limit]
    print(f"待导出 {len(files)} 个文件 -> {out}")

    stat: Counter = Counter()

    def work(item):
        dname, f = item
        loc = f"{dname}/{f.name}"
        name = loc2name.get(loc, loc.replace("/", "_"))
        safe = name.replace("/", "__").replace(".orderedmap", "").replace(":", "_")
        target = out / safe
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            return classify_and_export(f.read_bytes(), target)
        except Exception as e:
            return f"error:{type(e).__name__}"

    if args.workers > 1:
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=args.workers) as ex:
            for i, r in enumerate(ex.map(work, files), 1):
                stat[r] += 1
                if i % 5000 == 0:
                    print(f"  {i}/{len(files)}")
    else:
        for i, item in enumerate(files, 1):
            stat[work(item)] += 1
            if i % 2000 == 0:
                print(f"  {i}/{len(files)}")

    print("导出完成:")
    for k, v in stat.most_common():
        print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
