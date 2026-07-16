#!/usr/bin/env python3
"""Build and strictly verify the carrier-free dual_form_v1 SWF patch.

The script never publishes, installs, or edits a live client.  Its final SWF
is promoted inside the requested empty output directory only after method-index
resolution, P-code replacement, final export, and offline verification succeed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from typing import Any

import patch_pcode


PATCH_ROOT = Path(__file__).resolve().parent
DEFAULT_MANIFEST = patch_pcode.DEFAULT_MANIFEST


class BuildError(RuntimeError):
    pass


def _run(command: list[str], *, cwd: Path, env: dict[str, str], timeout: int) -> dict[str, Any]:
    completed = subprocess.run(
        command,
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        errors="replace",
        timeout=timeout,
        check=False,
    )
    result = {
        "command": command,
        "returncode": completed.returncode,
        "stdout": completed.stdout,
        "stderr": completed.stderr,
    }
    if completed.returncode != 0:
        raise BuildError(
            "command failed with exit code "
            f"{completed.returncode}: {' '.join(command[:8])}\n"
            f"stdout:\n{completed.stdout[-8000:]}\n"
            f"stderr:\n{completed.stderr[-8000:]}"
        )
    return result


def _write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        newline="\n",
        delete=False,
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
    ) as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")
        temporary = Path(handle.name)
    temporary.replace(path)


def _prepare_empty_output(path: Path) -> Path:
    path = path.resolve()
    if path.exists():
        if not path.is_dir():
            raise BuildError(f"output path is not a directory: {path}")
        if any(path.iterdir()):
            raise BuildError(f"output directory must be empty: {path}")
    else:
        path.mkdir(parents=True)
    return path


def build(
    *,
    baseline_swf: Path,
    baseline_pcode_root: Path,
    ffdec_jar: Path,
    output_dir: Path,
    profile_dir: Path,
    java: str = "java",
    manifest_path: Path = DEFAULT_MANIFEST,
    timeout: int = 240,
) -> dict[str, Any]:
    repo_root = PATCH_ROOT.parents[1]
    baseline_swf = baseline_swf.resolve()
    baseline_pcode_root = baseline_pcode_root.resolve()
    ffdec_jar = ffdec_jar.resolve()
    profile_dir = profile_dir.resolve()
    output_dir = _prepare_empty_output(output_dir)
    if not ffdec_jar.is_file():
        raise BuildError(f"FFDec jar is missing: {ffdec_jar}")
    if not baseline_pcode_root.is_dir():
        raise BuildError(f"baseline P-code export is missing: {baseline_pcode_root}")
    manifest = patch_pcode.load_manifest(manifest_path)
    if manifest["injection_strategy"] != "pure_pcode_existing_classes":
        raise BuildError(
            f"unsupported injection strategy: {manifest['injection_strategy']!r}"
        )
    if not baseline_swf.is_file():
        raise BuildError(f"baseline SWF is missing: {baseline_swf}")
    baseline_hash = hashlib.sha256(baseline_swf.read_bytes()).hexdigest()
    if baseline_hash != manifest["baseline"]["main_swf_sha256"]:
        raise BuildError(
            f"baseline SWF sha256 mismatch: expected "
            f"{manifest['baseline']['main_swf_sha256']}, got {baseline_hash}"
        )

    profile_dir.mkdir(parents=True, exist_ok=True)
    environment = os.environ.copy()
    environment["APPDATA"] = str(profile_dir)
    logs: list[dict[str, Any]] = []
    intermediate_swf = output_dir / "01-baseline-copy.swf"
    shutil.copy2(baseline_swf, intermediate_swf)

    pcode_dir = output_dir / "pcode"
    generated = patch_pcode.generate_patch_set(
        intermediate_swf,
        baseline_pcode_root,
        pcode_dir,
        manifest_path,
    )
    targets = patch_pcode.resolve_replacement_targets(
        intermediate_swf, manifest_path
    )
    generated_by_method = {
        item["method_name"]: item for item in generated["outputs"]
    }
    expected_methods = [target["method_name"] for target in targets]
    if (
        len(generated_by_method) != len(generated["outputs"])
        or set(generated_by_method) != set(expected_methods)
    ):
        raise BuildError(
            "generated method set does not exactly match replacement targets"
        )
    for target in targets:
        target["generated_pcode"] = generated_by_method[target["method_name"]][
            "output"
        ]
    final_unverified = output_dir / "02-pcode.unverified.swf"
    replace_command = [
        java,
        "-Xmx4g",
        "-jar",
        str(ffdec_jar),
        "-air",
        "-replace",
        str(intermediate_swf),
        str(final_unverified),
    ]
    for target in targets:
        generated_item = generated_by_method[target["method_name"]]
        replace_command.extend(
            [
                target["class_name"],
                generated_item["output"],
                str(target["replacement_body_index"]),
            ]
        )
    logs.append(
        _run(
            replace_command,
            cwd=repo_root,
            env=environment,
            timeout=timeout,
        )
    )

    export_root = output_dir / "final-pcode-export"
    selected_classes = [target["class_name"] for target in targets]
    selected_classes = list(dict.fromkeys(selected_classes))
    logs.append(
        _run(
            [
                java,
                "-Xmx4g",
                "-jar",
                str(ffdec_jar),
                "-air",
                "-format",
                "script:pcode",
                "-selectclass",
                ",".join(selected_classes),
                "-export",
                "script",
                str(export_root),
                str(final_unverified),
            ],
            cwd=repo_root,
            env=environment,
            timeout=timeout,
        )
    )
    verification = patch_pcode.verify_pcode_export(
        baseline_pcode_root,
        export_root / "scripts",
        manifest_path,
        baseline_swf=baseline_swf,
        final_swf=final_unverified,
        replacement_targets=targets,
    )
    final_hash = hashlib.sha256(final_unverified.read_bytes()).hexdigest()
    if final_hash == baseline_hash:
        raise BuildError("final SWF sha256 matches baseline")
    final_swf = output_dir / "dual-form-v1.swf"
    final_unverified.replace(final_swf)
    report = {
        "status": "offline-verified-device-canary-required",
        "injection_strategy": manifest["injection_strategy"],
        "baseline": {
            "path": str(baseline_swf),
            "sha256": baseline_hash,
        },
        "intermediate": {
            "path": str(intermediate_swf),
            "sha256": hashlib.sha256(intermediate_swf.read_bytes()).hexdigest(),
        },
        "final": {
            "path": str(final_swf),
            "sha256": final_hash,
            "size": final_swf.stat().st_size,
        },
        "replacement_targets": targets,
        "offline_verification": verification,
        "runtime_acceptance": {
            "device_canary_required": True,
            "device_canary_passed": False,
            "publish_allowed": False,
        },
        "commands": [
            {
                "command": item["command"],
                "returncode": item["returncode"],
                "stdout_tail": item["stdout"][-4000:],
                "stderr_tail": item["stderr"][-4000:],
            }
            for item in logs
        ],
    }
    _write_json_atomic(output_dir / "build-report.json", report)
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-swf", type=Path, required=True)
    parser.add_argument("--baseline-pcode-root", type=Path, required=True)
    parser.add_argument("--ffdec-jar", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--profile-dir", type=Path, required=True)
    parser.add_argument("--java", default="java")
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--timeout", type=int, default=240)
    args = parser.parse_args()
    try:
        report = build(
            baseline_swf=args.baseline_swf,
            baseline_pcode_root=args.baseline_pcode_root,
            ffdec_jar=args.ffdec_jar,
            output_dir=args.output_dir,
            profile_dir=args.profile_dir,
            java=args.java,
            manifest_path=args.manifest,
            timeout=args.timeout,
        )
    except (BuildError, patch_pcode.PcodePatchError, RuntimeError) as exc:
        parser.error(str(exc))
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
