#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""wf_rogue_rewards.py — 深渊连战奖励体系:深渊代币 + 15 把专属武装。

代币:克隆官方「激战代币」(item 2370007,23列)→ **2370099「深渊代币」**
  (图标暂复用激战代币;通关每轮由 rogue_event.json 掉落,后续接兑换商店)。
专属武装:每属性 2 把 + 通用 3 把 = 15 键(8000101-8000115),装备元数据
  从既有供体行构建,词条只取经过验证的官方模板首行。
同步:assets/equipment_max_level.json / equipment_element.json / equipment_lookup.json /
  equipment_ids.json / item_ids.json(后两个=邮件校验,静态 import 须重启服务端)。

用法(项目根,默认 dry-run):
  python mod-tools/wf_rogue_rewards.py --write --publish
"""
import argparse
import copy
import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, UnidentifiedImageError

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "mod-tools"))
import wf_quest_lib as q          # noqa: E402
import wf_mod_tool as core        # noqa: E402
import wf_describe                # noqa: E402
import wf_assets                  # noqa: E402
import wf_rogue_build as rogue_build  # noqa: E402

ITEM_T = "master/item/item.orderedmap"
EQUIP_T = "master/item/equipment.orderedmap"
EQUIP_STATUS_T = "master/item/equipment_status.orderedmap"
SOUL_T = "master/ability/ability_soul.orderedmap"
RUSH_EVENT_T = "master/quest/event/rush_event.orderedmap"

TOKEN_ID = "2370099"
TOKEN_TEMPLATE = "2370007"     # 激战代币
EVENT_ID = "700099"
TOKEN_DESCRIPTION = "在「深渊连战」中获得的深渊结晶。凝聚着历战boss的力量,可用于锻造深渊武装。"

MODE_DESCRIPTION = "【深渊连战专属】仅在深渊连战、宝物域连战 2001 与练习关生效,其余关卡与官方一致。"
IMAGE_PREFIX = "item/equipment/mod/abyss"
ABILITY_SOUL_ALL_ELEMENTS = "0,3,2,1,4,5"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
SOURCE_ASSET_SIZE = (20, 20)
SOURCE_ASSET_DIR = Path(ROOT) / "mod-tools" / "assets" / "abyss-equipment"


@dataclass(frozen=True)
class EffectSpec:
    template_id: str
    effect_kind: str
    strength: int


@dataclass(frozen=True)
class WeaponSpec:
    id: str
    name: str
    donor: str
    element: int
    group: str
    image_slug: str
    effects: tuple[EffectSpec, ...]


@dataclass(frozen=True)
class MasterTables:
    items: dict[str, object]
    equipment: dict[str, object]
    equipment_status: dict[str, object]
    ability_soul: dict[str, object]
    rush_event: dict[str, object]


@dataclass(frozen=True)
class MasterChanges:
    items: dict[str, object]
    equipment: dict[str, object]
    equipment_status: dict[str, object]
    ability_soul: dict[str, object]
    rush_event: dict[str, object]


@dataclass(frozen=True)
class ServerMirrors:
    equipment_max_level: dict[str, object]
    equipment_element: dict[str, object]
    equipment_lookup: dict[str, object]
    equipment_ids: list[int]
    item_ids: list[int]


# 强度分档(2026-07-17 收尾):属性拾贰把 = 官方顶级武器天花板 ×2(单条封顶 2,000,000=2000%),
# 通用叁把 = 官方天花板 ×1(单条封顶 1,000,000)。各把等比压到本档上限、保留原设计的主次配比,
# 属性武器的签名词条(伤害类)仍最突出。官方顶级武器实测封顶约 1,000,000,故属性把仍明显超模、
# 连战里强力,但不再是数量级碾压;通用把定位"任意属性可用、单条数值让位于泛用性"。
WEAPONS: tuple[WeaponSpec, ...] = (
    WeaponSpec("8000101", "灰烬巨剑", "5010060", 0, "Red", "fire_01", (
        EffectSpec("3020006", "32", 1_200_000),
        EffectSpec("5050009", "55", 2_000_000),
    )),
    WeaponSpec("8000102", "熔核法杖", "5020042", 0, "Red", "fire_02", (
        EffectSpec("4020013", "34", 2_000_000),
        EffectSpec("3050010", "211", 400_000),
    )),
    WeaponSpec("8000103", "深潮长枪", "5010075", 1, "Blue", "water_01", (
        EffectSpec("3020006", "32", 1_200_000),
        EffectSpec("5070035", "33", 2_000_000),
    )),
    WeaponSpec("8000104", "冻海战锚", "5020031", 1, "Blue", "water_02", (
        EffectSpec("3040003", "205", 1_000_000),
        EffectSpec("3010013", "195", 1_000_000),
        EffectSpec("3050010", "211", 1_000_000),
    )),
    WeaponSpec("8000105", "雷鸣双刃", "5010077", 2, "Yellow", "thunder_01", (
        EffectSpec("3020006", "32", 1_200_000),
        EffectSpec("5070035", "33", 2_000_000),
    )),
    WeaponSpec("8000106", "轰电战锤", "5020038", 2, "Yellow", "thunder_02", (
        EffectSpec("4020013", "34", 2_000_000),
        EffectSpec("3050010", "211", 400_000),
    )),
    WeaponSpec("8000107", "裂空战镰", "5010068", 3, "Green", "wind_01", (
        EffectSpec("3020006", "32", 1_200_000),
        EffectSpec("5070035", "33", 2_000_000),
    )),
    WeaponSpec("8000108", "苍岚长弓", "5020026", 3, "Green", "wind_02", (
        EffectSpec("4020013", "34", 2_000_000),
        EffectSpec("3050010", "211", 400_000),
    )),
    WeaponSpec("8000109", "晨星圣剑", "5017716", 4, "White", "light_01", (
        EffectSpec("3020006", "32", 1_200_000),
        EffectSpec("5090029", "388", 2_000_000),
    )),
    WeaponSpec("8000110", "辉环法器", "5020039", 4, "White", "light_02", (
        EffectSpec("3040003", "205", 650_000),
        EffectSpec("3010013", "195", 650_000),
        EffectSpec("4020013", "34", 2_000_000),
    )),
    WeaponSpec("8000111", "蚀月大剑", "5010078", 5, "Black", "dark_01", (
        EffectSpec("3020006", "32", 2_000_000),
        EffectSpec("4020013", "34", 2_000_000),
    )),
    WeaponSpec("8000112", "冥灯魔杖", "5020040", 5, "Black", "dark_02", (
        EffectSpec("5090029", "388", 2_000_000),
        EffectSpec("3050010", "211", 400_000),
    )),
    WeaponSpec("8000113", "深渊征服者", "5010057", -1, "(None)", "universal_01", (
        EffectSpec("3020006", "32", 1_000_000),
        EffectSpec("3040003", "205", 350_000),
    )),
    WeaponSpec("8000114", "深渊轮转核", "5020010", -1, "(None)", "universal_02", (
        EffectSpec("4020013", "34", 1_000_000),
        EffectSpec("3050010", "211", 200_000),
    )),
    WeaponSpec("8000115", "深渊万象铳", "5090045", -1, "(None)", "universal_03", (
        EffectSpec("5070035", "33", 1_000_000),
        EffectSpec("5050009", "55", 500_000),
        EffectSpec("5090029", "388", 500_000),
    )),
)


def validate_source_assets(
    asset_dir: Path, specs: tuple[WeaponSpec, ...],
) -> dict[str, Path]:
    """严格校验 15 张源 PNG，并按固定 image_slug 返回路径。"""
    if len(specs) != 15:
        raise ValueError(f"深渊武装源图必须正好 15 张,实际规格数 {len(specs)}")
    slugs = [spec.image_slug for spec in specs]
    if len(set(slugs)) != len(slugs):
        raise ValueError("深渊武装 image_slug 必须全部唯一")

    asset_dir = Path(asset_dir)
    expected_names = {f"{slug}.png" for slug in slugs}
    try:
        actual_names = {path.name for path in asset_dir.iterdir()}
    except OSError as exc:
        raise ValueError(f"无法读取源 PNG 目录 {asset_dir}: {exc}") from exc
    missing_names = sorted(expected_names.difference(actual_names))
    unexpected_names = sorted(actual_names.difference(expected_names))
    if missing_names or unexpected_names:
        raise ValueError(
            f"源 PNG 清单必须精确匹配 15 个固定文件: "
            f"missing={missing_names}, unexpected={unexpected_names}"
        )

    sources: dict[str, Path] = {}
    hashes: dict[str, str] = {}
    for spec in specs:
        source = asset_dir / f"{spec.image_slug}.png"
        if not source.is_file():
            raise ValueError(f"缺少源 PNG: {source.name}")

        try:
            source_bytes = source.read_bytes()
        except OSError as exc:
            raise ValueError(f"无法读取源 PNG {source.name}: {exc}") from exc
        if source_bytes[:8] != PNG_SIGNATURE:
            raise ValueError(f"{source.name} 不是标准 PNG(魔数不对)")

        try:
            image = Image.open(io.BytesIO(source_bytes))
            with image:
                image.load()
                if image.format != "PNG":
                    raise ValueError(
                        f"{source.name} Pillow 格式必须是 PNG,实际 {image.format}"
                    )
                if image.size != SOURCE_ASSET_SIZE:
                    raise ValueError(
                        f"{source.name} 尺寸必须是 "
                        f"{SOURCE_ASSET_SIZE[0]}x{SOURCE_ASSET_SIZE[1]},实际 "
                        f"{image.size[0]}x{image.size[1]}"
                    )
                if image.mode != "RGBA":
                    raise ValueError(
                        f"{source.name} 模式必须是 RGBA,实际 {image.mode}"
                    )

                alpha = image.getchannel("A")
                alpha_min, alpha_max = alpha.getextrema()
                if alpha_min != 0:
                    raise ValueError(f"{source.name} 必须包含全透明像素")
                if alpha_max <= 0:
                    raise ValueError(f"{source.name} 不能是全透明图")

                bounds = alpha.getbbox()
                if bounds is None:
                    raise ValueError(f"{source.name} 没有可见像素")
        except (UnidentifiedImageError, OSError) as exc:
            raise ValueError(f"{source.name} 不是可解码 PNG: {exc}") from exc

        digest = hashlib.sha256(source_bytes).hexdigest()
        duplicate = hashes.get(digest)
        if duplicate is not None:
            raise ValueError(
                f"源 PNG 内容重复: {duplicate}.png 与 {spec.image_slug}.png"
            )
        hashes[digest] = spec.image_slug
        sources[spec.image_slug] = source

    if len(hashes) != 15:
        raise ValueError(f"源 PNG 必须有 15 个不同 SHA-256,实际 {len(hashes)}")
    return sources


def install_source_assets(
    store: Path, sources: dict[str, Path], specs: tuple[WeaponSpec, ...],
) -> list[str]:
    """仅转换 PNG 魔数并写入固定逻辑路径的 upload 哈希位置。"""
    expected_slugs = [spec.image_slug for spec in specs]
    missing = [slug for slug in expected_slugs if slug not in sources]
    unexpected = sorted(set(sources).difference(expected_slugs))
    if missing or unexpected:
        raise ValueError(
            f"源 PNG 映射不完整: missing={missing}, unexpected={unexpected}"
        )

    store = Path(store)
    installed: list[str] = []
    for spec in specs:
        source = Path(sources[spec.image_slug])
        try:
            source_bytes = source.read_bytes()
        except OSError as exc:
            raise ValueError(f"无法读取源 PNG {source.name}: {exc}") from exc
        stored_bytes = wf_assets.png_encode(source_bytes)
        logical = f"{IMAGE_PREFIX}/{spec.image_slug}.png"
        relative = q.hashed_rel(logical)
        destination = store / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(stored_bytes)

        readback = destination.read_bytes()
        if wf_assets.png_decode(readback) != source_bytes:
            raise RuntimeError(f"PNG 写后复读不一致: {logical}")
        installed.append(relative)

    if len(installed) != 15 or len(set(installed)) != 15:
        raise RuntimeError(
            f"PNG 安装路径必须是 15 个不同哈希路径,实际 {len(set(installed))}"
        )
    return installed


def _leaf_text(leaf: bytes | str) -> str:
    return leaf.decode("utf-8") if isinstance(leaf, bytes) else leaf


def _join_like(rows: list[list[str]], like: bytes | str) -> bytes | str:
    text = core.write_csv_lines(rows)
    return text.encode("utf-8") if isinstance(like, bytes) else text


def cells(leaf) -> list[str]:
    return core.read_csv_lines(_leaf_text(leaf))[0]


def join_like(row: list[str], like) -> bytes | str:
    return _join_like([row], like)


def build_equipment_leaf(template_leaf: bytes | str, spec: WeaponSpec) -> bytes | str:
    """从供体装备首行构建一条固定的深渊武装行。"""
    row = list(core.read_csv_lines(_leaf_text(template_leaf))[0])
    row = core.normalize_row_length(row, 16)
    row[0] = f"mod_abyss_{spec.id}"
    row[1] = spec.name
    row[6] = f"{IMAGE_PREFIX}/{spec.image_slug}"
    row[7] = MODE_DESCRIPTION
    row[8] = "5"
    row[9] = "true"
    row[10] = spec.id
    row[11] = "5"
    return _join_like([row], template_leaf)


def build_ability_soul_item_leaf(
    template_leaf: bytes | str, spec: WeaponSpec,
) -> bytes | str:
    """Register the same-ID ability soul item required by detail/upgrade views."""
    row = list(core.read_csv_lines(_leaf_text(template_leaf))[0])
    row = core.normalize_row_length(row, 23)
    row[0] = f"mod_abyss_{spec.id}"
    row[1] = spec.id
    row[2] = f"{spec.name}魂珠"
    row[3] = f"{IMAGE_PREFIX}/{spec.image_slug}"
    row[12] = (
        str(spec.element) if spec.element >= 0 else ABILITY_SOUL_ALL_ELEMENTS
    )
    return _join_like([row], template_leaf)


def build_soul_leaf(
    template_table: dict[str, bytes | str], spec: WeaponSpec,
) -> bytes | str:
    """按声明顺序各取一个模板的首行，构建同键 ability_soul。"""
    rows: list[list[str]] = []
    output_like: bytes | str = ""
    for slot, effect in enumerate(spec.effects, start=1):
        template_leaf = template_table[effect.template_id]
        if slot == 1:
            output_like = template_leaf
        row = list(core.read_csv_lines(_leaf_text(template_leaf))[0])
        row = core.normalize_row_length(row, 123)
        row[0], row[1], row[2] = str(slot), "1", "0"
        row[44] = effect.effect_kind
        row[45] = "5"
        row[46] = spec.group
        row[48] = row[49] = str(effect.strength)
        rows.append(row)
    return _join_like(rows, output_like)


def build_equipment_status(status_table: dict[str, object], spec: WeaponSpec):
    """完整复制供体的所有等级 HP/ATK 映射，且不共享可变对象。"""
    return copy.deepcopy(status_table[spec.donor])


def _require_leaf(value: object, label: str) -> bytes | str:
    if not isinstance(value, (bytes, str)):
        raise ValueError(f"{label} 必须是 CSV 叶子,得到 {type(value).__name__}")
    return value


def assert_reserved_ownership(equipment: dict[str, object]) -> None:
    """拒绝覆盖未带精确深渊所有权标记的保留装备 ID。"""
    for spec in WEAPONS:
        if spec.id not in equipment:
            continue
        leaf = _require_leaf(equipment[spec.id], f"equipment[{spec.id}]")
        try:
            rows = core.read_csv_lines(_leaf_text(leaf))
        except Exception as exc:
            raise ValueError(f"保留装备 ID {spec.id} 的行无法解析") from exc
        marker = f"mod_abyss_{spec.id}"
        if len(rows) != 1 or not rows[0] or rows[0][0] != marker:
            actual = rows[0][0] if rows and rows[0] else "<missing>"
            raise ValueError(
                f"保留装备 ID {spec.id} 已被未知数据占用: c0={actual!r}, "
                f"期望 {marker!r}"
            )


def assert_reserved_item_ownership(items: dict[str, object]) -> None:
    """Reject foreign occupants before writing same-ID ability soul items."""
    for spec in WEAPONS:
        if spec.id not in items:
            continue
        leaf = _require_leaf(items[spec.id], f"item[{spec.id}]")
        try:
            rows = core.read_csv_lines(_leaf_text(leaf))
        except Exception as exc:
            raise ValueError(f"reserved item ID {spec.id} cannot be parsed") from exc
        marker = f"mod_abyss_{spec.id}"
        if len(rows) != 1 or not rows[0] or rows[0][0] != marker:
            actual = rows[0][0] if rows and rows[0] else "<missing>"
            raise ValueError(
                f"reserved item ID {spec.id} is occupied by foreign data: "
                f"c0={actual!r}, expected {marker!r}"
            )


def patch_rush_token(leaf: bytes | str) -> bytes | str:
    """只把 Rush Event 行的 c10 改为深渊代币,并保留叶子类型。"""
    rows = core.read_csv_lines(_leaf_text(leaf))
    if len(rows) != 1 or len(rows[0]) <= 10:
        raise ValueError(f"rush_event[{EVENT_ID}] 必须是至少 11 列的单行 CSV")
    rows[0][10] = TOKEN_ID
    return _join_like(rows, leaf)


def build_token_leaf(template_leaf: bytes | str) -> bytes | str:
    """Clone the complete canonical token template and patch owned columns."""
    rows = core.read_csv_lines(_leaf_text(template_leaf))
    if len(rows) != 1 or len(rows[0]) <= 5:
        raise ValueError(f"item[{TOKEN_TEMPLATE}] must be a single row with 6+ columns")
    row = list(rows[0])
    row[0] = "rogue_event_item_99"
    row[1] = TOKEN_ID
    row[2] = "深渊代币"
    row[5] = TOKEN_DESCRIPTION
    return _join_like([row], template_leaf)


def build_master_changes(tables: MasterTables) -> MasterChanges:
    """纯内存构建五张客户端表;所有占用与依赖在修改副本前完成校验。"""
    assert_reserved_ownership(tables.equipment)
    assert_reserved_item_ownership(tables.items)

    for spec in WEAPONS:
        has_owner = spec.id in tables.equipment
        if not has_owner and (
            spec.id in tables.equipment_status or spec.id in tables.ability_soul
        ):
            raise ValueError(f"保留 ID {spec.id} 存在孤立 soul/status,但没有所有权装备行")
        if spec.donor not in tables.equipment:
            raise ValueError(f"缺少装备供体 {spec.donor}")
        if spec.donor not in tables.items:
            raise ValueError(f"ability soul item donor missing: {spec.donor}")
        if spec.donor not in tables.equipment_status:
            raise ValueError(f"缺少装备状态供体 {spec.donor}")
        missing_templates = [
            effect.template_id for effect in spec.effects
            if effect.template_id not in tables.ability_soul
        ]
        if missing_templates:
            raise ValueError(f"武装 {spec.id} 缺少词条模板: {','.join(missing_templates)}")

    if TOKEN_TEMPLATE not in tables.items:
        raise ValueError(f"缺少代币模板 {TOKEN_TEMPLATE}")
    if EVENT_ID not in tables.rush_event:
        raise ValueError(f"缺少 Rush Event {EVENT_ID}")

    token_template = _require_leaf(
        tables.items[TOKEN_TEMPLATE], f"item[{TOKEN_TEMPLATE}]"
    )
    items = copy.deepcopy(tables.items)
    equipment = copy.deepcopy(tables.equipment)
    equipment_status = copy.deepcopy(tables.equipment_status)
    ability_soul = copy.deepcopy(tables.ability_soul)
    rush_event = copy.deepcopy(tables.rush_event)

    items[TOKEN_ID] = build_token_leaf(token_template)
    for spec in WEAPONS:
        donor_item_leaf = _require_leaf(
            tables.items[spec.donor], f"item[{spec.donor}]"
        )
        items[spec.id] = build_ability_soul_item_leaf(donor_item_leaf, spec)
        donor_leaf = _require_leaf(
            tables.equipment[spec.donor], f"equipment[{spec.donor}]"
        )
        equipment[spec.id] = build_equipment_leaf(donor_leaf, spec)
        equipment_status[spec.id] = build_equipment_status(tables.equipment_status, spec)
        ability_soul[spec.id] = build_soul_leaf(tables.ability_soul, spec)
    if rogue_build.TEMPLATE_EVENT not in tables.rush_event:
        raise ValueError(f"缺少 Rush Event 模板 {rogue_build.TEMPLATE_EVENT}")
    rush_leaf = _require_leaf(tables.rush_event[EVENT_ID], f"rush_event[{EVENT_ID}]")
    rush_template = _require_leaf(
        tables.rush_event[rogue_build.TEMPLATE_EVENT],
        f"rush_event[{rogue_build.TEMPLATE_EVENT}]",
    )
    rush_event[EVENT_ID] = rogue_build.build_event_metadata_leaf(
        rush_template,
        rush_leaf,
    )

    assert_reserved_ownership(equipment)
    generated = {spec.id for spec in WEAPONS}
    for label, table in (
        ("item", items),
        ("equipment", equipment),
        ("equipment_status", equipment_status),
        ("ability_soul", ability_soul),
    ):
        missing = generated.difference(table)
        if missing:
            raise RuntimeError(f"{label} 构建后缺少保留 ID: {sorted(missing)}")
    if cells(_require_leaf(items[TOKEN_ID], f"item[{TOKEN_ID}]"))[2] != "深渊代币":
        raise RuntimeError("深渊代币构建后名称校验失败")
    if cells(_require_leaf(rush_event[EVENT_ID], f"rush_event[{EVENT_ID}]"))[10] != TOKEN_ID:
        raise RuntimeError("Rush Event 构建后代币校验失败")

    return MasterChanges(
        items=items,
        equipment=equipment,
        equipment_status=equipment_status,
        ability_soul=ability_soul,
        rush_event=rush_event,
    )


def apply_server_mirrors(mirrors: ServerMirrors) -> ServerMirrors:
    """纯内存应用五个服务端镜像,并规范化 ID 数组。"""
    for spec in WEAPONS:
        if spec.donor not in mirrors.equipment_max_level:
            raise ValueError(f"equipment_max_level 缺少供体 {spec.donor}")
        donor_lookup = mirrors.equipment_lookup.get(spec.donor)
        if not isinstance(donor_lookup, dict) or "category" not in donor_lookup:
            raise ValueError(f"equipment_lookup 缺少供体类别 {spec.donor}")

    max_level = copy.deepcopy(mirrors.equipment_max_level)
    element = copy.deepcopy(mirrors.equipment_element)
    lookup = copy.deepcopy(mirrors.equipment_lookup)
    for spec in WEAPONS:
        donor_lookup = mirrors.equipment_lookup[spec.donor]
        max_level[spec.id] = copy.deepcopy(mirrors.equipment_max_level[spec.donor])
        element[spec.id] = spec.element
        lookup[spec.id] = {
            "name": spec.name,
            "rarity": "5",
            "category": copy.deepcopy(donor_lookup["category"]),
        }

    try:
        equipment_ids = sorted({
            *(int(value) for value in mirrors.equipment_ids),
            *(int(spec.id) for spec in WEAPONS),
        })
        item_ids = sorted({
            *(int(value) for value in mirrors.item_ids),
            int(TOKEN_ID),
        })
    except (TypeError, ValueError) as exc:
        raise ValueError("equipment_ids/item_ids 必须是整数数组") from exc

    return ServerMirrors(
        equipment_max_level=max_level,
        equipment_element=element,
        equipment_lookup=lookup,
        equipment_ids=equipment_ids,
        item_ids=item_ids,
    )


def load_json(name: str):
    with open(os.path.join(ROOT, "assets", name), encoding="utf-8") as fh:
        return json.load(fh)


def save_json(name: str, data) -> None:
    with open(os.path.join(ROOT, "assets", name), "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=0 if isinstance(data, list) else 1)


def require_cn_profile() -> core.VersionProfile:
    """锁定生成、写入与发布到同一个无 fallback 的 CN store。"""
    active = core.resolve_profile()
    cn_profile = core.resolve_profile("cn")
    if active is None or cn_profile is None:
        raise ValueError("必须同时配置 active profile 与 cn profile")
    if active.id != "cn" or cn_profile.id != "cn":
        raise ValueError(
            f"仅允许 active=cn,当前 active={active.id!r}, cn={cn_profile.id!r}"
        )
    if active.fallback is not None or cn_profile.fallback is not None:
        raise ValueError("CN profile 必须设置 fallback=null")

    active_store = active.store.resolve()
    cn_store = cn_profile.store.resolve()
    if not active_store.exists() or not cn_store.exists():
        raise ValueError(
            f"CN store 不存在: active={active_store}, explicit={cn_store}"
        )
    if active_store != cn_store:
        raise ValueError(
            f"active/cn store 不一致: active={active_store}, explicit={cn_store}"
        )

    quest_store = q.store_path(ITEM_T).parents[1].resolve()
    if quest_store != active_store:
        raise ValueError(
            f"wf_quest_lib store 与 CN profile 不一致: quest={quest_store}, "
            f"profile={active_store}"
        )
    print(f"[PROFILE] active=cn store={active_store}")
    return active


def _assert_readback_rows(
    actual: dict[str, object], expected: dict[str, object], keys: list[str], label: str,
) -> None:
    for key in keys:
        if key not in actual:
            raise RuntimeError(f"{label} 写后复读缺少键 {key}")
        if actual[key] != expected[key]:
            raise RuntimeError(f"{label} 写后复读不一致: {key}")


def _print_plan(changes: MasterChanges) -> None:
    print(f"代币: {TOKEN_ID} 深渊代币 <- {TOKEN_TEMPLATE}")
    for spec in WEAPONS:
        effects = ", ".join(
            f"kind {effect.effect_kind}={effect.strength}"
            for effect in spec.effects
        )
        image = f"{IMAGE_PREFIX}/{spec.image_slug}"
        print(
            f"武装: {spec.id} {spec.name} | donor={spec.donor} | "
            f"element={spec.element} | image={image} | effects=[{effects}]"
        )
        leaf = _require_leaf(changes.ability_soul[spec.id], f"ability_soul[{spec.id}]")
        descriptions = wf_describe.describe_rows(
            core.read_csv_lines(_leaf_text(leaf)), "ability_soul"
        )
        for slot, description in enumerate(descriptions, start=1):
            print(f"  词条 {slot}: {description}")
    print(
        f"[PLAN] {len(WEAPONS)} weapons; token {TOKEN_ID}; "
        "5 client tables; 5 server mirrors"
    )
    print(
        "[PLAN] client: item, equipment, equipment_status, ability_soul, rush_event"
    )
    print(
        "[PLAN] mirrors: equipment_max_level, equipment_element, equipment_lookup, "
        "equipment_ids, item_ids"
    )


def _print_asset_validation(sources: dict[str, Path]) -> None:
    digests: list[str] = []
    for spec in WEAPONS:
        source = sources[spec.image_slug]
        source_bytes = source.read_bytes()
        digest = hashlib.sha256(source_bytes).hexdigest()
        with Image.open(io.BytesIO(source_bytes)) as image:
            size = image.size
            mode = image.mode
        logical = f"{IMAGE_PREFIX}/{spec.image_slug}.png"
        relative = q.hashed_rel(logical)
        print(
            f"[ASSET] {source.name}: {size[0]}x{size[1]} {mode} "
            f"sha256={digest} logical={logical} hashed={relative}"
        )
        digests.append(digest)
    print(
        f"[OK] {len(sources)}/15 valid; "
        f"{len(set(digests))} distinct SHA-256"
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="深渊代币 + 连战专属武装")
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--publish", action="store_true")
    ap.add_argument("--client-verification")
    ap.add_argument("--ffdec", type=Path)
    ap.add_argument("--java", type=Path)
    ap.add_argument("--validate-assets", action="store_true")
    args = ap.parse_args()

    if args.publish and not args.write:
        print("[ERR] --publish 必须与 --write 同时使用", file=sys.stderr)
        return 1
    if args.publish and not args.client_verification:
        print("[ERR] --publish 必须提供 --client-verification", file=sys.stderr)
        return 1
    if args.publish and (args.ffdec is None or args.java is None):
        print("[ERR] --publish 必须同时提供 --ffdec 与 --java", file=sys.stderr)
        return 1

    sources: dict[str, Path] | None = None
    if args.validate_assets or args.write:
        try:
            sources = validate_source_assets(SOURCE_ASSET_DIR, WEAPONS)
            _print_asset_validation(sources)
        except (KeyError, TypeError, ValueError, RuntimeError, OSError) as exc:
            print(f"[ERR] 图片校验失败: {exc}", file=sys.stderr)
            return 1
        if args.validate_assets and not args.write:
            return 0

    try:
        profile = require_cn_profile()
        tables = MasterTables(
            items=q.load_table(ITEM_T),
            equipment=q.load_table(EQUIP_T),
            equipment_status=q.load_table(EQUIP_STATUS_T),
            ability_soul=q.load_table(SOUL_T),
            rush_event=q.load_table(RUSH_EVENT_T),
        )
        mirrors = ServerMirrors(
            equipment_max_level=load_json("equipment_max_level.json"),
            equipment_element=load_json("equipment_element.json"),
            equipment_lookup=load_json("equipment_lookup.json"),
            equipment_ids=load_json("equipment_ids.json"),
            item_ids=load_json("item_ids.json"),
        )
        changes = build_master_changes(tables)
        mirror_changes = apply_server_mirrors(mirrors)
        _print_plan(changes)
    except (KeyError, TypeError, ValueError, RuntimeError) as exc:
        print(f"[ERR] 生成计划失败: {exc}", file=sys.stderr)
        return 1

    if not args.write:
        print("[DRY-RUN] 未写入任何文件。加 --write 生效。")
        return 0

    weapon_ids = [spec.id for spec in WEAPONS]
    try:
        q.save_table(ITEM_T, changes.items)
        item_readback = q.load_table(ITEM_T)
        _assert_readback_rows(
            item_readback, changes.items, [TOKEN_ID, *weapon_ids], "item"
        )

        q.save_table(EQUIP_T, changes.equipment)
        equipment_readback = q.load_table(EQUIP_T)
        _assert_readback_rows(
            equipment_readback, changes.equipment, weapon_ids, "equipment"
        )
        assert_reserved_ownership(equipment_readback)

        q.save_table(EQUIP_STATUS_T, changes.equipment_status)
        status_readback = q.load_table(EQUIP_STATUS_T)
        _assert_readback_rows(
            status_readback, changes.equipment_status, weapon_ids, "equipment_status"
        )

        q.save_table(SOUL_T, changes.ability_soul)
        soul_readback = q.load_table(SOUL_T)
        _assert_readback_rows(
            soul_readback, changes.ability_soul, weapon_ids, "ability_soul"
        )

        q.save_table(RUSH_EVENT_T, changes.rush_event)
        rush_readback = q.load_table(RUSH_EVENT_T)
        _assert_readback_rows(
            rush_readback, changes.rush_event, [EVENT_ID], "rush_event"
        )
        rush_leaf = _require_leaf(rush_readback[EVENT_ID], f"rush_event[{EVENT_ID}]")
        if cells(rush_leaf)[10] != TOKEN_ID:
            raise RuntimeError(f"rush_event[{EVENT_ID}] 写后复读 c10 不是 {TOKEN_ID}")

        mirror_writes = (
            ("equipment_max_level.json", mirror_changes.equipment_max_level),
            ("equipment_element.json", mirror_changes.equipment_element),
            ("equipment_lookup.json", mirror_changes.equipment_lookup),
            ("equipment_ids.json", mirror_changes.equipment_ids),
            ("item_ids.json", mirror_changes.item_ids),
        )
        for name, data in mirror_writes:
            save_json(name, data)
            if load_json(name) != data:
                raise RuntimeError(f"{name} 写后复读不一致")

        if sources is None:
            raise RuntimeError("写入前未校验源 PNG")
        installed = install_source_assets(profile.store, sources, WEAPONS)
        if len(installed) != len(WEAPONS):
            raise RuntimeError(
                f"PNG 安装数量不一致: expected={len(WEAPONS)}, actual={len(installed)}"
            )
    except (KeyError, TypeError, ValueError, RuntimeError, OSError) as exc:
        print(f"[ERR] 写入或复读失败,禁止发布: {exc}", file=sys.stderr)
        return 1

    print(
        "[OK] 5 client tables, 5 server mirrors, and 15 PNGs passed "
        "write/readback validation"
    )
    from wf_rogue_validate import require_release_ready, release_logicals

    publish_tables = ",".join(release_logicals())
    if not args.publish:
        print(f"发布命令: python mod-tools/wf_publish.py --tables {publish_tables}")
        return 0

    try:
        publish_profile = require_cn_profile()
    except (KeyError, TypeError, ValueError, RuntimeError, OSError) as exc:
        print(f"[ERR] 发布前 CN profile 复检失败: {exc}", file=sys.stderr)
        return 1

    try:
        release_snapshot = require_release_ready(
            publish_profile.store,
            Path(ROOT) / "assets",
            Path(args.client_verification),
            ffdec=args.ffdec,
            java=args.java,
        )
    except (KeyError, TypeError, ValueError, RuntimeError, OSError) as exc:
        print(f"[ERR] 发布门禁失败,禁止调用发布器: {exc}", file=sys.stderr)
        return 1

    try:
        with tempfile.TemporaryDirectory(prefix="wf-abyss-release-snapshot-") as temp:
            snapshot_path = Path(temp) / "release-snapshot.json"
            release_snapshot.write(snapshot_path)
            command = [
                sys.executable,
                str(Path(ROOT) / "mod-tools" / "wf_publish.py"),
                "--tables",
                publish_tables,
                "--snapshot",
                str(snapshot_path),
            ]
            subprocess.run(command, cwd=ROOT, check=True)
    except subprocess.CalledProcessError as exc:
        code = exc.returncode if exc.returncode else 1
        print(f"[ERR] wf_publish 退出码 {code}", file=sys.stderr)
        return code
    except OSError as exc:
        print(f"[ERR] 无法调用 wf_publish: {exc}", file=sys.stderr)
        return 1
    print("[PUBLISH] wf_publish 退出码 0")
    return 0


if __name__ == "__main__":
    sys.exit(main())
