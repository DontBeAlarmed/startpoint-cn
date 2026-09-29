"use strict"

// 定时资源补充移动卡片视图（task-31 ADD-3，照账号页 AccountsMobileView 已验证模式）：
// 源码断言 —— 断点切换接线、范围徽章语义、详情行字段、启停 Switch 原逻辑、删除确认
// 文案与桌面逐字一致。三个锚点类与 API/文案锚点仍在 admin-scheduled-resource-ui-source
// （基线未动），两者互补。

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const projectRoot = path.resolve(__dirname, "..")
const componentPath = path.join(projectRoot, "admin/src/components/ScheduledResourceRules.tsx")
const mobilePath = path.join(projectRoot, "admin/src/components/ScheduledResourceMobileView.tsx")
const cssPath = path.join(projectRoot, "admin/src/styles/pages/scheduled-resource.css")

for (const filePath of [componentPath, mobilePath, cssPath]) {
    assert.equal(fs.existsSync(filePath), true, `缺少定时资源移动卡片文件：${filePath}`)
}

const component = fs.readFileSync(componentPath, "utf8")
const mobile = fs.readFileSync(mobilePath, "utf8")
const css = fs.readFileSync(cssPath, "utf8")

// ── 断点切换接线（照 Accounts.tsx：Grid.useBreakpoint / !screens.md）────────
assert.match(component, /const \{ useBreakpoint \} = Grid/, "定时资源组件应使用 Grid.useBreakpoint")
assert.match(component, /const screens = useBreakpoint\(\)/, "定时资源组件应读取断点")
assert.match(component, /const isMobile = !screens\.md/, "断点语义应是 <md 即移动")
assert.match(component, /className=\{isMobile \? "admin-mobile-list-card" : "admin-table-card"\}/, "卡片容器类应按断点切换")
assert.match(component, /\{isMobile \? \(/, "应有移动渲染分支")
assert.match(component, /<ScheduledResourceMobileView/, "移动分支应渲染 ScheduledResourceMobileView")
assert.match(component, /<Table<ScheduledResourceRule>/, "桌面分支应保留 Table")
assert.match(component, /新建规则/, "新建规则按钮应保留（卡片区上方现状位置）")

// ── 移动卡片：范围徽章 + 详情行 + 尾部行 ───────────────────────────────────
assert.match(mobile, /rule\.scope === "global"\s*\?\s*<span className="admin-badge-info">全局规则<\/span>/, "全局规则应为 info 徽章")
assert.match(mobile, /admin-badge-muted">指定存档 #\{rule\.playerId\}/, "指定存档应为 muted 徽章")
assert.match(mobile, /发放数量/, "详情行应含发放数量")
assert.match(mobile, /触发下限/, "详情行应含触发下限")
assert.match(mobile, /持有上限/, "详情行应含持有上限")
assert.match(mobile, /启用区间/, "详情行应含启用区间")
assert.match(mobile, /\{rule\.description && /, "备注应有则显示")
// 启停改为与同排按钮同规格的文字按钮 + 首行状态徽章 (维护者 2026-09-30: Switch 风格与按钮行不一致)
assert.match(mobile, /admin-badge-ok">启用<\/span>/, "启用态应有状态徽章")
assert.match(mobile, /admin-badge-muted">停用</, "停用态应有状态徽章")
assert.match(mobile, /rule\.enabled \? <CircleStop size=\{15\} \/> : <Play size=\{15\} \/>/, "启停图标随状态切换")
assert.match(mobile, /\{rule\.enabled \? "停用" : "启用"\}/, "按钮文案=点击后的动作")
assert.match(mobile, /loading=\{toggling\}/, "透传桌面同一 pending 态")
assert.match(mobile, /icon=\{<Pencil size=\{15\} \/>\} aria-label="编辑规则"/, "编辑按钮应为 icon+文字（账号卡规范）")
assert.match(mobile, /danger icon=\{<Trash2 size=\{15\} \/>\} aria-label="删除规则"/, "删除按钮应为 danger+icon+文字")
assert.match(mobile, /title="删除这条定时补充规则？"/, "删除确认标题与桌面逐字一致")
assert.match(mobile, /okText="删除"/, "删除确认 okText 与桌面一致")
assert.match(mobile, /locale=\{\{ emptyText: "暂无定时补充规则" \}\}/, "移动列表空态与桌面一致")
assert.match(mobile, /pagination=\{\{ pageSize: 10, hideOnSinglePage: true \}\}/, "移动分页应与桌面同参数")

// ── 移动优先 CSS：私有件进页面 css ─────────────────────────────────────────
assert.match(css, /\.scheduled-resource-mobile-foot\s*\{/, "尾部行样式应进 scheduled-resource.css")
assert.match(css, /\.scheduled-resource-mobile-foot \.admin-mobile-actions/, "操作行应复用共享 .admin-mobile-actions")

console.log("admin scheduled resource mobile card tests passed")
