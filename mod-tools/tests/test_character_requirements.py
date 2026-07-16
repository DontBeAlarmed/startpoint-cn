# -*- coding: utf-8 -*-
"""Unified character asset requirement contract tests (pure, no live store)."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from wf_character_requirements import (  # noqa: E402
    AssetRequirement,
    build_requirement_report,
    char_asset_requirements,
    classify_asset_category,
)


def fake_requirements(required: int, suggested: int, excluded: int):
    items = []
    for index in range(required):
        items.append(AssetRequirement(f"required/{index}.bin", "必要", "required"))
    for index in range(suggested):
        items.append(AssetRequirement(f"voice/battle/{index}.mp3", "语音·battle", "suggested"))
    for index in range(excluded):
        items.append(AssetRequirement(f"story/{index}.png", "剧情表情", "excluded"))
    return items


class TestRequirementReport(unittest.TestCase):
    def test_requirement_report_counts_exactly_37_required_assets(self):
        requirements = tuple(fake_requirements(required=37, suggested=2, excluded=3))
        existing = {item.logical_path for item in requirements if item.logical_path != "required/36.bin"}

        report = build_requirement_report(requirements, existing)

        self.assertEqual(37, report["required_total"])
        self.assertEqual(36, report["required_exists"])
        self.assertEqual(36, report["required_present"])
        self.assertEqual(["required/36.bin"], report["missing_required"])
        self.assertFalse(report["release_ready"])
        self.assertEqual(97, report["pct"])

    def test_static_character_contract_has_37_required_and_two_excluded(self):
        requirements = char_asset_requirements("alice")
        required = [item for item in requirements if item.category == "required"]
        excluded = [item for item in requirements if item.category == "excluded"]

        self.assertEqual(37, len(required))
        self.assertEqual(2, len(excluded))
        self.assertTrue(all(item.logical_path.startswith("character/alice/") for item in requirements))

    def test_voice_is_suggested_but_story_words_and_login_are_excluded(self):
        cases = {
            "character/alice/voice/battle/skill_0.mp3": "suggested",
            "character/alice/ui/story/face_0.png": "excluded",
            "character/alice/voice/words/story_0.mp3": "excluded",
            "character/alice/voice/words_extra/story_1.mp3": "excluded",
            "character/alice/voice/login/login_0.mp3": "excluded",
            "character/alice/ui/episode_banner_0.png": "excluded",
        }
        for logical_path, expected in cases.items():
            with self.subTest(logical_path=logical_path):
                self.assertEqual(expected, classify_asset_category(logical_path, "语音"))

    def test_groups_keep_gui_compatible_labels_and_metadata(self):
        requirements = (
            AssetRequirement("required/a.png", "立绘", "required", "PNG", (10, 20)),
            AssetRequirement("voice/battle/a.mp3", "语音·battle", "suggested", "MP3"),
            AssetRequirement("story/a.png", "剧情表情", "excluded", "PNG"),
        )
        report = build_requirement_report(
            requirements,
            {
                "required/a.png": {"size": 42, "dims": (10, 20), "text": ""},
                "voice/battle/a.mp3": {"size": 21, "dims": None, "text": "台词"},
            },
        )

        groups = {group["name"]: group for group in report["groups"]}
        self.assertEqual({"立绘(必要)", "语音(建议)", "剧情(不检查)"}, set(groups))
        self.assertTrue(groups["立绘(必要)"]["required"])
        self.assertFalse(groups["语音(建议)"]["required"])
        self.assertEqual(42, groups["立绘(必要)"]["items"][0]["size"])
        self.assertEqual("台词", groups["语音(建议)"]["items"][0]["text"])


if __name__ == "__main__":
    unittest.main()
