#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""wf_rogue_nerf.py — 调 rush 无尽战斗的逐轮修正曲线(boss/炮台 HP·ATK)。

数据:master/quest/event/rush_event_battle_quest_correction.orderedmap
树形 [event][folder][quest序号][round] = 9列 CSV:
  c0=hpB c1=atkB c2=tpB c3=hpF c4=atkF c5=tpF c6=hpZ c7=atkZ c8=tpZ
客户端按轮数键分段线性插值,超最大键沿末段斜率外推(无尽软上限看末两键斜率)。

用法(项目根运行,默认 dry-run):
  python mod-tools/wf_rogue_nerf.py --event 700007                       # 查看当前曲线
  python mod-tools/wf_rogue_nerf.py --event 700007 --hp-scale 0.3 --write
  python mod-tools/wf_rogue_nerf.py --event 700007 \
      --hp-values 0.5,0.65,0.8,1,1.2,1.45,1.7,2,2.4,2.9,3.5,4.2,5,6 --write --publish
选项:
  --hp-scale X     boss/炮台 HP 全轮乘 X(c0,c3)
  --atk-scale X    boss/炮台 ATK 全轮乘 X(c1,c4)
  --hp-values a,b  按轮数顺序直接指定 boss/炮台 HP(个数须=现有轮数键)
  --write          写入(自动备份);--publish 顺带 wf_publish 发 CDN
改完须发布 + 重启游戏才生效(服务端无需重启)。
"""
import argparse
import csv
import io
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import wf_quest_lib as q

LOGICAL = "master/quest/event/rush_event_battle_quest_correction.orderedmap"
COLS = ["hpB", "atkB", "tpB", "hpF", "atkF", "tpF", "hpZ", "atkZ", "tpZ"]


def fmt(v: float) -> str:
    s = f"{v:.6f}".rstrip("0").rstrip(".")
    return s if s else "0"


def walk_rounds(node, path=()):
    """深度优先展开到 round 叶子,yield (path, round_key, leaf)。"""
    for k in sorted(node.keys(), key=lambda x: int(x) if str(x).isdigit() else 0):
        v = node[k]
        if isinstance(v, dict):
            yield from walk_rounds(v, path + (k,))
        else:
            yield path, k, v


def main() -> int:
    ap = argparse.ArgumentParser(description="rush 无尽修正曲线调参")
    ap.add_argument("--event", required=True, help="活动 id,如 700007")
    ap.add_argument("--hp-scale", type=float, default=None)
    ap.add_argument("--atk-scale", type=float, default=None)
    ap.add_argument("--hp-values", default=None, help="逗号分隔,按轮数顺序覆盖 hpB/hpF")
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--publish", action="store_true")
    args = ap.parse_args()

    tree = q.load_table(LOGICAL)
    if args.event not in tree:
        print(f"[ERR] 事件 {args.event} 不在表中;现有:{list(tree.keys())}")
        return 1

    entries = list(walk_rounds(tree[args.event]))
    hp_values = None
    if args.hp_values:
        hp_values = [float(x) for x in args.hp_values.split(",")]
        if len(hp_values) != len(entries):
            print(f"[ERR] --hp-values 个数({len(hp_values)})≠轮数键个数({len(entries)})")
            return 1

    changed = False
    for idx, (path, rk, leaf) in enumerate(entries):
        line = leaf.decode("utf-8") if isinstance(leaf, bytes) else leaf
        row = next(csv.reader(io.StringIO(line)))
        before = ", ".join(f"{c}={row[i]}" for i, c in enumerate(COLS[:5]))
        if hp_values is not None:
            row[0] = row[3] = fmt(hp_values[idx])
        if args.hp_scale is not None:
            row[0] = fmt(float(row[0]) * args.hp_scale)
            row[3] = fmt(float(row[3]) * args.hp_scale)
        if args.atk_scale is not None:
            row[1] = fmt(float(row[1]) * args.atk_scale)
            row[4] = fmt(float(row[4]) * args.atk_scale)
        buf = io.StringIO()
        csv.writer(buf, lineterminator="").writerow(row)
        new_line = buf.getvalue()
        mark = ""
        if new_line != line:
            changed = True
            mark = "  =>  " + ", ".join(f"{c}={row[i]}" for i, c in enumerate(COLS[:5]))
            node = tree[args.event]
            for p in path:
                node = node[p]
            node[rk] = new_line.encode("utf-8") if isinstance(leaf, bytes) else new_line
        print(f"[{args.event}/{'/'.join(path)}] round {rk}: {before}{mark}")

    if not changed:
        print("无改动(未给定参数或数值相同)。")
        return 0
    if not args.write:
        print("[DRY-RUN] 未写入。加 --write 生效(自动备份),--publish 顺带发 CDN。")
        return 0

    out = q.save_table(LOGICAL, tree)
    print(f"[OK] 已写入 {out}(含备份)")
    if args.publish:
        r = subprocess.run([sys.executable, "mod-tools/wf_publish.py", "--tables", "rush_event_correction"])
        print(f"[PUBLISH] wf_publish 退出码 {r.returncode}")
    else:
        print("记得发布:python mod-tools/wf_publish.py --tables rush_event_correction")
    return 0


if __name__ == "__main__":
    sys.exit(main())
