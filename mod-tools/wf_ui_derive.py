# -*- coding: utf-8 -*-
"""从两张透明角色母版确定性派生 World Flipper UI PNG。"""
from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path

from PIL import Image

import wf_canary_skin as skin


# 裁切语义来自已真机验证的 Kyle 金丝雀。尺寸不属于共享表，必须由模板实测结果传入。
DERIVATIVES = {
    "ui/skill_cutin_{n}.png": {
        "mode": "upper_body", "rect": (0.00, 0.00, 1.00, 0.50)},
    "ui/square_{n}.png": {
        "mode": "portrait", "rect": (0.15, 0.00, 0.85, 0.58)},
    "ui/square_132_132_{n}.png": {
        "mode": "portrait", "rect": (0.15, 0.00, 0.85, 0.58)},
    "ui/square_round_95_95_{n}.png": {
        "mode": "face", "rect": (0.15, 0.00, 0.85, 0.58)},
    "ui/square_round_136_136_{n}.png": {
        "mode": "face", "rect": (0.15, 0.00, 0.85, 0.58)},
    "ui/thumb_level_up_{n}.png": {
        "mode": "portrait", "rect": (0.15, 0.00, 0.85, 0.62)},
    "ui/thumb_party_main_{n}.png": {
        "mode": "upper_body", "rect": (0.22, 0.00, 0.78, 0.68)},
    "ui/thumb_party_unison_{n}.png": {
        "mode": "portrait", "rect": (0.16, 0.00, 0.84, 0.64)},
    "ui/battle_control_board_{n}.png": {
        "mode": "head_shoulders", "rect": (0.30, 0.00, 0.70, 0.26)},
    "ui/battle_member_status_{n}.png": {
        "mode": "face", "rect": (0.15, 0.00, 0.85, 0.58)},
    "ui/cutin_skill_chain_{n}.png": {
        "mode": "face", "rect": (0.20, 0.00, 0.80, 0.27)},
}


def _size_for(sizes: Mapping[str, tuple[int, int]],
              relative: str) -> tuple[int, int]:
    try:
        raw = sizes[relative]
        width, height = raw
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError(f"missing or invalid template size: {relative}") from exc
    if (isinstance(width, bool) or isinstance(height, bool)
            or not isinstance(width, int) or not isinstance(height, int)
            or width <= 0 or height <= 0):
        raise ValueError(f"invalid template size for {relative}: {raw!r}")
    return width, height


def build_visual_derivatives(base: Path, awake: Path, out_dir: Path,
                             sizes: Mapping[str, tuple[int, int]]) -> list[Path]:
    """生成 2 张 full-shot 与 DERIVATIVES 的 22 张普通 RGBA PNG。

    ``sizes`` 以具体相对路径为键，调用方应从目标模板资产清单实测得到。函数不会
    生成剧情表情或横幅，也不会执行 store 编码。
    """
    base = Path(base)
    awake = Path(awake)
    out_dir = Path(out_dir)
    required = [
        *(f"ui/full_shot_1440_1920_{n}.png" for n in (0, 1)),
        *(template.format(n=n) for template in DERIVATIVES for n in (0, 1)),
    ]
    resolved_sizes = {relative: _size_for(sizes, relative) for relative in required}

    with Image.open(base) as base_image, Image.open(awake) as awake_image:
        masters = (base_image.convert("RGBA"), awake_image.convert("RGBA"))

    outputs: list[Path] = []
    for n, master in enumerate(masters):
        full_relative = f"ui/full_shot_1440_1920_{n}.png"
        full_path = out_dir / full_relative
        full_path.parent.mkdir(parents=True, exist_ok=True)
        skin.fit_rgba(master, resolved_sizes[full_relative], (0.5, 0.5)).save(
            full_path, format="PNG")
        outputs.append(full_path)

        for template, spec in DERIVATIVES.items():
            relative = template.format(n=n)
            path = out_dir / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            skin.focal_rect_rgba(
                master, resolved_sizes[relative], spec["rect"]
            ).save(path, format="PNG")
            outputs.append(path)
    return outputs


def _scaled_layout(sheet_size: tuple[int, int]) -> tuple[
        tuple[int, int], tuple[int, int], int]:
    """按 Kyle 的 361x806 atlas 比例缩放双格布局。"""
    width, height = sheet_size
    if (isinstance(width, bool) or isinstance(height, bool)
            or not isinstance(width, int) or not isinstance(height, int)
            or width <= 0 or height <= 0):
        raise ValueError(f"invalid illustration sheet size: {sheet_size!r}")
    awake_size = (max(1, round(width * 360 / 361)),
                  max(1, round(height * 372 / 806)))
    base_size = (max(1, round(width * 359 / 361)),
                 max(1, round(height * 365 / 806)))
    base_y = round(height * 373 / 806)
    return awake_size, base_size, base_y


def rebuild_illustration_sheet(out_dir: Path,
                               sheet_size: tuple[int, int]) -> Path:
    """由 full-shot 复建 Kyle 双格布局的 illustration sprite sheet。"""
    out_dir = Path(out_dir)
    awake_size, base_size, base_y = _scaled_layout(sheet_size)
    with Image.open(out_dir / "ui/full_shot_1440_1920_1.png") as image:
        awake = image.convert("RGBA")
    with Image.open(out_dir / "ui/full_shot_1440_1920_0.png") as image:
        base = image.convert("RGBA")

    sheet = Image.new("RGBA", sheet_size, (0, 0, 0, 0))
    sheet.alpha_composite(
        skin.fit_rgba(awake, awake_size, (0.5, 0.33)), (0, 0))
    sheet.alpha_composite(
        skin.fit_rgba(base, base_size, (0.5, 0.33)), (0, base_y))
    target = out_dir / "ui/illustration_setting_sprite_sheet.png"
    target.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(target, format="PNG")
    return target
