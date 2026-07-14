#!/usr/bin/env bash
# 可选补丁:boss 塔每次进本随机(random-floor)。用法: bash apply-random-floor.sh <FFDec导出的AS3目录>
# 详见 random-floor.md;打完按 README.md 回封 SWF / 重签 APK。
set -euo pipefail

EXPORT_DIR="${1:?用法: bash apply-random-floor.sh <EXPORT_DIR>}"

BQ="$EXPORT_DIR/pinball/common/data/quest/battle/BattleQuestBaseImpl.as"
[ -f "$BQ" ] || { echo "找不到 $BQ"; exit 1; }

# 注意:Windows 上 python3 可能是 Microsoft Store 占位 stub(静默退出),必须实际试跑
PY_BIN=""
for c in python3 python py; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c "import sys" >/dev/null 2>&1; then PY_BIN="$c"; break; fi
done
[ -n "$PY_BIN" ] || { echo "找不到可用的 Python"; exit 1; }

"$PY_BIN" - "$BQ" <<'PY'
import sys

f = sys.argv[1]
ANCHOR = "         var _loc2_:Array = logicAssets.getMasterTable(FloorTable).get_data().get(param1.tower_floor_id);"
# 用强类型 FloorValues 读头行(与下方工作循环同款访问方式)
BLOCK = """
         var _rfHead:FloorValues = _loc2_.length > 0 ? _loc2_[0] as FloorValues : null;
         if(_rfHead != null && _rfHead.battle_field_data_id.indexOf("__random__") != -1)
         {
            var _rfK:int = int(_rfHead.battle_bgm_prefix);
            var _rfPool:Array = _loc2_.slice(1);
            var _rfI:int = int(_rfPool.length);
            while(_rfI > 1)
            {
               var _rfJ:int = int(Math.random() * _rfI);
               _rfI--;
               var _rfT:* = _rfPool[_rfI];
               _rfPool[_rfI] = _rfPool[_rfJ];
               _rfPool[_rfJ] = _rfT;
            }
            if(_rfK < 1)
            {
               _rfK = 1;
            }
            if(_rfK > int(_rfPool.length))
            {
               _rfK = int(_rfPool.length);
            }
            _loc2_ = _rfPool.slice(0,_rfK);
         }"""

raw = open(f, "rb").read()
nl = "\r\n" if b"\r\n" in raw else "\n"  # FFDec 导出是 CRLF,保留原风格
s = raw.decode("utf-8").replace("\r\n", "\n")
if "__random__" in s:
    print("已打过:", f)
    sys.exit(0)
n = s.count(ANCHOR)
assert n == 2, f"锚点出现 {n} 次(应为 2:NoClearRank/Tower 两个函数;客户端版本变了?)"
s = s.replace(ANCHOR, ANCHOR + BLOCK)
open(f, "w", encoding="utf-8", newline=nl).write(s)
print("patched x2:", f)
PY

echo "完成。之后:FFDec 导回 SWF -> zipalign -> apksigner(见 README.md)。"
echo "提醒:发 __random__ 池数据前,确保所有玩家都已换上补丁 APK(旧客户端读到会崩)。"
