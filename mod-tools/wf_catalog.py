#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
数据表内容目录:扫描 production/upload,把所有能解析成 orderedmap 的数据表
(不管有没有已知逻辑路径)编成 DataCatalog.csv。

可续跑:每次处理若干个两位十六进制目录,进度记录在 work/catalog_state.json,
反复运行直到打印 ALL DONE。规避单次超时。

用法:
  python mod-tools/wf_catalog.py            # 处理下一批(默认16个目录)
  python mod-tools/wf_catalog.py --batch 32
  python mod-tools/wf_catalog.py --reset    # 重新开始
"""
from __future__ import annotations
import argparse
import csv
import json
import sys
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import wf_mod_tool as core

HEX = [f"{i:02x}" for i in range(256)]
WORK = Path(__file__).resolve().parent / "work"
STATE = WORK / "catalog_state.json"
OUT = Path(__file__).resolve().parent / "DataCatalog.csv"


def load_named() -> dict[str, str]:
    """已知 逻辑路径→存储位置 反表(存储位置 -> 逻辑路径)。"""
    loc2name: dict[str, str] = {}
    pl = Path(__file__).resolve().parent / "PathList.csv"
    if pl.exists():
        with pl.open(encoding="utf-8-sig") as fh:
            for row in csv.DictReader(fh):
                loc = row.get("存储位置") or row.get("存储位置(hash)")
                if loc:
                    loc2name[loc] = row["逻辑路径"]
    return loc2name


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--store")
    ap.add_argument("--reset", action="store_true")
    args = ap.parse_args()

    store = Path(args.store) if args.store else core.find_world_upload(
        Path(__file__).resolve().parent.parent)
    WORK.mkdir(parents=True, exist_ok=True)

    if args.reset or not STATE.exists():
        state = {"done": [], "total": 0, "om": 0}
        if OUT.exists():
            OUT.unlink()
    else:
        state = json.loads(STATE.read_text())

    loc2name = load_named()
    todo = [h for h in HEX if h not in state["done"]][:args.batch]
    if not todo:
        print(f"ALL DONE  总文件 {state['total']}  数据表 {state['om']}  -> {OUT}")
        return

    write_header = not OUT.exists()
    with OUT.open("a", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        if write_header:
            w.writerow(["存储位置", "逻辑路径(已知)", "键数", "前3键", "首行样本"])
        for h in todo:
            d = store / h
            if not d.is_dir():
                state["done"].append(h)
                continue
            for f in d.iterdir():
                if ".bak" in f.name:
                    continue
                state["total"] += 1
                try:
                    raw = f.read_bytes()
                    if len(raw) < 8:
                        continue
                    keys, pairs, il = core.parse_index(raw)
                except Exception:
                    continue
                if not keys:
                    continue
                state["om"] += 1
                loc = f"{h}/{f.name}"
                sample = ""
                try:
                    blob = raw[4 + il:]
                    first = blob[:pairs[0][1]] if pairs else b""
                    if first:
                        sample = zlib.decompress(first).decode("utf-8", "replace")[:50]
                        sample = sample.replace("\n", " ").replace("\r", "")
                except Exception:
                    pass
                w.writerow([loc, loc2name.get(loc, ""), len(keys),
                            ",".join(keys[:3]), sample])
            state["done"].append(h)

    STATE.write_text(json.dumps(state))
    print(f"batch done  已处理目录 {len(state['done'])}/256  "
          f"累计文件 {state['total']}  数据表 {state['om']}")


if __name__ == "__main__":
    main()
