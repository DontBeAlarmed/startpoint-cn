#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
WF 数据包**完全解密导出器** —— 按客户端逻辑解密/解码 **下载包(production/) + bundle 包**
每一个哈希文件,还原成真实资产,并用复原的逻辑路径建成目录树。

覆盖 store(6 个):
  下载包 upload / medium_upload / android_upload      (root = 弹国服/.../download/production)
  bundle包 bundle / medium_bundle / small_bundle        (root = wf-bundle/production, 来自 APK assets/bundle.zip)

已逆向的内容混淆(fileFaker.converter / FileReader):
  1. orderedmap 数据表           -> .csv
  2. 混淆 PNG(头 3 字节 +0x20)  -> .png
  3. MP3(明文 ID3 / 首字节 0xff->0x7f)-> .mp3
  4. AMF3(zlib,可含 4 字节长度前缀)-> .json  (timeline/frame/movie/parts/atlas/ui/action.dsl...)
  5. OGG / HTML / XML / CSS / JPEG / ATF / 其它 -> 对应后缀

文件名来自 WF_PATHLIST_recovered.csv(哈希->逻辑路径,SHA1 校验过);未复原的进 _unnamed/<store>/<hash>。
输出目录树保留逻辑路径,内容后缀按解码结果(x.timeline.amf3.deflate -> x.timeline.json)。

用法:
  python mod-tools/wf_export_assets.py --out D:\WF\wf-decrypted --workers 16
  python mod-tools/wf_export_assets.py --limit 300           # 小样验证
  python mod-tools/wf_export_assets.py --only-bundle         # 只导 bundle 包
"""
from __future__ import annotations
import argparse, csv, json, sys, zlib
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import wf_mod_tool as core

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
DL_STORES = ["upload", "medium_upload", "android_upload"]
BUNDLE_STORES = ["bundle", "medium_bundle", "small_bundle"]


def deobf_png(raw: bytes):
    if len(raw) < 8 or raw[0] != 0x89:
        return None
    fixed = bytearray(raw)
    for i in (1, 2, 3):
        fixed[i] = (fixed[i] - 0x20) & 0xFF
    return bytes(fixed) if bytes(fixed[:8]) == PNG_MAGIC else None


def deobf_mp3(raw: bytes):
    if len(raw) > 4 and raw[0] == 0x7F and (raw[1] & 0xE0) == 0xE0:
        return b"\xff" + raw[1:]
    return None


def try_inflate(raw: bytes):
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


def decode(raw: bytes):
    """返回 (ext, data_bytes)。ext 是最终真实后缀(含点)。"""
    # 1) orderedmap 表 -> csv
    try:
        keys, _, _ = core.parse_index(raw)
        if keys:
            om = core.read_orderedmap_file_from_bytes(raw)
            import io
            sio = io.StringIO()
            w = csv.writer(sio)
            for k, t in om.items():
                lines = core.read_csv_lines(t)
                if not lines:
                    w.writerow([k])
                for line in lines:
                    w.writerow([k] + line)
            return ".csv", sio.getvalue().encode("utf-8-sig")
    except Exception:
        pass
    # 2) MP3
    if raw[:3] == b"ID3" or raw[:2] == b"\xff\xfb":
        return ".mp3", raw
    mp3 = deobf_mp3(raw)
    if mp3:
        return ".mp3", mp3
    # 3) OGG
    if raw[:4] == b"OggS":
        return ".ogg", raw
    # 4) PNG / JPEG
    png = deobf_png(raw)
    if png:
        return ".png", png
    if raw[:8] == PNG_MAGIC:
        return ".png", raw
    if raw[:3] == b"\xff\xd8\xff":
        return ".jpg", raw
    # 5) zlib(AMF3 / 内嵌PNG / HTML / XML / CSS / ATF...)
    dec = try_inflate(raw)
    if dec is not None:
        png = deobf_png(dec)
        if png:
            return ".png", png
        if dec[:8] == PNG_MAGIC:
            return ".png", dec
        head = dec[:32].lstrip().lower()
        if head[:9] == b"<!doctype" or head[:5] == b"<html":
            return ".html", dec
        if head[:5] == b"<?xml" or head[:6] == b"<font>":
            return ".xml", dec
        if dec[:3] == b"ATF":
            return ".atf", dec
        try:
            obj = core.AMF3Reader(dec).read_value()
        except Exception:
            obj = None
        if obj is not None:
            return ".json", json.dumps(jsonable(obj), ensure_ascii=False, indent=1).encode("utf-8")
        return ".bin", dec
    # 6) 兜底
    return ".bin", raw


def strip_container(name: str) -> str:
    for suf in (".amf3.deflate", ".deflate"):
        if name.endswith(suf):
            return name[:-len(suf)]
    if name.endswith(".orderedmap"):
        return name[:-len(".orderedmap")]
    return name


def load_names(mod_dir: Path):
    loc2name = {}
    rec = mod_dir / "WF_PATHLIST_recovered.csv"
    if rec.exists():
        with rec.open(encoding="utf-8-sig") as fh:
            for row in csv.DictReader(fh):
                loc = row.get("hash_path"); name = row.get("logical_path")
                if loc and name:
                    loc2name.setdefault(loc, name)
    return loc2name


def collect(root: Path, stores):
    files = []
    for st in stores:
        d = root / st
        if not d.exists():
            continue
        for sub in sorted(d.iterdir()):
            if sub.is_dir() and len(sub.name) == 2:
                for f in sub.iterdir():
                    if ".bak" not in f.name:
                        files.append((st, sub.name + "/" + f.name, f))
    return files


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", help="下载包 production 目录(不填自动查找)")
    ap.add_argument("--bundle", default=r"D:\WF\wf-bundle\production")
    ap.add_argument("--out", default=r"D:\WF\wf-decrypted")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--only-bundle", action="store_true")
    ap.add_argument("--no-skip", action="store_true", help="不跳过已存在文件(默认跳过=可续跑)")
    args = ap.parse_args()

    mod_dir = Path(__file__).resolve().parent
    out = Path(args.out); out.mkdir(parents=True, exist_ok=True)
    loc2name = load_names(mod_dir)
    print("命名表:", len(loc2name), "条")

    files = []
    if not args.only_bundle:
        base = Path(args.base) if args.base else core.find_world_upload(mod_dir.parent).parent
        files += collect(base, DL_STORES)
    bundle_root = Path(args.bundle)
    if bundle_root.exists():
        files += collect(bundle_root, BUNDLE_STORES)
    if args.limit:
        files = files[:args.limit]
    print(f"待解密 {len(files)} 个文件 -> {out}")

    skip = not args.no_skip
    manifest = out / "_manifest.csv"
    stat = Counter()
    mrows = []

    def work(item):
        store, loc, f = item
        name = loc2name.get(loc)
        base_rel = strip_container(name) if name else f"_unnamed/{store}/{loc}"
        try:
            raw = f.read_bytes()
            ext, data = decode(raw)
            rel = base_rel if base_rel.endswith(ext) else base_rel + ext
            target = out / rel
            if not (skip and target.exists()):
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
            return ext.lstrip("."), (store, loc, name or "", rel)
        except Exception as e:
            return f"error:{type(e).__name__}", (store, loc, name or "", "")

    if args.workers > 1:
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=args.workers) as ex:
            for i, (kind, mrow) in enumerate(ex.map(work, files), 1):
                stat[kind] += 1; mrows.append(mrow)
                if i % 2000 == 0:
                    print(f"  {i}/{len(files)}", flush=True)
    else:
        for i, item in enumerate(files, 1):
            kind, mrow = work(item); stat[kind] += 1; mrows.append(mrow)
            if i % 2000 == 0:
                print(f"  {i}/{len(files)}", flush=True)

    with manifest.open("w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh); w.writerow(["store", "hash_path", "logical_path", "output_path"])
        w.writerows(sorted(mrows))
    print("解密完成:")
    for k, v in stat.most_common():
        print(f"  {k}: {v}")
    print("清单 ->", manifest)


if __name__ == "__main__":
    main()
