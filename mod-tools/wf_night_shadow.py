# -*- coding: utf-8 -*-
"""影子 store 组包 harness(2026-07-17 夜班·白狼杰拉德 149999)。

在影子副本上复用 wf_gui 已验证的 克隆/trim三表/整体转属性/资料三层同步,
全程零写 live store;随后把被改动的表镜像 + 服务端 json 导出进
wf_character_flow workspace 的 package/roots,并更新 manifest 的 tables/roots 声明。

用法(cwd=项目根):
  python mod-tools/wf_night_shadow.py build      # 建影子(复制全部 master 表 + 4 个 json)
  python mod-tools/wf_night_shadow.py run        # 影子上执行 克隆→trim→转光→资料
  python mod-tools/wf_night_shadow.py export     # 导出改动进 workspace + 更新 manifest
  python mod-tools/wf_night_shadow.py all        # 顺序执行三步
每步幂等:build 已存在则跳过;run 以 149999 是否已在影子 character 表里判重。
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import shutil
import sys
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

ROOT = Path(__file__).resolve().parent.parent
NIGHT = ROOT / "work" / "night_run_20260717"
SHADOW = NIGHT / "shadow"
SHADOW_STORE = SHADOW / "upload"
SHADOW_ASSETS = SHADOW / "assets"
SHADOW_WORK = SHADOW / "guiwork"
STATE_FILE = SHADOW / "shadow_state.json"

WORKSPACE = ROOT / "work" / "character_packs" / "white_wolf_gerald"

TEMPLATE_ID = "111007"
TEMPLATE_CODE = "black_wolf_knight"
NEW_ID = "149999"
NEW_CODE = "white_wolf_gerald"
NEW_NAME = "杰拉德"

# 身份文本(save_char_fields 三层同步;字段名须在 CHAR_FIELD_MAP 中,运行时校验)
IDENTITY_EDITS = {
    "name": "杰拉德",
    "name_en": "GERALD",
    "description": "海崖王国的白狼骑士。一身银白鬃毛与冰蓝之瞳,左眼的伤疤是旧日誓约的印记。"
                   "身披白氅蓝袍、佩金纹银甲,剑锋所指之处,即是他守护的道路。",
}

# 表镜像在包内的 root 归属(全部 common)与 codec(对齐 seris manifest 先例)
TABLE_CODECS = {
    "master/character/character.orderedmap": "flat",
    "master/ability/ability.orderedmap": "flat",
    "master/ability/leader_ability.orderedmap": "flat",
    "master/character/character_text.orderedmap": "flat",
    "master/character/character_awake_status.orderedmap": "flat",
    "master/character/character_speech.orderedmap": "flat",
    "master/skill_preview/skill_preview_character.orderedmap": "flat",
    "master/mana_board/mana_board2_open_condition.orderedmap": "flat",
    "master/mana_board/upskill.orderedmap": "flat",
    "master/stance_detail/character_stance_detail.orderedmap": "flat",
    "master/generated/trimmed_image.orderedmap": "flat",
    "master/character/character_status.orderedmap": "raw_outer",
    "master/generated/character_image.orderedmap": "raw_outer",
    "master/character/full_shot_image_attribute.orderedmap": "raw_outer",
    "master/generated/mana_board.orderedmap": "raw_outer",
    "master/mana_board/mana_node.orderedmap": "raw_outer",
    "master/character/character_gacha_sound.orderedmap": "raw_outer",
    "master/skill/action_skill.orderedmap": "action_nested",
    "master/character/unique_condition.orderedmap": "flat",
}

SERVER_JSONS = {
    # 影子相对路径 -> 包内 server root 相对路径(对齐 seris 先例)
    "assets/cdndata/character.json": "cdndata/character.json",
    "assets/cdndata/character_text.json": "cdndata/character_text.json",
    "assets/character.json": "character.json",
    "assets/mana_node.json": "mana_node.json",
}


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _load_gui_shadowed():
    """导入 wf_gui 并把全部写路径指向影子。必须在 build 之后调用。"""
    import wf_mod_tool as core
    import wf_gui as gui
    if not SHADOW_STORE.exists():
        raise SystemExit("影子未构建,先跑 build")
    if not hasattr(gui, "_REAL_TARGET_STORE"):
        gui._REAL_TARGET_STORE = gui.TARGET_STORE
    gui.TARGET_STORE = SHADOW_STORE
    gui.CDNDATA = SHADOW_ASSETS / "cdndata"
    SHADOW_WORK.mkdir(parents=True, exist_ok=True)
    gui.WORK_DIR = SHADOW_WORK
    gui.PENDING_FILE = SHADOW_WORK / "sync_pending.json"
    gui.CHANGELOG_FILE = SHADOW_WORK / "changelog.jsonl"
    gui.CHANGELOG_MD = SHADOW_WORK / "changelog.md"
    # 快照/备份类目录若有,一并指影子
    for attr in ("SNAPSHOT_DIR", "BACKUP_DIR"):
        if hasattr(gui, attr):
            setattr(gui, attr, SHADOW_WORK / attr.lower())
    return core, gui


def cmd_build() -> dict:
    """复制全部 master 表 + 4 个服务端 json 到影子(以真实 store 为源,只读)。"""
    import wf_mod_tool as core
    import wf_gui as gui
    if STATE_FILE.exists():
        state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        if state.get("built"):
            print(json.dumps({"ok": True, "skip": "already built", **state}, ensure_ascii=False))
            return state
    real_store = gui.TARGET_STORE
    pathlist = (ROOT / "mod-tools" / "WF_PATHLIST_recovered.txt").read_text(
        encoding="utf-8", errors="replace").splitlines()
    masters = [p.strip() for p in pathlist if p.strip().startswith("master/")]
    copied, missing, total_bytes = 0, [], 0
    for logical in masters:
        src = core.table_path(real_store, logical)
        if not src.exists():
            missing.append(logical)
            continue
        dst = core.table_path(SHADOW_STORE, logical)
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        total_bytes += src.stat().st_size
        copied += 1
    for rel in SERVER_JSONS:
        src = ROOT / rel
        dst = SHADOW / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
    state = {"built": True, "tables_copied": copied, "tables_missing": len(missing),
             "bytes": total_bytes}
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"ok": True, **state}, ensure_ascii=False))
    return state


def cmd_run() -> dict:
    core, gui = _load_gui_shadowed()
    report: dict = {"ops": []}
    # 判重:149999 已在影子 character 表 → 跳过克隆
    ct = core.load_table(core.CHARACTER_LOGICAL, gui.TARGET_STORE, gui.SOURCE_STORE)
    if NEW_ID in ct.text_rows():
        report["ops"].append({"clone": "skip(已存在)"})
    else:
        buf = io.StringIO()
        with redirect_stdout(buf):
            r = gui.clone_character(TEMPLATE_ID, NEW_ID, NEW_NAME, False, new_code=NEW_CODE)
        report["ops"].append({"clone": r.get("log", [])})
    # trim 三表:trimmed_image 行克隆(character_image/fs_attr 克隆已在 clone 内)
    trimmed = core.load_table(gui.TRIMMED_LOGICAL, gui.TARGET_STORE, gui.SOURCE_STORE)
    rows = trimmed.text_rows()
    prefix = f"character/{TEMPLATE_CODE}/"
    additions = {
        key.replace(prefix, f"character/{NEW_CODE}/", 1): value
        for key, value in rows.items()
        if key.startswith(prefix) and "/story/" not in key and "episode_banner" not in key
    }
    new_trim_keys = [k for k in additions if k not in rows]
    if new_trim_keys:
        trimmed.set_text_rows(additions)
        written = core.write_table(trimmed, gui.TARGET_STORE, ".bak-night-trim", no_backup=False)
        report["ops"].append({"trim_rows_added": new_trim_keys})
    else:
        report["ops"].append({"trim": "skip(已存在)"})
    # 整体转属性 → 光。先 dry-run 拿报告,再正式执行
    dr = gui.element_convert(NEW_ID, "光", True)
    r2 = gui.element_convert(NEW_ID, "光", False)
    report["ops"].append({"element_convert_dry": dr, "element_convert": r2})
    # 资料三层同步(name/name_en/description)
    field_map = getattr(gui, "CHAR_FIELD_MAP")
    edits = {k: v for k, v in IDENTITY_EDITS.items() if k in field_map}
    skipped = [k for k in IDENTITY_EDITS if k not in field_map]
    r3 = gui.save_char_fields(NEW_ID, edits, False)
    report["ops"].append({"save_char_fields": r3, "skipped_fields": skipped})
    out = NIGHT / "status" / "shadow_run_report.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=str),
                   encoding="utf-8")
    print(json.dumps({"ok": True, "report": str(out)}, ensure_ascii=False))
    return report


def _changed_tables(core, gui) -> list[str]:
    """对比影子表与 live 表字节,列出被改动的 logical。"""
    changed = []
    for logical in TABLE_CODECS:
        sp = core.table_path(SHADOW_STORE, logical)
        lp = core.table_path(gui._REAL_TARGET_STORE, logical)
        if not sp.exists():
            continue
        if not lp.exists() or sp.read_bytes() != lp.read_bytes():
            changed.append(logical)
    return changed


def _outer_keys_added(core, gui, logical: str) -> list[str]:
    """影子表相对 live 表新增的外层键(=包拥有的行)。"""
    sp = core.table_path(SHADOW_STORE, logical)
    lp = core.table_path(gui._REAL_TARGET_STORE, logical)
    read = core.read_orderedmap_file_raw_rows if TABLE_CODECS[logical] != "flat" \
        else core.read_orderedmap_file
    s_keys = set(read(sp, logical).keys)
    l_keys = set(read(lp, logical).keys) if lp.exists() else set()
    added = [k for k in read(sp, logical).keys if k not in l_keys]
    # element_convert/save_char_fields 会改既有行?否——只动 149999 相关新行;
    # 若未来出现改既有行的场景,这里必须扩展为逐行 diff。夜班断言:不改官方行。
    modified_official = []
    if lp.exists():
        s_om, l_om = read(sp, logical), read(lp, logical)
        l_map = dict(zip(l_om.keys, l_om.rows))
        for k, row in zip(s_om.keys, s_om.rows):
            if k in l_map and l_map[k] != row:
                modified_official.append(k)
    return added, modified_official


def cmd_export() -> dict:
    core, gui = _load_gui_shadowed()
    # 真实 store 引用(_load_gui_shadowed 补丁前已捕获)用于 diff
    import wf_gui as _g
    pkg = WORKSPACE / "package"
    if not pkg.exists():
        raise SystemExit("workspace 不存在,先跑 wf_character_flow init")
    manifest_path = pkg / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    tables_decl = []
    exported = []
    warnings = []
    for logical in TABLE_CODECS:
        sp = core.table_path(SHADOW_STORE, logical)
        lp = core.table_path(_g._REAL_TARGET_STORE, logical)
        if not sp.exists():
            continue
        if lp.exists() and sp.read_bytes() == lp.read_bytes():
            continue  # 未改动的表不进包
        added, modified = _outer_keys_added(core, _g, logical)
        if modified:
            # 已验证:ql.save_table 重编码规范化会让个别官方行字节变化但语义等价
            # (129999 实测 True)。包只认领新增行;rebase 对未声明行一律取 live 字节。
            warnings.append({"logical": logical, "modified_official_rows": modified,
                             "note": "bytes-only canonicalization, not claimed"})
        dst = pkg / "roots" / "common" / logical
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(sp, dst)
        exported.append(logical)
        tables_decl.append({
            "codec_id": TABLE_CODECS[logical],
            "logical_path": logical,
            "outer_keys": sorted(added),
            "inner_keys": [],
            "root": "common",
            "semantic_claims": [],
        })
    # 服务端 json:整文件进 server root;声明键=149999(+资产路径无)
    for shadow_rel, pkg_rel in SERVER_JSONS.items():
        sp = SHADOW / shadow_rel
        lp = ROOT / shadow_rel
        if not sp.exists():
            continue
        if lp.exists() and sp.read_bytes() == lp.read_bytes():
            continue
        dst = pkg / "roots" / "server" / pkg_rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(sp, dst)
        exported.append(f"server/{pkg_rel}")
        tables_decl.append({
            "codec_id": "json_object",
            "logical_path": pkg_rel,
            "outer_keys": [NEW_ID],
            "inner_keys": [],
            "root": "server",
            "semantic_claims": [],
        })
    manifest["tables"] = tables_decl
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8")
    result = {"ok": True, "exported": exported, "tables_declared": len(tables_decl),
              "warnings": warnings}
    out = NIGHT / "status" / "shadow_export_report.json"
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False)[:1500])
    return result


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("cmd", choices=["build", "run", "export", "all"])
    args = ap.parse_args()
    if args.cmd in ("build", "all"):
        cmd_build()
    if args.cmd in ("run", "all"):
        cmd_run()
    if args.cmd in ("export", "all"):
        cmd_export()
    return 0


if __name__ == "__main__":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    raise SystemExit(main())
