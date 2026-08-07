"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const root = path.resolve(__dirname, "..")

test("server status uses the pinned content snapshot instead of placeholder patch counters", () => {
    const source = fs.readFileSync(path.join(root, "src/routes/web_api/server.ts"), "utf8")

    assert.match(source, /getContentSnapshot/)
    assert.match(source, /runtimeConfig|getRuntimeConfig/)
    assert.doesNotMatch(source, /parseAssetProviderConfig/)
    assert.match(source, /buildAdminContentStatus/)
    assert.doesNotMatch(source, /runtimeEnabled:\s*false/)
    assert.doesNotMatch(source, /enabledPatchCount:\s*0/)
    assert.doesNotMatch(source, /status:\s*["']reserved["']/)
})

test("dashboard renders active patch versions and content release facts", () => {
    const source = fs.readFileSync(path.join(root, "admin/src/pages/Dashboard.tsx"), "utf8")

    assert.match(source, /CDN 基线 \/ 补丁 Overlay/)
    assert.match(source, /status\.cdn\.extension\.versions/)
    assert.match(source, /status\.cdn\.contentRelease\.releaseDigest/)
    assert.match(source, /当前固定 Content Snapshot 未包含补丁/)
    assert.doesNotMatch(source, /后续接入点/)
    assert.doesNotMatch(source, /未来自制角色和活动补丁/)
})
