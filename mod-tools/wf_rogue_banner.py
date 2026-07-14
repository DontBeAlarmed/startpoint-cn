#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""wf_rogue_banner.py — 给 700099「深渊连战」换专属横幅。

输入任意尺寸 PNG/JPG,自动缩放到官方规格,混淆编码写入 store 新逻辑路径,
改 rush_event 行横幅列,加入 pending,可顺带发布。

  主横幅  → 1000×184  quest/event/banner/rush_event/mod_rogue_gauntlet_banner_001
            (rush_event c3 三个轮播位全部指向它)
  boss横幅 → 377×199  quest/event/bossbattle_banner/rush_event/mod_rogue_gauntlet_bossbattle_banner_001
            (rush_event c4 第一位,其余 (None))

用法(项目根,默认 dry-run):
  python mod-tools/wf_rogue_banner.py --main 主图.png [--boss boss图.png] --write --publish
生效:发布后重启游戏(客户端增量下载新图;②层改动,服务端无需重启)。
"""
import argparse
import csv
import io
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "mod-tools"))
import wf_assets as wa            # noqa: E402
import wf_mod_tool as core        # noqa: E402
import wf_quest_lib as q          # noqa: E402

from PIL import Image             # noqa: E402

EVENT_ID = "700099"
Q_EVENT = "master/quest/event/rush_event.orderedmap"
MAIN_LOGICAL = "quest/event/banner/rush_event/mod_rogue_gauntlet_banner_001.png"
BOSS_LOGICAL = "quest/event/bossbattle_banner/rush_event/mod_rogue_gauntlet_bossbattle_banner_001.png"
MAIN_SIZE = (1000, 184)
BOSS_SIZE = (377, 199)
PENDING = os.path.join(ROOT, "mod-tools", "work", "sync_pending.json")


def fit_png(src: str, size: tuple[int, int]) -> bytes:
    img = Image.open(src).convert("RGBA")
    if img.size != size:
        img = img.resize(size, Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def add_pending(rel: str) -> None:
    items = []
    if os.path.exists(PENDING):
        with open(PENDING, encoding="utf-8") as fh:
            items = json.load(fh)
    if rel not in items:
        items.append(rel)
    os.makedirs(os.path.dirname(PENDING), exist_ok=True)
    with open(PENDING, "w", encoding="utf-8") as fh:
        json.dump(items, fh, indent=2)


def write_store(store, logical: str, raw_png: bytes) -> str:
    """混淆编码写 store(upload 根),返回 pending 用的 hashed rel(xx/hash)。

    哈希按**含 .png 的逻辑路径**计算(与 wf_assets.locate 一致);
    rush_event 行里引用时**不带扩展名**(客户端解析时自行补 .png)。
    """
    rel = q.hashed_rel(logical)
    dst = store.joinpath(*rel.split("/"))
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(wa.png_encode(raw_png))
    return rel


def main() -> int:
    ap = argparse.ArgumentParser(description="深渊连战专属横幅")
    ap.add_argument("--main", required=True, help="主横幅图片(任意尺寸,自动缩放 1000×184)")
    ap.add_argument("--boss", help="boss 入口横幅(可选,自动缩放 377×199)")
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--publish", action="store_true")
    args = ap.parse_args()

    store = core.resolve_profile(None).store

    for src in [args.main] + ([args.boss] if args.boss else []):
        if not os.path.exists(src):
            print(f"[ERR] 找不到文件: {src}")
            return 1

    main_png = fit_png(args.main, MAIN_SIZE)
    print(f"主横幅: {args.main} -> {MAIN_SIZE[0]}x{MAIN_SIZE[1]} ({len(main_png)}B) -> {MAIN_LOGICAL}")
    boss_png = None
    if args.boss:
        boss_png = fit_png(args.boss, BOSS_SIZE)
        print(f"boss横幅: {args.boss} -> {BOSS_SIZE[0]}x{BOSS_SIZE[1]} ({len(boss_png)}B) -> {BOSS_LOGICAL}")

    # rush_event 行横幅列
    ev = q.load_table(Q_EVENT)
    leaf = ev[EVENT_ID]
    was_bytes = isinstance(leaf, bytes)
    row = next(csv.reader(io.StringIO(leaf.decode("utf-8") if was_bytes else leaf)))
    main_noext = MAIN_LOGICAL[:-4]
    print(f"c3: {row[3][:60]}... -> {main_noext} ×3")
    row[3] = ",".join([main_noext] * 3)
    if boss_png is not None:
        boss_noext = BOSS_LOGICAL[:-4]
        print(f"c4: {row[4][:60]}... -> {boss_noext},(None),(None)")
        row[4] = ",".join([boss_noext, "(None)", "(None)"])

    if not args.write:
        print("[DRY-RUN] 未写入。加 --write 生效,--publish 顺带发 CDN。")
        return 0

    rels = [write_store(store, MAIN_LOGICAL, main_png)]
    if boss_png is not None:
        rels.append(write_store(store, BOSS_LOGICAL, boss_png))
    buf = io.StringIO()
    csv.writer(buf, lineterminator="").writerow(row)
    ev[EVENT_ID] = buf.getvalue().encode("utf-8") if was_bytes else buf.getvalue()
    table_path = q.save_table(Q_EVENT, ev)
    rels.append(os.path.relpath(table_path, store).replace(os.sep, "/"))
    for rel in rels:
        add_pending(rel)
    print(f"[OK] 写入 {len(rels)} 个文件并加入 pending: {rels}")

    if args.publish:
        import subprocess
        r = subprocess.run([sys.executable, os.path.join(ROOT, "mod-tools", "wf_publish.py")], cwd=ROOT)
        print(f"[PUBLISH] wf_publish 退出码 {r.returncode}")
    else:
        print("记得发布:python mod-tools/wf_publish.py(走 pending)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
