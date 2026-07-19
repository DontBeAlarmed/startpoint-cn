#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""在已含 abyss/重定向/dual-form 补丁的 APK 上叠加 render-scale-v1（尊重 frame.scale）。

复用 abyss-mode-equipment/build_apk.py 的 rewrite_apk（换主 SWF + 剥签名），
先注入 PixelArtCharacterView，再补 MemberView，最后 zipalign + apksigner 重签并回读验证。
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ABYSS = HERE.parent / "abyss-mode-equipment" / "build_apk.py"
SITE2_PATCHER = HERE / "patch_memberview_site2.py"

_spec = importlib.util.spec_from_file_location("abyss_build_apk", ABYSS)
abyss = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = abyss
_spec.loader.exec_module(abyss)

TARGET_CLASS = "pinball.ui.component.pixelArtCharacter.PixelArtCharacterView"
SOURCE_MARKER = "_loc12_.scale = _loc12_.scale / 6;"
FFDEC_MARKER = "_loc12_.scale /= 6;"
MARKER = SOURCE_MARKER


def has_site1_marker(text: str) -> bool:
    """Accept source and FFDec-canonicalized forms of the same scale patch."""
    return SOURCE_MARKER in text or FFDEC_MARKER in text


def run(cmd):
    print(">>", " ".join(str(c) for c in cmd))
    subprocess.run([str(c) for c in cmd], check=True)


def sha(p: Path) -> str:
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True, type=Path)
    ap.add_argument("--patched-as", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--work", required=True, type=Path)
    ap.add_argument("--ffdec", required=True, type=Path)
    ap.add_argument("--java", required=True, type=Path)
    ap.add_argument("--zipalign", required=True, type=Path)
    ap.add_argument("--apksigner", required=True, type=Path)
    ap.add_argument("--ks", required=True, type=Path)
    ap.add_argument("--ks-pass-env", required=True)
    a = ap.parse_args()

    assert has_site1_marker(a.patched_as.read_text(encoding="utf-8-sig")), "补丁标记缺失"
    if a.ks_pass_env not in os.environ:
        raise SystemExit(f"{a.ks_pass_env} 未设置")

    a.work.mkdir(parents=True, exist_ok=True)
    tx = Path(tempfile.mkdtemp(prefix=".render-scale-", dir=a.work)).resolve()
    original = tx / "original.swf"
    injected = tx / "injected.swf"
    fully_patched = tx / "fully-patched.swf"
    unsigned = tx / "unsigned.apk"
    aligned = tx / "aligned.apk"
    signed = tx / "signed.apk"
    vexport = tx / "verify_export"

    abyss._extract_original_swf(a.base, original)
    run([a.java, "-jar", a.ffdec, "-air", "-onerror", "abort", "-replace",
         original, injected, TARGET_CLASS, a.patched_as])
    assert injected.is_file(), "injected swf 未生成"

    # 回读验证补丁进了 SWF
    # Site 2: keep MemberView character frame.scale instead of forcing x6.
    assert SITE2_PATCHER.is_file(), f"MemberView patcher missing: {SITE2_PATCHER}"
    run([sys.executable, SITE2_PATCHER, "--swf", injected, "--out", fully_patched,
         "--ffdec", a.ffdec, "--java", a.java])
    assert fully_patched.is_file(), "two-site patched swf was not generated"

    vexport.mkdir()
    run([a.java, "-jar", a.ffdec, "-onerror", "abort", "-selectclass", TARGET_CLASS,
         "-export", "script", vexport, fully_patched])
    reexp = sorted(vexport.rglob("PixelArtCharacterView.as"))
    assert len(reexp) == 1, f"回读类数量异常: {len(reexp)}"
    assert has_site1_marker(reexp[0].read_text(encoding="utf-8-sig")), "回读未见补丁标记"

    abyss.rewrite_apk(a.base, unsigned, fully_patched)
    run([a.zipalign, "-p", "-f", "4", unsigned, aligned])
    run([a.apksigner, "sign", "--v4-signing-enabled", "false",
         "--ks", a.ks, "--ks-pass", f"env:{a.ks_pass_env}", "--out", signed, aligned])
    run([a.apksigner, "verify", "--verbose", signed])

    a.out.parent.mkdir(parents=True, exist_ok=True)
    os.replace(signed, a.out)
    print("OK", a.out, "sha256=" + sha(a.out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
