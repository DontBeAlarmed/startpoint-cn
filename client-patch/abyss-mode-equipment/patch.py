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
from typing import NamedTuple, Sequence


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
BEGIN_MARKER = "WF_ABYSS_MODE_EQUIPMENT_GATE_V2_BEGIN"
END_MARKER = "WF_ABYSS_MODE_EQUIPMENT_GATE_V2_END"
ALLOWED_SUMMARY = (
    "single[8]=2001, single[10]=1..97, single[17]=700099xxx"
)

PATCH_LINES = (
    f"// {BEGIN_MARKER}",
    "_loc12_ = null;",
    "if(_loc13_ is AbilitySoulAbilityLogic)",
    "{",
    "   _loc12_ = _loc13_ as AbilitySoulAbilityLogic;",
    "}",
    "else if(_loc13_ is EquipmentAbilityLogic)",
    "{",
    "   _loc12_ = (_loc13_ as EquipmentAbilityLogic).abilitySoulAbility;",
    "}",
    "if(_loc12_ != null && _loc12_.id >= 8000101 && _loc12_.id <= 8000115)",
    "{",
    "   _loc14_ = false;",
    "   if(param3.index == 0)",
    "   {",
    "      _loc15_ = int(param3.params[0].params[0]);",
    "      switch(param3.params[0].index)",
    "      {",
    "         case 8:",
    "            _loc14_ = _loc15_ == 2001;",
    "            break;",
    "         case 10:",
    "            _loc14_ = _loc15_ >= 1 && _loc15_ <= 97;",
    "            break;",
    "         case 17:",
    "            _loc14_ = int(Math.floor(_loc15_ / 1000 + 1e-10)) == 700099;",
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


class _Token(NamedTuple):
    value: str
    start: int
    end: int


_NUMBER_RE = re.compile(
    r"(?:0[xX][0-9A-Fa-f]+|(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?)"
)
_IDENTIFIER_RE = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*")
_MULTI_OPERATORS = tuple(sorted({
    ">>>=", "===", "!==", ">>>", "<<=", ">>=", "&&", "||", "==",
    "!=", "<=", ">=", "++", "--", "+=", "-=", "*=", "/=", "%=",
    "<<", ">>", "::", "..",
}, key=len, reverse=True))


def _tokenize(text: str) -> list[_Token]:
    """Tokenize enough AS3 to compare code while preserving token boundaries."""
    tokens: list[_Token] = []
    index = 0
    while index < len(text):
        char = text[index]
        if char.isspace():
            index += 1
            continue
        if text.startswith("//", index):
            newline = re.search(r"[\r\n]", text[index + 2:])
            index = len(text) if newline is None else index + 2 + newline.start()
            continue
        if text.startswith("/*", index):
            end = text.find("*/", index + 2)
            if end < 0:
                raise PatchError("unterminated block comment in ActionScript")
            index = end + 2
            continue
        if char in {'"', "'"}:
            quote = char
            end = index + 1
            while end < len(text):
                if text[end] == "\\":
                    end += 2
                    continue
                if text[end] == quote:
                    end += 1
                    break
                end += 1
            else:
                raise PatchError("unterminated string literal in ActionScript")
            tokens.append(_Token(text[index:end], index, end))
            index = end
            continue
        number = _NUMBER_RE.match(text, index)
        if number is not None:
            tokens.append(_Token(number.group(0), index, number.end()))
            index = number.end()
            continue
        identifier = _IDENTIFIER_RE.match(text, index)
        if identifier is not None:
            tokens.append(_Token(identifier.group(0), index, identifier.end()))
            index = identifier.end()
            continue
        operator = next(
            (value for value in _MULTI_OPERATORS
             if text.startswith(value, index)),
            None,
        )
        if operator is not None:
            tokens.append(_Token(operator, index, index + len(operator)))
            index += len(operator)
            continue
        tokens.append(_Token(char, index, index + 1))
        index += 1
    return tokens


def _token_values(tokens: Sequence[_Token]) -> tuple[str, ...]:
    return tuple(token.value for token in tokens)


def _gate_token_values() -> tuple[str, ...]:
    lines = [line for line in PATCH_LINES if not line.startswith("// ")]
    return _token_values(_tokenize("\n".join(lines)))


def _sequence_positions(
    tokens: Sequence[_Token], expected: Sequence[str]
) -> list[int]:
    values = _token_values(tokens)
    width = len(expected)
    if width == 0:
        return []
    return [
        index for index in range(len(values) - width + 1)
        if values[index:index + width] == tuple(expected)
    ]


def _matching_brace(tokens: Sequence[_Token], open_index: int) -> int:
    if open_index >= len(tokens) or tokens[open_index].value != "{":
        raise PatchError("official ability guard has no opening brace")
    depth = 0
    for index in range(open_index, len(tokens)):
        if tokens[index].value == "{":
            depth += 1
        elif tokens[index].value == "}":
            depth -= 1
            if depth == 0:
                return index
    raise PatchError("official if(_loc14_) block is not balanced")


_ABILITY_GET_TRIGGERS = (
    "_loc10_", "=", "_loc13_", ".", "getTriggers", "(", ")", ";",
)
_ABILITY_ADD = (
    "_loc7_", ".", "add", "(", "_loc18_", ",", "_loc10_", "[",
    "_loc17_", "]", ",", "this", ",", "param1", ",", "param2", ",",
    "false", ")", ";",
)
_SIMILAR_GATE_PREFIXES = (
    ("_loc13_", "is", "EquipmentAbilityLogic"),
    ("_loc13_", "as", "EquipmentAbilityLogic"),
    ("_loc12_", "!=", "null"),
    ("_loc12_", ".", "id", ">="),
    ("_loc12_", ".", "id", "<="),
    ("param3", ".", "index", "=="),
    ("Math", ".", "floor", "(", "_loc15_", "/", "1000"),
)


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
    method_tokens = _tokenize(method_text)
    post_tokens = _tokenize(post_anchor)
    gate_tokens = _gate_token_values()
    occurrences = _sequence_positions(method_tokens, gate_tokens)
    if len(occurrences) != 1:
        raise PatchError(
            f"expected exactly one complete abyss gate, found {len(occurrences)}"
        )
    if _token_values(post_tokens[:len(gate_tokens)]) != gate_tokens:
        raise PatchError("complete abyss gate is not immediately after the anchor")

    guard_start = len(gate_tokens)
    guard_prefix = ("if", "(", "_loc14_", ")", "{")
    if _token_values(
        post_tokens[guard_start:guard_start + len(guard_prefix)]
    ) != guard_prefix:
        raise PatchError("official if(_loc14_) does not immediately follow the gate")
    guard_open = guard_start + len(guard_prefix) - 1
    guard_close = _matching_brace(post_tokens, guard_open)
    if guard_close + 1 >= len(post_tokens) \
            or post_tokens[guard_close + 1].value != "}":
        raise PatchError("official ability guard is not followed by the loop close")

    for label, expected in (
        ("getTriggers", _ABILITY_GET_TRIGGERS),
        ("add", _ABILITY_ADD),
    ):
        positions = _sequence_positions(post_tokens, expected)
        if len(positions) != 1:
            raise PatchError(
                f"expected one official ability {label} path, found {len(positions)}"
            )
        position = positions[0]
        if not (guard_open < position
                and position + len(expected) - 1 < guard_close):
            raise PatchError(
                f"official ability {label} path is outside if(_loc14_)"
            )

    gate_start = method_start + anchor.end()
    gate_end = gate_start + post_tokens[guard_start].start
    _validate_markers(
        text,
        method_start,
        method_end,
        gate_start,
        gate_end,
        require_markers,
    )

    with_cond = text[with_cond_start:with_cond_end]
    with_cond_tokens = _tokenize(with_cond)
    found = [
        " ".join(prefix) for prefix in _SIMILAR_GATE_PREFIXES
        if _sequence_positions(with_cond_tokens, prefix)
    ]
    if _sequence_positions(with_cond_tokens, gate_tokens):
        found.append("complete gate")
    if found:
        raise PatchError(
            "abyss gate semantics found in getAvailableAbilitiesWithCond: "
            + ", ".join(found)
        )


def patch_text(text: str) -> tuple[str, int]:
    """Insert the exact gate once, returning ``(text, insertion_count)``."""
    method_start, method_end = _target_bounds(text)
    method_text = text[method_start:method_end]
    method_tokens = _tokenize(method_text)
    has_gate_indicator = (
        BEGIN_MARKER in text
        or END_MARKER in text
        or any(_sequence_positions(method_tokens, prefix)
               for prefix in _SIMILAR_GATE_PREFIXES)
    )
    if has_gate_indicator:
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


class _OutputSnapshot(NamedTuple):
    existed: bool
    data: bytes


def _snapshot_output(path: Path) -> _OutputSnapshot:
    try:
        return _OutputSnapshot(True, path.read_bytes())
    except FileNotFoundError:
        return _OutputSnapshot(False, b"")


def _snapshot_matches(path: Path, snapshot: _OutputSnapshot) -> bool:
    if not snapshot.existed:
        return not path.exists()
    try:
        return path.read_bytes() == snapshot.data
    except OSError:
        return False


def _restore_output_snapshot(path: Path, snapshot: _OutputSnapshot) -> None:
    """Restore exact prior bytes/existence after a replacement was attempted."""
    if _snapshot_matches(path, snapshot):
        return
    if not snapshot.existed:
        try:
            path.unlink(missing_ok=True)
        except BaseException:
            if _snapshot_matches(path, snapshot):
                return
            raise
        if not _snapshot_matches(path, snapshot):
            raise PatchError("failed to remove newly created output during restore")
        return

    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            dir=path.parent,
            prefix=f".{path.name}.restore-",
            suffix=".tmp",
            delete=False,
        ) as handle:
            temporary = Path(handle.name)
            handle.write(snapshot.data)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.replace(temporary, path)
            temporary = None
        except BaseException:
            if _snapshot_matches(path, snapshot):
                return
            raise
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    if not _snapshot_matches(path, snapshot):
        raise PatchError("restored output bytes do not match the prior snapshot")


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

    prior_output = _snapshot_output(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    replacement_attempted = False
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
        replacement_attempted = True
        os.replace(temporary, output_path)
        temporary = None
    except BaseException as original_error:
        if replacement_attempted:
            try:
                _restore_output_snapshot(output_path, prior_output)
            except BaseException as restore_error:
                original_error.add_note(
                    "output restore failed after replacement attempt: "
                    f"{type(restore_error).__name__}: {restore_error}"
                )
        raise
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
