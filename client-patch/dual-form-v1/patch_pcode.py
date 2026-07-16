#!/usr/bin/env python3
"""Generate and verify fail-closed FFDec P-code replacements.

The pure-P-code contract never compiles source code or adds classes.  It locks
the exact 6217 ABC method code, extracts the exported method bodies, and emits
replacements for methods that already exist in the baseline SWF.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
import tempfile
import textwrap
from pathlib import Path, PurePosixPath
from types import ModuleType
from typing import Any, Callable, NamedTuple


PATCH_ROOT = Path(__file__).resolve().parent
DEFAULT_MANIFEST = PATCH_ROOT / "patch-manifest-pure-pcode.json"
HELPER_CLASS = (
    'QName(PackageNamespace("pinball.scene.battle.battle.squad.member"),'
    '"DualFormPresentationController")'
)
VIEW_HELPER_CLASS = (
    'QName(PackageNamespace("pinball.scene.battle.battle.squad.member"),'
    '"DualFormPresentationController")'
)
RUNTIME_MARKER_CLASS = (
    'QName(PackageNamespace("pinball.scene.battle.battle.squad.member"),'
    '"DualFormRuntimeMarker")'
)
BRIDGE_PACKAGE = "pinball.scene.battle.battle.squad.member"
PUBLIC_BRIDGE_QNAME = f'QName(PackageNamespace("{BRIDGE_PACKAGE}"),"DualForm'
INTERNAL_BRIDGE_QNAME = f'QName(PackageInternalNs("{BRIDGE_PACKAGE}"),"DualForm'
CODE_INDENT = "            "
LABEL_INDENT = "   "
CTOR_CODE_INDENT = "         "
SCHEMA_KEYS = {"schema_version", "injection_strategy", "baseline", "methods"}
BASELINE_KEYS = {"main_swf_sha256", "resource_version"}
METHOD_KEYS = {
    "method_name",
    "pcode_path",
    "code_sha256",
    "patches",
    "required_maxstack",
    "required_localcount",
}
LOWER_SHA256 = re.compile(r"^[0-9a-f]{64}$")
LOCKED_RESOURCE_VERSION = "1.4.54"
FORBIDDEN_FINAL_TOKENS = (
    "DualFormPresentationController",
    "DualFormRuntimeMarker",
    "MemberHealthPointIndicatorPeek",
    "findpropstrict QName(PackageInternalNs",
)


class PcodePatchError(RuntimeError):
    pass


def _load_neighbor(name: str) -> ModuleType:
    path = PATCH_ROOT / f"{name}.py"
    spec = importlib.util.spec_from_file_location(f"dual_form_{name}", path)
    if spec is None or spec.loader is None:
        raise PcodePatchError(f"cannot load helper module: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _code(*lines: str) -> str:
    return "\n".join(CODE_INDENT + line for line in lines)


def _label(name: str) -> str:
    return LABEL_INDENT + name + ":"


def _ctor_code(*lines: str) -> str:
    return "\n".join(CTOR_CODE_INDENT + line for line in lines)


def _insert_after(anchor: str, *instructions: str) -> str:
    return anchor + "\n" + _code(*instructions)


def _insert_before(anchor: str, *instructions: str) -> str:
    return _code(*instructions) + "\n" + anchor


class PatchSpec(NamedTuple):
    anchor: str
    expected_count: int
    replace: Callable[[str], str]
    marker: str | None = None


PRELOAD_ANCHOR = _code(
    'getscopeobject 1',
    'getslot 1',
    'findproperty QName(PackageNamespace(""),"getPixelArtAnimationPath")',
    'callproperty QName(PackageNamespace(""),"getPixelArtAnimationPath"), 0',
    'coerce QName(PackageNamespace(""),"String")',
    'callpropvoid QName(Namespace("pinball.asset.logic:IAssetPathCollectionBuilder"),"addAnimationLayout"), 1',
)

PRELOAD_SPECIAL_REJOIN_LABEL = "ofs7fff"
PRELOAD_SPECIAL_REJOIN = _label(PRELOAD_SPECIAL_REJOIN_LABEL)
PRELOAD_SPECIAL_MARKER = (
    'callproperty QName(PackageNamespace(""),'
    '"getSpecialPixelArtAnimationPath"), 0'
)


def _preload_rarity4_special_animation(anchor: str) -> str:
    return "\n".join(
        (
            anchor,
            _code(
                'findproperty QName(PackageNamespace(""),"get_rarity")',
                'callproperty QName(PackageNamespace(""),"get_rarity"), 0',
                "convert_i",
                "pushbyte 4",
                f"iflt {PRELOAD_SPECIAL_REJOIN_LABEL}",
                "getscopeobject 1",
                "getslot 1",
                'findproperty QName(PackageNamespace(""),'
                '"getSpecialPixelArtAnimationPath")',
                PRELOAD_SPECIAL_MARKER,
                'coerce QName(PackageNamespace(""),"String")',
                'callpropvoid QName(Namespace('
                '"pinball.asset.logic:IAssetPathCollectionBuilder"),'
                '"addAnimationLayout"), 1',
            ),
            PRELOAD_SPECIAL_REJOIN,
        )
    )

CAPTURE_ANCHOR = _code(
    'getlocal 15',
    'getproperty QName(PackageNamespace(""),"atks")',
    'coerce QName(PackageNamespace("haxe.ds"),"IntMap")',
    'getproperty QName(PackageNamespace(""),"h")',
    'getlocal 19',
    'getproperty QName(PackageNamespace(""),"index")',
    'getlocal 19',
    'getproperty QName(PackageNamespace(""),"atk")',
    'setproperty MultinameL([PackageNamespace("","1")])',
)

MAIN_CUTIN_ANCHOR = _code(
    'getlocal3',
    'callproperty QName(PackageNamespace(""),"getSkillCutinImagePath"), 0',
    'coerce QName(PackageNamespace(""),"String")',
)

UNISON_CUTIN_ANCHOR = _code(
    'getlocal 13',
    'callproperty QName(PackageNamespace(""),"getSkillCutinImagePath"), 0',
    'coerce QName(PackageNamespace(""),"String")',
)

SKILL_CUTIN_ANIMATION_ANCHOR = _code(
    'getlocal 4',
    'pushstring "skill_ready"',
    'callpropvoid QName(Namespace("pinball.scene.battle.battle.squad.member:Member"),"startSkillCutinAnimation"), 1',
)

SQUAD_RESTORE_ANCHOR = _code(
    'pushbyte 0',
    'convert_i',
    'setlocal2',
    'findproperty QName(PackageNamespace(""),"members")',
)

UPDATE_MEMBER_ANCHOR = _code(
    'findproperty QName(PackageNamespace(""),"conditionSlot")',
    'getproperty QName(PackageNamespace(""),"conditionSlot")',
    'getlocal2',
    'not',
    'callpropvoid QName(PackageNamespace(""),"update"), 1',
)

ATTACH_MEMBER_ANCHOR = _code(
    'initproperty QName(PackageNamespace(""),"conditionSlot")',
    'findproperty QName(PackageNamespace(""),"conditionSlot")',
    'getproperty QName(PackageNamespace(""),"conditionSlot")',
    'getproperty QName(PackageNamespace(""),"hitEffectDispatcher")',
)

RESTORE_MEMBER_ANCHOR = _code(
    'findproperty QName(PackageNamespace(""),"skillPoint")',
    'getproperty QName(PackageNamespace(""),"skillPoint")',
    'getlocal1',
    'findproperty QName(PackageNamespace(""),"index")',
    'getproperty QName(PackageNamespace(""),"index")',
    'callproperty QName(PackageNamespace(""),"getSkillPointRatio"), 1',
    'convert_d',
    'callpropvoid QName(PackageNamespace(""),"setRatio"), 1',
    'returnvoid',
)

POST_SKILL_ANIMATION_ANCHOR = _code(
    'findproperty QName(PackageNamespace(""),"playheadCharacterAnimation")',
    'getproperty QName(PackageNamespace(""),"playheadCharacterAnimation")',
    'pushstring "walk_back"',
    'callpropvoid QName(PackageNamespace(""),"gotoAndPlay"), 1',
)

DISPOSE_MEMBER_ANCHOR = _code(
    'getlocal0',
    'pushscope',
    'findproperty QName(PackageNamespace(""),"playheadCharacterAnimation")',
)

SELECT_VIEW_ANCHOR = _code(
    'pushnull',
    'astype QName(PackageNamespace("pinball.scene.battle.battle.barrier"),"BarrierHpGaugePeek")',
    'setlocal 20',
    'findproperty QName(PackageNamespace(""),"member")',
)

DRAW_CAN_DISPLAY_ANCHOR = _code(
    'findproperty QName(PackageNamespace(""),"member")',
    'getproperty QName(PackageNamespace(""),"member")',
    'callproperty QName(Namespace('
    '"pinball.scene.battle.battle.squad.member:MemberPeek"),"canDisplay"), 0',
    "convert_b",
)
DUAL_FORM_SWAP_HUMAN_LABEL = "ofs7fc0"
DUAL_FORM_SWAP_PATH_READY_LABEL = "ofs7fd0"
DUAL_FORM_SWAP_REJOIN_LABEL = "ofs7fe0"
DUAL_FORM_SWAP_MARKER = 'pushstring "ModDualForm"'


def _swap_mod_dual_form_special_animation(anchor: str) -> str:
    return anchor.replace(
        CODE_INDENT + 'findproperty QName(PackageNamespace(""),"member")',
        _code(
            "pushnull",
            'astype QName(PackageNamespace(""),"String")',
            "setlocal 23",
            "pushnull",
            'astype QName(PackageNamespace("flatomo.animation"),"Animation")',
            "setlocal 24",
            'findproperty QName(PackageNamespace(""),"member")',
            'getproperty QName(PackageNamespace(""),"member")',
            'callproperty QName(Namespace('
            '"pinball.scene.battle.battle.squad.member:MemberPeek"),'
            '"getCharacter"), 0',
            'getproperty QName(PackageNamespace(""),"characterTags")',
            DUAL_FORM_SWAP_MARKER,
            'callproperty QName(Namespace('
            '"http://adobe.com/AS3/2006/builtin"),"indexOf"), 1',
            "convert_i",
            "pushbyte -1",
            f"ifeq {DUAL_FORM_SWAP_REJOIN_LABEL}",
            'findproperty QName(PackageNamespace(""),"member")',
            'getproperty QName(PackageNamespace(""),"member")',
            'getlex QName(PackageNamespace('
            '"pinball.common.data.character.condition"),"ConditionTargetKind")',
            "pushbyte 22",
            'callproperty QName(PackageNamespace(""),"Unique"), 1',
            'coerce QName(PackageNamespace('
            '"pinball.common.data.character.condition"),"ConditionTargetKind")',
            'callproperty QName(PackageNamespace(""),"matchCondition"), 1',
            "convert_b",
            f"iffalse {DUAL_FORM_SWAP_HUMAN_LABEL}",
            'pushstring "character/"',
            'findproperty QName(PackageNamespace(""),"member")',
            'getproperty QName(PackageNamespace(""),"member")',
            'callproperty QName(Namespace('
            '"pinball.scene.battle.battle.squad.member:MemberPeek"),'
            '"getCharacter"), 0',
            'getproperty QName(PackageNamespace(""),"mainCharacterStringId")',
            "add",
            'pushstring "/pixelart/special"',
            "add",
            'coerce QName(PackageNamespace(""),"String")',
            "setlocal 23",
            f"jump {DUAL_FORM_SWAP_PATH_READY_LABEL}",
        )
        + "\n"
        + _label(DUAL_FORM_SWAP_HUMAN_LABEL)
        + "\n"
        + _code(
            'findproperty QName(PackageNamespace(""),"member")',
            'getproperty QName(PackageNamespace(""),"member")',
            'callproperty QName(Namespace('
            '"pinball.scene.battle.battle.squad.member:MemberPeek"),'
            '"getCharacterAnimation"), 0',
            'coerce QName(PackageNamespace(""),"String")',
            "setlocal 23",
        )
        + "\n"
        + _label(DUAL_FORM_SWAP_PATH_READY_LABEL)
        + "\n"
        + _code(
            'findproperty QName(PackageNamespace(""),"character")',
            'getproperty QName(PackageNamespace(""),"character")',
            'callproperty QName(PackageNamespace(""),"get_path"), 0',
            'coerce QName(PackageNamespace(""),"String")',
            "getlocal 23",
            f"ifeq {DUAL_FORM_SWAP_REJOIN_LABEL}",
            'findproperty QName(PackageNamespace(""),"asset")',
            'getproperty QName(PackageNamespace(""),"asset")',
            "getlocal 23",
            'callproperty QName(PackageNamespace(""),"getAnimation"), 1',
            'coerce QName(PackageNamespace("flatomo.animation"),"Animation")',
            "setlocal 24",
            "getlocal 24",
            'getlex QName(PackageNamespace('
            '"pinball.scene.battle.battle"),"BattleConstants")',
            'getproperty QName(PackageNamespace(""),"SCALE_RENDERER")',
            'initproperty QName(PackageNamespace(""),"scaleX")',
            "getlocal 24",
            'getlex QName(PackageNamespace('
            '"pinball.scene.battle.battle"),"BattleConstants")',
            'getproperty QName(PackageNamespace(""),"SCALE_RENDERER")',
            'initproperty QName(PackageNamespace(""),"scaleY")',
            "getlocal 24",
            "pushbyte 21",
            'initproperty QName(PackageNamespace(""),"zIndex2")',
            "getlocal 24",
            'findproperty QName(PackageNamespace(""),"character")',
            'getproperty QName(PackageNamespace(""),"character")',
            'getproperty QName(PackageNamespace(""),"alpha")',
            'initproperty QName(PackageNamespace(""),"alpha")',
            "getlocal 24",
            'findproperty QName(PackageNamespace(""),"character")',
            'getproperty QName(PackageNamespace(""),"character")',
            'getproperty QName(PackageNamespace(""),"visible")',
            'initproperty QName(PackageNamespace(""),"visible")',
            'findproperty QName(PackageNamespace(""),"characterLayer")',
            'getproperty QName(PackageNamespace(""),"characterLayer")',
            'findproperty QName(PackageNamespace(""),"character")',
            'getproperty QName(PackageNamespace(""),"character")',
            "pushtrue",
            'callpropvoid QName(PackageNamespace(""),"removeChild"), 2',
            'findproperty QName(PackageNamespace(""),"character")',
            "getlocal 24",
            'setproperty QName(PackageNamespace(""),"character")',
            'findproperty QName(PackageNamespace(""),"characterLayer")',
            'getproperty QName(PackageNamespace(""),"characterLayer")',
            'findproperty QName(PackageNamespace(""),"character")',
            'getproperty QName(PackageNamespace(""),"character")',
            'callpropvoid QName(PackageNamespace(""),"addChild"), 1',
        )
        + "\n"
        + _label(DUAL_FORM_SWAP_REJOIN_LABEL)
        + "\n"
        + CODE_INDENT
        + 'findproperty QName(PackageNamespace(""),"member")',
        1,
    )

DRAW_EFFECTS_ANCHOR = "\n".join(
    (
        _label("ofs04fb"),
        CODE_INDENT + 'findproperty QName(PackageNamespace(""),"coffin")',
    )
)

DISPOSE_VIEW_ANCHOR = _code(
    'pushnull',
    'astype QName(PackageNamespace("flatomo.animation"),"Animation")',
    'setlocal1',
    'findproperty QName(PackageNamespace(""),"shadowLayer")',
)

RUNTIME_MARKER_ANCHOR = "\n".join(
    (
        "ofs000e:",
        CTOR_CODE_INDENT
        + 'findproperty QName(PackageNamespace(""),"playerHistoryCardClipboardMode")',
    )
)

WET_DAMAGE_SUBTRACTION_ANCHOR = _code(
    "getlocal 108",
    "getlocal 109",
    "subtract",
    "convert_d",
    "setlocal 108",
)
WET_REJOIN_LABEL = "ofs7f10"
WET_REJOIN = _label(WET_REJOIN_LABEL)
WET_MULTIPLIER_MARKER = "pushdouble 1.3"


def _wet_thunder_final_multiplier(anchor: str) -> str:
    return "\n".join(
        (
            anchor,
            _code(
                "getlocal2",
                'getproperty QName(PackageNamespace(""),"element")',
                "convert_i",
                "pushbyte 3",
                f"ifne {WET_REJOIN_LABEL}",
                "getlocal1",
                'getlex QName(PackageNamespace('
                '"pinball.common.data.character.condition"),"ConditionTargetKind")',
                "pushbyte 23",
                'callproperty QName(PackageNamespace(""),"Unique"), 1',
                'coerce QName(PackageNamespace('
                '"pinball.common.data.character.condition"),"ConditionTargetKind")',
                'callproperty QName(Namespace('
                '"pinball.online.battle.impact:ImpactTarget"),"matchCondition"), 1',
                "convert_b",
                f"iffalse {WET_REJOIN_LABEL}",
                "getlocal 108",
                WET_MULTIPLIER_MARKER,
                "multiply",
                "convert_d",
                "setlocal 108",
            ),
            WET_REJOIN,
        )
    )


SERIS_DEBUFF_EXTENSION_ADD_ANCHOR = _code(
    "getlocal2",
    "getlocal 11",
    'getproperty QName(PackageNamespace(""),"value")',
    "add",
    "convert_d",
    "convert_d",
    "setlocal2",
)
SERIS_DEBUFF_NATIVE_ADD_LABEL = "ofs7f20"
SERIS_DEBUFF_REJOIN_LABEL = "ofs01dc"
SERIS_DEBUFF_SENTINEL_MARKER = "pushdouble 0.625"


def _seris_manifestation_debuff_extension(anchor: str) -> str:
    return "\n".join(
        (
            _code(
                "getlocal 11",
                'getproperty QName(PackageNamespace(""),"value")',
                SERIS_DEBUFF_SENTINEL_MARKER,
                f"ifne {SERIS_DEBUFF_NATIVE_ADD_LABEL}",
                "getlocal 7",
                'getlex QName(PackageNamespace('
                '"pinball.common.data.character.condition"),"ConditionTargetKind")',
                "pushbyte 22",
                'callproperty QName(PackageNamespace(""),"Unique"), 1',
                'coerce QName(PackageNamespace('
                '"pinball.common.data.character.condition"),"ConditionTargetKind")',
                'callproperty QName(PackageNamespace(""),"matchCondition"), 1',
                "convert_b",
                f"iffalse {SERIS_DEBUFF_REJOIN_LABEL}",
                "getlocal2",
                "pushdouble 0.5",
                "add",
                "convert_d",
                "convert_d",
                "setlocal2",
                f"jump {SERIS_DEBUFF_REJOIN_LABEL}",
            ),
            _label(SERIS_DEBUFF_NATIVE_ADD_LABEL),
            anchor,
        )
    )


SERIS_NATURAL_EXIT_ANCHOR = _code(
    'findproperty QName(PackageNamespace(""),"removeCondition")',
    "getlocal 5",
    'callpropvoid QName(PackageNamespace(""),"removeCondition"), 1',
)
SERIS_NATURAL_EXIT_MEMBER_LABELS = ("ofs7f41", "ofs7f42", "ofs7f43")
SERIS_NATURAL_EXIT_REJOIN_LABEL = SERIS_NATURAL_EXIT_MEMBER_LABELS[2]
SERIS_EXIT_ABILITY6_MARKER = "pushshort 6000"


def _seris_award_member_from_squad(
    squad_local: int,
    option_local: int,
    member_local: int,
    member_index: int,
    skip_label: str,
) -> str:
    return "\n".join(
        (
            _code(
                f"getlocal {squad_local}",
                f"pushbyte {member_index}",
                'callproperty QName(Namespace('
                '"pinball.scene.battle.battle.squad:Squad"),"getMember"), 1',
                'coerce QName(PackageNamespace("haxe.ds"),"Option")',
                f"setlocal {option_local}",
                f"getlocal {option_local}",
                'getproperty QName(PackageNamespace(""),"index")',
                "pushbyte 0",
                f"ifne {skip_label}",
                f"getlocal {option_local}",
                'getproperty QName(PackageNamespace(""),"params")',
                "pushbyte 0",
                'getproperty MultinameL([PackageNamespace("","1")])',
                'coerce QName(PackageNamespace('
                '"pinball.scene.battle.battle.squad.member"),"MemberImpl")',
                f"setlocal {member_local}",
                f"getlocal {member_local}",
                "pushdouble 0.3",
                'callpropvoid QName(PackageNamespace(""),"addSkillPoint"), 1',
            ),
            _label(skip_label),
        )
    )


def _seris_unique22_natural_exit_team_gauge(anchor: str) -> str:
    return "\n".join(
        (
            anchor,
            _code(
                "getlocal 20",
                'getproperty QName(PackageNamespace(""),"content")',
                'getproperty QName(PackageNamespace(""),"index")',
                "pushbyte 31",
                f"ifne {SERIS_NATURAL_EXIT_REJOIN_LABEL}",
                "getlocal 20",
                'getproperty QName(PackageNamespace(""),"content")',
                'getproperty QName(PackageNamespace(""),"params")',
                "pushbyte 0",
                'getproperty MultinameL([PackageNamespace("","1")])',
                "convert_i",
                "pushbyte 22",
                f"ifne {SERIS_NATURAL_EXIT_REJOIN_LABEL}",
                'findproperty QName(PackageNamespace(""),"ownerMember")',
                'getproperty QName(PackageNamespace(""),"ownerMember")',
                'astype QName(PackageNamespace('
                '"pinball.scene.battle.battle.squad.member"),"MemberImpl")',
                "setlocal 42",
                "getlocal 42",
                "pushnull",
                'coerce QName(PackageNamespace('
                '"pinball.scene.battle.battle.squad.member"),"MemberImpl")',
                f"ifeq {SERIS_NATURAL_EXIT_REJOIN_LABEL}",
                "getlocal 42",
                'getproperty QName(PackageNamespace(""),"abilitySlot")',
                'getproperty QName(PackageNamespace(""),"stats")',
                SERIS_EXIT_ABILITY6_MARKER,
                'callproperty QName(Namespace("haxe:IMap"),"exists"), 1',
                "convert_b",
                f"iffalse {SERIS_NATURAL_EXIT_REJOIN_LABEL}",
                'findproperty QName(PackageNamespace(""),"squad")',
                'getproperty QName(PackageNamespace(""),"squad")',
                'coerce QName(PackageNamespace("haxe.ds"),"Option")',
                "setlocal 38",
                "getlocal 38",
                'getproperty QName(PackageNamespace(""),"index")',
                "pushbyte 0",
                f"ifne {SERIS_NATURAL_EXIT_REJOIN_LABEL}",
                "getlocal 38",
                'getproperty QName(PackageNamespace(""),"params")',
                "pushbyte 0",
                'getproperty MultinameL([PackageNamespace("","1")])',
                'coerce QName(PackageNamespace('
                '"pinball.scene.battle.battle.squad"),"Squad")',
                "setlocal 39",
            ),
            _seris_award_member_from_squad(
                39, 40, 41, 0, SERIS_NATURAL_EXIT_MEMBER_LABELS[0]
            ),
            _seris_award_member_from_squad(
                39, 40, 41, 1, SERIS_NATURAL_EXIT_MEMBER_LABELS[1]
            ),
            _seris_award_member_from_squad(
                39, 40, 41, 2, SERIS_NATURAL_EXIT_MEMBER_LABELS[2]
            ),
        )
    )


SERIS_DEATH_EXIT_PURGE_ANCHOR = _code(
    'findproperty QName(PackageNamespace(""),"conditionSlot")',
    'getproperty QName(PackageNamespace(""),"conditionSlot")',
    'findproperty QName(PackageNamespace(""),"coffinNotRemoveConditionUnique")',
    'getproperty QName(PackageNamespace(""),"coffinNotRemoveConditionUnique")',
    'callpropvoid QName(PackageNamespace(""),"purge"), 1',
)
SERIS_DEATH_EXIT_MEMBER_LABELS = ("ofs7f51", "ofs7f52", "ofs7f53")
SERIS_DEATH_EXIT_REJOIN_LABEL = SERIS_DEATH_EXIT_MEMBER_LABELS[2]


def _seris_unique22_death_exit_team_gauge(anchor: str) -> str:
    return "\n".join(
        (
            _code(
                'findproperty QName(PackageNamespace(""),"conditionSlot")',
                'getproperty QName(PackageNamespace(""),"conditionSlot")',
                'getlex QName(PackageNamespace('
                '"pinball.common.data.character.condition"),"ConditionTargetKind")',
                "pushbyte 22",
                'callproperty QName(PackageNamespace(""),"Unique"), 1',
                'coerce QName(PackageNamespace('
                '"pinball.common.data.character.condition"),"ConditionTargetKind")',
                'callproperty QName(PackageNamespace(""),"matchConditions"), 1',
                "convert_b",
                f"iffalse {SERIS_DEATH_EXIT_REJOIN_LABEL}",
                'findproperty QName(PackageNamespace(""),"abilitySlot")',
                'getproperty QName(PackageNamespace(""),"abilitySlot")',
                'getproperty QName(PackageNamespace(""),"stats")',
                SERIS_EXIT_ABILITY6_MARKER,
                'callproperty QName(Namespace("haxe:IMap"),"exists"), 1',
                "convert_b",
                f"iffalse {SERIS_DEATH_EXIT_REJOIN_LABEL}",
                'findproperty QName(PackageNamespace(""),"squad")',
                'getproperty QName(PackageNamespace(""),"squad")',
                'coerce QName(PackageNamespace('
                '"pinball.scene.battle.battle.squad"),"Squad")',
                "setlocal3",
            ),
            _seris_award_member_from_squad(
                3, 2, 4, 0, SERIS_DEATH_EXIT_MEMBER_LABELS[0]
            ),
            _seris_award_member_from_squad(
                3, 2, 4, 1, SERIS_DEATH_EXIT_MEMBER_LABELS[1]
            ),
            _seris_award_member_from_squad(
                3, 2, 4, 2, SERIS_DEATH_EXIT_MEMBER_LABELS[2]
            ),
            anchor,
        )
    )


PATCH_SPECS: dict[str, PatchSpec] = {
    "seris_unique22_natural_exit_team_gauge": PatchSpec(
        SERIS_NATURAL_EXIT_ANCHOR,
        1,
        _seris_unique22_natural_exit_team_gauge,
        SERIS_EXIT_ABILITY6_MARKER,
    ),
    "seris_unique22_death_exit_team_gauge": PatchSpec(
        SERIS_DEATH_EXIT_PURGE_ANCHOR,
        1,
        _seris_unique22_death_exit_team_gauge,
        SERIS_EXIT_ABILITY6_MARKER,
    ),
    "seris_manifestation_debuff_extension": PatchSpec(
        SERIS_DEBUFF_EXTENSION_ADD_ANCHOR,
        1,
        _seris_manifestation_debuff_extension,
        SERIS_DEBUFF_SENTINEL_MARKER,
    ),
    "wet_thunder_final_multiplier": PatchSpec(
        WET_DAMAGE_SUBTRACTION_ANCHOR,
        1,
        _wet_thunder_final_multiplier,
        WET_MULTIPLIER_MARKER,
    ),
    "preload_rarity4_special_animation": PatchSpec(
        PRELOAD_ANCHOR,
        1,
        _preload_rarity4_special_animation,
        PRELOAD_SPECIAL_MARKER,
    ),
    "preload_battle_logic": PatchSpec(
        PRELOAD_ANCHOR,
        1,
        lambda anchor: _insert_after(
            anchor,
            f"getlex {HELPER_CLASS}",
            "getlocal0",
            "getlocal1",
            "getlocal2",
            "getlocal3",
            'callpropvoid QName(PackageNamespace(""),"preloadBattleLogic"), 4',
        ),
    ),
    "capture_continuation_data": PatchSpec(
        CAPTURE_ANCHOR,
        1,
        lambda anchor: _insert_after(
            anchor,
            f"getlex {HELPER_CLASS}",
            "getlocal 15",
            "getlocal 19",
            'callpropvoid QName(PackageNamespace(""),"captureContinuationData"), 2',
        ),
    ),
    "select_main_cutin": PatchSpec(
        MAIN_CUTIN_ANCHOR,
        3,
        lambda _anchor: _code(
            f"getlex {HELPER_CLASS}",
            "getlocal3",
            "getlocal 6",
            'callproperty QName(PackageNamespace(""),"selectMainCutin"), 2',
            'coerce QName(PackageNamespace(""),"String")',
        ),
    ),
    "select_unison_cutin": PatchSpec(
        UNISON_CUTIN_ANCHOR,
        1,
        lambda _anchor: _code(
            f"getlex {HELPER_CLASS}",
            "getlocal 13",
            "getlocal 4",
            'callproperty QName(PackageNamespace(""),"selectUnisonCutin"), 2',
            'coerce QName(PackageNamespace(""),"String")',
        ),
    ),
    "select_skill_cutin_animation": PatchSpec(
        SKILL_CUTIN_ANIMATION_ANCHOR,
        1,
        lambda _anchor: _code(
            "getlocal 4",
            f"getlex {HELPER_CLASS}",
            "getlocal 4",
            "getlocal 6",
            'pushstring "skill_ready"',
            'callproperty QName(PackageNamespace(""),"skillCutinAnimationName"), 3',
            'coerce QName(PackageNamespace(""),"String")',
            'callpropvoid QName(Namespace("pinball.scene.battle.battle.squad.member:Member"),"startSkillCutinAnimation"), 1',
        ),
    ),
    "restore_squad_continuation": PatchSpec(
        SQUAD_RESTORE_ANCHOR,
        1,
        lambda anchor: anchor.replace(
            CODE_INDENT + 'findproperty QName(PackageNamespace(""),"members")',
            _code(
                f"getlex {HELPER_CLASS}",
                "getlocal0",
                "getlocal1",
                'callpropvoid QName(PackageNamespace(""),"restoreSquadContinuation"), 2',
                'findproperty QName(PackageNamespace(""),"members")',
            ),
        ),
    ),
    "update_member": PatchSpec(
        UPDATE_MEMBER_ANCHOR,
        1,
        lambda anchor: _insert_after(
            anchor,
            f"getlex {HELPER_CLASS}",
            "getlocal0",
            'callpropvoid QName(PackageNamespace(""),"updateMember"), 1',
        ),
    ),
    "probe_member_stack_noop": PatchSpec(
        ATTACH_MEMBER_ANCHOR,
        1,
        lambda anchor: anchor.replace(
            CODE_INDENT + 'findproperty QName(PackageNamespace(""),"conditionSlot")',
            _code(
                "pushtrue",
                "pop",
                'findproperty QName(PackageNamespace(""),"conditionSlot")',
            ),
            1,
        ),
    ),
    "probe_member_getlex_marker": PatchSpec(
        ATTACH_MEMBER_ANCHOR,
        1,
        lambda anchor: anchor.replace(
            CODE_INDENT + 'findproperty QName(PackageNamespace(""),"conditionSlot")',
            _code(
                f"getlex {RUNTIME_MARKER_CLASS}",
                "pop",
                'findproperty QName(PackageNamespace(""),"conditionSlot")',
            ),
            1,
        ),
    ),
    "probe_member_existing_unique_condition": PatchSpec(
        ATTACH_MEMBER_ANCHOR,
        1,
        lambda anchor: anchor.replace(
            CODE_INDENT + 'findproperty QName(PackageNamespace(""),"conditionSlot")',
            _code(
                'findproperty QName(PackageNamespace(""),"matchCondition")',
                'getlex QName(PackageNamespace('
                '"pinball.common.data.character.condition"),"ConditionTargetKind")',
                "pushbyte 22",
                'callproperty QName(PackageNamespace(""),"Unique"), 1',
                'coerce QName(PackageNamespace('
                '"pinball.common.data.character.condition"),"ConditionTargetKind")',
                'callproperty QName(PackageNamespace(""),"matchCondition"), 1',
                "convert_b",
                "pop",
                'findproperty QName(PackageNamespace(""),"conditionSlot")',
            ),
            1,
        ),
    ),
    "emit_runtime_marker_in_member": PatchSpec(
        ATTACH_MEMBER_ANCHOR,
        1,
        lambda anchor: anchor.replace(
            CODE_INDENT + 'findproperty QName(PackageNamespace(""),"conditionSlot")',
            _code(
                f"getlex {RUNTIME_MARKER_CLASS}",
                'callpropvoid QName(PackageNamespace(""),"emit"), 0',
                'findproperty QName(PackageNamespace(""),"conditionSlot")',
            ),
            1,
        ),
    ),
    "attach_member": PatchSpec(
        ATTACH_MEMBER_ANCHOR,
        1,
        lambda anchor: anchor.replace(
            CODE_INDENT + 'findproperty QName(PackageNamespace(""),"conditionSlot")',
            _code(
                f"getlex {RUNTIME_MARKER_CLASS}",
                'callpropvoid QName(PackageNamespace(""),"emit"), 0',
                f"getlex {HELPER_CLASS}",
                "getlocal0",
                "getlocal1",
                'callpropvoid QName(PackageNamespace(""),"attach"), 2',
                'findproperty QName(PackageNamespace(""),"conditionSlot")',
            ),
            1,
        ),
    ),
    "restore_member_continuation": PatchSpec(
        RESTORE_MEMBER_ANCHOR,
        1,
        lambda anchor: anchor.replace(
            CODE_INDENT + "returnvoid",
            _code(
                f"getlex {HELPER_CLASS}",
                "getlocal0",
                "getlocal1",
                'callpropvoid QName(PackageNamespace(""),"restoreMemberContinuation"), 2',
                "returnvoid",
            ),
        ),
    ),
    "select_post_skill_animation": PatchSpec(
        POST_SKILL_ANIMATION_ANCHOR,
        1,
        lambda _anchor: _code(
            'findproperty QName(PackageNamespace(""),"playheadCharacterAnimation")',
            'getproperty QName(PackageNamespace(""),"playheadCharacterAnimation")',
            f"getlex {HELPER_CLASS}",
            "getlocal0",
            'pushstring "walk_back"',
            'callproperty QName(PackageNamespace(""),"postSkillAnimationName"), 2',
            'coerce QName(PackageNamespace(""),"String")',
            'callpropvoid QName(PackageNamespace(""),"gotoAndPlay"), 1',
        ),
    ),
    "dispose_member": PatchSpec(
        DISPOSE_MEMBER_ANCHOR,
        1,
        lambda anchor: anchor.replace(
            CODE_INDENT + 'findproperty QName(PackageNamespace(""),"playheadCharacterAnimation")',
            _code(
                f"getlex {HELPER_CLASS}",
                "getlocal0",
                'callpropvoid QName(PackageNamespace(""),"disposeMember"), 1',
                'findproperty QName(PackageNamespace(""),"playheadCharacterAnimation")',
            ),
            1,
        ),
    ),
    "select_view_character": PatchSpec(
        SELECT_VIEW_ANCHOR,
        1,
        lambda anchor: anchor.replace(
            CODE_INDENT + 'findproperty QName(PackageNamespace(""),"member")',
            _code(
                "getlocal0",
                f"getlex {VIEW_HELPER_CLASS}",
                "getlocal0",
                'callproperty QName(PackageNamespace(""),"selectViewCharacter"), 1',
                'coerce QName(PackageNamespace("flatomo.animation"),"Animation")',
                'setproperty QName(PackageNamespace(""),"character")',
                'findproperty QName(PackageNamespace(""),"member")',
            ),
            1,
        ),
    ),
    "swap_mod_dual_form_special_animation": PatchSpec(
        SELECT_VIEW_ANCHOR,
        1,
        _swap_mod_dual_form_special_animation,
        DUAL_FORM_SWAP_MARKER,
    ),
    "draw_view_effects": PatchSpec(
        DRAW_EFFECTS_ANCHOR,
        1,
        lambda anchor: anchor.replace(
            CODE_INDENT + 'findproperty QName(PackageNamespace(""),"coffin")',
            _code(
                f"getlex {VIEW_HELPER_CLASS}",
                "getlocal0",
                "getlocal 13",
                "getlocal 14",
                "getlocal 15",
                'callpropvoid QName(PackageNamespace(""),"drawViewEffects"), 4',
                'findproperty QName(PackageNamespace(""),"coffin")',
            ),
            1,
        ),
    ),
    "dispose_view": PatchSpec(
        DISPOSE_VIEW_ANCHOR,
        1,
        lambda anchor: anchor.replace(
            CODE_INDENT + 'findproperty QName(PackageNamespace(""),"shadowLayer")',
            _code(
                f"getlex {VIEW_HELPER_CLASS}",
                "getlocal0",
                'callpropvoid QName(PackageNamespace(""),"disposeView"), 1',
                'findproperty QName(PackageNamespace(""),"shadowLayer")',
            ),
            1,
        ),
    ),
    "emit_runtime_marker": PatchSpec(
        RUNTIME_MARKER_ANCHOR,
        1,
        lambda anchor: anchor.replace(
            CTOR_CODE_INDENT
            + 'findproperty QName(PackageNamespace(""),"playerHistoryCardClipboardMode")',
            _ctor_code(
                f"getlex {RUNTIME_MARKER_CLASS}",
                'callpropvoid QName(PackageNamespace(""),"emit"), 0',
                'findproperty QName(PackageNamespace(""),"playerHistoryCardClipboardMode")',
            ),
            1,
        ),
    ),
}


PATCH_CALLS: dict[str, tuple[str, int] | None] = {
    "seris_manifestation_debuff_extension": None,
    "wet_thunder_final_multiplier": None,
    "preload_rarity4_special_animation": None,
    "preload_battle_logic": ("preloadBattleLogic", 1),
    "capture_continuation_data": ("captureContinuationData", 1),
    "select_main_cutin": ("selectMainCutin", 3),
    "select_unison_cutin": ("selectUnisonCutin", 1),
    "select_skill_cutin_animation": ("skillCutinAnimationName", 1),
    "restore_squad_continuation": ("restoreSquadContinuation", 1),
    "update_member": ("updateMember", 1),
    "probe_member_stack_noop": None,
    "probe_member_getlex_marker": ("DualFormRuntimeMarker", 1),
    "probe_member_existing_unique_condition": None,
    "emit_runtime_marker_in_member": ("emit", 1),
    "attach_member": ("attach", 1),
    "restore_member_continuation": ("restoreMemberContinuation", 1),
    "select_post_skill_animation": ("postSkillAnimationName", 1),
    "dispose_member": ("disposeMember", 1),
    "select_view_character": ("selectViewCharacter", 1),
    "swap_mod_dual_form_special_animation": None,
    "draw_view_effects": ("drawViewEffects", 1),
    "dispose_view": ("disposeView", 1),
    "emit_runtime_marker": ("emit", 1),
}


def anchor_for(patch_id: str) -> str:
    try:
        return PATCH_SPECS[patch_id].anchor
    except KeyError as exc:
        raise PcodePatchError(f"unknown P-code patch id: {patch_id}") from exc


def _require_exact_keys(value: Any, expected: set[str], context: str) -> None:
    if not isinstance(value, dict):
        raise PcodePatchError(f"{context} must be an object")
    actual = set(value)
    if actual != expected:
        missing = sorted(expected - actual)
        unexpected = sorted(actual - expected)
        raise PcodePatchError(
            f"{context} keys mismatch: missing={missing}, unexpected={unexpected}"
        )


def _require_lower_sha256(value: Any, context: str) -> None:
    if not isinstance(value, str) or LOWER_SHA256.fullmatch(value) is None:
        raise PcodePatchError(f"{context} must be 64 lowercase hexadecimal characters")


def _require_nonnegative_int(value: Any, context: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise PcodePatchError(f"{context} must be a non-negative integer")


def _method_parts(method_name: str) -> tuple[str, str]:
    if not isinstance(method_name, str) or method_name.count("/") != 1:
        raise PcodePatchError(f"invalid ABC method name: {method_name!r}")
    owner, trait_name = method_name.rsplit("/", 1)
    if owner.count(":") != 1 or not trait_name:
        raise PcodePatchError(f"invalid ABC method name: {method_name!r}")
    package_name, class_leaf = owner.rsplit(":", 1)
    if not package_name or not class_leaf:
        raise PcodePatchError(f"invalid ABC method name: {method_name!r}")
    return f"{package_name}.{class_leaf}", trait_name


def class_name_for_method(method_name: str) -> str:
    return _method_parts(method_name)[0]


def trait_name_for_method(method_name: str) -> str:
    return _method_parts(method_name)[1]


def load_manifest(path: Path = DEFAULT_MANIFEST) -> dict[str, Any]:
    try:
        manifest = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PcodePatchError(f"cannot read patch manifest {path}: {exc}") from exc
    _require_exact_keys(manifest, SCHEMA_KEYS, "manifest")
    if manifest["schema_version"] != 3:
        raise PcodePatchError("dual-form pure-P-code manifest schema must be 3")
    if manifest["injection_strategy"] != "pure_pcode_existing_classes":
        raise PcodePatchError(
            "unsupported injection strategy: "
            f"{manifest['injection_strategy']!r}"
        )

    baseline = manifest["baseline"]
    _require_exact_keys(baseline, BASELINE_KEYS, "manifest baseline")
    _require_lower_sha256(
        baseline["main_swf_sha256"], "manifest baseline main_swf_sha256"
    )
    if baseline["resource_version"] != LOCKED_RESOURCE_VERSION:
        raise PcodePatchError(
            "manifest baseline resource_version must be "
            f"{LOCKED_RESOURCE_VERSION!r}"
        )

    methods = manifest["methods"]
    if not isinstance(methods, list) or not methods:
        raise PcodePatchError("manifest methods must be a non-empty list")
    seen_names: set[str] = set()
    for sequence, entry in enumerate(methods):
        context = f"manifest method {sequence}"
        _require_exact_keys(entry, METHOD_KEYS, context)
        method_name = entry["method_name"]
        class_name_for_method(method_name)
        if method_name in seen_names:
            raise PcodePatchError(f"duplicate manifest method: {method_name}")
        seen_names.add(method_name)

        pcode_path = entry["pcode_path"]
        if not isinstance(pcode_path, str) or not pcode_path:
            raise PcodePatchError(f"{context} pcode_path must be non-empty")
        pure_path = PurePosixPath(pcode_path)
        if (
            pure_path.is_absolute()
            or ".." in pure_path.parts
            or pure_path.suffix != ".pcode"
        ):
            raise PcodePatchError(f"{context} pcode_path is unsafe: {pcode_path!r}")
        _require_lower_sha256(entry["code_sha256"], f"{context} code_sha256")

        patches = entry["patches"]
        if not isinstance(patches, list) or any(
            not isinstance(patch_id, str) or not patch_id for patch_id in patches
        ):
            raise PcodePatchError(f"{context} patches must be a list of names")
        if len(patches) != len(set(patches)):
            raise PcodePatchError(f"{context} patches must not contain duplicates")
        _require_nonnegative_int(
            entry["required_maxstack"], f"{context} required_maxstack"
        )
        _require_nonnegative_int(
            entry["required_localcount"], f"{context} required_localcount"
        )
    return manifest


def read_baseline_method(pcode_root: Path, entry: dict[str, Any]) -> str:
    tools = _load_neighbor("pcode_tools")
    source = Path(pcode_root) / Path(entry["pcode_path"])
    try:
        text = source.read_text(encoding="utf-8")
    except OSError as exc:
        raise PcodePatchError(f"cannot read P-code baseline {source}: {exc}") from exc
    try:
        block = tools.extract_method_block(
            text,
            trait_kind="method",
            trait_name=trait_name_for_method(entry["method_name"]),
        )
    except tools.PcodePatchError as exc:
        raise PcodePatchError(str(exc)) from exc
    return textwrap.dedent(block)


def _set_required_maxstack(text: str, required: int) -> str:
    pattern = re.compile(
        r"^(?P<indent>[ \t]*)maxstack (?P<value>\d+)[ \t]*$", re.MULTILINE
    )
    matches = list(pattern.finditer(text))
    if len(matches) != 1:
        raise PcodePatchError(f"expected one maxstack declaration, found {len(matches)}")
    current = int(matches[0].group("value"))
    if current >= required:
        return text
    replacement = f"{matches[0].group('indent')}maxstack {required}"
    return text[: matches[0].start()] + replacement + text[matches[0].end() :]


def _set_required_localcount(text: str, required: int) -> str:
    pattern = re.compile(
        r"^(?P<indent>[ \t]*)localcount (?P<value>\d+)[ \t]*$", re.MULTILINE
    )
    matches = list(pattern.finditer(text))
    if len(matches) != 1:
        raise PcodePatchError(
            f"expected one localcount declaration, found {len(matches)}"
        )
    current = int(matches[0].group("value"))
    if current >= required:
        return text
    replacement = f"{matches[0].group('indent')}localcount {required}"
    return text[: matches[0].start()] + replacement + text[matches[0].end() :]


def _verify_dual_form_swap_structural_contract(
    baseline: str,
    final: str,
) -> None:
    context = "dual-form swap structural contract"
    expected_replacement = _swap_mod_dual_form_special_animation(SELECT_VIEW_ANCHOR)
    if final.count(expected_replacement) != 1:
        raise PcodePatchError(f"{context}: injected instruction block differs")

    try:
        baseline_suffix_start = baseline.index(
            DRAW_CAN_DISPLAY_ANCHOR,
            baseline.index(SELECT_VIEW_ANCHOR),
        )
        final_rejoin_start = final.index(f"   {DUAL_FORM_SWAP_REJOIN_LABEL}:")
        final_suffix_start = final.index(
            DRAW_CAN_DISPLAY_ANCHOR,
            final_rejoin_start,
        )
        injection_start = final.index(SELECT_VIEW_ANCHOR.rsplit("\n", 1)[0])
    except ValueError as exc:
        raise PcodePatchError(f"{context}: required boundary is missing") from exc
    if baseline[baseline_suffix_start:] != final[final_suffix_start:]:
        raise PcodePatchError(f"{context}: original draw suffix changed")
    injected = final[injection_start:final_suffix_start]

    expected_counts = {
        DUAL_FORM_SWAP_MARKER: 1,
        'callproperty QName(Namespace('
        '"http://adobe.com/AS3/2006/builtin"),"indexOf"), 1': 1,
        "pushbyte 22": 1,
        'callproperty QName(PackageNamespace(""),"Unique"), 1': 1,
        'callproperty QName(PackageNamespace(""),"matchCondition"), 1': 1,
        'pushstring "character/"': 1,
        'pushstring "/pixelart/special"': 1,
        'callproperty QName(PackageNamespace(""),"get_path"), 0': 1,
        'callproperty QName(PackageNamespace(""),"getAnimation"), 1': 1,
        'callpropvoid QName(PackageNamespace(""),"removeChild"), 2': 1,
        "pushtrue": 1,
        'setproperty QName(PackageNamespace(""),"character")': 1,
        'callpropvoid QName(PackageNamespace(""),"addChild"), 1': 1,
    }
    for token, expected_count in expected_counts.items():
        actual_count = injected.count(token)
        if actual_count != expected_count:
            raise PcodePatchError(
                f"{context}: token {token!r} count {actual_count}; "
                f"expected {expected_count}"
            )

    for label, expected_references in (
        (DUAL_FORM_SWAP_HUMAN_LABEL, 1),
        (DUAL_FORM_SWAP_PATH_READY_LABEL, 1),
        (DUAL_FORM_SWAP_REJOIN_LABEL, 2),
    ):
        if injected.count(f"{label}:") != 1:
            raise PcodePatchError(f"{context}: label {label} is not uniquely defined")
        if injected.count(label) != expected_references + 1:
            raise PcodePatchError(
                f"{context}: label {label} reference count changed"
            )

    for forbidden in (
        "129999",
        "seris_dragon_king",
        "DualFormPresentationController",
        "DualFormRuntimeMarker",
        "MemberHealthPointIndicatorPeek",
        "getTimer",
        "addCondition",
        "removeCondition",
        "invokeSkill",
        "startSkill",
        "gotoAndPlay",
    ):
        if forbidden in injected:
            raise PcodePatchError(f"{context}: forbidden token {forbidden}")

    declarations: dict[str, int] = {}
    for field in ("maxstack", "localcount"):
        matches = re.findall(
            rf"^[ \t]*{field} ([0-9]+)[ \t]*$", final, re.MULTILINE
        )
        if len(matches) != 1:
            raise PcodePatchError(
                f"{context}: expected one {field} declaration; found {len(matches)}"
            )
        declarations[field] = int(matches[0])
    if declarations["maxstack"] < 4 or declarations["localcount"] != 25:
        raise PcodePatchError(
            f"{context}: expected maxstack >= 4 and localcount == 25"
        )

    try:
        _canonicalize_offset_labels(final)
    except PcodePatchError as exc:
        raise PcodePatchError(f"{context}: {exc}") from exc


def _verify_wet_thunder_structural_contract(baseline: str, final: str) -> None:
    context = "Wet thunder final multiplier structural contract"
    expected = _wet_thunder_final_multiplier(WET_DAMAGE_SUBTRACTION_ANCHOR)
    if final.count(expected) != 1:
        raise PcodePatchError(f"{context}: injected instruction block differs")
    if baseline.count(WET_DAMAGE_SUBTRACTION_ANCHOR) != 1:
        raise PcodePatchError(f"{context}: baseline subtraction anchor is not unique")
    if final.count(WET_MULTIPLIER_MARKER) != 1:
        raise PcodePatchError(f"{context}: final multiplier is not unique")
    if final.count(f"{WET_REJOIN_LABEL}:") != 1 or final.count(WET_REJOIN_LABEL) != 3:
        raise PcodePatchError(f"{context}: rejoin branch topology changed")
    injection_start = final.index(WET_DAMAGE_SUBTRACTION_ANCHOR)
    injection_end = final.index(WET_REJOIN) + len(WET_REJOIN)
    injected = final[injection_start:injection_end]
    required = (
        'getproperty QName(PackageNamespace(""),"element")',
        "pushbyte 3",
        "pushbyte 23",
        'callproperty QName(PackageNamespace(""),"Unique"), 1',
        'callproperty QName(Namespace('
        '"pinball.online.battle.impact:ImpactTarget"),"matchCondition"), 1',
        WET_MULTIPLIER_MARKER,
        "multiply",
    )
    for token in required:
        if injected.count(token) != 1:
            raise PcodePatchError(f"{context}: token {token!r} is not unique")
    floor = 'callproperty QName(PackageNamespace(""),"floor"), 1'
    if final.find(floor, injection_end) < 0:
        raise PcodePatchError(f"{context}: native FloatInt floor no longer follows hook")
    for forbidden in ("seris_dragon_king", "129999"):
        if forbidden in injected:
            raise PcodePatchError(f"{context}: forbidden identity token {forbidden}")


def _verify_seris_debuff_extension_structural_contract(
    baseline: str, final: str
) -> None:
    context = "Seris manifestation debuff extension structural contract"
    expected = _seris_manifestation_debuff_extension(
        SERIS_DEBUFF_EXTENSION_ADD_ANCHOR
    )
    if final.count(expected) != 1:
        raise PcodePatchError(f"{context}: injected instruction block differs")
    if baseline.count(SERIS_DEBUFF_EXTENSION_ADD_ANCHOR) != 1:
        raise PcodePatchError(f"{context}: baseline addition anchor is not unique")
    for token, count in (
        (SERIS_DEBUFF_SENTINEL_MARKER, 1),
        ("pushdouble 0.5", 1),
        ("pushbyte 22", 1),
        (f"{SERIS_DEBUFF_NATIVE_ADD_LABEL}:", 1),
        (f"{SERIS_DEBUFF_REJOIN_LABEL}:", 1),
    ):
        if final.count(token) != count:
            raise PcodePatchError(
                f"{context}: token {token!r} count is not {count}"
            )
    injected_start = final.index(SERIS_DEBUFF_SENTINEL_MARKER)
    injected_end = final.index(f"{SERIS_DEBUFF_REJOIN_LABEL}:")
    injected = final[injected_start:injected_end]
    required = (
        'getproperty QName(PackageNamespace(""),"value")',
        'callproperty QName(PackageNamespace(""),"Unique"), 1',
        'callproperty QName(PackageNamespace(""),"matchCondition"), 1',
        "pushdouble 0.5",
    )
    for token in required:
        if injected.count(token) != 1:
            raise PcodePatchError(f"{context}: token {token!r} is not unique")
    for forbidden in ("seris_dragon_king", "1299994"):
        if forbidden in injected:
            raise PcodePatchError(f"{context}: forbidden identity token {forbidden}")


def _verify_seris_natural_exit_structural_contract(
    baseline: str, final: str
) -> None:
    context = "Seris natural manifestation exit gauge structural contract"
    expected = _seris_unique22_natural_exit_team_gauge(
        SERIS_NATURAL_EXIT_ANCHOR
    )
    if final.count(expected) != 1:
        raise PcodePatchError(f"{context}: injected instruction block differs")
    if baseline.count(SERIS_NATURAL_EXIT_ANCHOR) != 1:
        raise PcodePatchError(f"{context}: baseline removal anchor is not unique")
    start = final.index(SERIS_NATURAL_EXIT_ANCHOR)
    end = final.index(f"{SERIS_NATURAL_EXIT_REJOIN_LABEL}:", start)
    injected = final[start:end]
    for token, count in (
        ("pushbyte 31", 1),
        ("pushbyte 22", 1),
        (SERIS_EXIT_ABILITY6_MARKER, 1),
        ('callproperty QName(Namespace("haxe:IMap"),"exists"), 1', 1),
        ('"getMember"', 3),
        ("pushdouble 0.3", 3),
        ('"addSkillPoint"', 3),
    ):
        if injected.count(token) != count:
            raise PcodePatchError(
                f"{context}: token {token!r} count {injected.count(token)}; "
                f"expected {count}"
            )
    labels = SERIS_NATURAL_EXIT_MEMBER_LABELS
    for label in labels:
        if final.count(f"{label}:") != 1:
            raise PcodePatchError(f"{context}: label {label} is not uniquely defined")
    if not re.search(r"^[ \t]*localcount (?:4[3-9]|[5-9][0-9]+)[ \t]*$", final, re.MULTILINE):
        raise PcodePatchError(f"{context}: localcount is below 43")
    for forbidden in ("seris_dragon_king", "1299996"):
        if forbidden in injected:
            raise PcodePatchError(f"{context}: forbidden identity token {forbidden}")
    try:
        _canonicalize_offset_labels(final)
    except PcodePatchError as exc:
        raise PcodePatchError(f"{context}: {exc}") from exc


def _verify_seris_death_exit_structural_contract(
    baseline: str, final: str
) -> None:
    context = "Seris death manifestation exit gauge structural contract"
    expected = _seris_unique22_death_exit_team_gauge(
        SERIS_DEATH_EXIT_PURGE_ANCHOR
    )
    if final.count(expected) != 1:
        raise PcodePatchError(f"{context}: injected instruction block differs")
    if baseline.count(SERIS_DEATH_EXIT_PURGE_ANCHOR) != 1:
        raise PcodePatchError(f"{context}: baseline purge anchor is not unique")
    start = final.index("pushbyte 22")
    end = final.index(SERIS_DEATH_EXIT_PURGE_ANCHOR, start)
    injected = final[start:end]
    for token, count in (
        ("pushbyte 22", 1),
        ('"matchConditions"', 1),
        (SERIS_EXIT_ABILITY6_MARKER, 1),
        ('callproperty QName(Namespace("haxe:IMap"),"exists"), 1', 1),
        ('"getMember"', 3),
        ("pushdouble 0.3", 3),
        ('"addSkillPoint"', 3),
    ):
        if injected.count(token) != count:
            raise PcodePatchError(
                f"{context}: token {token!r} count {injected.count(token)}; "
                f"expected {count}"
            )
    labels = SERIS_DEATH_EXIT_MEMBER_LABELS
    for label in labels:
        if final.count(f"{label}:") != 1:
            raise PcodePatchError(f"{context}: label {label} is not uniquely defined")
    if not re.search(r"^[ \t]*localcount (?:[5-9]|[1-9][0-9]+)[ \t]*$", final, re.MULTILINE):
        raise PcodePatchError(f"{context}: localcount is below 5")
    for forbidden in ("seris_dragon_king", "1299996"):
        if forbidden in injected:
            raise PcodePatchError(f"{context}: forbidden identity token {forbidden}")
    try:
        _canonicalize_offset_labels(final)
    except PcodePatchError as exc:
        raise PcodePatchError(f"{context}: {exc}") from exc


def patch_method_block(block: str, entry: dict[str, Any]) -> str:
    result = textwrap.dedent(block)
    baseline = result
    if "DualFormPresentationController" in result or "DualFormViewController" in result:
        raise PcodePatchError(f"method already contains a dual-form trampoline: {entry['method_name']}")
    for patch_id in entry["patches"]:
        try:
            spec = PATCH_SPECS[patch_id]
        except KeyError as exc:
            raise PcodePatchError(f"unknown P-code patch id: {patch_id}") from exc
        if spec.marker is not None and spec.marker in result:
            raise PcodePatchError(
                f"{entry['method_name']} patch {patch_id} already contains patch marker"
            )
        count = result.count(spec.anchor)
        if count != spec.expected_count:
            raise PcodePatchError(
                f"{entry['method_name']} patch {patch_id} anchor count {count}; "
                f"expected {spec.expected_count}"
            )
        result = result.replace(spec.anchor, spec.replace(spec.anchor))
    result = _set_required_maxstack(result, int(entry["required_maxstack"]))
    result = _set_required_localcount(result, int(entry["required_localcount"]))
    if "swap_mod_dual_form_special_animation" in entry["patches"]:
        _verify_dual_form_swap_structural_contract(baseline, result)
    if "wet_thunder_final_multiplier" in entry["patches"]:
        _verify_wet_thunder_structural_contract(baseline, result)
    if "seris_manifestation_debuff_extension" in entry["patches"]:
        _verify_seris_debuff_extension_structural_contract(baseline, result)
    if "seris_unique22_natural_exit_team_gauge" in entry["patches"]:
        _verify_seris_natural_exit_structural_contract(baseline, result)
    if "seris_unique22_death_exit_team_gauge" in entry["patches"]:
        _verify_seris_death_exit_structural_contract(baseline, result)
    return result if result.endswith("\n") else result + "\n"


def _write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        newline="\n",
        delete=False,
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
    ) as handle:
        handle.write(text)
        temporary = Path(handle.name)
    temporary.replace(path)


def _safe_output_name(sequence: int, entry: dict[str, Any]) -> str:
    leaf = entry["method_name"].rsplit("/", 1)[-1]
    class_leaf = class_name_for_method(entry["method_name"]).rsplit(".", 1)[-1]
    return f"{sequence:02d}-{class_leaf}-{leaf}.pcode"


def generate_patch_set(
    baseline_swf: Path,
    pcode_root: Path,
    output_root: Path,
    manifest_path: Path = DEFAULT_MANIFEST,
) -> dict[str, Any]:
    baseline_swf = Path(baseline_swf).resolve()
    pcode_root = Path(pcode_root).resolve()
    output_root = Path(output_root).resolve()
    manifest = load_manifest(Path(manifest_path))
    if not baseline_swf.is_file():
        raise PcodePatchError(f"baseline SWF is missing: {baseline_swf}")
    actual_swf_hash = hashlib.sha256(baseline_swf.read_bytes()).hexdigest()
    expected_swf_hash = manifest["baseline"]["main_swf_sha256"]
    if actual_swf_hash != expected_swf_hash:
        raise PcodePatchError(
            f"baseline SWF sha256 mismatch: expected {expected_swf_hash}, got {actual_swf_hash}"
        )
    abc = _load_neighbor("abc_methods")
    index = abc.index_swf_methods(baseline_swf)
    pending: list[tuple[Path, str]] = []
    outputs: list[dict[str, Any]] = []
    seen_bodies: set[int] = set()
    for sequence, entry in enumerate(manifest["methods"]):
        ref = index.require_ref(entry["method_name"])
        code_hash = hashlib.sha256(ref.code).hexdigest()
        if code_hash != entry["code_sha256"]:
            raise PcodePatchError(
                f"ABC body lock mismatch for {entry['method_name']}: "
                f"body={ref.body_index}, sha256={code_hash}"
            )
        if ref.body_index in seen_bodies:
            raise PcodePatchError(f"duplicate ABC method body index: {ref.body_index}")
        seen_bodies.add(ref.body_index)
        baseline_block = read_baseline_method(pcode_root, entry)
        patched_block = patch_method_block(baseline_block, entry)
        destination = output_root / _safe_output_name(sequence, entry)
        pending.append((destination, patched_block))
        outputs.append(
            {
                "class_name": class_name_for_method(entry["method_name"]),
                "method_name": entry["method_name"],
                "body_index": ref.body_index,
                "baseline_code_sha256": code_hash,
                "baseline_block": baseline_block,
                "output": str(destination),
                "patches": list(entry["patches"]),
            }
        )
    for destination, patched_block in pending:
        _write_atomic(destination, patched_block)
    return {
        "status": "generated",
        "baseline_swf": str(baseline_swf),
        "baseline_swf_sha256": actual_swf_hash,
        "method_count": len(outputs),
        "outputs": outputs,
    }


def resolve_replacement_targets(
    intermediate_swf: Path,
    manifest_path: Path = DEFAULT_MANIFEST,
) -> list[dict[str, Any]]:
    """Resolve body indexes from the exact intermediate baseline copy."""
    intermediate_swf = Path(intermediate_swf).resolve()
    manifest = load_manifest(Path(manifest_path))
    if not intermediate_swf.is_file():
        raise PcodePatchError(f"intermediate SWF is missing: {intermediate_swf}")
    abc = _load_neighbor("abc_methods")
    index = abc.index_swf_methods(intermediate_swf)
    targets: list[dict[str, Any]] = []
    seen: set[int] = set()
    for entry in manifest["methods"]:
        ref = index.require_ref(entry["method_name"])
        code_hash = hashlib.sha256(ref.code).hexdigest()
        if code_hash != entry["code_sha256"]:
            raise PcodePatchError(
                f"intermediate copy changed target method semantics before replacement: "
                f"{entry['method_name']} sha256={code_hash}"
            )
        if ref.body_index in seen:
            raise PcodePatchError(
                f"intermediate copy produced duplicate body index {ref.body_index}"
            )
        seen.add(ref.body_index)
        targets.append(
            {
                "class_name": class_name_for_method(entry["method_name"]),
                "method_name": entry["method_name"],
                "baseline_body_index": ref.body_index,
                "replacement_body_index": ref.body_index,
                "code_sha256": code_hash,
            }
        )
    return targets


def _pushstrings(text: str) -> dict[str, int]:
    result: dict[str, int] = {}
    for value in re.findall(r'^\s*pushstring\s+(.+?)\s*$', text, re.MULTILINE):
        result[value] = result.get(value, 0) + 1
    return result


def _branch_opcodes(text: str) -> dict[str, int]:
    result: dict[str, int] = {}
    for line in text.splitlines():
        stripped = line.strip()
        match = re.match(r"^(if\w*|jump|lookupswitch)\b", stripped)
        if match:
            opcode = match.group(1)
            result[opcode] = result.get(opcode, 0) + 1
    return result


def _canonicalize_offset_labels(text: str) -> str:
    """Ignore FFDec's numeric label renumbering while preserving label topology."""
    token_pattern = re.compile(r"\bofs[0-9A-Fa-f]+\b")
    definitions = re.findall(
        r"(?m)^[ \t]*(ofs[0-9A-Fa-f]+):[ \t]*$", text
    )
    normalized_definitions = [label.lower() for label in definitions]
    if len(normalized_definitions) != len(set(normalized_definitions)):
        raise PcodePatchError("P-code contains duplicate offset label definitions")
    labels = {
        label: f"L{sequence}"
        for sequence, label in enumerate(normalized_definitions)
    }
    referenced = {
        match.group(0).lower() for match in token_pattern.finditer(text)
    }
    undefined = sorted(referenced - set(labels))
    if undefined:
        raise PcodePatchError(
            f"P-code contains undefined offset label references: {undefined}"
        )
    return token_pattern.sub(lambda match: labels[match.group(0).lower()], text)


def verify_public_bridge_contract(
    target_pcode: str,
    helper_pcode: str,
    marker_pcode: str,
    context: str,
) -> None:
    """Reject cross-package internal bridge references before device testing."""
    if INTERNAL_BRIDGE_QNAME in target_pcode:
        raise PcodePatchError(f"final P-code uses internal bridge QName in {context}")
    if f"findpropstrict {PUBLIC_BRIDGE_QNAME}" in target_pcode:
        raise PcodePatchError(
            f"final P-code uses a scope object instead of the class receiver in {context}"
        )
    if f"getlex {PUBLIC_BRIDGE_QNAME}" not in target_pcode:
        raise PcodePatchError(f"final P-code is missing public bridge QName in {context}")
    for class_name, pcode in (
        ("DualFormPresentationController", helper_pcode),
        ("DualFormRuntimeMarker", marker_pcode),
    ):
        if f"public final class {class_name}" not in pcode:
            raise PcodePatchError(
                f"final P-code is missing public carrier class {class_name}"
            )


def verify_member_run_probe_contract(final: str, patches: list[str]) -> None:
    """Keep diagnostic MemberImpl.run probes mutually exclusive and stack neutral."""
    patch_set = set(patches)
    marker_receiver = f"getlex {RUNTIME_MARKER_CLASS}"
    marker_count = final.count(marker_receiver)
    emit_count = final.count('"emit"')
    if "probe_member_stack_noop" in patch_set:
        if marker_count or emit_count:
            raise PcodePatchError("stack-noop probe unexpectedly resolves the runtime marker")
        if final.count(CODE_INDENT + "pushtrue\n" + CODE_INDENT + "pop") != 1:
            raise PcodePatchError("stack-noop probe is missing its one balanced push/pop pair")
    if "probe_member_getlex_marker" in patch_set:
        if marker_count != 1 or emit_count != 0:
            raise PcodePatchError(
                "getlex-only probe must resolve the runtime marker once without calling emit"
            )
    if "probe_member_existing_unique_condition" in patch_set:
        condition_class = (
            'getlex QName(PackageNamespace('
            '"pinball.common.data.character.condition"),"ConditionTargetKind")'
        )
        if marker_count or emit_count:
            raise PcodePatchError(
                "existing-condition probe unexpectedly resolves a dual-form class"
            )
        if final.count(condition_class) != 1:
            raise PcodePatchError(
                "existing-condition probe must resolve ConditionTargetKind exactly once"
            )
        if final.count(CODE_INDENT + "pushbyte 22") != 1:
            raise PcodePatchError(
                "existing-condition probe must use numeric unique-condition id 22 once"
            )
        match_condition_call = (
            'callproperty QName(PackageNamespace(""),"matchCondition"), 1'
        )
        if final.count('"Unique"') != 1 or final.count(match_condition_call) != 1:
            raise PcodePatchError(
                "existing-condition probe must call Unique and matchCondition once"
            )
    if patch_set.intersection({"emit_runtime_marker_in_member", "attach_member"}):
        if marker_count != 1 or emit_count != 1:
            raise PcodePatchError(
                "final MemberImpl.run is missing the one-shot lazy runtime marker"
            )


def verify_pcode_export(
    baseline_pcode_root: Path,
    final_pcode_root: Path,
    manifest_path: Path = DEFAULT_MANIFEST,
    *,
    baseline_swf: Path,
    final_swf: Path,
    replacement_targets: list[dict[str, Any]],
) -> dict[str, Any]:
    manifest = load_manifest(Path(manifest_path))
    baseline_pcode_root = Path(baseline_pcode_root).resolve()
    final_pcode_root = Path(final_pcode_root).resolve()
    baseline_swf = Path(baseline_swf).resolve()
    final_swf = Path(final_swf).resolve()
    if not baseline_swf.is_file():
        raise PcodePatchError(f"baseline SWF is missing: {baseline_swf}")
    if not final_swf.is_file():
        raise PcodePatchError(f"final SWF is missing: {final_swf}")
    baseline_hash = hashlib.sha256(baseline_swf.read_bytes()).hexdigest()
    if baseline_hash != manifest["baseline"]["main_swf_sha256"]:
        raise PcodePatchError(
            "baseline SWF sha256 mismatch during final verification: "
            f"expected {manifest['baseline']['main_swf_sha256']}, got {baseline_hash}"
        )
    final_hash = hashlib.sha256(final_swf.read_bytes()).hexdigest()
    if final_hash == baseline_hash:
        raise PcodePatchError("final SWF sha256 matches baseline")

    expected_names = [entry["method_name"] for entry in manifest["methods"]]
    if not isinstance(replacement_targets, list):
        raise PcodePatchError("replacement targets must be a list")
    actual_names = [target.get("method_name") for target in replacement_targets]
    if actual_names != expected_names:
        raise PcodePatchError(
            "replacement target methods do not exactly match manifest: "
            f"expected={expected_names}, actual={actual_names}"
        )
    replacement_body_indices: dict[str, int] = {}
    seen_body_indices: set[int] = set()
    for target in replacement_targets:
        body_index = target.get("replacement_body_index")
        if isinstance(body_index, bool) or not isinstance(body_index, int) or body_index < 0:
            raise PcodePatchError(
                f"invalid replacement body index for {target.get('method_name')}: "
                f"{body_index!r}"
            )
        if body_index in seen_body_indices:
            raise PcodePatchError(f"duplicate replacement body index: {body_index}")
        seen_body_indices.add(body_index)
        replacement_body_indices[target["method_name"]] = body_index

    verified_methods: list[dict[str, Any]] = []
    targets_by_method = {
        target["method_name"]: target for target in replacement_targets
    }
    for entry in manifest["methods"]:
        baseline = read_baseline_method(baseline_pcode_root, entry)
        final = read_baseline_method(final_pcode_root, entry)
        for forbidden in FORBIDDEN_FINAL_TOKENS:
            if forbidden in final:
                raise PcodePatchError(
                    f"forbidden carrier token in final P-code for "
                    f"{entry['method_name']}: {forbidden}"
                )
        if entry["patches"]:
            if final == baseline:
                raise PcodePatchError(
                    f"target method body is unchanged: {entry['method_name']}"
                )
            generated_path = targets_by_method[entry["method_name"]].get(
                "generated_pcode"
            )
            if not isinstance(generated_path, str) or not generated_path:
                raise PcodePatchError(
                    f"generated replacement is missing for {entry['method_name']}"
                )
            try:
                generated = Path(generated_path).read_text(encoding="utf-8")
            except OSError as exc:
                raise PcodePatchError(
                    f"cannot read generated replacement {generated_path}: {exc}"
                ) from exc
            generated = textwrap.dedent(generated)
            if not generated.endswith("\n"):
                generated += "\n"
            if _canonicalize_offset_labels(final) != _canonicalize_offset_labels(
                generated
            ):
                raise PcodePatchError(
                    f"final P-code does not match generated replacement for "
                    f"{entry['method_name']}"
                )
        elif _canonicalize_offset_labels(final) != _canonicalize_offset_labels(
            baseline
        ):
            raise PcodePatchError(
                f"empty-patch target method body changed: {entry['method_name']}"
            )
        for field in ("maxstack", "localcount"):
            matches = re.findall(
                rf"^[ \t]*{field} ([0-9]+)[ \t]*$", final, re.MULTILINE
            )
            if len(matches) != 1:
                raise PcodePatchError(
                    f"final P-code must contain one {field} declaration for "
                    f"{entry['method_name']}; found {len(matches)}"
                )
            required = int(entry[f"required_{field}"])
            if int(matches[0]) < required:
                raise PcodePatchError(
                    f"final P-code {field} is too small for {entry['method_name']}"
                )
        verified_methods.append(
            {
                "method_name": entry["method_name"],
                "patches": list(entry["patches"]),
                "replacement_body_index": replacement_body_indices[
                    entry["method_name"]
                ],
            }
        )
    return {
        "status": "verified-offline-only",
        "method_count": len(verified_methods),
        "methods": verified_methods,
        "baseline_swf_sha256": baseline_hash,
        "final_swf_sha256": final_hash,
        "replacement_body_indices": replacement_body_indices,
        "device_canary_required": True,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-swf", type=Path, required=True)
    parser.add_argument("--pcode-root", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    args = parser.parse_args()
    try:
        report = generate_patch_set(
            args.baseline_swf,
            args.pcode_root,
            args.output_dir,
            args.manifest,
        )
    except (PcodePatchError, RuntimeError) as exc:
        parser.error(str(exc))
    printable = dict(report)
    printable["outputs"] = [
        {key: value for key, value in item.items() if key != "baseline_block"}
        for item in report["outputs"]
    ]
    print(json.dumps(printable, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
