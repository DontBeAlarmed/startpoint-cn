#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""wf_rogue_build.py — 生成自制 rush 活动 700099「深渊连战」(M1:每轮不同 boss)。

②层(模板全部克隆自 700007 狂热激战,零新资产):
  rush_event[700099]              事件行(常开 2000→2099,banner/背景复用 combat_diver)
  rush_event_quest_folder[700099] folder 1「深渊连战」(quest_kind=1)
  rush_event_quest[700099]        round 1..N,每轮独立 quest:
                                  c98 战场 = 连战塔素材池(wf_chain_build.build_pool)随机层,
                                  c9-13 view_condition 链住上一轮(§9.3 硬约束),
                                  c67 体力=0,c95 敌等级 80(塔场地×rush 已真机验证),
                                  c86-94 修正 = 缓坡(hp 0.5×1.185^r / atk 0.35×1.13^r)
  event_list[700099]              kind 11 入口

服务端(静态 import,改后须重启服务端):
  assets/rush_event_quest.json        += 700099001..N
  assets/rush_event_quest_folder.json += 700099 folder 奖励

用法(项目根,默认 dry-run):
  python mod-tools/wf_rogue_build.py --rounds 10 --seed 20260713
  python mod-tools/wf_rogue_build.py --rounds 10 --write --publish
重摇 boss 阵容 = 换 --seed 重跑(--write --publish),轮数不变时服务端 json 不变可不重启。
"""
import argparse
import csv
import io
import json
import os
import random
import subprocess
import sys
from datetime import date

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "mod-tools"))
import wf_quest_lib as q          # noqa: E402
import wf_chain_build as cb       # noqa: E402

EVENT_ID = "700099"
TOKEN_ID = "2370099"
EVENT_STRING_ID = "mod_rogue_gauntlet"
EVENT_NAME = "深渊连战"
Q_EVENT = "master/quest/event/rush_event.orderedmap"
Q_FOLDER = "master/quest/event/rush_event_quest_folder.orderedmap"
Q_QUEST = "master/quest/event/rush_event_quest.orderedmap"
Q_LIST = "master/quest/event/event_list.orderedmap"
Q_CORR = "master/quest/event/rush_event_battle_quest_correction.orderedmap"
TEMPLATE_EVENT = "700007"
ENDLESS_KEY = "99"          # 无尽 quest 内层键/id 尾号(避开 round 键位)

# boss 元素机制(2026-07-13 逆向实锤):
# general_boss 行 c0 = 元素 kind:0=Inherit(继承 quest)、1火2水3雷4风5光6暗、7=Colorless。
# 客户端 BattleQuestBaseImpl:2416 把 quest 的 battle_recommended_element(c69)作为
# questsElement 传进 ZoneSource → Inherit/Standard boss 的战斗元素 = c69!
# ⇒ 本生成器令 c69 = boss 实际元素:固定元素怪查表,Inherit 怪由种子随机指定
#   (显示的"推荐属性"即 boss 属性,同时决定 Inherit 怪的变体)。
GENERAL_BOSS = "master/battle/boss/general_boss.orderedmap"
STANDARD_BOSS = "master/battle/boss/standard_boss.orderedmap"


def boss_element_map() -> dict[str, int | None]:
    """boss code → 固定元素(0-based)或 None(=Inherit,元素随 c69)。

    只读 general_boss(c0=元素kind);standard_boss 表无元素列 = 恒继承 quest 元素。
    """
    out: dict[str, int | None] = {}
    table = q.load_table(GENERAL_BOSS)
    for code, node in table.items():
        leaf = node
        if isinstance(node, dict):
            leaf = node[next(iter(node))]
        s = leaf.decode("utf-8") if isinstance(leaf, bytes) else leaf
        kind = cb._cols(s.split("\n")[0])[0]
        out[code] = (int(kind) - 1) if kind in ("1", "2", "3", "4", "5", "6") else None
    return out


# ---- 跨副本楼层来源(v5,2026-07-13 用户设计)----
# 1-2=随机小怪房 3=领主战 6=随机机兵(高难多人) 8=随机降临讨伐 9=女帝歼灭者
# 11=战阵之宴·无幻之宴;其余轮 = 连战塔素材池随机。
import wf_boss as wb              # noqa: E402


_TBL_CACHE: dict[str, dict] = {}


def _tbl(logical: str) -> dict:
    if logical not in _TBL_CACHE:
        _TBL_CACHE[logical] = q.load_table(logical)
    return _TBL_CACHE[logical]


def _zone_pick(fdid: str) -> tuple[list[str], list[str]]:
    """field → (boss codes, zako codes),按 zone 波次列直读(不依赖名字表)。"""
    fd = _tbl("master/battle/field_data.orderedmap")
    zone = _tbl("master/battle/zone.orderedmap")
    frow = fd.get(fdid)
    if not frow:
        return [], []
    zn = zone.get(cb._cols(frow)[2])
    bosses, zakos = [], []
    if isinstance(zn, dict):
        for wrow in zn.values():
            wc = cb._cols(wrow)
            bosses += [wc[i + 1] for i in range(23, min(35, len(wc)), 2)
                       if wc[i] not in ("(None)", "") and wc[i + 1] not in ("(None)", "")]
            zakos += [wc[i] for i in range(2, min(22, len(wc)), 2)
                      if wc[i] not in ("(None)", "")]
    return bosses, zakos


def quest_pool(cat: str, name_eq: str | None = None, require_boss: bool = True) -> list[dict]:
    """副本类别 → [{field,bosses,thumb,name}](按 field 去重,field 从行单元格匹配)。"""
    logical = next(x[2] for x in wb.QUEST_CATS if x[0] == cat)
    tree = wb._load(logical)
    fd_keys = set(_tbl("master/battle/field_data.orderedmap").keys())
    out, seen = [], set()
    for _path, row in wb._leaves(tree):
        cs = row.split(",")
        name = next((x for x in cs[1:7] if x and wb._CJK.search(x)), "")
        name = name.replace("::quest_rank::", "").strip()
        if name_eq and name != name_eq:
            continue
        fdid = next((x for x in cs if x in fd_keys), "")
        if not fdid or fdid in seen:
            continue
        bosses, zakos = _zone_pick(fdid)
        if require_boss and not bosses:
            continue
        thumb = next((x for x in cs if "/thumbnail/" in x), "")
        seen.add(fdid)
        out.append({"field": fdid, "bosses": bosses, "zakos": zakos, "thumb": thumb, "name": name})
    return out


def zako_room_pool() -> list[dict]:
    """主线里的纯小怪房(zone 无 boss、有小怪)。"""
    out = []
    for entry in quest_pool("main", require_boss=False):
        if not entry["bosses"] and entry["zakos"]:
            out.append(entry)
    return out


# ---- 随机场地效果(v6)----
# 载体 = quest 行 battle_enemy_condition_1..5(c71-80,每槽 kind+strength 两列):
# kind 0能力/1直击/2弹射/3技能 = XX伤害耐性(strength 为小数比例,正=敌减伤=玩家减益,
# 负=敌易伤=玩家增益;官方超3用 -4=受伤×5),kind 4=敌方减益免疫(无强度)。
# 排程:1-4 层无;5-6 层 1 减益;7-9 层 2 减益;10 层起 双增益+三减益(5 槽拉满,
# 减益强制含"减益免疫"以保证增益槽位)。
COND_KIND_CN = {0: "能力", 1: "直击", 2: "弹射", 3: "技能"}


def field_effects(r: int, rng) -> tuple[list[tuple[str, str]], str]:
    if r < 5:
        return [], ""
    if r < 7:
        debuffs = rng.sample([0, 1, 2, 3, 4], 1)
        n_buff = 0
    elif r < 10:
        debuffs = rng.sample([0, 1, 2, 3, 4], 2)
        n_buff = 0
    else:
        debuffs = [4] + rng.sample([0, 1, 2, 3], 2)   # 免疫+2耐性,留2种给增益
        n_buff = 2
    buff_pool = [k for k in (0, 1, 2, 3) if k not in debuffs]
    buffs = rng.sample(buff_pool, min(n_buff, len(buff_pool)))
    conds: list[tuple[str, str]] = []
    deb_txt, buf_txt = [], []
    for k in debuffs:
        if k == 4:
            conds.append(("4", ""))
            deb_txt.append("减益免疫")
        else:
            s = rng.choice((0.2, 0.3, 0.4))
            conds.append((str(k), fmt(s)))
            deb_txt.append(f"{COND_KIND_CN[k]}耐性{int(s * 100)}%")
    for k in buffs:
        s = rng.choice((0.3, 0.4, 0.5))
        conds.append((str(k), fmt(-s)))
        buf_txt.append(f"{COND_KIND_CN[k]}易伤{int(s * 100)}%")
    parts = []
    if deb_txt:
        parts.append("敌抗:" + "/".join(deb_txt))
    if buf_txt:
        parts.append("敌弱:" + "/".join(buf_txt))
    return conds, " ".join(parts)


def _leaf_rows(node):
    """任意深度嵌套表 → 逐个 leaf CSV 行。"""
    if isinstance(node, dict):
        for v in node.values():
            yield from _leaf_rows(v)
    else:
        s = node.decode("utf-8") if isinstance(node, bytes) else node
        for ln in s.split("\n"):
            if ln.strip():
                yield ln


def field_thumbnail_map() -> dict[str, str]:
    """field_data id → 宿主 quest 的战斗缩略图(240×188 正规 quest/thumbnail)。

    floor 行第 3 列是塔层 31×31 小图标,放 quest 预览位显示空白(1.4.120 实锤)。
    正确素材 = 引用该 floor 的幽玄域/深层域宿主 quest 的 thumbnail(c3);
    floor 键→quest 缩略图,再经 floor 行摊开到每个 field。
    """
    floor = q.load_table("master/battle/floor.orderedmap")
    fkey_fields: dict[str, list[str]] = {}
    for k, v in floor.items():
        if isinstance(v, dict):
            continue
        s = v.decode("utf-8") if isinstance(v, bytes) else v
        fkey_fields[k] = [cb._cols(ln)[0] for ln in s.split("\n")
                          if cb._cols(ln) and cb._cols(ln)[0] not in ("", "(None)")]
    out: dict[str, str] = {}
    for logical, floor_col in [
        ("master/quest/event/tower_dungeon_event_quest.orderedmap", 99),
        ("master/quest/event/challenge_dungeon_event_quest.orderedmap", 110),
    ]:
        try:
            table = q.load_table(logical)
        except Exception:
            continue
        for ln in _leaf_rows(table):
            row = cb._cols(ln)
            if len(row) <= floor_col:
                continue
            fkey = row[floor_col]
            thumb = row[3]
            if not fkey or fkey in ("(None)",) or not thumb or thumb == "(None)":
                continue
            for field in fkey_fields.get(fkey, []):
                out.setdefault(field, thumb)
    return out

START = "2000-01-01 12:00:00"
END = "2099-12-29 23:59:59"
RESULT_END = "2099-12-30 12:00:00"
EXCHANGE_END = "2099-12-31 11:59:59"


def cells(leaf) -> list[str]:
    line = leaf.decode("utf-8") if isinstance(leaf, bytes) else leaf
    return next(csv.reader(io.StringIO(line)))


def join(row: list[str], as_bytes: bool):
    buf = io.StringIO()
    csv.writer(buf, lineterminator="").writerow(row)
    s = buf.getvalue()
    return s.encode("utf-8") if as_bytes else s


def fmt(v: float) -> str:
    s = f"{v:.4f}".rstrip("0").rstrip(".")
    return s or "0"


def patch_event_metadata(row: list[str]) -> list[str]:
    """只把深渊 Rush Event 的兑换代币改为深渊代币。"""
    row[10] = TOKEN_ID
    return row


def build_event_metadata_leaf(
    template_leaf: bytes | str,
    current_leaf: bytes | str,
) -> bytes | str:
    """Rebuild 700099 from the canonical template, preserving only banner art."""
    template = cells(template_leaf)
    current = cells(current_leaf)
    if len(template) < 18:
        raise ValueError(f"rush_event[{TEMPLATE_EVENT}] must have at least 18 columns")
    if len(current) < 5:
        raise ValueError(f"rush_event[{EVENT_ID}] must have at least 5 columns")

    row = list(template)
    row[0] = EVENT_STRING_ID
    row[1] = EVENT_NAME
    row[2] = f"{START},{END},{RESULT_END},{EXCHANGE_END}"
    row[3:5] = current[3:5]
    row[10] = TOKEN_ID
    row[15] = START
    row[16] = END
    row[17] = EXCHANGE_END
    return join(row, isinstance(current_leaf, bytes))


def main() -> int:
    ap = argparse.ArgumentParser(description="生成 700099 深渊连战")
    ap.add_argument("--rounds", type=int, default=15)
    ap.add_argument("--seed", type=int, default=int(date.today().strftime("%Y%m%d")))
    ap.add_argument("--hp-base", type=float, default=0.5)
    ap.add_argument("--hp-growth", type=float, default=1.185)
    ap.add_argument("--atk-base", type=float, default=0.35)
    ap.add_argument("--atk-growth", type=float, default=1.13)
    ap.add_argument("--enemy-level", type=int, default=80)
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--publish", action="store_true")
    args = ap.parse_args()

    rng = random.Random(args.seed)
    tower = cb.build_pool()
    if len(tower) < args.rounds + 1:
        print(f"[ERR] 塔素材池只有 {len(tower)} 层 < {args.rounds}+1 轮")
        return 1

    # ---- 楼层来源池(v5)----
    zako_lst = zako_room_pool()
    src = {
        "领主战": quest_pool("boss_battle"),
        "机兵": quest_pool("hard_multi"),
        "降临讨伐": quest_pool("advent"),
        "女帝歼灭者": quest_pool("advent", name_eq="女帝歼灭者"),
        "无幻之宴": quest_pool("raid", name_eq="无幻之宴"),
    }
    # 终始之龙:剧情版 main_12_10_01 自带 NPC 协力(史黛拉/蕾薇/阿尔克)+「无法强化效果」
    # 剧情 debuff,无法解除;改用**多人战版** eye_dragon_multibattle(始龙之眼,无色),
    # 干净无剧情机制。field 直接指定,缩略图借宿主 advent quest。
    DRAGON_FIELD = "eye_dragon_multibattle"
    DRAGON_THUMB = "quest/thumbnail/world_10/thumbnail1"
    for label, lst in [("小怪房", zako_lst)] + list(src.items()):
        if not lst:
            print(f"[ERR] 来源池「{label}」为空")
            return 1
        print(f"来源池 {label}: {len(lst)} 个场地")

    def src_pick(label: str) -> dict:
        e = src[label][rng.randrange(len(src[label]))]
        return {"field": e["field"], "bosses": e["bosses"], "thumb": e["thumb"],
                "bgm": None, "label": f"{label}·{e['name']}"}

    def dragon_pick() -> dict:
        bosses, _ = _zone_pick(DRAGON_FIELD)
        return {"field": DRAGON_FIELD, "bosses": bosses, "thumb": DRAGON_THUMB,
                "bgm": None, "label": "终始之龙·始龙之眼(多人版)"}

    def zako_pick() -> dict:
        e = zako_lst.pop(rng.randrange(len(zako_lst)))
        return {"field": e["field"], "bosses": [], "thumb": e["thumb"],
                "bgm": None, "label": f"小怪房·{e['name']}"}

    # ---- ② rush_event 行 ----
    # ⚠ 列语义(RushEventValues 实锤):c2=banner_schedule(横幅轮播排期,不是活动期!)
    # c15=start_time c16=playable_end_time c17=exchangeable_end_time。
    # 700099 行已存在时以现有行为基底(保留 wf_rogue_banner 换过的横幅列 c3/c4)。
    ev = q.load_table(Q_EVENT)
    template_leaf = ev[TEMPLATE_EVENT]
    current_leaf = ev.get(EVENT_ID) or template_leaf
    event_leaf = build_event_metadata_leaf(template_leaf, current_leaf)
    ev_row = cells(event_leaf)
    ev_bytes = isinstance(event_leaf, bytes)

    # ---- ② folder 行(连战=700007 超级 folder 3 模板;无尽=folder 4 模板)----
    fo = q.load_table(Q_FOLDER)
    tmpl_fo = cells(fo[TEMPLATE_EVENT]["3"])
    fo_bytes = isinstance(fo[TEMPLATE_EVENT]["3"], bytes)
    fo_row = list(tmpl_fo)
    fo_row[0] = "1"           # display_order
    fo_row[1] = "1"           # quest_kind = rush folder
    fo_row[2] = EVENT_NAME
    fo_endless = list(cells(fo[TEMPLATE_EVENT]["4"]))
    fo_endless[0] = "100"
    fo_endless[1] = "2"       # quest_kind = endless(缺它 = 点∞按钮 C3442)
    fo_endless[2] = "无尽战斗"

    # ---- ② quest 行 ----
    qt = q.load_table(Q_QUEST)
    tmpl_r1 = cells(qt[TEMPLATE_EVENT]["1"])
    tmpl_rn = cells(qt[TEMPLATE_EVENT]["2"])
    tmpl_endless = cells(qt[TEMPLATE_EVENT]["8"])
    qt_bytes = isinstance(qt[TEMPLATE_EVENT]["1"], bytes)
    ELEM_CN = ["火", "水", "雷", "风", "光", "暗"]

    thumb_map = field_thumbnail_map()
    belem_map = boss_element_map()

    def tower_pick() -> dict:
        f, line, bosses = tower.pop(rng.randrange(len(tower)))
        fc = cb._cols(line)
        return {"field": f, "bosses": bosses, "thumb": thumb_map.get(f, ""),
                "bgm": fc[1], "label": "塔·" + ",".join(bosses)}

    # 楼层计划:1-2 小怪房 / 3 领主战 / 6 机兵 / 8 降临讨伐 / 9 女帝歼灭者 / 11 无幻之宴
    SPECIALS = {1: zako_pick, 2: zako_pick,
                3: lambda: src_pick("领主战"), 6: lambda: src_pick("机兵"),
                8: lambda: src_pick("降临讨伐"), 9: lambda: src_pick("女帝歼灭者"),
                11: lambda: src_pick("无幻之宴"), 15: dragon_pick}

    def patch_common(row: list[str], name: str, pick: dict) -> str:
        row[4] = name
        thumb = pick.get("thumb") or ""
        if thumb:
            row[5] = thumb                               # 来源副本的正规预览图
        row[7] = START
        row[8] = END
        row[67] = "0"                                    # 体力
        # c69 = boss 实际元素:固定元素怪查表;Inherit 怪/小怪房由此列指定(随机)
        fixed = next((belem_map[c] for c in pick["bosses"] if belem_map.get(c) is not None), None)
        elem = fixed if fixed is not None else rng.randrange(6)
        row[69] = str(elem)
        row[95] = str(args.enemy_level)
        row[98] = pick["field"]
        if pick.get("bgm"):
            row[99] = pick["bgm"]                        # 塔层带专属 BGM;来源副本保持模板
        tag = "" if fixed is not None else "(随机)"
        return f" 属性:{ELEM_CN[elem]}{tag}"

    quest_rows: dict[str, list[str]] = {}
    plan = []
    for r in range(1, args.rounds + 1):
        pick = SPECIALS[r]() if r in SPECIALS else tower_pick()
        row = list(tmpl_r1 if r == 1 else tmpl_rn)
        row[0] = str(700099000 + r)
        row[1] = "1"
        row[2] = str(r)
        if r > 1:
            row[9] = "16"
            row[10] = EVENT_ID
            row[11] = ""
            row[12] = str(r - 1)
            row[13] = str(700099000 + r - 1)
        hp = fmt(args.hp_base * (args.hp_growth ** (r - 1)))
        atk = fmt(args.atk_base * (args.atk_growth ** (r - 1)))
        row[86], row[87], row[88] = hp, hp, hp           # hp 小怪/炮台/boss(小怪房也吃曲线)
        row[89], row[90], row[91] = atk, atk, atk        # atk
        row[92] = row[93] = row[94] = "1"                # tp
        rec = patch_common(row, f"{EVENT_NAME} 第{r}战", pick)
        # 随机场地效果:battle_enemy_condition_1..5(c71-80)+ 副标题(c3)
        conds, effect_desc = field_effects(r, rng)
        for slot in range(5):
            kind, strength = conds[slot] if slot < len(conds) else ("(None)", "")
            row[71 + slot * 2] = kind
            row[72 + slot * 2] = strength
        row[3] = effect_desc if effect_desc else "(None)"
        quest_rows[str(r)] = row
        eff = f" | {effect_desc}" if effect_desc else ""
        plan.append(f"  第{r}战 [{pick['label']}] field={pick['field']} hp×{hp} atk×{atk}{rec}{eff}")

    # 无尽档:folder 2 / round 0,修正曲线接管难度(quest 行修正=round-0 锚点)
    endless_pick = tower_pick()
    endless_row = list(tmpl_endless)
    endless_row[0] = str(700099000 + int(ENDLESS_KEY))
    endless_row[1] = "2"
    endless_row[2] = "0"
    rec = patch_common(endless_row, f"{EVENT_NAME} 无尽", endless_pick)
    quest_rows[ENDLESS_KEY] = endless_row
    plan.append(f"  无尽 [{endless_pick['label']}] field={endless_pick['field']}{rec}(曲线抄 700007 现值)")

    print(f"seed={args.seed} rounds={args.rounds}")
    print("\n".join(plan))

    if not args.write:
        print("[DRY-RUN] 未写入。加 --write 生效,--publish 顺带发 CDN。")
        return 0

    # 写 ② 层(save_table 自动备份)
    ev[EVENT_ID] = join(ev_row, ev_bytes)
    q.save_table(Q_EVENT, ev)
    fo[EVENT_ID] = {"1": join(fo_row, fo_bytes), "2": join(fo_endless, fo_bytes)}
    q.save_table(Q_FOLDER, fo)
    qt[EVENT_ID] = {k: join(v, qt_bytes) for k, v in quest_rows.items()}
    q.save_table(Q_QUEST, qt)
    el = q.load_table(Q_LIST)
    el_bytes = isinstance(el[TEMPLATE_EVENT], bytes)
    el[EVENT_ID] = join(["11", EVENT_ID, EVENT_ID], el_bytes)
    q.save_table(Q_LIST, el)
    # 无尽修正曲线:抄 700007 无尽当前值(已是缓坡)→ [700099][2][99]
    corr = q.load_table(Q_CORR)
    src_curve = corr[TEMPLATE_EVENT]["4"]["8"]
    corr[EVENT_ID] = {"2": {ENDLESS_KEY: dict(src_curve)}}
    q.save_table(Q_CORR, corr)
    print("[OK] ②层五表已写入(rush_event / folder / quest / event_list / correction)")

    # 服务端 json
    quest_json_path = os.path.join(ROOT, "assets", "rush_event_quest.json")
    with open(quest_json_path, encoding="utf-8") as fh:
        quest_json = json.load(fh)
    tmpl_entry = quest_json[f"{TEMPLATE_EVENT}001"]
    for r in range(1, args.rounds + 1):
        entry = dict(tmpl_entry)
        entry["rushEventId"] = int(EVENT_ID)
        entry["rushEventFolderId"] = 1
        entry["rushEventRound"] = r
        quest_json[str(700099000 + r)] = entry
    endless_entry = dict(tmpl_entry)
    endless_entry["rushEventId"] = int(EVENT_ID)
    endless_entry["rushEventFolderId"] = 2
    endless_entry["rushEventRound"] = 0
    quest_json[str(700099000 + int(ENDLESS_KEY))] = endless_entry
    # 清掉多余轮(rounds 缩小时;99=无尽键不在范围内)
    for r in range(args.rounds + 1, 31):
        quest_json.pop(str(700099000 + r), None)
    with open(quest_json_path, "w", encoding="utf-8") as fh:
        json.dump(quest_json, fh, ensure_ascii=False, indent=1)

    folder_json_path = os.path.join(ROOT, "assets", "rush_event_quest_folder.json")
    with open(folder_json_path, encoding="utf-8") as fh:
        folder_json = json.load(fh)
    folder_json[EVENT_ID] = {"1": folder_json[TEMPLATE_EVENT]["1"]}
    with open(folder_json_path, "w", encoding="utf-8") as fh:
        json.dump(folder_json, fh, ensure_ascii=False, indent=1)
    print("[OK] 服务端 json 已写入(rush_event_quest / rush_event_quest_folder)——静态 import,须重启服务端")

    if args.publish:
        r = subprocess.run([sys.executable, os.path.join(ROOT, "mod-tools", "wf_publish.py"),
                            "--tables",
                            "rush_event,rush_event_quest,rush_event_quest_folder,event_list,rush_event_correction"],
                           cwd=ROOT)
        print(f"[PUBLISH] wf_publish 退出码 {r.returncode}")
    else:
        print("记得发布:python mod-tools/wf_publish.py --tables "
              "rush_event,rush_event_quest,rush_event_quest_folder,event_list,rush_event_correction")
    return 0


if __name__ == "__main__":
    sys.exit(main())
