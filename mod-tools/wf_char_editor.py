#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
WF 单机版 · 角色数据编辑器
================================
在 *已解码* 的角色主数据(orderedmap JSON)上做导出 / 编辑 / 写回。

覆盖两个源文件(位于 startpoint-cn 仓库 `assets/cdndata/`):
  - character.json        角色身份主表(37 字段 / 角色)
  - character_text.json   角色文本词条(12 字段 / 角色):名字·描述·技能名·技能描述·声优

用法
----
  # 1) 导出成好读可编辑的文件
  python wf_char_editor.py export --repo <startpoint-cn目录> --out ./edit

  # 2) 手改 edit/characters_editable.json 或 edit/characters_overview.csv

  # 3) 写回(默认自动备份原文件为 *.bak)
  python wf_char_editor.py apply --repo <startpoint-cn目录> --edited ./edit/characters_editable.json

说明
----
* 只改本工具"暴露"的字段;每个角色其余原始字段原样保留(按下标回写)。
* export 会把完整原始数组存进 `_raw_master` / `_raw_text`,方便你对照未暴露字段。
* CSV 适合批量改身份类字段;JSON 适合改长文本(技能描述等)。JSON 优先。
"""
import argparse, csv, json, os, shutil, sys

# ---- 元素 / 字段字典 -----------------------------------------------------
ELEMENT = {"0": "火", "1": "水", "2": "雷", "3": "风", "4": "光", "5": "暗"}
ELEMENT_REV = {v: k for k, v in ELEMENT.items()}

# 暴露字段 -> (源文件, 数组下标)。源文件: "master"=character.json, "text"=character_text.json
FIELD_MAP = {
    # 身份(character.json)
    "code_name":       ("master", 0),
    "rarity":          ("master", 2),
    "element":         ("master", 3),   # 存 0-5;导出时同时给 element_name
    "race":            ("master", 4),
    "gender":          ("master", 7),
    "role":            ("master", 26),  # Attacker/Balance/Healer/Jammer/Supporter/Tank
    # 文本词条(character_text.json)
    "name":            ("text", 0),
    "name_en":         ("text", 1),
    "description":     ("text", 2),
    "title":           ("text", 3),
    "skill_name":      ("text", 4),
    "skill_desc":      ("text", 5),
    "skill_plus_name": ("text", 6),
    "skill_plus_desc": ("text", 7),
    "leader_title":    ("text", 10),
    "cv":              ("text", 11),
}
# CSV 里只放这些短字段(长描述用 JSON 改)
CSV_FIELDS = ["id", "name", "name_en", "rarity", "element", "role",
              "race", "gender", "title", "leader_title", "cv"]


def _paths(repo):
    base = os.path.join(repo, "assets", "cdndata")
    return (os.path.join(base, "character.json"),
            os.path.join(base, "character_text.json"))


def _load(repo):
    mp, tp = _paths(repo)
    for p in (mp, tp):
        if not os.path.exists(p):
            sys.exit(f"[错误] 找不到 {p} —— 请确认 --repo 指向 startpoint-cn 仓库根目录")
    master = json.load(open(mp, encoding="utf-8"))
    text = json.load(open(tp, encoding="utf-8"))
    return master, text


def cmd_export(args):
    master, text = _load(args.repo)
    os.makedirs(args.out, exist_ok=True)
    out = {}
    for cid, mval in master.items():
        m = mval[0]
        t = text.get(cid, [[""] * 12])[0]

        def get(field):
            src, idx = FIELD_MAP[field]
            arr = m if src == "master" else t
            return arr[idx] if idx < len(arr) else ""

        rec = {f: get(f) for f in FIELD_MAP}
        rec["id"] = cid
        rec["element_name"] = ELEMENT.get(rec["element"], rec["element"])
        rec["_raw_master"] = m
        rec["_raw_text"] = t
        out[cid] = rec

    js = os.path.join(args.out, "characters_editable.json")
    json.dump(out, open(js, "w", encoding="utf-8"), ensure_ascii=False, indent=2)

    cs = os.path.join(args.out, "characters_overview.csv")
    with open(cs, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        w.writeheader()
        for cid, rec in sorted(out.items(), key=lambda kv: int(kv[0]) if kv[0].isdigit() else 0):
            row = {k: rec.get(k, "") for k in CSV_FIELDS}
            row["element"] = rec["element_name"]  # CSV 里用中文元素名
            w.writerow(row)

    print(f"[OK] 导出 {len(out)} 个角色")
    print(f"     - {js}   (改长文本 / 技能描述用这个)")
    print(f"     - {cs}   (批量改身份字段用这个, Excel 可开)")


def _write_field(master, text, cid, field, value):
    src, idx = FIELD_MAP[field]
    store = master if src == "master" else text
    if cid not in store:
        return False
    arr = store[cid][0]
    while len(arr) <= idx:
        arr.append("")
    arr[idx] = value
    return True


def cmd_apply(args):
    master, text = _load(args.repo)
    edited = args.edited
    changes = 0

    if edited.lower().endswith(".csv"):
        rows = list(csv.DictReader(open(edited, encoding="utf-8-sig")))
        for row in rows:
            cid = str(row.get("id", "")).strip()
            if not cid:
                continue
            for field in CSV_FIELDS:
                if field == "id" or field not in FIELD_MAP:
                    continue
                val = row.get(field, "")
                if field == "element":
                    val = ELEMENT_REV.get(val, val)  # 中文名 -> 0-5
                if _write_field(master, text, cid, field, str(val)):
                    changes += 1
    else:  # JSON
        data = json.load(open(edited, encoding="utf-8"))
        for cid, rec in data.items():
            for field in FIELD_MAP:
                if field not in rec:
                    continue
                val = rec[field]
                if field == "element" and val in ELEMENT_REV:
                    val = ELEMENT_REV[val]
                _write_field(master, text, cid, field, str(val))
            changes += 1

    mp, tp = _paths(args.repo)
    if not args.no_backup:
        for p in (mp, tp):
            shutil.copy2(p, p + ".bak")
    json.dump(master, open(mp, "w", encoding="utf-8"), ensure_ascii=False,
              separators=(",", ":"))
    json.dump(text, open(tp, "w", encoding="utf-8"), ensure_ascii=False,
              separators=(",", ":"))
    print(f"[OK] 写回完成,处理 {changes} 处。原文件已备份为 *.bak "
          f"({'已跳过备份' if args.no_backup else '可用 .bak 还原'})")
    print("     下一步:重启服务端 / 重打包客户端主数据使改动生效(见指南文档)。")


def main():
    ap = argparse.ArgumentParser(description="WF 单机版角色数据编辑器")
    sub = ap.add_subparsers(dest="cmd", required=True)

    e = sub.add_parser("export", help="导出可编辑文件")
    e.add_argument("--repo", required=True)
    e.add_argument("--out", default="./edit")
    e.set_defaults(func=cmd_export)

    a = sub.add_parser("apply", help="把编辑写回主数据")
    a.add_argument("--repo", required=True)
    a.add_argument("--edited", required=True, help="characters_editable.json 或 .csv")
    a.add_argument("--no-backup", action="store_true")
    a.set_defaults(func=cmd_apply)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
