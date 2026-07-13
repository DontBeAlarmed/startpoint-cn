#!/usr/bin/env python3
"""Build and verify a signed APK containing the abyss equipment gate."""
from __future__ import annotations

import argparse
import hashlib
import hmac
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence


def _load_gate_patch() -> Any:
    module_name = "abyss_mode_equipment_gate_patch_for_builder"
    existing = sys.modules.get(module_name)
    if existing is not None:
        return existing
    path = Path(__file__).with_name("patch.py")
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load gate patch module: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


abyss_patch = _load_gate_patch()


TARGET_SWF_MEMBER = "assets/worldflipper_android_release.swf"
TARGET_CLASS = "pinball.common.data.character.BattleCharacterLogic"
REPORT_ARTIFACTS = (
    "patched_as",
    "injected_swf",
    "signed_apk",
    "reexported_as",
)
_SIGNATURE_EXTENSIONS = (".SF", ".RSA", ".DSA", ".EC")
_SHA256_RE = re.compile(r"[0-9a-f]{64}")


class BuildError(RuntimeError):
    """The APK cannot be built or verified safely."""


@dataclass(frozen=True)
class BuildConfig:
    """Explicit inputs and destinations for one verified APK build."""

    base: Path
    battle_logic_as: Path
    output_apk: Path
    report: Path
    work: Path
    ffdec: Path
    java: Path
    zipalign: Path
    apksigner: Path
    keystore: Path
    keystore_password_env: str


def is_signature_member(member: str) -> bool:
    """Return whether *member* is a top-level APK v1 signature file."""
    parts = member.split("/")
    if len(parts) != 2 or parts[0].upper() != "META-INF":
        return False
    filename = parts[1].upper()
    return filename == "MANIFEST.MF" or filename.endswith(_SIGNATURE_EXTENSIONS)


def rewrite_apk(
    base_apk: Path | str,
    output_apk: Path | str,
    injected_swf: Path | str,
) -> None:
    """Replace the main SWF and strip only top-level APK signatures."""
    base_path = Path(base_apk)
    output_path = Path(output_apk)
    swf_bytes = Path(injected_swf).read_bytes()
    if os.path.normcase(os.path.abspath(base_path)) == os.path.normcase(
        os.path.abspath(output_path)
    ):
        raise BuildError("base and rewritten APK must be different paths")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with zipfile.ZipFile(base_path, "r") as source:
            members = source.infolist()
            target_count = sum(
                member.filename == TARGET_SWF_MEMBER for member in members
            )
            if target_count != 1:
                raise BuildError(
                    f"expected exactly one {TARGET_SWF_MEMBER}, found {target_count}"
                )
            with tempfile.NamedTemporaryFile(
                dir=output_path.parent,
                prefix=f".{output_path.name}.",
                suffix=".tmp",
                delete=False,
            ) as handle:
                temporary = Path(handle.name)
            with zipfile.ZipFile(temporary, "w", allowZip64=True) as target:
                target.comment = source.comment
                for member in members:
                    if is_signature_member(member.filename):
                        continue
                    data = (
                        swf_bytes
                        if member.filename == TARGET_SWF_MEMBER
                        else source.read(member)
                    )
                    target.writestr(member, data)
        os.replace(temporary, output_path)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def sha256_file(path: Path | str) -> str:
    """Return a lowercase SHA-256 digest for *path*."""
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _load_report(report: Mapping[str, Any] | Path | str) -> Mapping[str, Any]:
    if isinstance(report, Mapping):
        return report
    try:
        loaded = json.loads(Path(report).read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise BuildError(f"cannot read verification report: {exc}") from exc
    if not isinstance(loaded, Mapping):
        raise BuildError("verification report root must be an object")
    return loaded


def validate_verification_report(
    report: Mapping[str, Any] | Path | str,
) -> bool:
    """Validate the report schema and re-hash every recorded artifact."""
    data = _load_report(report)
    if data.get("schema_version") != 1 or data.get("status") != "verified":
        raise BuildError("verification report status/schema is invalid")
    if data.get("class_name") != TARGET_CLASS:
        raise BuildError("verification report class name is invalid")
    artifacts = data.get("artifacts")
    if not isinstance(artifacts, Mapping):
        raise BuildError("verification report artifacts must be an object")
    if set(artifacts) != set(REPORT_ARTIFACTS):
        raise BuildError("verification report artifact set is invalid")

    canonical_paths: set[str] = set()
    for name in REPORT_ARTIFACTS:
        record = artifacts[name]
        if not isinstance(record, Mapping):
            raise BuildError(f"artifact {name} must be an object")
        path_text = record.get("path")
        expected_hash = record.get("sha256")
        if not isinstance(path_text, str) or not isinstance(expected_hash, str):
            raise BuildError(f"artifact {name} path/hash must be strings")
        path = Path(path_text)
        if not path.is_absolute() or path_text != str(path.resolve()):
            raise BuildError(f"artifact {name} path is not canonical absolute")
        if path_text in canonical_paths:
            raise BuildError(f"artifact {name} path is duplicated")
        canonical_paths.add(path_text)
        if _SHA256_RE.fullmatch(expected_hash) is None:
            raise BuildError(f"artifact {name} SHA-256 is malformed")
        try:
            actual_hash = sha256_file(path)
        except OSError as exc:
            raise BuildError(f"cannot hash artifact {name}: {exc}") from exc
        if not hmac.compare_digest(actual_hash, expected_hash):
            raise BuildError(f"artifact {name} SHA-256 mismatch")
    return True


def _resolved_config(config: BuildConfig) -> BuildConfig:
    return BuildConfig(
        base=config.base.resolve(),
        battle_logic_as=config.battle_logic_as.resolve(),
        output_apk=config.output_apk.resolve(),
        report=config.report.resolve(),
        work=config.work.resolve(),
        ffdec=config.ffdec.resolve(),
        java=config.java.resolve(),
        zipalign=config.zipalign.resolve(),
        apksigner=config.apksigner.resolve(),
        keystore=config.keystore.resolve(),
        keystore_password_env=config.keystore_password_env,
    )


def _required_files(config: BuildConfig) -> dict[str, Path]:
    return {
        "base APK": config.base,
        "patched BattleCharacterLogic AS": config.battle_logic_as,
        "FFDec jar": config.ffdec,
        "Java executable": config.java,
        "zipalign executable": config.zipalign,
        "apksigner executable": config.apksigner,
        "signing keystore": config.keystore,
    }


def _validate_destination_paths(config: BuildConfig) -> None:
    required_files = _required_files(config)
    output_key = os.path.normcase(str(config.output_apk))
    report_key = os.path.normcase(str(config.report))
    if output_key == report_key:
        raise BuildError("APK output and verification report must be different paths")
    protected = {
        os.path.normcase(str(path)): label for label, path in required_files.items()
    }
    for label, path, key in (
        ("APK output", config.output_apk, output_key),
        ("verification report", config.report, report_key),
    ):
        if key in protected:
            raise BuildError(f"{label} would overwrite {protected[key]}: {path}")


def _preflight(config: BuildConfig) -> None:
    required_files = _required_files(config)
    for label, path in required_files.items():
        if not path.is_file():
            raise BuildError(f"{label} is not a file: {path}")

    env_name = config.keystore_password_env
    if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", env_name) is None:
        raise BuildError("keystore password environment variable name is invalid")
    if env_name not in os.environ:
        raise BuildError(f"required environment variable is not set: {env_name}")

    try:
        source_text = config.battle_logic_as.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeError) as exc:
        raise BuildError(f"cannot read patched ActionScript: {exc}") from exc
    abyss_patch.verify_text(source_text, require_markers=True)


def _remove_final_pair(
    output_apk: Path,
    report: Path,
    original_error: BaseException | None = None,
) -> None:
    failures: list[str] = []
    for path in (output_apk, report):
        try:
            path.unlink(missing_ok=True)
        except BaseException as exc:
            failures.append(f"{path}: {type(exc).__name__}: {exc}")
    if not failures:
        return
    message = "failed to remove final output pair: " + "; ".join(failures)
    if original_error is not None:
        original_error.add_note(message)
        return
    raise BuildError(message)


def _extract_original_swf(base_apk: Path, destination: Path) -> None:
    with zipfile.ZipFile(base_apk, "r") as archive:
        matches = [
            member
            for member in archive.infolist()
            if member.filename == TARGET_SWF_MEMBER
        ]
        if len(matches) != 1:
            raise BuildError(
                f"expected exactly one {TARGET_SWF_MEMBER}, found {len(matches)}"
            )
        destination.write_bytes(archive.read(matches[0]))


def _run_external(command: Sequence[Path | str]) -> None:
    subprocess.run([str(value) for value in command], check=True)


def _require_created(path: Path, label: str) -> None:
    try:
        size = path.stat().st_size
    except OSError as exc:
        raise BuildError(f"{label} was not created: {path}") from exc
    if not path.is_file() or size <= 0:
        raise BuildError(f"{label} is empty or not a file: {path}")


def _artifact_record(report_path: Path, hash_path: Path | None = None) -> dict[str, str]:
    canonical = report_path.resolve()
    return {
        "path": str(canonical),
        "sha256": sha256_file(hash_path or canonical),
    }


def _build_report(
    patched_as: Path,
    injected_swf: Path,
    signed_apk_stage: Path,
    final_apk: Path,
    reexported_as: Path,
) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "status": "verified",
        "class_name": TARGET_CLASS,
        "artifacts": {
            "patched_as": _artifact_record(patched_as),
            "injected_swf": _artifact_record(injected_swf),
            "signed_apk": _artifact_record(final_apk, signed_apk_stage),
            "reexported_as": _artifact_record(reexported_as),
        },
    }


def _stage_copy(source: Path, destination: Path) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            dir=destination.parent,
            prefix=f".{destination.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            temporary = Path(handle.name)
            with source.open("rb") as source_handle:
                shutil.copyfileobj(source_handle, handle, 1024 * 1024)
            handle.flush()
            os.fsync(handle.fileno())
        return temporary
    except BaseException:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
        raise


def _stage_report(data: Mapping[str, Any], destination: Path) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    payload = (
        json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            dir=destination.parent,
            prefix=f".{destination.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            temporary = Path(handle.name)
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        return temporary
    except BaseException:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
        raise


def build_verified_apk(config: BuildConfig) -> dict[str, Any]:
    """Run the complete build and publish a final APK/report pair on success only."""
    config = _resolved_config(config)
    _validate_destination_paths(config)
    _remove_final_pair(config.output_apk, config.report)
    transaction: Path | None = None
    final_stages: list[Path] = []
    try:
        config.output_apk.parent.mkdir(parents=True, exist_ok=True)
        config.report.parent.mkdir(parents=True, exist_ok=True)
        config.work.mkdir(parents=True, exist_ok=True)
        _preflight(config)
        transaction = Path(
            tempfile.mkdtemp(prefix=".abyss-apk-build-", dir=config.work)
        ).resolve()
        original_swf = transaction / "original.swf"
        injected_swf = transaction / "injected.swf"
        verify_export = transaction / "verify_export"
        unsigned_apk = transaction / "unsigned.apk"
        aligned_apk = transaction / "aligned.apk"
        signed_apk = transaction / "signed.apk"

        _extract_original_swf(config.base, original_swf)
        _run_external(
            (
                config.java,
                "-jar",
                config.ffdec,
                "-air",
                "-onerror",
                "abort",
                "-replace",
                original_swf,
                injected_swf,
                TARGET_CLASS,
                config.battle_logic_as,
            )
        )
        _require_created(injected_swf, "FFDec injected SWF")

        _run_external(
            (
                config.java,
                "-jar",
                config.ffdec,
                "-onerror",
                "abort",
                "-selectclass",
                TARGET_CLASS,
                "-export",
                "script",
                verify_export,
                injected_swf,
            )
        )
        reexports = sorted(verify_export.rglob("BattleCharacterLogic.as"))
        if len(reexports) != 1:
            raise BuildError(
                "expected exactly one re-exported BattleCharacterLogic.as, "
                f"found {len(reexports)}"
            )
        reexported_as = reexports[0].resolve()
        try:
            reexported_text = reexported_as.read_text(encoding="utf-8-sig")
        except (OSError, UnicodeError) as exc:
            raise BuildError(f"cannot read re-exported ActionScript: {exc}") from exc
        abyss_patch.verify_text(reexported_text, require_markers=False)

        rewrite_apk(config.base, unsigned_apk, injected_swf)
        _run_external(
            (config.zipalign, "-p", "-f", "4", unsigned_apk, aligned_apk)
        )
        _require_created(aligned_apk, "zipaligned APK")
        _run_external(
            (
                config.apksigner,
                "sign",
                "--v4-signing-enabled",
                "false",
                "--ks",
                config.keystore,
                "--ks-pass",
                f"env:{config.keystore_password_env}",
                "--out",
                signed_apk,
                aligned_apk,
            )
        )
        _require_created(signed_apk, "signed APK")
        _run_external(
            (
                config.apksigner,
                "verify",
                "--verbose",
                "--print-certs",
                signed_apk,
            )
        )

        report_data = _build_report(
            config.battle_logic_as,
            injected_swf,
            signed_apk,
            config.output_apk,
            reexported_as,
        )
        apk_stage = _stage_copy(signed_apk, config.output_apk)
        final_stages.append(apk_stage)
        report_stage = _stage_report(report_data, config.report)
        final_stages.append(report_stage)

        os.replace(apk_stage, config.output_apk)
        final_stages.remove(apk_stage)
        os.replace(report_stage, config.report)
        final_stages.remove(report_stage)
        validate_verification_report(config.report)
        return report_data
    except BaseException as original_error:
        _remove_final_pair(
            config.output_apk,
            config.report,
            original_error=original_error,
        )
        for stage in final_stages:
            try:
                stage.unlink(missing_ok=True)
            except BaseException as cleanup_error:
                original_error.add_note(
                    "failed to clean staged final output: "
                    f"{type(cleanup_error).__name__}: {cleanup_error}"
                )
        if transaction is not None:
            try:
                shutil.rmtree(transaction)
            except BaseException as cleanup_error:
                original_error.add_note(
                    "failed to clean build transaction: "
                    f"{type(cleanup_error).__name__}: {cleanup_error}"
                )
        raise


def _parse_args(argv: Sequence[str] | None) -> BuildConfig:
    parser = argparse.ArgumentParser(
        description="Build, sign, and re-decompile the abyss gate client APK."
    )
    parser.add_argument("--base", required=True, type=Path)
    parser.add_argument("--battle-logic-as", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path, dest="output_apk")
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--work", required=True, type=Path)
    parser.add_argument("--ffdec", required=True, type=Path)
    parser.add_argument("--java", required=True, type=Path)
    parser.add_argument("--zipalign", required=True, type=Path)
    parser.add_argument("--apksigner", required=True, type=Path)
    parser.add_argument("--ks", required=True, type=Path, dest="keystore")
    parser.add_argument(
        "--ks-pass-env", required=True, dest="keystore_password_env"
    )
    return BuildConfig(**vars(parser.parse_args(argv)))


def _redacted_error(error: BaseException, env_name: str) -> str:
    message = str(error)
    secret = os.environ.get(env_name)
    if secret:
        message = message.replace(secret, "<redacted>")
    return message


def main(argv: Sequence[str] | None = None) -> int:
    config = _parse_args(argv)
    try:
        report = build_verified_apk(config)
    except KeyboardInterrupt:
        print("[CANCELLED] client APK build cancelled; no final outputs kept.", file=sys.stderr)
        return 130
    except (
        BuildError,
        abyss_patch.PatchError,
        OSError,
        UnicodeError,
        zipfile.BadZipFile,
        subprocess.CalledProcessError,
    ) as exc:
        print(
            f"[ERROR] client APK build failed: "
            f"{_redacted_error(exc, config.keystore_password_env)}",
            file=sys.stderr,
        )
        return 1
    signed = report["artifacts"]["signed_apk"]
    print(
        f"[OK] verified APK {signed['path']} sha256={signed['sha256']}; "
        f"report={config.report.resolve()}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
