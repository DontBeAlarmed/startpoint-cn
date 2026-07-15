# -*- coding: utf-8 -*-
from __future__ import annotations

import hashlib
import os
import stat
from dataclasses import dataclass
from pathlib import Path
from collections.abc import Iterable
from typing import Iterator


DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024
_REPARSE_ATTRIBUTE = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)


class InventoryError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class InventoryEntry:
    root: Path
    absolute_path: Path
    relative_path: str
    kind: str
    size: int
    sha256: str | None
    mtime_ns: int
    reparse: bool
    error: str | None = None


@dataclass(frozen=True, slots=True)
class TreeManifest:
    root: Path
    files: tuple[InventoryEntry, ...]
    tree_sha256: str
    file_count: int
    total_size: int
    reparse_count: int
    error_count: int


def sha256_file(path: Path, chunk_size: int = DEFAULT_CHUNK_SIZE) -> str:
    if chunk_size <= 0:
        raise ValueError("chunk_size must be positive")
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(chunk_size), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _is_reparse(metadata: os.stat_result) -> bool:
    if stat.S_ISLNK(metadata.st_mode):
        return True
    attributes = int(getattr(metadata, "st_file_attributes", 0))
    return bool(attributes & _REPARSE_ATTRIBUTE)


def _stable_name_key(name: str) -> tuple[str, str]:
    return name.casefold(), name


def _path_key(path: Path) -> str:
    return os.path.normcase(os.path.abspath(os.fspath(path)))


def _is_within_key(path: Path, root_key: str) -> bool:
    try:
        return os.path.commonpath([_path_key(path), root_key]) == root_key
    except ValueError:
        return False


def _relative(root: Path, target: Path) -> str:
    return target.relative_to(root).as_posix()


def _error_entry(
    root: Path,
    target: Path,
    metadata: os.stat_result | None,
    error: BaseException,
) -> InventoryEntry:
    return InventoryEntry(
        root=root,
        absolute_path=target,
        relative_path=_relative(root, target),
        kind="error",
        size=int(metadata.st_size) if metadata is not None else 0,
        sha256=None,
        mtime_ns=int(metadata.st_mtime_ns) if metadata is not None else 0,
        reparse=False,
        error=f"{type(error).__name__}: {error}",
    )


def _scan_directory(
    root: Path,
    directory: Path,
    *,
    hash_files: bool,
    exclude_keys: tuple[str, ...],
) -> Iterator[InventoryEntry]:
    try:
        with os.scandir(directory) as stream:
            children = sorted(list(stream), key=lambda item: _stable_name_key(item.name))
    except OSError as error:
        yield _error_entry(root, directory, None, error)
        return

    for child in children:
        target = directory / child.name
        if any(_is_within_key(target, excluded) for excluded in exclude_keys):
            continue
        metadata: os.stat_result | None = None
        try:
            metadata = child.stat(follow_symlinks=False)
            if _is_reparse(metadata):
                yield InventoryEntry(
                    root=root,
                    absolute_path=target,
                    relative_path=_relative(root, target),
                    kind="reparse",
                    size=int(metadata.st_size),
                    sha256=None,
                    mtime_ns=int(metadata.st_mtime_ns),
                    reparse=True,
                )
                continue

            if stat.S_ISDIR(metadata.st_mode):
                yield InventoryEntry(
                    root=root,
                    absolute_path=target,
                    relative_path=_relative(root, target),
                    kind="directory",
                    size=0,
                    sha256=None,
                    mtime_ns=int(metadata.st_mtime_ns),
                    reparse=False,
                )
                yield from _scan_directory(
                    root,
                    target,
                    hash_files=hash_files,
                    exclude_keys=exclude_keys,
                )
                continue

            if stat.S_ISREG(metadata.st_mode):
                digest = sha256_file(target) if hash_files else None
                if hash_files:
                    after = target.stat(follow_symlinks=False)
                    if (
                        _is_reparse(after)
                        or after.st_size != metadata.st_size
                        or after.st_mtime_ns != metadata.st_mtime_ns
                    ):
                        raise InventoryError(f"file changed while hashing: {target}")
                yield InventoryEntry(
                    root=root,
                    absolute_path=target,
                    relative_path=_relative(root, target),
                    kind="file",
                    size=int(metadata.st_size),
                    sha256=digest,
                    mtime_ns=int(metadata.st_mtime_ns),
                    reparse=False,
                )
                continue

            yield InventoryEntry(
                root=root,
                absolute_path=target,
                relative_path=_relative(root, target),
                kind="other",
                size=int(metadata.st_size),
                sha256=None,
                mtime_ns=int(metadata.st_mtime_ns),
                reparse=False,
            )
        except (OSError, InventoryError) as error:
            yield _error_entry(root, target, metadata, error)


def scan_root(
    root: Path,
    *,
    hash_files: bool = True,
    exclude_roots: Iterable[Path] = (),
) -> Iterator[InventoryEntry]:
    root = Path(os.path.abspath(os.fspath(root)))
    exclude_keys = tuple(_path_key(Path(item)) for item in exclude_roots)
    if any(_is_within_key(root, excluded) for excluded in exclude_keys):
        raise InventoryError(f"scan root is excluded: {root}")
    try:
        metadata = root.stat(follow_symlinks=False)
    except OSError as error:
        raise InventoryError(f"scan root is unavailable: {root}: {error}") from error
    if _is_reparse(metadata):
        raise InventoryError(f"scan root must not be a reparse point: {root}")
    if not stat.S_ISDIR(metadata.st_mode):
        raise InventoryError(f"scan root is not a directory: {root}")
    yield from _scan_directory(
        root,
        root,
        hash_files=hash_files,
        exclude_keys=exclude_keys,
    )


def tree_manifest(root: Path) -> TreeManifest:
    root = Path(os.path.abspath(os.fspath(root)))
    entries = tuple(scan_root(root))
    files = tuple(
        sorted(
            (entry for entry in entries if entry.kind == "file"),
            key=lambda item: (item.relative_path.casefold(), item.relative_path),
        )
    )
    digest = hashlib.sha256()
    for entry in files:
        digest.update(entry.relative_path.replace("\\", "/").encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(entry.size).encode("ascii"))
        digest.update(b"\0")
        digest.update((entry.sha256 or "").encode("ascii"))
        digest.update(b"\n")
    return TreeManifest(
        root=root,
        files=files,
        tree_sha256=digest.hexdigest(),
        file_count=len(files),
        total_size=sum(entry.size for entry in files),
        reparse_count=sum(entry.kind == "reparse" for entry in entries),
        error_count=sum(entry.kind == "error" for entry in entries),
    )
