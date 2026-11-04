#!/usr/bin/env python3
"""extract_help.py — 游戏内 [帮助] 功能全量提取（官方玩法文字教程）

数据源（全部本地只读，无网络请求）：
  - ../wf-assets-cn/orderedmap/help/help.json     帮助树（223 节点）
  - ../wf-assets-cn/orderedmap/string/ui_string.json  标题文案
  - .cdn/zip_index.json + .cdn/cn/*.zip            正文资产（rich_text/<id>.html.deflate）

寻址方案（与 tools 侧技能 DSL 提取同族）：sha1("<逻辑路径>" + SALT) →
production/upload/<前2位>/<余下>，在 zip 索引中定位成员后按 raw deflate(-15) 解压。

产物（默认写到仓库外的本地资料区 ../docs/help/，不进 starpoint-cn 仓——
官方游戏文本全文不入公共仓，见 README 纪律）：
  - manifest.json  帮助树（含标题/排序/类别/正文资产路径/展示起止时间）
  - <节点id>.md    逐篇正文（HTML 转纯文本 markdown）

用法：python3 tools/extract_help.py [--out <目录>]
"""
import argparse
import hashlib
import html as html_lib
import json
import re
import sys
import zipfile
import zlib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ASSETS = REPO_ROOT.parent / "wf-assets-cn" / "orderedmap"
CDN = REPO_ROOT / ".cdn"
DEFAULT_OUT = REPO_ROOT.parent / "docs" / "help"
SALT = "K6R9T9Hz22OpeIGEWB0ui6c6PYFQnJGy"

TOP_KEY = "(None)"  # help.json parent_id 的顶层哨兵值（客户端 HelpValues 同款）


def resolve_ui_string(value):
    """ui_string.json 的值可能是嵌套数组，递归取第一个字符串。"""
    while isinstance(value, list):
        value = value[0] if value else None
    return value if isinstance(value, str) else None


def cdn_blob_key(logical):
    digest = hashlib.sha1((logical + SALT).encode()).hexdigest()
    return f"production/upload/{digest[:2]}/{digest[2:]}"


class CdnTextReader:
    """按逻辑路径读取 CDN 文本资产（zip 句柄按需缓存）。"""

    def __init__(self, cdn_dir):
        self.index = json.loads((cdn_dir / "zip_index.json").read_text())
        self.cdn_dir = cdn_dir / "cn"
        self._zips = {}

    def read(self, logical):
        key = cdn_blob_key(logical)
        zip_name = self.index.get(key)
        if zip_name is None:
            return None
        if zip_name not in self._zips:
            self._zips[zip_name] = zipfile.ZipFile(self.cdn_dir / zip_name)
        data = self._zips[zip_name].read(key)
        for wbits in (-15, 15, 31):  # raw deflate / zlib / gzip 依次尝试
            try:
                return zlib.decompress(data, wbits)
            except zlib.error:
                continue
        return None


def html_to_markdown(raw, rich_path):
    """帮助正文是极简 HTML（<p>/<br/>/外链 style.css），转纯文本 markdown。"""
    text = raw.decode("utf-8", "replace")
    text = re.sub(r"<img\b[^>]*>", "[图片]", text)
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"</p\s*>", "\n\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    text = html_lib.unescape(text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return f"> 来源: {rich_path}\n\n{text}\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="产物目录")
    args = parser.parse_args()

    help_table = json.loads((ASSETS / "help" / "help.json").read_text())
    ui_strings = json.loads((ASSETS / "string" / "ui_string.json").read_text())
    reader = CdnTextReader(CDN)

    manifest = {}
    extracted = missing = 0
    args.out.mkdir(parents=True, exist_ok=True)
    for node_id, rows in help_table.items():
        safe_id = re.sub(r"[^A-Za-z0-9_.-]", "_", node_id)
        entries = []
        for row in rows:
            label_key, parent_id, display_order, child_kind, rich_path = row[0], row[1], row[2], row[3], row[4]
            entry = {
                "id": node_id,
                "label_key": label_key,
                "title": resolve_ui_string(ui_strings.get(label_key)) or label_key,
                "parent": None if parent_id == TOP_KEY else parent_id,
                "display_order": int(display_order),
                "child_kind": child_kind,  # 0=含子节点 1=正文页
                "rich_text": None if rich_path == "(None)" else rich_path,
                "show_start": None if row[5] == "(None)" else row[5],
                "show_end": None if row[6] == "(None)" else row[6],
            }
            entries.append(entry)
            if entry["child_kind"] != "1" or entry["rich_text"] is None:
                continue
            raw = reader.read(entry["rich_text"] + ".html.deflate")
            if raw is None:
                missing += 1
                continue
            extracted += 1
            (args.out / f"{safe_id}.md").write_text(
                html_to_markdown(raw, entry["rich_text"]), encoding="utf-8"
            )
        manifest[node_id] = entries

    (args.out / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    all_entries = [entry for entries in manifest.values() for entry in entries]
    tops = sorted((e for e in all_entries if e["parent"] is None), key=lambda e: e["display_order"])
    lines = ["# 游戏内 [帮助] 全量提取产物", "",
             f"- 主数据版本: {(REPO_ROOT.parent / 'wf-assets-cn' / 'VERSION').read_text().strip()}",
             f"- 节点: {len(all_entries)} / 正文页: {extracted}（缺失 {missing}）", ""]
    for top in tops:
        children = sorted(
            (e for e in all_entries if e["parent"] == top["id"]),
            key=lambda e: e["display_order"],
        )
        lines.append(f"- **{top['title']}**（{top['id']}）")
        for child in children:
            lines.append(f"  - {child['title']}（{child['id']}）")
    (args.out / "README.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"extracted={extracted} missing={missing} out={args.out}")
    return 0 if missing == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
