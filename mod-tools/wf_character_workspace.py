# -*- coding: utf-8 -*-
"""可续作的新角色 package 工作区。

这里唯一允许的写入目标是调用者提供的 workspace 根。模块不解析 profile、不读取 live
store，也不导入 GUI；发布前的真实写入仍由 ``wf_character_pack``/``wf_release`` 独占。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from wf_character_requirements import build_requirement_report, char_asset_requirements


_CODE_RE = re.compile(r"^[a-z][a-z0-9_]*$")
_PACKAGE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
_ROOT_NAMES = ("common", "medium", "android", "server")
_WORKSPACE_KEYS = {
    "schema_version",
    "package_id",
    "template_character_id",
    "character_id",
    "code_name",
    "package_dir",
}


class WorkspaceError(RuntimeError):
    pass


@dataclass(frozen=True)
class Workspace:
    root: Path
    package_dir: Path
    evidence_dir: Path
    package_id: str
    template_character_id: int
    character_id: int
    code_name: str


@dataclass(frozen=True)
class WorkspaceStatus:
    workspace: str
    input_digest: str
    output_digest: str
    file_count: int
    hash_cache_hits: int
    completed_paths: tuple[str, ...]
    requirement_report: dict[str, Any]
    manifest_errors: tuple[str, ...]
    three_layer_claim_status: dict[str, bool]
    release_ready: bool
    next_command: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": 1,
            "workspace": self.workspace,
            "input_digest": self.input_digest,
            "output_digest": self.output_digest,
            "file_count": self.file_count,
            "hash_cache_hits": self.hash_cache_hits,
            "completed_paths": list(self.completed_paths),
            "requirement_report": self.requirement_report,
            "manifest_errors": list(self.manifest_errors),
            "three_layer_claim_status": self.three_layer_claim_status,
            "release_ready": self.release_ready,
            "next_command": self.next_command,
        }


def _absolute(path: Path) -> Path:
    return Path(os.path.abspath(os.fspath(path)))


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _is_reparse(path: Path) -> bool:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    if stat.S_ISLNK(info.st_mode):
        return True
    attributes = getattr(info, "st_file_attributes", 0)
    flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return bool(attributes & flag)


def _path_has_reparse_component(path: Path) -> bool:
    current = _absolute(path)
    existing: list[Path] = []
    while True:
        if current.exists() or current.is_symlink():
            existing.append(current)
        if current.parent == current:
            break
        current = current.parent
    return any(_is_reparse(item) for item in existing)


def _canonical_bytes(payload: Any) -> bytes:
    return json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    ).encode("utf-8")


def _atomic_bytes(path: Path, raw: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("wb") as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _atomic_json(path: Path, payload: Any) -> None:
    raw = json.dumps(
        payload, ensure_ascii=False, indent=2, sort_keys=True,
    ).encode("utf-8") + b"\n"
    _atomic_bytes(path, raw)


def _validated_id(value: int, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise WorkspaceError(f"{label} character ID must be a positive integer")
    return value


def _workspace_payload(
    template_id: int,
    character_id: int,
    code_name: str,
    package_id: str,
) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "package_id": package_id,
        "template_character_id": template_id,
        "character_id": character_id,
        "code_name": code_name,
        "package_dir": "package",
    }


def _draft_manifest(character_id: int, code_name: str, package_id: str) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "package_id": package_id,
        "character_id": character_id,
        "code_name": code_name,
        "package_version": "0.0.0-draft",
        "requires_client_base": "UNSET",
        "required_capabilities": [],
        "roots": {name: [] for name in _ROOT_NAMES},
        "tables": [],
        "skills": {},
        "unique_condition": {},
        "qa": {
            "delivery_mode": "production",
            "release_ready": False,
            "required_assets_total": 37,
            "required_assets_present": 0,
            "workspace_input_sha256": "",
        },
        "snapshot": {},
    }


def init_workspace(
    root: Path,
    template_id: int,
    character_id: int,
    code_name: str,
    package_id: str,
) -> Workspace:
    template_id = _validated_id(template_id, "template")
    character_id = _validated_id(character_id, "target")
    if template_id == character_id:
        raise WorkspaceError("template and target character IDs must differ")
    if not _CODE_RE.fullmatch(code_name):
        raise WorkspaceError("code_name must match ^[a-z][a-z0-9_]*$")
    if not _PACKAGE_RE.fullmatch(package_id):
        raise WorkspaceError("package_id must match ^[a-z0-9][a-z0-9_-]*$")

    parent = _absolute(Path(root))
    destination = _absolute(parent / package_id)
    if not _is_within(destination, parent) or destination == parent:
        raise WorkspaceError("package_id escapes the workspace root")
    if _path_has_reparse_component(parent) or _path_has_reparse_component(destination):
        raise WorkspaceError("workspace path contains a reparse component")
    if destination.exists() and any(destination.iterdir()):
        raise WorkspaceError(f"workspace destination is non-empty: {destination}")

    package_dir = destination / "package"
    evidence_dir = destination / "evidence"
    for root_name in _ROOT_NAMES:
        (package_dir / "roots" / root_name).mkdir(parents=True, exist_ok=True)
    evidence_dir.mkdir(parents=True, exist_ok=True)
    _atomic_json(
        destination / "workspace.json",
        _workspace_payload(template_id, character_id, code_name, package_id),
    )
    _atomic_json(package_dir / "manifest.json", _draft_manifest(character_id, code_name, package_id))
    return load_workspace(destination)


def load_workspace(root: Path) -> Workspace:
    workspace_root = _absolute(Path(root))
    if _path_has_reparse_component(workspace_root):
        raise WorkspaceError("workspace path contains a reparse component")
    config_path = workspace_root / "workspace.json"
    try:
        payload = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise WorkspaceError(f"invalid workspace.json: {exc}") from exc
    if not isinstance(payload, dict) or set(payload) != _WORKSPACE_KEYS:
        raise WorkspaceError("workspace.json has invalid or unknown fields")
    if payload.get("schema_version") != 1:
        raise WorkspaceError("unsupported workspace schema_version")
    package_id = payload.get("package_id")
    code_name = payload.get("code_name")
    if not isinstance(package_id, str) or not _PACKAGE_RE.fullmatch(package_id):
        raise WorkspaceError("invalid package_id in workspace.json")
    if not isinstance(code_name, str) or not _CODE_RE.fullmatch(code_name):
        raise WorkspaceError("invalid code_name in workspace.json")
    template_id = _validated_id(payload.get("template_character_id"), "template")
    character_id = _validated_id(payload.get("character_id"), "target")
    if payload.get("package_dir") != "package":
        raise WorkspaceError("package_dir must be the relative path 'package'")
    package_dir = _absolute(workspace_root / "package")
    if not _is_within(package_dir, workspace_root):
        raise WorkspaceError("package_dir escapes workspace")
    for root_name in _ROOT_NAMES:
        root_path = package_dir / "roots" / root_name
        if not root_path.is_dir():
            raise WorkspaceError(f"package root is missing: {root_name}")
    return Workspace(
        root=workspace_root,
        package_dir=package_dir,
        evidence_dir=workspace_root / "evidence",
        package_id=package_id,
        template_character_id=template_id,
        character_id=character_id,
        code_name=code_name,
    )


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _load_hash_cache(path: Path) -> dict[str, dict[str, Any]]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return {}
    if not isinstance(payload, dict):
        return {}
    return {
        key: value for key, value in payload.items()
        if isinstance(key, str) and isinstance(value, dict)
    }


def _semantic_manifest_digest(path: Path) -> tuple[int, str] | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    normalized = json.loads(json.dumps(payload))
    qa = normalized.get("qa")
    if isinstance(qa, dict) and "workspace_input_sha256" in qa:
        qa["workspace_input_sha256"] = ""
    data = _canonical_bytes(normalized)
    return len(data), hashlib.sha256(data).hexdigest()


def _scan_package(workspace: Workspace) -> tuple[list[dict[str, Any]], int, dict[str, str]]:
    cache_path = workspace.evidence_dir / "hash-cache.json"
    old_cache = _load_hash_cache(cache_path)
    new_cache: dict[str, dict[str, Any]] = {}
    entries: list[dict[str, Any]] = []
    raw_hashes: dict[str, str] = {}
    cache_hits = 0
    for path in sorted(workspace.package_dir.rglob("*"), key=lambda item: item.as_posix()):
        if _is_reparse(path):
            raise WorkspaceError(f"package file is a reparse point: {path.name}")
        if path.is_dir():
            continue
        relative = path.relative_to(workspace.package_dir).as_posix()
        info = path.stat()
        cached = old_cache.get(relative)
        if (
            cached
            and cached.get("size") == info.st_size
            and cached.get("mtime_ns") == info.st_mtime_ns
            and isinstance(cached.get("sha256"), str)
        ):
            digest = cached["sha256"]
            cache_hits += 1
        else:
            digest = _sha256_file(path)
        raw_hashes[relative] = digest
        new_cache[relative] = {
            "size": info.st_size,
            "mtime_ns": info.st_mtime_ns,
            "sha256": digest,
        }
        semantic_size = info.st_size
        semantic_digest = digest
        if relative == "manifest.json":
            semantic = _semantic_manifest_digest(path)
            if semantic is not None:
                semantic_size, semantic_digest = semantic
        entries.append({"path": relative, "size": semantic_size, "sha256": semantic_digest})
    _atomic_json(cache_path, new_cache)
    return entries, cache_hits, raw_hashes


def _manifest_state(
    workspace: Workspace,
    input_digest: str,
    raw_hashes: Mapping[str, str],
) -> tuple[dict[str, Any], list[str]]:
    manifest_path = workspace.package_dir / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return {}, [f"invalid manifest.json: {exc}"]
    errors: list[str] = []
    if not isinstance(manifest, dict):
        return {}, ["manifest.json must be an object"]
    for key, expected in (
        ("package_id", workspace.package_id),
        ("character_id", workspace.character_id),
        ("code_name", workspace.code_name),
    ):
        if manifest.get(key) != expected:
            errors.append(f"manifest {key} does not match workspace")
    roots = manifest.get("roots")
    if not isinstance(roots, dict) or set(roots) != set(_ROOT_NAMES):
        errors.append("manifest roots must contain common, medium, android and server")
    else:
        for root_name in _ROOT_NAMES:
            claims = roots[root_name]
            if not isinstance(claims, list):
                errors.append(f"manifest root {root_name} must be an array")
                continue
            for index, claim in enumerate(claims):
                if not isinstance(claim, dict):
                    errors.append(f"manifest {root_name}[{index}] must be an object")
                    continue
                logical = claim.get("logical_path")
                if not isinstance(logical, str) or not logical or "\\" in logical or logical.startswith("/"):
                    errors.append(f"manifest {root_name}[{index}] has unsafe logical_path")
                    continue
                relative = f"roots/{root_name}/{logical}"
                actual = raw_hashes.get(relative)
                if actual is None:
                    errors.append(f"manifest file is missing: {root_name}:{logical}")
                elif claim.get("sha256") != actual:
                    errors.append(f"manifest hash mismatch: {root_name}:{logical}")
                path = workspace.package_dir / Path(relative)
                if path.is_file() and claim.get("size") != path.stat().st_size:
                    errors.append(f"manifest size mismatch: {root_name}:{logical}")
    qa = manifest.get("qa")
    if not isinstance(qa, dict):
        errors.append("manifest qa must be an object")
    elif qa.get("workspace_input_sha256") not in ("", input_digest):
        errors.append("manifest workspace_input_sha256 does not match status")
    return manifest, errors


def _strip_root(relative: str) -> tuple[str, str] | None:
    parts = relative.split("/", 2)
    if len(parts) != 3 or parts[0] != "roots" or parts[1] not in _ROOT_NAMES:
        return None
    return parts[1], parts[2]


def workspace_status(workspace: Workspace | Path) -> WorkspaceStatus:
    current = load_workspace(workspace.root if isinstance(workspace, Workspace) else workspace)
    entries, cache_hits, raw_hashes = _scan_package(current)
    input_digest = hashlib.sha256(_canonical_bytes(entries)).hexdigest()

    rooted = [item for item in (_strip_root(entry["path"]) for entry in entries) if item]
    completed = tuple(sorted({logical for _, logical in rooted}))
    client_existing = {
        logical for root_name, logical in rooted if root_name in {"common", "medium", "android"}
    }
    requirements = char_asset_requirements(current.code_name)
    requirement_report = build_requirement_report(requirements, client_existing)
    manifest, manifest_errors = _manifest_state(current, input_digest, raw_hashes)

    server_paths = {logical for root_name, logical in rooted if root_name == "server"}
    roots = manifest.get("roots", {}) if isinstance(manifest, dict) else {}
    tables = manifest.get("tables", []) if isinstance(manifest, dict) else []
    layer_status = {
        "layer_1_cdndata": {
            "cdndata/character.json",
            "cdndata/character_text.json",
        }.issubset(server_paths),
        "layer_2_client": bool(
            isinstance(tables, list)
            and tables
            and any(isinstance(roots.get(name), list) and roots.get(name)
                    for name in ("common", "medium", "android"))
        ),
        "server_character": "character.json" in server_paths,
    }
    layer_status["consistent"] = all(layer_status.values())
    qa = manifest.get("qa", {}) if isinstance(manifest, dict) else {}
    qa_ready = bool(
        isinstance(qa, dict)
        and qa.get("release_ready") is True
        and qa.get("required_assets_total") == 37
        and qa.get("required_assets_present") == 37
        and qa.get("workspace_input_sha256") == input_digest
    )
    release_ready = bool(
        requirement_report["release_ready"]
        and not manifest_errors
        and layer_status["consistent"]
        and qa_ready
    )
    if release_ready:
        next_command = (
            f"python mod-tools/wf_character_flow.py publish --workspace "
            f"work/character_packs/{current.package_id} --confirm PUBLISH_CHARACTER_PACKAGE"
        )
    elif manifest_errors:
        next_command = "修正 package/manifest.json 后重新运行 preflight"
    elif requirement_report["missing_required"]:
        next_command = "补齐 requirement_report.missing_required 后重新运行 status"
    else:
        next_command = (
            f"python mod-tools/wf_character_flow.py preflight --workspace "
            f"work/character_packs/{current.package_id}"
        )

    base_payload = {
        "schema_version": 1,
        "workspace": current.package_id,
        "input_digest": input_digest,
        "file_count": len(entries),
        "hash_cache_hits": cache_hits,
        "completed_paths": list(completed),
        "requirement_report": requirement_report,
        "manifest_errors": manifest_errors,
        "three_layer_claim_status": layer_status,
        "release_ready": release_ready,
        "next_command": next_command,
    }
    output_digest = hashlib.sha256(_canonical_bytes(base_payload)).hexdigest()
    status = WorkspaceStatus(
        workspace=current.package_id,
        input_digest=input_digest,
        output_digest=output_digest,
        file_count=len(entries),
        hash_cache_hits=cache_hits,
        completed_paths=completed,
        requirement_report=requirement_report,
        manifest_errors=tuple(manifest_errors),
        three_layer_claim_status=layer_status,
        release_ready=release_ready,
        next_command=next_command,
    )
    _atomic_json(current.evidence_dir / "status.json", status.to_dict())
    return status


def seal_workspace(workspace: Workspace | Path) -> WorkspaceStatus:
    """Bind a complete production package to its stable semantic input digest."""
    current = load_workspace(
        workspace.root if isinstance(workspace, Workspace) else workspace
    )
    before = workspace_status(current)
    report = before.requirement_report
    allowed_errors = {
        "manifest workspace_input_sha256 does not match status",
    }
    unexpected = set(before.manifest_errors) - allowed_errors
    if (
        report.get("required_total") != 37
        or report.get("required_present") != 37
        or report.get("release_ready") is not True
    ):
        raise WorkspaceError("production workspace must contain exactly 37/37 required assets")
    if unexpected:
        raise WorkspaceError(
            "production workspace manifest is invalid: " + "; ".join(sorted(unexpected))
        )
    if before.three_layer_claim_status.get("consistent") is not True:
        raise WorkspaceError("production workspace three-layer claims are incomplete")

    manifest_path = current.package_dir / "manifest.json"
    original_raw = manifest_path.read_bytes()
    try:
        manifest = json.loads(original_raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise WorkspaceError(f"invalid manifest.json: {exc}") from exc
    qa = manifest.get("qa") if isinstance(manifest, dict) else None
    if not isinstance(qa, dict) or qa.get("delivery_mode") != "production":
        raise WorkspaceError("only production workspaces can be sealed")
    qa.update({
        "release_ready": True,
        "required_assets_total": 37,
        "required_assets_present": 37,
        "workspace_input_sha256": "",
    })
    try:
        _atomic_json(manifest_path, manifest)
        binding = workspace_status(current)
        qa["workspace_input_sha256"] = binding.input_digest
        _atomic_json(manifest_path, manifest)
        sealed = workspace_status(current)
        if not sealed.release_ready:
            raise WorkspaceError("sealed workspace did not pass release readiness checks")
        return sealed
    except Exception:
        _atomic_bytes(manifest_path, original_raw)
        raise
