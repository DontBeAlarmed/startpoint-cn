#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Character-package validation and lock-free transaction preparation.

This module may read live roots, but it never mutates them and never allocates
release versions or final archive names.  Production promotion and the single
``active.json`` commit point belong to :mod:`wf_release`.
"""
from __future__ import annotations

import base64
import ctypes
import hashlib
import io
import json
import math
import os
import re
import uuid
import zipfile
from collections.abc import Iterator
from dataclasses import asdict, dataclass, replace
from pathlib import Path, PureWindowsPath
from typing import Any, Callable, Iterable, Literal, Mapping, Protocol, cast

if os.name == "nt":
    from ctypes import wintypes

import wf_mod_tool as core
import wf_assets

RootName = Literal["common", "medium", "android", "server"]
TableKey = tuple[RootName, str]

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
SERVER_LOGICAL_PATHS = (
    "cdndata/character.json",
    "cdndata/character_text.json",
    "character.json",
    "mana_node.json",
)
CLIENT_ROOTS: tuple[RootName, ...] = ("common", "medium", "android")
ARCHIVE_PREFIXES = {
    "common": "production/upload/",
    "medium": "production/medium_upload/",
    "android": "production/android_upload/",
}
UNIQUE_CONDITION_TABLE = "master/character/unique_condition.orderedmap"
TRANSACTION_MARKER = ".character-pack-transaction.json"
SNAPSHOT_MARKER = ".character-pack-snapshot.json"
# 回滚增量在 active 链上的 package_id 后缀（见 wf_character_rollback）；
# 正常包禁用该后缀，保证所有权推导无歧义。
ROLLBACK_PACKAGE_SUFFIX = "-rollback"
MATERIALIZE_PHASES = (
    "table_materialization",
    "asset_copy",
    "readback",
    "hash_verification",
    "provisional_zip_content",
)


@dataclass(frozen=True)
class PackFile:
    root: RootName
    logical_path: str
    sha256: str
    size: int


class PackPreflightError(ValueError):
    """The package cannot safely enter isolated staging."""


class PackStagingError(RuntimeError):
    """Isolated staging failed and its owned child was discarded."""


@dataclass(frozen=True)
class FileExpectation:
    exists: bool
    sha256: str | None
    size: int | None


@dataclass(frozen=True)
class ReleaseBaseState:
    active_raw: bytes | None
    active_sha256: str | None
    current_release_id: str | None
    validated_chain_tail: str
    expected_from_version: str
    active_package_manifest_sha256: str | None = None
    # 每个 package_id 当前生效的 manifest 哈希（多独立包共存）。
    # None = 旧 provider 未提供，回退到"链尾单一所有者"语义。
    package_owners: tuple[tuple[str, str], ...] | None = None


class ReleaseBaseProvider(Protocol):
    def read_validated_base(self) -> ReleaseBaseState: ...


@dataclass(frozen=True)
class LiveRoots:
    common: Path
    medium: Path
    android: Path
    server: Path
    protected: tuple[Path, ...] = ()


@dataclass(frozen=True)
class SemanticClaim:
    namespace: str
    value: str
    source_logical_path: str


@dataclass(frozen=True)
class TableClaim:
    root: RootName
    logical_path: str
    codec_id: str
    outer_keys: tuple[str, ...]
    inner_keys: tuple[tuple[str, tuple[str, ...]], ...] = ()
    semantic_claims: tuple[SemanticClaim, ...] = ()


@dataclass(frozen=True)
class TableImage:
    """Schema-free table inspection returned by an explicit codec."""

    outer_rows: tuple[tuple[str, bytes], ...]
    inner_rows: tuple[tuple[str, str, bytes], ...] = ()
    semantic_values: tuple[tuple[str, str], ...] = ()


class TableCodec(Protocol):
    def inspect(
        self,
        raw: bytes,
        claim: TableClaim,
        semantic_claims: tuple[SemanticClaim, ...],
    ) -> TableImage: ...


@dataclass(frozen=True)
class FrozenRecord(Mapping[str, Any]):
    """Recursively immutable mapping used at every transaction boundary."""

    items_tuple: tuple[tuple[str, Any], ...]

    def __getitem__(self, key: str) -> Any:
        for item_key, value in self.items_tuple:
            if item_key == key:
                return value
        raise KeyError(key)

    def __iter__(self) -> Iterator[str]:
        return (key for key, _ in self.items_tuple)

    def __len__(self) -> int:
        return len(self.items_tuple)

    def __eq__(self, other: object) -> bool:
        if isinstance(other, Mapping):
            return dict(self.items()) == dict(other.items())
        return False

    def __hash__(self) -> int:
        return hash(self.items_tuple)


def _freeze(value: Any) -> Any:
    if isinstance(value, FrozenRecord):
        return value
    if isinstance(value, Mapping):
        return FrozenRecord(tuple(
            (str(key), _freeze(item))
            for key, item in sorted(value.items(), key=lambda pair: str(pair[0]))
        ))
    if isinstance(value, (tuple, list)):
        return tuple(_freeze(item) for item in value)
    if isinstance(value, set):
        return frozenset(_freeze(item) for item in value)
    return value


def _plain(value: Any) -> Any:
    if isinstance(value, FrozenRecord):
        return {key: _plain(item) for key, item in value.items()}
    if isinstance(value, Mapping):
        return {str(key): _plain(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [_plain(item) for item in value]
    if isinstance(value, frozenset):
        return sorted(_plain(item) for item in value)
    if isinstance(value, Path):
        return str(value)
    return value


@dataclass(frozen=True)
class PreflightReport:
    package_id: str
    package_version: str
    installed_version: str | None
    version_diff: FrozenRecord
    creates: tuple[FrozenRecord, ...]
    updates: tuple[FrozenRecord, ...]
    deletes: tuple[FrozenRecord, ...]
    conflicts: tuple[FrozenRecord, ...]
    root_totals: FrozenRecord
    expected_base_hashes: FrozenRecord
    capability_warnings: tuple[FrozenRecord, ...]
    can_prepare: bool
    delivery_status: str

    def canonical_bytes(self) -> bytes:
        return _canonical_json_bytes({
            "package_id": self.package_id,
            "package_version": self.package_version,
            "installed_version": self.installed_version,
            "version_diff": _plain(self.version_diff),
            "creates": _plain(self.creates),
            "updates": _plain(self.updates),
            "deletes": _plain(self.deletes),
            "conflicts": _plain(self.conflicts),
            "root_totals": _plain(self.root_totals),
            "expected_base_hashes": _plain(self.expected_base_hashes),
            "capability_warnings": _plain(self.capability_warnings),
            "can_prepare": self.can_prepare,
            "delivery_status": self.delivery_status,
        })


@dataclass(frozen=True)
class PreparedPack:
    transaction_id: str
    staging_root: Path
    transaction_dir: Path
    marker_nonce: str
    prepared_digest: str
    package_manifest_sha256: str
    release_base: ReleaseBaseState
    table_key_changes: tuple[FrozenRecord, ...]
    file_changes: tuple[FrozenRecord, ...]
    degraded_data_confirmed: bool


@dataclass(frozen=True)
class SnapshotRecord:
    transaction_id: str
    snapshot_dir: Path
    release_base: ReleaseBaseState
    table_before: tuple[FrozenRecord, ...]
    file_before: tuple[FrozenRecord, ...]


@dataclass(frozen=True)
class StagedPack:
    transaction_id: str
    staging_root: Path
    transaction_dir: Path
    staged_files: tuple[FrozenRecord, ...]
    table_readback: tuple[FrozenRecord, ...]
    provisional_archives: tuple[FrozenRecord, ...]


@dataclass
class _Analysis:
    report: PreflightReport
    release_base: ReleaseBaseState
    candidate_claims: dict[TableKey, TableClaim]
    installed_claims: dict[TableKey, TableClaim]
    candidate_images: dict[TableKey, TableImage]
    live_images: dict[TableKey, TableImage]
    table_key_changes: tuple[FrozenRecord, ...]
    file_changes: tuple[FrozenRecord, ...]


@dataclass
class _TransactionAuthority:
    transaction_id: str
    root: Path
    transaction_dir: Path
    root_identity: tuple[int, int, int]
    dir_identity: tuple[int, int, int]
    marker_nonce: str
    marker_digest: str
    prepared_digest: str
    prepared: PreparedPack
    analysis: _Analysis
    owned_fs: "_OwnedFilesystem"
    owned_dir: "_OwnedDirectoryAuthority"
    marker_file: "_OwnedFileAuthority"
    lifecycle: str = "prepared"
    staged: StagedPack | None = None


def _canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def _json_sort_projection(value: Any) -> Any:
    """Project binary records only for deterministic ordering, without mutation."""
    if isinstance(value, bytes):
        return {"$bytes_base64": base64.b64encode(value).decode("ascii")}
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, Mapping):
        return {key: _json_sort_projection(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [_json_sort_projection(item) for item in value]
    return value


def _record_sort(records: Iterable[Mapping[str, Any]]) -> tuple[FrozenRecord, ...]:
    frozen = tuple(_freeze(record) for record in records)
    return tuple(sorted(
        frozen,
        key=lambda item: _canonical_json_bytes(_json_sort_projection(item)),
    ))


def _expectation(raw: bytes | None) -> dict[str, Any]:
    if raw is None:
        return asdict(FileExpectation(False, None, None))
    return asdict(FileExpectation(True, hashlib.sha256(raw).hexdigest(), len(raw)))


def _value_before(raw: bytes | None) -> dict[str, Any]:
    expectation = _expectation(raw)
    return {
        "exists": expectation["exists"],
        "bytes": raw,
        "sha256": expectation["sha256"],
        "size": expectation["size"],
    }


class _FlatCodec:
    def __init__(self, *, compressed_rows: bool):
        self.compressed_rows = compressed_rows

    def inspect(self, raw: bytes, claim: TableClaim,
                semantic_claims: tuple[SemanticClaim, ...]) -> TableImage:
        keys, rows = core._strict_orderedmap_rows(  # type: ignore[attr-defined]
            raw, label=claim.logical_path, compressed_rows=self.compressed_rows
        )
        return TableImage(tuple(zip(keys, rows)))


class _NestedCodec:
    def inspect(self, raw: bytes, claim: TableClaim,
                semantic_claims: tuple[SemanticClaim, ...]) -> TableImage:
        table = core.load_nested_table_bytes(raw, claim.logical_path)
        outer = tuple((key, table.raw_rows[key]) for key in table.rows)
        inner = tuple(
            (outer_key, inner_key, row)
            for outer_key, ordered in table.rows.items()
            for inner_key, row in zip(ordered.keys, ordered.rows)
        )
        return TableImage(outer, inner)


DEFAULT_CODECS: dict[str, TableCodec] = {
    "flat": _FlatCodec(compressed_rows=True),
    "raw_outer": _FlatCodec(compressed_rows=False),
    "action_nested": _NestedCodec(),
    "switched_nested": _NestedCodec(),
}


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


def _unique_condition_asset_errors(
    manifest: dict,
    package_dir: Path,
    declared_common_paths: set[str],
) -> list[str]:
    """Require every owned unique-condition icon reference to ship in common."""
    tables = manifest.get("tables")
    if not isinstance(tables, list):
        return []

    errors: list[str] = []
    for table_index, claim in enumerate(tables):
        if not isinstance(claim, dict):
            continue
        if (
            claim.get("root") != "common"
            or claim.get("logical_path") != UNIQUE_CONDITION_TABLE
            or claim.get("codec_id") != "flat"
        ):
            continue
        owned_keys = claim.get("outer_keys")
        if not isinstance(owned_keys, list):
            continue
        table_path = package_dir / "roots" / "common" / Path(
            *UNIQUE_CONDITION_TABLE.split("/")
        )
        try:
            keys, rows = core._strict_orderedmap_rows(  # type: ignore[attr-defined]
                table_path.read_bytes(),
                label=UNIQUE_CONDITION_TABLE,
                compressed_rows=True,
            )
            row_map = dict(zip(keys, rows))
        except Exception as exc:
            errors.append(
                f"tables[{table_index}]: cannot inspect unique-condition "
                f"asset references ({type(exc).__name__})"
            )
            continue

        for key_index, key in enumerate(owned_keys):
            if not isinstance(key, str):
                continue
            raw_row = row_map.get(key)
            if raw_row is None:
                continue
            prefix = f"tables[{table_index}].outer_keys[{key_index}]"
            try:
                csv_rows = core.read_csv_lines(raw_row.decode("utf-8"))
            except Exception as exc:
                errors.append(
                    f"{prefix}: cannot inspect unique-condition asset reference "
                    f"({type(exc).__name__})"
                )
                continue
            if len(csv_rows) != 1 or len(csv_rows[0]) < 3:
                errors.append(
                    f"{prefix}: unique-condition row does not contain an icon path"
                )
                continue
            icon_path = csv_rows[0][2].strip()
            if not icon_path:
                continue
            logical_icon = icon_path if icon_path.endswith(".png") else icon_path + ".png"
            problem = _path_problem(logical_icon)
            if problem:
                errors.append(f"{prefix}: invalid referenced asset path: {problem}")
            elif logical_icon not in declared_common_paths:
                errors.append(
                    f"{prefix}: referenced asset is not declared in roots.common: "
                    f"{logical_icon}"
                )
    return errors


def validate_manifest(
    manifest: dict,
    package_dir: Path,
    *,
    require_referenced_assets: bool = False,
) -> list[str]:
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
    declared_common_paths: set[str] = set()
    qa = manifest.get("qa")
    production_package = (
        isinstance(qa, dict) and qa.get("delivery_mode") == "production"
    )
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
                        if root == "common":
                            declared_common_paths.add(logical_path)
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
            if (
                production_package
                and require_referenced_assets
                and root in CLIENT_ROOTS
                and logical_path.endswith(".png")
            ):
                try:
                    with candidate.open("rb") as stream:
                        signature = stream.read(len(wf_assets.PNG_FAKE))
                except FILESYSTEM_ERRORS:
                    errors.append(f"{prefix}: cannot inspect WF storage signature")
                else:
                    if signature != wf_assets.PNG_FAKE:
                        errors.append(
                            f"{prefix}: {logical_path}: WF storage signature required"
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

    if require_referenced_assets and not errors and package_anchor is not None:
        errors.extend(_unique_condition_asset_errors(
            manifest,
            package_anchor,
            declared_common_paths,
        ))
    if not errors:
        try:
            canonical_manifest_bytes(manifest)
        except (TypeError, ValueError, OverflowError, RecursionError, UnicodeError):
            errors.append("manifest: cannot be canonicalized as deterministic JSON")
    return sorted(errors)


def _parse_transaction_claims(manifest: dict) -> dict[TableKey, TableClaim]:
    tables = manifest.get("tables")
    if not isinstance(tables, list):
        raise PackPreflightError("tables must serialize transaction claims as an array")
    result: dict[TableKey, TableClaim] = {}
    seen_table_keys: set[tuple[RootName, str, str]] = set()
    seen_inner_keys: set[tuple[RootName, str, str, str]] = set()
    seen_semantics: set[tuple[str, str]] = set()
    errors: list[str] = []
    required = {
        "root", "logical_path", "codec_id", "outer_keys", "inner_keys",
        "semantic_claims",
    }
    for index, entry in enumerate(tables):
        prefix = f"tables[{index}]"
        if not isinstance(entry, dict):
            errors.append(f"{prefix}: transaction claim must be an object")
            continue
        if set(entry) != required:
            missing = sorted(required - set(entry))
            extra = sorted(set(entry) - required)
            if missing:
                errors.append(f"{prefix}: missing fields {missing}")
            if extra:
                errors.append(f"{prefix}: unexpected fields {extra}")
            continue
        root = entry["root"]
        logical_path = entry["logical_path"]
        codec_id = entry["codec_id"]
        if root not in ROOT_NAMES:
            errors.append(f"{prefix}.root: must be one of {ROOT_NAMES}")
            continue
        root = cast(RootName, root)
        if not isinstance(logical_path, str) or _path_problem(logical_path):
            errors.append(f"{prefix}.logical_path: invalid logical path")
            continue
        table_key = (root, logical_path)
        if table_key in result:
            errors.append(
                f"{prefix}.logical_path: duplicate table claim {root}:{logical_path}"
            )
            continue
        if not isinstance(codec_id, str) or not codec_id:
            errors.append(f"{prefix}.codec_id: must be a non-empty string")
            continue

        outer_raw = entry["outer_keys"]
        outer_keys: list[str] = []
        if not isinstance(outer_raw, list):
            errors.append(f"{prefix}.outer_keys: must be an array")
        else:
            for item_index, key in enumerate(outer_raw):
                if not isinstance(key, str) or not key:
                    errors.append(
                        f"{prefix}.outer_keys[{item_index}]: must be a non-empty string"
                    )
                    continue
                marker = (root, logical_path, key)
                if marker in seen_table_keys:
                    errors.append(f"{prefix}.outer_keys[{item_index}]: duplicate claim {key}")
                    continue
                seen_table_keys.add(marker)
                outer_keys.append(key)

        inner_raw = entry["inner_keys"]
        inner_keys: list[tuple[str, tuple[str, ...]]] = []
        if not isinstance(inner_raw, list):
            errors.append(f"{prefix}.inner_keys: must be an array")
        else:
            seen_inner_outer: set[str] = set()
            for item_index, item in enumerate(inner_raw):
                item_prefix = f"{prefix}.inner_keys[{item_index}]"
                if not isinstance(item, dict) or set(item) != {"outer_key", "keys"}:
                    errors.append(f"{item_prefix}: must contain only outer_key and keys")
                    continue
                outer_key = item["outer_key"]
                keys = item["keys"]
                if not isinstance(outer_key, str) or not outer_key:
                    errors.append(f"{item_prefix}.outer_key: must be a non-empty string")
                    continue
                if outer_key in seen_inner_outer:
                    errors.append(f"{item_prefix}.outer_key: duplicate {outer_key}")
                    continue
                seen_inner_outer.add(outer_key)
                if outer_key not in outer_keys:
                    errors.append(
                        f"{item_prefix}.outer_key: {outer_key} is not an outer claim"
                    )
                if not isinstance(keys, list) or not keys:
                    errors.append(f"{item_prefix}.keys: must be a non-empty array")
                    continue
                parsed: list[str] = []
                for key_index, key in enumerate(keys):
                    if not isinstance(key, str) or not key:
                        errors.append(
                            f"{item_prefix}.keys[{key_index}]: must be a non-empty string"
                        )
                        continue
                    marker = (root, logical_path, outer_key, key)
                    if marker in seen_inner_keys:
                        errors.append(f"{item_prefix}.keys[{key_index}]: duplicate claim {key}")
                        continue
                    seen_inner_keys.add(marker)
                    parsed.append(key)
                inner_keys.append((outer_key, tuple(parsed)))

        semantic_raw = entry["semantic_claims"]
        semantics: list[SemanticClaim] = []
        if not isinstance(semantic_raw, list):
            errors.append(f"{prefix}.semantic_claims: must be an array")
        else:
            for item_index, item in enumerate(semantic_raw):
                item_prefix = f"{prefix}.semantic_claims[{item_index}]"
                required_semantic = {"namespace", "value", "source_logical_path"}
                if not isinstance(item, dict) or set(item) != required_semantic:
                    errors.append(
                        f"{item_prefix}: must contain namespace, value, source_logical_path"
                    )
                    continue
                namespace = item["namespace"]
                value = item["value"]
                source = item["source_logical_path"]
                if not all(isinstance(part, str) and part
                           for part in (namespace, value, source)):
                    errors.append(f"{item_prefix}: values must be non-empty strings")
                    continue
                if source != logical_path:
                    errors.append(f"{item_prefix}: source must equal table logical_path")
                    continue
                marker = (namespace, value)
                if marker in seen_semantics:
                    errors.append(f"{item_prefix}: duplicate semantic claim {namespace}:{value}")
                    continue
                seen_semantics.add(marker)
                semantics.append(SemanticClaim(namespace, value, source))

        result[table_key] = TableClaim(
            root,
            logical_path,
            codec_id,
            tuple(outer_keys),
            tuple(inner_keys),
            tuple(semantics),
        )
    if errors:
        raise PackPreflightError("; ".join(sorted(errors)))
    return result


def _validate_release_base(provider: ReleaseBaseProvider) -> ReleaseBaseState:
    try:
        state = provider.read_validated_base()
    except Exception as exc:
        raise PackPreflightError(f"release-base provider rejected state: {exc}") from exc
    if not isinstance(state, ReleaseBaseState):
        raise PackPreflightError("release-base provider returned an unknown state")
    if state.active_raw is None:
        if (state.active_sha256 is not None
                or state.current_release_id is not None
                or state.active_package_manifest_sha256 is not None):
            raise PackPreflightError(
                "absent active state requires absent hashes and release ID"
            )
    else:
        if not isinstance(state.active_raw, bytes):
            raise PackPreflightError("active_raw must be exact bytes")
        expected = hashlib.sha256(state.active_raw).hexdigest()
        if state.active_sha256 != expected:
            raise PackPreflightError("active bytes do not match active SHA-256")
        if not isinstance(state.current_release_id, str) or not state.current_release_id:
            raise PackPreflightError("present active state requires a release ID")
    if (not isinstance(state.validated_chain_tail, str)
            or not state.validated_chain_tail):
        raise PackPreflightError("validated chain tail is required")
    if state.expected_from_version != state.validated_chain_tail:
        raise PackPreflightError("expected from_version does not match validated chain tail")
    manifest_hash = state.active_package_manifest_sha256
    if manifest_hash is not None and SHA256_RE.fullmatch(manifest_hash) is None:
        raise PackPreflightError("active package-manifest hash is invalid")
    owners = state.package_owners
    if owners is not None:
        if not isinstance(owners, tuple):
            raise PackPreflightError("package owners must be a tuple of pairs")
        if state.active_raw is None and owners:
            raise PackPreflightError("absent active state requires empty package owners")
        seen_owner_ids: set[str] = set()
        for pair in owners:
            if (not isinstance(pair, tuple) or len(pair) != 2
                    or not isinstance(pair[0], str) or not pair[0]
                    or not isinstance(pair[1], str)
                    or SHA256_RE.fullmatch(pair[1]) is None):
                raise PackPreflightError("package owner entry is invalid")
            if pair[0] in seen_owner_ids:
                raise PackPreflightError("package owners repeat a package_id")
            seen_owner_ids.add(pair[0])
    return state


def _version_diff(installed: str | None, candidate: str) -> dict[str, str | None]:
    if installed is None:
        relation = "install"
    else:
        def key(value: str):
            pieces = value.split(".")
            if all(piece.isdigit() for piece in pieces):
                return (0, tuple(int(piece) for piece in pieces))
            return (1, value)
        relation = "same"
        if key(candidate) > key(installed):
            relation = "upgrade"
        elif key(candidate) < key(installed):
            relation = "downgrade"
    return {"installed": installed, "candidate": candidate, "relation": relation}


def _dict_rows(image: TableImage) -> tuple[
        dict[str, bytes], dict[tuple[str, str], bytes], set[tuple[str, str]]]:
    outer: dict[str, bytes] = {}
    inner: dict[tuple[str, str], bytes] = {}
    semantics: set[tuple[str, str]] = set()
    for key, raw in image.outer_rows:
        if key in outer:
            raise PackPreflightError(f"codec returned duplicate outer key {key}")
        if not isinstance(key, str) or not isinstance(raw, bytes):
            raise PackPreflightError("codec outer rows must be string/bytes pairs")
        outer[key] = raw
    for outer_key, inner_key, raw in image.inner_rows:
        marker = (outer_key, inner_key)
        if marker in inner:
            raise PackPreflightError(
                f"codec returned duplicate inner key {outer_key}/{inner_key}"
            )
        if not all(isinstance(item, str) for item in (outer_key, inner_key)) \
                or not isinstance(raw, bytes):
            raise PackPreflightError("codec inner rows must be string/string/bytes")
        inner[marker] = raw
    for namespace, value in image.semantic_values:
        marker = (namespace, value)
        if marker in semantics:
            raise PackPreflightError(
                f"codec returned duplicate semantic value {namespace}:{value}"
            )
        if not all(isinstance(item, str) for item in marker):
            raise PackPreflightError("codec semantic values must be strings")
        semantics.add(marker)
    return outer, inner, semantics


def _merge_inspection_claims(
    candidate: TableClaim, installed: TableClaim | None
) -> TableClaim:
    if installed is None:
        return candidate
    if candidate.root != installed.root \
            or candidate.logical_path != installed.logical_path \
            or candidate.codec_id != installed.codec_id:
        raise PackPreflightError("candidate/installed table claim identity mismatch")

    outer = tuple(dict.fromkeys((*candidate.outer_keys, *installed.outer_keys)))
    inner_map: dict[str, list[str]] = {}
    for outer_key, keys in (*candidate.inner_keys, *installed.inner_keys):
        bucket = inner_map.setdefault(outer_key, [])
        for key in keys:
            if key not in bucket:
                bucket.append(key)
    semantics = tuple({
        (item.namespace, item.value, item.source_logical_path): item
        for item in (*candidate.semantic_claims, *installed.semantic_claims)
    }.values())
    return TableClaim(
        candidate.root,
        candidate.logical_path,
        candidate.codec_id,
        outer,
        tuple((outer_key, tuple(keys)) for outer_key, keys in inner_map.items()),
        semantics,
    )


def _read_bytes_or_none(path: Path) -> bytes | None:
    try:
        return path.read_bytes() if path.is_file() else None
    except OSError as exc:
        raise PackPreflightError(f"cannot read live path {path}: {exc}") from exc


def _overlaps(first: Path, second: Path) -> bool:
    first = first.resolve()
    second = second.resolve()
    try:
        first.relative_to(second)
        return True
    except ValueError:
        pass
    try:
        second.relative_to(first)
        return True
    except ValueError:
        return False


def _is_link_or_junction(path: Path) -> bool:
    try:
        if path.is_symlink():
            return True
        is_junction = getattr(path, "is_junction", None)
        return bool(is_junction and is_junction())
    except OSError as exc:
        raise PackPreflightError(f"cannot inspect path link state {path}: {exc}") from exc


def _has_link_or_junction_component(path: Path) -> bool:
    absolute = Path(path).absolute()
    return any(
        candidate.exists() and _is_link_or_junction(candidate)
        for candidate in (absolute, *absolute.parents)
    )


def _prepared_digest_value(prepared: PreparedPack) -> str:
    payload = {
        "transaction_id": prepared.transaction_id,
        "staging_root": str(prepared.staging_root),
        "transaction_dir": str(prepared.transaction_dir),
        "marker_nonce": prepared.marker_nonce,
        "package_manifest_sha256": prepared.package_manifest_sha256,
        "release_base": {
            "active_raw": prepared.release_base.active_raw,
            "active_sha256": prepared.release_base.active_sha256,
            "current_release_id": prepared.release_base.current_release_id,
            "validated_chain_tail": prepared.release_base.validated_chain_tail,
            "expected_from_version": prepared.release_base.expected_from_version,
            "active_package_manifest_sha256": (
                prepared.release_base.active_package_manifest_sha256
            ),
            "package_owners": (
                [list(pair) for pair in prepared.release_base.package_owners]
                if prepared.release_base.package_owners is not None else None
            ),
        },
        "table_key_changes": _plain(prepared.table_key_changes),
        "file_changes": _plain(prepared.file_changes),
        "degraded_data_confirmed": prepared.degraded_data_confirmed,
    }
    projected = _json_sort_projection(payload)
    return hashlib.sha256(_canonical_json_bytes(projected)).hexdigest()


def _owned_leaf(prefix: str, root: str, logical_path: str) -> str:
    digest = hashlib.sha256(
        f"{root}\0{logical_path}".encode("utf-8")
    ).hexdigest()
    return f"{prefix}-{root}-{digest}"


def _validate_owned_leaf(name: str) -> str:
    if (not isinstance(name, str) or not name or name in {".", ".."}
            or "/" in name or "\\" in name or "\0" in name):
        raise PackStagingError("owned filesystem name must be one safe path leaf")
    return name


if os.name == "nt":
    class _WinUnicodeString(ctypes.Structure):
        _fields_ = [
            ("Length", wintypes.USHORT),
            ("MaximumLength", wintypes.USHORT),
            ("Buffer", wintypes.LPWSTR),
        ]


    class _WinObjectAttributes(ctypes.Structure):
        _fields_ = [
            ("Length", wintypes.ULONG),
            ("RootDirectory", wintypes.HANDLE),
            ("ObjectName", ctypes.POINTER(_WinUnicodeString)),
            ("Attributes", wintypes.ULONG),
            ("SecurityDescriptor", wintypes.LPVOID),
            ("SecurityQualityOfService", wintypes.LPVOID),
        ]


    class _WinIoStatusBlock(ctypes.Structure):
        _fields_ = [("Status", ctypes.c_void_p), ("Information", ctypes.c_void_p)]


    class _WinByHandleInfo(ctypes.Structure):
        _fields_ = [
            ("dwFileAttributes", wintypes.DWORD),
            ("ftCreationTime", wintypes.FILETIME),
            ("ftLastAccessTime", wintypes.FILETIME),
            ("ftLastWriteTime", wintypes.FILETIME),
            ("dwVolumeSerialNumber", wintypes.DWORD),
            ("nFileSizeHigh", wintypes.DWORD),
            ("nFileSizeLow", wintypes.DWORD),
            ("nNumberOfLinks", wintypes.DWORD),
            ("nFileIndexHigh", wintypes.DWORD),
            ("nFileIndexLow", wintypes.DWORD),
        ]


    class _WinDispositionInfo(ctypes.Structure):
        _fields_ = [("DeleteFile", wintypes.BOOL)]


@dataclass(frozen=True)
class _WindowsRelativeOpenContract:
    access: int
    share: int
    disposition: int
    options: int
    attributes: int


class _WindowsOwnedApi:
    FILE_SHARE_READ = 0x1
    FILE_SHARE_WRITE = 0x2
    FILE_SHARE_DELETE = 0x4
    OPEN_EXISTING = 3
    FILE_ATTRIBUTE_NORMAL = 0x80
    FILE_ATTRIBUTE_DIRECTORY = 0x10
    FILE_ATTRIBUTE_REPARSE_POINT = 0x400
    FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
    FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
    FILE_LIST_DIRECTORY = 0x1
    FILE_ADD_FILE = 0x2
    FILE_ADD_SUBDIRECTORY = 0x4
    FILE_DELETE_CHILD = 0x40
    FILE_READ_ATTRIBUTES = 0x80
    FILE_WRITE_ATTRIBUTES = 0x100
    FILE_READ_DATA = 0x1
    FILE_WRITE_DATA = 0x2
    FILE_TRAVERSE = 0x20
    DELETE = 0x00010000
    SYNCHRONIZE = 0x00100000
    GENERIC_READ = 0x80000000
    GENERIC_WRITE = 0x40000000
    OBJ_CASE_INSENSITIVE = 0x40
    FILE_OPEN = 1
    FILE_CREATE = 2
    FILE_DIRECTORY_FILE = 0x1
    FILE_SYNCHRONOUS_IO_NONALERT = 0x20
    FILE_NON_DIRECTORY_FILE = 0x40
    FILE_OPEN_FOR_BACKUP_INTENT = 0x4000
    FILE_OPEN_REPARSE_POINT = 0x00200000
    FILE_BEGIN = 0
    FILE_DISPOSITION_INFO = 4

    def __init__(self):
        self.kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self.ntdll = ctypes.WinDLL("ntdll")
        self.CreateFileW = self.kernel32.CreateFileW
        self.CreateFileW.argtypes = [
            wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
            wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
        ]
        self.CreateFileW.restype = wintypes.HANDLE
        self.CloseHandle = self.kernel32.CloseHandle
        self.CloseHandle.argtypes = [wintypes.HANDLE]
        self.CloseHandle.restype = wintypes.BOOL
        self.GetFileInformationByHandle = self.kernel32.GetFileInformationByHandle
        self.GetFileInformationByHandle.argtypes = [
            wintypes.HANDLE, ctypes.POINTER(_WinByHandleInfo),
        ]
        self.GetFileInformationByHandle.restype = wintypes.BOOL
        self.GetFinalPathNameByHandleW = self.kernel32.GetFinalPathNameByHandleW
        self.GetFinalPathNameByHandleW.argtypes = [
            wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD,
        ]
        self.GetFinalPathNameByHandleW.restype = wintypes.DWORD
        self.SetFileInformationByHandle = self.kernel32.SetFileInformationByHandle
        self.SetFileInformationByHandle.argtypes = [
            wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD,
        ]
        self.SetFileInformationByHandle.restype = wintypes.BOOL
        self.SetFilePointerEx = self.kernel32.SetFilePointerEx
        self.SetFilePointerEx.argtypes = [
            wintypes.HANDLE, ctypes.c_longlong,
            ctypes.POINTER(ctypes.c_longlong), wintypes.DWORD,
        ]
        self.SetFilePointerEx.restype = wintypes.BOOL
        self.SetEndOfFile = self.kernel32.SetEndOfFile
        self.SetEndOfFile.argtypes = [wintypes.HANDLE]
        self.SetEndOfFile.restype = wintypes.BOOL
        self.WriteFile = self.kernel32.WriteFile
        self.WriteFile.argtypes = [
            wintypes.HANDLE, wintypes.LPCVOID, wintypes.DWORD,
            ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID,
        ]
        self.WriteFile.restype = wintypes.BOOL
        self.ReadFile = self.kernel32.ReadFile
        self.ReadFile.argtypes = [
            wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD,
            ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID,
        ]
        self.ReadFile.restype = wintypes.BOOL
        self.GetFileSizeEx = self.kernel32.GetFileSizeEx
        self.GetFileSizeEx.argtypes = [
            wintypes.HANDLE, ctypes.POINTER(ctypes.c_longlong),
        ]
        self.GetFileSizeEx.restype = wintypes.BOOL
        self.FlushFileBuffers = self.kernel32.FlushFileBuffers
        self.FlushFileBuffers.argtypes = [wintypes.HANDLE]
        self.FlushFileBuffers.restype = wintypes.BOOL
        self.NtCreateFile = self.ntdll.NtCreateFile
        self.NtCreateFile.argtypes = [
            ctypes.POINTER(wintypes.HANDLE), wintypes.DWORD,
            ctypes.POINTER(_WinObjectAttributes),
            ctypes.POINTER(_WinIoStatusBlock), ctypes.c_void_p,
            wintypes.ULONG, wintypes.ULONG, wintypes.ULONG, wintypes.ULONG,
            ctypes.c_void_p, wintypes.ULONG,
        ]
        self.NtCreateFile.restype = ctypes.c_long
        self.RtlNtStatusToDosError = self.ntdll.RtlNtStatusToDosError
        self.RtlNtStatusToDosError.argtypes = [ctypes.c_long]
        self.RtlNtStatusToDosError.restype = wintypes.ULONG

    @staticmethod
    def _raise_last(label: str) -> None:
        code = ctypes.get_last_error()
        raise OSError(code, f"{label}: {ctypes.FormatError(code)}")

    def close(self, handle: int) -> None:
        if handle and not self.CloseHandle(wintypes.HANDLE(handle)):
            self._raise_last("CloseHandle")

    def open_root(self, path: Path) -> int:
        access = (
            self.FILE_LIST_DIRECTORY | self.FILE_ADD_FILE
            | self.FILE_ADD_SUBDIRECTORY | self.FILE_DELETE_CHILD
            | self.FILE_READ_ATTRIBUTES | self.FILE_WRITE_ATTRIBUTES
            | self.FILE_TRAVERSE | self.SYNCHRONIZE
        )
        handle = self.CreateFileW(
            str(path), access, self.FILE_SHARE_READ | self.FILE_SHARE_WRITE,
            None, self.OPEN_EXISTING,
            self.FILE_FLAG_BACKUP_SEMANTICS | self.FILE_FLAG_OPEN_REPARSE_POINT,
            None,
        )
        invalid = ctypes.c_void_p(-1).value
        value = ctypes.cast(handle, ctypes.c_void_p).value
        if value == invalid or value is None:
            self._raise_last(f"open owned root {path}")
        return int(value)

    def relative_open_contract(
        self, mode: str,
    ) -> _WindowsRelativeOpenContract:
        if mode == "retained_output":
            return _WindowsRelativeOpenContract(
                access=(
                    self.FILE_READ_DATA | self.FILE_WRITE_DATA
                    | self.FILE_READ_ATTRIBUTES | self.FILE_WRITE_ATTRIBUTES
                    | self.SYNCHRONIZE
                ),
                share=self.FILE_SHARE_READ,
                disposition=self.FILE_CREATE,
                options=(
                    self.FILE_NON_DIRECTORY_FILE
                    | self.FILE_SYNCHRONOUS_IO_NONALERT
                    | self.FILE_OPEN_REPARSE_POINT
                ),
                attributes=self.FILE_ATTRIBUTE_NORMAL,
            )
        if mode == "identity_reopen":
            return _WindowsRelativeOpenContract(
                access=self.FILE_READ_ATTRIBUTES | self.SYNCHRONIZE,
                share=self.FILE_SHARE_READ | self.FILE_SHARE_WRITE,
                disposition=self.FILE_OPEN,
                options=(
                    self.FILE_NON_DIRECTORY_FILE
                    | self.FILE_SYNCHRONOUS_IO_NONALERT
                    | self.FILE_OPEN_REPARSE_POINT
                ),
                attributes=self.FILE_ATTRIBUTE_NORMAL,
            )
        if mode == "cleanup_delete_reopen":
            return _WindowsRelativeOpenContract(
                access=self.DELETE | self.FILE_READ_ATTRIBUTES | self.SYNCHRONIZE,
                share=self.FILE_SHARE_READ,
                disposition=self.FILE_OPEN,
                options=(
                    self.FILE_NON_DIRECTORY_FILE
                    | self.FILE_SYNCHRONOUS_IO_NONALERT
                    | self.FILE_OPEN_REPARSE_POINT
                ),
                attributes=self.FILE_ATTRIBUTE_NORMAL,
            )
        if mode == "owned_directory_create":
            return _WindowsRelativeOpenContract(
                access=(
                    self.FILE_LIST_DIRECTORY | self.FILE_ADD_FILE
                    | self.FILE_ADD_SUBDIRECTORY | self.FILE_DELETE_CHILD
                    | self.FILE_READ_ATTRIBUTES | self.FILE_WRITE_ATTRIBUTES
                    | self.FILE_TRAVERSE | self.DELETE | self.SYNCHRONIZE
                ),
                share=self.FILE_SHARE_READ | self.FILE_SHARE_WRITE,
                disposition=self.FILE_CREATE,
                options=(
                    self.FILE_DIRECTORY_FILE | self.FILE_SYNCHRONOUS_IO_NONALERT
                    | self.FILE_OPEN_FOR_BACKUP_INTENT
                    | self.FILE_OPEN_REPARSE_POINT
                ),
                attributes=self.FILE_ATTRIBUTE_DIRECTORY,
            )
        raise ValueError(f"unknown Windows relative-open mode: {mode}")

    def _open_relative(
        self, parent: int, name: str, contract: _WindowsRelativeOpenContract,
    ) -> int:
        _validate_owned_leaf(name)
        name_buffer = ctypes.create_unicode_buffer(name)
        name_bytes = len(name.encode("utf-16-le"))
        unicode_name = _WinUnicodeString(
            name_bytes, name_bytes + ctypes.sizeof(wintypes.WCHAR),
            ctypes.cast(name_buffer, wintypes.LPWSTR),
        )
        attributes = _WinObjectAttributes(
            ctypes.sizeof(_WinObjectAttributes), wintypes.HANDLE(parent),
            ctypes.pointer(unicode_name), self.OBJ_CASE_INSENSITIVE,
            None, None,
        )
        io_status = _WinIoStatusBlock()
        output = wintypes.HANDLE()
        status = self.NtCreateFile(
            ctypes.byref(output), contract.access, ctypes.byref(attributes),
            ctypes.byref(io_status), None, contract.attributes, contract.share,
            contract.disposition, contract.options, None, 0,
        )
        if status < 0:
            code = int(self.RtlNtStatusToDosError(status))
            raise OSError(code, f"NtCreateFile({name}): {ctypes.FormatError(code)}")
        value = ctypes.cast(output, ctypes.c_void_p).value
        if value is None:
            raise OSError(f"NtCreateFile({name}) returned a null handle")
        return int(value)

    def create_owned_directory(self, parent: int, name: str) -> int:
        return self._open_relative(
            parent, name, self.relative_open_contract("owned_directory_create")
        )

    def create_retained_output(self, parent: int, name: str) -> int:
        return self._open_relative(
            parent, name, self.relative_open_contract("retained_output")
        )

    def reopen_output_identity(self, parent: int, name: str) -> int:
        return self._open_relative(
            parent, name, self.relative_open_contract("identity_reopen")
        )

    def reopen_output_cleanup(self, parent: int, name: str) -> int:
        return self._open_relative(
            parent, name,
            self.relative_open_contract("cleanup_delete_reopen"),
        )

    def identity(self, handle: int, *, directory: bool) -> tuple[int, int, int]:
        info = _WinByHandleInfo()
        if not self.GetFileInformationByHandle(
            wintypes.HANDLE(handle), ctypes.byref(info)
        ):
            self._raise_last("GetFileInformationByHandle")
        if info.dwFileAttributes & self.FILE_ATTRIBUTE_REPARSE_POINT:
            raise PackStagingError("owned handle resolves to a reparse point")
        is_directory = bool(info.dwFileAttributes & self.FILE_ATTRIBUTE_DIRECTORY)
        if is_directory != directory:
            raise PackStagingError("owned handle type changed")
        return (
            int(info.dwVolumeSerialNumber),
            (int(info.nFileIndexHigh) << 32) | int(info.nFileIndexLow),
            int(info.dwFileAttributes),
        )

    def final_path(self, handle: int) -> Path:
        size = self.GetFinalPathNameByHandleW(
            wintypes.HANDLE(handle), None, 0, 0
        )
        if not size:
            self._raise_last("GetFinalPathNameByHandleW(size)")
        buffer = ctypes.create_unicode_buffer(size + 1)
        written = self.GetFinalPathNameByHandleW(
            wintypes.HANDLE(handle), buffer, len(buffer), 0
        )
        if not written or written >= len(buffer):
            self._raise_last("GetFinalPathNameByHandleW(path)")
        value = buffer.value
        if value.startswith("\\\\?\\UNC\\"):
            value = "\\\\" + value[8:]
        elif value.startswith("\\\\?\\"):
            value = value[4:]
        return Path(value)

    def read(self, handle: int) -> bytes:
        size = ctypes.c_longlong()
        if not self.GetFileSizeEx(wintypes.HANDLE(handle), ctypes.byref(size)):
            self._raise_last("GetFileSizeEx")
        if not self.SetFilePointerEx(
            wintypes.HANDLE(handle), 0, None, self.FILE_BEGIN
        ):
            self._raise_last("SetFilePointerEx(read)")
        remaining = int(size.value)
        chunks: list[bytes] = []
        while remaining:
            amount = min(remaining, 1024 * 1024)
            buffer = ctypes.create_string_buffer(amount)
            read = wintypes.DWORD()
            if not self.ReadFile(
                wintypes.HANDLE(handle), buffer, amount, ctypes.byref(read), None
            ):
                self._raise_last("ReadFile")
            if read.value == 0:
                raise OSError("ReadFile returned an unexpected EOF")
            chunks.append(buffer.raw[:read.value])
            remaining -= int(read.value)
        return b"".join(chunks)

    def write(self, handle: int, raw: bytes) -> None:
        if not self.SetFilePointerEx(
            wintypes.HANDLE(handle), 0, None, self.FILE_BEGIN
        ):
            self._raise_last("SetFilePointerEx(write)")
        if not self.SetEndOfFile(wintypes.HANDLE(handle)):
            self._raise_last("SetEndOfFile")
        offset = 0
        while offset < len(raw):
            chunk = raw[offset:offset + 1024 * 1024]
            buffer = ctypes.create_string_buffer(chunk)
            written = wintypes.DWORD()
            if not self.WriteFile(
                wintypes.HANDLE(handle), buffer, len(chunk),
                ctypes.byref(written), None,
            ):
                self._raise_last("WriteFile")
            if written.value == 0:
                raise OSError("WriteFile made no progress")
            offset += int(written.value)
        if not self.FlushFileBuffers(wintypes.HANDLE(handle)):
            self._raise_last("FlushFileBuffers")

    def dispose(self, handle: int) -> None:
        info = _WinDispositionInfo(True)
        if not self.SetFileInformationByHandle(
            wintypes.HANDLE(handle), self.FILE_DISPOSITION_INFO,
            ctypes.byref(info), ctypes.sizeof(info),
        ):
            self._raise_last("SetFileInformationByHandle(disposition)")

_WIN_OWNED_API = _WindowsOwnedApi() if os.name == "nt" else None


@dataclass
class _OwnedFileAuthority:
    owner: "_OwnedFilesystem"
    parent: "_OwnedDirectoryAuthority"
    name: str
    path: Path
    handle: int
    identity: tuple[int, int, int]
    closed: bool = False

    def validate(self) -> None:
        if self.closed:
            raise PackStagingError("owned file handle is closed")
        current = self.owner._identity(self.handle, directory=False)
        if current != self.identity:
            raise PackStagingError("owned file handle identity changed")
        self.parent.validate()
        self.owner._validate_file_name(self)

    def read_bytes(self) -> bytes:
        self.validate()
        return self.owner._read(self.handle)

    def write_bytes(self, raw: bytes) -> None:
        self.validate()
        self.owner._write(self.handle, raw)
        self.validate()
        if self.owner._read(self.handle) != raw:
            raise PackStagingError("owned file handle readback mismatch")


@dataclass
class _OwnedDirectoryAuthority:
    owner: "_OwnedFilesystem"
    parent: "_OwnedDirectoryAuthority | None"
    name: str | None
    path: Path
    handle: int
    identity: tuple[int, int, int]
    files: dict[str, _OwnedFileAuthority]
    closed: bool = False

    def validate(self) -> None:
        if self.closed:
            raise PackStagingError("owned directory handle is closed")
        current = self.owner._identity(self.handle, directory=True)
        if current != self.identity:
            raise PackStagingError("owned directory handle identity changed")
        if self.parent is not None:
            self.parent.validate()
            self.owner._validate_directory_name(self)

    def create_file(self, name: str, raw: bytes, kind: str) -> _OwnedFileAuthority:
        return self.owner.create_file(self, name, raw, kind)


class _OwnedFilesystem:
    """Handle-bound, no-follow authority for every owned output and cleanup."""

    POSIX_EXACT_NAMED_STAGING_SUPPORTED = False

    def __init__(
        self, root: Path,
        hook: Callable[[str, Mapping[str, Any]], None] | None,
    ):
        self.hook = hook
        self.windows = os.name == "nt"
        if not self.windows:
            raise PackStagingError(
                "POSIX exact named staging unavailable; no owned output was written"
            )
        self.root = self._open_root(Path(root))
        self.children: list[_OwnedDirectoryAuthority] = []

    def _fire(self, event: str, **context: Any) -> None:
        if self.hook is not None:
            self.hook(event, context)

    def _open_root(self, path: Path) -> _OwnedDirectoryAuthority:
        if self.windows:
            assert _WIN_OWNED_API is not None
            handle = _WIN_OWNED_API.open_root(path)
        else:
            flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) \
                | getattr(os, "O_NOFOLLOW", 0)
            handle = os.open(path, flags)
        try:
            identity = self._identity(handle, directory=True)
            if self.windows:
                assert _WIN_OWNED_API is not None
                opened_path = _WIN_OWNED_API.final_path(handle)
                if os.path.normcase(str(opened_path.resolve())) != os.path.normcase(
                    str(path.resolve())
                ):
                    raise PackStagingError(
                        "owned root handle resolved to a different final path"
                    )
            elif (Path("/proc/self/fd").exists()
                  and not os.path.samefile(path, f"/proc/self/fd/{handle}")):
                raise PackStagingError(
                    "owned POSIX root handle resolved to a different object"
                )
        except Exception:
            if self.windows:
                assert _WIN_OWNED_API is not None
                _WIN_OWNED_API.close(handle)
            else:
                os.close(handle)
            raise
        return _OwnedDirectoryAuthority(
            self, None, None, path, handle, identity, {}, False
        )

    def _identity(self, handle: int, *, directory: bool) -> tuple[int, int, int]:
        if self.windows:
            assert _WIN_OWNED_API is not None
            return _WIN_OWNED_API.identity(handle, directory=directory)
        stat_result = os.fstat(handle)
        is_directory = (stat_result.st_mode & 0o170000) == 0o040000
        if is_directory != directory:
            raise PackStagingError("owned POSIX handle type changed")
        return (stat_result.st_dev, stat_result.st_ino, stat_result.st_mode)

    def _validate_directory_name(
        self, directory: _OwnedDirectoryAuthority,
    ) -> None:
        if self.windows:
            # Windows directory handles deliberately deny FILE_SHARE_DELETE, so
            # their parent/name association cannot change while retained.
            return
        assert directory.parent is not None
        assert directory.name is not None
        stat_result = os.stat(
            directory.name,
            dir_fd=directory.parent.handle,
            follow_symlinks=False,
        )
        identity = (stat_result.st_dev, stat_result.st_ino, stat_result.st_mode)
        if identity != directory.identity:
            raise PackStagingError(
                "owned POSIX directory name no longer identifies retained handle"
            )

    def _validate_file_name(self, owned: _OwnedFileAuthority) -> None:
        if self.windows:
            assert _WIN_OWNED_API is not None
            reopened = _WIN_OWNED_API.reopen_output_identity(
                owned.parent.handle, owned.name
            )
            try:
                identity = _WIN_OWNED_API.identity(reopened, directory=False)
            finally:
                _WIN_OWNED_API.close(reopened)
        else:
            stat_result = os.stat(
                owned.name,
                dir_fd=owned.parent.handle,
                follow_symlinks=False,
            )
            identity = (
                stat_result.st_dev,
                stat_result.st_ino,
                stat_result.st_mode,
            )
        if identity != owned.identity:
            raise PackStagingError(
                "owned output name no longer identifies retained file handle"
            )

    def create_directory(self, name: str) -> _OwnedDirectoryAuthority:
        name = _validate_owned_leaf(name)
        self.root.validate()
        if self.windows:
            assert _WIN_OWNED_API is not None
            handle = _WIN_OWNED_API.create_owned_directory(
                self.root.handle, name
            )
        else:
            raise PackStagingError(
                "POSIX exact named staging unavailable; directory not created"
            )
        try:
            identity = self._identity(handle, directory=True)
        except Exception:
            self._close_handle(handle)
            raise
        child = _OwnedDirectoryAuthority(
            self, self.root, name, self.root.path / name, handle,
            identity, {}, False,
        )
        self.children.append(child)
        return child

    def create_file(
        self, parent: _OwnedDirectoryAuthority, name: str, raw: bytes, kind: str,
    ) -> _OwnedFileAuthority:
        name = _validate_owned_leaf(name)
        parent.validate()
        path = parent.path / name
        self._fire("before_output_open", kind=kind, path=path)
        parent.validate()
        if self.windows:
            assert _WIN_OWNED_API is not None
            handle = _WIN_OWNED_API.create_retained_output(
                parent.handle, name
            )
        else:
            raise PackStagingError(
                "POSIX exact named staging unavailable; output not opened"
            )
        try:
            identity = self._identity(handle, directory=False)
        except Exception:
            self._close_handle(handle)
            raise
        owned = _OwnedFileAuthority(
            self, parent, name, path, handle,
            identity, False,
        )
        parent.files[name] = owned
        owned.write_bytes(raw)
        self._fire(
            "before_output_verify", kind=kind, path=path, authority=owned
        )
        owned.validate()
        observed = owned.read_bytes()
        if (len(observed) != len(raw)
                or hashlib.sha256(observed).digest() != hashlib.sha256(raw).digest()):
            raise PackStagingError("owned output hash/readback mismatch")
        return owned

    def _read(self, handle: int) -> bytes:
        if self.windows:
            assert _WIN_OWNED_API is not None
            return _WIN_OWNED_API.read(handle)
        os.lseek(handle, 0, os.SEEK_SET)
        chunks: list[bytes] = []
        while True:
            chunk = os.read(handle, 1024 * 1024)
            if not chunk:
                return b"".join(chunks)
            chunks.append(chunk)

    def _write(self, handle: int, raw: bytes) -> None:
        if self.windows:
            assert _WIN_OWNED_API is not None
            _WIN_OWNED_API.write(handle, raw)
            return
        os.lseek(handle, 0, os.SEEK_SET)
        os.ftruncate(handle, 0)
        view = memoryview(raw)
        while view:
            written = os.write(handle, view)
            if written <= 0:
                raise OSError("owned POSIX write made no progress")
            view = view[written:]
        os.fsync(handle)

    def _close_handle(self, handle: int) -> None:
        if self.windows:
            assert _WIN_OWNED_API is not None
            _WIN_OWNED_API.close(handle)
        else:
            os.close(handle)

    def _close_file(self, owned: _OwnedFileAuthority) -> None:
        if not owned.closed:
            self._close_handle(owned.handle)
            owned.closed = True

    def _close_directory(self, directory: _OwnedDirectoryAuthority) -> None:
        if not directory.closed:
            self._close_handle(directory.handle)
            directory.closed = True

    def delete_directory(
        self, directory: _OwnedDirectoryAuthority, kind: str,
    ) -> None:
        if not self.windows:
            self._fire("before_cleanup_delete", kind=kind, path=directory.path)
            self.abandon()
            raise PackStagingError(
                "exact POSIX cleanup unavailable; owned orphan retained"
            )
        directory.validate()
        self._fire("before_cleanup_delete", kind=kind, path=directory.path)
        directory.validate()
        names = {entry.name for entry in os.scandir(directory.path)}
        if names != set(directory.files):
            raise PackStagingError(
                "owned directory contains untracked entries; preserving orphan"
            )
        for name in sorted(directory.files):
            owned = directory.files[name]
            owned.validate()
            assert _WIN_OWNED_API is not None
            self._close_file(owned)
            delete_handle = _WIN_OWNED_API.reopen_output_cleanup(
                directory.handle, name,
            )
            try:
                if _WIN_OWNED_API.identity(
                    delete_handle, directory=False
                ) != owned.identity:
                    raise PackStagingError(
                        "owned output name changed before exact handle deletion"
                    )
                _WIN_OWNED_API.dispose(delete_handle)
            finally:
                _WIN_OWNED_API.close(delete_handle)
        directory.validate()
        assert _WIN_OWNED_API is not None
        _WIN_OWNED_API.dispose(directory.handle)
        self._close_directory(directory)
        self._close_directory(self.root)

    def abandon(self) -> None:
        for directory in self.children:
            for owned in directory.files.values():
                try:
                    self._close_file(owned)
                except OSError:
                    pass
            try:
                self._close_directory(directory)
            except OSError:
                pass
        try:
            self._close_directory(self.root)
        except OSError:
            pass


class PackTransaction:
    """Build a read-only plan and materialize it only in an owned staging child."""

    def __init__(
        self,
        package_dir: Path,
        manifest: dict,
        *,
        live_roots: LiveRoots,
        release_base_provider: ReleaseBaseProvider,
        codec_registry: Mapping[str, TableCodec] | None = None,
        installed_manifest: dict | None = None,
        installed_package_dir: Path | None = None,
        available_capabilities: Iterable[str] = (),
        degraded_data_confirmed: bool = False,
        snapshot_roots: Iterable[Path] = (),
        filesystem_boundary_hook: Callable[[str, Mapping[str, Any]], None] | None = None,
    ):
        self.package_dir = Path(package_dir)
        try:
            self._manifest_bytes = canonical_manifest_bytes(manifest)
            self._installed_manifest_bytes = (
                canonical_manifest_bytes(installed_manifest)
                if installed_manifest is not None else None
            )
        except Exception as exc:
            raise PackPreflightError(f"manifest cannot be canonical-copied: {exc}") from exc
        self.live_roots = LiveRoots(
            Path(live_roots.common), Path(live_roots.medium),
            Path(live_roots.android), Path(live_roots.server),
            tuple(Path(path) for path in live_roots.protected),
        )
        self.release_base_provider = release_base_provider
        self.codecs = dict(DEFAULT_CODECS)
        if codec_registry:
            self.codecs.update(codec_registry)
        self.installed_package_dir = (
            Path(installed_package_dir) if installed_package_dir is not None else None
        )
        self.available_capabilities = frozenset(available_capabilities)
        self.degraded_data_confirmed = bool(degraded_data_confirmed)
        self.snapshot_roots = tuple(Path(path) for path in snapshot_roots)
        self._filesystem_boundary_hook = filesystem_boundary_hook
        self._analysis: _Analysis | None = None
        self._transactions: dict[str, _TransactionAuthority] = {}
        self._latest_transaction_id: str | None = None
        self._snapshot_authorities: list[
            tuple[_OwnedFilesystem, _OwnedDirectoryAuthority]
        ] = []

    def __del__(self):
        for authority in getattr(self, "_transactions", {}).values():
            if authority.lifecycle not in {"discarded", "orphaned"}:
                try:
                    authority.owned_fs.abandon()
                except Exception:
                    pass
        for snapshot_fs, _ in getattr(self, "_snapshot_authorities", ()):
            try:
                snapshot_fs.abandon()
            except Exception:
                pass

    @property
    def manifest(self) -> dict:
        return json.loads(self._manifest_bytes.decode("utf-8"))

    @property
    def installed_manifest(self) -> dict | None:
        if self._installed_manifest_bytes is None:
            return None
        return json.loads(self._installed_manifest_bytes.decode("utf-8"))

    def _root_path(self, root: RootName) -> Path:
        return getattr(self.live_roots, root)

    def _live_path(self, root: RootName, logical_path: str) -> Path:
        if root == "server":
            return self.live_roots.server / Path(*logical_path.split("/"))
        return core.table_path(self._root_path(root), logical_path)

    def _source_path(self, package_dir: Path, root: RootName,
                     logical_path: str) -> Path:
        return package_dir / "roots" / root / Path(*logical_path.split("/"))

    @staticmethod
    def _entries(manifest: dict) -> dict[tuple[RootName, str], dict]:
        return {
            (root, entry["logical_path"]): entry
            for root in ROOT_NAMES for entry in manifest["roots"][root]
        }

    def _validate_inputs(self) -> tuple[
            ReleaseBaseState, dict[str, TableClaim], dict[str, TableClaim]]:
        named_live = {
            "common": self.live_roots.common,
            "medium": self.live_roots.medium,
            "android": self.live_roots.android,
            "server": self.live_roots.server,
        }
        names = tuple(named_live)
        for index, name in enumerate(names):
            path = Path(named_live[name])
            if _overlaps(path, self.package_dir):
                raise PackPreflightError(
                    f"live {name} root overlaps candidate package directory"
                )
            for other_name in names[index + 1:]:
                if _overlaps(path, Path(named_live[other_name])):
                    raise PackPreflightError(
                        f"live roots must be independent: {name} overlaps {other_name}"
                    )
            for protected in self.live_roots.protected:
                if _overlaps(path, Path(protected)):
                    raise PackPreflightError(
                        f"live {name} root overlaps active/CDN protected root"
                    )
        errors = validate_manifest(
            self.manifest,
            self.package_dir,
            require_referenced_assets=True,
        )
        if errors:
            raise PackPreflightError("candidate manifest invalid: " + "; ".join(errors))
        candidate_claims = _parse_transaction_claims(self.manifest)
        installed_claims: dict[TableKey, TableClaim] = {}
        if self.installed_manifest is not None:
            if self.installed_package_dir is None:
                raise PackPreflightError(
                    "installed manifest requires its package directory for validation"
                )
            installed_errors = validate_manifest(
                self.installed_manifest, self.installed_package_dir
            )
            if installed_errors:
                raise PackPreflightError(
                    "installed manifest invalid: " + "; ".join(installed_errors)
                )
            installed_claims = _parse_transaction_claims(self.installed_manifest)

        def validate_server_contract(
            manifest: dict, claims: dict[TableKey, TableClaim], label: str,
        ) -> None:
            server_paths = tuple(
                entry["logical_path"] for entry in manifest["roots"]["server"]
            )
            expected = set(SERVER_LOGICAL_PATHS)
            if set(server_paths) != expected or len(server_paths) != len(expected):
                raise PackPreflightError(
                    f"{label} server root must contain exactly "
                    + ", ".join(SERVER_LOGICAL_PATHS)
                )
            server_claims = {
                logical_path for root, logical_path in claims if root == "server"
            }
            if server_claims != expected:
                raise PackPreflightError(
                    f"{label} server tables must claim exactly "
                    + ", ".join(SERVER_LOGICAL_PATHS)
                )

        validate_server_contract(self.manifest, candidate_claims, "candidate")
        if self.installed_manifest is not None:
            validate_server_contract(
                self.installed_manifest, installed_claims, "installed"
            )
        candidate_entries = self._entries(self.manifest)
        for (root, logical_path), claim in candidate_claims.items():
            if claim.codec_id not in self.codecs:
                raise PackPreflightError(
                    f"unknown table codec {claim.codec_id!r} for {root}:{logical_path}"
                )
            if (root, logical_path) not in candidate_entries:
                raise PackPreflightError(
                    f"table claim {root}:{logical_path} has no storage-ready payload"
                )

        state = _validate_release_base(self.release_base_provider)
        candidate_package_id = self.manifest["package_id"]
        if candidate_package_id.endswith(ROLLBACK_PACKAGE_SUFFIX):
            raise PackPreflightError(
                "candidate package_id must not use the reserved -rollback suffix"
            )
        if state.package_owners is None:
            # 旧 provider（无 owners 信息）：保持链尾单一所有者语义。
            owner_hash = state.active_package_manifest_sha256
        else:
            owner_hash = dict(state.package_owners).get(candidate_package_id)
        if self.installed_manifest is not None:
            installed_hash = hashlib.sha256(
                canonical_manifest_bytes(self.installed_manifest)
            ).hexdigest()
            if owner_hash != installed_hash:
                raise PackPreflightError(
                    "installed ownership manifest is not hash-bound to active state"
                )
            if self.installed_manifest["package_id"] != candidate_package_id:
                raise PackPreflightError(
                    "installed ownership belongs to a different package_id"
                )
        elif owner_hash is not None:
            raise PackPreflightError(
                "active ownership hash exists but installed manifest was not supplied"
            )
        return state, candidate_claims, installed_claims

    def _inspect_tables(
        self,
        candidate_claims: dict[TableKey, TableClaim],
        installed_claims: dict[TableKey, TableClaim],
    ) -> tuple[
        dict[TableKey, TableImage], dict[TableKey, TableImage], list[dict], list[dict]
    ]:
        candidate_entries = self._entries(self.manifest)
        candidate_images: dict[TableKey, TableImage] = {}
        live_images: dict[TableKey, TableImage] = {}
        conflicts: list[dict] = []
        changes: list[dict] = []
        for table_key in sorted(set(candidate_claims) | set(installed_claims)):
            root, logical_path = table_key
            candidate_claim = candidate_claims.get(table_key)
            installed_claim = installed_claims.get(table_key)
            claim = candidate_claim or installed_claim
            assert claim is not None
            if candidate_claim is None:
                raise PackPreflightError(
                    f"deleted table {logical_path} still requires an empty candidate claim/payload"
                )
            if installed_claim is not None and installed_claim.codec_id != claim.codec_id:
                raise PackPreflightError(f"codec changed across upgrade for {logical_path}")
            inspection_claim = _merge_inspection_claims(
                candidate_claim, installed_claim
            )
            codec = self.codecs.get(claim.codec_id)
            if codec is None:
                raise PackPreflightError(f"unknown table codec {claim.codec_id!r}")
            entry = candidate_entries.get(table_key)
            if entry is None:
                raise PackPreflightError(f"missing candidate table payload {logical_path}")
            candidate_raw = self._source_path(
                self.package_dir, root, logical_path
            ).read_bytes()
            live_raw = _read_bytes_or_none(self._live_path(root, logical_path))
            try:
                candidate_image = codec.inspect(
                    candidate_raw, inspection_claim, inspection_claim.semantic_claims
                )
                live_image = (
                    codec.inspect(live_raw, inspection_claim, inspection_claim.semantic_claims)
                    if live_raw is not None else TableImage(())
                )
            except PackPreflightError:
                raise
            except Exception as exc:
                raise PackPreflightError(
                    f"codec {claim.codec_id} rejected {logical_path}: {exc}"
                ) from exc
            candidate_images[table_key] = candidate_image
            live_images[table_key] = live_image
            candidate_outer, candidate_inner, candidate_semantics = _dict_rows(candidate_image)
            live_outer, live_inner, live_semantics = _dict_rows(live_image)

            installed_outer = set(installed_claim.outer_keys) if installed_claim else set()
            installed_inner = {
                (outer, key) for outer, keys in (installed_claim.inner_keys if installed_claim else ())
                for key in keys
            }
            installed_semantics = {
                (item.namespace, item.value)
                for item in (installed_claim.semantic_claims if installed_claim else ())
            }
            candidate_outer_claims = set(candidate_claim.outer_keys)
            candidate_inner_claims = {
                (outer, key) for outer, keys in candidate_claim.inner_keys for key in keys
            }
            candidate_semantic_claims = {
                (item.namespace, item.value) for item in candidate_claim.semantic_claims
            }
            for key in sorted(installed_outer - candidate_outer_claims):
                if key in candidate_outer:
                    raise PackPreflightError(
                        f"omitted prior outer claim remains in candidate payload: "
                        f"{logical_path}:{key}"
                    )
            for outer_key, inner_key in sorted(installed_inner - candidate_inner_claims):
                if (outer_key, inner_key) in candidate_inner:
                    raise PackPreflightError(
                        f"omitted prior inner claim remains in candidate payload: "
                        f"{logical_path}:{outer_key}/{inner_key}"
                    )
            for namespace, value in sorted(installed_semantics - candidate_semantic_claims):
                if (namespace, value) in candidate_semantics:
                    raise PackPreflightError(
                        f"omitted prior semantic claim remains occupied in candidate payload: "
                        f"{namespace}:{value}"
                    )
            for key in sorted(candidate_outer_claims):
                if key not in candidate_outer:
                    raise PackPreflightError(
                        f"candidate codec evidence lacks outer claim {logical_path}:{key}"
                    )
                if key in live_outer and key not in installed_outer:
                    conflicts.append({
                        "kind": "outer_key", "claim": f"{logical_path}:{key}",
                        "reason": "occupied_without_hash_bound_prior_ownership",
                    })
            for outer_key, inner_key in sorted(candidate_inner_claims):
                if (outer_key, inner_key) not in candidate_inner:
                    raise PackPreflightError(
                        f"candidate codec evidence lacks inner claim "
                        f"{logical_path}:{outer_key}/{inner_key}"
                    )
                if (outer_key, inner_key) in live_inner \
                        and (outer_key, inner_key) not in installed_inner:
                    conflicts.append({
                        "kind": "inner_key",
                        "claim": f"{logical_path}:{outer_key}/{inner_key}",
                        "reason": "occupied_without_hash_bound_prior_ownership",
                    })
            for namespace, value in sorted(candidate_semantic_claims):
                if (namespace, value) not in candidate_semantics:
                    raise PackPreflightError(
                        f"candidate codec evidence lacks semantic claim {namespace}:{value}"
                    )
                if (namespace, value) in live_semantics \
                        and (namespace, value) not in installed_semantics:
                    conflicts.append({
                        "kind": "semantic", "claim": f"{namespace}:{value}",
                        "reason": "occupied_without_hash_bound_prior_ownership",
                    })

            allowed_outer = candidate_outer_claims | installed_outer
            for key in sorted(set(candidate_outer) | set(live_outer)):
                if candidate_outer.get(key) != live_outer.get(key) and key not in allowed_outer:
                    conflicts.append({
                        "kind": "unclaimed_change", "claim": f"{logical_path}:{key}",
                        "reason": "full-table payload changes an undeclared outer key",
                    })
            allowed_inner = candidate_inner_claims | installed_inner
            for marker in sorted(set(candidate_inner) | set(live_inner)):
                if candidate_inner.get(marker) != live_inner.get(marker) \
                        and marker not in allowed_inner:
                    conflicts.append({
                        "kind": "unclaimed_change",
                        "claim": f"{logical_path}:{marker[0]}/{marker[1]}",
                        "reason": "full-table payload changes an undeclared inner key",
                    })
            allowed_semantics = candidate_semantic_claims | installed_semantics
            for marker in sorted(candidate_semantics ^ live_semantics):
                if marker not in allowed_semantics:
                    conflicts.append({
                        "kind": "unclaimed_change",
                        "claim": f"{marker[0]}:{marker[1]}",
                        "reason": "full-table payload changes an undeclared semantic value",
                    })

            for key in sorted(allowed_outer):
                before = live_outer.get(key)
                after = candidate_outer.get(key)
                changes.append({
                    "root": root,
                    "logical_path": logical_path,
                    "kind": "outer",
                    "outer_key": key,
                    "inner_key": None,
                    "before": _expectation(before),
                    "after": _expectation(after),
                    "operation": "create" if before is None and after is not None
                    else "delete" if before is not None and after is None else "update",
                })
            for outer_key, inner_key in sorted(allowed_inner):
                before = live_inner.get((outer_key, inner_key))
                after = candidate_inner.get((outer_key, inner_key))
                changes.append({
                    "root": root,
                    "logical_path": logical_path,
                    "kind": "inner",
                    "outer_key": outer_key,
                    "inner_key": inner_key,
                    "before": _expectation(before),
                    "after": _expectation(after),
                    "operation": "create" if before is None and after is not None
                    else "delete" if before is not None and after is None else "update",
                })
            for namespace, value in sorted(allowed_semantics):
                before_occupied = (namespace, value) in live_semantics
                after_declared = (namespace, value) in candidate_semantics
                changes.append({
                    "root": root,
                    "logical_path": logical_path,
                    "kind": "semantic",
                    "namespace": namespace,
                    "value": value,
                    "outer_key": None,
                    "inner_key": None,
                    "before": {"occupied": before_occupied},
                    "after": {"declared": after_declared},
                    "evidence_kind": "codec_semantic_occupancy",
                    "operation": "create" if not before_occupied and after_declared
                    else "delete" if before_occupied and not after_declared else "update",
                })
        return candidate_images, live_images, conflicts, changes

    def _file_changes(
        self, table_keys: set[TableKey]
    ) -> tuple[tuple[dict, ...], dict[str, dict[str, int]]]:
        candidate = self._entries(self.manifest)
        installed = self._entries(self.installed_manifest) \
            if self.installed_manifest is not None else {}
        changes: list[dict] = []
        for root, logical_path in sorted(set(candidate) | set(installed)):
            entry = candidate.get((root, logical_path))
            live_path = self._live_path(root, logical_path)
            live_raw = _read_bytes_or_none(live_path)
            if entry is None:
                after_sha = None
                after_size = None
                source_path = None
                operation = "delete"
            else:
                after_sha = entry["sha256"]
                after_size = entry["size"]
                source_path = str(self._source_path(self.package_dir, root, logical_path))
                before_sha = hashlib.sha256(live_raw).hexdigest() if live_raw is not None else None
                operation = "create" if live_raw is None else (
                    "unchanged" if before_sha == after_sha else "update"
                )
            changes.append({
                "root": root,
                "logical_path": logical_path,
                "live_path": str(live_path),
                "source_path": source_path,
                "before": _expectation(live_raw),
                "after_sha256": after_sha,
                "after_size": after_size,
                "operation": operation,
                "is_table": (root, logical_path) in table_keys,
            })
        totals: dict[str, dict[str, int]] = {}
        for root in ROOT_NAMES:
            entries = self.manifest["roots"][root]
            totals[root] = {
                "files": len(entries),
                "bytes": sum(entry["size"] for entry in entries),
            }
        return _record_sort(changes), totals

    def preflight(self) -> PreflightReport:
        state, candidate_claims, installed_claims = self._validate_inputs()
        candidate_images, live_images, conflicts, table_changes = self._inspect_tables(
            candidate_claims, installed_claims
        )
        file_changes, totals = self._file_changes(set(candidate_claims))
        installed_entries = (
            self._entries(self.installed_manifest)
            if self.installed_manifest is not None else {}
        )
        for item in file_changes:
            ownership_key = (item["root"], item["logical_path"])
            if (item["root"] in CLIENT_ROOTS
                    and not item["is_table"]
                    and item["source_path"] is not None
                    and item["before"]["exists"]
                    and ownership_key not in installed_entries):
                conflicts.append({
                    "kind": "asset_path",
                    "claim": f"{item['root']}:{item['logical_path']}",
                    "reason": "occupied_without_hash_bound_prior_path_ownership",
                })
        table_file_before = {
            (item["root"], item["logical_path"]): item["before"]
            for item in file_changes if item["is_table"]
        }
        for item in table_changes:
            if item["kind"] == "semantic":
                item["source_table_before"] = table_file_before[
                    (item["root"], item["logical_path"])
                ]

        creates: list[dict] = []
        updates: list[dict] = []
        deletes: list[dict] = []
        candidate_tokens: set[tuple[str, str]] = set()
        installed_tokens: set[tuple[str, str]] = set()
        for (root, path), claim in candidate_claims.items():
            prefix = f"{root}:{path}"
            candidate_tokens.update(("outer", f"{prefix}:{key}") for key in claim.outer_keys)
            candidate_tokens.update(
                ("inner", f"{prefix}:{outer}/{key}")
                for outer, keys in claim.inner_keys for key in keys
            )
            candidate_tokens.update(
                ("semantic", f"{item.namespace}:{item.value}")
                for item in claim.semantic_claims
            )
        for (root, path), claim in installed_claims.items():
            prefix = f"{root}:{path}"
            installed_tokens.update(("outer", f"{prefix}:{key}") for key in claim.outer_keys)
            installed_tokens.update(
                ("inner", f"{prefix}:{outer}/{key}")
                for outer, keys in claim.inner_keys for key in keys
            )
            installed_tokens.update(
                ("semantic", f"{item.namespace}:{item.value}")
                for item in claim.semantic_claims
            )
        for kind, claim in sorted(candidate_tokens - installed_tokens):
            creates.append({"kind": kind, "claim": claim})
        for kind, claim in sorted(candidate_tokens & installed_tokens):
            updates.append({"kind": kind, "claim": claim})
        for kind, claim in sorted(installed_tokens - candidate_tokens):
            deletes.append({"kind": kind, "claim": claim, "intent": "forward_release"})
        for item in file_changes:
            target = {
                "kind": "file", "claim": f"{item['root']}:{item['logical_path']}"
            }
            if item["operation"] == "create":
                creates.append(target)
            elif item["operation"] == "delete":
                deletes.append({**target, "intent": "forward_release"})
            elif item["operation"] == "update":
                updates.append(target)

        capability_warnings: list[dict] = []
        has_base = self.manifest["requires_client_base"] in self.available_capabilities
        if not has_base:
            capability_warnings.append({
                "capability": self.manifest["requires_client_base"],
                "message": (
                    "dual_form_v1 unavailable: human/dragon native skills and matched voice "
                    "remain available; pixel/cut-in matched visuals are unavailable and stay "
                    "human; cross-zone Unique persistence is not guaranteed; this is degraded "
                    "data-only and never full dual-form delivery"
                ),
            })
        can_prepare = not conflicts and (has_base or self.degraded_data_confirmed)
        delivery = "full_dual_form" if has_base else "degraded_data_only"
        live_hashes = {
            item["live_path"]: item["before"] for item in file_changes
        }
        report = PreflightReport(
            package_id=self.manifest["package_id"],
            package_version=self.manifest["package_version"],
            installed_version=(
                self.installed_manifest["package_version"]
                if self.installed_manifest is not None else None
            ),
            version_diff=_freeze(_version_diff(
                self.installed_manifest["package_version"]
                if self.installed_manifest is not None else None,
                self.manifest["package_version"],
            )),
            creates=_record_sort(creates),
            updates=_record_sort(updates),
            deletes=_record_sort(deletes),
            conflicts=_record_sort(conflicts),
            root_totals=_freeze(totals),
            expected_base_hashes=_freeze({
                "active_sha256": state.active_sha256,
                "current_release_id": state.current_release_id,
                "validated_chain_tail": state.validated_chain_tail,
                "expected_from_version": state.expected_from_version,
                "live": dict(sorted(live_hashes.items())),
            }),
            capability_warnings=_record_sort(capability_warnings),
            can_prepare=can_prepare,
            delivery_status=delivery,
        )
        self._analysis = _Analysis(
            report, state, candidate_claims, installed_claims,
            candidate_images, live_images, _record_sort(table_changes), file_changes,
        )
        return report

    def _protected_for_staging(self) -> tuple[Path, ...]:
        return (
            self.package_dir,
            self.live_roots.common,
            self.live_roots.medium,
            self.live_roots.android,
            self.live_roots.server,
            *self.live_roots.protected,
            *self.snapshot_roots,
        )

    def _validate_isolated_root(self, root: Path, protected: Iterable[Path],
                                label: str) -> Path:
        original = Path(root)
        if _has_link_or_junction_component(original):
            raise PackPreflightError(
                f"{label} must not traverse a symlink or junction"
            )
        try:
            resolved = original.resolve()
        except (OSError, RuntimeError) as exc:
            raise PackPreflightError(f"cannot resolve {label}: {exc}") from exc
        for path in protected:
            if _overlaps(resolved, Path(path)):
                raise PackPreflightError(
                    f"{label} overlaps protected path {Path(path).resolve()}"
                )
        try:
            resolved.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise PackPreflightError(f"cannot create {label}: {exc}") from exc
        if _is_link_or_junction(resolved):
            raise PackPreflightError(f"{label} must not be a symlink or junction")
        return resolved

    @staticmethod
    def _release_metadata(state: ReleaseBaseState) -> dict[str, Any]:
        return {
            "active_raw_base64": (
                base64.b64encode(state.active_raw).decode("ascii")
                if state.active_raw is not None else None
            ),
            "active_sha256": state.active_sha256,
            "current_release_id": state.current_release_id,
            "validated_chain_tail": state.validated_chain_tail,
            "expected_from_version": state.expected_from_version,
            "active_package_manifest_sha256": state.active_package_manifest_sha256,
            "package_owners": (
                [list(pair) for pair in state.package_owners]
                if state.package_owners is not None else None
            ),
        }

    def prepare(self, staging_root: Path) -> PreparedPack:
        report = self.preflight()
        if not report.can_prepare:
            raise PackPreflightError(
                "package cannot prepare: conflicts or unconfirmed degraded delivery"
            )
        assert self._analysis is not None
        root = self._validate_isolated_root(
            Path(staging_root), self._protected_for_staging(), "staging root"
        )
        transaction_id = uuid.uuid4().hex
        previous_latest_transaction_id = self._latest_transaction_id
        marker_nonce = uuid.uuid4().hex
        child_name = f"character-pack-{transaction_id}"
        child = root / child_name
        package_manifest_sha256 = hashlib.sha256(self._manifest_bytes).hexdigest()
        owned_fs: _OwnedFilesystem | None = None
        owned_dir: _OwnedDirectoryAuthority | None = None
        try:
            owned_fs = _OwnedFilesystem(root, self._filesystem_boundary_hook)
            owned_dir = owned_fs.create_directory(child_name)
            provisional = PreparedPack(
                transaction_id=transaction_id,
                staging_root=root,
                transaction_dir=child,
                marker_nonce=marker_nonce,
                prepared_digest="",
                package_manifest_sha256=package_manifest_sha256,
                release_base=self._analysis.release_base,
                table_key_changes=self._analysis.table_key_changes,
                file_changes=self._analysis.file_changes,
                degraded_data_confirmed=self.degraded_data_confirmed,
            )
            prepared = replace(
                provisional,
                prepared_digest=_prepared_digest_value(provisional),
            )
            marker = {
                "kind": "character_pack_transaction",
                "transaction_id": transaction_id,
                "marker_nonce": marker_nonce,
                "prepared_digest": prepared.prepared_digest,
            }
            marker_bytes = _canonical_json_bytes(marker)
            marker_file = owned_dir.create_file(
                TRANSACTION_MARKER, marker_bytes, "prepare_marker"
            )
            metadata = {
                "transaction_id": transaction_id,
                "marker_nonce": marker_nonce,
                "prepared_digest": prepared.prepared_digest,
                "package_manifest_sha256": package_manifest_sha256,
                "release_base": self._release_metadata(self._analysis.release_base),
                "table_key_changes": _plain(self._analysis.table_key_changes),
                "file_changes": _plain(self._analysis.file_changes),
                "degraded_data_confirmed": self.degraded_data_confirmed,
            }
            owned_dir.create_file(
                "prepared.json", _canonical_json_bytes(metadata), "prepare_metadata"
            )
            authority = _TransactionAuthority(
                transaction_id=transaction_id,
                root=root,
                transaction_dir=child,
                root_identity=owned_fs.root.identity,
                dir_identity=owned_dir.identity,
                marker_nonce=marker_nonce,
                marker_digest=hashlib.sha256(marker_bytes).hexdigest(),
                prepared_digest=prepared.prepared_digest,
                prepared=prepared,
                analysis=self._analysis,
                owned_fs=owned_fs,
                owned_dir=owned_dir,
                marker_file=marker_file,
            )
            self._transactions[transaction_id] = authority
            self._latest_transaction_id = transaction_id
            self._validate_authority(authority)
        except Exception as exc:
            self._transactions.pop(transaction_id, None)
            if self._latest_transaction_id == transaction_id:
                self._latest_transaction_id = previous_latest_transaction_id
            cleanup_error: Exception | None = None
            if owned_fs is not None and owned_dir is not None:
                try:
                    owned_fs.delete_directory(owned_dir, "prepare_cleanup")
                except Exception as cleanup_exc:
                    cleanup_error = cleanup_exc
                    owned_fs.abandon()
            elif owned_fs is not None:
                owned_fs.abandon()
            detail = f"cannot create prepared transaction: {exc}"
            if cleanup_error is not None:
                detail += f"; exact owned cleanup preserved orphan: {cleanup_error}"
            raise PackPreflightError(detail) from exc
        return prepared

    def _validate_authority(self, authority: _TransactionAuthority) -> None:
        if authority.lifecycle in {"discarded", "orphaned"}:
            raise PackStagingError("transaction authority is tombstoned")
        authority.owned_dir.validate()
        if authority.owned_fs.root.identity != authority.root_identity \
                or authority.owned_dir.identity != authority.dir_identity:
            raise PackStagingError("retained transaction handle identity changed")
        try:
            marker_bytes = authority.marker_file.read_bytes()
            marker = json.loads(marker_bytes.decode("utf-8"))
        except Exception as exc:
            raise PackStagingError(f"transaction marker is unreadable: {exc}") from exc
        if hashlib.sha256(marker_bytes).hexdigest() != authority.marker_digest:
            raise PackStagingError("transaction marker digest changed")
        if marker != {
            "kind": "character_pack_transaction",
            "transaction_id": authority.transaction_id,
            "marker_nonce": authority.marker_nonce,
            "prepared_digest": authority.prepared_digest,
        }:
            raise PackStagingError("transaction marker does not match authority")
        if (_prepared_digest_value(authority.prepared) != authority.prepared_digest
                or authority.prepared.prepared_digest != authority.prepared_digest):
            raise PackStagingError("prepared authority digest changed")

    def _authority_for_prepared(self, prepared: PreparedPack) -> _TransactionAuthority:
        authority = self._transactions.get(prepared.transaction_id)
        if authority is None or prepared is not authority.prepared:
            raise PackStagingError("prepared record is not the emitted owned authority")
        self._validate_authority(authority)
        return authority

    def _remove_owned(self, authority: _TransactionAuthority) -> None:
        self._validate_authority(authority)
        try:
            authority.owned_fs.delete_directory(
                authority.owned_dir, "materialization_cleanup"
            )
        except Exception:
            authority.lifecycle = "orphaned"
            authority.owned_fs.abandon()
            raise
        authority.lifecycle = "discarded"

    @staticmethod
    def _phase_failure(fail_after: str | None, phase: str) -> None:
        if fail_after == phase:
            raise PackStagingError(f"injected staging failure after {phase}")

    def materialize_staging(
        self, prepared: PreparedPack, *, fail_after: str | None = None
    ) -> StagedPack:
        if fail_after is not None and fail_after not in MATERIALIZE_PHASES:
            raise PackStagingError(f"unknown staging failpoint {fail_after}")
        authority = self._authority_for_prepared(prepared)
        owned = authority.prepared
        analysis = authority.analysis
        staged_files: list[dict] = []
        staged_handles: dict[TableKey, _OwnedFileAuthority] = {}
        table_readback: list[dict] = []
        provisional: list[dict] = []

        def copy_change(item: Mapping[str, Any]) -> None:
            if item["operation"] == "delete":
                return
            root_name = item["root"]
            logical_path = item["logical_path"]
            if root_name not in ROOT_NAMES or _path_problem(logical_path):
                raise PackStagingError("prepared root/logical path is invalid")
            expected_source = self._source_path(
                self.package_dir, root_name, logical_path
            )
            if str(expected_source) != item["source_path"]:
                raise PackStagingError("prepared source identity does not match manifest root")
            source_root = (self.package_dir / "roots" / root_name).resolve()
            source = expected_source.resolve()
            try:
                source.relative_to(source_root)
            except ValueError as exc:
                raise PackStagingError("package source escaped its declared root") from exc
            if _has_link_or_junction_component(source):
                raise PackStagingError("package source traverses a link/junction")
            self._validate_authority(authority)
            try:
                raw = source.read_bytes()
            except OSError as exc:
                raise PackStagingError(f"cannot read package source {source}: {exc}") from exc
            if len(raw) != item["after_size"] \
                    or hashlib.sha256(raw).hexdigest() != item["after_sha256"]:
                raise PackStagingError(
                    f"package source changed after prepare: {item['root']}:{item['logical_path']}"
                )
            leaf = _owned_leaf("payload", root_name, logical_path)
            output = authority.owned_dir.create_file(
                leaf,
                raw,
                "payload_table" if item["is_table"] else "payload_asset",
            )
            self._validate_authority(authority)
            staged_handles[(cast(RootName, root_name), logical_path)] = output
            staged_files.append({
                "root": root_name,
                "logical_path": logical_path,
                "path": str(output.path),
                "sha256": item["after_sha256"],
                "size": item["after_size"],
                "operation": item["operation"],
            })

        try:
            for item in owned.file_changes:
                if item["is_table"]:
                    copy_change(item)
            self._phase_failure(fail_after, "table_materialization")

            for item in owned.file_changes:
                if not item["is_table"]:
                    copy_change(item)
            self._phase_failure(fail_after, "asset_copy")

            staged_by_key = {
                (item["root"], item["logical_path"]): item for item in staged_files
            }
            for table_key, claim in sorted(analysis.candidate_claims.items()):
                root_name, logical_path = table_key
                inspection_claim = _merge_inspection_claims(
                    claim, analysis.installed_claims.get(table_key)
                )
                staged_item = staged_by_key.get(table_key)
                if staged_item is None:
                    raise PackStagingError(
                        f"staged table is missing: {root_name}:{logical_path}"
                    )
                raw = staged_handles[table_key].read_bytes()
                try:
                    inspected = self.codecs[claim.codec_id].inspect(
                        raw, inspection_claim, inspection_claim.semantic_claims
                    )
                    _dict_rows(inspected)
                except Exception as exc:
                    raise PackStagingError(
                        f"staged table readback failed for {logical_path}: {exc}"
                    ) from exc
                if inspected != analysis.candidate_images[table_key]:
                    raise PackStagingError(
                        f"staged table semantic readback drift for {logical_path}"
                    )
                table_readback.append({
                    "root": root_name,
                    "logical_path": logical_path,
                    "codec_id": claim.codec_id,
                    "outer_keys": [key for key, _ in inspected.outer_rows],
                    "inner_keys": [
                        f"{outer}/{key}" for outer, key, _ in inspected.inner_rows
                    ],
                })
            self._phase_failure(fail_after, "readback")

            for item in staged_files:
                key = (cast(RootName, item["root"]), item["logical_path"])
                raw = staged_handles[key].read_bytes()
                if len(raw) != item["size"] \
                        or hashlib.sha256(raw).hexdigest() != item["sha256"]:
                    raise PackStagingError(
                        f"staged hash verification failed: {item['root']}:{item['logical_path']}"
                    )
            self._phase_failure(fail_after, "hash_verification")

            self._validate_authority(authority)
            for root in CLIENT_ROOTS:
                members: list[str] = []
                self._validate_authority(authority)
                archive_buffer = io.BytesIO()
                with zipfile.ZipFile(
                    archive_buffer, "w", compression=zipfile.ZIP_DEFLATED
                ) as archive:
                    for item in sorted(
                        (record for record in staged_files if record["root"] == root),
                        key=lambda record: record["logical_path"],
                    ):
                        live_path = self._live_path(root, item["logical_path"])
                        relative = live_path.relative_to(self._root_path(root)).as_posix()
                        member = ARCHIVE_PREFIXES[root] + relative
                        info = zipfile.ZipInfo(member, (1980, 1, 1, 0, 0, 0))
                        info.compress_type = zipfile.ZIP_DEFLATED
                        info.external_attr = 0o100644 << 16
                        key = (cast(RootName, root), item["logical_path"])
                        archive.writestr(info, staged_handles[key].read_bytes())
                        members.append(member)
                archive_raw = archive_buffer.getvalue()
                archive_file = authority.owned_dir.create_file(
                    f"{root}.zip", archive_raw, "provisional_zip"
                )
                with zipfile.ZipFile(io.BytesIO(archive_file.read_bytes()), "r") as archive:
                    if archive.namelist() != members:
                        raise PackStagingError(f"provisional {root} archive readback failed")
                    for member in members:
                        archive.read(member)
                provisional.append({
                    "root": root,
                    "path": str(archive_file.path),
                    "sha256": hashlib.sha256(archive_raw).hexdigest(),
                    "size": len(archive_raw),
                    "members": members,
                })
            self._phase_failure(fail_after, "provisional_zip_content")
        except Exception as exc:
            try:
                self._remove_owned(authority)
            except Exception as cleanup_exc:
                raise PackStagingError(
                    f"staging failed ({exc}); owned cleanup failed ({cleanup_exc})"
                ) from exc
            if isinstance(exc, PackStagingError):
                raise
            raise PackStagingError(f"staging failed: {exc}") from exc

        staged = StagedPack(
            owned.transaction_id,
            owned.staging_root,
            owned.transaction_dir,
            _record_sort(staged_files),
            _record_sort(table_readback),
            tuple(_freeze(item) for item in provisional),
        )
        authority.lifecycle = "staged"
        authority.staged = staged
        return staged

    def discard_staging(self, staged: StagedPack) -> None:
        authority = self._transactions.get(staged.transaction_id)
        if authority is None:
            raise PackStagingError("transaction is not owned by this PackTransaction")
        if authority.lifecycle == "discarded":
            if staged is authority.staged:
                return
            raise PackStagingError("forged record targets a tombstoned transaction")
        if staged is not authority.staged:
            raise PackStagingError("staged record is not the emitted owned authority")
        self._remove_owned(authority)

    def snapshot(self, snapshot_root: Path) -> SnapshotRecord:
        if self._latest_transaction_id is None:
            raise PackPreflightError("snapshot requires a current prepared transaction")
        authority = self._transactions[self._latest_transaction_id]
        self._validate_authority(authority)
        prepared = authority.prepared
        analysis = authority.analysis
        state = _validate_release_base(self.release_base_provider)
        if state != prepared.release_base:
            raise PackPreflightError("release base drifted after prepare")
        protected = (
            self.package_dir,
            self.live_roots.common,
            self.live_roots.medium,
            self.live_roots.android,
            self.live_roots.server,
            *self.live_roots.protected,
            prepared.staging_root,
        )
        root = self._validate_isolated_root(
            Path(snapshot_root), protected, "snapshot root"
        )
        captured: dict[TableKey, bytes | None] = {}
        for item in prepared.file_changes:
            key = (cast(RootName, item["root"]), item["logical_path"])
            if key in captured:
                raise PackPreflightError(
                    f"prepared plan repeats live path {key[0]}:{key[1]}"
                )
            current = _read_bytes_or_none(Path(item["live_path"]))
            captured[key] = current
            if _expectation(current) != item["before"]:
                raise PackPreflightError(
                    f"live path drifted after prepare: {item['live_path']}"
                )

        captured_images: dict[TableKey, TableImage] = {}
        for table_key in sorted(
            set(analysis.candidate_claims) | set(analysis.installed_claims)
        ):
            candidate_claim = analysis.candidate_claims.get(table_key)
            installed_claim = analysis.installed_claims.get(table_key)
            claim = candidate_claim or installed_claim
            assert claim is not None
            inspection_claim = (
                _merge_inspection_claims(candidate_claim, installed_claim)
                if candidate_claim is not None else installed_claim
            )
            assert inspection_claim is not None
            raw = captured.get(table_key)
            if table_key not in captured:
                raise PackPreflightError(
                    f"prepared plan lacks table file {table_key[0]}:{table_key[1]}"
                )
            try:
                image = (
                    self.codecs[claim.codec_id].inspect(
                        raw, inspection_claim, inspection_claim.semantic_claims
                    )
                    if raw is not None else TableImage(())
                )
                _dict_rows(image)
            except Exception as exc:
                raise PackPreflightError(
                    f"snapshot codec {claim.codec_id} rejected "
                    f"{table_key[0]}:{table_key[1]}: {exc}"
                ) from exc
            captured_images[table_key] = image

        table_before: list[dict] = []
        for table_key in sorted(
            set(analysis.candidate_claims) | set(analysis.installed_claims)
        ):
            root_name, logical_path = table_key
            candidate_claim = analysis.candidate_claims.get(table_key)
            installed_claim = analysis.installed_claims.get(table_key)
            live = captured_images[table_key]
            outer, inner, live_semantics = _dict_rows(live)
            outer_keys = set(candidate_claim.outer_keys if candidate_claim else ()) \
                | set(installed_claim.outer_keys if installed_claim else ())
            inner_keys = {
                (outer_key, key)
                for claim in (candidate_claim, installed_claim) if claim is not None
                for outer_key, keys in claim.inner_keys for key in keys
            }
            semantic_keys = {
                (item.namespace, item.value)
                for claim in (candidate_claim, installed_claim) if claim is not None
                for item in claim.semantic_claims
            }
            for outer_key in sorted(outer_keys):
                table_before.append({
                    "root": root_name,
                    "logical_path": logical_path,
                    "kind": "outer",
                    "outer_key": outer_key,
                    "inner_key": None,
                    **_value_before(outer.get(outer_key)),
                })
            for outer_key, inner_key in sorted(inner_keys):
                table_before.append({
                    "root": root_name,
                    "logical_path": logical_path,
                    "kind": "inner",
                    "outer_key": outer_key,
                    "inner_key": inner_key,
                    **_value_before(inner.get((outer_key, inner_key))),
                })
            for namespace, value in sorted(semantic_keys):
                source_before = _expectation(captured[table_key])
                table_before.append({
                    "root": root_name,
                    "logical_path": logical_path,
                    "kind": "semantic",
                    "namespace": namespace,
                    "value": value,
                    "outer_key": None,
                    "inner_key": None,
                    "occupied": (namespace, value) in live_semantics,
                    "evidence_kind": "codec_semantic_occupancy",
                    "source_table_before": source_before,
                })

        file_before: list[dict] = []
        for item in prepared.file_changes:
            key = (cast(RootName, item["root"]), item["logical_path"])
            raw = captured[key]
            record = {
                "root": item["root"],
                "logical_path": item["logical_path"],
                "live_path": item["live_path"],
                **_value_before(raw),
            }
            file_before.append(record)

        def snapshot_json_record(item: Mapping[str, Any]) -> dict[str, Any]:
            plain = _plain(item)
            if "bytes" in plain:
                plain["bytes"] = (
                    base64.b64encode(plain["bytes"]).decode("ascii")
                    if plain["bytes"] is not None else None
                )
            return plain

        frozen_table_before = _record_sort(table_before)
        frozen_file_before = _record_sort(file_before)
        serializable = {
            "transaction_id": prepared.transaction_id,
            "release_base": self._release_metadata(state),
            "table_before": [
                snapshot_json_record(item) for item in frozen_table_before
            ],
            "file_before": [
                snapshot_json_record(item) for item in frozen_file_before
            ],
        }
        snapshot_bytes = _canonical_json_bytes(serializable)
        snapshot_nonce = uuid.uuid4().hex
        temp_name = (
            f"character-pack-snapshot-{prepared.transaction_id}-{snapshot_nonce}"
        )
        final_dir = root / temp_name
        snapshot_fs: _OwnedFilesystem | None = None
        temp_authority: _OwnedDirectoryAuthority | None = None
        try:
            snapshot_fs = _OwnedFilesystem(root, self._filesystem_boundary_hook)
            temp_authority = snapshot_fs.create_directory(temp_name)
            marker_bytes = _canonical_json_bytes({
                "kind": "character_pack_snapshot",
                "transaction_id": prepared.transaction_id,
                "snapshot_nonce": snapshot_nonce,
                "prepared_digest": prepared.prepared_digest,
                "snapshot_sha256": hashlib.sha256(snapshot_bytes).hexdigest(),
            })
            for item in prepared.file_changes:
                key = (cast(RootName, item["root"]), item["logical_path"])
                raw = captured[key]
                if raw is not None:
                    temp_authority.create_file(
                        _owned_leaf(
                            "file", item["root"], item["logical_path"]
                        ),
                        raw,
                        "snapshot_file",
                    )
            temp_authority.create_file(
                "snapshot.json", snapshot_bytes, "snapshot_json"
            )
            # The unique directory is unpublished until this final marker exists.
            # Keeping all handles retained makes marker creation the atomic
            # authority-preserving finalize point without a pathname rename.
            temp_authority.validate()
            snapshot_fs._fire(
                "before_finalize", kind="snapshot_finalize",
                path=temp_authority.path,
                target=temp_authority.path / SNAPSHOT_MARKER,
            )
            temp_authority.validate()
            temp_authority.create_file(
                SNAPSHOT_MARKER, marker_bytes, "snapshot_marker"
            )
            self._snapshot_authorities.append((snapshot_fs, temp_authority))
        except Exception as exc:
            cleanup_error: Exception | None = None
            if snapshot_fs is not None and temp_authority is not None \
                    and not temp_authority.closed:
                try:
                    snapshot_fs.delete_directory(
                        temp_authority, "snapshot_cleanup"
                    )
                except Exception as cleanup_exc:
                    cleanup_error = cleanup_exc
                    snapshot_fs.abandon()
            elif snapshot_fs is not None:
                snapshot_fs.abandon()
            detail = f"cannot create snapshot: {exc}"
            if cleanup_error is not None:
                detail += f"; exact owned cleanup preserved orphan: {cleanup_error}"
            if isinstance(exc, PackPreflightError):
                if cleanup_error is None:
                    raise
            raise PackPreflightError(detail) from exc

        return SnapshotRecord(
            prepared.transaction_id,
            final_dir,
            state,
            frozen_table_before,
            frozen_file_before,
        )
