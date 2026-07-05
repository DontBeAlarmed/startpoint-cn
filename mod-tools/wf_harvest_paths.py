#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
从反编译源码 + 主数据表,抓取数据包解密所需的**原始逻辑路径**(.filelist 丢失时的替代)。

哈希逻辑(AssetPathTools.getHashedPath,已核实):
  规范化 = [/\\]+ -> /,去掉开头 /
  文件   = SHA1(规范化(路径+扩展名) + 盐)  -> hash[:2]/hash[2:]
  目录前缀 medium_/small_/android_ 只决定去哪个 store 文件夹找,不进哈希。

三类来源:
  A. 源码里的完整路径字面量(scene/bgm/battle 等)
  B. 拼接模板 "<prefix>/" + <变量> + "<tail>",变量= 角色 code_name / 数字 ID
  C. 主数据表单元格里的路径引用

对每个候选,拼 12 种扩展名 × 3 个 store(upload/medium_upload/android_upload)撞库。

用法(本地全量):
  python mod-tools/wf_harvest_paths.py ^
    --src decompile/scripts ^
    --base 弹国服/WorldFlipper/dummy/download/production ^
    --out mod-tools/HarvestedPaths.csv
"""
from __future__ import annotations
import argparse
import csv
import hashlib
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import wf_mod_tool as core

SALT = "K6R9T9Hz22OpeIGEWB0ui6c6PYFQnJGy"
STORES = ["upload", "medium_upload", "android_upload"]
EXTS = ["", ".png", ".mp3", ".orderedmap",
        ".amf3.deflate", ".frame.amf3.deflate", ".movie.amf3.deflate",
        ".timeline.amf3.deflate", ".layout.amf3.deflate", ".atlas.amf3.deflate",
        ".html.deflate", ".xml.deflate", ".css.deflate"]
LIT_RE = re.compile(r'"([a-z][a-z0-9_/]{2,90})"')
# "prefix/" + var + "tail"  形式
CONCAT_RE = re.compile(r'"([a-z][a-z0-9_/]*/)"\s*\+\s*\w+\s*\+\s*"([/a-z0-9_][a-z0-9_/]*)"')
# "prefix/" + var  (无尾)
CONCAT2_RE = re.compile(r'"([a-z][a-z0-9_/]*/)"\s*\+\s*\w+')


def normhash(p: str) -> str:
    p = re.sub(r"[/\\]+", "/", p)
    p = re.sub(r"^/", "", p)
    h = hashlib.sha1((p + SALT).encode("utf-8")).hexdigest()
    return h[:2] + "/" + h[2:]


def build_present(base: Path) -> dict[str, set[str]]:
    out = {}
    for name in STORES:
        store = base / name
        s = set()
        if store.exists():
            for d in store.iterdir():
                if d.is_dir() and len(d.name) == 2:
                    for f in d.iterdir():
                        if ".bak" not in f.name:
                            s.add(d.name + "/" + f.name)
        out[name] = s
    return out


def read_source(src: Path):
    literals, prefixes, tails = set(), set(), set()
    for f in src.rglob("*.as"):
        try:
            text = f.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        for m in LIT_RE.finditer(text):
            literals.add(m.group(1))
        for pre, tail in CONCAT_RE.findall(text):
            prefixes.add(pre)
            tails.add(tail if tail.startswith("/") else "/" + tail)
        for pre in CONCAT2_RE.findall(text):
            prefixes.add(pre)
    return literals, prefixes, tails


def read_enumerators(base: Path):
    """code_name(角色) + 全部数字 ID(所有表首列/键)。"""
    codes, ids = set(), set()
    upload = base / "upload"
    ch = core.table_path(upload, core.CHARACTER_LOGICAL)
    try:
        ct = core.read_orderedmap_file(ch, core.CHARACTER_LOGICAL)
        for t in ct.text_rows().values():
            rows = core.read_csv_lines(t)
            if rows and rows[0] and rows[0][0]:
                codes.add(rows[0][0])
            if rows and rows[0] and len(rows[0]) > 17 and rows[0][17].isdigit():
                ids.add(rows[0][17])
    except Exception:
        pass
    return codes, ids


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="decompile/scripts")
    ap.add_argument("--base", help="production 目录(不填则自动查找)")
    ap.add_argument("--out", default="mod-tools/HarvestedPaths.csv")
    ap.add_argument("--limit-codes", type=int, default=0, help="调试:只用前N个code_name")
    args = ap.parse_args()

    src = Path(args.src)
    if args.base:
        base = Path(args.base)
    else:
        upload = core.find_world_upload(Path(__file__).resolve().parent.parent)
        if not upload:
            print("未找到数据包(WorldFlipper/dummy/.../upload),请用 --base 指定 production 目录")
            sys.exit(1)
        base = upload.parent  # production/
    print(f"数据包 production: {base}")
    present = build_present(base)
    total_files = sum(len(s) for s in present.values())
    print("store 文件:", {k: len(v) for k, v in present.items()})

    literals, prefixes, tails = read_source(src)
    codes, ids = read_enumerators(base)
    if args.limit_codes:
        codes = set(list(codes)[:args.limit_codes])
    print(f"字面量 {len(literals)} · 前缀模板 {len(prefixes)} · 尾串 {len(tails)} · "
          f"code_name {len(codes)} · ID {len(ids)}")

    found: dict[str, str] = {}

    def probe(path: str):
        loc = normhash(path)
        for name, s in present.items():
            if loc in s:
                found[path] = f"{name}/{loc}"
                return

    # A. 直接字面量
    for s in literals:
        for e in EXTS:
            probe(s + e)
    print(f"A 字面量: 命中 {len(found)}")

    # B. 模板 × 枚举
    variables = list(codes) + list(ids)
    tails_all = list(tails) + [""]
    for pre in prefixes:
        for var in variables:
            for tail in tails_all:
                for e in EXTS:
                    probe(f"{pre}{var}{tail}{e}")
    print(f"B 模板×枚举: 命中 {len(found)}")

    # C. 主数据表单元格里的路径引用
    upload = base / "upload"
    scanned = 0
    for d in upload.iterdir():
        if not (d.is_dir() and len(d.name) == 2):
            continue
        for f in d.iterdir():
            if ".bak" in f.name:
                continue
            try:
                om = core.read_orderedmap_file_from_bytes(f.read_bytes())
            except Exception:
                continue
            scanned += 1
            for t in om.values():
                for cell in core.read_csv_lines(t):
                    for v in cell:
                        if "/" in v and " " not in v and 2 < len(v) < 90 \
                                and not v.startswith("http") and re.match(r"[a-z]", v):
                            for e in EXTS:
                                probe(v + e)
    print(f"C 表内引用(扫描 {scanned} 表): 命中 {len(found)}")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(["逻辑路径", "存储位置(含store)"])
        for p, loc in sorted(found.items()):
            w.writerow([p, loc])
    print(f"合计命中 {len(found)} / {total_files} 文件 ({len(found)*100//max(1,total_files)}%) -> {out}")


if __name__ == "__main__":
    main()
