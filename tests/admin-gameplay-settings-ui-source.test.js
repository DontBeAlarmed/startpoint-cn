"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const projectRoot = path.resolve(__dirname, "..")

test("admin exposes validated gameplay settings through the server settings API", () => {
    const pagePath = path.join(projectRoot, "admin/src/pages/GameplaySettings.tsx")
    assert.equal(fs.existsSync(pagePath), true, "gameplay settings page must exist")
    const page = fs.readFileSync(pagePath, "utf8")
    const app = fs.readFileSync(path.join(projectRoot, "admin/src/App.tsx"), "utf8")

    assert.match(page, /\/api\/server\/settings\/gameplay/)
    assert.match(page, /apiPatch/)
    assert.match(page, /min=\{1\}/)
    assert.match(page, /max=\{10\}/)
    assert.match(page, /关卡固定掉落倍率/)
    assert.match(app, /path="\/settings"/)
    assert.match(app, /label: "游戏设置"/)
})
