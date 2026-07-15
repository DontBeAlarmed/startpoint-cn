# -*- coding: utf-8 -*-
from __future__ import annotations

import binascii
import os
import re
import shutil
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path, PureWindowsPath
from typing import Any

from wf_asset_inventory import InventoryError, scan_root


class ArchiveError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class ArchiveTestResult:
    ok: bool
    returncode: int
    stderr: str


@dataclass(frozen=True, slots=True)
class ArchiveMember:
    path: str
    size: int
    crc32: str | None
    is_directory: bool
    encrypted: bool


@dataclass(frozen=True, slots=True)
class ArchiveTreeComparison:
    exact: bool
    issues: tuple[str, ...]
    archive_file_count: int
    tree_file_count: int
    total_size: int


Runner = Callable[[list[str]], Any]
_CRC_RE = re.compile(r"^[0-9A-Fa-f]{8}$")


def find_7zip() -> Path | None:
    candidates = [
        Path(r"C:\Program Files\7-Zip\7z.exe"),
        Path(r"C:\Program Files (x86)\7-Zip\7z.exe"),
    ]
    located = shutil.which("7z") or shutil.which("7z.exe")
    if located:
        candidates.append(Path(located))
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    return None


def _run(argv: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        argv,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )


def _safe_member_path(raw: str) -> str:
    if not raw or "\x00" in raw:
        raise ArchiveError(f"unsafe archive member path: {raw!r}")
    windows = PureWindowsPath(raw)
    normalized = raw.replace("\\", "/")
    if windows.drive or normalized.startswith("/") or normalized.startswith("//"):
        raise ArchiveError(f"unsafe archive member path: {raw}")
    normalized = normalized.rstrip("/")
    parts = normalized.split("/")
    if not normalized or any(part in {"", ".", ".."} for part in parts):
        raise ArchiveError(f"unsafe archive member path: {raw}")
    return "/".join(parts)


def _parse_records(output: str) -> list[dict[str, str]]:
    records: list[dict[str, str]] = []
    current: dict[str, str] = {}
    for raw_line in output.splitlines():
        line = raw_line.rstrip("\r")
        if not line:
            if current:
                records.append(current)
                current = {}
            continue
        if " = " not in line:
            raise ArchiveError(f"invalid 7-Zip listing line: {line[:160]}")
        key, value = line.split(" = ", 1)
        if key in current:
            raise ArchiveError(f"duplicate 7-Zip listing field: {key}")
        current[key] = value
    if current:
        records.append(current)
    return records


def _parse_members(output: str) -> tuple[ArchiveMember, ...]:
    members: list[ArchiveMember] = []
    seen: set[str] = set()
    for index, record in enumerate(_parse_records(output)):
        raw_path = record.get("Path")
        if raw_path is None:
            raise ArchiveError(f"7-Zip member {index} has no Path")
        member_path = _safe_member_path(raw_path)
        duplicate_key = member_path.casefold()
        if duplicate_key in seen:
            raise ArchiveError(f"duplicate normalized archive member path: {member_path}")
        seen.add(duplicate_key)
        folder_value = record.get("Folder", "-")
        attributes = record.get("Attributes", "")
        is_directory = folder_value == "+" or attributes.upper().startswith("D")
        raw_size = record.get("Size", "0" if is_directory else "")
        try:
            size = int(raw_size)
        except (TypeError, ValueError) as error:
            raise ArchiveError(f"invalid Size for archive member {member_path}: {raw_size!r}") from error
        if size < 0:
            raise ArchiveError(f"negative Size for archive member {member_path}")
        raw_crc = record.get("CRC", "").strip()
        crc32 = raw_crc.upper() if raw_crc else None
        if crc32 is not None and not _CRC_RE.fullmatch(crc32):
            raise ArchiveError(f"invalid CRC for archive member {member_path}: {raw_crc!r}")
        encrypted = record.get("Encrypted", "-").strip() not in {"", "-"}
        members.append(
            ArchiveMember(
                path=member_path,
                size=size,
                crc32=crc32,
                is_directory=is_directory,
                encrypted=encrypted,
            )
        )
    return tuple(members)


class SevenZip:
    def __init__(self, executable: Path | None = None, *, runner: Runner = _run) -> None:
        selected = executable if executable is not None else find_7zip()
        if selected is None:
            raise ArchiveError("7-Zip executable was not found")
        self.executable = Path(selected)
        self.runner = runner

    def test(self, archive: Path) -> ArchiveTestResult:
        completed = self.runner(
            [
                str(self.executable),
                "t",
                "-bso0",
                "-bsp0",
                "-bse1",
                "--",
                str(Path(archive)),
            ]
        )
        return ArchiveTestResult(
            ok=completed.returncode == 0,
            returncode=int(completed.returncode),
            stderr=str(completed.stderr or "")[-4000:],
        )

    def list(self, archive: Path) -> tuple[ArchiveMember, ...]:
        completed = self.runner(
            [
                str(self.executable),
                "l",
                "-slt",
                "-ba",
                "-sccUTF-8",
                "-bso1",
                "-bsp0",
                "-bse1",
                "--",
                str(Path(archive)),
            ]
        )
        if completed.returncode != 0:
            detail = str(completed.stderr or "")[-4000:]
            raise ArchiveError(
                f"archive listing failed with exit code {completed.returncode}: {detail}"
            )
        return _parse_members(str(completed.stdout or ""))


def _crc32_file(path: Path, chunk_size: int = 8 * 1024 * 1024) -> str:
    checksum = 0
    before = path.stat(follow_symlinks=False)
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(chunk_size), b""):
            checksum = binascii.crc32(chunk, checksum)
    after = path.stat(follow_symlinks=False)
    if before.st_size != after.st_size or before.st_mtime_ns != after.st_mtime_ns:
        raise ArchiveError(f"tree file changed during CRC comparison: {path}")
    return f"{checksum & 0xFFFFFFFF:08X}"


def compare_archive_to_tree(
    members: tuple[ArchiveMember, ...] | list[ArchiveMember],
    tree_root: Path,
) -> ArchiveTreeComparison:
    root = Path(os.path.abspath(tree_root))
    issues: list[str] = []
    try:
        entries = tuple(scan_root(root, hash_files=False))
    except InventoryError as error:
        return ArchiveTreeComparison(False, (str(error),), 0, 0, 0)

    for entry in entries:
        if entry.kind == "reparse":
            issues.append(f"tree contains reparse point: {entry.relative_path}")
        elif entry.kind == "error":
            issues.append(f"tree inventory error: {entry.relative_path}: {entry.error}")

    tree_files: dict[str, Any] = {}
    tree_directories = {
        entry.relative_path.casefold()
        for entry in entries
        if entry.kind == "directory"
    }
    for entry in entries:
        if entry.kind != "file":
            continue
        key = entry.relative_path.casefold()
        if key in tree_files:
            issues.append(f"tree has duplicate normalized path: {entry.relative_path}")
        tree_files[key] = entry

    archive_files = [member for member in members if not member.is_directory]
    archive_keys = {member.path.casefold() for member in archive_files}
    for member in members:
        key = member.path.casefold()
        if member.is_directory:
            if key not in tree_directories:
                issues.append(f"archive directory missing from tree: {member.path}")
            continue
        entry = tree_files.get(key)
        if entry is None:
            issues.append(f"archive file missing from tree: {member.path}")
            continue
        if member.encrypted:
            issues.append(f"archive member is encrypted: {member.path}")
        if member.crc32 is None:
            issues.append(f"archive member has no CRC: {member.path}")
        if member.size != entry.size:
            issues.append(
                f"size mismatch for {member.path}: archive={member.size} tree={entry.size}"
            )
        if member.crc32 is not None:
            try:
                actual_crc = _crc32_file(entry.absolute_path)
            except (OSError, ArchiveError) as error:
                issues.append(f"CRC read failed for {member.path}: {error}")
            else:
                if actual_crc != member.crc32:
                    issues.append(
                        f"CRC mismatch for {member.path}: archive={member.crc32} tree={actual_crc}"
                    )

    for key, entry in tree_files.items():
        if key not in archive_keys:
            issues.append(f"tree file absent from archive: {entry.relative_path}")

    return ArchiveTreeComparison(
        exact=not issues,
        issues=tuple(issues),
        archive_file_count=len(archive_files),
        tree_file_count=len(tree_files),
        total_size=sum(member.size for member in archive_files),
    )
