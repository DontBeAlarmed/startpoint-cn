#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
WF 单机版 · 客户端主数据定位器
==================================
用途:在"单机版手机数据包"的内容寻址资源库里,把 *加密假象* 的资源文件
解开(其实是 raw-DEFLATE 压缩,并非加密),并按解压后内容分类,
帮你定位角色 **数值/技能** 主数据表(HP/ATK 等基础数值就在这一层)。

关键事实(已逆向确认)
----------------------
* 资源库路径形如  .../production/android_upload/<xx>/<hash>  或  android_bundle/...
* 每个文件都是 **raw DEFLATE** 流(zlib.decompress(data, -15)),无加密、无密钥。
* 解开后可能是:ATF 贴图 / PNG / Ogg 音频 / 字体 XML / **orderedmap 主数据(二进制)**。
* 角色身份与文本词条在仓库里已解成 assets/cdndata/*.json;
  但 **基础数值表(character_status 等)** 需要在这一层里找。

用法
----
  # 扫描一个资源库目录,统计类型 + 列出"疑似主数据"候选
  python wf_scan_masterdata.py scan --store <资源库目录> [--limit 0]

  # 在库里搜索包含某些角色ID/关键字的文件(定位具体主数据表)
  python wf_scan_masterdata.py find --store <资源库目录> --needle 111002 --needle pirates_girl

  # 解开单个文件看内容
  python wf_scan_masterdata.py dump --file <单个hash文件> [--out out.bin]

资源库目录举例
--------------
  单机版数据包解压后的  WorldFlipper/dummy/download/production/android_upload
  或 APK 内 assets/bundle.zip 解压后的  production
"""
import argparse, os, zlib, sys, collections

WBITS = (-15, 15, 47)  # raw-deflate / zlib / gzip 都试


def inflate(data):
    for wb in WBITS:
        try:
            return zlib.decompress(data, wb)
        except Exception:
            continue
    return None  # 可能本来就是明文


def classify(raw):
    if raw is None:
        return "raw?", None
    h = raw[:16]
    if h[:3] == b"ATF":
        return "ATF贴图", None
    if h[:4] == b"\x89PNG":
        return "PNG", None
    if h[:4] == b"OggS":
        return "Ogg音频", None
    if h[:4] == b"RIFF":
        return "RIFF/WAV", None
    if h[:5] == b"<font":
        return "字体XML", None
    sample = raw[:400]
    printable = sum(1 for b in sample if 9 <= b <= 13 or 32 <= b <= 126)
    ratio = printable / max(1, len(sample))
    if ratio > 0.95:
        return "文本", raw[:120]
    # 疑似 orderedmap 主数据:二进制但含大量可见 ASCII 片段(字段名/ID)
    ascii_runs = sum(1 for b in raw[:2000] if 32 <= b <= 126)
    if ascii_runs / min(2000, max(1, len(raw))) > 0.35:
        return "疑似主数据(二进制含文本)", raw[:120]
    return "二进制", None


def walk(store):
    for r, _, fs in os.walk(store):
        for f in fs:
            yield os.path.join(r, f)


def cmd_scan(args):
    kinds = collections.Counter()
    cands = []
    n = 0
    for p in walk(args.store):
        n += 1
        if args.limit and n > args.limit:
            break
        try:
            data = open(p, "rb").read()
        except Exception:
            continue
        raw = inflate(data)
        kind, preview = classify(raw)
        kinds[kind] += 1
        if kind.startswith("疑似主数据") or kind == "文本":
            cands.append((len(raw or data), kind, p, preview))
    print(f"扫描 {n} 个文件,类型分布:")
    for k, v in kinds.most_common():
        print(f"  {v:>7}  {k}")
    print(f"\n候选主数据 / 文本文件 {len(cands)} 个(按解压大小倒序,取前 40):")
    for size, kind, p, preview in sorted(cands, reverse=True)[:40]:
        pv = (preview[:80] + b"...").decode("utf-8", "replace") if preview else ""
        print(f"  {size:>9}  {kind:<22}  {os.path.relpath(p, args.store)}  {pv}")


def cmd_find(args):
    needles = [n.encode("utf-8") if isinstance(n, str) else n for n in args.needle]
    hits = 0
    for p in walk(args.store):
        try:
            raw = inflate(open(p, "rb").read())
        except Exception:
            continue
        if raw is None:
            continue
        if all(nd in raw for nd in needles):
            hits += 1
            idx = raw.find(needles[0])
            ctx = raw[max(0, idx - 30): idx + 90].decode("utf-8", "replace")
            print(f"[命中] {os.path.relpath(p, args.store)}  ({len(raw)}B)")
            print(f"       ...{ctx}...")
    print(f"\n共 {hits} 个文件命中全部关键字。")


def cmd_dump(args):
    raw = inflate(open(args.file, "rb").read())
    if raw is None:
        sys.exit("无法解压(可能非 deflate)。")
    kind, _ = classify(raw)
    print(f"类型: {kind}, 解压大小: {len(raw)}")
    if args.out:
        open(args.out, "wb").write(raw)
        print(f"已写出: {args.out}")
    else:
        sys.stdout.buffer.write(raw[:1000])


def main():
    ap = argparse.ArgumentParser(description="WF 客户端主数据定位器")
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("scan", help="统计类型 + 列出候选主数据")
    s.add_argument("--store", required=True)
    s.add_argument("--limit", type=int, default=0, help="最多扫描文件数(0=全部)")
    s.set_defaults(func=cmd_scan)

    f = sub.add_parser("find", help="搜索包含关键字的文件")
    f.add_argument("--store", required=True)
    f.add_argument("--needle", action="append", required=True,
                   help="可多次给,需全部命中")
    f.set_defaults(func=cmd_find)

    d = sub.add_parser("dump", help="解开单个文件")
    d.add_argument("--file", required=True)
    d.add_argument("--out")
    d.set_defaults(func=cmd_dump)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
