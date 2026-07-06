# -*- coding: utf-8 -*-
"""核心引擎回归测试(纯标准库,离线合成数据,不碰真实 store)。

运行:
    python tests/test_core.py          # 或
    python -m unittest discover tests

覆盖最容易出灾难性 bug 的底层:orderedmap 往返一致、set_text_rows 新增键
(历史 bug:静默丢新键导致克隆角色客户端崩溃)、delete_keys、行序保持、
sha1_path 定位、发布 zip 的归档路径结构。
"""
from __future__ import annotations

import io
import sys
import tempfile
import unittest
import zipfile
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import wf_mod_tool as core  # noqa: E402

LOGICAL = "master/test/unit_test_table.orderedmap"


def make_store(tmp: Path, rows: dict[str, str]) -> Path:
    """在临时目录里按 store 布局(<xx>/<hash>)造一张表。"""
    om = core.OrderedMap(logical_path=LOGICAL, keys=list(rows),
                         rows=[v.encode("utf-8") for v in rows.values()],
                         source_path=Path("mem"))
    data = core.build_orderedmap(om)
    p = core.table_path(tmp, LOGICAL)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
    return p


class TestOrderedMap(unittest.TestCase):
    ROWS = {"111001": "a,b,c\nd,e,f", "111002": "1,2,3", "222001": ""}

    def test_roundtrip_bytes(self):
        """build → parse 字节级往返:键序、行文本完全一致。"""
        om = core.OrderedMap(LOGICAL, list(self.ROWS),
                             [v.encode() for v in self.ROWS.values()], Path("mem"))
        parsed = core.read_orderedmap_file_from_bytes(core.build_orderedmap(om))
        self.assertEqual(list(parsed.keys()), list(self.ROWS.keys()))
        self.assertEqual(parsed, self.ROWS)

    def test_roundtrip_via_store_file(self):
        """写入 store 布局文件 → load_table → write_table → 再读,内容一致。"""
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            make_store(tmp, self.ROWS)
            om = core.load_table(LOGICAL, tmp)
            self.assertEqual(om.text_rows(), self.ROWS)
            with redirect_stdout(io.StringIO()):
                core.write_table(om, tmp, ".bak-test", no_backup=True)
            again = core.load_table(LOGICAL, tmp)
            self.assertEqual(again.text_rows(), self.ROWS)

    def test_set_text_rows_appends_new_keys(self):
        """历史致命 bug 回归:set_text_rows 必须追加真正新增的键(克隆角色依赖)。"""
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            make_store(tmp, self.ROWS)
            om = core.load_table(LOGICAL, tmp)
            om.set_text_rows({"111001": "x,y,z", "999999": "new,row,here"})
            with redirect_stdout(io.StringIO()):
                core.write_table(om, tmp, ".bak-test", no_backup=True)
            again = core.load_table(LOGICAL, tmp).text_rows()
            self.assertEqual(again["111001"], "x,y,z", "已有键应被更新")
            self.assertIn("999999", again, "新增键不得被静默丢弃")
            self.assertEqual(again["999999"], "new,row,here")
            self.assertEqual(again["111002"], "1,2,3", "未提及的键不受影响")

    def test_delete_keys(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            make_store(tmp, self.ROWS)
            om = core.load_table(LOGICAL, tmp)
            om.delete_keys({"111002"})
            with redirect_stdout(io.StringIO()):
                core.write_table(om, tmp, ".bak-test", no_backup=True)
            again = core.load_table(LOGICAL, tmp).text_rows()
            self.assertNotIn("111002", again)
            self.assertEqual(list(again.keys()), ["111001", "222001"])

    def test_key_order_preserved(self):
        """键序不可重排(嵌套表/客户端解析依赖原序)。"""
        rows = {str(k): f"v{k}" for k in (5, 3, 9, 1, 7)}
        om = core.OrderedMap(LOGICAL, list(rows), [v.encode() for v in rows.values()], Path("mem"))
        parsed = core.read_orderedmap_file_from_bytes(core.build_orderedmap(om))
        self.assertEqual(list(parsed.keys()), ["5", "3", "9", "1", "7"])

    def test_normalize_row_length_pads_only(self):
        """normalize 只补不截(截断会毁行)。"""
        self.assertEqual(core.normalize_row_length(["a"], 3), ["a", "", ""])
        row6 = ["a", "b", "c", "d", "e", "f"]
        self.assertEqual(core.normalize_row_length(list(row6), 3), row6)


class TestSha1Path(unittest.TestCase):
    def test_format_and_determinism(self):
        h1 = core.sha1_path(LOGICAL)
        h2 = core.sha1_path(LOGICAL)
        self.assertEqual(h1, h2)
        self.assertEqual(len(h1), 40)
        int(h1, 16)  # 全 16 进制
        self.assertNotEqual(h1, core.sha1_path("master/test/other.orderedmap"))

    def test_table_path_layout(self):
        """store 布局 = <hash前2位>/<hash后38位>。"""
        h = core.sha1_path(LOGICAL)
        p = core.table_path(Path("root"), LOGICAL)
        self.assertEqual(p.parent.name, h[:2])
        self.assertEqual(p.name, h[2:])


def _char_csv(code: str, cid: str, refs: list[str]) -> str:
    row = [""] * 37
    row[0] = code
    row[17] = cid
    row[19:25] = refs
    return ",".join(row)


class TestCharacterLookup(unittest.TestCase):
    """历史 bug 回归:白(white_tiger)等老行 orderedmap 键('10')≠ character_id 列('3'),
    只按 col17/code_name 匹配会落进 `id×10+槽位` 回退,读到别人的孤儿词条(101)。"""

    def setUp(self):
        rows = {
            "1": _char_csv("alk", "1", ["11", "12", "13", "14", "15", "16"]),
            "10": _char_csv("white_tiger", "3", ["81", "82", "83", "84", "85", "86"]),
        }
        self.ct = core.OrderedMap(LOGICAL, list(rows),
                                  [v.encode() for v in rows.values()], Path("mem"))

    def test_key_mismatch_row_found_by_map_key(self):
        self.assertEqual(core.ability_ids_for_character("10", self.ct),
                         ["81", "82", "83", "84", "85", "86"])

    def test_normal_row_unchanged(self):
        self.assertEqual(core.ability_ids_for_character("1", self.ct),
                         ["11", "12", "13", "14", "15", "16"])

    def test_code_name_match_still_works(self):
        self.assertEqual(core.ability_ids_for_character("white_tiger", self.ct),
                         ["81", "82", "83", "84", "85", "86"])

    def test_fallback_without_table(self):
        self.assertEqual(core.ability_ids_for_character("7", None),
                         ["71", "72", "73", "74", "75", "76"])

    def test_effective_character_id(self):
        """leader_ability 表按 character_id 列取键:白 → 3,常规行原样,未知 id 原样。"""
        self.assertEqual(core.effective_character_id("10", self.ct), "3")
        self.assertEqual(core.effective_character_id("1", self.ct), "1")
        self.assertEqual(core.effective_character_id("999", self.ct), "999")


class TestPublishZipStructure(unittest.TestCase):
    def test_arcname_layout(self):
        """发布包内条目必须是 production/upload/<xx>/<hash>(与官方增量同构)。"""
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            f = make_store(tmp, {"1": "x"})
            rel = f.relative_to(tmp)
            arcname = "production/upload/" + rel.as_posix()
            zp = tmp / "test.zip"
            with zipfile.ZipFile(zp, "w") as z:
                z.write(f, arcname)
            with zipfile.ZipFile(zp) as z:
                names = z.namelist()
            self.assertEqual(len(names), 1)
            self.assertTrue(names[0].startswith("production/upload/"))
            parts = names[0].split("/")
            self.assertEqual(len(parts), 4)
            self.assertEqual(len(parts[2]), 2, "子目录=hash 前 2 位")
            self.assertEqual(len(parts[3]), 38, "文件名=hash 后 38 位")


if __name__ == "__main__":
    unittest.main(verbosity=2)
