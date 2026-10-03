"use strict"

// 公告卡片视图（2026-10-04 卡片化改造, 双视口统一 NewsCardView, 结构照礼包/账号页
// acc-card 模式）：源码断言 —— 页面接线、标题行结构(缩略图+两行标题块)、启用标识
// 收敛(无徽章/Switch, 恒位重标记按钮)、删除 icon-only、分页器、CSS 私有件。
// queryKey/API 断言仍在 admin-news-ui-source，两者互补。

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const projectRoot = path.resolve(__dirname, "..")
const newsPagePath = path.join(projectRoot, "admin/src/pages/News.tsx")
const cardViewPath = path.join(projectRoot, "admin/src/features/news/NewsCardView.tsx")
const newsCssPath = path.join(projectRoot, "admin/src/styles/pages/news.css")

for (const filePath of [newsPagePath, cardViewPath, newsCssPath]) {
    assert.equal(fs.existsSync(filePath), true, `缺少公告卡片文件：${filePath}`)
}
assert.equal(
    fs.existsSync(path.join(projectRoot, "admin/src/features/news/NewsMobileView.tsx")),
    false,
    "旧 NewsMobileView 应已删除(双视口统一 NewsCardView)",
)

const newsPage = fs.readFileSync(newsPagePath, "utf8")
const cardView = fs.readFileSync(cardViewPath, "utf8")
const newsCss = fs.readFileSync(newsCssPath, "utf8")

// ── 页面接线: 单一卡片视图, 无断点分支/表格/Switch ──────────────────────────
assert.doesNotMatch(newsPage, /<Table<AdminNewsRow>/, "桌面表格应已撤销(统一卡片)")
assert.doesNotMatch(newsPage, /NewsMobileView/, "旧移动视图引用应清除")
assert.doesNotMatch(newsPage, /useBreakpoint/, "双视口统一卡片后不再需要断点分支")
assert.doesNotMatch(newsPage, /<Switch/, "Switch 两套启用表达应移除(收敛到启停按钮)")
assert.match(newsPage, /<NewsCardView/, "公告页应渲染 NewsCardView")
assert.match(newsPage, /categoryLabels=\{CATEGORY_LABELS\}/, "分类文案应作为 props 下传（单一事实源）")
assert.match(newsPage, /categoryBadgeClass=\{CATEGORY_BADGE_CLASS\}/, "分类语义色映射应作为 props 下传")
assert.match(newsPage, /onToggle=\{row => toggle\.mutateAsync\(row\)\}/, "启停复用页面 toggle mutation(与原桌面 Switch 同通道)")

// ── 卡片结构: 缩略图 + 两行标题块 + 启停收敛 ────────────────────────────────
assert.match(cardView, /className="acc-card news-card"/, "卡片外壳复用账号页 acc-card")
assert.match(cardView, /<NewsThumb thumbnail=\{row\.thumbnail\} className="news-card-thumb" \/>/, "缩略图保留在标题行")
assert.match(cardView, /news-card-headline/, "第一行=分类徽章+标题")
assert.match(cardView, /className=\{categoryBadgeClass\[row\.category\]\}/, "分类徽章沿用页面语义色映射")
assert.match(cardView, /news-card-title/, "标题走两行截断样式")
assert.match(cardView, /news-card-time/, "第二行=发布时间")
assert.match(cardView, /发布时间 \{new Date\(row\.publishedAtReal\)\.toLocaleString\("zh-CN"\)\}/, "时间取自 publishedAtReal")
assert.match(cardView, /row\.label > 0 && <span> · 标签 \{row\.label\}<\/span>/, "标签>0 时并入第二行")

// ── 启用标识收敛: 无徽章/Switch, 恒位重标记按钮直呼 toggle ──────────────────
assert.doesNotMatch(cardView, /admin-badge-ok" : "admin-badge-muted/, "启用状态不得再用徽章表达")
assert.doesNotMatch(cardView, /停用这条公告|启用这条公告/, "启停不再走 Popconfirm 确认(与原桌面 Switch 一致, 直接切换; Popconfirm 仅删除使用)")
assert.match(cardView, /\{row\.enabled \? "停用" : "启用"\}/, "状态由启停按钮文字表达(恒位重标记)")
assert.match(cardView, /aria-label=\{row\.enabled \? "停用公告" : "启用公告"\}/, "启停按钮应有无障碍名")
assert.match(cardView, /active \? <CircleStop|row\.enabled \? <CircleStop/, "启停图标随状态切换")
assert.match(cardView, /togglingId === row\.id/, "启停进行中应有 loading 反馈")

// ── 底行操作: 编辑 + 垃圾桶 icon-only 删除 ─────────────────────────────────
assert.match(cardView, /icon=\{<Pencil size=\{15\} \/>\} aria-label="编辑公告"/, "编辑按钮保留")
assert.equal(cardView.split('aria-label="删除公告"').length - 1, 1, "删除入口唯一")
assert.match(cardView, /<Button danger icon=\{<Trash2 size=\{15\} \/>\} aria-label="删除公告" \/>/, "删除按钮应为垃圾桶 icon-only(A2')")
assert.doesNotMatch(cardView, />删除<\/Button>/, "删除按钮不得带文字(A2')")
assert.match(cardView, /title="删除这条公告？"/, "删除确认标题逐字一致")
assert.match(cardView, /description="此操作会物理删除公告，且无法恢复。"/, "删除确认说明逐字一致")
assert.match(cardView, /<Pagination/, "卡片视图应保留分页器")
assert.match(cardView, /showSizeChanger/, "分页应保留每页条数切换")
assert.match(cardView, /暂无公告/, "空态文案与原桌面一致")

// ── CSS: 私有件进页面 css ──────────────────────────────────────────────────
assert.match(newsCss, /\.news-card-heading \{[^}]*flex-direction: column/, "两行标题块样式应存在")
assert.match(newsCss, /\.news-card-title \{[^}]*-webkit-line-clamp: 2/, "标题应两行截断")
// 2026-10-04 二次调整: 三钮(启停/编辑/删除)合并一处 —— 桌面右侧一簇, 移动端最下一排
assert.match(cardView, /acc-actions news-card-actions/, "三钮应合并进标题行 actions 簇")
assert.doesNotMatch(cardView, /acc-bottom-row/, "独立底行应移除")
{
    const actionsStart = cardView.indexOf('acc-actions news-card-actions')
    const titlebarEnd = cardView.indexOf("</div>\n                        </div>\n                    </div>")
    const block = cardView.slice(actionsStart, actionsStart + 2200)
    assert.match(block, /aria-label="编辑公告"/, "编辑钮应在 actions 簇内")
    assert.match(block, /aria-label="删除公告"/, "删除钮应在 actions 簇内")
}
assert.match(newsCss, /\.news-card-actions \{[^}]*flex: 0 0 100%/, "移动端三钮应独占最下一排")
assert.match(newsCss, /@media \(min-width: 768px\) \{[\s\S]*?\.news-card \.news-card-actions \{[^}]*margin-left: auto/, "桌面端三钮应靠右成簇")
assert.doesNotMatch(newsCss, /news-status-toggle|news-mobile-/, "旧移动视图私有类应清除")
assert.doesNotMatch(newsCss, /news-title-cell/, "旧表格标题单元格类应清除")

console.log("admin news mobile card tests passed")
