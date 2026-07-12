#!/usr/bin/env bash
# 可选补丁:通用属性 UI 补全(element-colorless)。用法: bash apply-element-colorless.sh <FFDec导出的AS3目录>
# 给 ElementKindTools.as 的 6 个 switch 补 case 6(Colorless),图标复用官方 element_any。
# 详见 element-colorless.md;打完按 README.md 回封 SWF / 重签 APK。可重复执行。
set -euo pipefail

EXPORT_DIR="${1:?用法: bash apply-element-colorless.sh <EXPORT_DIR>}"

EKT="$EXPORT_DIR/pinball/common/data/general/ElementKindTools.as"
[ -f "$EKT" ] || { echo "找不到 $EKT"; exit 1; }

# 注意:Windows 上 python3 可能是 Microsoft Store 占位 stub(静默退出),必须实际试跑
PY_BIN=""
for c in python3 python py; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c "import sys" >/dev/null 2>&1; then PY_BIN="$c"; break; fi
done
[ -n "$PY_BIN" ] || { echo "找不到可用的 Python"; exit 1; }
"$PY_BIN" - "$EKT" <<'PY'
import re, sys

path = sys.argv[1]
raw = open(path, "rb").read()
nl = "\r\n" if b"\r\n" in raw else "\n"  # FFDec 导出是 CRLF,保留原风格使 diff 干净
s = raw.decode("utf-8").replace("\r\n", "\n")

ICON = "scene/general/sprite_sheet/vector_icon_color-assets/element_any"
# (函数名, case 6 返回语句)。缩进对齐 FFDec 输出(case=12 空格,return=15 空格)。
PATCHES = [
    ("getName", 'return param2.getUiString("element_kind_colorless");'),
    ("getIndex", "return 6;"),
    ("getImagePath", f'return "{ICON}";'),
    ("getMediumImagePath", f'return "{ICON}_medium";'),
    ("getColor", "return 13421772;"),  # 0xCCCCCC 银灰,通用属性主题色,可按口味改
    ("convertElementRecommendToEnemy", "return 6;"),
]


def func_span(name):
    m = re.search(r"public static function " + name + r"\(", s)
    assert m, f"找不到函数 {name}(客户端版本变了?)"
    nxt = s.find("public static function", m.end())
    return m.start(), (nxt if nxt != -1 else len(s))


patched = 0
for name, ret in PATCHES:
    start, end = func_span(name)
    seg = s[start:end]
    if "case 6:" in seg:
        print(f"已打过: {name}")
        continue
    assert seg.count("default:") == 1, f"{name} 内 default: 应恰好 1 处(客户端版本变了?)"
    i = seg.index("default:")
    seg = seg[:i] + f"case 6:\n               {ret}\n            " + seg[i:]
    s = s[:start] + seg + s[end:]
    patched += 1
    print(f"patched: {name}")

if patched:
    open(path, "w", encoding="utf-8", newline=nl).write(s)
print(f"完成: 本次补 {patched} 处 case 6 -> {path}")
PY

# ---- 第 2 文件(2026-07-12 补):属性限制关卡入场放行 ----
# QuestPartyStartableConditionByElement.satisfied 是严格等值(全员 element 必须==validElement),
# element=6 的通用角色会被挡在[限X属性]关卡外 → 放行 element 6。
# ⚠ 同时修复 FFDec 反编译伪影:循环内 `_loc4_ = true` 应为 false(原字节码语义=有一个
# 不匹配即不可入场)。不修的话,FFDec 按导出源回编译会把"限制完全失效"固化进客户端。
QPC="$EXPORT_DIR/pinball/common/data/quest/condition/startable/party/QuestPartyStartableConditionByElement.as"
[ -f "$QPC" ] || { echo "找不到 $QPC"; exit 1; }

"$PY_BIN" - "$QPC" <<'PY'
import sys

path = sys.argv[1]
raw = open(path, "rb").read()
nl = "\r\n" if b"\r\n" in raw else "\n"
s = raw.decode("utf-8").replace("\r\n", "\n")

if "!= 6" in s:
    print(f"已打过: {path}")
    sys.exit(0)

old_if = "if(int(_loc6_.get_element()) != _loc2_.validElement)"
new_if = "if(int(_loc6_.get_element()) != _loc2_.validElement && int(_loc6_.get_element()) != 6)"
assert s.count(old_if) == 1, f"入场判断锚点异常(客户端版本变了?): {path}"

old_body = "_loc4_ = true;\n               break;"
new_body = "_loc4_ = false;\n               break;"
assert s.count(old_body) == 1, f"伪影修复锚点异常(应恰 1 处 _loc4_=true+break): {path}"

s = s.replace(old_if, new_if).replace(old_body, new_body)
open(path, "w", encoding="utf-8", newline=nl).write(s)
print(f"patched: 入场限制放行 element 6 + 反编译伪影修复 -> {path}")
PY

echo "element-colorless 补丁完成;数据侧在修改器「角色资料」页用「改为通用属性」一键(element→6 + OmniElement 标签)。"
echo "提醒: 通用属性角色要参与共鸣/[限X属性]条件,须同时打 apply-omni-element.sh(详见 element-colorless.md)。"
