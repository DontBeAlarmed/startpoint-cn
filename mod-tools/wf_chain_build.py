# -*- coding: utf-8 -*-
"""wf_chain_build — boss 连战塔(floor 多层链)生成器。

机制:Tower 类 quest(挑战迷宫/幽玄域/摇曳的迷宫)的 tower_floor_id 指向
master/battle/floor 表键;键下 **单 zlib chunk 内每行 = 一层**(field_data,bgm前缀,缩略图),
层间 changeToNextFloor 无结算直接连打,HP/状态跨层保留,最后一层才结算。
(嵌套 orderedmap 是 zone/quest 系 getMap 的格式,floor 用了会 F2058 崩溃!)

素材池 = 官方 floor 表里所有带 boss 的层行(深层域/幽玄域/宝物域,实战验证过的
field+BGM+缩略图三元组),当前 160+ 行、80+ 种 boss。

用法:
    python mod-tools/wf_chain_build.py                     # 预览:今天种子,5 层
    python mod-tools/wf_chain_build.py --floors 8 --seed 42
    python mod-tools/wf_chain_build.py --write             # 写入 floor 表
    python mod-tools/wf_chain_build.py --write --publish   # 写入并发布 CDN
    python mod-tools/wf_chain_build.py --list-pool         # 看素材池

默认宿主 quest = 摇曳的迷宫 宝物域【暗】(challenge_dungeon 2001,
其 tower_floor_id 已指向 mod_chain_canary 键;换 quest 用 --key 配合手改 quest 表)。
每日随机:定时跑 `--write --publish`(种子默认取当天日期,同一天重跑结果一致)。
"""
from __future__ import annotations

import argparse
import csv
import datetime as _dt
import io
import random
import subprocess
import sys
from pathlib import Path

MOD_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(MOD_DIR))
import wf_quest_lib as q  # noqa: E402

FLOOR_T = "master/battle/floor.orderedmap"
FD_T = "master/battle/field_data.orderedmap"
ZONE_T = "master/battle/zone.orderedmap"

DEFAULT_KEY = "mod_chain_canary"


def _cols(row: str) -> list[str]:
    return next(csv.reader(io.StringIO(row)))


def build_pool():
    """官方 floor 行 → [(field_data_key, 原始层行, [boss codes])],按 field_data 去重。"""
    floor = q.load_table(FLOOR_T)
    fd = q.load_table(FD_T)
    zone = q.load_table(ZONE_T)
    pool, seen = [], set()
    for fkey, v in floor.items():
        if fkey == DEFAULT_KEY or not isinstance(v, str):
            continue
        for ln in v.split("\n"):
            c = _cols(ln)
            if len(c) < 3 or c[0] in seen:
                continue
            frow = fd.get(c[0])
            if not frow:
                continue
            zkey = _cols(frow)[2]
            zn = zone.get(zkey)
            if not isinstance(zn, dict):
                continue
            bosses = []
            for wrow in zn.values():
                wc = _cols(wrow)
                bosses += [wc[i + 1] for i in range(23, min(35, len(wc)), 2)
                           if wc[i] not in ("(None)", "")]
            if bosses:
                seen.add(c[0])
                pool.append((c[0], ln, sorted(set(bosses))))
    return pool


def main() -> None:
    ap = argparse.ArgumentParser(description="boss 连战塔生成器")
    ap.add_argument("--floors", type=int, default=5, help="层数(默认 5)")
    ap.add_argument("--pool", type=int, default=0, metavar="K",
                    help="⚠ 每次进本随机模式:写「__random__,K 头行 + 全池」,客户端每次抽 K 层。"
                         "必须先给所有客户端打 client-patch/random-floor 补丁,否则进本即崩!")
    ap.add_argument("--pool-size", type=int, default=0,
                    help="pool 模式候选层数上限(默认全池;配合 --seed 抽子集)")
    ap.add_argument("--seed", default=None,
                    help="随机种子(默认当天日期 YYYYMMDD,同天重跑结果一致)")
    ap.add_argument("--key", default=DEFAULT_KEY, help=f"floor 表键(默认 {DEFAULT_KEY})")
    ap.add_argument("--write", action="store_true", help="写入 floor 表(默认只预览)")
    ap.add_argument("--publish", action="store_true", help="写入后发布 CDN(隐含 --write)")
    ap.add_argument("--list-pool", action="store_true", help="打印素材池后退出")
    args = ap.parse_args()

    pool = build_pool()
    if args.list_pool:
        print(f"素材池 {len(pool)} 层:")
        for fdk, _ln, b in pool:
            print(f"  {fdk:44s} {','.join(b)}")
        return

    seed = args.seed if args.seed is not None else _dt.date.today().strftime("%Y%m%d")
    rng = random.Random(seed)

    if args.pool > 0:
        cand = pool
        if args.pool_size and args.pool_size < len(pool):
            cand = rng.sample(pool, args.pool_size)
        print(f"⚠ POOL 模式:客户端每次进本从 {len(cand)} 层池随机抽 {args.pool} 层")
        print("⚠ 前置:所有客户端已打 client-patch/random-floor 补丁(旧客户端读到会崩)!")
        for fdk, _ln, b in cand:
            print(f"  候选: {fdk:40s} boss={','.join(b)}")
        chain = "\n".join([f"__random__,{args.pool},-"] + [ln for _fdk, ln, _b in cand])
        n = len(cand) + 1                       # 1 头行 + 候选池行数
    else:
        n = min(args.floors, len(pool))
        picks = rng.sample(pool, n)
        print(f"种子={seed} 层数={n} 键={args.key}")
        for i, (fdk, _ln, b) in enumerate(picks):
            print(f"  层{i + 1}: {fdk:40s} boss={','.join(b)}")
        chain = "\n".join(ln for _fdk, ln, _b in picks)

    do_write = args.write or args.publish
    if not do_write:
        print("DRY-RUN(--write 写入,--publish 写入并发布)")
        return

    floor = q.load_table(FLOOR_T)
    floor[args.key] = chain
    q.save_table(FLOOR_T, floor)
    back = q.load_table(FLOOR_T)[args.key]
    assert back == chain, "回读校验失败"
    print(f"[OK] floor[{args.key}] 已写入 {n} 层(自动备份)")

    if args.publish:
        r = subprocess.run([sys.executable, "-X", "utf8", str(MOD_DIR / "wf_publish.py"),
                            "--tables", "floor"], capture_output=True, text=True,
                           encoding="utf-8", errors="replace")
        tail = (r.stdout or "") + (r.stderr or "")
        print(tail.strip().splitlines()[-3:] if tail else "(无输出)")
        if r.returncode != 0:
            sys.exit("发布失败,看上方输出")


if __name__ == "__main__":
    main()
