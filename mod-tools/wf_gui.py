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

import io
import json
import os
import shutil
import subprocess
import sys
import time
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

ELEMENTS = {"0": "火", "1": "水", "2": "雷", "3": "风", "4": "光", "5": "暗"}


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
            "element": ELEMENTS.get(str(row[3]), str(row[3])),
            "race": row[4],
            "role": row[26],
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
    (见版本切换设计.md)。"""
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
            elem_cn = next((c["element"] for c in load_characters() if c["id"] == dkey), "")
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


def _char_json_paths() -> tuple[Path, Path]:
    return CDNDATA / "character.json", CDNDATA / "character_text.json"


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
            "element_name": ELEMENTS.get(str(fields.get("element", "")), fields.get("element", ""))}


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
        norm[f] = val
        write(src, idx, val)

    # ---- ②层:同列写 character / character_text(客户端显示与战斗读这里) ----
    l2 = {"master": None, "text": None}   # 有变更的表对象,写盘阶段用
    l2_parsed = {}
    for src_kind, logical in (("master", core.CHARACTER_LOGICAL), ("text", CHAR_TEXT2_LOGICAL)):
        fields = {f: v for f, v in norm.items() if CHAR_FIELD_MAP[f][0] == src_kind}
        if not fields:
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
        for f, val in fields.items():
            idx = CHAR_FIELD_MAP[f][1]
            while len(row) <= idx:
                row.append("")
            if row[idx] != val:
                log.append(f"②{src_kind}[{idx}] {row[idx]!r} -> {val!r}")
                row[idx] = val
                changed = True
        if changed:
            l2[src_kind] = table
            l2_parsed[src_kind] = parsed

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


# ---------------------------------------------------------------- 技能形态切换
# 机制(CharacterValues.as 逆向,见 技能形态切换与资产包导入结论.md):
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
    if logical.endswith(".png"):
        if data[:8] != wf_assets.PNG_REAL:
            raise ValueError("上传的不是标准 PNG 文件(魔数不对)")
        nd = wf_assets.png_dims(data)
        od = wf_assets.png_dims(old)
        if od and nd != od and not force:
            raise ValueError(f"尺寸不匹配:原图 {od[0]}x{od[1]},上传 {nd[0]}x{nd[1]}。"
                             f"sprite sheet/图集类必须同尺寸同布局;立绘可勾选「强制」替换"
                             f"(游戏按原 pivot/缩放摆放,尺寸差异会导致偏移)")
        enc = wf_assets.png_encode(data)
        log.append(f"{logical}: PNG {od[0]}x{od[1]}→{nd[0]}x{nd[1]}, {len(old)}B→{len(enc)}B [{root_name}]")
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
        record_change(logical, "\n".join(log), bak)
        written = str(fp)
    return {"changes": 1, "log": "\n".join(log), "written": written,
            "dry_run": dry_run, "root": root_name}


# 提取器自产物(datamine 工具切帧/转GIF/解码JSON/缩放图),游戏 store 无对应文件,导入时静默跳过
_PACK_ARTIFACT_DIRS = ("/animated/", "/sprite_sheet/", "/special_sprite_sheet/")
_PACK_ARTIFACT_SUFFIX = (".gif", ".json")


def import_asset_pack(character: str, src_dir: str, force: bool, dry_run: bool) -> dict:
    """全资产包批量导入:datamine 解包目录(相对路径 = character/<code>/ 下的逻辑路径)
    一比一替换到 store。逐文件走 replace_asset(校验/混淆编码/备份/进 pending/改动日志),
    命不中 store 的路径跳过并报告。"""
    c = next((x for x in load_characters() if x["id"] == str(character)), None)
    if not c:
        raise ValueError(f"角色不存在: {character}")
    code = c["code_name"]
    base = Path(src_dir).expanduser()
    if not base.is_dir():
        raise ValueError(f"目录不存在: {src_dir}")
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
                    + ("(dry-run 预览,未写入)" if dry_run else ";已备份+进待发布,点「发布并重启游戏」生效")}


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


def get_skill_dsl_json(character: str, level: str) -> dict:
    """整棵技能 DSL 命令树导出为 JSON 文本(AMF3 序列化器已全库 1035 文件字节级往返验证)。"""
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


def save_skill_dsl_json(character: str, level: str, json_text: str, dry_run: bool) -> dict:
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


def restart_game() -> str:
    """force-stop + 拉起游戏(发布后让客户端立刻拉增量包)。"""
    adb = find_adb()
    if not adb:
        return "未找到 adb,请手动重启游戏拉取更新"
    log = []
    _, out = adb_run(adb, "connect", DEVICE, timeout=15)
    log.append(f"connect {DEVICE}: {out}")
    adb_run(adb, "-s", DEVICE, "shell", "am", "force-stop", PKG, timeout=20)
    log.append(f"force-stop {PKG}")
    code, out = adb_run(adb, "-s", DEVICE, "shell", "am", "start", "-n", f"{PKG}/.AppEntry", timeout=20)
    if code != 0 or "Error" in out:
        _, out2 = adb_run(adb, "-s", DEVICE, "shell", "monkey", "-p", PKG,
                          "-c", "android.intent.category.LAUNCHER", "1", timeout=20)
        log.append(f"start(monkey): {out2}")
    else:
        log.append(f"start: {out}")
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


# ---------------------------------------------------------------- http server


def read_page() -> bytes:
    html_path = Path(__file__).resolve().parent / "wf_gui.html"
    return html_path.read_bytes()


# API 前缀规范(为并入服务端后台准备,见 API.md):
#   标准:/api/mod/*  —— 将来 Fastify 只反代这一个前缀,与服务端自身 /api/* 零冲突
#   兼容:/api/*      —— 旧路径仍可用(标记 deprecated),迁移期后可删
API_PREFIX = "/api/mod"


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
            if path == "/souls":
                self._json(list_souls())
                return
            if path == "/boss/list":
                self._json(wf_boss.boss_list())
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
                                              (qs.get("level") or [""])[0]))
                return
            if path == "/skill_dsl":
                self._json(get_skill_dsl((qs.get("character") or [""])[0],
                                         (qs.get("level") or ["1"])[0]))
                return
            if path == "/char_assets":
                self._json(char_assets((qs.get("character") or [""])[0]))
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
