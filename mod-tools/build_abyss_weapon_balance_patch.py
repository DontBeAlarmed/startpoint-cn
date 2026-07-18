#!/usr/bin/env python
"""Build the deterministic 1.4.105 -> 1.4.106 abyss weapon balance patch.

This repair builder is intentionally isolated from wf_publish.py and the active
CN store. It validates the pinned bridge archive and two official backup
payloads, copies the validated backups into an OS temp directory, and writes
one repository asset-patch archive. The committed archive hash is canonical;
rebuilds on different zlib implementations are validated by decoded table
content because standard zlib and zlib-ng may choose different DEFLATE bytes.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import os
import struct
import sys
import tempfile
import zipfile
import zlib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MOD_TOOLS = ROOT / "mod-tools"
sys.path.insert(0, str(MOD_TOOLS))

import wf_quest_lib as quest  # noqa: E402
import wf_rogue_rewards as rewards  # noqa: E402


BRIDGE_ARCHIVE = (
    ROOT
    / "assets"
    / "asset-patch"
    / "active"
    / "pinball-1.4.101-1.4.102-1-mod07142258.zip"
)
OUTPUT_ARCHIVE = (
    ROOT
    / "assets"
    / "asset-patch"
    / "active"
    / "pinball-1.4.105-1.4.106-1-abyssbalance0718.zip"
)

BRIDGE_SHA256 = "31c897762d89e6d55064c477dc989d97e30e86a05ecca258e61e44ea90d0f86d"
SOUL_BASELINE_SIZE = 38_313
SOUL_BASELINE_SHA256 = "70dd53d7e1f9078199a017d49c0adb2946ecb6e91abfbc42f4b6a4da4b0a2e1e"
SOUL_CANONICAL_BASELINE_SHA256 = (
    "a464c324f44a9a7a685ec0036bb895e4a0f70ab4e1f0bd1f0a0a1780bfc661df"
)
WAB_BASELINE_SIZE = 3_640
WAB_BASELINE_SHA256 = "b9aa82f7c7483af88f758bcdaeed6474178e57a076d86b660d0bab902996e0ae"

ITEM_LOGICAL = rewards.ITEM_T
EQUIPMENT_LOGICAL = rewards.EQUIP_T
STATUS_LOGICAL = rewards.EQUIP_STATUS_T
SOUL_LOGICAL = rewards.SOUL_T
RUSH_LOGICAL = rewards.RUSH_EVENT_T
WAB_LOGICAL = (
    "master/equipment_enhancement/equipment_enhancement_ability.orderedmap"
)


def archive_member(logical: str) -> str:
    return f"production/upload/{quest.hashed_rel(logical)}"


EQUIPMENT_MEMBER = archive_member(EQUIPMENT_LOGICAL)
SOUL_MEMBER = archive_member(SOUL_LOGICAL)
WAB_MEMBER = archive_member(WAB_LOGICAL)
ARCHIVE_MEMBERS = (EQUIPMENT_MEMBER, SOUL_MEMBER, WAB_MEMBER)
ZIP_TIMESTAMP = (2026, 7, 18, 0, 0, 0)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def checked_read(path: Path, *, size: int, digest: str, label: str) -> bytes:
    data = path.read_bytes()
    actual_digest = sha256(data)
    if len(data) != size or actual_digest != digest:
        raise ValueError(
            f"{label} does not match pinned input: "
            f"size={len(data)} sha256={actual_digest}"
        )
    return data


def checked_bridge(path: Path) -> bytes:
    data = path.read_bytes()
    actual_digest = sha256(data)
    if actual_digest != BRIDGE_SHA256:
        raise ValueError(
            f"bridge archive does not match pinned input: sha256={actual_digest}"
        )
    return data


def read_bridge_member(bridge_bytes: bytes, logical: str) -> bytes:
    member = archive_member(logical)
    with zipfile.ZipFile(io.BytesIO(bridge_bytes)) as archive:
        if archive.testzip() is not None:
            raise ValueError("bridge archive failed ZIP integrity validation")
        try:
            return archive.read(member)
        except KeyError as exc:
            raise ValueError(f"bridge archive is missing {member}") from exc


def parse_table(data: bytes, logical: str) -> dict[str, object]:
    table = quest.parse_node(data)
    if not isinstance(table, dict):
        raise ValueError(f"{logical} is not a top-level orderedmap")
    return table


def canonical_node_sha256(node: object) -> str:
    """Hash ordered table content and order independently of compression bytes."""
    digest = hashlib.sha256()

    def visit(value: object) -> None:
        if isinstance(value, str):
            raw = value.encode("utf-8")
            digest.update(b"S")
            digest.update(struct.pack("<Q", len(raw)))
            digest.update(raw)
            return
        if not isinstance(value, dict):
            raise TypeError(
                f"orderedmap node must be str or dict, got {type(value).__name__}"
            )
        digest.update(b"M")
        digest.update(struct.pack("<Q", len(value)))
        for key, child in value.items():
            raw = key.encode("utf-8")
            digest.update(b"K")
            digest.update(struct.pack("<Q", len(raw)))
            digest.update(raw)
            visit(child)

    visit(node)
    return digest.hexdigest()


def build_official_orderedmap(node: object) -> bytes:
    """Serialize with the official ability_soul payload's zlib level 9."""
    if isinstance(node, str):
        return zlib.compress(node.encode("utf-8"), 9) if node else b""
    if not isinstance(node, dict):
        raise TypeError(f"orderedmap node must be str or dict, got {type(node).__name__}")

    key_blob = b""
    row_blob = b""
    pairs: list[tuple[int, int]] = []
    for key, child in node.items():
        key_blob += key.encode("utf-8")
        row_blob += build_official_orderedmap(child)
        pairs.append((len(key_blob), len(row_blob)))
    index = bytearray(struct.pack("<I", len(pairs)))
    for key_end, row_end in pairs:
        index += struct.pack("<II", key_end, row_end)
    index += key_blob
    packed_index = zlib.compress(bytes(index), 9)
    return struct.pack("<I", len(packed_index)) + packed_index + row_blob


def strip_custom_soul_rows(soul_bytes: bytes) -> bytes:
    table = parse_table(soul_bytes, SOUL_LOGICAL)
    custom_ids = {spec.id for spec in rewards.WEAPONS}
    stripped = {key: value for key, value in table.items() if key not in custom_ids}
    return build_official_orderedmap(stripped)


def build_payloads_from_soul_table(
    bridge_bytes: bytes,
    soul_baseline: dict[str, object],
    wab_baseline_bytes: bytes,
) -> tuple[bytes, bytes, bytes]:
    """Build from an already parsed official soul table."""
    if canonical_node_sha256(soul_baseline) != SOUL_CANONICAL_BASELINE_SHA256:
        raise ValueError("ability_soul baseline does not match canonical content")
    if sha256(wab_baseline_bytes) != WAB_BASELINE_SHA256:
        raise ValueError(
            "equipment_enhancement_ability hash is not pinned official baseline"
        )

    bridge_equipment_bytes = read_bridge_member(bridge_bytes, EQUIPMENT_LOGICAL)
    tables = rewards.MasterTables(
        items=parse_table(read_bridge_member(bridge_bytes, ITEM_LOGICAL), ITEM_LOGICAL),
        equipment=parse_table(bridge_equipment_bytes, EQUIPMENT_LOGICAL),
        equipment_status=parse_table(
            read_bridge_member(bridge_bytes, STATUS_LOGICAL), STATUS_LOGICAL
        ),
        ability_soul=soul_baseline,
        rush_event=parse_table(read_bridge_member(bridge_bytes, RUSH_LOGICAL), RUSH_LOGICAL),
    )
    changes = rewards.build_master_changes(tables)
    equipment_bytes = quest.build_node(changes.equipment)
    soul_bytes = build_official_orderedmap(changes.ability_soul)

    custom_ids = {spec.id for spec in rewards.WEAPONS}
    bridge_equipment = parse_table(bridge_equipment_bytes, EQUIPMENT_LOGICAL)
    final_equipment = parse_table(equipment_bytes, EQUIPMENT_LOGICAL)
    bridge_noncustom = [
        (key, value) for key, value in bridge_equipment.items() if key not in custom_ids
    ]
    final_noncustom = [
        (key, value) for key, value in final_equipment.items() if key not in custom_ids
    ]
    if final_noncustom != bridge_noncustom:
        raise RuntimeError("equipment non-custom rows or order changed")
    stripped_soul = parse_table(strip_custom_soul_rows(soul_bytes), SOUL_LOGICAL)
    if canonical_node_sha256(stripped_soul) != canonical_node_sha256(soul_baseline):
        raise RuntimeError("removing custom ability_soul rows did not restore baseline")

    return equipment_bytes, soul_bytes, wab_baseline_bytes


def build_payloads(
    bridge_bytes: bytes, soul_baseline_bytes: bytes, wab_baseline_bytes: bytes
) -> tuple[bytes, bytes, bytes]:
    if sha256(soul_baseline_bytes) != SOUL_BASELINE_SHA256:
        raise ValueError("ability_soul baseline hash is not pinned official baseline")
    soul_baseline = parse_table(soul_baseline_bytes, SOUL_LOGICAL)
    return build_payloads_from_soul_table(
        bridge_bytes, soul_baseline, wab_baseline_bytes
    )


def build_archive_bytes(payloads: tuple[bytes, bytes, bytes]) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        for member, payload in zip(ARCHIVE_MEMBERS, payloads, strict=True):
            info = zipfile.ZipInfo(member, ZIP_TIMESTAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 0
            info.external_attr = 0
            archive.writestr(
                info,
                payload,
                compress_type=zipfile.ZIP_DEFLATED,
                compresslevel=9,
            )
    return output.getvalue()


def write_atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as temp_file:
            temp_file.write(data)
            temp_file.flush()
            os.fsync(temp_file.fileno())
        Path(temp_name).replace(path)
    except BaseException:
        Path(temp_name).unlink(missing_ok=True)
        raise


def build_from_paths(
    bridge_path: Path,
    soul_path: Path,
    wab_path: Path,
) -> bytes:
    bridge_bytes = checked_bridge(bridge_path)
    soul_bytes = checked_read(
        soul_path,
        size=SOUL_BASELINE_SIZE,
        digest=SOUL_BASELINE_SHA256,
        label="ability_soul baseline",
    )
    wab_bytes = checked_read(
        wab_path,
        size=WAB_BASELINE_SIZE,
        digest=WAB_BASELINE_SHA256,
        label="equipment_enhancement_ability baseline",
    )
    with tempfile.TemporaryDirectory(prefix="wf-abyss-balance-inputs-") as temp:
        temp_root = Path(temp)
        soul_copy = temp_root / "ability_soul.orderedmap"
        wab_copy = temp_root / "equipment_enhancement_ability.orderedmap"
        soul_copy.write_bytes(soul_bytes)
        wab_copy.write_bytes(wab_bytes)
        return build_archive_bytes(
            build_payloads(
                bridge_bytes,
                soul_copy.read_bytes(),
                wab_copy.read_bytes(),
            )
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bridge", type=Path, default=BRIDGE_ARCHIVE)
    parser.add_argument("--soul-baseline", type=Path, required=True)
    parser.add_argument("--wab-baseline", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=OUTPUT_ARCHIVE)
    args = parser.parse_args()

    archive_bytes = build_from_paths(
        args.bridge, args.soul_baseline, args.wab_baseline
    )
    write_atomic(args.output, archive_bytes)
    print(
        f"[OK] {args.output} size={len(archive_bytes)} "
        f"sha256={sha256(archive_bytes)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
