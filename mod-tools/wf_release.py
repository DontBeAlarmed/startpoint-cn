#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Atomic multi-root character release with ``active.json`` as commit point."""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import uuid
import zipfile
from contextlib import contextmanager
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Callable, Iterator, Literal, Mapping

import wf_character_pack as character_pack


RootName = Literal["common", "medium", "android", "server"]
ClientRoot = Literal["common", "medium", "android"]
CLIENT_ROOTS: tuple[ClientRoot, ...] = ("common", "medium", "android")
ROOT_DIRS = {
    "common": "archive-common-diff",
    "medium": "archive-medium-diff",
    "android": "archive-android-diff",
}
ARCHIVE_PREFIXES = character_pack.ARCHIVE_PREFIXES
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")
TOKEN_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
HASH_RE = re.compile(r"^[0-9a-f]{64}$")
LEGACY_ARCHIVE_RE = re.compile(
    r"^pinball-(\d+\.\d+\.\d+)-(\d+\.\d+\.\d+)-\d+-.*\.zip$"
)


class ReleaseError(RuntimeError):
    """The release did not commit and was restored or made no writes."""


class CommittedReleaseError(RuntimeError):
    """The active manifest committed; only idempotent recovery remains."""


def _validate_qa_contract(manifest: dict, *, confirmation: str | None = None) -> str:
    """Validate the mutually exclusive production/runtime-test authorization gates."""
    qa = manifest.get("qa") if isinstance(manifest, dict) else None
    if not isinstance(qa, dict):
        raise ReleaseError("package qa contract is missing")
    mode = qa.get("delivery_mode")
    if mode == "runtime_test":
        if qa.get("release_ready") is not False \
                or qa.get("user_authorized_direct_real_test") is not True:
            raise ReleaseError("runtime-test authorization contract is missing")
        if confirmation is not None and confirmation != "DIRECT_REAL_TEST":
            raise ReleaseError("runtime-test publish requires DIRECT_REAL_TEST")
        return mode
    if mode != "production":
        raise ReleaseError("qa.delivery_mode must be production or runtime_test")
    if confirmation is not None and confirmation != "PUBLISH_CHARACTER_PACKAGE":
        raise ReleaseError("production publish requires PUBLISH_CHARACTER_PACKAGE")
    if qa.get("release_ready") is not True:
        raise ReleaseError("production package must declare release_ready=true")
    if qa.get("required_assets_total") != 37 or qa.get("required_assets_present") != 37:
        raise ReleaseError("production package requires exactly 37/37 required assets")
    digest = qa.get("workspace_input_sha256")
    if not isinstance(digest, str) or HASH_RE.fullmatch(digest) is None:
        raise ReleaseError("production package workspace_input_sha256 is invalid")
    return mode


@dataclass(frozen=True)
class ReleaseFile:
    root: RootName
    logical_path: str
    live_path: Path
    staged_path: Path
    before_raw: bytes | None
    after_sha256: str
    after_size: int
    delete_after: bool = False


@dataclass(frozen=True)
class ProvisionalArchive:
    root: ClientRoot
    path: Path
    sha256: str
    size: int
    members: tuple[str, ...]


@dataclass(frozen=True)
class ReleasePayload:
    package_id: str
    package_manifest_sha256: str
    expected_base: character_pack.ReleaseBaseState
    files: tuple[ReleaseFile, ...]
    provisional_archives: tuple[ProvisionalArchive, ...]


@dataclass(frozen=True)
class ReleaseResult:
    committed: bool
    release_id: str
    from_version: str
    version: str
    active_manifest_sha256: str
    archive_paths: tuple[Path, ...]
    snapshot_dir: Path | None = None


@dataclass(frozen=True)
class PreparedRuntimeRelease:
    transaction: character_pack.PackTransaction
    preflight: character_pack.PreflightReport
    prepared: character_pack.PreparedPack
    snapshot: character_pack.SnapshotRecord
    staged: character_pack.StagedPack
    payload: ReleasePayload


@dataclass(frozen=True)
class RuntimeRebaseResult:
    output_dir: Path
    source_manifest_sha256: str
    manifest_sha256: str
    table_count: int


class JsonObjectCodec:
    """Expose top-level server JSON ownership to ``PackTransaction``."""

    def inspect(
        self,
        raw: bytes,
        claim: character_pack.TableClaim,
        semantic_claims: tuple[character_pack.SemanticClaim, ...],
    ) -> character_pack.TableImage:
        del claim, semantic_claims
        value = _strict_object(raw, "server JSON object")
        return character_pack.TableImage(tuple(
            (str(key), _canonical(item)) for key, item in value.items()
        ))


def _merge_claimed_rows(
    live_keys: list[str],
    live_rows: list[bytes],
    candidate_rows: Mapping[str, bytes],
    claimed_keys: tuple[str, ...],
    *,
    label: str,
) -> tuple[list[str], list[bytes]]:
    keys = list(live_keys)
    rows = list(live_rows)
    positions = {key: index for index, key in enumerate(keys)}
    for key in claimed_keys:
        if key not in candidate_rows:
            raise ReleaseError(f"candidate lacks claimed row: {label}:{key}")
        row = candidate_rows[key]
        if key in positions:
            rows[positions[key]] = row
        else:
            positions[key] = len(keys)
            keys.append(key)
            rows.append(row)
    return keys, rows


def _merge_claimed_table_bytes(
    claim: character_pack.TableClaim,
    candidate_raw: bytes,
    live_raw: bytes,
) -> bytes:
    """Rebase only declared rows onto the current live full-table bytes."""
    import wf_mod_tool as core

    logical = claim.logical_path
    try:
        if claim.codec_id in {"flat", "raw_outer"}:
            compressed = claim.codec_id == "flat"
            candidate_keys, candidate_rows = core._strict_orderedmap_rows(  # type: ignore[attr-defined]
                candidate_raw, label=f"candidate:{logical}", compressed_rows=compressed
            )
            live_keys, live_rows = core._strict_orderedmap_rows(  # type: ignore[attr-defined]
                live_raw, label=f"live:{logical}", compressed_rows=compressed
            )
            keys, rows = _merge_claimed_rows(
                live_keys,
                live_rows,
                dict(zip(candidate_keys, candidate_rows)),
                claim.outer_keys,
                label=logical,
            )
            table = core.OrderedMap(logical, keys, rows, Path("<runtime-rebase>"))
            return (
                core.build_orderedmap(table)
                if compressed else core.build_orderedmap_raw_rows(table)
            )

        if claim.codec_id in {"action_nested", "switched_nested"}:
            candidate_outer_keys, candidate_outer_rows = core._strict_orderedmap_rows(  # type: ignore[attr-defined]
                candidate_raw, label=f"candidate:{logical}", compressed_rows=False
            )
            live_outer_keys, live_outer_rows = core._strict_orderedmap_rows(  # type: ignore[attr-defined]
                live_raw, label=f"live:{logical}", compressed_rows=False
            )
            candidate_outer = dict(zip(candidate_outer_keys, candidate_outer_rows))
            live_outer = dict(zip(live_outer_keys, live_outer_rows))
            inner_claims = dict(claim.inner_keys)
            if set(inner_claims) != set(claim.outer_keys):
                raise ReleaseError(f"nested claims are incomplete: {logical}")
            merged_outer_rows = list(live_outer_rows)
            outer_positions = {
                key: index for index, key in enumerate(live_outer_keys)
            }
            merged_outer_keys = list(live_outer_keys)
            for outer_key in claim.outer_keys:
                candidate_inner_raw = candidate_outer.get(outer_key)
                if candidate_inner_raw is None:
                    raise ReleaseError(
                        f"candidate lacks claimed nested row: {logical}:{outer_key}"
                    )
                candidate_inner_keys, candidate_inner_rows = core._strict_orderedmap_rows(  # type: ignore[attr-defined]
                    candidate_inner_raw,
                    label=f"candidate:{logical}:{outer_key}",
                    compressed_rows=True,
                )
                live_inner_raw = live_outer.get(outer_key)
                if live_inner_raw is None:
                    live_inner_keys: list[str] = []
                    live_inner_rows: list[bytes] = []
                else:
                    live_inner_keys, live_inner_rows = core._strict_orderedmap_rows(  # type: ignore[attr-defined]
                        live_inner_raw,
                        label=f"live:{logical}:{outer_key}",
                        compressed_rows=True,
                    )
                inner_keys, inner_rows = _merge_claimed_rows(
                    live_inner_keys,
                    live_inner_rows,
                    dict(zip(candidate_inner_keys, candidate_inner_rows)),
                    inner_claims[outer_key],
                    label=f"{logical}:{outer_key}",
                )
                merged_inner = core.build_orderedmap(core.OrderedMap(
                    f"{logical}#{outer_key}",
                    inner_keys,
                    inner_rows,
                    Path("<runtime-rebase>"),
                ))
                if outer_key in outer_positions:
                    merged_outer_rows[outer_positions[outer_key]] = merged_inner
                else:
                    outer_positions[outer_key] = len(merged_outer_keys)
                    merged_outer_keys.append(outer_key)
                    merged_outer_rows.append(merged_inner)
            return core.build_orderedmap_raw_rows(core.OrderedMap(
                logical,
                merged_outer_keys,
                merged_outer_rows,
                Path("<runtime-rebase>"),
            ))

        if claim.codec_id == "json_object":
            candidate = _strict_object(candidate_raw, f"candidate:{logical}")
            live = _strict_object(live_raw, f"live:{logical}")
            for key in claim.outer_keys:
                if key not in candidate:
                    raise ReleaseError(f"candidate lacks claimed JSON row: {logical}:{key}")
                live[key] = candidate[key]
            return _canonical(live)
    except ReleaseError:
        raise
    except Exception as exc:
        raise ReleaseError(f"cannot rebase claimed table {logical}: {exc}") from exc
    raise ReleaseError(f"unsupported runtime rebase codec: {claim.codec_id}")


def release_payload_from_records(
    manifest: Mapping[str, object],
    prepared: object,
    staged: object,
    snapshot: object,
) -> ReleasePayload:
    package_id = manifest.get("package_id")
    if not isinstance(package_id, str):
        raise ReleaseError("package manifest package_id is invalid")
    before_by_key: dict[tuple[str, str], Mapping[str, object]] = {}
    for item in getattr(snapshot, "file_before"):
        before_by_key[(str(item["root"]), str(item["logical_path"]))] = item
    files: list[ReleaseFile] = []
    for item in getattr(staged, "staged_files"):
        key = (str(item["root"]), str(item["logical_path"]))
        before = before_by_key.get(key)
        if before is None:
            raise ReleaseError(f"snapshot lacks staged file: {key[0]}:{key[1]}")
        before_raw = before.get("bytes")
        if before_raw is not None and not isinstance(before_raw, bytes):
            raise ReleaseError(f"snapshot before bytes are invalid: {key[0]}:{key[1]}")
        files.append(ReleaseFile(
            root=key[0],  # type: ignore[arg-type]
            logical_path=key[1],
            live_path=Path(str(before["live_path"])),
            staged_path=Path(str(item["path"])),
            before_raw=before_raw,
            after_sha256=str(item["sha256"]),
            after_size=int(item["size"]),
        ))
    archives: list[ProvisionalArchive] = []
    for item in getattr(staged, "provisional_archives"):
        members = item["members"]
        if not isinstance(members, (list, tuple)):
            raise ReleaseError("provisional archive members are invalid")
        archives.append(ProvisionalArchive(
            root=str(item["root"]),  # type: ignore[arg-type]
            path=Path(str(item["path"])),
            sha256=str(item["sha256"]),
            size=int(item["size"]),
            members=tuple(str(member) for member in members),
        ))
    return ReleasePayload(
        package_id=package_id,
        package_manifest_sha256=str(
            getattr(prepared, "package_manifest_sha256")
        ),
        expected_base=getattr(prepared, "release_base"),
        files=tuple(files),
        provisional_archives=tuple(archives),
    )


def prepare_runtime_release(
    package_dir: Path,
    *,
    installed_package_dir: Path | None = None,
    live_roots: character_pack.LiveRoots,
    cdn_root: Path,
    canonical_base_version: str,
    staging_root: Path,
    snapshot_root: Path,
    available_capabilities: tuple[str, ...] = ("dual_form_v1",),
) -> PreparedRuntimeRelease:
    import wf_seris_release_pack as seris_release_pack

    package_dir = Path(package_dir)
    errors = seris_release_pack.validate_runtime_test_package(package_dir)
    if errors:
        raise ReleaseError(
            "runtime-test package validation failed:\n- " + "\n- ".join(errors)
        )
    manifest = character_pack.load_manifest(package_dir / "manifest.json")
    installed_manifest, installed_package_dir = _load_installed_package(
        installed_package_dir
    )
    qa = manifest.get("qa")
    if (
        not isinstance(qa, dict)
        or qa.get("delivery_mode") != "runtime_test"
        or qa.get("user_authorized_direct_real_test") is not True
        or qa.get("release_ready") is not False
    ):
        raise ReleaseError("runtime-test authorization contract is missing")
    staging_root = Path(staging_root)
    snapshot_root = Path(snapshot_root)
    staging_root.mkdir(parents=True, exist_ok=True)
    snapshot_root.mkdir(parents=True, exist_ok=True)
    provider = ActiveReleaseStore(
        Path(cdn_root), canonical_base_version=canonical_base_version
    )
    transaction = character_pack.PackTransaction(
        package_dir,
        manifest,
        live_roots=live_roots,
        release_base_provider=provider,
        codec_registry={"json_object": JsonObjectCodec()},
        installed_manifest=installed_manifest,
        installed_package_dir=installed_package_dir,
        available_capabilities=available_capabilities,
        snapshot_roots=(snapshot_root,),
    )
    preflight = transaction.preflight()
    if not preflight.can_prepare:
        conflicts = [str(item.get("claim", item)) for item in preflight.conflicts]
        raise ReleaseError(
            "runtime-test package preflight rejected"
            + (": " + "; ".join(conflicts) if conflicts else "")
        )
    prepared: character_pack.PreparedPack | None = None
    staged: character_pack.StagedPack | None = None
    try:
        prepared = transaction.prepare(staging_root)
        snapshot = transaction.snapshot(snapshot_root)
        staged = transaction.materialize_staging(prepared)
        payload = release_payload_from_records(
            manifest, prepared, staged, snapshot
        )
        AtomicReleasePublisher._validate_payload(payload)
        return PreparedRuntimeRelease(
            transaction=transaction,
            preflight=preflight,
            prepared=prepared,
            snapshot=snapshot,
            staged=staged,
            payload=payload,
        )
    except Exception:
        if staged is not None:
            try:
                transaction.discard_staging(staged)
            except Exception:
                pass
        raise


def close_prepared_runtime_release(
    prepared_release: PreparedRuntimeRelease,
    *,
    discard_staging: bool,
) -> None:
    """Close Windows authorities after publish while retaining snapshot bytes."""
    errors: list[str] = []
    if discard_staging:
        try:
            prepared_release.transaction.discard_staging(prepared_release.staged)
        except Exception as exc:
            errors.append(f"discard staging: {exc}")
    authorities = getattr(prepared_release.transaction, "_snapshot_authorities", None)
    if isinstance(authorities, list):
        for owned_fs, _owned_dir in list(authorities):
            try:
                owned_fs.abandon()
            except Exception as exc:
                errors.append(f"close snapshot authority: {exc}")
        authorities.clear()
    if errors:
        raise ReleaseError("prepared release cleanup failed: " + "; ".join(errors))


def _canonical(value: object) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def _sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _read(path: Path) -> bytes | None:
    try:
        return path.read_bytes()
    except FileNotFoundError:
        return None


def _bump(version: str) -> str:
    if VERSION_RE.fullmatch(version) is None:
        raise ReleaseError(f"invalid version: {version}")
    major, minor, patch = (int(part) for part in version.split("."))
    return f"{major}.{minor}.{patch + 1}"


def _compare_version(left: str, right: str) -> int:
    left_parts = tuple(int(part) for part in left.split("."))
    right_parts = tuple(int(part) for part in right.split("."))
    return (left_parts > right_parts) - (left_parts < right_parts)


def detect_canonical_base_version(cdn_root: Path, repo_root: Path) -> str:
    active_path = Path(cdn_root) / "character-releases" / "active.json"
    try:
        active = _strict_object(active_path.read_bytes(), "active.json anchor")
    except FileNotFoundError:
        active = None
    if active is not None:
        if set(active) not in (
            {"schema_version", "base_version", "releases"},
            {
                "schema_version", "base_version", "base_package_owners",
                "releases",
            },
        ) \
                or active.get("schema_version") != 1:
            raise ReleaseError("active.json anchor fields are invalid")
        _validate_base_package_owners(active)
        base = active.get("base_version")
        releases = active.get("releases")
        if not isinstance(base, str) or VERSION_RE.fullmatch(base) is None \
                or not isinstance(releases, list):
            raise ReleaseError("active.json anchor is invalid")
        expected = base
        for index, release in enumerate(releases):
            if not isinstance(release, dict) \
                    or release.get("from_version") != expected \
                    or release.get("version") != _bump(expected):
                raise ReleaseError(
                    f"active.json anchor release[{index}] breaks the version chain"
                )
            expected = release["version"]
        return base

    best = "1.4.0"
    for directory in ROOT_DIRS.values():
        try:
            names = tuple((Path(cdn_root) / directory).iterdir())
        except FileNotFoundError:
            names = ()
        for path in names:
            if not path.is_file() or "-charpkg-" in path.name:
                continue
            match = LEGACY_ARCHIVE_RE.fullmatch(path.name)
            if match and _compare_version(match.group(2), best) > 0:
                best = match.group(2)
    patch_manifest = Path(repo_root) / "assets" / "asset-patch" / "manifest.json"
    try:
        patches = _strict_object(patch_manifest.read_bytes(), "asset patch manifest").get(
            "patches", []
        )
    except FileNotFoundError:
        patches = []
    if isinstance(patches, list):
        for patch in patches:
            if not isinstance(patch, dict) or not patch.get("enabled") \
                    or patch.get("type") != "patch":
                continue
            version = patch.get("version")
            if isinstance(version, str) and VERSION_RE.fullmatch(version) \
                    and _compare_version(version, best) > 0:
                best = version
    return best


def _safe_relative(value: str) -> bool:
    if not isinstance(value, str) or not value or "\\" in value:
        return False
    path = PurePosixPath(value)
    return not path.is_absolute() and all(part not in {"", ".", ".."} for part in path.parts)


def _fsync_directory(path: Path) -> None:
    if os.name == "nt":
        return
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _atomic_write(path: Path, raw: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temp = Path(temp_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
        _fsync_directory(path.parent)
    except Exception:
        try:
            temp.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def _atomic_commit_write(
    path: Path,
    raw: bytes,
    *,
    replaced: Callable[[], None],
) -> None:
    """Mark the visibility commit immediately after ``os.replace`` succeeds."""
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temp = Path(temp_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
        replaced()
        _fsync_directory(path.parent)
    except Exception:
        try:
            temp.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def _atomic_commit_delete(
    path: Path,
    expected_raw: bytes | None,
    *,
    deleted: Callable[[], None],
) -> None:
    """Delete one validated live path and expose it to rollback bookkeeping."""
    if _read(path) != expected_raw:
        raise ReleaseError(f"live payload drift before delete: {path}")
    path.unlink()
    deleted()
    _fsync_directory(path.parent)


def _strict_object(raw: bytes, label: str) -> dict:
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ReleaseError(f"{label}: duplicate key {key!r}")
            result[key] = value
        return result

    try:
        value = json.loads(raw, object_pairs_hook=pairs)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise ReleaseError(f"{label}: invalid JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise ReleaseError(f"{label}: object required")
    return value


def rebase_runtime_package(
    package_dir: Path,
    output_dir: Path,
    *,
    live_roots: character_pack.LiveRoots,
    generator_git_head: str,
) -> RuntimeRebaseResult:
    """Create a package whose declared full tables preserve the current live baseline."""
    import wf_mod_tool as core
    import wf_seris_release_pack as release_pack

    package_dir = Path(package_dir)
    output_dir = Path(output_dir)
    if re.fullmatch(r"[0-9a-f]{40}", generator_git_head) is None:
        raise ReleaseError("runtime rebase git head must be 40 lowercase hex characters")
    manifest = character_pack.load_manifest(package_dir / "manifest.json")
    mode = _validate_qa_contract(manifest)

    def validate(candidate: Path) -> list[str]:
        if mode == "runtime_test":
            return release_pack.validate_runtime_test_package(candidate)
        candidate_manifest = character_pack.load_manifest(candidate / "manifest.json")
        candidate_errors = character_pack.validate_manifest(candidate_manifest, candidate)
        try:
            _validate_qa_contract(candidate_manifest)
        except ReleaseError as exc:
            candidate_errors.append(str(exc))
        return sorted(set(candidate_errors))

    errors = validate(package_dir)
    if errors:
        raise ReleaseError("package is invalid before rebase:\n- " + "\n- ".join(errors))
    if output_dir.exists():
        raise ReleaseError("runtime rebase output already exists")
    source_resolved = package_dir.resolve()
    output_parent = output_dir.parent.resolve()
    output_resolved = output_parent / output_dir.name
    try:
        output_resolved.relative_to(source_resolved)
    except ValueError:
        pass
    else:
        raise ReleaseError("runtime rebase output may not be inside the source package")
    manifest_path = package_dir / "manifest.json"
    source_manifest_raw = manifest_path.read_bytes()
    claims = character_pack._parse_transaction_claims(manifest)  # type: ignore[attr-defined]
    source_files = release_pack._scan_files(package_dir)  # type: ignore[attr-defined]
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(
        prefix=f".{output_dir.name}.live-rebase-", dir=output_dir.parent
    ))
    try:
        for relative in sorted(source_files - {"manifest.json"}):
            release_pack._copy_exact(  # type: ignore[attr-defined]
                package_dir / Path(*PurePosixPath(relative).parts),
                staging / Path(*PurePosixPath(relative).parts),
                anchor=package_dir,
            )

        root_entries: dict[tuple[str, str], dict] = {}
        roots = manifest.get("roots")
        if not isinstance(roots, dict):
            raise ReleaseError("runtime package roots are invalid")
        for root_name, entries in roots.items():
            if not isinstance(root_name, str) or not isinstance(entries, list):
                raise ReleaseError("runtime package root inventory is invalid")
            for entry in entries:
                if not isinstance(entry, dict) or not isinstance(entry.get("logical_path"), str):
                    raise ReleaseError("runtime package root entry is invalid")
                root_entries[(root_name, entry["logical_path"])] = entry

        rebase_facts: list[dict] = []
        for (root_name, logical), claim in sorted(claims.items()):
            if root_name == "common":
                live_path = core.table_path(Path(live_roots.common), logical)
            elif root_name == "server":
                live_path = Path(live_roots.server) / Path(*logical.split("/"))
            else:
                raise ReleaseError(
                    f"runtime table rebase supports common/server only: {root_name}:{logical}"
                )
            try:
                live_raw = live_path.read_bytes()
            except OSError as exc:
                raise ReleaseError(f"cannot read live table for rebase: {root_name}:{logical}: {exc}") from exc
            candidate_path = staging / "roots" / root_name / Path(*logical.split("/"))
            candidate_raw = candidate_path.read_bytes()
            merged_raw = _merge_claimed_table_bytes(claim, candidate_raw, live_raw)
            _atomic_write(candidate_path, merged_raw)
            entry = root_entries.get((root_name, logical))
            if entry is None:
                raise ReleaseError(f"table rebase lacks root inventory entry: {root_name}:{logical}")
            entry["sha256"] = _sha256(merged_raw)
            entry["size"] = len(merged_raw)
            rebase_facts.append({
                "root": root_name,
                "logical_path": logical,
                "live_before_sha256": _sha256(live_raw),
                "live_before_size": len(live_raw),
                "rebased_sha256": _sha256(merged_raw),
                "rebased_size": len(merged_raw),
            })

        snapshot = manifest.get("snapshot")
        if not isinstance(snapshot, dict):
            raise ReleaseError("runtime package snapshot is invalid")
        snapshot["generator_git_head"] = generator_git_head
        snapshot["runtime_rebase"] = {
            "source_manifest_sha256": _sha256(source_manifest_raw),
            "tables": rebase_facts,
        }
        manifest_raw = character_pack.canonical_manifest_bytes(manifest)
        _atomic_write(staging / "manifest.json", manifest_raw)
        staged_errors = validate(staging)
        if staged_errors:
            raise ReleaseError(
                "rebased package validation failed:\n- "
                + "\n- ".join(staged_errors)
            )
        os.replace(staging, output_dir)
        final_errors = validate(output_dir)
        if final_errors:
            raise ReleaseError(
                "renamed rebased package validation failed:\n- "
                + "\n- ".join(final_errors)
            )
        return RuntimeRebaseResult(
            output_dir=output_dir,
            source_manifest_sha256=_sha256(source_manifest_raw),
            manifest_sha256=_sha256(manifest_raw),
            table_count=len(rebase_facts),
        )
    except Exception:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
        if output_dir.exists():
            shutil.rmtree(output_dir, ignore_errors=True)
        raise


ROLLBACK_PACKAGE_SUFFIX = character_pack.ROLLBACK_PACKAGE_SUFFIX


def _validate_base_package_owners(
    manifest: dict,
) -> tuple[tuple[str, str], ...]:
    raw = manifest.get("base_package_owners", [])
    if not isinstance(raw, list):
        raise ReleaseError("active.json base package owners are invalid")
    pairs: list[tuple[str, str]] = []
    seen: set[str] = set()
    for item in raw:
        if (
            not isinstance(item, list)
            or len(item) != 2
            or not isinstance(item[0], str)
            or TOKEN_RE.fullmatch(item[0]) is None
            or item[0].endswith(ROLLBACK_PACKAGE_SUFFIX)
            or item[0] in seen
            or not isinstance(item[1], str)
            or HASH_RE.fullmatch(item[1]) is None
        ):
            raise ReleaseError("active.json base package owners are invalid")
        seen.add(item[0])
        pairs.append((item[0], item[1]))
    if pairs != sorted(pairs):
        raise ReleaseError("active.json base package owners are not canonical")
    return tuple(pairs)


def derive_package_owners(
    releases: list[dict],
    *,
    base_package_owners: tuple[tuple[str, str], ...] = (),
) -> tuple[tuple[str, str], ...]:
    """从 active 链推导每个 package_id 当前生效的 manifest 哈希。

    正常条目把该包的哈希压栈；`<pkg>-rollback` 条目（snapshot 回滚增量）弹出
    源包最近一次发布，使所有权回退到上一版（无上一版则该包不再是所有者）。
    """
    stacks: dict[str, list[str]] = {
        package_id: [manifest_hash]
        for package_id, manifest_hash in base_package_owners
    }
    for index, release in enumerate(releases):
        package_id = release["package_id"]
        if package_id.endswith(ROLLBACK_PACKAGE_SUFFIX):
            source = package_id[: -len(ROLLBACK_PACKAGE_SUFFIX)]
            stack = stacks.get(source)
            if not stack:
                raise ReleaseError(
                    f"active.json releases[{index}]: rollback entry has no "
                    f"matching source release for {source}"
                )
            stack.pop()
        else:
            stacks.setdefault(package_id, []).append(
                release["package_manifest_sha256"]
            )
    return tuple(sorted(
        (package_id, stack[-1])
        for package_id, stack in stacks.items() if stack
    ))


class ActiveReleaseStore:
    def __init__(self, cdn_root: Path, *, canonical_base_version: str):
        self.cdn_root = Path(cdn_root)
        self.canonical_base_version = canonical_base_version
        if VERSION_RE.fullmatch(canonical_base_version) is None:
            raise ReleaseError("canonical base version is invalid")
        self.active_path = self.cdn_root / "character-releases" / "active.json"

    def read_manifest(self) -> tuple[bytes | None, dict | None]:
        raw = _read(self.active_path)
        if raw is None:
            return None, None
        manifest = _strict_object(raw, "active.json")
        if set(manifest) not in (
            {"schema_version", "base_version", "releases"},
            {
                "schema_version", "base_version", "base_package_owners",
                "releases",
            },
        ):
            raise ReleaseError("active.json fields are invalid")
        if manifest["schema_version"] != 1 or type(manifest["schema_version"]) is not int:
            raise ReleaseError("active.json schema_version must be 1")
        if manifest["base_version"] != self.canonical_base_version:
            raise ReleaseError("active.json base_version is detached from the canonical legacy tail")
        _validate_base_package_owners(manifest)
        releases = manifest["releases"]
        if not isinstance(releases, list):
            raise ReleaseError("active.json releases must be an array")
        expected_from = self.canonical_base_version
        seen_ids: set[str] = set()
        for index, release in enumerate(releases):
            label = f"active.json releases[{index}]"
            required = {
                "release_id", "package_id", "from_version", "version",
                "package_manifest_sha256", "archives",
            }
            if not isinstance(release, dict) or set(release) != required:
                raise ReleaseError(f"{label}: fields are invalid")
            release_id = release["release_id"]
            package_id = release["package_id"]
            if (
                not isinstance(release_id, str)
                or TOKEN_RE.fullmatch(release_id) is None
                or release_id in seen_ids
            ):
                raise ReleaseError(f"{label}: release_id is invalid")
            seen_ids.add(release_id)
            if not isinstance(package_id, str) or TOKEN_RE.fullmatch(package_id) is None:
                raise ReleaseError(f"{label}: package_id is invalid")
            if release["from_version"] != expected_from:
                raise ReleaseError(f"{label}: from_version breaks the continuous chain")
            if release["version"] != _bump(expected_from):
                raise ReleaseError(f"{label}: version is not the next patch version")
            if not isinstance(release["package_manifest_sha256"], str) \
                    or HASH_RE.fullmatch(release["package_manifest_sha256"]) is None:
                raise ReleaseError(f"{label}: package manifest hash is invalid")
            archives = release["archives"]
            if not isinstance(archives, list) or len(archives) != 3:
                raise ReleaseError(f"{label}: exactly three archives are required")
            seen_roots: set[str] = set()
            for archive in archives:
                if not isinstance(archive, dict) or set(archive) != {
                    "root", "relative_path", "size", "sha256"
                }:
                    raise ReleaseError(f"{label}: archive fields are invalid")
                root = archive["root"]
                relative = archive["relative_path"]
                if root not in CLIENT_ROOTS or root in seen_roots:
                    raise ReleaseError(f"{label}: archive root is invalid")
                seen_roots.add(root)
                if not _safe_relative(relative) or not relative.startswith(ROOT_DIRS[root] + "/"):
                    raise ReleaseError(f"{label}: archive relative path is invalid")
                filename = PurePosixPath(relative).name
                expected_name = (
                    f"pinball-{expected_from}-{release['version']}-1-charpkg-"
                    f"{package_id}-{release_id}-{root}.zip"
                )
                if filename != expected_name:
                    raise ReleaseError(f"{label}: archive filename is invalid")
                path = self.cdn_root / Path(*PurePosixPath(relative).parts)
                raw_archive = _read(path)
                if raw_archive is None:
                    raise ReleaseError(f"{label}: archive is missing: {relative}")
                if (
                    type(archive["size"]) is not int
                    or archive["size"] <= 0
                    or len(raw_archive) != archive["size"]
                    or not isinstance(archive["sha256"], str)
                    or HASH_RE.fullmatch(archive["sha256"]) is None
                    or _sha256(raw_archive) != archive["sha256"]
                ):
                    raise ReleaseError(f"{label}: archive hash/size mismatch: {relative}")
                try:
                    with zipfile.ZipFile(io.BytesIO(raw_archive), "r") as opened:
                        opened.testzip()
                except (OSError, zipfile.BadZipFile) as exc:
                    raise ReleaseError(f"{label}: archive is invalid: {relative}") from exc
            expected_from = release["version"]
        return raw, manifest

    def read_validated_base(self) -> character_pack.ReleaseBaseState:
        raw, manifest = self.read_manifest()
        if raw is None or manifest is None:
            return character_pack.ReleaseBaseState(
                active_raw=None,
                active_sha256=None,
                current_release_id=None,
                validated_chain_tail=self.canonical_base_version,
                expected_from_version=self.canonical_base_version,
                active_package_manifest_sha256=None,
                package_owners=(),
            )
        base_package_owners = _validate_base_package_owners(manifest)
        releases = manifest["releases"]
        package_owners = derive_package_owners(
            releases, base_package_owners=base_package_owners
        )
        if not releases:
            return character_pack.ReleaseBaseState(
                active_raw=raw,
                active_sha256=_sha256(raw),
                current_release_id=None,
                validated_chain_tail=self.canonical_base_version,
                expected_from_version=self.canonical_base_version,
                active_package_manifest_sha256=None,
                package_owners=package_owners,
            )
        last = releases[-1]
        return character_pack.ReleaseBaseState(
            active_raw=raw,
            active_sha256=_sha256(raw),
            current_release_id=last["release_id"],
            validated_chain_tail=last["version"],
            expected_from_version=last["version"],
            active_package_manifest_sha256=last["package_manifest_sha256"],
            package_owners=package_owners,
        )


@contextmanager
def _release_lock(path: Path) -> Iterator[None]:
    path.parent.mkdir(parents=True, exist_ok=True)
    stream = path.open("a+b")
    try:
        stream.seek(0, os.SEEK_END)
        if stream.tell() == 0:
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        if os.name == "nt":
            import msvcrt
            try:
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as exc:
                raise ReleaseError("CHARACTER_RELEASE_LOCKED") from exc
        else:
            import fcntl
            try:
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as exc:
                raise ReleaseError("CHARACTER_RELEASE_LOCKED") from exc
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
    finally:
        stream.close()


class AtomicReleasePublisher:
    def __init__(
        self,
        cdn_root: Path,
        *,
        canonical_base_version: str,
        release_id_factory: Callable[[], str] | None = None,
    ):
        self.cdn_root = Path(cdn_root)
        self.store = ActiveReleaseStore(
            self.cdn_root, canonical_base_version=canonical_base_version
        )
        self.release_id_factory = release_id_factory or self._new_release_id
        self.lock_path = self.cdn_root / ".character-release.lock"

    @staticmethod
    def _new_release_id() -> str:
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dt%H%M%Sz").lower()
        return f"{timestamp}-{uuid.uuid4().hex[:8]}"

    @staticmethod
    def _checkpoint(fail_after: str | None, phase: str) -> None:
        if fail_after == phase:
            raise RuntimeError(f"injected release failure after {phase}")

    @staticmethod
    def _validate_payload(payload: ReleasePayload, *, check_live: bool = True) -> None:
        if TOKEN_RE.fullmatch(payload.package_id) is None:
            raise ReleaseError("package_id is invalid")
        if HASH_RE.fullmatch(payload.package_manifest_sha256) is None:
            raise ReleaseError("package manifest hash is invalid")
        if not payload.files:
            raise ReleaseError("release payload has no files")
        if {archive.root for archive in payload.provisional_archives} != set(CLIENT_ROOTS) \
                or len(payload.provisional_archives) != 3:
            raise ReleaseError("release payload requires exactly three root archives")
        seen_live: set[Path] = set()
        for item in payload.files:
            if item.root not in (*CLIENT_ROOTS, "server"):
                raise ReleaseError("release file root is invalid")
            live = item.live_path.resolve()
            if live in seen_live:
                raise ReleaseError("release payload repeats a live path")
            seen_live.add(live)
            staged = item.staged_path.read_bytes()
            if item.delete_after:
                if staged != b"" or item.after_size != 0 \
                        or item.after_sha256 != _sha256(b""):
                    raise ReleaseError(
                        f"invalid staged delete marker: {item.root}:{item.logical_path}"
                    )
            elif len(staged) != item.after_size or _sha256(staged) != item.after_sha256:
                raise ReleaseError(f"staged payload drift: {item.root}:{item.logical_path}")
            if check_live and _read(item.live_path) != item.before_raw:
                raise ReleaseError(f"live payload drift: {item.root}:{item.logical_path}")
        for archive in payload.provisional_archives:
            raw = archive.path.read_bytes()
            if len(raw) != archive.size or _sha256(raw) != archive.sha256:
                raise ReleaseError(f"provisional archive drift: {archive.root}")
            try:
                with zipfile.ZipFile(io.BytesIO(raw), "r") as opened:
                    if tuple(opened.namelist()) != archive.members or opened.testzip() is not None:
                        raise ReleaseError(f"provisional archive content drift: {archive.root}")
                    prefix = ARCHIVE_PREFIXES[archive.root]
                    if any(not member.startswith(prefix) for member in archive.members):
                        raise ReleaseError(f"provisional archive root mismatch: {archive.root}")
            except zipfile.BadZipFile as exc:
                raise ReleaseError(f"provisional archive is invalid: {archive.root}") from exc

    def _journal_path(self, release_id: str) -> Path:
        return self.cdn_root / "character-releases" / "recovery" / f"journal-{release_id}.json"

    def publish(
        self,
        payload: ReleasePayload,
        *,
        server_running: Callable[[], bool],
        fail_after: str | None = None,
        prepare_live_guard: Callable[[], Callable[[], None] | None] | None = None,
    ) -> ReleaseResult:
        self._validate_payload(payload, check_live=False)
        with _release_lock(self.lock_path):
            current = self.store.read_validated_base()
            if current != payload.expected_base:
                raise ReleaseError("STALE_RELEASE_BASE")
            self._validate_payload(payload, check_live=True)
            if server_running():
                raise ReleaseError("SERVER_RESTART_REQUIRED")
            from_version = current.expected_from_version
            version = _bump(from_version)
            release_id = self.release_id_factory()
            if not isinstance(release_id, str) or TOKEN_RE.fullmatch(release_id) is None:
                raise ReleaseError("release_id factory returned an unsafe token")
            final_archives: list[tuple[ProvisionalArchive, Path, str]] = []
            archive_records: list[dict] = []
            for archive in sorted(payload.provisional_archives, key=lambda item: item.root):
                filename = (
                    f"pinball-{from_version}-{version}-1-charpkg-{payload.package_id}-"
                    f"{release_id}-{archive.root}.zip"
                )
                relative = f"{ROOT_DIRS[archive.root]}/{filename}"
                target = self.cdn_root / ROOT_DIRS[archive.root] / filename
                if target.exists():
                    raise ReleaseError(f"final archive already exists: {target}")
                final_archives.append((archive, target, relative))
                archive_records.append({
                    "root": archive.root,
                    "relative_path": relative,
                    "size": archive.size,
                    "sha256": archive.sha256,
                })
            existing_raw, existing_manifest = self.store.read_manifest()
            active = (
                json.loads(_canonical(existing_manifest))
                if existing_manifest is not None
                else {
                    "schema_version": 1,
                    "base_version": self.store.canonical_base_version,
                    "releases": [],
                }
            )
            release_record = {
                "release_id": release_id,
                "package_id": payload.package_id,
                "from_version": from_version,
                "version": version,
                "package_manifest_sha256": payload.package_manifest_sha256,
                "archives": archive_records,
            }
            active["releases"].append(release_record)
            active_raw = _canonical(active)
            journal = self._journal_path(release_id)
            journal_value = {
                "schema_version": 1,
                "release_id": release_id,
                "commit_point": "active_json_replace",
                "committed": False,
                "active_before_base64": (
                    base64.b64encode(existing_raw).decode("ascii")
                    if existing_raw is not None else None
                ),
                "active_after_sha256": _sha256(active_raw),
                "files": [{
                    "root": item.root,
                    "logical_path": item.logical_path,
                    "live_path": str(item.live_path),
                    "before_base64": (
                        base64.b64encode(item.before_raw).decode("ascii")
                        if item.before_raw is not None else None
                    ),
                    "after_sha256": item.after_sha256,
                    "delete_after": item.delete_after,
                } for item in payload.files],
                "archives": [str(target) for _archive, target, _relative in final_archives],
            }
            committed = False
            promoted_files: list[ReleaseFile] = []
            promoted_archives: list[Path] = []
            guard_rollback = (
                prepare_live_guard() if prepare_live_guard is not None else None
            )
            try:
                _atomic_write(journal, _canonical(journal_value))
                self._checkpoint(fail_after, "after_journal_fsync")
                for index, item in enumerate(payload.files):
                    def mark_live_replaced(item: ReleaseFile = item) -> None:
                        promoted_files.append(item)

                    if item.delete_after:
                        _atomic_commit_delete(
                            item.live_path,
                            item.before_raw,
                            deleted=mark_live_replaced,
                        )
                        if item.live_path.exists():
                            raise ReleaseError(
                                f"live deletion readback failed: {item.live_path}"
                            )
                    else:
                        _atomic_commit_write(
                            item.live_path,
                            item.staged_path.read_bytes(),
                            replaced=mark_live_replaced,
                        )
                        readback = item.live_path.read_bytes()
                        if len(readback) != item.after_size \
                                or _sha256(readback) != item.after_sha256:
                            raise ReleaseError(
                                f"live promotion readback failed: {item.live_path}"
                            )
                    self._checkpoint(fail_after, f"after_live_{index}")
                self._checkpoint(fail_after, "after_live_promotions")
                for index, (archive, target, _relative) in enumerate(final_archives):
                    def mark_archive_replaced(target: Path = target) -> None:
                        promoted_archives.append(target)

                    _atomic_commit_write(
                        target,
                        archive.path.read_bytes(),
                        replaced=mark_archive_replaced,
                    )
                    raw = target.read_bytes()
                    if len(raw) != archive.size or _sha256(raw) != archive.sha256:
                        raise ReleaseError(f"archive promotion readback failed: {target}")
                    self._checkpoint(fail_after, f"after_archive_{index}")
                self._checkpoint(fail_after, "after_archive_moves")
                self._checkpoint(fail_after, "before_active_replace")
                def mark_committed() -> None:
                    nonlocal committed
                    committed = True

                _atomic_commit_write(
                    self.store.active_path,
                    active_raw,
                    replaced=mark_committed,
                )
                self._checkpoint(fail_after, "after_active_replace")
                readback_state = self.store.read_validated_base()
                if (
                    readback_state.current_release_id != release_id
                    or readback_state.active_sha256 != _sha256(active_raw)
                ):
                    raise CommittedReleaseError("committed active manifest readback failed")
                journal.unlink(missing_ok=True)
                _fsync_directory(journal.parent)
                return ReleaseResult(
                    committed=True,
                    release_id=release_id,
                    from_version=from_version,
                    version=version,
                    active_manifest_sha256=_sha256(active_raw),
                    archive_paths=tuple(target for _archive, target, _relative in final_archives),
                )
            except Exception as exc:
                cleanup_errors: list[str] = []
                if committed:
                    try:
                        journal.unlink(missing_ok=True)
                    except OSError as cleanup_exc:
                        cleanup_errors.append(str(cleanup_exc))
                    detail = f"release committed; recovery cleanup only: {exc}"
                    if cleanup_errors:
                        detail += "; cleanup errors: " + "; ".join(cleanup_errors)
                    raise CommittedReleaseError(detail) from exc
                for item in reversed(promoted_files):
                    try:
                        if item.before_raw is None:
                            item.live_path.unlink(missing_ok=True)
                        else:
                            _atomic_write(item.live_path, item.before_raw)
                    except Exception as cleanup_exc:
                        cleanup_errors.append(f"restore {item.live_path}: {cleanup_exc}")
                for target in reversed(promoted_archives):
                    try:
                        target.unlink(missing_ok=True)
                    except Exception as cleanup_exc:
                        cleanup_errors.append(f"remove {target}: {cleanup_exc}")
                if guard_rollback is not None:
                    try:
                        guard_rollback()
                    except Exception as cleanup_exc:
                        cleanup_errors.append(
                            f"rollback prepared live guard: {cleanup_exc}"
                        )
                try:
                    journal.unlink(missing_ok=True)
                except Exception as cleanup_exc:
                    cleanup_errors.append(f"remove journal: {cleanup_exc}")
                detail = str(exc)
                if cleanup_errors:
                    detail += "; rollback errors: " + "; ".join(cleanup_errors)
                raise ReleaseError(detail) from exc


def _repo_paths(profile_id: str) -> tuple[Path, character_pack.LiveRoots, Path]:
    if profile_id != "cn":
        raise ReleaseError("character release is CN-only")
    import wf_mod_tool as core

    repo_root = Path(__file__).resolve().parent.parent
    profile = core.resolve_profile("cn")
    if profile is None or profile.id != "cn" or not Path(profile.store).is_dir():
        raise ReleaseError("active CN profile/store is unavailable")
    store = Path(profile.store).resolve()
    cdn_root = Path(os.environ.get("WF_CDN_DIR", repo_root / ".cdn" / "cn")).resolve()
    live_roots = character_pack.LiveRoots(
        common=store,
        medium=store.parent / "medium_upload",
        android=store.parent / "android_upload",
        server=repo_root / "assets",
        protected=(cdn_root,),
    )
    return repo_root, live_roots, cdn_root


def _current_git_head(repo_root: Path) -> str:
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=Path(repo_root),
        capture_output=True,
        text=True,
        check=False,
    )
    head = result.stdout.strip().lower()
    if result.returncode != 0 or re.fullmatch(r"[0-9a-f]{40}", head) is None:
        detail = result.stderr.strip() or "git rev-parse HEAD failed"
        raise ReleaseError(f"cannot determine generator git head: {detail}")
    return head


def rebase_package(
    package_dir: Path,
    profile_id: str,
    *,
    output_dir: Path,
    generator_git_head: str | None = None,
) -> RuntimeRebaseResult:
    """Rebase declared runtime-table rows without touching live roots."""
    repo_root, live_roots, _cdn_root = _repo_paths(profile_id)
    git_head = generator_git_head or _current_git_head(repo_root)
    return rebase_runtime_package(
        Path(package_dir),
        Path(output_dir),
        live_roots=live_roots,
        generator_git_head=git_head,
    )


def _server_running(repo_root: Path) -> bool:
    values: dict[str, str] = {}
    env_path = repo_root / ".env"
    try:
        lines = env_path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        lines = []
    except PermissionError:
        if not (
            os.environ.get("CN_LISTEN_HOST")
            and os.environ.get("CN_LISTEN_PORT")
        ):
            raise
        lines = []
    for line in lines:
        token = line.strip()
        if not token or token.startswith("#") or "=" not in token:
            continue
        key, value = token.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    host = os.environ.get("CN_LISTEN_HOST") or values.get("CN_LISTEN_HOST") or "127.0.0.1"
    port_token = os.environ.get("CN_LISTEN_PORT") or values.get("CN_LISTEN_PORT") or "8001"
    if host in {"0.0.0.0", "::"}:
        host = "127.0.0.1"
    try:
        with socket.create_connection((host, int(port_token)), timeout=0.3):
            return True
    except (OSError, ValueError):
        return False


def _load_installed_package(
    installed_package_dir: Path | None,
) -> tuple[dict | None, Path | None]:
    if installed_package_dir is None:
        return None, None
    installed_package_dir = Path(installed_package_dir)
    installed_manifest = character_pack.load_manifest(
        installed_package_dir / "manifest.json"
    )
    errors = character_pack.validate_manifest(
        installed_manifest, installed_package_dir
    )
    if errors:
        raise ReleaseError(
            "installed package invalid:\n- " + "\n- ".join(errors)
        )
    return installed_manifest, installed_package_dir


def _new_transaction(
    package_dir: Path,
    live_roots: character_pack.LiveRoots,
    cdn_root: Path,
    canonical_base: str,
    *,
    installed_package_dir: Path | None = None,
) -> tuple[dict, character_pack.PackTransaction]:
    import wf_seris_release_pack as seris_release_pack

    errors = seris_release_pack.validate_runtime_test_package(package_dir)
    if errors:
        raise ReleaseError("runtime-test package invalid:\n- " + "\n- ".join(errors))
    manifest = character_pack.load_manifest(package_dir / "manifest.json")
    installed_manifest, installed_package_dir = _load_installed_package(
        installed_package_dir
    )
    transaction = character_pack.PackTransaction(
        package_dir,
        manifest,
        live_roots=live_roots,
        release_base_provider=ActiveReleaseStore(
            cdn_root, canonical_base_version=canonical_base
        ),
        codec_registry={"json_object": JsonObjectCodec()},
        installed_manifest=installed_manifest,
        installed_package_dir=installed_package_dir,
        available_capabilities=("dual_form_v1",),
    )
    return manifest, transaction


def _reachable_client_base(
    required_base: str,
    *,
    repo_root: Path,
    cdn_root: Path,
    canonical_base: str,
) -> str:
    """Require an actual archive path from the declared base to the validated tail."""
    if VERSION_RE.fullmatch(required_base) is None:
        raise ReleaseError(
            "production requires_client_base must be a semantic asset version"
        )
    edges: dict[str, set[str]] = {}

    def add_edge(source: str, target: str) -> None:
        edges.setdefault(source, set()).add(target)

    for directory in (
        Path(cdn_root) / ROOT_DIRS["common"],
        Path(repo_root) / "assets" / "asset-patch" / "active",
    ):
        try:
            paths = tuple(directory.iterdir())
        except FileNotFoundError:
            paths = ()
        for path in paths:
            if not path.is_file():
                continue
            match = LEGACY_ARCHIVE_RE.fullmatch(path.name)
            if match:
                add_edge(match.group(1), match.group(2))

    active_store = ActiveReleaseStore(
        Path(cdn_root), canonical_base_version=canonical_base
    )
    _raw, active = active_store.read_manifest()
    target = canonical_base
    if active is not None:
        for release in active["releases"]:
            add_edge(release["from_version"], release["version"])
        target = active["releases"][-1]["version"]

    pending = [required_base]
    visited: set[str] = set()
    while pending:
        current = pending.pop()
        if current in visited:
            continue
        visited.add(current)
        pending.extend(sorted(edges.get(current, ()), reverse=True))
    if target not in visited:
        raise ReleaseError(
            f"requires_client_base {required_base} cannot reach validated tail {target}"
        )
    return target


def _production_workspace_status(package_dir: Path):
    import wf_character_workspace as character_workspace

    package_dir = Path(package_dir)
    if package_dir.name != "package":
        raise ReleaseError("production package must be inside a character workspace")
    try:
        workspace = character_workspace.load_workspace(package_dir.parent)
        status = character_workspace.workspace_status(workspace)
    except character_workspace.WorkspaceError as exc:
        raise ReleaseError(f"production workspace is invalid: {exc}") from exc
    if not status.release_ready:
        details = "; ".join(status.manifest_errors) or \
            ", ".join(status.requirement_report.get("missing_required", ())[:5])
        raise ReleaseError(
            "production workspace is not release-ready"
            + (f": {details}" if details else "")
        )
    return status


def _new_production_transaction(
    package_dir: Path,
    live_roots: character_pack.LiveRoots,
    cdn_root: Path,
    canonical_base: str,
    *,
    installed_package_dir: Path | None = None,
    snapshot_root: Path | None = None,
) -> tuple[dict, character_pack.PackTransaction]:
    package_dir = Path(package_dir)
    manifest = character_pack.load_manifest(package_dir / "manifest.json")
    errors = character_pack.validate_manifest(manifest, package_dir)
    if errors:
        raise ReleaseError("production package invalid:\n- " + "\n- ".join(errors))
    _validate_qa_contract(manifest)
    installed_manifest, installed_package_dir = _load_installed_package(
        installed_package_dir
    )
    transaction = character_pack.PackTransaction(
        package_dir,
        manifest,
        live_roots=live_roots,
        release_base_provider=ActiveReleaseStore(
            cdn_root, canonical_base_version=canonical_base
        ),
        codec_registry={"json_object": JsonObjectCodec()},
        installed_manifest=installed_manifest,
        installed_package_dir=installed_package_dir,
        available_capabilities=(manifest["requires_client_base"],),
        snapshot_roots=((Path(snapshot_root),) if snapshot_root is not None else ()),
    )
    return manifest, transaction


def _prepare_production_release(
    package_dir: Path,
    *,
    installed_package_dir: Path | None,
    live_roots: character_pack.LiveRoots,
    cdn_root: Path,
    canonical_base_version: str,
    staging_root: Path,
    snapshot_root: Path,
) -> PreparedRuntimeRelease:
    manifest, transaction = _new_production_transaction(
        package_dir,
        live_roots,
        cdn_root,
        canonical_base_version,
        installed_package_dir=installed_package_dir,
        snapshot_root=snapshot_root,
    )
    preflight = transaction.preflight()
    if not preflight.can_prepare:
        conflicts = [str(item.get("claim", item)) for item in preflight.conflicts]
        raise ReleaseError(
            "production package preflight rejected"
            + (": " + "; ".join(conflicts) if conflicts else "")
        )
    prepared: character_pack.PreparedPack | None = None
    staged: character_pack.StagedPack | None = None
    try:
        prepared = transaction.prepare(staging_root)
        snapshot = transaction.snapshot(snapshot_root)
        staged = transaction.materialize_staging(prepared)
        payload = release_payload_from_records(manifest, prepared, staged, snapshot)
        AtomicReleasePublisher._validate_payload(payload)
        return PreparedRuntimeRelease(
            transaction=transaction,
            preflight=preflight,
            prepared=prepared,
            snapshot=snapshot,
            staged=staged,
            payload=payload,
        )
    except Exception:
        if staged is not None:
            try:
                transaction.discard_staging(staged)
            except Exception:
                pass
        raise


def preflight_package(
    package_dir: Path,
    profile_id: str,
    installed_package_dir: Path | None = None,
) -> dict:
    """Run the read-only package gate and return a stable JSON-ready report."""
    package_dir = Path(package_dir)
    manifest = character_pack.load_manifest(package_dir / "manifest.json")
    mode = _validate_qa_contract(manifest)
    repo_root, live_roots, cdn_root = _repo_paths(profile_id)
    canonical_base = detect_canonical_base_version(cdn_root, repo_root)
    import wf_release_guard

    charpkg_strand = wf_release_guard.charpkg_strand_report(cdn_root, repo_root)
    if mode == "production":
        status = _production_workspace_status(package_dir)
        tail = _reachable_client_base(
            manifest["requires_client_base"],
            repo_root=repo_root,
            cdn_root=cdn_root,
            canonical_base=canonical_base,
        )
        _manifest, transaction = _new_production_transaction(
            package_dir,
            live_roots,
            cdn_root,
            canonical_base,
            installed_package_dir=installed_package_dir,
        )
    else:
        status = None
        tail = ActiveReleaseStore(
            cdn_root, canonical_base_version=canonical_base
        ).read_validated_base().validated_chain_tail
        _manifest, transaction = _new_transaction(
            package_dir,
            live_roots,
            cdn_root,
            canonical_base,
            installed_package_dir=installed_package_dir,
        )
    report = json.loads(transaction.preflight().canonical_bytes().decode("utf-8"))
    report.update({
        "delivery_mode": mode,
        "release_ready": bool(report.get("can_prepare"))
        and (status.release_ready if status is not None else False),
        "workspace_input_sha256": status.input_digest if status is not None else None,
        "validated_chain_tail": tail,
        "charpkg_strand": charpkg_strand,
        "writes_live": False,
    })
    return report


def publish_package(
    package_dir: Path,
    profile_id: str,
    confirmation: str,
    installed_package_dir: Path | None = None,
) -> ReleaseResult:
    """Publish a production or explicitly authorized runtime-test package."""
    package_dir = Path(package_dir)
    manifest = character_pack.load_manifest(package_dir / "manifest.json")
    mode = _validate_qa_contract(manifest, confirmation=confirmation)
    repo_root, live_roots, cdn_root = _repo_paths(profile_id)
    if _server_running(repo_root):
        raise ReleaseError("CN server must be stopped before character publication")
    canonical_base = detect_canonical_base_version(cdn_root, repo_root)
    # 重锚防孤儿门禁:被 active.json 丢弃的 charpkg 历史必须仍可达 tail,
    # 缺口自动补 charbridge 副本,补不齐则拒绝发布(2026-07-18 链重锚事故)
    import wf_release_guard

    staging_root = repo_root / "work" / "character_releases" / "staging"
    snapshot_root = repo_root / "work" / "character_releases" / "snapshots"
    if mode == "production":
        _production_workspace_status(package_dir)
        _reachable_client_base(
            manifest["requires_client_base"],
            repo_root=repo_root,
            cdn_root=cdn_root,
            canonical_base=canonical_base,
        )
        prepared = _prepare_production_release(
            package_dir,
            installed_package_dir=installed_package_dir,
            live_roots=live_roots,
            cdn_root=cdn_root,
            canonical_base_version=canonical_base,
            staging_root=staging_root,
            snapshot_root=snapshot_root,
        )
    else:
        prepared = prepare_runtime_release(
            package_dir,
            installed_package_dir=installed_package_dir,
            live_roots=live_roots,
            cdn_root=cdn_root,
            canonical_base_version=canonical_base,
            staging_root=staging_root,
            snapshot_root=snapshot_root,
        )

    def prepare_live_guard() -> Callable[[], None] | None:
        report = wf_release_guard.ensure_charpkg_history_bridged(
            cdn_root, repo_root, assume_lock_held=True
        )
        receipts = tuple(report["bridge_receipts"])
        if not receipts:
            return None
        return lambda: wf_release_guard.rollback_charpkg_bridges(
            receipts, cdn_root, assume_lock_held=True
        )

    try:
        result = AtomicReleasePublisher(
            cdn_root, canonical_base_version=canonical_base
        ).publish(
            prepared.payload,
            server_running=lambda: _server_running(repo_root),
            prepare_live_guard=prepare_live_guard,
        )
    except Exception as exc:
        try:
            close_prepared_runtime_release(prepared, discard_staging=True)
        except Exception as cleanup_exc:
            detail = f"{exc}; prepared release cleanup failed: {cleanup_exc}"
            if isinstance(exc, CommittedReleaseError):
                raise CommittedReleaseError(detail) from exc
            raise ReleaseError(detail) from exc
        raise
    try:
        close_prepared_runtime_release(prepared, discard_staging=True)
    except Exception as cleanup_exc:
        if result.committed:
            raise CommittedReleaseError(
                "release committed; prepared release cleanup only: "
                + str(cleanup_exc)
            ) from cleanup_exc
        raise
    return replace(result, snapshot_dir=prepared.snapshot.snapshot_dir)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    for command in ("preflight", "publish"):
        child = sub.add_parser(command)
        child.add_argument("--package-dir", required=True, type=Path)
        child.add_argument("--installed-package-dir", type=Path)
        child.add_argument("--profile", default="cn")
    rebase = sub.add_parser("rebase", help="rebase declared rows onto current live tables")
    rebase.add_argument("--package-dir", required=True, type=Path)
    rebase.add_argument("--output", required=True, type=Path)
    rebase.add_argument("--git-head", required=True)
    rebase.add_argument("--profile", default="cn")
    publish = sub.choices["publish"]
    publish.add_argument("--confirm", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "rebase":
            result = rebase_package(
                args.package_dir,
                args.profile,
                output_dir=args.output,
                generator_git_head=args.git_head,
            )
            print(_canonical({
                "operation": "rebase",
                "output": str(result.output_dir),
                "source_manifest_sha256": result.source_manifest_sha256,
                "manifest_sha256": result.manifest_sha256,
                "table_count": result.table_count,
                "writes_live": False,
            }).decode("utf-8"))
            return 0
        if args.command == "preflight":
            report = preflight_package(
                args.package_dir,
                args.profile,
                installed_package_dir=args.installed_package_dir,
            )
            print(_canonical(report).decode("utf-8"))
            return 0 if report.get("can_prepare") else 3
        result = publish_package(
            args.package_dir,
            args.profile,
            args.confirm,
            installed_package_dir=args.installed_package_dir,
        )
        print(_canonical({
            "committed": result.committed,
            "release_id": result.release_id,
            "from_version": result.from_version,
            "version": result.version,
            "active_manifest_sha256": result.active_manifest_sha256,
            "archives": [str(path) for path in result.archive_paths],
            "snapshot_dir": (
                str(result.snapshot_dir) if result.snapshot_dir is not None else None
            ),
            "server_restart_required": True,
        }).decode("utf-8"))
        return 0
    except (OSError, ValueError, ReleaseError, CommittedReleaseError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
