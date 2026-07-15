# -*- coding: utf-8 -*-
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import stat
import sys
import uuid
from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any

from wf_asset_archive import ArchiveError, SevenZip, compare_archive_to_tree, find_7zip
from wf_asset_inventory import InventoryEntry, InventoryError, scan_root, sha256_file
from wf_asset_policy import (
    AUTO_CATEGORIES,
    BackupDecision,
    Decision,
    Policy,
    PolicyError,
    ReferenceIndex,
    classify,
    classify_backup_group,
)
from wf_asset_quarantine import (
    QuarantineError,
    build_plan_entry_from_evidence,
    canonical_digest,
    purge,
    quarantine,
    read_manifest,
    read_plan,
    restore,
    resume_quarantine,
    verify_manifest,
    write_plan,
)
from wf_remediation_baseline import atomic_json


class MaintenanceError(RuntimeError):
    pass


class VerificationFailure(MaintenanceError):
    def __init__(self, message: str, payload: Mapping[str, Any]) -> None:
        super().__init__(message)
        self.payload = dict(payload)


_SCAN_ENTRY_KEYS = frozenset(
    {
        "record_type",
        "scan_root",
        "absolute_path",
        "relative_path",
        "kind",
        "size",
        "sha256",
        "mtime_ns",
        "reparse",
        "error",
    }
)
_REPARSE_ATTRIBUTE = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


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


def _regular_file(path: Path, label: str) -> Path:
    target = _absolute(path)
    try:
        metadata = target.stat(follow_symlinks=False)
    except OSError as error:
        raise MaintenanceError(f"{label} is unavailable: {target}: {error}") from error
    if _is_reparse(metadata) or not stat.S_ISREG(metadata.st_mode):
        raise MaintenanceError(f"{label} must be a regular non-reparse file: {target}")
    return target


def _json_bytes(value: object) -> bytes:
    return (
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
        + "\n"
    ).encode("utf-8")


def _load_json(path: Path, label: str) -> Any:
    target = _regular_file(path, label)

    def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise MaintenanceError(f"{label} has duplicate key: {key}")
            result[key] = value
        return result

    try:
        return json.loads(
            target.read_text(encoding="utf-8-sig"),
            object_pairs_hook=reject_duplicates,
        )
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise MaintenanceError(f"invalid {label}: {error}") from error


def _relative_to_repo(path: Path, repo_root: Path) -> str:
    try:
        return path.relative_to(repo_root).as_posix()
    except ValueError as error:
        raise MaintenanceError(f"policy path leaves repository: {path}") from error


def _scan_record(entry: InventoryEntry, root_relative: str) -> dict[str, Any]:
    return {
        "record_type": "entry",
        "scan_root": root_relative,
        "absolute_path": str(entry.absolute_path),
        "relative_path": entry.relative_path,
        "kind": entry.kind,
        "size": entry.size,
        "sha256": entry.sha256,
        "mtime_ns": entry.mtime_ns,
        "reparse": entry.reparse,
        "error": entry.error,
    }


def scan_assets(
    repo_root: Path,
    policy_path: Path,
    run_dir: Path,
) -> dict[str, Any]:
    repo = Path(repo_root).resolve(strict=True)
    policy = Policy.load(policy_path, repo_root=repo)
    output = _absolute(run_dir)
    if not _is_within(output, repo):
        raise MaintenanceError(f"run directory must stay inside repository: {output}")
    output.mkdir(parents=True, exist_ok=True)
    scan_path = output / "scan.jsonl"
    temporary = output / f".scan.jsonl.{uuid.uuid4().hex}.tmp"
    excluded_by_key: dict[str, Path] = {}
    for excluded in (output, *policy.protected_roots):
        excluded_by_key.setdefault(_path_key(excluded), _absolute(excluded))
    excluded_roots = tuple(
        sorted(excluded_by_key.values(), key=lambda item: (_path_key(item), str(item)))
    )
    header = {
        "record_type": "header",
        "schema_version": 1,
        "run_id": output.name,
        "created_at": _now(),
        "repo_root": str(repo),
        "policy_path": str(policy.source),
        "policy_sha256": sha256_file(policy.source),
        "scan_roots": [_relative_to_repo(root, repo) for root in policy.scan_roots],
        "excluded_roots": [str(path) for path in excluded_roots],
    }
    digest = hashlib.sha256()
    count = 0
    total_bytes = 0
    kind_counts: Counter[str] = Counter()
    try:
        with temporary.open("xb") as stream:
            raw = _json_bytes(header)
            stream.write(raw)
            digest.update(raw)
            for scan_root_path in policy.scan_roots:
                if not scan_root_path.is_dir():
                    raise MaintenanceError(f"configured scan root is missing: {scan_root_path}")
                root_relative = _relative_to_repo(scan_root_path, repo)
                exclusions = [
                    excluded for excluded in excluded_roots if _is_within(excluded, scan_root_path)
                ]
                if any(_path_key(excluded) == _path_key(scan_root_path) for excluded in exclusions):
                    print(f"[asset-scan] {root_relative} (protected root skipped)", file=sys.stderr, flush=True)
                    continue
                print(f"[asset-scan] {root_relative}", file=sys.stderr, flush=True)
                for entry in scan_root(scan_root_path, exclude_roots=exclusions):
                    record = _scan_record(entry, root_relative)
                    raw = _json_bytes(record)
                    stream.write(raw)
                    digest.update(raw)
                    count += 1
                    kind_counts[entry.kind] += 1
                    if entry.kind == "file":
                        total_bytes += entry.size
            footer = {
                "record_type": "footer",
                "schema_version": 1,
                "entry_count": count,
                "total_file_bytes": total_bytes,
                "kind_counts": dict(sorted(kind_counts.items())),
                "scan_digest": digest.hexdigest(),
                "completed_at": _now(),
            }
            stream.write(_json_bytes(footer))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, scan_path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
    return {
        "ok": True,
        "run_id": output.name,
        "artifact": str(scan_path),
        "scan_digest": digest.hexdigest(),
        "entry_count": count,
        "byte_count": total_bytes,
        "kind_counts": dict(sorted(kind_counts.items())),
    }


def load_scan(path: Path) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any]]:
    scan_path = _regular_file(path, "scan")
    digest = hashlib.sha256()
    header: dict[str, Any] | None = None
    footer: dict[str, Any] | None = None
    entries: list[dict[str, Any]] = []
    seen_paths: set[str] = set()
    header_keys = {
        "record_type",
        "schema_version",
        "run_id",
        "created_at",
        "repo_root",
        "policy_path",
        "policy_sha256",
        "scan_roots",
        "excluded_roots",
    }
    footer_keys = {
        "record_type",
        "schema_version",
        "entry_count",
        "total_file_bytes",
        "kind_counts",
        "scan_digest",
        "completed_at",
    }

    def decode(raw: bytes, line_number: int) -> Any:
        def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
            result: dict[str, Any] = {}
            for key, value in pairs:
                if key in result:
                    raise MaintenanceError(f"scan line {line_number} has duplicate key: {key}")
                result[key] = value
            return result

        try:
            return json.loads(raw.decode("utf-8"), object_pairs_hook=reject_duplicates)
        except (UnicodeError, json.JSONDecodeError) as error:
            raise MaintenanceError(f"invalid scan line {line_number}: {error}") from error

    with scan_path.open("rb") as stream:
        for line_number, raw in enumerate(stream, 1):
            if not raw.strip():
                raise MaintenanceError(f"scan contains a blank line at {line_number}")
            record = decode(raw, line_number)
            if not isinstance(record, dict):
                raise MaintenanceError(f"scan line {line_number} must be an object")
            record_type = record.get("record_type")
            if line_number == 1:
                if (
                    record_type != "header"
                    or record.get("schema_version") != 1
                    or set(record) != header_keys
                    or not isinstance(record.get("scan_roots"), list)
                    or not isinstance(record.get("excluded_roots"), list)
                    or not isinstance(record.get("repo_root"), str)
                    or not Path(record["repo_root"]).is_absolute()
                ):
                    raise MaintenanceError("scan header is invalid")
                header = record
                excluded_roots = header["excluded_roots"]
                if (
                    not all(isinstance(item, str) and Path(item).is_absolute() for item in excluded_roots)
                    or len({_path_key(item) for item in excluded_roots}) != len(excluded_roots)
                ):
                    raise MaintenanceError("scan excluded roots are invalid")
                digest.update(raw)
                continue
            if record_type == "footer":
                if footer is not None:
                    raise MaintenanceError("scan contains multiple footers")
                footer = record
                if set(record) != footer_keys:
                    raise MaintenanceError("scan footer keys are invalid")
                trailing = stream.read()
                if trailing:
                    raise MaintenanceError("scan contains data after footer")
                break
            if footer is not None or record_type != "entry" or set(record) != _SCAN_ENTRY_KEYS:
                raise MaintenanceError(f"scan entry is invalid at line {line_number}")
            absolute_path = record.get("absolute_path")
            if not isinstance(absolute_path, str) or not Path(absolute_path).is_absolute():
                raise MaintenanceError(f"scan path is invalid at line {line_number}")
            scan_root = record.get("scan_root")
            relative_path = record.get("relative_path")
            if (
                not isinstance(scan_root, str)
                or scan_root not in header["scan_roots"]
                or not isinstance(relative_path, str)
                or not _safe_relative(relative_path)
            ):
                raise MaintenanceError(f"scan root/relative path is invalid at line {line_number}")
            declared_root = _absolute(Path(header["repo_root"]) / Path(scan_root))
            expected_path = _absolute(declared_root / Path(relative_path))
            if _path_key(expected_path) != _path_key(absolute_path):
                raise MaintenanceError(f"scan absolute path does not match its root at line {line_number}")
            kind = record.get("kind")
            size = record.get("size")
            mtime_ns = record.get("mtime_ns")
            sha256 = record.get("sha256")
            reparse = record.get("reparse")
            error = record.get("error")
            if kind not in {"file", "directory", "reparse", "error", "other"}:
                raise MaintenanceError(f"scan kind is invalid at line {line_number}")
            if isinstance(size, bool) or not isinstance(size, int) or size < 0:
                raise MaintenanceError(f"scan size is invalid at line {line_number}")
            if isinstance(mtime_ns, bool) or not isinstance(mtime_ns, int) or mtime_ns < 0:
                raise MaintenanceError(f"scan mtime is invalid at line {line_number}")
            if not isinstance(reparse, bool) or reparse != (kind == "reparse"):
                raise MaintenanceError(f"scan reparse flag is invalid at line {line_number}")
            if kind == "file":
                if not isinstance(sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", sha256):
                    raise MaintenanceError(f"scan file SHA-256 is invalid at line {line_number}")
            elif sha256 is not None:
                raise MaintenanceError(f"scan non-file SHA-256 must be null at line {line_number}")
            if kind == "error" and not isinstance(error, str):
                raise MaintenanceError(f"scan error detail is missing at line {line_number}")
            if kind != "error" and error is not None:
                raise MaintenanceError(f"scan error detail is unexpected at line {line_number}")
            key = _path_key(absolute_path)
            if key in seen_paths:
                raise MaintenanceError(f"scan contains duplicate path: {absolute_path}")
            seen_paths.add(key)
            entries.append(record)
            digest.update(raw)
    if header is None or footer is None:
        raise MaintenanceError("scan header/footer is incomplete")
    if footer.get("schema_version") != 1 or footer.get("scan_digest") != digest.hexdigest():
        raise MaintenanceError("scan digest mismatch")
    if footer.get("entry_count") != len(entries):
        raise MaintenanceError("scan entry count mismatch")
    expected_kind_counts = dict(sorted(Counter(str(entry["kind"]) for entry in entries).items()))
    if footer.get("kind_counts") != expected_kind_counts:
        raise MaintenanceError("scan kind counts mismatch")
    byte_count = sum(
        int(entry["size"])
        for entry in entries
        if entry.get("kind") == "file" and isinstance(entry.get("size"), int)
    )
    if footer.get("total_file_bytes") != byte_count:
        raise MaintenanceError("scan byte count mismatch")
    return header, entries, footer


def _inventory_entry(record: Mapping[str, Any]) -> InventoryEntry:
    return InventoryEntry(
        root=_absolute(Path(str(record["absolute_path"])).parents[len(Path(str(record["relative_path"])).parts) - 1])
        if Path(str(record["relative_path"])).parts
        else _absolute(record["absolute_path"]),
        absolute_path=_absolute(record["absolute_path"]),
        relative_path=str(record["relative_path"]),
        kind=str(record["kind"]),
        size=int(record["size"]),
        sha256=record.get("sha256") if isinstance(record.get("sha256"), str) else None,
        mtime_ns=int(record["mtime_ns"]),
        reparse=bool(record["reparse"]),
        error=record.get("error") if isinstance(record.get("error"), str) else None,
    )


def _safe_relative(raw: str) -> bool:
    if not raw or "\x00" in raw:
        return False
    normalized = raw.replace("\\", "/")
    if normalized.startswith("/") or PureWindowsPath(raw).drive:
        return False
    parts = normalized.split("/")
    return all(part not in {"", ".", ".."} for part in parts)


def _archive_proofs(repo: Path, evidence_dir: Path) -> tuple[dict[Path, str], dict[str, Any]]:
    proofs: dict[Path, str] = {}
    report: dict[str, Any] = {"schema_version": 1, "archives": []}
    executable = find_7zip()
    candidates = [
        (repo / "弹国服" / "assets.rar", repo / "弹国服" / "assets"),
        (repo / "弹国服" / "bundle.zip", repo / "弹国服" / "bundle"),
    ]
    for archive, tree in candidates:
        if not archive.is_file() or not tree.is_dir():
            continue
        item: dict[str, Any] = {
            "archive": str(archive),
            "tree": str(tree),
            "test_ok": False,
            "exact": False,
            "issues": [],
        }
        try:
            if executable is None:
                raise ArchiveError("7-Zip executable was not found")
            seven = SevenZip(executable)
            tested = seven.test(archive)
            item["test_ok"] = tested.ok
            item["test_exit_code"] = tested.returncode
            if not tested.ok:
                item["issues"] = [tested.stderr or "7-Zip test failed"]
            else:
                members = seven.list(archive)
                comparison = compare_archive_to_tree(members, tree)
                item.update(
                    {
                        "exact": comparison.exact,
                        "archive_file_count": comparison.archive_file_count,
                        "tree_file_count": comparison.tree_file_count,
                        "byte_count": comparison.total_size,
                        "issues": list(comparison.issues[:200]),
                    }
                )
                if comparison.exact:
                    reason = (
                        f"7-Zip test passed and {comparison.archive_file_count} members "
                        f"match {archive.name} by normalized path, size and CRC"
                    )
                    proofs[tree] = reason
        except (ArchiveError, OSError) as error:
            item["issues"] = [f"{type(error).__name__}: {error}"]
        report["archives"].append(item)
    evidence_dir.mkdir(parents=True, exist_ok=True)
    target = evidence_dir / "archive-comparisons.json"
    atomic_json(target, report)
    return proofs, {"path": str(target), "sha256": sha256_file(target), **report}


def _regeneration_proofs(repo: Path, evidence_dir: Path) -> tuple[dict[Path, str], dict[str, Any]]:
    proofs: dict[Path, str] = {}
    report: dict[str, Any] = {"schema_version": 1, "trees": []}
    script = repo / "弹国服" / "wf_restore_package.py"
    candidate = repo / "弹国服" / "restored_readable"
    manifest = candidate / "_manifest.csv"
    pathlist = candidate / "_pathlist_restored.txt"
    uncovered = candidate / "_uncovered.csv"
    item: dict[str, Any] = {
        "tree": str(candidate),
        "proven": False,
        "issues": [],
    }
    if candidate.is_dir():
        required = [script, manifest, pathlist, uncovered]
        missing = [str(path) for path in required if not path.is_file()]
        if missing:
            item["issues"] = [f"missing regeneration evidence: {path}" for path in missing]
        else:
            expected_files = {"_manifest.csv", "_pathlist_restored.txt", "_uncovered.csv"}
            row_count = 0
            source_cache: dict[str, bool] = {}
            try:
                with manifest.open(encoding="utf-8-sig", newline="") as stream:
                    reader = csv.DictReader(stream)
                    required_columns = {"package", "store", "hash_path", "output_path", "status"}
                    if reader.fieldnames is None or not required_columns.issubset(reader.fieldnames):
                        raise MaintenanceError("restoration manifest columns are incomplete")
                    for row_count, row in enumerate(reader, 1):
                        output_path = row.get("output_path", "")
                        hash_path = row.get("hash_path", "")
                        store = row.get("store", "")
                        package = row.get("package", "")
                        if (
                            not _safe_relative(output_path)
                            or not _safe_relative(hash_path)
                            or not _safe_relative(store)
                        ):
                            raise MaintenanceError(f"unsafe restoration manifest row {row_count}")
                        expected_files.add(output_path.replace("\\", "/"))
                        output_file = candidate / Path(output_path)
                        if not output_file.is_file():
                            raise MaintenanceError(f"restored output is missing: {output_path}")
                        if package == "download":
                            source_root = repo / "弹国服" / "WorldFlipper" / "dummy" / "download" / "production"
                        elif package == "bundle":
                            source_root = repo / "弹国服" / "bundle" / "production"
                        else:
                            raise MaintenanceError(f"unknown restoration package at row {row_count}: {package}")
                        source = source_root / store / Path(hash_path)
                        if not _is_within(source, source_root):
                            raise MaintenanceError(f"restoration source leaves its package: {source}")
                        key = _path_key(source)
                        if key not in source_cache:
                            source_cache[key] = source.is_file()
                        exists = source_cache[key]
                        if not exists:
                            raise MaintenanceError(f"restoration source is missing: {source}")
                actual_files: set[str] = set()
                unsafe_entries: list[str] = []
                for entry in scan_root(candidate, hash_files=False):
                    if entry.kind == "file":
                        actual_files.add(entry.relative_path)
                    elif entry.kind in {"reparse", "error"}:
                        unsafe_entries.append(entry.relative_path)
                if unsafe_entries:
                    raise MaintenanceError(
                        "regenerable tree contains unsafe entries: " + ", ".join(unsafe_entries[:10])
                    )
                if row_count == 0:
                    raise MaintenanceError("restoration manifest has no rows")
                missing_outputs = sorted(expected_files - actual_files)
                extra_outputs = sorted(actual_files - expected_files)
                if missing_outputs or extra_outputs:
                    raise MaintenanceError(
                        f"regenerable tree file set mismatch; missing={missing_outputs[:5]} extra={extra_outputs[:5]}"
                    )
                reason = (
                    f"wf_restore_package.py inputs and all {row_count} manifest outputs verified; "
                    "actual tree has no undeclared files"
                )
                proofs[candidate] = reason
                item.update(
                    {
                        "proven": True,
                        "manifest_rows": row_count,
                        "source_files": len(source_cache),
                        "tree_files": len(actual_files),
                        "manifest_sha256": sha256_file(manifest),
                    }
                )
            except (OSError, UnicodeError, csv.Error, MaintenanceError) as error:
                item["issues"] = [f"{type(error).__name__}: {error}"]
    report["trees"].append(item)
    evidence_dir.mkdir(parents=True, exist_ok=True)
    target = evidence_dir / "regeneration-proofs.json"
    atomic_json(target, report)
    return proofs, {"path": str(target), "sha256": sha256_file(target), **report}


def _backup_evidence(
    entries: list[dict[str, Any]],
    references: ReferenceIndex,
    policy: Policy,
) -> tuple[dict[Path, str], set[str]]:
    groups: dict[tuple[str, str], list[Path]] = defaultdict(list)
    for record in entries:
        if record.get("kind") != "file":
            continue
        path = _absolute(record["absolute_path"])
        folded = path.name.casefold()
        for marker in policy.backup_markers:
            index = folded.find(marker.casefold())
            if index >= 0:
                groups[(_path_key(path.parent), folded[:index])].append(path)
                break
    expired: dict[Path, str] = {}
    retained: set[str] = set()
    for paths in groups.values():
        referenced = [path for path in paths if references.is_referenced(path)]
        last_success = max(referenced, key=lambda item: item.stat().st_mtime_ns) if referenced else None
        decisions = classify_backup_group(
            paths,
            keep_latest=policy.backup_keep_latest,
            referenced=referenced,
            last_success=last_success,
        )
        for decision in decisions:
            if decision.category == "retention_expired":
                expired[decision.path] = decision.reason
            else:
                retained.add(_path_key(decision.path))
    return expired, retained


def _tree_digest_from_scan(
    candidate: Path,
    entries: list[dict[str, Any]],
) -> tuple[str, int]:
    files: list[tuple[str, int, str]] = []
    for record in entries:
        path = _absolute(record["absolute_path"])
        if path == candidate or not _is_within(path, candidate):
            continue
        if record["kind"] in {"reparse", "error"}:
            raise MaintenanceError(f"candidate tree has unsafe scan entry: {path}")
        if record["kind"] != "file":
            continue
        sha256 = record.get("sha256")
        if not isinstance(sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", sha256):
            raise MaintenanceError(f"candidate tree file has no SHA-256: {path}")
        relative = path.relative_to(candidate).as_posix()
        files.append((relative, int(record["size"]), sha256))
    files.sort(key=lambda item: (item[0].casefold(), item[0]))
    digest = hashlib.sha256()
    for relative, size, sha256 in files:
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(size).encode("ascii"))
        digest.update(b"\0")
        digest.update(sha256.encode("ascii"))
        digest.update(b"\n")
    return digest.hexdigest(), sum(item[1] for item in files)


def _make_action(
    record: dict[str, Any],
    decision: Decision,
    entries: list[dict[str, Any]],
) -> dict[str, Any]:
    source = _absolute(record["absolute_path"])
    if record["kind"] == "file":
        digest = record.get("sha256")
        if not isinstance(digest, str):
            raise MaintenanceError(f"file action has no scan digest: {source}")
        size = int(record["size"])
        kind = "file"
    elif record["kind"] == "directory":
        digest, size = _tree_digest_from_scan(source, entries)
        kind = "tree"
    else:
        raise MaintenanceError(f"unsupported action kind: {record['kind']} at {source}")
    return build_plan_entry_from_evidence(
        source,
        kind=kind,
        digest=digest,
        size=size,
        mtime_ns=int(record["mtime_ns"]),
        category=decision.category,
        reason=decision.reason,
        auto_approved=decision.auto_approved,
        evidence=decision.evidence,
    )


def plan_assets(
    scan_path: Path,
    cdn_graph_path: Path,
    policy_path: Path | None = None,
) -> dict[str, Any]:
    scan_file = _regular_file(scan_path, "scan")
    header, entries, footer = load_scan(scan_file)
    repo = Path(str(header.get("repo_root", ""))).resolve(strict=True)
    selected_policy_path = policy_path or Path(str(header.get("policy_path", "")))
    policy = Policy.load(selected_policy_path, repo_root=repo)
    if sha256_file(policy.source) != header.get("policy_sha256"):
        raise MaintenanceError("policy changed after scan")

    graph_file = _regular_file(cdn_graph_path, "CDN graph")
    graph = _load_json(graph_file, "CDN graph")
    if not isinstance(graph, dict):
        raise MaintenanceError("CDN graph root must be an object")
    graph_issues = graph.get("issues", [])
    supported = graph.get("supported", [])
    if not isinstance(graph_issues, list) or graph_issues:
        raise MaintenanceError("CDN graph has unresolved issues")
    if not isinstance(supported, list) or any(
        not isinstance(item, dict) or item.get("reachable") is not True for item in supported
    ):
        raise MaintenanceError("one or more CDN supported bases are unreachable")

    references = ReferenceIndex.from_project(repo, graph_file)
    evidence_dir = scan_file.parent / "evidence"
    print("[asset-plan] proving archive relationships", file=sys.stderr, flush=True)
    exact_duplicates, archive_report = _archive_proofs(repo, evidence_dir)
    print("[asset-plan] proving regenerable trees", file=sys.stderr, flush=True)
    regenerable, regeneration_report = _regeneration_proofs(repo, evidence_dir)
    expired_backups, retained_backups = _backup_evidence(entries, references, policy)

    decisions: list[tuple[dict[str, Any], Decision]] = []
    category_counts: Counter[str] = Counter()
    category_bytes: Counter[str] = Counter()
    for record in entries:
        entry = _inventory_entry(record)
        if _path_key(entry.absolute_path) in retained_backups:
            decision = Decision(
                entry.absolute_path,
                "protected",
                "retained by backup policy",
                (f"keep_latest={policy.backup_keep_latest}",),
                False,
            )
        else:
            decision = classify(
                entry,
                references,
                policy,
                exact_duplicates=exact_duplicates,
                proven_regenerable=regenerable,
                retention_expired=expired_backups,
            )
        decisions.append((record, decision))
        category_counts[decision.category] += 1
        if record["kind"] == "file":
            category_bytes[decision.category] += int(record["size"])

    candidates = [(record, decision) for record, decision in decisions if decision.auto_approved]
    candidates.sort(
        key=lambda item: (
            len(_absolute(item[0]["absolute_path"]).parts),
            _path_key(item[0]["absolute_path"]),
        )
    )
    selected: list[tuple[dict[str, Any], Decision]] = []
    selected_roots: list[Path] = []
    blocked_roots: list[Path] = []
    for record, decision in candidates:
        path = _absolute(record["absolute_path"])
        if any(_is_within(path, root) for root in selected_roots + blocked_roots):
            continue
        if record["kind"] == "directory":
            descendant_categories = {
                child_decision.category
                for child_record, child_decision in decisions
                if _absolute(child_record["absolute_path"]) != path
                and _is_within(child_record["absolute_path"], path)
            }
            forbidden = {"protected", "live_referenced", "corrupt"}
            if decision.category == "stale_cache":
                forbidden.add("unknown")
            if descendant_categories & forbidden:
                blocked_roots.append(path)
                continue
            selected_roots.append(path)
        selected.append((record, decision))

    actions = [_make_action(record, decision, entries) for record, decision in selected]
    move_counts = Counter(action["category"] for action in actions)
    move_bytes = Counter()
    for action in actions:
        move_bytes[action["category"]] += int(action["size"])

    required_existing = sorted(
        {
            str(path)
            for path in [*references.paths, *references.roots, *policy.protected_roots]
            if Path(path).exists() or Path(path).is_symlink()
        },
        key=lambda value: (value.casefold(), value),
    )
    metadata = {
        "repo_root": str(repo),
        "scan_path": str(scan_file),
        "scan_digest": footer["scan_digest"],
        "policy_path": str(policy.source),
        "policy_sha256": sha256_file(policy.source),
        "cdn_graph_path": str(graph_file),
        "cdn_graph_sha256": sha256_file(graph_file),
        "cdn_graph_healthy": True,
        "classification_counts": dict(sorted(category_counts.items())),
        "classification_bytes": dict(sorted(category_bytes.items())),
        "move_counts": dict(sorted(move_counts.items())),
        "move_bytes": dict(sorted(move_bytes.items())),
        "required_existing": required_existing,
        "archive_evidence": {
            "path": archive_report["path"],
            "sha256": archive_report["sha256"],
        },
        "regeneration_evidence": {
            "path": regeneration_report["path"],
            "sha256": regeneration_report["sha256"],
        },
    }
    plan_record = write_plan(actions, scan_file.parent, run_id=str(header["run_id"]), metadata=metadata)
    report = {
        "schema_version": 1,
        "plan_path": str(plan_record.path),
        "plan_digest": plan_record.digest,
        **metadata,
    }
    atomic_json(scan_file.parent / "plan-report.json", report)
    return {
        "ok": True,
        "run_id": str(header["run_id"]),
        "artifact": str(plan_record.path),
        "plan_digest": plan_record.digest,
        "move_counts": dict(sorted(move_counts.items())),
        "move_bytes": dict(sorted(move_bytes.items())),
        "auto_move_bytes": sum(move_bytes.values()),
        "classification_counts": dict(sorted(category_counts.items())),
    }


def preflight_plan(plan_path: Path) -> dict[str, Any]:
    plan = read_plan(plan_path)
    metadata = plan.get("metadata")
    if not isinstance(metadata, dict):
        raise MaintenanceError("plan metadata is missing")
    entries = plan["entries"]
    counts = Counter(str(entry["category"]) for entry in entries)
    forbidden = {"unknown", "corrupt", "protected", "live_referenced"}
    invalid = [
        entry
        for entry in entries
        if entry["category"] in forbidden
        or entry["category"] not in AUTO_CATEGORIES
        or entry["auto_approved"] is not True
    ]
    issues: list[str] = []
    if invalid:
        issues.append(f"plan contains {len(invalid)} forbidden/unapproved entries")
    if metadata.get("cdn_graph_healthy") is not True:
        issues.append("CDN graph health evidence is false")
    for key in ("scan_digest", "policy_sha256", "cdn_graph_sha256"):
        value = metadata.get(key)
        if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value):
            issues.append(f"plan metadata {key} is invalid")
    required = metadata.get("required_existing")
    if not isinstance(required, list) or not required:
        issues.append("plan has no protected/live reference snapshot")
    payload = {
        "ok": not issues,
        "run_id": plan["run_id"],
        "artifact": str(_absolute(plan_path)),
        "plan_digest": plan["plan_digest"],
        "move_counts": dict(sorted(counts.items())),
        "unknown_moved": counts.get("unknown", 0),
        "corrupt_moved": counts.get("corrupt", 0),
        "protected_moved": counts.get("protected", 0),
        "issues": issues,
    }
    if issues:
        raise VerificationFailure("asset plan preflight failed", payload)
    return payload


def _context_payload(plan_path: Path, plan: Mapping[str, Any]) -> dict[str, Any]:
    payload = {
        "schema_version": 1,
        "plan_path": str(_absolute(plan_path)),
        "plan_digest": plan["plan_digest"],
        "metadata": plan["metadata"],
    }
    payload["context_digest"] = canonical_digest(payload)
    return payload


def quarantine_assets(plan_path: Path, quarantine_root: Path) -> dict[str, Any]:
    plan = read_plan(plan_path)
    preflight_plan(plan_path)
    metadata = plan["metadata"]
    Policy.load(
        Path(metadata["policy_path"]),
        repo_root=Path(metadata["repo_root"]),
        quarantine_root=quarantine_root,
    )
    summary = quarantine(plan_path, quarantine_root)
    context = _context_payload(plan_path, plan)
    atomic_json(_absolute(quarantine_root) / "context.json", context)
    return {
        "ok": True,
        "run_id": plan["run_id"],
        "artifact": str(summary.manifest_path),
        "moved_count": summary.moved_count,
        "byte_count": summary.byte_count,
        "moved_by_category": dict(summary.moved_by_category or {}),
    }


def verify_quarantine(manifest_path: Path) -> dict[str, Any]:
    summary = verify_manifest(manifest_path)
    issues = list(summary.issues)
    context_path = summary.manifest_path.parent / "context.json"
    if not context_path.is_file():
        issues.append(f"quarantine context is missing: {context_path}")
        context: dict[str, Any] = {}
    else:
        loaded = _load_json(context_path, "quarantine context")
        context = loaded if isinstance(loaded, dict) else {}
        stored = context.get("context_digest")
        unsigned = dict(context)
        unsigned.pop("context_digest", None)
        if not isinstance(stored, str) or canonical_digest(unsigned) != stored:
            issues.append("quarantine context digest mismatch")
        metadata = context.get("metadata", {})
        required = metadata.get("required_existing", []) if isinstance(metadata, dict) else []
        if not isinstance(required, list):
            issues.append("quarantine context required_existing is invalid")
        else:
            missing = [path for path in required if not Path(path).exists() and not Path(path).is_symlink()]
            if missing:
                issues.append(f"protected/live paths are missing after quarantine: {missing[:10]}")
    payload = {
        "ok": not issues,
        "run_id": summary.manifest_path.parent.name,
        "artifact": str(summary.manifest_path),
        "verified_count": summary.verified_count,
        "byte_count": summary.byte_count,
        "state_counts": dict(summary.state_counts),
        "issues": issues,
    }
    if issues:
        raise VerificationFailure("quarantine verification failed", payload)
    return payload


def _operation_payload(summary: Any, run_id: str) -> dict[str, Any]:
    return {
        "ok": True,
        "run_id": run_id,
        "artifact": str(summary.manifest_path),
        "operation": summary.operation,
        "moved_count": summary.moved_count,
        "restored_count": summary.restored_count,
        "purged_count": summary.purged_count,
        "byte_count": summary.byte_count,
        "moved_by_category": dict(summary.moved_by_category or {}),
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Evidence-based reversible asset maintenance")
    subparsers = parser.add_subparsers(dest="command", required=True)

    scan = subparsers.add_parser("scan")
    scan.add_argument("--repo-root", required=True, type=Path)
    scan.add_argument("--policy", required=True, type=Path)
    scan.add_argument("--run-dir", required=True, type=Path)

    plan = subparsers.add_parser("plan")
    plan.add_argument("--scan", required=True, type=Path)
    plan.add_argument("--cdn-graph", required=True, type=Path)
    plan.add_argument("--policy", type=Path)

    quarantine_parser = subparsers.add_parser("quarantine")
    mode = quarantine_parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--plan", type=Path)
    mode.add_argument("--manifest", type=Path)
    quarantine_parser.add_argument("--quarantine-root", type=Path)
    quarantine_parser.add_argument("--resume", action="store_true")
    quarantine_parser.add_argument("--id", action="append", default=[])

    verify = subparsers.add_parser("verify")
    verify_mode = verify.add_mutually_exclusive_group(required=True)
    verify_mode.add_argument("--plan", type=Path)
    verify_mode.add_argument("--manifest", type=Path)
    verify.add_argument("--mode", choices=["preflight"])

    restore_parser = subparsers.add_parser("restore")
    restore_parser.add_argument("--manifest", required=True, type=Path)
    restore_parser.add_argument("--id", action="append", default=[])

    purge_parser = subparsers.add_parser("purge")
    purge_parser.add_argument("--manifest", required=True, type=Path)
    purge_parser.add_argument("--confirm", required=True)
    purge_parser.add_argument("--id", action="append", default=[])
    return parser


def _dispatch(args: argparse.Namespace) -> dict[str, Any]:
    if args.command == "scan":
        return scan_assets(args.repo_root, args.policy, args.run_dir)
    if args.command == "plan":
        return plan_assets(args.scan, args.cdn_graph, args.policy)
    if args.command == "verify":
        if args.plan is not None:
            if args.mode != "preflight":
                raise MaintenanceError("--plan verification requires --mode preflight")
            return preflight_plan(args.plan)
        if args.mode is not None:
            raise MaintenanceError("--mode is only valid with --plan")
        return verify_quarantine(args.manifest)
    if args.command == "quarantine":
        ids = args.id or None
        if args.resume:
            if args.manifest is None or args.plan is not None or args.quarantine_root is not None:
                raise MaintenanceError("--resume requires only --manifest and optional --id")
            summary = resume_quarantine(args.manifest, ids)
            return _operation_payload(summary, summary.manifest_path.parent.name)
        if args.plan is None or args.manifest is not None or args.quarantine_root is None:
            raise MaintenanceError("initial quarantine requires --plan and --quarantine-root")
        if ids is not None:
            raise MaintenanceError("initial CLI quarantine does not allow partial IDs")
        return quarantine_assets(args.plan, args.quarantine_root)
    if args.command == "restore":
        summary = restore(args.manifest, args.id or None)
        return _operation_payload(summary, summary.manifest_path.parent.name)
    if args.command == "purge":
        summary = purge(args.manifest, confirmation=args.confirm, ids=args.id or None)
        return _operation_payload(summary, summary.manifest_path.parent.name)
    raise MaintenanceError(f"unsupported command: {args.command}")


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args = _parser().parse_args(argv)
        payload = _dispatch(args)
        print(json.dumps(payload, ensure_ascii=False, sort_keys=True, allow_nan=False))
        return 0
    except VerificationFailure as error:
        payload = {**error.payload, "ok": False, "error": str(error)}
        print(json.dumps(payload, ensure_ascii=False, sort_keys=True, allow_nan=False))
        return 4
    except (MaintenanceError, InventoryError, PolicyError, ArchiveError, QuarantineError, OSError) as error:
        code = 2
        command = getattr(locals().get("args", None), "command", None)
        manifest: Path | None = None
        if command == "quarantine":
            root = getattr(args, "quarantine_root", None)
            manifest = _absolute(root) / "manifest.jsonl" if root is not None else getattr(args, "manifest", None)
        elif command in {"restore", "purge"}:
            manifest = getattr(args, "manifest", None)
        if manifest is not None and Path(manifest).is_file() and Path(manifest).stat().st_size > 0:
            try:
                if command == "quarantine" and getattr(args, "resume", False) is False:
                    code = 3
                else:
                    latest_states: dict[str, str] = {}
                    for record in read_manifest(Path(manifest)):
                        latest_states[str(record["id"])] = str(record["state"])
                    if set(latest_states.values()) & {
                        "planned", "restore_planned", "requarantine_planned", "purge_planned"
                    }:
                        code = 3
            except QuarantineError:
                code = 3
        payload = {
            "ok": False,
            "run_id": None,
            "artifact": str(manifest) if manifest is not None else None,
            "error": f"{type(error).__name__}: {error}",
        }
        print(json.dumps(payload, ensure_ascii=False, sort_keys=True, allow_nan=False))
        return code


if __name__ == "__main__":
    raise SystemExit(main())
