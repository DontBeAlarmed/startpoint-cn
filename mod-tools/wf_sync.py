#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""命令行同步:把待同步的修改推送到模拟器并重启游戏(等同于 GUI 的同步按钮)。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from wf_gui import sync_to_emulator  # noqa: E402

if __name__ == "__main__":
    result = sync_to_emulator(restart=True)
    print(result["log"])
    print("同步成功" if result["ok"] else "同步失败")
    sys.exit(0 if result["ok"] else 1)
