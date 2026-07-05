#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
WF mod 发布器:把改动的数据表打成客户端增量包(diff zip),经服务端 CDN 下发。

原理(与官方增量更新同构):
  客户端 POST /get_path 报当前 res_ver → 服务端返回 archive-*-diff 里的
  pinball-<from>-<to>-N-<tag>.zip 列表 → 客户端下载高于自己版本的包,
  解包 production/upload/<xx>/<hash> 覆盖本地 → res_ver 升级。
  因此:把改好的表按同样结构打包、版本号 +0.0.1,客户端重启即自动拉取。
  (服务端 buildDiffList 每次请求动态扫描,放入 zip 即生效,无需重启服务端。)

用法:
  python mod-tools/wf_publish.py                 # 发布 pending 列表里的文件
  python mod-tools/wf_publish.py --tables ability,character_status
  python mod-tools/wf_publish.py --list          # 只看将发布什么/版本推进
注意:CN 表含觉醒列(col3/4 awake_kind),打包为原样字节复制,不做重编码。
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import time
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import wf_mod_tool as core  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CDN_DIFF = ROOT / ".cdn" / "cn" / "archive-common-diff"
WORK = Path(__file__).resolve().parent / "work"
PENDING = WORK / "sync_pending.json"
CHANGELOG = WORK / "changelog.jsonl"
CHANGELOG_MD = WORK / "changelog.md"


def stamp_changelog(version: str) -> int:
    """把日志里所有未发布(version=None)的条目标记为本次版本,并渲染 changelog.md。"""
    if not CHANGELOG.exists():
        return 0
    entries, n = [], 0
    for line in CHANGELOG.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
        except Exception:
            continue
        if e.get("version") is None:
            e["version"] = version
            n += 1
        entries.append(e)
    CHANGELOG.write_text(
        "\n".join(json.dumps(e, ensure_ascii=False) for e in entries) + "\n", encoding="utf-8")
    md = ["# WF Mod 改动日志", "",
          "| 时间 | 表 | 键 | 改动 | 发布版本 | 备份(回溯用) |",
          "|---|---|---|---|---|---|"]
    for e in reversed(entries):
        keys = ",".join(e.get("keys") or []) or "-"
        summ = (e.get("summary") or "").replace("\n", " / ").replace("|", "/")
        bak = Path(e["backup"]).name if e.get("backup") else "-"
        md.append(f"| {e.get('ts','')} | {e.get('table','')} | {keys} | {summ} | {e.get('version') or '(未发布)'} | {bak} |")
    CHANGELOG_MD.write_text("\n".join(md) + "\n", encoding="utf-8")
    return n

TABLE_ALIASES = {
    "ability": core.ABILITY_LOGICAL,
    "character": core.CHARACTER_LOGICAL,
    "character_status": core.STATUS_LOGICAL,
    "leader_ability": "master/ability/leader_ability.orderedmap",
    "ability_soul": "master/ability/ability_soul.orderedmap",
    "character_awake_status": "master/character/character_awake_status.orderedmap",
    "action_skill": "master/skill/action_skill.orderedmap",
    "weapon_ability": "master/equipment_enhancement/equipment_enhancement_ability.orderedmap",
    "character_text": "master/character/character_text.orderedmap",
    "character_speech": "master/character/character_speech.orderedmap",
    "skill_preview_character": "master/skill_preview/skill_preview_character.orderedmap",
    "mana_board2_open_condition": "master/mana_board/mana_board2_open_condition.orderedmap",
    "upskill": "master/mana_board/upskill.orderedmap",
    "character_stance_detail": "master/stance_detail/character_stance_detail.orderedmap",
    "character_image": "master/generated/character_image.orderedmap",
    "full_shot_image_attribute": "master/character/full_shot_image_attribute.orderedmap",
    "mana_board": "master/generated/mana_board.orderedmap",
    "mana_node": "master/mana_board/mana_node.orderedmap",
    "character_gacha_sound": "master/character/character_gacha_sound.orderedmap",
    # --- boss 战 / 副本 / 连战(roguelike boss rush 方案用,见 boss连战roguelike方案.md) ---
    "general_boss": "master/battle/boss/general_boss.orderedmap",
    "general_boss_state": "master/battle/boss/general_boss_state.orderedmap",
    "general_boss_variable": "master/battle/boss/general_boss_variable.orderedmap",
    "boss_level": "master/battle/boss/boss_level.orderedmap",
    "standard_boss": "master/battle/boss/standard_boss.orderedmap",
    "general_zako": "master/battle/zako/general_zako.orderedmap",
    "zako_level": "master/battle/zako/zako_level.orderedmap",
    "zone": "master/battle/zone.orderedmap",
    "field_data": "master/battle/field_data.orderedmap",
    "field": "master/battle/field.orderedmap",
    "boss_battle_quest": "master/quest/boss_battle_quest.orderedmap",
    "boss_battle_stage_node": "master/quest/boss_battle_stage_node.orderedmap",
    "rush_event": "master/quest/event/rush_event.orderedmap",
    "rush_event_quest": "master/quest/event/rush_event_quest.orderedmap",
    "rush_event_quest_folder": "master/quest/event/rush_event_quest_folder.orderedmap",
    "rush_event_correction": "master/quest/event/rush_event_battle_quest_correction.orderedmap",
    "event_list": "master/quest/event/event_list.orderedmap",
}

VER_RE = re.compile(r"pinball-(\d+\.\d+\.\d+)-(\d+\.\d+\.\d+)-\d+-")


def current_max_version(default: str = "1.4.54") -> str:
    best = default
    for f in CDN_DIFF.glob("*.zip"):
        m = VER_RE.match(f.name)
        if m and _cmp(m.group(2), best) > 0:
            best = m.group(2)
    return best


def _cmp(a: str, b: str) -> int:
    av = [int(x) for x in a.split(".")]
    bv = [int(x) for x in b.split(".")]
    for x, y in zip(av, bv):
        if x != y:
            return x - y
    return 0


def bump(v: str) -> str:
    p = v.split(".")
    return f"{p[0]}.{p[1]}.{int(p[2]) + 1}"


def collect_files(args) -> list[str]:
    """返回相对 upload 的 'xx/hash' 列表。"""
    rels: list[str] = []
    if args.tables:
        for t in args.tables.split(","):
            t = t.strip()
            logical = TABLE_ALIASES.get(t, t)
            digest = core.sha1_path(logical)
            rels.append(f"{digest[:2]}/{digest[2:]}")
    else:
        try:
            rels = json.loads(PENDING.read_text(encoding="utf-8"))
        except Exception:
            rels = []
    return rels


def main() -> None:
    ap = argparse.ArgumentParser(description="WF mod diff 发布器")
    ap.add_argument("--tables", help="逗号分隔的表别名/逻辑路径(默认用 pending 列表)")
    ap.add_argument("--list", action="store_true", help="只显示将发布的内容,不打包")
    ap.add_argument("--from-ver", help="覆盖起始版本(默认=CDN 现有最高版本)")
    args = ap.parse_args()

    profile = core.resolve_profile()
    store = profile.store if profile else core.default_target_store()
    if not store:
        raise SystemExit("未找到数据包 store")

    rels = collect_files(args)
    if not rels:
        raise SystemExit("没有待发布文件(pending 为空且未指定 --tables)")

    from_ver = args.from_ver or current_max_version()
    to_ver = bump(from_ver)

    print(f"数据源 store : {store}")
    print(f"版本推进     : {from_ver} -> {to_ver}")
    print("将发布文件   :")
    # 三根分组:pending 里 medium:/android: 前缀 → 各自 diff 目录(与官方增量同构)
    group_defs = {
        "": (store, CDN_DIFF, "production/upload"),
        "medium:": (store.parent / "medium_upload",
                    ROOT / ".cdn" / "cn" / "archive-medium-diff", "production/medium_upload"),
        "android:": (store.parent / "android_upload",
                     ROOT / ".cdn" / "cn" / "archive-android-diff", "production/android_upload"),
    }
    grouped: dict[str, list[tuple[Path, str]]] = {k: [] for k in group_defs}
    for rel in rels:
        pre = next((p for p in ("medium:", "android:") if rel.startswith(p)), "")
        r = rel[len(pre):]
        src_root, _outdir, arcbase = group_defs[pre]
        src = src_root / r
        if not src.exists():
            print(f"  [跳过] {rel} (本地不存在)")
            continue
        print(f"  {arcbase}/{r}  ({src.stat().st_size} B)")
        grouped[pre].append((src, f"{arcbase}/{r}"))
    if not any(grouped.values()):
        raise SystemExit("没有可发布的文件")
    if args.list:
        return

    tag = time.strftime("mod%m%d%H%M")
    for pre, files in grouped.items():
        if not files:
            continue
        _src_root, outdir, _arcbase = group_defs[pre]
        outdir.mkdir(parents=True, exist_ok=True)
        out = outdir / f"pinball-{from_ver}-{to_ver}-1-{tag}.zip"
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
            for src, arc in files:
                z.write(src, arc)
        print(f"\n[OK] 已发布: {outdir.name}/{out.name}  ({out.stat().st_size} B)")
    print("客户端重启游戏即会自动下载更新(服务端动态扫描,无需重启)。")
    print(f"提示: .env 的 CN_RES_VERSION 可保持不变(/load 跟随客户端 res_ver)。")

    # 自动公布改动日志:回填版本号 + 把 changelog.md 发到 CDN 目录
    stamped = stamp_changelog(to_ver)
    if CHANGELOG_MD.exists():
        try:
            shutil.copy2(CHANGELOG_MD, CDN_DIFF / "changelog.md")
        except Exception:
            pass
    print(f"改动日志: {stamped} 条标记为 {to_ver},已公布 changelog.md (work/ + CDN)。")


if __name__ == "__main__":
    main()
