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

// ── 移动卡片：启停恒位重标记（不消失）+ 编辑仅 stopped（恒排末位）+ 确认文案 ──
// (维护者 2026-09-30: 点击启动后按钮消失的 UX 不统一 → 与定时资源卡 停用/启用 同模式)
assert.match(giftsMobile, /\{active \? "停止" : "启动"\}/, "启停按钮应恒在原位重标记（不消失）")
assert.match(giftsMobile, /active \? <CircleStop size=\{15\} \/> : <Play size=\{15\} \/>/, "启停图标随状态切换")
assert.match(giftsMobile, /\{!active && \(\n\s*<Button icon=\{<Pencil size=\{15\} \/>\} aria-label="编辑礼包"/, "编辑仅 stopped 提供且恒排末位")
assert.equal(giftsMobile.split('aria-label="删除礼包"').length - 1, 1, "删除入口唯一")
assert.match(giftsMobile, /aria-label="领取记录"/, "应有领取记录入口")
assert.match(giftsMobile, /title="删除这个礼包？"/, "删除确认标题与桌面逐字一致")

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
