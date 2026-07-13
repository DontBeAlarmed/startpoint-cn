#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""wf_rogue_rewards.py — 深渊连战奖励体系:深渊代币 + 15 把专属武装。

代币:克隆官方「激战代币」(item 2370007,23列)→ **2370099「深渊代币」**
  (图标暂复用激战代币;通关每轮由 rogue_event.json 掉落,后续接兑换商店)。
专属武装:每属性 2 把 + 通用 3 把 = 15 键(8000101-8000115),装备元数据
  从既有供体行构建,词条只取经过验证的官方模板首行。
同步:assets/equipment_max_level.json / equipment_element.json / equipment_lookup.json /
  equipment_ids.json / item_ids.json(后两个=邮件校验,静态 import 须重启服务端)。

用法(项目根,默认 dry-run):
  python mod-tools/wf_rogue_rewards.py --write --publish
"""
import argparse
import copy
import json
import os
import subprocess
import sys
from dataclasses import dataclass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "mod-tools"))
import wf_quest_lib as q          # noqa: E402
import wf_mod_tool as core        # noqa: E402

ITEM_T = "master/item/item.orderedmap"
EQUIP_T = "master/item/equipment.orderedmap"
SOUL_T = "master/ability/ability_soul.orderedmap"

TOKEN_ID = "2370099"
TOKEN_TEMPLATE = "2370007"     # 激战代币

MODE_DESCRIPTION = "【测试版·连战专属】仅在深渊连战、宝物域连战 2001 与木桩假人生效。"
IMAGE_PREFIX = "item/equipment/mod/abyss"


@dataclass(frozen=True)
class EffectSpec:
    template_id: str
    effect_kind: str
    strength: int


@dataclass(frozen=True)
class WeaponSpec:
    id: str
    name: str
    donor: str
    element: int
    group: str
    image_slug: str
    effects: tuple[EffectSpec, ...]


WEAPONS: tuple[WeaponSpec, ...] = (
    WeaponSpec("8000101", "灰烬巨剑", "5010060", 0, "Red", "fire_01", (
        EffectSpec("3020006", "32", 3_000_000),
        EffectSpec("5050009", "55", 5_000_000),
    )),
    WeaponSpec("8000102", "熔核法杖", "5020042", 0, "Red", "fire_02", (
        EffectSpec("4020013", "34", 5_000_000),
        EffectSpec("3050010", "211", 1_000_000),
    )),
    WeaponSpec("8000103", "深潮长枪", "5010075", 1, "Blue", "water_01", (
        EffectSpec("3020006", "32", 3_000_000),
        EffectSpec("5070035", "33", 5_000_000),
    )),
    WeaponSpec("8000104", "冻海战锚", "5020031", 1, "Blue", "water_02", (
        EffectSpec("3040003", "205", 1_000_000),
        EffectSpec("3010013", "195", 1_000_000),
        EffectSpec("3050010", "211", 1_000_000),
    )),
    WeaponSpec("8000105", "雷鸣双刃", "5010077", 2, "Yellow", "thunder_01", (
        EffectSpec("3020006", "32", 3_000_000),
        EffectSpec("5070035", "33", 5_000_000),
    )),
    WeaponSpec("8000106", "轰电战锤", "5020038", 2, "Yellow", "thunder_02", (
        EffectSpec("4020013", "34", 5_000_000),
        EffectSpec("3050010", "211", 1_000_000),
    )),
    WeaponSpec("8000107", "裂空战镰", "5010068", 3, "Green", "wind_01", (
        EffectSpec("3020006", "32", 3_000_000),
        EffectSpec("5070035", "33", 5_000_000),
    )),
    WeaponSpec("8000108", "苍岚长弓", "5020026", 3, "Green", "wind_02", (
        EffectSpec("4020013", "34", 5_000_000),
        EffectSpec("3050010", "211", 1_000_000),
    )),
    WeaponSpec("8000109", "晨星圣剑", "5017716", 4, "White", "light_01", (
        EffectSpec("3020006", "32", 3_000_000),
        EffectSpec("5090029", "388", 5_000_000),
    )),
    WeaponSpec("8000110", "辉环法器", "5020039", 4, "White", "light_02", (
        EffectSpec("3040003", "205", 1_000_000),
        EffectSpec("3010013", "195", 1_000_000),
        EffectSpec("4020013", "34", 3_000_000),
    )),
    WeaponSpec("8000111", "蚀月大剑", "5010078", 5, "Black", "dark_01", (
        EffectSpec("3020006", "32", 5_000_000),
        EffectSpec("4020013", "34", 5_000_000),
    )),
    WeaponSpec("8000112", "冥灯魔杖", "5020040", 5, "Black", "dark_02", (
        EffectSpec("5090029", "388", 5_000_000),
        EffectSpec("3050010", "211", 1_000_000),
    )),
    WeaponSpec("8000113", "深渊征服者", "5010057", -1, "", "universal_01", (
        EffectSpec("3020006", "32", 3_000_000),
        EffectSpec("3040003", "205", 1_000_000),
    )),
    WeaponSpec("8000114", "深渊轮转核", "5020010", -1, "", "universal_02", (
        EffectSpec("4020013", "34", 5_000_000),
        EffectSpec("3050010", "211", 1_000_000),
    )),
    WeaponSpec("8000115", "深渊万象铳", "5090045", -1, "", "universal_03", (
        EffectSpec("5070035", "33", 3_000_000),
        EffectSpec("5050009", "55", 3_000_000),
        EffectSpec("5090029", "388", 3_000_000),
    )),
)


def _leaf_text(leaf: bytes | str) -> str:
    return leaf.decode("utf-8") if isinstance(leaf, bytes) else leaf


def _join_like(rows: list[list[str]], like: bytes | str) -> bytes | str:
    text = core.write_csv_lines(rows)
    return text.encode("utf-8") if isinstance(like, bytes) else text


def cells(leaf) -> list[str]:
    return core.read_csv_lines(_leaf_text(leaf))[0]


def join_like(row: list[str], like) -> bytes | str:
    return _join_like([row], like)


def build_equipment_leaf(template_leaf: bytes | str, spec: WeaponSpec) -> bytes | str:
    """从供体装备首行构建一条固定的深渊武装行。"""
    row = list(core.read_csv_lines(_leaf_text(template_leaf))[0])
    row = core.normalize_row_length(row, 12)
    row[0] = f"{IMAGE_PREFIX}/{spec.image_slug}"
    row[1] = spec.name
    row[6] = MODE_DESCRIPTION
    row[7] = str(spec.element)
    row[8] = "5"
    row[9] = "true"
    row[10] = spec.id
    row[11] = "5"
    return _join_like([row], template_leaf)


def build_soul_leaf(
    template_table: dict[str, bytes | str], spec: WeaponSpec,
) -> bytes | str:
    """按声明顺序各取一个模板的首行，构建同键 ability_soul。"""
    rows: list[list[str]] = []
    output_like: bytes | str = ""
    for slot, effect in enumerate(spec.effects, start=1):
        template_leaf = template_table[effect.template_id]
        if slot == 1:
            output_like = template_leaf
        row = list(core.read_csv_lines(_leaf_text(template_leaf))[0])
        row = core.normalize_row_length(row, 123)
        row[0], row[1], row[2] = str(slot), "1", "0"
        row[44] = effect.effect_kind
        row[45] = "5"
        row[46] = spec.group
        row[48] = row[49] = str(effect.strength)
        rows.append(row)
    return _join_like(rows, output_like)


def build_equipment_status(status_table: dict[str, object], spec: WeaponSpec):
    """完整复制供体的所有等级 HP/ATK 映射，且不共享可变对象。"""
    return copy.deepcopy(status_table[spec.donor])


def load_json(name: str):
    with open(os.path.join(ROOT, "assets", name), encoding="utf-8") as fh:
        return json.load(fh)


def save_json(name: str, data) -> None:
    with open(os.path.join(ROOT, "assets", name), "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=0 if isinstance(data, list) else 1)


def main() -> int:
    ap = argparse.ArgumentParser(description="深渊代币 + 连战专属武装")
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

    # ---- 连战专属武装 ----
    equip = q.load_table(EQUIP_T)
    souls = q.load_table(SOUL_T)
    new_equips: dict[str, object] = {}
    new_souls: dict[str, object] = {}
    for spec in WEAPONS:
        if spec.donor not in equip:
            print(f"[ERR] 捐赠武器 {spec.donor} 不存在")
            return 1
        missing_templates = [effect.template_id for effect in spec.effects
                             if effect.template_id not in souls]
        if missing_templates:
            print(f"[ERR] 武装 {spec.id} 缺少词条模板:{','.join(missing_templates)}")
            return 1
        new_equips[spec.id] = build_equipment_leaf(equip[spec.donor], spec)
        new_souls[spec.id] = build_soul_leaf(souls, spec)
        print(f"武装: {spec.id} {spec.name} <- {spec.donor}")

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
    for spec in WEAPONS:
        maxl[spec.id] = maxl.get(spec.donor, 5)
        elem[spec.id] = elem.get(spec.donor, -1)
        dl = lookup.get(spec.donor, {})
        lookup[spec.id] = {"name": spec.name, "rarity": dl.get("rarity", "0"),
                           "category": dl.get("category", "剑")}
        if int(spec.id) not in eq_ids:
            eq_ids.append(int(spec.id))
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
