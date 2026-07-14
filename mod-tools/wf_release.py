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
import socket
import stat
import sys
import tempfile
import uuid
import zipfile
from contextlib import contextmanager
from dataclasses import dataclass
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


@dataclass(frozen=True)
class ReleaseFile:
    root: RootName
    logical_path: str
    live_path: Path
    staged_path: Path
    before_raw: bytes | None
    after_sha256: str
    after_size: int


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


@dataclass(frozen=True)
class PreparedRuntimeRelease:
    transaction: character_pack.PackTransaction
    preflight: character_pack.PreflightReport
    prepared: character_pack.PreparedPack
    snapshot: character_pack.SnapshotRecord
    staged: character_pack.StagedPack
    payload: ReleasePayload


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
        if set(manifest) != {"schema_version", "base_version", "releases"}:
            raise ReleaseError("active.json fields are invalid")
        if manifest["schema_version"] != 1 or type(manifest["schema_version"]) is not int:
            raise ReleaseError("active.json schema_version must be 1")
        if manifest["base_version"] != self.canonical_base_version:
            raise ReleaseError("active.json base_version is detached from the canonical legacy tail")
        releases = manifest["releases"]
        if not isinstance(releases, list) or not releases:
            raise ReleaseError("active.json releases must be a non-empty array")
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
            )
        last = manifest["releases"][-1]
        return character_pack.ReleaseBaseState(
            active_raw=raw,
            active_sha256=_sha256(raw),
            current_release_id=last["release_id"],
            validated_chain_tail=last["version"],
            expected_from_version=last["version"],
            active_package_manifest_sha256=last["package_manifest_sha256"],
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
            if len(staged) != item.after_size or _sha256(staged) != item.after_sha256:
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
                } for item in payload.files],
                "archives": [str(target) for _archive, target, _relative in final_archives],
            }
            committed = False
            promoted_files: list[ReleaseFile] = []
            promoted_archives: list[Path] = []
            try:
                _atomic_write(journal, _canonical(journal_value))
                self._checkpoint(fail_after, "after_journal_fsync")
                for index, item in enumerate(payload.files):
                    def mark_live_replaced(item: ReleaseFile = item) -> None:
                        promoted_files.append(item)

                    _atomic_commit_write(
                        item.live_path,
                        item.staged_path.read_bytes(),
                        replaced=mark_live_replaced,
                    )
                    readback = item.live_path.read_bytes()
                    if len(readback) != item.after_size or _sha256(readback) != item.after_sha256:
                        raise ReleaseError(f"live promotion readback failed: {item.live_path}")
                    self._checkpoint(fail_after, f"after_live_{index}")
                self._checkpoint(fail_after, "after_live_promotions")
                for index, (archive, target, _relative) in enumerate(final_archives):
                    if target.exists():
                        raise ReleaseError(f"final archive already exists: {target}")
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


def _server_running(repo_root: Path) -> bool:
    values: dict[str, str] = {}
    env_path = repo_root / ".env"
    try:
        lines = env_path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
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


def _new_transaction(
    package_dir: Path,
    live_roots: character_pack.LiveRoots,
    cdn_root: Path,
    canonical_base: str,
) -> tuple[dict, character_pack.PackTransaction]:
    import wf_seris_release_pack as seris_release_pack

    errors = seris_release_pack.validate_runtime_test_package(package_dir)
    if errors:
        raise ReleaseError("runtime-test package invalid:\n- " + "\n- ".join(errors))
    manifest = character_pack.load_manifest(package_dir / "manifest.json")
    transaction = character_pack.PackTransaction(
        package_dir,
        manifest,
        live_roots=live_roots,
        release_base_provider=ActiveReleaseStore(
            cdn_root, canonical_base_version=canonical_base
        ),
        codec_registry={"json_object": JsonObjectCodec()},
        available_capabilities=("dual_form_v1",),
    )
    return manifest, transaction


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    for command in ("preflight", "publish"):
        child = sub.add_parser(command)
        child.add_argument("--package-dir", required=True, type=Path)
        child.add_argument("--profile", default="cn")
    publish = sub.choices["publish"]
    publish.add_argument("--confirm", required=True)
    publish.add_argument("--staging-root", type=Path)
    publish.add_argument("--snapshot-root", type=Path)
    args = parser.parse_args(argv)
    try:
        repo_root, live_roots, cdn_root = _repo_paths(args.profile)
        canonical_base = detect_canonical_base_version(cdn_root, repo_root)
        if args.command == "preflight":
            _manifest, transaction = _new_transaction(
                args.package_dir, live_roots, cdn_root, canonical_base
            )
            report = transaction.preflight()
            print(report.canonical_bytes().decode("utf-8"))
            return 0 if report.can_prepare else 3
        if args.confirm != "DIRECT_REAL_TEST":
            raise ReleaseError("publish requires --confirm DIRECT_REAL_TEST")
        staging_root = args.staging_root or (
            repo_root / "work" / "character_releases" / "staging"
        )
        snapshot_root = args.snapshot_root or (
            repo_root / "work" / "character_releases" / "snapshots"
        )
        prepared = prepare_runtime_release(
            args.package_dir,
            live_roots=live_roots,
            cdn_root=cdn_root,
            canonical_base_version=canonical_base,
            staging_root=staging_root,
            snapshot_root=snapshot_root,
        )
        try:
            result = AtomicReleasePublisher(
                cdn_root, canonical_base_version=canonical_base
            ).publish(
                prepared.payload,
                server_running=lambda: _server_running(repo_root),
            )
        finally:
            close_prepared_runtime_release(prepared, discard_staging=True)
        print(_canonical({
            "committed": result.committed,
            "release_id": result.release_id,
            "from_version": result.from_version,
            "version": result.version,
            "active_manifest_sha256": result.active_manifest_sha256,
            "archives": [str(path) for path in result.archive_paths],
            "server_restart_required": True,
        }).decode("utf-8"))
        return 0
    except (OSError, ValueError, ReleaseError, CommittedReleaseError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
