#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Remove main-position-only restrictions from master/ability/ability.orderedmap.

Patch policy:
  * CSV column 1 is `unisonable`; every `false` is changed to `true`.
  * Any CSV field equal to `202` is changed to `0`.  In the ability schema,
    202 is the `OwnerIsMain` precondition enum.

The tool reads a full source upload store, rebuilds the orderedmap binary, and
writes it into the target store used by the offline phone package.
"""
import argparse
import hashlib
import os
import shutil
import struct
import zlib


SALT = "K6R9T9Hz22OpeIGEWB0ui6c6PYFQnJGy"
LOGICAL_PATH = "master/ability/ability.orderedmap"


def ability_hash():
    return hashlib.sha1((LOGICAL_PATH + SALT).encode("utf-8")).hexdigest()


def physical_path(store):
    h = ability_hash()
    return os.path.join(store, h[:2], h[2:])


def parse_index(raw):
    index_len = struct.unpack_from("<I", raw, 0)[0]
    index = zlib.decompress(raw[4:4 + index_len])
    count = struct.unpack_from("<I", index, 0)[0]

    pairs = []
    for i in range(count):
        key_end, row_offset = struct.unpack_from("<II", index, 4 + i * 8)
        pairs.append((key_end, row_offset))

    key_start = 4 + count * 8
    keys = []
    prev = 0
    for key_end, _ in pairs:
        keys.append(index[key_start + prev:key_start + key_end].decode("utf-8"))
        prev = key_end

    return index_len, keys, pairs


def read_orderedmap(path):
    raw = open(path, "rb").read()
    index_len, keys, pairs = parse_index(raw)
    data_base = 4 + index_len
    rows = []
    for i, (_, row_offset) in enumerate(pairs):
        row_start = data_base + row_offset
        row_end = data_base + pairs[i + 1][1] if i + 1 < len(pairs) else len(raw)
        blob = raw[row_start:row_end]
        if not blob:
            rows.append(b"")
            continue
        rows.append(zlib.decompress(blob))
    return keys, rows


def build_orderedmap(keys, rows):
    key_blob = b""
    pairs = []
    row_blob = b""

    for key, row in zip(keys, rows):
        key_blob += key.encode("utf-8")
        pairs.append((len(key_blob), len(row_blob)))
        if row:
            row_blob += zlib.compress(row)

    index = bytearray()
    index += struct.pack("<I", len(keys))
    for key_end, row_offset in pairs:
        index += struct.pack("<II", key_end, row_offset)
    index += key_blob

    packed_index = zlib.compress(bytes(index))
    return struct.pack("<I", len(packed_index)) + packed_index + row_blob


def patch_rows(keys, rows):
    patched_rows = []
    stats = {
        "entries": len(keys),
        "lines": 0,
        "unisonable_false_to_true": 0,
        "owner_is_main_202_to_0": 0,
        "empty_rows": 0,
    }
    samples = []

    for key, row in zip(keys, rows):
        if not row:
            stats["empty_rows"] += 1
            patched_rows.append(row)
            continue

        text = row.decode("utf-8")
        out_lines = []
        for line in text.split("\n"):
            if line == "":
                out_lines.append(line)
                continue
            stats["lines"] += 1
            cols = line.split(",")
            changed = False
            before = line

            if len(cols) > 1 and cols[1] == "false":
                cols[1] = "true"
                stats["unisonable_false_to_true"] += 1
                changed = True

            for i, value in enumerate(cols):
                if value == "202":
                    cols[i] = "0"
                    stats["owner_is_main_202_to_0"] += 1
                    changed = True

            after = ",".join(cols)
            if changed and len(samples) < 10:
                samples.append((key, before[:160], after[:160]))
            out_lines.append(after)

        patched_rows.append("\n".join(out_lines).encode("utf-8"))

    return patched_rows, stats, samples


def main():
    ap = argparse.ArgumentParser(description="Remove ability main-position restrictions")
    ap.add_argument("--source-store", required=True, help="Full production/upload store to read from")
    ap.add_argument("--target-store", required=True, help="Offline WorldFlipper dummy production/upload store to patch")
    ap.add_argument("--out", help="Optional output file instead of writing the target store")
    ap.add_argument("--no-backup", action="store_true", help="Do not create a .bak-main-position backup")
    args = ap.parse_args()

    source = physical_path(args.source_store)
    target = args.out or physical_path(args.target_store)

    if not os.path.exists(source):
        raise SystemExit(f"source ability file not found: {source}")

    keys, rows = read_orderedmap(source)
    patched_rows, stats, samples = patch_rows(keys, rows)
    patched = build_orderedmap(keys, patched_rows)

    os.makedirs(os.path.dirname(target), exist_ok=True)
    if not args.out and os.path.exists(target) and not args.no_backup:
        backup = target + ".bak-main-position"
        if not os.path.exists(backup):
            shutil.copy2(target, backup)
            print(f"backup: {backup}")
        else:
            print(f"backup exists: {backup}")

    with open(target, "wb") as fh:
        fh.write(patched)

    print(f"source: {source}")
    print(f"target: {target}")
    print(f"logical: {LOGICAL_PATH}")
    print(f"hash: {ability_hash()}")
    print(f"written_bytes: {len(patched)}")
    print("stats:")
    for key, value in stats.items():
        print(f"  {key}: {value}")
    if samples:
        print("samples:")
        for key, before, after in samples:
            print(f"  {key}: {before}  =>  {after}")


if __name__ == "__main__":
    main()
