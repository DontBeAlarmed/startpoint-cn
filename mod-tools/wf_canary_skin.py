# -*- coding: utf-8 -*-
"""Pure, offline transformations for Kyle canary skin asset packs."""
from __future__ import annotations

import colorsys
import zlib
from pathlib import Path

from PIL import Image

import wf_dsl
import wf_mod_tool as core


KYLE_ICE_EYE = (72, 180, 255)

# Exact character-palette swaps run before the broad red-effect conversion.
# They are intentionally limited to the black-wolf sprite colors so unrelated
# purple/coffin VFX are not globally bleached.
KYLE_PIXEL_EXACT_PALETTE = {
    (69, 69, 59): (224, 232, 242),       # dark wolf fur -> cold white fur
    (143, 139, 139): (188, 202, 218),    # mid wolf/armour gray -> silver
    (196, 188, 185): (220, 228, 238),
    (229, 211, 211): (238, 243, 249),
    (208, 203, 204): (224, 232, 241),
    (239, 229, 213): (244, 247, 251),
    (73, 60, 60): (82, 101, 122),        # dark red armour -> slate blue
    (73, 61, 66): (83, 102, 124),
    (66, 33, 43): (43, 76, 110),
    (3, 178, 0): KYLE_ICE_EYE,
}


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


def cover_rgba(image: Image.Image, size: tuple[int, int],
               focus: tuple[float, float] = (0.5, 0.25),
               padding: float = 0.04) -> Image.Image:
    """Focal-crop the visible subject so compact UI slots are actually filled.

    Generated masters commonly contain a large transparent margin.  Cropping
    from the RGBA alpha bounds first makes ``focus`` describe the character,
    not the original generation canvas.  ``fit_rgba`` remains the contain
    operation for full-shot assets.
    """
    source = image.convert("RGBA")
    bbox = source.getchannel("A").getbbox()
    if bbox is None:
        return Image.new("RGBA", size, (0, 0, 0, 0))
    left, top, right, bottom = bbox
    visible_width = right - left
    visible_height = bottom - top
    margin_x = round(visible_width * max(0.0, padding))
    margin_y = round(visible_height * max(0.0, padding))
    left = max(0, left - margin_x)
    top = max(0, top - margin_y)
    right = min(source.width, right + margin_x)
    bottom = min(source.height, bottom + margin_y)
    visible = source.crop((left, top, right, bottom))

    scale = max(size[0] / visible.width, size[1] / visible.height)
    scaled = visible.resize(
        (max(1, round(visible.width * scale)),
         max(1, round(visible.height * scale))),
        Image.Resampling.LANCZOS,
    )
    focus_x = min(1.0, max(0.0, focus[0]))
    focus_y = min(1.0, max(0.0, focus[1]))
    max_x = max(0, scaled.width - size[0])
    max_y = max(0, scaled.height - size[1])
    crop_x = round(max_x * focus_x)
    crop_y = round(max_y * focus_y)
    return scaled.crop((crop_x, crop_y, crop_x + size[0], crop_y + size[1]))


def focal_rect_rgba(image: Image.Image, size: tuple[int, int],
                    rect: tuple[float, float, float, float]) -> Image.Image:
    """Crop an explicit normalized region of the visible subject, then cover."""
    source = image.convert("RGBA")
    bbox = source.getchannel("A").getbbox()
    if bbox is None:
        return Image.new("RGBA", size, (0, 0, 0, 0))
    x0, y0, x1, y1 = rect
    if not (0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1):
        raise ValueError(f"invalid normalized focal rect: {rect}")
    left, top, right, bottom = bbox
    width, height = right - left, bottom - top
    crop = (
        left + round(width * x0),
        top + round(height * y0),
        left + round(width * x1),
        top + round(height * y1),
    )
    return cover_rgba(source.crop(crop), size, focus=(0.5, 0.12), padding=0)


def recolor_kyle_pixel_sheet(image: Image.Image) -> Image.Image:
    """Convert exact wolf colors, then shift remaining red VFX to ice blue."""
    output = Image.new("RGBA", image.size)
    pixels = []
    for red, green, blue, alpha in image.convert("RGBA").get_flattened_data():
        if alpha == 0:
            pixels.append((0, 0, 0, 0))
            continue
        exact = KYLE_PIXEL_EXACT_PALETTE.get((red, green, blue))
        if exact is not None:
            pixels.append((*exact, alpha))
            continue
        hue, saturation, value = colorsys.rgb_to_hsv(
            red / 255, green / 255, blue / 255)
        if saturation > 0.38 and (hue < 0.12 or hue > 0.96):
            hue = 0.58
            saturation = min(0.78, saturation)
            value = min(1.0, value * 1.08)
        elif saturation < 0.22 and 0.32 < value < 0.52:
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
