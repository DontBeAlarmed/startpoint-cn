# -*- coding: utf-8 -*-
"""wf_boss — Boss 数值编辑 + 全副本列表(GUI「Boss·副本」页后端)。

数据链路(见 docs/boss战与副本分析报告.md):
    quest 行 → (任意单元格 ∈ field_data 键) → field_data col2 = zone id
      → zone 各 wave 行单元格 ∈ boss 键集合 → boss code
    HP = boss_level[code] 基础值 × 等级曲线(battle/enemy/*)×修正曲线;
    boss_level 列(BossLevelValues.as 逆向):
      col0 hp模式: 0=Hit(col1曲线,col2基础值,col3系数,col4修正曲线)
                   1=Fix(col1曲线,col5基础值,col6系数)
      col7 atk基础曲线  col8 atk打点数  col9 atk修正值  col10 atk修正曲线
      col11 tp曲线  col12 tp基础值
    改血量 = 改基础值/系数(等比生效于全部等级),发布 boss_level 后生效。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

MOD_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(MOD_DIR))
import wf_quest_lib as qlib  # noqa: E402

BOSS_LEVEL = "master/battle/boss/boss_level.orderedmap"
GENERAL_BOSS = "master/battle/boss/general_boss.orderedmap"
STANDARD_BOSS = "master/battle/boss/standard_boss.orderedmap"
ZONE = "master/battle/zone.orderedmap"
FIELD_DATA = "master/battle/field_data.orderedmap"

# (别名, 中文名, 逻辑路径, 分组, 图标)——22 类副本表(boot 注册路径 + master 前缀)
QUEST_CATS = [
    ("boss_battle", "领主战", "master/quest/boss_battle_quest.orderedmap", "常驻", "👑"),
    ("main", "主线", "master/quest/main_quest.orderedmap", "常驻", "📖"),
    ("ex", "高难EX", "master/quest/ex_quest.orderedmap", "常驻", "🔥"),
    ("character", "角色剧情", "master/quest/character_quest.orderedmap", "常驻", "🎭"),
    ("practice", "训练场", "master/quest/practice/practice_quest.orderedmap", "常驻", "🎯"),
    ("advent", "降临战", "master/quest/event/advent_event_quest.orderedmap", "高难活动", "☄️"),
    ("raid", "Raid", "master/quest/event/raid_event_quest.orderedmap", "高难活动", "⚔️"),
    ("rush", "Rush", "master/quest/event/rush_event_quest.orderedmap", "高难活动", "🌊"),
    ("hard_multi", "高难多人", "master/quest/event/hard_multi_event_quest.orderedmap", "高难活动", "👥"),
    ("expert_single", "专家单人", "master/quest/event/expert_single_event_quest.orderedmap", "高难活动", "🥇"),
    ("ranking", "排名赛", "master/quest/event/ranking_event_single_quest.orderedmap", "高难活动", "🏆"),
    ("score_attack", "分数挑战", "master/quest/event/score_attack_event_quest.orderedmap", "高难活动", "💯"),
    ("solo_time_attack", "单人计时", "master/quest/event/solo_time_attack_event_quest.orderedmap", "高难活动", "⏱️"),
    ("carnival", "嘉年华", "master/quest/event/carnival_event_quest.orderedmap", "活动周回", "🎪"),
    ("challenge_dungeon", "挑战迷宫", "master/quest/event/challenge_dungeon_event_quest.orderedmap", "活动周回", "🗝️"),
    ("tower", "爬塔", "master/quest/event/tower_dungeon_event_quest.orderedmap", "活动周回", "🗼"),
    ("daily_exp_mana", "经验玛那", "master/quest/event/daily_exp_mana_event_quest.orderedmap", "活动周回", "💎"),
    ("daily_week", "每日周常", "master/quest/event/daily_week_event_quest.orderedmap", "活动周回", "📅"),
    ("story_event", "剧情活动", "master/quest/event/story_event_single_quest.orderedmap", "剧情·其他", "📜"),
    ("world_story", "世界剧情", "master/quest/event/world_story_event_quest.orderedmap", "剧情·其他", "🌍"),
    ("world_story_boss", "世界剧情Boss", "master/quest/event/world_story_event_boss_battle_quest.orderedmap", "剧情·其他", "🐲"),
    ("skill_preview", "技能预览", "master/skill_preview/skill_preview_quest.orderedmap", "剧情·其他", "🎬"),
]

_CJK = re.compile(r"[㐀-鿿]")

# ---- 表缓存(按 mtime 失效;GUI 反复刷新不重复解析) ----
_cache: dict[str, tuple[float, dict]] = {}


def _load(logical: str) -> dict:
    p = qlib.store_path(logical)
    mt = p.stat().st_mtime
    hit = _cache.get(logical)
    if hit and hit[0] == mt:
        return hit[1]
    tree = qlib.load_table(logical)
    _cache[logical] = (mt, tree)
    return tree


def _leaves(node, path=()):
    if isinstance(node, str):
        yield path, node
    else:
        for k, v in node.items():
            yield from _leaves(v, path + (k,))


# ---------------------------------------------------------------- boss 名录

def _row_name(row: str) -> str:
    """boss 行取中文名:固定属性 col1;六属性复用 col3/5/7...(名,动画)对。"""
    c = row.split(",")
    if len(c) > 1 and _CJK.search(c[1] or ""):
        return c[1]
    names = [x for x in c[3:15:2] if x and _CJK.search(x)]
    if names:
        uniq = list(dict.fromkeys(names))
        return uniq[0] if len(uniq) == 1 else "/".join(uniq)[:48]
    for x in c:
        if x and _CJK.search(x):
            return x
    return ""


def boss_names() -> dict[str, str]:
    """boss code -> 中文名(general_boss + standard_boss)。"""
    out: dict[str, str] = {}
    gb = _load(GENERAL_BOSS)
    for k, node in gb.items():
        row = next((v for v in node.values() if isinstance(v, str)), "") if isinstance(node, dict) else node
        out[k] = _row_name(row or "")
    try:
        sb = _load(STANDARD_BOSS)
        for k, node in sb.items():
            if k not in out and isinstance(node, str):
                out[k] = _row_name(node)
    except Exception:
        pass
    return out


# ---------------------------------------------------------------- boss 数值

_NUM_FIELDS = ("hp_value", "hp_coef", "atk_hits", "atk_corr", "tp_value")


def _parse_boss_level_row(row: str) -> dict:
    c = row.split(",")

    def g(i):
        return c[i] if i < len(c) else ""

    kind = "hit" if g(0) == "0" else "fix"
    return {
        "kind": kind,
        "hp_curve": g(1),
        "hp_value": g(2) if kind == "hit" else g(5),
        "hp_coef": g(3) if kind == "hit" else g(6),
        "hp_corr": g(4) if kind == "hit" else "",
        "atk_curve": g(7), "atk_hits": g(8), "atk_corr": g(9), "atk_corr_curve": g(10),
        "tp_curve": g(11), "tp_value": g(12),
    }


def boss_list() -> dict:
    bl = _load(BOSS_LEVEL)
    gb = _load(GENERAL_BOSS)
    names = boss_names()
    out = []
    for k, row in bl.items():
        if not isinstance(row, str):
            continue
        item = {"key": k, "name": names.get(k, "")}
        item.update(_parse_boss_level_row(row))
        node = gb.get(k)
        item["levels"] = list(node) if isinstance(node, dict) else []
        out.append(item)
    return {"bosses": out,
            "note": "HP=基础值×等级曲线×修正曲线;改「基础值」即等比调血(Hit 模式基础值≈打点数)。"
                    "atk打点数/修正值同理;改完点「发布并重启游戏」生效"}


def boss_save(key: str, edits: dict, dry_run: bool) -> tuple[dict, Path | None]:
    """改 boss_level 数值列。edits: {hp_value/hp_coef/atk_hits/atk_corr/tp_value: 数值}。
    返回 (结果, 写入路径或 None);备份由 qlib.save_table 负责,pending/日志由调用方(GUI)负责。"""
    bl = _load(BOSS_LEVEL)
    if key not in bl or not isinstance(bl[key], str):
        raise ValueError(f"boss_level 表中没有 {key}")
    c = bl[key].split(",")
    while len(c) < 13:
        c.append("")
    kind = "hit" if c[0] == "0" else "fix"
    colmap = {"hp_value": 2 if kind == "hit" else 5,
              "hp_coef": 3 if kind == "hit" else 6,
              "atk_hits": 8, "atk_corr": 9, "tp_value": 12}
    log = []
    for f in _NUM_FIELDS:
        if f not in edits or edits[f] in ("", None):
            continue
        try:
            v = float(edits[f])
        except (TypeError, ValueError):
            raise ValueError(f"{f} 必须是数值: {edits[f]!r}")
        if not (0 <= v < 2**31):
            raise ValueError(f"{f} 超出范围 0~2^31: {v}")
        sv = str(int(v)) if v == int(v) else str(v)
        i = colmap[f]
        if c[i] != sv:
            log.append(f"{key} {f}[col{i}] {c[i]!r} -> {sv!r}")
            c[i] = sv
    written = None
    if log and not dry_run:
        # 重新加载完整树再改目标行,避免缓存树被就地污染后 dry-run 状态不一致
        tree = qlib.load_table(BOSS_LEVEL)
        tree[key] = ",".join(c)
        written = qlib.save_table(BOSS_LEVEL, tree)
        _cache.pop(BOSS_LEVEL, None)
    return ({"changes": len(log), "log": "\n".join(log), "dry_run": dry_run,
             "written": str(written) if written else None}, written)


# ---------------------------------------------------------------- 副本列表

def _fd_zone(fdid: str) -> str:
    fd = _load(FIELD_DATA)
    row = fd.get(fdid)
    if isinstance(row, str):
        c = row.split(",")
        if len(c) > 2:
            return c[2]
    return ""


def _zone_bosses(zone_id: str, boss_keys: set[str]) -> list[str]:
    zn = _load(ZONE)
    node = zn.get(zone_id)
    if node is None:
        return []
    found: list[str] = []
    rows = node.values() if isinstance(node, dict) else [node]
    for r in rows:
        if not isinstance(r, str):
            continue
        for cell in r.split(","):
            if cell in boss_keys and cell not in found:
                found.append(cell)
    return found


def quest_cats(with_counts: bool = True) -> list[dict]:
    out = []
    for alias, cn, logical, group, icon in QUEST_CATS:
        exists = qlib.store_path(logical).exists()
        ent = {"alias": alias, "cn": cn, "exists": exists, "group": group, "icon": icon}
        if exists and with_counts:
            try:
                ent["count"] = sum(1 for _ in _leaves(_load(logical)))
            except Exception:
                ent["count"] = None
        out.append(ent)
    return out


# ---- boss → 出现的副本类别(全类别扫描一次,进程内缓存;force 重算) ----
_usage_cache: dict[str, list[str]] | None = None


def boss_usage(force: bool = False) -> dict[str, list[str]]:
    """boss code -> [出现的副本类别 alias 列表](按 QUEST_CATS 顺序)。"""
    global _usage_cache
    if _usage_cache is not None and not force:
        return _usage_cache
    fd_keys = set(_load(FIELD_DATA).keys())
    boss_keys = set(boss_names().keys())
    usage: dict[str, list[str]] = {}
    for alias, _cn, logical, _group, _icon in QUEST_CATS:
        if not qlib.store_path(logical).exists():
            continue
        try:
            tree = _load(logical)
        except Exception:
            continue
        seen: set[str] = set()
        for _path, row in _leaves(tree):
            cells = row.split(",")
            fdid = next((x for x in cells if x in fd_keys), "")
            if not fdid:
                continue
            seen.update(_zone_bosses(_fd_zone(fdid), boss_keys))
        for b in seen:
            usage.setdefault(b, []).append(alias)
    _usage_cache = usage
    return usage


def quest_list(cat: str, search: str = "", limit: int = 400) -> dict:
    ent = next((x for x in QUEST_CATS if x[0] == cat), None)
    if not ent:
        raise ValueError(f"未知副本类别: {cat}")
    _, cn, logical = ent[:3]
    tree = _load(logical)
    fd_keys = set(_load(FIELD_DATA).keys())
    boss_keys = set(boss_names().keys())
    names = boss_names()
    s = (search or "").strip().lower()
    rows, total = [], 0
    for path, row in _leaves(tree):
        cells = row.split(",")
        qid = cells[0] if cells else ""
        name = next((x for x in cells[1:7] if x and _CJK.search(x)), "")
        name = name.replace("::quest_rank::", "").strip()
        total += 1
        if s and s not in name.lower() and s not in qid.lower() and s not in "/".join(path).lower():
            continue
        if len(rows) >= limit:
            continue
        fdid = next((x for x in cells if x in fd_keys), "")
        bosses = _zone_bosses(_fd_zone(fdid), boss_keys) if fdid else []
        rows.append({"path": "/".join(path), "id": qid, "name": name,
                     "bosses": [{"key": b, "name": names.get(b, "")} for b in bosses]})
    return {"cat": cat, "cn": cn, "total": total, "shown": len(rows), "rows": rows}
