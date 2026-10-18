// 测试分类：源码契约（R-17 决策）——断言 admin/src 源文件的结构不变量（路由/字段/文案锚点），
// 不是 React 行为覆盖；防改名/防删除安全网。改造为渲染级行为测试需引入组件测试基建，单独立项。
const assert = require("assert")
const fs = require("fs")
const path = require("path")

const source = fs.readFileSync(path.join(__dirname, "../admin/src/pages/TimeControl.tsx"), "utf8")

assert(source.includes("短期 UP 角色池"), "时间页应聚焦短期 UP 角色池")
assert(source.includes("/api/server/clairvoyance/gacha"), "时间页应接入千里眼卡池 API")
assert(!source.includes("玩家 time_offset"), "千里眼不应保留玩家 time_offset 占位")
assert(!source.includes("玩家视角校验"), "千里眼不应描述玩家时间偏移视角")
assert(!source.includes("事件窗口"), "当前阶段不应展示泛化事件窗口占位")

console.log("admin-time-clairvoyance-ui-source tests passed")
