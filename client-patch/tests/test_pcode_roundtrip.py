from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
BASELINE = (
    ROOT
    / "work"
    / "character_packs"
    / "seris_dragon_king"
    / "canary-runtime"
    / "ffdec-probe"
    / "input.swf"
)
PCODE_ROOT = (
    ROOT
    / "work"
    / "character_packs"
    / "seris_dragon_king"
    / "client-pcode-baseline-6217-exact"
    / "scripts"
)
FFDEC = ROOT.parent.parent / "ffdec_26.2.1" / "ffdec.jar"
FFDEC_PROFILE = ROOT / "work" / "ffdec-profile"
ABC_MODULE = ROOT / "client-patch" / "dual-form-v1" / "abc_methods.py"
PCODE_MODULE = ROOT / "client-patch" / "dual-form-v1" / "pcode_tools.py"
BUILD_MODULE = ROOT / "client-patch" / "dual-form-v1" / "build_patch.py"
PATCH_ROOT = BUILD_MODULE.parent


PURE_METHODS = (
    {
        "method_name": (
            "pinball.common.data.character:BattleCharacterLogic/"
            "resolvePathCollection"
        ),
        "pcode_path": "pinball/common/data/character/BattleCharacterLogic.pcode",
        "code_sha256": "1" * 64,
        "patches": ["preload_rarity4_special_animation"],
        "required_maxstack": 7,
        "required_localcount": 15,
    },
    {
        "method_name": "pinball.scene.battle.battle.squad.member:MemberView/draw",
        "pcode_path": "pinball/scene/battle/battle/squad/member/MemberView.pcode",
        "code_sha256": "2" * 64,
        "patches": [],
        "required_maxstack": 4,
        "required_localcount": 23,
    },
)


CASES = (
    (
        "pinball.common.data.character.BattleCharacterLogic",
        "pinball.common.data.character:BattleCharacterLogic/resolvePathCollection",
        "pinball/common/data/character/BattleCharacterLogic.pcode",
        "resolvePathCollection",
        None,
    ),
    (
        "pinball.common.data.battle.restore.BattleContinuationData",
        "pinball.common.data.battle.restore:BattleContinuationData/next",
        "pinball/common/data/battle/restore/BattleContinuationData.pcode",
        "next",
        None,
    ),
    (
        "pinball.scene.battle.battle.squad.SquadManagerImpl",
        "pinball.scene.battle.battle.squad:SquadManagerImpl/invokeActionSkill",
        "pinball/scene/battle/battle/squad/SquadManagerImpl.pcode",
        "invokeActionSkill",
        None,
    ),
    (
        "pinball.scene.battle.battle.squad.SquadImpl",
        "pinball.scene.battle.battle.squad:SquadImpl/setContinuationData",
        "pinball/scene/battle/battle/squad/SquadImpl.pcode",
        "setContinuationData",
        None,
    ),
    *(
        (
            "pinball.scene.battle.battle.squad.member.MemberImpl",
            f"pinball.scene.battle.battle.squad.member:MemberImpl/{leaf}",
            "pinball/scene/battle/battle/squad/member/MemberImpl.pcode",
            leaf,
            None,
        )
        for leaf in (
            "update",
            "run",
            "setContinuationData",
            "startActionSkills",
            "disposePlayhead",
        )
    ),
    *(
        (
            "pinball.scene.battle.battle.squad.member.MemberView",
            f"pinball.scene.battle.battle.squad.member:MemberView/{leaf}",
            "pinball/scene/battle/battle/squad/member/MemberView.pcode",
            leaf,
            None,
        )
        for leaf in ("draw", "dispose")
    ),
    (
        "pinball.config.core.DevConfig",
        "pinball.config.core:DevConfig/DevConfig",
        "pinball/config/core/DevConfig.pcode",
        None,
        "pinball.config.core:DevConfig/DevConfig",
    ),
)


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_build_module():
    sys.path.insert(0, str(PATCH_ROOT))
    try:
        return load_module("dual_form_build_patch", BUILD_MODULE)
    finally:
        sys.path.remove(str(PATCH_ROOT))


def pure_manifest(baseline_sha256: str) -> dict:
    return {
        "schema_version": 3,
        "injection_strategy": "pure_pcode_existing_classes",
        "baseline": {
            "main_swf_sha256": baseline_sha256,
            "resource_version": "1.4.54",
        },
        "methods": [dict(entry) for entry in PURE_METHODS],
    }


class RecordingRunner:
    def __init__(self, *, mutate_replacement: bool = True) -> None:
        self.commands: list[list[str]] = []
        self.mutate_replacement = mutate_replacement

    def __call__(self, command, *, cwd, env, timeout):
        del cwd, env, timeout
        command = [str(part) for part in command]
        self.commands.append(command)
        if "-replace" in command:
            replace = command.index("-replace")
            source = Path(command[replace + 1])
            destination = Path(command[replace + 2])
            data = source.read_bytes()
            if self.mutate_replacement:
                data += b"\npure-pcode-replacement"
            destination.write_bytes(data)
        elif "-export" in command:
            export = command.index("-export")
            export_root = Path(command[export + 2])
            (export_root / "scripts").mkdir(parents=True, exist_ok=True)
        return {"command": command, "returncode": 0, "stdout": "", "stderr": ""}


class TestPurePcodeBuild(unittest.TestCase):
    def setUp(self) -> None:
        self.build_module = load_build_module()

    def run_recorded_build(
        self, temporary: Path, *, mutate_replacement: bool = True
    ):
        baseline = temporary / "baseline.swf"
        baseline.write_bytes(b"synthetic baseline")
        manifest = temporary / "manifest.json"
        manifest.write_text(
            json.dumps(
                pure_manifest(hashlib.sha256(baseline.read_bytes()).hexdigest()),
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        pcode_root = temporary / "baseline-pcode"
        pcode_root.mkdir()
        ffdec = temporary / "ffdec.jar"
        ffdec.write_bytes(b"fixture")
        generated_root: Path | None = None

        def generate_patch_set(_swf, _pcode, output_root, _manifest):
            nonlocal generated_root
            generated_root = Path(output_root)
            generated_root.mkdir(parents=True, exist_ok=True)
            outputs = []
            for sequence, entry in enumerate(PURE_METHODS):
                output = generated_root / f"{sequence}.pcode"
                output.write_text("method\nend ; method\n", encoding="utf-8")
                outputs.append(
                    {
                        "method_name": entry["method_name"],
                        "output": str(output),
                    }
                )
            return {"status": "generated", "method_count": 2, "outputs": outputs}

        targets = [
            {
                "class_name": "pinball.common.data.character.BattleCharacterLogic",
                "method_name": PURE_METHODS[0]["method_name"],
                "replacement_body_index": 17692,
            },
            {
                "class_name": "pinball.scene.battle.battle.squad.member.MemberView",
                "method_name": PURE_METHODS[1]["method_name"],
                "replacement_body_index": 61044,
            },
        ]
        runner = RecordingRunner(mutate_replacement=mutate_replacement)
        verification = {
            "status": "verified-offline-only",
            "method_count": 2,
            "replacement_body_indices": {
                item["method_name"]: item["replacement_body_index"]
                for item in targets
            },
            "device_canary_required": True,
        }
        with (
            mock.patch.object(
                self.build_module.patch_pcode,
                "generate_patch_set",
                side_effect=generate_patch_set,
            ),
            mock.patch.object(
                self.build_module.patch_pcode,
                "resolve_replacement_targets",
                return_value=targets,
            ),
            mock.patch.object(
                self.build_module.patch_pcode,
                "verify_pcode_export",
                return_value=verification,
            ) as verify,
            mock.patch.object(self.build_module, "_run", side_effect=runner),
        ):
            report = self.build_module.build(
                baseline_swf=baseline,
                baseline_pcode_root=pcode_root,
                ffdec_jar=ffdec,
                output_dir=temporary / "output",
                profile_dir=temporary / "profile",
                manifest_path=manifest,
            )
        return report, runner.commands, verify

    def test_pure_build_never_invokes_import_script(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            report, commands, verify = self.run_recorded_build(Path(temporary))

        flattened = "\n".join(" ".join(command) for command in commands)
        self.assertNotIn("-importScript", flattened)
        self.assertNotIn(".as", flattened)
        self.assertIn("-replace", flattened)
        self.assertNotIn("carrier", report)
        self.assertEqual(2, len(report["replacement_targets"]))
        self.assertNotEqual(report["baseline"]["sha256"], report["final"]["sha256"])
        verify.assert_called_once()

    def test_pure_build_rejects_a_final_swf_identical_to_baseline(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(
                self.build_module.BuildError, "final SWF sha256 matches baseline"
            ):
                self.run_recorded_build(
                    Path(temporary), mutate_replacement=False
                )


@unittest.skipUnless(
    BASELINE.is_file() and PCODE_ROOT.is_dir() and FFDEC.is_file(),
    "exact SWF/P-code/FFDec fixtures are not present",
)
class TestPcodeRoundTrip(unittest.TestCase):
    def test_all_high_risk_methods_round_trip_byte_identically(self) -> None:
        abc = load_module("dual_form_abc_roundtrip", ABC_MODULE)
        pcode = load_module("dual_form_pcode_tools", PCODE_MODULE)
        before_index = abc.index_swf_methods(BASELINE)
        before_refs = {
            method_name: before_index.require_ref(method_name)
            for _class_name, method_name, _path, _trait, _info_name in CASES
        }

        with tempfile.TemporaryDirectory() as temporary:
            temporary_path = Path(temporary)
            output_swf = temporary_path / "roundtrip.swf"
            command = [
                "java",
                "-jar",
                str(FFDEC),
                "-air",
                "-replace",
                str(BASELINE),
                str(output_swf),
            ]
            for sequence, (
                class_name,
                method_name,
                relative_pcode,
                trait_name,
                method_info_name,
            ) in enumerate(CASES):
                method_file = temporary_path / f"method-{sequence}.pcode"
                source = PCODE_ROOT / relative_pcode
                if trait_name is not None:
                    pcode.write_method_block(
                        source,
                        method_file,
                        trait_kind="method",
                        trait_name=trait_name,
                    )
                else:
                    pcode.write_named_method_block(
                        source,
                        method_file,
                        method_info_name=method_info_name,
                    )
                command.extend(
                    [
                        class_name,
                        str(method_file),
                        str(before_refs[method_name].body_index),
                    ]
                )

            environment = os.environ.copy()
            environment["APPDATA"] = str(FFDEC_PROFILE)
            completed = subprocess.run(
                command,
                cwd=ROOT,
                env=environment,
                capture_output=True,
                text=True,
                timeout=120,
                check=False,
            )
            self.assertEqual(
                0,
                completed.returncode,
                msg=f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
            )
            after_index = abc.index_swf_methods(output_swf)
            after_refs = {
                method_name: after_index.require_ref(method_name)
                for _class_name, method_name, _path, _trait, _info_name in CASES
            }

        for method_name, before in before_refs.items():
            with self.subTest(method_name=method_name):
                after = after_refs[method_name]
                self.assertEqual(before.body_index, after.body_index)
                self.assertEqual(before.code, after.code)


if __name__ == "__main__":
    unittest.main()
