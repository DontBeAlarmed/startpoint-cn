"use strict"

// 礼包移动卡片视图（task-31，照账号页 AccountsMobileView 已验证模式）：
// 源码断言 —— 断点切换接线、状态徽章、active 无编辑入口、奖励 chips 复用 rewardDisplay、
// 删除确认文案与桌面逐字一致、分页器保留、移动优先 CSS 私有件。queryKey/API 与桌面操作列
// 结构断言仍在 admin-gift-ui-source，两者互补。

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const projectRoot = path.resolve(__dirname, "..")
const giftsPagePath = path.join(projectRoot, "admin/src/pages/Gifts.tsx")
const giftsMobilePath = path.join(projectRoot, "admin/src/features/gifts/GiftsMobileView.tsx")
const giftsCssPath = path.join(projectRoot, "admin/src/styles/pages/gifts.css")

for (const filePath of [giftsPagePath, giftsMobilePath, giftsCssPath]) {
    assert.equal(fs.existsSync(filePath), true, `缺少礼包移动卡片文件：${filePath}`)
}

const giftsPage = fs.readFileSync(giftsPagePath, "utf8")
const giftsMobile = fs.readFileSync(giftsMobilePath, "utf8")
const giftsCss = fs.readFileSync(giftsCssPath, "utf8")

// ── 断点切换接线（照 Accounts.tsx：Grid.useBreakpoint / !screens.md）────────
assert.match(giftsPage, /const \{ useBreakpoint \} = Grid/, "礼包页应使用 Grid.useBreakpoint")
assert.match(giftsPage, /const screens = useBreakpoint\(\)/, "礼包页应读取断点")
assert.match(giftsPage, /const isMobile = !screens\.md/, "礼包页断点语义应是 <md 即移动")
assert.match(giftsPage, /\{isMobile && \(/, "礼包页应有移动渲染分支")
assert.match(giftsPage, /\{!isMobile && \(/, "礼包页应保留桌面渲染分支")
assert.match(giftsPage, /<GiftsMobileView/, "礼包页移动分支应渲染 GiftsMobileView")
assert.match(giftsPage, /<Table<AdminGiftRow>/, "礼包页桌面分支应保留 Table")
assert.match(giftsPage, /rewardLookups=\{rewardLookups\}/, "奖励名称 lookup 应作为 props 下传")

// ── 移动卡片：active 无编辑入口 + 状态分流 + 确认文案 ──────────────────────
const ternaryStart = giftsMobile.indexOf("{active ? (")
const ternarySep = giftsMobile.indexOf(") : (", ternaryStart)
const ternaryEndMatch = giftsMobile.slice(ternarySep).match(/\)\}\s*<Popconfirm/)
assert.notEqual(ternaryStart, -1, "礼包移动操作行应存在 active 分流")
assert.notEqual(ternarySep, -1, "礼包移动操作行应存在 stopped 分流")
assert.notEqual(ternaryEndMatch, null, "礼包移动操作行分流应终止于共享删除确认")
const activeBranch = giftsMobile.slice(ternaryStart, ternarySep)
const stoppedBranch = giftsMobile.slice(ternarySep, ternarySep + ternaryEndMatch.index)

assert.equal(activeBranch.includes("编辑"), false, "active 礼包移动卡片不能提供编辑（先停止再修改）")
assert.match(activeBranch, /停止/, "active 礼包移动卡片应有停止入口")
assert.match(activeBranch, /记录/, "active 礼包移动卡片应有领取记录入口")
assert.match(stoppedBranch, /编辑/, "stopped 礼包移动卡片应有编辑入口")
assert.match(stoppedBranch, /启动/, "stopped 礼包移动卡片应有启动入口")
assert.match(stoppedBranch, /记录/, "stopped 礼包移动卡片应有领取记录入口")

assert.match(giftsMobile, /active \? "admin-badge-ok" : "admin-badge-muted"/, "礼包状态应为 ok/muted 徽章")
assert.match(giftsMobile, /启用/, "礼包启用徽章文案存在")
assert.match(giftsMobile, /停止/, "礼包停止徽章文案存在")
assert.match(giftsMobile, /giftRewardChipTexts\(row\.rewards, rewardLookups\)/, "奖励 chips 应复用 rewardDisplay")
assert.match(giftsMobile, /gift-reward-chip-more/, "奖励 chips 应保留 ≤2+N 折叠")
assert.match(giftsMobile, /title="删除这个礼包？"/, "删除确认标题与桌面逐字一致")
assert.match(giftsMobile, /description="此操作不可恢复，将清除全部领取记录，同 code 重建后可重新领取。"/, "删除确认说明与桌面逐字一致")
assert.match(giftsMobile, /okText="删除"/, "删除确认 okText 与桌面一致")
assert.match(giftsMobile, /locale=\{\{ emptyText: "暂无礼包" \}\}/, "移动列表空态与桌面一致")
assert.match(giftsMobile, /pagination=\{\{/, "移动列表应保留分页器")
assert.match(giftsMobile, /showSizeChanger: true/, "移动分页应保留每页条数切换")

// ── 移动优先 CSS：私有件进页面 css，桌面表格规则零新增 ─────────────────────
assert.match(giftsCss, /\.gift-mobile-code\s*\{[\s\S]*?AdminMono/, "gift 移动 code 应读作 mono 标题")
assert.equal(giftsCss.match(/\.admin-ops-table/g)?.length, 1, "gifts css 不应新增桌面表格规则")

console.log("admin gift mobile card tests passed")
