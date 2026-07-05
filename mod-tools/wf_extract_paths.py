#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
从客户端 SWF/APK 的 ActionScript 字节码(ABC)**字符串常量池**里抽出资源逻辑路径,
再用 SHA1(path+SALT) 撞库匹配 production/upload 存储,生成 PathList。

优点:只解析常量池,不做完整反编译 —— 秒级完成,规避 FFDec 反编译超时。

用法:
  python mod-tools/wf_extract_paths.py <SWF或APK路径> [--store <upload目录>] [--out PathList.csv]

例:
  python mod-tools/wf_extract_paths.py 弹国服/wf_M358262.apk
  python mod-tools/wf_extract_paths.py wf-2.1.125.swf --store D:\WF\...\upload
"""
from __future__ import annotations
import argparse
import csv
import hashlib
import re
import struct
import sys
import zipfile
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import wf_mod_tool as core


def load_swf_body(path: Path) -> bytes:
    if path.suffix.lower() == ".apk" or zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as z:
            name = next((n for n in z.namelist()
                         if n.endswith(".swf") and "worldflipper" in n.lower()), None)
            if name is None:
                name = next(n for n in z.namelist() if n.endswith("_release.swf"))
            data = z.read(name)
    else:
        data = path.read_bytes()
    sig = data[:3]
    body = data[8:]
    if sig == b"CWS":
        return zlib.decompress(body)
    if sig == b"ZWS":
        import lzma
        return lzma.decompress(body[4:], format=lzma.FORMAT_ALONE)
    return body


def _u30(buf: bytes, p: int) -> tuple[int, int]:
    r = 0
    sh = 0
    for _ in range(5):
        x = buf[p]
        p += 1
        r |= (x & 0x7F) << sh
        sh += 7
        if not x & 0x80:
            break
    return r, p


def extract_strings(body: bytes) -> set[str]:
    pos = 0
    nbits = body[pos] >> 3
    pos += (5 + 4 * nbits + 7) // 8
    pos += 4  # framerate + framecount
    abcs = []
    while pos + 2 <= len(body):
        tc = struct.unpack_from("<H", body, pos)[0]
        pos += 2
        code = tc >> 6
        ln = tc & 0x3F
        if ln == 0x3F:
            ln = struct.unpack_from("<I", body, pos)[0]
            pos += 4
        if code == 82:  # DoABC
            abcs.append((pos, ln))
        if code == 0:
            break
        pos += ln
    out: set[str] = set()
    for off, ln in abcs:
        a = body[off:off + ln]
        p = 4
        while a[p] != 0:
            p += 1
        p += 1
        p += 4  # minor+major
        for _ in range(2):  # int, uint pools
            n, p = _u30(a, p)
            for _ in range(max(0, n - 1)):
                _, p = _u30(a, p)
        n, p = _u30(a, p)  # double pool
        p += 8 * max(0, n - 1)
        n, p = _u30(a, p)  # string pool
        for _ in range(max(0, n - 1)):
            sl, p = _u30(a, p)
            s = a[p:p + sl]
            p += sl
            try:
                out.add(s.decode("utf-8"))
            except Exception:
                pass
    return out


def _camel_to_snake(s: str) -> str:
    s = re.sub(r"(.)([A-Z][a-z]+)", r"\1_\2", s)
    return re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", s).lower()


def table_names_from_classlist(classlist: Path) -> set[str]:
    """从 ffdec -dumpAS3 的类清单里,把 pinball.master.generated.*Table 等类名反推为 snake_case 表名。"""
    names: set[str] = set()
    for line in classlist.read_text(encoding="utf-8", errors="ignore").splitlines():
        cls = line.split()[0] if line.split() else ""
        if "pinball.master.generated." not in cls:
            continue
        leaf = cls.split(".")[-1]
        for suf in ("Table", "Values", "Data"):
            if leaf.endswith(suf):
                leaf = leaf[:-len(suf)]
        names.add(_camel_to_snake(leaf))
    return names


def match_paths(strings: set[str], store: Path, extra_names: set[str] | None = None) -> dict[str, str]:
    salt = core.SALT
    present = set()
    for d in store.iterdir():
        if d.is_dir() and len(d.name) == 2:
            for f in d.iterdir():
                if ".bak" not in f.name:
                    present.add(d.name + f.name)

    idents = set(s for s in strings if re.fullmatch(r"[a-z][a-z0-9_]{2,44}", s))
    if extra_names:
        idents |= extra_names
    idents = sorted(idents)
    found: dict[str, str] = {}

    def try_path(lp: str):
        h = hashlib.sha1((lp + salt).encode()).hexdigest()
        if h in present:
            found[lp] = h[:2] + "/" + h[2:]

    # 1) dir == name(最常见)
    for n in idents:
        try_path(f"master/{n}/{n}.orderedmap")
        try_path(f"master/{n}/{n}.csv")
    # 2) 已发现目录 × 全部标识符
    dirs = {lp.split("/")[1] for lp in found}
    dirs |= {"ability", "character", "equipment", "item", "quest", "gacha", "mana_board",
             "enemy", "mission", "degree", "skill", "party", "shop", "story", "event",
             "config", "player", "condition", "buff"}
    for dd in dirs:
        for n in idents:
            try_path(f"master/{dd}/{n}.orderedmap")
    return found


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("swf", help="SWF 或 APK 路径")
    ap.add_argument("--store", help="production/upload 目录(默认自动找)")
    ap.add_argument("--out", default="mod-tools/PathList.csv")
    ap.add_argument("--classlist", help="ffdec -dumpAS3 输出的类清单(可选,大幅提升命中)")
    args = ap.parse_args()

    body = load_swf_body(Path(args.swf))
    strings = extract_strings(body)
    print(f"常量池字符串: {len(strings)}")

    extra = None
    if args.classlist and Path(args.classlist).exists():
        extra = table_names_from_classlist(Path(args.classlist))
        print(f"类名反推表名: {len(extra)}")
        print("  (生成类清单: java -jar ffdec.jar -dumpAS3 wf.swf > classlist.txt)")

    store = Path(args.store) if args.store else core.find_world_upload(
        Path(__file__).resolve().parent.parent)
    if not store or not store.exists():
        print("未找到 upload 存储,用 --store 指定")
        sys.exit(1)

    found = match_paths(strings, store, extra)
    print(f"匹配到 {len(found)} 张表")

    rows = []
    for lp, loc in sorted(found.items()):
        keys = sample = ""
        try:
            om = core.read_orderedmap_file(store / loc, lp)
            keys = len(om.keys)
            tr = om.text_rows()
            sample = (tr.get(om.keys[0], "") or "")[:60].replace("\n", " ")
        except Exception:
            pass
        rows.append((lp, loc, keys, sample))

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(["逻辑路径", "存储位置", "键数", "首行样本"])
        for r in rows:
            w.writerow(r)
    print(f"已写出 {out}")


if __name__ == "__main__":
    main()
