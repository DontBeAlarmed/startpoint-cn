# -*- coding: utf-8 -*-
"""AMF3 编码器回归测试(纯合成数据,不碰真实 store)。

覆盖:encode_amf3 ↔ parse_dsl 往返、int/double 类型保持、字符串引用表、
JSON 文本管道、非法结构拒绝。全库 1035 个真实 DSL 文件的字节级往返
已在 2026-07-06 落地时验证(见 docs/技能形态切换与资产包导入结论.md)。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import wf_dsl  # noqa: E402


SYNTH = ["ActionDsl", 2, ["None"], False, True, None, 0, -18, 120,
         ["Block", [["Command", ["StopBall", -18, 120, ["Stop"], ["AB"], 0]],
                    ["Command", ["Rectangle", [{"min": 300, "max": 300}],
                                 [{"min": 2000.0, "max": 2000.5}]]]]],
         "重复字符串", "重复字符串", 268435455, -268435456, 2.5]


class TestAmf3Encoder(unittest.TestCase):
    def test_roundtrip_synthetic(self):
        data = wf_dsl.encode_amf3(SYNTH)
        tree = wf_dsl.parse_dsl(data)["tree"]
        self.assertEqual(tree, SYNTH)

    def test_int_double_types_preserved(self):
        data = wf_dsl.encode_amf3([1, 1.0, -5, -5.0])
        tree = wf_dsl.parse_dsl(data)["tree"]
        self.assertEqual([type(x) for x in tree], [int, float, int, float])

    def test_string_table_refs(self):
        """重复字符串必须走引用表(与官方序列化器同构,保证字节级一致)。"""
        one = wf_dsl.encode_amf3(["abcdef"])
        two = wf_dsl.encode_amf3(["abcdef", "abcdef"])
        # 第二次出现只占 marker(1B)+ref(1B),远小于重复内联
        self.assertLess(len(two) - len(one), 4)

    def test_json_text_pipeline(self):
        data = wf_dsl.encode_amf3(SYNTH)
        txt = wf_dsl.dsl_to_json_text(data)
        self.assertEqual(wf_dsl.json_text_to_dsl(txt), data)

    def test_out_of_range_int_falls_to_double(self):
        data = wf_dsl.encode_amf3([1 << 29])
        tree = wf_dsl.parse_dsl(data)["tree"]
        self.assertEqual(tree, [float(1 << 29)])

    def test_reject_bad_nodes(self):
        with self.assertRaises(ValueError):
            wf_dsl.encode_amf3([{"": 1}])       # 空对象键
        with self.assertRaises(ValueError):
            wf_dsl.encode_amf3([(1, 2)])         # 元组不是合法节点

    def test_u29_padded_still_readable(self):
        """历史原地补丁(非规范 U29)与新编码器共存:解析端两者都认。"""
        raw = wf_dsl.encode_u29_padded(300, 3)
        v, i = wf_dsl._read_u29(raw, 0)
        self.assertEqual((v, i), (300, 3))


if __name__ == "__main__":
    unittest.main()
