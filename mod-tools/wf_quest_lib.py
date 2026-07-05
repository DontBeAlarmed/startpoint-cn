# -*- coding: utf-8 -*-
"""wf_quest_lib — 嵌套 orderedmap 深度读写(quest/zone/boss 系表专用)。

格式(全体系统一,可递归):
    map   = [u32 packed_index_len][zlib(index)][chunk 拼接]
    index = u32 n + n × (u32 键名累计尾偏移, u32 chunk 累计尾偏移) + 键名 utf-8 拼接
    chunk = zlib(行文本)  |  嵌套 map 原始字节  |  空串

顶层 .orderedmap 文件本身就是一个 map(与 wf_mod_tool.parse_index 同构)。
两层表(character_status 等)wf_mod_tool 已能处理;本库补齐任意深度
(boss_battle_quest 为 章→quest→multiplied 三层),读出 Python 结构、改完写回。

内存表示:
    叶子   -> str(CSV 行文本;空行为 '')
    map    -> dict[str, 节点](保持插入序 = 文件键序)

用法:
    from wf_quest_lib import load_table, save_table, roundtrip_check
    tree = load_table('master/quest/boss_battle_quest.orderedmap')
    tree['1']['1']['1'] = 修改后的CSV行
    save_table('master/quest/boss_battle_quest.orderedmap', tree)  # 自动备份

CLI 自检(结构等价往返 + wf_mod_tool 复读验证):
    python mod-tools/wf_quest_lib.py --selftest
"""
from __future__ import annotations

import argparse
import hashlib
import re
import shutil
import struct
import sys
import time
import zlib
from pathlib import Path

MOD_DIR = Path(__file__).resolve().parent
ROOT = MOD_DIR.parent
sys.path.insert(0, str(MOD_DIR))
import wf_mod_tool as _m  # noqa: E402

SALT = "K6R9T9Hz22OpeIGEWB0ui6c6PYFQnJGy"


# ---------------------------------------------------------------- store 定位

def _store_base() -> Path:
    prof = _m.load_profiles() if hasattr(_m, "load_profiles") else None
    # 与 profiles.json 保持一致;失败则退回硬编码 cn store
    try:
        store = prof.active_store  # type: ignore[union-attr]
        return ROOT / store
    except Exception:
        return ROOT / "弹国服/WorldFlipper/dummy/download/production/upload"


def hashed_rel(logical: str) -> str:
    p = re.sub(r"[/\\]+", "/", logical).lstrip("/")
    h = hashlib.sha1((p + SALT).encode("utf-8")).hexdigest()
    return f"{h[:2]}/{h[2:]}"


def store_path(logical: str) -> Path:
    return _store_base() / hashed_rel(logical)


# ---------------------------------------------------------------- 解析

def _try_parse_map(raw: bytes):
    """严格校验的 map 解析;不是 map 返回 None。"""
    if len(raw) < 12:
        return None
    ilen = struct.unpack_from("<I", raw, 0)[0]
    if ilen <= 0 or 4 + ilen > len(raw):
        return None
    try:
        index = zlib.decompress(raw[4 : 4 + ilen])
    except zlib.error:
        return None
    if len(index) < 4:
        return None
    n = struct.unpack_from("<I", index, 0)[0]
    if n <= 0 or len(index) < 4 + 8 * n:
        return None
    pairs = [struct.unpack_from("<II", index, 4 + 8 * i) for i in range(n)]
    key_blob = index[4 + 8 * n :]
    # 校验: 键尾偏移单调不减且末值=键块长;chunk 尾偏移单调不减且末值=blob 长
    blob = raw[4 + ilen :]
    if pairs[-1][0] != len(key_blob) or pairs[-1][1] != len(blob):
        return None
    prev_k = prev_r = 0
    for k_end, r_end in pairs:
        if k_end < prev_k or r_end < prev_r:
            return None
        prev_k, prev_r = k_end, r_end
    keys, chunks = [], []
    prev_k = prev_r = 0
    for k_end, r_end in pairs:
        keys.append(key_blob[prev_k:k_end].decode("utf-8"))
        chunks.append(blob[prev_r:r_end])
        prev_k, prev_r = k_end, r_end
    return keys, chunks


def parse_node(raw: bytes):
    """chunk → 节点(dict 或 str)。"""
    if not raw:
        return ""
    parsed = _try_parse_map(raw)
    if parsed is not None:
        keys, chunks = parsed
        return {k: parse_node(c) for k, c in zip(keys, chunks)}
    try:
        return zlib.decompress(raw).decode("utf-8")
    except zlib.error as exc:  # 既不是 map 也不是 zlib 行 → 数据异常,宁可失败
        raise ValueError(f"无法识别的 chunk({len(raw)} bytes): {raw[:16].hex()}") from exc


# ---------------------------------------------------------------- 构建

def build_node(node) -> bytes:
    """节点 → chunk 字节(dict → 嵌套 map;str → zlib 行;'' → 空 chunk)。"""
    if isinstance(node, str):
        return zlib.compress(node.encode("utf-8")) if node else b""
    if not isinstance(node, dict):
        raise TypeError(f"节点必须是 str 或 dict,得到 {type(node)}")
    key_blob = b""
    row_blob = b""
    pairs = []
    for key, child in node.items():
        key_blob += key.encode("utf-8")
        row_blob += build_node(child)
        pairs.append((len(key_blob), len(row_blob)))
    index = bytearray()
    index += struct.pack("<I", len(pairs))
    for k_end, r_end in pairs:
        index += struct.pack("<II", k_end, r_end)
    index += key_blob
    packed = zlib.compress(bytes(index))
    return struct.pack("<I", len(packed)) + packed + row_blob


# ---------------------------------------------------------------- 文件级 API

def load_table(logical: str, path: Path | None = None) -> dict:
    p = path or store_path(logical)
    tree = parse_node(p.read_bytes())
    if not isinstance(tree, dict):
        raise ValueError(f"{logical} 顶层不是 map")
    return tree


def save_table(logical: str, tree: dict, path: Path | None = None, backup: bool = True) -> Path:
    """写回 store(默认),自动 .bak-wfquest-<ts> 备份;返回写入路径。"""
    p = path or store_path(logical)
    data = build_node(tree)
    # 写前自校验: 重新解析必须结构等价
    if parse_node(data) != tree:
        raise RuntimeError(f"{logical} 写前自校验失败(build→parse 不等价),已放弃写入")
    if backup and p.exists():
        ts = time.strftime("%Y%m%d-%H%M%S")
        shutil.copy2(p, p.with_name(p.name + f".bak-wfquest-{ts}"))
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
    return p


# ---------------------------------------------------------------- 自检

SELFTEST_TABLES = [
    "master/quest/boss_battle_quest.orderedmap",
    "master/quest/boss_battle_stage_node.orderedmap",
    "master/quest/event/rush_event_quest.orderedmap",
    "master/quest/event/rush_event_quest_folder.orderedmap",
    "master/quest/event/rush_event_battle_quest_correction.orderedmap",
    "master/quest/event/advent_event_quest.orderedmap",
    "master/battle/zone.orderedmap",
    "master/battle/field_data.orderedmap",
    "master/battle/boss/general_boss.orderedmap",
    "master/battle/boss/boss_level.orderedmap",
    "master/battle/zako/general_zako.orderedmap",
    "master/quest/main_quest.orderedmap",
]


def _count(node) -> tuple[int, int]:
    """(map 数, 叶子数)"""
    if isinstance(node, str):
        return 0, 1
    maps, leaves = 1, 0
    for v in node.values():
        m2, l2 = _count(v)
        maps += m2
        leaves += l2
    return maps, leaves


def roundtrip_check(logical: str) -> str:
    p = store_path(logical)
    if not p.exists():
        return f"MISS  {logical}"
    original = p.read_bytes()
    tree = parse_node(original)
    rebuilt = build_node(tree)
    tree2 = parse_node(rebuilt)
    if tree != tree2:
        return f"FAIL  {logical}: 结构往返不等价"
    # 交叉验证: wf_mod_tool 的顶层读取器必须能读重建产物(键序与行文本一致)
    tmp = p.with_name(p.name + ".rttmp")
    tmp.write_bytes(rebuilt)
    try:
        om_a = _m.read_orderedmap_file_raw_rows(p, logical)
        om_b = _m.read_orderedmap_file_raw_rows(tmp, logical)
        if om_a.keys != om_b.keys:
            return f"FAIL  {logical}: 顶层键序不一致"
        for k, ra, rb in zip(om_a.keys, om_a.rows, om_b.rows):
            if parse_node(ra) != parse_node(rb):
                return f"FAIL  {logical}: 行 {k} 内容不一致"
    finally:
        tmp.unlink(missing_ok=True)
    maps, leaves = _count(tree)
    return f"OK    {logical}  (map×{maps}, 行×{leaves}, {len(original)}→{len(rebuilt)}B)"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--selftest", action="store_true", help="对代表性表做结构往返自检")
    ap.add_argument("--table", help="只检指定逻辑路径")
    args = ap.parse_args()
    if args.table:
        print(roundtrip_check(args.table))
        return 0
    if args.selftest:
        bad = 0
        for t in SELFTEST_TABLES:
            r = roundtrip_check(t)
            print(r)
            bad += 0 if r.startswith(("OK", "MISS")) else 1
        print("=" * 40)
        print("全部通过" if bad == 0 else f"{bad} 个失败")
        return 1 if bad else 0
    ap.print_help()
    return 0


if __name__ == "__main__":
    sys.stdout = __import__("io").TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    raise SystemExit(main())
