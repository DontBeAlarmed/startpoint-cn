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

// ── 启停恒位重标记 + 编辑/删除常驻(生效中锁定) + 垃圾桶 icon-only 删除 ────────
assert.match(cardView, /\{active \? "生效中" : "已停用"\}/, "状态钮显示当前状态(恒位重标记, 不消失)")
// 2026-10-04: 状态色钮(绿=生效中/红=已停用), 状态钮一律不带图标
assert.match(cardView, /className=\{active \? "admin-state-active" : "admin-state-stopped"\}/, "启停钮应带状态色类(绿=生效中/红=已停用)")
assert.doesNotMatch(cardView, /aria-label="停止礼包"[^/]*icon=/, "状态钮一律不带图标(维护者 2026-10-04)")
assert.doesNotMatch(cardView, /CircleStop/, "停止钮不应再有 CircleStop 图标")
// 2026-10-04 二次调整: 编辑/删除常驻(布局不变); 生效中置灰锁定, 点击提示需先停用
assert.doesNotMatch(cardView, /\{!active && \(/, "编辑/删除不再按状态隐藏")
assert.match(cardView, /gift-card-btn-locked/, "锁定态样式类应存在")
assert.match(cardView, /需停用后编辑礼包/, "生效中点编辑应有提醒")
assert.match(cardView, /需停用后删除礼包/, "生效中点删除应有提醒")
assert.match(cardView, /disabled=\{active\}/, "生效中删除应禁用 Popconfirm(走提醒)")
{
    const block = cardView.slice(cardView.indexOf("acc-actions"), cardView.indexOf("gift-card-records"))
    assert.match(block, /aria-label="编辑礼包"/, "编辑钮常驻")
    assert.match(block, /aria-label="删除礼包"/, "删除钮常驻")
}
assert.equal(cardView.split('aria-label="删除礼包"').length - 1, 1, "删除入口唯一")
assert.match(cardView, /<Button\s+danger\s+className=\{active \? "gift-card-btn-locked" : undefined\}\s+aria-disabled=\{active\}\s+icon=\{<Trash2 size=\{15\} \/>\}\s+aria-label="删除礼包"/, "删除按钮应为垃圾桶 icon-only(A2', 生效中带锁定类)")
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
// 2026-10-04 二次修正: 双端统一 —— chips 全量平铺单行, 超出左右滚动(无滚动条),
// +N 折叠机制整体移除(触屏无 tooltip 打不开, 桌面同改滚动)
assert.doesNotMatch(cardView, /gift-reward-chip-more|gift-reward-chip-extra/, "chips 折叠机制(+N/extra)应整体移除")
assert.match(cardView, /chips\.map\(/, "奖励 chips 应全量渲染")
assert.match(cardView, /领取记录 \{row\.redemptionCount\}/, "折叠钮应展示「领取记录 N」(维护者 2026-10-04)")
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
// 奖励 chips: 双端单行滚动, 滚动条隐藏
assert.match(giftsCss, /\.gift-card-chips \{[^}]*flex-wrap: nowrap/, "chips 应单行不换行")
assert.match(giftsCss, /\.gift-card-chips \{[^}]*overflow-x: auto/, "chips 超出应可左右滚动")
assert.match(giftsCss, /\.gift-card-chips \{[^}]*scrollbar-width: none/, "滚动条应隐藏(Firefox)")
assert.match(giftsCss, /\.gift-card-chips::-webkit-scrollbar \{[^}]*display: none/, "滚动条应隐藏(Chromium)")
assert.doesNotMatch(giftsCss, /gift-reward-chip-extra|gift-reward-chip-more/, "chips 折叠 CSS 应清除")
// 礼包码即卡片标题(无名称字段): 标题级字重, 不是 id-chip 灰字
assert.match(giftsCss, /\.gift-card-code \{[^}]*font-size: 15px/, "礼包码标题字号应为 15px")
assert.match(giftsCss, /\.gift-card-code \{[^}]*font-weight: 700/, "礼包码标题应为粗体")
// 编辑器添加奖励按钮与上方奖励卡片间距显式钉住(间隔丢失第二次返修)
assert.match(giftsCss, /\.gift-add-reward\.ant-btn \{[^}]*margin-top: 10px/, "添加奖励按钮应与上方卡片保持间距")
assert.equal(giftsCss.match(/\.admin-ops-table/g)?.length, 1, "gifts css 不应新增桌面表格规则")
assert.doesNotMatch(giftsCss, /gift-mobile-/, "旧移动视图私有类应清除")

console.log("admin gift mobile card tests passed")
