#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Scan World Flipper CDN archive zips for raw-deflate asset contents.

The archive zips contain files such as production/upload/<xx>/<hash>.  Each
entry is itself usually a raw-deflate stream.  This tool opens zip entries,
inflates that inner stream, and searches the real asset bytes.
"""
import argparse
import os
import sys
import zipfile
import zlib

try:
    sys.stdout.reconfigure(errors="replace")
    sys.stderr.reconfigure(errors="replace")
except Exception:
    pass


WBITS = (-15, 15, 47)


def inflate(data):
    for wb in WBITS:
        try:
            return zlib.decompress(data, wb)
        except zlib.error:
            pass
    return None


def iter_zips(root):
    if os.path.isfile(root) and root.lower().endswith(".zip"):
        yield root
        return
    for base, _, files in os.walk(root):
        for name in files:
            if name.lower().endswith(".zip"):
                yield os.path.join(base, name)


def classify(raw):
    if raw is None:
        return "not-deflate"
    if raw.startswith(b"ATF"):
        return "ATF"
    if raw.startswith(b"\x89PNG"):
        return "PNG"
    if raw.startswith(b"OggS"):
        return "Ogg"
    sample = raw[:4000]
    if not sample:
        return "empty"
    printable = sum(1 for b in sample if b in (9, 10, 13) or 32 <= b <= 126)
    ratio = printable / len(sample)
    if ratio > 0.90:
        return "text"
    if ratio > 0.35:
        return "mixed-text"
    return "binary"


def context(raw, needle):
    idx = raw.find(needle)
    if idx < 0:
        return ""
    start = max(0, idx - 80)
    end = min(len(raw), idx + len(needle) + 160)
    return raw[start:end].decode("utf-8", "replace").replace("\r", "\\r").replace("\n", "\\n")


def cmd_find(args):
    needles = [n.encode("utf-8") for n in args.needle]
    hits = 0
    scanned_entries = 0
    scanned_zips = 0
    max_entry = args.max_entry_mb * 1024 * 1024 if args.max_entry_mb else None

    for zip_path in iter_zips(args.root):
        scanned_zips += 1
        rel_zip = os.path.relpath(zip_path, args.root) if os.path.isdir(args.root) else zip_path
        if args.verbose:
            print(f"[zip] {rel_zip}", file=sys.stderr)
        try:
            zf = zipfile.ZipFile(zip_path)
        except zipfile.BadZipFile:
            continue
        with zf:
            for info in zf.infolist():
                if info.is_dir():
                    continue
                if max_entry and info.file_size > max_entry:
                    continue
                scanned_entries += 1
                try:
                    packed = zf.read(info)
                except Exception:
                    continue
                raw = inflate(packed)
                if raw is None:
                    raw = packed
                if all(n in raw for n in needles):
                    hits += 1
                    kind = classify(raw)
                    print(f"[hit] zip={rel_zip}")
                    print(f"      entry={info.filename}")
                    print(f"      size={len(raw)} kind={kind}")
                    print(f"      ...{context(raw, needles[0])}...")
    print(f"\nscanned_zips={scanned_zips} scanned_entries={scanned_entries} hits={hits}")


def cmd_candidates(args):
    scanned_entries = 0
    rows = []
    max_entry = args.max_entry_mb * 1024 * 1024 if args.max_entry_mb else None
    for zip_path in iter_zips(args.root):
        rel_zip = os.path.relpath(zip_path, args.root) if os.path.isdir(args.root) else zip_path
        try:
            zf = zipfile.ZipFile(zip_path)
        except zipfile.BadZipFile:
            continue
        with zf:
            for info in zf.infolist():
                if info.is_dir():
                    continue
                if max_entry and info.file_size > max_entry:
                    continue
                scanned_entries += 1
                try:
                    packed = zf.read(info)
                except Exception:
                    continue
                raw = inflate(packed)
                kind = classify(raw)
                if kind in ("text", "mixed-text"):
                    rows.append((len(raw or packed), kind, rel_zip, info.filename, (raw or packed)[:120]))
    for size, kind, rel_zip, entry, preview in sorted(rows, reverse=True)[:args.limit]:
        pv = preview.decode("utf-8", "replace").replace("\r", "\\r").replace("\n", "\\n")
        print(f"{size:>9} {kind:<10} zip={rel_zip} entry={entry} preview={pv}")
    print(f"\nscanned_entries={scanned_entries} candidates={len(rows)}")


def cmd_dump(args):
    with zipfile.ZipFile(args.zip) as zf:
        packed = zf.read(args.entry)
    raw = inflate(packed)
    if raw is None:
        raw = packed
    if args.out:
        with open(args.out, "wb") as fh:
            fh.write(raw)
        print(f"wrote {args.out} ({len(raw)} bytes)")
    else:
        sys.stdout.buffer.write(raw)


def main():
    parser = argparse.ArgumentParser(description="Scan WF archive zip inner raw-deflate assets")
    sub = parser.add_subparsers(dest="cmd", required=True)

    find = sub.add_parser("find", help="search inflated archive entries")
    find.add_argument("--root", required=True, help="archive zip or directory containing zips")
    find.add_argument("--needle", action="append", required=True, help="UTF-8 text to search; may repeat")
    find.add_argument("--max-entry-mb", type=int, default=0, help="skip zip entries larger than this size")
    find.add_argument("--verbose", action="store_true")
    find.set_defaults(func=cmd_find)

    cand = sub.add_parser("candidates", help="list text-like inflated entries")
    cand.add_argument("--root", required=True)
    cand.add_argument("--max-entry-mb", type=int, default=0)
    cand.add_argument("--limit", type=int, default=80)
    cand.set_defaults(func=cmd_candidates)

    dump = sub.add_parser("dump", help="dump one inflated zip entry")
    dump.add_argument("--zip", required=True)
    dump.add_argument("--entry", required=True)
    dump.add_argument("--out")
    dump.set_defaults(func=cmd_dump)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
