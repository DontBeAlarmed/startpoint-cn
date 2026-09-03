"use strict"
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const css = fs.readFileSync(path.join(__dirname, "../admin/src/styles.css"), "utf8")
for (const v of ["--bg:#F3F7FC", "--panel:#FFFFFF", "--star:#FFD335", "--ink:#1F2D4D", "--water:#2E7FD6", "--wind:#2FA85C", "--thunder:#D99A00", "--fire:#E8544A"]) {
    assert.ok(css.includes(v), `缺少明色 token ${v}`)
}
assert.ok(css.includes('html[data-theme="dark"]'), "缺少暗色 token 块")
assert.ok(css.includes("--bg:#141B2E"), "缺少暗色页面底色")
assert.ok(css.includes(".wf-line"), "缺少 WF 渐变线")
for (const banned of ["#1890ff", "#faad14", "#ff4d4f"]) {
    assert.equal(css.includes(banned), false, `不得残留 AntD 旧默认色 ${banned}`)
}
