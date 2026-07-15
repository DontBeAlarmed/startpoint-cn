# -*- coding: utf-8 -*-
from __future__ import annotations

import binascii
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import wf_asset_archive as archive_module


def crc(raw: bytes) -> str:
    return f"{binascii.crc32(raw) & 0xFFFFFFFF:08X}"


def slt_record(path: str, raw: bytes, *, encrypted: str = "-", crc_value: str | None = None) -> str:
    checksum = crc(raw) if crc_value is None else crc_value
    return (
        f"Path = {path}\n"
        "Folder = -\n"
        f"Size = {len(raw)}\n"
        "Attributes = A\n"
        f"Encrypted = {encrypted}\n"
        f"CRC = {checksum}\n"
    )


class FakeRunner:
    def __init__(self, *, listing: str = "", test_code: int = 0, list_code: int = 0) -> None:
        self.listing = listing
        self.test_code = test_code
        self.list_code = list_code
        self.calls: list[list[str]] = []

    def __call__(self, argv: list[str]) -> SimpleNamespace:
        self.calls.append(argv)
        if argv[1] == "t":
            return SimpleNamespace(returncode=self.test_code, stdout="", stderr="test failed" if self.test_code else "")
        if argv[1] == "l":
            return SimpleNamespace(returncode=self.list_code, stdout=self.listing, stderr="list failed" if self.list_code else "")
        raise AssertionError(argv)


class AssetArchiveTests(unittest.TestCase):
    def test_archive_must_pass_test_and_match_tree_crc(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            extracted = Path(td)
            (extracted / "nested").mkdir()
            first = b"first"
            second = b"second"
            (extracted / "a.bin").write_bytes(first)
            (extracted / "nested" / "b.bin").write_bytes(second)
            runner = FakeRunner(
                listing=slt_record("a.bin", first) + "\n" + slt_record("nested/b.bin", second)
            )
            seven = archive_module.SevenZip(Path("7z.exe"), runner=runner)

            self.assertTrue(seven.test(Path("assets.rar")).ok)
            members = seven.list(Path("assets.rar"))
            comparison = archive_module.compare_archive_to_tree(members, extracted)
            self.assertTrue(comparison.exact, comparison.issues)
            self.assertEqual(2, comparison.archive_file_count)

            (extracted / "nested" / "b.bin").write_bytes(b"changed")
            changed = archive_module.compare_archive_to_tree(members, extracted)
            self.assertFalse(changed.exact)
            self.assertTrue(any("nested/b.bin" in issue for issue in changed.issues))

    def test_unsafe_archive_member_paths_are_rejected(self) -> None:
        unsafe = [
            "../escape.bin",
            "folder/../../escape.bin",
            "/absolute.bin",
            "C:/drive.bin",
            "C:relative.bin",
            "//server/share.bin",
            "folder/./file.bin",
        ]
        for member_path in unsafe:
            with self.subTest(member_path=member_path):
                seven = archive_module.SevenZip(
                    Path("7z.exe"),
                    runner=FakeRunner(listing=slt_record(member_path, b"x")),
                )
                with self.assertRaisesRegex(archive_module.ArchiveError, "unsafe archive member"):
                    seven.list(Path("unsafe.zip"))

    def test_duplicate_normalized_member_paths_are_rejected(self) -> None:
        listing = slt_record("Folder/A.bin", b"a") + "\n" + slt_record("folder\\a.bin", b"a")
        seven = archive_module.SevenZip(Path("7z.exe"), runner=FakeRunner(listing=listing))
        with self.assertRaisesRegex(archive_module.ArchiveError, "duplicate"):
            seven.list(Path("duplicate.zip"))

    def test_encrypted_or_crc_less_members_are_unproven(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "secret.bin").write_bytes(b"secret")
            encrypted = archive_module.SevenZip(
                Path("7z.exe"),
                runner=FakeRunner(listing=slt_record("secret.bin", b"secret", encrypted="+")),
            ).list(Path("encrypted.7z"))
            self.assertFalse(archive_module.compare_archive_to_tree(encrypted, root).exact)

            no_crc_listing = slt_record("secret.bin", b"secret", crc_value="")
            no_crc = archive_module.SevenZip(
                Path("7z.exe"), runner=FakeRunner(listing=no_crc_listing)
            ).list(Path("no-crc.zip"))
            comparison = archive_module.compare_archive_to_tree(no_crc, root)
            self.assertFalse(comparison.exact)
            self.assertTrue(any("CRC" in issue for issue in comparison.issues))

    def test_nonzero_7zip_commands_fail_closed(self) -> None:
        runner = FakeRunner(test_code=2, list_code=2)
        seven = archive_module.SevenZip(Path("7z.exe"), runner=runner)
        result = seven.test(Path("broken.rar"))
        self.assertFalse(result.ok)
        self.assertEqual(2, result.returncode)
        with self.assertRaisesRegex(archive_module.ArchiveError, "listing failed"):
            seven.list(Path("broken.rar"))

    def test_real_7zip_lists_and_tests_a_small_zip_read_only(self) -> None:
        executable = archive_module.find_7zip()
        if executable is None:
            self.skipTest("7-Zip is unavailable")
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            extracted = root / "tree"
            extracted.mkdir()
            (extracted / "hello.txt").write_bytes(b"hello")
            archive = root / "fixture.zip"
            with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as stream:
                stream.write(extracted / "hello.txt", "hello.txt")
            seven = archive_module.SevenZip(executable)
            self.assertTrue(seven.test(archive).ok)
            comparison = archive_module.compare_archive_to_tree(seven.list(archive), extracted)
            self.assertTrue(comparison.exact, comparison.issues)


if __name__ == "__main__":
    unittest.main()
