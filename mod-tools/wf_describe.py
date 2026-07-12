#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
词条行级中文描述器。

按逆向布局(ability_enum_map.json:五表块基址 + 块内字段偏移)和枚举中文直译
(词条条件代码全表.md §6.1-6.5 表格)把 ability / leader_ability / ability_soul /
equipment_enhancement_ability 的每一行翻成人话,格式:

  [觉醒追加] 火共鸣≥1 时:技能发动 → 赋予自身 冲刺间隔缩短 4%→8%(6秒)

注意:这**不是游戏原文**(原文由客户端 3.9 万行 AS3 动态拼接,无法离线复刻),
是按同一份数据生成的语义等价中文。数值端点 = SLv1→SLv满级(相等时只显示一个)。
"""
from __future__ import annotations

import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent

# md 章节 -> 枚举组键(instant_trigger 与 during_accumulation_trigger 共用 §6.2)
_MD_SECTIONS = {"6.1": "precondition", "6.2": "trigger", "6.3": "during_trigger",
                "6.4": "instant_content", "6.5": "during_content"}

# 小枚举(§6.6,量少直接写死)
TARGET_CN = {0: "自身", 1: "除自身全员", 2: "队长", 3: "2号位", 4: "3号位", 5: "全队",
             6: "协力全队", 7: "触发者", 8: "多球", 9: "HP最低者", 10: "HP最低者",
             11: "HP最低者(除自身)", 12: "HP最低者(除自身)", 13: "多球(按组)", 14: "多球(按角色组)"}
PULLER_CN = {0: "", 1: "队长", 2: "2号位", 3: "3号位", 4: "除自身任一", 5: "全队任一",
             6: "除自身合计", 7: "全队合计", 8: "沿用前置来源", 9: "全队总和", 10: "多球任一"}
ELEMENT_CN = {0: "全属性", 1: "火", 2: "水", 3: "雷", 4: "风", 5: "光", 6: "暗"}
GROUP_CN = {"Red": "火", "Blue": "水", "Yellow": "雷", "Green": "风", "White": "光",
            "Black": "暗", "All": "全属性", "Dragon": "龙族", "Male": "男性", "Female": "女性",
            "Machine": "机械", "Beast": "兽型", "Element": "精灵", "Undead": "不死",
            "Human": "人型", "Mystery": "神秘", "Devil": "魔族", "Plants": "植物", "Aquatic": "水栖"}
OPENING_CN = {0: "自身经验加成", 1: "全队经验加成", 2: "玛纳加成"}
PRECONTENT_CN = {0: "连击数达到", 1: "消耗全部固有状态", 2: "消耗固有状态", 3: "持有固有状态"}
MULTIPLY_CN = {1: "每次强化弹射", 2: "每次技能发动", 3: "进入Fever"}
AWAKE_CN = {1: "觉醒替换", 2: "觉醒追加"}

_enum_map: dict | None = None
_cn: dict[str, dict[str, str]] | None = None


def _load() -> None:
    global _enum_map, _cn
    if _enum_map is not None:
        return
    _enum_map = json.loads((HERE / "ability_enum_map.json").read_text(encoding="utf-8"))
    src = (HERE / "词条条件代码全表.md").read_text(encoding="utf-8")
    _cn = {}
    for sec, key in _MD_SECTIONS.items():
        i = src.find(f"### {sec}")
        j = src.find("### ", i + 5) if i >= 0 else -1
        block = src[i:(j if j > 0 else len(src))] if i >= 0 else ""
        d = {}
        # | 值 | 构造名 | 直译 | ... 直译为空时回退构造名
        for m in re.finditer(r"^\|\s*(\d+)\s*\|\s*(\w+)\s*\|\s*([^|]*?)\s*\|", block, re.M):
            d[m.group(1)] = m.group(3).strip() or m.group(2)
        _cn[key] = d


def table_kinds() -> list[str]:
    _load()
    return list(_enum_map["layouts"].keys())


def enum_map() -> dict:
    """ability_enum_map.json 原始内容(布局/块字段/枚举/使用计数),只读。"""
    _load()
    return _enum_map


# 五大枚举组 → ability_enum_map.json enums 键(词条工坊下拉用)
_BIG_ENUMS = {"precondition": "AbilityPreconditionMasterValue",
              "trigger": "InstantAbilityTriggerMasterValue",
              "during_trigger": "DuringAbilityTriggerMasterValue",
              "instant_content": "InstantAbilityContentMasterValue",
              "during_content": "CommonAbilityContentMasterValue"}


def enum_options() -> dict[str, dict[str, dict]]:
    """{组: {值: {en:构造名, cn:直译}}}。cn 缺失时回退构造名(与 describe 同源)。"""
    _load()
    out = {}
    for key, ename in _BIG_ENUMS.items():
        cn = _cn.get(key, {})
        out[key] = {v: {"en": en, "cn": cn.get(v, "")}
                    for v, en in _enum_map["enums"][ename].items()}
    return out


def layout(kind: str) -> dict:
    """某表的布局 {ncols, blocks:{块名:基址}}(来自 ability_enum_map.json)。"""
    _load()
    return _enum_map["layouts"][kind]


# ---------------------------------------------------------------- 数值格式化

def _num(v: str) -> int | None:
    v = (v or "").strip()
    if not v or v in ("true", "false") or not v.lstrip("-").isdigit():
        return None
    return int(v)


def _pct(v: int) -> str:
    return f"{v / 1000:g}%"


def _threshold(v: int) -> str:
    """阈值:十万=1次(层/个),否则按千分比。"""
    if v >= 100000 and v % 100000 == 0:
        return f"{v // 100000}"
    return _pct(v)


def _x100k_frames(v: int) -> str:
    sec = v / 100000 / 60
    return f"{sec:g}秒"


def _x100k_count(v: int) -> str:
    return f"{v / 100000:g}次"


def _endpoints(a: str, b: str, fmt) -> str:
    """SLv1→满级 端点;相等或缺一端时只显示一个。"""
    va, vb = _num(a), _num(b)
    if va is None and vb is None:
        return ""
    if va is None:
        return fmt(vb)
    if vb is None or va == vb:
        return fmt(va)
    return f"{fmt(va)}→{fmt(vb)}"


def _groups(v: str) -> str:
    v = (v or "").strip()
    if not v or v == "(None)":
        return ""
    return "/".join(GROUP_CN.get(t.strip(), t.strip()) for t in v.split("/") if t.strip())


# ---------------------------------------------------------------- 块描述

def _cell(row: list[str], i: int) -> str:
    v = row[i] if 0 <= i < len(row) else ""
    return "" if v == "(None)" else v


def _desc_precondition(row: list[str], b: int) -> str:
    kind = _cell(row, b).strip()
    if kind in ("", "0", "1"):  # Always / AlwaysWithoutConditionString
        return ""
    name = _cn["precondition"].get(kind, f"条件{kind}")
    s = name
    grp = _groups(_cell(row, b + 5))
    if grp:
        s = f"{grp}·{s}"
    th = _endpoints(_cell(row, b + 3), _cell(row, b + 4), _threshold)
    if th:
        s += f"≥{th}"
    puller = _num(_cell(row, b + 1))
    if puller:
        s += f"({PULLER_CN.get(puller, puller)})"
    uc = _cell(row, b + 6).strip()
    if uc not in ("", "0"):
        s += f"[固有{uc}]"
    return s


def _desc_trigger(row: list[str], b: int, enum_key: str) -> str:
    kind = _cell(row, b).strip()
    th = _endpoints(_cell(row, b + 3), _cell(row, b + 4), _threshold)
    if kind in ("", "0") and enum_key == "trigger" and not th:
        return ""  # Initial 且无阈值 = 常驻/开局生效,不值得占字
    if kind in ("", "0") and enum_key == "trigger":
        name = "开局"
    else:
        name = _cn[enum_key].get(kind or "0", f"触发{kind}")
    s = name
    grp = _groups(_cell(row, b + 9 if enum_key == "trigger" else b + 6))
    if grp:
        s = f"{grp}·{s}"
    if th:
        s += f"≥{th}"
    lim_off = 7 if enum_key == "trigger" else 5
    lim = _num(_cell(row, b + lim_off))
    if lim:
        s += f"(限{lim}次)"
    if enum_key == "trigger":
        ct = _num(_cell(row, b + 8))
        if ct:
            frames = ct / 100000 if ct >= 100000 else ct  # 两种存法都见过,大值按×100000
            s += f"(CT{frames / 60:g}秒)"
    uc_off = 10 if enum_key == "trigger" else 7
    uc = _cell(row, b + uc_off).strip()
    if uc not in ("", "0"):
        s += f"[固有{uc}]"
    return s


def _desc_precontent(row: list[str], b: int) -> str:
    kind = _cell(row, b).strip()
    # 块全空 = 无前置效果;kind=0(Combo) 仅在阈值非空时有意义
    th = _endpoints(_cell(row, b + 3), _cell(row, b + 4), _threshold)
    if kind in ("", "0") and not th:
        return ""
    k = _num(kind) or 0
    s = PRECONTENT_CN.get(k, f"前置效果{k}")
    if th:
        s += f" {th}"
    uc = _cell(row, b + 6).strip()
    if uc not in ("", "0"):
        s += f"[固有{uc}]"
    return s


def _desc_content(row: list[str], b: int, enum_key: str) -> str:
    """瞬发/持续效果块。enum_key: instant_content / during_content。"""
    is_instant = enum_key == "instant_content"
    probe_end = b + (14 if is_instant else 8)
    if all(not _cell(row, i).strip() for i in range(b, probe_end)):
        return ""
    kind = _cell(row, b).strip() or "0"
    name = _cn[enum_key].get(kind, f"效果{kind}")
    tgt = _num(_cell(row, b + 1)) or 0
    s = f"{name}"
    # 计数类效果(连击/次数/数量/层)强度按整数存(十万=1),其余按千分比
    flat = any(w in name for w in ("连击", "次数", "数量", "层"))
    fmt_stren = (lambda v: f"{v / 100000:g}") if flat and all(
        (_num(_cell(row, b + i)) or 0) % 100000 == 0 for i in (4, 5)) else _pct
    stren = _endpoints(_cell(row, b + 4), _cell(row, b + 5), fmt_stren)
    if stren:
        s += f" {stren}"
    s2 = _endpoints(_cell(row, b + 6), _cell(row, b + 7), _pct)
    if s2:
        s += f"(强度2 {s2})"
    if is_instant:
        s3 = _endpoints(_cell(row, b + 8), _cell(row, b + 9), _pct)
        if s3:
            s += f"(强度3 {s3})"
        frame = _endpoints(_cell(row, b + 10), _cell(row, b + 11), _x100k_frames)
        if frame:
            s += f"({frame})"
        cnt = _endpoints(_cell(row, b + 12), _cell(row, b + 13), _x100k_count)
        if cnt:
            s += f"×{cnt}"
        acc = _num(_cell(row, b + 14))
        if acc:
            s += f"[累积上限{acc}]"
        if _cell(row, b + 20).strip() == "1":
            s += "[不可驱散]"
        el = _num(_cell(row, b + 26))
        if el is not None and _cell(row, b + 26).strip() != "":
            s += f"[{ELEMENT_CN.get(el, el)}]"
        mt = _num(_cell(row, b + 28))
        if mt:
            add = _endpoints(_cell(row, b + 29), _cell(row, b + 29), _pct)
            s += f"[{MULTIPLY_CN.get(mt, mt)}倍增{('+' + add) if add else ''}]"
        sid = _cell(row, b + 23).strip()
        if sid and sid != "(None)":
            s += f"[{sid}]"
    else:
        el = _num(_cell(row, b + 10)) if _cell(row, b + 10).strip() != "" else None
        if el is not None:
            s += f"[{ELEMENT_CN.get(el, el)}]"
    grp = _groups(_cell(row, b + (19 if is_instant else 8)))
    tgt_grp = _groups(_cell(row, b + 2))
    tgt_s = TARGET_CN.get(tgt, str(tgt))
    if tgt_grp:
        tgt_s += f"({tgt_grp})"
    out = f"自身 {s}" if tgt_s == "自身" else f"赋予{tgt_s} {s}"
    if grp:
        out += f"[限{grp}]"
    return out


def _desc_opening(row: list[str], b: int) -> str:
    kind = _num(_cell(row, b))
    stren = _endpoints(_cell(row, b + 1), _cell(row, b + 2), _pct)
    if kind is None and not stren:
        return ""
    s = OPENING_CN.get(kind or 0, f"开幕{kind}")
    if stren:
        s += f" {stren}"
    return s


# ---------------------------------------------------------------- 行级入口

def describe_line(row: list[str], kind: str) -> str:
    """row=CSV 单行(list[str]),kind=layouts 键(ability/leader_ability/...)。"""
    _load()
    lay = _enum_map["layouts"].get(kind)
    if not lay:
        return ""
    B = lay["blocks"]
    trig_col = B["precondition1"] - 1  # 各表 trigger 都紧贴 precondition1 之前
    trig = _num(_cell(row, trig_col)) or 0
    parts = []

    # 觉醒标记(ability c3/c4,leader c1/c2)
    if kind == "ability":
        ak, al = _num(_cell(row, 3)), _cell(row, 4).strip()
    elif kind == "leader_ability":
        ak, al = _num(_cell(row, 1)), _cell(row, 2).strip()
    else:
        ak, al = None, ""
    # kind=1(Switch)+level=0 是觉醒前基础形态,不标;level≥1 才是觉醒后替换版
    lvl = _num(al) or 0
    if (ak == 1 and lvl >= 1) or ak == 2:
        parts.append(f"[觉醒{lvl}{'替换' if ak == 1 else '追加'}]")

    pres = [p for p in (_desc_precondition(row, B[f"precondition{i}"]) for i in (1, 2, 3)) if p]
    if pres:
        parts.append(" 且 ".join(pres) + " 时:")

    if trig == 2:
        op = _desc_opening(row, B["opening"])
        parts.append("开幕:" + op if op else "开幕效果")
    elif trig == 1:
        acc = _desc_trigger(row, B["during_accumulation_trigger"], "trigger") \
            if _cell(row, B["during_accumulation_trigger"]).strip() not in ("", "0") else ""
        dt = _desc_trigger(row, B["during_trigger"], "during_trigger")
        dc = _desc_content(row, B["during_content"], "during_content")
        seg = "持续·" + dt
        if acc:
            seg += f"(累积:{acc})"
        if dc:
            seg += " → " + dc
        parts.append(seg)
        if _cell(row, B["even_if_owner_dead"]).strip() == "true":
            parts.append("[倒下仍生效]")
    else:
        it = _desc_trigger(row, B["instant_trigger"], "trigger")
        pc = _desc_precontent(row, B["instant_precontent"])
        ic = _desc_content(row, B["instant_content"], "instant_content")
        delay = _num(_cell(row, B["instant_delay"]))
        seg = it
        if pc:
            seg += f"(需{pc})"
        if ic:
            seg = (seg + " → " + ic) if seg else ic
        if delay:
            seg += f"(延迟{delay / 60:g}秒)"
        parts.append(seg)

    return " ".join(p for p in parts if p).strip()


def describe_rows(rows: list[list[str]], kind: str) -> list[str]:
    return [describe_line(r, kind) for r in rows]


if __name__ == "__main__":
    # 自测:瓦格纳词条 + 队长技
    import sys, io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.path.insert(0, str(HERE))
    import wf_mod_tool as core
    prof = core.resolve_profile()
    store = prof.store
    ab = core.load_table("master/ability/ability.orderedmap", store, store)
    for key in ("1110011", "1110013", "1110016"):
        rows = core.read_csv_lines(ab.text_rows()[key])
        print(f"== ability {key} ==")
        for i, d in enumerate(describe_rows(rows, "ability"), 1):
            print(f"  行{i}: {d}")
    ld = core.load_table("master/ability/leader_ability.orderedmap", store, store)
    rows = core.read_csv_lines(ld.text_rows()["111001"])
    print("== leader 111001 ==")
    for i, d in enumerate(describe_rows(rows, "leader_ability"), 1):
        print(f"  行{i}: {d}")
