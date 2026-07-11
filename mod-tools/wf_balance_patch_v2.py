# -*- coding: utf-8 -*-
"""wf_balance_patch_v2 — 平衡补丁 v2.0(2026-07-09,按用户反馈重设计)。

相对 v1 的变化:
  1. 专精行不再"一属性一方向",改为**按角色自身词条判定流派**
     (技能伤害/强化弹射/fever/协力球·直击/能力伤害),每属性各流派都有代表。
     v1 加的 473 条属性专精行精确移除,替换为流派专精行。
  2. 三星/四星词条数值+队长技 → **逐效果向五星中位数对齐**(只升不降,封顶×2,
     留 5% 死区);基础数值目标提到基线 95%(cap 四星×1.35/三星×1.55)。
  3. 全角色 QoL(词条+队长技,解决"冷却太长/暖脚太久/次数限制"):
     - 触发冷却 ×0.6(≥1)
     - 增益次数上限 ×2 / 最大累积层数 ×1.5(向上取整)
     - 计数型启动阈值(≥2次,×100000 整倍)×0.7(最低1次)
  4. 点名额外强化(火罗尔夫/风罗尔夫/玛格诺斯/瓦格纳/火水三星克劳斯/光莉莉丝):
     自身词条+队长技全部强度 ×1.25,专精值 +8 个百分点。
  5. Boss:从 v1 备份取**原值** ×2.5(clamp 2^31 内);纯演武(score_attack 专属)
     与无限血量档(原值≥1e8)**还原原值**(撤销 v1 的×1.5)。

默认 dry-run,--apply 写入(自动备份);发布另跑 wf_publish。
"""
from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

MOD_DIR = Path(__file__).resolve().parent
ROOT = MOD_DIR.parent
sys.path.insert(0, str(MOD_DIR))
import wf_mod_tool as core  # noqa: E402
import wf_quest_lib as qlib  # noqa: E402
import wf_boss  # noqa: E402

LEADER_LOGICAL = "master/ability/leader_ability.orderedmap"
BOSS_LEVEL = "master/battle/boss/boss_level.orderedmap"
NCOLS_AB = 126
NCOLS_LEAD = 124
MARKER = ROOT / "logs" / "balance_patch_v2_applied.json"
REPORT = ROOT / "logs" / "balance_patch_v2_report.json"

ELEM_CN = ["火", "水", "雷", "风", "光", "暗"]
FAM_CN = {"skill": "技能伤害", "pf": "弹射伤害", "fever": "Fever期间攻击力",
          "ability": "能力伤害", "direct": "直击(协力球)伤害"}
FAM_KIND = {"skill": "2", "pf": "23", "fever": "0", "ability": "154", "direct": "1"}
FAM_CAT = {"skill": "action_skill", "pf": "power_flip", "fever": "fever",
           "ability": "attack_common", "direct": "attack_common"}

TIER_SIG = {"5_gen1": 15, "5_gen2": 12, "5_gen3": 10, "5_base": 8, "4": 12, "3": 15}
NAMED_EXTRA = {"111001", "111007", "111129", "141159", "311025", "321005", "151045"}
NAMED_SIG_BONUS = 8       # 专精值 +8pp
NAMED_STR_FACTOR = 1.25   # 词条/队长技强度 ×1.25
BENCH_CAP = 2.0           # 3/4星向5星对齐的最大放大
BENCH_DEADBAND = 1.05
COOL_FACTOR = 0.6
LIMIT_FACTOR = 5      # 次数上限超大幅提升(用户 2026-07-09 指示,原 ×2)
LIMIT_CAP = 99
ACCUM_FACTOR = 1.5
COUNT_TH_FACTOR = 0.7
STAT_TARGET_34 = 0.95     # 3/4星基础数值目标 = 基线均值×95%
STAT_CAP = {"4": 1.35, "3": 1.55}
BOSS_FACTOR = 2.5
BOSS_HP_CLAMP = 2_100_000_000
INF_HP = 100_000_000

# v1 的属性→方向映射(用于精确重建并移除 v1 专精行)
V1_KIND = {0: ("2", "action_skill"), 1: ("3", "action_skill"), 2: ("1", "attack_common"),
           3: ("23", "power_flip"), 4: ("0", "fever"), 5: ("154", "attack_common")}
V1_TIER = {"5_gen1": 15, "5_gen2": 12, "5_gen3": 10, "5_base": 8, "4": 12, "3": 15}

# 流派判定信号表
DET_D = {"2": "skill", "23": "pf", "49": "pf", "50": "pf", "51": "pf", "18": "fever",
         "154": "ability", "1": "direct", "45": "direct", "46": "direct",
         "161": "direct", "162": "direct"}
DET_I = {"1": "skill", "34": "skill", "28": "pf", "55": "pf", "21": "fever", "50": "fever",
         "56": "fever", "181": "fever", "213": "fever", "246": "fever",
         "388": "ability", "486": "ability", "33": "direct", "214": "direct",
         "483": "direct", "484": "direct", "29": "direct", "30": "direct"}
for _k in list(range(269, 287)) + list(range(334, 352)) + list(range(370, 388)):
    DET_I[str(_k)] = "ability"
DET_CAT = {"action_skill": "skill", "power_flip": "pf", "fever": "fever"}
ELEM_DEF = {0: "skill", 1: "direct", 2: "direct", 3: "pf", 4: "fever", 5: "ability"}


def pad(row: list[str], n: int) -> list[str]:
    return row + [""] * (n - len(row)) if len(row) < n else row


def load_roster() -> dict[str, dict]:
    ch = json.loads((ROOT / "assets/cdndata/character.json").read_text(encoding="utf-8"))
    tx = json.loads((ROOT / "assets/cdndata/character_text.json").read_text(encoding="utf-8"))
    roster = {}
    for cid, rows in ch.items():
        r = core.normalize_row_length(rows[0], 37)
        try:
            rar, el = int(r[2]), int(r[3])
        except ValueError:
            continue
        if 700000 <= int(cid) < 999999 or rar < 3 or el not in range(6):
            continue
        roster[cid] = {"id": cid, "icid": int(cid), "rar": rar, "el": el, "code": r[0],
                       "name": (tx.get(cid) or [["?"]])[0][0],
                       "abs": [x for x in (r[19 + i] for i in range(6)) if x and x != "(None)"],
                       "skill": r[8] if r[8] and r[8] != "(None)" else r[0]}
    # cohort(与 v1 相同规则)
    for el in range(6):
        five = [c for c in roster.values() if c["el"] == el and c["rar"] == 5]
        regular = sorted((c for c in five if len(c["id"]) == 6 and c["id"][0] == "1" and c["id"][2] == "1"),
                         key=lambda c: c["icid"])
        baseline = {c["id"] for c in regular[-5:]}
        baseline |= {c["id"] for c in five if len(c["id"]) == 6 and c["id"][2] == "3"}
        baseline |= {c["id"] for c in five if c["id"] == "999999"}
        older = [c for c in regular if c["id"] not in baseline]
        third = max(1, (len(older) + 2) // 3)
        gen = {c["id"]: ("5_gen1" if i < third else ("5_gen2" if i < 2 * third else "5_gen3"))
               for i, c in enumerate(older)}
        for c in five:
            c["cohort"] = "5_base" if c["id"] in baseline else gen.get(c["id"], "5_gen1")
    for c in roster.values():
        if c["rar"] == 4:
            c["cohort"] = "4"
        elif c["rar"] == 3:
            c["cohort"] = "3"
    return roster


def build_sig_row(sid: str, kind: str, cat: str, pct: int, fever: bool) -> list[str]:
    row = [""] * NCOLS_AB
    row[0] = sid
    row[1] = "true"
    row[2] = cat
    row[3] = "0"
    row[5] = "1"
    row[6] = row[13] = row[20] = "0"
    row[85] = "(None)"
    if fever:
        row[97] = "4"
    else:
        row[97] = "1"
        row[98] = "0"
        row[100] = row[101] = "100000"
    row[108] = "false"
    row[109] = kind
    row[110] = "0"
    row[113] = row[114] = str(pct * 1000)
    return row


def v1_sig_row(sid: str, element: int, cohort: str) -> list[str]:
    kind, cat = V1_KIND[element]
    pct = V1_TIER[cohort] * (2 if element == 4 else 1)
    return build_sig_row(sid, kind, cat, pct, fever=(element == 4))


def detect_family(info, parsed, lparsed, skill_path) -> str:
    score = Counter()

    def scan(rows, ibase, dbase):
        for row in rows:
            row = pad(row, NCOLS_AB)
            f = DET_I.get(row[ibase])
            d = DET_D.get(row[dbase])
            if f:
                score[f] += 2
            if d:
                score[d] += 2
            c = DET_CAT.get(row[2])
            if c:
                score[c] += 1

    for aid in info["abs"]:
        if aid in parsed:
            scan(parsed[aid], 47, 109)
    if info["id"] in lparsed:
        scan(lparsed[info["id"]], 45, 107)
    if "multi_ball" in skill_path.get(info["skill"], ""):
        score["direct"] += 3
    if not score:
        return ELEM_DEF[info["el"]]
    top = score.most_common()
    best, pts = top[0]
    if len(top) > 1 and top[1][1] == pts and ELEM_DEF[info["el"]] in (top[0][0], top[1][0]):
        best = ELEM_DEF[info["el"]]
    return best


def scale_pair(row, i1, i2, factor, log, tag, rounder=round):
    """同时缩放 (power1, first_max) 数值对,保持成长形状。"""
    changed = False
    for i in (i1, i2):
        v = row[i]
        if v in ("", "(None)", "0"):
            continue
        try:
            f = float(v)
        except ValueError:
            continue
        nv = int(rounder(f * factor))
        if nv != int(f):
            row[i] = str(nv)
            changed = True
    if changed:
        log.append(tag)
    return changed


def qol_pass(row, base_off: int, log: list[str]) -> bool:
    """冷却/次数/累积/计数阈值 QoL。base_off=0(ability)/-2(leader)。
    列号依据 block_fields:instant_trigger@27 → th=c30-33,limit=c34,cool=c35;
    accumulation@85 → th=c88-91,limit=c92,cool=c93;during@97 → limit=c102。"""
    changed = False
    b = base_off
    # 冷却:instant_trigger c35 / accumulation c93
    for ci in (35 + b, 93 + b):
        v = row[ci]
        if v not in ("", "(None)", "0", "1"):
            try:
                f = float(v)
            except ValueError:
                continue
            nv = max(1, int(round(f * COOL_FACTOR)))
            if nv != int(f):
                row[ci] = str(nv)
                log.append(f"冷却c{ci} {int(f)}->{nv}")
                changed = True
    # 次数上限:instant c34 / accumulation c92 / during c102
    for ci in (34 + b, 92 + b, 102 + b):
        v = row[ci]
        if v not in ("", "(None)", "0"):
            try:
                iv = int(float(v))
            except ValueError:
                continue
            if iv >= 1:
                nv = min(LIMIT_CAP, iv * LIMIT_FACTOR)
                row[ci] = str(nv)
                log.append(f"次数上限c{ci} {iv}->{nv}")
                changed = True
    # 最大累积:instant_content c61
    ci = 61 + b
    v = row[ci]
    if v not in ("", "(None)", "0"):
        try:
            iv = int(float(v))
        except ValueError:
            iv = 0
        if iv >= 1:
            nv = math.ceil(iv * ACCUM_FACTOR)
            if nv != iv:
                row[ci] = str(nv)
                log.append(f"累积上限c{ci} {iv}->{nv}")
                changed = True
    # 计数型启动阈值(≥200000 且 ×100000 整倍):instant c30-33;accumulation c88-91
    for ci in (30 + b, 31 + b, 32 + b, 33 + b, 88 + b, 89 + b, 90 + b, 91 + b):
        v = row[ci]
        if v in ("", "(None)", "0"):
            continue
        try:
            f = float(v)
        except ValueError:
            continue
        if f >= 200000 and f % 100000 == 0:
            nv = max(100000, int(round(f * COUNT_TH_FACTOR / 100000)) * 100000)
            if nv != int(f):
                row[ci] = str(nv)
                log.append(f"计数阈值c{ci} {int(f)}->{nv}")
                changed = True
    return changed


def main() -> None:
    ap = argparse.ArgumentParser(description="平衡补丁 v2.0(按角色流派重设计)")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    dry = not args.apply
    if args.apply and MARKER.exists() and not args.force:
        sys.exit(f"v2 已应用过(marker: {MARKER})。确需重跑加 --force。")

    prof = core.resolve_profile()
    store = prof.store
    ts = time.strftime("%Y%m%d-%H%M%S")
    suffix = f".bak-wfmod-balv2-{ts}"
    report: dict = {"ts": ts, "dry_run": dry, "sections": {}}

    roster = load_roster()
    ab = core.load_table(core.ABILITY_LOGICAL, store)
    parsed = {k: core.read_csv_lines(t) for k, t in ab.text_rows().items()}
    lead = core.load_table(LEADER_LOGICAL, store)
    lparsed = {k: core.read_csv_lines(t) for k, t in lead.text_rows().items()}
    ask = core.load_action_skill_table(store)
    skill_path = {}
    for i, k in enumerate(ask.keys):
        ent = core.decode_action_skill_row(ask.rows[i])
        skill_path[k] = " ".join(f[2] for _lv, f in ent if len(f) > 2)

    use = Counter()
    ch_all = json.loads((ROOT / "assets/cdndata/character.json").read_text(encoding="utf-8"))
    for rows in ch_all.values():
        r = core.normalize_row_length(rows[0], 37)
        for x in set(a for a in (r[19 + i] for i in range(6)) if a and a != "(None)"):
            use[x] += 1

    # ---------- A1. 移除 v1 专精行(精确重建匹配) ----------
    removed = 0
    for c in roster.values():
        excl = [a for a in c["abs"] if use[a] == 1 and a in parsed]
        if not excl:
            continue
        dst = excl[0]
        sid = parsed[dst][0][0] if parsed[dst] and parsed[dst][0] else ""
        old = v1_sig_row(sid, c["el"], c["cohort"])
        before = len(parsed[dst])
        parsed[dst] = [r for r in parsed[dst] if r != old]
        removed += before - len(parsed[dst])
    print(f"A1. 移除 v1 属性专精行: {removed}")

    # ---------- A2. 流派判定 ----------
    fam_dist = Counter()
    for c in roster.values():
        c["family"] = detect_family(c, parsed, lparsed, skill_path)
        fam_dist[c["family"]] += 1
    print(f"A2. 流派分布: {dict(fam_dist)}")

    # ---------- A3. 五星强度基准(逐效果中位数,3/4星对齐用) ----------
    bench_ab: dict[tuple, list] = defaultdict(list)
    bench_ld: dict[tuple, list] = defaultdict(list)
    for c in roster.values():
        if c["rar"] != 5:
            continue
        for aid in c["abs"]:
            for row in parsed.get(aid, []):
                row = pad(row, NCOLS_AB)
                for base in (47, 109):
                    if row[base] != "":
                        try:
                            v = float(row[base + 5])
                            if v > 0:
                                bench_ab[(base, row[base])].append(v)
                        except ValueError:
                            pass
        for row in lparsed.get(c["id"], []):
            row = pad(row, NCOLS_LEAD)
            for base in (45, 107):
                if row[base] != "":
                    try:
                        v = float(row[base + 5])
                        if v > 0:
                            bench_ld[(base, row[base])].append(v)
                    except ValueError:
                        pass
    bench_ab = {k: statistics.median(v) for k, v in bench_ab.items() if len(v) >= 5}
    bench_ld = {k: statistics.median(v) for k, v in bench_ld.items() if len(v) >= 5}

    # ---------- A4. 词条改动:QoL(全员) + 3/4星对齐 + 点名×1.25 ----------
    stats = Counter()
    detail_named = []
    detail_bench = []
    for c in roster.values():
        named = c["id"] in NAMED_EXTRA
        for aid in c["abs"]:
            if aid not in parsed:
                continue
            for li, row in enumerate(parsed[aid]):
                row = pad(row, NCOLS_AB)
                parsed[aid][li] = row
                log: list[str] = []
                if qol_pass(row, 0, log):
                    stats["qol_rows"] += 1
                if c["rar"] in (3, 4):
                    for base in (47, 109):
                        key = (base, row[base])
                        if key in bench_ab and row[base] != "":
                            try:
                                cur = float(row[base + 5])
                            except ValueError:
                                continue
                            if cur > 0 and bench_ab[key] > cur * BENCH_DEADBAND:
                                f = min(BENCH_CAP, bench_ab[key] / cur)
                                if scale_pair(row, base + 4, base + 5, f, log,
                                              f"对齐5星 c{base+5}×{f:.2f}"):
                                    stats["bench_rows"] += 1
                                    if len(detail_bench) < 40:
                                        detail_bench.append(f"{c['name']} {aid}L{li+1} {log[-1]}")
                if named:
                    for base in (47, 109):
                        if row[base] != "":
                            if scale_pair(row, base + 4, base + 5, NAMED_STR_FACTOR, log,
                                          f"点名强化 c{base+5}×{NAMED_STR_FACTOR}"):
                                stats["named_rows"] += 1
                if log and named:
                    detail_named.append(f"{c['name']} {aid}L{li+1}: " + ";".join(log))
    print(f"A4. QoL 行 {stats['qol_rows']},3/4星对齐行 {stats['bench_rows']},点名强化行 {stats['named_rows']}")

    # ---------- A5. 追加流派专精行 ----------
    added = 0
    sig_detail = []
    for c in roster.values():
        excl = [a for a in c["abs"] if use[a] == 1 and a in parsed]
        if not excl:
            continue
        dst = excl[0]
        pct = TIER_SIG[c["cohort"]]
        if c["id"] in NAMED_EXTRA:
            pct += NAMED_SIG_BONUS
        fever = c["family"] == "fever"
        if fever:
            pct *= 2
        sid = parsed[dst][0][0] if parsed[dst] and parsed[dst][0] else ""
        new_row = build_sig_row(sid, FAM_KIND[c["family"]], FAM_CAT[c["family"]], pct, fever)
        if any(r == new_row for r in parsed[dst]):
            continue
        parsed[dst].append(new_row)
        added += 1
        sig_detail.append({"id": c["id"], "name": c["name"], "el": ELEM_CN[c["el"]],
                           "cohort": c["cohort"], "family": c["family"],
                           "effect": f"{FAM_CN[c['family']]}+{pct}%(常驻)", "dst": dst})
    print(f"A5. 流派专精行 +{added}")
    report["sections"]["ability"] = {"v1_removed": removed, "family_dist": dict(fam_dist),
                                     "qol_rows": stats["qol_rows"], "bench_rows": stats["bench_rows"],
                                     "named_rows": stats["named_rows"], "sig_added": added,
                                     "sig_detail": sig_detail, "bench_samples": detail_bench,
                                     "named_detail": detail_named}
    if not dry:
        ab.set_text_rows({k: core.write_csv_lines(rows) for k, rows in parsed.items()})
        print("   写入", core.write_table(ab, store, suffix))

    # ---------- B. 队长技:QoL(全员) + 3/4星对齐 + 点名×1.25 ----------
    lstats = Counter()
    ldetail = []
    for c in roster.values():
        rows = lparsed.get(c["id"])
        if not rows:
            continue
        named = c["id"] in NAMED_EXTRA
        for li, row in enumerate(rows):
            row = pad(row, NCOLS_LEAD)
            rows[li] = row
            log: list[str] = []
            if qol_pass(row, -2, log):
                lstats["qol"] += 1
            if c["rar"] in (3, 4):
                for base in (45, 107):
                    key = (base, row[base])
                    if key in bench_ld and row[base] != "":
                        try:
                            cur = float(row[base + 5])
                        except ValueError:
                            continue
                        if cur > 0 and bench_ld[key] > cur * BENCH_DEADBAND:
                            f = min(BENCH_CAP, bench_ld[key] / cur)
                            if scale_pair(row, base + 4, base + 5, f, log, f"队长技对齐 c{base+5}×{f:.2f}"):
                                lstats["bench"] += 1
            if named:
                for base in (45, 107):
                    if row[base] != "":
                        if scale_pair(row, base + 4, base + 5, NAMED_STR_FACTOR, log,
                                      f"点名 c{base+5}×{NAMED_STR_FACTOR}"):
                            lstats["named"] += 1
            if log and (named or len(ldetail) < 30):
                ldetail.append(f"{c['name']} L{li+1}: " + ";".join(log))
    print(f"B. 队长技 QoL {lstats['qol']} 行,3/4星对齐 {lstats['bench']} 行,点名 {lstats['named']} 行")
    report["sections"]["leader"] = {**{k: int(v) for k, v in lstats.items()}, "detail": ldetail}
    if not dry and sum(lstats.values()):
        lead.set_text_rows({k: core.write_csv_lines(rows) for k, rows in lparsed.items()})
        print("   写入", core.write_table(lead, store, suffix))

    # ---------- C. 3/4星基础数值 → 基线95%(在当前值上继续,只升不降) ----------
    st = core.load_status_table(store)
    decoded = {}
    lv100 = {}
    for i, k in enumerate(st.keys):
        entries = core.decode_status_row(st.rows[i])
        decoded[k] = entries
        for lv, hp, atk in entries:
            if lv == "100":
                lv100[k] = (hp, atk)
    base_avg = {}
    for el in range(6):
        bs = [lv100[c["id"]] for c in roster.values()
              if c["el"] == el and c["cohort"] == "5_base" and c["id"] in lv100]
        base_avg[el] = (sum(x[0] for x in bs) / len(bs), sum(x[1] for x in bs) / len(bs))
    stat_changed = 0
    stat_detail = []
    for c in roster.values():
        if c["rar"] not in (3, 4) or c["id"] not in lv100:
            continue
        cap = STAT_CAP[str(c["rar"])]
        th = base_avg[c["el"]][0] * STAT_TARGET_34
        ta = base_avg[c["el"]][1] * STAT_TARGET_34
        hp0, atk0 = lv100[c["id"]]
        fh = min(cap, max(1.0, th / hp0)) if hp0 else 1.0
        fa = min(cap, max(1.0, ta / atk0)) if atk0 else 1.0
        if fh == 1.0 and fa == 1.0:
            continue
        decoded[c["id"]] = [(lv, int(round(hp * fh)), int(round(atk * fa)))
                            for lv, hp, atk in decoded[c["id"]]]
        stat_changed += 1
        if len(stat_detail) < 30:
            stat_detail.append({"id": c["id"], "name": c["name"], "rar": c["rar"],
                                "hp": f"{hp0}->{int(round(hp0*fh))}", "atk": f"{atk0}->{int(round(atk0*fa))}"})
    print(f"C. 3/4星基础数值提升 {stat_changed} 个角色(目标=基线95%)")
    report["sections"]["status"] = {"changed": stat_changed, "detail": stat_detail}
    if not dry and stat_changed:
        for i, k in enumerate(st.keys):
            if k in decoded:
                st.rows[i] = core.encode_status_row(decoded[k])
        print("   写入", core.write_status_table(st, store, suffix))

    # ---------- D. Boss:原值×2.5,演武/无限档还原原值 ----------
    bak_dir = qlib.store_path(BOSS_LEVEL).parent
    baks = sorted(bak_dir.glob("*.bak-wfquest-*"))
    if not baks:
        sys.exit("找不到 boss_level 的 v1 备份(.bak-wfquest-*),无法取原值")
    orig_tree = qlib.load_table(BOSS_LEVEL, path=baks[0])   # 最早备份=原版
    tree = qlib.load_table(BOSS_LEVEL)
    score_only = set()
    r = wf_boss.quest_list("score_attack", limit=1000)
    sb = {b["key"] for q in r["rows"] for b in q["bosses"]}
    other = set()
    for cat in wf_boss.quest_cats():
        if not cat["exists"] or cat["alias"] == "score_attack":
            continue
        try:
            rr = wf_boss.quest_list(cat["alias"], limit=5000)
        except Exception:
            continue
        for q in rr["rows"]:
            for b in q["bosses"]:
                other.add(b["key"])
    score_only = sb - other
    boss_up = boss_restore = 0
    boss_detail = []
    for key, row in orig_tree.items():
        if not isinstance(row, str) or key not in tree:
            continue
        cells = row.split(",")
        while len(cells) < 13:
            cells.append("")
        col = 2 if cells[0] == "0" else 5
        try:
            ov = float(cells[col])
        except ValueError:
            continue
        if ov <= 0:
            continue
        excluded = key in score_only or ov >= INF_HP
        nv = int(ov) if excluded else min(BOSS_HP_CLAMP, int(round(ov * BOSS_FACTOR)))
        cur_cells = tree[key].split(",")
        while len(cur_cells) < 13:
            cur_cells.append("")
        if cur_cells[col] == str(nv):
            continue
        tag = "还原" if excluded else f"×{BOSS_FACTOR}"
        if len(boss_detail) < 25:
            boss_detail.append(f"{key} {cur_cells[col]}->{nv}({tag},原值{int(ov)})")
        cur_cells[col] = str(nv)
        tree[key] = ",".join(cur_cells)
        if excluded:
            boss_restore += 1
        else:
            boss_up += 1
    print(f"D. Boss 血量: {boss_up} 条原值×{BOSS_FACTOR},{boss_restore} 条演武/无限档还原原值")
    report["sections"]["boss"] = {"scaled": boss_up, "restored": boss_restore,
                                  "score_only": sorted(score_only), "detail": boss_detail}
    if not dry and (boss_up or boss_restore):
        print("   写入", qlib.save_table(BOSS_LEVEL, tree))

    REPORT.parent.mkdir(exist_ok=True)
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"报告 → {REPORT}")
    if not dry:
        MARKER.write_text(json.dumps({"ts": ts, "suffix": suffix}, ensure_ascii=False), encoding="utf-8")
        print("发布:python mod-tools/wf_publish.py --tables ability,leader_ability,character_status,boss_level")
    else:
        print("(dry-run,未写入)")


if __name__ == "__main__":
    main()
