#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""render-scale-v1 站点 2：MemberView 构造器删除 character 的 SCALE_RENDERER 覆盖。

语义：战斗内 character 动画不再被强制 ×6，保留 parse 出的 frame.scale
（官方角色 frame.scale=6 零感知；与 JoinMovieView 等"不覆盖 scale 的入口"同语义）。
shadow 的 ×6 保留。fail-closed：锚序列必须恰好出现一次；替换后回读 diff 必须
恰好等于删除的 10 行，其余逐行一致。

用法：python patch_memberview_site2.py --swf <in.swf> --out <out.swf>
      --ffdec <ffdec.jar> [--java java]
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path

HERE = Path(__file__).resolve().parent
DUAL = HERE.parent / "dual-form-v1"

CLASS_NAME = "pinball.scene.battle.battle.squad.member.MemberView"
CTOR_ALIAS = "pinball.scene.battle.battle.squad.member:MemberView/MemberView"
PCODE_REL = Path("scripts/pinball/scene/battle/battle/squad/member/MemberView.pcode")

REMOVE = [
    'findproperty QName(PackageNamespace(""),"character")',
    'getproperty QName(PackageNamespace(""),"character")',
    'getlex QName(PackageNamespace("pinball.scene.battle.battle"),"BattleConstants")',
    'getproperty QName(PackageNamespace(""),"SCALE_RENDERER")',
    'initproperty QName(PackageNamespace(""),"scaleX")',
    'findproperty QName(PackageNamespace(""),"character")',
    'getproperty QName(PackageNamespace(""),"character")',
    'getlex QName(PackageNamespace("pinball.scene.battle.battle"),"BattleConstants")',
    'getproperty QName(PackageNamespace(""),"SCALE_RENDERER")',
    'initproperty QName(PackageNamespace(""),"scaleY")',
]


def load_mod(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def run(cmd, timeout=600):
    print(">>", " ".join(str(c) for c in cmd))
    subprocess.run([str(c) for c in cmd], check=True, timeout=timeout)


def export_class_pcode(java, ffdec, swf: Path, dest: Path) -> Path:
    run([java, "-Xmx4g", "-jar", ffdec, "-air", "-format", "script:pcode",
         "-selectclass", CLASS_NAME, "-export", "script", dest, swf])
    out = dest / PCODE_REL
    assert out.is_file(), f"导出缺文件: {out}"
    return out


def extract_ctor_block(text: str) -> tuple[list[str], int, int]:
    lines = text.splitlines()
    anchors = [i for i, l in enumerate(lines)
               if l.strip().startswith("public function MemberView(")]
    assert len(anchors) == 1, f"构造器头出现 {len(anchors)} 次"
    m = None
    for i in range(anchors[0] + 1, len(lines)):
        if lines[i].strip() == "method":
            m = i
            break
    assert m is not None, "构造器 method 块缺失"
    indent = lines[m][: len(lines[m]) - len(lines[m].lstrip())]
    e = None
    for i in range(m + 1, len(lines)):
        if lines[i] == f"{indent}end ; method":
            e = i
            break
    assert e is not None, "构造器 method 块未闭合"
    return lines, m, e


def remove_sequence(block: str) -> str:
    lines = block.splitlines()
    stripped = [l.strip() for l in lines]
    hits = [i for i in range(len(lines) - len(REMOVE) + 1)
            if stripped[i:i + len(REMOVE)] == REMOVE]
    assert len(hits) == 1, f"锚序列出现 {len(hits)} 次(应恰 1 次)"
    i = hits[0]
    return "\n".join(lines[:i] + lines[i + len(REMOVE):]) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--swf", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--ffdec", required=True, type=Path)
    ap.add_argument("--java", default="java")
    a = ap.parse_args()

    abc = load_mod("abc_methods", DUAL / "abc_methods.py")
    index = abc.index_swf_methods(a.swf)
    ref = index.require_ref(CTOR_ALIAS)
    print(f"ctor body_index={ref.body_index} code_sha={hashlib.sha256(ref.code).hexdigest()[:16]}")

    with tempfile.TemporaryDirectory(prefix=".site2-", dir=a.out.parent) as td:
        td = Path(td)
        before = export_class_pcode(a.java, a.ffdec, a.swf, td / "before")
        text_before = before.read_text(encoding="utf-8")
        lines, m, e = extract_ctor_block(text_before)
        block = textwrap.dedent("\n".join(lines[m:e + 1]) + "\n")
        patched_block = remove_sequence(block)
        pfile = td / "ctor.pcode"
        pfile.write_text(patched_block, encoding="utf-8", newline="\n")

        out_unverified = td / "patched.swf"
        run([a.java, "-Xmx4g", "-jar", a.ffdec, "-air", "-onerror", "abort",
             "-replace", a.swf, out_unverified,
             CLASS_NAME, pfile, str(ref.body_index)])
        assert out_unverified.is_file(), "replace 未产出 swf"

        after = export_class_pcode(a.java, a.ffdec, out_unverified, td / "after")
        la = text_before.splitlines()
        lb = after.read_text(encoding="utf-8").splitlines()
        sa = [l.strip() for l in la]
        sb = [l.strip() for l in lb]
        # 期望:剥去空白差异后,after = before 去掉 REMOVE 序列
        hits = [i for i in range(len(sa) - len(REMOVE) + 1)
                if sa[i:i + len(REMOVE)] == REMOVE]
        assert len(hits) == 1, "before 导出锚序列异常"
        expected = sa[:hits[0]] + sa[hits[0] + len(REMOVE):]

        # 指令删除使后续字节偏移变化,FFDec 重导出会重命名 ofsXXXX 标签——
        # 按首次出现顺序归一化标签后比较(跳转结构不变则归一化流必须一致)
        import re
        def canon(ls: list[str]) -> list[str]:
            mapping: dict[str, str] = {}
            out = []
            for l in ls:
                def sub(mm):
                    k = mm.group(0)
                    if k not in mapping:
                        mapping[k] = f"L{len(mapping)}"
                    return mapping[k]
                out.append(re.sub(r"\bofs[0-9a-f]+\b", sub, l))
            return out
        ca, cb = canon(expected), canon(sb)
        if ca != cb:
            for i, (x, y) in enumerate(zip(ca, cb)):
                if x != y:
                    raise AssertionError(f"首个差异行 {i}: 期望={x!r} 实际={y!r}")
            raise AssertionError(f"长度差异: expected={len(ca)} after={len(cb)}")
        assert "SCALE_RENDERER" in "\n".join(sb), "shadow 的 SCALE_RENDERER 不应消失"
        assert "\n".join(sb).count("SCALE_RENDERER") == 2, "应剩恰好 2 处(shadow)"

        a.out.parent.mkdir(parents=True, exist_ok=True)
        out_unverified.replace(a.out)
    print("OK", a.out, "sha256=" + hashlib.sha256(a.out.read_bytes()).hexdigest())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
