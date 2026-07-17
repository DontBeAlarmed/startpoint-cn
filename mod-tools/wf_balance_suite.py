# -*- coding: utf-8 -*-
"""wf_balance_suite — 全角色平衡增强总包(v3)一键执行器。

整合全部设计层(执行顺序即本序):
  1 移除 v1 属性专精行 → 2 解除主位限制 → 3 刃值倍率(统一封顶×2.5,0/5,辅助减半,点名×1.25 并入)
  → 4 机制引擎(开局槽满/充能×1.5/延长×2/Fever点×2/追加连击+5/连击↓+3/技能槽限≤3改(None)无限)
  → 5 QoL(冷却×0.6,光×0.5;次数上限×5 仅限技能槽/治疗等非伤害行;计数阈值×0.7;累积×2)
    * 伤害暖机行防双重放大:强度倍率降档≤1.5 且次数保持原值(点名角色由补丁表精确给值)
    * --force = 自动按 marker 还原上次备份再按新规则重跑(修正超模的标准路径)
  → 6 点名定制单元格补丁(最终绝对值) → 7 追加(流派专精行/独特机制分发445条/龙兽组件/合成行)
  → 8 三四星基础数值→基线95% → 9 Boss 原值×2.5(演武/无限档还原) → 10 武器魂珠(数值同步+上限×5)

平衡审查内置:同一行只吃一次统一倍率(bench/scale/点名取 max 后封顶 2.5);强度绝对上限
max(原值,500%);依赖行不参与单发;boss 从 v1 备份原值重算(不叠加);marker 防重复应用。

用法:
  python mod-tools/wf_balance_suite.py                # dry-run 全量统计
  python mod-tools/wf_balance_suite.py --apply        # 写入(自动备份)
  python mod-tools/wf_balance_suite.py --apply --publish   # 写入+发布 CDN
  python mod-tools/wf_balance_suite.py --export-pack  # 打可分享改动包(zip+说明)
前置:先跑 wf_all_analysis.py 与 wf_unique_mech.py(生成 logs/all_analysis.json / unique_assign.json)。
"""
from __future__ import annotations

import argparse
import json
import math
import shutil
import subprocess
import sys
import time
import zipfile
from collections import Counter
from pathlib import Path

MOD_DIR = Path(__file__).resolve().parent
ROOT = MOD_DIR.parent
sys.path.insert(0, str(MOD_DIR))
import wf_mod_tool as core  # noqa: E402
import wf_quest_lib as qlib  # noqa: E402
import wf_boss  # noqa: E402
import wf_describe  # noqa: E402

LEADER = "master/ability/leader_ability.orderedmap"
SOUL = "master/ability/ability_soul.orderedmap"
WAB = "master/equipment_enhancement/equipment_enhancement_ability.orderedmap"
BOSS_LEVEL = "master/battle/boss/boss_level.orderedmap"
MARKER = ROOT / "logs" / "balance_suite_applied.json"
REPORT = ROOT / "logs" / "balance_suite_report.json"

ELEM_TOKEN = {0: "Red", 1: "Blue", 2: "Yellow", 3: "Green", 4: "White", 5: "Black"}
ALL_TOKENS = set(ELEM_TOKEN.values())

SCALE_CAP = 2.5
BOSS_HP_MULT = 4.0        # 普通 boss 血量倍率(演武/无限档仍还原)
DUMMY_HP_MULT = 20.0      # 木桩/假人(waraboss_*)血量巨幅上调(练度检验用)
# 主线证章/黄金宝珠(soul_id):大幅强化 + 去负面副作用行(2026-07-09)
MAINLINE_ORBS = {"200001", "200002", "200003", "200004", "200005", "200006",
                 "100011", "100012", "5090054"}
MAINLINE_ORB_MULT = 4.0
ABS_CAP = 500000          # 强度绝对上限 500%(除非原值更高)
COOL_F, COOL_F_LIGHT = 0.6, 0.5
LIMIT_F, LIMIT_CAP = 5, 99
TH_F, ACCUM_F = 0.7, 2

SIG_TIER = {"5_gen1": 15, "5_gen2": 12.5, "5_gen3": 10, "5_base": 7.5, "4": 12.5, "3": 15}
NAMED = {"111001", "111007", "111129", "311025", "321005", "151045", "141159",
         "10"}   # 白虎兽人(用户 2026-07-09 点名加强)
NAMED_SIG = 25
# 点名删行:按 (ability_key, {col: val}) 签名匹配删除(限定键内,无跨键误删风险)
REMOVE_SIG = [
    ("3410051", {47: "390"}),   # 缪(猫耳格斗士)能力1"连击≥350→Set连击0"(用户 2026-07-09)
]
FAM_KIND = {"skill": "2", "pf": "23", "fever": "0", "ability": "154", "direct": "1"}
FAM_CAT = {"skill": "action_skill", "pf": "power_flip", "fever": "fever",
           "ability": "attack_common", "direct": "attack_common"}
# v1 行重建(移除用)
V1_KIND = {0: ("2", "action_skill"), 1: ("3", "action_skill"), 2: ("1", "attack_common"),
           3: ("23", "power_flip"), 4: ("0", "fever"), 5: ("154", "attack_common")}
V1_TIER = {"5_gen1": 15, "5_gen2": 12, "5_gen3": 10, "5_base": 8, "4": 12, "3": 15}

# 龙兽通用组件:family -> (donor_char, slot(1-6), line(1-based))
PKG = {"skill": ("111183", 3, 1), "pf": ("111001", 3, 1), "direct": ("341005", 2, 1),
       "fever": ("131020", 2, 2), "ability": ("151027", 3, 2)}
# 定向移植:(src_char, slot, line, dst_char)
TRANSPLANTS = [
    ("111004", 3, 1, "111007"),   # 玛丽安 全队技能槽 → 火罗尔夫(用户指定)
    ("121003", 5, 1, "10"),       # 水艾莉亚 追加连击 → 风白
    ("111001", 3, 1, "10"),       # 瓦格纳 连击数↓ → 风白
    ("111015", 1, 1, "161081"),   # 花火 2号位技能槽100% → HW拉芙
    ("111015", 3, 2, "161081"),   # 花火 技能最大→全队攻击(过充) → HW拉芙
    ("111015", 3, 1, "161081"),   # 花火 满槽充能 → HW拉芙
    ("111015", 3, 1, "10"),       # 花火 满槽充能 → 白虎兽人(用户 2026-07-09 加强)
]
# 点名单元格补丁(应用于机制引擎与倍率之后,值=最终绝对值):(char, slot, line, {col: val})
PATCHES = [
    ("111001", 2, 1, {31: "300000"}),   # 瓦格纳暖机阈值 ≥5→≥3(层数/单层交给全局暖机规则)
    ("111001", 2, 2, {31: "300000"}),
    ("111001", 5, 1, {51: "500000", 52: "500000"}),               # 连击↓5
    ("111183", 3, 3, {57: "180000000", 58: "180000000"}),         # 炎龙王窗口30秒
    ("111129", 1, 1, {57: "180000000", 58: "180000000"}),         # 玛格诺斯窗口10→30秒
    ("111129", 3, 2, {57: "180000000", 58: "180000000"}),
    ("111129", 4, 1, {57: "180000000", 58: "180000000"}),
    ("111007", 1, 2, {31: "1500000"}),                            # 罗尔夫直击暖机阈值 20→15
    ("141159", 3, 1, {30: "500000", 31: "500000"}),               # 风罗尔夫 能力3 ≥10→≥5
    ("141159", 3, 2, {57: "360000000", 58: "360000000"}),         # 状态弹射伤 60 秒
    ("141008", 3, 3, {113: "1500000", 114: "1500000"}),           # 风龙 连击↓-15
    ("131020", 2, 1, {35: "120"}), ("131020", 2, 2, {35: "120"}),   # 白花机人 CT2秒(帧)
    ("131020", 3, 1, {35: "300"}), ("131020", 3, 2, {35: "300"}),   # CT5秒(帧)
    ("261089", 3, 2, {113: "7500", 114: "7500"}),                 # 暗龙充能 7.5%
    ("121003", 2, 1, {30: "2000000", 31: "2000000"}),             # 水艾莉亚 连击30→20
    ("121008", 6, 1, {30: "1000000", 31: "1000000"}),             # 冲浪拉杰 承伤15→10
    ("121008", 3, 1, {100: "50000", 101: "50000"}),               # HP≥80%→50%
    ("151159", 3, 2, {57: "240000000", 58: "240000000"}),         # 光龙 乘区窗口40秒
    # 茶露亚:去掉队伍血量递增条件(HpIncrease 1%×60层 → 恒真满值,用户 2026-07-09)
    ("121189", 2, 1, {97: "1", 98: "0", 100: "100000", 101: "100000", 102: "",
                      105: "", 106: "", 113: "90000", 114: "150000"}),
    ("121189", 3, 1, {97: "1", 98: "0", 100: "100000", 101: "100000", 102: "",
                      105: "", 106: "", 113: "120000", 114: "300000"}),
    ("121189", 3, 2, {97: "1", 98: "0", 100: "100000", 101: "100000", 102: "",
                      105: "", 106: "", 113: "120000", 114: "300000"}),
    ("121189", 5, 1, {97: "1", 98: "0", 100: "100000", 101: "100000", 102: "",
                      105: "", 106: "", 113: "30000", 114: "30000"}),
    ("121189", 6, 1, {97: "1", 98: "0", 100: "100000", 101: "100000", 102: "",
                      105: "", 106: "", 113: "30000", 114: "30000"}),
    # 白虎兽人:队长时 独立乘区强化弹射伤害 2.5→10%/5→20%(用户 2026-07-09 加强)
    ("10", 1, 3, {51: "10000", 52: "20000"}),
]
# 队长技单元格补丁(布局-2):(char, line, {col: val})
LEADER_PATCHES = [
    ("121189", 1, {95: "1", 96: "0", 98: "100000", 99: "100000", 100: "",
                   103: "", 104: "", 111: "300000", 112: "300000"}),
    ("121189", 2, {95: "1", 96: "0", 98: "100000", 99: "100000", 100: "",
                   103: "", 104: "", 111: "300000", 112: "300000"}),
]
# (暖机层数/单层数值由全局暖机规则统一处理:层数×0.6 更快叠满、单层补偿、总量≤原×1.5)
# 合成行:(dst_char, during_kind_name 或 kind, target, strength‰, during_trigger, character_groups)
SYNTH = [
    # 暗龙:全队(暗)攻击+10%——groups 用元素 token;'Dragon' 在该显示位客户端渲染为 null(2026-07-09)
    ("261089", "0", "5", 10000, "1", "Black"),
    ("111004", "0", "5", 20000, "4", ""),            # 玛丽安:Fever中全队攻击+20%
]
# 全体角色队长技+1 好玩行:family -> (来源表 ab|ld, 角色, 槽/键, 行)
LEADER_FUN = {
    "skill": ("ab", "111004", 3, 1),    # 技能发动→全队技能槽+10%
    "pf": ("ld", "141008", 0, 2),       # 队长表 141008 第2行:强化弹射Lv3伤害特攻(冲刺改按特色发放)
    "direct": ("ab", "341005", 2, 1),   # 技能发动→状态DirectAttack2 追击(5秒)
    "fever": ("ld", "151001", 0, 2),    # 队长表 151001 第2行:Fever时间延长 40→60%
    "ability": ("ab", "151027", 3, 2),  # 技能发动(限)→全队能力伤害
}


def pad(r, n=126):
    return r + [""] * (n - len(r)) if len(r) < n else r


def round05_raw(v: float, up: bool = False) -> int:
    """强度‰值 → 百分比 0/5 结尾(≥10%取5步进,≥2.5%取2.5步进,更小取0.5步进防膨胀)。
    up=True 向上取整(暖机层数压缩的单层补偿用,保证总量只升不降)。"""
    pct = v / 1000.0
    fn = (lambda x: math.ceil(x - 1e-9)) if up else round
    if pct >= 10:
        pct = fn(pct / 5) * 5
    elif pct >= 2.5:
        pct = fn(pct / 2.5) * 2.5
    else:
        pct = max(0.5, fn(pct / 0.5) * 0.5)
    return int(pct * 1000)


def tier_ct(v: float) -> int:
    """阶梯冷却(单位=帧,60帧=1秒):≥30秒→5秒;15~29秒→2秒;1~14秒→1秒;<1秒保持。
    (2026-07-09 二次下调:10/5/1 → 5/2/1)"""
    if v >= 1800:
        return 300
    if v >= 900:
        return 120
    if v > 60:
        return 60
    return int(v)


def build_sig(sid, kind, cat, pct, fever):
    row = [""] * 126
    row[0], row[1], row[2], row[3], row[5] = sid, "true", cat, "0", "1"
    row[6] = row[13] = row[20] = "0"
    row[85] = "(None)"
    if fever:
        row[97] = "4"
    else:
        row[97], row[98] = "1", "0"
        row[100] = row[101] = "100000"
    row[108], row[109], row[110] = "false", kind, "0"
    row[113] = row[114] = str(int(pct * 1000))
    return row


def adapt_row(row, dst_el, dst_sid, ibase=47, dbase=109):
    """append_line_adapted 语义:元素 token/枚举适配、string_id 对齐、觉醒清零、协力可用。"""
    row = pad(list(row))
    tok = ELEM_TOKEN[dst_el]
    for i, v in enumerate(row):
        parts = [p for p in str(v).split("/") if p]
        if parts and all(p in ALL_TOKENS for p in parts) and v != tok:
            row[i] = tok
    for ci in (ibase + 26, dbase + 10):
        if row[ci] in ("1", "2", "3", "4", "5", "6"):
            row[ci] = str(dst_el + 1)
    if dst_sid:                      # 目标首行 sid 为空时保留来源 sid,防客户端显示 null
        row[0] = dst_sid
    row[1], row[3], row[4] = "true", "0", ""
    if row[27] not in ("", "0") and row[34] == "":
        row[34] = "(None)"           # 带触发行空 limit=0次(审计 2026-07-09),归一化为无限哨兵
    return row


def adapt_leader_row(row, dst_el, dst_sid):
    """leader→leader 移植(布局-2:c1=awake_kind,c2=awake_level,无 unisonable;官方 124 列)。"""
    row = pad(list(row), 124)[:124]
    tok = ELEM_TOKEN[dst_el]
    for i, v in enumerate(row):
        parts = [p for p in str(v).split("/") if p]
        if parts and all(p in ALL_TOKENS for p in parts) and v != tok:
            row[i] = tok
    for ci in (45 + 26, 107 + 10):
        if row[ci] in ("1", "2", "3", "4", "5", "6"):
            row[ci] = str(dst_el + 1)
    if dst_sid:
        row[0] = dst_sid
    row[1], row[2] = "0", "0"
    if row[25] not in ("", "0") and row[32] == "":
        row[32] = "(None)"           # 同 adapt_row:带触发行空 limit 归一化(审计 2026-07-09)
    return row


def main() -> None:
    ap = argparse.ArgumentParser(description="平衡增强总包 v3")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--publish", action="store_true", help="写入后发布 CDN(需 --apply)")
    ap.add_argument("--export-pack", action="store_true", help="打可分享改动包")
    ap.add_argument("--force", action="store_true")
    # 原版武器回调(2026-07-17):默认不再对原版武器魂珠做数值拉平/上限×5/证章×4。
    # --apply 从锁定基准重建时不跑第 10 步 = 原版武器回到官方原值。仅当明确想恢复旧的
    # 超模武器平衡时才加 --legacy-weapon-buff。自制深渊武器不经此步,由 wf_rogue_rewards 定义。
    ap.add_argument("--legacy-weapon-buff", action="store_true",
                    help="恢复旧版原版武器超模加强(默认关闭=官方原值)")
    args = ap.parse_args()
    dry = not args.apply
    if args.apply and MARKER.exists() and not args.force:
        sys.exit(f"已应用过({MARKER})。--force = 从最老备份(真·纯净态)重建后按当前规则重跑。")
    if args.apply:
        # 从**锁定基准**重建再全量重算(幂等由构造保证;v1 行不存在→无"官方双胞胎误删"):
        #   ability/status/action_skill = 今晚 v1 应用前的备份(含用户自己的历史手改,正确基线)
        #   leader/soul/wab            = 首次套件运行时的备份(套件动它们之前的状态)
        # 不能取"最老备份"——GUI 时代的更旧备份会回滚用户手改甚至行错位(161093 乱码案例)
        prof0 = core.resolve_profile()
        PIN = {core.ABILITY_LOGICAL: ".bak-wfmod-balance-20260709-003745",
               core.STATUS_LOGICAL: ".bak-wfmod-balance-20260709-003745",
               "master/skill/action_skill.orderedmap": ".bak-wfmod-balance-20260709-003745",
               LEADER: None, SOUL: None, WAB: None}   # None = 最早 .bak-wfmod-suite-*
        restored = 0
        for lg, pin in PIN.items():
            p = core.table_path(prof0.store, lg)
            if pin:
                bak = p.with_name(p.name + pin)
                if not bak.exists():
                    sys.exit(f"锁定基准缺失: {bak}")
            else:
                baks = sorted(p.parent.glob(p.name + ".bak-wfmod-suite-*"),
                              key=lambda b: b.stat().st_mtime)
                if not baks:
                    sys.exit(f"缺少套件基准备份: {p}")
                bak = baks[0]
            shutil.copy2(bak, p)
            restored += 1
        if MARKER.exists():
            MARKER.unlink()
        print(f"[restore] 已从锁定基准重建 {restored} 张表,开始全量重算")
    if (ROOT / "logs" / "balance_patch_v2_applied.json").exists():
        sys.exit("检测到 v2 已单独应用;总包与 v2 不能叠加,请先还原 v2 备份。")

    prof = core.resolve_profile()
    store = prof.store
    ts = time.strftime("%Y%m%d-%H%M%S")
    suffix = f".bak-wfmod-suite-{ts}"
    rep: dict = {"ts": ts, "dry": dry, "layers": {}}
    cnt = Counter()

    wf_describe._load()
    cn_i, cn_d = wf_describe._cn["instant_content"], wf_describe._cn["during_content"]
    ext_i = {k for k, v in cn_i.items() if "延长" in v}
    ext_d = {k for k, v in cn_d.items() if "延长" in v}

    allj = json.loads((ROOT / "logs" / "all_analysis.json").read_text(encoding="utf-8"))
    meta = {c["id"]: c for rows in allj["elements"].values() for c in rows}
    assigns = json.loads((ROOT / "logs" / "unique_assign.json").read_text(encoding="utf-8"))
    ch = json.loads((ROOT / "assets/cdndata/character.json").read_text(encoding="utf-8"))

    def slots(cid):
        r = core.normalize_row_length(ch[cid][0], 37)
        return [r[19 + i] for i in range(6)]

    ab = core.load_table(core.ABILITY_LOGICAL, store)
    parsed = {k: core.read_csv_lines(t) for k, t in ab.text_rows().items()}
    lead = core.load_table(LEADER, store)
    lparsed = {k: core.read_csv_lines(t) for k, t in lead.text_rows().items()}

    # 点名删行(重建后立即删,后续所有层都看不见该行)
    for aid, sig in REMOVE_SIG:
        rows0 = parsed.get(aid)
        if rows0:
            keep = [r for r in rows0
                    if not all(pad(list(r))[c] == v for c, v in sig.items())]
            cnt["removed"] += len(rows0) - len(keep)
            parsed[aid] = keep

    # 队长键映射:白(10→键3)等 8 个老角色 leader 键=character_id 列≠cid
    # (2026-07-09 审计:此前按 cid 直查,这些角色被所有队长层静默跳过)
    chtab = core.load_table("master/character/character.orderedmap", store)
    lmap = {cid: (cid if cid in lparsed else core.effective_character_id(cid, chtab))
            for cid in meta}

    def lrows(cid):
        return lparsed.get(lmap.get(cid, cid))

    use = Counter()
    for cid, rows in ch.items():
        r = core.normalize_row_length(rows[0], 37)
        for x in set(a for a in (r[19 + i] for i in range(6)) if a and a != "(None)"):
            use[x] += 1

    def first_excl(cid):
        for a in slots(cid):
            if a and a != "(None)" and use[a] == 1 and a in parsed:
                return a
        return None

    def fam_hit(name, fam):
        if "↓" in name or "延长" in name or "无效" in name:
            return False
        return (("攻击力" in name) or
                (fam == "skill" and "技能伤害" in name) or
                (fam == "pf" and "强化弹射" in name and ("伤害" in name or "特攻" in name)) or
                (fam == "direct" and ("直接攻击" in name or "直击" in name or "Direct" in name)) or
                (fam == "ability" and "能力伤害" in name))

    # (v1 专精行移除已废弃:--apply 从 v1 之前的纯净备份重建,v1 行天然不存在)

    # ---- 2 解锁 + 3 倍率 + 4 机制引擎 + 5 QoL(能力表与队长技表) ----
    done_keys: set = set()   # 共用词条键只处理一次(多持有者重复缩层/倍率叠加 bug 2026-07-09)
    for cid, m in meta.items():
        fam = m["family"]
        named = cid in NAMED
        f_scale = m["scale"]
        if m["role"] in ("Healer", "Supporter", "Tank"):
            f_scale = 1 + (f_scale - 1) / 2
        f_row = min(SCALE_CAP, f_scale * (1.25 if named else 1.0))
        # 基线组=标尺,一律不吃倍率(弱系锚点抬升会让刃值被低估的基线成员误得 2.5,
        # 蕾薇 161201 案例:固有特攻系词条未计入刃值→total=0→官方巨额数值被再乘爆炸)
        if m["cohort"] == "5_base" and not named:
            f_row = 1.0
        light = (m.get("tags") is not None and False) or False
        el = ["火", "水", "雷", "风", "光", "暗"].index(
            next(e for e, rows in allj["elements"].items() for c in rows if c["id"] == cid))
        cool_f = COOL_F_LIGHT if el == 4 else COOL_F

        def process(rows, ib, db, off):
            """off=0(ability)/-2(leader)。"""
            for row in rows:
                row[:] = pad(row)
                # 解锁
                if row[1] == "false" and off == 0:
                    row[1] = "true"
                    cnt["unlock"] += 1
                for ci in (6 + off, 13 + off, 20 + off):
                    if row[ci] == "202":
                        row[ci] = "0"
                        cnt["unlock202"] += 1
                # 伤害相关性:fam_hit=本流派(吃倍率);dmg_like=任何伤害类内容
                # (非本流派伤害堆行两边都不碰,防走工具行无上限补偿——2026-07-09 审计洞)
                def harm(name):
                    return any(w in name for w in ("伤害", "攻击力", "特攻")) and "↓" not in name
                ni_name, nd_name = cn_i.get(row[ib], ""), cn_d.get(row[db], "")
                is_dmg_i = row[ib] != "" and fam_hit(ni_name, fam)
                is_dmg_d = row[db] != "" and fam_hit(nd_name, fam)
                dmg_like_i = is_dmg_i or (row[ib] != "" and harm(ni_name))
                dmg_like_d = is_dmg_d or (row[db] != "" and harm(nd_name))

                def numeric(cell):
                    try:
                        return int(float(cell))
                    except ValueError:
                        return 0

                # 水系"血量越多"堆叠(HpIncrease 109)一律转恒真满值
                # (2026-07-09 茶露亚案例推广到全水系:错误感知的生命值条件全部去除)
                if el == 1 and row[97 + off] == "109" and dmg_like_d:
                    try:
                        stacks = int(float(row[102 + off]))
                    except ValueError:
                        stacks = 0
                    if stacks >= 2:
                        for sc in (db + 4, db + 5):
                            try:
                                fv = float(row[sc])
                                if fv > 0:
                                    row[sc] = str(min(500000, int(fv * stacks)))
                            except ValueError:
                                pass
                        row[97 + off] = "1"
                        row[98 + off] = "0"
                        row[100 + off] = row[101 + off] = "100000"
                        row[102 + off] = ""
                        row[105 + off] = row[106 + off] = ""
                        cnt["water_hp_unlock"] += 1
                # 暖机堆叠行(有次数上限的伤害行,用户定案 2026-07-09):
                #   次数**减少**(×0.6,最低2层)+ 单层按比例提高 → 更快叠满;
                #   总量 = 原总量 × min(倍率,1.5),防双重超模(斩铁案例)
                def newlim(lv):
                    return max(2, int(round(lv * 0.6)))

                lim_i = numeric(row[34 + off])
                lim_d92, lim_d102 = numeric(row[92 + off]), numeric(row[102 + off])
                lim_d = max(lim_d92, lim_d102)
                stack_i = is_dmg_i and lim_i >= 2
                stack_d = is_dmg_d and lim_d >= 2
                # 倍率(流派+攻击行,统一封顶;堆叠行含层数压缩补偿)
                for base, is_dmg, stk, lv in ((ib, is_dmg_i, stack_i, lim_i),
                                              (db, is_dmg_d, stack_d, lim_d)):
                    if not is_dmg:
                        continue
                    f_use = min(f_row, 1.5) * (lv / newlim(lv)) if stk else f_row
                    for sc in (base + 4, base + 5):
                        v = row[sc]
                        try:
                            fv = float(v)
                        except ValueError:
                            continue
                        if fv <= 0:
                            continue
                        rounded = round05_raw(fv * f_use, up=stk)   # 层数压缩补偿向上取整
                        nv = min(max(int(fv), ABS_CAP), rounded) \
                            if fv * f_use > ABS_CAP else rounded
                        if f_use > 1.0 and nv > fv:
                            row[sc] = str(nv)
                            cnt["scaled_cells"] += 1
                # 堆叠行层数压缩写回
                if stack_i:
                    row[34 + off] = str(newlim(lim_i))
                    cnt["stack_shrink"] += 1
                if stack_d:
                    if lim_d92 >= 2:
                        row[92 + off] = str(newlim(lim_d92))
                    if lim_d102 >= 2:
                        row[102 + off] = str(newlim(lim_d102))
                    cnt["stack_shrink"] += 1
                # 机制引擎
                ic, dc = row[ib], row[db]
                if ic == "211" and row[ib - 20] in ("", "0") and row[ib - 17] == "" and row[ib - 16] == "":
                    for sc in (ib + 4, ib + 5):   # 开局技能槽→100
                        try:
                            if 0 < float(row[sc]) < 100000:
                                row[sc] = "100000"
                                cnt["gauge_full"] += 1
                        except ValueError:
                            pass
                # 合击(联动配对)条件转常驻:触发198+tag组在私服是死条件(惠惠合击案例);
                # 元素覆盖(720/722)必须保持配对门槛,跳过
                if row[27 + off] == "198" and ic not in ("720", "722"):
                    row[27 + off] = "0"
                    row[36 + off] = ""
                    cnt["pair_unlock"] += 1
                if ic == "211":
                    limc = ib - 13   # instant trigger_limit(=c34/off0)
                    try:
                        lv = int(float(row[limc]))
                        if 1 <= lv <= 3:
                            row[limc] = "(None)"   # 官方"无限次"哨兵;空串会被客户端当 0 次(斩铁案例)
                            cnt["gauge_unlimit"] += 1
                    except ValueError:
                        pass
                if dc == "3":       # 充能×1.5
                    for sc in (db + 4, db + 5):
                        try:
                            row[sc] = str(round05_raw(float(row[sc]) * 1.5))
                            cnt["charging"] += 1
                        except ValueError:
                            pass
                if ic in ext_i or dc in ext_d:   # 延长×2
                    for base in (ib, db):
                        if row[base] in (ext_i | ext_d):
                            for sc in (base + 4, base + 5):
                                try:
                                    row[sc] = str(round05_raw(float(row[sc]) * 2))
                                    cnt["extension"] += 1
                                except ValueError:
                                    pass
                if ic == "213":     # 追加Fever点×2
                    for sc in (ib + 4, ib + 5):
                        try:
                            row[sc] = str(int(float(row[sc]) * 2))
                            cnt["feverpt"] += 1
                        except ValueError:
                            pass
                if ic == "226":     # 追加连击+5
                    for sc in (ib + 4, ib + 5):
                        try:
                            row[sc] = str(int(float(row[sc]) + 500000))
                            cnt["addcombo"] += 1
                        except ValueError:
                            pass
                if dc == "256" or ic == "200":   # 连击需求↓+3
                    base = db if dc == "256" else ib
                    for sc in (base + 4, base + 5):
                        try:
                            row[sc] = str(int(float(row[sc]) + 300000))
                            cnt["combodown"] += 1
                        except ValueError:
                            pass
                # QoL:阶梯冷却(用户 2026-07-09:长CT大幅缩短,短CT极致短)
                for ci in (35 + off, 93 + off):
                    v = row[ci]
                    if v not in ("", "(None)", "0", "1"):
                        try:
                            nv = tier_ct(float(v))
                            if nv != int(float(v)):
                                row[ci] = str(nv)
                                cnt["cool"] += 1
                        except ValueError:
                            pass
                # 非伤害工具行(技能槽/充能/治疗/Fever点等):总量按 ×5 档,但层数压缩
                # (充能类"20层暖机太慢"反馈 2026-07-09):单次 = 总量/新层数,少层快满
                for ci, dmg, base in ((34 + off, dmg_like_i, ib),
                                      (92 + off, dmg_like_d, db), (102 + off, dmg_like_d, db)):
                    if dmg:
                        continue
                    v = row[ci]
                    if v not in ("", "(None)", "0"):
                        try:
                            iv = int(float(v))
                        except ValueError:
                            continue
                        if iv >= 2:
                            lim5 = min(LIMIT_CAP, iv * LIMIT_F)
                            newl = max(2, int(round(iv * 0.6)))
                            row[ci] = str(newl)
                            for sc in (base + 4, base + 5):
                                try:
                                    fv = float(row[sc])
                                    if fv > 0:
                                        row[sc] = str(round05_raw(fv * lim5 / newl, up=True))
                                except ValueError:
                                    pass
                            cnt["limit"] += 1
                        elif iv == 1:
                            row[ci] = str(LIMIT_F)   # 限1次的工具行放宽到5次
                            cnt["limit"] += 1
                for ci in (30 + off, 31 + off, 32 + off, 33 + off,
                           88 + off, 89 + off, 90 + off, 91 + off):   # 计数阈值×0.7
                    v = row[ci]
                    try:
                        f = float(v)
                    except ValueError:
                        continue
                    if f >= 200000 and f % 100000 == 0:
                        row[ci] = str(max(100000, int(round(f * TH_F / 100000)) * 100000))
                        cnt["threshold"] += 1
                # 高血门槛放宽(水系"血量越高越强"更易保持):during_trigger HpHigh 阈值≥60%→50%
                # HpLow(暗系"血量越少越强")一律不动,保留流派身份(用户 2026-07-09 方向性要求)
                if row[97 + off] == "0":
                    for ci in (100 + off, 101 + off):
                        try:
                            if float(row[ci]) >= 60000:
                                row[ci] = "50000"
                                cnt["hphigh_loosen"] += 1
                        except ValueError:
                            pass
                ci = 61 + off       # 累积×2
                v = row[ci]
                if v not in ("", "(None)", "0"):
                    try:
                        iv = int(float(v))
                        if iv >= 1:
                            row[ci] = str(iv * ACCUM_F)
                            cnt["accum"] += 1
                    except ValueError:
                        pass

        for aid in slots(cid):
            if aid in parsed and aid not in done_keys:
                done_keys.add(aid)
                process(parsed[aid], 47, 109, 0)
        lr = lrows(cid)
        if lr is not None:
            process(lr, 45, 107, -2)

    # ---- 6 点名补丁(最终绝对值) ----
    for cid, slot, line, cells in PATCHES:
        aid = slots(cid)[slot - 1] if cid in ch else None
        if aid and aid in parsed and len(parsed[aid]) >= line:
            row = pad(parsed[aid][line - 1])
            for col, val in cells.items():
                row[col] = val
            parsed[aid][line - 1] = row
            cnt["patch"] += 1
    for cid, line, cells in LEADER_PATCHES:
        lr = lrows(cid)
        if lr and len(lr) >= line:
            row = pad(lr[line - 1])
            for col, val in cells.items():
                row[col] = val
            lr[line - 1] = row
            cnt["leader_patch"] += 1

    # ---- 7 追加:专精行 / 分发 / 龙兽包 / 定向移植 / 合成 ----
    def append_row(dst_cid, new_row):
        dst = first_excl(dst_cid)
        if not dst:
            cnt["append_skip"] += 1
            return
        if any(r == new_row for r in parsed[dst]):
            return
        parsed[dst].append(new_row)
        cnt["appended"] += 1

    # 特色检测(冲刺/99连击不烂大街,按角色特色发放)——必须在一切追加之前扫原生 kit,
    # 否则 PKG 发的连击数↓行会造成假阳性
    combo_chars, dash_chars = set(), set()
    for cid2 in meta:
        for aid2 in slots(cid2):
            for row2 in parsed.get(aid2, []):
                row2 = pad(row2)
                if (row2[47] in ("226", "489", "200", "718") or row2[109] == "256"
                        or row2[6] in ("10", "11") or row2[13] in ("10", "11")
                        or row2[97] in ("2", "3")):
                    combo_chars.add(cid2)
                if row2[47] in ("31", "194") or row2[109] == "420" or row2[27] in ("4", "5"):
                    dash_chars.add(cid2)

    el_of = {}
    for e_cn, rows in allj["elements"].items():
        for c in rows:
            el_of[c["id"]] = ["火", "水", "雷", "风", "光", "暗"].index(e_cn)
    for cid, m in meta.items():
        dst = first_excl(cid)
        if not dst:
            continue
        sid = parsed[dst][0][0] if parsed[dst] and parsed[dst][0] else ""
        fam = m["family"]
        if cid == "141159":   # 超越版三连
            for f2, p2 in (("pf", 25), ("skill", 20), ("direct", 20)):
                append_row(cid, build_sig(sid, FAM_KIND[f2], FAM_CAT[f2], p2, False))
            continue
        pct = NAMED_SIG if cid in NAMED else SIG_TIER[m["cohort"]]
        fever = fam == "fever"
        if fever:
            pct *= 2
        append_row(cid, build_sig(sid, FAM_KIND[fam], FAM_CAT[fam], pct, fever))
    for a in assigns:   # 独特机制分发
        src = parsed.get(a["src_aid"])
        if not src or len(src) < a["src_line"]:
            continue
        dst = first_excl(a["dst"])
        if not dst:
            continue
        sid = parsed[dst][0][0] if parsed[dst] and parsed[dst][0] else ""
        append_row(a["dst"], adapt_row(src[a["src_line"] - 1], a["el"], sid))
    for cid, m in meta.items():   # 龙兽通用组件 + 词条单调角色机制丰富(暗龙式纯数值/暖机堆)
        race = m.get("race") or ""
        kinds = set()
        for aid in slots(cid):
            for row in parsed.get(aid, []):
                row = pad(row)
                if row[47]:
                    kinds.add("i" + row[47])
                if row[109]:
                    kinds.add("d" + row[109])
        boring = len(kinds) <= 4
        if "Dragon" not in race and "Beast" not in race and not boring:
            continue
        if boring:
            cnt["boring_enriched"] += 1
        d_cid, d_slot, d_line = PKG[m["family"]]
        d_aid = slots(d_cid)[d_slot - 1]
        if d_aid in parsed and len(parsed[d_aid]) >= d_line:
            dst = first_excl(cid)
            if dst:
                sid = parsed[dst][0][0] if parsed[dst] and parsed[dst][0] else ""
                append_row(cid, adapt_row(parsed[d_aid][d_line - 1], el_of[cid], sid))
    for s_cid, s_slot, s_line, d_cid in TRANSPLANTS:
        s_aid = slots(s_cid)[s_slot - 1]
        if s_aid in parsed and len(parsed[s_aid]) >= s_line:
            dst = first_excl(d_cid)
            if dst:
                sid = parsed[dst][0][0] if parsed[dst] and parsed[dst][0] else ""
                append_row(d_cid, adapt_row(parsed[s_aid][s_line - 1], el_of[d_cid], sid))
    for d_cid, kind, tgt, stren, dtrig, groups in SYNTH:
        dst = first_excl(d_cid)
        if not dst:
            continue
        sid = parsed[dst][0][0] if parsed[dst] and parsed[dst][0] else ""
        row = build_sig(sid, kind, "attack_common", stren / 1000, dtrig == "4")
        row[110] = tgt
        if groups:
            row[117] = groups
        append_row(d_cid, row)
    # ---- 7.5 特色机制扩发(用户 2026-07-09):冲刺间隔缩短(队长技)/最大速度固定/
    #      勇者莱特700016 开幕贯通+再生 与 99次弹射连击加成 → 超一线组 ----
    SUPER = ["111001", "111007", "111129", "141159", "141008", "141099", "261089",
             "151159", "10", "121003", "121008", "161081", "131020", "311025",
             "321005", "151045", "263002"]
    # U_573686 复盘:1.4.62(列宽修复+三类下线)可正常进游戏;勇者行(贯通26/连击加成489)
    # 与冲刺(31)无多球依赖,安全回归。Fixed速度全服仅"多球Self"授予体,无安全捐赠→保持下线。

    def kindname_rows(pdict, contains, ib2, db2):
        out = []
        for k, rows in pdict.items():
            for li, r in enumerate(rows, 1):
                r = pad(r)
                ni, nd = cn_i.get(r[ib2], ""), cn_d.get(r[db2], "")
                if any(c in ni or c in nd for c in contains):
                    out.append((k, li))
        return out

    dash_leader = kindname_rows(lparsed, ("冲刺",), 45, 107)      # 枚举名:冲刺/冲刺延长
    fixed_rows = []                                               # Fixed速度:无安全捐赠体,搁置
    hero_rows = []
    if "700016" in ch:
        h1 = slots("700016")[0]
        if h1 in parsed:
            hero_rows = [(h1, li) for li in range(1, min(2, len(parsed[h1])) + 1)]
    for cid in meta:
        el2 = el_of[cid]
        lr = lrows(cid)
        if dash_leader and cid in dash_chars and lr:
            sk, sl = dash_leader[0]              # 冲刺:只给自带冲刺体系的角色
            lsid = lr[0][0] if lr[0] else ""
            nrow = adapt_leader_row(lparsed[sk][sl - 1], el2, lsid)
            if nrow not in lr:
                lr.append(nrow)
                cnt["dash_leader"] += 1
        if hero_rows and cid in SUPER:           # 勇者开幕贯通:仅超一线组
            sk, sl = hero_rows[0]
            dst2 = first_excl(cid)
            if dst2 and len(parsed[sk]) >= sl:
                sid2 = parsed[dst2][0][0] if parsed[dst2] and parsed[dst2][0] else ""
                append_row(cid, adapt_row(parsed[sk][sl - 1], el2, sid2))
                cnt["hero_rows"] += 1
        if len(hero_rows) >= 2 and cid in combo_chars:   # 99次连击加成:只给连击特色角色
            sk, sl = hero_rows[1]
            dst2 = first_excl(cid)
            if dst2 and len(parsed[sk]) >= sl:
                sid2 = parsed[dst2][0][0] if parsed[dst2] and parsed[dst2][0] else ""
                append_row(cid, adapt_row(parsed[sk][sl - 1], el2, sid2))
                cnt["hero_combo"] += 1
        if meta[cid]["family"] == "fever":       # fever角色额外能量来源(连击/弹射/技能发动轮转)
            donors = [("341005", 1, 1), ("111007", 6, 1), ("111015", 4, 1)]
            d_cid3, d_slot3, d_line3 = donors[int(cid) % 3]
            d_aid3 = slots(d_cid3)[d_slot3 - 1]
            dst2 = first_excl(cid)
            if dst2 and d_aid3 in parsed and len(parsed[d_aid3]) >= d_line3:
                sid2 = parsed[dst2][0][0] if parsed[dst2] and parsed[dst2][0] else ""
                append_row(cid, adapt_row(parsed[d_aid3][d_line3 - 1], el2, sid2))
                cnt["fever_energy"] += 1

    # ---- 7.6 全体角色队长技+1 好玩行(用户 2026-07-09"重点设计全体队长技") ----
    # 能力表行→队长布局:去掉 c1(unisonable)/c2(category),其余对齐(124 列)
    def ability_to_leader(row):
        row = pad(list(row))
        return ([row[0]] + row[3:126])[:124]

    for cid, m in meta.items():
        lr = lrows(cid)
        if not lr:
            continue
        srctab, d_cid2, d_slot2, d_line2 = LEADER_FUN[m["family"]]
        if srctab == "ab":
            d_aid2 = slots(d_cid2)[d_slot2 - 1]
            if d_aid2 not in parsed or len(parsed[d_aid2]) < d_line2:
                continue
            base_row = ability_to_leader(parsed[d_aid2][d_line2 - 1])
        else:
            if d_cid2 not in lparsed or len(lparsed[d_cid2]) < d_line2:
                continue
            base_row = lparsed[d_cid2][d_line2 - 1]
        lsid = lr[0][0] if lr[0] else ""
        nrow = adapt_leader_row(base_row, el_of[cid], lsid)
        if nrow not in lr:
            lr.append(nrow)
            cnt["leader_fun"] += 1

    # ---- 7.65 白虎兽人(10)定向强化(用户 2026-07-09):队长技趣味包 ----
    WHITE = "10"
    wl = lrows(WHITE) if WHITE in meta else None
    if wl:
        wel2 = el_of[WHITE]
        wsid = wl[0][0] if wl[0] else ""
        extra = []
        if dash_leader:                              # 冲刺间隔缩短(白色咆哮突进特色)
            sk, sl = dash_leader[0]
            extra.append(adapt_leader_row(lparsed[sk][sl - 1], wel2, wsid))
        if "151001" in lparsed and len(lparsed["151001"]) >= 2:   # Fever时间延长
            extra.append(adapt_leader_row(lparsed["151001"][1], wel2, wsid))
        for d_cid5, d_slot5, d_line5 in (("111001", 3, 1),    # 连击数↓
                                         ("111004", 3, 1),    # 全队技能槽
                                         ("121003", 5, 1)):   # 追加连击
            a5 = slots(d_cid5)[d_slot5 - 1]
            if a5 in parsed and len(parsed[a5]) >= d_line5:
                extra.append(adapt_leader_row(
                    ability_to_leader(parsed[a5][d_line5 - 1]), wel2, wsid))
        for nrow in extra:
            if nrow not in wl:
                wl.append(nrow)
                cnt["white_leader"] += 1

    # ---- 7.7 (2026-07-09 追加轮) ----
    # a) 技能槽最大值+15% 队长行 → 全员;b) 进入Fever充能/弹射充能 少量扩发(每属性4人,非fever系);
    # c) 三/四星再加料:家族组件行 + 第二条队长好玩行(相邻流派轮转)
    # 技能槽最大值 = 枚举245(wf_describe 误标"2号位技能槽");捐赠体=绮拉131122 队长L3
    gmax_leader = [(k, li) for k, rows in lparsed.items()
                   for li, r0 in enumerate(rows, 1) if pad(r0)[45] == "245"][:1]
    fever_gauge = [(k, li) for k, rows in parsed.items()
                   for li, r0 in enumerate(rows, 1)
                   if pad(r0)[27] == "8" and pad(r0)[47] == "211"][:1]
    pf_gauge = [(slots("111007")[5], 1)]
    fams_cycle = ["skill", "pf", "direct", "fever", "ability"]
    per_el_quota = {el2: 4 for el2 in range(6)}
    order = sorted(meta.items(), key=lambda kv: kv[1]["total"] / max(1, kv[1]["target"]))
    for idx, (cid, m) in enumerate(order):
        el2 = el_of[cid]
        lr = lrows(cid)
        if gmax_leader and lr:   # a) 全员技能槽最大值
            sk, sl = gmax_leader[0]
            lsid = lr[0][0] if lr[0] else ""
            nrow = adapt_leader_row(lparsed[sk][sl - 1], el2, lsid)
            if nrow not in lr:
                lr.append(nrow)
                cnt["gauge_max_all"] += 1
        if (m["family"] != "fever" and per_el_quota[el2] > 0
                and m["total"] < m["target"]):                 # b) 少量扩发
            donors2 = fever_gauge if idx % 2 == 0 else pf_gauge
            if donors2:
                sk, sl = donors2[0]
                dst2 = first_excl(cid)
                if dst2 and sk in parsed and len(parsed[sk]) >= sl:
                    sid2 = parsed[dst2][0][0] if parsed[dst2] and parsed[dst2][0] else ""
                    append_row(cid, adapt_row(parsed[sk][sl - 1], el2, sid2))
                    per_el_quota[el2] -= 1
                    cnt["gauge_spread"] += 1
        if m["rar"] in (3, 4):                                 # c) 三/四星再加料
            d_cid4, d_slot4, d_line4 = PKG[m["family"]]
            d_aid4 = slots(d_cid4)[d_slot4 - 1]
            if d_aid4 in parsed and len(parsed[d_aid4]) >= d_line4:
                dst2 = first_excl(cid)
                if dst2:
                    sid2 = parsed[dst2][0][0] if parsed[dst2] and parsed[dst2][0] else ""
                    append_row(cid, adapt_row(parsed[d_aid4][d_line4 - 1], el2, sid2))
            fam2 = fams_cycle[(fams_cycle.index(m["family"]) + 1) % 5]
            srctab2, dc2, ds2, dl2 = LEADER_FUN[fam2]
            base_row2 = None
            if srctab2 == "ab":
                a2 = slots(dc2)[ds2 - 1]
                if a2 in parsed and len(parsed[a2]) >= dl2:
                    base_row2 = ability_to_leader(parsed[a2][dl2 - 1]) if False else None
            # ability_to_leader 定义在 7.6,此处直接内联转换
            if srctab2 == "ab":
                a2 = slots(dc2)[ds2 - 1]
                if a2 in parsed and len(parsed[a2]) >= dl2:
                    r2 = pad(list(parsed[a2][dl2 - 1]))
                    base_row2 = ([r2[0]] + r2[3:126])[:124]
            elif dc2 in lparsed and len(lparsed[dc2]) >= dl2:
                base_row2 = lparsed[dc2][dl2 - 1]
            if base_row2 and lr:
                lsid = lr[0][0] if lr[0] else ""
                nrow = adapt_leader_row(base_row2, el2, lsid)
                if nrow not in lr:
                    lr.append(nrow)
                    cnt["lowstar_leader2"] += 1

    # ---- 7.70 雷系直击+贯通体系 / 风系Fever体系(用户 2026-07-09) ----
    def _clone(src_key, want_ic=None, want_dt=None, want_dc=None):
        for rw in parsed.get(src_key, []):
            r = pad(rw)
            if want_ic and r[47] == want_ic:
                return list(r)
            if want_dt and r[97] == want_dt and (not want_dc or r[109] == want_dc):
                return list(r)
        return None
    pierce_tmpl = _clone("1110023", want_ic="26")          # 弹射→状态贯通(合法)
    pdirect_tmpl = _clone("1610022", want_dt="30", want_dc="1")  # 贯通中→Direct伤害(合法)
    fever_pt_tmpl = None
    for rw in parsed.get(slots("131020")[1], []):
        if pad(rw)[47] == "213":
            fever_pt_tmpl = list(pad(rw)); break

    # 雷系直击+贯通:弹射授予贯通 + 贯通中直击伤害大幅(短贯通触发,循环)
    for cid in ("131068", "131110", "131062"):   # 梅姆拉姆/拉普缇娜/丝特莱纳
        if cid not in meta:
            continue
        dst = first_excl(cid)
        if not dst or not parsed.get(dst):
            continue
        sid = parsed[dst][0][0] if parsed[dst][0] else ""
        if pierce_tmpl:
            pr = adapt_row(pierce_tmpl, 2, sid)
            pr[27] = "6"; pr[30] = pr[31] = "500000"   # 弹射≥5 授予贯通
            pr[35] = "0"
            if pr not in parsed[dst]:
                parsed[dst].append(pr); cnt["thunder_pierce"] += 1
        if pdirect_tmpl:
            dr = adapt_row(pdirect_tmpl, 2, sid)
            dr[110] = "0"                              # 目标自身
            dr[113] = "100000"; dr[114] = "150000"     # 贯通中→直击伤害+100%→150%
            if dr not in parsed[dst]:
                parsed[dst].append(dr); cnt["thunder_pierce"] += 1
        # 配套常驻直击伤害
        parsed[dst].append(build_sig(sid, "1", "attack_common", 40, fever=False))

    # 风系Fever体系:强化弹射→追加Fever点(靠风的弹射特色进Fever) + Fever中攻击/技能大幅
    for cid in ("141135", "141093", "141051"):   # 泽菲尔/玛露琪亚/艾丝缇莉艾尔
        if cid not in meta:
            continue
        dst = first_excl(cid)
        if not dst or not parsed.get(dst):
            continue
        sid = parsed[dst][0][0] if parsed[dst][0] else ""
        if fever_pt_tmpl:
            fp = adapt_row(fever_pt_tmpl, 3, sid)
            fp[27] = "6"; fp[30] = fp[31] = "300000"   # 强化弹射≥3 → 追加Fever点(风弹射特色进Fever)
            fp[35] = "0"
            if fp not in parsed[dst]:
                parsed[dst].append(fp); cnt["wind_fever"] += 1
        parsed[dst].append(build_sig(sid, "0", "fever", 60, fever=True))   # Fever中攻击+60%
        parsed[dst].append(build_sig(sid, "23", "power_flip", 50, fever=True))  # Fever中弹射伤害+50%
        cnt["wind_fever"] += 1

    # ---- 7.71 能力伤害体系(用户 2026-07-09):火水雷风暗部分角色,不同触发+短CD ----
    # 克隆合法能力伤害炮行(2110021L4: instant_content 251=敌方伤害·依攻击火),
    # 换元素炮 kind(251+el)、触发方式、短冷却(60帧=1秒/30帧=0.5秒)。
    ADT_TMPL = "2110021"   # 模板键
    adt_src = parsed.get(ADT_TMPL)
    adt_line = next((i for i, rw in enumerate(adt_src or [], 0)
                     if pad(rw)[47] == "251"), None)
    # (角色, 触发kind, 触发中文, CT帧):触发 2弹射/4冲刺/6弹球/8Fever/23技能
    ABILITY_SYS = [
        ("111093", 2, 60), ("111051", 4, 60), ("111087", 6, 30),   # 火:弹射/冲刺/弹球
        ("121081", 2, 60), ("121087", 23, 60), ("121105", 4, 30),  # 水:弹射/技能/冲刺
        ("131092", 2, 60), ("131056", 8, 60), ("131038", 23, 30),  # 雷:弹射/Fever/技能
        ("141045", 4, 60), ("141033", 2, 60), ("141111", 6, 30),   # 风:冲刺/弹射/弹球
        ("161135", 2, 60), ("161165", 23, 60), ("161159", 4, 30),  # 暗:弹射/技能/冲刺
    ]
    if adt_line is not None:
        for cid, trig, ct in ABILITY_SYS:
            if cid not in meta:
                continue
            el2 = el_of.get(cid, 0)
            dst = first_excl(cid)
            if not dst or not parsed.get(dst):
                continue
            sid = parsed[dst][0][0] if parsed[dst][0] else ""
            row = adapt_row(adt_src[adt_line], el2, sid)
            row[27] = str(trig)                 # 触发方式
            row[28] = "0"; row[29] = ""          # 触发来源=自身,无属性过滤
            row[30] = row[31] = "100000"         # 阈值≥1
            row[34] = "(None)"                   # 无次数上限
            row[35] = str(ct)                    # 短冷却
            row[47] = str(251 + el2)             # 敌方伤害·依攻击(本属性)
            row[48] = "0"
            row[51] = "1500000"; row[52] = "3000000"   # 1500%→3000% 能力伤害
            # 配套:常驻能力伤害+40% 独立乘区,让体系成立
            buff = build_sig(sid, "154", "attack_common", 40, fever=False)
            if row not in parsed[dst]:
                parsed[dst].append(row)
                cnt["ability_sys"] += 1
            if buff not in parsed[dst]:
                parsed[dst].append(buff)

    # ---- 7.72 Fever 消耗机制(用户 2026-07-09,三种设计分配到不同角色+武器) ----
    # 每种都"扣Fever"配"必生效收益":负Fever点若客户端不认(零先例),收益仍在、不崩。
    # A 烧Fever换爆发 / B Fever循环(扣+FeverPointDown触发充能) / C 纯扣(debuff/特殊)
    def add_fever_consume(cid, variant, el2):
        dst = first_excl(cid)
        if not dst or not parsed.get(dst):
            return 0
        sid = parsed[dst][0][0] if parsed[dst][0] else ""
        added = 0

        def push(row):
            nonlocal added
            if row not in parsed[dst]:
                parsed[dst].append(row)
                added += 1
        # 扣 Fever 点:Fever 中 → Fever点 -20%(负值,金丝雀验证项)
        consume = build_sig(sid, "18", "fever", -20, fever=True)
        push(consume)
        if variant == "A":       # 烧 Fever 换爆发:Fever 中技能伤害/攻击大幅
            push(build_sig(sid, "2", "action_skill", 60, fever=True))
            push(build_sig(sid, "0", "fever", 60, fever=True))
        elif variant == "B":     # 循环:FeverPointDown(触发22)时充能——即使负Fever无效也能靠Fever自然消耗触发
            row = build_sig(sid, "3", "action_skill", 15, fever=True)
            row[97] = "22"       # during_trigger = ConditionFeverPointDown
            push(row)
        # variant C:仅扣(特殊/debuff 定位),不配收益
        return added

    FEVER_CONSUME = {
        "131001": "A", "131004": "A", "131013": "A",   # 稻穗/梅媞斯/伊路米:烧Fever爆发
        "331004": "B", "331006": "B", "231007": "B",   # 黑/加津知/欧雷欧:循环
        "231008": "C", "231009": "C", "231099": "C",   # 阿德尼/露迪/英维特拉:纯扣特殊
    }
    for cid, var in FEVER_CONSUME.items():
        if cid in meta:
            cnt["fever_consume"] += add_fever_consume(cid, var, el_of.get(cid, 2))

    # 武器侧:给几把雷系武器挂"Fever中扣Fever点"(纯特殊玩法,soul 表克隆合法行改)
    FEVER_CONSUME_WEAPONS = []   # soul 行需合法模板,单独在 soul 层用 wel==2 的武器处理见下

    # ---- 7.75 雷系 Fever 流:技能发动→追加Fever点(放技能充Fever槽,更快进Fever) ----
    # 克隆白花机人 131020 能力2L2(追加Fever点,ic213)——结构合法,元素自动适配到雷
    tf_donor_aid = slots("131020")[1]   # 能力2 键
    tf_line = None
    for li, rw in enumerate(parsed.get(tf_donor_aid, []), 1):
        if pad(rw)[47] == "213":
            tf_line = li
            break
    if tf_line:
        for cid in [c["id"] for c in allj["elements"]["雷"] if c["family"] == "fever"]:
            dst = first_excl(cid)
            if dst:
                sid = parsed[dst][0][0] if parsed[dst] and parsed[dst][0] else ""
                append_row(cid, adapt_row(parsed[tf_donor_aid][tf_line - 1], 2, sid))
                cnt["thunder_fever"] += 1

    # ---- 7.9 全角色独立趣味词条(agent 逐角色设计档案 logs/unique_design.json,2026-07-09) ----
    # 条目: {cid, adds: [{table: ab|ld, donor_key, donor_line, tweaks: {col: val}, why}]}
    # 落地走 adapt_row/adapt_leader_row(结构合法性由捐赠行保证),tweaks 在适配后覆盖
    UD = ROOT / "logs" / "unique_design.json"
    if UD.exists():
        applied_log = []
        for d in json.loads(UD.read_text(encoding="utf-8")):
            cid = d.get("cid")
            if cid not in meta:
                cnt["design_skip"] += 1
                continue
            for add in d.get("adds", []):
                tweaks = {int(c): str(v) for c, v in (add.get("tweaks") or {}).items()}
                if add.get("table") == "ld":
                    src = lparsed.get(add["donor_key"])
                    lr = lrows(cid)
                    if not src or len(src) < add["donor_line"] or not lr:
                        cnt["design_skip"] += 1
                        continue
                    lsid = lr[0][0] if lr[0] else ""
                    row = adapt_leader_row(src[add["donor_line"] - 1], el_of[cid], lsid)
                    for col, val in tweaks.items():
                        row[col] = val
                    if row not in lr:
                        lr.append(row)
                        cnt["design_added"] += 1
                        applied_log.append({"cid": cid, "table": "ld",
                                            "desc": wf_describe.describe_line(row, "leader_ability"),
                                            "why": add.get("why", "")})
                else:
                    src = parsed.get(add["donor_key"])
                    dst = first_excl(cid)
                    if not src or len(src) < add["donor_line"] or not dst:
                        cnt["design_skip"] += 1
                        continue
                    sid = parsed[dst][0][0] if parsed[dst] and parsed[dst][0] else ""
                    row = adapt_row(src[add["donor_line"] - 1], el_of[cid], sid)
                    for col, val in tweaks.items():
                        row[col] = val
                    if row not in parsed[dst]:
                        parsed[dst].append(row)
                        cnt["design_added"] += 1
                        applied_log.append({"cid": cid, "table": "ab", "key": dst,
                                            "desc": wf_describe.describe_line(row, "ability"),
                                            "why": add.get("why", "")})
        (ROOT / "logs" / "unique_design_applied.json").write_text(
            json.dumps(applied_log, ensure_ascii=False, indent=1), encoding="utf-8")

    # ---- 7.8 修复"技能槽最大值(kind245)"编队条件+次数导致的不可达 [最大] ----
    # 静态"编成≥N"只触发一次,却靠"限N次"叠到标称上限→永远吃不满(用户 2026-07-09)。
    # 处置:该类行 power1=first_max(一次给满)、清 trigger_limit、编队阈值降到≥4。
    def fix_gaugemax(rows, ib, off):
        n = 0
        for row in rows:
            row[:] = pad(row)
            if row[ib] == "245":
                row[ib + 4] = row[ib + 5]        # instant strength power1 := first_max(一次给满)
                # 无限次哨兵必须 "(None)":带触发行空串=0次即整行死(斩铁案例;2026-07-09 审计
                # 证实官方带触发行 leader 0/247、ability 53/1580 为空串,此前写空串致 466 行无效)
                row[ib - 13] = "(None)"
                if row[6 + off] in ("2", "208") and row[9 + off]:
                    row[9 + off] = row[10 + off] = "400000"   # 编成阈值 → ≥4
                n += 1
        return n
    for cid in meta:
        for aid in slots(cid):
            if aid in parsed:
                cnt["gaugemax_fix"] += fix_gaugemax(parsed[aid], 47, 0)
        lr = lrows(cid)
        if lr is not None:
            cnt["gaugemax_fix"] += fix_gaugemax(lr, 45, -2)

    # 263002 双系乘区(独立乘区技能伤害 kind 由名称解析)
    mz = next((k for k, v in cn_d.items() if "独立乘区技能伤害" in v), None)
    if mz:
        for el2 in (5, 4):
            dst = first_excl("263002")
            if dst:
                sid = parsed[dst][0][0]
                row = build_sig(sid, mz, "attack_common", 5, False)
                row[110] = "5"
                row[117] = ELEM_TOKEN[el2]
                append_row("263002", row)
                cnt["rafu_zone"] += 1

    # 点名删行终扫:分发/PKG 等 append 层会重新引入被删签名(缪的连击归零来自
    # unique_assign 分发 艾丝缇莉艾尔"连击≥500 Set连击0",阈值×0.7→350),故写盘前再扫一遍
    for aid, sig in REMOVE_SIG:
        rows0 = parsed.get(aid)
        if rows0:
            keep = [r for r in rows0
                    if not all(pad(list(r))[c] == v for c, v in sig.items())]
            cnt["removed"] += len(rows0) - len(keep)
            parsed[aid] = keep

    if not dry:
        ab.set_text_rows({k: core.write_csv_lines(r) for k, r in parsed.items()})
        print("写入", core.write_table(ab, store, suffix))
        # 队长技表官方 124 列:处理期按 126 补齐索引,写盘前必须裁回(126 列曾致客户端解析错误)
        lead.set_text_rows({k: core.write_csv_lines([r[:124] for r in rows])
                            for k, rows in lparsed.items()})
        print("写入", core.write_table(lead, store, suffix))

    # ---- 8 三四星基础数值 ----
    st = core.load_status_table(store)
    dec = {}
    lv100 = {}
    for i, k in enumerate(st.keys):
        e = core.decode_status_row(st.rows[i])
        dec[k] = e
        for lv, hp, atk in e:
            if lv == "100":
                lv100[k] = (hp, atk)
    base_avg = {}
    for e_cn, rows in allj["elements"].items():
        el2 = ["火", "水", "雷", "风", "光", "暗"].index(e_cn)
        bs = [lv100[c["id"]] for c in rows if c["cohort"] == "5_base" and c["id"] in lv100]
        base_avg[el2] = (sum(x[0] for x in bs) / len(bs), sum(x[1] for x in bs) / len(bs))
    for cid, m in meta.items():
        if cid not in lv100:
            continue
        # 五星按世代 cap(v1 逻辑并入,纯净态重建后由本层负责);三/四星 →基线95%
        if m["rar"] == 5:
            cap = {"5_gen1": 1.20, "5_gen2": 1.12, "5_gen3": 1.06}.get(m["cohort"], 1.0)
            if cap <= 1.0:
                continue
            th, ta = base_avg[el_of[cid]]
        elif m["rar"] in (3, 4):
            cap = 1.35 if m["rar"] == 4 else 1.55
            th, ta = (v * 0.95 for v in base_avg[el_of[cid]])
        else:
            continue
        hp0, atk0 = lv100[cid]
        fh = min(cap, max(1.0, th / hp0)) if hp0 else 1.0
        fa = min(cap, max(1.0, ta / atk0)) if atk0 else 1.0
        if fh > 1.0 or fa > 1.0:
            dec[cid] = [(lv, int(round(hp * fh)), int(round(atk * fa))) for lv, hp, atk in dec[cid]]
            cnt["status"] += 1
    if not dry and cnt["status"]:
        for i, k in enumerate(st.keys):
            if k in dec:
                st.rows[i] = core.encode_status_row(dec[k])
        print("写入", core.write_status_table(st, store, suffix))

    # ---- 9 Boss(原值×2.5,演武/无限档还原) ----
    bak_dir = qlib.store_path(BOSS_LEVEL).parent
    baks = sorted(bak_dir.glob("*.bak-wfquest-*"))
    orig = qlib.load_table(BOSS_LEVEL, path=baks[0]) if baks else qlib.load_table(BOSS_LEVEL)
    tree = qlib.load_table(BOSS_LEVEL)
    sb = {b["key"] for q in wf_boss.quest_list("score_attack", limit=1000)["rows"] for b in q["bosses"]}
    other = set()
    for cat in wf_boss.quest_cats():
        if cat["exists"] and cat["alias"] != "score_attack":
            try:
                for q in wf_boss.quest_list(cat["alias"], limit=5000)["rows"]:
                    for b in q["bosses"]:
                        other.add(b["key"])
            except Exception:
                pass
    score_only = sb - other
    for key, row in orig.items():
        if not isinstance(row, str) or key not in tree:
            continue
        c2 = row.split(",")
        while len(c2) < 13:
            c2.append("")
        col = 2 if c2[0] == "0" else 5
        try:
            ov = float(c2[col])
        except ValueError:
            continue
        if ov <= 0:
            continue
        excl = key in score_only or ov >= 1e8
        if key.startswith("waraboss") or "waraboss" in key:   # 木桩/假人:巨幅
            nv = min(2_100_000_000, int(round(ov * DUMMY_HP_MULT)))
            cnt["dummy_hp"] += 1
        elif excl:
            nv = int(ov)
        else:
            nv = min(2_100_000_000, int(round(ov * BOSS_HP_MULT)))
        cur = tree[key].split(",")
        while len(cur) < 13:
            cur.append("")
        if cur[col] != str(nv):
            cur[col] = str(nv)
            tree[key] = ",".join(cur)
            cnt["boss_restore" if excl else "boss_up"] += 1
    if not dry and (cnt["boss_up"] or cnt["boss_restore"]):
        print("写入", qlib.save_table(BOSS_LEVEL, tree))

    # ---- 10 武器魂珠:数值同步 + 上限×5 ----
    # 用户 2026-07-17:原版全套武器此前加强太多 → 默认回官方原值(--apply 重建时不跑本步)。
    # 自制深渊武器(8000101-8000115)不经本步,词条由 wf_rogue_rewards 独立定义。
    if not getattr(args, "legacy_weapon_buff", False):
        print("[10] 原版武器魂珠:回官方原值(跳过拉平/上限×5/证章×4;--legacy-weapon-buff 可恢复旧超模)")
    else:
        # 武器拉平预计算:各属性以顶级武器(封顶1000)为基准,低于基准的按 power 比例拉升(封顶×5)
        ETOK2 = {"Red": 0, "Blue": 1, "Yellow": 2, "Green": 3, "White": 4, "Black": 5}
        eq_tbl = core.load_table("master/item/equipment.orderedmap", store)
        soul_pre = core.load_table(SOUL, store)
        sp_pre = {k: core.read_csv_lines(t) for k, t in soul_pre.text_rows().items()}

        def _wpow(k):
            tot = 0.0
            for row in sp_pre.get(k, []):
                row = pad(row, 123)
                for base in (44, 106):
                    for sc in (base + 4, base + 5):
                        try:
                            v = float(row[sc])
                            if v > 0:
                                tot += v / 1000
                        except ValueError:
                            pass
            return tot

        def _wel(k):
            votes = Counter()
            for row in sp_pre.get(k, []):
                row = pad(row, 123)
                for v in row:
                    for t, e in ETOK2.items():
                        if v == t or ("/" in str(v) and t in str(v).split("/")):
                            votes[e] += 1
                for ci in (70, 116):
                    if ci < len(row) and row[ci] in ("1", "2", "3", "4", "5", "6"):
                        votes[int(row[ci]) - 1] += 1
            return votes.most_common(1)[0][0] if votes else None

        wpow, wel = {}, {}
        el_bench = {}
        for k, rows in eq_tbl.text_rows().items():
            r = core.normalize_row_length(core.read_csv_lines(rows)[0] if False else
                                          core.read_csv_lines(eq_tbl.text_rows()[k])[0], 12)
            if r[2] != "0":
                continue
            sid = r[10]
            e = _wel(sid)
            if e is None:
                continue
            p = _wpow(sid)
            wpow[sid] = p
            wel[sid] = e
            el_bench[e] = max(el_bench.get(e, 0), min(p, 1000))
        wfactor = {}
        for sid, p in wpow.items():
            if sid in MAINLINE_ORBS or p <= 0:
                continue
            bench = el_bench.get(wel[sid], 800)
            if p < bench:
                wfactor[sid] = min(5.0, bench / p)

        for logical, ib, db, tag in ((SOUL, 44, 106, "soul"), (WAB, 47, 109, "wab")):
            tbl = core.load_table(logical, store)
            p2 = {k: core.read_csv_lines(t) for k, t in tbl.text_rows().items()}
            changed = False
            limcols = (31, 89, 99) if tag == "soul" else (34, 92, 102)
            coolcols = (32, 90) if tag == "soul" else (35, 93)
            # 装备血量条件在 during_trigger(基址 魂珠94/武器97);during_content 存强度(106/109)。
            # 前置枚举 0=Always 非血量,不动。
            dtrcol, dccol = (94, 106) if tag == "soul" else (97, 109)
            ncol = 123 if tag == "soul" else 126   # soul 官方123列,wab=ability布局126列
            for k, rows in p2.items():
                is_orb = tag == "soul" and k in MAINLINE_ORBS
                wf = wfactor.get(k) if tag == "soul" else None   # 武器拉平系数
                new_rows = []
                for row in rows:
                    row[:] = pad(row, ncol)
                    # 武器拉平:低于本属性基准的武器,正面强度按比例拉升(单行封顶500%)
                    if wf:
                        for base in (ib, db):
                            for sc in (base + 4, base + 5):
                                try:
                                    fv = float(row[sc])
                                except ValueError:
                                    continue
                                if fv > 0:
                                    row[sc] = str(min(500000, int(round(fv * wf))))
                        changed = True
                    # 主线证章/黄金宝珠:大幅强化(正面强度×4)+ 删负面副作用行(用户 2026-07-09)
                    if is_orb:
                        neg = False
                        for base in (ib, db):
                            for sc in (base + 4, base + 5):
                                v = row[sc]
                                try:
                                    fv = float(v)
                                except ValueError:
                                    continue
                                if fv < 0:
                                    neg = True
                                elif fv > 0:
                                    row[sc] = str(min(500000, int(round(fv * MAINLINE_ORB_MULT))))
                        if neg:              # 掉抗/掉攻这类倒扣行直接丢弃
                            cnt["orb_neg_drop"] += 1
                            changed = True
                            continue
                        # 触发型强化行去次数上限,常驻满收益
                        for lc in limcols:
                            if row[lc] not in ("", "(None)", "0"):
                                row[lc] = "(None)"
                        cnt["orb_buff"] += 1
                        changed = True
                    new_rows.append(row)
                    # 去掉装备血量要求词条(用户 2026-07-09):HpHigh0/HpLow1/HpIncrease109/HpDecrease110
                    # 持续触发→恒真 HpLow≤100%;HpIncrease 堆叠先取满值
                    if row[dtrcol] in ("0", "1", "109", "110"):
                        if row[dtrcol] == "109":       # HpIncrease 堆叠:单层×层数 → 满值
                            try:
                                stacks = int(float(row[dtrcol + 5]))
                            except ValueError:
                                stacks = 0
                            if stacks >= 2:
                                for sc in (dccol + 4, dccol + 5):
                                    try:
                                        fv = float(row[sc])
                                        if fv > 0:
                                            row[sc] = str(min(500000, int(fv * stacks)))
                                    except ValueError:
                                        pass
                                row[dtrcol + 5] = ""   # 清 trigger_limit
                        row[dtrcol] = "1"              # → HpLow
                        row[dtrcol + 3] = "100000"      # 阈值 100% = 恒真
                        row[dtrcol + 4] = "100000"
                        cnt[f"{tag}_hp_dtr"] += 1
                        changed = True
                    for base, offs in ((ib, (4, 6, 8)), (db, (4, 6))):
                        for offp in offs:
                            a, b = row[base + offp], row[base + offp + 1]
                            try:
                                if a not in ("", "(None)") and b not in ("", "(None)") and float(a) < float(b):
                                    row[base + offp] = b
                                    cnt[f"{tag}_sync"] += 1
                                    changed = True
                            except ValueError:
                                pass
                    # 次数上限:与角色同策略——伤害暖机行=层数×0.6+单层补偿(总量不变,叠更快);
                    # 工具行=少层保×5总量(装备侧此前统一×5被过度放大,2026-07-09 修正)
                    def harm2(name):
                        return any(w in name for w in ("伤害", "攻击力", "特攻")) and "↓" not in name
                    dmg_i2 = row[ib] != "" and harm2(cn_i.get(row[ib], ""))
                    dmg_d2 = row[db] != "" and harm2(cn_d.get(row[db], ""))
                    for ci, dmg2, base in ((limcols[0], dmg_i2, ib),
                                           (limcols[1], dmg_d2, db), (limcols[2], dmg_d2, db)):
                        v = row[ci]
                        if v in ("", "(None)", "0"):
                            continue
                        try:
                            iv = int(float(v))
                        except ValueError:
                            continue
                        if iv < 2:
                            continue
                        newl = max(2, int(round(iv * 0.6)))
                        mult = (iv / newl) if dmg2 else (min(LIMIT_CAP, iv * LIMIT_F) / newl)
                        row[ci] = str(newl)
                        for sc in (base + 4, base + 5):
                            try:
                                fv = float(row[sc])
                                if fv > 0:
                                    row[sc] = str(round05_raw(fv * mult, up=True))
                            except ValueError:
                                pass
                        cnt[f"{tag}_limit"] += 1
                        changed = True
                    for ci in coolcols:   # 装备侧阶梯冷却
                        v = row[ci]
                        if v not in ("", "(None)", "0", "1"):
                            try:
                                nv = tier_ct(float(v))
                                if nv != int(float(v)):
                                    row[ci] = str(nv)
                                    cnt[f"{tag}_cool"] += 1
                                    changed = True
                            except ValueError:
                                pass
                # 雷系武器:Fever 中扣 Fever 点(特殊玩法,克隆本武器 during 行→Fever触发+负Fever点)
                if tag == "soul" and wel.get(k) == 2 and cnt["wpn_fever_consume"] < 5 and new_rows:
                    tmpl = next((r for r in new_rows if r[94] in ("0", "1", "109", "110")
                                 or (len(r) > 106 and r[106] not in ("", "(None)"))), None)
                    if tmpl is not None:
                        fc = list(tmpl)
                        fc[94] = "4"; fc[95] = "0"        # during_trigger = Fever
                        fc[97] = fc[98] = ""; fc[99] = ""  # 清阈值/次数
                        fc[106] = "18"                    # during_content = Fever点
                        fc[107] = "0"
                        fc[110] = fc[111] = "-20000"      # -20%(负值,金丝雀)
                        if fc not in new_rows:
                            new_rows.append(fc)
                            cnt["wpn_fever_consume"] += 1
                            changed = True
                # 部分武器分有趣词条:克隆本武器已有 during 行(结构必然合法)→ 换 during_content
                # 效果 kind 与强度为按属性的好玩效果。避免手工构造 soul 行导致列错位(2026-07-09)
                if wf and new_rows:
                    fun_kind = {0: "2", 1: "3", 2: "1", 3: "23", 4: "0", 5: "154"}[wel[k]]
                    tmpl = next((r for r in new_rows if r[94] in ("0", "1", "109", "110")
                                 or (len(r) > 106 and r[106] not in ("", "(None)"))), None)
                    if tmpl is not None:
                        fun = list(tmpl)
                        fun[94] = "1"; fun[95] = "0"        # during_trigger HpLow, puller 自身
                        fun[97] = fun[98] = "100000"        # 阈值100%恒真
                        fun[99] = ""                         # 清 trigger_limit
                        fun[106] = fun_kind                  # during_content kind = 属性好玩效果
                        fun[107] = "0"                       # 目标=自身
                        fun[110] = fun[111] = "20000"        # +20%
                        if fun not in new_rows:
                            new_rows.append(fun)
                            cnt["weapon_fun"] += 1
                            changed = True
                p2[k] = new_rows   # 写回(负面证章行已被 continue 丢弃)
            if not dry and changed:
                tbl.set_text_rows({k: core.write_csv_lines(r) for k, r in p2.items()})
                print("写入", core.write_table(tbl, store, suffix))

    # ---- 11 技能能量:已撤销(用户 2026-07-09"能量全部恢复") ----
    # 原 ×0.85+0/5 化层删除;--apply 从锁定基准重建时 action_skill 自动还原官方原值,
    # 发布表列表保留 action_skill 以便把还原后的表下发给客户端。

    rep["layers"] = dict(cnt)
    REPORT.write_text(json.dumps(rep, ensure_ascii=False, indent=1), encoding="utf-8")
    print("=== 总包统计 ===")
    for k, v in sorted(cnt.items()):
        print(f"  {k}: {v}")
    print(f"报告 → {REPORT}")

    if not dry:
        MARKER.write_text(json.dumps({"ts": ts, "suffix": suffix}), encoding="utf-8")
        if args.publish:
            subprocess.run([sys.executable, str(MOD_DIR / "wf_publish.py"), "--tables",
                            "ability,leader_ability,character_status,boss_level,"
                            "ability_soul,weapon_ability,action_skill"],
                           check=True)
    if args.export_pack:
        cdn = ROOT / ".cdn" / "cn" / "archive-common-diff"
        # 打包全部 mod 系增量(文件名带 -mod 标记),对方无论停在链上哪个版本都能续上
        zips = sorted(cdn.glob("pinball-*-mod*.zip"), key=lambda p: p.stat().st_mtime)
        out = ROOT / f"WF平衡增强包-{ts}.zip"
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
            for p in zips:
                z.write(p, f"archive-common-diff/{p.name}")
            z.writestr("使用说明.txt",
                       "WF 平衡增强包(startpoint-cn 私服用)\n"
                       "1. 把 archive-common-diff/ 下的 zip 复制到你的 startpoint-cn/.cdn/cn/archive-common-diff/\n"
                       "2. 服务端动态扫描,无需重启;重启游戏客户端即自动增量下载生效\n"
                       "3. 客户端资源版本需低于包内目标版本(文件名 pinball-<from>-<to>);\n"
                       "   若客户端版本过旧会按版本链依次下载,不影响使用\n"
                       "4. 回滚:删除该 zip,客户端清资源缓存后重下\n")
        print(f"分享包 → {out}")
    if dry:
        print("(dry-run,未写入;--apply 写入,--apply --publish 一键下发,--export-pack 打分享包)")


if __name__ == "__main__":
    main()
