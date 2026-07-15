# -*- coding: utf-8 -*-
from __future__ import annotations

import json
import os
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from wf_asset_inventory import InventoryEntry


AUTO_CATEGORIES = frozenset(
    {"exact_duplicate", "proven_regenerable", "stale_cache", "retention_expired"}
)
_POLICY_KEYS = frozenset(
    {
        "schema_version",
        "scan_roots",
        "protected_roots",
        "backup_keep_latest",
        "backup_markers",
        "auto_categories",
        "stale_cache_directory_names",
        "stale_cache_suffixes",
    }
)


class PolicyError(RuntimeError):
    pass


def _path_key(path: Path | str) -> str:
    return os.path.normcase(os.path.abspath(os.fspath(path)))


def _is_within(path: Path | str, root: Path | str) -> bool:
    path_key = _path_key(path)
    root_key = _path_key(root)
    try:
        return os.path.commonpath([path_key, root_key]) == root_key
    except ValueError:
        return False


def _relative_policy_path(repo_root: Path, raw: object, field_name: str) -> Path:
    if not isinstance(raw, str) or not raw.strip():
        raise PolicyError(f"{field_name} entries must be non-empty strings")
    value = Path(raw)
    if value.is_absolute() or value.drive or any(part in {"", ".", ".."} for part in value.parts):
        raise PolicyError(f"unsafe {field_name} entry: {raw}")
    result = Path(os.path.abspath(repo_root / value))
    if not _is_within(result, repo_root):
        raise PolicyError(f"{field_name} leaves repository: {raw}")
    return result


def _load_json(path: Path) -> Any:
    def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise PolicyError(f"duplicate JSON key: {key}")
            result[key] = value
        return result

    try:
        return json.loads(path.read_text(encoding="utf-8-sig"), object_pairs_hook=reject_duplicates)
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise PolicyError(f"cannot load policy {path}: {error}") from error


@dataclass(frozen=True, slots=True)
class Policy:
    source: Path
    repo_root: Path
    scan_roots: tuple[Path, ...]
    protected_roots: tuple[Path, ...]
    backup_keep_latest: int
    backup_markers: tuple[str, ...]
    auto_categories: frozenset[str]
    stale_cache_directory_names: frozenset[str]
    stale_cache_suffixes: frozenset[str]

    @classmethod
    def load(
        cls,
        path: Path,
        *,
        repo_root: Path | None = None,
        quarantine_root: Path | None = None,
    ) -> "Policy":
        source = Path(path).resolve(strict=True)
        root = Path(os.path.abspath(repo_root if repo_root is not None else source.parent.parent))
        payload = _load_json(source)
        if not isinstance(payload, dict):
            raise PolicyError("policy root must be an object")
        unknown = sorted(set(payload) - _POLICY_KEYS)
        if unknown:
            raise PolicyError(f"unknown policy keys: {', '.join(unknown)}")
        missing = sorted(_POLICY_KEYS - set(payload))
        if missing:
            raise PolicyError(f"missing policy keys: {', '.join(missing)}")
        if payload.get("schema_version") != 1:
            raise PolicyError("policy schema_version must be 1")

        raw_scan = payload.get("scan_roots")
        raw_protected = payload.get("protected_roots")
        if not isinstance(raw_scan, list) or not raw_scan:
            raise PolicyError("scan_roots must be a non-empty array")
        if not isinstance(raw_protected, list):
            raise PolicyError("protected_roots must be an array")
        scan_roots = tuple(_relative_policy_path(root, item, "scan_roots") for item in raw_scan)
        protected_roots = tuple(
            _relative_policy_path(root, item, "protected_roots") for item in raw_protected
        )
        if len({_path_key(item) for item in scan_roots}) != len(scan_roots):
            raise PolicyError("scan_roots contain duplicates")

        keep_latest = payload.get("backup_keep_latest")
        if isinstance(keep_latest, bool) or not isinstance(keep_latest, int) or keep_latest < 3:
            raise PolicyError("backup_keep_latest must be an integer of at least 3")

        def string_tuple(field_name: str) -> tuple[str, ...]:
            raw = payload.get(field_name)
            if not isinstance(raw, list) or not raw or not all(isinstance(item, str) and item for item in raw):
                raise PolicyError(f"{field_name} must be a non-empty string array")
            if len(set(raw)) != len(raw):
                raise PolicyError(f"{field_name} contains duplicates")
            return tuple(raw)

        backup_markers = string_tuple("backup_markers")
        configured_auto = frozenset(string_tuple("auto_categories"))
        if not configured_auto.issubset(AUTO_CATEGORIES):
            raise PolicyError("auto_categories contains a forbidden category")
        cache_names = frozenset(item.casefold() for item in string_tuple("stale_cache_directory_names"))
        cache_suffixes = frozenset(item.casefold() for item in string_tuple("stale_cache_suffixes"))
        if not all(item.startswith(".") for item in cache_suffixes):
            raise PolicyError("stale_cache_suffixes must start with a dot")

        if quarantine_root is not None:
            quarantine = Path(os.path.abspath(quarantine_root))
            for scan_root in scan_roots:
                if _is_within(quarantine, scan_root):
                    raise PolicyError(
                        f"quarantine root must not be inside scan root: {quarantine} inside {scan_root}"
                    )

        return cls(
            source=source,
            repo_root=root,
            scan_roots=scan_roots,
            protected_roots=protected_roots,
            backup_keep_latest=keep_latest,
            backup_markers=backup_markers,
            auto_categories=configured_auto,
            stale_cache_directory_names=cache_names,
            stale_cache_suffixes=cache_suffixes,
        )

    def protected_match(self, path: Path) -> Path | None:
        for root in self.protected_roots:
            if _is_within(path, root):
                return root
        return None


@dataclass(slots=True)
class ReferenceIndex:
    paths: set[Path | str] = field(default_factory=set)
    roots: set[Path | str] = field(default_factory=set)
    evidence: dict[str, list[str]] = field(default_factory=dict)
    _path_keys: set[str] = field(init=False, default_factory=set)
    _root_keys: set[str] = field(init=False, default_factory=set)

    def __post_init__(self) -> None:
        original_paths = tuple(self.paths)
        original_roots = tuple(self.roots)
        self.paths = set()
        self.roots = set()
        for path in original_paths:
            self.add_path(Path(path), "explicit reference")
        for root in original_roots:
            self.add_root(Path(root), "explicit reference root")

    def add_path(self, path: Path, reason: str) -> None:
        absolute = Path(os.path.abspath(path))
        key = _path_key(absolute)
        self.paths.add(absolute)
        self._path_keys.add(key)
        self.evidence.setdefault(key, []).append(reason)

    def add_root(self, root: Path, reason: str) -> None:
        absolute = Path(os.path.abspath(root))
        key = _path_key(absolute)
        self.roots.add(absolute)
        self._root_keys.add(key)
        self.evidence.setdefault(key, []).append(reason)

    def is_referenced(self, path: Path) -> bool:
        key = _path_key(path)
        if key in self._path_keys:
            return True
        return any(_is_within(key, root) for root in self._root_keys)

    def reasons(self, path: Path) -> tuple[str, ...]:
        key = _path_key(path)
        reasons = list(self.evidence.get(key, ()))
        for root in self._root_keys:
            if _is_within(key, root):
                reasons.extend(self.evidence.get(root, ()))
        return tuple(dict.fromkeys(reasons))

    @classmethod
    def from_project(
        cls,
        repo_root: Path,
        cdn_graph_json: Path | None = None,
    ) -> "ReferenceIndex":
        root = Path(os.path.abspath(repo_root))
        index = cls()

        def add_if_exists(path: Path, reason: str) -> None:
            if path.exists() or path.is_symlink():
                index.add_path(path, reason)

        profiles_path = root / "mod-tools" / "profiles.json"
        add_if_exists(profiles_path, "mod-tool profile configuration")
        if profiles_path.is_file():
            try:
                profiles = json.loads(profiles_path.read_text(encoding="utf-8-sig"))
                for profile in (profiles.get("profiles", {}) if isinstance(profiles, dict) else {}).values():
                    if not isinstance(profile, dict):
                        continue
                    for field_name in ("store", "cdndata"):
                        raw = profile.get(field_name)
                        if isinstance(raw, str) and raw:
                            candidate = Path(raw)
                            if not candidate.is_absolute():
                                candidate = root / candidate
                            index.add_root(candidate, f"profiles.json {field_name}")
            except (OSError, UnicodeError, json.JSONDecodeError):
                pass

        active = root / ".cdn" / "cn" / "character-releases" / "active.json"
        add_if_exists(active, "active character release manifest")
        if active.is_file():
            try:
                payload = json.loads(active.read_text(encoding="utf-8-sig"))
                for release in payload.get("releases", []):
                    if not isinstance(release, dict):
                        continue
                    for archive in release.get("archives", []):
                        if isinstance(archive, dict):
                            raw = archive.get("relative_path")
                            if isinstance(raw, str) and raw:
                                index.add_path(root / ".cdn" / "cn" / Path(raw), "active character archive")
            except (OSError, UnicodeError, json.JSONDecodeError, AttributeError):
                pass

        if cdn_graph_json is not None:
            graph_path = Path(cdn_graph_json)
            add_if_exists(graph_path, "validated CDN graph evidence")
            if graph_path.is_file():
                try:
                    graph = json.loads(graph_path.read_text(encoding="utf-8-sig"))
                    for edge in graph.get("edges", []):
                        if not isinstance(edge, dict):
                            continue
                        for archive in edge.get("archives", []):
                            if not isinstance(archive, dict):
                                continue
                            raw = archive.get("absolute_path") or archive.get("relativePath") or archive.get("relative_path")
                            if not isinstance(raw, str) or not raw:
                                continue
                            candidate = Path(raw)
                            if not candidate.is_absolute():
                                normalized = raw.replace("\\", "/")
                                if normalized.startswith("asset-patch/"):
                                    candidate = root / "assets" / Path(normalized)
                                elif normalized.startswith("assets/") or normalized.startswith(".cdn/"):
                                    candidate = root / Path(normalized)
                                else:
                                    candidate = root / ".cdn" / "cn" / Path(normalized)
                            index.add_path(candidate, "selected validated CDN edge")
                except (OSError, UnicodeError, json.JSONDecodeError, AttributeError):
                    pass

        index.add_root(root / ".database", "live database and snapshots")
        for relative in (
            ".cdn/cn/archive-common-full",
            ".cdn/cn/archive-medium-full",
            ".cdn/cn/archive-android-full",
            ".cdn/cn/EntityLists",
            ".cdn/cn/entities",
            "work/character_releases",
            "work/char_snapshots",
            "work/char_gen",
            "work/ai_canary",
            "work/asset_exports",
            "work/remediation",
            "mod-tools/work/char_snapshots",
            "mod-tools/work/char_gen",
        ):
            index.add_root(root / Path(relative), "fixed live runtime or generator root")

        for relative in (
            "assets/asset-patch/manifest.json",
            "mod-tools/work/changelog.jsonl",
            "mod-tools/work/changelog.md",
            "mod-tools/work/sync_pending.json",
            "mod-tools/work/rogue_auto.json",
            "弹国服/wf_restore_package.py",
        ):
            add_if_exists(root / Path(relative), "fixed runtime evidence")

        assets_root = root / "assets"
        if assets_root.is_dir():
            for child in assets_root.iterdir():
                folded = child.name.casefold()
                if child.is_file() and ".bak-" not in folded:
                    index.add_path(child, "active server asset")
                elif child.is_dir() and child.name in {
                    "asset_lists",
                    "cdndata",
                    "gacha_movie_configs",
                }:
                    index.add_root(child, "active server asset root")

        changelog = root / "mod-tools" / "work" / "changelog.jsonl"
        if changelog.is_file():
            try:
                with changelog.open(encoding="utf-8-sig") as stream:
                    for line in stream:
                        if not line.strip():
                            continue
                        record = json.loads(line)
                        backup = record.get("backup") if isinstance(record, dict) else None
                        if isinstance(backup, str) and backup:
                            candidate = Path(backup)
                            if not candidate.is_absolute():
                                candidate = root / candidate
                            if _is_within(candidate, root) and (
                                candidate.exists() or candidate.is_symlink()
                            ):
                                index.add_path(candidate, "backup referenced by modifier changelog")
            except (OSError, UnicodeError, json.JSONDecodeError):
                pass

        search_roots = [root, root / "mod-tools", root / "弹国服"]
        protected_names = {
            "harvestedpaths.csv",
            "pathlist.csv",
            "wf_pathlist_recovered.csv",
            "wf_pathlist_uncovered.csv",
            "_pathlist_recovered.csv",
            "_pathlist_restored.txt",
        }
        for search_root in search_roots:
            if not search_root.is_dir():
                continue
            for child in search_root.iterdir():
                folded = child.name.casefold()
                if (
                    child.is_file()
                    and (
                        folded.endswith(".pathlist")
                        or folded in protected_names
                        or folded.startswith("wf_pathlist_recovered")
                    )
                ):
                    index.add_path(child, "path recovery source or evidence")
        return index


@dataclass(frozen=True, slots=True)
class Decision:
    path: Path
    category: str
    reason: str
    evidence: tuple[str, ...]
    auto_approved: bool


@dataclass(frozen=True, slots=True)
class BackupDecision:
    path: Path
    category: str
    reason: str
    auto_approved: bool


def _evidence_for(
    values: Mapping[Path | str, str] | Iterable[Path | str] | None,
    path: Path,
) -> str | None:
    if values is None:
        return None
    target = _path_key(path)
    if isinstance(values, Mapping):
        for candidate, reason in values.items():
            if _path_key(candidate) == target:
                return str(reason)
        return None
    return "explicit evidence" if any(_path_key(candidate) == target for candidate in values) else None


def classify(
    entry: InventoryEntry,
    references: ReferenceIndex,
    policy: Policy,
    *,
    exact_duplicates: Mapping[Path | str, str] | Iterable[Path | str] | None = None,
    proven_regenerable: Mapping[Path | str, str] | Iterable[Path | str] | None = None,
    retention_expired: Mapping[Path | str, str] | Iterable[Path | str] | None = None,
) -> Decision:
    path = entry.absolute_path
    protected = policy.protected_match(path)
    if protected is not None:
        return Decision(path, "protected", f"inside protected root {protected}", (str(protected),), False)
    if references.is_referenced(path):
        reasons = references.reasons(path)
        return Decision(path, "live_referenced", "referenced by live project evidence", reasons, False)
    if entry.kind == "error" or entry.error:
        return Decision(path, "corrupt", entry.error or "inventory read failed", (), False)
    if entry.reparse or entry.kind == "reparse":
        return Decision(path, "unknown", "reparse points are never auto-classified", (), False)

    duplicate_reason = _evidence_for(exact_duplicates, path)
    if duplicate_reason is not None:
        category = "exact_duplicate"
        return Decision(path, category, duplicate_reason, (duplicate_reason,), category in policy.auto_categories)
    regenerate_reason = _evidence_for(proven_regenerable, path)
    if regenerate_reason is not None:
        category = "proven_regenerable"
        return Decision(path, category, regenerate_reason, (regenerate_reason,), category in policy.auto_categories)

    parts = {part.casefold() for part in path.parts}
    if parts & policy.stale_cache_directory_names or path.suffix.casefold() in policy.stale_cache_suffixes:
        category = "stale_cache"
        return Decision(path, category, "matches explicit interpreter/tool cache rule", (), category in policy.auto_categories)

    retention_reason = _evidence_for(retention_expired, path)
    if retention_reason is not None:
        category = "retention_expired"
        return Decision(path, category, retention_reason, (retention_reason,), category in policy.auto_categories)
    return Decision(path, "unknown", "no sufficient evidence for automatic action", (), False)


def classify_backup_group(
    backups: Iterable[Path],
    *,
    keep_latest: int,
    referenced: Iterable[Path] = (),
    last_success: Path | None = None,
) -> tuple[BackupDecision, ...]:
    if keep_latest < 3:
        raise PolicyError("backup retention must keep at least three files")
    unique = {Path(os.path.abspath(path)) for path in backups}
    ordered = sorted(
        unique,
        key=lambda item: (
            item.stat().st_mtime_ns if item.exists() else 0,
            item.name.casefold(),
            item.name,
        ),
    )
    keep = set(ordered[-keep_latest:])
    referenced_keys = {_path_key(path) for path in referenced}
    keep.update(path for path in ordered if _path_key(path) in referenced_keys)
    if last_success is not None:
        success_key = _path_key(last_success)
        keep.update(path for path in ordered if _path_key(path) == success_key)
    decisions: list[BackupDecision] = []
    for path in ordered:
        if path in keep:
            decisions.append(BackupDecision(path, "protected", "backup retention keep set", False))
        else:
            decisions.append(BackupDecision(path, "retention_expired", "older than retained restore points", True))
    return tuple(decisions)
