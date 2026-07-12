# -*- coding: utf-8 -*-
"""wf_fire_analysis — 火系全角色强度分析(刃值口径)+逐角色增强方案生成。

刃值口径(与用户算例校准,瓦格纳=队170/面板205,炎之守护者莉莉丝队长技=500):
  计入 = 基础行(觉醒等级列 c4∈'',0)中,效果中文名含「攻击力」或本流派伤害词
        (技能伤害/强化弹射×伤害|特攻/直接攻击|直击/能力伤害)的强度满级值%,
        暖机类 × 触发次数上限(instant c34/leader c32)或累积上限。
  不计 = 技能槽/治疗/连击数↓/贯通延长/Fever点等 → 列为「机制项」。
只分析,不改数据。输出 md + json。
"""
from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

MOD_DIR = Path(__file__).resolve().parent
ROOT = MOD_DIR.parent
sys.path.insert(0, str(MOD_DIR))
import wf_mod_tool as core  # noqa: E402
import wf_describe  # noqa: E402

LEADER_LOGICAL = "master/ability/leader_ability.orderedmap"
OUT_MD = MOD_DIR / "docs" / "火系全角色分析与增强方案.md"
OUT_JSON = ROOT / "logs" / "fire_analysis.json"

FAM_CN = {"skill": "技能伤害", "pf": "强化弹射", "fever": "Fever", "ability": "能力伤害", "direct": "直击(协力球)"}
FAMILY_OVERRIDE = {"111183": "skill",   # 炎龙王:强化弹射触发的技能伤害堆叠(用户确认)
                   "111004": "fever"}   # 盛装女仆:Fever点辅助定位
NAMED = {"111001", "111007", "111129", "311025"}  # 火系点名(另有风罗尔夫/水克劳斯/光莉莉丝不在火表)

# 目标刃值 = 基线组中位 × 系数
TARGET_RATIO = {"5_gen1": 0.85, "5_gen2": 0.88, "5_gen3": 0.92, "5_base": 1.0, "4": 0.80, "3": 0.72}
SCALE_CAP = 2.5

DET_D = {"2": "skill", "23": "pf", "49": "pf", "50": "pf", "51": "pf", "18": "fever",
         "154": "ability", "1": "direct", "45": "direct", "46": "direct",
         "161": "direct", "162": "direct"}
DET_I = {"1": "skill", "34": "skill", "28": "pf", "55": "pf", "21": "fever", "50": "fever",
         "56": "fever", "181": "fever", "213": "fever", "246": "fever",
         "388": "ability", "486": "ability", "33": "direct", "214": "direct",
         "483": "direct", "484": "direct", "29": "direct", "30": "direct", "153": "pf"}
for _k in list(range(269, 287)) + list(range(334, 352)) + list(range(370, 388)):
    DET_I[str(_k)] = "ability"
DET_CAT = {"action_skill": "skill", "power_flip": "pf", "fever": "fever"}

SIGVALS = {str(v * 1000) for v in (8, 10, 12, 15, 16, 20, 23, 24, 30)}


def pad(r, n=126):
    return r + [""] * (n - len(r)) if len(r) < n else r


def is_v1sig(row):
    row = pad(row)
    return (row[5] == "1" and row[97] in ("1", "4") and row[110] == "0"
            and row[113] == row[114] and row[113] in SIGVALS and row[85] == "(None)"
            and row[100] in ("100000", ""))


def fam_terms_hit(name: str, fam: str) -> bool:
    if "↓" in name or "延长" in name or "无效" in name:
        return False
    if fam == "skill":
        return "技能伤害" in name
    if fam == "pf":
        return "强化弹射" in name and ("伤害" in name or "特攻" in name)
    if fam == "direct":
        return "直接攻击" in name or "直击" in name
    if fam == "ability":
        return "能力伤害" in name
    if fam == "fever":
        return False  # fever 流派靠攻击力(fever中)与Fever点机制,伤害词不单列
    return False


def main() -> None:
    prof = core.resolve_profile()
    store = prof.store
    ch = json.loads((ROOT / "assets/cdndata/character.json").read_text(encoding="utf-8"))
    tx = json.loads((ROOT / "assets/cdndata/character_text.json").read_text(encoding="utf-8"))
    ab = core.load_table(core.ABILITY_LOGICAL, store)
    parsed = {k: core.read_csv_lines(t) for k, t in ab.text_rows().items()}
    lead = core.load_table(LEADER_LOGICAL, store)
    lparsed = {k: core.read_csv_lines(t) for k, t in lead.text_rows().items()}
    ask = core.load_action_skill_table(store)
    skill_info = {}
    for i, k in enumerate(ask.keys):
        ent = core.decode_action_skill_row(ask.rows[i])
        skill_info[k] = {"path": " ".join(f[2] for _l, f in ent if len(f) > 2),
                         "desc": (ent[-1][1][1] if ent and len(ent[-1][1]) > 1 else "")}

    wf_describe._load()
    cn_i = wf_describe._cn["instant_content"]
    cn_d = wf_describe._cn["during_content"]

    roster = []
    for cid, rows in ch.items():
        r = core.normalize_row_length(rows[0], 37)
        try:
            rar, el = int(r[2]), int(r[3])
        except ValueError:
            continue
        if el != 0 or rar < 3 or (700000 <= int(cid) < 999999):
            continue
        roster.append({"id": cid, "icid": int(cid), "rar": rar, "code": r[0], "role": r[26],
                       "name": (tx.get(cid) or [["?"]])[0][0],
                       "title": (tx.get(cid) or [[""] * 4])[0][3] if len(tx.get(cid, [[""]])[0]) > 3 else "",
                       "abs": [x for x in (r[19 + i] for i in range(6)) if x and x != "(None)"],
                       "skill": r[8] if r[8] and r[8] != "(None)" else r[0]})
    # cohort
    five = [c for c in roster if c["rar"] == 5]
    regular = sorted((c for c in five if len(c["id"]) == 6 and c["id"][2] == "1"), key=lambda c: c["icid"])
    baseline = {c["id"] for c in regular[-5:]} | {c["id"] for c in five if len(c["id"]) == 6 and c["id"][2] == "3"} \
        | {c["id"] for c in five if c["id"] == "999999"}
    older = [c for c in regular if c["id"] not in baseline]
    third = max(1, (len(older) + 2) // 3)
    gen = {c["id"]: ("5_gen1" if i < third else ("5_gen2" if i < 2 * third else "5_gen3"))
           for i, c in enumerate(older)}
    for c in roster:
        if c["rar"] == 4:
            c["cohort"] = "4"
        elif c["rar"] == 3:
            c["cohort"] = "3"
        else:
            c["cohort"] = "5_base" if c["id"] in baseline else gen.get(c["id"], "5_gen1")

    # family
    for c in roster:
        score = Counter()
        for aid in c["abs"]:
            for row in parsed.get(aid, []):
                row = pad(row)
                if is_v1sig(row):
                    continue
                f = DET_I.get(row[47]); d = DET_D.get(row[109])
                if f:
                    score[f] += 2
                if d:
                    score[d] += 2
                cc = DET_CAT.get(row[2])
                if cc:
                    score[cc] += 1
        for row in lparsed.get(c["id"], []):
            row = pad(row)
            f = DET_I.get(row[45]); d = DET_D.get(row[107])
            if f:
                score[f] += 2
            if d:
                score[d] += 2
        if "multi_ball" in skill_info.get(c["skill"], {}).get("path", ""):
            score["direct"] += 3
        c["family"] = FAMILY_OVERRIDE.get(c["id"]) or (score.most_common(1)[0][0] if score else "skill")

    # 刃值
    def row_value(row, fam, ibase, dbase, ilim, awake_col=4):
        """返回 (计入刃值, 机制项标记)。awake_col:ability=c4,leader=c2(整体-2)。"""
        row = pad(row)
        if row[awake_col] not in ("", "0"):     # 只算基础行(觉醒行不计)
            return 0.0, None
        val = 0.0
        note = None
        for base, cn in ((ibase, cn_i), (dbase, cn_d)):
            kind = row[base]
            if kind == "":
                continue
            name = cn.get(kind, f"效果{kind}")
            try:
                s = float(row[base + 5]) / 1000.0
            except ValueError:
                s = 0.0
            mult = 1
            if base == ibase:
                limv = row[ilim]
                try:
                    mult = max(1, int(float(limv)))
                except ValueError:
                    mult = 1
            hit = ("攻击力" in name and "↓" not in name and "延长" not in name) or fam_terms_hit(name, fam)
            if hit and s > 0:
                val += s * mult
            if any(w in name for w in ("技能槽", "治疗", "回复", "连击数", "贯通", "Fever", "状态固有", "消耗固有")):
                note = name
        return val, note

    fire = []
    for c in roster:
        fam = c["family"]
        panel = 0.0
        notes = []
        kit_lines = []
        counted = []
        mech = []
        for si, aid in enumerate(c["abs"], 1):
            for li, row in enumerate(parsed.get(aid, []), 1):
                if is_v1sig(row):
                    continue
                v, note = row_value(row, fam, 47, 109, 34)
                panel += v
                d = wf_describe.describe_line(row, "ability")
                kit_lines.append(f"能力{si}L{li}: {d}")
                if v > 0:
                    counted.append((f"能力{si}L{li}", round(v), d))
                if note:
                    notes.append(f"能力{si}L{li}: {d}")
                if pad(row)[4] in ("", "0"):
                    for m in mech_proposals(row, d, 34, 47):
                        mech.append(f"能力{si}L{li}: {m}")
        lval = 0.0
        for li, row in enumerate(lparsed.get(c["id"], []), 1):
            v, note = row_value(row, fam, 45, 107, 32, awake_col=2)
            lval += v
            d = wf_describe.describe_line(row, "leader_ability")
            kit_lines.append(f"队长L{li}: {d}")
            if v > 0:
                counted.append((f"队长L{li}", round(v), d))
            if note:
                notes.append(f"队长L{li}: {d}")
            if pad(row)[2] in ("", "0"):
                for m in mech_proposals(row, d, 32, 45):
                    mech.append(f"队长L{li}: {m}")
        c.update({"leader_blade": round(lval), "panel_blade": round(panel),
                  "total": round(lval + panel), "notes": notes, "kit": kit_lines,
                  "counted": counted, "mech": mech,
                  "skill_desc": skill_info.get(c["skill"], {}).get("desc", "")})
        fire.append(c)

    base_totals = sorted((c["total"] for c in fire if c["cohort"] == "5_base"), reverse=True)
    anchor = round(sum(base_totals[:3]) / 3)   # 基线头部三强均值(向炎之守护者档看齐)
    for c in fire:
        tgt = anchor * TARGET_RATIO[c["cohort"]]
        c["target"] = round(tgt)
        c["scale"] = round(min(SCALE_CAP, max(1.0, tgt / c["total"])), 2) if c["total"] > 0 else SCALE_CAP

    fire.sort(key=lambda c: (-c["rar"], c["icid"]))
    OUT_JSON.write_text(json.dumps(fire, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"火系角色 {len(fire)},基线组刃值(降序): {base_totals},头部锚点 {anchor}")
    for c in fire:
        print(f"{c['id']:7s} {c['name']:8s} {c['rar']}星 {c['cohort']:6s} {c['role']:9s} {FAM_CN[c['family']]:8s} "
              f"队{c['leader_blade']:4d}+面{c['panel_blade']:4d}={c['total']:4d} 目标{c['target']:4d} 建议×{c['scale']}")
    write_markdown(fire, anchor, base_totals)


def round05(pct: float) -> float:
    """数值卫生:百分比取 0/5 结尾(≥10 取 5 的倍数;<10 允许 2.5 步进)。"""
    if pct >= 10:
        return round(pct / 5) * 5
    return round(pct / 2.5) * 2.5 or 2.5


def mech_proposals(row, desc: str, ilim: int, ibase: int) -> list[str]:
    """机制词条强化引擎(充能/技能槽/延长/Fever/连击/追击/治疗/防御),数值 0/5 结尾。"""
    row = pad(row)
    out = []

    def stren(base):
        try:
            return float(row[base + 5]) / 1000.0
        except ValueError:
            return 0.0

    def limv():
        try:
            return int(float(row[ilim]))
        except ValueError:
            return 0

    d = stren(109 if ibase == 47 else 107)  # during strength
    i = stren(ibase)                        # instant strength
    lim = limv()
    if "技能槽充能" in desc:
        v = d or i
        if v:
            out.append(f"充能速度 {v:g}%→{round05(v*1.5):g}%")
    elif "技能槽" in desc and "→" in desc:
        if lim and lim <= 3:
            out.append(f"技能槽增益「限{lim}次」→**去掉次数限制**")
        elif lim:
            out.append(f"技能槽增益 限{lim}次→{lim*4}次,单次 {i:g}%→{round05(max(2.5, i*0.8)):g}%(次数大增/单次微降)")
        elif desc.startswith("自身 技能槽") and 0 < i < 100:
            out.append(f"开局技能槽 {i:g}%→**100%**(开局满槽)")
    if "延长" in desc:
        v = i or d
        if v:
            out.append(f"提升时间延长 {v:g}%→{round05(v*2):g}%")
    if "追加Fever点" in desc and i:
        out.append(f"Fever槽上升 {i:g}%→{round05(i*2):g}%")
    if "追加连击" in desc:
        try:
            cv = float(row[ibase + 5]) / 100000
            out.append(f"追加连击 {cv:g}→{cv+5:g}")
        except ValueError:
            pass
    if "连击数↓" in desc:
        try:
            cv = float(row[(109 if ibase == 47 else 107) + 5]) / 100000
            out.append(f"连击需求 ↓{cv:g}→↓{cv+3:g}")
        except ValueError:
            pass
    if ("治疗" in desc or "回复" in desc) and lim:
        out.append(f"治疗「限{lim}次」→{lim*2}次")
    return out


CUSTOM_PLAN = {
    "111001": [
        "暖机重做(用户指定):能力2「强化弹射≥5(限6次)攻击力15%」→ **≥3 次触发、每层 20%、上限 8 层**"
        "(暖满 90→160 刃,暖机速度约快一倍)",
        "能力5「强化弹射连击数↓2」→ **↓5**(与能力3的↓5 叠加共 -10 连击,PF Lv3 显著提速=独立乘区)",
        "能力4 开局技能槽 50% → **100%**(开局满槽)",
        "能力6「PF Lv3≥1(限5次)PF伤害8%」→ 限 **10** 次(40→80 刃)",
        "点名专精行:弹射伤害 +25%(常驻)",
    ],
    "111183": [
        "定位=技能伤害堆叠(用户确认,流派已改判 skill):全套「强化弹射≥3(限10次)」暖机 → **≥2 次、限 14 次**"
        "(攻击 20×10→20×14=280,技能伤害 20+6+7 → ×14 档)",
        "能力3L3「技能发动→状态攻击力 200%(20秒)」→ **30 秒**(减暖脚断档)",
        "已是基线头部(1375 刃),数值不再上调,只做暖机 QoL",
    ],
    "111004": [
        "Fever 辅助强化(用户指定):能力2 追加Fever点 2500% → **5000%**,能力4 1500% → **3000%**(充 Fever 快一倍)",
        "**新增 Fever 效果行**:Fever 期间 赋予全队(火) 攻击力 +20%(during_trigger=4,官方结构)",
        "能力3L2 全队治疗「限3次」→ **6 次**;能力3L3 技能伤害「限4次」→ 8 次;能力6「限3次」→ 6 次(v2 QoL ×2)",
        "能力5 全队攻击「限10次」→ 20 次",
    ],
    "111007": [
        "移植(用户指定):玛丽安 能力3「技能发动≥1 → 赋予全队(火) 技能槽 5%→10%」**下发给罗尔夫**"
        "(append_line_adapted,与自带的全队充能 15% 形成技能循环轴)",
        "能力1L2「编成直击≥20(限4次)攻击5%→10%」→ 限 **8** 次且阈值 20→**15**(暖机 40→80 刃)",
        "能力3L1「PF Lv3≥1(限5次)队长攻击12%」→ 限 **10** 次且单层 12%→**15%**(60→150 刃,专职给队长喂刀)",
        "能力6「PF Lv3≥3(CT15秒)技能槽10%」→ CT **10 秒**",
        "点名:全词条+队长技强度 ×1.25、专精 弹射+25%",
    ],
    "111129": [
        "技能后爆发窗口(10秒)全部 → **20 秒**(状态攻击力 125/200/50、减少暖脚焦虑)",
        "能力3 开局技能槽 50%→**100%**;两段「火·MySelf 技能伤害 125/50」按 ×1.25 点名放大",
        "有形态切换(能力6),增强只动数值不碰形态结构",
    ],
    "311025": [
        "三星突围样板(用户点名):能力1 开局技能槽 75%→**100%**、能力4 25%→50%",
        "眩晕畏缩特攻三段 30/30/5 → 逐效果对齐五星中位(约 ×1.6)并点名 ×1.25",
        "能力3「强化弹射连击数↓2」→ **↓4**;全攻击力行向 5 星对齐",
        "基础 HP/ATK 走三星→基线 95% 通道(cap ×1.55)",
    ],
    "111165": ["对标角色(炎之守护者):数值零改动,仅作为火系刃值标尺(队500+面776)"],
    "111002": ["海盗船协力球定位:专精走直击(协力球);船体召唤物伤害随直击伤害行放大"],
}


def write_markdown(fire, anchor, base_totals):
    L = []
    L.append("# 火系全角色分析与增强方案(刃值口径)\n")
    L.append("> 刃值 = 队长技+面板中「攻击力%+本流派伤害%」求和(暖机×次数上限;觉醒行不计;"
             "技能槽/治疗/连击数↓/贯通延长/Fever点列为机制项)。与用户算例校准:"
             "瓦格纳=队170+面205,炎之守护者莉莉丝队长技=500。\n")
    L.append(f"> 基线组刃值(降序):{base_totals};**目标锚点 = 头部三强均值 {anchor}**。"
             f"各层目标:五星初代 85% / 中期 88% / 近代 92% / 基线 100% / 四星 80% / 三星 72%;"
             f"单角色放大封顶 ×2.5。\n")
    L.append("## 全局规则(火系先行,后续推全属性)\n")
    L.append("1. **数值**:每角色「流派+攻击力」强度行统一 ×建议倍率(见下),补到目标刃值;辅助/治疗/坦克"
             "定位角色(Healer/Supporter/Tank)倍率减半执行,优先补机制而非伤害。\n"
             "2. **数值卫生**:所有改后数值取 **0/5 结尾**(≥10% 取 5 的倍数,<10% 允许 2.5 步进;次数/层数取整)。\n"
             "3. **机制词条引擎**(好玩优先):充能速度×1.5;技能槽增益「限≤3次」**直接去掉限制**、限≥4次 → 次数×4 且单次微降;"
             "提升时间(↑延长)×2;Fever槽上升率×2;追加连击 +5;连击需求↓ 再-3;治疗次数×2;触发冷却×0.6;计数阈值×0.7。\n"
             "4. **开局技能槽**:凡「开局技能槽+X%(X<100)」→ 一律 **+100%**(开局满槽)。\n"
             "5. **专精行**:按流派加常驻行(点名角色 25%)。\n"
             "6. **同体系下放**:头部成员特色词条复制给同流派弱势成员(见文末章节),用 append_line_adapted 实现。\n")
    coh_cn = {"5_gen1": "五星·初代", "5_gen2": "五星·中期", "5_gen3": "五星·近代",
              "5_base": "五星·基线", "4": "四星", "3": "三星"}
    role_cn = {"Attacker": "输出", "Balance": "均衡", "Healer": "治疗", "Jammer": "妨害",
               "Supporter": "辅助", "Tank": "坦克"}
    cur = None
    for c in fire:
        if c["cohort"] != cur:
            cur = c["cohort"]
            L.append(f"\n## {coh_cn[cur]}\n")
        L.append(f"### {c['id']} {c['name']}「{c['title']}」 — {coh_cn[c['cohort']]}·"
                 f"{role_cn.get(c['role'], c['role'])}·{FAM_CN[c['family']]}流\n")
        eff_scale = c["scale"] if c["role"] not in ("Healer", "Supporter", "Tank") \
            else round(1 + (c["scale"] - 1) / 2, 2)
        L.append(f"- **刃值**:队长 {c['leader_blade']} + 面板 {c['panel_blade']} = **{c['total']}**"
                 f"(目标 {c['target']},流派/攻击行 ×**{eff_scale}**"
                 f"{',辅助定位→伤害倍率减半,机制优先' if c['role'] in ('Healer','Supporter','Tank') else ''})")
        if c["counted"]:
            tops = sorted(c["counted"], key=lambda t: -t[1])[:4]
            L.append("- **数值方案**(0/5结尾):" + ";".join(
                f"{p} {v}→**{round05(v*eff_scale):g}**刃({d[:40]})" for p, v, d in tops))
        if c["mech"]:
            L.append("- **机制方案**:" + ";".join(c["mech"][:6]))
        elif c["notes"]:
            L.append("- **机制项**:" + ";".join(n[:60] for n in c["notes"][:4]))
        plan = CUSTOM_PLAN.get(c["id"])
        if plan:
            L.append("- **定制方案**:")
            for p in plan:
                L.append(f"  - {p}")
        L.append("")

    # ---- 同体系下放建议 ----
    L.append("\n## 同体系词条下放(复制给同流派弱势成员)\n")
    L.append("> 原则:每流派选头部成员最有特色的 1-2 行,append_line_adapted 复制给该流派刃值<70%目标的成员"
             "(自动适配元素/清觉醒门槛/unisonable=true)。\n")
    DEP = ("固有", "贯通", "消耗", "切换", "发动技能动作")   # 依赖专属状态机的行不下放
    for fam in ("skill", "pf", "direct", "fever", "ability"):
        members = [c for c in fire if c["family"] == fam]
        if not members:
            continue
        members.sort(key=lambda c: -c["total"])
        donor_rows = []
        donor = None
        for cand in members[:3]:   # 头部三人里找无依赖的特色行
            rows = [t for t in sorted(cand["counted"], key=lambda t: -t[1])
                    if not any(w in t[2] for w in DEP)][:2]
            if rows:
                donor, donor_rows = cand, rows
                break
        if not donor:
            continue
        weak = [c for c in members if c["total"] < c["target"] * 0.7 and c["id"] != donor["id"]]
        L.append(f"### {FAM_CN[fam]}流(头部:{donor['name']} {donor['id']},{donor['total']}刃)\n")
        for p, v, d in donor_rows:
            L.append(f"- 下放行:{donor['name']} {p}「{d[:60]}」")
        if weak:
            L.append(f"- 接收方({len(weak)}人):" + "、".join(c["name"] for c in weak[:14]) +
                     ("…" if len(weak) > 14 else ""))
        else:
            L.append("- 接收方:该流派火系暂无其他成员(玛丽安为唯一 Fever 定位时属正常)")
        L.append("")

    # ---- 跨属性先行单点(用户指定,非火系) ----
    L.append("\n## 附:跨属性先行单点(用户指定)\n")
    L.append("### 121003 水·艾莉亚「戏水的毽子板少女」— 连击技能伤害特色\n"
             "- 能力1L2「技能发动≥1(限3次)→技能槽 5%→10%」→ **去掉次数限制**(无限回转,连击轴成型)\n"
             "- 能力5L1「技能发动→追加连击 3→5」→ **追加连击 10**(喂连击=喂能力2暖机与全队连击组件)\n"
             "- 能力2L1「连击≥30(限6次)攻击 12.5%」→ 阈值 30→**20**,限 6→**12** 次(暖满 75→150 刃)\n"
             "- 能力1L3 充能 15%→**25%**;能力3L1 技伤「限8次」→16 次\n")
    L.append("### 121008 水·拉杰尔特「冲浪王子」— 承伤转能特色\n"
             "- 能力6「伤害计数≥15(限4次)→全队(水)技能槽 5%」→ 伤害计数 **15→10**、"
             "限 4→**20** 次、单次 5%→**4%**(总量 20%→80%,坦到就是赚)\n"
             "- 能力3「HP≥80% 强化弹射伤害 230%」阈值 80%→**50%**(高压副本更易保持)\n"
             "- 能力1L2 充能 15%→**25%**;能力1L1 全队屏障 15%→**20%**;能力4 全队HP 7%→**10%**\n")
    OUT_MD.write_text("\n".join(L), encoding="utf-8")
    print(f"文档 → {OUT_MD}")


if __name__ == "__main__":
    main()
