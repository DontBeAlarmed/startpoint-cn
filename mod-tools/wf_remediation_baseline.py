# -*- coding: utf-8 -*-
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import subprocess
import sys
import uuid
from collections.abc import Callable, Mapping, Sequence
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


CommandRunner = Callable[[list[str], Path], str]
_SECRET_FRAGMENTS = ("TOKEN", "SECRET", "PASSWORD", "COOKIE", "PRIVATE", "API_KEY")


class BaselineError(RuntimeError):
    pass


def _run(argv: list[str], cwd: Path) -> str:
    completed = subprocess.run(
        argv,
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    return completed.stdout


def _reject_duplicate_keys(pairs: Sequence[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _reject_constant(value: str) -> None:
    raise ValueError(f"non-finite JSON value: {value}")


def _strict_json(path: Path) -> Any:
    return json.loads(
        path.read_text(encoding="utf-8"),
        object_pairs_hook=_reject_duplicate_keys,
        parse_constant=_reject_constant,
    )


def _relative_path(path: Path, root: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return path.name


def database_checks(repo_root: Path) -> dict[str, Any]:
    repo_root = Path(repo_root).resolve()
    database = repo_root / ".database" / "wdfp_data.db"
    if not database.is_file():
        return {
            "status": "missing",
            "database_file": ".database/wdfp_data.db",
            "quick_check": None,
            "foreign_key_check": [],
        }

    result: dict[str, Any] = {
        "status": "ok",
        "database_file": _relative_path(database, repo_root),
        "size": database.stat().st_size,
        "mtime_ns": database.stat().st_mtime_ns,
        "quick_check": None,
        "foreign_key_check": [],
    }
    uri = database.resolve().as_uri() + "?mode=ro"
    try:
        connection = sqlite3.connect(uri, uri=True, timeout=5.0)
        try:
            quick_rows = connection.execute("PRAGMA quick_check").fetchall()
            quick_values = [str(row[0]) for row in quick_rows]
            result["quick_check"] = "ok" if quick_values == ["ok"] else quick_values
            result["foreign_key_check"] = [list(row) for row in connection.execute("PRAGMA foreign_key_check")]
            if result["quick_check"] != "ok" or result["foreign_key_check"]:
                result["status"] = "invalid"
        finally:
            connection.close()
    except (OSError, sqlite3.Error) as error:
        result["status"] = "error"
        result["error"] = f"{type(error).__name__}: {error}"
    return result


def active_manifest_summary(repo_root: Path) -> dict[str, Any]:
    repo_root = Path(repo_root).resolve()
    manifest = repo_root / ".cdn" / "cn" / "character-releases" / "active.json"
    if not manifest.is_file():
        return {
            "status": "missing",
            "manifest": ".cdn/cn/character-releases/active.json",
            "base_version": None,
            "tail_version": None,
            "release_count": 0,
        }

    try:
        payload = _strict_json(manifest)
        if not isinstance(payload, dict):
            raise ValueError("active manifest must be an object")
        base_version = payload.get("base_version")
        releases = payload.get("releases")
        if not isinstance(base_version, str) or not base_version:
            raise ValueError("base_version must be a non-empty string")
        if not isinstance(releases, list):
            raise ValueError("releases must be an array")
        tail_version = base_version
        release_ids: list[str] = []
        for index, release in enumerate(releases):
            if not isinstance(release, dict):
                raise ValueError(f"releases[{index}] must be an object")
            version = release.get("version", release.get("to_version"))
            if not isinstance(version, str) or not version:
                raise ValueError(f"releases[{index}] has no target version")
            tail_version = version
            release_id = release.get("release_id")
            if isinstance(release_id, str) and release_id:
                release_ids.append(release_id)
        return {
            "status": "ok",
            "manifest": _relative_path(manifest, repo_root),
            "schema_version": payload.get("schema_version"),
            "base_version": base_version,
            "tail_version": tail_version,
            "release_count": len(releases),
            "release_ids": release_ids,
            "size": manifest.stat().st_size,
            "mtime_ns": manifest.stat().st_mtime_ns,
        }
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
        return {
            "status": "invalid",
            "manifest": _relative_path(manifest, repo_root),
            "error": f"{type(error).__name__}: {error}",
        }


def _safe_environment(env: Mapping[str, str]) -> dict[str, str]:
    result: dict[str, str] = {}
    for key in sorted(env):
        upper = key.upper()
        if not upper.startswith(("CN_", "CDN_")):
            continue
        if any(fragment in upper for fragment in _SECRET_FRAGMENTS):
            continue
        result[key] = str(env[key])
    return result


def _parse_unquoted_dotenv_value(raw: str) -> str:
    value = raw.strip()
    for index, character in enumerate(value):
        if character == "#" and (index == 0 or value[index - 1].isspace()):
            return value[:index].rstrip()
    return value


def effective_environment(
    repo_root: Path, process_env: Mapping[str, str]
) -> dict[str, str]:
    repo_root = Path(repo_root).resolve()
    merged: dict[str, str] = {}
    dotenv = repo_root / ".env"
    if dotenv.is_file():
        for index, original in enumerate(dotenv.read_text(encoding="utf-8-sig").splitlines(), 1):
            line = original.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[7:].lstrip()
            if "=" not in line:
                continue
            key, raw_value = line.split("=", 1)
            key = key.strip()
            if not key or not (key[0].isalpha() or key[0] == "_"):
                continue
            if not all(character.isalnum() or character == "_" for character in key):
                continue
            value = raw_value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
                value = value[1:-1]
            else:
                value = _parse_unquoted_dotenv_value(value)
            merged[key] = value
    merged.update({str(key): str(value) for key, value in process_env.items()})
    return _safe_environment(merged)


def _allocate_run_dir(output_root: Path) -> Path:
    output_root.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    for suffix in range(100):
        run_id = timestamp if suffix == 0 else f"{timestamp}-{suffix:02d}"
        run_dir = output_root / run_id
        try:
            run_dir.mkdir()
            return run_dir
        except FileExistsError:
            continue
    raise BaselineError(f"unable to allocate a unique run directory under {output_root}")


def atomic_json(path: Path, payload: Mapping[str, Any]) -> None:
    raw = (
        json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False)
        + "\n"
    ).encode("utf-8")
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("xb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def append_jsonl(path: Path, payload: Mapping[str, Any]) -> None:
    raw = (
        json.dumps(payload, ensure_ascii=False, sort_keys=True, allow_nan=False)
        + "\n"
    ).encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("ab") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())


# Backward-compatible private name for older callers.
_atomic_json = atomic_json


def capture_baseline(
    repo_root: Path,
    output_root: Path,
    env: Mapping[str, str],
    runner: CommandRunner = _run,
) -> Path:
    repo_root = Path(repo_root).resolve(strict=True)
    output_root = Path(output_root).resolve()
    run_dir = _allocate_run_dir(output_root)
    try:
        payload = {
            "schema_version": 1,
            "run_id": run_dir.name,
            "captured_at": datetime.now(timezone.utc).isoformat(),
            "repo_root": str(repo_root),
            "git": {
                "head": runner(["git", "rev-parse", "HEAD"], repo_root).strip(),
                "status": runner(["git", "status", "--short"], repo_root).splitlines(),
            },
            "environment": _safe_environment(env),
            "database": database_checks(repo_root),
            "character_release": active_manifest_summary(repo_root),
        }
        _atomic_json(run_dir / "baseline.json", payload)
        return run_dir
    except Exception:
        try:
            run_dir.rmdir()
        except OSError:
            pass
        raise


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Capture a redacted StartPoint remediation baseline")
    subparsers = parser.add_subparsers(dest="command", required=True)
    baseline = subparsers.add_parser("baseline", help="capture the current repository baseline")
    baseline.add_argument("--repo-root", required=True, type=Path)
    baseline.add_argument("--output-root", required=True, type=Path)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.command != "baseline":
        raise BaselineError(f"unsupported command: {args.command}")
    run_dir = capture_baseline(
        args.repo_root,
        args.output_root,
        effective_environment(args.repo_root, os.environ),
    )
    print(run_dir)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (BaselineError, OSError, subprocess.CalledProcessError) as error:
        print(f"baseline error: {error}", file=sys.stderr)
        raise SystemExit(2)
