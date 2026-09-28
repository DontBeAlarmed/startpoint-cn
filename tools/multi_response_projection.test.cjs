"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

require("../src/multi/settlement/response")

test("multi finish response projector is dependency-free from DB, Content, Mail, and routes", () => {
    const source = fs.readFileSync(
        path.join(__dirname, "../src/multi/settlement/response.ts"),
        "utf8",
    )
    assert.doesNotMatch(
        source,
        /(?:from\s+["'][^"']*(?:\/data|\/content|\/routes|mail)|require\([^)]*(?:\/data|\/content|\/routes|mail))/i,
    )
    const loaded = Object.keys(require.cache)
    assert.equal(
        loaded.some(file => /\/src\/(data|content|routes)\//.test(file)),
        false,
    )
})
