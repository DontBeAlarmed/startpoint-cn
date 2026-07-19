# -*- coding: utf-8 -*-
"""Guard the committed 1.4.106 -> 1.4.107 three-character payload edge.

Validates only committed repository artifacts (CI-safe on a clean checkout):
the ten sequence-numbered parts, the hygiene size cap, member integrity, the
pinned aggregate content hash, character-table semantics, no row regressions
against the prior chain state, and the deliberate exclusion of the
operator-local balance tables (see build_three_char_release_patch.py).
"""
from __future__ import annotations

import hashlib
import re
import sys
import unittest
import zipfile
import zlib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
MOD_TOOLS = REPO_ROOT / "mod-tools"
sys.path.insert(0, str(MOD_TOOLS))

import wf_mod_tool as core  # noqa: E402
import wf_quest_lib as quest  # noqa: E402

ACTIVE = REPO_ROOT / "assets" / "asset-patch" / "active"
EDGE_GLOB = "pinball-1.4.106-1.4.107-*-threechar0719.zip"
EDGE_RE = re.compile(r"^pinball-1\.4\.106-1\.4\.107-([1-9]\d*)-threechar0719\.zip$")
PART_COUNT = 10
PART_HARD_CAP = 5_242_880
AGGREGATE_SHA256 = (
    "8fe22706bdc5f980f55f894c67eaa7addf7da8f74cc1b63677042e45250e3bab"
)

CHARACTER_T = "master/character/character.orderedmap"
ABILITY_T = "master/ability/ability.orderedmap"
LEADER_T = "master/ability/leader_ability.orderedmap"
PF_T = "master/skill/power_flip_action.orderedmap"
UPSKILL_T = "master/mana_board/upskill.orderedmap"
EXCLUDED_TABLES = (
    "master/ability/ability_soul.orderedmap",
    "master/equipment_enhancement/equipment_enhancement_ability.orderedmap",
    "master/quest/event/rush_event_quest.orderedmap",
)


def edge_parts() -> list[Path]:
    return sorted(
        ACTIVE.glob(EDGE_GLOB),
        key=lambda p: int(EDGE_RE.match(p.name).group(1)),
    )


def load_members() -> dict[str, bytes]:
    members: dict[str, bytes] = {}
    for part in edge_parts():
        with zipfile.ZipFile(part) as zf:
            for name in zf.namelist():
                rel = name.split("production/upload/", 1)[1]
                assert rel not in members, f"duplicate member {rel}"
                members[rel] = zf.read(name)
    return members


def prior_chain_state() -> dict[str, bytes]:
    state: dict[str, bytes] = {}
    pattern = re.compile(
        r"^pinball-(\d+\.\d+\.\d+)-(\d+\.\d+\.\d+)-([1-9]\d*)-(.+)\.zip$"
    )
    names = []
    for path in ACTIVE.glob("*.zip"):
        match = pattern.match(path.name)
        if match is None or EDGE_RE.match(path.name):
            continue
        names.append((
            tuple(int(x) for x in match.group(2).split(".")),
            int(match.group(3)),
            path,
        ))
    for _ver, _seq, path in sorted(names, key=lambda t: (t[0], t[1])):
        with zipfile.ZipFile(path) as zf:
            for name in zf.namelist():
                if name.startswith("production/upload/"):
                    state[name.split("production/upload/", 1)[1]] = zf.read(name)
    return state


def table_keys(data: bytes) -> list[str]:
    keys, _pairs, _index_len = core.parse_index(data)
    return keys


class TestThreeCharReleasePatch(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.parts = edge_parts()
        cls.members = load_members()

    def test_parts_sequential_and_capped(self) -> None:
        self.assertEqual(len(self.parts), PART_COUNT)
        sequences = [int(EDGE_RE.match(p.name).group(1)) for p in self.parts]
        self.assertEqual(sequences, list(range(1, PART_COUNT + 1)))
        for part in self.parts:
            self.assertLessEqual(part.stat().st_size, PART_HARD_CAP, part.name)
            with zipfile.ZipFile(part) as zf:
                self.assertIsNone(zf.testzip(), part.name)
                for name in zf.namelist():
                    self.assertTrue(
                        name.startswith("production/upload/"), name
                    )

    def test_aggregate_content_hash_pinned(self) -> None:
        listing = "".join(
            f"{rel}:{hashlib.sha256(data).hexdigest()}\n"
            for rel, data in sorted(self.members.items())
        )
        self.assertEqual(
            hashlib.sha256(listing.encode("utf-8")).hexdigest(),
            AGGREGATE_SHA256,
        )

    def test_character_tables_carry_all_three(self) -> None:
        rows = core.read_orderedmap_file_from_bytes(
            self.members[quest.hashed_rel(CHARACTER_T)]
        )
        for character_id in ("129999", "139999", "149999"):
            self.assertIn(character_id, rows)

    def test_gerald_ability_and_pf_rows(self) -> None:
        ability = core.read_orderedmap_file_from_bytes(
            self.members[quest.hashed_rel(ABILITY_T)]
        )
        for key in (f"149999{i}" for i in range(1, 7)):
            self.assertIn(key, ability)
        leader = core.read_orderedmap_file_from_bytes(
            self.members[quest.hashed_rel(LEADER_T)]
        )
        self.assertIn("149999", leader)
        pf = core.read_orderedmap_file_from_bytes(
            self.members[quest.hashed_rel(PF_T)]
        )
        for key in (
            "white_wolf_gerald_pf",
            "override_seris_human_powerflip",
            "override_seris_dragon_special",
        ):
            self.assertIn(key, pf)

    def test_upskill_official_plus_gerald(self) -> None:
        rows = core.read_orderedmap_file_from_bytes(
            self.members[quest.hashed_rel(UPSKILL_T)]
        )
        self.assertIn("149999", rows)
        self.assertGreaterEqual(len(rows), 369)

    def test_no_row_regressions_against_prior_chain(self) -> None:
        prior = prior_chain_state()
        checked = 0
        for rel, data in self.members.items():
            if rel not in prior:
                continue
            try:
                old_keys = set(table_keys(prior[rel]))
                new_keys = set(table_keys(data))
            except Exception:
                continue  # binary asset, not a table container
            missing = old_keys - new_keys
            self.assertFalse(
                missing, f"{rel} drops keys vs prior chain: {sorted(missing)[:5]}"
            )
            checked += 1
        self.assertGreaterEqual(checked, 10)

    def test_operator_local_tables_stay_excluded(self) -> None:
        for logical in EXCLUDED_TABLES:
            self.assertNotIn(quest.hashed_rel(logical), self.members, logical)


if __name__ == "__main__":
    unittest.main()
