"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const root = path.resolve(__dirname, "..")

test("server status uses the pinned content snapshot instead of placeholder patch counters", () => {
    const source = fs.readFileSync(path.join(root, "src/routes/web_api/server.ts"), "utf8")

    assert.match(source, /getContentSnapshot/)
    assert.match(source, /parseAssetProviderConfig/)
    assert.match(source, /buildAdminContentStatus/)
    assert.doesNotMatch(source, /runtimeEnabled:\s*false/)
    assert.doesNotMatch(source, /enabledPatchCount:\s*0/)
    assert.doesNotMatch(source, /status:\s*["']reserved["']/)
})
