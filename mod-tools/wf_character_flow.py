#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""新角色 package 的唯一编排入口：workspace → preflight → publish → rollback。"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, is_dataclass
from pathlib import Path
from typing import Any

import wf_character_pack as character_pack
import wf_character_workspace as workspace_module
import wf_release


class FlowError(RuntimeError):
    pass


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise FlowError(message)


def _parser() -> argparse.ArgumentParser:
    parser = _Parser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    init = sub.add_parser("init")
    init.add_argument("--root", type=Path, default=Path("work/character_packs"))
    init.add_argument("--template-id", required=True, type=int)
    init.add_argument("--character-id", required=True, type=int)
    init.add_argument("--code-name", required=True)
    init.add_argument("--package-id", required=True)

    for name in ("status", "preflight", "publish"):
        child = sub.add_parser(name)
        child.add_argument("--workspace", required=True, type=Path)
        if name in {"preflight", "publish"}:
            child.add_argument("--profile", default="cn")
            child.add_argument("--installed-package-dir", type=Path)
        if name == "publish":
            child.add_argument("--confirm", required=True)

    rebase = sub.add_parser("rebase")
    rebase.add_argument("--workspace", required=True, type=Path)
    rebase.add_argument("--profile", default="cn")
    rebase.add_argument("--output", type=Path)
    rebase.add_argument("--git-head")

    rollback = sub.add_parser("rollback")
    rollback.add_argument("--snapshot-dir", required=True, type=Path)
    rollback.add_argument("--profile", default="cn")
    rollback.add_argument("--installed-package-dir", type=Path)
    rollback.add_argument("--confirm", required=True)
    return parser


def _base_payload(
    *,
    stage: str,
    workspace: str | None,
    release_ready: bool,
    errors: list[str] | None = None,
    next_command: str | None = None,
    **extra: Any,
) -> dict[str, Any]:
    return {
        "ok": not errors,
        "stage": stage,
        "workspace": workspace,
        "release_ready": bool(release_ready),
        "errors": errors or [],
        "next_command": next_command,
        **extra,
    }


def _manifest_mode(workspace: workspace_module.Workspace) -> str:
    manifest = character_pack.load_manifest(workspace.package_dir / "manifest.json")
    qa = manifest.get("qa")
    if not isinstance(qa, dict) or qa.get("delivery_mode") not in {"production", "runtime_test"}:
        raise FlowError("manifest.qa.delivery_mode 必须是 production 或 runtime_test")
    return str(qa["delivery_mode"])


def _release_result_payload(result: Any) -> dict[str, Any]:
    if is_dataclass(result):
        values = asdict(result)
    else:
        values = dict(vars(result))
    archives = values.pop("archive_paths", ())
    snapshot = values.pop("snapshot_dir", None)
    return {
        **values,
        "archives": [str(path) for path in archives],
        "snapshot_dir": str(snapshot) if snapshot is not None else None,
    }


def run_command(
    argv: list[str] | None = None,
    *,
    release_module=wf_release,
) -> tuple[int, dict[str, Any]]:
    command = "unknown"
    workspace_path: str | None = None
    try:
        args = _parser().parse_args(argv)
        command = args.command
        if command == "init":
            workspace = workspace_module.init_workspace(
                args.root,
                args.template_id,
                args.character_id,
                args.code_name,
                args.package_id,
            )
            status = workspace_module.workspace_status(workspace)
            workspace_path = str(workspace.root)
            return 0, _base_payload(
                stage="init",
                workspace=workspace_path,
                release_ready=False,
                next_command=(
                    f"python mod-tools/wf_character_flow.py status --workspace "
                    f"{workspace.root}"
                ),
                package_id=workspace.package_id,
                character_id=workspace.character_id,
                code_name=workspace.code_name,
                status=status.to_dict(),
            )

        if command == "rollback":
            if args.confirm != "ROLLBACK_CHARACTER_PACKAGE":
                raise FlowError("回滚必须使用确认口令 ROLLBACK_CHARACTER_PACKAGE")
            try:
                import wf_character_rollback as rollback_module
            except ImportError as exc:
                raise FlowError("snapshot 回滚模块尚不可用") from exc
            result = rollback_module.publish_snapshot_rollback(
                args.snapshot_dir,
                profile_id=args.profile,
                confirmation=args.confirm,
                installed_package_dir=args.installed_package_dir,
            )
            return 0, _base_payload(
                stage="rollback",
                workspace=None,
                release_ready=False,
                next_command=None,
                **_release_result_payload(result),
            )

        workspace = workspace_module.load_workspace(args.workspace)
        workspace_path = str(workspace.root)
        if command == "status":
            status = workspace_module.workspace_status(workspace)
            payload = status.to_dict()
            return 0, _base_payload(
                stage="status",
                workspace=workspace_path,
                release_ready=status.release_ready,
                next_command=status.next_command,
                status=payload,
            )

        if command == "preflight":
            status = workspace_module.workspace_status(workspace)
            report = release_module.preflight_package(
                workspace.package_dir,
                args.profile,
                installed_package_dir=args.installed_package_dir,
            )
            ready = bool(report.get("release_ready", report.get("can_prepare", False)))
            return (0 if ready else 3), _base_payload(
                stage="preflight",
                workspace=workspace_path,
                release_ready=ready,
                errors=[] if ready else ["package preflight 尚未达到发布条件"],
                next_command=(
                    f"python mod-tools/wf_character_flow.py publish --workspace {workspace.root} "
                    "--confirm PUBLISH_CHARACTER_PACKAGE"
                    if ready else status.next_command
                ),
                status=status.to_dict(),
                preflight=report,
            )

        if command == "publish":
            mode = _manifest_mode(workspace)
            expected = "DIRECT_REAL_TEST" if mode == "runtime_test" \
                else "PUBLISH_CHARACTER_PACKAGE"
            if args.confirm != expected:
                raise FlowError(f"{mode} 发布必须使用确认口令 {expected}")
            status = workspace_module.workspace_status(workspace)
            if mode == "production" and not status.release_ready:
                raise FlowError("production workspace 未达到 release_ready=true")
            result = release_module.publish_package(
                workspace.package_dir,
                args.profile,
                args.confirm,
                installed_package_dir=args.installed_package_dir,
            )
            return 0, _base_payload(
                stage="publish",
                workspace=workspace_path,
                release_ready=mode == "production",
                next_command=None,
                delivery_mode=mode,
                **_release_result_payload(result),
            )

        if command == "rebase":
            if not hasattr(release_module, "rebase_package"):
                raise FlowError("release API 未提供 rebase_package")
            output = args.output or (workspace.root / "rebased-package")
            result = release_module.rebase_package(
                workspace.package_dir,
                args.profile,
                output_dir=output,
                generator_git_head=args.git_head,
            )
            return 0, _base_payload(
                stage="rebase",
                workspace=workspace_path,
                release_ready=False,
                next_command=f"检查 {result.output_dir} 后替换 workspace package",
                output=str(result.output_dir),
                manifest_sha256=result.manifest_sha256,
                writes_live=False,
            )
        raise FlowError(f"未知命令: {command}")
    except (
        OSError,
        ValueError,
        RuntimeError,
        workspace_module.WorkspaceError,
        character_pack.PackPreflightError,
        character_pack.PackStagingError,
        wf_release.ReleaseError,
    ) as exc:
        return 2, _base_payload(
            stage=command,
            workspace=workspace_path,
            release_ready=False,
            errors=[str(exc)],
            next_command=None,
        )


def main(argv: list[str] | None = None) -> int:
    code, payload = run_command(argv)
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
