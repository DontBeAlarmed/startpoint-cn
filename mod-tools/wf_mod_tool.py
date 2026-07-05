#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Reusable World Flipper CN offline master-data mod tool.

Current scope:
  * Reads/writes CDN orderedmap binaries in production/upload.
  * Parses the ability AMF3 schema so ability columns can be addressed by name.
  * Lists/exports ability rows by character id, ability id, or string_id text.
  * Applies JSON recipes for common balance work:
      - remove_main_position
      - set field values
      - scale numeric fields
      - copy ability rows/fields from one character to another

The tool writes to the offline phone package's WorldFlipper/dummy upload store.
It can use a full source upload store as fallback when the target contains only
a tiny stub file.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
import shutil
import struct
import sys
import time
import zlib
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from typing import Any


SALT = "K6R9T9Hz22OpeIGEWB0ui6c6PYFQnJGy"

ABILITY_LOGICAL = "master/ability/ability.orderedmap"
CHARACTER_LOGICAL = "master/character/character.orderedmap"
ABILITY_SCHEMA_REL = Path("2b") / "6ca08e92d925665614cd48a37167f3618dd6e6"

CHARACTER_COLUMNS = {
    "code_name": 0,
    "rarity": 2,
    "element": 3,
    "race": 4,
    "gender": 7,
    "action_skill": 8,
    "character_id": 17,
    "leader_ability_title": 18,
    "ability_1": 19,
    "ability_2": 20,
    "ability_3": 21,
    "ability_4": 22,
    "ability_5": 23,
    "ability_6": 24,
    "mana_board_kind": 25,
    "role": 26,
    "base_character_id": 27,
    "max_ability_powers": 36,
}

ABILITY_ALIASES = {
    "skill_strength": [
        "trigger.values.instant_content.values.strength.power1",
        "trigger.values.instant_content.values.strength2.power1",
        "trigger.values.instant_content.values.strength3.power1",
        "trigger.values.during_content.values.strength.power1",
        "trigger.values.during_content.values.strength2.power1",
        "trigger.values.opening.values.strength.power1",
    ],
    "instant_strength": [
        "trigger.values.instant_content.values.strength.power1",
        "trigger.values.instant_content.values.strength2.power1",
        "trigger.values.instant_content.values.strength3.power1",
    ],
    "during_strength": [
        "trigger.values.during_content.values.strength.power1",
        "trigger.values.during_content.values.strength2.power1",
    ],
    "duration_frames": [
        "trigger.values.instant_content.values.frame.power1",
    ],
    "counts": [
        "trigger.values.instant_content.values.number.power1",
    ],
    "thresholds": [
        "trigger.values.precondition.values.threshold.power1",
        "trigger.values.precondition2.values.threshold.power1",
        "trigger.values.precondition3.values.threshold.power1",
        "trigger.values.instant_trigger.values.threshold.power1",
        "trigger.values.instant_trigger.values.threshold2.power1",
        "trigger.values.instant_precontent.values.threshold.power1",
        "trigger.values.instant_content.values.multiply_trigger.values.threshold.power1",
        "trigger.values.during_accumulation_trigger.values.threshold.power1",
        "trigger.values.during_accumulation_trigger.values.threshold2.power1",
        "trigger.values.during_trigger.values.threshold.power1",
        "trigger.values.during_trigger.values.start_threshold.power1",
    ],
}


@dataclass
class OrderedMap:
    logical_path: str
    keys: list[str]
    rows: list[bytes]
    source_path: Path

    def text_rows(self) -> dict[str, str]:
        return {
            key: row.decode("utf-8") if row else ""
            for key, row in zip(self.keys, self.rows)
        }

    def set_text_rows(self, row_map: dict[str, str]) -> None:
        out = []
        for key, old in zip(self.keys, self.rows):
            if key in row_map:
                out.append(row_map[key].encode("utf-8") if row_map[key] else b"")
            else:
                out.append(old)
        self.rows = out
        # 追加 row_map 里真正新增的键(克隆/新增角色依赖此;历史 bug:曾静默丢弃新键)
        existing = set(self.keys)
        for key, val in row_map.items():
            if key not in existing:
                self.keys.append(key)
                self.rows.append(val.encode("utf-8") if val else b"")
                existing.add(key)

    def delete_keys(self, keys: set[str]) -> None:
        """整键删除(用于回滚克隆/新增角色)。"""
        pairs = [(k, r) for k, r in zip(self.keys, self.rows) if k not in keys]
        self.keys = [k for k, _ in pairs]
        self.rows = [r for _, r in pairs]


class AMF3Reader:
    """Small AMF3 reader for the schema files used by this game."""

    def __init__(self, data: bytes):
        self.data = data
        self.pos = 0
        self.string_refs: list[str] = []
        self.object_refs: list[Any] = []
        self.trait_refs: list[tuple[str, list[str], bool, bool]] = []

    def read_byte(self) -> int:
        value = self.data[self.pos]
        self.pos += 1
        return value

    def read_u29(self) -> int:
        value = 0
        for i in range(4):
            b = self.read_byte()
            if i < 3:
                value = (value << 7) | (b & 0x7F)
                if not b & 0x80:
                    return value
            else:
                return (value << 8) | b
        return value

    def read_string_body(self) -> str:
        header = self.read_u29()
        if not header & 1:
            return self.string_refs[header >> 1]
        length = header >> 1
        if length == 0:
            return ""
        raw = self.data[self.pos:self.pos + length]
        self.pos += length
        value = raw.decode("utf-8")
        self.string_refs.append(value)
        return value

    def read_value(self) -> Any:
        marker = self.read_byte()
        if marker in (0x00, 0x01):
            return None
        if marker == 0x02:
            return False
        if marker == 0x03:
            return True
        if marker == 0x04:
            value = self.read_u29()
            return value - 0x20000000 if value & 0x10000000 else value
        if marker == 0x05:
            value = struct.unpack(">d", self.data[self.pos:self.pos + 8])[0]
            self.pos += 8
            return value
        if marker == 0x06:
            return self.read_string_body()
        if marker == 0x09:
            return self.read_array()
        if marker == 0x0A:
            return self.read_object()
        raise ValueError(f"unsupported AMF3 marker 0x{marker:02x} at {self.pos - 1}")

    def read_array(self) -> Any:
        header = self.read_u29()
        if not header & 1:
            return self.object_refs[header >> 1]
        dense_count = header >> 1
        assoc = {}
        while True:
            key = self.read_string_body()
            if key == "":
                break
            assoc[key] = self.read_value()
        dense: list[Any] = []
        container: Any = dense if not assoc else {"$assoc": assoc, "$dense": dense}
        self.object_refs.append(container)
        for _ in range(dense_count):
            dense.append(self.read_value())
        return container

    def read_object(self) -> dict[str, Any]:
        header = self.read_u29()
        if not header & 1:
            return self.object_refs[header >> 1]

        if not header & 2:
            class_name, sealed_names, externalizable, dynamic = self.trait_refs[header >> 2]
        else:
            externalizable = bool(header & 4)
            dynamic = bool(header & 8)
            sealed_count = header >> 4
            class_name = self.read_string_body()
            sealed_names = [self.read_string_body() for _ in range(sealed_count)]
            self.trait_refs.append((class_name, sealed_names, externalizable, dynamic))

        if externalizable:
            raise ValueError("externalizable AMF3 objects are not supported")

        obj: dict[str, Any] = {}
        if class_name:
            obj["$class"] = class_name
        self.object_refs.append(obj)
        for name in sealed_names:
            obj[name] = self.read_value()
        if dynamic:
            while True:
                key = self.read_string_body()
                if key == "":
                    break
                obj[key] = self.read_value()
        return obj


def sha1_path(logical_path: str) -> str:
    return hashlib.sha1((logical_path + SALT).encode("utf-8")).hexdigest()


def table_path(store: Path, logical_path: str) -> Path:
    digest = sha1_path(logical_path)
    return store / digest[:2] / digest[2:]


def find_world_upload(root: Path) -> Path | None:
    for child in root.iterdir():
        candidate = child / "WorldFlipper" / "dummy" / "download" / "production" / "upload"
        if candidate.exists():
            return candidate
    candidate = root / "WorldFlipper" / "dummy" / "download" / "production" / "upload"
    return candidate if candidate.exists() else None


def default_target_store() -> Path | None:
    return find_world_upload(Path.cwd())


def default_source_store() -> Path | None:
    # 可选的跨版本兜底源;发布版不硬编码个人路径,改由 WF_SOURCE_STORE 指定。
    # profile 模式下 source 由档案 fallback 决定(默认 None),此函数一般不触发。
    env = os.environ.get("WF_SOURCE_STORE")
    if env and Path(env).exists():
        return Path(env)
    return None


# ---------------------------------------------------------------------------
# Version profiles: bind store + cdndata + schema into one explicit version so
# the tool never silently mixes CN data with a global-server fallback.
# See 版本切换设计.md.
# ---------------------------------------------------------------------------


@dataclass
class VersionProfile:
    id: str
    label: str
    store: Path
    cdndata: Path | None = None
    res_version: str = ""
    fallback: Path | None = None


def project_root() -> Path:
    """mod-tools/ 的上一级 = startpoint-cn 仓库根;profiles.json 里的相对路径以此为基准。"""
    return Path(__file__).resolve().parent.parent


def profiles_file() -> Path:
    return Path(__file__).resolve().parent / "profiles.json"


def _resolve_profile_path(value: str) -> Path:
    p = Path(value)
    return p if p.is_absolute() else (project_root() / p).resolve()


def load_profiles() -> dict[str, Any]:
    pf = profiles_file()
    if not pf.exists():
        return {}
    return json.loads(pf.read_text(encoding="utf-8"))


def resolve_profile(profile_id: str | None = None) -> VersionProfile | None:
    """读取 profiles.json 的激活档案。无文件 / 无匹配时返回 None,调用方回退旧逻辑。"""
    data = load_profiles()
    profiles = data.get("profiles") or {}
    pid = profile_id or data.get("active")
    if not pid or pid not in profiles:
        return None
    entry = profiles[pid]
    return VersionProfile(
        id=pid,
        label=entry.get("label", pid),
        store=_resolve_profile_path(entry["store"]),
        cdndata=_resolve_profile_path(entry["cdndata"]) if entry.get("cdndata") else None,
        res_version=entry.get("res_version", ""),
        fallback=_resolve_profile_path(entry["fallback"]) if entry.get("fallback") else None,
    )


def parse_index(raw: bytes) -> tuple[list[str], list[tuple[int, int]], int]:
    if len(raw) < 8:
        raise ValueError("file is too small for orderedmap")
    index_len = struct.unpack_from("<I", raw, 0)[0]
    if index_len <= 0 or 4 + index_len > len(raw):
        raise ValueError("invalid orderedmap index length")
    index = zlib.decompress(raw[4:4 + index_len])
    count = struct.unpack_from("<I", index, 0)[0]
    pairs = []
    for i in range(count):
        key_end, row_offset = struct.unpack_from("<II", index, 4 + i * 8)
        pairs.append((key_end, row_offset))

    key_start = 4 + count * 8
    key_blob = index[key_start:]
    keys = []
    prev = 0
    for key_end, _ in pairs:
        keys.append(key_blob[prev:key_end].decode("utf-8"))
        prev = key_end
    return keys, pairs, index_len


def read_orderedmap_file(path: Path, logical_path: str) -> OrderedMap:
    """读 orderedmap。注意:索引里的 row_offset 是该行数据的**结束位置**(行尾),
    row_i = blob[offset_{i-1} : offset_i](offset_{-1}=0)。
    旧版本误当作起始位置使用,会导致全表键值错位一格。"""
    raw = path.read_bytes()
    keys, pairs, index_len = parse_index(raw)
    data_base = 4 + index_len
    blob = raw[data_base:]
    rows = []
    prev = 0
    for _, row_end in pairs:
        chunk = blob[prev:row_end]
        prev = row_end
        rows.append(zlib.decompress(chunk) if chunk else b"")
    return OrderedMap(logical_path, keys, rows, path)


def read_orderedmap_file_from_bytes(raw: bytes) -> dict[str, str]:
    """从内存字节解码 orderedmap,返回 {键: 文本行}。供导出器复用。"""
    keys, pairs, index_len = parse_index(raw)
    blob = raw[4 + index_len:]
    out: dict[str, str] = {}
    prev = 0
    for key, (_, row_end) in zip(keys, pairs):
        chunk = blob[prev:row_end]
        prev = row_end
        out[key] = zlib.decompress(chunk).decode("utf-8") if chunk else ""
    return out


def build_orderedmap(ordered: OrderedMap) -> bytes:
    """写 orderedmap,row_offset 使用行尾语义(与游戏客户端一致)。"""
    key_blob = b""
    row_blob = b""
    pairs = []
    for key, row in zip(ordered.keys, ordered.rows):
        key_blob += key.encode("utf-8")
        if row:
            row_blob += zlib.compress(row)
        pairs.append((len(key_blob), len(row_blob)))

    index = bytearray()
    index += struct.pack("<I", len(ordered.keys))
    for key_end, row_end in pairs:
        index += struct.pack("<II", key_end, row_end)
    index += key_blob

    packed_index = zlib.compress(bytes(index))
    return struct.pack("<I", len(packed_index)) + packed_index + row_blob


# ---------------------------------------------------------------------------
# 嵌套 orderedmap(character_status 基础数值表)
# 逆向结论(2026-07-05,对照 decompile CharacterBaseStatusLogic/CharacterStatusValues):
#   外层:键=角色ID,行=**原样存储**的内层 orderedmap 二进制(不再 zlib)
#   内层:键=等级断点("1","10","80","100"),行=zlib CSV "hp,atk"(列0=HP 列1=ATK)
#   客户端对断点排序后二分 + 线性插值(Math.ceil);505/505 全量验证通过。
#   写回时保持内层原键序(实测 168 个角色键序为 10,1,80,100,勿重排)。
# ---------------------------------------------------------------------------

STATUS_LOGICAL = "master/character/character_status.orderedmap"


def read_orderedmap_file_raw_rows(path: Path, logical_path: str) -> OrderedMap:
    """读外层行为原样字节(不 zlib)的 orderedmap。rows 是二进制,勿调 text_rows()。"""
    raw = path.read_bytes()
    keys, pairs, index_len = parse_index(raw)
    blob = raw[4 + index_len:]
    rows = []
    prev = 0
    for _, row_end in pairs:
        rows.append(blob[prev:row_end])
        prev = row_end
    return OrderedMap(logical_path, keys, rows, path)


def build_orderedmap_raw_rows(ordered: OrderedMap) -> bytes:
    """写外层:索引同 build_orderedmap,行原样拼接(不 zlib)。"""
    key_blob = b""
    row_blob = b""
    pairs = []
    for key, row in zip(ordered.keys, ordered.rows):
        key_blob += key.encode("utf-8")
        row_blob += row
        pairs.append((len(key_blob), len(row_blob)))
    index = bytearray()
    index += struct.pack("<I", len(ordered.keys))
    for key_end, row_end in pairs:
        index += struct.pack("<II", key_end, row_end)
    index += key_blob
    packed_index = zlib.compress(bytes(index))
    return struct.pack("<I", len(packed_index)) + packed_index + row_blob


def decode_status_row(chunk: bytes) -> list[tuple[str, int, int]]:
    """内层解码:嵌套 orderedmap 字节 -> [(等级断点, hp, atk)],保持原键序。"""
    inner = read_orderedmap_file_from_bytes(chunk)
    out = []
    for level, text in inner.items():
        parts = text.split(",")
        if len(parts) != 2:
            raise ValueError(f"status 行不是 hp,atk 两列: {level} -> {text!r}")
        out.append((level, int(parts[0]), int(parts[1])))
    return out


def encode_status_row(entries: list[tuple[str, int, int]]) -> bytes:
    """内层编码:[(等级断点, hp, atk)] -> 嵌套 orderedmap 字节(行 zlib,键序按传入)。"""
    om = OrderedMap(
        "<status-inner>",
        [str(level) for level, _, _ in entries],
        [f"{int(hp)},{int(atk)}".encode("utf-8") for _, hp, atk in entries],
        Path("."),
    )
    return build_orderedmap(om)


def load_status_table(target_store: Path, source_store: Path | None = None) -> OrderedMap:
    """读 character_status(外层 raw-rows)。与 load_table 同风格,但不做可读性启发。"""
    target = table_path(target_store, STATUS_LOGICAL)
    if target.exists():
        return read_orderedmap_file_raw_rows(target, STATUS_LOGICAL)
    if source_store:
        source = table_path(source_store, STATUS_LOGICAL)
        if source.exists():
            return read_orderedmap_file_raw_rows(source, STATUS_LOGICAL)
    raise FileNotFoundError(f"cannot read {STATUS_LOGICAL} from target/source stores")


def write_status_table(ordered: OrderedMap, target_store: Path, backup_suffix: str) -> Path:
    target = table_path(target_store, STATUS_LOGICAL)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        backup = target.with_name(target.name + backup_suffix)
        if not backup.exists():
            shutil.copy2(target, backup)
            print(f"backup: {backup}")
    target.write_bytes(build_orderedmap_raw_rows(ordered))
    return target


# ---------------------------------------------------------------------------
# 嵌套 orderedmap(action_skill 主动技表 · 技能能量/名称/描述)
# 逆向结论(2026-07-05,对照 decompile ActionSkillLogic.get_skillWeight):
#   外层:键=角色 code_name(如 black_wolf_knight),行=**原样存储**的内层 orderedmap 二进制
#   内层:键="1"(基础技)/"2"(＋进化技),行=zlib CSV(下列 ACTION_SKILL_COLUMNS)
#   技能能量(面板"技能能量")= 客户端 skillWeight:按 SLv 在 min/max 间线性插值
#     skillWeight(SLv)=floor((SLv-1)*(max-min)/(MAX_SLV-1)+min);SLv1=min,SLvMAX=max
#     ∴ 满级(常见展示)技能能量 = max_skill_weight = 内层列5;SLv1 = min_skill_weight = 列4
#   maxLevelSkillWeightShorten = min - max(满级相对 SLv1 少消耗的能量)
#   与 character_status 同为"外层 raw / 内层 zlib CSV",复用相同读写原语。
# ---------------------------------------------------------------------------

ACTION_SKILL_LOGICAL = "master/skill/action_skill.orderedmap"

# 内层 CSV 列(已确认列;其余列语义未逐一确认,写回原样保留)
ACTION_SKILL_COLUMNS = {
    "name": 0,               # 技能名(＋进化技带"＋")
    "description": 1,        # 技能描述
    "action_path": 2,        # 动作路径(dynamic/skill/...)
    "min_skill_weight": 4,   # SLv1 技能能量
    "max_skill_weight": 5,   # SLv满级 技能能量(面板显示值)
    "program_path": 7,       # 技能程序路径
}


def decode_action_skill_row(chunk: bytes) -> list[tuple[str, list[str]]]:
    """内层解码:嵌套 orderedmap 字节 -> [(内层键, CSV 列表)],保持原键序。
    一个内层键理论上一行 CSV;按行拆分后取首行(与游戏一致)。"""
    inner = read_orderedmap_file_from_bytes(chunk)
    out: list[tuple[str, list[str]]] = []
    for key, text in inner.items():
        rows = read_csv_lines(text)
        out.append((key, rows[0] if rows else []))
    return out


def encode_action_skill_row(entries: list[tuple[str, list[str]]]) -> bytes:
    """内层编码:[(内层键, CSV 列表)] -> 嵌套 orderedmap 字节(行 zlib,键序按传入)。"""
    om = OrderedMap(
        "<action-skill-inner>",
        [str(key) for key, _ in entries],
        [write_csv_lines([fields]).encode("utf-8") for _, fields in entries],
        Path("."),
    )
    return build_orderedmap(om)


def load_action_skill_table(target_store: Path, source_store: Path | None = None) -> OrderedMap:
    """读 action_skill(外层 raw-rows)。与 load_status_table 同风格。"""
    target = table_path(target_store, ACTION_SKILL_LOGICAL)
    if target.exists():
        return read_orderedmap_file_raw_rows(target, ACTION_SKILL_LOGICAL)
    if source_store:
        source = table_path(source_store, ACTION_SKILL_LOGICAL)
        if source.exists():
            return read_orderedmap_file_raw_rows(source, ACTION_SKILL_LOGICAL)
    raise FileNotFoundError(f"cannot read {ACTION_SKILL_LOGICAL} from target/source stores")


def write_action_skill_table(ordered: OrderedMap, target_store: Path, backup_suffix: str) -> Path:
    target = table_path(target_store, ACTION_SKILL_LOGICAL)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        backup = target.with_name(target.name + backup_suffix)
        if not backup.exists():
            shutil.copy2(target, backup)
            print(f"backup: {backup}")
    target.write_bytes(build_orderedmap_raw_rows(ordered))
    return target


def readable_orderedmap(path: Path, logical_path: str, min_keys: int = 2) -> bool:
    try:
        ordered = read_orderedmap_file(path, logical_path)
    except Exception:
        return False
    return len(ordered.keys) >= min_keys


def load_table(logical_path: str, target_store: Path, source_store: Path | None = None) -> OrderedMap:
    target = table_path(target_store, logical_path)
    if target.exists() and readable_orderedmap(target, logical_path):
        return read_orderedmap_file(target, logical_path)

    if source_store:
        source = table_path(source_store, logical_path)
        if source.exists() and readable_orderedmap(source, logical_path):
            return read_orderedmap_file(source, logical_path)

    raise FileNotFoundError(f"cannot read {logical_path} from target/source stores")


def write_table(ordered: OrderedMap, target_store: Path, backup_suffix: str, no_backup: bool = False) -> Path:
    target = table_path(target_store, ordered.logical_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and not no_backup:
        backup = target.with_name(target.name + backup_suffix)
        if not backup.exists():
            shutil.copy2(target, backup)
            print(f"backup: {backup}")
        else:
            print(f"backup exists: {backup}")
    target.write_bytes(build_orderedmap(ordered))
    return target


def read_csv_lines(text: str) -> list[list[str]]:
    if not text:
        return []
    rows = []
    for line in text.splitlines():
        if line == "":
            continue
        rows.append(next(csv.reader([line])))
    return rows


def write_csv_lines(rows: list[list[str]]) -> str:
    out_lines = []
    for row in rows:
        buf = io.StringIO()
        writer = csv.writer(buf, lineterminator="")
        writer.writerow(row)
        out_lines.append(buf.getvalue())
    return "\n".join(out_lines)


def normalize_row_length(row: list[str], length: int) -> list[str]:
    if len(row) < length:
        return row + [""] * (length - len(row))
    return row


def load_ability_schema(target_store: Path, source_store: Path | None = None) -> list[dict[str, Any]]:
    candidates = [target_store / ABILITY_SCHEMA_REL]
    if source_store:
        candidates.append(source_store / ABILITY_SCHEMA_REL)

    for path in candidates:
        if not path.exists():
            continue
        try:
            raw = zlib.decompress(path.read_bytes(), -15)
            schema = AMF3Reader(raw).read_value()
            value_schema = schema["valueSchema"]
            value_schema.sort(key=lambda item: int(item["index"]))
            return value_schema
        except Exception:
            pass

    raise FileNotFoundError("ability schema file was not found or could not be parsed")


def schema_names(schema: list[dict[str, Any]]) -> list[str]:
    size = max(int(item["index"]) for item in schema) + 1
    names = [""] * size
    for item in schema:
        names[int(item["index"])] = item["columnName"]
    return names


def schema_index(schema: list[dict[str, Any]]) -> dict[str, int]:
    return {item["columnName"]: int(item["index"]) for item in schema}


def expand_fields(fields: Any, index_by_name: dict[str, int]) -> list[int]:
    if fields is None:
        return []
    if isinstance(fields, str):
        fields = [fields]
    result: list[int] = []
    for field in fields:
        if isinstance(field, int):
            idx = field
        elif isinstance(field, str) and field.isdigit():
            idx = int(field)
        elif isinstance(field, str) and field in ABILITY_ALIASES:
            for alias_field in ABILITY_ALIASES[field]:
                if alias_field in index_by_name:
                    result.append(index_by_name[alias_field])
            continue
        elif isinstance(field, str) and field in index_by_name:
            idx = index_by_name[field]
        else:
            raise KeyError(f"unknown ability field or alias: {field}")
        if idx not in result:
            result.append(idx)
    return result


def ability_ids_for_character(character: str, character_table: OrderedMap | None = None) -> list[str]:
    character = str(character)
    ids = [f"{character}{slot}" for slot in range(1, 7)]
    if not character_table:
        return ids

    for row_text in character_table.text_rows().values():
        rows = read_csv_lines(row_text)
        if not rows:
            continue
        row = rows[0]
        row = normalize_row_length(row, max(CHARACTER_COLUMNS.values()) + 1)
        if row[CHARACTER_COLUMNS["character_id"]] == character or row[CHARACTER_COLUMNS["code_name"]] == character:
            return [value for value in row[19:25] if value]
    return ids


def row_matches(
    key: str,
    line_index: int,
    row: list[str],
    match: dict[str, Any] | None,
    names: list[str],
    index_by_name: dict[str, int],
    character_table: OrderedMap | None,
) -> bool:
    if not match:
        return True

    if "ability" in match:
        abilities = match["ability"]
        if isinstance(abilities, (str, int)):
            abilities = [str(abilities)]
        else:
            abilities = [str(value) for value in abilities]
        if key not in abilities:
            return False

    if "character" in match:
        chars = match["character"]
        if isinstance(chars, (str, int)):
            chars = [str(chars)]
        else:
            chars = [str(value) for value in chars]
        allowed: set[str] = set()
        for char in chars:
            allowed.update(ability_ids_for_character(char, character_table))
        if key not in allowed:
            return False

    if "string_id" in match:
        value = str(match["string_id"])
        if not row or row[0] != value:
            return False

    if "text" in match:
        needle = str(match["text"])
        if needle not in ",".join(row):
            return False

    if "line" in match and int(match["line"]) != line_index:
        return False

    where = match.get("where") or {}
    for field, expected in where.items():
        idx = expand_fields([field], index_by_name)[0]
        row = normalize_row_length(row, idx + 1)
        if row[idx] != str(expected):
            return False

    return True


def format_decimal(value: Decimal) -> str:
    if value == value.to_integral_value():
        return str(int(value))
    text = format(value.normalize(), "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def scale_text(value: str, factor: Decimal, rounding: str = "int") -> str | None:
    if value in ("", "(None)", "None", "false", "true"):
        return None
    try:
        number = Decimal(value)
    except InvalidOperation:
        return None
    new_value = number * factor
    if rounding == "keep":
        return format_decimal(new_value)
    if rounding == "floor":
        return str(int(new_value))
    if rounding == "ceil":
        integral = int(new_value)
        if new_value != new_value.to_integral_value() and new_value > 0:
            integral += 1
        return str(integral)
    quantized = new_value.quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    return str(int(quantized))


def apply_remove_main_position(row: list[str], index_by_name: dict[str, int]) -> tuple[list[str], list[str]]:
    changes = []
    unisonable_idx = index_by_name.get("unisonable", 1)
    row = normalize_row_length(row, unisonable_idx + 1)
    if row[unisonable_idx] == "false":
        row[unisonable_idx] = "true"
        changes.append("unisonable false -> true")
    for i, value in enumerate(row):
        if value == "202":
            row[i] = "0"
            changes.append(f"field {i} OwnerIsMain(202) -> 0")
    return row, changes


def describe_row(key: str, line_index: int, row: list[str], names: list[str]) -> dict[str, str]:
    out = {"ability": key, "line": str(line_index)}
    for idx, name in enumerate(names):
        value = row[idx] if idx < len(row) else ""
        if value:
            out[f"{idx}:{name}"] = value
    return out


def iter_ability_lines(ordered: OrderedMap):
    for key, text in ordered.text_rows().items():
        for line_index, row in enumerate(read_csv_lines(text), start=1):
            yield key, line_index, row


def cmd_schema(args: argparse.Namespace) -> None:
    profile = resolve_profile(getattr(args, "profile", None))
    target_store = resolve_target_store(args.target_store, profile)
    source_store = resolve_source_store(args.source_store, profile)
    schema = load_ability_schema(target_store, source_store)
    rows = []
    for item in schema:
        constructors = item["type"].get("constructors") or {}
        rows.append({
            "index": item["index"],
            "columnName": item["columnName"],
            "isDecimal": item["type"].get("isDecimal"),
            "enumCount": len(constructors),
        })

    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        if out.suffix.lower() == ".json":
            out.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
        else:
            with out.open("w", newline="", encoding="utf-8-sig") as fh:
                writer = csv.DictWriter(fh, fieldnames=["index", "columnName", "isDecimal", "enumCount"])
                writer.writeheader()
                writer.writerows(rows)
        print(f"schema exported: {out}")
        return

    for row in rows:
        print(f"{int(row['index']):03d} {row['columnName']}")


def load_character_table_for_lookup(target_store: Path, source_store: Path | None) -> OrderedMap | None:
    try:
        return load_table(CHARACTER_LOGICAL, target_store, source_store)
    except Exception:
        return None


def cmd_list(args: argparse.Namespace) -> None:
    profile = resolve_profile(getattr(args, "profile", None))
    target_store = resolve_target_store(args.target_store, profile)
    source_store = resolve_source_store(args.source_store, profile)
    schema = load_ability_schema(target_store, source_store)
    names = schema_names(schema)
    index_by_name = schema_index(schema)
    ability_table = load_table(ABILITY_LOGICAL, target_store, source_store)
    character_table = load_character_table_for_lookup(target_store, source_store)

    match: dict[str, Any] = {}
    if args.character:
        match["character"] = args.character
    if args.ability:
        match["ability"] = args.ability
    if args.text:
        match["text"] = args.text

    # 默认列改为按列名 / 别名派生(版本无关):裸下标会随 schema 版本错位(见版本切换设计.md)。
    # 0/1 = string_id/unisonable 是所有版本固定前置列;威力列走 skill_strength 别名。
    selected_fields = expand_fields(args.fields, index_by_name) if args.fields else (
        [0, 1] + expand_fields(["skill_strength"], index_by_name)
    )

    count = 0
    for key, line_index, row in iter_ability_lines(ability_table):
        if not row_matches(key, line_index, row, match, names, index_by_name, character_table):
            continue
        count += 1
        print(f"[{key} line {line_index}]")
        for idx in selected_fields:
            value = row[idx] if idx < len(row) else ""
            if value:
                print(f"  {idx:03d} {names[idx]} = {value}")
    print(f"matched_lines: {count}")


def cmd_export(args: argparse.Namespace) -> None:
    profile = resolve_profile(getattr(args, "profile", None))
    target_store = resolve_target_store(args.target_store, profile)
    source_store = resolve_source_store(args.source_store, profile)
    schema = load_ability_schema(target_store, source_store)
    names = schema_names(schema)
    index_by_name = schema_index(schema)
    ability_table = load_table(ABILITY_LOGICAL, target_store, source_store)
    character_table = load_character_table_for_lookup(target_store, source_store)

    match: dict[str, Any] = {}
    if args.character:
        match["character"] = args.character
    if args.ability:
        match["ability"] = args.ability
    if args.text:
        match["text"] = args.text

    rows = []
    for key, line_index, row in iter_ability_lines(ability_table):
        if row_matches(key, line_index, row, match, names, index_by_name, character_table):
            rows.append((key, line_index, normalize_row_length(row, len(names))))

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.suffix.lower() == ".json":
        payload = []
        for key, line_index, row in rows:
            payload.append({
                "_ability": key,
                "_line": line_index,
                **{name: row[i] for i, name in enumerate(names)},
            })
        out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    else:
        with out.open("w", newline="", encoding="utf-8-sig") as fh:
            fieldnames = ["_ability", "_line"] + names
            writer = csv.DictWriter(fh, fieldnames=fieldnames)
            writer.writeheader()
            for key, line_index, row in rows:
                writer.writerow({"_ability": key, "_line": line_index, **{name: row[i] for i, name in enumerate(names)}})
    print(f"exported_lines: {len(rows)}")
    print(f"out: {out}")


def read_import_records(path: Path, names: list[str]) -> list[tuple[str, int, list[str]]]:
    records: list[tuple[str, int, list[str]]] = []
    if path.suffix.lower() == ".json":
        payload = json.loads(path.read_text(encoding="utf-8"))
        for item in payload:
            ability = str(item["_ability"])
            line = int(item["_line"])
            row = [str(item.get(name, "")) for name in names]
            records.append((ability, line, row))
        return records

    with path.open("r", newline="", encoding="utf-8-sig") as fh:
        for item in csv.DictReader(fh):
            ability = str(item["_ability"])
            line = int(item["_line"])
            row = [str(item.get(name, "")) for name in names]
            records.append((ability, line, row))
    return records


def cmd_import(args: argparse.Namespace) -> None:
    profile = resolve_profile(getattr(args, "profile", None))
    target_store = resolve_target_store(args.target_store, profile)
    source_store = resolve_source_store(args.source_store, profile)
    schema = load_ability_schema(target_store, source_store)
    names = schema_names(schema)
    ability_table = load_table(ABILITY_LOGICAL, target_store, source_store)
    edited = Path(args.edited)
    records = read_import_records(edited, names)
    parsed = {key: read_csv_lines(text) for key, text in ability_table.text_rows().items()}

    changes = 0
    for ability, line, new_row in records:
        if ability not in parsed:
            raise ValueError(f"ability not found: {ability}")
        if line < 1 or line > len(parsed[ability]):
            raise ValueError(f"line out of range: {ability} line {line}")
        old_row = normalize_row_length(parsed[ability][line - 1], len(names))
        new_row = normalize_row_length(new_row, len(names))
        changed_fields = []
        for idx, (old, new) in enumerate(zip(old_row, new_row)):
            if old != new:
                changed_fields.append((idx, old, new))
        if not changed_fields:
            continue
        changes += len(changed_fields)
        parsed[ability][line - 1] = new_row
        preview = ", ".join(
            f"{names[idx]} {old!r}->{new!r}" for idx, old, new in changed_fields[:8]
        )
        suffix = "" if len(changed_fields) <= 8 else f", ... +{len(changed_fields) - 8}"
        print(f"{ability} line {line}: {preview}{suffix}")

    print(f"total_changes: {changes}")
    if args.dry_run:
        print("dry_run: no files were written")
        return

    ability_table.set_text_rows({key: write_csv_lines(rows) for key, rows in parsed.items()})
    suffix = ".bak-wfmod-import-" + time.strftime("%Y%m%d-%H%M%S")
    target = write_table(ability_table, target_store, suffix, args.no_backup)
    print(f"written: {target}")
    print(f"bytes: {target.stat().st_size}")


def apply_recipe_to_ability(
    ability_table: OrderedMap,
    schema: list[dict[str, Any]],
    recipe: dict[str, Any],
    character_table: OrderedMap | None,
    dry_run: bool,
) -> int:
    names = schema_names(schema)
    index_by_name = schema_index(schema)
    row_map = ability_table.text_rows()
    parsed = {key: read_csv_lines(text) for key, text in row_map.items()}
    total_changes = 0

    operations = recipe.get("operations")
    if not isinstance(operations, list):
        raise ValueError("recipe must contain an operations array")

    for op_index, op in enumerate(operations, start=1):
        op_name = op.get("op")
        op_changes = 0
        print(f"operation {op_index}: {op_name}")

        if op_name == "remove_main_position":
            match = op.get("match")
            for key, rows in parsed.items():
                for line_index, row in enumerate(rows, start=1):
                    if not row_matches(key, line_index, row, match, names, index_by_name, character_table):
                        continue
                    before = list(row)
                    row, changes = apply_remove_main_position(row, index_by_name)
                    if changes:
                        rows[line_index - 1] = row
                        op_changes += len(changes)
                        print(f"  {key} line {line_index}: {', '.join(changes)}")
                    elif before != row:
                        rows[line_index - 1] = row

        elif op_name == "set":
            match = op.get("match")
            fields = expand_fields(op.get("field") or op.get("fields"), index_by_name)
            value = str(op.get("value", ""))
            for key, rows in parsed.items():
                for line_index, row in enumerate(rows, start=1):
                    if not row_matches(key, line_index, row, match, names, index_by_name, character_table):
                        continue
                    row = normalize_row_length(row, len(names))
                    for idx in fields:
                        old = row[idx]
                        if old != value:
                            row[idx] = value
                            op_changes += 1
                            print(f"  {key} line {line_index}: {names[idx]} {old!r} -> {value!r}")
                    rows[line_index - 1] = row

        elif op_name == "scale":
            match = op.get("match")
            fields = expand_fields(op.get("field") or op.get("fields") or "skill_strength", index_by_name)
            factor = Decimal(str(op.get("factor", "1")))
            rounding = op.get("rounding", "int")
            for key, rows in parsed.items():
                for line_index, row in enumerate(rows, start=1):
                    if not row_matches(key, line_index, row, match, names, index_by_name, character_table):
                        continue
                    row = normalize_row_length(row, len(names))
                    for idx in fields:
                        old = row[idx]
                        new_value = scale_text(old, factor, rounding)
                        if new_value is not None and new_value != old:
                            row[idx] = new_value
                            op_changes += 1
                            print(f"  {key} line {line_index}: {names[idx]} {old} -> {new_value}")
                    rows[line_index - 1] = row

        elif op_name == "copy_ability":
            from_character = str(op.get("from_character", ""))
            to_character = str(op.get("to_character", ""))
            if not from_character or not to_character:
                raise ValueError("copy_ability requires from_character and to_character")
            slots = op.get("slots") or [1, 2, 3, 4, 5, 6]
            preserve = op.get("preserve_fields", ["string_id"])
            preserve_indices = expand_fields(preserve, index_by_name) if preserve else []
            copy_fields = op.get("fields")
            copy_indices = expand_fields(copy_fields, index_by_name) if copy_fields else None
            source_ids = ability_ids_for_character(from_character, character_table)
            target_ids = ability_ids_for_character(to_character, character_table)
            for slot in slots:
                src_key = source_ids[int(slot) - 1] if int(slot) - 1 < len(source_ids) else f"{from_character}{slot}"
                dst_key = target_ids[int(slot) - 1] if int(slot) - 1 < len(target_ids) else f"{to_character}{slot}"
                if src_key not in parsed or dst_key not in parsed:
                    print(f"  skip slot {slot}: {src_key} or {dst_key} not found")
                    continue
                src_rows = [normalize_row_length(list(row), len(names)) for row in parsed[src_key]]
                old_dst_rows = [normalize_row_length(list(row), len(names)) for row in parsed[dst_key]]
                if copy_indices is None:
                    new_rows = [list(row) for row in src_rows]
                    for line_i, new_row in enumerate(new_rows):
                        old_row = old_dst_rows[line_i] if line_i < len(old_dst_rows) else []
                        old_row = normalize_row_length(old_row, len(names))
                        for idx in preserve_indices:
                            new_row[idx] = old_row[idx]
                    parsed[dst_key] = new_rows
                    op_changes += 1
                    print(f"  slot {slot}: replace {dst_key} rows from {src_key}")
                else:
                    if not old_dst_rows:
                        old_dst_rows = [[""] * len(names) for _ in src_rows]
                    for line_i, src_row in enumerate(src_rows):
                        if line_i >= len(old_dst_rows):
                            old_dst_rows.append([""] * len(names))
                        for idx in copy_indices:
                            old = old_dst_rows[line_i][idx]
                            new_value = src_row[idx]
                            if old != new_value:
                                old_dst_rows[line_i][idx] = new_value
                                op_changes += 1
                                print(f"  {dst_key} line {line_i + 1}: {names[idx]} {old!r} -> {new_value!r}")
                    parsed[dst_key] = old_dst_rows

        elif op_name == "copy_fields":
            source_match = op.get("from") or op.get("source")
            target_match = op.get("to") or op.get("target")
            fields = expand_fields(op.get("fields"), index_by_name)
            if not source_match or not target_match or not fields:
                raise ValueError("copy_fields requires from, to, and fields")
            sources = []
            targets = []
            for key, rows in parsed.items():
                for line_index, row in enumerate(rows, start=1):
                    if row_matches(key, line_index, row, source_match, names, index_by_name, character_table):
                        sources.append((key, line_index, normalize_row_length(row, len(names))))
                    if row_matches(key, line_index, row, target_match, names, index_by_name, character_table):
                        targets.append((key, line_index, row))
            if len(sources) != 1:
                raise ValueError(f"copy_fields expected one source row, got {len(sources)}")
            source_row = sources[0][2]
            for key, line_index, row in targets:
                row = normalize_row_length(row, len(names))
                for idx in fields:
                    old = row[idx]
                    new_value = source_row[idx]
                    if old != new_value:
                        row[idx] = new_value
                        op_changes += 1
                        print(f"  {key} line {line_index}: {names[idx]} {old!r} -> {new_value!r}")
                parsed[key][line_index - 1] = row

        else:
            raise ValueError(f"unknown operation: {op_name}")

        print(f"  changes: {op_changes}")
        total_changes += op_changes

    if not dry_run:
        ability_table.set_text_rows({key: write_csv_lines(rows) for key, rows in parsed.items()})

    return total_changes


def cmd_apply(args: argparse.Namespace) -> None:
    profile = resolve_profile(getattr(args, "profile", None))
    target_store = resolve_target_store(args.target_store, profile)
    source_store = resolve_source_store(args.source_store, profile)
    schema = load_ability_schema(target_store, source_store)
    ability_table = load_table(ABILITY_LOGICAL, target_store, source_store)
    character_table = load_character_table_for_lookup(target_store, source_store)
    recipe = json.loads(Path(args.recipe).read_text(encoding="utf-8"))

    changes = apply_recipe_to_ability(ability_table, schema, recipe, character_table, args.dry_run)
    print(f"total_changes: {changes}")
    if args.dry_run:
        print("dry_run: no files were written")
        return

    suffix = ".bak-wfmod-" + time.strftime("%Y%m%d-%H%M%S")
    target = write_table(ability_table, target_store, suffix, args.no_backup)
    print(f"written: {target}")
    print(f"bytes: {target.stat().st_size}")


def resolve_target_store(value: str | None, profile: "VersionProfile | None" = None) -> Path:
    if value:
        return Path(value)
    if profile:
        return profile.store
    store = default_target_store()
    if store:
        return store
    raise SystemExit("target store not found; pass --target-store or configure mod-tools/profiles.json")


def resolve_source_store(value: str | None, profile: "VersionProfile | None" = None) -> Path | None:
    if value:
        return Path(value)
    if profile:
        return profile.fallback  # 档案默认 fallback=None:禁止跨版本静默兜底(见版本切换设计.md)
    return default_source_store()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="WF offline orderedmap mod tool")
    parser.add_argument("--target-store", help="Offline production/upload store to read/write")
    parser.add_argument("--source-store", help="Full production/upload store used as fallback")
    parser.add_argument("--profile", help="Version profile id from mod-tools/profiles.json (default: active profile)")
    sub = parser.add_subparsers(dest="cmd", required=True)

    schema = sub.add_parser("schema", help="Print or export ability column schema")
    schema.add_argument("--out", help="CSV/JSON output path")
    schema.set_defaults(func=cmd_schema)

    list_cmd = sub.add_parser("list", help="List ability rows")
    list_cmd.add_argument("--character", help="Character id or code_name")
    list_cmd.add_argument("--ability", action="append", help="Ability id, repeatable")
    list_cmd.add_argument("--text", help="Search text in a row")
    list_cmd.add_argument("--fields", nargs="+", help="Field names, indexes, or aliases")
    list_cmd.set_defaults(func=cmd_list)

    export_cmd = sub.add_parser("export", help="Export ability rows to CSV/JSON")
    export_cmd.add_argument("--out", required=True)
    export_cmd.add_argument("--character", help="Character id or code_name")
    export_cmd.add_argument("--ability", action="append", help="Ability id, repeatable")
    export_cmd.add_argument("--text", help="Search text in a row")
    export_cmd.set_defaults(func=cmd_export)

    import_cmd = sub.add_parser("import", help="Import edited ability CSV/JSON exported by this tool")
    import_cmd.add_argument("--edited", required=True)
    import_cmd.add_argument("--dry-run", action="store_true")
    import_cmd.add_argument("--no-backup", action="store_true")
    import_cmd.set_defaults(func=cmd_import)

    apply_cmd = sub.add_parser("apply", help="Apply an ability recipe JSON")
    apply_cmd.add_argument("--recipe", required=True)
    apply_cmd.add_argument("--dry-run", action="store_true")
    apply_cmd.add_argument("--no-backup", action="store_true")
    apply_cmd.set_defaults(func=cmd_apply)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    try:
        args.func(args)
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
