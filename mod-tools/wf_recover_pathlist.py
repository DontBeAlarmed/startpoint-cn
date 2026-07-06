#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
从 FileReader 的哈希算法 + wf-extracted/.pathlist + 主数据表(ordermap) + voiceLines.json,
复原**下载包(production/) 与 bundle 包(APK 内 bundle.zip)** 每个加密哈希文件的原始逻辑路径。

哈希(pinball/asset/path/AssetPathTools.getHashedPath):
    规范化   = 把 [/\\]+ 合并成 /,去掉开头的 /
    文件名   = SHA1( 规范化(逻辑路径 + 扩展名) + SALT )
    存储位置 = 文件名[:2] / 文件名[2:]
  前缀 store 只决定文件夹,不进哈希:
    下载包 upload / medium_upload / android_upload
    bundle包 bundle / medium_bundle / small_bundle   (APK assets/bundle.zip 解出来的)

来源(按贡献):
  1. .pathlist   —— 提取工具留下的无扩展名逻辑路径清单(含 voice/words、故事表情等)。
  2. ordermap    —— 解密所有 .orderedmap 主表,提取单元格里的路径引用。
  3. voiceLines  —— D:\WF\角色语音\<code>\voiceLines.json 键 = character/<code>/voice/<key>.mp3。
  4. 同族交叉    —— 把某 key 的 (tail,ext) 套到同族所有 key。
  5. bundle 索引 —— bundle_<amf|encrypt|copy|compress|png|atf>.filelist(哈希命名的索引文件)直接命名。

每条命中都由 SHA1 精确校验(零误报)。

用法:
  python mod-tools/wf_recover_pathlist.py
  # 可选 --base <production目录> --bundle <bundle production目录> --pathlist ... --voice ... --out ...
输出(默认 mod-tools/):
  WF_PATHLIST_recovered.csv   store,hash_path,logical_path   (每个物理文件一行,含 bundle)
  WF_PATHLIST_recovered.txt   去重逻辑路径
  WF_PATHLIST_uncovered.csv   仍未复原的哈希
"""
from __future__ import annotations
import argparse, csv, hashlib, json, re, sys, collections
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import wf_mod_tool as core

SALT = "K6R9T9Hz22OpeIGEWB0ui6c6PYFQnJGy"
DL_STORES = ["upload", "medium_upload", "android_upload"]
BUNDLE_STORES = ["bundle", "medium_bundle", "small_bundle"]

EXTS = ["", ".png", ".mp3", ".orderedmap", ".atf.deflate", ".amf3.deflate",
        ".frame.amf3.deflate", ".movie.amf3.deflate", ".timeline.amf3.deflate",
        ".parts.amf3.deflate", ".atlas.amf3.deflate", ".layout.amf3.deflate",
        ".action.dsl.amf3.deflate", ".esdl.amf3.deflate", ".ui.amf3.deflate",
        ".gacha.amf3.deflate", ".battle.amf3.deflate", ".ball.amf3.deflate",
        ".terrain.amf3.deflate", ".html.deflate", ".xml.deflate", ".css.deflate",
        ".battle.json"]
TEMPLATES = {"$/g", "$1/$2", "$1/hash/$2.hash", "$1/sprite_sheet"}
PATHISH = re.compile(r"^[a-z][a-z0-9_]*(?:/[a-z0-9_$.\-]+)+$")


def nh(p: str) -> str:
    p = re.sub(r"[/\\]+", "/", p)
    p = re.sub(r"^/", "", p)
    d = hashlib.sha1((p + SALT).encode("utf-8")).hexdigest()
    return d[:2] + "/" + d[2:]


def scan_stores(root: Path, stores: list[str], present: dict, loc2file: dict) -> None:
    for name in stores:
        s = present.setdefault(name, set())
        st = root / name
        if not st.exists():
            continue
        for d in st.iterdir():
            if d.is_dir() and len(d.name) == 2:
                for fp in d.iterdir():
                    if ".bak" not in fp.name:
                        loc = d.name + "/" + fp.name
                        s.add(loc)
                        loc2file[(name, loc)] = fp


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", help="下载包 production 目录(不填自动查找)")
    ap.add_argument("--bundle", default=r"D:\WF\wf-bundle\production",
                    help="bundle 包 production 目录(APK bundle.zip 解出);不存在则跳过")
    ap.add_argument("--pathlist", default=r"D:\WF\wf-extracted\wf-extracted\.pathlist")
    ap.add_argument("--voice", default=r"D:\WF\角色语音")
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent))
    args = ap.parse_args()

    if args.base:
        base = Path(args.base)
    else:
        up = core.find_world_upload(Path(__file__).resolve().parent.parent)
        if not up:
            print("未找到 production,请用 --base 指定"); sys.exit(1)
        base = up.parent
    out = Path(args.out)

    present: dict[str, set] = {}
    loc2file: dict = {}
    scan_stores(base, DL_STORES, present, loc2file)
    bundle_root = Path(args.bundle)
    have_bundle = bundle_root.exists()
    if have_bundle:
        scan_stores(bundle_root, BUNDLE_STORES, present, loc2file)
    allhash = set()
    for s in present.values():
        allhash |= s
    print("stores:", {k: len(v) for k, v in present.items()}, "unique hashes", len(allhash))

    found: dict[str, str] = {}   # loc(hash) -> logical(with ext)

    def mark(cand: str) -> bool:
        loc = nh(cand)
        if loc in allhash and loc not in found:
            found[loc] = cand
            return True
        return loc in allhash

    # ---- 0. bundle 索引文件(哈希命名)直接命名 ----
    if have_bundle:
        for pre in ("bundle", "ios_bundle"):
            for cat in ("amf", "encrypt", "copy", "compress", "png", "atf"):
                name = f"{pre}_{cat}.filelist"
                loc = nh(name)
                if loc in allhash:
                    found[loc] = name

    # ---- 1. .pathlist ----
    lines = Path(args.pathlist).read_text(encoding="utf-8", errors="replace").split("\n")
    uniq = sorted(set(l for l in lines if l != ""))
    slash = [l for l in uniq if l.startswith("/") and l not in TEMPLATES]
    full = [l for l in uniq if not l.startswith("/") and l not in TEMPLATES]
    for l in slash:
        mark("master" + l + ".orderedmap")
    for l in full:
        for e in EXTS:
            mark(l + e)
        mark("master/" + l + ".orderedmap")
    print(f"[1] pathlist       : {len(found)}/{len(allhash)} = {len(found)*100//len(allhash)}%")

    # ---- 2. ordermap 单元格路径 ----
    cell_paths = set()
    seen_files = set()
    total_files = len(loc2file)
    for scanned, ((_, loc), fp) in enumerate(loc2file.items(), 1):
        if scanned % 20000 == 0:
            print(f"  扫描 orderedmap {scanned}/{total_files}", flush=True)
        if loc in seen_files:
            continue
        seen_files.add(loc)
        try:
            raw = fp.read_bytes()
            if len(raw) < 8 or raw[4] != 0x78:
                continue
            om = core.read_orderedmap_file_from_bytes(raw)
        except Exception:
            continue
        for key, text in om.items():
            if PATHISH.match(key):
                cell_paths.add(key)
            if not text:
                continue
            for cell in core.read_csv_lines(text):
                for v in cell:
                    if 2 < len(v) < 90 and PATHISH.match(v):
                        cell_paths.add(v)
    for p in cell_paths:
        for e in EXTS:
            mark(p + e)
        mark("master/" + p + ".orderedmap")
    print(f"[2] ordermap cells : {len(found)}/{len(allhash)} = {len(found)*100//len(allhash)}%  (cells {len(cell_paths)})")

    # ---- 3. voiceLines.json ----
    vd = Path(args.voice)
    if vd.exists():
        for cd in vd.iterdir():
            vf = cd / "voiceLines.json"
            if not vf.exists():
                continue
            try:
                data = json.loads(vf.read_text(encoding="utf-8", errors="replace"))
            except Exception:
                continue
            for k in data:
                mark(f"character/{cd.name}/voice/{k}.mp3")
    print(f"[3] voiceLines     : {len(found)}/{len(allhash)} = {len(found)*100//len(allhash)}%")

    # ---- 4. 同族交叉 ----
    fam_keys = collections.defaultdict(set)
    fam_tail_ext = collections.defaultdict(lambda: collections.defaultdict(set))
    for cand in list(found.values()):
        if cand.startswith("master/") or "/" not in cand:
            continue
        m = re.search(r"(\.[a-z0-9.]+)$", cand)
        ext = m.group(1) if m else ""
        stem = cand[:len(cand) - len(ext)] if ext else cand
        parts = stem.split("/")
        if len(parts) >= 2:
            fam_keys[parts[0]].add(parts[1])
            fam_tail_ext[parts[0]]["/".join(parts[2:])].add(ext)
    for fam, tails in fam_tail_ext.items():
        keys = list(fam_keys[fam])
        for tail, exts in tails.items():
            for key in keys:
                stem = fam + "/" + key + ("/" + tail if tail else "")
                for e in exts:
                    mark(stem + e)
    print(f"[4] family cross   : {len(found)}/{len(allhash)} = {len(found)*100//len(allhash)}%")

    # ---- 输出:每个物理文件一行(含 bundle 各 store) ----
    rows = []
    for store, locs in present.items():
        for loc in locs:
            rows.append((store, loc, found.get(loc, "")))
    rows.sort(key=lambda r: (r[0], r[1]))
    with (out / "WF_PATHLIST_recovered.csv").open("w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh); w.writerow(["store", "hash_path", "logical_path"]); w.writerows(rows)
    uniqpaths = sorted(set(r[2] for r in rows if r[2]))
    (out / "WF_PATHLIST_recovered.txt").write_text("\n".join(uniqpaths) + "\n", encoding="utf-8")
    with (out / "WF_PATHLIST_uncovered.csv").open("w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh); w.writerow(["store", "hash_path"])
        for store, locs in sorted(present.items()):
            for loc in sorted(locs):
                if loc not in found:
                    w.writerow([store, loc])

    total = len(allhash)
    named = len(found)
    print(f"\n复原 {named}/{total} ({named*100/total:.1f}%) · 唯一路径 {len(uniqpaths)}")
    for store in DL_STORES + (BUNDLE_STORES if have_bundle else []):
        locs = present.get(store, set())
        if not locs:
            continue
        c = sum(1 for loc in locs if loc in found)
        print(f"  {store:15} {c}/{len(locs)}  未复原 {len(locs)-c}")
    print("输出 ->", out)


if __name__ == "__main__":
    main()
