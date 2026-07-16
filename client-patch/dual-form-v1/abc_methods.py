#!/usr/bin/env python3
"""Small fail-closed AVM2 method-body indexer for exact SWF patching.

FFDec's P-code replacement command requires the method-body index relative to
the DoABC tag that owns the selected script pack.  The normal P-code export
does not print that index, so this module reads only enough of the ABC format
to map method_info names to method bodies.  It deliberately does not modify
the SWF.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
import zlib
from pathlib import Path
from typing import Iterable


class AbcIndexError(RuntimeError):
    pass


class Reader:
    def __init__(self, data: bytes, label: str) -> None:
        self.data = data
        self.label = label
        self.pos = 0

    def remaining(self) -> int:
        return len(self.data) - self.pos

    def _need(self, size: int) -> None:
        if size < 0 or self.pos + size > len(self.data):
            raise AbcIndexError(
                f"truncated {self.label} at 0x{self.pos:x}: need {size} bytes"
            )

    def u8(self) -> int:
        self._need(1)
        value = self.data[self.pos]
        self.pos += 1
        return value

    def u16(self) -> int:
        self._need(2)
        value = struct.unpack_from("<H", self.data, self.pos)[0]
        self.pos += 2
        return value

    def u32(self) -> int:
        self._need(4)
        value = struct.unpack_from("<I", self.data, self.pos)[0]
        self.pos += 4
        return value

    def u30(self) -> int:
        value = 0
        shift = 0
        for _ in range(5):
            byte = self.u8()
            value |= (byte & 0x7F) << shift
            if not byte & 0x80:
                if value > 0x3FFFFFFF:
                    raise AbcIndexError(
                        f"invalid u30 in {self.label} at 0x{self.pos:x}"
                    )
                return value
            shift += 7
        raise AbcIndexError(f"unterminated u30 in {self.label} at 0x{self.pos:x}")

    def varint32(self) -> int:
        """Consume an ABC s32/u32 pool entry without applying u30 limits."""
        value = 0
        shift = 0
        for _ in range(5):
            byte = self.u8()
            value |= (byte & 0x7F) << shift
            if not byte & 0x80:
                return value & 0xFFFFFFFF
            shift += 7
        return value & 0xFFFFFFFF

    def take(self, size: int) -> bytes:
        self._need(size)
        value = self.data[self.pos : self.pos + size]
        self.pos += size
        return value

    def skip(self, size: int) -> None:
        self.take(size)


class MethodBodyRef:
    def __init__(
        self,
        *,
        abc_index: int,
        abc_name: str,
        method_name: str,
        method_info_index: int,
        body_index: int,
        code: bytes,
        aliases: Iterable[str] = (),
    ) -> None:
        self.abc_index = abc_index
        self.abc_name = abc_name
        self.method_name = method_name
        self.method_info_index = method_info_index
        self.body_index = body_index
        self.code = code
        self.aliases = tuple(dict.fromkeys((method_name, *aliases)))

    def as_dict(self) -> dict[str, object]:
        return {
            "abc_index": self.abc_index,
            "abc_name": self.abc_name,
            "method_name": self.method_name,
            "aliases": list(self.aliases),
            "method_info_index": self.method_info_index,
            "body_index": self.body_index,
            "code_sha256": hashlib.sha256(self.code).hexdigest(),
            "code_length": len(self.code),
        }


class SwfMethodIndex:
    def __init__(self, refs: Iterable[MethodBodyRef]) -> None:
        self.refs = tuple(refs)
        self.by_name: dict[str, list[MethodBodyRef]] = {}
        for ref in self.refs:
            for alias in ref.aliases:
                self.by_name.setdefault(alias, []).append(ref)

    def require_ref(self, method_name: str) -> MethodBodyRef:
        matches = self.by_name.get(method_name, [])
        if len(matches) != 1:
            raise AbcIndexError(
                f"expected exactly one body for {method_name!r}, found {len(matches)}"
            )
        return matches[0]

    def require_unique(self, method_name: str) -> int:
        return self.require_ref(method_name).body_index


def _load_swf_tag_stream(path: Path) -> bytes:
    data = Path(path).read_bytes()
    if len(data) < 8:
        raise AbcIndexError(f"SWF is truncated: {path}")
    signature = data[:3]
    if signature == b"FWS":
        body = data[8:]
    elif signature == b"CWS":
        try:
            body = zlib.decompress(data[8:])
        except zlib.error as exc:
            raise AbcIndexError(f"cannot decompress CWS {path}: {exc}") from exc
    elif signature == b"ZWS":
        raise AbcIndexError("ZWS input is not supported by this narrow indexer")
    else:
        raise AbcIndexError(f"not a SWF file: signature={signature!r}")

    reader = Reader(body, f"SWF body {path}")
    nbits = reader.data[0] >> 3
    rect_size = (5 + 4 * nbits + 7) // 8
    reader.skip(rect_size)
    reader.skip(4)  # frame rate and frame count
    return reader.data[reader.pos :]


def _iter_doabc(path: Path) -> Iterable[tuple[int, str, bytes]]:
    reader = Reader(_load_swf_tag_stream(path), f"SWF tags {path}")
    abc_index = 0
    while reader.remaining() >= 2:
        header = reader.u16()
        tag_code = header >> 6
        length = header & 0x3F
        if length == 0x3F:
            length = reader.u32()
        payload = reader.take(length)
        if tag_code == 82:
            payload_reader = Reader(payload, f"DoABC[{abc_index}]")
            payload_reader.u32()  # flags
            name_bytes = bytearray()
            while True:
                byte = payload_reader.u8()
                if byte == 0:
                    break
                name_bytes.append(byte)
            name = bytes(name_bytes).decode("utf-8", errors="replace")
            yield abc_index, name, payload_reader.take(payload_reader.remaining())
            abc_index += 1
        if tag_code == 0:
            break


def _pool_count(reader: Reader) -> int:
    return max(0, reader.u30() - 1)


def _read_constant_pool(
    reader: Reader,
) -> tuple[list[str], list[tuple[int, int]], list[tuple[int, int, int]]]:
    for _ in range(_pool_count(reader)):  # int
        reader.varint32()
    for _ in range(_pool_count(reader)):  # uint
        reader.varint32()
    reader.skip(8 * _pool_count(reader))  # double

    strings = [""]
    for _ in range(_pool_count(reader)):
        size = reader.u30()
        strings.append(reader.take(size).decode("utf-8", errors="replace"))

    namespaces = [(0, 0)]
    for _ in range(_pool_count(reader)):  # namespace
        namespaces.append((reader.u8(), reader.u30()))
    for _ in range(_pool_count(reader)):  # namespace set
        for _ in range(reader.u30()):
            reader.u30()
    multinames = [(0, 0, 0)]
    for _ in range(_pool_count(reader)):  # multiname
        kind = reader.u8()
        if kind in (0x07, 0x0D):  # QName, QNameA
            multinames.append((kind, reader.u30(), reader.u30()))
        elif kind in (0x0F, 0x10):  # RTQName, RTQNameA
            multinames.append((kind, 0, reader.u30()))
        elif kind in (0x11, 0x12):  # RTQNameL, RTQNameLA
            multinames.append((kind, 0, 0))
        elif kind in (0x09, 0x0E):  # Multiname, MultinameA
            name_index = reader.u30()
            reader.u30()
            multinames.append((kind, 0, name_index))
        elif kind in (0x1B, 0x1C):  # MultinameL, MultinameLA
            reader.u30()
            multinames.append((kind, 0, 0))
        elif kind == 0x1D:  # TypeName
            qname_index = reader.u30()
            for _ in range(reader.u30()):
                reader.u30()
            multinames.append((kind, 0, qname_index))
        else:
            raise AbcIndexError(
                f"unsupported multiname kind 0x{kind:02x} in {reader.label}"
            )
    return strings, namespaces, multinames


def _qualified_multiname(
    index: int,
    strings: list[str],
    namespaces: list[tuple[int, int]],
    multinames: list[tuple[int, int, int]],
) -> tuple[str, str]:
    if index <= 0 or index >= len(multinames):
        return "", ""
    kind, namespace_index, name_index = multinames[index]
    if kind not in (0x07, 0x0D):
        name = strings[name_index] if 0 <= name_index < len(strings) else ""
        return "", name
    namespace = ""
    if 0 < namespace_index < len(namespaces):
        string_index = namespaces[namespace_index][1]
        if 0 <= string_index < len(strings):
            namespace = strings[string_index]
    name = strings[name_index] if 0 <= name_index < len(strings) else ""
    return namespace, name


def _read_traits(reader: Reader) -> list[tuple[int, int, int | None]]:
    result: list[tuple[int, int, int | None]] = []
    for _ in range(reader.u30()):
        trait_name = reader.u30()
        kind_and_attributes = reader.u8()
        kind = kind_and_attributes & 0x0F
        method_index: int | None = None
        if kind in (0, 6):  # slot, const
            reader.u30()
            reader.u30()
            value_index = reader.u30()
            if value_index:
                reader.u8()
        elif kind in (1, 2, 3):  # method, getter, setter
            reader.u30()
            method_index = reader.u30()
        elif kind == 4:  # class
            reader.u30()
            reader.u30()
        elif kind == 5:  # function
            reader.u30()
            reader.u30()
        else:
            raise AbcIndexError(f"unsupported trait kind {kind} in {reader.label}")
        if kind_and_attributes & 0x40:  # ATTR_Metadata
            for _ in range(reader.u30()):
                reader.u30()
        result.append((kind, trait_name, method_index))
    return result


def _parse_abc(abc_index: int, abc_name: str, data: bytes) -> list[MethodBodyRef]:
    reader = Reader(data, f"ABC[{abc_index}] {abc_name}")
    reader.u16()  # minor version
    reader.u16()  # major version
    strings, namespaces, multinames = _read_constant_pool(reader)

    method_names: list[str] = []
    method_count = reader.u30()
    for _ in range(method_count):
        param_count = reader.u30()
        reader.u30()  # return type
        for _ in range(param_count):
            reader.u30()
        name_index = reader.u30()
        if name_index >= len(strings):
            raise AbcIndexError(
                f"method name string index {name_index} is out of range in {reader.label}"
            )
        method_names.append(strings[name_index])
        flags = reader.u8()
        if flags & 0x08:  # HAS_OPTIONAL
            for _ in range(reader.u30()):
                reader.u30()
                reader.u8()
        if flags & 0x80:  # HAS_PARAM_NAMES
            for _ in range(param_count):
                reader.u30()

    for _ in range(reader.u30()):  # metadata
        reader.u30()
        item_count = reader.u30()
        for _ in range(item_count):
            reader.u30()
        for _ in range(item_count):
            reader.u30()

    class_count = reader.u30()
    instances: list[tuple[int, int, list[tuple[int, int, int | None]]]] = []
    for _ in range(class_count):  # instance_info
        class_name = reader.u30()
        reader.u30()
        flags = reader.u8()
        if flags & 0x08:
            reader.u30()
        for _ in range(reader.u30()):
            reader.u30()
        initializer = reader.u30()
        instances.append((class_name, initializer, _read_traits(reader)))
    class_traits: list[tuple[int, list[tuple[int, int, int | None]]]] = []
    for _ in range(class_count):  # class_info
        initializer = reader.u30()
        class_traits.append((initializer, _read_traits(reader)))
    script_traits: list[tuple[int, list[tuple[int, int, int | None]]]] = []
    for _ in range(reader.u30()):  # script_info
        initializer = reader.u30()
        script_traits.append((initializer, _read_traits(reader)))

    aliases_by_method: dict[int, set[str]] = {}
    for method_index, raw_name in enumerate(method_names):
        if raw_name:
            aliases_by_method.setdefault(method_index, set()).add(raw_name)

    def add_trait_aliases(
        class_prefix: str,
        traits: Iterable[tuple[int, int, int | None]],
    ) -> None:
        for _kind, trait_name_index, method_index in traits:
            if method_index is None:
                continue
            _namespace, leaf = _qualified_multiname(
                trait_name_index, strings, namespaces, multinames
            )
            if leaf:
                aliases_by_method.setdefault(method_index, set()).add(
                    f"{class_prefix}/{leaf}"
                )

    for class_index, (class_name_index, initializer, traits) in enumerate(instances):
        package_name, class_name = _qualified_multiname(
            class_name_index, strings, namespaces, multinames
        )
        class_prefix = f"{package_name}:{class_name}" if package_name else class_name
        if class_prefix:
            aliases_by_method.setdefault(initializer, set()).add(
                f"{class_prefix}/{class_name}"
            )
            add_trait_aliases(class_prefix, traits)
            class_initializer, static_traits = class_traits[class_index]
            aliases_by_method.setdefault(class_initializer, set()).add(
                f"{class_prefix}/$cinit"
            )
            add_trait_aliases(class_prefix, static_traits)

    for script_index, (initializer, traits) in enumerate(script_traits):
        script_prefix = f"{abc_name}#$script{script_index}"
        aliases_by_method.setdefault(initializer, set()).add(
            f"{script_prefix}/$init"
        )
        add_trait_aliases(script_prefix, traits)

    # Body table follows instance/class/script information.
    refs: list[MethodBodyRef] = []
    body_count = reader.u30()
    for body_index in range(body_count):
        method_info_index = reader.u30()
        if method_info_index >= len(method_names):
            raise AbcIndexError(
                f"body {body_index} method_info {method_info_index} is out of range "
                f"in {reader.label}"
            )
        reader.u30()  # max_stack
        reader.u30()  # local_count
        reader.u30()  # init_scope_depth
        reader.u30()  # max_scope_depth
        code = reader.take(reader.u30())
        for _ in range(reader.u30()):  # exception_info
            reader.u30()
            reader.u30()
            reader.u30()
            reader.u30()
            reader.u30()
        _read_traits(reader)
        aliases = sorted(aliases_by_method.get(method_info_index, set()))
        primary_name = method_names[method_info_index]
        if not primary_name:
            primary_name = aliases[0] if aliases else (
                f"{abc_name}#method_info_{method_info_index}"
            )
        refs.append(
            MethodBodyRef(
                abc_index=abc_index,
                abc_name=abc_name,
                method_name=primary_name,
                method_info_index=method_info_index,
                body_index=body_index,
                code=code,
                aliases=aliases,
            )
        )
    if reader.remaining() != 0:
        raise AbcIndexError(
            f"unparsed trailing bytes in {reader.label}: {reader.remaining()}"
        )
    return refs


def index_swf_methods(path: Path) -> SwfMethodIndex:
    refs: list[MethodBodyRef] = []
    abc_count = 0
    for abc_index, abc_name, data in _iter_doabc(Path(path)):
        refs.extend(_parse_abc(abc_index, abc_name, data))
        abc_count += 1
    if abc_count == 0:
        raise AbcIndexError(f"no DoABC tags found in {path}")
    return SwfMethodIndex(refs)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("swf", type=Path)
    parser.add_argument("method", nargs="+")
    args = parser.parse_args()
    try:
        index = index_swf_methods(args.swf)
        report = {
            name: index.require_ref(name).as_dict()
            for name in args.method
        }
    except (OSError, AbcIndexError) as exc:
        parser.error(str(exc))
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
