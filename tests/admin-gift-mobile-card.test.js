"use strict"

// 礼包卡片视图（2026-10-04 卡片化改造, 双视口统一 GiftsCardView, 结构照账号页
// acc-card 已验证模式）：源码断言 —— 卡片结构(code chip/状态徽章/启停恒位重标记/
// 编辑仅 stopped/垃圾桶 icon-only 删除/记录 N 折叠内嵌面板)、空白点按防穿透、
// 分页器、奖励 chips 复用 rewardDisplay、内嵌面板组件化。queryKey/API 结构断言
// 仍在 admin-gift-ui-source，两者互补。

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const projectRoot = path.resolve(__dirname, "..")
const giftsPagePath = path.join(projectRoot, "admin/src/pages/Gifts.tsx")
const cardViewPath = path.join(projectRoot, "admin/src/features/gifts/GiftsCardView.tsx")
const redemptionsPath = path.join(projectRoot, "admin/src/features/gifts/GiftRedemptions.tsx")
const giftsCssPath = path.join(projectRoot, "admin/src/styles/pages/gifts.css")

for (const filePath of [giftsPagePath, cardViewPath, redemptionsPath, giftsCssPath]) {
    assert.equal(fs.existsSync(filePath), true, `缺少礼包卡片文件：${filePath}`)
}
assert.equal(
    fs.existsSync(path.join(projectRoot, "admin/src/features/gifts/GiftsMobileView.tsx")),
    false,
    "旧 GiftsMobileView 应已删除(双视口统一 GiftsCardView)",
)

const giftsPage = fs.readFileSync(giftsPagePath, "utf8")
const cardView = fs.readFileSync(cardViewPath, "utf8")
const redemptions = fs.readFileSync(redemptionsPath, "utf8")
const giftsCss = fs.readFileSync(giftsCssPath, "utf8")

// ── 页面接线: 单一卡片视图 + 展开状态页级持有(单开互斥) ─────────────────────
assert.doesNotMatch(giftsPage, /<Table<AdminGiftRow>/, "桌面表格应已撤销(统一卡片)")
assert.doesNotMatch(giftsPage, /GiftsMobileView/, "旧移动视图引用应清除")
assert.doesNotMatch(giftsPage, /useBreakpoint/, "双视口统一卡片后不再需要断点分支")
assert.match(giftsPage, /<GiftsCardView/, "礼包页应渲染 GiftsCardView")
assert.match(giftsPage, /expandedGiftId/, "页面应持有展开态(单开互斥)")
assert.match(giftsPage, /current === id \? null : id/, "展开切换应为单开互斥")
assert.match(giftsPage, /rewardLookups=\{rewardLookups\}/, "奖励名称 lookup 应作为 props 下传")
assert.match(giftsPage, /admin-mobile-list-card/, "列表仍挂在页面级 Card 内")

// ── 卡片结构(照账号页 acc-card): 空白点按防穿透 + 记录内嵌 ──────────────────
assert.match(cardView, /className="acc-card gift-card"/, "卡片外壳复用账号页 acc-card")
assert.match(cardView, /if \(event\.target !== event\.currentTarget\) return/, "空白点按应有 target 判定(防点击穿透)")
assert.match(cardView, /onToggleExpand\(row\.id\)/, "空白点按应切换记录展开")
assert.match(cardView, /acc-titlebar/, "标题行复用账号页结构")
assert.match(cardView, /acc-bottom-row/, "底行复用账号页结构")
assert.match(cardView, /gift-card-records/, "记录内嵌展开区应存在")
assert.match(cardView, /<GiftRedemptions gift=\{row\} \/>/, "展开区应渲染内嵌记录面板")

// ── 启停恒位重标记 + 编辑仅 stopped + 垃圾桶 icon-only 删除 ─────────────────
assert.match(cardView, /\{active \? "停止" : "启动"\}/, "启停按钮应恒在原位重标记（不消失）")
assert.match(cardView, /active \? <CircleStop size=\{15\} \/> : <Play size=\{15\} \/>/, "启停图标随状态切换")
assert.match(cardView, /\{!active && \(/, "编辑仅 stopped 提供")
{
    // 编辑+删除同在 stopped 分支内(原桌面严格语义: active 先停止再修改/删除)
    const stoppedStart = cardView.indexOf("{!active && (")
    const recordsStart = cardView.indexOf("gift-card-records")
    const stoppedBlock = cardView.slice(stoppedStart, recordsStart)
    assert.match(stoppedBlock, /aria-label="编辑礼包"/)
    assert.match(stoppedBlock, /aria-label="删除礼包"/)
}
assert.equal(cardView.split('aria-label="删除礼包"').length - 1, 1, "删除入口唯一")
assert.match(cardView, /<Button danger icon=\{<Trash2 size=\{15\} \/>\} aria-label="删除礼包" \/>/, "删除按钮应为垃圾桶 icon-only(A2')")
assert.doesNotMatch(cardView, />删除<\/Button>/, "删除按钮不得带文字(A2')")
assert.match(cardView, /title="删除这个礼包？"/, "删除确认标题与原桌面逐字一致")
assert.match(cardView, /description="此操作不可恢复，将清除全部领取记录，同 code 重建后可重新领取。"/, "删除确认说明逐字一致")

// ── 状态收敛/更新时间/chips/meta/分页 ───────────────────────────────────────
// 2026-10-04 专项整理: 启用/停止徽章移除, 状态收敛到启停按钮文字(和存档页相同);
// 更新时间跟在 code 后
assert.doesNotMatch(cardView, /admin-badge-ok|admin-badge-muted/, "卡片本体不得再出现状态徽章")
assert.match(cardView, /gift-card-time/, "更新时间应跟在 code 后(专项整理)")
assert.match(cardView, /更新时间 \{new Date\(row\.updatedAt\)\.toLocaleString\("zh-CN"\)\}/, "更新时间取自 updatedAt")
assert.match(cardView, /giftRewardChipTexts\(row\.rewards, rewardLookups\)/, "奖励 chips 应复用 rewardDisplay")
assert.match(cardView, /gift-reward-chip-more/, "奖励 chips 应保留 ≤2+N 折叠")
assert.match(cardView, /记录 \{row\.redemptionCount\}/, "底行折叠钮应展示已领取数")
assert.match(cardView, /奖励版本 <b className="admin-mono">\{row\.rewardRevision\}<\/b>/, "奖励版本取自 rewardRevision")
assert.match(cardView, /版本 <b className="admin-mono">\{row\.revision\}<\/b>/, "版本取自 revision")
assert.match(cardView, /<Pagination/, "卡片视图应保留分页器")
assert.match(cardView, /showSizeChanger/, "分页应保留每页条数切换")
assert.match(cardView, /暂无礼包/, "空态文案与原桌面一致")

// ── 内嵌记录面板: 组件化去 Card 壳, queryKey 逐字保留 ───────────────────────
assert.doesNotMatch(redemptions, /<Card/, "记录面板不应再有独立 Card 壳")
assert.doesNotMatch(redemptions, /onClose/, "内嵌面板无需关闭按钮(收起走卡片折叠钮)")
assert.match(redemptions, /queryKey: \["adminGiftRedemptions", gift\.id, page, pageSize, search\]/, "queryKey 与原面板逐字一致")
assert.match(redemptions, /`\/api\/gifts\/\$\{gift\.id\}\/redemptions\?page=/, "API 路径与原面板逐字一致")
assert.match(redemptions, /搜索玩家名或精确 Player\/Account ID/, "搜索入口保留")

// ── CSS: 私有件进页面 css, 不新增桌面表格规则 ──────────────────────────────
assert.match(giftsCss, /\.gift-card-records\s*\{/, "记录展开区样式应存在")
assert.match(giftsCss, /\.gift-card \.acc-bottom-row \.ant-btn:not\(\.acc-count-toggle\)/, "底行按钮不挤占折叠钮")
// 2026-10-04 专项整理: meta+操作行移动端上下两行, 桌面端并排一行
assert.match(giftsCss, /\.gift-card-infoline \{[^}]*flex-direction: column/, "移动端 meta+操作上下排列")
assert.match(giftsCss, /@media \(min-width: 768px\) \{[\s\S]*?\.gift-card-infoline \{[^}]*flex-direction: row/, "桌面端 meta+操作并排一行")
assert.match(giftsCss, /\.gift-card-heading \{[^}]*flex-direction: column/, "标题两行结构样式应存在")
assert.match(giftsCss, /\.gift-card-time \{/, "更新时间行内样式应存在")
assert.equal(giftsCss.match(/\.admin-ops-table/g)?.length, 1, "gifts css 不应新增桌面表格规则")
assert.doesNotMatch(giftsCss, /gift-mobile-/, "旧移动视图私有类应清除")

console.log("admin gift mobile card tests passed")
