"use strict"

// 定时资源补充卡片视图（2026-10-04 卡片化改造, 双视口统一 ScheduledResourceCardView,
// 结构照礼包/公告页 acc-card 模式）：源码断言 —— 页面接线、标题行(资源名+范围徽章/
// 启用区间)、状态钮(绿=生效中/红=已停用, 显示当前状态)、编辑+垃圾桶删除、分页、
// CSS 私有件。三个锚点类与 API/文案锚点仍在 admin-scheduled-resource-ui-source。

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const projectRoot = path.resolve(__dirname, "..")
const componentPath = path.join(projectRoot, "admin/src/components/ScheduledResourceRules.tsx")
const cardViewPath = path.join(projectRoot, "admin/src/components/ScheduledResourceCardView.tsx")
const cssPath = path.join(projectRoot, "admin/src/styles/pages/scheduled-resource.css")

for (const filePath of [componentPath, cardViewPath, cssPath]) {
    assert.equal(fs.existsSync(filePath), true, `缺少定时资源卡片文件：${filePath}`)
}
assert.equal(
    fs.existsSync(path.join(projectRoot, "admin/src/components/ScheduledResourceMobileView.tsx")),
    false,
    "旧 ScheduledResourceMobileView 应已删除(双视口统一 ScheduledResourceCardView)",
)

const component = fs.readFileSync(componentPath, "utf8")
const cardView = fs.readFileSync(cardViewPath, "utf8")
const css = fs.readFileSync(cssPath, "utf8")

// ── 页面接线: 单一卡片视图, 无断点分支/表格 ─────────────────────────────────
assert.doesNotMatch(component, /<Table<ScheduledResourceRule>/, "桌面表格应已撤销(统一卡片)")
assert.doesNotMatch(component, /useBreakpoint/, "双视口统一卡片后不再需要断点分支")
assert.match(component, /<ScheduledResourceCardView/, "定时资源组件应渲染 ScheduledResourceCardView")
assert.match(component, /新建规则/, "新建规则按钮应保留")
assert.match(component, /className="admin-mobile-list-card"/, "列表仍挂在页面级 Card 内")

// ── 卡片结构: 资源名+范围徽章 / 启用区间 / 状态钮 / 编辑 / 删除 ─────────────
assert.match(cardView, /className="acc-card sched-card"/, "卡片外壳复用账号页 acc-card")
// 2026-10-04 二次调整: 徽章在名称前(移动端独占左上/桌面同行), 启用区间并入信息行
// 2026-10-05: 范围徽章移到资源名前方(同行, 间隔 8px)—— 标题行包一层 headline 行容器
assert.match(cardView, /sched-headline/, "徽章+资源名应有同行行容器")
assert.match(css, /\.sched-headline \{[^}]*gap: 8px/, "徽章与资源名间隔 8px")
assert.match(cardView, /admin-badge-info">全局规则<\/span>[\s\S]*?sched-title/, "范围徽章应位于资源名之前(移动端即左上)")
assert.match(cardView, /rule\.scope === "global"\n?\s*\? <span className="admin-badge-info">全局规则<\/span>/, "全局规则应为 info 徽章")
assert.match(cardView, /admin-badge-muted">指定存档 #\{rule\.playerId\}/, "指定存档应为 muted 徽章")
assert.match(cardView, /启用区间\{" "\}/, "启用区间应并入信息行")
assert.match(cardView, /发放数量/, "meta 行应含发放数量")
assert.match(cardView, /触发下限/, "meta 行应含触发下限")
assert.match(cardView, /持有上限/, "meta 行应含持有上限")
assert.match(cardView, /rule\.description && /, "备注应有则显示")

// ── 状态钮: 显示当前状态(绿=生效中/红=已停用), 无图标 ──────────────────────
assert.match(cardView, /className=\{rule\.enabled \? "admin-state-active" : "admin-state-stopped"\}/, "状态钮应带状态色类")
assert.match(cardView, /\{rule\.enabled \? "生效中" : "已停用"\}/, "状态钮显示当前状态(恒位重标记)")
assert.match(cardView, /aria-label=\{rule\.enabled \? "点击停用规则" : "点击启用规则"\}/, "状态钮应有无障碍名(描述点击动作)")
assert.doesNotMatch(cardView, /CircleStop|Play/, "状态钮不应有任何图标")
// 2026-10-05: loading 动画移除(维护者指定: 只做颜色/内容切换, 尺寸不变), 无 loading 透传

// ── 操作行: 编辑 + 垃圾桶 icon-only 删除 ───────────────────────────────────
assert.match(cardView, /icon=\{<Pencil size=\{15\} \/>\} aria-label="编辑规则"/, "编辑按钮保留")
assert.equal(cardView.split('aria-label="删除规则"').length - 1, 1, "删除入口唯一")
assert.match(cardView, /<Button danger icon=\{<Trash2 size=\{15\} \/>\} aria-label="删除规则" \/>/, "删除按钮应为垃圾桶 icon-only(A2')")
assert.match(cardView, /title="删除这条定时补充规则？"/, "删除确认标题逐字一致")
assert.match(cardView, /<Pagination/, "卡片视图应保留分页器")
assert.match(cardView, /暂无定时补充规则/, "空态文案与原桌面一致")

// ── CSS: 私有件进页面 css ──────────────────────────────────────────────────
assert.match(css, /\.sched-card \{[^}]*min-width: 0/, "卡片收缩样式应存在")
assert.match(css, /\.sched-heading \{[^}]*flex-direction: column/, "移动端徽章/名称应上下排列")
// 区块摆放(grid areas): 移动端单列三钮最下一排, 桌面端标题+三钮同排、信息行横贯
assert.match(css, /\.sched-card \{[^}]*grid-template-areas:[\s\S]*?"head"\s*"meta"\s*"actions"/, "移动端三钮应独占最下一排(grid 区块)")
assert.match(css, /@media \(min-width: 768px\) \{[\s\S]*?grid-template-areas:[\s\S]*?"head actions"\s*"meta meta"/, "桌面端标题+三钮同排(grid 区块)")
assert.match(css, /@media \(min-width: 768px\) \{[\s\S]*?\.sched-heading \{[^}]*flex-direction: row/, "桌面端徽章与名称应同行")
assert.doesNotMatch(css, /scheduled-resource-mobile-/, "旧移动视图私有类应清除")

console.log("admin scheduled resource mobile card tests passed")
