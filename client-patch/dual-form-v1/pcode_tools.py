#!/usr/bin/env python3
"""Fail-closed helpers for extracting one FFDec AS3 P-code method block."""

from __future__ import annotations

import argparse
import re
import tempfile
from pathlib import Path


class PcodePatchError(RuntimeError):
    pass


def extract_method_block(
    text: str,
    *,
    trait_kind: str,
    trait_name: str,
) -> str:
    if trait_kind not in {"method", "getter", "setter"}:
        raise PcodePatchError(f"unsupported trait kind: {trait_kind}")
    lines = text.splitlines()
    pattern = re.compile(
        rf'^(?P<indent>\s*)trait\s+{re.escape(trait_kind)}\s+.*,"'
        rf'{re.escape(trait_name)}"\)\s*$'
    )
    matches = [index for index, line in enumerate(lines) if pattern.match(line)]
    if len(matches) != 1:
        raise PcodePatchError(
            f"expected exactly one {trait_kind} trait {trait_name!r}, "
            f"found {len(matches)}"
        )
    start = matches[0]
    method_line = None
    for index in range(start + 1, len(lines)):
        if lines[index].strip() == "method":
            method_line = index
            break
        if lines[index].lstrip().startswith("trait "):
            break
    if method_line is None:
        raise PcodePatchError(f"method block is missing for trait {trait_name!r}")
    method_indent = lines[method_line][: len(lines[method_line]) - len(lines[method_line].lstrip())]
    end_line = None
    for index in range(method_line + 1, len(lines)):
        if lines[index] == f"{method_indent}end ; method":
            end_line = index
            break
    if end_line is None:
        raise PcodePatchError(f"method block is unterminated for trait {trait_name!r}")
    return "\n".join(lines[start : end_line + 1]) + "\n"


def extract_named_method_block(text: str, *, method_info_name: str) -> str:
    lines = text.splitlines()
    pattern = re.compile(
        rf'^\s*name\s+"{re.escape(method_info_name)}"\s*$'
    )
    matches = [index for index, line in enumerate(lines) if pattern.match(line)]
    if len(matches) != 1:
        raise PcodePatchError(
            f"expected exactly one method info name {method_info_name!r}, "
            f"found {len(matches)}"
        )
    name_line = matches[0]
    method_line = None
    for index in range(name_line - 1, -1, -1):
        if lines[index].strip() == "method":
            method_line = index
            break
    if method_line is None:
        raise PcodePatchError(
            f"method block is missing for method info {method_info_name!r}"
        )
    method_indent = lines[method_line][: len(lines[method_line]) - len(lines[method_line].lstrip())]
    end_line = None
    for index in range(name_line + 1, len(lines)):
        if lines[index] == f"{method_indent}end ; method":
            end_line = index
            break
    if end_line is None:
        raise PcodePatchError(
            f"method block is unterminated for method info {method_info_name!r}"
        )
    return "\n".join(lines[method_line : end_line + 1]) + "\n"


def _write_atomic(path: Path, text: str) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        newline="\n",
        delete=False,
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
    ) as handle:
        handle.write(text)
        temporary = Path(handle.name)
    temporary.replace(path)


def write_method_block(
    source: Path,
    destination: Path,
    *,
    trait_kind: str,
    trait_name: str,
) -> None:
    try:
        text = Path(source).read_text(encoding="utf-8")
    except OSError as exc:
        raise PcodePatchError(f"cannot read P-code export {source}: {exc}") from exc
    block = extract_method_block(
        text,
        trait_kind=trait_kind,
        trait_name=trait_name,
    )
    _write_atomic(Path(destination), block)


def write_named_method_block(
    source: Path,
    destination: Path,
    *,
    method_info_name: str,
) -> None:
    try:
        text = Path(source).read_text(encoding="utf-8")
    except OSError as exc:
        raise PcodePatchError(f"cannot read P-code export {source}: {exc}") from exc
    _write_atomic(
        Path(destination),
        extract_named_method_block(text, method_info_name=method_info_name),
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--trait-kind", default="method")
    parser.add_argument("--trait-name", required=True)
    args = parser.parse_args()
    try:
        write_method_block(
            args.source,
            args.destination,
            trait_kind=args.trait_kind,
            trait_name=args.trait_name,
        )
    except PcodePatchError as exc:
        parser.error(str(exc))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
