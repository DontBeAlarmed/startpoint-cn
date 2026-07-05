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
import sys
import time
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import wf_mod_tool as core  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CDN_DIFF = ROOT / ".cdn" / "cn" / "archive-common-diff"
PENDING = Path(__file__).resolve().parent / "work" / "sync_pending.json"

TABLE_ALIASES = {
    "ability": core.ABILITY_LOGICAL,
    "character": core.CHARACTER_LOGICAL,
    "character_status": core.STATUS_LOGICAL,
    "leader_ability": "master/ability/leader_ability.orderedmap",
    "ability_soul": "master/ability/ability_soul.orderedmap",
    "character_awake_status": "master/character/character_awake_status.orderedmap",
    "action_skill": "master/skill/action_skill.orderedmap",
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
    files: list[tuple[Path, str]] = []
    for rel in rels:
        src = store / rel
        if not src.exists():
            print(f"  [跳过] {rel} (本地不存在)")
            continue
        print(f"  production/upload/{rel}  ({src.stat().st_size} B)")
        files.append((src, f"production/upload/{rel}"))
    if not files:
        raise SystemExit("没有可发布的文件")
    if args.list:
        return

    CDN_DIFF.mkdir(parents=True, exist_ok=True)
    tag = time.strftime("mod%m%d%H%M")
    out = CDN_DIFF / f"pinball-{from_ver}-{to_ver}-1-{tag}.zip"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for src, arc in files:
            z.write(src, arc)
    print(f"\n[OK] 已发布: {out.name}  ({out.stat().st_size} B)")
    print("客户端重启游戏即会自动下载更新(服务端动态扫描,无需重启)。")
    print(f"提示: .env 的 CN_RES_VERSION 可保持不变(/load 跟随客户端 res_ver)。")


if __name__ == "__main__":
    main()
