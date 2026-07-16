# -*- coding: utf-8 -*-
"""角色包资源完整度的纯逻辑契约。

本模块不读取 store，也不导入 GUI。调用方先生成逻辑需求，再把实际存在路径交给
``build_requirement_report``，从而让 GUI、工作区和发布 preflight 共用同一套 37 项硬门。

37 项硬门只覆盖 ``character/<code>/`` 模板资产；master 表新增/修改行引用的全局资产
（unique_condition 图标、词条引用的固有状态 ID、技能 DSL 特效目录）由本模块下半部的
master 引用门禁负责：调用方解码表/DSL 后交给 ``extract_master_asset_references``，
再用 ``build_master_reference_report`` 对照包内声明与 live store 逐条确认。
"""
from __future__ import annotations

import csv
import io
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Literal, Mapping, TypeAlias


RequirementCategory = Literal["required", "suggested", "excluded"]
RequirementReport: TypeAlias = dict[str, Any]


@dataclass(frozen=True)
class AssetRequirement:
    logical_path: str
    kind: str
    category: RequirementCategory
    requirement: str = ""
    expected_dims: tuple[int, int] | None = None
    text: str = ""


_REQUIRED_KINDS = {
    "立绘",
    "技能cut-in",
    "图标合集",
    "像素图",
    "头像",
    "缩略图",
    "战斗UI",
    "连锁cut-in",
    "配套数据",
}
_STORY_KINDS = {"剧情横幅", "剧情表情"}


def classify_asset_category(logical_path: str, kind: str) -> RequirementCategory:
    """按可观察路径分类；剧情、words 与 login 永不进入生产 37 项硬门。"""
    path = "/" + logical_path.replace("\\", "/").strip("/").lower() + "/"
    kind_lower = kind.lower()
    if (
        kind in _STORY_KINDS
        or "/ui/story/" in path
        or "/episode_banner_" in path
        or "/voice/words/" in path
        or "/voice/words_" in path
        or "/voice/login/" in path
        or "剧情" in kind
    ):
        return "excluded"
    if kind.startswith("语音") or "/voice/" in path:
        return "suggested"
    if kind in _REQUIRED_KINDS:
        return "required"
    return "excluded"


# (相对 character/<code>/ 的路径, 分类, 格式/尺寸说明, 可选固定尺寸)
_CHARACTER_TEMPLATES: tuple[tuple[str, str, str, tuple[int, int] | None], ...] = (
    ("ui/full_shot_1440_1920_0.png", "立绘", "基础立绘。PNG,设计画布 1440x1920(实际可裁边,建议与原图同尺寸,居中构图)", None),
    ("ui/full_shot_1440_1920_1.png", "立绘", "进化/觉醒立绘。PNG,设计画布 1440x1920(同上)", None),
    ("ui/skill_cutin_0.png", "技能cut-in", "技能演出横图。PNG 1024x512(战斗真机只读配对 ATF,替换时自动重编码)", (1024, 512)),
    ("ui/skill_cutin_1.png", "技能cut-in", "进化后技能演出横图。PNG 1024x512(同上,ATF 自动重编码)", (1024, 512)),
    ("ui/illustration_setting_sprite_sheet.png", "图标合集", "头像/队伍小图 sprite sheet(配 .atlas 切割,替换须保持同尺寸同布局)", None),
    ("pixelart/sprite_sheet.png", "像素图", "战斗像素动画 sprite sheet(配 atlas/timeline,同尺寸同布局)", None),
    ("pixelart/special_sprite_sheet.png", "像素图", "技能特殊动作 sprite sheet(同上)", None),
    ("ui/square_0.png", "头像", "方形头像(基础)。PNG,与原图同尺寸", None),
    ("ui/square_1.png", "头像", "方形头像(进化)。PNG,同上", None),
    ("ui/square_132_132_0.png", "头像", "132x132 方形头像(基础)", (132, 132)),
    ("ui/square_132_132_1.png", "头像", "132x132 方形头像(进化)", (132, 132)),
    ("ui/square_round_95_95_0.png", "头像", "95x95 圆角头像(基础)", (95, 95)),
    ("ui/square_round_95_95_1.png", "头像", "95x95 圆角头像(进化)", (95, 95)),
    ("ui/square_round_136_136_0.png", "头像", "136x136 圆角头像(基础)", (136, 136)),
    ("ui/square_round_136_136_1.png", "头像", "136x136 圆角头像(进化)", (136, 136)),
    ("ui/thumb_level_up_0.png", "缩略图", "升级/强化界面缩略图(基础)", None),
    ("ui/thumb_level_up_1.png", "缩略图", "升级/强化界面缩略图(进化)", None),
    ("ui/thumb_party_main_0.png", "缩略图", "编队主位缩略图(基础)", None),
    ("ui/thumb_party_main_1.png", "缩略图", "编队主位缩略图(进化)", None),
    ("ui/thumb_party_unison_0.png", "缩略图", "编队副位缩略图(基础)", None),
    ("ui/thumb_party_unison_1.png", "缩略图", "编队副位缩略图(进化)", None),
    ("ui/battle_control_board_0.png", "战斗UI", "战斗下方技能条立绘(基础)", None),
    ("ui/battle_control_board_1.png", "战斗UI", "战斗下方技能条立绘(进化)", None),
    ("ui/battle_member_status_0.png", "战斗UI", "战斗队员状态小头像(基础)", None),
    ("ui/battle_member_status_1.png", "战斗UI", "战斗队员状态小头像(进化)", None),
    ("ui/cutin_skill_chain_0.png", "连锁cut-in", "技能连锁 cut-in 头像(基础)", None),
    ("ui/cutin_skill_chain_1.png", "连锁cut-in", "技能连锁 cut-in 头像(进化)", None),
    ("ui/episode_banner_0.png", "剧情横幅", "角色剧情列表横幅(基础)", None),
    ("ui/episode_banner_1.png", "剧情横幅", "角色剧情列表横幅(进化)", None),
)

_COMPANION_TEMPLATES: tuple[tuple[str, str], ...] = (
    ("ui/illustration_setting_sprite_sheet.atlas.amf3.deflate", "图标合集的切割坐标"),
    ("pixelart/sprite_sheet.atlas.amf3.deflate", "像素图切割坐标"),
    ("pixelart/special_sprite_sheet.atlas.amf3.deflate", "特殊动作切割坐标"),
    ("pixelart/pixelart.frame.amf3.deflate", "像素动画帧定义"),
    ("pixelart/pixelart.timeline.amf3.deflate", "像素动画时间轴"),
    ("pixelart/special.frame.amf3.deflate", "特殊动作帧定义"),
    ("pixelart/special.timeline.amf3.deflate", "特殊动作时间轴"),
    ("ui/skill_cutin_0.atf.deflate", "技能cut-in 的 ATF(ETC1)纹理——战斗真机实际读取的文件;替换 PNG 时 wf_atf 自动重生成"),
    ("ui/skill_cutin_1.atf.deflate", "同上(进化)"),
    ("battle/character_detail_skill_preview.battle.amf3.deflate", "角色详情页技能预览战斗数据"),
)


def char_asset_requirements(code_name: str) -> tuple[AssetRequirement, ...]:
    """返回不依赖 store 的静态资产矩阵：37 required + 2 excluded。"""
    prefix = f"character/{code_name}/"
    requirements = [
        AssetRequirement(
            prefix + relative,
            kind,
            classify_asset_category(prefix + relative, kind),
            description,
            expected_dims,
        )
        for relative, kind, description, expected_dims in _CHARACTER_TEMPLATES
    ]
    requirements.extend(
        AssetRequirement(
            prefix + relative,
            "配套数据",
            "required",
            description + "(AMF3 二进制,不可预览;仅支持整文件替换,改错会崩,慎动)",
        )
        for relative, description in _COMPANION_TEMPLATES
    )
    return tuple(requirements)


def _group_name(item: AssetRequirement) -> str:
    if item.category == "suggested":
        return "语音(建议)" if item.kind.startswith("语音") else f"{item.kind}(建议)"
    if item.category == "excluded":
        return "剧情(不检查)" if (
            item.kind in _STORY_KINDS
            or "剧情" in item.kind
            or "/story/" in item.logical_path
            or "/voice/words" in item.logical_path
            or "/voice/login/" in item.logical_path
            or "/episode_banner_" in item.logical_path
        ) else f"{item.kind}(不检查)"
    return "配套数据(必要)" if item.kind == "配套数据" else f"{item.kind}(必要)"


def build_requirement_report(
    requirements: Iterable[AssetRequirement],
    existing_paths: Iterable[str] | Mapping[str, Mapping[str, Any]],
) -> RequirementReport:
    """把纯需求和实际路径合并成 GUI/CLI 共用报告。"""
    items = tuple(requirements)
    metadata: Mapping[str, Mapping[str, Any]]
    if isinstance(existing_paths, Mapping):
        metadata = existing_paths
        existing = set(existing_paths)
    else:
        existing = set(existing_paths)
        metadata = {}

    grouped: dict[str, dict[str, Any]] = {}
    for requirement in items:
        name = _group_name(requirement)
        group = grouped.setdefault(
            name,
            {
                "name": name,
                "required": requirement.category == "required",
                "items": [],
                "exists": 0,
                "total": 0,
            },
        )
        present = requirement.logical_path in existing
        details = dict(metadata.get(requirement.logical_path, {}))
        group["items"].append(
            {
                "logical": requirement.logical_path,
                "kind": requirement.kind,
                "exists": present,
                "dims": details.get("dims"),
                "size": int(details.get("size", 0)),
                "req": requirement.requirement,
                "text": str(details.get("text", requirement.text)),
                "expected_dims": requirement.expected_dims,
                "category": requirement.category,
            }
        )
        group["total"] += 1
        group["exists"] += int(present)

    required = [item for item in items if item.category == "required"]
    missing = [item.logical_path for item in required if item.logical_path not in existing]
    required_exists = len(required) - len(missing)
    return {
        "groups": sorted(grouped.values(), key=lambda group: (not group["required"], group["name"])),
        "required_total": len(required),
        "required_exists": required_exists,
        "required_present": required_exists,
        "pct": round(required_exists * 100 / len(required)) if required else 0,
        "missing_required": missing,
        "release_ready": not missing,
    }


# ---------------------------------------------------------------------------
# master 表资产引用门禁
# 2026-07-16 赛瑞斯 1.4.143 事故：unique_condition 行 23 (unique_seris_wet) 引用的
# 图标 PNG 从未进包，客户端 F1009 空引用崩溃。根因是 37 项硬门只核对
# character/<code>/ 模板清单，不检查 master 表行引用的全局资产路径。
# 本节保持纯逻辑：调用方负责解码表与 DSL，并注入"包内声明 / live store 是否存在"。
# ---------------------------------------------------------------------------

UNIQUE_CONDITION_TABLE = "master/character/unique_condition.orderedmap"
ACTION_SKILL_TABLE = "master/skill/action_skill.orderedmap"
SWITCHED_ACTION_SKILL_TABLE = "master/skill/switched_action_skill.orderedmap"
SKILL_EFFECT_PREFIX = "battle/effect/"

# unique_condition 平表列 2 = 图标路径(不带 .png;wf_gui UNIQUE_ICON_DIR)
_UNIQUE_CONDITION_ICON_COLUMN = 2

# 词条块基址(ability_enum_map.json layouts;leader 头部少 2 列故整体 -2)
_ABILITY_BLOCK_BASES: dict[str, Mapping[str, int]] = {
    "master/ability/ability.orderedmap": {
        "precondition1": 6, "precondition2": 13, "precondition3": 20,
        "instant_trigger": 27, "instant_precontent": 39, "instant_content": 47,
        "during_accumulation_trigger": 85, "during_trigger": 97,
        "during_content": 109,
    },
    "master/ability/leader_ability.orderedmap": {
        "precondition1": 4, "precondition2": 11, "precondition3": 18,
        "instant_trigger": 25, "instant_precontent": 37, "instant_content": 45,
        "during_accumulation_trigger": 83, "during_trigger": 95,
        "during_content": 107,
    },
}
# unique_condition_id 在各块内的相对偏移(ability_enum_map.json block_fields)
_UNIQUE_ID_BLOCK_OFFSETS: Mapping[str, int] = {
    "precondition1": 6, "precondition2": 6, "precondition3": 6,
    "instant_trigger": 10, "instant_precontent": 6, "instant_content": 21,
    "during_accumulation_trigger": 10, "during_trigger": 7,
    "during_content": 9,
}
ABILITY_TABLES: tuple[str, ...] = tuple(_ABILITY_BLOCK_BASES)

# nested 技能表 → program_path 所在内层列(wf_mod_tool ACTION_SKILL_COLUMNS)
NESTED_SKILL_PROGRAM_COLUMNS: Mapping[str, int] = {
    ACTION_SKILL_TABLE: 7,
    SWITCHED_ACTION_SKILL_TABLE: 0,
}

MasterReferenceKind = Literal[
    "unique_condition_icon", "unique_condition_id", "skill_effect", "skill_program",
]


@dataclass(frozen=True)
class MasterAssetReference:
    kind: MasterReferenceKind
    value: str   # 资产逻辑路径(不含派生后缀)或 unique_condition 表键
    source: str  # "<表>:<键>[ 行N 列M]",供修复定位


def unique_condition_id_columns(logical_path: str) -> tuple[int, ...]:
    bases = _ABILITY_BLOCK_BASES[logical_path]
    return tuple(sorted(
        base + _UNIQUE_ID_BLOCK_OFFSETS[name] for name, base in bases.items()
    ))


def required_asset_paths(reference: MasterAssetReference) -> tuple[str, ...]:
    """引用 → 客户端实际加载的 store 逻辑路径(unique_condition_id 按 ID 校验,无路径)。"""
    value = reference.value
    if reference.kind == "unique_condition_icon":
        return (value if value.endswith(".png") else value + ".png",)
    if reference.kind == "skill_program":
        return (f"{value}.action.dsl.amf3.deflate",)
    if reference.kind == "skill_effect":
        # flatomo PartsAnimation:<目录>/<效果>.parts/.timeline + 目录共用贴图
        # <目录>/<目录名>.png 与同名 atlas(live store 实测,alice/stella 等目录)
        directory, _, _name = value.rpartition("/")
        directory_name = directory.rsplit("/", 1)[-1]
        return (
            f"{value}.parts.amf3.deflate",
            f"{value}.timeline.amf3.deflate",
            f"{directory}/{directory_name}.png",
            f"{directory}/{directory_name}.atlas.amf3.deflate",
        )
    return ()


def _csv_rows(text: str) -> list[list[str]]:
    # 与 wf_mod_tool.read_csv_lines 同语义:整段喂 csv.reader,引号内换行不撕裂
    if not text:
        return []
    return [row for row in csv.reader(io.StringIO(text)) if row]


def _cell(row: list[str], index: int) -> str:
    return row[index].strip() if index < len(row) else ""


def _iter_tree_strings(node: Any) -> Iterable[str]:
    if isinstance(node, str):
        yield node
    elif isinstance(node, Mapping):
        for value in node.values():
            yield from _iter_tree_strings(value)
    elif isinstance(node, (list, tuple)):
        for item in node:
            yield from _iter_tree_strings(item)


def extract_master_asset_references(
    flat_tables: Mapping[str, Mapping[str, str]],
    nested_tables: Mapping[str, Mapping[str, Mapping[str, str]]] | None = None,
    dsl_trees: Mapping[str, Any] | None = None,
) -> tuple[MasterAssetReference, ...]:
    """解码后的 master 表/DSL 树 → 全局资产引用(按 (kind,value) 去重,保留首个来源)。

    ``flat_tables``/``nested_tables`` 是 {逻辑路径: 解码行};``dsl_trees`` 是
    {DSL 文件逻辑路径: wf_dsl.parse_dsl 的 tree}。缺哪张表就跳过哪张,不视为错误。
    """
    references: dict[tuple[str, str], MasterAssetReference] = {}

    def add(kind: MasterReferenceKind, value: str, source: str) -> None:
        references.setdefault((kind, value), MasterAssetReference(kind, value, source))

    for key, text in (flat_tables.get(UNIQUE_CONDITION_TABLE) or {}).items():
        for row in _csv_rows(text):
            icon = _cell(row, _UNIQUE_CONDITION_ICON_COLUMN)
            if icon:
                add("unique_condition_icon", icon, f"{UNIQUE_CONDITION_TABLE}:{key}")

    for logical in ABILITY_TABLES:
        columns = unique_condition_id_columns(logical)
        for key, text in (flat_tables.get(logical) or {}).items():
            for line_number, row in enumerate(_csv_rows(text), 1):
                for column in columns:
                    condition_id = _cell(row, column)
                    if condition_id and condition_id != "0":
                        add(
                            "unique_condition_id",
                            condition_id,
                            f"{logical}:{key} 行{line_number} 列{column}",
                        )

    for logical, column in NESTED_SKILL_PROGRAM_COLUMNS.items():
        for outer_key, inner in ((nested_tables or {}).get(logical) or {}).items():
            for inner_key, text in inner.items():
                rows = _csv_rows(text)
                program = _cell(rows[0], column) if rows else ""
                if program:
                    add("skill_program", program, f"{logical}:{outer_key}/{inner_key}")

    for logical, tree in (dsl_trees or {}).items():
        for value in _iter_tree_strings(tree):
            if (
                value.startswith(SKILL_EFFECT_PREFIX)
                and "/" in value[len(SKILL_EFFECT_PREFIX):]
            ):
                add("skill_effect", value, logical)

    return tuple(references.values())


def build_master_reference_report(
    references: Iterable[MasterAssetReference],
    *,
    package_asset_paths: Iterable[str] = (),
    package_condition_ids: Iterable[str] = (),
    asset_exists: Callable[[str], bool] = lambda _path: False,
    condition_id_exists: Callable[[str], bool] = lambda _cid: False,
) -> RequirementReport:
    """逐条确认引用可满足:包内声明命中即过,否则问 live store;缺失全部列出。"""
    items = tuple(references)
    declared = set(package_asset_paths)
    condition_ids = {str(item) for item in package_condition_ids}
    missing: list[dict[str, str]] = []
    for reference in items:
        if reference.kind == "unique_condition_id":
            if reference.value in condition_ids or condition_id_exists(reference.value):
                continue
            missing.append({
                "kind": reference.kind,
                "reference": reference.value,
                "source": reference.source,
                "missing": reference.value,
            })
            continue
        for logical in required_asset_paths(reference):
            if logical in declared or asset_exists(logical):
                continue
            missing.append({
                "kind": reference.kind,
                "reference": reference.value,
                "source": reference.source,
                "missing": logical,
            })
    return {
        "checked_references": len(items),
        "missing": missing,
        "release_ready": not missing,
    }
