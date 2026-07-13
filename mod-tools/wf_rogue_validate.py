#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Fail-closed end-to-end validator for the abyss equipment release."""
from __future__ import annotations

import argparse
import csv
import hashlib
import importlib.util
import json
import sys
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import wf_assets
import wf_describe
import wf_mod_tool as core
import wf_quest_lib as q
import wf_rogue_rewards as rewards
import wf_rogue_shop as shop


ROOT = Path(__file__).resolve().parents[1]
ASSETS_DIR = ROOT / "assets"


def _load_task7_builder():
    module_name = "abyss_task8_release_builder"
    existing = sys.modules.get(module_name)
    if existing is not None:
        return existing
    path = ROOT / "client-patch" / "abyss-mode-equipment" / "build_apk.py"
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load Task 7 APK builder: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


apk_builder = _load_task7_builder()


@dataclass(frozen=True)
class ValidationResult:
    errors: tuple[str, ...]
    descriptions: tuple[str, ...]


def release_logicals() -> list[str]:
    """Return the complete explicit release allowlist in deterministic order."""
    return [
        rewards.ITEM_T,
        rewards.EQUIP_T,
        rewards.EQUIP_STATUS_T,
        rewards.SOUL_T,
        rewards.RUSH_EVENT_T,
        shop.SHOP_T,
        *[
            f"{rewards.IMAGE_PREFIX}/{spec.image_slug}.png"
            for spec in rewards.WEAPONS
        ],
    ]


def validate_release(
    store: Path, assets_dir: Path, report_path: Path,
) -> ValidationResult:
    """Validate a materialized release without changing it."""
    store = Path(store)
    assets_dir = Path(assets_dir)
    report_path = Path(report_path)
    errors: list[str] = []

    tables = {
        logical: _load_table(store, logical, errors)
        for logical in release_logicals()[:6]
    }
    json_values: dict[str, Any] = {}
    for name, root_type in (
        ("equipment_max_level", dict),
        ("equipment_element", dict),
        ("equipment_lookup", dict),
        ("equipment_ids", list),
        ("item_ids", list),
        ("event_item_shop", dict),
        ("event_item_shop_id_map", dict),
    ):
        value = _load_json(assets_dir, name, errors)
        if value is not None and not isinstance(value, root_type):
            expected = "object" if root_type is dict else "array"
            errors.append(
                f"assets.{name}.invalid: expected JSON {expected}, "
                f"got {type(value).__name__}"
            )
            value = None
        json_values[name] = value

    _validate_item(tables.get(rewards.ITEM_T), errors)
    descriptions = _validate_weapons(
        tables.get(rewards.EQUIP_T),
        tables.get(rewards.EQUIP_STATUS_T),
        tables.get(rewards.SOUL_T),
        errors,
    )
    _validate_rush(tables.get(rewards.RUSH_EVENT_T), errors)
    _validate_mirrors(json_values, errors)
    _validate_shop(
        tables.get(shop.SHOP_T),
        json_values.get("event_item_shop"),
        json_values.get("event_item_shop_id_map"),
        errors,
    )
    _validate_pngs(store, assets_dir, errors)
    _validate_client_verification(report_path, errors)

    return ValidationResult(
        errors=tuple(errors),
        descriptions=tuple(descriptions),
    )


def require_release_ready(
    store: Path, assets_dir: Path, report_path: Path,
) -> None:
    """Raise when ``validate_release`` reports any release blocker."""
    result = validate_release(store, assets_dir, report_path)
    _print_result(result)
    if result.errors:
        raise RuntimeError(
            f"abyss release validation failed with {len(result.errors)} error(s)"
        )


def _print_result(result: ValidationResult) -> None:
    for description in result.descriptions:
        print(f"[ABILITY] {description}")
    for error in result.errors:
        print(f"[ERR] {error}", file=sys.stderr)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate the complete abyss equipment release gate"
    )
    parser.add_argument("--client-verification", required=True)
    args = parser.parse_args()
    try:
        profile = rewards.require_cn_profile()
    except (OSError, KeyError, TypeError, ValueError, RuntimeError) as exc:
        print(f"[ERR] CN profile validation failed: {exc}", file=sys.stderr)
        return 1
    result = validate_release(
        profile.store,
        ASSETS_DIR,
        Path(args.client_verification),
    )
    _print_result(result)
    if result.errors:
        print(
            f"[ERR] abyss release validation failed: {len(result.errors)} error(s)",
            file=sys.stderr,
        )
        return 1
    print("[OK] abyss release validation passed")
    return 0


def _load_table(
    store: Path, logical: str, errors: list[str],
) -> dict[str, object] | None:
    path = store / q.hashed_rel(logical)
    if not path.is_file():
        errors.append(f"table.{logical}.missing: {path}")
        return None
    try:
        table = q.load_table(logical, path=path)
    except (OSError, UnicodeError, TypeError, ValueError) as exc:
        errors.append(
            f"table.{logical}.invalid: {type(exc).__name__}: {exc}"
        )
        return None
    if not isinstance(table, dict):
        errors.append(f"table.{logical}.invalid: root is not a map")
        return None
    return table


def _load_json(
    assets_dir: Path, stem: str, errors: list[str],
) -> Any | None:
    path = assets_dir / f"{stem}.json"
    if not path.is_file():
        errors.append(f"assets.{stem}.missing: {path}")
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        errors.append(
            f"assets.{stem}.invalid: {type(exc).__name__}: {exc}"
        )
        return None


def _leaf_rows(value: object, label: str, errors: list[str]) -> list[list[str]] | None:
    if not isinstance(value, (bytes, str)):
        errors.append(f"{label}.invalid: expected CSV leaf, got {type(value).__name__}")
        return None
    try:
        text = value.decode("utf-8") if isinstance(value, bytes) else value
        rows = core.read_csv_lines(text)
    except (UnicodeError, TypeError, ValueError, csv.Error) as exc:
        errors.append(f"{label}.invalid: {type(exc).__name__}: {exc}")
        return None
    if not rows:
        errors.append(f"{label}.invalid: empty CSV leaf")
        return None
    return rows


def _validate_item(table: object, errors: list[str]) -> None:
    if not isinstance(table, dict):
        return
    leaf = table.get(rewards.TOKEN_ID)
    if leaf is None:
        errors.append(f"item[{rewards.TOKEN_ID}].missing")
        return
    rows = _leaf_rows(leaf, f"item[{rewards.TOKEN_ID}]", errors)
    if rows is None or len(rows) != 1 or len(rows[0]) <= 5:
        if rows is not None:
            errors.append(f"item[{rewards.TOKEN_ID}].schema")
        return
    row = rows[0]
    expected = {
        0: ("string_id", "rogue_event_item_99"),
        1: ("id", rewards.TOKEN_ID),
        2: ("name", "深渊代币"),
        5: ("description", rewards.TOKEN_DESCRIPTION),
    }
    for column, (name, value) in expected.items():
        if row[column] != value:
            errors.append(
                f"item[{rewards.TOKEN_ID}].{name}: "
                f"expected={value!r}, actual={row[column]!r}"
            )


def _validate_weapons(
    equipment: object,
    status: object,
    ability_soul: object,
    errors: list[str],
) -> list[str]:
    equipment_map = equipment if isinstance(equipment, dict) else {}
    status_map = status if isinstance(status, dict) else {}
    soul_map = ability_soul if isinstance(ability_soul, dict) else {}
    descriptions: list[str] = []

    for spec in rewards.WEAPONS:
        equipment_leaf = equipment_map.get(spec.id)
        equipment_rows: list[list[str]] | None = None
        if equipment_leaf is None:
            errors.append(f"equipment[{spec.id}].missing")
        else:
            equipment_rows = _leaf_rows(
                equipment_leaf, f"equipment[{spec.id}]", errors
            )
        if equipment_rows is not None:
            if len(equipment_rows) != 1 or len(equipment_rows[0]) < 12:
                errors.append(f"equipment[{spec.id}].schema")
            else:
                expected_row: list[str] | None = None
                donor_leaf = equipment_map.get(spec.donor)
                if donor_leaf is None:
                    errors.append(f"equipment[{spec.id}].donor_missing: {spec.donor}")
                else:
                    try:
                        expected_leaf = rewards.build_equipment_leaf(donor_leaf, spec)
                        expected_rows = _leaf_rows(
                            expected_leaf,
                            f"equipment[{spec.id}].expected",
                            errors,
                        )
                        if expected_rows is not None and len(expected_rows) == 1:
                            expected_row = expected_rows[0]
                    except (
                        KeyError,
                        IndexError,
                        TypeError,
                        ValueError,
                        csv.Error,
                    ) as exc:
                        errors.append(
                            f"equipment[{spec.id}].expected.invalid: "
                            f"{type(exc).__name__}: {exc}"
                        )
                if expected_row is not None:
                    actual_row = equipment_rows[0]
                    fields = {
                        0: "string_id",
                        1: "name",
                        6: "image_path",
                        7: "description",
                        8: "max_level",
                        9: "ability_enabled",
                        10: "ability_column",
                        11: "rarity",
                    }
                    for column, name in fields.items():
                        if actual_row[column] != expected_row[column]:
                            errors.append(
                                f"equipment[{spec.id}].{name}: "
                                f"expected={expected_row[column]!r}, "
                                f"actual={actual_row[column]!r}"
                            )
                    if actual_row != expected_row:
                        errors.append(f"equipment[{spec.id}].canonical_row")

        actual_status = status_map.get(spec.id)
        if actual_status is None:
            errors.append(f"equipment_status[{spec.id}].missing")
        elif spec.donor not in status_map:
            errors.append(f"equipment_status[{spec.id}].donor_missing: {spec.donor}")
        else:
            try:
                expected_status = rewards.build_equipment_status(status_map, spec)
                if actual_status != expected_status:
                    errors.append(f"equipment_status[{spec.id}].donor_map")
            except (KeyError, TypeError, ValueError) as exc:
                errors.append(
                    f"equipment_status[{spec.id}].invalid: "
                    f"{type(exc).__name__}: {exc}"
                )

        actual_soul = soul_map.get(spec.id)
        actual_soul_rows: list[list[str]] | None = None
        if actual_soul is None:
            errors.append(f"ability_soul[{spec.id}].missing")
        else:
            actual_soul_rows = _leaf_rows(
                actual_soul, f"ability_soul[{spec.id}]", errors
            )
        if actual_soul_rows is not None:
            try:
                expected_soul = rewards.build_soul_leaf(soul_map, spec)
                expected_rows = _leaf_rows(
                    expected_soul, f"ability_soul[{spec.id}].expected", errors
                )
                if expected_rows is not None and actual_soul_rows != expected_rows:
                    errors.append(f"ability_soul[{spec.id}].canonical_rows")
            except (
                KeyError,
                IndexError,
                TypeError,
                ValueError,
                csv.Error,
            ) as exc:
                errors.append(
                    f"ability_soul[{spec.id}].templates: "
                    f"{type(exc).__name__}: {exc}"
                )

        rendered: list[str] = []
        if actual_soul_rows is not None:
            try:
                rendered = wf_describe.describe_rows(
                    actual_soul_rows, "ability_soul"
                )
            except (
                ArithmeticError,
                KeyError,
                IndexError,
                TypeError,
                ValueError,
            ) as exc:
                errors.append(
                    f"ability_soul[{spec.id}].description.invalid: "
                    f"{type(exc).__name__}: {exc}"
                )
            if not rendered or any(
                not isinstance(value, str) or not value.strip()
                for value in rendered
            ):
                errors.append(f"ability_soul[{spec.id}].description.empty")
        description_text = " | ".join(
            value.strip()
            for value in rendered
            if isinstance(value, str) and value.strip()
        )
        if not description_text:
            description_text = "<unavailable>"
        descriptions.append(f"{spec.id} {spec.name}: {description_text}")

    return descriptions


def _validate_rush(table: object, errors: list[str]) -> None:
    if not isinstance(table, dict):
        return
    leaf = table.get(rewards.EVENT_ID)
    if leaf is None:
        errors.append(f"rush_event[{rewards.EVENT_ID}].missing")
        return
    rows = _leaf_rows(leaf, f"rush_event[{rewards.EVENT_ID}]", errors)
    if rows is None or len(rows) != 1 or len(rows[0]) <= 10:
        if rows is not None:
            errors.append(f"rush_event[{rewards.EVENT_ID}].schema")
        return
    if rows[0][10] != rewards.TOKEN_ID:
        errors.append(
            f"rush_event[{rewards.EVENT_ID}].token: "
            f"expected={rewards.TOKEN_ID}, actual={rows[0][10]!r}"
        )


def _validate_mirrors(values: dict[str, Any], errors: list[str]) -> None:
    max_level = values.get("equipment_max_level")
    element = values.get("equipment_element")
    lookup = values.get("equipment_lookup")
    equipment_ids = values.get("equipment_ids")
    item_ids = values.get("item_ids")

    for spec in rewards.WEAPONS:
        if isinstance(max_level, dict):
            if spec.id not in max_level:
                errors.append(f"assets.equipment_max_level[{spec.id}].missing")
            elif spec.donor not in max_level:
                errors.append(
                    f"assets.equipment_max_level[{spec.id}].donor_missing: "
                    f"{spec.donor}"
                )
            elif not _strict_equal(max_level[spec.id], max_level[spec.donor]):
                errors.append(
                    f"assets.equipment_max_level[{spec.id}].value: "
                    f"expected donor {max_level[spec.donor]!r}, "
                    f"actual={max_level[spec.id]!r}"
                )
        if isinstance(element, dict):
            if not _strict_equal(element.get(spec.id), spec.element):
                errors.append(
                    f"assets.equipment_element[{spec.id}].value: "
                    f"expected={spec.element}, actual={element.get(spec.id)!r}"
                )
        if isinstance(lookup, dict):
            actual = lookup.get(spec.id)
            donor = lookup.get(spec.donor)
            if not isinstance(actual, dict):
                errors.append(f"assets.equipment_lookup[{spec.id}].missing")
            else:
                if actual.get("name") != spec.name:
                    errors.append(f"assets.equipment_lookup[{spec.id}].name")
                if actual.get("rarity") != "5":
                    errors.append(f"assets.equipment_lookup[{spec.id}].rarity")
                if not isinstance(donor, dict) or "category" not in donor:
                    errors.append(
                        f"assets.equipment_lookup[{spec.id}].donor_category_missing"
                    )
                elif actual.get("category") != donor["category"]:
                    errors.append(f"assets.equipment_lookup[{spec.id}].category")

    _validate_id_list(
        equipment_ids,
        [int(spec.id) for spec in rewards.WEAPONS],
        "assets.equipment_ids",
        errors,
    )
    _validate_id_list(
        item_ids,
        [int(rewards.TOKEN_ID)],
        "assets.item_ids",
        errors,
    )


def _validate_id_list(
    value: object, required: list[int], label: str, errors: list[str],
) -> None:
    if value is None:
        return
    if not isinstance(value, list) or any(
        not isinstance(entry, int) or isinstance(entry, bool) for entry in value
    ):
        errors.append(f"{label}.invalid: expected integer array")
        return
    if value != sorted(set(value)):
        errors.append(f"{label}.ordering: expected sorted unique integers")
    missing = sorted(set(required).difference(value))
    if missing:
        errors.append(f"{label}.missing: {missing}")


def _strict_equal(actual: object, expected: object) -> bool:
    """Compare JSON-like values without Python's bool/int equivalence."""
    if type(actual) is not type(expected):
        return False
    if isinstance(expected, dict):
        return actual.keys() == expected.keys() and all(
            _strict_equal(actual[key], value) for key, value in expected.items()
        )
    if isinstance(expected, list):
        return len(actual) == len(expected) and all(
            _strict_equal(actual_value, expected_value)
            for actual_value, expected_value in zip(actual, expected)
        )
    return actual == expected


def _validate_shop(
    client: object, server: object, id_map: object, errors: list[str],
) -> None:
    if isinstance(client, dict):
        reserved_order = tuple(
            key for key in client if key in shop.RESERVED_SHOP_IDS
        )
        if reserved_order != shop.RESERVED_SHOP_IDS:
            errors.append(
                f"shop.client.ordering: actual={reserved_order!r}"
            )
        for shop_id in shop.RESERVED_SHOP_IDS:
            if shop_id not in client:
                errors.append(f"shop.client[{shop_id}].missing")
    if isinstance(client, dict) and isinstance(server, dict) and isinstance(id_map, dict):
        try:
            for problem in shop.validate_shop(client, server, id_map):
                errors.append(f"shop.contract: {problem}")
        except (KeyError, IndexError, TypeError, ValueError, csv.Error) as exc:
            errors.append(
                f"shop.contract.invalid: {type(exc).__name__}: {exc}"
            )

    expected_products = shop._expected_products(rewards.WEAPONS)
    target_products: dict[str, Any] = {}
    if isinstance(server, dict):
        events = server.get(shop.EVENT_TYPE)
        candidate = events.get(shop.EVENT_ID) if isinstance(events, dict) else None
        if isinstance(candidate, dict):
            target_products = candidate
    for shop_id in shop.RESERVED_SHOP_IDS:
        actual = target_products.get(shop_id)
        expected = expected_products[shop_id]
        if not isinstance(actual, dict):
            errors.append(f"shop.server[{shop_id}].nesting")
            continue
        if not _strict_equal(actual.get("costs"), expected["costs"]):
            errors.append(f"shop.server[{shop_id}].cost")
        if not _strict_equal(actual.get("stock"), expected["stock"]):
            errors.append(f"shop.server[{shop_id}].stock")
        if not _strict_equal(actual.get("rewards"), expected["rewards"]):
            errors.append(f"shop.server[{shop_id}].reward")
        for name in ("availableFrom", "availableUntil"):
            if not _strict_equal(actual.get(name), expected[name]):
                errors.append(f"shop.server[{shop_id}].{name}")

    expected_map = {
        "eventType": int(shop.EVENT_TYPE),
        "eventId": int(shop.EVENT_ID),
    }
    if isinstance(id_map, dict):
        for shop_id in shop.RESERVED_SHOP_IDS:
            if not _strict_equal(id_map.get(shop_id), expected_map):
                errors.append(f"shop.id_map[{shop_id}].value")


def _validate_pngs(store: Path, assets_dir: Path, errors: list[str]) -> None:
    source_dir = assets_dir.parent / "mod-tools" / "assets" / "abyss-equipment"
    try:
        rewards.validate_source_assets(source_dir, rewards.WEAPONS)
    except (OSError, KeyError, TypeError, ValueError, RuntimeError) as exc:
        errors.append(
            f"png.sources.invalid: {type(exc).__name__}: {exc}"
        )

    for spec in rewards.WEAPONS:
        logical = f"{rewards.IMAGE_PREFIX}/{spec.image_slug}.png"
        source = source_dir / f"{spec.image_slug}.png"
        destination = store / q.hashed_rel(logical)
        if not destination.is_file():
            errors.append(f"png.store[{logical}].missing: {destination}")
            continue
        try:
            stored = destination.read_bytes()
        except OSError as exc:
            errors.append(
                f"png.store[{logical}].invalid: {type(exc).__name__}: {exc}"
            )
            continue
        try:
            source_bytes = source.read_bytes()
            expected_stored = wf_assets.png_encode(source_bytes)
        except (OSError, TypeError, ValueError):
            expected_stored = None
        if expected_stored is not None and stored != expected_stored:
            errors.append(f"png.store[{logical}].bytes")


def _validate_client_verification(
    report_path: Path, errors: list[str],
) -> None:
    if not report_path.is_file():
        errors.append(
            f"client_verification.report.missing: {report_path.resolve()}"
        )
        return
    try:
        data = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        errors.append(
            f"client_verification.report.invalid: "
            f"{type(exc).__name__}: {exc}"
        )
        return
    if not isinstance(data, dict):
        errors.append("client_verification.report.invalid: root is not an object")
        return

    if type(data.get("schema_version")) is not int:
        errors.append(
            "client_verification.report.invalid: schema_version must be integer 1"
        )

    try:
        apk_builder.validate_verification_report(data)
    except (OSError, UnicodeError, TypeError, ValueError, RuntimeError) as exc:
        errors.append(
            f"client_verification.report.invalid: "
            f"{type(exc).__name__}: {exc}"
        )

    artifacts = data.get("artifacts")
    if not isinstance(artifacts, dict):
        return
    try:
        report_mtime = report_path.stat().st_mtime_ns
    except OSError:
        report_mtime = None

    artifact_paths: dict[str, Path] = {}
    for name in apk_builder.REPORT_ARTIFACTS:
        record = artifacts.get(name)
        if not isinstance(record, dict) or not isinstance(record.get("path"), str):
            continue
        path = Path(record["path"])
        artifact_paths[name] = path
        try:
            artifact_mtime = path.stat().st_mtime_ns
        except (OSError, ValueError):
            artifact_mtime = None
        if (
            report_mtime is not None
            and artifact_mtime is not None
            and artifact_mtime > report_mtime
        ):
            errors.append(
                f"client_verification.report.stale[{name}]: "
                f"artifact mtime {artifact_mtime} > report mtime {report_mtime}"
            )

    reexported = artifact_paths.get("reexported_as")
    if reexported is None or not reexported.is_file():
        errors.append("client_verification.reexport.missing")
    else:
        try:
            reexported_text = reexported.read_text(encoding="utf-8-sig")
            apk_builder.abyss_patch.verify_text(
                reexported_text, require_markers=False
            )
        except (OSError, UnicodeError, TypeError, ValueError, RuntimeError) as exc:
            errors.append(
                f"client_verification.reexport.semantic: "
                f"{type(exc).__name__}: {exc}"
            )

    signed_apk = artifact_paths.get("signed_apk")
    if signed_apk is None or not signed_apk.is_file():
        errors.append("client_verification.apk.missing")
        return
    try:
        with zipfile.ZipFile(signed_apk, "r") as archive:
            matches = [
                member
                for member in archive.infolist()
                if member.filename == apk_builder.TARGET_SWF_MEMBER
            ]
            if len(matches) != 1:
                errors.append(
                    "client_verification.apk.target_swf: "
                    f"expected=1, actual={len(matches)}"
                )
                return
            embedded_digest = hashlib.sha256(
                archive.read(matches[0])
            ).hexdigest()
    except (OSError, KeyError, RuntimeError, zipfile.BadZipFile) as exc:
        errors.append(
            f"client_verification.apk.invalid: "
            f"{type(exc).__name__}: {exc}"
        )
        return
    injected = artifacts.get("injected_swf")
    expected_digest = injected.get("sha256") if isinstance(injected, dict) else None
    if embedded_digest != expected_digest:
        errors.append(
            "client_verification.apk.embedded_swf: "
            f"expected={expected_digest!r}, actual={embedded_digest!r}"
        )


if __name__ == "__main__":
    sys.exit(main())
