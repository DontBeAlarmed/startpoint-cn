#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
WF 单机版 · 本地网页修改器 (GUI)

在浏览器中修改 WorldFlipper/dummy 数据包,11 个页签全程点鼠标:
  * 词条编辑(逐字段 + 单条主位开关 + 删行) / 角色资料(① 层) / 基础数值+觉醒
  * 技能能量(action_skill) / 能力魂 / 武器词条(equipment_enhancement_ability)
  * 倍率调整 / 词条移植(A→B / 行级 / 队长技→词条槽 / 队长技→队长技整段) / 配方
  * 改动日志(每次写入自动记录) + 一键回溯(还原备份+重新发布+重启游戏)
  * 备份 / 还原;右上角「发布并重启游戏」= wf_publish 打增量包到 CDN + 重启客户端

启动:  python wf_gui.py   (或双击同目录 wf-gui.bat;放在 startpoint-cn/mod-tools/ 内亦可)
浏览器: http://127.0.0.1:8765/

环境变量(可选):
  WF_TARGET_STORE  目标 upload 目录(默认按 profiles.json / 项目根目录查找)
  WF_CDNDATA       服务端 assets/cdndata 目录(①层;独立部署必配,默认取仓库根布局)
  WF_CDN_DIR       服务端 .cdn/cn 目录(发布目标;独立部署必配,默认取仓库根布局)
  WF_ADB           adb.exe 完整路径
  WF_ADB_PORT      模拟器 adb 端口(默认 16384 = MuMu 12)
  WF_PKG           游戏包名(默认 com.leiting.wf,雷霆国服)
  WF_GUI_PORT      本工具监听端口(默认 8765)
"""

from __future__ import annotations

import base64
import csv
import io
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import tempfile
import urllib.error
import urllib.request
import zipfile
import zlib
from contextlib import redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
import wf_mod_tool as core  # noqa: E402
import wf_describe  # noqa: E402  行级中文描述器(逆向布局+枚举直译)
import wf_assets  # noqa: E402    角色资产(立绘/图标/语音)编解码与清单
import wf_dsl  # noqa: E402       技能 ActionDsl 数值编辑
import wf_atf  # noqa: E402       skill_cutin ATF(ETC1)纹理重编码(战斗真机只读 ATF 不读 PNG)
import wf_boss  # noqa: E402      Boss 数值 + 副本列表(Boss·副本页)

ROOT = Path(__file__).resolve().parent.parent
_PROFILE = core.resolve_profile(os.environ.get("WF_PROFILE"))
# ①层 cdndata:独立部署时用 WF_CDNDATA 指向服务端 assets/cdndata
_ENV_CDNDATA = os.environ.get("WF_CDNDATA")
CDNDATA = (Path(_ENV_CDNDATA) if _ENV_CDNDATA
           else _PROFILE.cdndata if _PROFILE and _PROFILE.cdndata
           else ROOT / "assets" / "cdndata")
WORK_DIR = Path(__file__).resolve().parent / "work"
PENDING_FILE = WORK_DIR / "sync_pending.json"

GUI_PORT = int(os.environ.get("WF_GUI_PORT", "8765"))
ADB_PORT = os.environ.get("WF_ADB_PORT", "16384")
PKG = os.environ.get("WF_PKG", "com.leiting.wf")
DEVICE = f"127.0.0.1:{ADB_PORT}"
REMOTE_UPLOAD = "/sdcard/WorldFlipper/dummy/download/production/upload"

# element 6=Colorless 是敌人/boss 专属,给可玩角色写 6 会崩(见 omni_convert 注释);
# 只保留 0-5 供资料页写入。6 仅用于**显示**(万一有 boss 复用体),显示映射另见 ELEMENTS_DISPLAY。
ELEMENTS = {"0": "火", "1": "水", "2": "雷", "3": "风", "4": "光", "5": "暗"}
ELEMENTS_DISPLAY = {**ELEMENTS, "6": "通用"}


# ---------------------------------------------------------------- store


def resolve_store() -> Path:
    env = os.environ.get("WF_TARGET_STORE")
    if env:
        p = Path(env)
        if p.exists():
            return p
        raise SystemExit(f"WF_TARGET_STORE 不存在: {env}")
    if _PROFILE:
        return _PROFILE.store
    store = core.find_world_upload(ROOT)
    if store:
        return store
    raise SystemExit("未找到 WorldFlipper/dummy/.../upload,请设置 WF_TARGET_STORE 或配置 mod-tools/profiles.json")


TARGET_STORE = resolve_store()
SOURCE_STORE = _PROFILE.fallback if _PROFILE else core.default_source_store()


def load_schema():
    return core.load_ability_schema(TARGET_STORE, SOURCE_STORE)


def load_ability_table() -> core.OrderedMap:
    return core.load_table(core.ABILITY_LOGICAL, TARGET_STORE, SOURCE_STORE)


def load_char_table():
    return core.load_character_table_for_lookup(TARGET_STORE, SOURCE_STORE)


# ---------------------------------------------------------------- characters

_char_cache: list[dict] | None = None


def load_characters() -> list[dict]:
    global _char_cache
    if _char_cache is not None:
        return _char_cache
    chars = json.loads((CDNDATA / "character.json").read_text(encoding="utf-8"))
    try:
        texts = json.loads((CDNDATA / "character_text.json").read_text(encoding="utf-8"))
    except Exception:
        texts = {}

    try:
        ability_keys = set(load_ability_table().keys)
    except Exception:
        ability_keys = set()

    out = []
    for cid, rows in chars.items():
        if not rows or not isinstance(rows[0], list):
            continue
        row = rows[0] + [""] * (37 - len(rows[0]))
        trow = (texts.get(cid) or [[]])[0]
        name = trow[0] if len(trow) > 0 else ""
        name_en = trow[1] if len(trow) > 1 else ""
        skill_name = trow[4] if len(trow) > 4 else ""
        abilities = [v for v in row[19:25] if v]
        out.append({
            "id": cid,
            "code_name": row[0],
            "rarity": row[2],
            "element": ELEMENTS_DISPLAY.get(str(row[3]), str(row[3])),
            "race": row[4],
            "role": row[26],
            "leader_id": row[17],   # leader_ability 表键(≠角色ID,如白虎 角色10/队长技3)
            "name": name or row[0],
            "name_en": name_en,
            "skill_name": skill_name,
            "abilities": abilities,
            "in_store": any(a in ability_keys for a in abilities),
        })
    out.sort(key=lambda c: (not c["in_store"], c["id"]))
    _char_cache = out
    return out


# ---------------------------------------------------------------- pending sync list


def read_pending() -> list[str]:
    try:
        return json.loads(PENDING_FILE.read_text(encoding="utf-8"))
    except Exception:
        return []


def add_pending(target: Path) -> None:
    """支持三根:upload=裸 rel;medium_upload/android_upload 加前缀(发布器按前缀分包)。"""
    rel = None
    for prefix, root in (("", TARGET_STORE),
                         ("medium:", TARGET_STORE.parent / "medium_upload"),
                         ("android:", TARGET_STORE.parent / "android_upload")):
        try:
            rel = prefix + target.relative_to(root).as_posix()
            break
        except ValueError:
            continue
    if rel is None:
        raise ValueError(f"文件不在任何数据根下: {target}")
    items = read_pending()
    if rel not in items:
        items.append(rel)
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    PENDING_FILE.write_text(json.dumps(items, indent=2), encoding="utf-8")


def clear_pending() -> None:
    if PENDING_FILE.exists():
        PENDING_FILE.write_text("[]", encoding="utf-8")


# ---------------------------------------------------------------- 改动日志 + 回溯
# 每次写 ② 层数据自动记一条(append-only jsonl):时间/表/键/摘要/备份文件/发布版本。
# 发布时(wf_publish.py)回填 version 并渲染 changelog.md 一并"公布"到 CDN。
# 回溯:按日志条目或备份文件一键还原某表 + 重新发布。

CHANGELOG_FILE = WORK_DIR / "changelog.jsonl"
CHANGELOG_MD = WORK_DIR / "changelog.md"

# 逻辑路径 -> 表别名(与 wf_publish.TABLE_ALIASES 同步,用于日志可读)
_LOGICAL_ALIAS = {
    core.ABILITY_LOGICAL: "ability",
    core.CHARACTER_LOGICAL: "character",
    core.STATUS_LOGICAL: "character_status",
    "master/ability/leader_ability.orderedmap": "leader_ability",
    "master/ability/ability_soul.orderedmap": "ability_soul",
    "master/character/character_awake_status.orderedmap": "character_awake_status",
    "master/skill/action_skill.orderedmap": "action_skill",
    "master/equipment_enhancement/equipment_enhancement_ability.orderedmap": "weapon_ability",
    "master/character/character_text.orderedmap": "character_text",
    "master/character/character_speech.orderedmap": "character_speech",
    "master/skill_preview/skill_preview_character.orderedmap": "skill_preview_character",
    "master/mana_board/mana_board2_open_condition.orderedmap": "mana_board2_open_condition",
    "master/mana_board/upskill.orderedmap": "upskill",
    "master/stance_detail/character_stance_detail.orderedmap": "character_stance_detail",
    "master/generated/character_image.orderedmap": "character_image",
    "master/character/full_shot_image_attribute.orderedmap": "full_shot_image_attribute",
    "master/generated/mana_board.orderedmap": "mana_board",
    "master/mana_board/mana_node.orderedmap": "mana_node",
    "master/character/character_gacha_sound.orderedmap": "character_gacha_sound",
    "master/character/unique_condition.orderedmap": "unique_condition",
    "master/shop/boss_coin_shop.orderedmap": "boss_coin_shop",
    "master/shop/boss_coin_shop_category.orderedmap": "boss_coin_shop_category",
    "master/generated/trimmed_image.orderedmap": "trimmed_image",
}


def _keys_from_summary(summary: str) -> list[str]:
    """从摘要里粗略抽出受影响的键(每行首 token,形如 1411592 / L:141159 / black_wolf_knight)。"""
    keys = []
    for line in (summary or "").splitlines():
        tok = line.strip().split(" ", 1)[0].strip(":")
        if tok and tok not in keys and (tok[0].isalnum() or tok.startswith("L:")):
            keys.append(tok)
    return keys[:8]


def record_change(logical: str, summary: str, backup: "Path | str | None") -> None:
    """追加一条改动日志。失败不影响主流程(日志是旁路)。"""
    try:
        WORK_DIR.mkdir(parents=True, exist_ok=True)
        entry = {
            "ts": time.strftime("%Y-%m-%d %H:%M:%S"),
            "table": _LOGICAL_ALIAS.get(logical, logical),
            "logical": logical,
            "keys": _keys_from_summary(summary),
            "summary": (summary or "").strip(),
            "backup": (str(backup) if backup else None),
            "version": None,
        }
        with CHANGELOG_FILE.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:
        pass


def read_changelog() -> list[dict]:
    if not CHANGELOG_FILE.exists():
        return []
    out = []
    for line in CHANGELOG_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            try:
                out.append(json.loads(line))
            except Exception:
                pass
    return out


def render_changelog_md() -> Path:
    """渲染人类可读的 changelog.md(最新在上)。"""
    rows = read_changelog()
    lines = ["# WF Mod 改动日志", "",
             "| 时间 | 表 | 键 | 改动 | 发布版本 | 备份(回溯用) |",
             "|---|---|---|---|---|---|"]
    for e in reversed(rows):
        keys = ",".join(e.get("keys") or []) or "-"
        summ = (e.get("summary") or "").replace("\n", " / ").replace("|", "/")
        ver = e.get("version") or "(未发布)"
        bak = Path(e["backup"]).name if e.get("backup") else "-"
        lines.append(f"| {e.get('ts','')} | {e.get('table','')} | {keys} | {summ} | {ver} | {bak} |")
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    CHANGELOG_MD.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return CHANGELOG_MD


# ---------------------------------------------------------------- operations


def run_recipe(recipe: dict, dry_run: bool) -> dict:
    buf = io.StringIO()
    schema = load_schema()
    table = load_ability_table()
    char_table = load_char_table()
    with redirect_stdout(buf):
        changes = core.apply_recipe_to_ability(table, schema, recipe, char_table, dry_run)
        written = None
        if not dry_run and changes:
            suffix = ".bak-wfmod-" + time.strftime("%Y%m%d-%H%M%S")
            written = core.write_table(table, TARGET_STORE, suffix, no_backup=False)
    if written:
        add_pending(written)
        record_change(core.ABILITY_LOGICAL, buf.getvalue(),
                      written.with_name(written.name + suffix))
    return {
        "changes": changes,
        "log": buf.getvalue(),
        "written": str(written) if written else None,
        "dry_run": dry_run,
    }


CATEGORY_CN = {
    "power_flip": "强化弹射", "attack_common": "攻击强化", "attack_red": "攻击(火)",
    "attack_blue": "攻击(水)", "attack_yellow": "攻击(雷)", "attack_green": "攻击(风)",
    "attack_white": "攻击(光)", "attack_black": "攻击(暗)", "hp_skill": "生命/技能",
    "action_skill": "技能相关", "fever": "狂热", "skill_gauge": "技能充能",
    "direct_attack": "直接攻击", "combo": "连击", "resist": "抗性", "heal": "治疗",
    "guts": "不屈", "barrier": "屏障", "poison": "毒", "paralysis": "麻痹",
    "condition": "状态", "piercing": "贯穿", "power_flip_lv": "强化弹射Lv",
}


def _pct(v: str) -> str:
    try:
        return f"{int(v) / 1000:g}%"
    except Exception:
        return v


def describe_ability(lines: list[dict], idx: dict[str, int]) -> str:
    """规则化中文备注:类别 + 触发条件 + 数值端点。启发式,以面板为准。
    持续威力列按 schema 列名派生(CN=112/114,global=109/111),不写死下标以免跨版本错位
    (见 docs/版本切换设计.md)。"""
    if not lines:
        return ""
    v1 = lines[0]["values"]
    parts = []
    cat = v1.get("2", "")
    if cat:
        parts.append(CATEGORY_CN.get(cat, cat))
    thr = v1.get("29", "")
    if thr.isdigit() and int(thr) >= 100000:
        parts.append(f"阈值{int(thr) // 100000}次")
    lim = v1.get("33", "")
    if lim.isdigit() and int(lim) > 0:
        parts.append(f"CT{int(lim) / 60:g}秒")

    def col(name: str) -> str:
        return str(idx.get(name, -1))

    if len(lines) == 2:
        v2 = lines[1]["values"]
        a, b = v1.get("50", ""), v2.get("50", "")
        if a.lstrip("-").isdigit() and b.lstrip("-").isdigit():
            lo, hi = sorted((int(a), int(b)))
            parts.append(f"威力 {_pct(str(lo))}→{_pct(str(hi))}(1级→满级)")
        dcol = col("trigger.values.during_content.values.strength.power1")
        da, db = v1.get(dcol, ""), v2.get(dcol, "")
        if da.lstrip("-").isdigit() and db.lstrip("-").isdigit():
            lo, hi = sorted((int(da), int(db)))
            parts.append(f"持续威力 {_pct(str(lo))}→{_pct(str(hi))}")
        ecol = col("trigger.values.during_content.values.strength2.power1")
        ea, eb = v1.get(ecol, ""), v2.get(ecol, "")
        if ea.lstrip("-").isdigit() and eb.lstrip("-").isdigit():
            lo, hi = sorted((int(ea), int(eb)))
            parts.append(f"持续威力2 {_pct(str(lo))}→{_pct(str(hi))}")
    else:
        lo, hi = v1.get("49", ""), v1.get("50", "")
        if lo.lstrip("-").isdigit() and hi.lstrip("-").isdigit():
            parts.append(f"威力 {_pct(lo)}→{_pct(hi)}(1级→满级)")
    return " · ".join(parts)


def leader_title_for(character: str) -> str:
    """队长技称号(character 行第18列)。键优先匹配(白等老行 键≠character_id 列)。"""
    row = core.character_row_for(character, load_char_table())
    if row and row[18] not in ("", "(None)"):
        return row[18]
    return ""


def get_rows_for_character(character: str) -> dict:
    schema = load_schema()
    names = core.schema_names(schema)
    idx_by = core.schema_index(schema)
    table = load_ability_table()
    char_table = load_char_table()
    ids = core.ability_ids_for_character(character, char_table)
    text_rows = table.text_rows()
    rows = []

    def make_lines(text: str) -> list[dict]:
        lines = []
        for line_index, row in enumerate(core.read_csv_lines(text), start=1):
            row = core.normalize_row_length(row, len(names))
            lines.append({"line": line_index,
                          "values": {str(i): v for i, v in enumerate(row) if v != ""}})
        return lines

    for aid in ids:
        text = text_rows.get(aid)
        if text is None:
            rows.append({"ability": aid, "missing": True, "lines": [], "desc": ""})
            continue
        lines = make_lines(text)
        rows.append({"ability": aid, "missing": False, "lines": lines,
                     "desc": describe_ability(lines, idx_by),
                     "line_descs": wf_describe.describe_rows(core.read_csv_lines(text), "ability")})

    # 队长技(leader_ability 表,键=character_id 列;白等老行 键≠该列),伪槽 "L:<id>"
    lid = core.effective_character_id(character, char_table)
    try:
        leader = core.load_table(LEADER_LOGICAL, TARGET_STORE, SOURCE_STORE)
        lt = leader.text_rows().get(lid)
        if lt is not None:
            lines = make_lines(lt)
            rows.append({"ability": f"L:{lid}", "missing": False, "leader": True,
                         "lines": lines, "desc": describe_ability(lines, idx_by),
                         "line_descs": wf_describe.describe_rows(core.read_csv_lines(lt), "leader_ability")})
        else:
            rows.append({"ability": f"L:{lid}", "missing": True, "leader": True,
                         "lines": [], "desc": ""})
    except Exception:
        pass

    return {"character": character, "columns": names, "abilities": rows,
            "leader_title": leader_title_for(character)}


def _write_with_backup(table: core.OrderedMap, parsed: dict, log_lines: list[str]) -> Path:
    table.set_text_rows({k: core.write_csv_lines(r) for k, r in parsed.items()})
    suffix = ".bak-wfmod-gui-" + time.strftime("%Y%m%d-%H%M%S")
    buf = io.StringIO()
    with redirect_stdout(buf):
        written = core.write_table(table, TARGET_STORE, suffix, no_backup=False)
    log_lines.append(buf.getvalue().strip())
    add_pending(written)
    summary = "\n".join(l for l in log_lines if l and not l.startswith("backup"))
    record_change(table.logical_path, summary, written.with_name(written.name + suffix))
    return written


def _table_row_width(parsed: dict, fallback: int) -> int:
    """表真实行宽 = 现有行宽度的众数(leader=124 / ability=126)。
    勿用 schema 的 125:对 leader 多一列、对 ability 少一列,客户端 CSV 解析器
    要求整表等宽,差一列即 InvalidRowWidth 崩溃(2026-07-06 实锤)。"""
    cnt: dict[int, int] = {}
    for rows in parsed.values():
        for r in rows:
            cnt[len(r)] = cnt.get(len(r), 0) + 1
    return max(cnt, key=cnt.get) if cnt else fallback


def _fit_row_width(row: list, width: int) -> list:
    """行宽对齐:短则补空;长且多余尾列全空则裁掉(非空尾列保留并由调用方自查)。"""
    row = core.normalize_row_length(list(row), width)
    if len(row) > width and all(x == "" for x in row[width:]):
        row = row[:width]
    return row


def _remap_cross_table(row: list, src_logical: str, dst_logical: str, dst_rows: list) -> tuple[list, str]:
    """角色词条(126列)↔队长技(124列)跨表列重排(全表 md §2 铁律):
    leader = ability 去掉 c1(unisonable)/c2(类别串),其余整体 -2。
    leader→ability 补 c1=true、c2=目标首行类别(缺省 attack_common);ability→leader 去掉这两列。
    不重排直接跨表写入会整行错位 2 列 → 客户端 U0000(2026-07-05 实测)。"""
    if src_logical == dst_logical:
        return list(row), ""
    if {src_logical, dst_logical} != {core.ABILITY_LOGICAL, LEADER_LOGICAL}:
        raise ValueError("跨表列重排仅支持 角色词条<->队长技(武器/魂列图不同,禁止跨表)")
    if src_logical == LEADER_LOGICAL:
        cat = ""
        if dst_rows:
            r0 = list(dst_rows[0])
            cat = r0[2] if len(r0) > 2 else ""
        cat = cat or "attack_common"
        return [row[0], "true", cat] + list(row[1:]), f"跨表重排 leader→ability(+2 列,补 c1=true c2={cat!r})"
    return [row[0]] + list(row[3:]), "跨表重排 ability→leader(-2 列,去掉 unisonable/类别串)"


def save_row_edits(edits: list[dict], dry_run: bool) -> dict:
    """edits: [{ability, line, index, value}];ability 以 "L:" 开头时写 leader_ability 表。"""
    schema = load_schema()
    names = core.schema_names(schema)
    table = load_ability_table()
    leader = core.load_table(LEADER_LOGICAL, TARGET_STORE, SOURCE_STORE)
    parsed_a = {k: core.read_csv_lines(t) for k, t in table.text_rows().items()}
    parsed_l = {k: core.read_csv_lines(t) for k, t in leader.text_rows().items()}
    width_a = _table_row_width(parsed_a, len(names))
    width_l = _table_row_width(parsed_l, len(names))
    log_lines = []
    changes = {"a": 0, "l": 0}
    for e in edits:
        aid, line, idx, value = str(e["ability"]), int(e["line"]), int(e["index"]), str(e["value"])
        if aid.startswith("L:"):
            parsed, tag, key = parsed_l, "l", aid[2:]
        else:
            parsed, tag, key = parsed_a, "a", aid
        if key not in parsed:
            raise ValueError(f"键不存在: {aid}")
        if line < 1 or line > len(parsed[key]):
            raise ValueError(f"行号越界: {aid} line {line}")
        row = _fit_row_width(parsed[key][line - 1], width_l if tag == "l" else width_a)
        old = row[idx]
        if old == value:
            continue
        row[idx] = value
        parsed[key][line - 1] = row
        changes[tag] += 1
        col = names[idx] if idx < len(names) else str(idx)
        log_lines.append(f"{aid} line {line}: {col} {old!r} -> {value!r}")

    written = []
    total = changes["a"] + changes["l"]
    if not dry_run and total:
        if changes["a"]:
            written.append(str(_write_with_backup(table, parsed_a, log_lines)))
        if changes["l"]:
            written.append(str(_write_with_backup(leader, parsed_l, log_lines)))
    return {"changes": total, "log": "\n".join(l for l in log_lines if l),
            "written": "; ".join(written) or None, "dry_run": dry_run}


def copy_row(src: dict, dst: dict, preserve_string_id: bool, dry_run: bool) -> dict:
    """单个效果(行)级移植。src/dst: {key, line};键前缀 L:=队长技 W:=武器词条 S:=能力魂。
    dst mode: line=N 覆盖该行 / "append" 追加 / "all" 整键替换为这一行。
    只放行 同表移植 + 角色词条<->队长技(历史行为,列图差 2 列需自行按 §5 重排);
    其余跨表组合拒绝——列图不同,盲拷必造成客户端 U0000 崩溃。"""
    schema = load_schema()
    names = core.schema_names(schema)
    idx_by = core.schema_index(schema)
    loaded: dict[str, tuple] = {}

    def pick(keystr):
        logical, key = _table_for_key(keystr)
        if logical not in loaded:
            tobj = core.load_table(logical, TARGET_STORE, SOURCE_STORE)
            loaded[logical] = (tobj, {k: core.read_csv_lines(t) for k, t in tobj.text_rows().items()})
        return loaded[logical][1], logical, key

    sp, slog, skey = pick(src["key"])
    dp, dlog, dkey = pick(dst["key"])
    if slog != dlog and {slog, dlog} != {core.ABILITY_LOGICAL, LEADER_LOGICAL}:
        raise ValueError("跨表移植仅支持 角色词条<->队长技;武器词条/能力魂只能同表移植(列图不同)")
    if skey not in sp:
        raise ValueError(f"来源不存在: {src['key']}")
    if dkey not in dp:
        raise ValueError(f"目标不存在: {dst['key']}")
    dst_width = _table_row_width(dp, len(names))
    srow = list(sp[skey][int(src.get("line", 1)) - 1])
    remap_note = ""
    if slog != dlog:
        srow, remap_note = _remap_cross_table(srow, slog, dlog, dp[dkey])
    srow = _fit_row_width(srow, dst_width)
    sid_idx = idx_by.get("string_id", 0)
    uni_idx = idx_by.get("unisonable", 1)
    # 仅 ability 目标有 unisonable 列(c1);其余表 c1 含义不同,强设 true 会毁坏该行
    if dlog == core.ABILITY_LOGICAL and srow[uni_idx] in ("0", "1", "false", ""):
        srow[uni_idx] = "true"
    mode = dst.get("line", "all")
    old_rows = [_fit_row_width(r, dst_width) for r in dp[dkey]]
    keep_sid = old_rows[0][sid_idx] if (preserve_string_id and old_rows) else None
    new_row = list(srow)
    if keep_sid is not None:
        new_row[sid_idx] = keep_sid
    if mode == "append":
        old_rows.append(new_row)
        action = f"追加为第 {len(old_rows)} 行"
    elif mode == "all":
        old_rows = [new_row]
        action = "整键替换为该行"
    else:
        li = int(mode)
        if li < 1 or li > len(old_rows):
            raise ValueError(f"目标行越界: {li}")
        old_rows[li - 1] = new_row
        action = f"覆盖第 {li} 行"
    log_lines = [f"{src['key']} 行{src.get('line', 1)} -> {dst['key']} ({action})"]
    if remap_note:
        log_lines.append("  " + remap_note)
    written = []
    if not dry_run:
        dp[dkey] = old_rows
        written.append(str(_write_with_backup(loaded[dlog][0], dp, log_lines)))
    return {"changes": 1, "log": "\n".join(log_lines),
            "written": "; ".join(written) or None, "dry_run": dry_run}


def append_line_adapted(src_key: str, src_line: int, dst_key: str, element: str = "auto",
                        adapt_sid: bool = True, clear_awake: bool = True,
                        dry_run: bool = False) -> dict:
    """跨键复制一行词条并自动适配目标(同表限定)。
    适配 = 手工移植铁律的自动化(防跨属性 U0000 崩溃):
      1) 元素:行内元素 token(character_groups 等)与元素枚举列 → 目标属性
         (element="auto":角色词条/队长技按目标角色属性,武器/魂按目标现有词条检测;
          也可传 火/水/雷/风/光/暗 强制;"" = 不改)
      2) string_id 统一为目标首行(角色词条/队长技,描述文本随目标)
      3) 觉醒门槛清零(复制行常驻生效);ability 目标 unisonable=true
      4) 武器目标:解锁强化等级(c1)对齐目标首行"""
    slog, skey = _table_for_key(src_key)
    dlog, dkey = _table_for_key(dst_key)
    if slog != dlog:
        raise ValueError("添加词条行只支持同表复制(角色词条←角色词条 / 武器←武器 / 队长技←队长技 / 魂←魂)")
    kind = {core.ABILITY_LOGICAL: "ability", LEADER_LOGICAL: "leader_ability",
            WEAPON_LOGICAL: "equipment_enhancement_ability", SOUL_LOGICAL: "ability_soul"}[dlog]
    lay = wf_describe.layout(kind)
    table = core.load_table(dlog, TARGET_STORE, SOURCE_STORE)
    parsed = {k: core.read_csv_lines(t) for k, t in table.text_rows().items()}
    if skey not in parsed:
        raise ValueError(f"来源不存在: {src_key}")
    if dkey not in parsed:
        raise ValueError(f"目标不存在: {dst_key}")
    srows = parsed[skey]
    if not (1 <= int(src_line) <= len(srows)):
        raise ValueError(f"来源行号越界: {src_key} 共 {len(srows)} 行")
    ncols = _table_row_width(parsed, int(lay["ncols"]))
    row = _fit_row_width(srows[int(src_line) - 1], ncols)
    log = [f"复制 {src_key} 行{src_line} → {dst_key}(追加为第 {len(parsed[dkey]) + 1} 行)"]

    # ---- 目标属性解析 + 元素适配
    elem_cn = ""
    if element == "auto":
        if kind == "ability":
            o = ability_owner_index().get(dkey)
            cid = o[1] if o else ""
            elem_cn = next((c["element"] for c in load_characters() if c["id"] == cid), "")
        elif kind == "leader_ability":
            # 队长技键≠角色ID(白虎:角色10/队长技3),按 c17 leader_ability_id 反查
            elem_cn = next((c["element"] for c in load_characters()
                            if c.get("leader_id") == dkey), "")
        else:
            elem_cn = _detect_element(parsed[dkey])
    elif element in _CN_ELEM_TOKEN:
        elem_cn = element
    if elem_cn:
        tok = _CN_ELEM_TOKEN[elem_cn]
        for i, v in enumerate(row):
            parts = [p for p in str(v).split("/") if p]
            if parts and all(p in _ELEM_TOKEN_CN for p in parts) and v != tok:
                log.append(f"c{i} 元素组 {v} -> {tok}({elem_cn})")
                row[i] = tok
        for blk, off in (("instant_content", 26), ("during_content", 10)):
            ci = lay["blocks"][blk] + off
            want = _ELEM_TOKEN_NUM[tok]
            if ci < len(row) and row[ci] in ("1", "2", "3", "4", "5", "6") and row[ci] != want:
                log.append(f"c{ci} 元素枚举 {row[ci]} -> {want}({elem_cn})")
                row[ci] = want

    # ---- string_id 统一(c0 是 string_id 的表)
    if adapt_sid and kind in ("ability", "leader_ability"):
        sid = (parsed[dkey][0][0] if parsed[dkey] and parsed[dkey][0] else "")
        if sid and row[0] != sid:
            log.append(f"string_id {row[0]!r} -> {sid!r}(描述文本随目标)")
            row[0] = sid

    # ---- 觉醒门槛 / unisonable / 武器头部
    if kind == "ability":
        if row[1] in ("", "0", "1", "false"):
            row[1] = "true"
        if clear_awake and (row[3] not in ("", "0") or row[4] not in ("", "0")):
            log.append(f"觉醒门槛清零(c3 {row[3]!r}->0, c4 {row[4]!r}->空):复制行常驻生效")
            row[3], row[4] = "0", ""
    elif kind == "leader_ability" and clear_awake:
        if row[1] == "2" or row[2] not in ("", "0"):
            log.append(f"觉醒门槛清零(c1 {row[1]!r}->1, c2 {row[2]!r}->0)")
            row[1], row[2] = "1", "0"
    elif kind == "equipment_enhancement_ability" and parsed[dkey]:
        d0 = core.normalize_row_length(list(parsed[dkey][0]), ncols)
        if row[1] != d0[1]:
            log.append(f"解锁强化等级 c1 {row[1]!r} -> {d0[1]!r}(对齐目标武器)")
            row[1] = d0[1]

    new_desc = wf_describe.describe_line(row, kind)
    log.append("适配后效果: " + (new_desc or "(空)"))
    # 元素 token 替换改不了"枚举自带属性"的效果(如 状态抗性火)→ 提醒手动换枚举
    if elem_cn:
        others = {e for e in "火水雷风光暗" if e in new_desc and e != elem_cn}
        if others:
            log.append(f"⚠ 效果描述仍含[{'/'.join(sorted(others))}]:该效果枚举本身是属性变体,"
                       f"要彻底换属性需手动改效果枚举值(查词条速查或全表 §6)")

    written = None
    if not dry_run:
        parsed[dkey].append(row)
        written = str(_write_with_backup(table, parsed, log))
    return {"changes": 1, "log": "\n".join(log), "written": written,
            "dry_run": dry_run, "adapted_desc": new_desc}


def append_ability_lines(src_key: str, dst_key: str, preserve_string_id: bool,
                         dry_run: bool) -> dict:
    """整词条追加移植:把 src_key 的**所有效果行**追加到 dst_key 之后(不覆盖原有行)。
    key 前缀 "L:" 表示 leader_ability 表。用于「把 A 的能力 N 添加到 B 的能力 M」。
    每条追加行统一 unisonable=true(避免入队/主位限制);preserve_string_id=True 时
    追加行沿用 dst 首行的 string_id(否则保留来源自己的描述键)。"""
    schema = load_schema()
    names = core.schema_names(schema)
    idx_by = core.schema_index(schema)
    table = load_ability_table()
    leader = core.load_table(LEADER_LOGICAL, TARGET_STORE, SOURCE_STORE)
    parsed_a = {k: core.read_csv_lines(t) for k, t in table.text_rows().items()}
    parsed_l = {k: core.read_csv_lines(t) for k, t in leader.text_rows().items()}

    def pick(keystr):
        if str(keystr).startswith("L:"):
            return parsed_l, "l", str(keystr)[2:]
        return parsed_a, "a", str(keystr)

    sp, _, skey = pick(src_key)
    dp, dtag, dkey = pick(dst_key)
    if skey not in sp:
        raise ValueError(f"来源不存在: {src_key}")
    if dkey not in dp:
        raise ValueError(f"目标不存在: {dst_key}")
    sid_idx = idx_by.get("string_id", 0)
    uni_idx = idx_by.get("unisonable", 1)
    stag = "l" if str(src_key).startswith("L:") else "a"
    slog_t = LEADER_LOGICAL if stag == "l" else core.ABILITY_LOGICAL
    dlog_t = LEADER_LOGICAL if dtag == "l" else core.ABILITY_LOGICAL
    dst_width = _table_row_width(parsed_l if dtag == "l" else parsed_a, len(names))
    dst_rows = [_fit_row_width(r, dst_width) for r in dp[dkey]]
    keep_sid = dst_rows[0][sid_idx] if (preserve_string_id and dst_rows) else None
    added = []
    remap_note = ""
    for r in sp[skey]:
        row = list(r)
        if slog_t != dlog_t:
            row, remap_note = _remap_cross_table(row, slog_t, dlog_t, dp[dkey])
        row = _fit_row_width(row, dst_width)
        # 仅 ability 目标有 unisonable 列(c1);leader 表 c1=awake_kind,强设 true 会毁坏该行
        if dtag == "a" and row[uni_idx] in ("0", "1", "false", ""):
            row[uni_idx] = "true"
        if keep_sid is not None:
            row[sid_idx] = keep_sid
        added.append(row)
    new_rows = dst_rows + added
    log_lines = [f"{src_key} 全部 {len(added)} 行 -> 追加到 {dst_key}"
                 f"(原 {len(dst_rows)} 行 → 共 {len(new_rows)} 行)"]
    if remap_note:
        log_lines.append("  " + remap_note)
    written = None
    if not dry_run:
        dp[dkey] = new_rows
        if dtag == "a":
            written = str(_write_with_backup(table, parsed_a, log_lines))
        else:
            written = str(_write_with_backup(leader, parsed_l, log_lines))
    return {"changes": len(added), "log": "\n".join(log_lines),
            "written": written, "dry_run": dry_run}


# 前置块基址 precondition1/2/3(词条条件代码全表.md §2;leader 头部少 2 列故整体 -2)
_PRECON_BASES = {"a": (6, 13, 20), "l": (4, 11, 18)}

# 前置块内相对偏移 → 字段名(全表 §3)
_PRECON_OFF_NAMES = {0: "kind", 1: "trigger_puller", 2: "trigger_puller.character_groups",
                     3: "threshold.power1", 4: "threshold.first_max",
                     5: "character_groups", 6: "unique_condition_id"}

# 常用可清除的前置条件列组,按"块序号 + 块内相对偏移"定义(全表 §3:
# +0=kind, +3/+4=threshold 对, +5=character_groups),由 transplant_line 按
# 目标表类型换算成绝对列号;zero_kind=True 时把块内 kind 列写回 0(Always),
# 避免 Member 等条件挂着空阈值
STRIP_PRESETS = {
    # 属性共鸣前置:清前置1块的 threshold 对 + 角色组,kind 回 Always(去掉共鸣门槛)
    "element_resonance": {"block": 0, "offsets": [3, 4, 5], "zero_kind": True},
    # 第二/第三前置(整块保守清除:kind 回 Always,其余 6 列清空)
    "precondition2": {"block": 1, "offsets": [1, 2, 3, 4, 5, 6], "zero_kind": True},
    "precondition3": {"block": 2, "offsets": [1, 2, 3, 4, 5, 6], "zero_kind": True},
}


def transplant_line(src_key: str, src_line: int, dst_key: str, mode: str,
                    strip_cols: list[int] | str | None, preserve_string_id: bool,
                    dry_run: bool) -> dict:
    """行级移植 + 可选清除前置条件列。
    src_key/dst_key 前缀 "L:" = leader_ability 表。
    mode: "append" 追加 / "N" 覆盖第 N 行 / "all" 整键替换。
    strip_cols: STRIP_PRESETS 预设名(按目标表类型换算列号)或显式绝对列号列表。"""
    schema = load_schema()
    names = core.schema_names(schema)
    idx_by = core.schema_index(schema)
    table = load_ability_table()
    leader = core.load_table(LEADER_LOGICAL, TARGET_STORE, SOURCE_STORE)
    parsed_a = {k: core.read_csv_lines(t) for k, t in table.text_rows().items()}
    parsed_l = {k: core.read_csv_lines(t) for k, t in leader.text_rows().items()}

    def pick(keystr):
        if str(keystr).startswith("L:"):
            return parsed_l, "l", str(keystr)[2:]
        return parsed_a, "a", str(keystr)

    sp, stag, skey = pick(src_key)
    dp, dtag, dkey = pick(dst_key)
    if skey not in sp:
        raise ValueError(f"来源不存在: {src_key}")
    if dkey not in dp:
        raise ValueError(f"目标不存在: {dst_key}")
    if not (1 <= int(src_line) <= len(sp[skey])):
        raise ValueError(f"来源行越界: {src_key} 共 {len(sp[skey])} 行")
    sid_idx = idx_by.get("string_id", 0)
    uni_idx = idx_by.get("unisonable", 1)
    dst_width = _table_row_width(parsed_l if dtag == "l" else parsed_a, len(names))
    new_row = list(sp[skey][int(src_line) - 1])
    remap_note = ""
    if stag != dtag:
        new_row, remap_note = _remap_cross_table(
            new_row, LEADER_LOGICAL if stag == "l" else core.ABILITY_LOGICAL,
            LEADER_LOGICAL if dtag == "l" else core.ABILITY_LOGICAL, dp[dkey])
    new_row = _fit_row_width(new_row, dst_width)
    # 仅 ability 目标有 unisonable 列(c1);leader 表 c1=awake_kind,强设 true 会毁坏该行
    if dtag == "a" and new_row[uni_idx] in ("0", "1", "false", ""):
        new_row[uni_idx] = "true"
    dst_rows = [_fit_row_width(r, dst_width) for r in dp[dkey]]
    if preserve_string_id and dst_rows:
        new_row[sid_idx] = dst_rows[0][sid_idx]
    strip_pairs: list[tuple[int, str]] = []  # (绝对列号, 日志用字段名)
    zero_pairs: list[tuple[int, str]] = []
    if isinstance(strip_cols, str):
        preset = STRIP_PRESETS.get(strip_cols)
        if preset is None:
            raise ValueError(f"未知 strip 预设: {strip_cols}")
        base = _PRECON_BASES[dtag][preset["block"]]
        blk = f"前置{preset['block'] + 1}"
        # 标签按全表 §3 偏移名生成(schema 列名已知错位,不可用于日志)
        strip_pairs = [(base + off, f"{blk}.{_PRECON_OFF_NAMES[off]}")
                       for off in preset["offsets"]]
        if preset["zero_kind"]:
            zero_pairs = [(base, f"{blk}.kind")]
    else:
        strip_pairs = [(c, names[c].split(".")[-1]) for c in (strip_cols or [])]
    stripped = []
    for c, lab in strip_pairs:
        if new_row[c] not in ("", "(None)"):
            stripped.append(f"c{c}({lab})={new_row[c]}->空")
            new_row[c] = ""
    for c, lab in zero_pairs:
        if new_row[c] not in ("", "0"):
            stripped.append(f"c{c}({lab})={new_row[c]}->0")
        new_row[c] = "0"
    if mode == "append":
        dst_rows.append(new_row); action = f"追加为第 {len(dst_rows)} 行"
    elif mode == "all":
        dst_rows = [new_row]; action = "整键替换"
    else:
        li = int(mode)
        if not (1 <= li <= len(dst_rows)):
            raise ValueError(f"目标行越界: {li}")
        dst_rows[li - 1] = new_row; action = f"覆盖第 {li} 行"
    log_lines = [f"{src_key} 行{src_line} -> {dst_key} ({action})"]
    if remap_note:
        log_lines.append("  " + remap_note)
    if stripped:
        log_lines.append("  清除前置: " + ", ".join(stripped))
    written = None
    if not dry_run:
        dp[dkey] = dst_rows
        if dtag == "a":
            written = str(_write_with_backup(table, parsed_a, log_lines))
        else:
            written = str(_write_with_backup(leader, parsed_l, log_lines))
    return {"changes": 1, "stripped": stripped, "log": "\n".join(log_lines),
            "written": written, "dry_run": dry_run}


def mainpos(action: str) -> dict:
    """主位限制开关:unisonable=false 的入队限制。status/remove/restore。"""
    schema = load_schema()
    names = core.schema_names(schema)
    table = load_ability_table()
    parsed = {k: core.read_csv_lines(t) for k, t in table.text_rows().items()}
    count_false = sum(1 for rows in parsed.values() for r in rows if len(r) > 1 and r[1] == "false")
    if action == "status":
        return {"restricted_rows": count_false,
                "state": "已解除" if count_false == 0 else f"存在 {count_false} 行限制"}
    log_lines = []
    changes = 0
    if action == "remove":
        for rows in parsed.values():
            for r in rows:
                if len(r) > 1 and r[1] == "false":
                    r[1] = "true"
                    changes += 1
    elif action == "restore":
        tbl_path = core.table_path(TARGET_STORE, core.ABILITY_LOGICAL)
        bak = tbl_path.parent / (tbl_path.name + ".bak-main-position")
        if not bak.exists():
            raise ValueError("找不到原始备份 .bak-main-position,无法还原")
        pristine = core.read_orderedmap_file(bak, core.ABILITY_LOGICAL)
        pmap = {k: core.read_csv_lines(t) for k, t in pristine.text_rows().items()}
        for key, rows in parsed.items():
            prows = pmap.get(key)
            if not prows:
                continue
            for i, r in enumerate(rows):
                if i < len(prows) and len(prows[i]) > 1 and len(r) > 1 and r[1] != prows[i][1]:
                    r[1] = prows[i][1]
                    changes += 1
    else:
        raise ValueError(f"未知动作: {action}")
    written = None
    if changes:
        written = str(_write_with_backup(table, parsed, log_lines))
    return {"changes": changes, "log": "\n".join(log_lines),
            "written": written, "action": action}


LEADER_LOGICAL = "master/ability/leader_ability.orderedmap"


def copy_leader_to_slot(from_character: str, to_character: str, slot: int,
                        preserve_string_id: bool, dry_run: bool) -> dict:
    """把 from_character 的队长技(leader_ability 表)复制为 to_character 的第 slot 个词条。

    ⚠️ 不安全:leader 表 124 列、ability 表 126 列,头部与块基址不同(全表 §2)。
    2026-07-06 起已内置 leader→ability 列重排(+2 列,补 c1=true/c2=类别串)+行宽对齐,
    不再产生错位 2 列的 U0000。仍建议优先 copy_leader_to_leader(同表语义更直观)。"""
    schema = load_schema()
    names = core.schema_names(schema)
    index_by_name = core.schema_index(schema)
    leader = core.load_table(LEADER_LOGICAL, TARGET_STORE, SOURCE_STORE)
    table = load_ability_table()
    char_table = load_char_table()

    from_character = core.effective_character_id(from_character, char_table)
    src_text = leader.text_rows().get(from_character)
    if src_text is None:
        raise ValueError(f"leader_ability 表中没有角色 {from_character}")
    src_rows = [list(r) for r in core.read_csv_lines(src_text)]

    target_ids = core.ability_ids_for_character(to_character, char_table)
    if not (1 <= int(slot) <= len(target_ids)):
        raise ValueError(f"槽位越界: {slot}")
    dst_key = target_ids[int(slot) - 1]
    parsed = {k: core.read_csv_lines(t) for k, t in table.text_rows().items()}
    if dst_key not in parsed:
        raise ValueError(f"目标词条不存在于数据包: {dst_key}")

    dst_width = _table_row_width(parsed, len(names))
    old_rows = [_fit_row_width(r, dst_width) for r in parsed[dst_key]]
    sid_idx = index_by_name.get("string_id", 0)
    uni_idx = index_by_name.get("unisonable", 1)
    log_lines = []
    new_rows = []
    remap_note = ""
    for r in src_rows:
        nr, remap_note = _remap_cross_table(r, LEADER_LOGICAL, core.ABILITY_LOGICAL, parsed[dst_key])
        new_rows.append(_fit_row_width(nr, dst_width))
    for i, row in enumerate(new_rows):
        if preserve_string_id and i < len(old_rows):
            row[sid_idx] = old_rows[i][sid_idx]
        if row[uni_idx] in ("0", "1", "false", ""):
            row[uni_idx] = "true"
    log_lines.append(f"{from_character} 队长技 ({len(new_rows)} 行) -> {dst_key} (槽位 {slot})")
    if remap_note:
        log_lines.append("  " + remap_note)

    written = None
    if not dry_run:
        parsed[dst_key] = new_rows
        table.set_text_rows({k: core.write_csv_lines(r) for k, r in parsed.items()})
        suffix = ".bak-wfmod-gui-" + time.strftime("%Y%m%d-%H%M%S")
        buf = io.StringIO()
        with redirect_stdout(buf):
            written = core.write_table(table, TARGET_STORE, suffix, no_backup=False)
        log_lines.append(buf.getvalue().strip())
        add_pending(written)
    return {"changes": len(new_rows), "log": "\n".join(log_lines),
            "written": str(written) if written else None, "dry_run": dry_run}


def copy_leader_to_leader(from_character: str, to_character: str,
                          preserve_string_id: bool, dry_run: bool) -> dict:
    """队长技移植:把 from_character 的队长技整行复制为 to_character 的队长技
    (leader_ability 表内 行=角色ID,直接整键覆盖)。
    preserve_string_id=False 时连 string_id 一并复制 → 目标角色队长技描述也换成来源的。"""
    schema = load_schema()
    names = core.schema_names(schema)
    index_by_name = core.schema_index(schema)
    leader = core.load_table(LEADER_LOGICAL, TARGET_STORE, SOURCE_STORE)
    parsed = {k: core.read_csv_lines(t) for k, t in leader.text_rows().items()}
    ct = load_char_table()
    from_character = core.effective_character_id(from_character, ct)
    to_character = core.effective_character_id(to_character, ct)
    if from_character not in parsed:
        raise ValueError(f"leader_ability 表中没有来源角色 {from_character}")
    if to_character not in parsed:
        raise ValueError(f"leader_ability 表中没有目标角色 {to_character}")
    sid_idx = index_by_name.get("string_id", 0)
    lw = _table_row_width(parsed, len(names))
    src_rows = [_fit_row_width(r, lw) for r in parsed[from_character]]
    old_rows = [_fit_row_width(r, lw) for r in parsed[to_character]]
    old_sid = old_rows[0][sid_idx] if old_rows else None
    new_rows = [list(r) for r in src_rows]
    if preserve_string_id and old_sid is not None:
        for r in new_rows:
            r[sid_idx] = old_sid
    log_lines = [f"{from_character} 队长技 ({len(new_rows)} 行) -> {to_character} 队长技 (整行替换"
                 + ("，保留原 string_id)" if preserve_string_id else "，连描述一并移植)")]
    written = None
    if not dry_run:
        parsed[to_character] = new_rows
        written = str(_write_with_backup(leader, parsed, log_lines))
    return {"changes": len(new_rows), "log": "\n".join(log_lines),
            "written": written, "dry_run": dry_run}


def schema_enums(schema) -> dict[int, dict[str, str]]:
    """列号 -> {数值: 枚举名},用于把 202 之类的值标注为 OwnerIsMain。"""
    out: dict[int, dict[str, str]] = {}
    for item in schema:
        cons = item["type"].get("constructors") or {}
        if cons:
            out[int(item["index"])] = {str(v): str(k) for k, v in cons.items()}
    return out


def ability_owner_index() -> dict[str, tuple[str, str, int]]:
    """ability_id -> (角色名, 角色id, 槽位)。"""
    m: dict[str, tuple[str, str, int]] = {}
    for c in load_characters():
        for i, aid in enumerate(c["abilities"], 1):
            m[aid] = (c["name"], c["id"], i)
    return m


def export_annotated() -> dict:
    """导出标注版 CSV:角色名/槽位 + 枚举值带名称,两行按数值大小标记 满级/1级。"""
    schema = load_schema()
    names = core.schema_names(schema)
    enums = schema_enums(schema)
    owners = ability_owner_index()
    table = load_ability_table()
    out_dir = Path(__file__).resolve().parent / "edit"
    out_dir.mkdir(parents=True, exist_ok=True)
    import csv as _csv
    out = out_dir / ("ability_annotated_" + time.strftime("%Y%m%d-%H%M%S") + ".csv")

    def annotate(idx: int, value: str) -> str:
        if not value:
            return ""
        name = enums.get(idx, {}).get(value)
        return f"{value} [{name}]" if name else value

    with out.open("w", newline="", encoding="utf-8-sig") as fh:
        w = _csv.writer(fh)
        w.writerow(["角色", "角色ID", "槽位", "_ability", "_line", "等级端"]
                   + [f"{i}:{n}" for i, n in enumerate(names)])
        n = 0
        parsed = {k: [core.normalize_row_length(r, len(names))
                      for r in core.read_csv_lines(t)]
                  for k, t in table.text_rows().items()}
        for key, rows in parsed.items():
            cname, cid, slot = owners.get(key, ("", "", 0))
            # 两行时按 strength 数值大小猜测 满级/1级 端
            tags = [""] * len(rows)
            if len(rows) == 2:
                def mag(r):
                    total = 0
                    for i, v in enumerate(r):
                        if i in (50, 52, 54, 56, 58) and v.lstrip("-").isdigit():
                            total += abs(int(v))
                    return total
                a, b = mag(rows[0]), mag(rows[1])
                if a != b:
                    tags = ["满级值", "1级值"] if a > b else ["1级值", "满级值"]
            for line_index, row in enumerate(rows, start=1):
                w.writerow([cname, cid, slot or "", key, line_index, tags[line_index - 1]]
                           + [annotate(i, v) for i, v in enumerate(row)])
                n += 1
    return {"out": str(out), "rows": n,
            "hint": "枚举值已标注为 值[名称];写回请用未标注的导出文件或 GUI 编辑"}


def export_all_abilities() -> dict:
    """把全部词条解码导出为可编辑 CSV(整理版,非加密)。"""
    schema = load_schema()
    names = core.schema_names(schema)
    table = load_ability_table()
    out_dir = Path(__file__).resolve().parent / "edit"
    out_dir.mkdir(parents=True, exist_ok=True)
    import csv as _csv
    out = out_dir / ("ability_all_" + time.strftime("%Y%m%d-%H%M%S") + ".csv")
    with out.open("w", newline="", encoding="utf-8-sig") as fh:
        w = _csv.writer(fh)
        w.writerow(["_ability", "_line"] + names)
        n = 0
        for key, line_index, row in core.iter_ability_lines(table):
            w.writerow([key, line_index] + core.normalize_row_length(row, len(names)))
            n += 1
    return {"out": str(out), "rows": n,
            "hint": "编辑后用命令写回: python mod-tools/wf_mod_tool.py import --edited <文件> [--dry-run]"}


# ---------------------------------------------------------------- 词条速查(关键字搜索 + 共用/专属分组)
# 扫 ability / leader_ability / weapon_ability / ability_soul 四表,每键生成行级中文描述,
# 按"从 trigger 列起的 body 内容"做签名分组 → 同签名 = 效果完全相同的共用词条。
# 索引带表文件 mtime 缓存,写入后自动失效重建。

_SEARCH_CACHE: dict = {"stamp": None, "entries": None, "groups": None}
# 各表 body 起始列(=trigger 列):五表 body 同构,从这里起的内容可跨表比较
_KIND_BODY_COL = {"ability": 5, "leader_ability": 3, "ability_soul": 2,
                  "equipment_enhancement_ability": 5}


def _search_stamp() -> str:
    parts = []
    for logical in (core.ABILITY_LOGICAL, LEADER_LOGICAL, WEAPON_LOGICAL, SOUL_LOGICAL):
        try:
            parts.append(str(core.table_path(TARGET_STORE, logical).stat().st_mtime_ns))
        except Exception:
            parts.append("0")
    return "|".join(parts)


def _build_search_index() -> tuple[list[dict], dict]:
    stamp = _search_stamp()
    if _SEARCH_CACHE["stamp"] == stamp:
        return _SEARCH_CACHE["entries"], _SEARCH_CACHE["groups"]
    owners = ability_owner_index()
    id2name = {c["id"]: c["name"] for c in load_characters()}
    entries: list[dict] = []

    def add(logical: str, kind: str, prefix: str, owner_fn) -> None:
        table = core.load_table(logical, TARGET_STORE, SOURCE_STORE)
        body_col = _KIND_BODY_COL[kind]
        for k, t in table.text_rows().items():
            rows = core.read_csv_lines(t)
            descs = [d for d in wf_describe.describe_rows(rows, kind) if d]
            body = "\n".join(",".join(r[body_col:]) for r in rows)
            owner, slot = owner_fn(k)
            sid = rows[0][0] if rows and kind in ("ability", "leader_ability") else ""
            entries.append({"key": prefix + k, "kind": kind, "owner": owner, "slot": slot,
                            "desc": " ┃ ".join(descs), "sid": sid,
                            "sig": hash(body), "lines": len(rows)})

    def char_owner(k: str):
        o = owners.get(k)
        return (o[0], o[2]) if o else ("(未被角色引用)", 0)

    eqinfo = equipment_info()

    def eq_owner(prefix_cn):
        def fn(k):
            ei = eqinfo.get(k, {})
            return (prefix_cn + "·" + (ei.get("enh_name") or ei.get("name") or k), 0)
        return fn

    add(core.ABILITY_LOGICAL, "ability", "", char_owner)
    add(LEADER_LOGICAL, "leader_ability", "L:", lambda k: (id2name.get(k, k) + "·队长技", 0))
    add(WEAPON_LOGICAL, "equipment_enhancement_ability", "W:", eq_owner("武器"))
    add(SOUL_LOGICAL, "ability_soul", "S:", eq_owner("魂珠"))

    groups: dict = {}
    for e in entries:
        groups.setdefault(e["sig"], []).append(e)
    _SEARCH_CACHE.update(stamp=stamp, entries=entries, groups=groups)
    return entries, groups


def search_abilities(q: str, limit: int = 150) -> dict:
    """关键字搜四表词条(中文描述/归属角色/键/string_id),命中项带同效果分组。"""
    entries, groups = _build_search_index()
    ql = q.strip().lower()
    if not ql:
        raise ValueError("请输入关键字(效果中文/角色名/词条ID/string_id 均可)")
    hits = []
    for e in entries:
        hay = (e["desc"] + " " + e["owner"] + " " + e["key"] + " " + e["sid"]).lower()
        if ql in hay:
            share = groups[e["sig"]]
            hits.append({"key": e["key"], "kind": e["kind"], "owner": e["owner"],
                         "slot": e["slot"], "desc": e["desc"], "sid": e["sid"],
                         "lines": e["lines"], "shared_count": len(share),
                         "shared": [{"key": s["key"], "owner": s["owner"], "slot": s["slot"]}
                                    for s in share[:24] if s["key"] != e["key"]]})
            if len(hits) >= limit:
                break
    return {"query": q, "count": len(hits), "results": hits}


# ---------------------------------------------------------------- 能力魂 ability_soul
# ability_soul.orderedmap 与 ability 同 schema(键=能力魂 ID,如 2020001);
# 属 ② 层手机包数据,改后走 adb 同步(加入 pending)。

SOUL_LOGICAL = "master/ability/ability_soul.orderedmap"


def list_souls() -> list[dict]:
    schema = load_schema()
    names = core.schema_names(schema)
    idx_by = core.schema_index(schema)
    rarity_idx = idx_by.get("rarity", 2)
    table = core.load_table(SOUL_LOGICAL, TARGET_STORE, SOURCE_STORE)
    info = equipment_info()  # 魂珠与装备同键:借装备表拿中文名/品质/类型
    out = []
    for k, t in table.text_rows().items():
        rows = core.read_csv_lines(t)
        r0 = core.normalize_row_length(rows[0], len(names)) if rows else []
        ei = info.get(k, {})
        out.append({"id": k, "string_id": r0[0] if r0 else "",
                    "rarity": r0[rarity_idx] if r0 else "", "lines": len(rows),
                    "name": ei.get("name", ""), "eq_rarity": ei.get("rarity", ""),
                    "kind": ei.get("kind", "")})
    out.sort(key=lambda s: (-int(s["eq_rarity"] or 0), s["id"]))
    return out


def get_soul_rows(soul_id: str) -> dict:
    schema = load_schema()
    names = core.schema_names(schema)
    idx_by = core.schema_index(schema)
    table = core.load_table(SOUL_LOGICAL, TARGET_STORE, SOURCE_STORE)
    text = table.text_rows().get(str(soul_id))
    if text is None:
        raise ValueError(f"能力魂不存在: {soul_id}")
    lines = []
    for li, row in enumerate(core.read_csv_lines(text), start=1):
        row = core.normalize_row_length(row, len(names))
        lines.append({"line": li, "values": {str(i): v for i, v in enumerate(row) if v != ""}})
    return {"soul": str(soul_id), "columns": names, "lines": lines,
            "desc": describe_ability(lines, idx_by),
            "line_descs": wf_describe.describe_rows(core.read_csv_lines(text), "ability_soul"),
            "info": equipment_info().get(str(soul_id), {})}


def _save_single_table_edits(logical: str, edits: list[dict], dry_run: bool, bak_tag: str) -> dict:
    """通用单表逐字段保存:edits=[{key,line,index,value}]。走 pending(② 层需同步)。"""
    schema = load_schema()
    names = core.schema_names(schema)
    table = core.load_table(logical, TARGET_STORE, SOURCE_STORE)
    parsed = {k: core.read_csv_lines(t) for k, t in table.text_rows().items()}
    width = _table_row_width(parsed, len(names))
    log_lines = []
    changes = 0
    for e in edits:
        key, line, idx, value = str(e["key"]), int(e["line"]), int(e["index"]), str(e["value"])
        if key not in parsed:
            raise ValueError(f"键不存在: {key}")
        if line < 1 or line > len(parsed[key]):
            raise ValueError(f"行号越界: {key} line {line}")
        row = _fit_row_width(parsed[key][line - 1], width)
        if row[idx] == value:
            continue
        col = names[idx] if idx < len(names) else str(idx)
        log_lines.append(f"{key} line {line}: {col} {row[idx]!r} -> {value!r}")
        row[idx] = value
        parsed[key][line - 1] = row
        changes += 1
    written = None
    if not dry_run and changes:
        table.set_text_rows({k: core.write_csv_lines(r) for k, r in parsed.items()})
        suffix = bak_tag + time.strftime("%Y%m%d-%H%M%S")
        buf = io.StringIO()
        with redirect_stdout(buf):
            written = core.write_table(table, TARGET_STORE, suffix, no_backup=False)
        add_pending(written)
        record_change(logical, "\n".join(log_lines),
                      written.with_name(written.name + suffix))
    return {"changes": changes, "log": "\n".join(log_lines),
            "written": str(written) if written else None, "dry_run": dry_run}


def save_soul_rows(edits: list[dict], dry_run: bool) -> dict:
    return _save_single_table_edits(SOUL_LOGICAL, edits, dry_run, ".bak-wfmod-soul-")


# ---------------------------------------------------------------- 词条删行(增删改的"删")


def _table_for_key(key: str) -> tuple[str, str]:
    """键前缀 -> (逻辑路径, 真实键)。L:=队长技 W:=武器词条 S:=能力魂,无前缀=角色词条。"""
    ks = str(key)
    if ks.startswith("L:"):
        return LEADER_LOGICAL, ks[2:]
    if ks.startswith("W:"):
        return WEAPON_LOGICAL, ks[2:]
    if ks.startswith("S:"):
        return SOUL_LOGICAL, ks[2:]
    return core.ABILITY_LOGICAL, ks


def delete_line(key: str, line: int, dry_run: bool) -> dict:
    """删除某键的第 line 行(1 起)。key 前缀:L:=队长技 W:=武器词条 S:=能力魂。"""
    logical, real_key = _table_for_key(key)
    table = core.load_table(logical, TARGET_STORE, SOURCE_STORE)
    parsed = {k: core.read_csv_lines(t) for k, t in table.text_rows().items()}
    if real_key not in parsed:
        raise ValueError(f"键不存在: {key}")
    rows = parsed[real_key]
    if not (1 <= int(line) <= len(rows)):
        raise ValueError(f"行号越界: {key} 共 {len(rows)} 行")
    if len(rows) <= 1:
        raise ValueError("该词条只剩 1 行,删除会清空整键;如需清空请改用其它方式")
    removed = rows.pop(int(line) - 1)
    log = f"{key} 删除第 {line} 行(剩 {len(rows)} 行)"
    written = None
    if not dry_run:
        written = str(_write_with_backup(table, parsed, [log]))
    return {"changes": 1, "log": log, "written": written, "dry_run": dry_run}


def mainpos_one(ability: str, line: int, action: str, dry_run: bool) -> dict:
    """单条词条的主位限制开关。action: on(加限制=仅主位)/ off(解除)。
    on: c1 unisonable→false;off: c1→true 且把前置里的 202(OwnerIsMain)→0。"""
    schema = load_schema()
    names = core.schema_names(schema)
    idx = core.schema_index(schema)
    uni = idx.get("unisonable", 1)
    table = load_ability_table()
    parsed = {k: core.read_csv_lines(t) for k, t in table.text_rows().items()}
    if str(ability) not in parsed:
        raise ValueError(f"词条不存在: {ability}")
    rows = parsed[str(ability)]
    if not (1 <= int(line) <= len(rows)):
        raise ValueError(f"行号越界: {ability} 共 {len(rows)} 行")
    row = _fit_row_width(rows[int(line) - 1], _table_row_width(parsed, len(names)))
    log = []
    if action == "on":
        if row[uni] != "false":
            log.append(f"{ability} line{line}: unisonable {row[uni]!r}->false(仅主位)")
            row[uni] = "false"
    elif action == "off":
        if row[uni] == "false":
            log.append(f"{ability} line{line}: unisonable false->true")
            row[uni] = "true"
        for i, v in enumerate(row):
            if v == "202":
                log.append(f"{ability} line{line}: c{i} OwnerIsMain(202)->0")
                row[i] = "0"
    else:
        raise ValueError("action 只能是 on / off")
    rows[int(line) - 1] = row
    written = None
    if log and not dry_run:
        written = str(_write_with_backup(table, parsed, log))
    return {"changes": len(log), "log": "\n".join(log), "written": written, "dry_run": dry_run}


# ---------------------------------------------------------------- 词条工坊(按块结构化组装/编辑词条行)
# 依据 ability_enum_map.json 的块布局(五表基址+块内字段偏移)把 126/124/123 列的行
# 拆成「前置条件/触发/效果」表单;前端组装完整行后按行写回(追加或覆盖)。
# 行状态始终是完整 row(未知列原样保留),不做 spec 重建 → 不丢未逆向列。

# 单元格禁引号/换行(破坏单行 CSV)。逗号放行:官方数据即有含逗号单元格
# (leader 121177 行4 powerflip_override.levels="1,2,3",CSV 引号包裹),
# write_csv_lines(csv.writer)会自动加引号,客户端解析器已被官方数据证实支持。
_CELL_BAD = re.compile(r'["\r\n]')


def _kind_by_logical(logical: str) -> str:
    # 惰性映射:WEAPON_LOGICAL 等常量定义在本函数之后,不能在模块级引用
    return {core.ABILITY_LOGICAL: "ability", LEADER_LOGICAL: "leader_ability",
            WEAPON_LOGICAL: "equipment_enhancement_ability",
            SOUL_LOGICAL: "ability_soul"}[logical]


def _composer_ctx(key: str):
    logical, real = _table_for_key(key)
    kind = _kind_by_logical(logical)
    table = core.load_table(logical, TARGET_STORE, SOURCE_STORE)
    parsed = {k: core.read_csv_lines(t) for k, t in table.text_rows().items()}
    width = _table_row_width(parsed, int(wf_describe.layout(kind)["ncols"]))
    return logical, real, kind, table, parsed, width


def composer_meta() -> dict:
    m = wf_describe.enum_map()
    kinds = {}
    for kind, lay in m["layouts"].items():
        kinds[kind] = {"ncols": lay["ncols"], "blocks": lay["blocks"],
                       "head": lay.get("head", []),
                       "trigger_col": lay["blocks"]["precondition1"] - 1}
    ucs = []
    try:
        for u in list_unique_conditions()["conditions"]:
            ucs.append({"id": u["id"], "name": u["name"]})
    except Exception:
        pass
    small = {
        "target": {str(k): v for k, v in wf_describe.TARGET_CN.items()},
        "puller": {str(k): v for k, v in wf_describe.PULLER_CN.items()},
        "element": {str(k): v for k, v in wf_describe.ELEMENT_CN.items()},
        "precontent": {str(k): v for k, v in wf_describe.PRECONTENT_CN.items()},
        "multiply": {str(k): v for k, v in wf_describe.MULTIPLY_CN.items()},
        "opening": {str(k): v for k, v in wf_describe.OPENING_CN.items()},
    }
    return {"kinds": kinds, "block_fields": m["block_fields"],
            "enums": wf_describe.enum_options(), "small": small,
            "groups": {tok: wf_describe.GROUP_CN.get(tok, tok)
                       for tok in m["character_groups_seen"]},
            "categories": list(m["category_strings"].keys()),
            "usage": m["usage_counts"], "unique_conditions": ucs,
            "note": "数值单位:强度类 1000=1%;阈值 100000=1次/层;帧×100000;60帧=1秒"}


def composer_row(key: str, line: int, as_key: str = "") -> dict:
    """读任意键的一行(补齐到表真实宽)作为工坊底稿/编辑对象。
    as_key 非空 = 作为该目标键的模板载入:跨表(仅 角色词条<->队长技)自动列重排。"""
    logical, real, kind, table, parsed, width = _composer_ctx(key)
    if real not in parsed:
        raise ValueError(f"键不存在: {key}")
    rows = parsed[real]
    if not (1 <= int(line) <= len(rows)):
        raise ValueError(f"行号越界: {key} 共 {len(rows)} 行")
    row = _fit_row_width(rows[int(line) - 1], width)
    remap_note = ""
    if as_key:
        dlogical, dreal, dkind, _dt, dparsed, dwidth = _composer_ctx(as_key)
        if dlogical != logical:
            row, remap_note = _remap_cross_table(row, logical, dlogical,
                                                 dparsed.get(dreal) or [])
            kind, width = dkind, dwidth
            row = _fit_row_width(row, width)
    return {"key": key, "kind": kind, "line": int(line), "ncols": width, "row": row,
            "lines_total": len(rows), "desc": wf_describe.describe_line(row, kind),
            "remap_note": remap_note}


_BLANK_TPL_CACHE: dict = {}


def _blank_template(kind: str, parsed: dict, width: int, tcol: int) -> list[str]:
    """客户端合法空白行模板:每列取官方行众数(按块所属触发模式分组统计)。
    **C7050 铁律(2026-07-13 实锤)**:AbilityValues.parseAt* 的枚举列(前置条件1-3/
    瞬发触发/瞬发内容等)没有空串分支,空串直接 throw ClientError 7050——官方哨兵是
    前置='0'、instant_precontent='(None)'、delay='0';Option 列(time/threshold)的
    None 哨兵是字面量 "(None)" 不是空串。全空白行 = 必崩客户端,模板必须取官方惯例值。"""
    ck = (kind, width)
    if ck in _BLANK_TPL_CACHE:
        return list(_BLANK_TPL_CACHE[ck])
    from collections import Counter
    blocks = wf_describe.layout(kind)["blocks"]
    # 每列归属触发模式:precondition* 全模式读;instant_*=0;during_*/even_if=1;opening=2
    order = sorted(blocks.items(), key=lambda kv: kv[1])
    col_mode = {}
    for (bname, base), (nname, nbase) in zip(order, order[1:] + [("", width)]):
        mode = None
        if bname.startswith("instant"):
            mode = "0"
        elif bname.startswith("during") or bname == "even_if_owner_dead":
            mode = "1"
        elif bname == "opening":
            mode = "2"
        for c in range(int(base), int(nbase)):
            col_mode[c] = mode
    cnts = [Counter() for _ in range(width)]
    for rows in parsed.values():
        for r in rows:
            rmode = r[tcol] if tcol < len(r) else ""
            for c in range(width):
                m = col_mode.get(c)
                if m is not None and m != rmode:
                    continue          # 该块只统计对应触发模式的官方行
                cnts[c][r[c] if c < len(r) else ""] += 1
    tpl = [(cnts[c].most_common(1)[0][0] if cnts[c] else "") for c in range(width)]
    _BLANK_TPL_CACHE[ck] = list(tpl)
    return tpl


def composer_blank(dst_key: str) -> dict:
    """按目标键生成空白行:头部列(觉醒门槛清零)抄目标首行,其余=官方众数模板
    (纯空串行会触发客户端 C7050,见 _blank_template)、触发=瞬发。"""
    logical, real, kind, table, parsed, width = _composer_ctx(dst_key)
    lay = wf_describe.layout(kind)
    head_end = int(lay["blocks"]["precondition1"])
    tcol = head_end - 1
    row = _blank_template(kind, parsed, width, tcol)
    if real in parsed and parsed[real]:
        d0 = _fit_row_width(parsed[real][0], width)
        row[:head_end] = d0[:head_end]
    if kind == "ability":
        row[1] = "true"
        row[2] = row[2] or "attack_common"
        row[3], row[4] = "0", ""
    elif kind == "leader_ability":
        # 官方众数:c1='0'(2200/2316,'1'仅78例)、c2='0'/''——此前硬编码 '1','0' 无先例
        row[1], row[2] = "0", "0"
    row[tcol] = "0"
    return {"key": dst_key, "kind": kind, "line": None, "ncols": width, "row": row,
            "lines_total": len(parsed.get(real) or []), "desc": ""}


def composer_describe(kind: str, row: list) -> dict:
    if kind not in wf_describe.table_kinds():
        raise ValueError(f"未知表类型: {kind}")
    return {"desc": wf_describe.describe_line([str(v) for v in row], kind) or "(空)"}


def _client_legality_problems(kind: str, row: list[str]) -> list[str]:
    """客户端 AbilityValues.parseAt* 硬规则(违者 C7050/7101 打开角色页即崩,2026-07-13 实锤):
    枚举列无空串分支,前置1-3/触发/内容 kind 必须数字;instant_precontent 哨兵 '(None)';
    during_accumulation_trigger 哨兵 '(None)';even_if_owner_dead 必须 true/false。"""
    lay = wf_describe.layout(kind)
    B = {k: int(v) for k, v in lay["blocks"].items()}
    tcol = B["precondition1"] - 1

    def cell(i):
        return (row[i] if i < len(row) else "").strip()

    def is_num(v):
        return bool(v) and v.lstrip("-").isdigit()

    probs = []
    tmode = cell(tcol)
    if tmode not in ("0", "1", "2"):
        return [f"c{tcol} 触发模式={tmode!r},须为 0(瞬发)/1(持续)/2(开幕)"]
    for p in ("precondition1", "precondition2", "precondition3"):
        v = cell(B[p])
        if not is_num(v):
            probs.append(f"c{B[p]} {p}.kind={v!r} 须为数字(无条件填 0;空串=客户端C7050)")
    if tmode == "0":
        for name, label in (("instant_trigger", "瞬发触发kind"),
                            ("instant_delay", "延迟"), ("instant_content", "瞬发效果kind")):
            v = cell(B[name])
            if not is_num(v):
                probs.append(f"c{B[name]} {label}={v!r} 须为数字(空串=客户端C7050)")
        v = cell(B["instant_precontent"])
        if v != "(None)" and not is_num(v):
            probs.append(f"c{B['instant_precontent']} instant_precontent={v!r} 须为 '(None)' 或数字")
    elif tmode == "1":
        v = cell(B["during_accumulation_trigger"])
        if v != "(None)" and not is_num(v):
            probs.append(f"c{B['during_accumulation_trigger']} 累积触发={v!r} 须为 '(None)' 或数字")
        v = cell(B["during_trigger"])
        if not is_num(v):
            probs.append(f"c{B['during_trigger']} 持续触发kind={v!r} 须为数字")
        v = cell(B["even_if_owner_dead"])
        if v.lower() not in ("true", "false"):
            probs.append(f"c{B['even_if_owner_dead']} even_if_owner_dead={v!r} 须为 true/false(否则C7101)")
        v = cell(B["during_content"])
        if not is_num(v):
            probs.append(f"c{B['during_content']} 持续效果kind={v!r} 须为数字")
    else:
        v = cell(B["opening"])
        if not is_num(v):
            probs.append(f"c{B['opening']} 开幕kind={v!r} 须为数字")
    return probs


def composer_apply(dst_key: str, mode, row: list, adapt_sid: bool, dry_run: bool,
                   create_missing: bool = False) -> dict:
    """工坊写入:mode="append" 追加 / 行号 N 覆盖该行。行宽对齐目标表,单元格禁引号/换行。
    create_missing=True 且键不存在时新建整键(角色 abilities 引用了但表中缺失的槽位)。"""
    logical, real, kind, table, parsed, width = _composer_ctx(dst_key)
    created = False
    if real not in parsed:
        if not (create_missing and mode == "append"):
            raise ValueError(f"目标不存在: {dst_key}(缺失槽位可勾「新建键」以追加方式创建)")
        parsed[real] = []
        created = True
    row = [str(v) for v in row]
    for i, v in enumerate(row):
        if _CELL_BAD.search(v):
            raise ValueError(f"c{i} 含引号/换行(会破坏 CSV 行结构): {v!r}")
    if len(row) > width and any(v != "" for v in row[width:]):
        raise ValueError(f"行宽超限: {len(row)} 列 > 表宽 {width} 且尾部非空")
    row = _fit_row_width(row, width)
    log = []
    if created:
        log.append(f"⚠ 新建整键 {dst_key}(此前不在 {kind} 表中)")
    if adapt_sid and kind in ("ability", "leader_ability") and parsed[real]:
        sid = parsed[real][0][0] if parsed[real][0] else ""
        if sid and row[0] != sid:
            log.append(f"string_id {row[0]!r} -> {sid!r}(描述文本随目标)")
            row[0] = sid
    if kind == "ability" and row[1] not in ("true", "false"):
        row[1] = "true"
    probs = _client_legality_problems(kind, row)
    if probs:
        raise ValueError("行未通过客户端合法性校验(写入会导致打开角色页 C7050 崩溃):\n"
                         + "\n".join(f"  · {p}" for p in probs))
    # InvokeSkill(629) 的 string_id 必须在 custom_ability_string 表注册,
    # 否则角色页描述生成 MasterBinaryMap.get → C8601「指定的Key不存在」(2026-07-13 实锤)
    invoke_sid = ""
    B = {k: int(v) for k, v in wf_describe.layout(kind)["blocks"].items()}
    tcol = B["precondition1"] - 1
    if (row[tcol] if tcol < len(row) else "") == "0" \
            and (row[B["instant_content"]] if B["instant_content"] < len(row) else "") == "629":
        invoke_sid = (row[B["instant_content"] + 23] or "").strip()
        if not invoke_sid or invoke_sid == "(None)":
            raise ValueError("InvokeSkill(629) 需填 string_id(效果文本键),否则客户端 C8601")
        castr_lp = "master/string/custom_ability_string.orderedmap"
        castr = core.load_table(castr_lp, TARGET_STORE, SOURCE_STORE)
        if invoke_sid not in castr.text_rows():
            log_extra = f"⚠ custom_ability_string 缺文案键 {invoke_sid},自动注册(默认文案「发动特殊技能」,可在 JSON 直改里改)"
            if not dry_run:
                cr = castr.text_rows()
                cr[invoke_sid] = "发动特殊技能"
                castr.set_text_rows(cr)
                w = core.write_table(castr, TARGET_STORE,
                                     ".bak-wfmod-gui-" + time.strftime("%Y%m%d-%H%M%S"))
                add_pending(w)
        else:
            log_extra = ""
    else:
        log_extra = ""
    desc = wf_describe.describe_line(row, kind)
    if mode == "append":
        parsed[real].append(row)
        action = f"追加为第 {len(parsed[real])} 行"
    else:
        li = int(mode)
        if not (1 <= li <= len(parsed[real])):
            raise ValueError(f"目标行越界: {li}(共 {len(parsed[real])} 行)")
        parsed[real][li - 1] = row
        action = f"覆盖第 {li} 行"
    log.insert(0, f"{dst_key} {action}: {desc or '(空行)'}")
    if log_extra:
        log.append(log_extra)
    written = None
    if not dry_run:
        written = str(_write_with_backup(table, parsed, log))
    return {"changes": 1, "log": "\n".join(log), "written": written,
            "dry_run": dry_run, "desc": desc}


# ---------------------------------------------------------------- 词条工坊·按效果生成(效果选择器)
# 目录条目全部来自真实枚举 + 全库使用频次(composer_meta usage),生成 = 空白行按块布局填格,
# 单位换算内置(强度 千=1%、阈值/次数 十万=1次、HP阈值 千=1%)。写入仍走 /composer/apply。

_FXGEN_TRIGGERS = [
    # (id, 中文, 模式, 触发枚举, 阈值单位 None|pct|count, 说明)
    ("battle_start", "开幕(战斗开始,常驻)", "instant", "0", None, "最常见的常驻被动(全库×2631)"),
    ("skill", "技能发动时", "instant", "23", None, "每次发动技能触发"),
    ("pf", "强化弹射时", "instant", "2", "count", "阈值=第N次强化弹射(空=每次)"),
    ("dash", "冲刺时", "instant", "4", "count", "阈值=第N次冲刺(空=每次;可配前置条件如Fever中)"),
    ("flip", "弹射时", "instant", "6", "count", "阈值=第N次弹射(空=每次;高频,建议配冷却/前置)"),
    ("pf3", "强化弹射Lv3时", "instant", "65", None, ""),
    ("fever_in", "Fever发动时", "instant", "8", None, ""),
    ("member", "编成含指定角色组", "instant", "57", "count", "阈值=编成N名以上;配合目标角色组"),
    ("combo", "连击数达标时", "instant", "12", "count", "阈值=连击数"),
    ("heal_cnt", "治疗计数达标", "instant", "19", "count", "阈值=治疗N次"),
    ("dmg_cnt", "伤害计数达标", "instant", "21", "count", "阈值=造成伤害N次"),
    ("hp_high", "HP≥X%期间(持续)", "during", "0", "pct", "阈值=HP百分比"),
    ("hp_low", "HP≤X%期间(持续)", "during", "1", "pct", "阈值=HP百分比"),
    ("pierce", "贯通状态期间(持续)", "during", "30", None, "全库×123,配合贯通授予行"),
    ("fever_during", "Fever期间(持续)", "during", "4", None, ""),
    ("atkup_during", "攻击力↑状态期间(持续)", "during", "9", None, ""),
]

_FXGEN_EFFECTS = [
    # (id, 中文, 模式, 效果枚举, 数值单位 pct|count, 说明)
    ("atk", "攻击力 +X%", "instant", "32", "pct", "全库×1441 的标准数值行"),
    ("skill_dmg", "技能伤害 +X%", "instant", "34", "pct", ""),
    ("pf_dmg", "强化弹射伤害 +X%", "instant", "55", "pct", ""),
    ("direct_dmg", "Direct伤害 +X%", "instant", "33", "pct", ""),
    ("hp", "HP +X%", "instant", "205", "pct", ""),
    ("gauge", "技能槽 +X%(立即)", "instant", "211", "pct", "发动型:立即充能"),
    ("charge", "技能槽充能速度 +X%", "instant", "35", "pct", ""),
    ("heal", "比例治疗 X%", "instant", "206", "pct", "按最大HP比例回复"),
    ("combo_add", "追加连击 +N", "instant", "226", "count", ""),
    ("fever_add", "追加Fever点 +X%", "instant", "213", "pct", ""),
    ("fever_ext", "Fever时间延长 +X%", "instant", "56", "pct", ""),
    ("d_atk", "攻击力 +X%(持续)", "during", "0", "pct", "持续触发期间生效"),
    ("d_skill", "技能伤害 +X%(持续)", "during", "2", "pct", ""),
    ("d_pf", "强化弹射伤害 +X%(持续)", "during", "23", "pct", ""),
    ("d_direct", "Direct伤害 +X%(持续)", "during", "1", "pct", ""),
    ("d_charge", "技能槽充能 +X%(持续)", "during", "3", "pct", ""),
    ("d_ability", "能力伤害 +X%(持续)", "during", "154", "pct", ""),
    ("d_ind_direct", "独立乘区Direct +X%(持续)", "during", "410", "pct", "后期五星标志乘区"),
    ("d_ind_pf", "独立乘区强化弹射 +X%(持续)", "during", "413", "pct", ""),
    # 对敌伤害(能力伤害,DMG: 伪 kind 在 generate 按角色元素解析成真实枚举 251/316/352+elem)
    ("dmg_all", "对全体敌人 能力伤害(依自身攻击,X倍)", "instant", "DMG:all", "x",
     "元素自动跟角色;「段数」填N=改为最近顺序N段"),
    ("dmg_near", "对最近的敌人 能力伤害(依自身攻击,X倍)", "instant", "DMG:near", "x",
     "「段数」=多段连击(空=1段)"),
    ("dmg_trig", "对触发源敌人 能力伤害(依自身攻击,X倍)", "instant", "DMG:trig", "x",
     "配合受击/敌方行动类触发"),
    ("invoke", "发动技能动作 InvokeSkill(伤害计为技能伤害)", "instant", "629", "raw",
     "填「技能键/动作路径」;范本=队长技 L:111183 行5(火龙弹射追击)"),
]

_FXGEN_GROUPS = [("", "(不限)"), ("Red", "火属性"), ("Blue", "水属性"), ("Yellow", "雷属性"),
                 ("Green", "风属性"), ("White", "光属性"), ("Black", "暗属性")]


def _enum_menu(cat: str, table: str = "ability") -> list:
    """某枚举类别的全量选项,按全库使用频次降序(0 次的沉底);供自由构建器下拉。
    返回 [{kind, cn, en, n}]。cat ∈ enums 键;table ∈ usage 的表名(ability/leader…)。"""
    m = composer_meta()
    usage_key = {"trigger": "instant_trigger", "during_trigger": "during_trigger",
                 "instant_content": "instant_content", "during_content": "during_content"}.get(cat, cat)
    use = (m["usage"].get(usage_key) or {}).get(table, {}) or {}
    out = []
    for k, v in m["enums"].get(cat, {}).items():
        out.append({"kind": k, "cn": v.get("cn") or v.get("en"), "en": v.get("en", ""),
                    "n": int(use.get(k, 0))})
    out.sort(key=lambda x: (-x["n"], int(x["kind"]) if x["kind"].isdigit() else 1 << 30))
    return out


def composer_catalog() -> dict:
    """效果构建器目录:`common` = 精选常用(带默认单位/阈值提示);`all` = 全量枚举
    (触发/效果各按 瞬发/持续 分组,中文名+使用频次,可搜),让人**自由组合**任意效果
    而不是面对空白块。目标/角色组/来源/属性附带。"""
    tg = {str(k): v for k, v in wf_describe.TARGET_CN.items()}
    pl = {str(k): v for k, v in wf_describe.PULLER_CN.items()}
    return {"triggers": [{"id": t[0], "name": t[1], "mode": t[2], "kind": t[3],
                          "threshold": t[4], "note": t[5]} for t in _FXGEN_TRIGGERS],
            "effects": [{"id": e[0], "name": e[1], "mode": e[2], "kind": e[3],
                         "unit": e[4], "note": e[5]} for e in _FXGEN_EFFECTS],
            "all": {
                "trigger": {"instant": _enum_menu("trigger"),
                            "during": _enum_menu("during_trigger")},
                "effect": {"instant": _enum_menu("instant_content"),
                           "during": _enum_menu("during_content")},
                "precondition": _enum_menu("precondition"),
            },
            "pullers": pl,
            "targets": tg, "groups": [{"id": g[0], "name": g[1]} for g in _FXGEN_GROUPS],
            "preconditions_common": [
                {"kind": "", "name": "(无前置条件)", "threshold": None},
                {"kind": "12", "name": "Fever中", "threshold": None},
                {"kind": "186", "name": "非Fever", "threshold": None},
                {"kind": "8", "name": "HP≥X%", "threshold": "pct"},
                {"kind": "9", "name": "HP≤X%", "threshold": "pct"},
                {"kind": "119", "name": "技能槽≥X%", "threshold": "pct"},
            ],
            "note": "触发与效果须同模式(瞬发/持续);数值单位自动换算(%×1000,次×100000,倍×100000)"}


def _unit_mul(unit: str) -> int:
    return {"pct": 1000, "count": 100000, "raw": 1, "x": 100000}.get(unit, 1000)


# 对敌伤害三族(依攻击 ByAttack)基准枚举:族基址 + 元素下标(0火..5暗) = 真实 kind。
# all=EnemyDamage(time空=全体/N=最近顺序N段) near=NearestEnemyDamage trig=TriggerEnemyDamage
_DMG_FAMILY_BASE = {"all": 251, "near": 352, "trig": 316}
_GROUP_TOKEN_ELEM = {"Red": 0, "Blue": 1, "Yellow": 2, "Green": 3, "White": 4, "Black": 5}


def _element_index_for_key(dst_key: str) -> int | None:
    """dst_key 所属角色的伤害族元素下标(0火..5暗)。
    ⚠ character c3 element 是 **0-based**(火=0 水=1 雷=2 风=3 光=4 暗=5),与对敌伤害枚举族
    (251 EnemyDamageByAttackRed…)**同基,直接可用,无需换算**——2026-07-13 全库实证:
    c3 × 队长技元素token 对照 火80/水82/雷80/风75/光79/黑81 全吻合。此前"1-based 须 -1"
    是误诊(把 wf_describe.ELEMENT_CN 的 1-based 枚举当成了 c3 语义),曾把风角色(c3=3)的
    伤害错生成雷(253)。非 0-5 → None。
    L: 前缀=队长技键,按 character c17(leader_ability_id)反查角色——**键≠角色ID**
    (白虎:角色10/队长技3);多个角色共用同一队长技且元素不同时 → None(须手选属性)。
    纯数字键扫 character 表 c19-24 词条引用。"""
    ks = str(dst_key)
    if ks.startswith(("W:", "S:")):
        return None

    def _to_idx(el: str) -> int | None:
        return int(el) if el.isdigit() and 0 <= int(el) <= 5 else None

    try:
        table = core.load_table(core.CHARACTER_LOGICAL, TARGET_STORE, SOURCE_STORE)
        rows = {k: core.read_csv_lines(t) for k, t in table.text_rows().items() if t}
        if ks.startswith("L:"):
            lk = ks[2:]
            els = {lines[0][3].strip() for lines in rows.values()
                   if len(lines[0]) > 17 and lines[0][17] == lk}
            return _to_idx(els.pop()) if len(els) == 1 else None
        for lines in rows.values():
            r = lines[0]
            if len(r) > 24 and ks in r[19:25]:
                return _to_idx(r[3].strip())
    except Exception:
        return None
    return None


def composer_generate(dst_key: str, trigger_id: str = "", effect_id: str = "",
                      value: float = 0, value_max=None, threshold=None,
                      target: str = "0", groups: str = "",
                      mode: str = "", trigger_kind: str = "", effect_kind: str = "",
                      effect_unit: str = "pct", threshold_unit: str = "count",
                      puller: str = "0", trigger_groups: str = "",
                      precondition_kind: str = "", precondition_threshold=None,
                      precondition_unit: str = "pct", hits=None,
                      string_id: str = "", action_path: str = "") -> dict:
    """生成整行(不写盘;预览后 /composer/apply 写入)。两种调用:
    ① 精选:传 trigger_id/effect_id(取自 catalog.triggers/effects,带默认单位);
    ② 自由:传 mode('instant'|'during') + trigger_kind + effect_kind(枚举 ID,取自 catalog.all)
       + effect_unit('pct'|'count'|'raw'|'x'倍)。自由模式支持全量枚举任意组合。
    通用扩展:precondition_kind=前置条件枚举(如 12=Fever中,阈值单位 pct/count);
    hits=对敌伤害段数(EnemyDamage族 time 列:空=全体/N=最近顺序N段);
    string_id/action_path=InvokeSkill(629) 的技能键与 DSL 路径;
    effect_kind='DMG:all|near|trig'=对敌能力伤害伪 kind,按角色元素解析(元素取
    「角色组/属性」选择,否则自动查 dst_key 所属角色 c3)。"""
    tr = next((t for t in _FXGEN_TRIGGERS if t[0] == trigger_id), None)
    fx = next((e for e in _FXGEN_EFFECTS if e[0] == effect_id), None)
    # 归一化:精选 → 通用参数
    if tr and fx:
        if tr[2] != fx[2]:
            raise ValueError(f"触发({tr[1]})与效果({fx[1]})模式不一致:瞬发配瞬发,持续配持续")
        mode = tr[2]
        trigger_kind = tr[3]
        effect_kind = fx[3]
        effect_unit = fx[4] or "pct"
        threshold_unit = tr[4] or "count"
        if tr[0] == "member":       # 编成:阈值判编成人数、组进触发角色组
            trigger_groups = groups
        tr_name, fx_name = tr[1], fx[1]
    else:
        if mode not in ("instant", "during"):
            raise ValueError("自由模式需 mode='instant'|'during'")
        if not effect_kind:
            raise ValueError("需选择效果(effect_kind)")
        m = composer_meta()
        trcat = "trigger" if mode == "instant" else "during_trigger"
        fxcat = "instant_content" if mode == "instant" else "during_content"
        tr_name = (m["enums"][trcat].get(trigger_kind, {}) or {}).get("cn") \
            or (trigger_kind and f"触发{trigger_kind}") or "常驻"
        fx_name = (m["enums"][fxcat].get(effect_kind, {}) or {}).get("cn") or f"效果{effect_kind}"
    # DMG: 伪 kind → 真实对敌伤害枚举(族基址+元素)。元素:属性下拉 token > 角色 c3 自动
    is_dmg = str(effect_kind).startswith("DMG:")
    if is_dmg:
        if mode != "instant":
            raise ValueError("对敌伤害为瞬发效果,模式须为 instant")
        fam = str(effect_kind)[4:]
        base_k = _DMG_FAMILY_BASE.get(fam)
        if base_k is None:
            raise ValueError(f"未知伤害族: {effect_kind}")
        el = _GROUP_TOKEN_ELEM.get(groups)
        if el is None:
            el = _element_index_for_key(dst_key)
        if el is None:
            raise ValueError("无法确定伤害元素:请在「角色组/属性」下拉选一个属性")
        effect_kind = str(base_k + el)
        groups = ""      # 属性已消费为伤害元素,不写入目标角色组
        fx_name = f"{fx_name}[{['火','水','雷','风','光','暗'][el]}]"

    b = composer_blank(dst_key)
    kind, row = b["kind"], b["row"]
    blocks = wf_describe.layout(kind)["blocks"]
    tcol = blocks["precondition1"] - 1
    vmax = value_max if value_max not in (None, "") else value
    umul = _unit_mul(effect_unit)
    if mode == "instant":
        row[tcol] = "0"
        base = blocks["instant_trigger"]
        row[base] = trigger_kind or "0"          # 空=Initial(常驻/开局)
        row[base + 1] = "0"                       # 来源=自身
        if threshold not in (None, "", 0):
            tmul = _unit_mul(threshold_unit)
            row[base + 3] = row[base + 4] = str(int(float(threshold) * tmul))
        elif (trigger_kind or "0") not in ("0", "1"):
            # 计数型触发(冲刺/弹射/强化弹射等)官方全库阈值最小=100000(1次),0/0 全库
            # 零先例——写 0 客户端渲染成「0次冲刺时」且触发行为未定义(2026-07-13 实锤)。
            # 空阈值默认=每次(1次=100000)。
            row[base + 3] = row[base + 4] = "100000"
        if (trigger_kind or "0") not in ("0", "1"):
            if not str(row[base + 7]).strip():
                row[base + 7] = "(None)"          # trigger_limit
            if not str(row[base + 8]).strip():
                row[base + 8] = "0"               # cooltime
        if trigger_groups:
            row[base + 9] = trigger_groups        # instant_trigger.character_groups
        cbase = blocks["instant_content"]
    else:
        row[tcol] = "1"
        base = blocks["during_trigger"]
        row[base] = trigger_kind or "0"
        row[base + 1] = str(puller or "0")        # puller 必填(7050:需 puller 的 case 空=崩)
        if threshold not in (None, "", 0):
            tmul = _unit_mul(threshold_unit)
            row[base + 3] = row[base + 4] = str(int(float(threshold) * tmul))
        if trigger_groups:
            row[base + 6] = trigger_groups        # during_trigger.character_groups
        cbase = blocks["during_content"]
    row[cbase] = effect_kind
    row[cbase + 1] = str(target or "0")
    if groups:
        row[cbase + 2] = groups                   # 目标·角色组(如 全队(火))
    if effect_kind == "629" and float(value or 0) == 0:
        row[cbase + 4] = row[cbase + 5] = ""      # InvokeSkill 不读强度,官方行留空
    else:
        row[cbase + 4] = str(int(float(value) * umul))
        row[cbase + 5] = str(int(float(vmax) * umul))
    # 前置条件(precondition1 块:kind / 阈值)
    if precondition_kind not in ("", None):
        pbase = blocks["precondition1"]
        row[pbase] = str(precondition_kind)
        if precondition_threshold not in (None, "", 0):
            pmul = _unit_mul(precondition_unit)
            row[pbase + 3] = row[pbase + 4] = str(int(float(precondition_threshold) * pmul))
    if mode == "instant":
        if is_dmg:
            # time 列:读 time 的 kind 空串非法(Some(parseInt(''))),None 哨兵=字面量 (None)
            row[cbase + 22] = str(int(hits)) if hits not in (None, "", 0) else "(None)"
        elif hits not in (None, "", 0):           # 其他 kind:仅显式给段数时写
            row[cbase + 22] = str(int(hits))
        if string_id:
            row[cbase + 23] = string_id           # InvokeSkill 技能键
        if action_path:
            row[cbase + 24] = action_path         # InvokeSkill DSL 路径
    desc = wf_describe.describe_line(row, kind)
    return {"key": dst_key, "kind": kind, "ncols": len(row), "row": row, "desc": desc,
            "trigger": tr_name, "effect": fx_name,
            "note": "预览无误后用「追加到词条」写入(走 /composer/apply,自动 dry-run→确认)"}


# ---------------------------------------------------------------- 装备/魂珠 equipment
# master/item/equipment.orderedmap:武器与魂珠共表(436 键,c2 kind 0=武器 1=魂珠orb),
# c1=中文名 c7=描述 c8=品质 c10=ability_soul_id(实测 436/436 与自身键一致 → 每件装备
# 都有同键的 ability_soul 行 = 对应魂珠效果)。equipment_enhancement.orderedmap(29 键)
# 是武器改造层:c2=改造名(·改) c7=最大强化等级。

EQUIP_LOGICAL = "master/item/equipment.orderedmap"
ENH_LOGICAL = "master/equipment_enhancement/equipment_enhancement.orderedmap"
_EQUIP_CACHE: dict = {"stamp": None, "info": None}


def equipment_info() -> dict[str, dict]:
    """装备表快照:id -> {string_id, name, enh_name?, kind, rarity, desc, soul_id}。"""
    try:
        stamp = str(core.table_path(TARGET_STORE, EQUIP_LOGICAL).stat().st_mtime_ns)
    except Exception:
        stamp = "0"
    if _EQUIP_CACHE["stamp"] == stamp:
        return _EQUIP_CACHE["info"]
    info: dict[str, dict] = {}
    try:
        eq = core.load_table(EQUIP_LOGICAL, TARGET_STORE, SOURCE_STORE)
        for k, t in eq.text_rows().items():
            r = core.read_csv_lines(t)[0]
            def g(i):
                return r[i] if i < len(r) else ""
            info[k] = {"string_id": g(0), "name": g(1), "kind": g(2),
                       "rarity": g(8), "desc": g(7), "soul_id": g(10)}
    except Exception:
        pass
    try:
        en = core.load_table(ENH_LOGICAL, TARGET_STORE, SOURCE_STORE)
        for k, t in en.text_rows().items():
            r = core.read_csv_lines(t)[0]
            if k in info and len(r) > 2 and r[2]:
                info[k]["enh_name"] = r[2]
    except Exception:
        pass
    _EQUIP_CACHE.update(stamp=stamp, info=info)
    return info


# ---------------------------------------------------------------- 武器词条 weapon_ability
# equipment_enhancement_ability.orderedmap:武器强化词条,与角色 ability 同 126 列 schema
# (表头不同:c0=slot c1=learn_level c2=max_power_level c3/c4=power c5=trigger,块基址同 ability)。
# 属 ② 层手机包,改后走发布/adb 同步。

WEAPON_LOGICAL = "master/equipment_enhancement/equipment_enhancement_ability.orderedmap"


_ELEM_TOKEN_CN = {"Red": "火", "Blue": "水", "Yellow": "雷", "Green": "风", "White": "光", "Black": "暗"}
_CN_ELEM_TOKEN = {v: k for k, v in _ELEM_TOKEN_CN.items()}
_ELEM_TOKEN_NUM = {"Red": "1", "Blue": "2", "Yellow": "3", "Green": "4", "White": "5", "Black": "6"}


def _detect_element(rows: list[list[str]]) -> str:
    """数词条行里的元素 token(character_groups 等),返回中文元素;无 = ''(通用)。"""
    from collections import Counter
    cnt: Counter = Counter()
    for r in rows:
        for cell in r:
            for tok in str(cell).split("/"):
                if tok in _ELEM_TOKEN_CN:
                    cnt[tok] += 1
    return _ELEM_TOKEN_CN[cnt.most_common(1)[0][0]] if cnt else ""


def list_weapons() -> list[dict]:
    """全部武器 = equipment 表 kind=0(424 把),不止有强化词条的 29 把。
    element 按词条内容检测(强化词条 + 同键魂珠):无元素 token = 通用。"""
    table = core.load_table(WEAPON_LOGICAL, TARGET_STORE, SOURCE_STORE)
    enh_rows = {k: core.read_csv_lines(t) for k, t in table.text_rows().items()}
    soul = core.load_table(SOUL_LOGICAL, TARGET_STORE, SOURCE_STORE)
    soul_rows = soul.text_rows()
    info = equipment_info()
    out = []
    for k, ei in info.items():
        er = enh_rows.get(k) or []
        rows = list(er)
        if k in soul_rows:
            rows = rows + core.read_csv_lines(soul_rows[k])
        r0 = er[0] if er else []
        out.append({"id": k, "slot": r0[0] if r0 else "",
                    "learn_level": r0[1] if len(r0) > 1 else "",
                    "lines": len(er), "has_enh": bool(er),
                    "kind": ei.get("kind", "0"),  # 0=武器 1=魂珠(主线orb)
                    "name": ei.get("name", ""), "enh_name": ei.get("enh_name", ""),
                    "rarity": ei.get("rarity", ""), "soul_id": ei.get("soul_id", "") or k,
                    "element": _detect_element(rows)})
    elem_order = {"火": 0, "水": 1, "雷": 2, "风": 3, "光": 4, "暗": 5, "": 6}
    out.sort(key=lambda w: (w["kind"], elem_order.get(w["element"], 6),
                            -int(w["rarity"] or 0), not w["has_enh"], w["id"]))
    return out


def get_weapon_rows(wid: str) -> dict:
    schema = load_schema()
    names = core.schema_names(schema)
    idx_by = core.schema_index(schema)
    table = core.load_table(WEAPON_LOGICAL, TARGET_STORE, SOURCE_STORE)
    text = table.text_rows().get(str(wid))
    if text is None:
        # 大部分装备没有强化词条,只有同键魂珠 → 页面只显示魂珠效果区
        soul = None
        try:
            soul = get_soul_rows(str(wid))
        except Exception:
            pass
        return {"weapon": str(wid), "columns": names, "lines": [], "no_enh": True,
                "desc": "", "line_descs": [],
                "info": equipment_info().get(str(wid), {}), "soul": soul}
    lines = []
    for li, row in enumerate(core.read_csv_lines(text), start=1):
        row = core.normalize_row_length(row, len(names))
        lines.append({"line": li, "values": {str(i): v for i, v in enumerate(row) if v != ""}})
    soul = None
    try:
        soul = get_soul_rows(str(wid))  # 装备与魂同键:武器页一并展示/编辑
    except Exception:
        pass
    return {"weapon": str(wid), "columns": names, "lines": lines,
            "desc": describe_ability(lines, idx_by),
            "line_descs": wf_describe.describe_rows(core.read_csv_lines(text), "equipment_enhancement_ability"),
            "info": equipment_info().get(str(wid), {}), "soul": soul}


def save_weapon_rows(edits: list[dict], dry_run: bool) -> dict:
    return _save_single_table_edits(WEAPON_LOGICAL, edits, dry_run, ".bak-wfmod-weapon-")


# ---------------------------------------------------------------- 基础数值 character_status
# 嵌套 orderedmap(外层键=角色ID,内层键=等级断点,行="hp,atk")。
# 逆向依据见 wf_mod_tool.py STATUS_LOGICAL 注释;属 ② 层手机包,改后走 adb 同步。


# 觉醒加成表:平表(zlib CSV 单行),键=角色ID(36 个有觉醒板的角色)。
# 逆向依据 CharacterAwakeStatusValues.as:atk_plus_value=row[0], hp_plus_value=row[1]
# ——列序与 character_status(hp,atk)**相反**!
# 面板公式(BattleCharacterLogic):加成 = 已点亮觉醒大节点数 × plus_value。
AWAKE_LOGICAL = "master/character/character_awake_status.orderedmap"


def get_awake_values(cid: str) -> dict | None:
    try:
        table = core.load_table(AWAKE_LOGICAL, TARGET_STORE, SOURCE_STORE)
    except Exception:
        return None
    text = table.text_rows().get(str(cid))
    if text is None:
        return None
    rows = core.read_csv_lines(text)
    if not rows or len(rows[0]) < 2:
        return None
    return {"atk_plus": int(rows[0][0]), "hp_plus": int(rows[0][1])}


def save_awake_values(cid: str, atk_plus: int, hp_plus: int, dry_run: bool) -> dict:
    cid = str(cid)
    table = core.load_table(AWAKE_LOGICAL, TARGET_STORE, SOURCE_STORE)
    parsed = {k: core.read_csv_lines(t) for k, t in table.text_rows().items()}
    if cid not in parsed:
        raise ValueError(f"角色不在觉醒加成表中(不允许新增键): {cid}")
    atk_plus, hp_plus = int(atk_plus), int(hp_plus)
    if not (0 <= atk_plus < 2**31 and 0 <= hp_plus < 2**31):
        raise ValueError("觉醒加成必须是 0 ~ 2^31-1 的整数")
    old = parsed[cid][0]
    log_lines = []
    if [str(atk_plus), str(hp_plus)] != old[:2]:
        log_lines.append(f"{cid} 觉醒/大节点: ATK+{old[0]}->{atk_plus}  HP+{old[1]}->{hp_plus}")
    changes = len(log_lines)
    written = None
    if not dry_run and changes:
        parsed[cid] = [[str(atk_plus), str(hp_plus)]]  # 列序:atk,hp(与面板 hp,atk 相反,勿混)
        table.set_text_rows({k: core.write_csv_lines(r) for k, r in parsed.items()})
        suffix = ".bak-wfmod-awake-" + time.strftime("%Y%m%d-%H%M%S")
        buf = io.StringIO()
        with redirect_stdout(buf):
            written = core.write_table(table, TARGET_STORE, suffix, no_backup=False)
        log_lines.append(buf.getvalue().strip())
        add_pending(written)
        record_change(AWAKE_LOGICAL, "\n".join(l for l in log_lines if l),
                      written.with_name(written.name + suffix))
    return {"changes": changes, "log": "\n".join(l for l in log_lines if l),
            "written": str(written) if written else None, "dry_run": dry_run}


def get_status_values(cid: str) -> dict:
    table = core.load_status_table(TARGET_STORE, SOURCE_STORE)
    cid = str(cid)
    if cid not in table.keys:
        raise ValueError(f"角色不存在于 character_status: {cid}")
    entries = core.decode_status_row(table.rows[table.keys.index(cid)])
    return {"character": cid,
            "entries": [{"level": lv, "hp": hp, "atk": atk} for lv, hp, atk in entries],
            "awake": get_awake_values(cid),
            "note": "客户端按断点线性插值(向上取整);断点等级不建议改,只改 HP/ATK"}


def save_status_values(cid: str, entries: list[dict], dry_run: bool) -> dict:
    table = core.load_status_table(TARGET_STORE, SOURCE_STORE)
    cid = str(cid)
    if cid not in table.keys:
        raise ValueError(f"角色不存在于 character_status: {cid}")
    ki = table.keys.index(cid)
    old = core.decode_status_row(table.rows[ki])
    by_level = {str(e["level"]): (int(e["hp"]), int(e["atk"])) for e in entries}
    unknown = set(by_level) - {lv for lv, _, _ in old}
    if unknown:
        raise ValueError(f"未知等级断点(不允许增删断点): {sorted(unknown)}")
    for hp, atk in by_level.values():
        if hp < 0 or atk < 0 or hp > 2**31 - 1 or atk > 2**31 - 1:
            raise ValueError("HP/ATK 必须是 0 ~ 2^31-1 的整数")
    new = []
    log_lines = []
    for lv, hp, atk in old:  # 保持原键序
        nhp, natk = by_level.get(lv, (hp, atk))
        if (nhp, natk) != (hp, atk):
            log_lines.append(f"{cid} Lv{lv}: HP {hp}->{nhp}  ATK {atk}->{natk}")
        new.append((lv, nhp, natk))
    changes = len(log_lines)
    written = None
    if not dry_run and changes:
        table.rows[ki] = core.encode_status_row(new)
        suffix = ".bak-wfmod-status-" + time.strftime("%Y%m%d-%H%M%S")
        buf = io.StringIO()
        with redirect_stdout(buf):
            written = core.write_status_table(table, TARGET_STORE, suffix)
        log_lines.append(buf.getvalue().strip())
        add_pending(written)
        record_change(core.STATUS_LOGICAL, "\n".join(l for l in log_lines if l),
                      written.with_name(written.name + suffix))
    return {"changes": changes, "log": "\n".join(l for l in log_lines if l),
            "written": str(written) if written else None, "dry_run": dry_run}


# ---------------------------------------------------------------- 技能能量 action_skill
# 嵌套 orderedmap(外层键=角色 code_name,内层键 "1"基础技/"2"＋进化技,行=CSV)。
# 逆向依据见 wf_mod_tool.py ACTION_SKILL_* 注释;属 ② 层手机包,改后走 adb 同步。
# 面板"技能能量" = 内层列5(max_skill_weight,满级值);列4 = min_skill_weight(SLv1)。

SKILL_LEVEL_LABEL = {"1": "基础技", "2": "＋进化技", "3": "＋＋进化技"}


def _action_skill_key(character: str) -> str:
    """角色 ID -> action_skill 表键(code_name)。col8=action_skill,回退 col0=code_name。"""
    character = str(character)
    ct = load_char_table()
    if ct:
        for text in ct.text_rows().values():
            row = core.read_csv_lines(text)
            if not row:
                continue
            r = core.normalize_row_length(row[0], 37)
            if r[17] == character or r[0] == character:
                return r[8] or r[0]
    # 回退:直接从 ① 层 character.json 取 code_name
    for c in load_characters():
        if c["id"] == character:
            return c["code_name"]
    return character


def get_skill_energy(character: str) -> dict:
    key = _action_skill_key(character)
    table = core.load_action_skill_table(TARGET_STORE, SOURCE_STORE)
    if key not in table.keys:
        raise ValueError(f"action_skill 表中没有 {key}(角色 {character})")
    entries = core.decode_action_skill_row(table.rows[table.keys.index(key)])
    C = core.ACTION_SKILL_COLUMNS
    skills = []
    for lv, raw_fields in entries:
        fields = core.normalize_row_length(raw_fields, C["max_skill_weight"] + 1)
        pp = raw_fields[C["program_path"]] if len(raw_fields) > C["program_path"] else ""
        dsl_state = ""   # "" = 可编辑;否则为不可编辑原因(前端置灰按钮)
        if not pp or pp == "(None)":
            dsl_state = "官方数据无效果文件引用(短行)" if len(raw_fields) <= C["program_path"] \
                else "该级别未引用效果文件"
        else:
            d = core.sha1_path(wf_dsl.dsl_logical(pp))
            if not (TARGET_STORE / d[:2] / d[2:]).exists():
                dsl_state = "效果文件不在本地数据包(官方未下发)"
        skills.append({
            "level": lv,
            "label": SKILL_LEVEL_LABEL.get(lv, lv),
            "name": fields[C["name"]],
            "description": fields[C["description"]],   # 游戏内技能效果描述(内层 c1)
            "min_skill_weight": fields[C["min_skill_weight"]],   # SLv1 技能能量
            "max_skill_weight": fields[C["max_skill_weight"]],   # 满级技能能量(面板显示)
            "dsl_unavailable": dsl_state,
        })
    return {"character": str(character), "skill_key": key, "skills": skills,
            "note": "面板技能能量=满级值(max_skill_weight);名称/描述只是显示文本,技能实际效果在 ActionDsl(不可改,可整段移植别人的技能)"}


def _write_action_skill(table, log_lines: list[str]) -> str:
    """action_skill 写盘 + 备份 + pending + 改动日志(公共出口)。"""
    suffix = ".bak-wfmod-actionskill-" + time.strftime("%Y%m%d-%H%M%S")
    buf = io.StringIO()
    with redirect_stdout(buf):
        written = core.write_action_skill_table(table, TARGET_STORE, suffix)
    log_lines.append(buf.getvalue().strip())
    add_pending(written)
    record_change(core.ACTION_SKILL_LOGICAL, "\n".join(l for l in log_lines if l),
                  written.with_name(written.name + suffix))
    return str(written)


def _skill_text_clean(v: str) -> str:
    """名称/描述写入内层 CSV 前清洗:半角逗号/换行会破坏 CSV 行结构。"""
    return str(v).replace(",", "，").replace("\r", "").replace("\n", " ")


def save_skill_energy(character: str, edits: list[dict], dry_run: bool) -> dict:
    """edits: [{level, min_skill_weight?, max_skill_weight?, name?, description?}]。缺省字段不改。"""
    key = _action_skill_key(character)
    table = core.load_action_skill_table(TARGET_STORE, SOURCE_STORE)
    if key not in table.keys:
        raise ValueError(f"action_skill 表中没有 {key}(角色 {character})")
    ki = table.keys.index(key)
    entries = core.decode_action_skill_row(table.rows[ki])
    C = core.ACTION_SKILL_COLUMNS
    by_level = {str(e["level"]): e for e in edits}
    log_lines = []
    new_entries: list[tuple[str, list[str]]] = []
    for lv, fields in entries:
        fields = core.normalize_row_length(list(fields), C["max_skill_weight"] + 1)
        e = by_level.get(lv)
        if e:
            tag = SKILL_LEVEL_LABEL.get(lv, lv)
            for colname in ("min_skill_weight", "max_skill_weight"):
                if colname in e and e[colname] is not None and str(e[colname]) != "":
                    val = int(e[colname])
                    if not (0 <= val < 2**31):
                        raise ValueError("技能能量必须是 0 ~ 2^31-1 的整数")
                    if str(val) != fields[C[colname]]:
                        log_lines.append(f"{key} [{tag}] {colname} {fields[C[colname]]}->{val}")
                        fields[C[colname]] = str(val)
            for colname in ("name", "description"):
                if colname in e and e[colname] is not None:
                    val = _skill_text_clean(e[colname])
                    if val and val != fields[C[colname]]:
                        log_lines.append(f"{key} [{tag}] {colname} {fields[C[colname]]!r}->{val!r}")
                        fields[C[colname]] = val
        new_entries.append((lv, fields))
    changes = len(log_lines)
    written = None
    if not dry_run and changes:
        table.rows[ki] = core.encode_action_skill_row(new_entries)
        written = _write_action_skill(table, log_lines)
    return {"changes": changes, "log": "\n".join(l for l in log_lines if l),
            "written": written, "dry_run": dry_run}


def skill_copy(from_character: str, to_character: str, dry_run: bool) -> dict:
    """整技能移植:外层行原样字节复制(from 的全部技能级别 → to,含名称/描述/能量/动作路径)。
    不重编码内层 → 零结构风险;目标原技能整段被替换(备份可回)。"""
    fkey = _action_skill_key(from_character)
    tkey = _action_skill_key(to_character)
    table = core.load_action_skill_table(TARGET_STORE, SOURCE_STORE)
    for k, who in ((fkey, from_character), (tkey, to_character)):
        if k not in table.keys:
            raise ValueError(f"action_skill 表中没有 {k}(角色 {who})")
    fi, ti = table.keys.index(fkey), table.keys.index(tkey)
    src_names = [f"[{SKILL_LEVEL_LABEL.get(lv, lv)}]{fields[0]}"
                 for lv, fields in core.decode_action_skill_row(table.rows[fi])]
    log_lines = [f"{fkey} 整技能 -> {tkey}(外层原样字节替换): " + " ".join(src_names),
                 "⚠ 技能动画/效果走来源的 ActionDsl;名称/描述/能量一并变成来源的"]
    written = None
    if not dry_run:
        table.rows[ti] = bytes(table.rows[fi])
        written = _write_action_skill(table, log_lines)
    return {"changes": 1, "log": "\n".join(log_lines), "written": written, "dry_run": dry_run}


def skill_level_copy(from_character: str, from_level: str, to_character: str,
                     to_level: str, dry_run: bool) -> dict:
    """单个技能级别移植:from 的级别 N → to 的级别 M(已存在=替换,不存在=新增到末尾)。"""
    fkey = _action_skill_key(from_character)
    tkey = _action_skill_key(to_character)
    table = core.load_action_skill_table(TARGET_STORE, SOURCE_STORE)
    for k, who in ((fkey, from_character), (tkey, to_character)):
        if k not in table.keys:
            raise ValueError(f"action_skill 表中没有 {k}(角色 {who})")
    src = dict(core.decode_action_skill_row(table.rows[table.keys.index(fkey)]))
    if str(from_level) not in src:
        raise ValueError(f"{fkey} 没有技能级别 {from_level}(现有: {'/'.join(src)})")
    ti = table.keys.index(tkey)
    entries = core.decode_action_skill_row(table.rows[ti])
    fields = list(src[str(from_level)])
    tag_f = SKILL_LEVEL_LABEL.get(str(from_level), from_level)
    tag_t = SKILL_LEVEL_LABEL.get(str(to_level), to_level)
    keys_now = [lv for lv, _ in entries]
    if str(to_level) in keys_now:
        new_entries = [(lv, fields if lv == str(to_level) else fl) for lv, fl in entries]
        action = f"替换 {tkey} 的 [{tag_t}]"
    else:
        new_entries = entries + [(str(to_level), fields)]
        action = f"新增 {tkey} 的 [{tag_t}](追加到内层末尾)"
    log_lines = [f"{fkey} [{tag_f}]{fields[0]} -> {action}"]
    written = None
    if not dry_run:
        table.rows[ti] = core.encode_action_skill_row(new_entries)
        written = _write_action_skill(table, log_lines)
    return {"changes": 1, "log": "\n".join(log_lines), "written": written, "dry_run": dry_run}


def skill_level_delete(character: str, level: str, dry_run: bool) -> dict:
    """删除技能级别(至少保留 1 个;删"2"会影响已进化角色,慎用)。"""
    key = _action_skill_key(character)
    table = core.load_action_skill_table(TARGET_STORE, SOURCE_STORE)
    if key not in table.keys:
        raise ValueError(f"action_skill 表中没有 {key}(角色 {character})")
    ki = table.keys.index(key)
    entries = core.decode_action_skill_row(table.rows[ki])
    keys_now = [lv for lv, _ in entries]
    if str(level) not in keys_now:
        raise ValueError(f"{key} 没有技能级别 {level}(现有: {'/'.join(keys_now)})")
    if len(entries) <= 1:
        raise ValueError("只剩 1 个技能级别,不允许删空")
    new_entries = [(lv, fl) for lv, fl in entries if lv != str(level)]
    log_lines = [f"{key} 删除技能级别 [{SKILL_LEVEL_LABEL.get(str(level), level)}](剩 {len(new_entries)} 个)"]
    written = None
    if not dry_run:
        table.rows[ki] = core.encode_action_skill_row(new_entries)
        written = _write_action_skill(table, log_lines)
    return {"changes": 1, "log": "\n".join(log_lines), "written": written, "dry_run": dry_run}


# ---------------------------------------------------------------- ① 层角色资料
# character.json + character_text.json(服务端 assets/cdndata),非手机数据包。
# 改这里影响服务端下发的身份 / 文本词条,保存后需重启服务端生效(不走 adb 同步)。

CHAR_FIELD_MAP = {
    "code_name": ("master", 0), "rarity": ("master", 2), "element": ("master", 3),
    "race": ("master", 4), "gender": ("master", 7), "role": ("master", 26),
    "name": ("text", 0), "name_en": ("text", 1), "description": ("text", 2),
    "title": ("text", 3), "skill_name": ("text", 4), "skill_desc": ("text", 5),
    "skill_plus_name": ("text", 6), "skill_plus_desc": ("text", 7),
    "leader_title": ("text", 10), "cv": ("text", 11),
}

# 显示源结论(2026-07-13 逆向 StatusWindow/CharacterValues/CharacterTextValues):
# character_text 的 skill_name_*/leader_ability_name 只喂**抽卡特性页**;
# 详情页/战斗的 队长技名 = character 表 c18(leader_ability Option 的 name,c17=id),
# 技能名/描述 = action_skill 表 name/description(按技能级别)。
# 所以 leader_title 要**双写** text[10] + master[18];技能名系字段另同步 action_skill
# (save_char_fields 里做)。种族 = character c4 token → APK 内 race 表映射,乱填不显示。
CHAR_FIELD_EXTRA = {"leader_title": ("master", 18)}
RACE_TOKENS = ("Human", "Beast", "Element", "Machine", "Undead",
               "Mystery", "Dragon", "Devil", "Plants", "Aquatic")
# 资料页技能字段 → action_skill 级别/列(技能名＋=级别2;＋＋级别3 资料页未暴露不动)
_SKILL_TEXT_SYNC = {"1": ("skill_name", "skill_desc"),
                    "2": ("skill_plus_name", "skill_plus_desc")}


def _char_json_paths() -> tuple[Path, Path]:
    return CDNDATA / "character.json", CDNDATA / "character_text.json"


# ---- 改星级后的存档校正 ----
# 已拥有角色的 突破段/exp 超出新星级上限 → 客户端查看角色即 C2275 崩溃
# (CharacterLevelLogic.as:94 校验)。上限镜像自 src/routes/api/character.ts
# (characterMaxOverLimits) + src/lib/character.ts(characterExpCaps,index=突破段)。
SAVE_DB = ROOT / ".database" / "wdfp_data.db"
MAX_OVER_LIMITS = {1: 12, 2: 10, 3: 8, 4: 6, 5: 4}
CHARACTER_EXP_CAPS = {
    1: [11416, 15820, 21477, 28538, 37241, 49481, 66600, 91180, 125223, 170928, 216633, 262338, 308043],
    2: [21477, 28538, 37241, 49481, 66600, 91180, 125223, 170928, 216633, 262338, 308043],
    3: [37241, 49481, 66600, 91180, 125223, 170928, 216633, 262338, 308043],
    4: [76272, 102829, 139190, 189995, 240800, 291605, 342410],
    5: [153988, 210488, 266988, 323488, 379988],
}


def _clamp_save_for_rarity(cid: str, rarity: int, apply: bool) -> str:
    """全部存档里该角色的 over_limit_step/exp 钳到新星级合法范围。
    apply=False 只预览。返回日志串(空=没有需要校正的行)。"""
    mx = MAX_OVER_LIMITS.get(rarity)
    caps = CHARACTER_EXP_CAPS.get(rarity)
    if mx is None or not caps or not SAVE_DB.exists():
        return ""
    try:
        con = sqlite3.connect(str(SAVE_DB), timeout=10)
        try:
            rows = con.execute(
                "SELECT player_id, over_limit_step, exp FROM players_characters WHERE id=?",
                (int(cid),)).fetchall()
            fixed = []
            for pid, ol, exp in rows:
                ol0 = ol if ol is not None else 0
                new_ol = min(ol0, mx)
                cap = caps[min(new_ol, len(caps) - 1)]
                new_exp = min(exp, cap) if exp is not None else exp
                if new_ol != ol0 or new_exp != exp:
                    if apply:
                        con.execute("UPDATE players_characters SET over_limit_step=?, exp=? "
                                    "WHERE player_id=? AND id=?", (new_ol, new_exp, pid, int(cid)))
                    fixed.append(f"存档player{pid}: 突破{ol0}->{new_ol} exp{exp}->{new_exp}")
            if fixed and apply:
                con.commit()
            return "; ".join(fixed)
        finally:
            con.close()
    except Exception as exc:
        return f"⚠ 存档校正失败(可手动查 .database/wdfp_data.db): {exc}"


def get_char_fields(cid: str) -> dict:
    mp, tp = _char_json_paths()
    master = json.loads(mp.read_text(encoding="utf-8"))
    text = json.loads(tp.read_text(encoding="utf-8"))
    if cid not in master:
        raise ValueError(f"角色不存在于 character.json: {cid}")
    m = master[cid][0]
    t = (text.get(cid) or [[""]])[0]
    fields = {}
    for f, (src, idx) in CHAR_FIELD_MAP.items():
        arr = m if src == "master" else t
        fields[f] = arr[idx] if idx < len(arr) else ""
    return {"id": cid, "fields": fields,
            "element_name": ELEMENTS_DISPLAY.get(str(fields.get("element", "")), fields.get("element", ""))}


def _server_char_json_path() -> Path:
    """服务端逻辑用的简化表 assets/character.json(邮件发放/admin 校验),cdndata 的兄弟文件。"""
    return CDNDATA.parent / "character.json"


def save_char_fields(cid: str, edits: dict, dry_run: bool) -> dict:
    """三层同步保存角色资料(2026-07-06 起):
    ①层 cdndata 两 json(GUI 名录 + 服务端目录镜像);
    ②层 character / character_text 表(客户端真正读的:星级/属性/名字/描述,发布后生效);
    服务端简化表 assets/character.json(name/rarity/element,邮件/校验用,重启服务端生效)。
    """
    mp, tp = _char_json_paths()
    master = json.loads(mp.read_text(encoding="utf-8"))
    text = json.loads(tp.read_text(encoding="utf-8"))
    if cid not in master:
        raise ValueError(f"角色不存在于 character.json: {cid}")
    rev_el = {v: k for k, v in ELEMENTS.items()}
    log = []

    def write(src, idx, val):
        store = master if src == "master" else text
        store.setdefault(cid, [[]])
        arr = store[cid][0]
        while len(arr) <= idx:
            arr.append("")
        if arr[idx] != val:
            log.append(f"①{src}[{idx}] {arr[idx]!r} -> {val!r}")
            arr[idx] = val

    norm = {}  # 归一化后的编辑值(element 已转 0-5),②层/服务端复用
    for f, val in edits.items():
        if f not in CHAR_FIELD_MAP:
            continue
        src, idx = CHAR_FIELD_MAP[f]
        val = str(val)
        if f == "element":
            val = rev_el.get(val, val)  # 中文名 -> 0-5
            # 硬拦截:element=6(Colorless)敌人专属,写给可玩角色会崩(C7050/连锁越界/
            # forceUncolorless 抛)。2026-07-12 实测阿尔克 element=6 → 查看即崩,已回滚。
            if val in ("6", "通用"):
                raise ValueError(
                    "element=6(通用/Colorless)是敌人专属元素,写给可玩角色会导致客户端崩溃"
                    "(C7050 等),已禁止。要「任意共鸣」用『通用共鸣(OmniElement)』开关(保留原元素)。")
        if f == "race":
            # 客户端把 c4 按逗号拆 token 查 APK 内 race 表,未知 token 显示不出来(中文更不行)
            val = ",".join(t.strip() for t in val.split(",") if t.strip())
            bad = [t for t in val.split(",") if t and t not in RACE_TOKENS]
            if bad:
                raise ValueError(f"未知种族 token: {'/'.join(bad)}。只认英文 token(逗号分隔多值): "
                                 + ",".join(RACE_TOKENS)
                                 + "(Human人型 Beast兽型 Element精灵 Machine机械 Undead不死"
                                   " Mystery神秘 Dragon龙族 Devil魔族 Plants植物 Aquatic水栖)")
        norm[f] = val
        write(src, idx, val)
        if f in CHAR_FIELD_EXTRA:  # 队长技名双写:客户端详情页读 character c18,不读 text[10]
            write(*CHAR_FIELD_EXTRA[f], val)

    # ---- ②层:同列写 character / character_text(客户端显示与战斗读这里) ----
    l2 = {"master": None, "text": None}   # 有变更的表对象,写盘阶段用
    l2_parsed = {}
    for src_kind, logical in (("master", core.CHARACTER_LOGICAL), ("text", CHAR_TEXT2_LOGICAL)):
        idx_writes = [(CHAR_FIELD_MAP[f][1], v) for f, v in norm.items()
                      if CHAR_FIELD_MAP[f][0] == src_kind]
        idx_writes += [(CHAR_FIELD_EXTRA[f][1], v) for f, v in norm.items()
                       if f in CHAR_FIELD_EXTRA and CHAR_FIELD_EXTRA[f][0] == src_kind]
        if not idx_writes:
            continue
        try:
            table = core.load_table(logical, TARGET_STORE, SOURCE_STORE)
        except Exception as e:
            log.append(f"②{src_kind} 表读取失败,跳过同步: {e}")
            continue
        parsed = {k: core.read_csv_lines(t) for k, t in table.text_rows().items()}
        if cid not in parsed:
            log.append(f"②{src_kind} 表中没有角色 {cid},跳过同步")
            continue
        row = parsed[cid][0]
        changed = False
        for idx, val in idx_writes:
            while len(row) <= idx:
                row.append("")
            if row[idx] != val:
                log.append(f"②{src_kind}[{idx}] {row[idx]!r} -> {val!r}")
                row[idx] = val
                changed = True
        if changed:
            l2[src_kind] = table
            l2_parsed[src_kind] = parsed

    # ---- ②层 action_skill:技能名/描述的**实际显示源**(详情页/战斗)同步 ----
    # character_text 的 skill_name_*/description_* 只喂抽卡特性页;详情页与战斗读
    # action_skill 表 name/description(2026-07-13 逆向 StatusWindowView L1086/1103)。
    sk_edits = []
    for lv, (fn, fd) in _SKILL_TEXT_SYNC.items():
        e = {"level": lv}
        if fn in norm:
            e["name"] = norm[fn]
        if fd in norm:
            e["description"] = norm[fd]
        if len(e) > 1:
            sk_edits.append(e)
    if sk_edits:
        askey = _action_skill_key(cid)
        sharers = [k for k, v in master.items()
                   if v and len(v[0]) > 8 and v[0][8] == askey and k != cid]
        try:
            r = save_skill_energy(cid, sk_edits, dry_run)
            if r.get("log"):
                log.append("②action_skill 同步(详情页/战斗显示源): "
                           + "; ".join(l for l in r["log"].splitlines() if l))
            if r.get("changes") and sharers:
                log.append(f"⚠ 技能 {askey} 与 {len(sharers)} 个角色共用"
                           f"({'/'.join(sharers[:5])}{'…' if len(sharers) > 5 else ''}),"
                           "技能名/描述会一起变(克隆时勾「资产独立」可避免)")
        except Exception as e:
            log.append(f"⚠ action_skill 同步失败(游戏内技能名/描述不会变): {e}")

    # ---- 服务端简化表 assets/character.json(name/rarity/element) ----
    sp = _server_char_json_path()
    server = None
    if sp.exists() and any(f in norm for f in ("name", "rarity", "element")):
        try:
            server = json.loads(sp.read_text(encoding="utf-8"))
        except Exception as e:
            log.append(f"服务端 character.json 读取失败,跳过同步: {e}")
            server = None
        if server is not None:
            ent = server.get(cid)
            if ent is None:
                log.append(f"服务端 character.json 中没有角色 {cid},跳过同步")
                server = None
            else:
                dirty = False
                for f in ("rarity", "element"):
                    if f in norm:
                        try:
                            nv = int(norm[f])
                        except ValueError:
                            continue
                        if ent.get(f) != nv:
                            log.append(f"服务端[{f}] {ent.get(f)!r} -> {nv!r}")
                            ent[f] = nv
                            dirty = True
                if "name" in norm and ent.get("name") != norm["name"]:
                    log.append(f"服务端[name] {ent.get('name')!r} -> {norm['name']!r}")
                    ent["name"] = norm["name"]
                    dirty = True
                if not dirty:
                    server = None

    # 改星级 → 顺带校正所有存档里该角色的 突破段/exp(防 C2275 崩溃;dry-run 只预览)
    clamp_log = ""
    if "rarity" in norm:
        try:
            clamp_log = _clamp_save_for_rarity(cid, int(norm["rarity"]), apply=not dry_run)
        except (ValueError, TypeError):
            clamp_log = ""
        if clamp_log:
            log.append(clamp_log + ("" if dry_run else "(已写入存档,重启游戏生效)"))

    written = None
    if not dry_run and log:
        global _char_cache
        suffix = ".bak-charfields-" + time.strftime("%Y%m%d-%H%M%S")
        for p in (mp, tp):
            bak = p.with_name(p.name + suffix)
            if not bak.exists():  # 同秒连写不覆盖更早的备份
                shutil.copy2(p, bak)
        mp.write_text(json.dumps(master, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        tp.write_text(json.dumps(text, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        written = str(mp)
        for src_kind, logical in (("master", core.CHARACTER_LOGICAL), ("text", CHAR_TEXT2_LOGICAL)):
            table = l2[src_kind]
            if table is None:
                continue
            table.set_text_rows({k: core.write_csv_lines(r) for k, r in l2_parsed[src_kind].items()})
            buf = io.StringIO()
            with redirect_stdout(buf):
                w = core.write_table(table, TARGET_STORE, suffix, no_backup=False)
            add_pending(w)
            record_change(logical, f"{cid} 资料同步: " + "; ".join(
                l for l in log if l.startswith(f"②{src_kind}")), w.with_name(w.name + suffix))
        if server is not None:
            sbak = sp.with_name(sp.name + suffix)
            if not sbak.exists():
                shutil.copy2(sp, sbak)
            sp.write_text(json.dumps(server, ensure_ascii=False, indent=2), encoding="utf-8")
        _char_cache = None  # 名录已变,清缓存使左侧列表刷新
    synced2 = any(t is not None for t in l2.values())
    note = "①层已改(重启服务端生效)"
    if synced2:
        note += ";②层已同步进待发布(点「发布并重启游戏」后游戏内生效)"
    if server is not None:
        note += ";服务端简化表已同步(重启服务端生效)"
    return {"changes": len(log), "log": "\n".join(log), "written": written, "dry_run": dry_run,
            "note": note}


# ---------------------------------------------------------------- 整体转属性(一键)
# 元素在角色数据里的落点(2026-07-13 逆向):
#  1) character 表 c3 element(0火1水2雷3风4光5暗)—— 决定 UI 属性 + 属性球 + 克制
#     + **技能伤害元素随此自动**(白等技能 DSL 无显式元素参数,伤害元素 = 角色 c3)。
#  2) ability/leader 全行的**元素 string token**(Red/Blue/Yellow/Green/White/Black)——
#     只出现在 character_groups 类单元格(编成≥/共鸣/[限X属性]/赋予全队(X)),全是己方队门槛,
#     改属性必须整套翻(否则如白转光后队长技还判"风编成"→永不触发,上轮实锤)。
#  3) content 块的 **element 数值列(0-5)**:显式指定造物/攻击元素,非空且=旧属性时翻。
#  ❌ 不翻:元素型**枚举 kind**(数字 ID,如 抗性风/敌方抗性火↓/来自抗性X)——判攻击方/敌方
#     元素,是独立机制,与角色自身属性无关(翻了会改玩法);工具报告出来供人工决定。
_EL_TOKENS = {"0": "Red", "1": "Blue", "2": "Yellow", "3": "Green", "4": "White", "5": "Black"}
_EL_TOKEN_SET = set(_EL_TOKENS.values())
_EL_ENUM_SETS = None  # 惰性:元素型枚举 kind 的 (block -> {kind_id}) 供报告


def _element_enum_ids() -> dict:
    """元素型枚举 kind 的 ID 集合(供报告"未改动机制类"),按 content 块。"""
    global _EL_ENUM_SETS
    if _EL_ENUM_SETS is not None:
        return _EL_ENUM_SETS
    en = composer_meta()["enums"]
    out = {}
    for cat in ("instant_content", "during_content"):
        ids = {}
        for k, v in en.get(cat, {}).items():
            if any(e in v.get("en", "") for e in _EL_TOKEN_SET) \
                    or any(c in v.get("cn", "") for c in "火水雷风光暗"):
                ids[k] = v.get("cn") or v.get("en")
        out[cat] = ids
    _EL_ENUM_SETS = out
    return out


def _flip_row_tokens(row: list, tok: str) -> list[str]:
    """把一行里所有元素 token 单元格翻成 tok;返回改动说明列表。"""
    logs = []
    for ci, v in enumerate(row):
        if not v:
            continue
        parts = v.split(",")
        if any(p in _EL_TOKEN_SET for p in parts):
            newparts = [tok if p in _EL_TOKEN_SET else p for p in parts]
            nv = ",".join(newparts)
            if nv != v:
                logs.append(f"c{ci} {v!r}->{nv!r}")
                row[ci] = nv
    return logs


def element_convert(character: str, target: str, dry_run: bool) -> dict:
    """一键把角色整套改成 target 属性(0-5/中文):c3 + 全套词条/队长技元素 token +
    content element 列 + ①层三层同步。元素型枚举 kind(抗性/敌方,判他方元素)不动,列进报告。"""
    rev_el = {v: k for k, v in ELEMENTS.items()}
    tgt = rev_el.get(str(target), str(target))
    if tgt not in _EL_TOKENS:
        raise ValueError(f"目标属性非法: {target}(要 0-5 或 火/水/雷/风/光/暗;element=6 禁用)")
    tok = _EL_TOKENS[tgt]
    cid = str(character)
    char_table = load_char_table()
    ids = list(core.ability_ids_for_character(cid, char_table))
    lid = core.effective_character_id(cid, char_table)
    logs = []
    written = []

    # ---- ② ability 表:6 词条整套翻 token + element 数值列 ----
    ab_blocks = wf_describe.layout("ability")["blocks"]
    ab_el_cols = [ab_blocks["instant_content"] + 26, ab_blocks["during_content"] + 10]
    ab = core.load_table(core.ABILITY_LOGICAL, TARGET_STORE, SOURCE_STORE)
    pa = {k: core.read_csv_lines(t) for k, t in ab.text_rows().items()}
    ab_changed = False
    for aid in ids:
        if aid not in pa:
            continue
        for li, row in enumerate(pa[aid], 1):
            for msg in _flip_row_tokens(row, tok):
                logs.append(f"词条{aid} 行{li} {msg}")
                ab_changed = True
            for ec in ab_el_cols:
                if len(row) > ec and row[ec] in _EL_TOKENS and row[ec] != tgt:
                    logs.append(f"词条{aid} 行{li} c{ec} element {row[ec]}->{tgt}")
                    row[ec] = tgt
                    ab_changed = True

    # ---- ② leader 表 ----
    ld_blocks = wf_describe.layout("leader_ability")["blocks"]
    ld_el_cols = [ld_blocks["instant_content"] + 26, ld_blocks["during_content"] + 10]
    ld = core.load_table(LEADER_LOGICAL, TARGET_STORE, SOURCE_STORE)
    pl = {k: core.read_csv_lines(t) for k, t in ld.text_rows().items()}
    ld_changed = False
    if lid in pl:
        for li, row in enumerate(pl[lid], 1):
            for msg in _flip_row_tokens(row, tok):
                logs.append(f"队长技 行{li} {msg}")
                ld_changed = True
            for ec in ld_el_cols:
                if len(row) > ec and row[ec] in _EL_TOKENS and row[ec] != tgt:
                    logs.append(f"队长技 行{li} c{ec} element {row[ec]}->{tgt}")
                    row[ec] = tgt
                    ld_changed = True

    # ---- 报告:元素型枚举 kind(不改)----
    enum_ids = _element_enum_ids()
    mech = []
    for label, keys, parsed, blocks in (("词条", ids, pa, ab_blocks),
                                        ("队长技", [lid], pl, ld_blocks)):
        for k in keys:
            for li, row in enumerate(parsed.get(k, []), 1):
                for blk, off in (("instant_content", blocks["instant_content"]),
                                 ("during_content", blocks["during_content"])):
                    kind = row[off] if len(row) > off else ""
                    if kind and kind in enum_ids[blk]:
                        who = k if label == "词条" else ""
                        mech.append(f"  {label}{who} 行{li}: {enum_ids[blk][kind]}(机制类,未改)")

    logs.append(f"—— 属性整体转换 -> {ELEMENTS[tgt]}({tok})——")
    logs.append(f"己方队门槛(编成/共鸣/赋予全队/[限X]) + 造物元素:共 "
                f"{sum(1 for l in logs if '->' in l)} 处已翻(见上)"
                if any('->' in l for l in logs) else "词条/队长技里没有需要翻的元素引用")
    if mech:
        logs.append(f"以下 {len(mech)} 处是**判他方元素的机制**(抗性/敌方特攻),按属性无关"
                    "→保留不动(如需改用词条工坊手动换枚举):")
        logs.extend(mech[:20])
        if len(mech) > 20:
            logs.append(f"  …等共 {len(mech)} 处")

    changes = 0
    if not dry_run:
        if ab_changed:
            written.append(str(_write_with_backup(ab, pa, [f"{cid} 整体转{ELEMENTS[tgt]}:词条元素 token"])))
            changes += 1
        if ld_changed:
            written.append(str(_write_with_backup(ld, pl, [f"{cid} 整体转{ELEMENTS[tgt]}:队长技元素 token"])))
            changes += 1
    # c3 + ①层三层同步(复用 save_char_fields;dry_run 透传)
    r_fields = save_char_fields(cid, {"element": tgt}, dry_run)
    if r_fields.get("log"):
        logs.insert(0, "【属性字段】" + r_fields["log"].replace("\n", " / "))
    changes += r_fields.get("changes", 0)
    if not dry_run:
        written.append(r_fields.get("written") or "")
    return {"changes": changes if not dry_run else (int(ab_changed) + int(ld_changed) + 1),
            "log": "\n".join(logs), "written": "; ".join(w for w in written if w) or None,
            "dry_run": dry_run,
            "note": "②层(c3+词条+队长技)进待发布→「发布并重启游戏」;①层资料+服务端简化表"
                    "重启服务端生效。技能伤害元素随 c3 自动,无需改 DSL。"
                    "机制类枚举(抗性/敌方)按属性无关未动。"}


# ---------------------------------------------------------------- 技能形态切换
# 机制(CharacterValues.as 逆向,见 docs/技能形态切换与资产包导入结论.md):
# ② character 表 col9=条件种类 col10=状态枚举 col12=多球列表 col13=阈值
# col14=切换后技能键(→ switched_action_skill 表,嵌套,键=code_name)
# col15/16=切换时静音(技能音/就绪音)。①层 cdndata character.json 同列镜像。

SWITCH_KINDS = {"(None)": "无切换", "0": "HP≥阈值时", "1": "存在指定状态时",
                "2": "多球数≥阈值时", "3": "技能变化标志触发", "4": "处于副位时"}
SWITCHED_SKILL_LOGICAL = "master/skill/switched_action_skill.orderedmap"
_SWITCH_COLS = {"kind": 9, "condition": 10, "multiballs": 12, "threshold": 13,
                "skill": 14, "no_voice": 15, "no_ready_voice": 16}


def _switched_skill_targets() -> list[str]:
    try:
        return list(wf_boss.qlib.load_table(SWITCHED_SKILL_LOGICAL))
    except Exception:
        return []


def get_skill_switch(cid: str) -> dict:
    row = _char_row(str(cid))
    fields = {f: (row[i] if i < len(row) else "") for f, i in _SWITCH_COLS.items()}
    return {"character": str(cid), "fields": fields, "kinds": SWITCH_KINDS,
            "targets": _switched_skill_targets(),
            "note": "切换后技能必须是 switched_action_skill 表已有键(全库 6 个);"
                    "给新角色加形态需先给该表加键(未支持,可先借用现有键试玩)。"
                    "改条件参数(如 HP 阈值 0.5→0.9)对已带切换的角色即改即用"}


def save_skill_switch(cid: str, edits: dict, dry_run: bool) -> dict:
    cid = str(cid)
    kind = str(edits.get("kind", "")).strip() or "(None)"
    if kind not in SWITCH_KINDS:
        raise ValueError(f"条件种类必须是 {'/'.join(SWITCH_KINDS)}: {kind!r}")
    vals = {"kind": kind}
    if kind == "(None)":
        for f in ("condition", "multiballs", "threshold", "skill", "no_voice", "no_ready_voice"):
            vals[f] = ""
    else:
        skill = str(edits.get("skill", "")).strip()
        targets = _switched_skill_targets()
        if skill not in targets:
            raise ValueError(f"切换后技能 {skill!r} 不在 switched_action_skill 表(现有: {'/'.join(targets)})")
        vals["skill"] = skill
        thr = str(edits.get("threshold", "")).strip()
        if kind in ("0", "2"):
            try:
                float(thr)
            except ValueError:
                raise ValueError(f"阈值必须是数值(HP 比例 0-1 / 球数): {thr!r}")
        vals["threshold"] = thr
        cond = str(edits.get("condition", "")).strip()
        if kind == "1" and not cond.isdigit():
            raise ValueError(f"状态枚举必须是数字(如 28): {cond!r}")
        vals["condition"] = cond
        vals["multiballs"] = str(edits.get("multiballs", "")).strip()
        for f in ("no_voice", "no_ready_voice"):
            v = str(edits.get(f, "")).strip().lower()
            if v not in ("", "true", "false"):
                raise ValueError(f"{f} 必须是 true/false/空: {v!r}")
            vals[f] = v
    # ② character 表
    table = core.load_table(core.CHARACTER_LOGICAL, TARGET_STORE, SOURCE_STORE)
    parsed = {k: core.read_csv_lines(t) for k, t in table.text_rows().items()}
    if cid not in parsed:
        raise ValueError(f"② character 表中没有角色 {cid}")
    row = parsed[cid][0]
    log = []
    for f, val in vals.items():
        i = _SWITCH_COLS[f]
        while len(row) <= i:
            row.append("")
        if row[i] != val:
            log.append(f"②character[{i}]{f} {row[i]!r} -> {val!r}")
            row[i] = val
    # ① cdndata 镜像同列
    mp, _tp = _char_json_paths()
    master = json.loads(mp.read_text(encoding="utf-8"))
    m_arr = master.get(cid, [[]])[0] if cid in master else None
    if m_arr is not None:
        for f, val in vals.items():
            i = _SWITCH_COLS[f]
            while len(m_arr) <= i:
                m_arr.append("")
            if m_arr[i] != val:
                log.append(f"①master[{i}]{f} {m_arr[i]!r} -> {val!r}")
                m_arr[i] = val
    written = None
    if log and not dry_run:
        table.set_text_rows({k: core.write_csv_lines(r) for k, r in parsed.items()})
        suffix = ".bak-wfmod-switch-" + time.strftime("%Y%m%d-%H%M%S")
        buf = io.StringIO()
        with redirect_stdout(buf):
            w = core.write_table(table, TARGET_STORE, suffix, no_backup=False)
        add_pending(w)
        record_change(core.CHARACTER_LOGICAL, f"{cid} 形态切换: " + "; ".join(log), w.with_name(w.name + suffix))
        if m_arr is not None:
            bak = mp.with_name(mp.name + suffix)
            if not bak.exists():
                shutil.copy2(mp, bak)
            mp.write_text(json.dumps(master, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        written = str(w)
    return {"changes": len(log), "log": "\n".join(log), "written": written, "dry_run": dry_run,
            "note": "②层已进待发布(发布后游戏内生效);①层镜像已同步"}


# ---------------------------------------------------------------- 角色资产(立绘/图标/语音)


def char_assets(character: str) -> dict:
    c = next((x for x in load_characters() if x["id"] == str(character)), None)
    if not c:
        raise ValueError(f"角色不存在: {character}")
    code = c["code_name"]
    return {"character": str(character), "code_name": code,
            "assets": wf_assets.char_asset_manifest(TARGET_STORE, code),
            "note": "PNG/MP3 存储态有混淆,预览与替换自动转换;替换自动备份+进待发布"
                    "(medium 根资产发布时自动走 medium diff 包)"}


def get_asset_bytes(logical: str) -> tuple[bytes, str]:
    loc = wf_assets.locate(TARGET_STORE, logical)
    if not loc:
        raise ValueError(f"资产不存在: {logical}")
    data = loc[1].read_bytes()
    if logical.endswith(".png"):
        return wf_assets.png_decode(data), "image/png"
    if logical.endswith(".mp3"):
        return wf_assets.mp3_decode(data), "audio/mpeg"
    return data, "application/octet-stream"


def replace_asset(logical: str, data: bytes, force: bool, dry_run: bool) -> dict:
    loc = wf_assets.locate(TARGET_STORE, logical)
    if not loc:
        raise ValueError(f"资产不存在(暂不支持新增全新路径,先替换现有): {logical}")
    root_name, fp = loc
    old = fp.read_bytes()
    log = []
    atf_job = None
    trim_job = None       # (表, 键, 新行) —— trimmed_image frame 同步
    trim_nested_job = None  # (cid, level, 新内层文本) —— full_shot 的 character_image 同步
    if logical.endswith(".png"):
        if data[:8] != wf_assets.PNG_REAL:
            raise ValueError("上传的不是标准 PNG 文件(魔数不对)")
        nd = wf_assets.png_dims(data)
        od = wf_assets.png_dims(old)
        if od and nd != od and not force:
            raise ValueError(f"尺寸不匹配:原图 {od[0]}x{od[1]},上传 {nd[0]}x{nd[1]}。"
                             f"sprite sheet/图集类必须同尺寸同布局;立绘可勾选「强制」替换"
                             f"(裁剪图的 trim 定位会自动同步,图集类错位不可自动修)")
        enc = wf_assets.png_encode(data)
        log.append(f"{logical}: PNG {od[0]}x{od[1]}→{nd[0]}x{nd[1]}, {len(old)}B→{len(enc)}B [{root_name}]")
        # ---- trim 同步:story/skill_cutin/full_shot 是裁剪图,尺寸变了必须同步
        #      trimmed_image(纹理 frame),否则游戏内错位/出框(2026-07-12 逆向)。
        if od and nd != od:
            te = _trim_entry(logical)
            if te:
                tt, tkey, parts = te
                tx, ty, cw, ch = parts[:4]
                nx = max(0, int(tx) + (od[0] - nd[0]) // 2)
                ny = max(0, int(ty) + (od[1] - nd[1]) // 2)
                new_row = [str(nx), str(ny), cw, ch]
                if new_row != parts[:4]:
                    trim_job = (tt, tkey, new_row)
                    log.append(f"trimmed_image[{tkey}]: {','.join(parts[:4])} -> "
                               f"{','.join(new_row)}(画布 {cw}x{ch} 不变,内容框保持中心)")
                m = _re.search(r"character/([^/]+)/ui/full_shot_1440_1920_([01])\.png$", logical)
                if m:
                    cid = next((c["id"] for c in load_characters()
                                if c["code_name"] == m.group(1)), None)
                    if cid:
                        trim_nested_job = (cid, m.group(2), f"{nx},{ny},{nd[0]},{nd[1]}")
                        log.append(f"character_image[{cid}][形态{m.group(2)}]: -> "
                                   f"{trim_nested_job[2]}(内容框 w/h=新图尺寸,详情页 colorBounds 用)")
            elif logical.split("/")[-1].startswith(("full_shot_", "skill_cutin_")) \
                    or "/ui/story/" in logical:
                log.append(f"⚠ trimmed_image 表中无 {logical[:-4]} 键,不同步(该图可能无 frame)")
        # skill_cutin:战斗真机只读配对的 .atf.deflate(android 根),必须连 ATF 一起重编码
        if "/ui/skill_cutin_" in logical:
            aloc = wf_assets.locate(TARGET_STORE, logical[:-4] + ".atf.deflate")
            if aloc:
                ref = wf_atf.inflate(aloc[1].read_bytes())
                atf_enc = wf_atf.deflate(wf_atf.build_cutin_atf(data, ref))
                atf_job = (aloc[1], atf_enc)
                log.append(f"{logical[:-4]}.atf.deflate: ETC1 纹理重编码 {len(ref)}B→ATF, "
                           f"{len(atf_enc)}B [{aloc[0]}](战斗内实际读取的是 ATF 而非 PNG)")
    elif logical.endswith(".mp3"):
        enc = wf_assets.mp3_encode(data)
        log.append(f"{logical}: MP3 {len(old)}B→{len(enc)}B [{root_name}]")
    else:
        enc = data
        log.append(f"{logical}: RAW {len(old)}B→{len(enc)}B [{root_name}]")
    written = None
    if not dry_run:
        bak = fp.with_name(fp.name + ".bak-wfmod-asset-" + time.strftime("%Y%m%d-%H%M%S"))
        if not bak.exists():
            shutil.copy2(fp, bak)
        fp.write_bytes(enc)
        add_pending(fp)
        if atf_job:
            afp, aenc = atf_job
            abak = afp.with_name(afp.name + ".bak-wfmod-asset-" + time.strftime("%Y%m%d-%H%M%S"))
            if not abak.exists():
                shutil.copy2(afp, abak)
            afp.write_bytes(aenc)
            add_pending(afp)
        if trim_job:
            tt, tkey, new_row = trim_job
            _write_trim_row(tt, tkey, new_row, log)
        if trim_nested_job:
            cid, lv, new_text = trim_nested_job
            om = _load_nested_opt(CHAR_IMAGE_LOGICAL)
            if cid in om.keys:
                inner = core.read_orderedmap_file_from_bytes(om.rows[om.keys.index(cid)])
            else:
                inner = {}
            inner[lv] = new_text
            inner_om = core.OrderedMap("<inner>", list(inner.keys()),
                                       [t.encode("utf-8") for t in inner.values()], Path("."))
            blob = core.build_orderedmap(inner_om)
            if cid in om.keys:
                om.rows[om.keys.index(cid)] = blob
            else:
                om.keys.append(cid)
                om.rows.append(blob)
            _write_nested(om, CHAR_IMAGE_LOGICAL, f"{cid} 立绘内容框随换图同步(形态{lv})")
        record_change(logical, "\n".join(log), bak)
        written = str(fp)
    return {"changes": 1, "log": "\n".join(log), "written": written,
            "dry_run": dry_run, "root": root_name}


# 提取器自产物(datamine 工具切帧/转GIF/解码JSON/缩放图),游戏 store 无对应文件,导入时静默跳过
_PACK_ARTIFACT_DIRS = ("/animated/", "/sprite_sheet/", "/special_sprite_sheet/")
_PACK_ARTIFACT_SUFFIX = (".gif", ".json")


def import_asset_pack(character: str, src_dir: str, force: bool, dry_run: bool) -> dict:
    """全资产包批量导入:datamine 解包目录或 .zip 包一比一替换到 store。
    路径识别(2026-07-13 起两段式):相对路径先按 character/<code>/ 下的逻辑路径找,
    命不中再按**全局逻辑路径**原样找——「一键导出全部资产」的 zip(character/<code>/**、
    battle/** 技能 DSL/特效原样全局树)因此可以直接整包导回,不再报"store 无对应路径"。
    zip 自动解压到临时目录;外层多套的文件夹(zip 内只有一个角色名目录的常见形状)
    自动下钻到含 ui/pixelart/voice/battle 的那级。逐文件走 replace_asset
    (校验/混淆编码/备份/进 pending/改动日志),两种前缀都命不中 store 的路径跳过并报告。"""
    c = next((x for x in load_characters() if x["id"] == str(character)), None)
    if not c:
        raise ValueError(f"角色不存在: {character}")
    code = c["code_name"]
    base = Path(src_dir.strip().strip('"')).expanduser()
    tmp = None
    try:
        if base.is_file() and base.suffix.lower() == ".zip":
            WORK_DIR.mkdir(parents=True, exist_ok=True)
            tmp = Path(tempfile.mkdtemp(prefix="wfpack-", dir=str(WORK_DIR)))
            with zipfile.ZipFile(base) as zf:
                zf.extractall(tmp)
            base = tmp
        elif base.is_file():
            raise ValueError(f"不支持的文件类型(目录或 .zip): {src_dir}")
        if not base.is_dir():
            raise ValueError(f"目录/zip 不存在: {src_dir}")
        markers = ("ui", "pixelart", "voice", "battle")
        for _ in range(3):  # 自动下钻最多 3 层
            if any((base / m).is_dir() for m in markers):
                break
            subs = [p for p in base.iterdir() if p.is_dir()]
            if len(subs) != 1:
                break
            base = subs[0]
        replaced, artifacts, missing, bad = [], [], [], []
        log = []
        for root, _, files in os.walk(base):
            for fn in sorted(files):
                fp = Path(root) / fn
                rel = fp.relative_to(base).as_posix()
                marked = "/" + rel
                if (rel.lower().endswith(_PACK_ARTIFACT_SUFFIX)
                        or "_resized." in rel
                        or any(m in marked for m in _PACK_ARTIFACT_DIRS)):
                    artifacts.append(rel)
                    continue
                logical = f"character/{code}/{rel}"
                if not wf_assets.locate(TARGET_STORE, logical):
                    # 全局逻辑路径兜底:一键导出包里 character/<code>/**、battle/**(技能
                    # DSL/特效)是完整逻辑树,不能再套 character/<code>/ 前缀
                    if wf_assets.locate(TARGET_STORE, rel):
                        logical = rel
                    else:
                        missing.append(rel)
                        continue
                try:
                    r = replace_asset(logical, fp.read_bytes(), force, dry_run)
                    replaced.append(rel)
                    log.append(r["log"])
                except ValueError as e:
                    bad.append(f"{rel}: {e}")
        return {"changes": len(replaced), "dry_run": dry_run, "code_name": code,
                "replaced": len(replaced), "artifacts": len(artifacts),
                "missing": missing, "bad": bad, "log": "\n".join(log),
                "note": f"替换 {len(replaced)},跳过提取器产物 {len(artifacts)},"
                        f"store 无对应 {len(missing)},失败 {len(bad)}"
                        + ("(dry-run 预览,未写入)" if dry_run
                           else ";已备份+进待发布,点「发布并重启游戏」生效")}
    finally:
        if tmp is not None:
            shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------- 像素图排布/动画数据
# sprite_sheet 的小图排布由配套 .atlas.amf3.deflate 决定(AMF3 列表,每项 {n,x,y,w,h[,r]});
# 动画由 .frame/.timeline 定义。容器 = raw deflate(-15) 包 AMF3,已实测 40 文件
# core.AMF3Reader 解码 + wf_dsl.encode_amf3 编码字节级一致。
# 资产包导入会把 datamine 解码出的 .json 当提取器产物跳过——这里是它们的专用入口:
# GUI 内直改(/pixelart_data → /pixelart_data/save json_text)或
# 上传外部编辑好的文档(data_b64,.json / .amf3.deflate / 裸 AMF3 自动识别)。

PIXELART_DATA_FILES = {
    "atlas": ("pixelart/sprite_sheet.atlas.amf3.deflate", "常规像素图排布(atlas)"),
    "special_atlas": ("pixelart/special_sprite_sheet.atlas.amf3.deflate", "特殊动作排布(atlas)"),
    "frame": ("pixelart/pixelart.frame.amf3.deflate", "常规动画帧定义"),
    "timeline": ("pixelart/pixelart.timeline.amf3.deflate", "常规动画时间轴"),
    "special_frame": ("pixelart/special.frame.amf3.deflate", "特殊动作帧定义"),
    "special_timeline": ("pixelart/special.timeline.amf3.deflate", "特殊动作时间轴"),
}


def _pixelart_logical(character: str, name: str) -> tuple[str, str]:
    c = next((x for x in load_characters() if x["id"] == str(character)), None)
    if not c:
        raise ValueError(f"角色不存在: {character}")
    if name not in PIXELART_DATA_FILES:
        raise ValueError(f"未知数据文件 {name}(可选: {'/'.join(PIXELART_DATA_FILES)})")
    rel, desc = PIXELART_DATA_FILES[name]
    return f"character/{c['code_name']}/{rel}", desc


def _amf3_container_load(logical: str) -> tuple[bytes, str]:
    """读 .amf3.deflate:store 优先,APK bundle 兜底;返回 (AMF3 明文, 来源根)。"""
    loc = wf_assets.locate(TARGET_STORE, logical)
    if loc:
        raw, src = loc[1].read_bytes(), loc[0]
    else:
        raw = _apk_read_asset(logical)
        if raw is None:
            raise ValueError(f"资产不存在(store 与 APK bundle 均无): {logical}")
        src = "apk_bundle"
    for blob in (raw, raw[4:] if len(raw) > 4 else raw):
        for wb in (-15, 15):
            try:
                return zlib.decompress(blob, wb), src
            except Exception:
                continue
    raise ValueError(f"无法解压(不是 deflate/zlib 容器): {logical}")


def get_pixelart_data(character: str, name: str) -> dict:
    logical, desc = _pixelart_logical(character, name)
    plain, src = _amf3_container_load(logical)
    tree = core.AMF3Reader(plain).read_value()
    byte_ok = wf_dsl.encode_amf3(tree) == plain
    return {"character": str(character), "name": name, "logical": logical, "source": src,
            "desc": desc, "bytes": len(plain), "byte_roundtrip": byte_ok,
            "entries": len(tree) if isinstance(tree, (list, dict)) else None,
            "json_text": json.dumps(tree, ensure_ascii=False, indent=1),
            "note": ("atlas 每项 {n:小图名,x,y,w,h[,r:存图旋转90°]},坐标=sprite_sheet.png 内像素;"
                     "对象键序不可重排(AMF3 按序写 traits);整数别写成 3.0(类型会变)。"
                     + ("" if byte_ok else " ⚠ 此文件编码器往返不一致,保存前会再自检,谨慎"))}


def _tree_equal(a, b) -> bool:
    """dict 比较须含键序(AMF3 traits 有序;== 忽略键序会漏改动)。"""
    if isinstance(a, dict) and isinstance(b, dict):
        return list(a.keys()) == list(b.keys()) and all(_tree_equal(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_tree_equal(x, y) for x, y in zip(a, b))
    return type(a) is type(b) and a == b


def save_pixelart_data(character: str, name: str, json_text: str, data_b64: str,
                       dry_run: bool) -> dict:
    """编辑保存(json_text)或上传文档(data_b64:.json/.amf3.deflate/裸 AMF3 自动识别)。"""
    logical, desc = _pixelart_logical(character, name)
    if (json_text or "").strip():
        tree = json.loads(json_text)
        src_desc = "JSON 文本"
    elif data_b64:
        raw = base64.b64decode(data_b64)
        tree, src_desc = None, ""
        try:
            tree = json.loads(raw.decode("utf-8"))
            src_desc = "JSON 文件"
        except Exception:
            for blob in (raw, raw[4:] if len(raw) > 4 else raw):
                for wb in (-15, 15):
                    try:
                        tree = core.AMF3Reader(zlib.decompress(blob, wb)).read_value()
                        src_desc = "amf3.deflate 二进制"
                        break
                    except Exception:
                        continue
                if tree is not None:
                    break
            if tree is None:
                try:
                    tree = core.AMF3Reader(raw).read_value()
                    src_desc = "裸 AMF3"
                except Exception:
                    raise ValueError("上传内容不是 JSON / amf3.deflate / AMF3 任一格式")
    else:
        raise ValueError("缺少内容(json_text 或 data_b64)")

    plain = wf_dsl.encode_amf3(tree)
    if not _tree_equal(core.AMF3Reader(plain).read_value(), tree):
        raise ValueError("AMF3 编码自校验失败(结构含不支持的类型?),已放弃写入")
    try:
        old_plain, src = _amf3_container_load(logical)
    except ValueError:
        old_plain, src = None, "new"
    if old_plain is not None and plain == old_plain:
        return {"changes": 0, "log": "内容与当前文件一致,无需写入", "written": None,
                "dry_run": dry_run}
    n = len(tree) if isinstance(tree, (list, dict)) else 0
    co = zlib.compressobj(9, zlib.DEFLATED, -15)
    enc = co.compress(plain) + co.flush()
    log = [f"{logical}: {desc} {'新建' if old_plain is None else '替换'}({src_desc}),"
           f"明文 {len(old_plain) if old_plain else 0}B -> {len(plain)}B,条目 {n}"
           + (" [原文件在 APK bundle,写 store 后下载优先接管]" if src == "apk_bundle" else "")]
    written = None
    if not dry_run:
        loc = wf_assets.locate(TARGET_STORE, logical)
        if loc:
            fp = loc[1]
        else:
            d = core.sha1_path(logical)
            fp = TARGET_STORE / d[:2] / d[2:]
            fp.parent.mkdir(parents=True, exist_ok=True)
        bak = None
        if fp.exists():
            bak = fp.with_name(fp.name + ".bak-wfmod-pixdata-" + time.strftime("%Y%m%d-%H%M%S"))
            if not bak.exists():
                shutil.copy2(fp, bak)
        fp.write_bytes(enc)
        add_pending(fp)
        record_change(logical, "\n".join(log), bak)
        written = str(fp)
    return {"changes": 1, "log": "\n".join(log), "written": written, "dry_run": dry_run,
            "note": "发布后生效;改 atlas 只影响排布读取,PNG 本体另用「替换」上传"}


# ---------------------------------------------------------------- 技能效果 DSL 数值


def _skill_program_path(character: str, level: str) -> str:
    key = _action_skill_key(character)
    table = core.load_action_skill_table(TARGET_STORE, SOURCE_STORE)
    if key not in table.keys:
        raise ValueError(f"action_skill 表中没有 {key}(角色 {character})")
    entries = dict(core.decode_action_skill_row(table.rows[table.keys.index(key)]))
    if str(level) not in entries:
        raise ValueError(f"没有技能级别 {level}(现有: {'/'.join(entries)})")
    fields = entries[str(level)]
    pi = core.ACTION_SKILL_COLUMNS["program_path"]
    pp = fields[pi] if len(fields) > pi else ""
    if not pp or pp == "(None)":
        why = "官方数据即为短行(仅名称/描述)" if len(fields) <= pi else "该级别未引用效果文件"
        raise ValueError(f"{key} 级别{level} 没有效果文件(program_path):{why};"
                         "无法编辑效果参数,可用「整技能替换」换成其他角色的技能")
    return pp


def get_skill_dsl(character: str, level: str) -> dict:
    pp = _skill_program_path(character, level)
    fp, data = wf_dsl.load_dsl_file(TARGET_STORE, pp)
    r = wf_dsl.parse_dsl(data)
    nums = [{"offset": n["offset"], "len": n["len"], "type": n["type"],
             "value": n["value"], "ctx": wf_dsl.cn_ctx(n["ctx"])} for n in r["numbers"]]
    return {"character": str(character), "level": str(level), "program_path": pp,
            "numbers": nums,
            "note": "技能效果命令树全部数值(判定范围/帧/强度…,单位随命令不同,小步改+实测);"
                    "整数受原字段字节数限制,放不下会拒绝(此时用整技能替换换模板)"}


def save_skill_dsl(character: str, level: str, edits: list[dict], dry_run: bool) -> dict:
    pp = _skill_program_path(character, level)
    fp, data = wf_dsl.load_dsl_file(TARGET_STORE, pp)
    patched, plog = wf_dsl.patch_numbers(data, edits)
    log = [f"{pp} 技能效果 DSL 补丁 {len(edits)} 处"] + plog
    written = None
    if not dry_run and patched != data:
        suffix = ".bak-wfmod-dsl-" + time.strftime("%Y%m%d-%H%M%S")
        wf_dsl.save_dsl_file(fp, patched, suffix)
        add_pending(fp)
        record_change(wf_dsl.dsl_logical(pp), "\n".join(log), fp.with_name(fp.name + suffix))
        written = str(fp)
    return {"changes": len(plog), "log": "\n".join(log), "written": written, "dry_run": dry_run}


def _dsl_sharers(pp: str) -> list[str]:
    """引用同一 program_path 的 action_skill 键(共享技能改一处全变,提示用)。"""
    out = []
    try:
        table = core.load_action_skill_table(TARGET_STORE, SOURCE_STORE)
        pi = core.ACTION_SKILL_COLUMNS["program_path"]
        for key, row in zip(table.keys, table.rows):
            try:
                for _lv, f in core.decode_action_skill_row(bytes(row)):
                    if len(f) > pi and f[pi] == pp:
                        out.append(key)
                        break
            except Exception:
                continue
    except Exception:
        pass
    return out


def get_skill_dsl_json(character: str, level: str, pp: str = "") -> dict:
    """整棵技能 DSL 命令树导出为 JSON 文本(AMF3 序列化器已全库 1035 文件字节级往返验证)。
    pp 非空 = 直接按 program_path 打开(强化弹射/变体等非 action_skill 引用的效果文件)。"""
    if not pp:
        pp = _skill_program_path(character, level)
    fp, data = wf_dsl.load_dsl_file(TARGET_STORE, pp)
    byte_ok, sem_ok = wf_dsl.roundtrip_ok(data)
    if not (byte_ok or sem_ok):
        raise ValueError("该 DSL 文件往返自检失败,禁止 JSON 编辑(可用「效果参数」原地补丁)")
    sharers = _dsl_sharers(pp)
    return {"character": str(character), "level": str(level), "program_path": pp,
            "json_text": wf_dsl.dsl_to_json_text(data), "bytes": len(data),
            "sharers": sharers,
            "note": "整树可改:数值/字符串/增删命令数组均可;3 与 3.0 类型不同勿混"
                    "(整数=int,带小数点=double);结构错了保存时会被自检拦下。"
                    + (f"共享提醒:{len(sharers)} 个技能键引用此文件,改动全部生效" if len(sharers) > 1 else "")}


def save_skill_dsl_json(character: str, level: str, json_text: str, dry_run: bool,
                        pp: str = "") -> dict:
    if not pp:
        pp = _skill_program_path(character, level)
    fp, data = wf_dsl.load_dsl_file(TARGET_STORE, pp)
    new = wf_dsl.json_text_to_dsl(json_text)  # 含 encode→parse 自校验
    if new == data:
        return {"changes": 0, "log": "内容与当前文件一致,无需写入", "written": None, "dry_run": dry_run}
    o = len(wf_dsl.parse_dsl(data)["numbers"])
    n = len(wf_dsl.parse_dsl(new)["numbers"])
    log = [f"{pp} JSON 整树替换: {len(data)}B -> {len(new)}B,数值叶子 {o} -> {n}"]
    written = None
    if not dry_run:
        suffix = ".bak-wfmod-dsljson-" + time.strftime("%Y%m%d-%H%M%S")
        wf_dsl.save_dsl_file(fp, new, suffix)
        add_pending(fp)
        record_change(wf_dsl.dsl_logical(pp), "\n".join(log), fp.with_name(fp.name + suffix))
        written = str(fp)
    return {"changes": 1, "log": "\n".join(log), "written": written, "dry_run": dry_run}


# ---------------------------------------------------------------- 技能效果文件上传
# 用户自己写好的技能效果(ActionDsl)直接替换目标文件:
#   main   = action_skill 各级别(1=觉醒前/基础技,2=觉醒后/+进化技,3=++)的 program_path
#   switch = switched_action_skill 变体(形态切换后技能,外层键=code_name,内层 1/2,c0=program_path)
# 输入两种:json_text = wf_dsl JSON 格式(「技能 JSON」导出的同款,编码时自校验);
#          data_b64  = 原始 AMF3 字节(或 .deflate 压缩,自动识别),parse 通过才收。
# 文件可不存在(官方未下发)→ 新建 sha1 路径;program_path 无效(短行)→ 报错。


def _dsl_target_pp(character: str, level: str, kind: str) -> str:
    level = str(level)
    if kind == "switch":
        key = _action_skill_key(character)
        t = wf_boss.qlib.load_table(SWITCHED_SKILL_LOGICAL)
        row = (t.get(key) or {}).get(level)
        if not row:
            raise ValueError(f"switched_action_skill 中没有 {key} 级别{level}"
                             f"(现有变体键: {'/'.join(t)})")
        pp = row.split(",")[0].strip()
    else:
        pp = _skill_program_path(character, level)
    if not pp or pp == "(None)":
        raise ValueError("该级别没有效果文件引用(官方短行),先用「整技能替换」建立引用")
    return pp


def upload_skill_dsl(character: str, level: str, kind: str, json_text: str,
                     data_b64: str, dry_run: bool) -> dict:
    pp = _dsl_target_pp(character, level, kind)
    if json_text.strip():
        new = wf_dsl.json_text_to_dsl(json_text)  # 编码 → parse 自校验
        src_desc = "JSON 文本"
    elif data_b64:
        raw = base64.b64decode(data_b64)
        try:
            wf_dsl.parse_dsl(raw)
            new = raw
            src_desc = "AMF3 二进制"
        except Exception:
            import zlib as _z
            try:
                new = _z.decompress(raw, -15)
            except Exception:
                try:
                    new = _z.decompress(raw)
                except Exception:
                    raise ValueError("上传内容既不是可解析的 AMF3,也不是 deflate/zlib 压缩包")
            wf_dsl.parse_dsl(new)  # 解压后必须可解析
            src_desc = "deflate 压缩 AMF3"
    else:
        raise ValueError("缺少上传内容(json_text 或 data_b64)")

    lg = wf_dsl.dsl_logical(pp)
    d = core.sha1_path(lg)
    fp = TARGET_STORE / d[:2] / d[2:]
    old = None
    if fp.exists():
        import zlib as _z
        try:
            old = _z.decompress(fp.read_bytes(), -15)
        except Exception:
            old = None
    if old == new:
        return {"changes": 0, "log": "内容与当前文件一致,无需写入", "written": None,
                "dry_run": dry_run}
    n_leaf = len(wf_dsl.parse_dsl(new)["numbers"])
    sharers = _dsl_sharers(pp)
    log = [f"{pp} 效果文件{'替换' if old is not None else '新建'}({src_desc}): "
           f"{len(old) if old is not None else 0}B -> {len(new)}B,数值叶子 {n_leaf}"]
    if len(sharers) > 1:
        log.append(f"共享提醒: {len(sharers)} 个技能键引用此文件({'/'.join(sharers)}),全部一起变")
    written = None
    if not dry_run:
        fp.parent.mkdir(parents=True, exist_ok=True)
        suffix = ".bak-wfmod-dslup-" + time.strftime("%Y%m%d-%H%M%S")
        wf_dsl.save_dsl_file(fp, new, suffix)
        add_pending(fp)
        record_change(lg, "\n".join(log),
                      fp.with_name(fp.name + suffix) if old is not None else None)
        written = str(fp)
    return {"changes": 1, "log": "\n".join(log), "written": written, "dry_run": dry_run,
            "note": "发布后生效;上传前可先用「JSON」按钮导出现有文件做底稿"}


def switched_skill_variants(character: str) -> dict:
    """该角色(按 code_name)在 switched_action_skill 里的变体级别与引用;无则给全部键供参考。"""
    key = _action_skill_key(character)
    t = wf_boss.qlib.load_table(SWITCHED_SKILL_LOGICAL)
    mine = t.get(key) or {}
    return {"character": str(character), "key": key,
            "levels": [{"level": lv, "program_path": row.split(",")[0].strip()}
                       for lv, row in mine.items()],
            "all_keys": list(t)}


# ---------------------------------------------------------------- 技能效果词条(命令级编辑)
# 前端「效果词条」编辑器:树在前端用字面量保持型 JSON 解析器编辑(int/double 不失真),
# 保存复用 /skill_dsl_json/save。后端只提供:
#   /skill_sig      命令/事件/枚举构造签名 + 中文标注(wf_dsl_sig,静态)
#   /skill_cmd_lib  全库命令实例库(从 1024 个技能 DSL 收割,去重,供"插入命令"检索)

_CMDLIB_CACHE: dict = {"stamp": None, "items": None, "names": None}


def skill_sig() -> dict:
    import wf_dsl_sig as S
    return {"commands": S.COMMANDS, "events": S.EVENTS, "enums": S.ENUMS,
            "cmd_cn": S.CMD_CN, "ac_cn": S.AC_CN, "param_cn": S.PARAM_CN,
            "ac_param_cn": S.AC_PARAM_CN, "type_cn": S.TYPE_CN,
            "note": "树语法: [\"Block\",[表达式...]] / [\"Command\",[名,参数...]] / "
                    "[\"Event\",[名,参数...]];[{min,max}]=SLv1/满级端点"}


def _all_program_paths() -> dict[str, list[str]]:
    """program_path -> [归属技能键(code_name[·级别/变体])];含 switched 变体。"""
    out: dict[str, list[str]] = {}
    tbl = core.load_action_skill_table(TARGET_STORE, SOURCE_STORE)
    C = core.ACTION_SKILL_COLUMNS
    for ki, key in enumerate(tbl.keys):
        for lv, fields in core.decode_action_skill_row(tbl.rows[ki]):
            if len(fields) > C["program_path"]:
                pp = fields[C["program_path"]]
                if pp and pp != "(None)":
                    out.setdefault(pp, []).append(f"{key}·{lv}")
    try:
        sw = wf_boss.qlib.load_table(SWITCHED_SKILL_LOGICAL)
        for key, levels in sw.items():
            for lv, row in levels.items():
                pp = row.split(",")[0].strip()
                if pp and pp != "(None)":
                    out.setdefault(pp, []).append(f"{key}·变体{lv}")
    except Exception:
        pass
    return out


def _build_cmd_library() -> tuple[list[dict], list[dict]]:
    """全库命令实例收割(按 名称+JSON 去重)。缓存按 action_skill 表 mtime 失效。"""
    import wf_dsl_sig as S
    try:
        stamp = str(core.table_path(TARGET_STORE, core.ACTION_SKILL_LOGICAL).stat().st_mtime_ns)
    except Exception:
        stamp = "0"
    if _CMDLIB_CACHE["stamp"] == stamp:
        return _CMDLIB_CACHE["items"], _CMDLIB_CACHE["names"]
    owners_of = _all_program_paths()
    dedup: dict[tuple, dict] = {}

    def walk(node, pp):
        if isinstance(node, list):
            if (len(node) == 2 and node[0] in ("Command", "Event")
                    and isinstance(node[1], list) and node[1]
                    and isinstance(node[1][0], str)):
                jt = json.dumps(node, ensure_ascii=False)
                k = (node[0], node[1][0], jt)
                it = dedup.get(k)
                if it is None:
                    dedup[k] = it = {"kind": node[0], "name": node[1][0],
                                     "cn": S.cn_cmd(node[1][0]),
                                     "brief": S.brief_command(node[1]),
                                     "owners": [], "count": 0, "json": jt}
                it["count"] += 1
                own = owners_of.get(pp, [])
                for o in own[:2]:
                    if o not in it["owners"] and len(it["owners"]) < 6:
                        it["owners"].append(o)
            for x in node:
                walk(x, pp)
        elif isinstance(node, dict):
            for v in node.values():
                walk(v, pp)

    for pp in owners_of:
        lg = wf_dsl.dsl_logical(pp)
        d = core.sha1_path(lg)
        fp = TARGET_STORE / d[:2] / d[2:]
        if not fp.exists():
            continue
        try:
            tree = wf_dsl.parse_dsl(zlib.decompress(fp.read_bytes(), -15))["tree"]
        except Exception:
            continue
        walk(tree, pp)

    items = sorted(dedup.values(), key=lambda x: (-x["count"], x["name"]))
    by_name: dict[tuple, int] = {}
    for it in items:
        k = (it["kind"], it["name"])
        by_name[k] = by_name.get(k, 0) + it["count"]
    names = sorted(({"kind": k[0], "name": k[1], "cn": wf_dsl_cn(k[1]), "count": n}
                    for k, n in by_name.items()), key=lambda x: -x["count"])
    _CMDLIB_CACHE.update(stamp=stamp, items=items, names=names)
    return items, names


def wf_dsl_cn(name: str) -> str:
    import wf_dsl_sig as S
    return S.cn_cmd(name)


def skill_cmd_lib(name: str, q: str, limit: int = 80) -> dict:
    items, names = _build_cmd_library()
    ql = (q or "").strip().lower()
    hits = []
    for it in items:
        if name and it["name"] != name:
            continue
        if ql:
            hay = (it["name"] + " " + it["cn"] + " " + it["brief"]
                   + " " + " ".join(it["owners"])).lower()
            if ql not in hay:
                continue
        hits.append(it)
        if len(hits) >= max(1, int(limit)):
            break
    return {"names": names, "count": len(hits), "items": hits,
            "note": "items[].json 为该命令实例的完整子树(int/double 已按 3/3.0 区分),"
                    "可直接插入目标技能的 Block"}


# ---------------------------------------------------------------- 强化弹射(Power Flip)
# 逆向结论(2026-07-12,SpecialityTypeTools/PowerFlipLogic/RootMasterBinary/FileReader):
#   * 角色 PF 种类 = character 表 c6 speciality_type:0=knight剑士 1=fighter格斗
#     2=ranged射击 3=supporter辅助 4=special特殊(同时决定类型图标)。
#   * 种类定义表 master/skill/power_flip_action.orderedmap:键=种类 id,行=3 列 DSL 路径
#     (lv1/2/3)。**store 里的是增量部分**(special/ruin_girl/thunder_dragon/override_*),
#     knight/fighter/ranged/supporter 基础键在 APK 内置 base 表里;客户端把多文件 union,
#     键重复 = ClientError 7051 崩溃 → 新键名不得与 base 撞(禁用 4 个标准名)。
#   * DSL 文件解析:下载 store 优先于 APK 内置(FileReader.resolveFiles)→ 把内置
#     knight/ranged/supporter 文件提取进 store 即可编辑(字节相同则行为不变)。
#   * 自定义种类激活 = 队长词条 powerflip_override(instant/during_content 块:
#     id=表键, levels="1,2,3", description_id=文本键;官方例 leader 121177 行4)。

PF_LOGICAL = "master/skill/power_flip_action.orderedmap"
PF_STD = [("knight", "剑士"), ("fighter", "格斗"), ("ranged", "射击"),
          ("supporter", "辅助"), ("special", "特殊")]
PF_SPEC_CN = {0: "剑士(knight)", 1: "格斗(fighter)", 2: "射击(ranged)",
              3: "辅助(supporter)", 4: "特殊(special)"}
_PF_ID_RE = re.compile(r"^[a-z][a-z0-9_]{2,60}$")


def _pf_conventional_paths(kind: str) -> list[str]:
    return [f"battle/action/power_flip/action/{kind}${kind}_lv{n}" for n in (1, 2, 3)]


def _dsl_store_path(pp: str) -> Path:
    d = core.sha1_path(wf_dsl.dsl_logical(pp))
    return TARGET_STORE / d[:2] / d[2:]


def _find_apk() -> Path | None:
    """内置 base 资产来源 APK:WF_APK 环境变量 > 仓库 弹国服/*.apk 取最新。"""
    envp = os.environ.get("WF_APK")
    if envp and Path(envp).exists():
        return Path(envp)
    cands = sorted((ROOT / "弹国服").glob("*.apk"),
                   key=lambda p: p.stat().st_mtime, reverse=True)
    return cands[0] if cands else None


_APK_BUNDLE_CACHE: dict = {"apk": None, "names": None}


def _apk_bundle_names(apk: Path):
    """APK assets/bundle.zip 文件名集(缓存);返回 (ZipFile 工厂, names)。"""
    import zipfile
    if _APK_BUNDLE_CACHE["apk"] != str(apk):
        with zipfile.ZipFile(apk) as z:
            blob = z.read("assets/bundle.zip")
        inner = zipfile.ZipFile(io.BytesIO(blob))
        _APK_BUNDLE_CACHE.update(apk=str(apk), blob=blob,
                                 names=[n for n in inner.namelist() if not n.endswith("/")])
    return _APK_BUNDLE_CACHE


def _apk_read_asset(pp: str) -> bytes | None:
    """从 APK bundle.zip 按 sha1 桶取 DSL 存储态字节;不存在返回 None。"""
    import zipfile
    apk = _find_apk()
    if not apk:
        return None
    cache = _apk_bundle_names(apk)
    d = core.sha1_path(wf_dsl.dsl_logical(pp))
    tail = d[:2] + "/" + d[2:]
    hit = next((n for n in cache["names"] if n.endswith(tail)), None)
    if not hit:
        return None
    return zipfile.ZipFile(io.BytesIO(cache["blob"])).read(hit)


def _pf_table():
    table = core.load_table(PF_LOGICAL, TARGET_STORE, SOURCE_STORE)
    parsed = {k: core.read_csv_lines(t) for k, t in table.text_rows().items()}
    return table, parsed


def powerflip_overview(character: str = "") -> dict:
    table, parsed = _pf_table()
    apk = _find_apk()
    kinds = []
    std_ids = {k for k, _ in PF_STD}

    def level_info(pp: str) -> dict:
        in_store = _dsl_store_path(pp).exists()
        in_apk = False
        if not in_store and apk:
            in_apk = _apk_read_asset(pp) is not None
        return {"pp": pp, "in_store": in_store, "in_apk": in_apk}

    for kid, cn in PF_STD:
        rows = parsed.get(kid)
        paths = ([c for c in rows[0][:3]] if rows and rows[0] else
                 _pf_conventional_paths(kid))
        kinds.append({"id": kid, "cn": cn, "std": True,
                      "source": "store表" if kid in parsed else "内置base",
                      "levels": [level_info(p) for p in paths]})
    for kid, rows in parsed.items():
        if kid in std_ids:
            continue
        paths = rows[0][:3] if rows and rows[0] else []
        kinds.append({"id": kid, "cn": "", "std": False, "source": "store表",
                      "levels": [level_info(p) for p in paths]})

    spec = None
    if character:
        ct = load_char_table()
        t = ct.text_rows().get(str(character)) if ct else None
        if t:
            r = core.read_csv_lines(t)
            if r and len(r[0]) > 6:
                spec = r[0][6]
    return {"kinds": kinds, "apk": str(apk) if apk else None,
            "character": str(character), "speciality": spec,
            "spec_cn": {str(k): v for k, v in PF_SPEC_CN.items()},
            "note": "PF 定义全局共享:改标准种类的效果 = 所有该类型角色一起变。"
                    "自定义种类靠队长词条 powerflip_override(id=种类键,levels=\"1,2,3\")激活。"}


def powerflip_set_spec(character: str, spec, dry_run: bool) -> dict:
    """改角色 PF 种类 = character 表 c6 speciality_type(0-4;同时决定类型图标)。"""
    spec = int(spec)
    if spec not in PF_SPEC_CN:
        raise ValueError("speciality_type 只能是 0-4")
    ct = core.load_table(core.CHARACTER_LOGICAL, TARGET_STORE, SOURCE_STORE)
    parsed = {k: core.read_csv_lines(t) for k, t in ct.text_rows().items()}
    key = str(character)
    if key not in parsed or not parsed[key]:
        raise ValueError(f"character 表中没有 {key}")
    row = parsed[key][0]
    old = row[6] if len(row) > 6 else ""
    if old == str(spec):
        return {"changes": 0, "log": f"{key} 种类已是 {PF_SPEC_CN[spec]},无需修改",
                "written": None, "dry_run": dry_run}
    while len(row) <= 6:
        row.append("")
    row[6] = str(spec)
    log = [f"{key} speciality_type(c6) {old!r} -> {spec}"
           f"({PF_SPEC_CN.get(int(old)) if old.isdigit() and int(old) in PF_SPEC_CN else old} → {PF_SPEC_CN[spec]})"]
    written = None
    if not dry_run:
        written = str(_write_with_backup(ct, parsed, log))
    return {"changes": 1, "log": "\n".join(log), "written": written, "dry_run": dry_run,
            "note": "类型图标随之改变;PF 动作按新种类生效(发布后)"}


def powerflip_extract(kind: str, dry_run: bool) -> dict:
    """把 APK 内置的该种类 PF DSL 提取进 store(字节原样,行为不变),之后即可编辑。"""
    table, parsed = _pf_table()
    paths = (parsed[kind][0][:3] if kind in parsed and parsed[kind]
             else _pf_conventional_paths(kind))
    log, wrote = [], []
    for pp in paths:
        fp = _dsl_store_path(pp)
        if fp.exists():
            log.append(f"{pp}: 已在 store,跳过")
            continue
        raw = _apk_read_asset(pp)
        if raw is None:
            log.append(f"{pp}: ⚠ APK 里也没有,跳过(该级别不可编辑)")
            continue
        wf_dsl.parse_dsl(zlib.decompress(raw, -15))  # 先验证可解析
        log.append(f"{pp}: 从 APK 提取 {len(raw)}B -> store")
        if not dry_run:
            fp.parent.mkdir(parents=True, exist_ok=True)
            fp.write_bytes(raw)
            add_pending(fp)
            record_change(wf_dsl.dsl_logical(pp), f"PF {kind} 提取自 APK({len(raw)}B)", None)
            wrote.append(str(fp))
    return {"changes": len(wrote) if not dry_run else sum("提取" in l for l in log),
            "log": "\n".join(log), "written": "; ".join(wrote) or None, "dry_run": dry_run}


def powerflip_clone(src_kind: str, new_id: str, dry_run: bool) -> dict:
    """新建 PF 种类:克隆 src 的 3 个 DSL 文件到全新路径 + power_flip_action 表加新键。
    激活方式:队长词条 powerflip_override.id=新键(levels=\"1,2,3\")。"""
    new_id = str(new_id).strip()
    if not _PF_ID_RE.match(new_id):
        raise ValueError("新种类 id 只能用小写字母/数字/下划线(字母开头,3-61 位)")
    table, parsed = _pf_table()
    if new_id in parsed:
        raise ValueError(f"种类已存在: {new_id}")
    if new_id in {k for k, _ in PF_STD}:
        raise ValueError("不能占用标准种类名(内置 base 表已有,键重复=客户端 7051 崩溃)")
    src_paths = (parsed[src_kind][0][:3] if src_kind in parsed and parsed[src_kind]
                 else _pf_conventional_paths(src_kind) if src_kind in {k for k, _ in PF_STD}
                 else None)
    if not src_paths:
        raise ValueError(f"来源种类不存在: {src_kind}")
    dst_paths = [f"battle/action/power_flip/action/override/{new_id}${new_id}_lv{n}"
                 for n in (1, 2, 3)]
    log = [f"新建 PF 种类 {new_id}(克隆自 {src_kind})"]
    blobs = []
    for sp, dp in zip(src_paths, dst_paths):
        fp = _dsl_store_path(sp)
        if fp.exists():
            raw = fp.read_bytes()
            src_from = "store"
        else:
            raw = _apk_read_asset(sp)
            src_from = "APK"
        if raw is None:
            raise ValueError(f"来源效果文件不可得: {sp}(store 与 APK 都没有)")
        wf_dsl.parse_dsl(zlib.decompress(raw, -15))
        blobs.append((dp, raw))
        log.append(f"  {sp} [{src_from}] -> {dp}({len(raw)}B)")
    log.append(f"  power_flip_action 表 + 键 {new_id}")
    log.append(f"激活:给队长词条的 效果块 填 powerflip_override.id={new_id}, levels=\"1,2,3\""
               f"(词条工坊「瞬发/持续效果」区末尾三个字段)")
    written = []
    if not dry_run:
        for dp, raw in blobs:
            fp = _dsl_store_path(dp)
            fp.parent.mkdir(parents=True, exist_ok=True)
            fp.write_bytes(raw)
            add_pending(fp)
            written.append(str(fp))
        parsed[new_id] = [list(dst_paths)]
        written.append(str(_write_with_backup(table, parsed, log)))
    return {"changes": 4, "log": "\n".join(log), "written": "; ".join(written) or None,
            "dry_run": dry_run, "new_id": new_id, "paths": dst_paths}


# ---------------------------------------------------------------- PF 合成工坊
# 任选已有 PF 种类组合成新种类并一键挂角色(2026-07-13,真机范本 override_dual_spgirl_meteor
# =希尔媞+索维,白 ID10 验证通过)。合并规则:
#   * 基底保留完整生命周期(SetPowerFilpSuppress/NotifyPowerflipEnd/命中重置时间线);
#   * 供体只贡献攻击/演出块——递归剥离生命周期命令(抑制/结束通知/RemoveEvent),
#     剥空的 Wait 事件一并丢弃;
#   * 供体标签(特效名/事件名,'*'匿名除外)加 _N 后缀,防止与基底/其他供体串扰
#     (基底的 HideEffect/RemoveEvent 只认自己的标签);
#   * 顶层抑制帧取全体最大(供体动作不被提前打断)。
# 挂角色 = 队长技追加 instant 722(powerflip_override)行,模板取全表官方 722 行,
# 前置清空=无条件常驻;已有 722 行则改指新种类。仅队长位生效;PF 图标仍随 c6。
_PF_LABEL_ARGS = {"ShowEffect": (1,), "HideEffect": (1,), "Wait": (2,),
                  "RemoveEvent": (1,), "CollisionOfBallAndEnemy": (3,), "CreateHitArea": (1,)}
_PF_LIFECYCLE_CMDS = {"SetPowerFilpSuppress", "NotifyPowerflipEnd", "RemoveEvent"}


def _pf_kind_paths(kind: str, parsed: dict) -> "list[str] | None":
    if kind in parsed and parsed[kind]:
        return parsed[kind][0][:3]
    if kind in {k for k, _ in PF_STD}:
        return _pf_conventional_paths(kind)
    return None


def _pf_load_tree(pp: str):
    fp = _dsl_store_path(pp)
    raw = fp.read_bytes() if fp.exists() else _apk_read_asset(pp)
    if raw is None:
        raise ValueError(f"PF 动作文件不可得(store 与 APK 都没有): {pp}")
    return wf_dsl.parse_dsl(zlib.decompress(raw, -15))["tree"]


def _pf_top_block(tree) -> list:
    for el in tree:
        if isinstance(el, list) and el and el[0] == "Block":
            return el[1]
    raise ValueError("PF DSL 无顶层 Block")


def _pf_cmd_name(entry) -> str:
    return (entry[1][0] if isinstance(entry, list) and len(entry) > 1
            and isinstance(entry[1], list) and entry[1]
            and isinstance(entry[1][0], str) else "")


def _pf_brief_lines(tree) -> list[str]:
    import wf_dsl_sig as _S
    out: list[str] = []

    def walk(n, depth=0):
        if isinstance(n, list):
            if len(n) >= 2 and n[0] in ("Command", "Event") and isinstance(n[1], list) \
                    and n[1] and isinstance(n[1][0], str):
                try:
                    b = _S.brief_command(n[1])
                except Exception:
                    b = None
                out.append("  " * depth + (b or str(n[1][0])))
                for x in n[1][1:]:
                    walk(x, depth + 1)
                return
            for x in n:
                walk(x, depth)

    walk(tree)
    return out


def _pf_has_commands(node) -> bool:
    if isinstance(node, list):
        if node and node[0] == "Command":
            return True
        return any(_pf_has_commands(x) for x in node)
    return False


def _pf_clean_donor(node) -> None:
    """就地递归:每个 Block 内剔除生命周期命令;剥空(不再含任何 Command)的 Wait 事件丢弃。"""
    if not isinstance(node, list):
        return
    if node and node[0] == "Block" and len(node) > 1 and isinstance(node[1], list):
        kept = []
        for e in node[1]:
            nm = _pf_cmd_name(e)
            if isinstance(e, list) and e and e[0] == "Command" and nm in _PF_LIFECYCLE_CMDS:
                continue
            _pf_clean_donor(e)
            if isinstance(e, list) and e and e[0] == "Event" and nm == "Wait" \
                    and not _pf_has_commands(e):
                continue
            kept.append(e)
        node[1] = kept
        return
    for x in node:
        _pf_clean_donor(x)


def _pf_rename_labels(node, suffix: str):
    """就地递归:标签参数(特效名/事件名)加后缀;'*'(匿名)与空串不动。"""
    if isinstance(node, list):
        if len(node) >= 2 and node[0] in ("Command", "Event") and isinstance(node[1], list) \
                and node[1] and isinstance(node[1][0], str):
            cmd = node[1]
            for i in _PF_LABEL_ARGS.get(cmd[0], ()):
                if i < len(cmd) and isinstance(cmd[i], str) and cmd[i] not in ("", "*"):
                    cmd[i] = cmd[i] + suffix
            for x in cmd[1:]:
                _pf_rename_labels(x, suffix)
            return node
        for x in node:
            _pf_rename_labels(x, suffix)
    return node


def powerflip_brief(kind: str) -> dict:
    """一个 PF 种类三级动作的中文命令摘要(合成工坊选材预览用)。"""
    _table, parsed = _pf_table()
    paths = _pf_kind_paths(kind, parsed)
    if not paths:
        raise ValueError(f"种类不存在: {kind}")
    briefs = {}
    for lv, pp in enumerate(paths, 1):
        try:
            briefs[str(lv)] = _pf_brief_lines(_pf_load_tree(pp))
        except Exception as exc:
            briefs[str(lv)] = [f"(不可读: {exc})"]
    return {"kind": kind, "briefs": briefs}


def powerflip_compose(new_id: str, base_kind: str, donor_kinds: list, character: str,
                      dry_run: bool) -> dict:
    """合成新 PF 种类(基底+任意供体)并可选一键挂到角色队长技(instant 722,无条件)。"""
    import copy as _copy
    new_id = str(new_id).strip()
    if not _PF_ID_RE.match(new_id):
        raise ValueError("新种类 id 只能用小写字母/数字/下划线(字母开头,3-61 位)")
    donor_kinds = [str(k).strip() for k in (donor_kinds or []) if str(k).strip()]
    base_kind = str(base_kind).strip()
    if not donor_kinds:
        raise ValueError("至少选一个供体种类(要拼进基底的 PF)")
    if base_kind in donor_kinds:
        raise ValueError(f"基底与供体重复: {base_kind}")
    table, parsed = _pf_table()
    if new_id in parsed:
        raise ValueError(f"种类已存在: {new_id}")
    if new_id in {k for k, _ in PF_STD}:
        raise ValueError("不能占用标准种类名(内置 base 表已有,键重复=客户端 7051 崩溃)")
    src_all = [base_kind] + donor_kinds
    paths = {}
    for k in src_all:
        p = _pf_kind_paths(k, parsed)
        if not p:
            raise ValueError(f"来源种类不存在: {k}")
        paths[k] = p
    dst_paths = [f"battle/action/power_flip/action/override/{new_id}${new_id}_lv{n}"
                 for n in (1, 2, 3)]
    log = [f"合成 PF 种类 {new_id} = 基底 {base_kind} + 供体 {'+'.join(donor_kinds)}"]
    briefs = {}
    blobs = []
    for lv in (1, 2, 3):
        base = _pf_load_tree(paths[base_kind][lv - 1])
        blk = _pf_top_block(base)
        sup_vals = [int(e[1][1]) for e in blk
                    if _pf_cmd_name(e) == "SetPowerFilpSuppress" and len(e[1]) > 1]
        for i, dk in enumerate(donor_kinds):
            donor = _pf_load_tree(paths[dk][lv - 1])
            for e in _pf_top_block(donor):
                if _pf_cmd_name(e) == "SetPowerFilpSuppress" and len(e[1]) > 1:
                    sup_vals.append(int(e[1][1]))
            wrap = ["Block", _copy.deepcopy(_pf_top_block(donor))]
            _pf_clean_donor(wrap)
            _pf_rename_labels(wrap, f"_{i + 2}")
            if not wrap[1]:
                log.append(f"  lv{lv} 供体 {dk}: 剥离生命周期后无剩余命令,跳过")
                continue
            blk.extend(wrap[1])
        if sup_vals:
            for e in blk:
                if _pf_cmd_name(e) == "SetPowerFilpSuppress":
                    e[1][1] = max(sup_vals)
                    break
        enc = wf_dsl.encode_amf3(base)
        if wf_dsl.parse_dsl(enc)["tree"] != base:
            raise ValueError(f"lv{lv} 合成树编码后解析不一致,取消写入")
        blobs.append((dst_paths[lv - 1], enc))
        briefs[str(lv)] = _pf_brief_lines(base)
        log.append(f"  lv{lv}: {len(enc)}B,顶层 {len(blk)} 块,抑制帧="
                   f"{max(sup_vals) if sup_vals else '(沿用基底)'}")

    # ---- 可选:挂到角色队长技(instant 722,无条件常驻) ----
    ld = pl = None
    lk = ""
    leader_log: list[str] = []
    if str(character or "").strip():
        c = next((x for x in load_characters() if x["id"] == str(character)), None)
        if not c:
            raise ValueError(f"角色不存在: {character}")
        lk = (c.get("leader_id") or "").strip()
        ld = core.load_table(LEADER_LOGICAL, TARGET_STORE, SOURCE_STORE)
        pl = {k: core.read_csv_lines(t) for k, t in ld.text_rows().items()}
        if not lk or lk not in pl:
            raise ValueError(f"角色 {c['name']} 无队长技表键(character c17={lk!r}),无法挂 override")
        rows = pl[lk]
        exist_i = next((i for i, r in enumerate(rows) if len(r) > 45 and r[45] == "722"), None)
        if exist_i is not None:
            rows[exist_i][80] = new_id
            leader_log.append(f"队长技 {lk} 行{exist_i + 1} 已有 722 行 → 改指 {new_id}")
        else:
            tpl = None
            for rr in pl.values():
                tpl = next((_copy.deepcopy(r) for r in rr
                            if len(r) > 82 and r[45] == "722" and r[80]), None)
                if tpl:
                    break
            if tpl is None:
                raise ValueError("全表未找到官方 722 模板行,无法组装 override 行")
            tpl[0] = rows[0][0] if rows and rows[0] else tpl[0]
            tpl[4:9] = ["0", "", "", "", ""]      # 前置1-3 清空 = 无条件常驻
            tpl[11:16] = ["0", "", "", "", ""]
            tpl[18:23] = ["0", "", "", "", ""]
            tpl[80] = new_id                       # id;c81 levels='1,2,3'/c82 描述键沿用模板
            probs = _client_legality_problems("leader_ability", tpl)
            if probs:
                raise ValueError("override 行未过客户端合法性校验:\n"
                                 + "\n".join(f"  · {p}" for p in probs))
            rows.append(tpl)
            leader_log.append(f"队长技 {lk} 追加 722 行(无条件) → {new_id}, levels=1,2,3")
        leader_log.append("⚠ 生效条件:该角色需在队长位;PF 类型图标仍随 character c6")

    written = []
    if not dry_run:
        for dp, raw in blobs:
            fp = _dsl_store_path(dp)
            fp.parent.mkdir(parents=True, exist_ok=True)
            wf_dsl.save_dsl_file(fp, raw, ".bak-wfmod-pfmix-" + time.strftime("%Y%m%d-%H%M%S"))
            add_pending(fp)
            record_change(wf_dsl.dsl_logical(dp), f"PF 合成 {new_id}({len(raw)}B)", None)
            written.append(str(fp))
        parsed[new_id] = [list(dst_paths)]
        written.append(str(_write_with_backup(table, parsed, list(log))))
        if lk:
            written.append(str(_write_with_backup(ld, pl, list(leader_log))))
    return {"changes": (3 + 1 + (1 if lk else 0)),
            "log": "\n".join(log + leader_log), "written": "; ".join(written) or None,
            "dry_run": dry_run, "new_id": new_id, "paths": dst_paths,
            "leader_key": lk or None, "briefs": briefs,
            "note": "写入后「发布并重启游戏」生效;合成种类全局可复用,其他角色挂同 id 即同款"}


# ---------------------------------------------------------------- 共鸣通用属性(OmniElement)
# 逆向结论(2026-07-12,OrCharacterGroup/BattleCharacterLogic/SquadMemberSource):
#   词条里的角色组 token 解析顺序 = 元素名(Red…Colorless)→类型名→性别表→种族表→角色标签表;
#   元素组匹配 = 角色 element 单值列**严格等值**,数据层没有"全属性通配"。
#   角色自身的 character_tag(character 表 c5,逗号分隔列表)客户端不做表校验,
#   加未知 token 无害 → 方案:给角色 c5 加 "OmniElement" 标签作为**数据开关**,
#   配套**客户端补丁**(client-patch/omni-element 两处 matchCharacterGroup 的 Element 分支
#   追加 `|| characterTags.indexOf("OmniElement") != -1`)后,该角色匹配任意元素组:
#   共鸣计数/[限X属性]效果/编队 ribbon 全部生效。无补丁时标签无效果(安全)。

OMNI_TAG = "OmniElement"


def _char_tags(row: list[str]) -> list[str]:
    return [t for t in (row[5] if len(row) > 5 else "").split(",") if t]


def omni_element_status(character: str) -> dict:
    ct = core.load_table(core.CHARACTER_LOGICAL, TARGET_STORE, SOURCE_STORE)
    t = ct.text_rows().get(str(character))
    if t is None:
        raise ValueError(f"character 表中没有 {character}")
    row = core.read_csv_lines(t)[0]
    tags = _char_tags(row)
    return {"character": str(character), "enabled": OMNI_TAG in tags, "tags": tags,
            "note": "OmniElement=共鸣通用标签(character 表 c5)。需配合客户端补丁 "
                    "client-patch/omni-element 才生效;无补丁时无效果(无害)。"}


def omni_element_set(character: str, enable: bool, dry_run: bool) -> dict:
    ct = core.load_table(core.CHARACTER_LOGICAL, TARGET_STORE, SOURCE_STORE)
    parsed = {k: core.read_csv_lines(t) for k, t in ct.text_rows().items()}
    key = str(character)
    if key not in parsed or not parsed[key]:
        raise ValueError(f"character 表中没有 {key}")
    row = parsed[key][0]
    while len(row) <= 5:
        row.append("")
    tags = _char_tags(row)
    if enable == (OMNI_TAG in tags):
        return {"changes": 0, "log": f"{key} OmniElement 已{'开启' if enable else '关闭'},无需修改",
                "written": None, "dry_run": dry_run}
    tags = tags + [OMNI_TAG] if enable else [t for t in tags if t != OMNI_TAG]
    old = row[5]
    row[5] = ",".join(tags)
    log = [f"{key} character_tag(c5) {old!r} -> {row[5]!r}"
           f"({'加' if enable else '去'} OmniElement 共鸣通用标签)",
           "⚠ 生效前提:客户端已打 omni-element 补丁(client-patch/);发布后重启游戏"]
    written = None
    if not dry_run:
        written = str(_write_with_backup(ct, parsed, log))
    return {"changes": 1, "log": "\n".join(log), "written": written, "dry_run": dry_run}


_OMNI_EL_WORDS = ("火", "水", "雷", "风", "光", "暗")


def _omni_kit_audit(cid: str) -> list[str]:
    """转换预检:列出该角色词条/队长技里提到六色属性的行(属性配对清单)。
    逆向结论(docs/通用属性方案.md):这些配对**保留原样即最优**,无需改数据——
    共鸣/编成/[限X属性]类经 omni-element 补丁自身计入任意色,与同色队友协同不丢;
    「受X属性伤害减免」判攻击方元素、「对X属性敌人加伤」判敌方元素,均与自身元素无关。"""
    hits = []
    try:
        data = get_rows_for_character(cid)
    except Exception as e:
        return [f"⚠ 词条审计失败(不影响转换): {e}"]
    for r in data.get("abilities", []):
        label = ("队长技 " if r.get("leader") else "词条 ") + str(r.get("ability"))
        for i, d in enumerate(r.get("line_descs") or [], 1):
            if d and any(w + "属性" in d or w + "共鸣" in d or "限" + w in d
                         for w in _OMNI_EL_WORDS):
                hits.append(f"  {label} 行{i}: {d[:90]}")
    if not hits:
        return ["  (词条/队长技中未发现六色属性引用,转换零影响)"]
    if len(hits) > 15:
        hits = hits[:15] + [f"  …等共 {len(hits)} 条"]
    return hits


_MANA_TREE_TABLES = ("master/generated/mana_board.orderedmap",
                     "master/mana_board/mana_node.orderedmap")


def _remap_mana_for_clone(src_id: str, new_id: str) -> tuple[list[str], list[str]]:
    """克隆后玛纳板修复:②层两张三层树(角色→板→节点→CSV)中,新角色键下的节点
    multiplied_id 全部由 模板前缀(src_id×2) 重编号为 新前缀(new_id×2),含 mana_board
    的前置节点引用列;并给服务端 assets/mana_node.json 补新角色条目(键同步重编号)。
    ⚠ mana_node.json 是静态 import,补条目后须重启服务端才生效(不在热重载 9 json 内)。"""
    import re as _re
    import wf_quest_lib as ql
    old_pref, new_pref = str(int(src_id) * 2), str(int(new_id) * 2)
    token = _re.compile(r"^%s(\d{3})$" % _re.escape(old_pref))
    logs: list[str] = []
    written: list[str] = []

    def remap(node):
        if isinstance(node, dict):
            return {k: remap(v) for k, v in node.items()}
        s = node if isinstance(node, str) else node.decode("utf-8")
        rows = core.read_csv_lines(s)
        for r in rows:
            for i, c in enumerate(r):
                m = token.match(c)
                if m:
                    r[i] = new_pref + m.group(1)
        out = core.write_csv_lines(rows)
        return out if isinstance(node, str) else out.encode("utf-8")

    for lg in _MANA_TREE_TABLES:
        p = core.table_path(TARGET_STORE, lg)
        tree = ql.load_table(lg, p)
        if new_id not in tree:
            continue
        tree[new_id] = remap(tree[new_id])
        w = ql.save_table(lg, tree, p)
        add_pending(w)
        record_change(lg, f"玛纳板节点重编号 {old_pref}xxx->{new_pref}xxx({new_id},克隆自 {src_id})", None)
        written.append(str(w))
        logs.append(f"{lg.split('/')[-1]}: 节点前缀 {old_pref}->{new_pref}")
    # 服务端 assets/mana_node.json(learn_mana_node 校验/扣费读它)
    sp = _server_char_json_path().parent / "mana_node.json"
    try:
        server = json.loads(sp.read_text(encoding="utf-8"))
        if src_id in server and new_id not in server:
            server[new_id] = {board: {new_pref + nid[len(old_pref):]: dict(nd)
                                      for nid, nd in nodes.items()}
                              for board, nodes in server[src_id].items()}
            sbak = sp.with_name(sp.name + ".bak-wfmod-mana-" + time.strftime("%Y%m%d-%H%M%S"))
            if not sbak.exists():
                shutil.copy2(sp, sbak)
            sp.write_text(json.dumps(server, ensure_ascii=False, separators=(",", ":")),
                          encoding="utf-8")
            written.append(str(sp))
            logs.append(f"服务端 mana_node.json 已补 {new_id}(⚠ 静态 import,须重启服务端)")
    except Exception as exc:
        logs.append(f"⚠ 服务端 mana_node.json 同步失败(升级玛纳板会 400): {exc}")
    return logs, written


def omni_convert(character: str, dry_run: bool) -> dict:
    """一键「通用共鸣」= 只挂 OmniElement 标签(Form A),**不改 element**。

    ⚠ 2026-07-12 实测教训:element=6(Colorless)是**敌人/boss 专属**元素,给可玩角色
    写 6 会崩(客户端 C7050 等):Colorless 不能转成玩家 ElementKind(forceUncolorless
    硬抛),战斗连锁按 ElementKindValue.LENGTH=6 建数组、index 6 越界,且未打补丁的客户端
    ElementKindTools 6 个函数缺 case 6。**任何补丁都救不了 element=6 的可玩角色**。
    因此本按钮**只做安全的 Form A**:角色保留真实元素(伤害/克制/UI 都正常),
    加 OmniElement 标签后经 omni-element 客户端补丁计入**任意元素**的共鸣/编成/[限X属性]。
    这满足「能满足任意共鸣」,但不是「无属性」——引擎不支持可玩角色无属性。"""
    cid = str(character)
    logs = []
    r2 = omni_element_set(cid, True, dry_run)
    if r2.get("log"):
        logs.append(r2["log"])
    changes = r2.get("changes", 0)
    if not changes:
        logs.append(f"{cid} 已开启通用共鸣(OmniElement),无需修改")
    else:
        logs.append("⚠ 生效前提:客户端已打 omni-element 补丁(client-patch/,共鸣通配含副位);"
                    "②层改动发布后重启游戏。角色元素**未改**(仍按原属性打伤害/吃克制)")
    logs.append("—— 属性配对检查(该角色词条里的元素引用,均保留原样) ——")
    logs.extend(_omni_kit_audit(cid))
    logs.append("  说明:共鸣/编成/[限X属性]类→补丁后自身计入任意色,同色队友协同保留;"
                "角色自身伤害/克制按原元素不变。想要「无属性伤害」需 element=6,但那会崩("
                "Colorless 是敌人专属元素),不提供。")
    return {"changes": changes, "log": "\n".join(logs), "dry_run": dry_run,
            "note": "只改 c5 标签(安全);②层进待发布,发布后重启游戏生效"}


# ---------------------------------------------------------------- 新角色生态:动画/特效预览 + 资产模板 + 技能摘要
# 像素动画(flatomo FrameAnimation):sprite_sheet.png + atlas(帧矩形,pixelartNNNN/specialNNNN)
#   + timeline(sequences: name/kind(loop|once|pass)/begin..end)+ frame(画布原点/scale)。
#   序列帧号有空洞 = 沿用前一张有图的帧(hold-last)。
# 战斗特效(flatomo PartsAnimation):<目录>/<目录名>.png + 同名 atlas(帧名 .gen/<效果>/x)
#   + <效果>.parts(骨架:贴图/图层/12位定点矩阵)+ <效果>.timeline。完整骨架播放未复刻
#   (GraphicsSource 补间语义 1000+ 行),预览 = 贴图帧墙 + 时间线/音效元数据。

def _amf3_tree(logical: str):
    """store 里的 .amf3.deflate → 解压 + AMF3 解码,返回数据树;不存在返回 None。"""
    loc = wf_assets.locate(TARGET_STORE, logical)
    if not loc:
        return None
    try:
        return wf_dsl.parse_dsl(zlib.decompress(loc[1].read_bytes(), -15))["tree"]
    except Exception:
        return None


def _char_code(character: str) -> str:
    c = next((x for x in load_characters() if x["id"] == str(character)), None)
    if not c:
        raise ValueError(f"角色不存在: {character}")
    return c["code_name"]


# (像素动画预览已有完整实现:前端 loadPixPreview + 后端 get_pixelart_data,勿重复造)


def effect_previews(character: str) -> dict:
    """角色战斗特效预览:pathlist 扫 battle/** 含 /<code>/ 的 parts/timeline,
    按目录取 <目录名>.png+atlas 切帧墙;timeline 给序列/音效元数据。"""
    code = _char_code(character)
    tag = f"/{code}/"
    dirs: dict[str, set[str]] = {}
    plp = MOD_DIR / "WF_PATHLIST_recovered.txt"
    if plp.exists():
        with plp.open(encoding="utf-8", errors="replace") as f:
            for line in f:
                p = line.strip()
                if p.startswith("battle/") and tag in p and p.endswith(".parts.amf3.deflate"):
                    d, fn = p.rsplit("/", 1)
                    dirs.setdefault(d, set()).add(fn[:-len(".parts.amf3.deflate")])
    out = []
    for d, effects in sorted(dirs.items()):
        dname = d.rsplit("/", 1)[-1]
        sheet_lg = f"{d}/{dname}.png"
        has_sheet = bool(wf_assets.locate(TARGET_STORE, sheet_lg))
        atlas = _amf3_tree(f"{d}/{dname}.atlas.amf3.deflate") or []
        by_fx: dict[str, list] = {}
        for e in atlas:
            n = e.get("n", "")
            if "/.gen/" not in n:
                continue
            fx, frame = (n.split("/.gen/", 1)[1].split("/", 1) + [""])[:2]
            by_fx.setdefault(fx, []).append(
                {"frame": frame, "x": e["x"], "y": e["y"], "w": e["w"], "h": e["h"],
                 "r": bool(e.get("r")), "fx": e.get("fx", 0), "fy": e.get("fy", 0),
                 "fw": e.get("fw", e["w"]), "fh": e.get("fh", e["h"])})
        for name in sorted(effects):
            tl = _amf3_tree(f"{d}/{name}.timeline.amf3.deflate") or {}
            parts = _amf3_tree(f"{d}/{name}.parts.amf3.deflate") or {}
            out.append({
                "dir": d, "name": name,
                "sheet": sheet_lg if has_sheet else None,
                "frames": sorted(by_fx.get(name, []), key=lambda x: x["frame"]),
                "sequences": tl.get("sequences", []),
                "sounds": tl.get("sounds", []),
                "n_images": len(parts.get("i", [])), "n_layers": len(parts.get("g", [])),
            })
    return {"character": str(character), "code": code, "effects": out,
            "note": "帧墙=特效贴图按 atlas 切割;完整骨架动画(矩阵补间)在游戏内合成,此处不复刻"}


# ---- 资产模板(新角色必要资源检查;剧情类不计入必要) ----
_TPL_REQUIRED_KINDS = {"立绘", "技能cut-in", "图标合集", "像素图", "头像", "缩略图",
                       "战斗UI", "连锁cut-in"}
_TPL_STORY_KINDS = {"剧情横幅", "剧情表情"}


def asset_template_check(character: str) -> dict:
    """新角色资产模板完整度:必要项(缺=游戏内空白/崩溃风险)/建议项(语音等体验项)/
    剧情项(用户明确不管)。数据来自 char_asset_manifest + 配套数据探测。"""
    code = _char_code(character)
    manifest = wf_assets.char_asset_manifest(TARGET_STORE, code)
    groups: dict[str, dict] = {}
    for a in manifest:
        kind = a["kind"]
        if kind.startswith("语音"):
            cat = "语音(建议)"
        elif kind in _TPL_STORY_KINDS:
            cat = "剧情(不检查)"
        elif kind == "配套数据":
            cat = "配套数据(必要)"
        elif kind in _TPL_REQUIRED_KINDS:
            cat = f"{kind}(必要)"
        else:
            cat = kind
        g = groups.setdefault(cat, {"name": cat, "required": "必要" in cat,
                                    "items": [], "exists": 0, "total": 0})
        g["items"].append({"logical": a["logical"], "kind": kind, "exists": a["exists"],
                           "dims": a.get("dims"), "size": a["size"], "req": a.get("req", ""),
                           "text": a.get("text", "")})
        g["total"] += 1
        g["exists"] += 1 if a["exists"] else 0
    req_total = sum(g["total"] for g in groups.values() if g["required"])
    req_ok = sum(g["exists"] for g in groups.values() if g["required"])
    missing = [i["logical"] for g in groups.values() if g["required"]
               for i in g["items"] if not i["exists"]]
    return {"character": str(character), "code": code,
            "groups": sorted(groups.values(), key=lambda g: (not g["required"], g["name"])),
            "required_total": req_total, "required_exists": req_ok,
            "pct": round(req_ok * 100 / req_total) if req_total else 0,
            "missing_required": missing,
            "note": "必要=界面/战斗直接引用,缺失显示空白(不一定崩);建议=语音;"
                    "克隆(资产独立)会整套复制模板,替换后逐项生效"}


# ---- 技能效果摘要(DSL 命令树 → 可读分组) ----
_SUM_CATS = [
    ("伤害", ("CreateNormalAttack", "CreateFixedAttack", "CreateRatioAttack",
              "CreateOnlyHitAttack", "CreateShockWaveAttack", "CreateTargetAttack",
              "CreateWindAttack")),
    ("增益/状态", ("CreateCondition", "RemoveCondition")),
    ("治疗", ("Heal",)),
    ("召唤/生成", ("CreateBall", "CreateObstacle", "SummonUnit", "CreateField")),
    ("移动/球体", ("StopBall", "MoveBall", "ShootBall", "WarpBall", "AccelerateBall")),
]


def _sum_cat(name: str) -> str:
    for cat, names in _SUM_CATS:
        if name in names:
            return cat
    for cat, pref in (("伤害", "Attack"), ("召唤/生成", "Create"), ("演出", "Effect"),
                      ("演出", "Sound"), ("演出", "Camera"), ("演出", "Shake")):
        if pref in name:
            return cat
    return "其他"


def skill_effect_summary(character: str, level: str) -> dict:
    """技能效果预览:命令树按类别分组成中文摘要(伤害/增益/治疗/演出…)。"""
    import wf_dsl_sig as S
    pp = _skill_program_path(character, level)
    fp, data = wf_dsl.load_dsl_file(TARGET_STORE, pp)
    tree = json.loads(wf_dsl.dsl_to_json_text(data))
    cats: dict[str, list[str]] = {}
    counts: dict[str, int] = {}

    def walk(n):
        if isinstance(n, list):
            if len(n) >= 2 and n[0] in ("Command", "Event") and isinstance(n[1], list) \
                    and n[1] and isinstance(n[1][0], str):
                name = n[1][0]
                cat = _sum_cat(name)
                counts[cat] = counts.get(cat, 0) + 1
                b = S.brief_command(n[1])
                if b and len(cats.setdefault(cat, [])) < 40:
                    cats[cat].append(b)
            for x in n:
                walk(x)

    walk(tree)
    order = ["伤害", "增益/状态", "治疗", "召唤/生成", "移动/球体", "演出", "其他"]
    head = " / ".join(f"{c}×{counts[c]}" for c in order if counts.get(c))
    return {"character": str(character), "level": str(level), "program_path": pp,
            "headline": head or "(空)",
            "groups": [{"cat": c, "lines": cats.get(c, []), "count": counts.get(c, 0)}
                       for c in order if counts.get(c)],
            "note": "语义等价摘要(非游戏原文);倍率/帧数为 SLv1→满级 区间,60帧=1秒"}


# ---------------------------------------------------------------- 角色资产一键导出
# 打包该角色**全部**资产为 zip(逻辑路径目录树,PNG/MP3 解混淆为标准格式,数据文件原样):
#   1) 路径表里 character/<code>/**(立绘/图标/像素点阵/语音/story 差分/配套数据全量)
#   2) battle/** 里含 /<code>/ 的特效动画(skill_unique/powerflip/chain 等 parts+timeline)
#   3) 资产清单探测项(pathlist 外的语音/words 等) + cut-in ATF 配对
#   4) 该角色引用的全部技能/变体 DSL 文件
# 解码后的逻辑树与「资产包导入」一比一互通(改完可整包导回)。

def export_char_assets(character: str) -> tuple[Path, dict]:
    import zipfile
    c = next((x for x in load_characters() if x["id"] == str(character)), None)
    if not c:
        raise ValueError(f"角色不存在: {character}")
    code = c["code_name"]
    logicals: set[str] = set()
    pref = f"character/{code}/"
    tag = f"/{code}/"
    plp = MOD_DIR / "WF_PATHLIST_recovered.txt"
    if plp.exists():
        with plp.open(encoding="utf-8", errors="replace") as f:
            for line in f:
                p = line.strip()
                if p.startswith(pref) or (p.startswith("battle/") and tag in p):
                    logicals.add(p)
    for a in wf_assets.char_asset_manifest(TARGET_STORE, code):
        if a.get("exists"):
            logicals.add(a["logical"])
    for i in range(4):  # cut-in ATF 配对(android 根,pathlist 无)
        logicals.add(f"character/{code}/ui/skill_cutin_{i}.atf.deflate")
    dsl_pps = [pp for pp, owners in _all_program_paths().items()
               if any(o.split("·")[0] == code for o in owners)]
    # 该角色为 PF override 表键时(如 override_<code>),把对应 PF 动作也带上
    _t, pf_parsed = _pf_table()
    for k, rows in pf_parsed.items():
        if code in k and rows and rows[0]:
            dsl_pps += [p for p in rows[0][:3] if p and p != "(None)"]
    logicals.update(wf_dsl.dsl_logical(pp) for pp in dsl_pps)
    # DSL 里 SpecifyEffectDirectly 引用的特效动画:pathlist 复原率有限(这些路径常缺),
    # 直接从命令树提取路径并按 parts/timeline/atlas/png 后缀探测
    fx_paths: set[str] = set()

    def _walk_fx(n):
        if isinstance(n, list):
            if (len(n) >= 2 and n[0] == "SpecifyEffectDirectly"
                    and isinstance(n[1], str) and n[1]):
                fx_paths.add(n[1])
            for x in n:
                _walk_fx(x)
        elif isinstance(n, dict):
            for v in n.values():
                _walk_fx(v)

    for pp in dsl_pps:
        fp = _dsl_store_path(pp)
        if not fp.exists():
            continue
        try:
            _walk_fx(wf_dsl.parse_dsl(zlib.decompress(fp.read_bytes(), -15))["tree"])
        except Exception:
            continue
    for e in fx_paths:
        for suf in (".parts.amf3.deflate", ".timeline.amf3.deflate",
                    ".atlas.amf3.deflate", ".png"):
            logicals.add(e + suf)

    out_dir = WORK_DIR / "asset_exports"
    out_dir.mkdir(parents=True, exist_ok=True)
    zpath = out_dir / f"{code}-assets-{time.strftime('%Y%m%d-%H%M%S')}.zip"
    found = missing = 0
    by_root: dict[str, int] = {}
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for lg in sorted(logicals):
            loc = wf_assets.locate(TARGET_STORE, lg)
            if not loc:
                missing += 1
                continue
            data = loc[1].read_bytes()
            try:
                if lg.endswith(".png"):
                    data = wf_assets.png_decode(data)
                elif lg.endswith(".mp3"):
                    data = wf_assets.mp3_decode(data)
            except Exception:
                pass  # 解码失败按原样导出,不中断整包
            z.writestr(lg, data)
            found += 1
            by_root[loc[0]] = by_root.get(loc[0], 0) + 1
        info = {"character": str(character), "name": c["name"], "code_name": code,
                "files": found, "missing_candidates": missing, "by_root": by_root,
                "note": "逻辑路径目录树;PNG/MP3 已解混淆为标准格式,其余原样存储态。"
                        "改完可用 GUI「资产包导入」一比一导回。"}
        z.writestr("_export_info.json", json.dumps(info, ensure_ascii=False, indent=1))
    return zpath, info


# ---------------------------------------------------------------- 单角色快照/还原 + 克隆
# 快照 = 一个 zip:②层全部表行(平表存解码文本/嵌套表存外层原样字节) + ①层两 json 条目
#        + 全部资产文件(存储态原样) + 技能 DSL 文件。还原 = 逐项写回(自动备份+进待发布)。

SNAP_DIR = WORK_DIR / "char_snapshots"
CHAR_TEXT2_LOGICAL = "master/character/character_text.orderedmap"
# 新角色额外要复制的按 character_id 索引的外围表(标准 orderedmap,已验证 111001 为键)。
# 缺这些客户端会在 box/详情/技能预览/玛纳板 崩溃。generated/character_image 与
# generated/mana_board 用别的格式(现读取器读不了),是完整新角色的已知硬缺口(见方案文档)。
CLONE_EXTRA_TABLES = [
    "master/character/character_speech.orderedmap",
    "master/skill_preview/skill_preview_character.orderedmap",
    "master/mana_board/mana_board2_open_condition.orderedmap",
    "master/mana_board/upskill.orderedmap",
    "master/stance_detail/character_stance_detail.orderedmap",
]
# 嵌套表(外层键=character_id,行=原样内层 orderedmap 字节):克隆=原样复制外层行,
# 不解内层(和 character_status 同法)。character_image=立绘定位、mana_board/mana_node=
# 玛纳板、full_shot_image_attribute=立绘属性、character_gacha_sound=抽卡音效。
CLONE_NESTED_TABLES = [
    "master/generated/character_image.orderedmap",
    "master/character/full_shot_image_attribute.orderedmap",
    "master/generated/mana_board.orderedmap",
    "master/mana_board/mana_node.orderedmap",
    "master/character/character_gacha_sound.orderedmap",
]


def _load_nested(logical: str) -> core.OrderedMap:
    return core.read_orderedmap_file_raw_rows(core.table_path(TARGET_STORE, logical), logical)


def _write_nested(om: core.OrderedMap, logical: str, tag: str) -> str:
    """嵌套表写盘(外层原样字节)+ 备份 + pending + 改动日志。"""
    p = core.table_path(TARGET_STORE, logical)
    suffix = ".bak-wfmod-nested-" + time.strftime("%Y%m%d-%H%M%S")
    if p.exists():
        bak = p.with_name(p.name + suffix)
        if not bak.exists():
            shutil.copy2(p, bak)
    p.write_bytes(core.build_orderedmap_raw_rows(om))
    add_pending(p)
    record_change(logical, tag, p.with_name(p.name + suffix))
    return str(p)


def _char_row(cid: str) -> list[str]:
    ct = core.load_table(core.CHARACTER_LOGICAL, TARGET_STORE, SOURCE_STORE)
    t = ct.text_rows().get(str(cid))
    if t is None:
        raise ValueError(f"② character 表中没有角色 {cid}")
    return core.normalize_row_length(core.read_csv_lines(t)[0], 37)


def _char_flat_parts(cid: str, row: list[str]) -> list[tuple[str, str, list[str]]]:
    abilities = [v for v in row[19:25] if v and v != "(None)"]
    # leader_ability 键 = character_id 列(白等老行 键≠该列)
    lid = row[17] if row[17] not in ("", "(None)") else cid
    return [
        (core.CHARACTER_LOGICAL, "character", [cid]),
        (CHAR_TEXT2_LOGICAL, "character_text", [cid]),
        (core.ABILITY_LOGICAL, "ability", abilities),
        (LEADER_LOGICAL, "leader_ability", [lid]),
        (AWAKE_LOGICAL, "character_awake_status", [cid]),
    ]


def char_snapshot(cid: str, note: str = "") -> dict:
    import zipfile as _zf
    cid = str(cid)
    row = _char_row(cid)
    code = row[0]
    skey = row[8] or code
    SNAP_DIR.mkdir(parents=True, exist_ok=True)
    ts = time.strftime("%Y%m%d-%H%M%S")
    zpath = SNAP_DIR / f"{cid}-{ts}.zip"
    meta = {"id": cid, "code_name": code, "ts": ts, "note": note,
            "tables": {}, "raw": {}, "assets": []}
    with _zf.ZipFile(zpath, "w", _zf.ZIP_DEFLATED) as z:
        for logical, alias, keys in _char_flat_parts(cid, row):
            try:
                tr = core.load_table(logical, TARGET_STORE, SOURCE_STORE).text_rows()
            except Exception:
                continue
            got = [k for k in keys if k in tr]
            for k in got:
                z.writestr(f"tables/{alias}/{k}", tr[k])
            if got:
                meta["tables"][alias] = {"logical": logical, "keys": got}
        try:
            st = core.load_status_table(TARGET_STORE, SOURCE_STORE)
            if cid in st.keys:
                z.writestr(f"raw/character_status/{cid}", bytes(st.rows[st.keys.index(cid)]))
                meta["raw"]["character_status"] = [cid]
        except Exception:
            pass
        dsl_logicals = []
        try:
            ak = core.load_action_skill_table(TARGET_STORE, SOURCE_STORE)
            if skey in ak.keys:
                blob = bytes(ak.rows[ak.keys.index(skey)])
                z.writestr(f"raw/action_skill/{skey}", blob)
                meta["raw"]["action_skill"] = [skey]
                for lv, f in core.decode_action_skill_row(blob):
                    pp = f[core.ACTION_SKILL_COLUMNS["program_path"]] if len(f) > 7 else ""
                    if pp and pp != "(None)":
                        dsl_logicals.append(wf_dsl.dsl_logical(pp))
        except Exception:
            pass
        mp, tp = _char_json_paths()
        master = json.loads(mp.read_text(encoding="utf-8"))
        text = json.loads(tp.read_text(encoding="utf-8"))
        z.writestr("layer1.json", json.dumps(
            {"master": master.get(cid), "text": text.get(cid)}, ensure_ascii=False))
        logicals = [a["logical"] for a in wf_assets.char_asset_manifest(TARGET_STORE, code)
                    if a["exists"]] + dsl_logicals
        for lg in logicals:
            loc = wf_assets.locate(TARGET_STORE, lg)
            if not loc:
                continue
            root_name, fp = loc
            z.writestr(f"assets/{root_name}/{fp.parent.name}/{fp.name}", fp.read_bytes())
            meta["assets"].append({"logical": lg, "root": root_name,
                                   "rel": f"{fp.parent.name}/{fp.name}"})
        z.writestr("meta.json", json.dumps(meta, ensure_ascii=False, indent=1))
    return {"file": zpath.name, "size": zpath.stat().st_size,
            "tables": {k: len(v["keys"]) for k, v in meta["tables"].items()},
            "raw": {k: len(v) for k, v in meta["raw"].items()},
            "assets": len(meta["assets"]),
            "note": "快照 = ②层表行 + ①层条目 + 全部资产 + 技能DSL,一键还原用同名文件"}


def list_char_snapshots(cid: str = "") -> list[dict]:
    import zipfile as _zf
    out = []
    if SNAP_DIR.exists():
        for p in sorted(SNAP_DIR.glob("*.zip"), reverse=True):
            try:
                meta = json.loads(_zf.ZipFile(p).read("meta.json"))
            except Exception:
                continue
            if cid and meta.get("id") != str(cid):
                continue
            out.append({"file": p.name, "id": meta.get("id"), "code_name": meta.get("code_name"),
                        "ts": meta.get("ts"), "note": meta.get("note", ""),
                        "size": p.stat().st_size, "assets": len(meta.get("assets", []))})
    return out


def char_restore(fname: str, dry_run: bool) -> dict:
    import zipfile as _zf
    p = SNAP_DIR / Path(fname).name
    if not p.exists():
        raise ValueError(f"快照不存在: {fname}")
    z = _zf.ZipFile(p)
    meta = json.loads(z.read("meta.json"))
    cid = meta["id"]
    log = [f"还原角色 {cid}({meta.get('code_name')}) 快照 {meta.get('ts')}"]
    written = []
    for alias, info in meta.get("tables", {}).items():
        table = core.load_table(info["logical"], TARGET_STORE, SOURCE_STORE)
        cur = table.text_rows()
        parsed = {k: core.read_csv_lines(t) for k, t in cur.items()}
        changed = 0
        for k in info["keys"]:
            snap_text = z.read(f"tables/{alias}/{k}").decode("utf-8")
            if cur.get(k) != snap_text:
                parsed[k] = core.read_csv_lines(snap_text)
                changed += 1
        if changed:
            log.append(f"{alias}: 还原 {changed} 键")
            if not dry_run:
                written.append(str(_write_with_backup(table, parsed,
                                                      [f"角色快照还原 {alias}({cid})"])))
    for k in meta.get("raw", {}).get("character_status", []):
        st = core.load_status_table(TARGET_STORE, SOURCE_STORE)
        snap = z.read(f"raw/character_status/{k}")
        if k in st.keys and bytes(st.rows[st.keys.index(k)]) != snap:
            log.append(f"character_status: 还原 {k}")
            if not dry_run:
                st.rows[st.keys.index(k)] = snap
                suffix = ".bak-wfmod-status-" + time.strftime("%Y%m%d-%H%M%S")
                buf = io.StringIO()
                with redirect_stdout(buf):
                    w = core.write_status_table(st, TARGET_STORE, suffix)
                add_pending(w)
                record_change(core.STATUS_LOGICAL, f"角色快照还原 character_status {k}",
                              w.with_name(w.name + suffix))
                written.append(str(w))
    for k in meta.get("raw", {}).get("action_skill", []):
        ak = core.load_action_skill_table(TARGET_STORE, SOURCE_STORE)
        snap = z.read(f"raw/action_skill/{k}")
        if k in ak.keys and bytes(ak.rows[ak.keys.index(k)]) != snap:
            log.append(f"action_skill: 还原 {k}")
            if not dry_run:
                ak.rows[ak.keys.index(k)] = snap
                written.append(_write_action_skill(ak, [f"角色快照还原 action_skill {k}"]))
    l1 = json.loads(z.read("layer1.json"))
    mp, tp = _char_json_paths()
    master = json.loads(mp.read_text(encoding="utf-8"))
    text = json.loads(tp.read_text(encoding="utf-8"))
    if master.get(cid) != l1.get("master") or text.get(cid) != l1.get("text"):
        log.append("①层 character/character_text.json: 条目还原(重启服务端生效)")
        if not dry_run:
            global _char_cache
            suffix = ".bak-charfields-" + time.strftime("%Y%m%d-%H%M%S")
            for f in (mp, tp):
                shutil.copy2(f, f.with_name(f.name + suffix))
            if l1.get("master") is not None:
                master[cid] = l1["master"]
            if l1.get("text") is not None:
                text[cid] = l1["text"]
            mp.write_text(json.dumps(master, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            tp.write_text(json.dumps(text, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            _char_cache = None
            written.append(str(mp))
    n_assets = 0
    for a in meta.get("assets", []):
        snap = z.read(f"assets/{a['root']}/{a['rel']}")
        fp = wf_assets.roots(TARGET_STORE)[a["root"]] / a["rel"]
        if fp.exists() and fp.read_bytes() == snap:
            continue
        n_assets += 1
        if not dry_run:
            if fp.exists():
                bak = fp.with_name(fp.name + ".bak-wfmod-asset-" + time.strftime("%Y%m%d-%H%M%S"))
                if not bak.exists():
                    shutil.copy2(fp, bak)
            fp.parent.mkdir(parents=True, exist_ok=True)
            fp.write_bytes(snap)
            add_pending(fp)
    if n_assets:
        log.append(f"资产: 还原 {n_assets} 个文件")
        if not dry_run:
            record_change("char_assets", f"角色快照还原 {cid} 资产 {n_assets} 个", None)
    changes = len(log) - 1
    return {"changes": changes, "log": "\n".join(log),
            "written": "; ".join(written) or None, "dry_run": dry_run,
            "note": "②层+资产进待发布(点发布进游戏);①层改动需重启服务端"}


def clone_character(src_id: str, new_id: str, new_name: str, dry_run: bool,
                    new_code: str = "") -> dict:
    """克隆整套数据为新角色(全新角色·金丝雀)。词条 6 键复制为 <new_id>1..6 独立可改。
    new_code 为空:code_name/技能/资产共用来源(改技能会互相影响,零拷贝);
    new_code 非空:**资产独立** —— 新 code_name,action_skill 原样字节复制为新键,
    模板的立绘/图标/像素/语音/配套数据全套复制到新 code 路径(之后可独立换皮)。
    获得途径:服务端 admin 后台/邮件把 new_id 发进存档。客户端容错未验证,先单个实验。"""
    import copy as _copy
    import re as _re
    src_id, new_id = str(src_id), str(new_id)
    new_code = str(new_code or "").strip()
    if not (new_id.isdigit() and 4 <= len(new_id) <= 8):
        raise ValueError("新角色 ID 必须是 4-8 位纯数字(建议 6 位,如 119999)")
    if new_code and not _re.fullmatch(r"[a-z][a-z0-9_]{2,40}", new_code):
        raise ValueError("新 code_name 须为小写字母开头的 [a-z0-9_](3-41 位)")
    row = _char_row(src_id)
    src_code = row[0]
    ct = core.load_table(core.CHARACTER_LOGICAL, TARGET_STORE, SOURCE_STORE)
    if new_id in ct.text_rows():
        raise ValueError(f"② character 表已存在 ID {new_id}")
    if new_code:
        used_codes = {core.read_csv_lines(t)[0][0] for t in ct.text_rows().values()}
        if new_code in used_codes:
            raise ValueError(f"code_name 已被占用: {new_code}")
    mp, tp = _char_json_paths()
    master = json.loads(mp.read_text(encoding="utf-8"))
    text = json.loads(tp.read_text(encoding="utf-8"))
    if new_id in master:
        raise ValueError(f"①层 character.json 已存在 {new_id}")
    new_abilities = [f"{new_id}{n}" for n in range(1, 7)]
    ab = core.load_table(core.ABILITY_LOGICAL, TARGET_STORE, SOURCE_STORE)
    ab_rows = ab.text_rows()
    for aid in new_abilities:
        if aid in ab_rows:
            raise ValueError(f"词条键已存在: {aid}")
    src_abilities = row[19:25]
    asset_logicals = wf_assets.all_asset_logicals(TARGET_STORE, src_code) if new_code else []
    log = [f"克隆 {src_id}({src_code}) -> 新角色 {new_id}" + (f"「{new_name}」" if new_name else ""),
           f"新词条键 {new_abilities[0]}..{new_abilities[-1]}(独立可改)"]
    if new_code:
        log.append(f"资产独立:code_name={new_code},复制 {len(asset_logicals)} 个资产文件 + action_skill 新键")
    else:
        log.append("code_name/技能/资产共用来源(改技能会互相影响)")
    log.append("获得途径:发布 + 重启服务端后,用 admin 后台/邮件把该 ID 发进存档;先金丝雀验证客户端不崩")
    written = []
    if not dry_run:
        # ② character:整行复制,改 id/词条引用(/code_name)
        new_row = list(row)
        new_row[17] = new_id
        new_row[27] = new_id
        for i, aid in enumerate(new_abilities):
            new_row[19 + i] = aid
        if new_code:
            new_row[0] = new_code
            new_row[8] = new_code
        parsed = {k: core.read_csv_lines(t) for k, t in ct.text_rows().items()}
        parsed[new_id] = [new_row]
        written.append(str(_write_with_backup(ct, parsed, [f"新增角色 {new_id}(克隆自 {src_id})"])))
        # ability ×6
        parsed_a = {k: core.read_csv_lines(t) for k, t in ab_rows.items()}
        n_ab = 0
        for old, new in zip(src_abilities, new_abilities):
            if old in parsed_a:
                parsed_a[new] = [list(r) for r in parsed_a[old]]
                n_ab += 1
        written.append(str(_write_with_backup(ab, parsed_a, [f"新增词条 {n_ab} 键(克隆自 {src_id})"])))
        # leader_ability(来源键 = character_id 列;白等老行 键≠该列)
        src_lid = row[17] if row[17] not in ("", "(None)") else src_id
        ld = core.load_table(LEADER_LOGICAL, TARGET_STORE, SOURCE_STORE)
        pl = {k: core.read_csv_lines(t) for k, t in ld.text_rows().items()}
        if src_lid in pl:
            pl[new_id] = [list(r) for r in pl[src_lid]]
            written.append(str(_write_with_backup(ld, pl, [f"新增队长技 {new_id}(克隆自 {src_id})"])))
        # ② character_text
        try:
            t2 = core.load_table(CHAR_TEXT2_LOGICAL, TARGET_STORE, SOURCE_STORE)
            p2 = {k: core.read_csv_lines(t) for k, t in t2.text_rows().items()}
            if src_id in p2:
                p2[new_id] = [list(r) for r in p2[src_id]]
                if new_name and p2[new_id] and p2[new_id][0]:
                    p2[new_id][0][0] = _skill_text_clean(new_name)
                written.append(str(_write_with_backup(t2, p2, [f"新增角色文本 {new_id}"])))
        except Exception as exc:
            log.append(f"② character_text 跳过: {exc}")
        # 其它按 character_id 索引的外围表(客户端 box/详情/技能预览会查,缺则崩)。
        # 整键复制来源行;词条 ID 相关的表(upskill 引用 ability 键)需替换引用。
        for logical in CLONE_EXTRA_TABLES:
            try:
                et = core.load_table(logical, TARGET_STORE, SOURCE_STORE)
                ep = {k: core.read_csv_lines(t) for k, t in et.text_rows().items()}
                if src_id not in ep:
                    continue
                new_rows = [list(r) for r in ep[src_id]]
                for r in new_rows:  # 行内出现的来源 id/词条键 → 新的(保持自引用一致)
                    for i, v in enumerate(r):
                        if v == src_id:
                            r[i] = new_id
                        elif v in src_abilities:
                            r[i] = new_abilities[list(src_abilities).index(v)]
                ep[new_id] = new_rows
                written.append(str(_write_with_backup(et, ep,
                               [f"新增 {_LOGICAL_ALIAS.get(logical, logical)} {new_id}"])))
            except Exception as exc:
                log.append(f"{logical.split('/')[-1]} 跳过: {exc}")
        # 其它嵌套表(立绘定位/玛纳板/立绘属性/抽卡音效):外层原样字节复制
        for logical in CLONE_NESTED_TABLES:
            try:
                om = _load_nested(logical)
            except Exception as exc:
                log.append(f"{logical.split('/')[-1]} 跳过: {exc}")
                continue
            if src_id in om.keys and new_id not in om.keys:
                om.keys.append(new_id)
                om.rows.append(bytes(om.rows[om.keys.index(src_id)]))
                written.append(_write_nested(om, logical, f"新增 {logical.split('/')[-1]} {new_id}"))
        # 玛纳板节点重编号(2026-07-13 金丝雀 H400 教训):节点 multiplied_id 前缀=角色ID×2,
        # 客户端由节点 ID 反推角色 ID——原样字节复制会让新角色的板指回模板,
        # learn_mana_node 发成模板 ID → 服务端 400(游戏内 H400 弹回登录)。
        try:
            mlog, mwritten = _remap_mana_for_clone(src_id, new_id)
            log.extend(mlog)
            written.extend(mwritten)
        except Exception as exc:
            log.append(f"⚠ 玛纳板重编号失败(升级玛纳板会 H400,需手工修): {exc}")
        # character_status(嵌套,外层原样字节追加)
        st = core.load_status_table(TARGET_STORE, SOURCE_STORE)
        if src_id in st.keys and new_id not in st.keys:
            blob = bytes(st.rows[st.keys.index(src_id)])
            st.keys.append(new_id)
            st.rows.append(blob)
            suffix = ".bak-wfmod-status-" + time.strftime("%Y%m%d-%H%M%S")
            buf = io.StringIO()
            with redirect_stdout(buf):
                w = core.write_status_table(st, TARGET_STORE, suffix)
            add_pending(w)
            record_change(core.STATUS_LOGICAL, f"新增 character_status {new_id}(克隆自 {src_id})",
                          w.with_name(w.name + suffix))
            written.append(str(w))
        # awake(有觉醒板才有)
        aw = core.load_table(AWAKE_LOGICAL, TARGET_STORE, SOURCE_STORE)
        pw = {k: core.read_csv_lines(t) for k, t in aw.text_rows().items()}
        if src_id in pw:
            pw[new_id] = [list(r) for r in pw[src_id]]
            written.append(str(_write_with_backup(aw, pw, [f"新增觉醒加成 {new_id}"])))
        if new_code:
            # action_skill:来源外层行原样字节复制为新键(技能独立,互不影响)
            ak = core.load_action_skill_table(TARGET_STORE, SOURCE_STORE)
            skey = row[8] or src_code
            if skey in ak.keys and new_code not in ak.keys:
                blob = bytes(ak.rows[ak.keys.index(skey)])
                ak.keys.append(new_code)
                ak.rows.append(blob)
                written.append(_write_action_skill(ak, [f"新增 action_skill {new_code}(克隆自 {skey})"]))
            # 资产全套复制到新 code 路径(同根,新哈希文件,进待发布)
            n_copied = 0
            for lg in asset_logicals:
                loc = wf_assets.locate(TARGET_STORE, lg)
                if not loc:
                    continue
                root_name, fp = loc
                new_lg = lg.replace(f"character/{src_code}/", f"character/{new_code}/", 1)
                nfp = wf_assets.path_in_root(TARGET_STORE, root_name, new_lg)
                nfp.parent.mkdir(parents=True, exist_ok=True)
                nfp.write_bytes(fp.read_bytes())
                add_pending(nfp)
                n_copied += 1
            record_change("char_assets", f"克隆资产 {src_code}->{new_code} 共 {n_copied} 个", None)
            log.append(f"已复制资产 {n_copied} 个到 character/{new_code}/*")
        # ① 层两 json
        global _char_cache
        master[new_id] = _copy.deepcopy(master[src_id])
        m0 = master[new_id][0]
        m0[17] = new_id
        m0[27] = new_id
        for i, aid in enumerate(new_abilities):
            m0[19 + i] = aid
        if new_code:
            m0[0] = new_code
            m0[8] = new_code
        text[new_id] = _copy.deepcopy(text.get(src_id) or [[""]])
        if new_name and text[new_id] and text[new_id][0]:
            text[new_id][0][0] = new_name
        suffix = ".bak-charfields-" + time.strftime("%Y%m%d-%H%M%S")
        for f in (mp, tp):
            shutil.copy2(f, f.with_name(f.name + suffix))
        mp.write_text(json.dumps(master, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        tp.write_text(json.dumps(text, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        _char_cache = None
        written.append(str(mp))
        # 服务端简化表 assets/character.json:补条目(邮件发放校验/升级经验上限读它,缺=发不进存档)
        sp = _server_char_json_path()
        try:
            server = json.loads(sp.read_text(encoding="utf-8"))
            src_ent = server.get(src_id) or {}
            server[new_id] = {"name": new_name or src_ent.get("name", ""),
                              "rarity": int(row[2] or 0), "element": int(row[3] or 0),
                              "skill_count": src_ent.get("skill_count", 6)}
            sbak = sp.with_name(sp.name + suffix)
            if not sbak.exists():
                shutil.copy2(sp, sbak)
            sp.write_text(json.dumps(server, ensure_ascii=False, indent=2), encoding="utf-8")
            written.append(str(sp))
            log.append(f"服务端简化表已补条目 {new_id}(重启服务端或「推送服务端」生效)")
        except Exception as exc:
            log.append(f"⚠ 服务端 character.json 同步失败(admin/邮件发放会被校验拒绝): {exc}")
        # 写入后校验:确认 ②层新键真的落盘(防历史 set_text_rows 静默丢键的坑复发)
        verify = core.load_table(core.CHARACTER_LOGICAL, TARGET_STORE, None)
        va = core.load_table(core.ABILITY_LOGICAL, TARGET_STORE, None)
        miss = []
        if new_id not in verify.text_rows():
            miss.append(f"② character 缺 {new_id}")
        for aid in new_abilities:
            if aid not in va.text_rows():
                miss.append(f"② ability 缺 {aid}")
                break
        for logical in CLONE_NESTED_TABLES:  # 立绘/玛纳板等嵌套表也校验
            try:
                if new_id not in _load_nested(logical).keys:
                    miss.append(f"{logical.split('/')[-1]} 缺 {new_id}")
            except Exception:
                pass
        if miss:
            raise RuntimeError("克隆写入校验失败(数据不一致,勿发布!): " + "; ".join(miss))
        log.append(f"已写入并校验 {len(CLONE_EXTRA_TABLES) + len(CLONE_NESTED_TABLES) + 6} 张按角色索引的表")
    return {"changes": 1, "log": "\n".join(log),
            "written": "; ".join(written) or None, "dry_run": dry_run,
            "note": "⚠ 坏档风险:全新 ID 角色曾导致客户端反复闪退/存档损坏,发放前先备份存档,"
                    "金丝雀验证不过立即删除角色并从存档移除。"
                    "写入后:点「发布并重启游戏」推 ②层 → 重启服务端推 ①层 → admin 发放角色 → 进游戏金丝雀验证"}


def delete_character(cid: str, dry_run: bool) -> dict:
    """整键删除一个(克隆出来的)角色:②层全部表 + ①层两 json。用于回滚失败的金丝雀。
    只允许删非原始角色(保护:cid 必须此前由克隆产生,即词条键=<cid>1..6 存在或 ①有而②残缺)。"""
    cid = str(cid)
    new_abilities = [f"{cid}{n}" for n in range(1, 7)]
    log = [f"删除角色 {cid}(②层全表 + ①层)"]
    written = []
    # ② 平表:character / ability×6 / leader / character_text / awake / 外围 id 表
    flat = [(core.CHARACTER_LOGICAL, [cid]),
            (core.ABILITY_LOGICAL, new_abilities),
            (LEADER_LOGICAL, [cid]),
            (CHAR_TEXT2_LOGICAL, [cid]),
            (AWAKE_LOGICAL, [cid])] + [(lg, [cid]) for lg in CLONE_EXTRA_TABLES]
    for logical, keys in flat:
        table = core.load_table(logical, TARGET_STORE, SOURCE_STORE)
        present = [k for k in keys if k in table.text_rows()]
        if present:
            log.append(f"{_LOGICAL_ALIAS.get(logical, logical)}: 删 {present}")
            if not dry_run:
                table.delete_keys(set(present))
                suffix = ".bak-wfmod-delchar-" + time.strftime("%Y%m%d-%H%M%S")
                buf = io.StringIO()
                with redirect_stdout(buf):
                    w = core.write_table(table, TARGET_STORE, suffix, no_backup=False)
                add_pending(w)
                record_change(logical, f"删除角色 {cid}: {present}", w.with_name(w.name + suffix))
                written.append(str(w))
    # ② 嵌套表(立绘/玛纳板/立绘属性/抽卡音效):整键删除
    for logical in CLONE_NESTED_TABLES:
        try:
            om = _load_nested(logical)
        except Exception:
            continue
        if cid in om.keys:
            log.append(f"{logical.split('/')[-1]}: 删 {cid}")
            if not dry_run:
                om.delete_keys({cid})
                written.append(_write_nested(om, logical, f"删除角色 {cid}: {logical.split('/')[-1]}"))
    # ② 嵌套:character_status / action_skill(键=code_name,慎删——可能与来源共用)
    st = core.load_status_table(TARGET_STORE, SOURCE_STORE)
    if cid in st.keys:
        log.append(f"character_status: 删 {cid}")
        if not dry_run:
            i = st.keys.index(cid)
            del st.keys[i]
            del st.rows[i]
            suffix = ".bak-wfmod-status-" + time.strftime("%Y%m%d-%H%M%S")
            buf = io.StringIO()
            with redirect_stdout(buf):
                w = core.write_status_table(st, TARGET_STORE, suffix)
            add_pending(w)
            record_change(core.STATUS_LOGICAL, f"删除 character_status {cid}",
                          w.with_name(w.name + suffix))
            written.append(str(w))
    # ① 两 json
    mp, tp = _char_json_paths()
    master = json.loads(mp.read_text(encoding="utf-8"))
    text = json.loads(tp.read_text(encoding="utf-8"))
    if cid in master or cid in text:
        log.append("①层 character/character_text.json: 删条目(重启服务端生效)")
        if not dry_run:
            global _char_cache
            suffix = ".bak-charfields-" + time.strftime("%Y%m%d-%H%M%S")
            for f in (mp, tp):
                shutil.copy2(f, f.with_name(f.name + suffix))
            master.pop(cid, None)
            text.pop(cid, None)
            mp.write_text(json.dumps(master, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            tp.write_text(json.dumps(text, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            _char_cache = None
            written.append(str(mp))
    # 服务端简化表 assets/character.json:删条目(与克隆时的补条目对应)
    sp = _server_char_json_path()
    try:
        server = json.loads(sp.read_text(encoding="utf-8"))
    except Exception:
        server = None
    if server is not None and cid in server:
        log.append("服务端 character.json: 删条目(重启服务端生效)")
        if not dry_run:
            sbak = sp.with_name(sp.name + ".bak-charfields-" + time.strftime("%Y%m%d-%H%M%S"))
            if not sbak.exists():
                shutil.copy2(sp, sbak)
            server.pop(cid, None)
            sp.write_text(json.dumps(server, ensure_ascii=False, indent=2), encoding="utf-8")
            written.append(str(sp))
    # 服务端 mana_node.json:删条目(与克隆时的玛纳板补条目对应)
    mnp = _server_char_json_path().parent / "mana_node.json"
    try:
        mserver = json.loads(mnp.read_text(encoding="utf-8"))
    except Exception:
        mserver = None
    if mserver is not None and cid in mserver:
        log.append("服务端 mana_node.json: 删条目(重启服务端生效)")
        if not dry_run:
            mbak = mnp.with_name(mnp.name + ".bak-wfmod-mana-" + time.strftime("%Y%m%d-%H%M%S"))
            if not mbak.exists():
                shutil.copy2(mnp, mbak)
            mserver.pop(cid, None)
            mnp.write_text(json.dumps(mserver, ensure_ascii=False, separators=(",", ":")),
                           encoding="utf-8")
            written.append(str(mnp))
    return {"changes": len(log) - 1, "log": "\n".join(log),
            "written": "; ".join(written) or None, "dry_run": dry_run,
            "note": "回滚完成:发布推 ②层 + 重启服务端推 ①层;若已 admin 发放该角色,也去存档里移除避免残留引用"}


# ---------------------------------------------------------------- backups


def tracked_tables() -> list[tuple[str, Path]]:
    """回溯覆盖全部 ② 层表(含直接脚本改过的),别名 -> 表文件路径。"""
    return [(alias, core.table_path(TARGET_STORE, logical))
            for logical, alias in _LOGICAL_ALIAS.items()]


def list_backups() -> list[dict]:
    out = []
    for label, table in tracked_tables():
        if not table.parent.exists():
            continue
        for p in sorted(table.parent.glob(table.name + ".bak*")):
            st = p.stat()
            out.append({
                "table": label,
                "name": p.name,
                "size": st.st_size,
                "mtime": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(st.st_mtime)),
            })
    out.sort(key=lambda b: b["mtime"], reverse=True)
    return out


def restore_backup(name: str) -> dict:
    for label, table in tracked_tables():
        cand = table.parent / name
        if cand.exists() and cand.name.startswith(table.name + ".bak"):
            # 回溯前先给"当前状态"存一份 pre-rollback 备份,回溯本身也可再回溯
            pre = table.with_name(table.name + ".bak-prerollback-" + time.strftime("%Y%m%d-%H%M%S"))
            if table.exists() and not pre.exists():
                shutil.copy2(table, pre)
            shutil.copy2(cand, table)
            add_pending(table)
            logical = next((lg for lg, al in _LOGICAL_ALIAS.items() if al == label), label)
            record_change(logical, f"回溯 {label} -> 还原备份 {name}", pre)
            return {"restored": name, "table": label, "target": str(table),
                    "note": "已还原并加入待发布;运行 wf_publish.py 让客户端拉回改动"}
    raise ValueError(f"未找到备份: {name}")


def _remove_pending_tables(tables: str) -> None:
    """发布成功后把已发布的表从 pending 列表移除(pending 存 'xx/hash' 相对路径)。"""
    alias_to_logical = {al: lg for lg, al in _LOGICAL_ALIAS.items()}
    rels = set()
    for t in tables.split(","):
        logical = alias_to_logical.get(t.strip(), t.strip())
        try:
            digest = core.sha1_path(logical)
        except Exception:
            continue
        rels.add(f"{digest[:2]}/{digest[2:]}")
    items = [r for r in read_pending() if r not in rels]
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    PENDING_FILE.write_text(json.dumps(items, indent=2), encoding="utf-8")


def run_publish(tables: str | None = None, list_only: bool = False) -> dict:
    """子进程调 wf_publish.py:打增量包发到 CDN(② 层生效的唯一正道)。
    tables=None 时发布 pending 列表;list_only=True 走 --list 只预览不打包。"""
    cmd = [sys.executable, str(Path(__file__).resolve().parent / "wf_publish.py")]
    if tables:
        cmd += ["--tables", tables]
    if list_only:
        cmd.append("--list")
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                       errors="replace", env={**os.environ, "PYTHONUTF8": "1"})
    ok = r.returncode == 0
    if ok and not list_only:
        if tables:
            _remove_pending_tables(tables)
        else:
            clear_pending()
    return {"ok": ok, "log": ((r.stdout or "") + (r.stderr or "")).strip(),
            "list_only": list_only}


def rollback_and_publish(name: str) -> dict:
    """一键回溯:还原备份 + 自动发布(客户端重启即拉回)。"""
    res = restore_backup(name)
    pub = run_publish(res["table"])
    res["ok"] = pub["ok"]
    res["publish_log"] = pub["log"]
    return res


# ---------------------------------------------------------------- adb sync

ADB_CANDIDATES = [
    r"D:\WF\MuMuPlayer\nx_main\adb.exe",
    r"C:\Program Files\Netease\MuMuPlayer-12.0\shell\adb.exe",
    r"C:\Program Files\Netease\MuMu Player 12\shell\adb.exe",
    r"C:\Program Files (x86)\Netease\MuMuPlayer-12.0\shell\adb.exe",
    r"D:\Program Files\Netease\MuMuPlayer-12.0\shell\adb.exe",
    r"C:\Program Files\Netease\MuMuPlayerGlobal-12.0\shell\adb.exe",
]


def find_adb() -> str | None:
    env = os.environ.get("WF_ADB")
    if env and Path(env).exists():
        return env
    which = shutil.which("adb")
    if which:
        return which
    for cand in ADB_CANDIDATES:
        if Path(cand).exists():
            return cand
    return None


def adb_run(adb: str, *args: str, timeout: int = 600) -> tuple[int, str]:
    proc = subprocess.run(
        [adb, *args], capture_output=True, text=True, timeout=timeout,
        errors="replace",
    )
    return proc.returncode, (proc.stdout + proc.stderr).strip()


def sync_to_emulator(restart: bool = True) -> dict:
    adb = find_adb()
    log = []
    if not adb:
        return {"ok": False, "log": "未找到 adb。请安装 MuMu 12 或设置环境变量 WF_ADB 指向 adb.exe"}
    log.append(f"adb: {adb}")

    code, out = adb_run(adb, "connect", DEVICE, timeout=15)
    log.append(f"connect {DEVICE}: {out}")
    if "cannot" in out or "failed" in out.lower():
        return {"ok": False, "log": "\n".join(log)}

    pending = read_pending()
    if not pending:
        log.append("没有待同步的修改文件")
    for rel in pending:
        root, rbase, r = TARGET_STORE, REMOTE_UPLOAD, rel
        if rel.startswith("medium:"):
            root, r = TARGET_STORE.parent / "medium_upload", rel[7:]
            rbase = REMOTE_UPLOAD.replace("/upload", "/medium_upload")
        elif rel.startswith("android:"):
            root, r = TARGET_STORE.parent / "android_upload", rel[8:]
            rbase = REMOTE_UPLOAD.replace("/upload", "/android_upload")
        local = root / r
        if not local.exists():
            log.append(f"跳过(本地缺失): {rel}")
            continue
        remote = f"{rbase}/{r}"
        code, out = adb_run(adb, "-s", DEVICE, "push", str(local), remote)
        log.append(f"push {rel}: {out}")
        if code != 0:
            return {"ok": False, "log": "\n".join(log)}

    if restart:
        adb_run(adb, "-s", DEVICE, "shell", "am", "force-stop", PKG, timeout=20)
        log.append(f"force-stop {PKG}")
        code, out = adb_run(adb, "-s", DEVICE, "shell", "am", "start", "-n", f"{PKG}/.AppEntry", timeout=20)
        if code != 0 or "Error" in out:
            code2, out2 = adb_run(
                adb, "-s", DEVICE, "shell", "monkey", "-p", PKG,
                "-c", "android.intent.category.LAUNCHER", "1", timeout=20)
            log.append(f"start(monkey): {out2}")
        else:
            log.append(f"start: {out}")

    if pending:
        clear_pending()
        log.append(f"已同步 {len(pending)} 个文件,清空待同步列表")
    return {"ok": True, "log": "\n".join(log)}


def _restart_game_via_mumu(log: list) -> bool:
    """adb 桥失联时的兜底:MuMuManager 的 RPC shell 重启游戏。
    MuMu 的 adb 端口会漂移(16384→16416…)甚至整个不监听(2026-07-12 实测),
    但 MuMuManager sh 走自有通道不依赖 adb。注意该通道下 monkey 参数会被拆坏,
    必须用 am start -n 显式 Activity。"""
    adb = find_adb()
    mgr = os.environ.get("WF_MUMU_MANAGER") or (str(Path(adb).with_name("MuMuManager.exe")) if adb else "")
    if not mgr or not Path(mgr).exists():
        log.append("MuMuManager.exe 未找到(应在 adb 同目录),无法兜底")
        return False
    try:
        _, out = adb_run(mgr, "info", "-v", "all", timeout=15)
        data = json.loads(out or "{}")
        insts = {str(data["index"]): data} if "index" in data else data
        idx = next((k for k, v in insts.items()
                    if isinstance(v, dict) and v.get("is_android_started")), None)
        if idx is None:
            log.append("MuMuManager: 没有运行中的模拟器实例")
            return False
        log.append(f"adb 失联,改走 MuMuManager sh(实例 {idx})")
        adb_run(mgr, "sh", "-v", idx, "-c", f"am force-stop {PKG}", timeout=20)
        log.append(f"force-stop {PKG} (MuMuManager)")
        act = f"{PKG}/com.leiting.sdk.activity.PrivacyActivity"
        _, out = adb_run(mgr, "sh", "-v", idx, "-c",
                         f"cmd package resolve-activity --brief {PKG}", timeout=20)
        for line in out.splitlines():
            if line.strip().startswith(PKG + "/"):
                act = line.strip()
        code, out = adb_run(mgr, "sh", "-v", idx, "-c", f"am start -n {act}", timeout=20)
        log.append(f"start {act}: {(out.strip() or 'ok')}")
        return code == 0 and "Error" not in out
    except Exception as e:
        log.append(f"MuMuManager 兜底失败: {e}")
        return False


def restart_game() -> str:
    """force-stop + 拉起游戏(发布后让客户端立刻拉增量包)。adb 失联自动走 MuMuManager。"""
    adb = find_adb()
    log = []
    adb_ok = False
    if adb:
        _, out = adb_run(adb, "connect", DEVICE, timeout=15)
        log.append(f"connect {DEVICE}: {out}")
        if not ("cannot" in out or "failed" in out.lower() or "unable" in out.lower()):
            adb_run(adb, "-s", DEVICE, "shell", "am", "force-stop", PKG, timeout=20)
            log.append(f"force-stop {PKG}")
            code, out = adb_run(adb, "-s", DEVICE, "shell", "am", "start", "-n", f"{PKG}/.AppEntry", timeout=20)
            if code != 0 or "Error" in out or "not found" in out:
                code2, out2 = adb_run(adb, "-s", DEVICE, "shell", "monkey", "-p", PKG,
                                      "-c", "android.intent.category.LAUNCHER", "1", timeout=20)
                log.append(f"start(monkey): {out2}")
                adb_ok = code2 == 0 and "not found" not in out2 and "Error" not in out2
            else:
                log.append(f"start: {out}")
                adb_ok = True
    else:
        log.append("未找到 adb")
    if not adb_ok:
        _restart_game_via_mumu(log)
    return "\n".join(log)


def adb_status() -> dict:
    adb = find_adb()
    if not adb:
        return {"adb": None, "connected": False}
    try:
        code, out = adb_run(adb, "devices", timeout=10)
        connected = any(DEVICE in line and "device" in line.split("\t")[-1]
                        for line in out.splitlines() if "\t" in line)
    except Exception:
        connected = False
    return {"adb": adb, "connected": connected}


# ---------------------------------------------------------------- 工具箱(长任务子进程 + 状态轮询)
# 把独立命令行工具(全量解密导出/路径表复原/数据包还原)并入 GUI:
# 子进程跑(不 import,零耦合),stdout 逐行进环形日志,前端轮询 /toolbox/status。
# 同一时间只允许一个任务(都是重 IO,并行只会互相拖慢)。

import re as _re
import threading

MOD_DIR = Path(__file__).resolve().parent

TOOLBOX_TOOLS = {
    "selftest": {
        "title": "全链路自检",
        "script": MOD_DIR / "wf_selftest.py",
        "desc": "环境可用性检测 + 功能模拟演练(词条工坊/技能DSL/命令库/强化弹射/发布预检);"
                "deep=含金丝雀写入闭环(写入后立即复原,校验字节一致)",
    },
    "balance_suite": {
        "title": "平衡增强总包",
        "script": MOD_DIR / "wf_balance_suite.py",
        "desc": "全角色平衡增强总包 v3:不勾选=dry-run 预览;可选 应用/发布/打分享包(会写 store)",
    },
    "rogue_reroll": {
        "title": "深渊连战·一键重开",
        "script": MOD_DIR / "wf_rogue_reroll.py",
        "desc": "重摇 700099 爬塔全部楼层/boss属性/场地效果(随机种子)+清爬塔进度+发布CDN+重启游戏;"
                "不勾「应用」= 只预览新阵容(会写 store)",
    },
    "export_assets": {
        "title": "全量解密导出",
        "script": MOD_DIR / "wf_export_assets.py",
        "desc": "解密下载包+bundle 全部哈希文件,按逻辑路径建目录树(PNG/MP3/CSV/JSON)",
    },
    "recover_pathlist": {
        "title": "路径表复原",
        "script": MOD_DIR / "wf_recover_pathlist.py",
        "desc": "重建 WF_PATHLIST_recovered.csv/txt(资产页 story/words 语音枚举靠它)",
    },
    "restore_package": {
        "title": "数据包还原",
        "script": ROOT / "弹国服" / "wf_restore_package.py",
        "desc": "不依赖 pathlist 自举复原路径并还原原始内容(重型,可只出清单)",
    },
}
# 各工具允许透传的 CLI 参数(白名单;flag 型值为 True 时加开关)
TOOLBOX_ARG_WHITELIST = {
    "selftest": {"deep": bool, "sample": int},
    "balance_suite": {"apply": bool, "publish": bool, "export-pack": bool, "force": bool},
    "rogue_reroll": {"rounds": int, "seed": int, "enemy-level": int, "event": str,
                     "player": int, "keep-progress": bool, "no-restart": bool, "apply": bool},
    "export_assets": {"out": str, "limit": int, "workers": int,
                      "only-bundle": bool, "no-skip": bool},
    "recover_pathlist": {"out": str},
    "restore_package": {"out": str, "limit": int, "workers": int,
                        "only-recover": bool, "no-skip": bool, "readable": bool},
}

_TB_LOCK = threading.Lock()
_TB_PROC: subprocess.Popen | None = None
_TB: dict = {"seq": 0, "tool": "", "title": "", "state": "idle", "log": [],
             "rc": None, "started": 0.0, "ended": 0.0, "cmd": ""}
_TB_PROGRESS = _re.compile(r"(\d+)\s*/\s*(\d+)")


def _toolbox_reader(proc: subprocess.Popen, seq: int) -> None:
    """后台线程:逐行收集子进程输出(限存最近 500 行),进程结束回填状态。"""
    assert proc.stdout is not None
    for raw in proc.stdout:
        line = raw.rstrip("\r\n")
        with _TB_LOCK:
            if _TB["seq"] != seq:
                break
            _TB["log"].append(line)
            if len(_TB["log"]) > 500:
                del _TB["log"][:100]
    rc = proc.wait()
    with _TB_LOCK:
        if _TB["seq"] == seq:
            _TB["rc"] = rc
            _TB["state"] = "done" if rc == 0 else ("cancelled" if _TB["state"] == "cancelling" else "failed")
            _TB["ended"] = time.time()


def toolbox_run(tool: str, args: dict) -> dict:
    spec = TOOLBOX_TOOLS.get(tool)
    if not spec:
        raise ValueError(f"未知工具: {tool}(可用: {'/'.join(TOOLBOX_TOOLS)})")
    if not spec["script"].exists():
        raise ValueError(f"脚本不存在: {spec['script']}")
    global _TB_PROC
    with _TB_LOCK:
        if _TB["state"] == "running" or _TB["state"] == "cancelling":
            raise ValueError(f"已有任务在跑: {_TB['title']}(先等它结束或取消)")
        cmd = [sys.executable, "-u", str(spec["script"])]
        allow = TOOLBOX_ARG_WHITELIST.get(tool, {})
        for k, v in (args or {}).items():
            if k not in allow or v in (None, "", False):
                continue
            typ = allow[k]
            if typ is bool:
                cmd.append(f"--{k}")
            elif typ is int:
                cmd += [f"--{k}", str(int(v))]
            else:
                cmd += [f"--{k}", str(v)]
        env = dict(os.environ, PYTHONIOENCODING="utf-8")
        proc = subprocess.Popen(
            cmd, cwd=str(ROOT), env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace")
        _TB_PROC = proc
        _TB.update(seq=_TB["seq"] + 1, tool=tool, title=spec["title"], state="running",
                   log=[], rc=None, started=time.time(), ended=0.0,
                   cmd=" ".join(cmd[2:]))
        threading.Thread(target=_toolbox_reader, args=(proc, _TB["seq"]),
                         daemon=True).start()
        return {"ok": True, "tool": tool, "title": spec["title"], "cmd": _TB["cmd"]}


def toolbox_status() -> dict:
    with _TB_LOCK:
        snap = {k: (list(v) if isinstance(v, list) else v) for k, v in _TB.items()}
    done = total = 0
    for line in reversed(snap["log"][-40:]):
        m = _TB_PROGRESS.search(line)
        if m and int(m.group(2)) >= int(m.group(1)) > 0:
            done, total = int(m.group(1)), int(m.group(2))
            break
    snap["progress"] = {"done": done, "total": total}
    snap["log"] = snap["log"][-120:]
    snap["tools"] = {k: {"title": v["title"], "desc": v["desc"],
                         "available": v["script"].exists()}
                     for k, v in TOOLBOX_TOOLS.items()}
    return snap


def toolbox_cancel() -> dict:
    global _TB_PROC
    with _TB_LOCK:
        if _TB["state"] != "running" or _TB_PROC is None:
            return {"ok": False, "log": "当前没有在跑的任务"}
        _TB["state"] = "cancelling"
        proc = _TB_PROC
    try:
        proc.terminate()
    except Exception as exc:
        return {"ok": False, "log": f"终止失败: {exc}"}
    return {"ok": True, "log": f"已请求终止 {_TB['title']}"}


# ---------------------------------------------------------------- 立绘定位(详情页/概览页)
# 逆向结论(2026-07-12,对照 CharacterImageValues/FullShotImageAttributeValues/
# FullShotImageViewTools.applyTextureToImage/getOffsetToCenterizeFace):
# 立绘 PNG 是**裁剪图**(trim 后),两张嵌套表把它摆回 1440x1920 设计画布:
#   master/generated/character_image.orderedmap(内层键=形态0/1,行=CSV 4列):
#     full_shot_x, full_shot_y = 裁剪图在画布中的偏移;full_shot_width/height =
#     裁剪图尺寸(**必须等于 PNG 实际宽高**,换不同尺寸立绘不更新这行就会错位!)
#   master/character/full_shot_image_attribute.orderedmap(内层键=形态0/1,行=CSV 5列):
#     pivot_x, pivot_y, scale = 角色详情页标准立绘位置(image.x = -pivot_x*scale;
#       pivot 是画布坐标系里对齐到视图原点的点,默认 1000,1000 / scale=1)
#     face_x, face_y = 脸部画布坐标;概览/列表页(centeringKind=1/2)按
#       scale*(pivot-face) 偏移把脸对准框中心 —— 即"概览页立绘位置"

CHAR_IMAGE_LOGICAL = "master/generated/character_image.orderedmap"
FS_ATTR_LOGICAL = "master/character/full_shot_image_attribute.orderedmap"
# trimmed_image(平表,11778 键):键=图逻辑路径(不带 .png),行=x,y,画布w,画布h。
# 客户端 ViewAssetCache 给**所有 UI 图**套 frame(Rectangle(-x,-y,w,h)):
# story 表情差分 9792 / skill_cutin 996 / full_shot 990 全是裁剪图,
# 换不同尺寸的图不同步此表 = 游戏内错位/出框。full_shot 的 x,y 与
# character_image 表同值(980/980 实测),两处必须一起写。
TRIMMED_LOGICAL = "master/generated/trimmed_image.orderedmap"


def _trim_entry(logical_png: str) -> tuple[core.OrderedMap, str, list[str]] | None:
    """查图片的 trim 行:返回 (表, 键, [x,y,画布w,画布h]) 或 None(表中无此图)。"""
    tkey = logical_png[:-4] if logical_png.endswith(".png") else logical_png
    try:
        tt = core.load_table(TRIMMED_LOGICAL, TARGET_STORE, SOURCE_STORE)
    except Exception:
        return None
    text = tt.text_rows().get(tkey)
    if not text:
        return None
    parts = [s.strip() for s in text.split(",")]
    return (tt, tkey, parts) if len(parts) >= 4 else None


def _write_trim_row(tt: core.OrderedMap, tkey: str, row: list[str],
                    log_lines: list[str]) -> str:
    return str(_write_with_backup(tt, {tkey: [row]}, log_lines))


def _load_nested_opt(logical: str) -> core.OrderedMap:
    p = core.table_path(TARGET_STORE, logical)
    if p.exists():
        return core.read_orderedmap_file_raw_rows(p, logical)
    if SOURCE_STORE:
        sp = core.table_path(SOURCE_STORE, logical)
        if sp.exists():
            return core.read_orderedmap_file_raw_rows(sp, logical)
    raise FileNotFoundError(f"cannot read {logical}")


def _full_shot_png_dims(code_name: str, level: str) -> tuple[int, int] | None:
    loc = wf_assets.locate(TARGET_STORE, f"character/{code_name}/ui/full_shot_1440_1920_{level}.png")
    if not loc:
        return None
    return wf_assets.png_dims(wf_assets.png_decode(loc[1].read_bytes()))


def get_char_image_pos(cid: str) -> dict:
    cid = str(cid)
    code = next((c["code_name"] for c in load_characters() if c["id"] == cid), None)
    if not code:
        raise ValueError(f"角色不存在: {cid}")
    out = []
    tables = {}
    for name, logical in (("fs", CHAR_IMAGE_LOGICAL), ("attr", FS_ATTR_LOGICAL)):
        try:
            om = _load_nested_opt(logical)
            tables[name] = core.read_orderedmap_file_from_bytes(om.rows[om.keys.index(cid)]) \
                if cid in om.keys else {}
        except Exception:
            tables[name] = {}
    levels = sorted(set(tables["fs"]) | set(tables["attr"]) | {"0", "1"}, key=str)
    for lv in levels:
        dims = _full_shot_png_dims(code, lv)
        fs = [x.strip() for x in tables["fs"].get(lv, "").split(",")] if tables["fs"].get(lv) else None
        at = [x.strip() for x in tables["attr"].get(lv, "").split(",")] if tables["attr"].get(lv) else None
        te = _trim_entry(f"character/{code}/ui/full_shot_1440_1920_{lv}.png")
        out.append({
            "level": lv,
            "img_w": dims[0] if dims else None, "img_h": dims[1] if dims else None,
            "canvas_w": te[2][2] if te else "1440", "canvas_h": te[2][3] if te else "1920",
            "fs": {"x": fs[0], "y": fs[1], "w": fs[2], "h": fs[3]} if fs and len(fs) >= 4 else None,
            "attr": {"pivot_x": at[0], "pivot_y": at[1], "scale": at[2],
                     "face_x": at[3], "face_y": at[4]} if at and len(at) >= 5 else None,
            "size_mismatch": bool(dims and fs and len(fs) >= 4
                                  and (fs[2] != str(dims[0]) or fs[3] != str(dims[1]))),
        })
    return {"character": cid, "code_name": code, "levels": out,
            "note": "内容框 w/h 必须等于立绘 PNG 实际宽高(换图后点「按图自动」);"
                    "pivot/scale=详情页位置(x=-pivot*scale),face=概览页脸部居中点(画布坐标)。"
                    "改后发布生效。"}


def _num_or_raise(v, f: str, float_ok: bool = False) -> str:
    v = str(v).strip()
    try:
        (float if float_ok else int)(v)
    except ValueError:
        raise ValueError(f"{f} 必须是{'数值' if float_ok else '整数'}: {v!r}")
    return v


def save_char_image_pos(cid: str, level: str, fs: dict | None, attr: dict | None,
                        dry_run: bool) -> dict:
    """写立绘定位:fs=内容框(character_image 4列),attr=摆放属性(attribute 5列)。"""
    cid, level = str(cid), str(level).strip()
    if level not in ("0", "1"):
        raise ValueError(f"形态必须是 0(基础)或 1(觉醒): {level!r}")
    log: list[str] = []
    jobs = []  # (logical, 新内层行文本)
    trim_sync = None  # (表, 键, 新行) —— trimmed_image 的 full_shot frame 同步
    if fs:
        row = ",".join(_num_or_raise(fs.get(k, ""), f"内容框 {k}") for k in ("x", "y", "w", "h"))
        jobs.append((CHAR_IMAGE_LOGICAL, row, "内容框(character_image)"))
        # trimmed_image 的 x,y 与 character_image 同值(980/980 实测),必须一起写,
        # 否则纹理 frame 与 colorBounds 不一致 → 部分场景错位
        code = next((c["code_name"] for c in load_characters() if c["id"] == cid), None)
        if code:
            te = _trim_entry(f"character/{code}/ui/full_shot_1440_1920_{level}.png")
            if te:
                tt, tkey, parts = te
                new_row = [str(fs.get("x")).strip(), str(fs.get("y")).strip(),
                           parts[2], parts[3]]
                if new_row != parts[:4]:
                    trim_sync = (tt, tkey, new_row)
                    log.append(f"{cid} trimmed_image[{tkey}]: {','.join(parts[:4])} -> "
                               f"{','.join(new_row)}(x,y 随内容框同步,画布不变)")
    if attr:
        vals = [_num_or_raise(attr.get("pivot_x", ""), "pivot_x"),
                _num_or_raise(attr.get("pivot_y", ""), "pivot_y"),
                _num_or_raise(attr.get("scale", ""), "scale", float_ok=True),
                _num_or_raise(attr.get("face_x", ""), "face_x"),
                _num_or_raise(attr.get("face_y", ""), "face_y")]
        jobs.append((FS_ATTR_LOGICAL, ",".join(vals), "摆放属性(full_shot_image_attribute)"))
    if not jobs:
        return {"changes": 0, "log": "没有修改", "written": None, "dry_run": dry_run}

    written = []
    changes = 0
    for logical, new_text, tag in jobs:
        om = _load_nested_opt(logical)
        if cid in om.keys:
            inner = core.read_orderedmap_file_from_bytes(om.rows[om.keys.index(cid)])
        else:
            inner = {}
            log.append(f"{cid} {tag}: 表中无此角色,新增外层键")
        old = inner.get(level)
        if old == new_text:
            continue
        log.append(f"{cid} {tag} 形态{level}: {old!r} -> {new_text!r}")
        changes += 1
        if dry_run:
            continue
        inner[level] = new_text
        inner_om = core.OrderedMap("<inner>", list(inner.keys()),
                                   [t.encode("utf-8") for t in inner.values()], Path("."))
        blob = core.build_orderedmap(inner_om)
        if cid in om.keys:
            om.rows[om.keys.index(cid)] = blob
        else:
            om.keys.append(cid)
            om.rows.append(blob)
        written.append(_write_nested(om, logical, "\n".join(log)))
    if trim_sync:
        changes += 1
        if not dry_run:
            tt, tkey, new_row = trim_sync
            written.append(_write_trim_row(tt, tkey, new_row, log))
    if changes == 0:
        return {"changes": 0, "log": "内容与当前一致,无需写入", "written": None, "dry_run": dry_run}
    return {"changes": changes, "log": "\n".join(log),
            "written": "; ".join(written) if written else None, "dry_run": dry_run,
            "note": "发布后生效(character_image/attribute/trimmed_image 均 ② 层)"}


# ---------------------------------------------------------------- 服务端推送(mod-admin)
# 服务端 src/lib/assets.ts 的商店/角色简化表已改为可热重载;
# POST /api/mod-admin/reload_assets 让改动即时生效,不用重启服务端。
# 地址优先级:WF_SERVER_URL > 项目根 .env 的 CN_LISTEN_HOST/PORT > 127.0.0.1:8001。


def _resolve_server_url() -> str:
    env = os.environ.get("WF_SERVER_URL")
    if env:
        return env.rstrip("/")
    host, port = "127.0.0.1", "8001"
    try:
        for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("CN_LISTEN_HOST="):
                host = line.split("=", 1)[1].strip().strip('"').strip("'") or host
            elif line.startswith("CN_LISTEN_PORT="):
                port = line.split("=", 1)[1].strip().strip('"').strip("'") or port
    except Exception:
        pass
    if host in ("0.0.0.0", ""):
        host = "127.0.0.1"
    return f"http://{host}:{port}"


SERVER_URL = _resolve_server_url()


def _server_call(path: str, post: bool = False) -> dict:
    req = urllib.request.Request(
        SERVER_URL + path,
        data=b"{}" if post else None,
        headers={"Content-Type": "application/json"} if post else {},
        method="POST" if post else "GET")
    with urllib.request.urlopen(req, timeout=8) as r:
        return json.loads(r.read().decode("utf-8"))


def server_ping() -> dict:
    try:
        d = _server_call("/api/mod-admin/ping")
        return {"online": True, "url": SERVER_URL, **d}
    except Exception as exc:
        # 字段名用 detail 而非 error:离线是正常状态,不能触发前端 api() 的统一报错
        return {"online": False, "url": SERVER_URL, "detail": str(exc)}


def server_push() -> dict:
    """让运行中的服务端重读商店/角色简化表等 assets json(不用重启)。"""
    try:
        d = _server_call("/api/mod-admin/reload_assets", post=True)
    except urllib.error.HTTPError as exc:
        raise ValueError(f"服务端返回 {exc.code}(旧版服务端无此接口?先 npx tsc + 重启一次): {exc}")
    except Exception as exc:
        raise ValueError(f"服务端不在线({SERVER_URL}),改动会在下次启动服务端时生效: {exc}")
    files = d.get("reloaded") or []
    return {"ok": True, "log": f"服务端已重读 {len(files)} 个文件: " + ", ".join(files),
            "reloaded": files}


# ---------------------------------------------------------------- 多行安全 CSV
# boss_coin_shop 等商店表的描述列含换行(带引号的多行 CSV 字段)。
# read_csv_lines 按物理行拆,会把这类行拆坏 —— 商店/特殊效果表一律用下面这对
# (csv.reader 吃整段文本,正确处理引号内换行;全表 6566 行字节级往返已验证)。


def _read_ml(text: str) -> list[list[str]]:
    if not text:
        return []
    return list(csv.reader(io.StringIO(text)))


def _write_ml(rows: list[list[str]]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerows(rows)
    out = buf.getvalue()
    return out[:-1] if out.endswith("\n") else out


def _write_with_backup_ml(table: core.OrderedMap, parsed: dict, log_lines: list[str],
                          bak_tag: str = ".bak-wfmod-gui-") -> Path:
    """同 _write_with_backup,但行文本用多行安全编码(勿对商店表用 write_csv_lines)。"""
    table.set_text_rows({k: _write_ml(r) for k, r in parsed.items()})
    suffix = bak_tag + time.strftime("%Y%m%d-%H%M%S")
    buf = io.StringIO()
    with redirect_stdout(buf):
        written = core.write_table(table, TARGET_STORE, suffix, no_backup=False)
    log_lines.append(buf.getvalue().strip())
    add_pending(written)
    summary = "\n".join(l for l in log_lines if l and not l.startswith("backup"))
    record_change(table.logical_path, summary, written.with_name(written.name + suffix))
    return written


def _write_json_asset_file(p: Path, data, tag: str, bak_tag: str) -> str:
    """服务端 assets/*.json 或 cdndata 镜像写盘:备份 + 紧凑 JSON + 改动日志。"""
    suffix = bak_tag + time.strftime("%Y%m%d-%H%M%S")
    bak = None
    if p.exists():
        bak = p.with_name(p.name + suffix)
        if not bak.exists():
            shutil.copy2(p, bak)
    p.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    record_change(tag, f"{p.name} 写入", bak)
    return str(p)


# ---------------------------------------------------------------- 特殊效果 unique_condition
# 表:master/character/unique_condition.orderedmap(平表,单行 15 列)
#   c0=string_id  c1=名称(战斗内浮标注释)  c2=图标逻辑路径(不带 .png)
#   c3=持续帧(99999999=永续)  c4=最大层数((None)=1)  c5-c8=(None)
#   c9-c13=行为开关(含直接消失/坏状态类,语义未全逆向,JSON 直改可调)  c14=扩展引用
# 图标:battle/common/unique_condition/<string_id>.png,48x48(全 21 张实测同尺寸)。
# 词条引用:ability 行的 unique_condition_id 列填本表键;赋予=效果枚举 461(ConditionUnique),
# 消耗=525(ConsumeUniqueCondition),触发/条件侧用 accumulation_unique_condition 系枚举。

UNIQUE_LOGICAL = "master/character/unique_condition.orderedmap"
UNIQUE_ICON_DIR = "battle/common/unique_condition"
UNIQUE_ROW_WIDTH = 15


def list_unique_conditions() -> dict:
    om = core.load_table(UNIQUE_LOGICAL, TARGET_STORE, SOURCE_STORE)
    out = []
    for k, t in om.text_rows().items():
        rows = _read_ml(t)
        row = core.normalize_row_length(rows[0] if rows else [], UNIQUE_ROW_WIDTH)
        icon = row[2] if row[2] not in ("", "(None)") else ""
        out.append({"id": k, "string_id": row[0], "name": row[1], "icon": icon,
                    "duration": row[3], "max_count": row[4],
                    "flags": row[9:14], "extra": row[14],
                    "icon_exists": bool(icon and wf_assets.locate(TARGET_STORE, icon + ".png"))})
    out.sort(key=lambda c: int(c["id"]) if c["id"].isdigit() else 0)
    return {"conditions": out,
            "note": "词条里引用:unique_condition_id 列填本表 ID;赋予=效果枚举 461,消耗=525,"
                    "触发条件用 accumulation_unique_condition 系。改表/图标后需右上角发布。"}


def _write_png_asset(logical: str, png: bytes, expect: tuple[int, int] | None,
                     force: bool, dry_run: bool) -> tuple[str, Path | None]:
    """PNG 资产写入(支持全新路径):校验魔数/尺寸 → 混淆编码 → 备份 → 待发布。"""
    if png[:8] != wf_assets.PNG_REAL:
        raise ValueError("上传的不是标准 PNG 文件(魔数不对)")
    dims = wf_assets.png_dims(png)
    if expect and dims != expect and not force:
        raise ValueError(f"图标必须是 {expect[0]}x{expect[1]}(上传的是 {dims[0]}x{dims[1]});"
                         "确要用请勾「强制」(游戏内会被缩放/裁切)")
    loc = wf_assets.locate(TARGET_STORE, logical)
    root, fp = loc if loc else ("upload", wf_assets.path_in_root(TARGET_STORE, "upload", logical))
    new = not fp.exists()
    line = f"{logical}: {'新增' if new else '替换'} PNG {dims[0]}x{dims[1]} {len(png)}B [{root}]"
    if dry_run:
        return line, None
    fp.parent.mkdir(parents=True, exist_ok=True)
    if not new:
        bak = fp.with_name(fp.name + ".bak-wfmod-asset-" + time.strftime("%Y%m%d-%H%M%S"))
        if not bak.exists():
            shutil.copy2(fp, bak)
    fp.write_bytes(wf_assets.png_encode(png))
    add_pending(fp)
    return line, fp


def save_unique_condition(uid: str, edits: dict, icon_b64: str, force_icon: bool,
                          dry_run: bool) -> dict:
    """新增/编辑特殊效果:名称/持续帧/最大层数 + 48x48 图标(新增时必传)。"""
    uid = str(uid).strip()
    if not uid.isdigit():
        raise ValueError(f"ID 必须是数字: {uid!r}")
    om = core.load_table(UNIQUE_LOGICAL, TARGET_STORE, SOURCE_STORE)
    parsed = {k: _read_ml(t) for k, t in om.text_rows().items()}
    exists = uid in parsed
    log_lines: list[str] = []

    if exists:
        row = core.normalize_row_length(list(parsed[uid][0]), UNIQUE_ROW_WIDTH)
    else:
        sid = str(edits.get("string_id", "")).strip().lower()
        if sid and not sid.startswith("unique_"):
            sid = "unique_" + sid
        if not sid or not all(c.isalnum() or c == "_" for c in sid):
            raise ValueError("新增需要内部名 string_id(小写字母/数字/下划线,自动加 unique_ 前缀)")
        if not str(edits.get("name", "")).strip():
            raise ValueError("新增需要名称(战斗内浮标显示)")
        if not icon_b64:
            raise ValueError("新增需要上传 48x48 图标 PNG")
        if any(_read_ml(t) and _read_ml(t)[0][0] == sid for t in om.text_rows().values()):
            raise ValueError(f"内部名已存在: {sid}")
        row = [sid, "", f"{UNIQUE_ICON_DIR}/{sid}", "99999999", "(None)",
               "(None)", "(None)", "(None)", "(None)",
               "false", "false", "0", "0", "true", "(None)"]
        log_lines.append(f"{uid} 新增特殊效果 {sid}")

    field_cols = {"name": 1, "duration": 3, "max_count": 4}
    for f, ci in field_cols.items():
        if f not in edits or edits[f] is None:
            continue
        val = str(edits[f]).strip()
        if f in ("duration", "max_count") and val not in ("", "(None)"):
            if not val.isdigit() or not (0 < int(val) < 2**31):
                raise ValueError(f"{f} 必须是正整数或 (None): {val!r}")
        if f == "name":
            val = val.replace("\r", "").replace("\n", " ")
            if not val:
                raise ValueError("名称不能为空")
        if val == "":
            val = "(None)"
        if row[ci] != val:
            log_lines.append(f"{uid} {f}: {row[ci]!r} -> {val!r}")
            row[ci] = val

    icon_line = None
    if icon_b64:
        png = base64.b64decode(icon_b64)
        icon_logical = row[2] + ".png"
        icon_line, _fp = _write_png_asset(icon_logical, png, (48, 48), force_icon, dry_run)
        log_lines.append(icon_line)

    changes = len([l for l in log_lines if l])
    if changes == 0:
        return {"changes": 0, "log": "没有修改", "written": None, "dry_run": dry_run}
    written = None
    if not dry_run:
        parsed[uid] = [row]
        written = str(_write_with_backup_ml(om, parsed, log_lines, ".bak-wfmod-unique-"))
    return {"changes": changes, "log": "\n".join(l for l in log_lines if l),
            "written": written, "dry_run": dry_run,
            "note": "发布后生效;词条引用该 ID 用 unique_condition_id 列(赋予 461/消耗 525)"}


# ---------------------------------------------------------------- 商店 boss_coin_shop(三处同步)
# ②层 master/shop/boss_coin_shop.orderedmap  = 客户端显示(名称/描述/图标/价格/库存/时间)
# ①层 assets/cdndata/boss_coin_shop.json    = ②层的 JSON 镜像(逐键 [行数组],保持同步)
# 服务端 assets/boss_coin_shop.json          = get_sales_list/buy 校验(costs/rewards/时间/库存)
#        assets/boss_coin_shop_item_category_map.json = 物品ID→类目(buy 查这个)
# ②层列(50 列,多行 desc 用 _read_ml/_write_ml;实测 6566 行全部 50 列等宽):
#   c0=类目 c6=名称 c8=序号 c9=物品主表引用 c10=描述 c12=图标 c13=类型
#   c17=货币道具ID c18=价格 c25=开始时间 c26=结束时间 c27=单次购买量(恒1)
#   c28=c31=库存 c32=奖励type c33=奖励ID c34=奖励数量

BSHOP_LOGICAL = "master/shop/boss_coin_shop.orderedmap"
BSHOP_CAT_LOGICAL = "master/shop/boss_coin_shop_category.orderedmap"
BSHOP_ROW_WIDTH = 50
BSHOP_COLS = {"name": 6, "desc": 10, "icon": 12, "cost_id": 17, "cost_amount": 18,
              "available_from": 25, "available_until": 26,
              "reward_type": 32, "reward_id": 33, "reward_count": 34}
SERVER_ASSETS = CDNDATA.parent  # assets/


def _bshop_server_paths() -> tuple[Path, Path]:
    return SERVER_ASSETS / "boss_coin_shop.json", SERVER_ASSETS / "boss_coin_shop_item_category_map.json"


def _bshop_cdn_path() -> Path:
    return CDNDATA / "boss_coin_shop.json"


def shop_categories() -> dict:
    cat = core.load_table(BSHOP_CAT_LOGICAL, TARGET_STORE, SOURCE_STORE)
    om = core.load_table(BSHOP_LOGICAL, TARGET_STORE, SOURCE_STORE)
    client_count: dict[str, int] = {}
    for t in om.text_rows().values():
        rows = _read_ml(t)
        if rows:
            c = rows[0][0]
            client_count[c] = client_count.get(c, 0) + 1
    try:
        srv = json.loads(_bshop_server_paths()[0].read_text(encoding="utf-8"))
    except Exception:
        srv = {}
    out = []
    for k, t in cat.text_rows().items():
        rows = _read_ml(t)
        code = rows[0][0] if rows and rows[0] else ""
        banner = rows[0][9] if rows and len(rows[0]) > 9 else ""
        if banner and not wf_assets.locate(TARGET_STORE, banner + ".png"):
            banner = ""
        out.append({"id": k, "code": code, "banner": banner,
                    "client_items": client_count.get(k, 0),
                    "server_items": len(srv.get(k, {}))})
    out.sort(key=lambda c: int(c["id"]) if c["id"].isdigit() else 0)
    return {"categories": out,
            "server_file": str(_bshop_server_paths()[0]),
            "note": "客户端列 = ②层表(改后发布);服务端列 = assets/boss_coin_shop.json"
                    "(购买校验,改后点「推送服务端」即时生效)"}


# 名称/图标速查:道具表(货币与 type=1 奖励)、角色(type=2)、装备(type=4)+
# item 图集坐标(346/355 商店图标在 item/sprite_sheet.png 里,前端 CSS sprite 切图)
_shop_lookups_cache: dict | None = None

ITEM_LOGICAL = "master/item/item.orderedmap"
ITEM_SHEET_LOGICAL = "item/sprite_sheet.png"
ITEM_ATLAS_LOGICAL = "item/sprite_sheet.atlas.amf3.deflate"


def _decode_amf3_asset(logical: str):
    """store 里的 .amf3.deflate → Python 对象(容错 4 字节长度前缀 / raw deflate)。"""
    loc = wf_assets.locate(TARGET_STORE, logical)
    if not loc:
        return None
    raw = loc[1].read_bytes()
    for blob in (raw, raw[4:]):
        for wbits in (15, -15):
            try:
                return core.AMF3Reader(zlib.decompress(blob, wbits)).read_value()
            except Exception:
                continue
    return None


def shop_lookups() -> dict:
    global _shop_lookups_cache
    if _shop_lookups_cache is not None:
        return _shop_lookups_cache
    items: dict[str, dict] = {}
    it = core.load_table(ITEM_LOGICAL, TARGET_STORE, SOURCE_STORE)
    for k, t in it.text_rows().items():
        rows = _read_ml(t)  # item 描述列含换行,禁按物理行拆
        if rows and len(rows[0]) > 3:
            items[k] = {"n": rows[0][2], "i": rows[0][3]}
    equip: dict[str, dict] = {}
    eq = core.load_table(EQUIP_LOGICAL, TARGET_STORE, SOURCE_STORE)
    for k, t in eq.text_rows().items():
        rows = _read_ml(t)
        if rows and len(rows[0]) > 6:
            equip[k] = {"n": rows[0][1], "i": rows[0][6]}
    chars = {c["id"]: {"n": c["name"], "i": f"character/{c['code_name']}/ui/square_0"}
             for c in load_characters()}
    atlas: dict[str, list] = {}
    sheet = {"w": 0, "h": 0, "logical": ITEM_SHEET_LOGICAL}
    entries = _decode_amf3_asset(ITEM_ATLAS_LOGICAL)
    if isinstance(entries, list):
        for e in entries:
            try:
                atlas[str(e["n"])] = [int(e["x"]), int(e["y"]), int(e["w"]), int(e["h"]),
                                      1 if e.get("r") else 0]
            except Exception:
                continue
        loc = wf_assets.locate(TARGET_STORE, ITEM_SHEET_LOGICAL)
        if loc:
            dims = wf_assets.png_dims(wf_assets.png_decode(loc[1].read_bytes()[:64]))
            if dims:
                sheet["w"], sheet["h"] = int(dims[0]), int(dims[1])
    _shop_lookups_cache = {
        "items": items, "characters": chars, "equipment": equip,
        "atlas": atlas, "sheet": sheet,
        "note": "atlas 条目 = [x,y,w,h,rot](rot=1 时图集里存的是顺时针转 90° 的区域)"}
    return _shop_lookups_cache


def shop_items(cat: str) -> dict:
    cat = str(cat)
    om = core.load_table(BSHOP_LOGICAL, TARGET_STORE, SOURCE_STORE)
    client: dict[str, list[str]] = {}
    for k, t in om.text_rows().items():
        rows = _read_ml(t)
        if rows and rows[0] and rows[0][0] == cat:
            client[k] = core.normalize_row_length(rows[0], BSHOP_ROW_WIDTH)
    try:
        srv_all = json.loads(_bshop_server_paths()[0].read_text(encoding="utf-8"))
    except Exception:
        srv_all = {}
    srv = srv_all.get(cat, {})
    items = []
    for iid in sorted(set(client) | set(srv), key=lambda x: int(x) if x.isdigit() else 0):
        row = client.get(iid)
        s = srv.get(iid) or {}
        cost = (s.get("costs") or [{}])[0]
        reward = (s.get("rewards") or [{}])[0]
        it = {"id": iid, "in_client": row is not None, "in_server": iid in srv}
        if row:
            it.update({f: row[ci] for f, ci in BSHOP_COLS.items()})
            it["stock"] = row[28]
        else:
            it.update({"name": "", "desc": "", "icon": "",
                       "cost_id": str(cost.get("id", "")), "cost_amount": str(cost.get("amount", "")),
                       "available_from": s.get("availableFrom", ""),
                       "available_until": s.get("availableUntil") or "",
                       "stock": str(s.get("stock", "")),
                       "reward_type": str(reward.get("type", "")),
                       "reward_id": str(reward.get("id", "")),
                       "reward_count": str(reward.get("count", ""))})
        it["server"] = s or None
        items.append(it)
    all_ids = [int(k) for k in om.keys if str(k).isdigit()]
    return {"category": cat, "items": items,
            "suggest_id": (max(all_ids) + 1) if all_ids else 1,
            "note": "改动同步写三处:②层表(发布生效)+cdndata 镜像+服务端 json(推送生效)。"
                    "奖励 type:1=道具 2=角色 3=玛纳 4=装备(常见值,以现有条目为准)"}


def _validate_shop_edits(edits: dict) -> dict:
    """字段白名单 + 类型校验,返回规范化后的 {字段: 字符串值}。"""
    out = {}
    known = set(BSHOP_COLS) | {"stock"}
    for f, v in edits.items():
        if f not in known or v is None:
            continue
        v = str(v).strip()
        if f in ("cost_id", "cost_amount", "stock", "reward_type", "reward_id", "reward_count"):
            if not v.isdigit():
                raise ValueError(f"{f} 必须是非负整数: {v!r}")
            if int(v) >= 2**31:
                raise ValueError(f"{f} 超出范围: {v}")
        if f in ("available_from", "available_until") and v:
            try:
                time.strptime(v, "%Y-%m-%d %H:%M:%S")
            except ValueError:
                raise ValueError(f"{f} 时间格式须为 YYYY-MM-DD HH:MM:SS: {v!r}")
        if f in ("name", "desc"):
            v = v.replace("\r", "")
        out[f] = v
    return out


def save_shop_item(cat: str, iid: str, edits: dict, clone_from: str, dry_run: bool) -> dict:
    """三处同步写一个商店条目;iid 不存在时从 clone_from(同类目)克隆新增。"""
    cat, iid = str(cat).strip(), str(iid).strip()
    if not cat.isdigit() or not iid.isdigit():
        raise ValueError("类目/物品 ID 必须是数字")
    ed = _validate_shop_edits(edits)
    om = core.load_table(BSHOP_LOGICAL, TARGET_STORE, SOURCE_STORE)
    parsed = {k: _read_ml(t) for k, t in om.text_rows().items()}
    log: list[str] = []

    # ---- ② 层行(新增=克隆同类目行) ----
    if iid in parsed:
        row = core.normalize_row_length(list(parsed[iid][0]), BSHOP_ROW_WIDTH)
    else:
        src = str(clone_from or "").strip()
        if not src:
            src = next((k for k, r in parsed.items() if r and r[0] and r[0][0] == cat), "")
        if not src or src not in parsed:
            raise ValueError(f"新增需要 clone_from(同类目现有物品 ID),类目 {cat} 找不到可克隆行")
        row = core.normalize_row_length(list(parsed[src][0]), BSHOP_ROW_WIDTH)
        row[0] = cat
        log.append(f"{iid} ②新增(克隆自 {src})")
    for f, ci in BSHOP_COLS.items():
        if f in ed and row[ci] != ed[f]:
            log.append(f"{iid} ②{f}: {row[ci]!r} -> {ed[f]!r}")
            row[ci] = ed[f]
    if "stock" in ed:
        for ci in (28, 31):
            if row[ci] != ed["stock"]:
                log.append(f"{iid} ②c{ci}(库存): {row[ci]!r} -> {ed['stock']!r}")
                row[ci] = ed["stock"]

    # ---- 服务端 json + 类目映射 ----
    sp, mp = _bshop_server_paths()
    srv = json.loads(sp.read_text(encoding="utf-8")) if sp.exists() else {}
    cmap = json.loads(mp.read_text(encoding="utf-8")) if mp.exists() else {}
    ent = dict(srv.get(cat, {}).get(iid) or {})
    if not ent:
        ent = {"costs": [], "rewards": [], "availableFrom": row[25],
               "availableUntil": row[26] or None, "stock": int(row[28] or 0)}
        log.append(f"{iid} srv新增条目(类目 {cat})")
    costs = list(ent.get("costs") or [])
    c0 = dict(costs[0]) if costs else {}
    rewards = list(ent.get("rewards") or [])
    r0 = dict(rewards[0]) if rewards else {}
    srv_map = {"cost_id": ("costs", c0, "id"), "cost_amount": ("costs", c0, "amount"),
               "reward_type": ("rewards", r0, "type"), "reward_id": ("rewards", r0, "id"),
               "reward_count": ("rewards", r0, "count")}
    for f, (_lst, obj, key) in srv_map.items():
        if f in ed and obj.get(key) != int(ed[f]):
            log.append(f"{iid} srv{f}: {obj.get(key)!r} -> {ed[f]}")
            obj[key] = int(ed[f])
    if c0:
        ent["costs"] = [c0] + costs[1:]
    if r0:
        ent["rewards"] = [r0] + rewards[1:]
    if "available_from" in ed and ent.get("availableFrom") != ed["available_from"]:
        log.append(f"{iid} srvFrom: {ent.get('availableFrom')!r} -> {ed['available_from']!r}")
        ent["availableFrom"] = ed["available_from"]
    if "available_until" in ed:
        nu = ed["available_until"] or None
        if ent.get("availableUntil") != nu:
            log.append(f"{iid} srvUntil: {ent.get('availableUntil')!r} -> {nu!r}")
            ent["availableUntil"] = nu
    if "stock" in ed and ent.get("stock") != int(ed["stock"]):
        log.append(f"{iid} srvStock: {ent.get('stock')!r} -> {ed['stock']}")
        ent["stock"] = int(ed["stock"])
    if cmap.get(iid) != int(cat):
        log.append(f"{iid} 类目映射 -> {cat}")

    changes = len(log)
    if changes == 0:
        return {"changes": 0, "log": "没有修改", "written": None, "dry_run": dry_run}
    written = None
    if not dry_run:
        # ② 层 + cdndata 镜像 + 服务端两 json,全部备份后写
        parsed[iid] = [row]
        written = str(_write_with_backup_ml(om, parsed, log, ".bak-wfmod-shop-"))
        cp = _bshop_cdn_path()
        cdn = json.loads(cp.read_text(encoding="utf-8")) if cp.exists() else {}
        cdn[iid] = [row]
        _write_json_asset_file(cp, cdn, "cdndata/boss_coin_shop.json", ".bak-wfmod-shop-")
        srv.setdefault(cat, {})[iid] = ent
        _write_json_asset_file(sp, srv, "server-assets/boss_coin_shop.json", ".bak-wfmod-shop-")
        cmap[iid] = int(cat)
        _write_json_asset_file(mp, cmap, "server-assets/boss_coin_shop_item_category_map.json",
                               ".bak-wfmod-shop-")
    return {"changes": changes, "log": "\n".join(log), "written": written, "dry_run": dry_run,
            "note": "②层改动点右上角「发布」进游戏;服务端 json 已写盘,点「推送服务端」即时生效"}


# ---------------------------------------------------------------- 通用 JSON 直改
# 把任意支持表的一个键导出为 JSON 文本,浏览器里直接改整行/整树,保存 = 解析校验 →
# dry-run 预览 → 备份写回。三类数据统一入口:
#   flat   ② 层平表:键 → 多行 CSV,JSON = [[列,...], ...](一行一个数组,全是字符串)
#   nested ② 层嵌套表:键 → 内层 orderedmap,JSON = {"内层键": [[列,...], ...]}
#   cdn    ① 层 cdndata json:顶层键 → 原生 JSON 节点(重启服务端生效,不发 CDN)

RAW_JSON_TABLES: dict[str, dict] = {
    "ability":        {"kind": "flat", "logical": core.ABILITY_LOGICAL, "cn": "角色词条②"},
    "leader_ability": {"kind": "flat", "logical": LEADER_LOGICAL, "cn": "队长技②"},
    "ability_soul":   {"kind": "flat", "logical": SOUL_LOGICAL, "cn": "魂珠效果②"},
    "weapon_ability": {"kind": "flat", "logical": WEAPON_LOGICAL, "cn": "武器强化词条②"},
    "character":      {"kind": "flat", "logical": core.CHARACTER_LOGICAL, "cn": "角色主表②"},
    "character_text": {"kind": "flat", "logical": CHAR_TEXT2_LOGICAL, "cn": "角色文本②"},
    "character_awake_status": {"kind": "flat", "logical": AWAKE_LOGICAL, "cn": "觉醒加成②"},
    "equipment":      {"kind": "flat", "logical": EQUIP_LOGICAL, "cn": "装备主表②"},
    "equipment_enhancement": {"kind": "flat", "logical": ENH_LOGICAL, "cn": "武器改造②"},
    "unique_condition": {"kind": "flat", "logical": UNIQUE_LOGICAL, "cn": "特殊效果②", "ml": True},
    "boss_coin_shop":   {"kind": "flat", "logical": BSHOP_LOGICAL, "cn": "Boss币商店②", "ml": True},
    "boss_coin_shop_category": {"kind": "flat", "logical": BSHOP_CAT_LOGICAL,
                                "cn": "Boss币商店类目②", "ml": True},
    "character_status": {"kind": "nested", "logical": core.STATUS_LOGICAL, "cn": "基础数值②(嵌套)"},
    "action_skill":     {"kind": "nested", "logical": core.ACTION_SKILL_LOGICAL, "cn": "主动技②(嵌套)"},
    "character_image":  {"kind": "nested", "logical": CHAR_IMAGE_LOGICAL, "cn": "立绘内容框②(嵌套)"},
    "full_shot_image_attribute": {"kind": "nested", "logical": FS_ATTR_LOGICAL,
                                  "cn": "立绘摆放属性②(嵌套)"},
    "trimmed_image": {"kind": "flat", "logical": TRIMMED_LOGICAL, "cn": "裁剪图frame②(story/cutin/立绘)"},
    "ex_ability": {"kind": "flat", "logical": "master/ex_boost/ex_ability.orderedmap",
                   "cn": "EX词条效果②(改效果发布生效;加新键须同步服务端 assets/ex_ability.json 抽取池)"},
    "ex_status":  {"kind": "flat", "logical": "master/ex_boost/ex_status.orderedmap",
                   "cn": "EX强化数值②(9档 HP/ATK 加成)"},
    "ex_boost":   {"kind": "flat", "logical": "master/ex_boost/ex_boost.orderedmap",
                   "cn": "EX素材定义②(素材id→消耗/组)"},
    "cdn:character":      {"kind": "cdn", "file": "character.json", "cn": "①角色名录"},
    "cdn:character_text": {"kind": "cdn", "file": "character_text.json", "cn": "①角色文本"},
    "cdn:gacha":          {"kind": "cdn", "file": "gacha.json", "cn": "①卡池"},
    "cdn:gacha_feature_content": {"kind": "cdn", "file": "gacha_feature_content.json", "cn": "①卡池内容"},
    "cdn:boss_coin_shop": {"kind": "cdn", "file": "boss_coin_shop.json", "cn": "①Boss币商店"},
    "cdn:player_rank":    {"kind": "cdn", "file": "player_rank.json", "cn": "①玩家等级"},
    "cdn:player_rank_full": {"kind": "cdn", "file": "player_rank_full.json", "cn": "①玩家等级full"},
    "cdn:rare_score_reward": {"kind": "cdn", "file": "rare_score_reward.json", "cn": "①稀有度积分"},
}


def _rj_spec(table: str) -> dict:
    spec = RAW_JSON_TABLES.get(str(table))
    if not spec:
        raise ValueError(f"不支持 JSON 直改的表: {table}(支持: {', '.join(RAW_JSON_TABLES)})")
    return spec


def _rj_load_table(spec: dict) -> core.OrderedMap:
    if spec["kind"] == "flat":
        return core.load_table(spec["logical"], TARGET_STORE, SOURCE_STORE)
    for store in (TARGET_STORE, SOURCE_STORE):
        if store:
            p = core.table_path(store, spec["logical"])
            if p.exists():
                return core.read_orderedmap_file_raw_rows(p, spec["logical"])
    raise FileNotFoundError(f"cannot read {spec['logical']} from target/source stores")


def _rj_cdn_path(spec: dict) -> Path:
    return CDNDATA / spec["file"]


def _rj_dump_rows(rows: list[list[str]], indent: str = "") -> str:
    """行数组 JSON 格式化:一行 CSV = 一行 JSON(126 列不炸成 126 行)。"""
    if not rows:
        return "[]"
    body = (",\n" + indent + "  ").join(json.dumps(r, ensure_ascii=False) for r in rows)
    return "[\n" + indent + "  " + body + "\n" + indent + "]"


def _rj_dumps(node) -> str:
    if isinstance(node, list) and node and all(isinstance(r, list) for r in node):
        return _rj_dump_rows(node)
    if isinstance(node, dict) and node and all(
            isinstance(v, list) and all(isinstance(r, list) for r in v) for v in node.values()):
        parts = [json.dumps(str(k), ensure_ascii=False) + ": " + _rj_dump_rows(v, "  ")
                 for k, v in node.items()]
        return "{\n  " + ",\n  ".join(parts) + "\n}"
    return json.dumps(node, ensure_ascii=False, indent=2)


def _rj_coerce_rows(value, where: str) -> list[list[str]]:
    """JSON → CSV 行:必须是数组的数组,单元格标量一律转字符串(true/false 小写)。"""
    if not isinstance(value, list) or not value:
        raise ValueError(f"{where}: 必须是非空的「数组的数组」,如 [[\"a\",\"b\"],...]")
    out = []
    for li, row in enumerate(value, start=1):
        if not isinstance(row, list):
            raise ValueError(f"{where} 第{li}行: 不是数组")
        cells = []
        for ci, v in enumerate(row):
            if isinstance(v, bool):
                cells.append("true" if v else "false")
            elif v is None:
                cells.append("")
            elif isinstance(v, (int, float, str)):
                cells.append(str(v))
            else:
                raise ValueError(f"{where} 第{li}行第{ci}列: 只能是 字符串/数字/布尔/null")
        out.append(cells)
    return out


def _rj_diff_rows(key: str, old: list[list[str]], new: list[list[str]],
                  log_lines: list[str]) -> int:
    """逐行逐列 diff,返回改动数;明细最多记 40 行。"""
    changes = 0
    for li in range(max(len(old), len(new))):
        o = old[li] if li < len(old) else None
        n = new[li] if li < len(new) else None
        if o is None:
            changes += 1
            if len(log_lines) < 40:
                log_lines.append(f"{key} 行{li + 1}: 新增({len(n)} 列)")
            continue
        if n is None:
            changes += 1
            if len(log_lines) < 40:
                log_lines.append(f"{key} 行{li + 1}: 删除")
            continue
        for ci in range(max(len(o), len(n))):
            ov = o[ci] if ci < len(o) else ""
            nv = n[ci] if ci < len(n) else ""
            if ov != nv:
                changes += 1
                if len(log_lines) < 40:
                    log_lines.append(f"{key} 行{li + 1} c{ci}: {ov!r} -> {nv!r}")
    return changes


def raw_json_tables() -> dict:
    return {"tables": [{"alias": a, "kind": s["kind"], "cn": s["cn"],
                        "target": s.get("logical") or ("cdndata/" + s["file"])}
                       for a, s in RAW_JSON_TABLES.items()]}


def raw_json_keys(table: str, q: str) -> dict:
    spec = _rj_spec(table)
    if spec["kind"] == "cdn":
        keys = list(json.loads(_rj_cdn_path(spec).read_text(encoding="utf-8")))
    else:
        keys = list(_rj_load_table(spec).keys)
    q = (q or "").strip().lower()
    hit = [k for k in keys if q in k.lower()] if q else keys
    return {"total": len(hit), "keys": hit[:100]}


def get_raw_json(table: str, key: str) -> dict:
    spec = _rj_spec(table)
    key = str(key)
    if spec["kind"] == "cdn":
        data = json.loads(_rj_cdn_path(spec).read_text(encoding="utf-8"))
        if key not in data:
            raise ValueError(f"{spec['file']} 中没有键 {key}")
        note = (f"① 层 cdndata/{spec['file']} 的键 {key}(原生 JSON 节点)。"
                "保存自动备份;重启服务端生效,不走发布。")
        return {"table": table, "key": key, "kind": "cdn",
                "json_text": _rj_dumps(data[key]), "note": note}
    om = _rj_load_table(spec)
    if key not in om.keys:
        raise ValueError(f"{spec['logical']} 中没有键 {key}")
    ki = om.keys.index(key)
    if spec["kind"] == "flat":
        reader = _read_ml if spec.get("ml") else core.read_csv_lines
        rows = reader(om.rows[ki].decode("utf-8") if om.rows[ki] else "")
        parsed = {k: reader(t) for k, t in om.text_rows().items()}
        width = _table_row_width(parsed, len(rows[0]) if rows else 0)
        note = (f"② 层平表 {spec['logical']}:一行 CSV = 一个数组,所有列都是字符串;"
                f"表宽 {width} 列(短行自动补空,超宽且尾列非空会被拦下)。"
                "可增删行;保存自动备份+进待发布。"
                + ("单元格内允许换行(多行描述)。" if spec.get("ml") else ""))
        return {"table": table, "key": key, "kind": "flat", "width": width,
                "json_text": _rj_dumps(rows), "note": note}
    inner = core.read_orderedmap_file_from_bytes(om.rows[ki])
    node = {ik: core.read_csv_lines(t) for ik, t in inner.items()}
    note = (f"② 层嵌套表 {spec['logical']}:{{内层键: [[列,...]]}};"
            "已有内层键的相对顺序不可重排(客户端读取依赖),可增删键/行;"
            "保存自动备份+进待发布。")
    return {"table": table, "key": key, "kind": "nested",
            "json_text": _rj_dumps(node), "note": note}


def save_raw_json(table: str, key: str, json_text: str, dry_run: bool) -> dict:
    spec = _rj_spec(table)
    key = str(key)
    try:
        node = json.loads(json_text)
    except Exception as exc:
        raise ValueError(f"JSON 解析失败: {exc}")

    if spec["kind"] == "cdn":
        p = _rj_cdn_path(spec)
        data = json.loads(p.read_text(encoding="utf-8"))
        if key not in data:
            raise ValueError(f"{spec['file']} 中没有键 {key}(不允许新增键)")
        if data[key] == node:
            return {"changes": 0, "log": "内容与当前文件一致,无需写入",
                    "written": None, "dry_run": dry_run}
        old_sz = len(json.dumps(data[key], ensure_ascii=False))
        new_sz = len(json.dumps(node, ensure_ascii=False))
        log = [f"{key} ①{spec['file']} 节点整体替换: {old_sz}B -> {new_sz}B"]
        written = None
        if not dry_run:
            data[key] = node
            suffix = ".bak-wfmod-rawjson-" + time.strftime("%Y%m%d-%H%M%S")
            bak = p.with_name(p.name + suffix)
            if not bak.exists():
                shutil.copy2(p, bak)
            p.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")),
                         encoding="utf-8")
            record_change("cdndata/" + spec["file"], "\n".join(log), bak)
            if spec["file"] in ("character.json", "character_text.json"):
                global _char_cache
                _char_cache = None
            written = str(p)
        return {"changes": 1, "log": "\n".join(log) + "\n(① 层:重启服务端生效,不走发布)",
                "written": written, "dry_run": dry_run}

    om = _rj_load_table(spec)
    if key not in om.keys:
        raise ValueError(f"{spec['logical']} 中没有键 {key}(不允许新增键)")
    ki = om.keys.index(key)

    if spec["kind"] == "flat":
        new_rows = _rj_coerce_rows(node, key)
        reader = _read_ml if spec.get("ml") else core.read_csv_lines
        parsed = {k: reader(t) for k, t in om.text_rows().items()}
        width = _table_row_width(parsed, len(new_rows[0]))
        for li, r in enumerate(new_rows, start=1):
            if len(r) > width and any(x != "" for x in r[width:]):
                raise ValueError(f"第{li}行 {len(r)} 列超过表宽 {width} 且尾列非空"
                                 "(整表必须等宽,否则客户端 InvalidRowWidth 崩溃)")
        new_rows = [core.normalize_row_length(r, width)[:width] for r in new_rows]
        log_lines: list[str] = []
        changes = _rj_diff_rows(key, parsed[key], new_rows, log_lines)
        if changes == 0:
            return {"changes": 0, "log": "内容与当前表一致,无需写入",
                    "written": None, "dry_run": dry_run}
        if changes > len(log_lines):
            log_lines.append(f"… 其余 {changes - len(log_lines)} 处改动省略")
        written = None
        if not dry_run:
            if spec.get("ml"):
                written = str(_write_with_backup_ml(om, {key: new_rows}, log_lines))
            else:
                written = str(_write_with_backup(om, {key: new_rows}, log_lines))
        return {"changes": changes, "log": "\n".join(log_lines),
                "written": written, "dry_run": dry_run}

    # nested:{内层键: [[列,...]]},内层已有键的相对顺序不可重排
    if not isinstance(node, dict) or not node:
        raise ValueError("嵌套表必须是非空 JSON 对象: {\"内层键\": [[列,...], ...]}")
    old_inner = {ik: core.read_csv_lines(t)
                 for ik, t in core.read_orderedmap_file_from_bytes(om.rows[ki]).items()}
    new_inner = {str(ik): _rj_coerce_rows(v, f"{key}.{ik}") for ik, v in node.items()}
    common_old = [k for k in old_inner if k in new_inner]
    common_new = [k for k in new_inner if k in old_inner]
    if common_old != common_new:
        raise ValueError(f"内层已有键的相对顺序不可重排: 原 {common_old} -> 新 {common_new}")
    log_lines = []
    changes = 0
    for ik in old_inner:
        if ik not in new_inner:
            changes += 1
            log_lines.append(f"{key} 内层键 {ik}: 删除")
    for ik, rows in new_inner.items():
        if ik not in old_inner:
            changes += 1
            log_lines.append(f"{key} 内层键 {ik}: 新增({len(rows)} 行)")
        else:
            changes += _rj_diff_rows(f"{key}.{ik}", old_inner[ik], rows, log_lines)
    if changes == 0:
        return {"changes": 0, "log": "内容与当前表一致,无需写入",
                "written": None, "dry_run": dry_run}
    written = None
    if not dry_run:
        inner_om = core.OrderedMap("<rawjson-inner>", list(new_inner.keys()),
                                   [core.write_csv_lines(r).encode("utf-8") if r else b""
                                    for r in new_inner.values()], Path("."))
        om.rows[ki] = core.build_orderedmap(inner_om)
        written = _write_nested(om, spec["logical"],
                                "\n".join(l for l in log_lines if l))
    return {"changes": changes, "log": "\n".join(log_lines),
            "written": written, "dry_run": dry_run}


# ---------------------------------------------------------------- 新增武器 / 新增副本(克隆式)
# 武器 = equipment 行 + 同键 ability_soul 被动(+ 改造武器另有 weapon_ability 行)。
# 图标默认沿用源武器(item/sprite_sheet.png 图集内 20×20 像素图,c6 路径);
# 服务端 equipment_ids.json(邮件发放校验)+ equipment_lookup.json(后台显示),静态 import 重启生效。
# 副本 = boss_battle_quest[1][node][rank] 行(行动模式 = field_data/zone/boss AI 引用原样保留)。
# 前例:node1 rank4-19(技伤不死王等 16 个测试副本)即此链路,已实战验证。

BBQ_LOGICAL = "master/quest/boss_battle_quest.orderedmap"
BBQ_NODE_LOGICAL = "master/quest/boss_battle_stage_node.orderedmap"


def weapon_clone(src: str, new_id: str, new_name: str, new_desc: str,
                 soul_from: str, dry_run: bool) -> dict:
    src, new_id = str(src).strip(), str(new_id).strip()
    if not new_id.isdigit():
        raise ValueError("新武器 ID 必须是纯数字(建议 59xxxxx 段避开现有 436 键)")
    eq = core.load_table(EQUIP_LOGICAL, TARGET_STORE, SOURCE_STORE)
    eq_rows = eq.text_rows()
    if src not in eq_rows:
        raise ValueError(f"源武器 {src} 不在 equipment 表")
    if new_id in eq_rows:
        raise ValueError(f"新 ID {new_id} 已存在于 equipment 表")
    soul_from = str(soul_from or src).strip()
    soul = core.load_table(SOUL_LOGICAL, TARGET_STORE, SOURCE_STORE)
    soul_rows = soul.text_rows()
    if soul_from not in soul_rows:
        raise ValueError(f"被动来源 {soul_from} 不在 ability_soul 表(武器被动=同键魂效果)")
    if new_id in soul_rows:
        raise ValueError(f"新 ID {new_id} 已存在于 ability_soul 表")

    row = list(_read_ml(eq_rows[src])[0])
    src_name = row[1]
    if new_name:
        row[1] = new_name
    if new_desc and len(row) > 7:
        row[7] = new_desc
    if len(row) > 10:
        row[10] = new_id  # soul_id → 指向自己的新被动

    wa = core.load_table(WEAPON_LOGICAL, TARGET_STORE, SOURCE_STORE)
    wa_rows = wa.text_rows()
    has_wa = src in wa_rows

    ids_p = SERVER_ASSETS / "equipment_ids.json"
    lookup_p = SERVER_ASSETS / "equipment_lookup.json"
    lookup = json.loads(lookup_p.read_text(encoding="utf-8"))
    src_lk = lookup.get(src, {})
    log = [f"equipment[{new_id}] 克隆自 {src}({src_name}): 名={row[1]!r} 图标沿用 {row[6]}",
           f"ability_soul[{new_id}] 被动克隆自 {soul_from}"
           + ("" if soul_from == src else "(指定来源)"),
           (f"weapon_ability[{new_id}] 强化词条克隆自 {src}" if has_wa
            else "源武器无 weapon_ability 强化词条行,跳过"),
           f"服务端 equipment_ids.json +{new_id};equipment_lookup.json +name/rarity/category"
           f"(须重启服务端,之后邮件附件类型 6 id={new_id} 可发放)"]
    written = None
    if not dry_run:
        bak_tag = ".bak-wfmod-wpnclone-"
        eq_parsed = {k: _read_ml(t) for k, t in eq_rows.items()}
        eq_parsed[new_id] = [row]
        w1 = _write_with_backup_ml(eq, eq_parsed, [f"{new_id} 克隆武器(自 {src})"], bak_tag)
        soul_parsed = {k: _read_ml(t) for k, t in soul_rows.items()}
        soul_parsed[new_id] = _read_ml(soul_rows[soul_from])
        _write_with_backup_ml(soul, soul_parsed,
                              [f"{new_id} 武器被动(克隆 ability_soul[{soul_from}])"], bak_tag)
        if has_wa:
            wa_parsed = {k: _read_ml(t) for k, t in wa_rows.items()}
            wa_parsed[new_id] = _read_ml(wa_rows[src])
            _write_with_backup_ml(wa, wa_parsed,
                                  [f"{new_id} 武器强化词条(克隆 {src})"], bak_tag)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        ids = json.loads(ids_p.read_text(encoding="utf-8"))
        for p in (ids_p, lookup_p):
            bak = p.with_name(p.name + bak_tag + stamp)
            if not bak.exists():
                shutil.copy2(p, bak)
        if int(new_id) not in ids:
            ids.append(int(new_id))
            ids_p.write_text(json.dumps(ids), encoding="utf-8")
        lookup[new_id] = {"name": row[1], "rarity": row[8] if len(row) > 8 else "0",
                          "category": src_lk.get("category", "")}
        lookup_p.write_text(json.dumps(lookup, ensure_ascii=False), encoding="utf-8")
        record_change(EQUIP_LOGICAL, f"{new_id} 新增武器(克隆 {src},被动 {soul_from})", None)
        written = str(w1)
    return {"changes": 1, "log": "\n".join(log), "written": written, "dry_run": dry_run,
            "note": "发布 equipment,ability_soul" + (",weapon_ability" if has_wa else "")
                    + " 三表 + 重启服务端后:邮件(附件类型6)发放,武器页可继续改被动/词条"}


def quest_clone(src_node: str, src_rank: str, mode: str, new_name: str,
                node_name: str, dry_run: bool) -> dict:
    """克隆领主战副本:mode=rank(源节点内加新难度,推荐/已验证)| node(新建节点)。
    行动模式(field_data/zone/boss AI)原样保留,数值后续用 Boss·副本页 / JSON 直改调。"""
    import wf_quest_lib as qlib
    src_node, src_rank = str(src_node).strip(), str(src_rank).strip()
    bbq = qlib.load_table(BBQ_LOGICAL)
    ch = bbq.get("1")
    if not isinstance(ch, dict) or src_node not in ch:
        raise ValueError(f"节点 {src_node} 不存在(现有 1-{max(int(k) for k in ch)})")
    node = ch[src_node]
    if src_rank not in node:
        raise ValueError(f"节点 {src_node} 没有难度 {src_rank}(现有: {'/'.join(node)})")
    c = list(_read_ml(node[src_rank])[0])
    src_qid = c[0]

    sn = qlib.load_table(BBQ_NODE_LOGICAL)
    snch = sn["1"]
    log = []
    if mode == "node":
        new_node = str(max(int(k) for k in snch) + 1)
        new_rank = "1"
        snrow = list(_read_ml(snch[src_node])[0])
        snrow[1] = (node_name or (snrow[1] + "·复刻")).strip()
        if len(snrow) > 6:
            snrow[6] = new_node
        if len(snrow) > 13:
            snrow[13] = str(1000 + int(new_node))
        log.append(f"stage_node[1][{new_node}] 新节点 {snrow[1]!r}(缩略图/背景沿用节点 {src_node})")
    else:
        new_node = src_node
        new_rank = str(max(int(k) for k in node) + 1)
        snrow = None
    qid = f"1{int(new_node):03d}{int(new_rank):03d}"
    c[0] = qid
    c[1] = new_rank
    if new_name:
        c[2] = new_name

    sj_p = SERVER_ASSETS / "boss_battle_quest.json"
    sj = json.loads(sj_p.read_text(encoding="utf-8"))
    if qid in sj:
        raise ValueError(f"quest id {qid} 已在服务端 boss_battle_quest.json(数据不一致,先排查)")
    src_entry = sj.get(src_qid)
    if src_entry is None:
        raise ValueError(f"源 quest {src_qid} 不在服务端 boss_battle_quest.json,无法克隆报酬参数")
    log.append(f"boss_battle_quest[1][{new_node}][{new_rank}] = 克隆 [{src_node}][{src_rank}]"
               f"(quest {src_qid} -> {qid},名={c[2]!r},行动模式/敌人/地形全保留)")
    log.append(f"服务端 boss_battle_quest.json +{qid}(报酬/评分参数抄 {src_qid},重启服务端生效)")
    written = None
    if not dry_run:
        stamp = time.strftime("%Y%m%d-%H%M%S")
        node[new_rank] = _write_ml([c])
        if snrow is not None:
            if new_node in snch:
                raise ValueError(f"节点 {new_node} 已存在")
            snch[new_node] = _write_ml([snrow])
            ch[new_node] = {new_rank: node.pop(new_rank)}  # 行挂到新节点
            p2 = qlib.save_table(BBQ_NODE_LOGICAL, sn)
            add_pending(p2)
            record_change(BBQ_NODE_LOGICAL, f"新节点 {new_node} {snrow[1]!r}", None)
        p1 = qlib.save_table(BBQ_LOGICAL, bbq)
        add_pending(p1)
        record_change(BBQ_LOGICAL, "\n".join(log), None)
        bak = sj_p.with_name(sj_p.name + ".bak-wfmod-qclone-" + stamp)
        if not bak.exists():
            shutil.copy2(sj_p, bak)
        sj[qid] = dict(src_entry)
        sj_p.write_text(json.dumps(sj, ensure_ascii=False), encoding="utf-8")
        written = str(p1)
    return {"changes": 1, "log": "\n".join(log), "written": written, "dry_run": dry_run,
            "quest_id": qid, "node": new_node, "rank": new_rank,
            "note": "发布 boss_battle_quest" + (" + boss_battle_stage_node" if mode == "node" else "")
                    + " 表 + 重启服务端;游戏内 领主战列表"
                    + (f"新节点" if mode == "node" else f"节点内新难度 {new_rank}")
                    + ";数值调整用 Boss·副本页(敌等级/修正列)或 JSON 直改"}


# ---------------------------------------------------------------- 连战塔(宝物域 boss 连战)
# 机制见 docs/强化弹射与boss连战逆向结论.md §9.55:Tower 类 quest 的 tower_floor_id →
# floor 表键,单 zlib chunk 内每行 = 一层,层间无结算连打;素材池复用 wf_chain_build。

CHAIN_FLOOR_LOGICAL = "master/battle/floor.orderedmap"
CHAIN_QUEST_LOGICAL = "master/quest/event/challenge_dungeon_event_quest.orderedmap"
CHAIN_KEY = "mod_chain_canary"
CHAIN_OFFICIAL_FLOOR = "treasure_cave_area"  # 宝物域官方层键(摘除入口时还原)
CHAIN_GROUP = "2"  # 外层键 2 = 摇曳的迷宫宝物域(2001-2006);外层键 1 = 崩坏域
# 列号:ChallengeDungeonEventQuestValues.as 实证(126 列,col110=tower_floor_id)
CHAIN_QCOLS = {
    "enemy_level": 107,  # 敌等级
    "hp_zako": 98, "hp_boss": 100,     # HP 修正(小怪/boss;99=funnel 不动)
    "atk_zako": 101, "atk_boss": 103,  # ATK 修正
    "time_limit": 111,  # 帧(60=1秒)
}
CHAIN_DIFF_FIELDS = ("enemy_level", "hp_zako", "hp_boss", "atk_zako", "atk_boss", "time_limit")


def _chain_pool() -> list:
    import wf_chain_build as cb
    return cb.build_pool()


def _chain_row_cols(row: str) -> list[str]:
    return next(csv.reader(io.StringIO(row)))


def _chain_floor_info(lines: list[str], pool_by_fd: dict, names: dict) -> list[dict]:
    out = []
    for ln in lines:
        c = _chain_row_cols(ln)
        fdk = c[0] if c else ""
        bosses = pool_by_fd.get(fdk, [])
        out.append({"field": fdk,
                    "bosses": [{"key": b, "name": names.get(b, "")} for b in bosses]})
    return out


def chain_state() -> dict:
    """连战塔现状:floor 链内容(模式/层列表带 boss 名)+ 宝物域 6 入口(指向/难度列)。"""
    import wf_quest_lib as qlib
    names = wf_boss.boss_names()
    pool = _chain_pool()
    pool_by_fd = {fdk: b for fdk, _ln, b in pool}

    floor = qlib.load_table(CHAIN_FLOOR_LOGICAL)
    raw = floor.get(CHAIN_KEY)
    mode, k, floors = "empty", 0, []
    if isinstance(raw, str) and raw.strip():
        lines = raw.split("\n")
        head = _chain_row_cols(lines[0])
        if head and head[0] == "__random__":
            mode, k = "random", int(head[1] or "1")
            floors = _chain_floor_info(lines[1:], pool_by_fd, names)
        else:
            mode = "fixed"
            floors = _chain_floor_info(lines, pool_by_fd, names)

    quest = qlib.load_table(CHAIN_QUEST_LOGICAL)
    quests = []
    for ik, row in quest.get(CHAIN_GROUP, {}).items():
        c = _read_ml(row)[0]
        q = {"inner": ik, "id": c[0], "name": c[2], "floor": c[110],
             "attached": c[110] == CHAIN_KEY}
        for f, col in CHAIN_QCOLS.items():
            q[f] = c[col]
        quests.append(q)
    return {"key": CHAIN_KEY, "mode": mode, "random_k": k, "floors": floors,
            "pool_total": len(pool), "official_floor": CHAIN_OFFICIAL_FLOOR,
            "quests": quests}


def chain_pool_list() -> dict:
    names = wf_boss.boss_names()
    return {"pool": [{"field": fdk,
                      "bosses": [{"key": b, "name": names.get(b, "")} for b in bosses]}
                     for fdk, _ln, bosses in _chain_pool()]}


def chain_apply(body: dict, dry_run: bool) -> dict:
    """写连战塔:floor 链(fixed=发布时抽定 N 层 / random=__random__ 头行+候选池)
    + 宝物域入口指向 + 难度列。random 模式必须客户端已打 client-patch/random-floor。"""
    import random as _random
    import wf_quest_lib as qlib

    mode = str(body.get("mode") or "fixed")
    if mode not in ("fixed", "random"):
        raise ValueError(f"mode 只能是 fixed/random,收到 {mode!r}")
    seed = str(body.get("seed") or "").strip() or time.strftime("%Y%m%d")
    rng = _random.Random(seed)
    pool = _chain_pool()
    names = wf_boss.boss_names()
    pool_by_fd = {fdk: b for fdk, _ln, b in pool}
    log: list[str] = []

    if mode == "fixed":
        n = max(1, min(int(body.get("floors") or 5), len(pool)))
        picks = rng.sample(pool, n)
        chain = "\n".join(ln for _fdk, ln, _b in picks)
        chain_lines = [ln for _fdk, ln, _b in picks]
        log.append(f"floor[{CHAIN_KEY}] = 固定链 {n} 层(种子 {seed})")
    else:
        k = max(1, int(body.get("random_k") or 3))
        cand = pool
        pool_size = int(body.get("pool_size") or 0)
        if pool_size and pool_size < len(pool):
            cand = rng.sample(pool, pool_size)
        k = min(k, len(cand))
        chain_lines = [ln for _fdk, ln, _b in cand]
        chain = "\n".join([f"__random__,{k},-"] + chain_lines)
        log.append(f"floor[{CHAIN_KEY}] = 随机池模式:每次进本从 {len(cand)} 层抽 {k} 层"
                   f"(种子 {seed} 决定候选池)")
        log.append("⚠ 前置:客户端必须已打 random-floor 补丁,否则进本即崩")

    floors_info = _chain_floor_info(chain_lines, pool_by_fd, names)
    for i, f in enumerate(floors_info):
        bs = ",".join(x["name"] or x["key"] for x in f["bosses"]) or "?"
        log.append(f"  {'候选' if mode == 'random' else '层' + str(i + 1)}: "
                   f"{f['field']}  boss={bs}")

    # 入口 + 难度
    attach_ids = {str(x) for x in (body.get("attach_ids") or [])}
    diff = {f: str(body[f]).strip() for f in CHAIN_DIFF_FIELDS
            if body.get(f) not in (None, "")}
    quest = qlib.load_table(CHAIN_QUEST_LOGICAL)
    group = quest.get(CHAIN_GROUP, {})
    quest_changes = 0
    for ik, row in group.items():
        c = _read_ml(row)[0]
        qid, qname = c[0], c[2]
        want = CHAIN_KEY if qid in attach_ids else CHAIN_OFFICIAL_FLOOR
        changed = []
        if c[110] != want:
            changed.append(f"floor {c[110]} → {want}")
            c[110] = want
        if qid in attach_ids:
            for f, val in diff.items():
                col = CHAIN_QCOLS[f]
                if c[col] != val:
                    changed.append(f"{f} {c[col]} → {val}")
                    c[col] = val
        if changed:
            quest_changes += 1
            group[ik] = _write_ml([c])
            log.append(f"quest {qid} {qname}: " + ";".join(changed))

    changes = 1 + quest_changes
    written = None
    if not dry_run:
        floor = qlib.load_table(CHAIN_FLOOR_LOGICAL)
        floor[CHAIN_KEY] = chain
        p1 = qlib.save_table(CHAIN_FLOOR_LOGICAL, floor)
        assert qlib.load_table(CHAIN_FLOOR_LOGICAL)[CHAIN_KEY] == chain, "floor 回读校验失败"
        add_pending(p1)
        if quest_changes:
            p2 = qlib.save_table(CHAIN_QUEST_LOGICAL, quest)
            add_pending(p2)
        record_change(CHAIN_FLOOR_LOGICAL, "\n".join(log), None)
        written = str(p1)
    note = "写入后点右上角「发布并重启游戏」生效(floor" \
           + (" + challenge_dungeon_event_quest" if quest_changes else "") + ")"
    if mode == "random":
        note += ";随机池模式需客户端 random-floor 补丁"
    return {"changes": changes, "log": "\n".join(log), "written": written,
            "dry_run": dry_run, "floors": floors_info, "mode": mode, "note": note}


# ---------------------------------------------------------------- http server


def read_page() -> bytes:
    html_path = Path(__file__).resolve().parent / "wf_gui.html"
    return html_path.read_bytes()


# API 前缀规范(为并入服务端后台准备,见 API.md):
#   标准:/api/mod/*  —— 将来 Fastify 只反代这一个前缀,与服务端自身 /api/* 零冲突
#   兼容:/api/*      —— 旧路径仍可用(标记 deprecated),迁移期后可删
API_PREFIX = "/api/mod"


# ================================================================ 深渊连战(700099 rush 活动)编辑
# 五块:①难度曲线/重摇(wf_rogue_build)②无尽修正(wf_rogue_nerf)③掉落代币(rogue_event.json)
# ④商店(event_item_shop 9700101-9700115,三处同步)⑤boss 阵容查看。
# CLI 工具封装为子进程复用;数据侧直读写(qlib 读嵌套/平表,assets json 直改)。
ROGUE_EVENT_ID = "700099"
ROGUE_Q_LOGICAL = "master/quest/event/rush_event_quest.orderedmap"
ROGUE_CORR_LOGICAL = "master/quest/event/rush_event_battle_quest_correction.orderedmap"
ROGUE_SHOP_LOGICAL = "master/shop/event_item_shop.orderedmap"
ROGUE_SHOP_KEYS = [str(i) for i in range(9700101, 9700116)]
# event_item_shop 列(51 列,plan Task4 + 真机实证):c7 名 c18 货币id c19 价 c29 库存
# c32 奖励type c33 奖励id c34 数量
ROGUE_SHOP_COLS = {"name": 7, "cost_id": 18, "price": 19, "stock": 29,
                   "reward_type": 32, "reward_id": 33, "reward_count": 34}
ROGUE_ELEM_CN = ["火", "水", "雷", "风", "光", "暗"]


def _rogue_cells(leaf) -> list[str]:
    line = leaf.decode("utf-8") if isinstance(leaf, (bytes, bytearray)) else leaf
    return next(csv.reader(io.StringIO(line)))


def _rogue_join(row: list[str], like) -> object:
    buf = io.StringIO()
    csv.writer(buf, lineterminator="").writerow(row)
    s = buf.getvalue()
    return s.encode("utf-8") if isinstance(like, (bytes, bytearray)) else s


def _rogue_asset_path(name: str) -> str:
    return os.path.join(ROOT, "assets", name)


def _rogue_run(script: str, args: list[str]) -> dict:
    """跑 mod-tools 下的 rogue CLI,返回 {ok, rc, log}。"""
    cmd = [sys.executable, "-X", "utf8", str(MOD_DIR / script)] + args
    r = subprocess.run(cmd, cwd=str(ROOT), capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    return {"ok": r.returncode == 0, "rc": r.returncode,
            "log": ((r.stdout or "") + (r.stderr or "")).strip()}


def rogue_state() -> dict:
    """深渊连战现状汇总:轮次 / 无尽 / 无尽修正曲线 / 掉落配置 / 商店。"""
    import wf_quest_lib as qlib
    names = wf_boss.boss_names()
    try:
        import wf_chain_build as cb
        pool_by_fd = {fdk: b for fdk, _ln, b in cb.build_pool()}
    except Exception:
        pool_by_fd = {}
    quest = qlib.load_table(ROGUE_Q_LOGICAL)
    rounds, endless = [], None
    for k, v in (quest.get(ROGUE_EVENT_ID) or {}).items():
        c = _rogue_cells(v)
        fd = c[98] if len(c) > 98 else ""
        bosses = pool_by_fd.get(fd, [])
        eff = []
        for s in range(5):
            ki = 71 + s * 2
            if len(c) > ki + 1 and c[ki] not in ("", "(None)"):
                eff.append({"kind": c[ki], "strength": c[ki + 1]})
        el = c[69] if len(c) > 69 else ""
        entry = {"qno": k, "round": c[2] if len(c) > 2 else "",
                 "subname": c[4] if len(c) > 4 else "", "field": fd,
                 "boss": "、".join(names.get(b, b) for b in bosses) or fd,
                 "element": el,
                 "element_cn": ROGUE_ELEM_CN[int(el)] if el.isdigit() and int(el) < 6 else "",
                 "enemy_level": c[95] if len(c) > 95 else "",
                 "hp": c[86] if len(c) > 86 else "", "atk": c[89] if len(c) > 89 else "",
                 "effects": eff}
        if entry["round"] == "0":
            endless = entry
        else:
            rounds.append(entry)
    rounds.sort(key=lambda r: int(r["round"] or 0))
    # 无尽修正曲线 [folder][questNo][round]
    corr = qlib.load_table(ROGUE_CORR_LOGICAL)
    curve = []

    def _walk(n):
        for kk in sorted(n, key=lambda x: int(x) if str(x).isdigit() else 0):
            vv = n[kk]
            if isinstance(vv, dict):
                yield from _walk(vv)
            else:
                yield kk, _rogue_cells(vv)
    if ROGUE_EVENT_ID in corr:
        for rk, row in _walk(corr[ROGUE_EVENT_ID]):
            curve.append({"round": rk, "hp": row[0] if row else "",
                          "atk": row[1] if len(row) > 1 else ""})
    # 掉落配置(rogue_event.json: {enabled, events:{700099:{...}}})
    drops, rogue_enabled = {}, False
    try:
        with open(_rogue_asset_path("rogue_event.json"), encoding="utf-8") as fh:
            rj = json.load(fh)
        rogue_enabled = bool(rj.get("enabled"))
        drops = (rj.get("events") or {}).get(ROGUE_EVENT_ID, {})
    except Exception:
        pass
    # 商店(15 商品)
    shop = []
    try:
        srows = core.load_table(ROGUE_SHOP_LOGICAL, TARGET_STORE, SOURCE_STORE).text_rows()
        for sid in ROGUE_SHOP_KEYS:
            if sid not in srows:
                continue
            c = _rogue_cells(srows[sid])
            shop.append({"id": sid, **{f: (c[i] if len(c) > i else "")
                                       for f, i in ROGUE_SHOP_COLS.items()}})
    except Exception as exc:
        shop = [{"error": str(exc)}]
    return {"event": ROGUE_EVENT_ID, "enabled": rogue_enabled, "rounds": rounds,
            "endless": endless, "curve": curve, "drops": drops, "shop": shop}


def rogue_build_apply(body: dict, dry_run: bool) -> dict:
    """难度曲线 + 重摇:封装 wf_rogue_build。dry_run=预览,否则 --write --publish。"""
    def _num(key, default):
        v = body.get(key)
        return str(default if v in (None, "") else v)
    args = ["--rounds", str(int(float(_num("rounds", 15)))),
            "--hp-base", _num("hp_base", 0.5), "--hp-growth", _num("hp_growth", 1.185),
            "--atk-base", _num("atk_base", 0.35), "--atk-growth", _num("atk_growth", 1.13),
            "--enemy-level", str(int(float(_num("enemy_level", 80))))]
    if body.get("seed") not in (None, ""):
        args += ["--seed", str(int(float(body["seed"])))]
    if not dry_run:
        args += ["--write"]
        if body.get("publish"):
            args += ["--publish"]
    return _rogue_run("wf_rogue_build.py", args)


def rogue_nerf_apply(body: dict, dry_run: bool) -> dict:
    """无尽修正曲线:封装 wf_rogue_nerf。"""
    args = ["--event", ROGUE_EVENT_ID]
    if body.get("hp_scale") not in (None, ""):
        args += ["--hp-scale", str(body["hp_scale"])]
    if body.get("atk_scale") not in (None, ""):
        args += ["--atk-scale", str(body["atk_scale"])]
    if body.get("hp_values"):
        args += ["--hp-values", str(body["hp_values"]).strip()]
    if len(args) == 2:
        return {"ok": True, "log": "未给任何参数(hp-scale/atk-scale/hp-values),仅查看当前曲线。"}
    if not dry_run:
        args += ["--write", "--publish"]
    return _rogue_run("wf_rogue_nerf.py", args)


def rogue_drops_save(body: dict, dry_run: bool) -> dict:
    """写 rogue_event.json(events[700099] 掉落配置 + enabled 总开关)+ 热重载服务端。"""
    cfg = body.get("config")
    if not isinstance(cfg, dict):
        return {"ok": False, "log": "config 必须是 JSON 对象"}
    path = _rogue_asset_path("rogue_event.json")
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    events = data.setdefault("events", {})
    old = json.dumps({"enabled": data.get("enabled"),
                      "cfg": events.get(ROGUE_EVENT_ID, {})}, ensure_ascii=False, indent=2)
    new_enabled = data.get("enabled") if body.get("enabled") is None else bool(body["enabled"])
    new = json.dumps({"enabled": new_enabled, "cfg": cfg}, ensure_ascii=False, indent=2)
    if old == new:
        return {"ok": True, "log": "没有修改"}
    if dry_run:
        return {"ok": True, "dry_run": True,
                "log": f"--- 现值 ---\n{old}\n\n--- 将写入 ---\n{new}"}
    shutil.copy(path, path + time.strftime(".bak-wfmod-rogue-%Y%m%d-%H%M%S"))
    events[ROGUE_EVENT_ID] = cfg
    data["enabled"] = new_enabled
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=1)
    try:
        _server_call("/api/mod-admin/reload_assets", post=True)
        reload_log = "已热重载服务端"
    except Exception:
        reload_log = "已写盘(热重载失败,点「推送服务端」或重启服务端生效)"
    return {"ok": True, "log": f"rogue_event.json 已更新(enabled={new_enabled})。{reload_log}"}


def rogue_shop_save(body: dict, dry_run: bool) -> dict:
    """深渊兑换商店三处同步:②表 event_item_shop + 服务端 json + id_map。
    body.items = [{id, name?, price?, cost_id?, reward_id?, reward_count?, stock?}, ...]。"""
    import wf_quest_lib as qlib
    edits = body.get("items") or []
    if not isinstance(edits, list) or not edits:
        return {"ok": False, "log": "items 为空"}
    tbl = qlib.load_table(ROGUE_SHOP_LOGICAL)
    sp = _rogue_asset_path("event_item_shop.json")
    with open(sp, encoding="utf-8") as fh:
        srv = json.load(fh)
    node = srv.setdefault("11", {}).setdefault(ROGUE_EVENT_ID, {})
    log: list[str] = []
    pend_tbl: dict = {}
    pend_srv = json.loads(json.dumps(srv))  # 深拷贝供预览
    pnode = pend_srv["11"][ROGUE_EVENT_ID]
    for ed in edits:
        sid = str(ed.get("id", "")).strip()
        if sid not in ROGUE_SHOP_KEYS or sid not in tbl:
            log.append(f"[跳过] {sid} 不是深渊商店键")
            continue
        row = list(_rogue_cells(tbl[sid]))
        for f, ci in ROGUE_SHOP_COLS.items():
            if f in ed and ed[f] not in (None, "") and len(row) > ci and row[ci] != str(ed[f]):
                log.append(f"{sid} ②{f}: {row[ci]!r} -> {ed[f]!r}")
                row[ci] = str(ed[f])
        pend_tbl[sid] = _rogue_join(row, tbl[sid])
        # 服务端 json 条目
        e = dict(pnode.get(sid) or {})
        costs = list(e.get("costs") or [{}]); c0 = dict(costs[0]) if costs else {}
        rews = list(e.get("rewards") or [{}]); r0 = dict(rews[0]) if rews else {}
        if "cost_id" in ed and ed["cost_id"] not in (None, ""):
            c0["id"] = int(ed["cost_id"])
        if "price" in ed and ed["price"] not in (None, ""):
            c0["amount"] = int(ed["price"]); log.append(f"{sid} srv价 -> {ed['price']}")
        if "reward_id" in ed and ed["reward_id"] not in (None, ""):
            r0["id"] = int(ed["reward_id"])
        if "reward_count" in ed and ed["reward_count"] not in (None, ""):
            r0["count"] = int(ed["reward_count"])
        if "reward_type" in ed and ed["reward_type"] not in (None, ""):
            r0["type"] = int(ed["reward_type"])
        if "stock" in ed and ed["stock"] not in (None, ""):
            e["stock"] = int(ed["stock"]); log.append(f"{sid} srv库存 -> {ed['stock']}")
        e["costs"] = [c0]; e["rewards"] = [r0]
        pnode[sid] = e
    if not log:
        return {"ok": True, "log": "没有修改"}
    if dry_run:
        return {"ok": True, "dry_run": True, "log": "\n".join(log)}
    # 写 ②表(自动备份)+ 发布
    for sid, leaf in pend_tbl.items():
        tbl[sid] = leaf
    out = qlib.save_table(ROGUE_SHOP_LOGICAL, tbl)
    shutil.copy(sp, sp + time.strftime(".bak-wfmod-eshop-%Y%m%d-%H%M%S"))
    with open(sp, "w", encoding="utf-8") as fh:
        json.dump(pend_srv, fh, ensure_ascii=False, indent=1)
    pub = _rogue_run("wf_publish.py", ["--tables", ROGUE_SHOP_LOGICAL])
    reload_ok = ""
    try:
        _server_call("/api/mod-admin/reload_assets", post=True); reload_ok = "已热重载服务端"
    except Exception:
        reload_ok = "服务端未热重载(点「推送服务端」或重启)"
    return {"ok": pub["ok"], "log": "\n".join(log)
            + f"\n[②表已写 {os.path.basename(str(out))} 并发布]\n[服务端 json 已写盘,{reload_ok}]\n"
            + pub["log"][-400:]}


# 综合可选池的类别(quest_pool key → 中文类别);steampunk 场地统一归「机兵」
ROGUE_POOL_CATS = [
    ("boss_battle", "领主战"), ("ex", "EX·决战"), ("advent", "降临讨伐"),
    ("hard_multi", "机兵"), ("raid", "战阵之宴"), ("expert_single", "专家单人"),
    ("score_attack", "积分战"), ("solo_time_attack", "计时战"), ("ranking", "排名战"),
    ("world_story_boss", "剧情boss"), ("challenge_dungeon", "临境域/幽玄"),
]


_ROGUE_POOL_CACHE: dict | None = None


def rogue_pool(force: bool = False) -> dict:
    """综合可选 boss 池(全高难类别):塔层/领主战/EX决战/机兵(含菲诺梅那)/降临/战阵之宴/
    专家单人/积分战/计时战/排名战/剧情boss/临境域/小怪房。field 去重,元素=固定元素 boss 查表。
    结果按进程缓存(master 数据不常变);带 thumb=来源 quest 缩略图(布局写入时同步)。"""
    global _ROGUE_POOL_CACHE
    if _ROGUE_POOL_CACHE is not None and not force:
        return _ROGUE_POOL_CACHE
    import wf_rogue_build as rb
    import wf_chain_build as cb
    names = wf_boss.boss_names()
    belem = rb.boss_element_map()
    seen: dict = {}
    out: list = []

    def push(cat, field, disp, bosses, thumb=""):
        if not field or field in seen:
            return
        seen[field] = 1
        el = next((belem[b] for b in bosses if belem.get(b) is not None), None)
        out.append({"field": field, "cat": cat, "boss": disp or field,
                    "label": f"{cat} · {disp or field}  [{field}]",
                    "element": ("" if el is None else str(el)),
                    "element_cn": (ROGUE_ELEM_CN[el] if el is not None and el < 6 else ""),
                    "thumb": thumb or ""})
    try:
        for fdk, _ln, b in cb.build_pool():
            push("连战塔", fdk, "、".join(names.get(x, x) for x in b) or fdk, b)
    except Exception:
        pass
    for cat_key, cat_cn in ROGUE_POOL_CATS:
        try:
            for e in rb.quest_pool(cat_key):
                cat = "机兵" if "steampunk" in e["field"] else cat_cn
                push(cat, e["field"], e["name"], e.get("bosses", []), e.get("thumb", ""))
        except Exception:
            continue
    try:
        for e in rb.zako_room_pool():
            push("小怪房", e["field"], e["name"] or "小怪房", e.get("bosses", []), e.get("thumb", ""))
    except Exception:
        pass
    # 分类排序(高难类别靠前),同类按名字
    cat_order = {c[1]: i for i, c in enumerate(
        [("", "机兵"), ("", "领主战"), ("", "EX·决战"), ("", "战阵之宴"), ("", "降临讨伐"),
         ("", "专家单人"), ("", "临境域/幽玄"), ("", "剧情boss"), ("", "积分战"),
         ("", "计时战"), ("", "排名战"), ("", "连战塔"), ("", "小怪房")])}
    out.sort(key=lambda x: (cat_order.get(x["cat"], 99), x["boss"]))
    _ROGUE_POOL_CACHE = {"pool": out,
                         "cats": sorted({x["cat"] for x in out}, key=lambda c: cat_order.get(c, 99))}
    return _ROGUE_POOL_CACHE


def rogue_layout_apply(body: dict, dry_run: bool) -> dict:
    """逐层手动布局:写 700099 folder1 各轮的 field/element/场地效果(c71-80),
    保留 hp/atk 曲线与 view_condition 链。body.rounds=[{round,field,element?,effects:[{kind,strength}],subname?}]。"""
    import wf_quest_lib as qlib
    import wf_rogue_build as rb
    rounds = body.get("rounds") or []
    if not rounds:
        return {"ok": False, "log": "rounds 为空"}
    thumb_map = dict(_rogue_thumbs())
    try:
        for x in rogue_pool()["pool"]:
            if x.get("thumb") and x["field"] not in thumb_map:
                thumb_map[x["field"]] = x["thumb"]
    except Exception:
        pass
    quest = qlib.load_table(ROGUE_Q_LOGICAL)
    inner = quest.get(ROGUE_EVENT_ID) or {}
    qno_by_round = {}
    for k, v in inner.items():
        c = _rogue_cells(v)
        if len(c) > 2 and c[1] == "1":
            qno_by_round[c[2]] = k
    log, pend = [], {}
    for rd in rounds:
        rn = str(rd.get("round", "")).strip()
        qno = qno_by_round.get(rn)
        if not qno:
            log.append(f"[跳过] 轮 {rn} 无对应 quest")
            continue
        like = inner[qno]
        row = list(_rogue_cells(like))
        field = str(rd.get("field", "")).strip()
        if field and len(row) > 98:
            if row[98] != field:
                log.append(f"轮{rn} 场地: {row[98]!r} -> {field!r}")
            row[98] = field
            th = thumb_map.get(field)
            if th and len(row) > 5:
                row[5] = th
        el = rd.get("element")
        if el not in (None, "") and len(row) > 69 and row[69] != str(el):
            log.append(f"轮{rn} 属性: {row[69]!r} -> {el}")
            row[69] = str(el)
        effects = rd.get("effects")
        if effects is not None:                       # 不带 effects 键 = 保留原效果列
            for s in range(5):
                ki = 71 + s * 2
                if len(row) > ki + 1:
                    if s < len(effects) and str(effects[s].get("kind", "")) not in ("", "(None)"):
                        row[ki] = str(effects[s].get("kind"))
                        row[ki + 1] = str(effects[s].get("strength", ""))
                    else:
                        row[ki], row[ki + 1] = "(None)", ""
            log.append(f"轮{rn} 场地效果 {len([e for e in effects if str(e.get('kind',''))not in('','(None)')])} 槽")
        if rd.get("subname") is not None and len(row) > 4:
            row[4] = str(rd["subname"]).strip() or "(None)"
        pend[qno] = rb.join(row, isinstance(like, (bytes, bytearray)))
    if not pend:
        return {"ok": True, "log": "没有可写的轮次"}
    # (下方写入+可选发布)
    if dry_run:
        return {"ok": True, "dry_run": True, "log": "\n".join(log) or "(将写入所选轮次)"}
    for qno, leaf in pend.items():
        inner[qno] = leaf
    quest[ROGUE_EVENT_ID] = inner
    out = qlib.save_table(ROGUE_Q_LOGICAL, quest)
    if body.get("publish"):
        pub = _rogue_run("wf_publish.py", ["--tables", "rush_event_quest"])
        return {"ok": pub["ok"], "log": "\n".join(log)
                + f"\n[已写 {os.path.basename(str(out))} 并发布 ②表]\n" + pub["log"][-300:]}
    return {"ok": True, "log": "\n".join(log)
            + f"\n[已写 {os.path.basename(str(out))},未发布——点「📤 发布」推送到游戏]"}


_ROGUE_THUMBS: dict | None = None


def _rogue_thumbs() -> dict:
    """field → 宿主 quest 缩略图(重型,进程内缓存)。"""
    global _ROGUE_THUMBS
    if _ROGUE_THUMBS is None:
        try:
            import wf_rogue_build as rb
            _ROGUE_THUMBS = rb.field_thumbnail_map()
        except Exception:
            _ROGUE_THUMBS = {}
    return _ROGUE_THUMBS


# rush 五表(随机/布局写入涉及的全部 ②层表;发布按钮一次推齐)
ROGUE_TABLES_LOGICAL = ",".join([
    "master/quest/event/rush_event.orderedmap",
    "master/quest/event/rush_event_quest_folder.orderedmap",
    "master/quest/event/rush_event_quest.orderedmap",
    "master/quest/event/event_list.orderedmap",
    "master/quest/event/rush_event_battle_quest_correction.orderedmap",
])


def rogue_publish() -> dict:
    """发布 rush 五表到 CDN(与写入分离的独立动作)。"""
    r = _rogue_run("wf_publish.py", ["--tables", ROGUE_TABLES_LOGICAL])
    r["log"] = (r["log"] or "")[-1200:]
    return r


def rogue_randomize(body: dict, dry_run: bool) -> dict:
    """随机生成:难度参数 + 每层池子计划(plan=[{round,cat}],cat 空=build 默认方案,
    '*'=全池任意)。先 wf_rogue_build --write(不发布),再按计划逐层随机覆盖 boss/场地。"""
    import random as _random
    seed = body.get("seed")
    seed = int(seed) if str(seed or "").strip() else _random.SystemRandom().randrange(1, 10 ** 8)
    r1 = rogue_build_apply({**body, "seed": seed, "publish": False}, dry_run)
    if not r1.get("ok"):
        return r1
    plan = [p for p in (body.get("plan") or []) if str(p.get("cat", "")).strip()]
    lines = [f"[seed {seed}(复现填此值)]", r1["log"][-1200:]]
    if plan:
        pool = rogue_pool()["pool"]
        rng = _random.Random(seed * 31 + 7)
        payload = []
        lines.append("—— 按层池子覆盖 ——")
        for p in sorted(plan, key=lambda x: int(x.get("round", 0) or 0)):
            cat = str(p["cat"]).strip()
            cand = pool if cat == "*" else [x for x in pool if x["cat"] == cat]
            if not cand:
                lines.append(f"层{p.get('round')}: 池「{cat}」为空,跳过")
                continue
            pick = rng.choice(cand)
            el = pick["element"] if pick["element"] != "" else str(rng.randrange(6))
            payload.append({"round": str(p.get("round")), "field": pick["field"], "element": el})
            lines.append(f"层{p.get('round')} [{'任意' if cat == '*' else cat}] → {pick['boss']} "
                         f"[{pick['field']}] 属性:{ROGUE_ELEM_CN[int(el)]}")
        if payload and not dry_run:
            r2 = rogue_layout_apply({"rounds": payload}, False)
            lines.append(r2["log"][-400:])
    lines.append("[DRY-RUN] 未写入。" if dry_run
                 else "已写入(未发布)。可在⑥手动微调,然后点「📤 发布」。")
    return {"ok": True, "log": "\n".join(lines)}


# ---------------------------------------------------------------- 定时自动随机刷新
ROGUE_AUTO_PATH = MOD_DIR / "work" / "rogue_auto.json"
_ROGUE_AUTO_LOCK = threading.Lock()
_ROGUE_AUTO = {"enabled": False, "time": "04:30", "rounds": 15, "enemy_level": 80,
               "clear_progress": True, "restart_game": False, "last_run_date": ""}
_ROGUE_AUTO_RT = {"running": False, "last_run": "", "last_log": ""}


def _rogue_auto_load() -> None:
    try:
        with open(ROGUE_AUTO_PATH, encoding="utf-8") as fh:
            _ROGUE_AUTO.update(json.load(fh))
    except Exception:
        pass


def _rogue_auto_save() -> None:
    os.makedirs(os.path.dirname(str(ROGUE_AUTO_PATH)), exist_ok=True)
    with open(ROGUE_AUTO_PATH, "w", encoding="utf-8") as fh:
        json.dump(_ROGUE_AUTO, fh, ensure_ascii=False, indent=1)


def _rogue_auto_due_ts() -> float:
    hh, mm = (str(_ROGUE_AUTO.get("time", "04:30")).split(":") + ["0"])[:2]
    now = time.localtime()
    return time.mktime((now.tm_year, now.tm_mon, now.tm_mday, int(hh), int(mm), 0,
                        now.tm_wday, now.tm_yday, now.tm_isdst))


def _rogue_auto_state() -> dict:
    nxt = ""
    if _ROGUE_AUTO.get("enabled"):
        try:
            due = _rogue_auto_due_ts()
            today = time.strftime("%Y-%m-%d")
            if time.time() < due:
                nxt = time.strftime("今天 %H:%M", time.localtime(due))
            elif _ROGUE_AUTO.get("last_run_date") != today:
                nxt = "即将执行(30 秒内)"
            else:
                nxt = time.strftime("明天 %H:%M", time.localtime(due))
        except Exception:
            nxt = "?"
    return {**{k: v for k, v in _ROGUE_AUTO.items() if k != "last_run_date"},
            **_ROGUE_AUTO_RT, "next_due": nxt}


def _rogue_auto_run() -> dict:
    """整局重开一次(wf_rogue_reroll):重摇+发布,按配置清进度/重启游戏。"""
    with _ROGUE_AUTO_LOCK:
        if _ROGUE_AUTO_RT["running"]:
            return {"ok": False, "log": "已在执行中"}
        _ROGUE_AUTO_RT["running"] = True
    try:
        args = ["--apply", "--rounds", str(_ROGUE_AUTO.get("rounds", 15)),
                "--enemy-level", str(_ROGUE_AUTO.get("enemy_level", 80))]
        if not _ROGUE_AUTO.get("clear_progress", True):
            args.append("--keep-progress")
        if not _ROGUE_AUTO.get("restart_game"):
            args.append("--no-restart")
        r = _rogue_run("wf_rogue_reroll.py", args)
        _ROGUE_AUTO_RT["last_run"] = time.strftime("%Y-%m-%d %H:%M:%S")
        _ROGUE_AUTO_RT["last_log"] = (r["log"] or "")[-1500:]
        _ROGUE_AUTO["last_run_date"] = time.strftime("%Y-%m-%d")
        _rogue_auto_save()
        return r
    finally:
        _ROGUE_AUTO_RT["running"] = False


def _rogue_auto_thread() -> None:
    while True:
        time.sleep(30)
        try:
            if not _ROGUE_AUTO.get("enabled"):
                continue
            if (time.time() >= _rogue_auto_due_ts()
                    and _ROGUE_AUTO.get("last_run_date") != time.strftime("%Y-%m-%d")):
                threading.Thread(target=_rogue_auto_run, daemon=True).start()
        except Exception:
            pass


_rogue_auto_load()
threading.Thread(target=_rogue_auto_thread, daemon=True).start()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    MAX_BODY = 64 * 1024 * 1024  # 请求体上限:最大合法载荷是 /asset/replace 的 base64 立绘(≈10MB),64MB 足够

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        if length > self.MAX_BODY:
            raise ValueError(f"请求体过大: {length} 字节(上限 {self.MAX_BODY})")
        return json.loads(self.rfile.read(length).decode("utf-8"))

    @staticmethod
    def _route(path: str) -> str | None:
        """把请求路径归一成不带前缀的 API 路由;非 API 路径返回 None。"""
        if path.startswith(API_PREFIX + "/"):
            return path[len(API_PREFIX):]
        if path.startswith("/api/"):
            return path[len("/api"):]
        return None

    def do_GET(self):
        parsed = urlparse(self.path)
        raw_path = parsed.path
        qs = parse_qs(parsed.query)
        try:
            if raw_path == "/" or raw_path == "/index.html":
                body = read_page()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
                return
            path = self._route(raw_path)
            if path is None:
                self._json({"error": "not found"}, 404)
                return
            if path == "/status":
                self._json({
                    "target_store": str(TARGET_STORE),
                    "profile": _PROFILE.label if _PROFILE else None,
                    "profile_id": _PROFILE.id if _PROFILE else None,
                    "res_version": _PROFILE.res_version if _PROFILE else "",
                    "pending": read_pending(),
                    "device": DEVICE,
                    "package": PKG,
                    **adb_status(),
                })
                return
            if path == "/characters":
                self._json(load_characters())
                return
            if path == "/schema":
                schema = load_schema()
                self._json({
                    "columns": [
                        {"index": int(i["index"]), "name": i["columnName"],
                         "isDecimal": i["type"].get("isDecimal")}
                        for i in schema
                    ],
                    "enums": {str(k): v for k, v in schema_enums(schema).items()},
                })
                return
            if path == "/abilities":
                character = (qs.get("character") or [""])[0]
                if not character:
                    self._json({"error": "缺少 character 参数"}, 400)
                    return
                self._json(get_rows_for_character(character))
                return
            if path == "/char_fields":
                character = (qs.get("character") or [""])[0]
                if not character:
                    self._json({"error": "缺少 character 参数"}, 400)
                    return
                self._json(get_char_fields(character))
                return
            if path == "/composer/meta":
                self._json(composer_meta())
                return
            if path == "/composer/row":
                self._json(composer_row((qs.get("key") or [""])[0],
                                        int((qs.get("line") or ["1"])[0]),
                                        (qs.get("as_key") or [""])[0]))
                return
            if path == "/composer/blank":
                self._json(composer_blank((qs.get("key") or [""])[0]))
                return
            if path == "/souls":
                self._json(list_souls())
                return
            if path == "/boss/list":
                self._json(wf_boss.boss_list())
                return
            if path == "/chain/state":
                self._json(chain_state())
                return
            if path == "/chain/pool":
                self._json(chain_pool_list())
                return
            if path == "/rogue/state":
                self._json(rogue_state())
                return
            if path == "/rogue/pool":
                self._json(rogue_pool())
                return
            if path == "/rogue/auto":
                self._json(_rogue_auto_state())
                return
            if path == "/skill_switch":
                character = (qs.get("character") or [""])[0]
                if not character:
                    self._json({"error": "缺少 character 参数"}, 400)
                    return
                self._json(get_skill_switch(character))
                return
            if path == "/quest/cats":
                self._json({"cats": wf_boss.quest_cats()})
                return
            if path == "/boss/usage":
                force = (qs.get("force") or [""])[0] == "1"
                self._json({"usage": wf_boss.boss_usage(force)})
                return
            if path == "/quest/list":
                cat = (qs.get("cat") or [""])[0]
                if not cat:
                    self._json({"error": "缺少 cat 参数"}, 400)
                    return
                self._json(wf_boss.quest_list(cat, (qs.get("q") or [""])[0]))
                return
            if path == "/status_values":
                character = (qs.get("character") or [""])[0]
                if not character:
                    self._json({"error": "缺少 character 参数"}, 400)
                    return
                self._json(get_status_values(character))
                return
            if path == "/soul_rows":
                soul = (qs.get("soul") or [""])[0]
                if not soul:
                    self._json({"error": "缺少 soul 参数"}, 400)
                    return
                self._json(get_soul_rows(soul))
                return
            if path == "/weapons":
                self._json(list_weapons())
                return
            if path == "/weapon_ability":
                wid = (qs.get("wid") or [""])[0]
                if not wid:
                    self._json({"error": "缺少 wid 参数"}, 400)
                    return
                self._json(get_weapon_rows(wid))
                return
            if path == "/skill_energy":
                character = (qs.get("character") or [""])[0]
                if not character:
                    self._json({"error": "缺少 character 参数"}, 400)
                    return
                self._json(get_skill_energy(character))
                return
            if path == "/skill_dsl_json":
                self._json(get_skill_dsl_json((qs.get("character") or [""])[0],
                                              (qs.get("level") or [""])[0],
                                              (qs.get("pp") or [""])[0]))
                return
            if path == "/skill_sig":
                self._json(skill_sig())
                return
            if path == "/pixelart_data":
                self._json(get_pixelart_data((qs.get("character") or [""])[0],
                                             (qs.get("name") or [""])[0]))
                return
            if path == "/powerflip":
                self._json(powerflip_overview((qs.get("character") or [""])[0]))
                return
            if path == "/powerflip/brief":
                self._json(powerflip_brief((qs.get("kind") or [""])[0]))
                return
            if path == "/omni_element":
                self._json(omni_element_status((qs.get("character") or [""])[0]))
                return
            if path == "/asset/export_char":
                zp, info = export_char_assets((qs.get("character") or [""])[0])
                body = zp.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "application/zip")
                self.send_header("Content-Disposition",
                                 f'attachment; filename="{zp.name}"')
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if path == "/skill_cmd_lib":
                self._json(skill_cmd_lib((qs.get("name") or [""])[0],
                                         (qs.get("q") or [""])[0],
                                         int((qs.get("limit") or ["80"])[0])))
                return
            if path == "/skill_dsl":
                self._json(get_skill_dsl((qs.get("character") or [""])[0],
                                         (qs.get("level") or ["1"])[0]))
                return
            if path == "/char_assets":
                self._json(char_assets((qs.get("character") or [""])[0]))
                return
            if path == "/effects":
                self._json(effect_previews((qs.get("character") or [""])[0]))
                return
            if path == "/asset_template":
                self._json(asset_template_check((qs.get("character") or [""])[0]))
                return
            if path == "/skill_summary":
                self._json(skill_effect_summary((qs.get("character") or [""])[0],
                                                (qs.get("level") or ["1"])[0]))
                return
            if path == "/composer/catalog":
                self._json(composer_catalog())
                return
            if path == "/char_snapshots":
                self._json(list_char_snapshots((qs.get("character") or [""])[0]))
                return
            if path == "/asset":
                logical = (qs.get("logical") or [""])[0]
                data, ctype = get_asset_bytes(logical)
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(data)
                return
            if path == "/backups":
                self._json(list_backups())
                return
            if path == "/search_abilities":
                q = (qs.get("q") or [""])[0]
                self._json(search_abilities(q))
                return
            if path == "/history":
                md = render_changelog_md()
                self._json({"entries": list(reversed(read_changelog())),
                            "changelog_md": str(md)})
                return
            if path == "/mainpos":
                self._json(mainpos("status"))
                return
            if path == "/toolbox/status":
                self._json(toolbox_status())
                return
            if path == "/raw_json/tables":
                self._json(raw_json_tables())
                return
            if path == "/server/ping":
                self._json(server_ping())
                return
            if path == "/char_image_pos":
                self._json(get_char_image_pos((qs.get("character") or [""])[0]))
                return
            if path == "/skill_variants":
                self._json(switched_skill_variants((qs.get("character") or [""])[0]))
                return
            if path == "/unique_conditions":
                self._json(list_unique_conditions())
                return
            if path == "/shop/categories":
                self._json(shop_categories())
                return
            if path == "/shop/items":
                self._json(shop_items((qs.get("cat") or [""])[0]))
                return
            if path == "/shop/lookups":
                self._json(shop_lookups())
                return
            if path == "/raw_json/keys":
                self._json(raw_json_keys((qs.get("table") or [""])[0],
                                         (qs.get("q") or [""])[0]))
                return
            if path == "/raw_json":
                self._json(get_raw_json((qs.get("table") or [""])[0],
                                        (qs.get("key") or [""])[0]))
                return
            self._json({"error": "not found"}, 404)
        except Exception as exc:
            self._json({"error": str(exc)}, 500)

    def do_POST(self):
        path = self._route(urlparse(self.path).path)
        try:
            if path is None:
                self._json({"error": "not found"}, 404)
                return
            body = self._read_body()
            if path == "/scale":
                match = {}
                if body.get("character"):
                    match["character"] = str(body["character"])
                if body.get("ability"):
                    match["ability"] = body["ability"]
                op = {
                    "op": "scale",
                    "match": match or None,
                    "fields": body.get("fields") or "skill_strength",
                    "factor": body.get("factor", 1),
                    "rounding": body.get("rounding", "int"),
                }
                self._json(run_recipe({"operations": [op]}, bool(body.get("dry_run"))))
                return
            if path == "/copy":
                op = {
                    "op": "copy_ability",
                    "from_character": str(body.get("from_character", "")),
                    "to_character": str(body.get("to_character", "")),
                    "slots": body.get("slots") or [1, 2, 3, 4, 5, 6],
                }
                if body.get("preserve_string_id", True):
                    op["preserve_fields"] = ["string_id"]
                else:
                    op["preserve_fields"] = []
                if body.get("fields"):
                    op["fields"] = body["fields"]
                self._json(run_recipe({"operations": [op]}, bool(body.get("dry_run"))))
                return
            if path == "/copy_row":
                self._json(copy_row(body.get("src") or {}, body.get("dst") or {},
                                    bool(body.get("preserve_string_id", True)),
                                    bool(body.get("dry_run"))))
                return
            if path == "/composer/describe":
                self._json(composer_describe(str(body.get("kind", "ability")),
                                             list(body.get("row") or [])))
                return
            if path == "/composer/apply":
                self._json(composer_apply(
                    str(body.get("dst_key", "")), body.get("mode", "append"),
                    list(body.get("row") or []), bool(body.get("adapt_sid", False)),
                    bool(body.get("dry_run")), bool(body.get("create_missing", False))))
                return
            if path == "/composer/generate":
                self._json(composer_generate(
                    str(body.get("dst_key", "")), str(body.get("trigger", "")),
                    str(body.get("effect", "")), float(body.get("value") or 0),
                    body.get("value_max"), body.get("threshold"),
                    str(body.get("target", "0")), str(body.get("groups", "")),
                    mode=str(body.get("mode", "")),
                    trigger_kind=str(body.get("trigger_kind", "")),
                    effect_kind=str(body.get("effect_kind", "")),
                    effect_unit=str(body.get("effect_unit", "pct")),
                    threshold_unit=str(body.get("threshold_unit", "count")),
                    puller=str(body.get("puller", "0")),
                    trigger_groups=str(body.get("trigger_groups", "")),
                    precondition_kind=str(body.get("precondition_kind", "")),
                    precondition_threshold=body.get("precondition_threshold"),
                    precondition_unit=str(body.get("precondition_unit", "pct")),
                    hits=body.get("hits"),
                    string_id=str(body.get("string_id", "")),
                    action_path=str(body.get("action_path", ""))))
                return
            if path == "/append_line_adapted":
                self._json(append_line_adapted(
                    str(body.get("src_key", "")), int(body.get("src_line", 1)),
                    str(body.get("dst_key", "")), str(body.get("element", "auto")),
                    bool(body.get("adapt_sid", True)), bool(body.get("clear_awake", True)),
                    bool(body.get("dry_run")),
                ))
                return
            if path == "/append_ability":
                self._json(append_ability_lines(
                    str(body.get("src_key", "")),
                    str(body.get("dst_key", "")),
                    bool(body.get("preserve_string_id", False)),
                    bool(body.get("dry_run")),
                ))
                return
            if path == "/transplant_line":
                strip = body.get("strip_cols")
                if not isinstance(strip, str):
                    strip = [int(c) for c in (strip or [])]
                self._json(transplant_line(
                    str(body.get("src_key", "")),
                    int(body.get("src_line", 1)),
                    str(body.get("dst_key", "")),
                    str(body.get("mode", "append")),
                    strip,
                    bool(body.get("preserve_string_id", False)),
                    bool(body.get("dry_run")),
                ))
                return
            if path == "/mainpos":
                self._json(mainpos(str(body.get("action", "status"))))
                return
            if path == "/copy_leader":
                self._json(copy_leader_to_slot(
                    str(body.get("from_character", "")),
                    str(body.get("to_character", "")),
                    int(body.get("slot", 6)),
                    bool(body.get("preserve_string_id", True)),
                    bool(body.get("dry_run")),
                ))
                return
            if path == "/copy_leader_to_leader":
                self._json(copy_leader_to_leader(
                    str(body.get("from_character", "")),
                    str(body.get("to_character", "")),
                    bool(body.get("preserve_string_id", False)),
                    bool(body.get("dry_run")),
                ))
                return
            if path == "/export_all":
                self._json(export_all_abilities())
                return
            if path == "/export_annotated":
                self._json(export_annotated())
                return
            if path == "/recipe":
                recipe = body.get("recipe")
                if isinstance(recipe, str):
                    recipe = json.loads(recipe)
                self._json(run_recipe(recipe, bool(body.get("dry_run"))))
                return
            if path == "/rows/save":
                self._json(save_row_edits(body.get("edits") or [], bool(body.get("dry_run"))))
                return
            if path == "/backups":
                self._json(list_backups())
                return
            if path == "/restore":
                self._json(restore_backup(str(body.get("name", ""))))
                return
            if path == "/rollback":
                # 回溯 = 还原备份 + 自动发布 + 重启游戏(客户端立刻拉回改动)
                res = rollback_and_publish(str(body.get("name", "")))
                if res.get("ok") and body.get("restart", True):
                    res["restart_log"] = restart_game()
                self._json(res)
                return
            if path == "/publish":
                # 一键发布:pending(或指定表)打增量包到 CDN;list_only 只预览
                res = run_publish(body.get("tables") or None, bool(body.get("list_only")))
                if res["ok"] and not res["list_only"] and body.get("restart", True):
                    res["restart_log"] = restart_game()
                self._json(res)
                return
            if path == "/sync":
                self._json(sync_to_emulator(restart=bool(body.get("restart", True))))
                return
            if path == "/char_fields/save":
                self._json(save_char_fields(
                    str(body.get("character", "")),
                    body.get("edits") or {},
                    bool(body.get("dry_run")),
                ))
                return
            if path == "/element_convert":
                self._json(element_convert(
                    str(body.get("character", "")),
                    str(body.get("target", "")),
                    bool(body.get("dry_run")),
                ))
                return
            if path == "/soul_rows/save":
                self._json(save_soul_rows(body.get("edits") or [], bool(body.get("dry_run"))))
                return
            if path == "/skill_energy/save":
                self._json(save_skill_energy(
                    str(body.get("character", "")),
                    body.get("edits") or [],
                    bool(body.get("dry_run")),
                ))
                return
            if path == "/skill_copy":
                self._json(skill_copy(str(body.get("from_character", "")),
                                      str(body.get("to_character", "")),
                                      bool(body.get("dry_run"))))
                return
            if path == "/skill_level_copy":
                self._json(skill_level_copy(
                    str(body.get("from_character", "")), str(body.get("from_level", "1")),
                    str(body.get("to_character", "")), str(body.get("to_level", "1")),
                    bool(body.get("dry_run"))))
                return
            if path == "/skill_level_delete":
                self._json(skill_level_delete(str(body.get("character", "")),
                                              str(body.get("level", "")),
                                              bool(body.get("dry_run"))))
                return
            if path == "/skill_dsl_json/save":
                self._json(save_skill_dsl_json(str(body.get("character", "")),
                                               str(body.get("level", "")),
                                               str(body.get("json_text", "")),
                                               bool(body.get("dry_run")),
                                               str(body.get("pp", ""))))
                return
            if path == "/pixelart_data/save":
                self._json(save_pixelart_data(str(body.get("character", "")),
                                              str(body.get("name", "")),
                                              str(body.get("json_text", "")),
                                              str(body.get("data_b64", "")),
                                              bool(body.get("dry_run"))))
                return
            if path == "/weapon_clone":
                self._json(weapon_clone(str(body.get("src", "")),
                                        str(body.get("new_id", "")),
                                        str(body.get("new_name", "")),
                                        str(body.get("new_desc", "")),
                                        str(body.get("soul_from", "")),
                                        bool(body.get("dry_run"))))
                return
            if path == "/quest_clone":
                self._json(quest_clone(str(body.get("src_node", "")),
                                       str(body.get("src_rank", "")),
                                       str(body.get("mode", "rank")),
                                       str(body.get("new_name", "")),
                                       str(body.get("node_name", "")),
                                       bool(body.get("dry_run"))))
                return
            if path == "/chain/apply":
                self._json(chain_apply(body, bool(body.get("dry_run"))))
                return
            if path == "/rogue/build":
                self._json(rogue_build_apply(body, bool(body.get("dry_run"))))
                return
            if path == "/rogue/nerf":
                self._json(rogue_nerf_apply(body, bool(body.get("dry_run"))))
                return
            if path == "/rogue/drops":
                self._json(rogue_drops_save(body, bool(body.get("dry_run"))))
                return
            if path == "/rogue/shop":
                self._json(rogue_shop_save(body, bool(body.get("dry_run"))))
                return
            if path == "/rogue/layout":
                self._json(rogue_layout_apply(body, bool(body.get("dry_run"))))
                return
            if path == "/rogue/randomize":
                self._json(rogue_randomize(body, bool(body.get("dry_run"))))
                return
            if path == "/rogue/publish":
                self._json(rogue_publish())
                return
            if path == "/rogue/auto":
                for k in ("enabled", "clear_progress", "restart_game"):
                    if k in body:
                        _ROGUE_AUTO[k] = bool(body[k])
                if body.get("time"):
                    _ROGUE_AUTO["time"] = str(body["time"])[:5]
                for k in ("rounds", "enemy_level"):
                    if body.get(k) not in (None, ""):
                        _ROGUE_AUTO[k] = int(float(body[k]))
                _rogue_auto_save()
                self._json(_rogue_auto_state())
                return
            if path == "/rogue/auto/run":
                threading.Thread(target=_rogue_auto_run, daemon=True).start()
                self._json({"ok": True,
                            "log": "已在后台执行整局重开(重摇+发布,约半分钟),稍后点「刷新」看新阵容/状态"})
                return
            if path == "/powerflip/spec":
                self._json(powerflip_set_spec(str(body.get("character", "")),
                                              body.get("speciality", 0),
                                              bool(body.get("dry_run"))))
                return
            if path == "/omni_element/set":
                self._json(omni_element_set(str(body.get("character", "")),
                                            bool(body.get("enable")),
                                            bool(body.get("dry_run"))))
                return
            if path == "/omni_convert":
                self._json(omni_convert(str(body.get("character", "")),
                                        bool(body.get("dry_run"))))
                return
            if path == "/powerflip/extract":
                self._json(powerflip_extract(str(body.get("kind", "")),
                                             bool(body.get("dry_run"))))
                return
            if path == "/powerflip/clone":
                self._json(powerflip_clone(str(body.get("src_kind", "")),
                                           str(body.get("new_id", "")),
                                           bool(body.get("dry_run"))))
                return
            if path == "/powerflip/compose":
                self._json(powerflip_compose(str(body.get("new_id", "")),
                                             str(body.get("base_kind", "")),
                                             list(body.get("donors") or []),
                                             str(body.get("character", "") or ""),
                                             bool(body.get("dry_run"))))
                return
            if path == "/raw_json/save":
                self._json(save_raw_json(str(body.get("table", "")),
                                         str(body.get("key", "")),
                                         str(body.get("json_text", "")),
                                         bool(body.get("dry_run"))))
                return
            if path == "/server/push":
                self._json(server_push())
                return
            if path == "/char_image_pos/save":
                self._json(save_char_image_pos(str(body.get("character", "")),
                                               str(body.get("level", "")),
                                               body.get("fs"), body.get("attr"),
                                               bool(body.get("dry_run"))))
                return
            if path == "/skill_dsl_upload":
                self._json(upload_skill_dsl(str(body.get("character", "")),
                                            str(body.get("level", "")),
                                            str(body.get("kind", "main")),
                                            str(body.get("json_text", "")),
                                            str(body.get("data_b64", "")),
                                            bool(body.get("dry_run"))))
                return
            if path == "/unique_condition/save":
                self._json(save_unique_condition(str(body.get("id", "")),
                                                 body.get("edits") or {},
                                                 str(body.get("icon_b64", "")),
                                                 bool(body.get("force_icon")),
                                                 bool(body.get("dry_run"))))
                return
            if path == "/shop/item/save":
                self._json(save_shop_item(str(body.get("cat", "")),
                                          str(body.get("id", "")),
                                          body.get("edits") or {},
                                          str(body.get("clone_from", "")),
                                          bool(body.get("dry_run"))))
                return
            if path == "/skill_dsl/save":
                self._json(save_skill_dsl(str(body.get("character", "")),
                                          str(body.get("level", "1")),
                                          body.get("edits") or [],
                                          bool(body.get("dry_run"))))
                return
            if path == "/char_snapshot":
                self._json(char_snapshot(str(body.get("character", "")),
                                         str(body.get("note", ""))))
                return
            if path == "/char_restore":
                self._json(char_restore(str(body.get("file", "")), bool(body.get("dry_run"))))
                return
            if path == "/char_clone":
                self._json(clone_character(str(body.get("src", "")), str(body.get("new_id", "")),
                                           str(body.get("new_name", "")), bool(body.get("dry_run")),
                                           str(body.get("new_code", ""))))
                return
            if path == "/char_delete":
                self._json(delete_character(str(body.get("cid", "")), bool(body.get("dry_run"))))
                return
            if path == "/asset/replace":
                import base64
                self._json(replace_asset(str(body.get("logical", "")),
                                         base64.b64decode(str(body.get("data_b64", ""))),
                                         bool(body.get("force")),
                                         bool(body.get("dry_run"))))
                return
            if path == "/skill_switch/save":
                self._json(save_skill_switch(str(body.get("character", "")),
                                             body.get("edits") or {},
                                             bool(body.get("dry_run"))))
                return
            if path == "/boss/save":
                res, written = wf_boss.boss_save(str(body.get("key", "")),
                                                 body.get("edits") or {},
                                                 bool(body.get("dry_run")))
                if written:
                    add_pending(written)
                    baks = sorted(written.parent.glob(written.name + ".bak-wfquest-*"))
                    record_change(wf_boss.BOSS_LEVEL, res.get("log", ""),
                                  baks[-1] if baks else None)
                self._json(res)
                return
            if path == "/asset/import_pack":
                self._json(import_asset_pack(str(body.get("character", "")),
                                             str(body.get("dir", "")),
                                             bool(body.get("force")),
                                             bool(body.get("dry_run"))))
                return
            if path == "/delete_line":
                self._json(delete_line(str(body.get("key", "")), int(body.get("line", 0)),
                                       bool(body.get("dry_run"))))
                return
            if path == "/mainpos_one":
                self._json(mainpos_one(str(body.get("ability", "")), int(body.get("line", 1)),
                                       str(body.get("action", "off")), bool(body.get("dry_run"))))
                return
            if path == "/weapon_ability/save":
                self._json(save_weapon_rows(body.get("edits") or [], bool(body.get("dry_run"))))
                return
            if path == "/status_values/save":
                self._json(save_status_values(
                    str(body.get("character", "")),
                    body.get("entries") or [],
                    bool(body.get("dry_run")),
                ))
                return
            if path == "/awake_values/save":
                self._json(save_awake_values(
                    str(body.get("character", "")),
                    body.get("atk_plus", 0),
                    body.get("hp_plus", 0),
                    bool(body.get("dry_run")),
                ))
                return
            if path == "/toolbox/run":
                self._json(toolbox_run(str(body.get("tool", "")), body.get("args") or {}))
                return
            if path == "/toolbox/cancel":
                self._json(toolbox_cancel())
                return
            self._json({"error": "not found"}, 404)
        except Exception as exc:
            self._json({"error": str(exc)}, 500)


def make_server() -> tuple[ThreadingHTTPServer, int]:
    """8765 被占用/被系统保留(WinError 10013)时自动尝试备用端口。"""
    last_error: Exception | None = None
    candidates = [GUI_PORT, 8766, 8876, 9797, 18765, 28765, 0]
    for port in candidates:
        try:
            server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            return server, server.server_address[1]
        except OSError as exc:
            last_error = exc
    raise SystemExit(f"无法绑定任何端口: {last_error}")


def main() -> None:
    server, port = make_server()
    if port != GUI_PORT:
        print(f"(端口 {GUI_PORT} 不可用,已改用 {port})")
    print(f"WF 修改器已启动: http://127.0.0.1:{port}/")
    print(f"目标数据包: {TARGET_STORE}")
    print(f"模拟器: {DEVICE}  包名: {PKG}")
    print("按 Ctrl+C 退出")
    try:
        import webbrowser
        webbrowser.open(f"http://127.0.0.1:{port}/")
    except Exception:
        pass
    server.serve_forever()


if __name__ == "__main__":
    main()
