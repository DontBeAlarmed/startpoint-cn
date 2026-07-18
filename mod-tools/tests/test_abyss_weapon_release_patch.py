import json
import re
import sys
import unittest
import zipfile
import zlib
from collections import deque
from io import BytesIO
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "mod-tools"))

import build_abyss_weapon_balance_patch as builder  # noqa: E402
import wf_mod_tool as core  # noqa: E402
import wf_rogue_rewards as rewards  # noqa: E402


MANIFEST = ROOT / "assets" / "asset-patch" / "manifest.json"
ARCHIVE_NAME = "pinball-1.4.105-1.4.106-1-abyssbalance0718.zip"
ARCHIVE = ROOT / "assets" / "asset-patch" / "active" / ARCHIVE_NAME
ARCHIVE_SHA256 = "e9ec4451ac5b3101f060c74278fd8901b7c207c57f19e313084ff9f9639f7272"
EDGE_RE = re.compile(r"^pinball-(1\.4\.\d+)-(1\.4\.\d+)-\d+-.+\.zip$")


class AbyssWeaponReleasePatchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        cls.archive_bytes = ARCHIVE.read_bytes()
        with zipfile.ZipFile(BytesIO(cls.archive_bytes)) as archive:
            cls.members = archive.namelist()
            cls.bad_member = archive.testzip()
            cls.member_bytes = {name: archive.read(name) for name in cls.members}
            cls.infos = archive.infolist()
            cls.archive_comment = archive.comment

    def test_enabled_tail_edge_is_published(self) -> None:
        matches = [
            patch
            for patch in self.manifest["patches"]
            if patch.get("id") == "abyss-weapon-balance-v1"
        ]
        self.assertEqual(1, len(matches))
        patch = matches[0]
        self.assertTrue(patch["enabled"])
        self.assertEqual("1.4.105", patch["depends_on"])
        self.assertEqual("1.4.106", patch["version"])
        self.assertEqual([ARCHIVE_NAME], patch["chain"])
        self.assertEqual("2026-07-18", patch["created_at"])
        self.assertTrue(ARCHIVE.is_file())

    def test_enabled_chain_reaches_tail_continuously(self) -> None:
        graph: dict[str, set[str]] = {}
        for patch in self.manifest["patches"]:
            if not patch.get("enabled"):
                continue
            for archive_name in patch.get("chain", []):
                match = EDGE_RE.fullmatch(archive_name)
                self.assertIsNotNone(match, archive_name)
                source, target = match.groups()
                graph.setdefault(source, set()).add(target)

        queue = deque(["1.4.90"])
        reached = {"1.4.90"}
        while queue:
            for target in graph.get(queue.popleft(), set()):
                if target not in reached:
                    reached.add(target)
                    queue.append(target)
        self.assertIn("1.4.106", reached)

    def test_archive_has_exact_deterministic_payload_set(self) -> None:
        self.assertIsNone(self.bad_member)
        self.assertEqual(
            [
                "production/upload/49/a073fdd109e00ac9daf801113cb5e19f64a8cf",
                "production/upload/d6/a23f83f176b05f715a8504b8fc0fc1ffaff068",
                "production/upload/8d/d127a4e129d8c80dd3711704191738812f9181",
            ],
            self.members,
        )
        self.assertEqual(list(builder.ARCHIVE_MEMBERS), self.members)
        self.assertEqual(
            [builder.ZIP_TIMESTAMP] * 3,
            [info.date_time for info in self.infos],
        )
        self.assertEqual(
            [zipfile.ZIP_DEFLATED] * 3,
            [info.compress_type for info in self.infos],
        )
        self.assertEqual([0] * 3, [info.flag_bits for info in self.infos])
        self.assertEqual([b""] * 3, [info.extra for info in self.infos])
        self.assertEqual(b"", self.archive_comment)
        for info in self.infos:
            payload = self.member_bytes[info.filename]
            self.assertEqual(len(payload), info.file_size)
            self.assertEqual(zlib.crc32(payload) & 0xFFFFFFFF, info.CRC)
        self.assertEqual(115_915, len(self.archive_bytes))
        self.assertEqual(ARCHIVE_SHA256, builder.sha256(self.archive_bytes))

    def test_payloads_match_current_generator_and_official_baselines(self) -> None:
        equipment_bytes = self.member_bytes[builder.EQUIPMENT_MEMBER]
        soul_bytes = self.member_bytes[builder.SOUL_MEMBER]
        wab_bytes = self.member_bytes[builder.WAB_MEMBER]

        official_soul = builder.parse_table(
            builder.strip_custom_soul_rows(soul_bytes), builder.SOUL_LOGICAL
        )
        self.assertEqual(
            builder.SOUL_CANONICAL_BASELINE_SHA256,
            builder.canonical_node_sha256(official_soul),
        )
        self.assertEqual(builder.WAB_BASELINE_SIZE, len(wab_bytes))
        self.assertEqual(builder.WAB_BASELINE_SHA256, builder.sha256(wab_bytes))

        bridge_bytes = builder.checked_bridge(builder.BRIDGE_ARCHIVE)
        tampered_soul = dict(official_soul)
        first_soul_id = next(iter(tampered_soul))
        tampered_soul[first_soul_id] = str(tampered_soul[first_soul_id]) + ",tamper"
        with self.assertRaisesRegex(ValueError, "canonical content"):
            builder.build_payloads_from_soul_table(
                bridge_bytes,
                tampered_soul,
                wab_bytes,
            )
        expected_payloads = builder.build_payloads_from_soul_table(
            bridge_bytes,
            official_soul,
            wab_bytes,
        )
        self.assertEqual(
            builder.parse_table(expected_payloads[0], builder.EQUIPMENT_LOGICAL),
            builder.parse_table(equipment_bytes, builder.EQUIPMENT_LOGICAL),
        )
        self.assertEqual(
            builder.parse_table(expected_payloads[1], builder.SOUL_LOGICAL),
            builder.parse_table(soul_bytes, builder.SOUL_LOGICAL),
        )
        self.assertEqual(expected_payloads[2], wab_bytes)

        equipment = builder.parse_table(equipment_bytes, builder.EQUIPMENT_LOGICAL)
        souls = builder.parse_table(soul_bytes, builder.SOUL_LOGICAL)
        for spec in rewards.WEAPONS:
            equipment_row = core.read_csv_lines(equipment[spec.id])[0]
            self.assertEqual(rewards.MODE_DESCRIPTION, equipment_row[7], spec.id)
            self.assertEqual(f"mod_abyss_{spec.id}", equipment_row[0], spec.id)

            soul_rows = core.read_csv_lines(souls[spec.id])
            self.assertEqual(len(spec.effects), len(soul_rows), spec.id)
            for row, effect in zip(soul_rows, spec.effects, strict=True):
                self.assertEqual(effect.effect_kind, row[44], spec.id)
                self.assertEqual(str(effect.strength), row[48], spec.id)
                self.assertEqual(str(effect.strength), row[49], spec.id)

    def test_equipment_preserves_every_noncustom_bridge_row_and_order(self) -> None:
        bridge = builder.checked_bridge(builder.BRIDGE_ARCHIVE)
        bridge_equipment = builder.parse_table(
            builder.read_bridge_member(bridge, builder.EQUIPMENT_LOGICAL),
            builder.EQUIPMENT_LOGICAL,
        )
        final_equipment = builder.parse_table(
            self.member_bytes[builder.EQUIPMENT_MEMBER], builder.EQUIPMENT_LOGICAL
        )
        custom_ids = {spec.id for spec in rewards.WEAPONS}
        bridge_noncustom = [
            (key, value)
            for key, value in bridge_equipment.items()
            if key not in custom_ids
        ]
        final_noncustom = [
            (key, value)
            for key, value in final_equipment.items()
            if key not in custom_ids
        ]
        self.assertEqual(bridge_noncustom, final_noncustom)

    def test_rebuild_is_semantically_stable_without_live_store(self) -> None:
        payloads = (
            self.member_bytes[builder.EQUIPMENT_MEMBER],
            self.member_bytes[builder.SOUL_MEMBER],
            self.member_bytes[builder.WAB_MEMBER],
        )
        first = builder.build_archive_bytes(payloads)
        second = builder.build_archive_bytes(payloads)
        self.assertEqual(first, second)
        with zipfile.ZipFile(BytesIO(first)) as rebuilt:
            self.assertEqual(self.members, rebuilt.namelist())
            for member in self.members:
                actual = self.member_bytes[member]
                candidate = rebuilt.read(member)
                if member == builder.WAB_MEMBER:
                    self.assertEqual(actual, candidate)
                else:
                    self.assertEqual(
                        builder.parse_table(actual, member),
                        builder.parse_table(candidate, member),
                    )


if __name__ == "__main__":
    unittest.main()
