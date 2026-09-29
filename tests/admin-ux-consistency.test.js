"use strict"

// admin UI UX 一致性机械化约束（task-33，源码断言，条款源自 task-32 审计报告）：
//   C1  — 所有 scroll={{ x: ... }} 的 Table 必须配 tableLayout="fixed"（±5 行内）
//   E3a — tsx 内联代码禁 6 位 hex 色值；styles/ 禁 @media (max-width（移动优先约定）
//   B3  — UI 与注释均禁「默认存档」「账号默认」（术语统一为「当前存档」）
//   B2  — GameplaySettings 禁「已开启」「已关闭」（开关状态由 Switch 本体表达，不设文字徽章）
//   A2  — PlayerDetail 删除按钮禁 icon（纯文字红按钮 + Popconfirm 红确认键）
//   A1  — 移动卡片视图（礼包/定时资源）禁 Switch 式 checkedChildren（启停恒位重标记按钮制）
//   F1  — 全仓 tsx 禁 icon={<DeleteOutlined（桌面删除类禁 icon）
//
// hex 色值白名单（文件级豁免，内联于本头注释）：
//   - admin/src/theme.tsx                    antd ThemeConfig 令牌（主题 API 值，非内联样式）
//   - admin/src/features/news/newsPreview.tsx  公告手机预览的客户端拟真渐变调色板数据
//     （模拟客户端渲染素材，非管理端 UI 主题色；暗色主题不随之切换属预期）
// F1 移动视图豁免清单（移动操作行允许 lucide Trash2 图标，A3 规格）：
//   - admin/src/features/gifts/GiftsMobileView.tsx
//   - admin/src/pages/accounts/AccountsMobileView.tsx
//   - admin/src/components/ScheduledResourceMobileView.tsx

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const projectRoot = path.resolve(__dirname, "..")
const adminSrc = path.join(projectRoot, "admin/src")
const adminStyles = path.join(adminSrc, "styles")

function listFiles(dir, exts) {
    const out = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) out.push(...listFiles(full, exts))
        else if (exts.some(ext => entry.name.endsWith(ext))) out.push(full)
    }
    return out
}

// 剥离注释后再做字面量扫描：注释里的色值/媒体查询字样不构成渲染行为
function stripComments(src, isCss) {
    let out = src.replace(/\/\*[\s\S]*?\*\//g, " ")
    if (!isCss) out = out.replace(/\/\/[^\n]*/g, " ")
    return out
}

const tsxFiles = listFiles(adminSrc, [".tsx", ".ts"])
const rel = file => path.relative(projectRoot, file).split(path.sep).join("/")

// ── C1：scroll.x 横滚表必须配 tableLayout="fixed" ──────────────────────────
let scrollXCount = 0
for (const file of tsxFiles) {
    const lines = fs.readFileSync(file, "utf8").split("\n")
    lines.forEach((line, i) => {
        if (!/scroll=\{\{ x: /.test(line)) return
        scrollXCount += 1
        const window = lines.slice(Math.max(0, i - 5), i + 6).join("\n")
        assert.match(
            window,
            /tableLayout="fixed"/,
            `${rel(file)}:${i + 1} scroll={{ x: ... }} 的 Table 5 行内缺 tableLayout="fixed"（C1：fixed 布局防列宽漂移）`,
        )
    })
}
assert.ok(scrollXCount > 0, "应存在 scroll.x 表格（扫描器自身有效性检查）")

// ── E3a：tsx 内联代码禁 hex 色值 / styles 禁 max-width 媒体查询 ─────────────
const hexWhitelist = new Set([
    rel(path.join(adminSrc, "theme.tsx")),
    rel(path.join(adminSrc, "features/news/newsPreview.tsx")),
])
const hexRe = /#[0-9a-fA-F]{6}\b/
for (const file of tsxFiles) {
    if (hexWhitelist.has(rel(file))) continue
    const src = stripComments(fs.readFileSync(file, "utf8"), false)
    assert.doesNotMatch(
        src,
        hexRe,
        `${rel(file)} 存在 6 位 hex 色值（E3a：颜色必须走 base.css 的 --token，暗色主题才能随动）`,
    )
}

const cssFiles = listFiles(adminStyles, [".css"])
for (const file of cssFiles) {
    const src = stripComments(fs.readFileSync(file, "utf8"), true)
    assert.doesNotMatch(
        src,
        /@media \(max-width/,
        `${rel(file)} 存在 @media (max-width（E3a：约定移动优先——窄屏值为默认，桌面用 @media (min-width: 768px) 升档）`,
    )
}

// ── B3：术语统一——禁「默认存档」「账号默认」 ────────────────────────────────
for (const file of tsxFiles) {
    const src = fs.readFileSync(file, "utf8")
    assert.doesNotMatch(src, /默认存档|账号默认/, `${rel(file)} 出现「默认存档/账号默认」（B3：术语统一为「当前存档」）`)
}

// ── B2：GameplaySettings 开关状态禁文字徽章化 ───────────────────────────────
{
    const src = fs.readFileSync(path.join(adminSrc, "pages/GameplaySettings.tsx"), "utf8")
    assert.doesNotMatch(src, /已开启|已关闭/, "GameplaySettings.tsx 出现「已开启/已关闭」（B2：开关状态由 Switch 本体表达，不得文字徽章化）")
}

// ── A2：PlayerDetail 删除按钮禁 icon ────────────────────────────────────────
{
    const src = fs.readFileSync(path.join(adminSrc, "pages/PlayerDetail.tsx"), "utf8")
    assert.doesNotMatch(src, /icon=\{<DeleteOutlined/, "PlayerDetail.tsx 删除按钮带 icon（A2：删除类统一纯文字红按钮 + Popconfirm）")
}

// ── A1：移动卡片视图禁 Switch 式启停 ────────────────────────────────────────
for (const name of ["features/gifts/GiftsMobileView.tsx", "components/ScheduledResourceMobileView.tsx"]) {
    const src = fs.readFileSync(path.join(adminSrc, name), "utf8")
    assert.doesNotMatch(src, /checkedChildren/, `admin/src/${name} 使用 checkedChildren（A1：移动卡片启停为恒位重标记按钮制，非 Switch）`)
}

// ── F1：全仓 tsx 禁删除 icon 按钮（移动视图豁免清单见头注释） ───────────────
const f1Whitelist = new Set([
    rel(path.join(adminSrc, "features/gifts/GiftsMobileView.tsx")),
    rel(path.join(adminSrc, "pages/accounts/AccountsMobileView.tsx")),
    rel(path.join(adminSrc, "components/ScheduledResourceMobileView.tsx")),
])
for (const file of tsxFiles) {
    if (f1Whitelist.has(rel(file))) continue
    const src = fs.readFileSync(file, "utf8")
    assert.doesNotMatch(src, /icon=\{<DeleteOutlined/, `${rel(file)} 删除按钮带 DeleteOutlined icon（F1：桌面删除类禁 icon，纯文字红）`)
}

console.log(`admin ux consistency tests passed (scroll.x tables checked: ${scrollXCount})`)
