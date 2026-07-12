# -*- coding: utf-8 -*-
"""wf_unique_mech — 全属性独特机制挖掘与同属性下放建议。

独特 = 效果枚举/触发枚举的全局持有角色数 ≤ RARE_N(默认4)。
对每属性输出:独特机制菜单(持有者+行描述+全局持有数) + 下放接收建议(同属性未达标角色,
同流派优先)。样板:缪341005 连击→技能槽;花火111015 过充体系(2号位槽/技能最大触发/满槽充能)。
只分析,不改数据。
"""
from __future__ import annotations

import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

MOD_DIR = Path(__file__).resolve().parent
ROOT = MOD_DIR.parent
sys.path.insert(0, str(MOD_DIR))
import wf_mod_tool as core  # noqa: E402
import wf_describe  # noqa: E402

ELEM_CN = ["火", "水", "雷", "风", "光", "暗"]
RARE_N = 4
# 泛用/无聊枚举不入菜单(即使稀有度低)
BORING_IC = {"", "0", "1", "32", "34", "55", "33", "214", "211", "388", "486", "28"}
BORING_DC = {"", "0", "1", "2", "3", "23", "154", "18"}
OUT_MD = MOD_DIR / "docs" / "全属性独特机制挖掘与下放.md"


def pad(r, n=126):
    return r + [""] * (n - len(r)) if len(r) < n else r


SIGVALS = {str(v * 1000) for v in (8, 10, 12, 15, 16, 20, 23, 24, 30)}


def is_sig(row):
    row = pad(row)
    return (row[5] == "1" and row[97] in ("1", "4") and row[110] == "0"
            and row[113] == row[114] and row[113] in SIGVALS and row[85] == "(None)")


def main() -> None:
    prof = core.resolve_profile()
    store = prof.store
    ch = json.loads((ROOT / "assets/cdndata/character.json").read_text(encoding="utf-8"))
    tx = json.loads((ROOT / "assets/cdndata/character_text.json").read_text(encoding="utf-8"))
    ab = core.load_table(core.ABILITY_LOGICAL, store)
    parsed = {k: core.read_csv_lines(t) for k, t in ab.text_rows().items()}
    wf_describe._load()
    blade = {}
    try:
        allj = json.loads((ROOT / "logs" / "all_analysis.json").read_text(encoding="utf-8"))
        for el_cn, rows in allj["elements"].items():
            for c in rows:
                blade[c["id"]] = c
    except Exception:
        pass

    roster = []
    for cid, rows in ch.items():
        r = core.normalize_row_length(rows[0], 37)
        try:
            rar, el = int(r[2]), int(r[3])
        except ValueError:
            continue
        if rar < 3 or 700000 <= int(cid) < 999999:
            continue
        roster.append({"id": cid, "rar": rar, "el": el,
                       "name": (tx.get(cid) or [["?"]])[0][0],
                       "abs": [x for x in (r[19 + i] for i in range(6)) if x and x != "(None)"]})

    # 全局稀有度:每个 ic/dc/触发 枚举的持有角色集合
    own_ic, own_dc, own_tr = defaultdict(set), defaultdict(set), defaultdict(set)
    for c in roster:
        for aid in c["abs"]:
            for row in parsed.get(aid, []):
                if is_sig(row):
                    continue
                row = pad(row)
                if row[47]:
                    own_ic[row[47]].add(c["id"])
                if row[109]:
                    own_dc[row[109]].add(c["id"])
                if row[27] not in ("", "0"):
                    own_tr[row[27]].add(c["id"])

    # 每属性菜单
    menus = {el: [] for el in range(6)}
    seen = {el: set() for el in range(6)}
    for c in roster:
        for si, aid in enumerate(c["abs"], 1):
            for li, row in enumerate(parsed.get(aid, []), 1):
                if is_sig(row):
                    continue
                row = pad(row)
                reasons = []
                ic, dc, tr = row[47], row[109], row[27]
                if ic and ic not in BORING_IC and len(own_ic[ic]) <= RARE_N:
                    reasons.append(f"效果枚举{ic}全服仅{len(own_ic[ic])}人")
                if dc and dc not in BORING_DC and len(own_dc[dc]) <= RARE_N:
                    reasons.append(f"持续枚举{dc}全服仅{len(own_dc[dc])}人")
                if tr not in ("", "0") and len(own_tr[tr]) <= RARE_N:
                    reasons.append(f"触发枚举{tr}全服仅{len(own_tr[tr])}人")
                if not reasons:
                    continue
                key = (ic, dc, tr)
                if key in seen[c["el"]]:
                    continue
                seen[c["el"]].add(key)
                d = wf_describe.describe_line(row, "ability")
                menus[c["el"]].append({"owner": c["name"], "oid": c["id"], "rar": c["rar"],
                                       "pos": f"能力{si}L{li}", "aid": aid, "line": li,
                                       "desc": d, "why": ";".join(reasons)})

    # ---- 逐人分发:每个未达标角色分到 1 项(五星初代 2 项);流派关键词匹配优先,每项机制最多服务 4 人
    FAM_KEY = {"skill": ("技能", "技伤"), "pf": ("弹射", "连击"), "direct": ("直击", "Direct", "追击"),
               "fever": ("Fever", "狂热"), "ability": ("能力伤害", "敌方")}
    # 依赖专属状态机/召唤物的行不能单独分发(整组移植另走龙兽组件库)
    DEP = ("固有", "贯通", "消耗", "切换", "发动技能动作", "Disguise", "多球", "Specific")
    assign = {el: [] for el in range(6)}
    for el in range(6):
        weak = [blade[c["id"]] for c in roster
                if c["el"] == el and c["id"] in blade and blade[c["id"]]["total"] < blade[c["id"]]["target"]]
        weak.sort(key=lambda c: c["total"] / max(1, c["target"]))
        served = Counter()
        menu = [m for m in menus[el] if not any(w in m["desc"] for w in DEP)]
        for c in weak:
            want = 2 if c["cohort"] == "5_gen1" else 1
            keys = FAM_KEY.get(c.get("family", ""), ())
            picks = []
            cand = sorted(menu, key=lambda m: (served[id(m)],
                                               0 if any(k in m["desc"] for k in keys) else 1))
            for m in cand:
                if m["oid"] == c["id"] or served[id(m)] >= 4:
                    continue
                picks.append(m)
                served[id(m)] += 1
                if len(picks) >= want:
                    break
            assign[el].append((c, picks))

    L = ["# 全属性独特机制挖掘·分发清单\n",
         "> 独特 = 效果/持续/触发枚举全服持有角色 ≤4 人(排除泛用枚举)。分发 = 每个未达标角色获得"
         " 1 项(五星初代 2 项)同属性独特机制,流派关键词匹配优先,每项最多服务 4 人;"
         "落地用 append_line_adapted,数值 0/5 化,次数上限按超大幅规则 ×5。\n",
         "## 样板(用户指定)\n",
         "- **缪 341005(风3星·兽)**「连击≥30→自身技能槽 6%」+「技能发动→状态DirectAttack2(5秒)追击」"
         "→ 下放全体风系连击/弹射流;追击态给直击流。\n",
         "- **花火 111015(火5星·星花忍者)过充体系**:「自身 **2号位技能槽100%**」、"
         "「**技能最大≥1**(过充触发)→全队(火)攻击」、「满槽时→充能+20%」"
         "→ 三件套下放火系技能伤害流;「2号位充电」火系辅助人手一行。\n",
         "## 暗系拉芙·独特补强(用户点名)\n",
         "### 161081 拉芙(5星·HW★暗夜少女)——技能连发引擎\n",
         "- 全套「技能发动(限4次)」→ **限 20 次**(超大幅 ×5):自身技伤 50/15/15、全队(暗)技伤 75、充能 4 全程无限叠\n",
         "- 移植·花火过充三件套(暗版):「2号位技能槽100%」+「技能最大≥1(限20次)→全队(暗)技能伤害+10%」+「满槽时充能+20%」\n",
         "- 队长L2/L3「限3次」→ **15 次**;专精 技能伤害+15%(常驻)\n",
         "### 263002 拉芙(4星·永夜女王)——全服唯一暗光双系辅助\n",
         "- 双属性行全保留并放大:暗/光两组条件行 ×1.25(0/5化);觉醒替换强档不动\n",
         "- **新增双系独立乘区**:「暗·编成≥6→全队(暗)独立乘区技能伤害+5%」+「光·编成≥6→全队(光)独立乘区技能伤害+5%」"
         "(拉夫马诺全队乘区行换 kind/元素,双行成对=永夜女王专属身份)\n",
         "- 机械特色高频化:能力6「机械·MySelf 技能发动(限1次)→技能槽30%」→ **限 5 次**;能力3L3 觉醒行「限5次」→ 25 次\n",
         "- 四星对齐五星通道照常(基础数值/词条对齐)\n"]
    for el in range(6):
        L.append(f"\n## {ELEM_CN[el]}系独特机制菜单({len(menus[el])}项)\n")
        for m in sorted(menus[el], key=lambda m: (-m["rar"], m["oid"]))[:18]:
            L.append(f"- **{m['owner']}**({m['rar']}星,{m['oid']}) {m['pos']}:{m['desc'][:90]}"
                     f" 〔{m['why']}〕")
        L.append(f"\n### {ELEM_CN[el]}系分发清单(未达标 {len(assign[el])} 人,逐人)\n")
        for c, picks in assign[el]:
            got = ";".join(f"{m['owner']}·{m['pos']}「{m['desc'][:40]}」" for m in picks) or "(菜单不足)"
            L.append(f"- {c['name']}({c['id']},{c['total']}/{c['target']}) ← {got}")
        L.append("")
    # ---- 武器/魂珠:数值同步 + 次数上限超大幅(统计口径,落地进 v3) ----
    soul = core.load_table("master/ability/ability_soul.orderedmap", store)
    wab = core.load_table("master/equipment_enhancement/equipment_enhancement_ability.orderedmap", store)
    stats = Counter()
    for tbl, ic_base, dc_base, name in ((soul, 44, 106, "魂珠"), (wab, 47, 109, "武器强化")):
        ilim = ic_base - 44 + 31 if name == "魂珠" else 34    # soul instant_trigger@24→limit c31;weapon=ability 布局 c34
        for k, t in tbl.text_rows().items():
            for row in core.read_csv_lines(t):
                row = pad(row)
                for base in (ic_base, dc_base):
                    for off in (4, 6, 8):   # strength/2/3 对
                        a, b = row[base + off], row[base + off + 1]
                        try:
                            if a not in ("", "(None)") and b not in ("", "(None)") and float(a) < float(b):
                                stats[f"{name}_sync"] += 1
                        except ValueError:
                            pass
                try:
                    if int(float(row[ilim])) >= 1:
                        stats[f"{name}_limit"] += 1
                except (ValueError, TypeError):
                    pass
    L.append("\n## 武器·魂珠(进 v3 落地)\n")
    L.append(f"1. **数值同步**:魂珠/武器强化词条全部强度对 `SLv1值 := 满级值`(低练度=本体满级)。"
             f"待同步强度对:魂珠 **{stats['魂珠_sync']}** 处、武器强化词条 **{stats['武器强化_sync']}** 处。\n")
    L.append(f"2. **次数上限超大幅**:装备侧「限N次」一律 ×5(封顶99)。命中:魂珠 **{stats['魂珠_limit']}** 行、"
             f"武器强化 **{stats['武器强化_limit']}** 行。角色侧(词条/队长技)同规则已并入 v2(LIMIT_FACTOR=5)。\n")
    OUT_MD.write_text("\n".join(L), encoding="utf-8")
    print(f"文档 → {OUT_MD}")
    # 机器可读分发清单(wf_balance_suite 消费)
    aj = []
    for el in range(6):
        for c, picks in assign[el]:
            for m in picks:
                aj.append({"dst": c["id"], "dst_name": c["name"], "el": el,
                           "src_aid": m["aid"], "src_line": m["line"],
                           "src_owner": m["owner"], "desc": m["desc"][:60]})
    (ROOT / "logs" / "unique_assign.json").write_text(
        json.dumps(aj, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"分发 JSON → logs/unique_assign.json ({len(aj)} 条)")
    print("武器魂珠统计:", dict(stats))
    for el in range(6):
        print(ELEM_CN[el], "菜单", len(menus[el]), "项,分发", len(assign[el]), "人")


if __name__ == "__main__":
    main()
