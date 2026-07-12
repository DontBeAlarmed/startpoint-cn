# -*- coding: utf-8 -*-
"""Pure, offline transformations for Kyle canary skin asset packs."""
from __future__ import annotations

import colorsys
import zlib
from pathlib import Path

from PIL import Image

import wf_dsl
import wf_mod_tool as core


def remap_tree(value, old: str, new: str):
    """Recursively replace path prefixes without changing container order."""
    if isinstance(value, str):
        return value.replace(old, new)
    if isinstance(value, list):
        return [remap_tree(item, old, new) for item in value]
    if isinstance(value, dict):
        return {key: remap_tree(item, old, new)
                for key, item in value.items()}
    return value


def remap_amf3_deflate(data: bytes, old: str, new: str) -> bytes:
    """Remap paths in an AMF3 tree wrapped in raw DEFLATE bytes."""
    plain = zlib.decompress(data, -15)
    original = core.AMF3Reader(plain).read_value()
    mapped = remap_tree(original, old, new)
    encoded = wf_dsl.encode_amf3(mapped)
    if core.AMF3Reader(encoded).read_value() != mapped:
        raise ValueError("AMF3 remap round-trip mismatch")
    compressor = zlib.compressobj(9, zlib.DEFLATED, -15)
    return compressor.compress(encoded) + compressor.flush()


def fit_rgba(image: Image.Image, size: tuple[int, int],
             focus: tuple[float, float] = (0.5, 0.42)) -> Image.Image:
    """Contain an image on an exact transparent RGBA canvas."""
    source = image.convert("RGBA")
    scale = min(size[0] / source.width, size[1] / source.height)
    scaled = source.resize(
        (max(1, round(source.width * scale)),
         max(1, round(source.height * scale))),
        Image.Resampling.LANCZOS,
    )
    canvas = Image.new("RGBA", size, (0, 0, 0, 0))
    x = round(size[0] * focus[0] - scaled.width * focus[0])
    y = round(size[1] * focus[1] - scaled.height * focus[1])
    canvas.alpha_composite(scaled, (x, y))
    return canvas


def recolor_kyle_pixel_sheet(image: Image.Image) -> Image.Image:
    """Shift saturated red effects to ice blue and dark neutrals to silver."""
    output = Image.new("RGBA", image.size)
    pixels = []
    for red, green, blue, alpha in image.convert("RGBA").get_flattened_data():
        if alpha == 0:
            pixels.append((0, 0, 0, 0))
            continue
        hue, saturation, value = colorsys.rgb_to_hsv(
            red / 255, green / 255, blue / 255)
        if saturation > 0.38 and (hue < 0.12 or hue > 0.96):
            hue = 0.58
            saturation = min(0.78, saturation)
            value = min(1.0, value * 1.08)
        elif saturation < 0.22 and 0.10 < value < 0.52:
            saturation = 0.08
            value = 0.66 + (value - 0.10) / 0.42 * 0.28
        new_red, new_green, new_blue = colorsys.hsv_to_rgb(
            hue, saturation, value)
        pixels.append((round(new_red * 255), round(new_green * 255),
                       round(new_blue * 255), alpha))
    output.putdata(pixels)
    return output


def validate_pack(pack_dir: Path,
                  required_sizes: dict[str, tuple[int, int]]) -> dict:
    """Validate required image presence and exact atlas geometry."""
    missing = []
    bad = []
    for relative_path, expected_size in required_sizes.items():
        path = pack_dir / relative_path
        if not path.exists():
            missing.append(relative_path)
            continue
        with Image.open(path) as image:
            if image.size != expected_size:
                bad.append(f"{relative_path}: {image.size} != {expected_size}")
    if missing or bad:
        errors = [*(f"missing {path}" for path in missing), *bad]
        raise ValueError("; ".join(errors))
    return {"required": len(required_sizes), "missing": 0, "bad": 0}
