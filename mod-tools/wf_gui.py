#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
WF 单机版 · 本地网页修改器 (GUI)

在浏览器中修改 WorldFlipper/dummy 数据包:
  * 角色技能倍率缩放(基于 wf_mod_tool 的 scale 配方)
  * 词条(ability)逐字段编辑
  * 词条移植(copy_ability,角色 A -> 角色 B)
  * 备份 / 还原
  * 一键同步到 MuMu 模拟器(adb push 增量 + 重启游戏)

启动:  python mod-tools/wf_gui.py   (或 mod-tools\wf-gui.bat)
浏览器: http://127.0.0.1:8765/

环境变量(可选):
  WF_TARGET_STORE  目标 upload 目录(默认自动在项目根目录查找)
  WF_ADB           adb.exe 完整路径
  WF_ADB_PORT      模拟器 adb 端口(默认 16384 = MuMu 12)
  WF_PKG           游戏包名(默认 air.com.leiting.wf)
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

ROOT = Path(__file__).resolve().parent.parent
_PROFILE = core.resolve_profile(os.environ.get("WF_PROFILE"))
CDNDATA = (_PROFILE.cdndata if _PROFILE and _PROFILE.cdndata else ROOT / "assets" / "cdndata")
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
    rel = target.relative_to(TARGET_STORE).as_posix()
    items = read_pending()
    if rel not in items:
        items.append(rel)
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    PENDING_FILE.write_text(json.dumps(items, indent=2), encoding="utf-8")


def clear_pending() -> None:
    if PENDING_FILE.exists():
        PENDING_FILE.write_text("[]", encoding="utf-8")


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
    """从 character 表按 char_id 列查队长技称号(第18列)。"""
    ct = load_char_table()
    if not ct:
        return ""
    for text in ct.text_rows().values():
        rows = core.read_csv_lines(text)
        if rows and len(rows[0]) > 18 and rows[0][17] == str(character):
            return rows[0][18]
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
                     "desc": describe_ability(lines, idx_by)})

    # 队长技(leader_ability 表,键=角色ID),伪槽 "L:<id>"
    try:
        leader = core.load_table(LEADER_LOGICAL, TARGET_STORE, SOURCE_STORE)
        lt = leader.text_rows().get(str(character))
        if lt is not None:
            lines = make_lines(lt)
            rows.append({"ability": f"L:{character}", "missing": False, "leader": True,
                         "lines": lines, "desc": describe_ability(lines, idx_by)})
        else:
            rows.append({"ability": f"L:{character}", "missing": True, "leader": True,
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
    return written


def save_row_edits(edits: list[dict], dry_run: bool) -> dict:
    """edits: [{ability, line, index, value}];ability 以 "L:" 开头时写 leader_ability 表。"""
    schema = load_schema()
    names = core.schema_names(schema)
    table = load_ability_table()
    leader = core.load_table(LEADER_LOGICAL, TARGET_STORE, SOURCE_STORE)
    parsed_a = {k: core.read_csv_lines(t) for k, t in table.text_rows().items()}
    parsed_l = {k: core.read_csv_lines(t) for k, t in leader.text_rows().items()}
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
        row = core.normalize_row_length(parsed[key][line - 1], len(names))
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
    """单个效果(行)级移植。src/dst: {key, line};key 前缀 "L:" 表示队长技表。
    dst mode: line=N 覆盖该行 / "append" 追加 / "all" 整键替换为这一行。"""
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

    sp, stag, skey = pick(src["key"])
    dp, dtag, dkey = pick(dst["key"])
    if skey not in sp:
        raise ValueError(f"来源不存在: {src['key']}")
    if dkey not in dp:
        raise ValueError(f"目标不存在: {dst['key']}")
    srow = core.normalize_row_length(list(sp[skey][int(src.get("line", 1)) - 1]), len(names))
    sid_idx = idx_by.get("string_id", 0)
    uni_idx = idx_by.get("unisonable", 1)
    if srow[uni_idx] in ("0", "1", "false", ""):
        srow[uni_idx] = "true"
    mode = dst.get("line", "all")
    old_rows = [core.normalize_row_length(list(r), len(names)) for r in dp[dkey]]
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
    written = []
    if not dry_run:
        dp[dkey] = old_rows
        if dtag == "a":
            written.append(str(_write_with_backup(table, parsed_a, log_lines)))
        else:
            written.append(str(_write_with_backup(leader, parsed_l, log_lines)))
    return {"changes": 1, "log": "\n".join(log_lines),
            "written": "; ".join(written) or None, "dry_run": dry_run}


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
    """把 from_character 的队长技(leader_ability 表)复制为 to_character 的第 slot 个词条。"""
    schema = load_schema()
    names = core.schema_names(schema)
    index_by_name = core.schema_index(schema)
    leader = core.load_table(LEADER_LOGICAL, TARGET_STORE, SOURCE_STORE)
    table = load_ability_table()
    char_table = load_char_table()

    from_character = str(from_character)
    src_text = leader.text_rows().get(from_character)
    if src_text is None:
        raise ValueError(f"leader_ability 表中没有角色 {from_character}")
    src_rows = [core.normalize_row_length(r, len(names))
                for r in core.read_csv_lines(src_text)]

    target_ids = core.ability_ids_for_character(to_character, char_table)
    if not (1 <= int(slot) <= len(target_ids)):
        raise ValueError(f"槽位越界: {slot}")
    dst_key = target_ids[int(slot) - 1]
    parsed = {k: core.read_csv_lines(t) for k, t in table.text_rows().items()}
    if dst_key not in parsed:
        raise ValueError(f"目标词条不存在于数据包: {dst_key}")

    old_rows = [core.normalize_row_length(list(r), len(names)) for r in parsed[dst_key]]
    sid_idx = index_by_name.get("string_id", 0)
    uni_idx = index_by_name.get("unisonable", 1)
    new_rows = [list(r) for r in src_rows]
    log_lines = []
    for i, row in enumerate(new_rows):
        if preserve_string_id and i < len(old_rows):
            row[sid_idx] = old_rows[i][sid_idx]
        # leader 表的 unisonable 是 0/1,统一为 true 以免主位限制
        if row[uni_idx] in ("0", "1", "false", ""):
            row[uni_idx] = "true"
    log_lines.append(f"{from_character} 队长技 ({len(new_rows)} 行) -> {dst_key} (槽位 {slot})")

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
    out = []
    for k, t in table.text_rows().items():
        rows = core.read_csv_lines(t)
        r0 = core.normalize_row_length(rows[0], len(names)) if rows else []
        out.append({"id": k, "string_id": r0[0] if r0 else "",
                    "rarity": r0[rarity_idx] if r0 else "", "lines": len(rows)})
    out.sort(key=lambda s: s["id"])
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
            "desc": describe_ability(lines, idx_by)}


def _save_single_table_edits(logical: str, edits: list[dict], dry_run: bool, bak_tag: str) -> dict:
    """通用单表逐字段保存:edits=[{key,line,index,value}]。走 pending(② 层需同步)。"""
    schema = load_schema()
    names = core.schema_names(schema)
    table = core.load_table(logical, TARGET_STORE, SOURCE_STORE)
    parsed = {k: core.read_csv_lines(t) for k, t in table.text_rows().items()}
    log_lines = []
    changes = 0
    for e in edits:
        key, line, idx, value = str(e["key"]), int(e["line"]), int(e["index"]), str(e["value"])
        if key not in parsed:
            raise ValueError(f"键不存在: {key}")
        if line < 1 or line > len(parsed[key]):
            raise ValueError(f"行号越界: {key} line {line}")
        row = core.normalize_row_length(parsed[key][line - 1], len(names))
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
    return {"changes": changes, "log": "\n".join(log_lines),
            "written": str(written) if written else None, "dry_run": dry_run}


def save_soul_rows(edits: list[dict], dry_run: bool) -> dict:
    return _save_single_table_edits(SOUL_LOGICAL, edits, dry_run, ".bak-wfmod-soul-")


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
    return {"changes": changes, "log": "\n".join(l for l in log_lines if l),
            "written": str(written) if written else None, "dry_run": dry_run}


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


def save_char_fields(cid: str, edits: dict, dry_run: bool) -> dict:
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
            log.append(f"{src}[{idx}] {arr[idx]!r} -> {val!r}")
            arr[idx] = val

    for f, val in edits.items():
        if f not in CHAR_FIELD_MAP:
            continue
        src, idx = CHAR_FIELD_MAP[f]
        val = str(val)
        if f == "element":
            val = rev_el.get(val, val)  # 中文名 -> 0-5
        write(src, idx, val)

    written = None
    if not dry_run and log:
        global _char_cache
        suffix = ".bak-charfields-" + time.strftime("%Y%m%d-%H%M%S")
        for p in (mp, tp):
            shutil.copy2(p, p.with_name(p.name + suffix))
        mp.write_text(json.dumps(master, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        tp.write_text(json.dumps(text, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        written = str(mp)
        _char_cache = None  # 名录已变,清缓存使左侧列表刷新
    return {"changes": len(log), "log": "\n".join(log), "written": written, "dry_run": dry_run,
            "note": "① 层已改;重启服务端后客户端 /load 生效(此改动不走模拟器同步)"}


# ---------------------------------------------------------------- backups


def tracked_tables() -> list[tuple[str, Path]]:
    return [
        ("ability", core.table_path(TARGET_STORE, core.ABILITY_LOGICAL)),
        ("character", core.table_path(TARGET_STORE, core.CHARACTER_LOGICAL)),
    ]


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
            shutil.copy2(cand, table)
            add_pending(table)
            return {"restored": name, "table": label, "target": str(table)}
    raise ValueError(f"未找到备份: {name}")


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
        local = TARGET_STORE / rel
        if not local.exists():
            log.append(f"跳过(本地缺失): {rel}")
            continue
        remote = f"{REMOTE_UPLOAD}/{rel}"
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

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
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
            if path == "/backups":
                self._json(list_backups())
                return
            if path == "/mainpos":
                self._json(mainpos("status"))
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
