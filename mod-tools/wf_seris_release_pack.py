#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Convert the validated Seris offline handoff into a formal runtime-test pack.

This module still performs no live, CDN, service, mail, API, or device write.
The output uses the strict ``character-pack-v1`` manifest so ``wf_release`` can
preflight and publish it transactionally after an explicit runtime-test grant.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Mapping

import wf_character_pack as character_pack
import wf_assets
import wf_mod_tool as core


ROOT_NAMES = character_pack.ROOT_NAMES
CONFIRMATION = "DIRECT_REAL_TEST"
SERVER_PATHS = character_pack.SERVER_LOGICAL_PATHS
SHA256_RE = re.compile(r"^[0-9a-f]{40,64}$")


class ReleasePackError(RuntimeError):
    """A runtime-test package could not be assembled without weakening a gate."""


@dataclass(frozen=True)
class RuntimeTestPackageResult:
    output_dir: Path
    manifest_sha256: str
    root_counts: Mapping[str, int]
    payload_count: int


def _canonical(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def _sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _load_object(path: Path) -> dict:
    value = json.loads(path.read_bytes())
    if not isinstance(value, dict):
        raise ReleasePackError(f"JSON object required: {path}")
    return value


def _reparse(path: Path) -> bool:
    try:
        info = os.lstat(path)
    except OSError as exc:
        raise ReleasePackError(f"cannot inspect path: {path}: {exc}") from exc
    if stat.S_ISLNK(info.st_mode):
        return True
    return bool(
        getattr(info, "st_file_attributes", 0)
        & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    )


def _require_regular_source(path: Path, anchor: Path) -> None:
    try:
        path.resolve().relative_to(anchor.resolve())
    except (OSError, ValueError) as exc:
        raise ReleasePackError(f"source escapes offline package: {path}") from exc
    current = path
    while True:
        if _reparse(current):
            raise ReleasePackError(f"reparse source is forbidden: {current}")
        if current == anchor:
            break
        current = current.parent
    try:
        mode = os.lstat(path).st_mode
    except OSError as exc:
        raise ReleasePackError(f"cannot inspect source: {path}: {exc}") from exc
    if not stat.S_ISREG(mode):
        raise ReleasePackError(f"regular source file required: {path}")


def _copy_exact(source: Path, target: Path, *, anchor: Path) -> bytes:
    _require_regular_source(source, anchor)
    raw = source.read_bytes()
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("xb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    return raw


def _copy_runtime_payload(
    source: Path,
    target: Path,
    *,
    anchor: Path,
    logical_path: str,
) -> tuple[bytes, bytes]:
    """Copy an authoring payload after converting media to WF storage form."""
    _require_regular_source(source, anchor)
    source_raw = source.read_bytes()
    if logical_path.endswith(".png"):
        stored_raw = wf_assets.png_encode(source_raw)
    elif logical_path.endswith(".mp3"):
        stored_raw = wf_assets.mp3_encode(source_raw)
    else:
        stored_raw = source_raw
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("xb") as stream:
        stream.write(stored_raw)
        stream.flush()
        os.fsync(stream.fileno())
    return source_raw, stored_raw


def _formal_table_claims(offline: dict, package_dir: Path) -> list[dict]:
    claims: list[dict] = []
    raw_claims = offline.get("tables")
    if not isinstance(raw_claims, list):
        raise ReleasePackError("offline table claims are missing")
    for index, item in enumerate(raw_claims):
        if not isinstance(item, dict):
            raise ReleasePackError(f"offline table claim {index} is not an object")
        logical = item.get("logical_path")
        keys = item.get("keys")
        kind = item.get("kind")
        if (
            item.get("root") != "common"
            or not isinstance(logical, str)
            or not isinstance(keys, list)
            or not keys
            or any(not isinstance(key, str) or not key for key in keys)
        ):
            raise ReleasePackError(f"offline table claim {index} is invalid")
        codec_id = "flat"
        inner_keys: list[dict[str, object]] = []
        if kind == "nested":
            codec_id = (
                "switched_nested"
                if logical == "master/skill/switched_action_skill.orderedmap"
                else "action_nested"
            )
            raw = (
                package_dir / "roots" / "common" / Path(*logical.split("/"))
            ).read_bytes()
            table = core.load_nested_table_bytes(raw, logical)
            for outer_key in keys:
                if outer_key not in table.rows:
                    raise ReleasePackError(
                        f"nested claim is absent from payload: {logical}:{outer_key}"
                    )
                inner_keys.append({
                    "outer_key": outer_key,
                    "keys": list(table.rows[outer_key].keys),
                })
        elif kind == "recursive":
            codec_id = "raw_outer"
        elif kind != "flat":
            raise ReleasePackError(f"unsupported offline table kind: {kind!r}")
        claims.append({
            "root": "common",
            "logical_path": logical,
            "codec_id": codec_id,
            "outer_keys": list(keys),
            "inner_keys": inner_keys,
            "semantic_claims": [],
        })
    for logical in SERVER_PATHS:
        claims.append({
            "root": "server",
            "logical_path": logical,
            "codec_id": "json_object",
            "outer_keys": ["129999"],
            "inner_keys": [],
            "semantic_claims": [],
        })
    return claims


def _declared_root_files(manifest: dict) -> dict[str, dict[str, dict]]:
    roots = manifest.get("roots")
    if not isinstance(roots, dict):
        raise ReleasePackError("offline roots are missing")
    result: dict[str, dict[str, dict]] = {}
    for root_name in ROOT_NAMES:
        entries = roots.get(root_name)
        if not isinstance(entries, list):
            raise ReleasePackError(f"offline root is not an array: {root_name}")
        mapped: dict[str, dict] = {}
        for entry in entries:
            if not isinstance(entry, dict):
                raise ReleasePackError(f"offline root entry is invalid: {root_name}")
            logical = entry.get("logical_path")
            if not isinstance(logical, str) or not logical or logical in mapped:
                raise ReleasePackError(f"offline root path is invalid: {root_name}:{logical}")
            mapped[logical] = entry
        result[root_name] = mapped
    return result


def _scan_files(root: Path) -> set[str]:
    if not root.is_dir() or _reparse(root):
        raise ReleasePackError(f"ordinary directory required: {root}")
    files: set[str] = set()

    def onerror(exc: OSError) -> None:
        raise ReleasePackError(f"cannot scan package tree: {exc}") from exc

    for directory, dirnames, filenames in os.walk(root, onerror=onerror):
        directory_path = Path(directory)
        for name in list(dirnames):
            child = directory_path / name
            if _reparse(child):
                raise ReleasePackError(f"reparse directory is forbidden: {child}")
        for name in filenames:
            child = directory_path / name
            if _reparse(child) or not child.is_file():
                raise ReleasePackError(f"ordinary file required: {child}")
            files.add(child.relative_to(root).as_posix())
    return files


def validate_runtime_test_package(package_dir: Path) -> list[str]:
    package_dir = Path(package_dir)
    errors: list[str] = []
    try:
        manifest = _load_object(package_dir / "manifest.json")
    except (OSError, ValueError, ReleasePackError) as exc:
        return [f"manifest: {exc}"]
    errors.extend(character_pack.validate_manifest(manifest, package_dir))
    expected_identity = {
        "schema_version": 1,
        "package_id": "seris_dragon_king",
        "character_id": 129999,
        "code_name": "seris_dragon_king",
        "requires_client_base": "dual_form_v1",
    }
    for field, expected in expected_identity.items():
        if manifest.get(field) != expected:
            errors.append(f"{field}: expected {expected!r}")
    qa = manifest.get("qa")
    if not isinstance(qa, dict):
        errors.append("qa: object required")
        qa = {}
    if qa.get("delivery_mode") != "runtime_test":
        errors.append("qa.delivery_mode: runtime_test required")
    if qa.get("release_ready") is not False:
        errors.append("qa.release_ready: must remain false until runtime matrix passes")
    if qa.get("user_authorized_direct_real_test") is not True:
        errors.append("qa.user_authorized_direct_real_test: explicit authorization required")
    try:
        character_pack._parse_transaction_claims(manifest)  # type: ignore[attr-defined]
    except (ValueError, character_pack.PackPreflightError) as exc:
        errors.append(f"tables: {exc}")
    roots = manifest.get("roots")
    if isinstance(roots, dict):
        for root_name in ROOT_NAMES:
            entries = roots.get(root_name)
            if not isinstance(entries, list):
                continue
            declared = {
                entry.get("logical_path") for entry in entries if isinstance(entry, dict)
            }
            try:
                actual = _scan_files(package_dir / "roots" / root_name)
            except ReleasePackError as exc:
                errors.append(f"roots.{root_name}: {exc}")
                continue
            extras = sorted(actual - declared)
            missing = sorted(declared - actual)
            if extras:
                errors.append(f"roots.{root_name}: undeclared files: {extras}")
            if missing:
                errors.append(f"roots.{root_name}: missing files: {missing}")
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                logical = entry.get("logical_path")
                if not isinstance(logical, str):
                    continue
                payload = package_dir / "roots" / root_name / Path(*logical.split("/"))
                if not payload.is_file():
                    continue
                try:
                    raw = payload.read_bytes()
                except OSError as exc:
                    errors.append(f"roots.{root_name}:{logical}: cannot read: {exc}")
                    continue
                if logical.endswith(".png") and raw[:8] != wf_assets.PNG_FAKE:
                    errors.append(
                        f"roots.{root_name}:{logical}: WF storage PNG signature required"
                    )
                elif logical.endswith(".mp3"):
                    probe = wf_assets.mp3_probe(raw, 1023)
                    if probe["frames"] == 0:
                        errors.append(
                            f"roots.{root_name}:{logical}: WF storage MP3 frames required"
                        )
    qa_files = qa.get("files") if isinstance(qa, dict) else None
    if isinstance(qa_files, list):
        declared_qa = {
            item.get("logical_path") for item in qa_files if isinstance(item, dict)
        }
        try:
            actual_qa = _scan_files(package_dir / "qa")
        except ReleasePackError as exc:
            errors.append(f"qa.files: {exc}")
        else:
            if actual_qa != declared_qa:
                errors.append("qa.files: declared inventory differs from disk")
    else:
        errors.append("qa.files: array required")
    return sorted(set(errors))


def assemble_runtime_test_package(
    offline_package: Path,
    output_dir: Path,
    *,
    git_head: str,
    confirmation: str,
    offline_validator: Callable[[Path], list[str]] | None = None,
) -> RuntimeTestPackageResult:
    if confirmation != CONFIRMATION:
        raise ReleasePackError(f"explicit {CONFIRMATION} confirmation is required")
    if not isinstance(git_head, str) or SHA256_RE.fullmatch(git_head) is None:
        raise ReleasePackError("git_head must be a 40-64 lowercase hex commit/hash")
    offline_package = Path(offline_package)
    output_dir = Path(output_dir)
    if output_dir.exists():
        raise ReleasePackError("runtime-test output already exists")
    if offline_validator is None:
        import wf_seris_offline_handoff as offline_handoff

        validator = offline_handoff.validate_package
    else:
        validator = offline_validator
    offline_errors = validator(offline_package)
    if offline_errors:
        raise ReleasePackError(
            "offline handoff validation failed:\n- " + "\n- ".join(offline_errors)
        )
    offline_manifest_raw = (offline_package / "manifest.json").read_bytes()
    offline_manifest = _load_object(offline_package / "manifest.json")
    if (
        offline_manifest.get("format") != "seris-offline-handoff/v1"
        or offline_manifest.get("package_id") != "seris_dragon_king"
        or str(offline_manifest.get("character_id")) != "129999"
        or offline_manifest.get("code_name") != "seris_dragon_king"
    ):
        raise ReleasePackError("offline handoff identity mismatch")
    source_roots = _declared_root_files(offline_manifest)
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(
        prefix=f".{output_dir.name}.runtime-test-", dir=output_dir.parent
    ))
    try:
        formal_roots: dict[str, list[dict]] = {root: [] for root in ROOT_NAMES}
        for root_name in ROOT_NAMES:
            for logical, claim in sorted(source_roots[root_name].items()):
                source = offline_package / "roots" / root_name / Path(*logical.split("/"))
                target = staging / "roots" / root_name / Path(*logical.split("/"))
                source_raw, stored_raw = _copy_runtime_payload(
                    source,
                    target,
                    anchor=offline_package,
                    logical_path=logical,
                )
                expected_sha = claim.get("sha256")
                expected_size = claim.get("size")
                if (
                    _sha256(source_raw) != expected_sha
                    or len(source_raw) != expected_size
                ):
                    raise ReleasePackError(f"offline payload drift: {root_name}:{logical}")
                formal_roots[root_name].append({
                    "logical_path": logical,
                    "sha256": _sha256(stored_raw),
                    "size": len(stored_raw),
                })
        qa_entries = offline_manifest.get("qa")
        if not isinstance(qa_entries, list):
            raise ReleasePackError("offline QA inventory is missing")
        formal_qa_files: list[dict] = []
        for item in qa_entries:
            if not isinstance(item, dict) or not isinstance(item.get("path"), str):
                raise ReleasePackError("offline QA entry is invalid")
            relative = item["path"]
            if not relative.startswith("qa/"):
                raise ReleasePackError(f"offline QA path escapes qa/: {relative}")
            logical = relative[3:]
            raw = _copy_exact(
                offline_package / Path(*relative.split("/")),
                staging / "qa" / Path(*logical.split("/")),
                anchor=offline_package,
            )
            if _sha256(raw) != item.get("sha256"):
                raise ReleasePackError(f"offline QA drift: {relative}")
            formal_qa_files.append({
                "logical_path": logical,
                "sha256": _sha256(raw),
                "size": len(raw),
            })
        client_base = offline_manifest.get("client_base")
        if not isinstance(client_base, dict):
            raise ReleasePackError("offline client-base evidence is missing")
        required_base = (
            client_base.get("required_capability")
            or client_base.get("capability")
            or "dual_form_v1"
        )
        if required_base != "dual_form_v1":
            raise ReleasePackError("offline client-base capability mismatch")
        manifest = {
            "schema_version": 1,
            "package_id": "seris_dragon_king",
            "character_id": 129999,
            "code_name": "seris_dragon_king",
            "package_version": str(offline_manifest.get("package_version")),
            "requires_client_base": "dual_form_v1",
            "required_capabilities": [
                "ModDualForm", "SpecialPixelSlot", "MatchedCutin", "MatchedVoice",
            ],
            "roots": formal_roots,
            "tables": _formal_table_claims(offline_manifest, staging),
            "skills": {
                "programs": offline_manifest.get("skills", []),
                "human_hits": {"water": 6, "thunder": 4},
                "dragon_hits": {"water": 5, "thunder": 5},
            },
            "unique_condition": {
                "id": 22,
                "duration_frames": 1800,
                "source": offline_manifest.get("unique_condition", {}),
            },
            "qa": {
                "delivery_mode": "runtime_test",
                "release_ready": False,
                "user_authorized_direct_real_test": True,
                "runtime_matrix_status": "pending",
                "files": formal_qa_files,
                "client_base": client_base,
            },
            "snapshot": {
                "offline_manifest_sha256": _sha256(offline_manifest_raw),
                "generator_git_head": git_head,
                "rollback_package_id": "seris_dragon_king-forward-rollback",
            },
        }
        manifest_raw = character_pack.canonical_manifest_bytes(manifest)
        with (staging / "manifest.json").open("xb") as stream:
            stream.write(manifest_raw)
            stream.flush()
            os.fsync(stream.fileno())
        errors = validate_runtime_test_package(staging)
        if errors:
            raise ReleasePackError(
                "formal runtime-test package validation failed:\n- "
                + "\n- ".join(errors)
            )
        os.replace(staging, output_dir)
        final_errors = validate_runtime_test_package(output_dir)
        if final_errors:
            raise ReleasePackError(
                "renamed runtime-test package validation failed:\n- "
                + "\n- ".join(final_errors)
            )
        return RuntimeTestPackageResult(
            output_dir=output_dir,
            manifest_sha256=_sha256(manifest_raw),
            root_counts={root: len(formal_roots[root]) for root in ROOT_NAMES},
            payload_count=sum(len(formal_roots[root]) for root in ROOT_NAMES),
        )
    except Exception:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
        if output_dir.exists():
            shutil.rmtree(output_dir, ignore_errors=True)
        raise


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--offline-package", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--git-head", required=True)
    parser.add_argument("--confirm", required=True)
    args = parser.parse_args(argv)
    try:
        result = assemble_runtime_test_package(
            args.offline_package,
            args.output,
            git_head=args.git_head,
            confirmation=args.confirm,
        )
    except (OSError, ValueError, ReleasePackError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    print(_canonical({
        "output": str(result.output_dir),
        "manifest_sha256": result.manifest_sha256,
        "payload_count": result.payload_count,
        "root_counts": dict(result.root_counts),
        "delivery_mode": "runtime_test",
        "release_ready": False,
        "writes_live": False,
    }).decode("utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
