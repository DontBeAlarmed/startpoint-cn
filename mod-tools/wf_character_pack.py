#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Character-package validation and lock-free transaction preparation.

This module may read live roots, but it never mutates them and never allocates
release versions or final archive names.  Production promotion and the single
``active.json`` commit point belong to :mod:`wf_release`.
"""
from __future__ import annotations

import base64
import hashlib
import json
import math
import re
import shutil
import uuid
import zipfile
from dataclasses import asdict, dataclass
from pathlib import Path, PureWindowsPath
from typing import Any, Iterable, Literal, Mapping, Protocol

import wf_mod_tool as core

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
TRANSACTION_MARKER = ".character-pack-transaction.json"
SNAPSHOT_MARKER = ".character-pack-snapshot.json"
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
class PreflightReport:
    package_id: str
    package_version: str
    installed_version: str | None
    version_diff: dict[str, str | None]
    creates: tuple[dict, ...]
    updates: tuple[dict, ...]
    deletes: tuple[dict, ...]
    conflicts: tuple[dict, ...]
    root_totals: dict[str, dict[str, int]]
    expected_base_hashes: dict[str, Any]
    capability_warnings: tuple[dict, ...]
    can_prepare: bool
    delivery_status: str

    def canonical_bytes(self) -> bytes:
        return _canonical_json_bytes(asdict(self))


@dataclass(frozen=True)
class PreparedPack:
    transaction_id: str
    staging_root: Path
    transaction_dir: Path
    package_manifest_sha256: str
    release_base: ReleaseBaseState
    table_key_changes: tuple[dict, ...]
    file_changes: tuple[dict, ...]
    degraded_data_confirmed: bool


@dataclass(frozen=True)
class SnapshotRecord:
    transaction_id: str
    snapshot_dir: Path
    release_base: ReleaseBaseState
    table_before: tuple[dict, ...]
    file_before: tuple[dict, ...]


@dataclass(frozen=True)
class StagedPack:
    transaction_id: str
    staging_root: Path
    transaction_dir: Path
    staged_files: tuple[dict, ...]
    table_readback: tuple[dict, ...]
    provisional_archives: tuple[dict, ...]


@dataclass
class _Analysis:
    report: PreflightReport
    release_base: ReleaseBaseState
    candidate_claims: dict[str, TableClaim]
    installed_claims: dict[str, TableClaim]
    candidate_images: dict[str, TableImage]
    live_images: dict[str, TableImage]
    table_key_changes: tuple[dict, ...]
    file_changes: tuple[dict, ...]


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
    if isinstance(value, dict):
        return {key: _json_sort_projection(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [_json_sort_projection(item) for item in value]
    return value


def _record_sort(records: Iterable[dict]) -> tuple[dict, ...]:
    return tuple(sorted(
        records,
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


def _parse_transaction_claims(manifest: dict) -> dict[str, TableClaim]:
    tables = manifest.get("tables")
    if not isinstance(tables, list):
        raise PackPreflightError("tables must serialize transaction claims as an array")
    result: dict[str, TableClaim] = {}
    seen_table_keys: set[tuple[str, str]] = set()
    seen_inner_keys: set[tuple[str, str, str]] = set()
    seen_semantics: set[tuple[str, str]] = set()
    errors: list[str] = []
    required = {
        "logical_path", "codec_id", "outer_keys", "inner_keys", "semantic_claims",
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
        logical_path = entry["logical_path"]
        codec_id = entry["codec_id"]
        if not isinstance(logical_path, str) or _path_problem(logical_path):
            errors.append(f"{prefix}.logical_path: invalid logical path")
            continue
        if logical_path in result:
            errors.append(f"{prefix}.logical_path: duplicate table claim {logical_path}")
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
                marker = (logical_path, key)
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
                    marker = (logical_path, outer_key, key)
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

        result[logical_path] = TableClaim(
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
    ):
        self.package_dir = Path(package_dir)
        self.manifest = manifest
        self.live_roots = live_roots
        self.release_base_provider = release_base_provider
        self.codecs = dict(DEFAULT_CODECS)
        if codec_registry:
            self.codecs.update(codec_registry)
        self.installed_manifest = installed_manifest
        self.installed_package_dir = (
            Path(installed_package_dir) if installed_package_dir is not None else None
        )
        self.available_capabilities = frozenset(available_capabilities)
        self.degraded_data_confirmed = bool(degraded_data_confirmed)
        self.snapshot_roots = tuple(Path(path) for path in snapshot_roots)
        self._analysis: _Analysis | None = None
        self._prepared: PreparedPack | None = None
        self._known_transaction_ids: set[str] = set()

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
        errors = validate_manifest(self.manifest, self.package_dir)
        if errors:
            raise PackPreflightError("candidate manifest invalid: " + "; ".join(errors))
        candidate_claims = _parse_transaction_claims(self.manifest)
        installed_claims: dict[str, TableClaim] = {}
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

        server_paths = tuple(
            entry["logical_path"] for entry in self.manifest["roots"]["server"]
        )
        if set(server_paths) != set(SERVER_LOGICAL_PATHS) \
                or len(server_paths) != len(SERVER_LOGICAL_PATHS):
            raise PackPreflightError(
                "server root must contain exactly " + ", ".join(SERVER_LOGICAL_PATHS)
            )
        candidate_entries = self._entries(self.manifest)
        for logical_path, claim in candidate_claims.items():
            if claim.codec_id not in self.codecs:
                raise PackPreflightError(
                    f"unknown table codec {claim.codec_id!r} for {logical_path}"
                )
            if ("common", logical_path) not in candidate_entries:
                raise PackPreflightError(
                    f"table claim {logical_path} has no common storage-ready payload"
                )

        state = _validate_release_base(self.release_base_provider)
        if self.installed_manifest is not None:
            installed_hash = hashlib.sha256(
                canonical_manifest_bytes(self.installed_manifest)
            ).hexdigest()
            if state.active_package_manifest_sha256 != installed_hash:
                raise PackPreflightError(
                    "installed ownership manifest is not hash-bound to active state"
                )
            if self.installed_manifest["package_id"] != self.manifest["package_id"]:
                raise PackPreflightError(
                    "installed ownership belongs to a different package_id"
                )
        elif state.active_package_manifest_sha256 is not None:
            raise PackPreflightError(
                "active ownership hash exists but installed manifest was not supplied"
            )
        return state, candidate_claims, installed_claims

    def _inspect_tables(
        self,
        candidate_claims: dict[str, TableClaim],
        installed_claims: dict[str, TableClaim],
    ) -> tuple[dict[str, TableImage], dict[str, TableImage], list[dict], list[dict]]:
        candidate_entries = self._entries(self.manifest)
        candidate_images: dict[str, TableImage] = {}
        live_images: dict[str, TableImage] = {}
        conflicts: list[dict] = []
        changes: list[dict] = []
        for logical_path in sorted(set(candidate_claims) | set(installed_claims)):
            candidate_claim = candidate_claims.get(logical_path)
            installed_claim = installed_claims.get(logical_path)
            claim = candidate_claim or installed_claim
            assert claim is not None
            if candidate_claim is None:
                raise PackPreflightError(
                    f"deleted table {logical_path} still requires an empty candidate claim/payload"
                )
            if installed_claim is not None and installed_claim.codec_id != claim.codec_id:
                raise PackPreflightError(f"codec changed across upgrade for {logical_path}")
            codec = self.codecs.get(claim.codec_id)
            if codec is None:
                raise PackPreflightError(f"unknown table codec {claim.codec_id!r}")
            entry = candidate_entries.get(("common", logical_path))
            if entry is None:
                raise PackPreflightError(f"missing candidate table payload {logical_path}")
            candidate_raw = self._source_path(
                self.package_dir, "common", logical_path
            ).read_bytes()
            live_raw = _read_bytes_or_none(self._live_path("common", logical_path))
            try:
                candidate_image = codec.inspect(
                    candidate_raw, candidate_claim, candidate_claim.semantic_claims
                )
                live_image = (
                    codec.inspect(live_raw, candidate_claim, candidate_claim.semantic_claims)
                    if live_raw is not None else TableImage(())
                )
            except PackPreflightError:
                raise
            except Exception as exc:
                raise PackPreflightError(
                    f"codec {claim.codec_id} rejected {logical_path}: {exc}"
                ) from exc
            candidate_images[logical_path] = candidate_image
            live_images[logical_path] = live_image
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
        self, table_paths: set[str]
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
                "is_table": root == "common" and logical_path in table_paths,
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
        table_file_before = {
            item["logical_path"]: item["before"]
            for item in file_changes if item["is_table"]
        }
        for item in table_changes:
            if item["kind"] == "semantic":
                item["source_table_before"] = table_file_before[item["logical_path"]]

        creates: list[dict] = []
        updates: list[dict] = []
        deletes: list[dict] = []
        candidate_tokens: set[tuple[str, str]] = set()
        installed_tokens: set[tuple[str, str]] = set()
        for path, claim in candidate_claims.items():
            candidate_tokens.update(("outer", f"{path}:{key}") for key in claim.outer_keys)
            candidate_tokens.update(
                ("inner", f"{path}:{outer}/{key}")
                for outer, keys in claim.inner_keys for key in keys
            )
            candidate_tokens.update(
                ("semantic", f"{item.namespace}:{item.value}")
                for item in claim.semantic_claims
            )
        for path, claim in installed_claims.items():
            installed_tokens.update(("outer", f"{path}:{key}") for key in claim.outer_keys)
            installed_tokens.update(
                ("inner", f"{path}:{outer}/{key}")
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
            version_diff=_version_diff(
                self.installed_manifest["package_version"]
                if self.installed_manifest is not None else None,
                self.manifest["package_version"],
            ),
            creates=_record_sort(creates),
            updates=_record_sort(updates),
            deletes=_record_sort(deletes),
            conflicts=_record_sort(conflicts),
            root_totals=totals,
            expected_base_hashes={
                "active_sha256": state.active_sha256,
                "current_release_id": state.current_release_id,
                "validated_chain_tail": state.validated_chain_tail,
                "expected_from_version": state.expected_from_version,
                "live": dict(sorted(live_hashes.items())),
            },
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
        child = root / f"character-pack-{transaction_id}"
        try:
            child.mkdir()
            marker = {
                "kind": "character_pack_transaction",
                "transaction_id": transaction_id,
            }
            (child / TRANSACTION_MARKER).write_bytes(_canonical_json_bytes(marker))
            metadata = {
                "transaction_id": transaction_id,
                "package_manifest_sha256": hashlib.sha256(
                    canonical_manifest_bytes(self.manifest)
                ).hexdigest(),
                "release_base": self._release_metadata(self._analysis.release_base),
                "table_key_changes": self._analysis.table_key_changes,
                "file_changes": self._analysis.file_changes,
                "degraded_data_confirmed": self.degraded_data_confirmed,
            }
            (child / "prepared.json").write_bytes(_canonical_json_bytes(metadata))
        except Exception as exc:
            if child.exists():
                shutil.rmtree(child)
            raise PackPreflightError(f"cannot create prepared transaction: {exc}") from exc
        prepared = PreparedPack(
            transaction_id=transaction_id,
            staging_root=root,
            transaction_dir=child,
            package_manifest_sha256=hashlib.sha256(
                canonical_manifest_bytes(self.manifest)
            ).hexdigest(),
            release_base=self._analysis.release_base,
            table_key_changes=self._analysis.table_key_changes,
            file_changes=self._analysis.file_changes,
            degraded_data_confirmed=self.degraded_data_confirmed,
        )
        self._prepared = prepared
        self._known_transaction_ids.add(transaction_id)
        return prepared

    def _verify_marker(self, transaction_id: str, transaction_dir: Path,
                       staging_root: Path) -> None:
        if transaction_id not in self._known_transaction_ids:
            raise PackStagingError("transaction is not owned by this PackTransaction")
        if not transaction_dir.exists():
            return
        if _is_link_or_junction(transaction_dir):
            raise PackStagingError("transaction directory became a symlink or junction")
        resolved_dir = transaction_dir.resolve()
        resolved_root = staging_root.resolve()
        if resolved_dir.parent != resolved_root:
            raise PackStagingError("transaction directory is not a direct owned child")
        marker_path = resolved_dir / TRANSACTION_MARKER
        try:
            marker = json.loads(marker_path.read_text(encoding="utf-8"))
        except Exception as exc:
            raise PackStagingError(f"transaction marker is unreadable: {exc}") from exc
        if marker != {
            "kind": "character_pack_transaction",
            "transaction_id": transaction_id,
        }:
            raise PackStagingError("transaction marker does not match owner/id")

    def _remove_owned(self, transaction_id: str, transaction_dir: Path,
                      staging_root: Path) -> None:
        self._verify_marker(transaction_id, transaction_dir, staging_root)
        if transaction_dir.exists():
            shutil.rmtree(transaction_dir)

    @staticmethod
    def _phase_failure(fail_after: str | None, phase: str) -> None:
        if fail_after == phase:
            raise PackStagingError(f"injected staging failure after {phase}")

    def materialize_staging(
        self, prepared: PreparedPack, *, fail_after: str | None = None
    ) -> StagedPack:
        if fail_after is not None and fail_after not in MATERIALIZE_PHASES:
            raise PackStagingError(f"unknown staging failpoint {fail_after}")
        if self._analysis is None or self._prepared != prepared:
            raise PackStagingError("prepared record is not the current owned transaction")
        self._verify_marker(
            prepared.transaction_id, prepared.transaction_dir, prepared.staging_root
        )
        payload_root = prepared.transaction_dir / "payload"
        staged_files: list[dict] = []
        table_readback: list[dict] = []
        provisional: list[dict] = []

        def copy_change(item: dict) -> None:
            if item["operation"] == "delete":
                return
            source = Path(item["source_path"])
            try:
                raw = source.read_bytes()
            except OSError as exc:
                raise PackStagingError(f"cannot read package source {source}: {exc}") from exc
            if len(raw) != item["after_size"] \
                    or hashlib.sha256(raw).hexdigest() != item["after_sha256"]:
                raise PackStagingError(
                    f"package source changed after prepare: {item['root']}:{item['logical_path']}"
                )
            destination = payload_root / item["root"] / Path(*item["logical_path"].split("/"))
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(raw)
            staged_files.append({
                "root": item["root"],
                "logical_path": item["logical_path"],
                "path": str(destination),
                "sha256": item["after_sha256"],
                "size": item["after_size"],
                "operation": item["operation"],
            })

        try:
            for item in prepared.file_changes:
                if item["is_table"]:
                    copy_change(item)
            self._phase_failure(fail_after, "table_materialization")

            for item in prepared.file_changes:
                if not item["is_table"]:
                    copy_change(item)
            self._phase_failure(fail_after, "asset_copy")

            staged_by_key = {
                (item["root"], item["logical_path"]): item for item in staged_files
            }
            for logical_path, claim in sorted(self._analysis.candidate_claims.items()):
                staged_item = staged_by_key.get(("common", logical_path))
                if staged_item is None:
                    raise PackStagingError(f"staged table is missing: {logical_path}")
                raw = Path(staged_item["path"]).read_bytes()
                try:
                    inspected = self.codecs[claim.codec_id].inspect(
                        raw, claim, claim.semantic_claims
                    )
                    _dict_rows(inspected)
                except Exception as exc:
                    raise PackStagingError(
                        f"staged table readback failed for {logical_path}: {exc}"
                    ) from exc
                if inspected != self._analysis.candidate_images[logical_path]:
                    raise PackStagingError(
                        f"staged table semantic readback drift for {logical_path}"
                    )
                table_readback.append({
                    "logical_path": logical_path,
                    "codec_id": claim.codec_id,
                    "outer_keys": [key for key, _ in inspected.outer_rows],
                    "inner_keys": [
                        f"{outer}/{key}" for outer, key, _ in inspected.inner_rows
                    ],
                })
            self._phase_failure(fail_after, "readback")

            for item in staged_files:
                path = Path(item["path"])
                if path.stat().st_size != item["size"] \
                        or _sha256_file(path) != item["sha256"]:
                    raise PackStagingError(
                        f"staged hash verification failed: {item['root']}:{item['logical_path']}"
                    )
            self._phase_failure(fail_after, "hash_verification")

            archive_dir = prepared.transaction_dir / "provisional"
            archive_dir.mkdir()
            for root in CLIENT_ROOTS:
                archive_path = archive_dir / f"{root}.zip"
                members: list[str] = []
                with zipfile.ZipFile(
                    archive_path, "w", compression=zipfile.ZIP_DEFLATED
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
                        archive.writestr(info, Path(item["path"]).read_bytes())
                        members.append(member)
                with zipfile.ZipFile(archive_path, "r") as archive:
                    if archive.namelist() != members:
                        raise PackStagingError(f"provisional {root} archive readback failed")
                    for member in members:
                        archive.read(member)
                provisional.append({
                    "root": root,
                    "path": str(archive_path),
                    "sha256": _sha256_file(archive_path),
                    "size": archive_path.stat().st_size,
                    "members": members,
                })
            self._phase_failure(fail_after, "provisional_zip_content")
        except Exception as exc:
            try:
                self._remove_owned(
                    prepared.transaction_id,
                    prepared.transaction_dir,
                    prepared.staging_root,
                )
            except Exception as cleanup_exc:
                raise PackStagingError(
                    f"staging failed ({exc}); owned cleanup failed ({cleanup_exc})"
                ) from exc
            if isinstance(exc, PackStagingError):
                raise
            raise PackStagingError(f"staging failed: {exc}") from exc

        return StagedPack(
            prepared.transaction_id,
            prepared.staging_root,
            prepared.transaction_dir,
            _record_sort(staged_files),
            _record_sort(table_readback),
            tuple(provisional),
        )

    def discard_staging(self, staged: StagedPack) -> None:
        self._remove_owned(
            staged.transaction_id, staged.transaction_dir, staged.staging_root
        )

    def snapshot(self, snapshot_root: Path) -> SnapshotRecord:
        if self._prepared is None or self._analysis is None:
            raise PackPreflightError("snapshot requires a current prepared transaction")
        prepared = self._prepared
        state = _validate_release_base(self.release_base_provider)
        if state != prepared.release_base:
            raise PackPreflightError("release base drifted after prepare")
        for item in prepared.file_changes:
            current = _read_bytes_or_none(Path(item["live_path"]))
            if _expectation(current) != item["before"]:
                raise PackPreflightError(
                    f"live path drifted after prepare: {item['live_path']}"
                )
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
        snapshot_dir = root / f"character-pack-snapshot-{prepared.transaction_id}"
        if snapshot_dir.exists():
            raise PackPreflightError("snapshot already exists for transaction")
        snapshot_dir.mkdir()
        (snapshot_dir / SNAPSHOT_MARKER).write_bytes(_canonical_json_bytes({
            "kind": "character_pack_snapshot",
            "transaction_id": prepared.transaction_id,
        }))

        table_before: list[dict] = []
        for logical_path in sorted(
            set(self._analysis.candidate_claims) | set(self._analysis.installed_claims)
        ):
            candidate_claim = self._analysis.candidate_claims.get(logical_path)
            installed_claim = self._analysis.installed_claims.get(logical_path)
            live = self._analysis.live_images[logical_path]
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
                    "logical_path": logical_path,
                    "kind": "outer",
                    "outer_key": outer_key,
                    "inner_key": None,
                    **_value_before(outer.get(outer_key)),
                })
            for outer_key, inner_key in sorted(inner_keys):
                table_before.append({
                    "logical_path": logical_path,
                    "kind": "inner",
                    "outer_key": outer_key,
                    "inner_key": inner_key,
                    **_value_before(inner.get((outer_key, inner_key))),
                })
            for namespace, value in sorted(semantic_keys):
                source_before = next(
                    item["before"] for item in prepared.file_changes
                    if item["root"] == "common"
                    and item["logical_path"] == logical_path
                )
                table_before.append({
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
            raw = _read_bytes_or_none(Path(item["live_path"]))
            record = {
                "root": item["root"],
                "logical_path": item["logical_path"],
                "live_path": item["live_path"],
                **_value_before(raw),
            }
            file_before.append(record)
            if raw is not None:
                output = snapshot_dir / "files" / item["root"] / Path(
                    *item["logical_path"].split("/")
                )
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_bytes(raw)

        serializable = {
            "transaction_id": prepared.transaction_id,
            "release_base": self._release_metadata(state),
            "table_before": [
                ({**item, "bytes": (
                    base64.b64encode(item["bytes"]).decode("ascii")
                    if item["bytes"] is not None else None
                )} if "bytes" in item else dict(item))
                for item in _record_sort(table_before)
            ],
            "file_before": [
                {**item, "bytes": (
                    base64.b64encode(item["bytes"]).decode("ascii")
                    if item["bytes"] is not None else None
                )} for item in _record_sort(file_before)
            ],
        }
        (snapshot_dir / "snapshot.json").write_bytes(_canonical_json_bytes(serializable))
        return SnapshotRecord(
            prepared.transaction_id,
            snapshot_dir,
            state,
            _record_sort(table_before),
            _record_sort(file_before),
        )
