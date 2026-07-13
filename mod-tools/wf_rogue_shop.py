#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""深渊连战原生 EVENT_ITEM 兑换商店生成器。

默认仅 dry-run。``--write`` 会同时写入客户端 orderedmap 与两份服务端 JSON，
随后逐份复读并验证；本脚本不负责发布 CDN。
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "mod-tools"))
import wf_mod_tool as core  # noqa: E402
import wf_quest_lib as q  # noqa: E402
import wf_rogue_rewards as rewards  # noqa: E402


# Re-export the canonical contract instead of maintaining a second copy.
WeaponSpec = rewards.WeaponSpec
WEAPONS = rewards.WEAPONS
require_cn_profile = rewards.require_cn_profile

SHOP_T = "master/shop/event_item_shop.orderedmap"
SHOP_TEMPLATE = "310200"
SHOP_JSON = "event_item_shop.json"
SHOP_ID_MAP_JSON = "event_item_shop_id_map.json"

EVENT_TYPE = "11"
EVENT_ID = rewards.EVENT_ID
TOKEN_ID = rewards.TOKEN_ID
MODE_DESCRIPTION = rewards.MODE_DESCRIPTION
IMAGE_PREFIX = rewards.IMAGE_PREFIX

CLIENT_COLUMNS = 51
STOCK = 5
AVAILABLE_FROM = "2000-01-01 00:00:00"
AVAILABLE_UNTIL = "2099-12-31 23:59:59"
RESERVED_SHOP_IDS = tuple(str(9_700_101 + index) for index in range(15))
ASSETS_DIR = Path(ROOT) / "assets"


def _leaf_text(leaf: bytes | str) -> str:
    if isinstance(leaf, bytes):
        return leaf.decode("utf-8")
    if isinstance(leaf, str):
        return leaf
    raise TypeError(f"orderedmap 叶子必须是 str/bytes,得到 {type(leaf).__name__}")


def _join_like(row: list[str], template: bytes | str) -> bytes | str:
    text = core.write_csv_lines([row])
    return text.encode("utf-8") if isinstance(template, bytes) else text


def _single_row(leaf: object, label: str) -> tuple[list[str], bytes | str]:
    if not isinstance(leaf, (bytes, str)):
        raise TypeError(f"{label} 必须是 str/bytes")
    rows = core.read_csv_lines(_leaf_text(leaf))
    if len(rows) != 1:
        raise ValueError(f"{label} 必须恰好包含 1 行 CSV,实际 {len(rows)}")
    return list(rows[0]), leaf


def _price(spec: WeaponSpec) -> int:
    if spec.element == -1:
        return 15
    if 0 <= spec.element <= 5:
        return 10
    raise ValueError(f"武器 {spec.id} 的 element 非法: {spec.element}")


def _weapon_pairs(weapons: tuple[WeaponSpec, ...]):
    if len(weapons) != len(RESERVED_SHOP_IDS):
        raise ValueError(
            f"兑换商店必须恰好有 {len(RESERVED_SHOP_IDS)} 把武器,实际 {len(weapons)}"
        )
    weapon_ids = [spec.id for spec in weapons]
    if len(set(weapon_ids)) != len(weapon_ids):
        raise ValueError("兑换商店武器 ID 重复")
    return tuple(zip(RESERVED_SHOP_IDS, weapons))


def _sort_numeric_mapping(mapping: dict) -> dict:
    """Recursively order numeric-key maps while preserving record field order."""
    items = list(mapping.items())
    if items and all(isinstance(key, str) and key.isdigit() for key, _ in items):
        items.sort(key=lambda item: int(item[0]))
    result = {}
    for key, value in items:
        if isinstance(value, dict):
            value = _sort_numeric_mapping(value)
        elif isinstance(value, list):
            value = [
                _sort_numeric_mapping(child) if isinstance(child, dict) else child
                for child in value
            ]
        result[key] = value
    return result


def _expected_client_leaves(
    table: dict[str, object], weapons: tuple[WeaponSpec, ...]
) -> dict[str, object]:
    if SHOP_TEMPLATE not in table:
        raise KeyError(f"客户端商店缺少官方模板 {SHOP_TEMPLATE}")
    template_row, template_leaf = _single_row(
        table[SHOP_TEMPLATE], f"event_item_shop[{SHOP_TEMPLATE}]"
    )
    if len(template_row) > CLIENT_COLUMNS:
        raise ValueError(
            f"官方模板 {SHOP_TEMPLATE} 超过 {CLIENT_COLUMNS} 列: {len(template_row)}"
        )
    template_row = core.normalize_row_length(template_row, CLIENT_COLUMNS)
    if len(template_row) != CLIENT_COLUMNS:
        raise ValueError(
            f"官方模板 {SHOP_TEMPLATE} 无法规范为 {CLIENT_COLUMNS} 列"
        )

    expected: dict[str, object] = {}
    for slot, (shop_id, spec) in enumerate(_weapon_pairs(weapons), start=1):
        row = list(template_row)
        fixed = {
            0: "6",
            1: EVENT_ID,
            2: EVENT_TYPE,
            7: spec.name,
            8: shop_id,
            9: "1",
            10: str(slot),
            11: MODE_DESCRIPTION,
            13: f"{IMAGE_PREFIX}/{spec.image_slug}",
            14: "5",
            18: TOKEN_ID,
            19: str(_price(spec)),
            26: AVAILABLE_FROM,
            27: AVAILABLE_UNTIL,
            28: "0",
            29: str(STOCK),
            30: str(STOCK),
            31: "(None)",
            32: "4",
            33: spec.id,
            34: "1",
        }
        for column, value in fixed.items():
            row[column] = value
        if len(row) != CLIENT_COLUMNS:
            raise RuntimeError(f"生成行 {shop_id} 不是 {CLIENT_COLUMNS} 列")
        expected[shop_id] = _join_like(row, template_leaf)
    return expected


def build_client_shop(
    table: dict[str, object], weapons: tuple[WeaponSpec, ...]
) -> dict[str, object]:
    """Return a collision-safe client shop table without mutating ``table``."""
    if not isinstance(table, dict):
        raise TypeError("客户端 event_item_shop 必须是 dict")
    expected = _expected_client_leaves(table, weapons)
    for shop_id, leaf in expected.items():
        if shop_id in table and table[shop_id] != leaf:
            raise ValueError(f"保留商店 ID {shop_id} 已被外来客户端条目占用")

    result = copy.deepcopy(table)
    result.pop(EVENT_ID, None)
    # A client orderedmap's insertion order is part of the stored table. Keep every
    # unrelated key in place and normalize only our owned range into one block.
    for shop_id in RESERVED_SHOP_IDS:
        result.pop(shop_id, None)
    for shop_id, leaf in expected.items():
        result[shop_id] = leaf
    return result


def _expected_products(weapons: tuple[WeaponSpec, ...]) -> dict[str, dict]:
    expected: dict[str, dict] = {}
    for shop_id, spec in _weapon_pairs(weapons):
        expected[shop_id] = {
            "costs": [{"id": int(TOKEN_ID), "amount": _price(spec)}],
            "rewards": [{"type": 4, "id": int(spec.id), "count": 1}],
            "availableFrom": AVAILABLE_FROM,
            "availableUntil": AVAILABLE_UNTIL,
            "stock": STOCK,
        }
    return expected


def _walk_product_maps(shop: dict):
    for event_type, events in shop.items():
        if not isinstance(events, dict):
            raise TypeError(f"event_item_shop[{event_type!r}] 必须是 dict")
        for event_id, products in events.items():
            if not isinstance(products, dict):
                raise TypeError(
                    f"event_item_shop[{event_type!r}][{event_id!r}] 必须是 dict"
                )
            yield str(event_type), str(event_id), products


def build_server_shop(
    shop: dict,
    id_map: dict,
    weapons: tuple[WeaponSpec, ...],
) -> tuple[dict, dict]:
    """Return server mirrors with only owned reserved IDs replaced."""
    if not isinstance(shop, dict) or not isinstance(id_map, dict):
        raise TypeError("服务端商店与 ID map 必须都是 dict")
    expected = _expected_products(weapons)
    expected_map = {"eventType": int(EVENT_TYPE), "eventId": int(EVENT_ID)}

    for event_type, event_id, products in _walk_product_maps(shop):
        for shop_id in RESERVED_SHOP_IDS:
            if shop_id not in products:
                continue
            owned = (
                event_type == EVENT_TYPE
                and event_id == EVENT_ID
                and products[shop_id] == expected[shop_id]
            )
            if not owned:
                raise ValueError(
                    f"保留商店 ID {shop_id} 已被外来服务端条目占用 "
                    f"({event_type}/{event_id})"
                )
    for shop_id in RESERVED_SHOP_IDS:
        if shop_id in id_map and id_map[shop_id] != expected_map:
            raise ValueError(f"保留商店 ID {shop_id} 已被外来 ID-map 条目占用")

    result_shop = copy.deepcopy(shop)
    result_map = copy.deepcopy(id_map)
    for _event_type, _event_id, products in _walk_product_maps(result_shop):
        products.pop(EVENT_ID, None)
    result_map.pop(EVENT_ID, None)

    events = result_shop.setdefault(EVENT_TYPE, {})
    if not isinstance(events, dict):
        raise TypeError(f"event_item_shop[{EVENT_TYPE}] 必须是 dict")
    products = events.setdefault(EVENT_ID, {})
    if not isinstance(products, dict):
        raise TypeError(f"event_item_shop[{EVENT_TYPE}][{EVENT_ID}] 必须是 dict")
    for shop_id, product in expected.items():
        products[shop_id] = copy.deepcopy(product)
        result_map[shop_id] = copy.deepcopy(expected_map)

    return _sort_numeric_mapping(result_shop), _sort_numeric_mapping(result_map)


def _numeric_order_problems(value, label: str) -> list[str]:
    problems: list[str] = []
    if isinstance(value, dict):
        keys = list(value)
        if keys and all(isinstance(key, str) and key.isdigit() for key in keys):
            if keys != sorted(keys, key=int):
                problems.append(f"{label} 的数字键顺序不稳定")
        for key, child in value.items():
            problems.extend(_numeric_order_problems(child, f"{label}[{key!r}]"))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            problems.extend(_numeric_order_problems(child, f"{label}[{index}]"))
    return problems


def validate_shop(client: dict, shop: dict, id_map: dict) -> list[str]:
    """Return every client/server contract violation; an empty list is valid."""
    problems: list[str] = []
    if not isinstance(client, dict) or not isinstance(shop, dict) or not isinstance(id_map, dict):
        return ["client/shop/id_map 必须都是 dict"]

    if EVENT_ID in client:
        problems.append(f"客户端旧键 {EVENT_ID} 未移除")
    reserved_order = tuple(key for key in client if key in RESERVED_SHOP_IDS)
    if reserved_order != RESERVED_SHOP_IDS:
        problems.append(
            "客户端保留商店键必须组成 9700101..9700115 的升序块"
        )
    expected_products = _expected_products(WEAPONS)
    expected_map = {"eventType": int(EVENT_TYPE), "eventId": int(EVENT_ID)}

    for slot, (shop_id, spec) in enumerate(_weapon_pairs(WEAPONS), start=1):
        if shop_id not in client:
            problems.append(f"客户端缺少商店键 {shop_id}")
            continue
        try:
            row, _leaf = _single_row(client[shop_id], f"client[{shop_id}]")
        except (TypeError, ValueError, UnicodeError) as exc:
            problems.append(str(exc))
            continue
        if len(row) != CLIENT_COLUMNS:
            problems.append(
                f"客户端 {shop_id} 必须是 {CLIENT_COLUMNS} 列,实际 {len(row)}"
            )
            continue
        expected_fields = {
            0: "6",
            1: EVENT_ID,
            2: EVENT_TYPE,
            7: spec.name,
            8: shop_id,
            9: "1",
            10: str(slot),
            11: MODE_DESCRIPTION,
            13: f"{IMAGE_PREFIX}/{spec.image_slug}",
            14: "5",
            18: TOKEN_ID,
            19: str(_price(spec)),
            26: AVAILABLE_FROM,
            27: AVAILABLE_UNTIL,
            28: "0",
            29: str(STOCK),
            30: str(STOCK),
            31: "(None)",
            32: "4",
            33: spec.id,
            34: "1",
        }
        for column, expected in expected_fields.items():
            if row[column] != expected:
                problems.append(
                    f"客户端 {shop_id} c{column}: expected={expected!r}, "
                    f"actual={row[column]!r}"
                )

    target_products = None
    try:
        target_events = shop.get(EVENT_TYPE)
        if isinstance(target_events, dict):
            target_products = target_events.get(EVENT_ID)
        if not isinstance(target_products, dict):
            problems.append(f"服务端缺少 event_item_shop[{EVENT_TYPE}][{EVENT_ID}]")
            target_products = {}
        for event_type, event_id, products in _walk_product_maps(shop):
            if EVENT_ID in products:
                problems.append(
                    f"服务端旧商品键 {EVENT_ID} 未从 {event_type}/{event_id} 移除"
                )
            for shop_id in RESERVED_SHOP_IDS:
                if shop_id in products and not (
                    event_type == EVENT_TYPE and event_id == EVENT_ID
                ):
                    problems.append(
                        f"保留商店 ID {shop_id} 出现在错误位置 {event_type}/{event_id}"
                    )
    except TypeError as exc:
        problems.append(str(exc))

    total_cost = 0
    for shop_id, expected in expected_products.items():
        actual = target_products.get(shop_id) if isinstance(target_products, dict) else None
        if actual != expected:
            problems.append(f"服务端商品 {shop_id} 与规范不一致")
        if isinstance(actual, dict):
            try:
                total_cost += int(actual["costs"][0]["amount"]) * int(actual["stock"])
            except (KeyError, IndexError, TypeError, ValueError):
                pass
        if id_map.get(shop_id) != expected_map:
            problems.append(f"ID map {shop_id} 与规范不一致")
    if EVENT_ID in id_map:
        problems.append(f"旧 ID-map 键 {EVENT_ID} 未移除")
    if total_cost != 825:
        problems.append(f"商店总库存成本必须是 825,实际 {total_cost}")

    problems.extend(_numeric_order_problems(shop, "shop"))
    problems.extend(_numeric_order_problems(id_map, "id_map"))
    return problems


def load_json(name: str):
    return json.loads((ASSETS_DIR / name).read_text(encoding="utf-8"))


def _atomic_write_bytes(path: Path, payload: bytes) -> None:
    """Replace one file from a sibling temporary file."""
    path = Path(path).absolute()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(fd, "wb") as handle:
            fd = -1
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if fd >= 0:
            os.close(fd)
        temporary.unlink(missing_ok=True)


def save_json(name: str, data) -> None:
    ordered = _sort_numeric_mapping(data) if isinstance(data, dict) else data
    payload = json.dumps(ordered, ensure_ascii=False, indent=4) + "\n"
    _atomic_write_bytes(ASSETS_DIR / name, payload.encode("utf-8"))


def _write_target_paths() -> tuple[Path, Path, Path]:
    return (
        Path(q.store_path(SHOP_T)),
        ASSETS_DIR / SHOP_JSON,
        ASSETS_DIR / SHOP_ID_MAP_JSON,
    )


class _FileBeforeImages:
    """Exact in-memory before-images for the complete live mutation set."""

    def __init__(self, paths) -> None:
        self.entries: list[tuple[Path, bool, bytes | None]] = []
        seen: set[str] = set()
        for candidate in paths:
            path = Path(candidate).absolute()
            key = str(path).casefold()
            if key in seen:
                continue
            seen.add(key)
            existed = path.exists()
            if existed and not path.is_file():
                raise ValueError(f"rollback target is not a file: {path}")
            self.entries.append(
                (path, existed, path.read_bytes() if existed else None)
            )

    def restore(self) -> list[str]:
        errors: list[str] = []
        for path, existed, payload in reversed(self.entries):
            try:
                if existed:
                    if path.exists() and not path.is_file():
                        raise ValueError(f"rollback target became non-file: {path}")
                    if payload is None:
                        raise RuntimeError(f"rollback payload missing: {path}")
                    _atomic_write_bytes(path, payload)
                elif path.exists():
                    if not path.is_file():
                        raise ValueError(f"new rollback target is not a file: {path}")
                    path.unlink()
            except Exception as exc:
                errors.append(f"{path}: {exc}")
        return errors


def _rollback_write_targets(before_images: _FileBeforeImages | None) -> None:
    if before_images is None:
        return
    rollback_errors = before_images.restore()
    if rollback_errors:
        print(
            "[ERR] 回滚失败: " + " | ".join(rollback_errors),
            file=sys.stderr,
        )
    else:
        print("[ROLLBACK] 三个写入目标已恢复到写前状态。", file=sys.stderr)


def _stale_product_count(shop: dict) -> int:
    count = 0
    for _event_type, _event_id, products in _walk_product_maps(shop):
        count += int(EVENT_ID in products)
    return count


def _print_plan(client_before: dict, shop_before: dict, id_map_before: dict) -> None:
    elemental = sum(spec.element != -1 for spec in WEAPONS)
    universal = len(WEAPONS) - elemental
    print(
        f"[PLAN] {len(WEAPONS)} products; "
        f"{elemental} * 10 * {STOCK} + {universal} * 15 * {STOCK} = 825"
    )
    print(
        f"[PLAN] remove stale key {EVENT_ID}: "
        f"client={int(EVENT_ID in client_before)}, "
        f"server={_stale_product_count(shop_before)}, "
        f"id_map={int(EVENT_ID in id_map_before)}"
    )
    print(
        f"[PLAN] client={SHOP_T}; server={SHOP_JSON},{SHOP_ID_MAP_JSON}; "
        "publication deferred"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="深渊连战专属兑换商店")
    parser.add_argument("--write", action="store_true", help="写入并复读校验")
    args = parser.parse_args()

    try:
        profile = require_cn_profile()
        client_before = q.load_table(SHOP_T)
        shop_before = load_json(SHOP_JSON)
        id_map_before = load_json(SHOP_ID_MAP_JSON)
        client_after = build_client_shop(client_before, WEAPONS)
        shop_after, id_map_after = build_server_shop(
            shop_before, id_map_before, WEAPONS
        )
        problems = validate_shop(client_after, shop_after, id_map_after)
        if problems:
            raise ValueError("; ".join(problems))
        _print_plan(client_before, shop_before, id_map_before)
    except (KeyError, TypeError, ValueError, RuntimeError, OSError, json.JSONDecodeError) as exc:
        print(f"[ERR] 生成计划失败: {exc}", file=sys.stderr)
        return 1

    if not args.write:
        print("[DRY-RUN] 未写入任何文件；加 --write 才会落盘。本脚本不会发布。")
        return 0

    before_images: _FileBeforeImages | None = None
    try:
        write_profile = require_cn_profile()
        if write_profile.store.resolve() != profile.store.resolve():
            raise ValueError(
                f"写入前 CN store 已变化: {profile.store.resolve()} -> "
                f"{write_profile.store.resolve()}"
            )
        before_images = _FileBeforeImages(_write_target_paths())
        q.save_table(SHOP_T, client_after)
        save_json(SHOP_JSON, shop_after)
        save_json(SHOP_ID_MAP_JSON, id_map_after)

        client_readback = q.load_table(SHOP_T)
        shop_readback = load_json(SHOP_JSON)
        id_map_readback = load_json(SHOP_ID_MAP_JSON)
        if list(client_readback.items()) != list(client_after.items()):
            raise RuntimeError("客户端商店写后复读与计划不一致")
        if shop_readback != shop_after:
            raise RuntimeError("event_item_shop.json 写后复读与计划不一致")
        if id_map_readback != id_map_after:
            raise RuntimeError("event_item_shop_id_map.json 写后复读与计划不一致")
        problems = validate_shop(client_readback, shop_readback, id_map_readback)
        if problems:
            raise RuntimeError("写后复读校验失败: " + "; ".join(problems))
    except Exception as exc:
        print(f"[ERR] 写入或复读失败: {exc}", file=sys.stderr)
        _rollback_write_targets(before_images)
        return 1
    except BaseException as exc:
        print(
            f"[ERR] 写入或复读被中断: {type(exc).__name__}: {exc}",
            file=sys.stderr,
        )
        _rollback_write_targets(before_images)
        raise

    print("[OK] 15 products passed client/server write-readback validation; 未发布。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
