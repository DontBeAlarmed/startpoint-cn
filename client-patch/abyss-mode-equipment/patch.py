#!/usr/bin/env python3
"""Patch BattleCharacterLogic with the fail-closed abyss equipment gate."""
from __future__ import annotations

import argparse
import codecs
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Sequence


TARGET_SIGNATURE = (
    "public function getAvailableAbilities(param1:BattlePartyLogic, param2:int, "
    "param3:QuestIdGroupKind, param4:Array) : BattleAbilitySource"
)
WITH_COND_SIGNATURE = (
    "public function getAvailableAbilitiesWithCond(param1:BattlePartyLogic, "
    "param2:int, param3:Function, param4:Array, param5:Boolean, "
    "param6:Boolean) : BattleAbilitySource"
)
ACTION_SKILLS_PREFIX = "public function getActionSkills"
ANCHOR = "_loc14_ = Boolean(_loc5_(_loc13_.questKind));"
BEGIN_MARKER = "WF_ABYSS_MODE_EQUIPMENT_GATE_V1_BEGIN"
END_MARKER = "WF_ABYSS_MODE_EQUIPMENT_GATE_V1_END"
ALLOWED_SUMMARY = (
    "single[8]=2001, single[10]=1..97, single[17]=700099xxx"
)

PATCH_LINES = (
    f"// {BEGIN_MARKER}",
    "if(_loc13_ is AbilitySoulAbilityLogic)",
    "{",
    "   _loc12_ = _loc13_ as AbilitySoulAbilityLogic;",
    "   if(_loc12_.id >= 8000101 && _loc12_.id <= 8000115)",
    "   {",
    "      _loc14_ = false;",
    "      if(param3.index == 0)",
    "      {",
    "         _loc15_ = int(param3.params[0].params[0]);",
    "         switch(param3.params[0].index)",
    "         {",
    "            case 8:",
    "               _loc14_ = _loc15_ == 2001;",
    "               break;",
    "            case 10:",
    "               _loc14_ = _loc15_ >= 1 && _loc15_ <= 97;",
    "               break;",
    "            case 17:",
    "               _loc14_ = int(Math.floor(_loc15_ / 1000 + 1e-10)) == 700099;",
    "         }",
    "      }",
    "   }",
    "}",
    f"// {END_MARKER}",
)


class PatchError(RuntimeError):
    """The source shape or patched semantics are not exactly as expected."""


def allowed_quest(group_index: int, single_index: int, quest_id: int) -> bool:
    """Return the exact quest whitelist used by the ActionScript gate."""
    if group_index != 0:
        return False
    if single_index == 8:
        return quest_id == 2001
    if single_index == 10:
        return 1 <= quest_id <= 97
    if single_index == 17:
        return quest_id // 1000 == 700099
    return False


def _target_bounds(text: str) -> tuple[int, int]:
    count = text.count(TARGET_SIGNATURE)
    if count != 1:
        raise PatchError(
            f"expected exactly one getAvailableAbilities method, found {count}"
        )
    start = text.index(TARGET_SIGNATURE)
    end = text.find(ACTION_SKILLS_PREFIX, start + len(TARGET_SIGNATURE))
    if end < 0:
        raise PatchError("getAvailableAbilities has no following getActionSkills boundary")
    return start, end


def _with_cond_bounds(text: str, target_start: int) -> tuple[int, int]:
    count = text.count(WITH_COND_SIGNATURE)
    if count != 1:
        raise PatchError(
            f"expected exactly one getAvailableAbilitiesWithCond method, found {count}"
        )
    start = text.index(WITH_COND_SIGNATURE)
    if start >= target_start:
        raise PatchError(
            "getAvailableAbilitiesWithCond must precede getAvailableAbilities"
        )
    return start, target_start


def _anchor_matches(method_text: str) -> list[re.Match[str]]:
    pattern = re.compile(
        r"(?m)^(?P<indent>[ \t]*)"
        + re.escape(ANCHOR)
        + r"(?P<newline>\r\n|\n|\r)"
    )
    return list(pattern.finditer(method_text))


def _checked_anchor(method_text: str) -> re.Match[str]:
    raw_count = method_text.count(ANCHOR)
    matches = _anchor_matches(method_text)
    if raw_count != 1 or len(matches) != 1:
        raise PatchError(
            "expected the exact quest-condition anchor line once inside "
            f"getAvailableAbilities, found raw={raw_count}, exact={len(matches)}"
        )
    return matches[0]


def _render_block(indent: str, newline: str) -> str:
    return newline.join(indent + line for line in PATCH_LINES)


def _semantic_compact(text: str) -> str:
    without_comments = re.sub(r"//[^\r\n]*", "", text)
    return re.sub(r"\s+", "", without_comments)


def _expected_semantics() -> str:
    lines = [line for line in PATCH_LINES if not line.startswith("// ")]
    return _semantic_compact("\n".join(lines))


def _validate_markers(
    text: str,
    method_start: int,
    method_end: int,
    gate_start: int,
    gate_end: int,
    require_markers: bool,
) -> None:
    begin_count = text.count(BEGIN_MARKER)
    end_count = text.count(END_MARKER)
    if require_markers and (begin_count != 1 or end_count != 1):
        raise PatchError(
            "required gate markers must each occur once, found "
            f"begin={begin_count}, end={end_count}"
        )
    if begin_count or end_count:
        if begin_count != 1 or end_count != 1:
            raise PatchError(
                "gate markers must be absent or each occur once, found "
                f"begin={begin_count}, end={end_count}"
            )
        begin = text.index(BEGIN_MARKER)
        end = text.index(END_MARKER)
        if not (method_start <= begin < end < method_end):
            raise PatchError("gate markers are outside getAvailableAbilities")
        if not (gate_start <= begin < end < gate_end):
            raise PatchError("gate markers do not surround the post-anchor gate")


def verify_text(text: str, require_markers: bool) -> None:
    """Verify the gate semantically, optionally requiring source comments."""
    method_start, method_end = _target_bounds(text)
    with_cond_start, with_cond_end = _with_cond_bounds(text, method_start)
    method_text = text[method_start:method_end]
    anchor = _checked_anchor(method_text)

    post_anchor = method_text[anchor.end():]
    official_if = re.search(r"if\s*\(\s*_loc14_\s*\)", post_anchor)
    if official_if is None:
        raise PatchError("cannot find the official if(_loc14_) after the anchor")
    gate_text = post_anchor[:official_if.start()]
    if _semantic_compact(gate_text) != _expected_semantics():
        raise PatchError("post-anchor abyss gate semantics do not match exactly")

    gate_start = method_start + anchor.end()
    gate_end = gate_start + official_if.start()
    _validate_markers(
        text,
        method_start,
        method_end,
        gate_start,
        gate_end,
        require_markers,
    )

    with_cond = text[with_cond_start:with_cond_end]
    with_cond_compact = _semantic_compact(with_cond)
    similar_tokens = (
        BEGIN_MARKER,
        END_MARKER,
        "_loc12_.id>=",
        "_loc12_.id<=",
        "param3.index==0",
        "Math.floor(_loc15_/1000",
    )
    found = [token for token in similar_tokens if token in with_cond_compact]
    if found:
        raise PatchError(
            "abyss gate semantics found in getAvailableAbilitiesWithCond: "
            + ", ".join(found)
        )


def patch_text(text: str) -> tuple[str, int]:
    """Insert the exact gate once, returning ``(text, insertion_count)``."""
    method_start, method_end = _target_bounds(text)
    method_text = text[method_start:method_end]

    gate_indicators = (
        BEGIN_MARKER,
        END_MARKER,
        "8000101",
        "8000115",
        "param3.index == 0",
    )
    if any(indicator in method_text for indicator in gate_indicators):
        require_markers = BEGIN_MARKER in text or END_MARKER in text
        verify_text(text, require_markers=require_markers)
        return text, 0

    anchor = _checked_anchor(method_text)
    indent = anchor.group("indent")
    newline = anchor.group("newline")
    insertion_at = method_start + anchor.end()
    block = _render_block(indent, newline) + newline
    patched = text[:insertion_at] + block + text[insertion_at:]
    verify_text(patched, require_markers=True)
    return patched, 1


def _decode_utf8(data: bytes) -> tuple[str, bytes]:
    bom = codecs.BOM_UTF8 if data.startswith(codecs.BOM_UTF8) else b""
    return data[len(bom):].decode("utf-8"), bom


def patch_file(source: Path | str, output: Path | str) -> int:
    """Patch to an atomic sibling temp, preserving any existing output on error."""
    source_path = Path(source)
    output_path = Path(output)
    source_abs = os.path.normcase(os.path.abspath(source_path))
    output_abs = os.path.normcase(os.path.abspath(output_path))
    if source_abs == output_abs:
        raise PatchError("source and output must be different paths")

    source_bytes = source_path.read_bytes()
    source_text, bom = _decode_utf8(source_bytes)
    patched_text, insertions = patch_text(source_text)
    verify_text(patched_text, require_markers=True)
    patched_bytes = bom + patched_text.encode("utf-8")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            dir=output_path.parent,
            prefix=f".{output_path.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            temporary = Path(handle.name)
            handle.write(patched_bytes)
            handle.flush()
            os.fsync(handle.fileno())

        written = temporary.read_bytes()
        if written != patched_bytes:
            raise PatchError("temporary output bytes differ from the verified patch")
        written_text, _ = _decode_utf8(written)
        verify_text(written_text, require_markers=True)
        os.replace(temporary, output_path)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return insertions


def verify_file(path: Path | str, require_markers: bool = False) -> None:
    text, _ = _decode_utf8(Path(path).read_bytes())
    verify_text(text, require_markers=require_markers)


def _success_report(action: str, path: Path, insertions: int | None = None) -> str:
    count = "" if insertions is None else f"; insertions={insertions}"
    return (
        f"[OK] {action} {path}{count}; allowed quest classes: "
        f"{ALLOWED_SUMMARY}"
    )


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Patch or verify the abyss equipment BattleCharacterLogic gate."
    )
    parser.add_argument("--source", type=Path, help="authoritative source AS file")
    parser.add_argument("--output", type=Path, help="patched output AS file")
    parser.add_argument("--verify", type=Path, help="patched or FFDec re-exported AS")
    args = parser.parse_args(argv)

    if args.verify is not None:
        if args.source is not None or args.output is not None:
            parser.error("--verify cannot be combined with --source or --output")
        try:
            verify_file(args.verify, require_markers=False)
        except (OSError, UnicodeError, PatchError) as exc:
            print(f"[ERROR] {exc}", file=sys.stderr)
            return 1
        print(_success_report("verified", args.verify))
        return 0

    if args.source is None or args.output is None:
        parser.error("patching requires both --source and --output")
    try:
        insertions = patch_file(args.source, args.output)
    except (OSError, UnicodeError, PatchError) as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        return 1
    print(_success_report("patched", args.output, insertions))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
