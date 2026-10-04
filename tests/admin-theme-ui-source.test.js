"use strict"
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
// styles.css is an @import entry; read entry + all parts in import order
const adminSrcDir = path.join(__dirname, "../admin/src")
const css = [...fs.readFileSync(path.join(adminSrcDir, "styles.css"), "utf8").matchAll(/@import\s+"([^"]+)";/g)]
    .map(match => fs.readFileSync(path.join(adminSrcDir, match[1]), "utf8"))
    .join("\n")
for (const v of ["--bg:#F5F6F9", "--panel:#FFFFFF", "--star:#FFD335", "--ink:#1F2D4D", "--water:#2E7FD6", "--wind:#2FA85C", "--thunder:#D99A00", "--fire:#E8544A"]) {
    assert.ok(css.includes(v), `缺少明色 token ${v}`)
}
assert.ok(css.includes('html[data-theme="dark"]'), "缺少暗色 token 块")
assert.ok(css.includes("--bg:#0D1117"), "缺少暗色页面底色")
for (const banned of ["#1890ff", "#faad14", "#ff4d4f"]) {
    assert.equal(css.includes(banned), false, `不得残留 AntD 旧默认色 ${banned}`)
}
const themeSrc = fs.readFileSync(path.join(__dirname, "../admin/src/theme.tsx"), "utf8")
const mainSrc = fs.readFileSync(path.join(__dirname, "../admin/src/main.tsx"), "utf8")
assert.ok(themeSrc.includes('"starpoint-admin-theme"'), "缺少 localStorage key")
assert.ok(themeSrc.includes("prefers-color-scheme"), "缺少系统偏好回退")
assert.ok(themeSrc.includes('document.documentElement.dataset.theme'), "缺少 data-theme 写入")
assert.ok(themeSrc.includes("darkAlgorithm") && themeSrc.includes("defaultAlgorithm"), "缺少算法切换")
assert.ok(themeSrc.includes('colorTextLightSolid: "#1F2D4D"'), "黄色主按钮深色文字缺失")
assert.ok(themeSrc.includes("colorPrimary: \"#FFD335\""), "colorPrimary 缺失")
assert.ok(mainSrc.includes("ThemeProvider"), "main.tsx 未接入 ThemeProvider")
assert.ok(themeSrc.includes("admin-theme-toggle"), "ThemeToggle 缺少 admin-theme-toggle className")
assert.ok(themeSrc.includes("◐ 黑夜") && themeSrc.includes("◐ 白昼"), "ThemeToggle 缺少明暗切换文案")
assert.equal(mainSrc.includes("adminTheme"), false, "main.tsx 残留旧 data-admin-theme 写入")
const appSrc = fs.readFileSync(path.join(__dirname, "../admin/src/App.tsx"), "utf8")
assert.ok(appSrc.includes("<ThemeToggle"), "顶栏缺少主题切换按钮")
const dash = fs.readFileSync(path.join(__dirname, "../admin/src/pages/Dashboard.tsx"), "utf8")
assert.ok(css.includes(".admin-stat-tick"), "缺少统计卡星形角标类")
assert.ok(css.includes(".admin-badge-ok") && css.includes(".admin-badge-warn") && css.includes(".admin-badge-info"), "缺少语义徽章类")
assert.ok(dash.includes("admin-stat-tick"), "Dashboard 未使用星形角标")
