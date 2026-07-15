# -*- coding: utf-8 -*-
"""角色包资源完整度的纯逻辑契约。

本模块不读取 store，也不导入 GUI。调用方先生成逻辑需求，再把实际存在路径交给
``build_requirement_report``，从而让 GUI、工作区和发布 preflight 共用同一套 37 项硬门。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, Literal, Mapping, TypeAlias


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
        "pct": round(required_exists * 100 / len(required)) if required else 0,
        "missing_required": missing,
        "release_ready": not missing,
    }
