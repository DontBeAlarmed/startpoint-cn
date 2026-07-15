#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Turn one finalized character-package snapshot into a new reverse increment."""
from __future__ import annotations

import base64
import binascii
import hashlib
import io
import os
import re
import shutil
import stat
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import wf_character_pack as character_pack
import wf_mod_tool as core
import wf_release


ROOT_NAMES = ("common", "medium", "android", "server")
CLIENT_ROOTS = ("common", "medium", "android")
HEX32_RE = re.compile(r"^[0-9a-f]{32}$")
MARKER_FIELDS = {
    "kind",
    "transaction_id",
    "snapshot_nonce",
    "prepared_digest",
    "snapshot_sha256",
}
SNAPSHOT_FIELDS = {
    "transaction_id",
    "release_base",
    "table_before",
    "file_before",
}
FILE_FIELDS = {
    "root",
    "logical_path",
    "live_path",
    "exists",
    "bytes",
    "sha256",
    "size",
}
BASE_FIELDS = {
    "active_raw_base64",
    "active_sha256",
    "current_release_id",
    "validated_chain_tail",
    "expected_from_version",
    "active_package_manifest_sha256",
}


@dataclass(frozen=True)
class SnapshotFile:
    root: str
    logical_path: str
    live_path: Path
    target_raw: bytes | None


@dataclass(frozen=True)
class LoadedSnapshot:
    snapshot_dir: Path
    transaction_id: str
    snapshot_sha256: str
    prepared_digest: str
    release_base: character_pack.ReleaseBaseState
    files: tuple[SnapshotFile, ...]


def _absolute(path: Path) -> Path:
    return Path(os.path.abspath(os.fspath(path)))


def _is_reparse(path: Path) -> bool:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    if stat.S_ISLNK(info.st_mode):
        return True
    is_junction = getattr(path, "is_junction", None)
    if is_junction is not None:
        try:
            if is_junction():
                return True
        except OSError as exc:
            raise wf_release.ReleaseError(f"cannot inspect reparse path: {path}: {exc}") from exc
    attributes = getattr(info, "st_file_attributes", 0)
    return bool(attributes & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400))


def _has_reparse_component(path: Path) -> bool:
    current = _absolute(path)
    while True:
        if (current.exists() or current.is_symlink()) and _is_reparse(current):
            return True
        if current.parent == current:
            return False
        current = current.parent


def _is_within(path: Path, root: Path) -> bool:
    try:
        _absolute(path).relative_to(_absolute(root))
        return True
    except ValueError:
        return False


def _overlaps(left: Path, right: Path) -> bool:
    return _is_within(left, right) or _is_within(right, left)


def _safe_logical(value: object) -> str:
    if not isinstance(value, str) or character_pack._path_problem(value) is not None:  # type: ignore[attr-defined]
        raise wf_release.ReleaseError("snapshot logical_path is unsafe")
    return value


def _decode_base(value: object) -> character_pack.ReleaseBaseState:
    if not isinstance(value, dict) or set(value) != BASE_FIELDS:
        raise wf_release.ReleaseError("snapshot release_base fields are invalid")
    encoded = value["active_raw_base64"]
    if encoded is None:
        active_raw = None
    elif isinstance(encoded, str):
        try:
            active_raw = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise wf_release.ReleaseError("snapshot active base64 is invalid") from exc
    else:
        raise wf_release.ReleaseError("snapshot active base64 is invalid")
    active_sha = value["active_sha256"]
    if active_raw is None:
        if active_sha is not None:
            raise wf_release.ReleaseError("snapshot empty active base has a hash")
    elif not isinstance(active_sha, str) or hashlib.sha256(active_raw).hexdigest() != active_sha:
        raise wf_release.ReleaseError("snapshot active base hash mismatch")
    for field in ("validated_chain_tail", "expected_from_version"):
        if not isinstance(value[field], str) or wf_release.VERSION_RE.fullmatch(value[field]) is None:
            raise wf_release.ReleaseError(f"snapshot {field} is invalid")
    current_release_id = value["current_release_id"]
    if current_release_id is not None and (
        not isinstance(current_release_id, str)
        or wf_release.TOKEN_RE.fullmatch(current_release_id) is None
    ):
        raise wf_release.ReleaseError("snapshot current_release_id is invalid")
    package_hash = value["active_package_manifest_sha256"]
    if package_hash is not None and (
        not isinstance(package_hash, str) or wf_release.HASH_RE.fullmatch(package_hash) is None
    ):
        raise wf_release.ReleaseError("snapshot active package hash is invalid")
    if active_raw is None and (current_release_id is not None or package_hash is not None):
        raise wf_release.ReleaseError("snapshot empty active base has release metadata")
    return character_pack.ReleaseBaseState(
        active_raw=active_raw,
        active_sha256=active_sha,
        current_release_id=current_release_id,
        validated_chain_tail=value["validated_chain_tail"],
        expected_from_version=value["expected_from_version"],
        active_package_manifest_sha256=package_hash,
    )


def _expected_live(
    live_roots: character_pack.LiveRoots,
    root: str,
    logical_path: str,
) -> Path:
    root_path = Path(getattr(live_roots, root))
    if root == "server":
        return root_path / Path(*logical_path.split("/"))
    return core.table_path(root_path, logical_path)


def _owned_snapshot_leaf(root: str, logical_path: str) -> str:
    digest = hashlib.sha256(f"{root}\0{logical_path}".encode("utf-8")).hexdigest()
    return f"file-{root}-{digest}"


def _decode_file(
    snapshot_dir: Path,
    value: object,
    live_roots: character_pack.LiveRoots,
) -> SnapshotFile:
    if not isinstance(value, dict) or set(value) != FILE_FIELDS:
        raise wf_release.ReleaseError("snapshot file record fields are invalid")
    root = value["root"]
    if root not in ROOT_NAMES:
        raise wf_release.ReleaseError("snapshot file root is invalid")
    logical = _safe_logical(value["logical_path"])
    if not isinstance(value["live_path"], str):
        raise wf_release.ReleaseError("snapshot live_path is invalid")
    expected = _absolute(_expected_live(live_roots, root, logical))
    recorded = _absolute(Path(value["live_path"]))
    if recorded != expected:
        raise wf_release.ReleaseError("snapshot live_path is outside configured roots")
    if _has_reparse_component(expected.parent):
        raise wf_release.ReleaseError("snapshot live_path traverses a reparse point")
    exists = value["exists"]
    if type(exists) is not bool:
        raise wf_release.ReleaseError("snapshot file exists marker is invalid")
    if exists:
        encoded = value["bytes"]
        if not isinstance(encoded, str):
            raise wf_release.ReleaseError("snapshot file base64 is missing")
        try:
            raw = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise wf_release.ReleaseError("snapshot file base64 is invalid") from exc
        if (
            not isinstance(value["sha256"], str)
            or hashlib.sha256(raw).hexdigest() != value["sha256"]
            or type(value["size"]) is not int
            or len(raw) != value["size"]
        ):
            raise wf_release.ReleaseError("snapshot file hash/size mismatch")
        owned = snapshot_dir / _owned_snapshot_leaf(root, logical)
        if _has_reparse_component(owned) or not owned.is_file() or owned.read_bytes() != raw:
            raise wf_release.ReleaseError("snapshot owned before-bytes mismatch")
    else:
        if value["bytes"] is not None or value["sha256"] is not None or value["size"] is not None:
            raise wf_release.ReleaseError("snapshot absent file has bytes")
        owned = snapshot_dir / _owned_snapshot_leaf(root, logical)
        if owned.exists():
            raise wf_release.ReleaseError("snapshot absent file has an owned payload")
        raw = None
    return SnapshotFile(root=root, logical_path=logical, live_path=expected, target_raw=raw)


def _load_snapshot(
    snapshot_dir: Path,
    live_roots: character_pack.LiveRoots,
) -> LoadedSnapshot:
    directory = _absolute(Path(snapshot_dir))
    if _has_reparse_component(directory) or not directory.is_dir():
        raise wf_release.ReleaseError("snapshot directory is missing or contains a reparse point")
    marker_path = directory / character_pack.SNAPSHOT_MARKER
    snapshot_path = directory / "snapshot.json"
    try:
        marker_raw = marker_path.read_bytes()
        snapshot_raw = snapshot_path.read_bytes()
    except OSError as exc:
        raise wf_release.ReleaseError(f"snapshot is not finalized: {exc}") from exc
    marker = wf_release._strict_object(marker_raw, "snapshot marker")
    if set(marker) != MARKER_FIELDS or marker.get("kind") != "character_pack_snapshot":
        raise wf_release.ReleaseError("snapshot final marker fields are invalid")
    if marker_raw != wf_release._canonical(marker):
        raise wf_release.ReleaseError("snapshot final marker is not canonical")
    transaction_id = marker.get("transaction_id")
    nonce = marker.get("snapshot_nonce")
    prepared_digest = marker.get("prepared_digest")
    snapshot_sha = marker.get("snapshot_sha256")
    if not isinstance(transaction_id, str) or HEX32_RE.fullmatch(transaction_id) is None:
        raise wf_release.ReleaseError("snapshot transaction_id is invalid")
    if not isinstance(nonce, str) or HEX32_RE.fullmatch(nonce) is None:
        raise wf_release.ReleaseError("snapshot nonce is invalid")
    if not isinstance(prepared_digest, str) or wf_release.HASH_RE.fullmatch(prepared_digest) is None:
        raise wf_release.ReleaseError("snapshot prepared digest is invalid")
    if not isinstance(snapshot_sha, str) or hashlib.sha256(snapshot_raw).hexdigest() != snapshot_sha:
        raise wf_release.ReleaseError("snapshot digest mismatch")
    snapshot = wf_release._strict_object(snapshot_raw, "snapshot.json")
    if set(snapshot) != SNAPSHOT_FIELDS or snapshot_raw != wf_release._canonical(snapshot):
        raise wf_release.ReleaseError("snapshot.json fields or canonical encoding are invalid")
    if snapshot.get("transaction_id") != transaction_id:
        raise wf_release.ReleaseError("snapshot transaction_id does not match marker")
    if not isinstance(snapshot.get("table_before"), list):
        raise wf_release.ReleaseError("snapshot table_before is invalid")
    raw_files = snapshot.get("file_before")
    if not isinstance(raw_files, list) or not raw_files:
        raise wf_release.ReleaseError("snapshot file_before is empty or invalid")
    files = tuple(_decode_file(directory, value, live_roots) for value in raw_files)
    identities = [(item.root, item.logical_path) for item in files]
    live_paths = [_absolute(item.live_path) for item in files]
    if len(set(identities)) != len(identities) or len(set(live_paths)) != len(live_paths):
        raise wf_release.ReleaseError("snapshot repeats a file identity")
    return LoadedSnapshot(
        snapshot_dir=directory,
        transaction_id=transaction_id,
        snapshot_sha256=snapshot_sha,
        prepared_digest=prepared_digest,
        release_base=_decode_base(snapshot["release_base"]),
        files=files,
    )


def _bind_to_current_release(
    snapshot: LoadedSnapshot,
    release_store: wf_release.ActiveReleaseStore,
) -> dict[str, Any]:
    _raw, active = release_store.read_manifest()
    if active is None or not active["releases"]:
        raise wf_release.ReleaseError("snapshot rollback requires one active character release")
    releases = active["releases"]
    last = releases[-1]
    if len(releases) == 1:
        expected_base = character_pack.ReleaseBaseState(
            active_raw=None,
            active_sha256=None,
            current_release_id=None,
            validated_chain_tail=active["base_version"],
            expected_from_version=active["base_version"],
            active_package_manifest_sha256=None,
        )
    else:
        previous = releases[-2]
        prefix = {
            "schema_version": active["schema_version"],
            "base_version": active["base_version"],
            "releases": releases[:-1],
        }
        prefix_raw = wf_release._canonical(prefix)
        expected_base = character_pack.ReleaseBaseState(
            active_raw=prefix_raw,
            active_sha256=hashlib.sha256(prefix_raw).hexdigest(),
            current_release_id=previous["release_id"],
            validated_chain_tail=previous["version"],
            expected_from_version=previous["version"],
            active_package_manifest_sha256=previous["package_manifest_sha256"],
        )
    if snapshot.release_base != expected_base or last["from_version"] != expected_base.expected_from_version:
        raise wf_release.ReleaseError(
            "snapshot does not describe the immediately preceding active release base"
        )
    return last


def _write_file(path: Path, raw: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as handle:
        handle.write(raw)
        handle.flush()
        os.fsync(handle.fileno())
    if path.read_bytes() != raw:
        raise wf_release.ReleaseError(f"rollback staging readback failed: {path.name}")


def _build_zip(entries: list[tuple[str, bytes]]) -> tuple[bytes, tuple[str, ...]]:
    output = io.BytesIO()
    members: list[str] = []
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for member, raw in sorted(entries):
            info = zipfile.ZipInfo(member, (1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, raw)
            members.append(member)
    return output.getvalue(), tuple(members)


def _cleanup_owned(owned: Path, staging_root: Path) -> None:
    owned = _absolute(owned)
    staging_root = _absolute(staging_root)
    if owned.parent != staging_root or not owned.name.startswith("character-rollback-"):
        raise wf_release.ReleaseError("refusing to clean an unowned rollback staging path")
    if not owned.exists():
        return
    if _is_reparse(owned):
        raise wf_release.ReleaseError(
            "rollback staging ownership changed; preserving the path for inspection"
        )
    shutil.rmtree(owned)


def prepare_snapshot_rollback(
    snapshot_dir: Path,
    live_roots: character_pack.LiveRoots,
    release_store: wf_release.ActiveReleaseStore,
    staging_root: Path,
) -> wf_release.ReleasePayload:
    """Validate a finalized snapshot and stage its before bytes without live writes."""
    snapshot = _load_snapshot(Path(snapshot_dir), live_roots)
    active_release = _bind_to_current_release(snapshot, release_store)
    root = _absolute(Path(staging_root))
    protected = (
        *(Path(getattr(live_roots, name)) for name in ROOT_NAMES),
        *(Path(path) for path in live_roots.protected),
        snapshot.snapshot_dir,
    )
    if any(_overlaps(root, path) for path in protected):
        raise wf_release.ReleaseError("rollback staging root overlaps protected data")
    if _has_reparse_component(root):
        raise wf_release.ReleaseError("rollback staging root contains a reparse point")
    root.mkdir(parents=True, exist_ok=True)
    if _is_reparse(root):
        raise wf_release.ReleaseError("rollback staging root is a reparse point")
    owned = Path(tempfile.mkdtemp(prefix="character-rollback-", dir=root))
    try:
        files: list[wf_release.ReleaseFile] = []
        archive_entries: dict[str, list[tuple[str, bytes]]] = {
            name: [] for name in CLIENT_ROOTS
        }
        evidence_files: list[dict[str, Any]] = []
        for item in snapshot.files:
            try:
                current_raw = item.live_path.read_bytes()
            except FileNotFoundError:
                current_raw = None
            if current_raw == item.target_raw:
                continue
            leaf = "payload-{}-{}".format(
                item.root,
                hashlib.sha256(f"{item.root}\0{item.logical_path}".encode()).hexdigest(),
            )
            staged_path = owned / leaf
            delete_after = item.target_raw is None
            staged_raw = b"" if delete_after else item.target_raw
            assert staged_raw is not None
            _write_file(staged_path, staged_raw)
            files.append(wf_release.ReleaseFile(
                root=item.root,
                logical_path=item.logical_path,
                live_path=item.live_path,
                staged_path=staged_path,
                before_raw=current_raw,
                after_sha256=hashlib.sha256(staged_raw).hexdigest(),
                after_size=len(staged_raw),
                delete_after=delete_after,
            ))
            evidence_files.append({
                "root": item.root,
                "logical_path": item.logical_path,
                "current_sha256": (
                    hashlib.sha256(current_raw).hexdigest()
                    if current_raw is not None else None
                ),
                "rollback_sha256": (
                    hashlib.sha256(item.target_raw).hexdigest()
                    if item.target_raw is not None else None
                ),
                "delete_after": delete_after,
            })
            if item.root in CLIENT_ROOTS and item.target_raw is not None:
                root_path = Path(getattr(live_roots, item.root))
                member = (
                    character_pack.ARCHIVE_PREFIXES[item.root]
                    + item.live_path.relative_to(root_path).as_posix()
                )
                archive_entries[item.root].append((member, item.target_raw))
        if not files:
            raise wf_release.ReleaseError("snapshot target already matches current live files")
        archives: list[wf_release.ProvisionalArchive] = []
        for root_name in CLIENT_ROOTS:
            raw, members = _build_zip(archive_entries[root_name])
            path = owned / f"rollback-{root_name}.zip"
            _write_file(path, raw)
            archives.append(wf_release.ProvisionalArchive(
                root=root_name,
                path=path,
                sha256=hashlib.sha256(raw).hexdigest(),
                size=len(raw),
                members=members,
            ))
        package_id = f"{active_release['package_id']}-rollback"
        descriptor = {
            "schema_version": 1,
            "operation": "snapshot_rollback",
            "source_package_id": active_release["package_id"],
            "source_package_manifest_sha256": active_release["package_manifest_sha256"],
            "transaction_id": snapshot.transaction_id,
            "prepared_digest": snapshot.prepared_digest,
            "snapshot_sha256": snapshot.snapshot_sha256,
            "files": sorted(
                evidence_files,
                key=lambda value: (value["root"], value["logical_path"]),
            ),
        }
        payload = wf_release.ReleasePayload(
            package_id=package_id,
            package_manifest_sha256=hashlib.sha256(
                wf_release._canonical(descriptor)
            ).hexdigest(),
            expected_base=release_store.read_validated_base(),
            files=tuple(files),
            provisional_archives=tuple(archives),
        )
        wf_release.AtomicReleasePublisher._validate_payload(payload)
        return payload
    except Exception:
        _cleanup_owned(owned, root)
        raise


def _validate_installed_binding(
    installed_package_dir: Path,
    snapshot_dir: Path,
    live_roots: character_pack.LiveRoots,
    store: wf_release.ActiveReleaseStore,
) -> None:
    package_dir = Path(installed_package_dir)
    manifest = character_pack.load_manifest(package_dir / "manifest.json")
    errors = character_pack.validate_manifest(manifest, package_dir)
    if errors:
        raise wf_release.ReleaseError(
            "installed package is invalid:\n- " + "\n- ".join(errors)
        )
    snapshot = _load_snapshot(snapshot_dir, live_roots)
    active_release = _bind_to_current_release(snapshot, store)
    manifest_hash = hashlib.sha256(character_pack.canonical_manifest_bytes(manifest)).hexdigest()
    if (
        manifest_hash != active_release["package_manifest_sha256"]
        or manifest.get("package_id") != active_release["package_id"]
    ):
        raise wf_release.ReleaseError("installed package does not bind the active release")
    entries = {
        (root, entry["logical_path"]): entry
        for root in ROOT_NAMES
        for entry in manifest["roots"][root]
    }
    for item in snapshot.files:
        entry = entries.get((item.root, item.logical_path))
        try:
            current = item.live_path.read_bytes()
        except FileNotFoundError:
            current = None
        if entry is None:
            if current is not None:
                raise wf_release.ReleaseError(
                    f"current live file is not owned by installed package: {item.root}:{item.logical_path}"
                )
        elif (
            current is None
            or len(current) != entry["size"]
            or hashlib.sha256(current).hexdigest() != entry["sha256"]
        ):
            raise wf_release.ReleaseError(
                f"current live file drifted from installed package: {item.root}:{item.logical_path}"
            )


def publish_snapshot_rollback(
    snapshot_dir: Path,
    profile_id: str,
    confirmation: str,
    installed_package_dir: Path | None = None,
) -> wf_release.ReleaseResult:
    """Publish a rollback as a newer immutable increment after all fail-closed gates."""
    if confirmation != "ROLLBACK_CHARACTER_PACKAGE":
        raise wf_release.ReleaseError(
            "rollback requires ROLLBACK_CHARACTER_PACKAGE"
        )
    repo_root, live_roots, cdn_root = wf_release._repo_paths(profile_id)
    if wf_release._server_running(repo_root):
        raise wf_release.ReleaseError("CN server must be stopped before character rollback")
    if installed_package_dir is None:
        raise wf_release.ReleaseError("installed package is required for snapshot rollback")
    expected_snapshot_root = _absolute(
        Path(repo_root) / "work" / "character_releases" / "snapshots"
    )
    snapshot = _absolute(Path(snapshot_dir))
    if snapshot.parent != expected_snapshot_root:
        raise wf_release.ReleaseError("snapshot directory is outside the configured snapshot root")
    canonical_base = wf_release.detect_canonical_base_version(cdn_root, repo_root)
    store = wf_release.ActiveReleaseStore(
        cdn_root, canonical_base_version=canonical_base
    )
    _validate_installed_binding(
        Path(installed_package_dir), snapshot, live_roots, store
    )
    staging_root = Path(repo_root) / "work" / "character_releases" / "rollback-staging"
    payload = prepare_snapshot_rollback(
        snapshot, live_roots, store, staging_root
    )
    owned = payload.provisional_archives[0].path.parent
    result: wf_release.ReleaseResult | None = None
    try:
        result = wf_release.AtomicReleasePublisher(
            cdn_root, canonical_base_version=canonical_base
        ).publish(
            payload,
            server_running=lambda: wf_release._server_running(repo_root),
        )
    finally:
        try:
            _cleanup_owned(owned, staging_root)
        except Exception as exc:
            if result is not None and result.committed:
                raise wf_release.CommittedReleaseError(
                    f"rollback committed; staging cleanup failed: {exc}"
                ) from exc
            raise
    assert result is not None
    return result
