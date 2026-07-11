# -*- coding: utf-8 -*-
"""wf_balance_patch — 全角色平衡性增强补丁 v1.0(2026-07)。

以各属性最后推出的五星(正编尾段5个+联动+特殊编号)为强度基线,把老角色拉向基线:

  A. ability   — ①全角色解除主位限制(c1 unisonable→true;c6/c13/c20 前置202→0)
                 ②每角色追加一条「属性专精」常驻词条(写入其第一个专属词条键):
                    火=技能伤害  水=技能充能  雷=直击(协力球)伤害
                    风=弹射伤害  光=Fever期间攻击力(×2值)  暗=能力伤害
                 常驻实现=During+HpLow≤100%(官方恒真先例 90020/90052);光=During+Fever(4)
  B. status    — 老角色 HP/ATK 向本属性基线均值靠拢:factor=clamp(target/cur,1,cap)
                 五星按世代 cap 1.20/1.12/1.06;四星 target=0.85×基线 cap1.15;三星 0.75×/1.18
  C. action_skill — 全部玩家角色技能能量 ×0.85(SLv1与满级,四舍五入,≥1)
  D. boss_level  — 全部 boss 血量基础值 ×1.5(hit/fix 两模式)

安全:默认 dry-run;--apply 写入(自动 .bak 备份);写入后落 marker,重复 --apply 需 --force。
发布:python mod-tools/wf_publish.py --tables ability,character_status,action_skill,boss_level
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter
from pathlib import Path

MOD_DIR = Path(__file__).resolve().parent
ROOT = MOD_DIR.parent
sys.path.insert(0, str(MOD_DIR))
import wf_mod_tool as core  # noqa: E402
import wf_quest_lib as qlib  # noqa: E402

BOSS_LEVEL = "master/battle/boss/boss_level.orderedmap"
NCOLS = 126
MARKER = ROOT / "logs" / "balance_patch_v1_applied.json"
REPORT = ROOT / "logs" / "balance_patch_v1_report.json"

ELEM_CN = ["火", "水", "雷", "风", "光", "暗"]

# 属性专精:element -> (during_content kind, 词条类别串, 中文说明)
SIG_KIND = {
    0: ("2", "action_skill", "技能伤害"),
    1: ("3", "action_skill", "技能充能效率"),
    2: ("1", "attack_common", "直击(协力球)伤害"),
    3: ("23", "power_flip", "弹射伤害"),
    4: ("0", "fever", "Fever期间攻击力"),
    5: ("154", "attack_common", "能力伤害"),
}

# 分层参数:cohort -> (HP/ATK涨幅上限cap, 专精强度%)
TIER = {
    "5_gen1": (1.20, 15),
    "5_gen2": (1.12, 12),
    "5_gen3": (1.06, 10),
    "5_base": (1.00, 8),   # 基线:数值不动,仍给小额专精
    "4": (1.15, 12),
    "3": (1.18, 15),
}
TARGET_RATIO = {"5": 1.00, "4": 0.85, "3": 0.75}  # 各稀有度 status 目标=基线均值×比例
ENERGY_FACTOR = 0.85
BOSS_HP_FACTOR = 1.5


def load_roster() -> list[dict]:
    """rarity>=3 的玩家角色(排除 700xxx 助战);含六槽词条/技能键/元素/世代分层。"""
    ch = json.loads((ROOT / "assets/cdndata/character.json").read_text(encoding="utf-8"))
    tx = json.loads((ROOT / "assets/cdndata/character_text.json").read_text(encoding="utf-8"))
    roster = []
    for cid, rows in ch.items():
        r = core.normalize_row_length(rows[0], 37)
        try:
            rar, el = int(r[2]), int(r[3])
        except ValueError:
            continue
        icid = int(cid)
        if 700000 <= icid < 999999 or rar < 3 or el not in range(6):
            continue
        roster.append({
            "id": cid, "icid": icid, "code": r[0], "rarity": rar, "element": el,
            "name": (tx.get(cid) or [["?"]])[0][0],
            "abilities": [x for x in (r[19 + i] for i in range(6)) if x and x != "(None)"],
            "skill_key": (r[8] if r[8] and r[8] != "(None)" else r[0]),
        })
    return roster


def classify(roster: list[dict]) -> None:
    """打 cohort 标签。五星:正编(1x1xxx)尾段5个+联动(1x3xxx)+999999=基线;其余按序三等分。"""
    for el in range(6):
        five = [c for c in roster if c["element"] == el and c["rarity"] == 5]
        regular = sorted((c for c in five if len(c["id"]) == 6 and c["id"][0] == "1" and c["id"][2] == "1"),
                         key=lambda c: c["icid"])
        baseline = set(c["id"] for c in regular[-5:])
        baseline |= {c["id"] for c in five if len(c["id"]) == 6 and c["id"][2] == "3"}  # 联动
        baseline |= {c["id"] for c in five if c["id"] == "999999"}
        older = [c for c in regular if c["id"] not in baseline]
        third = max(1, (len(older) + 2) // 3)
        gen = {}
        for i, c in enumerate(older):
            gen[c["id"]] = "5_gen1" if i < third else ("5_gen2" if i < 2 * third else "5_gen3")
        for c in five:
            if c["id"] in baseline:
                c["cohort"] = "5_base"
            elif c["id"] in gen:
                c["cohort"] = gen[c["id"]]
            else:
                c["cohort"] = "5_gen1"  # 非正编非基线(如主角 alk)=初代
    for c in roster:
        if c["rarity"] == 4:
            c["cohort"] = "4"
        elif c["rarity"] == 3:
            c["cohort"] = "3"


def build_sig_row(sid: str, element: int, pct: int) -> list[str]:
    """构造属性专精常驻词条行(骨架=官方恒真行 90052 / Fever 行 2310032L2)。"""
    kind, cat, _label = SIG_KIND[element]
    row = [""] * NCOLS
    row[0] = sid          # string_id 沿用目标键首行(与 GUI append_line_adapted 同法)
    row[1] = "true"       # 协力位可用
    row[2] = cat
    row[3] = "0"          # 非觉醒行
    row[5] = "1"          # During
    row[6] = row[13] = row[20] = "0"   # 无前置条件
    row[85] = "(None)"
    if element == 4:      # 光:Fever期间生效
        row[97] = "4"
    else:                 # 其余:HpLow≤100% 恒真=常驻
        row[97] = "1"
        row[98] = "0"
        row[100] = row[101] = "100000"
    row[108] = "false"
    row[109] = kind
    row[110] = "0"        # 目标=自身
    row[113] = row[114] = str(pct * 1000)   # 1000=1%,SLv1=满级(不随技能等级变化)
    return row


def main() -> None:
    ap = argparse.ArgumentParser(description="全角色平衡性增强补丁 v1.0")
    ap.add_argument("--apply", action="store_true", help="写入(缺省 dry-run)")
    ap.add_argument("--force", action="store_true", help="忽略已应用 marker 强制再跑")
    args = ap.parse_args()
    dry = not args.apply

    if args.apply and MARKER.exists() and not args.force:
        sys.exit(f"已应用过(marker: {MARKER})。数值/能量/boss 会叠加,确需重跑加 --force。")

    prof = core.resolve_profile()
    if not prof:
        sys.exit("profiles.json 未配置 active 档案")
    store = prof.store
    ts = time.strftime("%Y%m%d-%H%M%S")
    suffix = f".bak-wfmod-balance-{ts}"
    report: dict = {"ts": ts, "dry_run": dry, "sections": {}}

    roster = load_roster()
    classify(roster)
    print(f"玩家角色 {len(roster)} 个(五星{sum(1 for c in roster if c['rarity']==5)}"
          f"/四星{sum(1 for c in roster if c['rarity']==4)}/三星{sum(1 for c in roster if c['rarity']==3)})")

    # ---------------- A. ability:主位解除 + 属性专精行 ----------------
    ab = core.load_table(core.ABILITY_LOGICAL, store)
    parsed = {k: core.read_csv_lines(t) for k, t in ab.text_rows().items()}

    use = Counter()
    ch_all = json.loads((ROOT / "assets/cdndata/character.json").read_text(encoding="utf-8"))
    for rows in ch_all.values():
        r = core.normalize_row_length(rows[0], 37)
        for x in set(a for a in (r[19 + i] for i in range(6)) if a and a != "(None)"):
            use[x] += 1

    unlock_rows = 0
    unlock_keys = set()
    sig_added = 0
    sig_skipped = 0
    sig_detail = []
    for c in roster:
        # A1 主位解除:该角色全部词条键
        for aid in c["abilities"]:
            if aid not in parsed:
                continue
            for row in parsed[aid]:
                changed = False
                if len(row) > 1 and row[1] == "false":
                    row[1] = "true"
                    changed = True
                for ci in (6, 13, 20):
                    if len(row) > ci and row[ci] == "202":
                        row[ci] = "0"
                        changed = True
                if changed:
                    unlock_rows += 1
                    unlock_keys.add(aid)
        # A2 属性专精行 → 第一个专属词条键
        excl = [a for a in c["abilities"] if use[a] == 1 and a in parsed]
        if not excl:
            sig_detail.append({"id": c["id"], "name": c["name"], "sig": None, "why": "无专属词条键"})
            continue
        dst = excl[0]
        cap, pct = TIER[c["cohort"]]
        if c["element"] == 4:
            pct *= 2  # 光:Fever 期间才生效,补偿×2
        sid = parsed[dst][0][0] if parsed[dst] and parsed[dst][0] else ""
        new_row = build_sig_row(sid, c["element"], pct)
        if any(r == new_row for r in parsed[dst]):
            sig_skipped += 1
            continue
        parsed[dst].append(new_row)
        sig_added += 1
        sig_detail.append({"id": c["id"], "name": c["name"], "element": ELEM_CN[c["element"]],
                           "cohort": c["cohort"], "dst_ability": dst,
                           "effect": f"{SIG_KIND[c['element']][2]}+{pct}%(常驻)"})
    print(f"A. 主位解除:{len(unlock_keys)} 键 {unlock_rows} 行;属性专精:+{sig_added} 行(跳过已存在 {sig_skipped})")
    report["sections"]["ability"] = {"unlock_keys": len(unlock_keys), "unlock_rows": unlock_rows,
                                     "sig_added": sig_added, "sig_skipped": sig_skipped,
                                     "detail": sig_detail}
    if not dry and (unlock_rows or sig_added):
        ab.set_text_rows({k: core.write_csv_lines(rows) for k, rows in parsed.items()})
        written = core.write_table(ab, store, suffix)
        print(f"   写入 {written}")

    # ---------------- B. character_status:HP/ATK 向基线靠拢 ----------------
    st = core.load_status_table(store)
    lv100 = {}
    decoded = {}
    for i, k in enumerate(st.keys):
        entries = core.decode_status_row(st.rows[i])
        decoded[k] = entries
        for lv, hp, atk in entries:
            if lv == "100":
                lv100[k] = (hp, atk)

    base_avg = {}
    for el in range(6):
        bs = [lv100[c["id"]] for c in roster
              if c["element"] == el and c.get("cohort") == "5_base" and c["id"] in lv100]
        base_avg[el] = (sum(x[0] for x in bs) / len(bs), sum(x[1] for x in bs) / len(bs))

    stat_changed = 0
    stat_detail = []
    for c in roster:
        if c["cohort"] == "5_base" or c["id"] not in lv100:
            continue
        cap, _pct = TIER[c["cohort"]]
        if cap <= 1.0:
            continue
        tr = TARGET_RATIO[str(c["rarity"])]
        th, ta = base_avg[c["element"]][0] * tr, base_avg[c["element"]][1] * tr
        hp0, atk0 = lv100[c["id"]]
        fh = min(cap, max(1.0, th / hp0)) if hp0 else 1.0
        fa = min(cap, max(1.0, ta / atk0)) if atk0 else 1.0
        if fh == 1.0 and fa == 1.0:
            continue
        decoded[c["id"]] = [(lv, int(round(hp * fh)), int(round(atk * fa)))
                            for lv, hp, atk in decoded[c["id"]]]
        stat_changed += 1
        stat_detail.append({"id": c["id"], "name": c["name"], "cohort": c["cohort"],
                            "hp": f"{hp0}->{int(round(hp0*fh))}(×{fh:.3f})",
                            "atk": f"{atk0}->{int(round(atk0*fa))}(×{fa:.3f})"})
    print(f"B. HP/ATK 调整 {stat_changed} 个角色(基线均值目标,涨幅封顶,不降低)")
    report["sections"]["status"] = {"changed": stat_changed,
                                    "base_avg": {ELEM_CN[e]: [round(v) for v in base_avg[e]] for e in base_avg},
                                    "detail": stat_detail}
    if not dry and stat_changed:
        for i, k in enumerate(st.keys):
            if k in decoded:
                st.rows[i] = core.encode_status_row(decoded[k])
        written = core.write_status_table(st, store, suffix)
        print(f"   写入 {written}")

    # ---------------- C. action_skill:技能能量 ×0.85 ----------------
    ask = core.load_action_skill_table(store)
    C = core.ACTION_SKILL_COLUMNS
    keys_done = set()
    energy_changed = 0
    energy_detail = []
    for c in roster:
        k = c["skill_key"]
        if k in keys_done or k not in ask.keys:
            continue
        keys_done.add(k)
        ki = ask.keys.index(k)
        entries = core.decode_action_skill_row(ask.rows[ki])
        changed = False
        log = []
        new_entries = []
        for lv, fields in entries:
            f = list(fields)
            if len(f) > C["max_skill_weight"]:
                for col in (C["min_skill_weight"], C["max_skill_weight"]):
                    try:
                        v = int(f[col])
                    except ValueError:
                        continue
                    nv = max(1, int(round(v * ENERGY_FACTOR)))
                    if nv != v:
                        f[col] = str(nv)
                        changed = True
                        log.append(f"lv{lv} c{col} {v}->{nv}")
            new_entries.append((lv, f))
        if changed:
            energy_changed += 1
            energy_detail.append({"key": k, "log": ";".join(log)})
            if not dry:
                ask.rows[ki] = core.encode_action_skill_row(new_entries)
    print(f"C. 技能能量 ×{ENERGY_FACTOR}:{energy_changed} 个技能键")
    report["sections"]["action_skill"] = {"changed": energy_changed, "detail": energy_detail}
    if not dry and energy_changed:
        written = core.write_action_skill_table(ask, store, suffix)
        print(f"   写入 {written}")

    # ---------------- D. boss_level:血量 ×1.5 ----------------
    tree = qlib.load_table(BOSS_LEVEL)
    boss_changed = 0
    boss_detail = []
    for key, row in tree.items():
        if not isinstance(row, str):
            continue
        cells = row.split(",")
        while len(cells) < 13:
            cells.append("")
        col = 2 if cells[0] == "0" else 5
        try:
            v = float(cells[col])
        except ValueError:
            continue
        if v <= 0:
            continue
        nv = int(round(v * BOSS_HP_FACTOR))
        if nv == v:
            continue
        boss_detail.append({"key": key, "hp": f"{cells[col]}->{nv}"})
        cells[col] = str(nv)
        tree[key] = ",".join(cells)
        boss_changed += 1
    print(f"D. Boss 血量 ×{BOSS_HP_FACTOR}:{boss_changed} 条")
    report["sections"]["boss"] = {"changed": boss_changed, "detail": boss_detail[:20],
                                  "total_detail_truncated": len(boss_detail) > 20}
    if not dry and boss_changed:
        written = qlib.save_table(BOSS_LEVEL, tree)
        print(f"   写入 {written}")

    REPORT.parent.mkdir(exist_ok=True)
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"报告 → {REPORT}")
    if not dry:
        MARKER.write_text(json.dumps({"ts": ts, "suffix": suffix}, ensure_ascii=False), encoding="utf-8")
        print(f"marker → {MARKER}")
        print("下一步发布:python mod-tools/wf_publish.py --tables ability,character_status,action_skill,boss_level")
    else:
        print("(dry-run,未写入;--apply 执行)")


if __name__ == "__main__":
    main()
