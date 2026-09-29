"use strict"

// 公告移动卡片视图（task-31，照账号页 AccountsMobileView 已验证模式）：
// 源码断言 —— 断点切换接线、分类语义徽章、操作行 icon+文字、删除确认文案与桌面
// 逐字一致、分页器保留、移动优先 CSS 私有件。queryKey/API 断言仍在
// admin-news-ui-source，两者互补。

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const projectRoot = path.resolve(__dirname, "..")
const newsPagePath = path.join(projectRoot, "admin/src/pages/News.tsx")
const newsMobilePath = path.join(projectRoot, "admin/src/features/news/NewsMobileView.tsx")
const newsCssPath = path.join(projectRoot, "admin/src/styles/pages/news.css")

for (const filePath of [newsPagePath, newsMobilePath, newsCssPath]) {
    assert.equal(fs.existsSync(filePath), true, `缺少公告移动卡片文件：${filePath}`)
}

const newsPage = fs.readFileSync(newsPagePath, "utf8")
const newsMobile = fs.readFileSync(newsMobilePath, "utf8")
const newsCss = fs.readFileSync(newsCssPath, "utf8")

// ── 断点切换接线（照 Accounts.tsx：Grid.useBreakpoint / !screens.md）────────
assert.match(newsPage, /const \{ useBreakpoint \} = Grid/, "公告页应使用 Grid.useBreakpoint")
assert.match(newsPage, /const screens = useBreakpoint\(\)/, "公告页应读取断点")
assert.match(newsPage, /const isMobile = !screens\.md/, "公告页断点语义应是 <md 即移动")
assert.match(newsPage, /\{isMobile && \(/, "公告页应有移动渲染分支")
assert.match(newsPage, /\{!isMobile && \(/, "公告页应保留桌面渲染分支")
assert.match(newsPage, /<NewsMobileView/, "公告页移动分支应渲染 NewsMobileView")
assert.match(newsPage, /<Table<AdminNewsRow>/, "公告页桌面分支应保留 Table")
assert.match(newsPage, /categoryLabels=\{CATEGORY_LABELS\}/, "分类文案应作为 props 下传（单一事实源）")
assert.match(newsPage, /categoryBadgeClass=\{CATEGORY_BADGE_CLASS\}/, "分类语义色映射应作为 props 下传")

// ── 移动卡片：徽章语义 + 操作行 + 确认文案 ─────────────────────────────────
assert.match(newsMobile, /className=\{categoryBadgeClass\[row\.category\]\}/, "移动卡片分类徽章应沿用页面语义色映射")
assert.match(newsMobile, /row\.enabled \? "admin-badge-ok" : "admin-badge-muted"/, "启用/停用应为 ok/muted 徽章")
assert.match(newsMobile, /启用/, "启用徽章文案存在")
assert.match(newsMobile, /停用/, "停用徽章文案存在")
assert.match(newsMobile, /news-mobile-title/, "移动卡片标题应走两行截断样式")
assert.match(newsMobile, /<NewsThumb thumbnail=\{row\.thumbnail\} \/>/, "移动卡片应保留缩略图")
assert.match(newsMobile, /icon=\{<Pencil size=\{15\} \/>\} aria-label="编辑公告"/, "编辑按钮应为 icon+文字（账号卡规范）")
assert.match(newsMobile, /danger icon=\{<Trash2 size=\{15\} \/>\} aria-label="删除公告"/, "删除按钮应为 danger+icon+文字")
assert.match(newsMobile, /title="删除这条公告？"/, "删除确认标题与桌面逐字一致")
assert.match(newsMobile, /description="此操作会物理删除公告，且无法恢复。"/, "删除确认说明与桌面逐字一致")
assert.match(newsMobile, /okText="删除"/, "删除确认 okText 与桌面一致")
assert.match(newsMobile, /locale=\{\{ emptyText: "暂无公告" \}\}/, "移动列表空态与桌面一致")
assert.match(newsMobile, /pagination=\{\{/, "移动列表应保留分页器")
assert.match(newsMobile, /showSizeChanger: true/, "移动分页应保留每页条数切换")

// ── 移动优先 CSS：私有件进页面 css ─────────────────────────────────────────
assert.match(newsCss, /\.news-mobile-title\s*\{[\s\S]*?-webkit-line-clamp: 2/, "news 移动标题应两行截断")

console.log("admin news mobile card tests passed")
