# -*- coding: utf-8 -*-
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
import uuid
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from wf_asset_inventory import InventoryError, scan_root, sha256_file, tree_manifest
from wf_asset_policy import AUTO_CATEGORIES
from wf_remediation_baseline import append_jsonl, atomic_json


class QuarantineError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class PlanRecord:
    path: Path
    digest: str
    entry_count: int
    run_id: str


@dataclass(frozen=True, slots=True)
class OperationSummary:
    operation: str
    manifest_path: Path
    moved_count: int = 0
    restored_count: int = 0
    purged_count: int = 0
    byte_count: int = 0
    moved_by_category: Mapping[str, int] | None = None


@dataclass(frozen=True, slots=True)
class VerificationSummary:
    ok: bool
    manifest_path: Path
    issues: tuple[str, ...]
    state_counts: Mapping[str, int]
    verified_count: int
    byte_count: int


_ID_RE = re.compile(r"^[0-9a-f]{24}$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_REPARSE_ATTRIBUTE = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
_IS_WINDOWS = os.name == "nt"
_WINDOWS_MAX_PATH = 260
_ENTRY_KEYS = frozenset(
    {
        "id",
        "source",
        "kind",
        "category",
        "reason",
        "evidence",
        "auto_approved",
        "size",
        "digest",
        "digest_algorithm",
        "mtime_ns",
    }
)
_MANIFEST_KEYS = frozenset(
    {
        "schema_version",
        "sequence",
        "timestamp",
        "previous_record_digest",
        "id",
        "plan_digest",
        "source",
        "target",
        "kind",
        "category",
        "size",
        "digest",
        "digest_algorithm",
        "state",
        "record_digest",
    }
)
_MANIFEST_STATES = frozenset(
    {
        "planned",
        "quarantined",
        "rollback",
        "restore_planned",
        "restored",
        "requarantine_planned",
        "purge_planned",
        "purged",
    }
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def canonical_digest(value: object) -> str:
    raw = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _absolute(path: Path | str) -> Path:
    return Path(os.path.abspath(os.fspath(path)))


def _path_key(path: Path | str) -> str:
    return os.path.normcase(os.path.abspath(os.fspath(path)))


def _is_within(path: Path | str, root: Path | str) -> bool:
    try:
        return os.path.commonpath([_path_key(path), _path_key(root)]) == _path_key(root)
    except ValueError:
        return False


def _is_reparse(metadata: os.stat_result) -> bool:
    return stat.S_ISLNK(metadata.st_mode) or bool(
        int(getattr(metadata, "st_file_attributes", 0)) & _REPARSE_ATTRIBUTE
    )


def _regular_control_file(path: Path, label: str) -> Path:
    target = _absolute(path)
    try:
        metadata = target.stat(follow_symlinks=False)
    except OSError as error:
        raise QuarantineError(f"{label} is unavailable: {target}: {error}") from error
    if _is_reparse(metadata) or not stat.S_ISREG(metadata.st_mode):
        raise QuarantineError(f"{label} must be a regular non-reparse file: {target}")
    return target


def _digest_path(path: Path, expected_kind: str | None = None) -> tuple[str, int]:
    target = _absolute(path)
    try:
        metadata = target.stat(follow_symlinks=False)
    except OSError as error:
        raise QuarantineError(f"asset is unavailable: {target}: {error}") from error
    if _is_reparse(metadata):
        raise QuarantineError(f"reparse assets cannot be quarantined automatically: {target}")
    if stat.S_ISREG(metadata.st_mode):
        kind = "file"
        digest = sha256_file(target)
        size = int(metadata.st_size)
        after = target.stat(follow_symlinks=False)
        if (
            _is_reparse(after)
            or after.st_size != metadata.st_size
            or after.st_mtime_ns != metadata.st_mtime_ns
        ):
            raise QuarantineError(f"asset changed while hashing: {target}")
    elif stat.S_ISDIR(metadata.st_mode):
        kind = "tree"
        manifest = tree_manifest(target)
        if manifest.reparse_count or manifest.error_count:
            raise QuarantineError(
                f"tree has reparse or unreadable entries: {target}; "
                f"reparse={manifest.reparse_count} errors={manifest.error_count}"
            )
        digest = manifest.tree_sha256
        size = manifest.total_size
    else:
        raise QuarantineError(f"unsupported asset type: {target}")
    if expected_kind is not None and kind != expected_kind:
        raise QuarantineError(f"asset kind changed: {target}; expected={expected_kind} actual={kind}")
    return digest, size


def _entry_identity(entry: Mapping[str, Any]) -> str:
    return canonical_digest(
        {
            "source": _path_key(str(entry["source"])),
            "category": str(entry["category"]),
            "kind": str(entry["kind"]),
            "digest": str(entry["digest"]),
        }
    )[:24]


def _validate_entry(entry: Mapping[str, Any], label: str) -> None:
    if set(entry) != _ENTRY_KEYS:
        missing = sorted(_ENTRY_KEYS - set(entry))
        extra = sorted(set(entry) - _ENTRY_KEYS)
        raise QuarantineError(f"{label} keys are invalid; missing={missing} extra={extra}")
    identity = entry.get("id")
    if not isinstance(identity, str) or not _ID_RE.fullmatch(identity):
        raise QuarantineError(f"{label} has invalid id")
    source = entry.get("source")
    if not isinstance(source, str) or not Path(source).is_absolute():
        raise QuarantineError(f"{label} source must be absolute")
    if entry.get("kind") not in {"file", "tree"}:
        raise QuarantineError(f"{label} has invalid kind")
    if not isinstance(entry.get("category"), str) or not entry["category"]:
        raise QuarantineError(f"{label} has invalid category")
    if not isinstance(entry.get("reason"), str) or not entry["reason"]:
        raise QuarantineError(f"{label} has invalid reason")
    evidence = entry.get("evidence")
    if not isinstance(evidence, list) or not all(isinstance(item, str) for item in evidence):
        raise QuarantineError(f"{label} evidence must be a string array")
    if not isinstance(entry.get("auto_approved"), bool):
        raise QuarantineError(f"{label} auto_approved must be boolean")
    size = entry.get("size")
    mtime_ns = entry.get("mtime_ns")
    if isinstance(size, bool) or not isinstance(size, int) or size < 0:
        raise QuarantineError(f"{label} has invalid size")
    if isinstance(mtime_ns, bool) or not isinstance(mtime_ns, int) or mtime_ns < 0:
        raise QuarantineError(f"{label} has invalid mtime_ns")
    digest = entry.get("digest")
    if not isinstance(digest, str) or not _SHA256_RE.fullmatch(digest):
        raise QuarantineError(f"{label} has invalid digest")
    expected_algorithm = "sha256" if entry["kind"] == "file" else "tree-sha256"
    if entry.get("digest_algorithm") != expected_algorithm:
        raise QuarantineError(f"{label} has invalid digest_algorithm")
    if identity != _entry_identity(entry):
        raise QuarantineError(f"{label} deterministic id mismatch")


def build_plan_entry(
    source: Path,
    *,
    category: str,
    reason: str,
    auto_approved: bool,
    evidence: Sequence[str] = (),
) -> dict[str, Any]:
    absolute = _absolute(source)
    metadata = absolute.stat(follow_symlinks=False)
    if _is_reparse(metadata):
        raise QuarantineError(f"cannot plan a reparse asset: {absolute}")
    kind = "file" if stat.S_ISREG(metadata.st_mode) else "tree" if stat.S_ISDIR(metadata.st_mode) else "other"
    if kind == "other":
        raise QuarantineError(f"cannot plan unsupported asset type: {absolute}")
    digest, size = _digest_path(absolute, kind)
    return build_plan_entry_from_evidence(
        absolute,
        kind=kind,
        digest=digest,
        size=size,
        mtime_ns=int(metadata.st_mtime_ns),
        category=category,
        reason=reason,
        auto_approved=auto_approved,
        evidence=evidence,
    )


def build_plan_entry_from_evidence(
    source: Path,
    *,
    kind: str,
    digest: str,
    size: int,
    mtime_ns: int,
    category: str,
    reason: str,
    auto_approved: bool,
    evidence: Sequence[str] = (),
) -> dict[str, Any]:
    absolute = _absolute(source)
    metadata = absolute.stat(follow_symlinks=False)
    if _is_reparse(metadata):
        raise QuarantineError(f"cannot plan a reparse asset: {absolute}")
    actual_kind = "file" if stat.S_ISREG(metadata.st_mode) else "tree" if stat.S_ISDIR(metadata.st_mode) else "other"
    if actual_kind != kind:
        raise QuarantineError(
            f"asset kind changed since scan: {absolute}; expected={kind} actual={actual_kind}"
        )
    if kind == "file":
        if int(metadata.st_mtime_ns) != int(mtime_ns):
            raise QuarantineError(f"asset mtime changed since scan: {absolute}")
        if int(metadata.st_size) != int(size):
            raise QuarantineError(f"asset size changed since scan: {absolute}")
    entry = {
        "id": "",
        "source": str(absolute),
        "kind": kind,
        "category": str(category),
        "reason": str(reason),
        "evidence": [str(item) for item in evidence],
        "auto_approved": bool(auto_approved),
        "size": size,
        "digest": digest,
        "digest_algorithm": "sha256" if kind == "file" else "tree-sha256",
        "mtime_ns": int(mtime_ns),
    }
    entry["id"] = _entry_identity(entry)
    _validate_entry(entry, "generated plan entry")
    return entry


def _strict_json(raw: str, *, label: str) -> Any:
    def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise QuarantineError(f"{label} has duplicate key: {key}")
            result[key] = value
        return result

    try:
        return json.loads(raw, object_pairs_hook=reject_duplicates)
    except (json.JSONDecodeError, ValueError) as error:
        raise QuarantineError(f"invalid {label}: {error}") from error


def write_plan(
    entries: Iterable[Mapping[str, Any]],
    run_dir: Path,
    *,
    run_id: str | None = None,
    metadata: Mapping[str, Any] | None = None,
) -> PlanRecord:
    target_dir = _absolute(run_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    normalized = [dict(entry) for entry in entries]
    normalized.sort(key=lambda item: (_path_key(str(item.get("source", ""))), str(item.get("id", ""))))
    seen_ids: set[str] = set()
    seen_sources: set[str] = set()
    for index, entry in enumerate(normalized):
        _validate_entry(entry, f"plan entry {index}")
        identity = entry["id"]
        source_key = _path_key(str(entry["source"]))
        if identity in seen_ids or source_key in seen_sources:
            raise QuarantineError("plan contains duplicate identity or source")
        seen_ids.add(identity)
        seen_sources.add(source_key)
    payload: dict[str, Any] = {
        "schema_version": 1,
        "run_id": run_id or target_dir.name,
        "created_at": _now(),
        "metadata": dict(metadata or {}),
        "entries": normalized,
    }
    payload["plan_digest"] = canonical_digest(payload)
    path = target_dir / "plan.json"
    atomic_json(path, payload)
    return PlanRecord(path=path, digest=payload["plan_digest"], entry_count=len(normalized), run_id=payload["run_id"])


def _read_plan(path: Path) -> dict[str, Any]:
    target = _regular_control_file(path, "plan")
    payload = _strict_json(target.read_text(encoding="utf-8-sig"), label="plan")
    if not isinstance(payload, dict) or set(payload) != {
        "schema_version", "run_id", "created_at", "metadata", "entries", "plan_digest"
    } or payload.get("schema_version") != 1:
        raise QuarantineError("plan schema_version must be 1")
    stored = payload.get("plan_digest")
    if not isinstance(stored, str):
        raise QuarantineError("plan has no digest")
    unsigned = dict(payload)
    unsigned.pop("plan_digest", None)
    if canonical_digest(unsigned) != stored:
        raise QuarantineError("plan digest mismatch")
    entries = payload.get("entries")
    if not isinstance(entries, list):
        raise QuarantineError("plan entries must be an array")
    seen_ids: set[str] = set()
    seen_sources: set[str] = set()
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise QuarantineError(f"plan entry {index} must be an object")
        _validate_entry(entry, f"plan entry {index}")
        source_key = _path_key(entry["source"])
        if entry["id"] in seen_ids or source_key in seen_sources:
            raise QuarantineError("plan contains duplicate identity or source")
        seen_ids.add(entry["id"])
        seen_sources.add(source_key)
    return payload


def read_plan(path: Path) -> dict[str, Any]:
    return _read_plan(path)


def _same_volume(source: Path, target: Path) -> bool:
    if source.drive or target.drive:
        return bool(source.drive and target.drive and source.drive.casefold() == target.drive.casefold())
    try:
        source_device = source.stat(follow_symlinks=False).st_dev
        ancestor = target.parent
        while not ancestor.exists() and ancestor != ancestor.parent:
            ancestor = ancestor.parent
        return source_device == ancestor.stat(follow_symlinks=False).st_dev
    except OSError:
        return False


def atomic_move(source: Path, target: Path) -> None:
    source = _absolute(source)
    target = _absolute(target)
    if not _same_volume(source, target):
        raise QuarantineError(f"cross-volume quarantine is not allowed: {source} -> {target}")
    if target.exists() or target.is_symlink():
        raise QuarantineError(f"quarantine destination exists: {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.replace(source, target)
    except OSError as error:
        raise QuarantineError(f"atomic move failed: {source} -> {target}: {error}") from error


def _record_payload(base: Mapping[str, Any], state: str) -> dict[str, Any]:
    return {
        "id": base["id"],
        "plan_digest": base["plan_digest"],
        "source": base["source"],
        "target": base["target"],
        "kind": base["kind"],
        "category": base["category"],
        "size": base["size"],
        "digest": base["digest"],
        "digest_algorithm": base["digest_algorithm"],
        "state": state,
    }


def read_manifest(path: Path) -> tuple[dict[str, Any], ...]:
    manifest = _regular_control_file(path, "manifest")
    records: list[dict[str, Any]] = []
    previous = ""
    for line_number, line in enumerate(manifest.read_text(encoding="utf-8-sig").splitlines(), 1):
        if not line.strip():
            continue
        record = _strict_json(line, label=f"manifest line {line_number}")
        if not isinstance(record, dict):
            raise QuarantineError(f"manifest line {line_number} must be an object")
        if set(record) != _MANIFEST_KEYS:
            raise QuarantineError(f"manifest keys are invalid at line {line_number}")
        stored = record.get("record_digest")
        unsigned = dict(record)
        unsigned.pop("record_digest", None)
        if not isinstance(stored, str) or canonical_digest(unsigned) != stored:
            raise QuarantineError(f"manifest record digest mismatch at line {line_number}")
        if record.get("schema_version") != 1 or record.get("sequence") != len(records) + 1:
            raise QuarantineError(f"manifest sequence/schema mismatch at line {line_number}")
        if record.get("previous_record_digest") != previous:
            raise QuarantineError(f"manifest chain mismatch at line {line_number}")
        identity = record.get("id")
        if not isinstance(identity, str) or not _ID_RE.fullmatch(identity):
            raise QuarantineError(f"manifest id is invalid at line {line_number}")
        if record.get("state") not in _MANIFEST_STATES:
            raise QuarantineError(f"manifest state is invalid at line {line_number}")
        if record.get("kind") not in {"file", "tree"}:
            raise QuarantineError(f"manifest kind is invalid at line {line_number}")
        if not isinstance(record.get("source"), str) or not Path(record["source"]).is_absolute():
            raise QuarantineError(f"manifest source is invalid at line {line_number}")
        if not isinstance(record.get("target"), str) or not Path(record["target"]).is_absolute():
            raise QuarantineError(f"manifest target is invalid at line {line_number}")
        if not _is_within(record["target"], manifest.parent / "data"):
            raise QuarantineError(f"manifest target leaves data root at line {line_number}")
        if _is_within(record["source"], manifest.parent):
            raise QuarantineError(f"manifest source overlaps quarantine root at line {line_number}")
        if not isinstance(record.get("size"), int) or isinstance(record.get("size"), bool) or record["size"] < 0:
            raise QuarantineError(f"manifest size is invalid at line {line_number}")
        if not isinstance(record.get("digest"), str) or not _SHA256_RE.fullmatch(record["digest"]):
            raise QuarantineError(f"manifest digest is invalid at line {line_number}")
        expected_algorithm = "sha256" if record["kind"] == "file" else "tree-sha256"
        if record.get("digest_algorithm") != expected_algorithm:
            raise QuarantineError(f"manifest digest_algorithm is invalid at line {line_number}")
        if not isinstance(record.get("plan_digest"), str) or not _SHA256_RE.fullmatch(record["plan_digest"]):
            raise QuarantineError(f"manifest plan_digest is invalid at line {line_number}")
        records.append(record)
        previous = stored
    return tuple(records)


def _append_record(manifest: Path, payload: Mapping[str, Any]) -> dict[str, Any]:
    existing = read_manifest(manifest) if manifest.exists() else ()
    previous = existing[-1]["record_digest"] if existing else ""
    record = {
        "schema_version": 1,
        "sequence": len(existing) + 1,
        "timestamp": _now(),
        "previous_record_digest": previous,
        **dict(payload),
    }
    record["record_digest"] = canonical_digest(record)
    append_jsonl(manifest, record)
    return record


def _latest_records(records: Iterable[Mapping[str, Any]]) -> dict[str, dict[str, Any]]:
    latest: dict[str, dict[str, Any]] = {}
    identities: dict[str, tuple[str, ...]] = {}
    for raw in records:
        record = dict(raw)
        identity = str(record["id"])
        invariant = (
            _path_key(record["source"]),
            _path_key(record["target"]),
            str(record["kind"]),
            str(record["digest"]),
            str(record["category"]),
            str(record["size"]),
            str(record["digest_algorithm"]),
            str(record["plan_digest"]),
        )
        if identity in identities and identities[identity] != invariant:
            raise QuarantineError(f"manifest identity changed across records: {identity}")
        identities[identity] = invariant
        latest[identity] = record
    return latest


def _selected(values: Iterable[str] | None) -> set[str] | None:
    if values is None:
        return None
    result = {str(value) for value in values}
    if not all(_ID_RE.fullmatch(value) for value in result):
        raise QuarantineError("one or more selected IDs are invalid")
    return result


def _target_for(quarantine_root: Path, entry: Mapping[str, Any]) -> Path:
    return quarantine_root / "data" / str(entry["id"])


def _validate_target_path_budget(source: Path, target: Path, kind: str) -> None:
    if not _IS_WINDOWS:
        return
    offender_count = 0
    longest_path = ""
    longest_length = 0

    def check(path: Path) -> None:
        nonlocal offender_count, longest_path, longest_length
        absolute = str(_absolute(path))
        length = len(absolute)
        if length >= _WINDOWS_MAX_PATH:
            offender_count += 1
            if length > longest_length:
                longest_path = absolute
                longest_length = length

    check(target)
    if kind == "tree":
        try:
            for entry in scan_root(source, hash_files=False):
                check(target / Path(entry.relative_path))
        except InventoryError as error:
            raise QuarantineError(f"cannot inspect target path budget for {source}: {error}") from error
    if offender_count:
        raise QuarantineError(
            "Windows MAX_PATH budget would be exceeded before quarantine move: "
            f"source={source} target={target} offenders={offender_count} "
            f"longest={longest_length} limit={_WINDOWS_MAX_PATH - 1} path={longest_path}; "
            "choose a shorter quarantine root"
        )


def _verify_expected(path: Path, entry: Mapping[str, Any]) -> None:
    actual_digest, actual_size = _digest_path(path, str(entry["kind"]))
    if actual_digest != entry["digest"] or actual_size != entry["size"]:
        raise QuarantineError(
            f"asset digest mismatch: {path}; expected={entry['digest']}/{entry['size']} "
            f"actual={actual_digest}/{actual_size}"
        )


def _summary_payload(summary: OperationSummary) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "operation": summary.operation,
        "manifest_path": str(summary.manifest_path),
        "moved_count": summary.moved_count,
        "restored_count": summary.restored_count,
        "purged_count": summary.purged_count,
        "byte_count": summary.byte_count,
        "moved_by_category": dict(summary.moved_by_category or {}),
        "recorded_at": _now(),
    }


def generate_restore_wrapper(manifest_path: Path) -> Path:
    manifest = _regular_control_file(manifest_path, "manifest")
    tool = Path(__file__).with_name("wf_asset_maintenance.py").resolve()
    if "'" in str(manifest) or "'" in str(tool):
        raise QuarantineError("restore wrapper paths must not contain a single quote")
    target = manifest.parent / "restore.ps1"
    text = (
        "param([string[]]$Id = @())\n"
        "$ErrorActionPreference = 'Stop'\n"
        f"$manifestPath = '{manifest}'\n"
        f"$toolPath = '{tool}'\n"
        "$arguments = @($toolPath, 'restore', '--manifest', $manifestPath)\n"
        "foreach ($value in $Id) { $arguments += @('--id', [string]$value) }\n"
        "& python @arguments\n"
        "exit $LASTEXITCODE\n"
    )
    temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("x", encoding="utf-8", newline="\n") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
    return target


def quarantine(
    plan_path: Path,
    quarantine_root: Path,
    *,
    ids: Iterable[str] | None = None,
) -> OperationSummary:
    plan = _read_plan(plan_path)
    selected = _selected(ids)
    root = _absolute(quarantine_root)
    entries = [entry for entry in plan["entries"] if selected is None or entry["id"] in selected]
    if selected is not None and {entry["id"] for entry in entries} != selected:
        raise QuarantineError("one or more selected IDs are absent from the plan")
    locations: dict[str, tuple[Path, Path]] = {}
    for entry in entries:
        if not entry.get("auto_approved") or entry.get("category") not in AUTO_CATEGORIES:
            raise QuarantineError(
                f"plan entry is not auto-approved: {entry.get('source')} category={entry.get('category')}"
            )
        source = _absolute(entry["source"])
        target = _target_for(root, entry)
        if _is_within(root, source) or _is_within(source, root):
            raise QuarantineError(f"quarantine root overlaps a source: {root} and {source}")
        if not _is_within(target, root / "data"):
            raise QuarantineError(f"computed quarantine target escapes data root: {target}")
        _validate_target_path_budget(source, target, str(entry["kind"]))
        locations[str(entry["id"])] = (source, target)

    root.mkdir(parents=True, exist_ok=True)
    manifest = root / "manifest.jsonl"
    if not manifest.exists():
        manifest.touch(exist_ok=False)
    existing = read_manifest(manifest)
    latest = _latest_records(existing)

    work: list[tuple[dict[str, Any], Path, Path, str]] = []
    for entry in entries:
        source, target = locations[str(entry["id"])]
        prior = latest.get(entry["id"])
        if prior is not None and prior.get("plan_digest") != plan["plan_digest"]:
            raise QuarantineError(f"manifest plan digest mismatch for {entry['id']}")
        if prior is None:
            if target.exists() or target.is_symlink():
                raise QuarantineError(f"quarantine destination exists without manifest record: {target}")
            _verify_expected(source, entry)
            if not _same_volume(source, target):
                raise QuarantineError(f"cross-volume quarantine is not allowed: {source} -> {target}")
            work.append((entry, source, target, "new"))
        elif prior["state"] == "quarantined":
            _verify_expected(target, entry)
            if source.exists() or source.is_symlink():
                raise QuarantineError(f"both source and quarantine target exist: {source}")
        elif prior["state"] in {"planned", "rollback"}:
            source_exists = source.exists() or source.is_symlink()
            target_exists = target.exists() or target.is_symlink()
            if source_exists and target_exists:
                raise QuarantineError(f"both source and quarantine target exist: {source}")
            if not source_exists and not target_exists:
                raise QuarantineError(f"neither source nor quarantine target exists: {source}")
            if source_exists:
                _verify_expected(source, entry)
                if not _same_volume(source, target):
                    raise QuarantineError(f"cross-volume quarantine is not allowed: {source} -> {target}")
                work.append((entry, source, target, "resume-source"))
            else:
                _verify_expected(target, entry)
                work.append((entry, source, target, "resume-target"))
        else:
            raise QuarantineError(
                f"entry {entry['id']} is in state {prior['state']}; use resume_quarantine after restore"
            )

    moved = 0
    moved_bytes = 0
    categories: Counter[str] = Counter()
    for entry, source, target, mode in work:
        base = {
            **entry,
            "plan_digest": plan["plan_digest"],
            "source": str(source),
            "target": str(target),
        }
        if mode == "resume-target":
            _append_record(manifest, _record_payload(base, "quarantined"))
        else:
            if mode == "new":
                _append_record(manifest, _record_payload(base, "planned"))
            try:
                atomic_move(source, target)
            except QuarantineError:
                raise
            try:
                _verify_expected(target, entry)
            except QuarantineError as error:
                rollback_error: Exception | None = None
                try:
                    if not source.exists() and target.exists():
                        atomic_move(target, source)
                        _append_record(manifest, _record_payload(base, "rollback"))
                except Exception as caught:
                    rollback_error = caught
                detail = f"post-move digest verification failed: {error}"
                if rollback_error is not None:
                    detail += f"; rollback failed: {rollback_error}"
                raise QuarantineError(detail) from error
            _append_record(manifest, _record_payload(base, "quarantined"))
        moved += 1
        moved_bytes += int(entry["size"])
        categories[str(entry["category"])] += 1

    summary = OperationSummary(
        operation="quarantine",
        manifest_path=manifest,
        moved_count=moved,
        byte_count=moved_bytes,
        moved_by_category=dict(sorted(categories.items())),
    )
    atomic_json(root / "summary.json", _summary_payload(summary))
    generate_restore_wrapper(manifest)
    return summary


def verify_manifest(manifest_path: Path) -> VerificationSummary:
    manifest = _regular_control_file(manifest_path, "manifest")
    records = read_manifest(manifest)
    latest = _latest_records(records)
    issues: list[str] = []
    counts: Counter[str] = Counter()
    verified = 0
    byte_count = 0
    data_root = manifest.parent / "data"
    for identity, record in latest.items():
        state = str(record["state"])
        counts[state] += 1
        source = _absolute(record["source"])
        target = _absolute(record["target"])
        if not _is_within(target, data_root):
            issues.append(f"target leaves quarantine data root for {identity}: {target}")
            continue
        expected_location: Path | None
        absent_location: Path | None
        if state == "quarantined":
            expected_location, absent_location = target, source
        elif state in {"restored", "rollback"}:
            expected_location, absent_location = source, target
        elif state == "purged":
            expected_location = None
            absent_location = None
            if source.exists() or target.exists():
                issues.append(f"purged entry still exists for {identity}")
            continue
        else:
            issues.append(f"entry requires recovery for {identity}: state={state}")
            continue
        if absent_location.exists() or absent_location.is_symlink():
            issues.append(f"unexpected duplicate location for {identity}: {absent_location}")
        try:
            _verify_expected(expected_location, record)
        except QuarantineError as error:
            issues.append(str(error))
        else:
            verified += 1
            byte_count += int(record["size"])
    return VerificationSummary(
        ok=not issues,
        manifest_path=manifest,
        issues=tuple(issues),
        state_counts=dict(sorted(counts.items())),
        verified_count=verified,
        byte_count=byte_count,
    )


def _move_from_latest(
    manifest_path: Path,
    *,
    ids: Iterable[str] | None,
    from_state: str,
    to_state: str,
    planned_state: str,
    reverse: bool,
) -> OperationSummary:
    manifest = _regular_control_file(manifest_path, "manifest")
    records = read_manifest(manifest)
    latest = _latest_records(records)
    selected = _selected(ids)
    candidates: list[tuple[dict[str, Any], str]] = []
    for identity, record in sorted(latest.items()):
        if selected is not None and identity not in selected:
            continue
        state = record["state"]
        if state == from_state:
            candidates.append((record, "new"))
        elif state == planned_state:
            candidates.append((record, "planned"))
        elif selected is not None:
            raise QuarantineError(
                f"selected ID {identity} is not in state {from_state} or {planned_state}"
            )
    if selected is not None and {record["id"] for record, _mode in candidates} != selected:
        raise QuarantineError(f"one or more selected IDs are absent from the manifest")

    prepared: list[tuple[dict[str, Any], Path, Path, str]] = []
    for record, mode in candidates:
        origin = _absolute(record["target"] if reverse else record["source"])
        destination = _absolute(record["source"] if reverse else record["target"])
        origin_exists = origin.exists() or origin.is_symlink()
        destination_exists = destination.exists() or destination.is_symlink()
        if mode == "new":
            if destination_exists:
                raise QuarantineError(f"destination exists: {destination}")
            if not origin_exists:
                raise QuarantineError(f"operation source is missing: {origin}")
            _verify_expected(origin, record)
            prepared.append((record, origin, destination, "new"))
            continue
        if origin_exists and destination_exists:
            raise QuarantineError(f"both operation locations exist: {origin} and {destination}")
        if not origin_exists and not destination_exists:
            raise QuarantineError(f"neither operation location exists: {origin} and {destination}")
        if origin_exists:
            _verify_expected(origin, record)
            prepared.append((record, origin, destination, "resume-origin"))
        else:
            _verify_expected(destination, record)
            prepared.append((record, origin, destination, "resume-destination"))

    count = 0
    byte_count = 0
    categories: Counter[str] = Counter()
    for record, origin, destination, mode in prepared:
        if mode == "new":
            _append_record(manifest, _record_payload(record, planned_state))
        if mode != "resume-destination":
            atomic_move(origin, destination)
            try:
                _verify_expected(destination, record)
            except QuarantineError as error:
                rollback_error: Exception | None = None
                try:
                    if not origin.exists() and destination.exists():
                        atomic_move(destination, origin)
                except Exception as caught:
                    rollback_error = caught
                detail = f"post-move digest verification failed: {error}"
                if rollback_error is not None:
                    detail += f"; rollback failed: {rollback_error}"
                raise QuarantineError(detail) from error
        _append_record(manifest, _record_payload(record, to_state))
        count += 1
        byte_count += int(record["size"])
        categories[str(record["category"])] += 1

    operation = "restore" if reverse else "resume_quarantine"
    return OperationSummary(
        operation=operation,
        manifest_path=manifest,
        moved_count=0 if reverse else count,
        restored_count=count if reverse else 0,
        byte_count=byte_count,
        moved_by_category=dict(sorted(categories.items())),
    )


def restore(manifest_path: Path, ids: Iterable[str] | None = None) -> OperationSummary:
    return _move_from_latest(
        manifest_path,
        ids=ids,
        from_state="quarantined",
        to_state="restored",
        planned_state="restore_planned",
        reverse=True,
    )


def resume_quarantine(manifest_path: Path, ids: Iterable[str] | None = None) -> OperationSummary:
    return _move_from_latest(
        manifest_path,
        ids=ids,
        from_state="restored",
        to_state="quarantined",
        planned_state="requarantine_planned",
        reverse=False,
    )


def purge(
    manifest_path: Path,
    *,
    confirmation: str,
    ids: Iterable[str] | None = None,
) -> OperationSummary:
    if confirmation != "PERMANENT_DELETE":
        raise QuarantineError("purge requires exact confirmation PERMANENT_DELETE")
    manifest = _regular_control_file(manifest_path, "manifest")
    records = read_manifest(manifest)
    latest = _latest_records(records)
    selected = _selected(ids)
    candidates = [
        record
        for identity, record in sorted(latest.items())
        if (selected is None or identity in selected) and record["state"] == "quarantined"
    ]
    if selected is not None and {record["id"] for record in candidates} != selected:
        raise QuarantineError("one or more selected IDs are not quarantined")
    data_root = manifest.parent / "data"
    for record in candidates:
        target = _absolute(record["target"])
        if not _is_within(target, data_root):
            raise QuarantineError(f"purge target leaves quarantine data root: {target}")
        _verify_expected(target, record)
        if _absolute(record["source"]).exists():
            raise QuarantineError(f"purge refused because source also exists: {record['source']}")

    count = 0
    byte_count = 0
    for record in candidates:
        target = _absolute(record["target"])
        _append_record(manifest, _record_payload(record, "purge_planned"))
        if record["kind"] == "file":
            target.unlink()
        else:
            shutil.rmtree(target)
        _append_record(manifest, _record_payload(record, "purged"))
        count += 1
        byte_count += int(record["size"])
    return OperationSummary(
        operation="purge",
        manifest_path=manifest,
        purged_count=count,
        byte_count=byte_count,
    )
