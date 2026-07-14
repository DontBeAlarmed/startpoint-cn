#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""wf_rogue_rewards.py — 深渊连战奖励体系:深渊代币 + 15 个占位武器。

代币:克隆官方「激战代币」(item 2370007,23列)→ **2370099「深渊代币」**
  (图标暂复用激战代币;通关每轮由 rogue_event.json 掉落,后续接兑换商店)。
占位武器:每属性 2 把 + 通用 3 把 = 15 键(8000101-8000115),克隆现有武器
  (equipment 行 + 同键 ability_soul 词条行),名字带「占位」,之后在 GUI 武器页
  直接改名/改词条/换图即成正式武器。
同步:assets/equipment_max_level.json / equipment_element.json / equipment_lookup.json /
  equipment_ids.json / item_ids.json(后两个=邮件校验,静态 import 须重启服务端)。

用法(项目根,默认 dry-run):
  python mod-tools/wf_rogue_rewards.py --write --publish
"""
import argparse
import csv
import io
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "mod-tools"))
import wf_quest_lib as q          # noqa: E402

ITEM_T = "master/item/item.orderedmap"
EQUIP_T = "master/item/equipment.orderedmap"
SOUL_T = "master/ability/ability_soul.orderedmap"

TOKEN_ID = "2370099"
TOKEN_TEMPLATE = "2370007"     # 激战代币

# (新id, 名字, 捐赠武器id)
ELEM_CN = ["火", "水", "雷", "风", "光", "暗"]
PLACEHOLDERS = [
    ("8000101", "深渊武装·火壹(占位)", "5010060"),
    ("8000102", "深渊武装·火贰(占位)", "5020042"),
    ("8000103", "深渊武装·水壹(占位)", "5010075"),
    ("8000104", "深渊武装·水贰(占位)", "5020031"),
    ("8000105", "深渊武装·雷壹(占位)", "5010077"),
    ("8000106", "深渊武装·雷贰(占位)", "5020038"),
    ("8000107", "深渊武装·风壹(占位)", "5010068"),
    ("8000108", "深渊武装·风贰(占位)", "5020026"),
    ("8000109", "深渊武装·光壹(占位)", "5017716"),
    ("8000110", "深渊武装·光贰(占位)", "5020039"),
    ("8000111", "深渊武装·暗壹(占位)", "5010078"),
    ("8000112", "深渊武装·暗贰(占位)", "5020040"),
    ("8000113", "深渊武装·通用壹(占位)", "5010057"),
    ("8000114", "深渊武装·通用贰(占位)", "5020010"),
    ("8000115", "深渊武装·通用叁(占位)", "5090045"),
]


def cells(leaf) -> list[str]:
    line = leaf.decode("utf-8") if isinstance(leaf, bytes) else leaf
    return next(csv.reader(io.StringIO(line)))


def join_like(row: list[str], like) -> bytes | str:
    buf = io.StringIO()
    csv.writer(buf, lineterminator="").writerow(row)
    s = buf.getvalue()
    return s.encode("utf-8") if isinstance(like, bytes) else s


def load_json(name: str):
    with open(os.path.join(ROOT, "assets", name), encoding="utf-8") as fh:
        return json.load(fh)


def save_json(name: str, data) -> None:
    with open(os.path.join(ROOT, "assets", name), "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=0 if isinstance(data, list) else 1)


def main() -> int:
    ap = argparse.ArgumentParser(description="深渊代币 + 占位武器")
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--publish", action="store_true")
    args = ap.parse_args()

    # ---- 代币 ----
    items = q.load_table(ITEM_T)
    tmpl = items[TOKEN_TEMPLATE]
    trow = cells(tmpl)
    trow[0] = "rogue_event_item_99"
    trow[1] = TOKEN_ID
    trow[2] = "深渊代币"
    trow[5] = "在「深渊连战」中获得的深渊结晶。凝聚着历战boss的力量,可用于锻造深渊武装。"
    print(f"代币: {TOKEN_ID} 深渊代币(克隆 {TOKEN_TEMPLATE} 激战代币,图标暂共用)")

    # ---- 占位武器 ----
    equip = q.load_table(EQUIP_T)
    souls = q.load_table(SOUL_T)
    new_equips: dict[str, object] = {}
    new_souls: dict[str, object] = {}
    for nid, name, donor in PLACEHOLDERS:
        if donor not in equip:
            print(f"[ERR] 捐赠武器 {donor} 不存在")
            return 1
        erow = cells(equip[donor])
        erow[0] = f"mod_abyss_{nid}"
        erow[1] = name
        if len(erow) > 10 and erow[10] not in ("", "(None)"):
            erow[10] = nid                    # soul_id 指回自身键
        new_equips[nid] = join_like(erow, equip[donor])
        if donor in souls:
            new_souls[nid] = souls[donor]     # 词条行原样克隆(整键复制,之后 GUI 单独编辑)
        print(f"占位: {nid} {name} <- {donor}")

    if not args.write:
        print("[DRY-RUN] 未写入。加 --write 生效。")
        return 0

    items[TOKEN_ID] = join_like(trow, tmpl)
    q.save_table(ITEM_T, items)
    for nid, leaf in new_equips.items():
        equip[nid] = leaf
    q.save_table(EQUIP_T, equip)
    for nid, leaf in new_souls.items():
        souls[nid] = leaf
    q.save_table(SOUL_T, souls)
    print("[OK] ②层三表已写入(item / equipment / ability_soul)")

    # ---- 服务端镜像 ----
    maxl = load_json("equipment_max_level.json")
    elem = load_json("equipment_element.json")
    lookup = load_json("equipment_lookup.json")
    eq_ids = load_json("equipment_ids.json")
    it_ids = load_json("item_ids.json")
    for nid, name, donor in PLACEHOLDERS:
        maxl[nid] = maxl.get(donor, 5)
        elem[nid] = elem.get(donor, -1)
        dl = lookup.get(donor, {})
        lookup[nid] = {"name": name, "rarity": dl.get("rarity", "0"), "category": dl.get("category", "剑")}
        if int(nid) not in eq_ids:
            eq_ids.append(int(nid))
    if int(TOKEN_ID) not in it_ids:
        it_ids.append(int(TOKEN_ID))
    save_json("equipment_max_level.json", maxl)
    save_json("equipment_element.json", elem)
    save_json("equipment_lookup.json", lookup)
    save_json("equipment_ids.json", eq_ids)
    save_json("item_ids.json", it_ids)
    print("[OK] 服务端镜像已更新(max_level/element/lookup/equipment_ids/item_ids)——须重启服务端")

    if args.publish:
        r = subprocess.run([sys.executable, os.path.join(ROOT, "mod-tools", "wf_publish.py"),
                            "--tables", f"{ITEM_T},{EQUIP_T},ability_soul"], cwd=ROOT)
        print(f"[PUBLISH] wf_publish 退出码 {r.returncode}")
    else:
        print(f"记得发布:python mod-tools/wf_publish.py --tables {ITEM_T},{EQUIP_T},ability_soul")
    return 0


if __name__ == "__main__":
    sys.exit(main())
