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
import struct
import sys
import tempfile
import unittest
import zipfile
import zlib
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import wf_mod_tool as core  # noqa: E402

LOGICAL = "master/test/unit_test_table.orderedmap"


def build_fixture_orderedmap(keys: list[str], rows: list[bytes], *,
                             compress_rows: bool, level: int = 9) -> bytes:
    """Build an orderedmap with non-default zlib settings to expose re-encoding."""
    key_blob = b""
    row_blob = b""
    pairs: list[tuple[int, int]] = []
    for key, row in zip(keys, rows):
        key_blob += key.encode("utf-8")
        row_blob += zlib.compress(row, level) if compress_rows and row else row
        pairs.append((len(key_blob), len(row_blob)))

    index = bytearray(struct.pack("<I", len(keys)))
    for key_end, row_end in pairs:
        index += struct.pack("<II", key_end, row_end)
    index += key_blob
    packed_index = zlib.compress(bytes(index), level)
    return struct.pack("<I", len(packed_index)) + packed_index + row_blob


def build_inner_fixture(entries: list[tuple[str, list[str]]]) -> bytes:
    return build_fixture_orderedmap(
        [key for key, _ in entries],
        [core.write_csv_lines([fields]).encode("utf-8") for _, fields in entries],
        compress_rows=True,
    )


def build_outer_fixture(entries: list[tuple[str, bytes]]) -> bytes:
    return build_fixture_orderedmap(
        [key for key, _ in entries],
        [row for _, row in entries],
        compress_rows=False,
    )


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


class TestGenericNestedTable(unittest.TestCase):
    def _apis(self):
        required = (
            "ACTION_SKILL_LOGICAL",
            "SWITCHED_ACTION_SKILL_LOGICAL",
            "load_nested_table",
            "load_nested_table_bytes",
            "build_nested_table",
            "write_nested_table",
        )
        missing = [name for name in required if not hasattr(core, name)]
        if missing:
            self.fail("missing nested-table APIs: " + ", ".join(missing))
        return (
            core.load_nested_table,
            core.load_nested_table_bytes,
            core.build_nested_table,
            core.write_nested_table,
        )

    @staticmethod
    def _action_fixture(logical: str) -> tuple[bytes, dict[str, bytes]]:
        if logical == getattr(core, "ACTION_SKILL_LOGICAL", ""):
            seris_fields = ["skill", "desc", "action", "", "400", "400", "", "dsl/seris", ""]
            fixture_fields = ["fixture", "desc", "action", "", "500", "500", "", "dsl/fixture", ""]
        else:
            seris_fields = ["dsl/seris-switched", "desc", "", "", "", "", "", "wrong-c7"]
            fixture_fields = ["dsl/fixture-switched", "desc", "", "", "", "", "", "wrong-c7"]
        raw_rows = {
            "seris_dragon_king": build_inner_fixture([("1", seris_fields), ("2", seris_fields + ["plus"])]),
            "fixture": build_inner_fixture([("1", fixture_fields), ("2", fixture_fields + ["plus"])]),
        }
        return build_outer_fixture(list(raw_rows.items())), raw_rows

    def test_action_skill_roundtrip_preserves_full_and_inner_bytes(self):
        _, load_bytes, build_nested, _ = self._apis()
        encoded, raw_rows = self._action_fixture(core.ACTION_SKILL_LOGICAL)

        decoded = load_bytes(encoded, core.ACTION_SKILL_LOGICAL)

        self.assertEqual(list(decoded.rows), ["seris_dragon_king", "fixture"])
        self.assertEqual(decoded.raw_rows, raw_rows)
        self.assertTrue(hasattr(decoded, "program_path"),
                        "nested layout must expose its table-specific program-path reader")
        self.assertEqual(decoded.program_path("seris_dragon_king", "1"), "dsl/seris")
        self.assertEqual(build_nested(decoded, core.ACTION_SKILL_LOGICAL), encoded)

    def test_switched_program_path_is_inner_c0_not_action_c7(self):
        _, load_bytes, build_nested, _ = self._apis()
        encoded, _ = self._action_fixture(core.SWITCHED_ACTION_SKILL_LOGICAL)

        decoded = load_bytes(encoded, core.SWITCHED_ACTION_SKILL_LOGICAL)
        fields = core.read_csv_lines(decoded.rows["seris_dragon_king"].text_rows()["1"])[0]

        self.assertTrue(hasattr(decoded, "program_path"),
                        "nested layout must expose its table-specific program-path reader")
        self.assertEqual(decoded.program_path("seris_dragon_king", "1"),
                         "dsl/seris-switched")
        self.assertEqual(fields[0], "dsl/seris-switched")
        self.assertEqual(fields[core.ACTION_SKILL_COLUMNS["program_path"]], "wrong-c7")
        self.assertEqual(build_nested(decoded, core.SWITCHED_ACTION_SKILL_LOGICAL), encoded)

    def test_changed_row_reuses_untouched_raw_inner_bytes(self):
        _, load_bytes, build_nested, _ = self._apis()
        encoded, raw_rows = self._action_fixture(core.ACTION_SKILL_LOGICAL)
        decoded = load_bytes(encoded, core.ACTION_SKILL_LOGICAL)
        fields = core.read_csv_lines(decoded.rows["seris_dragon_king"].text_rows()["1"])[0]
        fields[1] = "changed description"
        decoded.rows["seris_dragon_king"].set_text_rows({"1": core.write_csv_lines([fields])})

        rebuilt = build_nested(decoded, core.ACTION_SKILL_LOGICAL)
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "nested.orderedmap"
            path.write_bytes(rebuilt)
            outer = core.read_orderedmap_file_raw_rows(path, core.ACTION_SKILL_LOGICAL)

        self.assertNotEqual(rebuilt, encoded)
        self.assertNotEqual(outer.rows[0], raw_rows["seris_dragon_king"])
        self.assertEqual(outer.rows[1], raw_rows["fixture"])
        changed = load_bytes(rebuilt, core.ACTION_SKILL_LOGICAL)
        self.assertEqual(changed.rows["seris_dragon_king"].text_rows()["1"].split(",")[1],
                         "changed description")

    def test_load_prefers_target_then_falls_back_to_source(self):
        load_nested, _, _, _ = self._apis()
        source_bytes, _ = self._action_fixture(core.ACTION_SKILL_LOGICAL)
        target_bytes, _ = self._action_fixture(core.SWITCHED_ACTION_SKILL_LOGICAL)
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            target_store = root / "target"
            source_store = root / "source"
            source_path = core.table_path(source_store, core.ACTION_SKILL_LOGICAL)
            source_path.parent.mkdir(parents=True)
            source_path.write_bytes(source_bytes)

            loaded = load_nested(core.ACTION_SKILL_LOGICAL, target_store, source_store)
            self.assertEqual(loaded.original_bytes, source_bytes)

            target_path = core.table_path(target_store, core.ACTION_SKILL_LOGICAL)
            target_path.parent.mkdir(parents=True)
            target_path.write_bytes(target_bytes)
            loaded = load_nested(core.ACTION_SKILL_LOGICAL, target_store, source_store)
            self.assertEqual(loaded.original_bytes, target_bytes)

    def test_write_uses_explicit_logical_path_and_backup_policy(self):
        _, load_bytes, _, write_nested = self._apis()
        encoded, _ = self._action_fixture(core.ACTION_SKILL_LOGICAL)
        decoded = load_bytes(encoded, core.ACTION_SKILL_LOGICAL)
        fields = core.read_csv_lines(decoded.rows["fixture"].text_rows()["1"])[0]
        fields[1] = "updated"
        decoded.rows["fixture"].set_text_rows({"1": core.write_csv_lines([fields])})

        with tempfile.TemporaryDirectory() as td:
            store = Path(td)
            target = core.table_path(store, core.ACTION_SKILL_LOGICAL)
            target.parent.mkdir(parents=True)
            target.write_bytes(encoded)
            with redirect_stdout(io.StringIO()):
                written = write_nested(decoded, core.ACTION_SKILL_LOGICAL, store, ".bak-unit")
            self.assertEqual(written, target)
            self.assertEqual(target.with_name(target.name + ".bak-unit").read_bytes(), encoded)

            no_backup_store = store / "no-backup"
            no_backup_target = core.table_path(no_backup_store, core.ACTION_SKILL_LOGICAL)
            no_backup_target.parent.mkdir(parents=True)
            no_backup_target.write_bytes(encoded)
            with redirect_stdout(io.StringIO()):
                write_nested(decoded, core.ACTION_SKILL_LOGICAL, no_backup_store,
                             ".bak-forbidden", no_backup=True)
            self.assertFalse(no_backup_target.with_name(no_backup_target.name + ".bak-forbidden").exists())

    def test_unknown_layout_is_rejected_before_decode(self):
        _, load_bytes, _, write_nested = self._apis()
        with self.assertRaisesRegex(ValueError, "unsupported nested table"):
            load_bytes(b"not-an-orderedmap", "master/unknown/table.orderedmap")

        encoded, _ = self._action_fixture(core.ACTION_SKILL_LOGICAL)
        decoded = load_bytes(encoded, core.ACTION_SKILL_LOGICAL)
        with tempfile.TemporaryDirectory() as td:
            store = Path(td)
            with self.assertRaisesRegex(ValueError, "unsupported nested table"):
                write_nested(decoded, "master/unknown/table.orderedmap", store, ".bak")
            self.assertEqual(list(store.rglob("*")), [],
                             "unknown layouts must fail before filesystem mutation")

    def test_duplicate_outer_and_inner_keys_are_rejected(self):
        _, load_bytes, _, _ = self._apis()
        inner = build_inner_fixture([("1", ["a"]), ("1", ["b"])])
        with self.assertRaisesRegex(ValueError, "duplicate inner key"):
            load_bytes(build_outer_fixture([("outer", inner)]), core.ACTION_SKILL_LOGICAL)

        valid_inner = build_inner_fixture([("1", ["a"])])
        with self.assertRaisesRegex(ValueError, "duplicate outer key"):
            load_bytes(build_outer_fixture([("outer", valid_inner), ("outer", valid_inner)]),
                       core.ACTION_SKILL_LOGICAL)

    def test_length_mismatches_and_multi_row_csv_are_rejected(self):
        _, load_bytes, build_nested, _ = self._apis()
        valid = build_outer_fixture([("outer", build_inner_fixture([("1", ["a"])]))])
        with self.assertRaisesRegex(ValueError, "length mismatch"):
            load_bytes(valid + b"trailing", core.ACTION_SKILL_LOGICAL)

        multi = build_inner_fixture([("1", ["a", "b"])])
        inner = core.read_orderedmap_file_from_bytes(multi)["1"] + "\nc,d"
        multi = build_fixture_orderedmap(["1"], [inner.encode("utf-8")], compress_rows=True)
        with self.assertRaisesRegex(ValueError, "exactly one CSV row"):
            load_bytes(build_outer_fixture([("outer", multi)]), core.ACTION_SKILL_LOGICAL)

        decoded = load_bytes(valid, core.ACTION_SKILL_LOGICAL)
        decoded.rows["outer"].keys.append("2")
        with self.assertRaisesRegex(ValueError, "key/row length mismatch"):
            build_nested(decoded, core.ACTION_SKILL_LOGICAL)


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
