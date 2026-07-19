#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Build the deterministic 1.4.106 -> 1.4.107 three-character payload edge.

Exports the device-accepted state of the three custom characters into the
repository asset-patch chain so fresh deployments serve them:

- white_wolf_gerald  : full client payload, pinned to the 1.4.172 release
  manifest (canonical sha256 c4a7b142...) -- his assets were never in the
  repo chain beyond the 1.4.105 afterchain partial.
- seris_dragon_king  : fix-train final (combat_fix5, the 1.4.182 release
  manifest, canonical sha256 c1311b52...), including the Stella files the
  package carries.
- shared master tables: surgical inclusion only. A table ships only when its
  raw-row diff against the repo chain tail (or the official full archive for
  tables the chain never carried) is limited to the packages' claimed keys.
  This deliberately EXCLUDES the operator-local balance suite
  (ability_soul / equipment_enhancement_ability) and the daily rogue reroll
  state (rush_event_quest row 700099), which are not part of the public
  release stance (see commit 3f69321).

Inputs live outside git (work/ package credentials, the CN store, .cdn); the
committed archives are canonical. CI validates the committed output via
tests/test_three_char_release_patch.py which needs only repo files.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import sys
import tempfile
import zipfile
import zlib
from pathlib import Path

MOD_DIR = Path(__file__).resolve().parent
ROOT = MOD_DIR.parent
sys.path.insert(0, str(MOD_DIR))

import wf_quest_lib as quest  # noqa: E402
import wf_mod_tool as core  # noqa: E402

ACTIVE_DIR = ROOT / "assets" / "asset-patch" / "active"
FROM_VERSION = "1.4.106"
TO_VERSION = "1.4.107"
TAG = "threechar0719"
PART_BUDGET = 4_800_000
PART_HARD_CAP = 5_242_880  # scripts/check-hygiene.sh
ZIP_DATE = (2026, 7, 19, 0, 0, 0)

PACKAGES = {
    "white_wolf_gerald": {
        "dir": ROOT / "work/character_packs/white_wolf_gerald/package",
        "canonical_sha256": (
            "c4a7b142f2a4b16af2ea6330f42bb6a904a3f5418e7ce76610792ad088f033ed"
        ),
    },
    "seris_dragon_king": {
        "dir": ROOT
        / "work/cf2/seris_dragon_king_combat_fix5_20260719/seris_dragon_king/package",
        "canonical_sha256": (
            "c1311b52ebdc476224d2524fe27bdbe2bcdd1c64054e6bbf161fb3bbbc7c5551"
        ),
    },
}
CLIENT_ROOTS = ("android", "common", "medium")
# Known manifest under-claims (sealed credentials cannot be edited): the
# Gerald 1.4.167 PF release added this key without a manifest table claim.
EXTRA_SANCTIONED = {
    "master/skill/power_flip_action.orderedmap": {"white_wolf_gerald_pf"},
}
# official full archive that carries tables the chain never shipped (upskill)
OFFICIAL_FULL = ROOT / ".cdn/cn/archive-common-full/pinball-1.4.0-113-1eabcab0.zip"

ARCHIVE_RE = re.compile(
    r"^pinball-(\d+\.\d+\.\d+)-(\d+\.\d+\.\d+)-([1-9]\d*)-(.+)\.zip$"
)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_manifest_sha(raw: bytes) -> str:
    value = json.loads(raw.decode("utf-8"))
    canon = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return sha256(canon)


def edge_sort_key(name: str):
    match = ARCHIVE_RE.match(name)
    if match is None:
        raise SystemExit(f"unparseable archive name: {name}")
    return (
        tuple(int(x) for x in match.group(2).split(".")),
        int(match.group(3)),
    )


def repo_tail_state() -> dict[str, bytes]:
    state: dict[str, bytes] = {}
    for name in sorted(
        (p.name for p in ACTIVE_DIR.glob("*.zip")), key=edge_sort_key
    ):
        with zipfile.ZipFile(ACTIVE_DIR / name) as zf:
            for member in zf.namelist():
                if member.startswith("production/upload/"):
                    rel = member.split("production/upload/", 1)[1]
                    state[rel] = zf.read(member)
    return state


def raw_rows(data: bytes, logical: str) -> dict[str, bytes]:
    """Keys plus raw (still-compressed) row chunks, codec-agnostic."""
    fd, tmp = tempfile.mkstemp(suffix=".orderedmap")
    os.close(fd)
    try:
        Path(tmp).write_bytes(data)
        om = core.read_orderedmap_file_raw_rows(Path(tmp), logical)
        return dict(zip(om.keys, om.rows))
    finally:
        os.unlink(tmp)


def rows_equal(a: bytes, b: bytes) -> bool:
    """Row chunks may be recompressed differently across sources; compare
    decompressed text when the raw bytes differ."""
    if a == b:
        return True
    try:
        return zlib.decompress(a) == zlib.decompress(b)
    except zlib.error:
        return False


def official_table_bytes(rel: str) -> bytes | None:
    if not OFFICIAL_FULL.exists():
        return None
    with zipfile.ZipFile(OFFICIAL_FULL) as zf:
        for member in zf.namelist():
            if member.endswith(rel):
                return zf.read(member)
    return None


def collect() -> tuple[dict[str, tuple[bytes, str]], list[str]]:
    """rel -> (bytes, description); plus human-readable notes."""
    notes: list[str] = []
    tail = repo_tail_state()
    notes.append(f"repo tail: {len(tail)} members across chain")
    store = quest._store_base()
    if not store.exists():
        raise SystemExit(f"store not found: {store}")

    members: dict[str, tuple[bytes, str]] = {}
    claims: dict[str, set[str]] = {}

    for package_id, spec in PACKAGES.items():
        pdir = spec["dir"]
        raw = (pdir / "manifest.json").read_bytes()
        got = canonical_manifest_sha(raw)
        if got != spec["canonical_sha256"]:
            raise SystemExit(
                f"{package_id}: manifest canonical sha mismatch "
                f"(expected {spec['canonical_sha256'][:12]}, got {got[:12]})"
            )
        manifest = json.loads(raw.decode("utf-8"))
        file_count = 0
        for root in CLIENT_ROOTS:
            for entry in manifest["roots"].get(root, []):
                logical = entry["logical_path"]
                if logical.startswith("master/"):
                    continue  # tables go through the surgical channel
                src = pdir / "roots" / root / logical
                data = src.read_bytes()
                if sha256(data) != entry["sha256"]:
                    raise SystemExit(
                        f"{package_id}: payload drift {root}:{logical}"
                    )
                rel = quest.hashed_rel(logical)
                if rel in tail and sha256(tail[rel]) == entry["sha256"]:
                    continue  # chain already current (afterchain partial)
                members[rel] = (data, f"{package_id}:{root}:{logical}")
                file_count += 1
        notes.append(f"{package_id}: {file_count} file payload members")
        for table in manifest.get("tables", []):
            logical = table["logical_path"]
            if table.get("root") == "server" or logical.startswith("cdndata"):
                continue
            claims.setdefault(logical, set()).update(table["outer_keys"])
    for logical, extra in EXTRA_SANCTIONED.items():
        claims.setdefault(logical, set()).update(extra)

    table_count = 0
    for logical in sorted(claims):
        rel = quest.hashed_rel(logical)
        live = (store / rel).read_bytes()
        if rel in tail:
            baseline, baseline_src = tail[rel], "chain-tail"
        else:
            official = official_table_bytes(rel)
            if official is None:
                raise SystemExit(f"no baseline for table {logical}")
            baseline, baseline_src = official, "official-full"
        if sha256(live) == sha256(baseline):
            continue
        old = raw_rows(baseline, logical)
        new = raw_rows(live, logical)
        removed = sorted(set(old) - set(new))
        touched = sorted(
            k for k in new
            if k not in old or not rows_equal(old[k], new[k])
        )
        unsanctioned = [k for k in touched if k not in claims[logical]]
        if removed:
            raise SystemExit(f"{logical}: rows removed vs {baseline_src}: {removed[:5]}")
        if unsanctioned:
            raise SystemExit(
                f"{logical}: unsanctioned rows vs {baseline_src}: {unsanctioned[:5]}"
            )
        members[rel] = (live, f"table:{logical} (+{len(touched)} rows)")
        table_count += 1
    notes.append(f"tables: {table_count} surgical members")
    return members, notes


def deflated_size(data: bytes) -> int:
    return len(zlib.compress(data, 9)) + 120  # entry overhead estimate


def build_parts(members: dict[str, tuple[bytes, str]]) -> list[tuple[str, bytes]]:
    ordered = sorted(members.items())
    bins: list[list[tuple[str, bytes]]] = [[]]
    budget = 0
    for rel, (data, _desc) in ordered:
        est = deflated_size(data)
        if budget + est > PART_BUDGET and bins[-1]:
            bins.append([])
            budget = 0
        bins[-1].append((rel, data))
        budget += est
    parts: list[tuple[str, bytes]] = []
    for index, entries in enumerate(bins, start=1):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
            for rel, data in entries:
                info = zipfile.ZipInfo(f"production/upload/{rel}", ZIP_DATE)
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o644 << 16
                zf.writestr(info, data, compresslevel=9)
        blob = buffer.getvalue()
        if len(blob) > PART_HARD_CAP:
            raise SystemExit(
                f"part {index} exceeds 5MiB ({len(blob)}); lower PART_BUDGET"
            )
        name = f"pinball-{FROM_VERSION}-{TO_VERSION}-{index}-{TAG}.zip"
        parts.append((name, blob))
    return parts


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true", help="write archives")
    args = parser.parse_args()

    members, notes = collect()
    for note in notes:
        print(f"[plan] {note}")
    total = sum(len(d) for d, _ in members.values())
    print(f"[plan] edge members: {len(members)} files, {total/1e6:.1f} MB raw")

    parts = build_parts(members)
    listing = "".join(
        f"{rel}:{sha256(data)}\n" for rel, (data, _d) in sorted(members.items())
    )
    print(f"[plan] aggregate member sha256: {sha256(listing.encode('utf-8'))}")
    for name, blob in parts:
        print(f"[plan] {name}: {len(blob)} bytes sha256={sha256(blob)[:16]}")

    if not args.write:
        print("[plan] dry-run only; pass --write to emit archives")
        return
    for name, blob in parts:
        target = ACTIVE_DIR / name
        if target.exists():
            raise SystemExit(f"refusing to overwrite {target}")
        target.write_bytes(blob)
        print(f"[write] {target}")
    print(f"[write] done: {len(parts)} parts, edge {FROM_VERSION}->{TO_VERSION}")


if __name__ == "__main__":
    main()
