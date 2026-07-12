#!/usr/bin/env bash
# 可选补丁:共鸣通用属性(OmniElement)。用法: bash apply-omni-element.sh <FFDec导出的AS3目录>
# 详见 omni-element.md;打完按 README.md 回封 SWF / 重签 APK。
set -euo pipefail

EXPORT_DIR="${1:?用法: bash apply-omni-element.sh <EXPORT_DIR>}"

BCL="$EXPORT_DIR/pinball/common/data/character/BattleCharacterLogic.as"
SMS="$EXPORT_DIR/pinball/common/data/battle/squadMember/SquadMemberSource.as"

[ -f "$BCL" ] || { echo "找不到 $BCL"; exit 1; }
[ -f "$SMS" ] || { echo "找不到 $SMS"; exit 1; }

patch_one() { # file, 原判断串, 追加串
  local f="$1" old="$2" add="$3"
  if grep -qF "$add" "$f"; then
    echo "已打过: $f"
    return
  fi
  grep -qF "$old" "$f" || { echo "!! 找不到锚点(客户端版本变了?): $f"; exit 1; }
  # 只改第一处(Element 分支;两文件中该串均唯一出现在 matchCharacterGroup)
  # 注意:Windows 上 python3 可能是 Microsoft Store 占位 stub(静默退出),必须实际试跑
  local PY_BIN=""
  for c in python3 python py; do
    if command -v "$c" >/dev/null 2>&1 && "$c" -c "import sys" >/dev/null 2>&1; then PY_BIN="$c"; break; fi
  done
  [ -n "$PY_BIN" ] || { echo "找不到可用的 Python"; exit 1; }
  "$PY_BIN" - "$f" "$old" "$add" <<'PY'
import sys
f, old, add = sys.argv[1], sys.argv[2], sys.argv[3]
raw = open(f, "rb").read()
nl = "\r\n" if b"\r\n" in raw else "\n"  # FFDec 导出是 CRLF,保留原风格使 diff 干净
s = raw.decode("utf-8").replace("\r\n", "\n")
n = s.count(old)
assert n == 1, f"锚点出现 {n} 次(应为 1): {f}"
open(f, "w", encoding="utf-8", newline=nl).write(
    s.replace(old, old[:-1] + " || " + add + ")"))
print("patched:", f)
PY
}

patch_one "$BCL" \
  'if(ElementKind_Impl_.toColorlessable(get_element()) == int(_loc4_.params[0]))' \
  'get_characterTags().indexOf("OmniElement") != -1'

patch_one "$SMS" \
  'if(ElementKind_Impl_.toColorlessable(element) == int(_loc4_.params[0]))' \
  'characterTags.indexOf("OmniElement") != -1'

# 第 3 处(2026-07-12 补):副位(unison)组匹配是独立实现 matchUnisonCharacterGroup,
# Element 分支走 matchElements(unisonElements,…);unisonCharacterTags 字段官方现成。
# 不补的话:通用/OmniElement 角色放副位时,元素共鸣/编成条件不再计入它。
patch_one "$SMS" \
  'if(SquadMemberSource.matchElements(unisonElements,int(_loc4_.params[0])))' \
  'unisonCharacterTags.indexOf("OmniElement") != -1'

echo "OmniElement 补丁完成(3 处:主位×2 + 副位×1);数据侧在修改器「角色资料」页给角色开 OmniElement 标签。"
