#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""首次部署:安装 WFdebug APK + 整包推送 WorldFlipper 数据到 MuMu(约 10GB,仅需一次)。"""
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from wf_gui import DEVICE, ROOT, find_adb  # noqa: E402


def run(adb, *args, timeout=None):
    print(">", " ".join(str(a) for a in args))
    return subprocess.run([adb, *args], timeout=timeout).returncode


def main() -> int:
    adb = find_adb()
    if not adb:
        print("[!] 未找到 adb,请先安装 MuMu 12,或设置环境变量 WF_ADB 指向 adb.exe")
        return 1
    print(f"adb: {adb}")

    # 找到含 WorldFlipper/dummy 数据包的目录(如「弹国服」)
    pack_dir = None
    for child in ROOT.iterdir():
        if (child / "WorldFlipper" / "dummy" / "download" / "production" / "upload").exists():
            pack_dir = child
            break
    if not pack_dir:
        print("[!] 项目里未找到 WorldFlipper/dummy 数据包目录")
        return 1
    print(f"数据包目录: {pack_dir}")

    print("[1/3] 连接模拟器...")
    if run(adb, "connect", DEVICE, timeout=15) != 0:
        return 1

    apks = sorted(pack_dir.glob("*.apk"))
    if apks:
        print(f"[2/3] 安装 APK: {apks[0].name} (如已安装会覆盖安装)...")
        run(adb, "-s", DEVICE, "install", "-r", str(apks[0]))
    else:
        print("[2/3] 未找到 APK,跳过(请手动安装)")

    print("[3/3] 推送数据包(约10GB,请耐心等待)...")
    if run(adb, "-s", DEVICE, "push", str(pack_dir / "WorldFlipper"), "/sdcard/WorldFlipper") != 0:
        return 1

    print("部署完成,可在模拟器中启动游戏")
    return 0


if __name__ == "__main__":
    sys.exit(main())
