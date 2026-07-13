# -*- coding: utf-8 -*-
"""Transactional abyss client APK builder regression tests."""
from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import unittest
import warnings
import zipfile
from contextlib import redirect_stderr
from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
BUILDER_PATH = ROOT / "client-patch/abyss-mode-equipment/build_apk.py"
SPEC = importlib.util.spec_from_file_location("abyss_apk_builder", BUILDER_PATH)
if SPEC is None or SPEC.loader is None:  # pragma: no cover - importlib guard
    raise ImportError(f"cannot load APK builder module: {BUILDER_PATH}")
builder = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = builder
SPEC.loader.exec_module(builder)


def _source_text() -> str:
    patch = builder.abyss_patch
    lines = [
        "package",
        "{",
        "   public class BattleCharacterLogic",
        "   {",
        f"      {patch.WITH_COND_SIGNATURE}",
        "      {",
        "         var _loc12_:* = null as AbilitySoulAbilityLogic;",
        "         var _loc13_:* = null as BattleAbilityPeek;",
        "         var _loc14_:Boolean = false;",
        "         _loc14_ = Boolean(param3(_loc13_.questKind));",
        "      }",
        "",
        f"      {patch.TARGET_SIGNATURE}",
        "      {",
        "         var _loc12_:* = null as AbilitySoulAbilityLogic;",
        "         var _loc13_:* = null as BattleAbilityPeek;",
        "         var _loc14_:Boolean = false;",
        "         var _loc15_:int = 0;",
        f"         {patch.ANCHOR}",
        "         if(_loc14_)",
        "         {",
        "            _loc10_ = _loc13_.getTriggers();",
        "            _loc7_.add(_loc18_,_loc10_[_loc17_],this,param1,param2,false);",
        "         }",
        "      }",
        "",
        "      public function getActionSkills() : Array",
        "      {",
        "         return [];",
        "      }",
        "   }",
        "}",
        "",
    ]
    return "\n".join(lines)


class FakeToolchain:
    """Create expected tool outputs while keeping orchestration real."""

    def __init__(
        self,
        battle_logic_as: Path,
        *,
        fail_call: int | None = None,
        cancel_call: int | None = None,
        export_count: int = 1,
        invalid_export: bool = False,
    ) -> None:
        self.battle_logic_as = battle_logic_as
        self.fail_call = fail_call
        self.cancel_call = cancel_call
        self.export_count = export_count
        self.invalid_export = invalid_export
        self.commands: list[list[str]] = []

    def __call__(self, command: list[str], *, check: bool) -> subprocess.CompletedProcess:
        actual = [str(value) for value in command]
        call_index = len(self.commands)
        self.commands.append(actual)
        if self.cancel_call == call_index:
            raise KeyboardInterrupt(f"cancelled tool call {call_index}")
        if self.fail_call == call_index:
            raise subprocess.CalledProcessError(9, actual)

        if "-replace" in actual:
            replace = actual.index("-replace")
            shutil.copyfile(actual[replace + 1], actual[replace + 2])
        elif "-export" in actual:
            export = actual.index("-export")
            export_root = Path(actual[export + 2])
            for index in range(self.export_count):
                suffix = "" if index == 0 else f"/duplicate-{index}"
                destination = export_root / (
                    "scripts/pinball/common/data/character"
                    f"{suffix}/BattleCharacterLogic.as"
                )
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_text(
                    "invalid ActionScript"
                    if self.invalid_export
                    else self.battle_logic_as.read_text(encoding="utf-8"),
                    encoding="utf-8",
                )
        elif "sign" in actual:
            output = Path(actual[actual.index("--out") + 1])
            shutil.copyfile(actual[-1], output)
        elif "verify" not in actual:
            shutil.copyfile(actual[-2], actual[-1])
        return subprocess.CompletedProcess(actual, 0)


def _build_fixture(root: Path) -> builder.BuildConfig:
    base = root / "base.apk"
    with zipfile.ZipFile(base, "w") as archive:
        archive.writestr(
            builder.TARGET_SWF_MEMBER,
            b"original SWF",
            compress_type=zipfile.ZIP_DEFLATED,
        )
        archive.writestr("META-INF/CERT.RSA", b"old signature")
        archive.writestr("META-INF/AIR/application.xml", b"AIR metadata")

    battle_logic_as = root / "BattleCharacterLogic.as"
    patched, insertions = builder.abyss_patch.patch_text(_source_text())
    if insertions != 1:  # pragma: no cover - fixture invariant
        raise AssertionError("fixture gate was not inserted")
    battle_logic_as.write_text(patched, encoding="utf-8")

    tools = root / "tools"
    tools.mkdir()
    java = tools / "java.exe"
    ffdec = tools / "ffdec.jar"
    zipalign = tools / "zipalign.exe"
    apksigner = tools / "apksigner.bat"
    keystore = tools / "wf.keystore"
    for path in (java, ffdec, zipalign, apksigner, keystore):
        path.write_bytes(b"test tool")

    return builder.BuildConfig(
        base=base,
        battle_logic_as=battle_logic_as,
        output_apk=root / "final.apk",
        report=root / "verification.json",
        work=root / "work",
        ffdec=ffdec,
        java=java,
        zipalign=zipalign,
        apksigner=apksigner,
        keystore=keystore,
        keystore_password_env="WF_TEST_APK_KS_PASS",
    )


class TestBuilderSurface(unittest.TestCase):
    def test_target_swf_member_is_explicit(self) -> None:
        self.assertEqual(
            builder.TARGET_SWF_MEMBER,
            "assets/worldflipper_android_release.swf",
        )


class TestSignatureMembers(unittest.TestCase):
    def test_only_top_level_apk_signature_members_are_recognized(self) -> None:
        for member in (
            "META-INF/MANIFEST.MF",
            "META-INF/CERT.SF",
            "META-INF/CERT.RSA",
            "META-INF/CERT.DSA",
            "META-INF/CERT.EC",
            "meta-inf/lower.sf",
        ):
            with self.subTest(member=member):
                self.assertTrue(builder.is_signature_member(member))

        for member in (
            "META-INF/AIR/MANIFEST.MF",
            "META-INF/AIR/CERT.SF",
            "META-INF/services/example",
            "META-INF/NOTICE",
            "other/META-INF/CERT.RSA",
            "META-INF/CERT.RSA/child",
            "META-INF/",
        ):
            with self.subTest(member=member):
                self.assertFalse(builder.is_signature_member(member))


class TestRewriteApk(unittest.TestCase):
    def test_replaces_swf_preserving_compression_and_keeps_air_metadata(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            base = root / "base.apk"
            replacement = root / "injected.swf"
            output = root / "unsigned.apk"
            replacement.write_bytes(b"patched swf")
            with zipfile.ZipFile(base, "w") as archive:
                archive.comment = b"apk comment"
                archive.writestr(
                    builder.TARGET_SWF_MEMBER,
                    b"original swf",
                    compress_type=zipfile.ZIP_DEFLATED,
                )
                archive.writestr("assets/keep.bin", b"keep")
                archive.writestr("META-INF/MANIFEST.MF", b"manifest")
                archive.writestr("META-INF/CERT.SF", b"sf")
                archive.writestr("META-INF/CERT.RSA", b"rsa")
                archive.writestr("META-INF/CERT.DSA", b"dsa")
                archive.writestr("META-INF/CERT.EC", b"ec")
                archive.writestr("META-INF/AIR/application.xml", b"air")
                archive.writestr("META-INF/AIR/CERT.RSA", b"air signature")

            builder.rewrite_apk(base, output, replacement)

            with zipfile.ZipFile(output) as archive:
                names = archive.namelist()
                self.assertEqual(archive.comment, b"apk comment")
                self.assertEqual(
                    archive.read(builder.TARGET_SWF_MEMBER), b"patched swf"
                )
                self.assertEqual(
                    archive.getinfo(builder.TARGET_SWF_MEMBER).compress_type,
                    zipfile.ZIP_DEFLATED,
                )
                self.assertEqual(archive.read("assets/keep.bin"), b"keep")
                self.assertEqual(
                    archive.read("META-INF/AIR/application.xml"), b"air"
                )
                self.assertEqual(
                    archive.read("META-INF/AIR/CERT.RSA"), b"air signature"
                )
                self.assertNotIn("META-INF/MANIFEST.MF", names)
                self.assertNotIn("META-INF/CERT.SF", names)
                self.assertNotIn("META-INF/CERT.RSA", names)
                self.assertNotIn("META-INF/CERT.DSA", names)
                self.assertNotIn("META-INF/CERT.EC", names)

    def test_missing_or_duplicate_target_preserves_existing_output(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            replacement = root / "injected.swf"
            replacement.write_bytes(b"patched")
            output = root / "unsigned.apk"
            output.write_bytes(b"previous output")

            for count in (0, 2):
                base = root / f"base-{count}.apk"
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", UserWarning)
                    with zipfile.ZipFile(base, "w") as archive:
                        for index in range(count):
                            archive.writestr(
                                builder.TARGET_SWF_MEMBER,
                                f"original-{index}".encode(),
                            )
                with self.subTest(count=count):
                    with self.assertRaises(builder.BuildError):
                        builder.rewrite_apk(base, output, replacement)
                    self.assertEqual(output.read_bytes(), b"previous output")


class TestVerificationReport(unittest.TestCase):
    def _make_report(self, root: Path) -> tuple[dict[str, object], dict[str, bytes]]:
        contents = {
            "patched_as": b"patched ActionScript",
            "injected_swf": b"compiled SWF",
            "signed_apk": b"signed APK",
            "reexported_as": b"re-exported ActionScript",
        }
        artifacts: dict[str, dict[str, str]] = {}
        for name, data in contents.items():
            path = (root / name).resolve()
            path.write_bytes(data)
            artifacts[name] = {
                "path": str(path),
                "sha256": hashlib.sha256(data).hexdigest(),
            }
        report: dict[str, object] = {
            "schema_version": 1,
            "status": "verified",
            "class_name": (
                "pinball.common.data.character.BattleCharacterLogic"
            ),
            "artifacts": artifacts,
        }
        return report, contents

    def test_valid_report_checks_all_absolute_paths_and_hashes(self) -> None:
        with TemporaryDirectory() as temporary:
            report, _ = self._make_report(Path(temporary))
            self.assertTrue(builder.validate_verification_report(report))

    def test_rehashing_any_artifact_invalidates_report(self) -> None:
        with TemporaryDirectory() as temporary:
            report, contents = self._make_report(Path(temporary))
            artifacts = report["artifacts"]
            self.assertIsInstance(artifacts, dict)
            for name, original in contents.items():
                record = artifacts[name]
                path = Path(record["path"])
                with self.subTest(artifact=name):
                    path.write_bytes(original + b" tampered")
                    with self.assertRaises(builder.BuildError):
                        builder.validate_verification_report(report)
                    path.write_bytes(original)

    def test_wrong_class_relative_path_and_malformed_hash_are_rejected(self) -> None:
        with TemporaryDirectory() as temporary:
            report, _ = self._make_report(Path(temporary))

            wrong_class = copy.deepcopy(report)
            wrong_class["class_name"] = "WrongClass"
            with self.assertRaises(builder.BuildError):
                builder.validate_verification_report(wrong_class)

            relative_path = copy.deepcopy(report)
            relative_path["artifacts"]["patched_as"]["path"] = "relative.as"
            with self.assertRaises(builder.BuildError):
                builder.validate_verification_report(relative_path)

            malformed_hash = copy.deepcopy(report)
            malformed_hash["artifacts"]["signed_apk"]["sha256"] = "not-a-sha"
            with self.assertRaises(builder.BuildError):
                builder.validate_verification_report(malformed_hash)


class TestTransactionalBuild(unittest.TestCase):
    SECRET = "local-test-secret-must-never-appear"

    def _run_success(
        self, root: Path
    ) -> tuple[builder.BuildConfig, FakeToolchain, dict[str, object]]:
        config = _build_fixture(root)
        toolchain = FakeToolchain(config.battle_logic_as)
        with mock.patch.dict(
            os.environ,
            {config.keystore_password_env: self.SECRET},
            clear=False,
        ), mock.patch.object(
            builder.subprocess, "run", side_effect=toolchain
        ):
            report = builder.build_verified_apk(config)
        return config, toolchain, report

    def test_success_uses_exact_sequence_and_writes_valid_secret_free_report(self) -> None:
        with TemporaryDirectory() as temporary:
            config, toolchain, report = self._run_success(Path(temporary))

            self.assertEqual(len(toolchain.commands), 5)
            replace, export, align, sign, verify = toolchain.commands
            self.assertEqual(
                replace[:7],
                [
                    str(config.java.resolve()),
                    "-jar",
                    str(config.ffdec.resolve()),
                    "-air",
                    "-onerror",
                    "abort",
                    "-replace",
                ],
            )
            self.assertEqual(replace[-2:], [builder.TARGET_CLASS, str(config.battle_logic_as.resolve())])
            self.assertEqual(
                export[:8],
                [
                    str(config.java.resolve()),
                    "-jar",
                    str(config.ffdec.resolve()),
                    "-onerror",
                    "abort",
                    "-selectclass",
                    builder.TARGET_CLASS,
                    "-export",
                ],
            )
            self.assertEqual(export[8], "script")
            self.assertEqual(
                align[:4], [str(config.zipalign.resolve()), "-p", "-f", "4"]
            )
            self.assertEqual(
                sign[:8],
                [
                    str(config.apksigner.resolve()),
                    "sign",
                    "--v4-signing-enabled",
                    "false",
                    "--ks",
                    str(config.keystore.resolve()),
                    "--ks-pass",
                    f"env:{config.keystore_password_env}",
                ],
            )
            self.assertEqual(
                verify[:4],
                [
                    str(config.apksigner.resolve()),
                    "verify",
                    "--verbose",
                    "--print-certs",
                ],
            )
            self.assertEqual(Path(verify[-1]).name, "signed.apk")
            self.assertNotEqual(verify[-1], str(config.output_apk.resolve()))

            report_text = config.report.read_text(encoding="utf-8")
            self.assertNotIn(self.SECRET, report_text)
            self.assertNotIn(self.SECRET, repr(toolchain.commands))
            self.assertNotIn("ks_pass", report_text.lower())
            self.assertEqual(report, json.loads(report_text))
            self.assertEqual(report["class_name"], builder.TARGET_CLASS)
            self.assertEqual(set(report["artifacts"]), set(builder.REPORT_ARTIFACTS))
            self.assertTrue(config.output_apk.is_file())
            self.assertTrue(config.report.is_file())
            self.assertTrue(builder.validate_verification_report(config.report))
            for record in report["artifacts"].values():
                self.assertTrue(Path(record["path"]).is_absolute())

    def test_every_external_failure_removes_stale_final_pair_and_work_transaction(self) -> None:
        for call_index, stage in enumerate(
            ("replace", "re-export", "zipalign", "sign", "signature verify")
        ):
            with self.subTest(stage=stage), TemporaryDirectory() as temporary:
                config = _build_fixture(Path(temporary))
                config.output_apk.write_bytes(b"stale APK")
                config.report.write_text("stale report", encoding="utf-8")
                toolchain = FakeToolchain(
                    config.battle_logic_as, fail_call=call_index
                )
                with mock.patch.dict(
                    os.environ,
                    {config.keystore_password_env: self.SECRET},
                    clear=False,
                ), mock.patch.object(
                    builder.subprocess, "run", side_effect=toolchain
                ):
                    with self.assertRaises(subprocess.CalledProcessError):
                        builder.build_verified_apk(config)
                self.assertFalse(config.output_apk.exists())
                self.assertFalse(config.report.exists())
                self.assertEqual(list(config.work.glob(".abyss-apk-build-*")), [])

    def test_cli_redacts_a_secret_even_if_an_error_contains_it(self) -> None:
        with TemporaryDirectory() as temporary:
            config = _build_fixture(Path(temporary))
            argv = [
                "--base", str(config.base),
                "--battle-logic-as", str(config.battle_logic_as),
                "--out", str(config.output_apk),
                "--report", str(config.report),
                "--work", str(config.work),
                "--ffdec", str(config.ffdec),
                "--java", str(config.java),
                "--zipalign", str(config.zipalign),
                "--apksigner", str(config.apksigner),
                "--ks", str(config.keystore),
                "--ks-pass-env", config.keystore_password_env,
            ]
            stderr = StringIO()
            with mock.patch.dict(
                os.environ,
                {config.keystore_password_env: self.SECRET},
                clear=False,
            ), mock.patch.object(
                builder,
                "build_verified_apk",
                side_effect=builder.BuildError(f"failure {self.SECRET}"),
            ), redirect_stderr(stderr):
                result = builder.main(argv)
            self.assertEqual(result, 1)
            self.assertNotIn(self.SECRET, stderr.getvalue())
            self.assertIn("<redacted>", stderr.getvalue())

    def test_explicit_empty_keystore_password_is_distinct_from_unset(self) -> None:
        with TemporaryDirectory() as temporary:
            config = _build_fixture(Path(temporary))
            toolchain = FakeToolchain(config.battle_logic_as)
            with mock.patch.dict(
                os.environ,
                {config.keystore_password_env: ""},
                clear=False,
            ), mock.patch.object(
                builder.subprocess, "run", side_effect=toolchain
            ):
                builder.build_verified_apk(config)
            self.assertTrue(config.output_apk.is_file())
            self.assertTrue(config.report.is_file())

        with TemporaryDirectory() as temporary:
            config = _build_fixture(Path(temporary))
            with mock.patch.dict(os.environ, {}, clear=False):
                os.environ.pop(config.keystore_password_env, None)
                with self.assertRaises(builder.BuildError):
                    builder.build_verified_apk(config)

    def test_every_external_cancellation_leaves_no_final_pair(self) -> None:
        for call_index, stage in enumerate(
            ("replace", "re-export", "zipalign", "sign", "signature verify")
        ):
            with self.subTest(stage=stage), TemporaryDirectory() as temporary:
                config = _build_fixture(Path(temporary))
                toolchain = FakeToolchain(
                    config.battle_logic_as, cancel_call=call_index
                )
                with mock.patch.dict(
                    os.environ,
                    {config.keystore_password_env: self.SECRET},
                    clear=False,
                ), mock.patch.object(
                    builder.subprocess, "run", side_effect=toolchain
                ):
                    with self.assertRaises(KeyboardInterrupt):
                        builder.build_verified_apk(config)
                self.assertFalse(config.output_apk.exists())
                self.assertFalse(config.report.exists())
                self.assertEqual(list(config.work.glob(".abyss-apk-build-*")), [])

    def test_preflight_cancellation_also_removes_stale_final_pair(self) -> None:
        with TemporaryDirectory() as temporary:
            config = _build_fixture(Path(temporary))
            config.output_apk.write_bytes(b"stale APK")
            config.report.write_text("stale report", encoding="utf-8")
            with mock.patch.dict(
                os.environ,
                {config.keystore_password_env: self.SECRET},
                clear=False,
            ), mock.patch.object(
                builder.abyss_patch,
                "verify_text",
                side_effect=KeyboardInterrupt("cancelled during preflight"),
            ):
                with self.assertRaises(KeyboardInterrupt):
                    builder.build_verified_apk(config)
            self.assertFalse(config.output_apk.exists())
            self.assertFalse(config.report.exists())

    def test_missing_ambiguous_or_semantically_invalid_reexport_fails_closed(self) -> None:
        cases = (
            ("missing", 0, False),
            ("ambiguous", 2, False),
            ("invalid", 1, True),
        )
        for label, export_count, invalid in cases:
            with self.subTest(case=label), TemporaryDirectory() as temporary:
                config = _build_fixture(Path(temporary))
                toolchain = FakeToolchain(
                    config.battle_logic_as,
                    export_count=export_count,
                    invalid_export=invalid,
                )
                with mock.patch.dict(
                    os.environ,
                    {config.keystore_password_env: self.SECRET},
                    clear=False,
                ), mock.patch.object(
                    builder.subprocess, "run", side_effect=toolchain
                ):
                    with self.assertRaises((builder.BuildError, builder.abyss_patch.PatchError)):
                        builder.build_verified_apk(config)
                self.assertFalse(config.output_apk.exists())
                self.assertFalse(config.report.exists())
                self.assertEqual(list(config.work.glob(".abyss-apk-build-*")), [])

    def test_cancellation_after_either_final_move_removes_both_outputs(self) -> None:
        for destination_name in ("output_apk", "report"):
            with self.subTest(destination=destination_name), TemporaryDirectory() as temporary:
                config = _build_fixture(Path(temporary))
                toolchain = FakeToolchain(config.battle_logic_as)
                destination = getattr(config, destination_name).resolve()
                real_replace = os.replace

                def commit_then_cancel(source: object, target: object) -> None:
                    real_replace(source, target)
                    if Path(target).resolve() == destination:
                        raise KeyboardInterrupt(f"cancelled after {destination_name}")

                with mock.patch.dict(
                    os.environ,
                    {config.keystore_password_env: self.SECRET},
                    clear=False,
                ), mock.patch.object(
                    builder.subprocess, "run", side_effect=toolchain
                ), mock.patch.object(
                    builder.os, "replace", side_effect=commit_then_cancel
                ):
                    with self.assertRaises(KeyboardInterrupt):
                        builder.build_verified_apk(config)
                self.assertFalse(config.output_apk.exists())
                self.assertFalse(config.report.exists())


if __name__ == "__main__":
    unittest.main()
