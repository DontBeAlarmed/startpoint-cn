"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const componentPath = path.join(__dirname, "../admin/src/components/ScheduledResourceRules.tsx")
assert.equal(fs.existsSync(componentPath), true, "应将定时资源补充拆成独立后台组件")
const source = fs.readFileSync(componentPath, "utf8")
const mailSource = fs.readFileSync(path.join(__dirname, "../admin/src/pages/Mail.tsx"), "utf8")
const styles = fs.readFileSync(path.join(__dirname, "../admin/src/styles.css"), "utf8")

for (const text of [
    "定时资源补充",
    "全局规则",
    "指定存档",
    "免费星导石",
    "发放数量",
    "触发下限",
    "持有上限",
    "开始时间",
    "结束时间",
    "备注",
]) {
    assert.equal(source.includes(text), true, `定时规则界面缺少：${text}`)
}

assert.match(source, /apiGet<ScheduledResourceRule\[]>\("\/api\/scheduled-resource"\)/)
assert.match(source, /apiPost<ScheduledResourceRule>\("\/api\/scheduled-resource"/)
assert.match(source, /apiPatch<ScheduledResourceRule>\(`\/api\/scheduled-resource\/\$\{rule\.id\}`/)
assert.match(source, /apiDelete<\{ ok: boolean \}>\(`\/api\/scheduled-resource\/\$\{ruleId\}`\)/)
assert.match(mailSource, /<ScheduledResourceRules players=\{players\} \/>/)
assert.match(source, /className="scheduled-resource-modal"/)
assert.match(source, /className="scheduled-resource-number-grid"/)
assert.match(source, /className="scheduled-resource-date-grid"/)
assert.match(source, /className="scheduled-resource-reset-note"/)
assert.match(styles, /\.scheduled-resource-modal/)
assert.match(styles, /\.scheduled-resource-number-grid/)
assert.match(styles, /\.scheduled-resource-date-grid/)
assert.match(styles, /\.scheduled-resource-reset-note/)
assert.match(styles, /white-space: normal/)
assert.match(styles, /calc\(100dvh -/)

console.log("admin scheduled resource UI source tests passed")
