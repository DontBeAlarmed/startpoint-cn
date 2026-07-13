# -*- coding: utf-8 -*-
"""深渊连战活动元数据生成回归测试。"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import wf_rogue_build as rogue_build  # noqa: E402


class TestRushEventMetadata(unittest.TestCase):
    def test_abyss_event_always_uses_abyss_token(self):
        row = [f"column-{index}" for index in range(18)]
        row[10] = "2370007"
        before = list(row)

        actual = rogue_build.patch_event_metadata(row)

        self.assertEqual("2370099", actual[10])
        self.assertEqual(before[:10] + before[11:], actual[:10] + actual[11:])


if __name__ == "__main__":
    unittest.main()
