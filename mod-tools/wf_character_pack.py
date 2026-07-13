#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Read-only character-package manifest contract primitives.

Task 1 deliberately stops at loading and validation.  Staging, live-store
mutation, release allocation, and publication belong to later transaction
layers and are not implemented here.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass
from pathlib import Path, PureWindowsPath
from typing import Literal

RootName = Literal["common", "medium", "android", "server"]

SCHEMA_VERSION = 1
ROOT_NAMES: tuple[RootName, ...] = ("common", "medium", "android", "server")
REQUIRED_TOP_LEVEL = frozenset({
    "schema_version",
    "package_id",
    "character_id",
    "code_name",
    "package_version",
    "requires_client_base",
    "required_capabilities",
    "roots",
    "tables",
    "skills",
    "unique_condition",
    "qa",
    "snapshot",
})
FILE_FIELDS = frozenset({"logical_path", "sha256", "size"})
FORBIDDEN_ASSET_SEGMENTS = frozenset({
    "story", "words", "login", "expression", "expressions",
})
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
FILESYSTEM_ERRORS = (OSError, RuntimeError, ValueError)


@dataclass(frozen=True)
class PackFile:
    root: RootName
    logical_path: str
    sha256: str
    size: int


def _reject_json_constant(value: str):
    raise ValueError(f"non-JSON constant {value}")


def _reject_duplicate_object_keys(pairs: list[tuple[str, object]]) -> dict:
    result: dict = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON object key {key!r}")
        result[key] = value
    return result


def load_manifest(path: Path) -> dict:
    """Load a UTF-8 JSON manifest without touching any package or live root."""
    manifest = json.loads(
        path.read_text(encoding="utf-8"),
        parse_constant=_reject_json_constant,
        object_pairs_hook=_reject_duplicate_object_keys,
    )
    if not isinstance(manifest, dict):
        raise ValueError("character-pack manifest must be a JSON object")
    return manifest


def canonical_manifest_bytes(manifest: dict) -> bytes:
    """Return the exact canonical UTF-8 representation used for hashing."""
    return json.dumps(
        manifest,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def _path_problem(logical_path: str) -> str | None:
    windows_path = PureWindowsPath(logical_path)
    if logical_path.startswith("/") or windows_path.is_absolute() or windows_path.drive:
        return "must be relative"
    if "\\" in logical_path:
        return "must use forward slashes"
    segments = logical_path.split("/")
    if any(segment == ".." for segment in segments):
        return "must not contain '..' segments"
    if any(segment in ("", ".") for segment in segments):
        return "must not contain empty or '.' segments"
    return None


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _resolve_for_validation(path: Path, field: str, errors: list[str]) -> Path | None:
    try:
        return path.resolve()
    except FILESYSTEM_ERRORS:
        errors.append(f"{field}: cannot resolve path")
        return None


def _validate_string_field(manifest: dict, field: str, errors: list[str]) -> None:
    if field not in manifest:
        return
    value = manifest[field]
    if not isinstance(value, str) or not value:
        errors.append(f"{field}: must be a non-empty string")


def _json_value_errors(value: object, path: str = "$",
                       ancestors: set[int] | None = None) -> list[str]:
    """Reject values that canonical JSON cannot represent deterministically."""
    errors: list[str] = []
    ancestors = set() if ancestors is None else ancestors
    value_type = type(value)
    if value is None or value_type in (bool, int):
        return errors
    if value_type is str:
        try:
            value.encode("utf-8")
        except UnicodeEncodeError:
            errors.append(f"{path}: string is not valid UTF-8")
        return errors
    if value_type is float:
        if not math.isfinite(value):
            errors.append(f"{path}: non-finite number is not a JSON value")
        return errors
    if value_type not in (list, dict):
        errors.append(f"{path}: not a JSON value ({value_type.__name__})")
        return errors

    marker = id(value)
    if marker in ancestors:
        errors.append(f"{path}: circular reference is not a JSON value")
        return errors
    ancestors.add(marker)
    try:
        if value_type is list:
            for index, item in enumerate(value):
                errors.extend(_json_value_errors(item, f"{path}[{index}]", ancestors))
        else:
            for key, item in value.items():
                if type(key) is not str:
                    errors.append(f"{path}: object key must be a string")
                    continue
                try:
                    key.encode("utf-8")
                except UnicodeEncodeError:
                    errors.append(f"{path}: object key is not valid UTF-8")
                    continue
                errors.extend(_json_value_errors(item, f"{path}.{key}", ancestors))
    finally:
        ancestors.remove(marker)
    return errors


def validate_manifest(manifest: dict, package_dir: Path) -> list[str]:
    """Return every deterministic contract error without mutating any input/root."""
    if not isinstance(manifest, dict):
        return ["manifest: must be an object"]

    errors = _json_value_errors(manifest)
    if errors:
        return sorted(errors)
    for field in sorted(REQUIRED_TOP_LEVEL - set(manifest)):
        errors.append(f"{field} is required")
    for field in sorted(set(manifest) - REQUIRED_TOP_LEVEL):
        errors.append(f"unexpected top-level field: {field}")

    if "schema_version" in manifest:
        version = manifest["schema_version"]
        if type(version) is not int or version != SCHEMA_VERSION:
            errors.append(f"schema_version: unsupported schema_version {version!r}")
    if "character_id" in manifest:
        character_id = manifest["character_id"]
        if type(character_id) is not int or character_id < 0:
            errors.append("character_id: must be a non-negative integer")
    for field in (
        "package_id", "code_name", "package_version", "requires_client_base",
    ):
        _validate_string_field(manifest, field, errors)

    capabilities = manifest.get("required_capabilities")
    if capabilities is not None:
        if not isinstance(capabilities, list):
            errors.append("required_capabilities: must be an array")
        else:
            seen_capabilities: set[str] = set()
            for index, capability in enumerate(capabilities):
                if not isinstance(capability, str) or not capability:
                    errors.append(
                        f"required_capabilities[{index}]: must be a non-empty string"
                    )
                elif capability in seen_capabilities:
                    errors.append(f"required_capabilities[{index}]: duplicate capability {capability}")
                else:
                    seen_capabilities.add(capability)

    expected_types = {
        "tables": list,
        "skills": dict,
        "unique_condition": dict,
        "qa": dict,
        "snapshot": dict,
    }
    for field, expected_type in expected_types.items():
        if field in manifest and not isinstance(manifest[field], expected_type):
            errors.append(f"{field}: must be a {expected_type.__name__}")

    roots = manifest.get("roots")
    if roots is None:
        return sorted(errors)
    if not isinstance(roots, dict):
        errors.append("roots: must be an object")
        return sorted(errors)
    for root in sorted(set(ROOT_NAMES) - set(roots)):
        errors.append(f"roots.{root} is required")
    for root in sorted(set(roots) - set(ROOT_NAMES)):
        errors.append(f"roots: unexpected root {root}")

    seen_paths: dict[str, str] = {}
    package_anchor = _resolve_for_validation(Path(package_dir), "package_dir", errors)
    roots_anchor: Path | None = None
    if package_anchor is not None:
        roots_anchor = _resolve_for_validation(package_anchor / "roots", "roots", errors)
        if roots_anchor is not None:
            try:
                roots_anchor.relative_to(package_anchor)
            except ValueError:
                errors.append("roots: resolves outside package_dir")
                roots_anchor = None

    for root in ROOT_NAMES:
        entries = roots.get(root)
        if entries is None:
            continue
        if not isinstance(entries, list):
            errors.append(f"roots.{root}: must be an array")
            continue
        root_dir: Path | None = None
        if roots_anchor is not None:
            root_dir = _resolve_for_validation(
                roots_anchor / root, f"roots.{root}", errors
            )
            if root_dir is not None:
                try:
                    root_dir.relative_to(roots_anchor)
                except ValueError:
                    errors.append(f"roots.{root}: resolves outside package roots")
                    root_dir = None
        for index, entry in enumerate(entries):
            prefix = f"roots.{root}[{index}]"
            if not isinstance(entry, dict):
                errors.append(f"{prefix}: must be an object")
                continue
            for field in sorted(FILE_FIELDS - set(entry)):
                errors.append(f"{prefix}.{field} is required")
            for field in sorted(set(entry) - FILE_FIELDS):
                errors.append(f"{prefix}: unexpected field {field}")

            logical_path = entry.get("logical_path")
            path_valid = False
            path_segments: list[str] = []
            if not isinstance(logical_path, str) or not logical_path:
                if "logical_path" in entry:
                    errors.append(f"{prefix}.logical_path: must be a non-empty string")
            else:
                path_segments = logical_path.split("/")
                problem = _path_problem(logical_path)
                if problem:
                    errors.append(f"{prefix}.logical_path: {problem}")
                else:
                    path_valid = True
                    previous = seen_paths.get(logical_path)
                    if previous is not None:
                        errors.append(
                            f"{prefix}.logical_path: duplicate logical_path {logical_path!r}; "
                            f"first declared at {previous}"
                        )
                    else:
                        seen_paths[logical_path] = prefix
                forbidden = sorted(
                    {segment.lower() for segment in path_segments}
                    & FORBIDDEN_ASSET_SEGMENTS
                )
                for segment in forbidden:
                    errors.append(
                        f"{prefix}.logical_path: forbidden asset segment {segment!r}"
                    )

            sha256 = entry.get("sha256")
            sha_valid = isinstance(sha256, str) and SHA256_RE.fullmatch(sha256) is not None
            if "sha256" in entry and not sha_valid:
                errors.append(f"{prefix}.sha256: invalid sha256")

            size = entry.get("size")
            size_valid = type(size) is int and size >= 0
            if "size" in entry and not size_valid:
                errors.append(f"{prefix}.size: must be a non-negative integer")

            if not path_valid or root_dir is None:
                continue
            candidate = _resolve_for_validation(
                root_dir.joinpath(*path_segments), f"{prefix}.logical_path", errors
            )
            if candidate is None:
                continue
            try:
                candidate.relative_to(root_dir)
            except ValueError:
                errors.append(f"{prefix}.logical_path: resolves outside declared root")
                continue
            try:
                is_file = candidate.is_file()
            except FILESYSTEM_ERRORS:
                errors.append(f"{prefix}: cannot inspect file")
                continue
            if not is_file:
                errors.append(f"{prefix}: file does not exist: {logical_path}")
                continue
            try:
                actual_size = candidate.stat().st_size
            except FILESYSTEM_ERRORS:
                errors.append(f"{prefix}.size: cannot inspect file size")
                continue
            if size_valid and actual_size != size:
                errors.append(
                    f"{prefix}: size mismatch: expected {size}, got {actual_size}"
                )
            if sha_valid:
                try:
                    actual_sha256 = _sha256_file(candidate)
                except FILESYSTEM_ERRORS:
                    errors.append(f"{prefix}.sha256: cannot hash file")
                    continue
                if actual_sha256 != sha256:
                    errors.append(
                        f"{prefix}: sha256 mismatch: expected {sha256}, got {actual_sha256}"
                    )

    if not errors:
        try:
            canonical_manifest_bytes(manifest)
        except (TypeError, ValueError, OverflowError, RecursionError, UnicodeError):
            errors.append("manifest: cannot be canonicalized as deterministic JSON")
    return sorted(errors)
