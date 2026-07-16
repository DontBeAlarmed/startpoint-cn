from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "client-patch" / "dual-form-v1" / "abc_methods.py"
BASELINE = (
    ROOT
    / "work"
    / "character_packs"
    / "seris_dragon_king"
    / "canary-runtime"
    / "ffdec-probe"
    / "input.swf"
)

TARGET_METHODS = {
    "pinball.common.data.character:BattleCharacterLogic/resolvePathCollection",
    "pinball.common.data.battle.restore:BattleContinuationData/next",
    "pinball.scene.battle.battle.squad:SquadManagerImpl/invokeActionSkill",
    "pinball.scene.battle.battle.squad:SquadImpl/setContinuationData",
    "pinball.scene.battle.battle.squad.member:MemberImpl/update",
    "pinball.scene.battle.battle.squad.member:MemberImpl/run",
    "pinball.scene.battle.battle.squad.member:MemberImpl/setContinuationData",
    "pinball.scene.battle.battle.squad.member:MemberImpl/disposePlayhead",
    "pinball.scene.battle.battle.squad.member:MemberView/draw",
    "pinball.scene.battle.battle.squad.member:MemberView/dispose",
    "pinball.config.core:DevConfig/DevConfig",
}


def load_module():
    spec = importlib.util.spec_from_file_location("dual_form_abc_methods", MODULE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {MODULE_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@unittest.skipUnless(BASELINE.is_file(), "exact 6217 SWF fixture is not present")
class TestPcodeMethodIndex(unittest.TestCase):
    def test_exact_baseline_resolves_every_target_once(self) -> None:
        module = load_module()
        index = module.index_swf_methods(BASELINE)
        resolved = {name: index.require_unique(name) for name in TARGET_METHODS}

        self.assertEqual(TARGET_METHODS, set(resolved))
        self.assertEqual(len(resolved), len(set(resolved.values())))
        self.assertTrue(all(body_index >= 0 for body_index in resolved.values()))

    def test_unknown_method_fails_closed(self) -> None:
        module = load_module()
        index = module.index_swf_methods(BASELINE)
        with self.assertRaisesRegex(module.AbcIndexError, "expected exactly one"):
            index.require_unique("pinball.missing:Never/exists")


if __name__ == "__main__":
    unittest.main()
