"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const projectRoot = path.resolve(__dirname, "..")
const compatibility = fs.readFileSync(
    path.join(projectRoot, "docs/systems/cn-final-operation-compatibility.md"),
    "utf8",
)
const rush = fs.readFileSync(path.join(projectRoot, "docs/systems/rush-event.md"), "utf8")
const knownIssues = fs.readFileSync(
    path.join(projectRoot, "docs/status/known-issues.md"),
    "utf8",
)
const contentSync = fs.readFileSync(
    path.join(projectRoot, "docs/cdn/content-sync.md"),
    "utf8",
)

assert.match(compatibility, /1001.*1006/s)
assert.match(compatibility, /hard_multi_event/)
assert.match(compatibility, /periodic_reward/)
assert.match(compatibility, /boss_battle_quest/)
assert.match(compatibility, /1061001.*1066004/s)
assert.match(compatibility, /700011.*700017/s)
assert.match(compatibility, /eventId\s*-\s*10/)
assert.match(compatibility, /推测性兼容/)
assert.match(compatibility, /不属于.*CDN.*原始行为/s)

for (const source of [rush, knownIssues, contentSync]) {
    assert.match(source, /cn-final-operation-compatibility\.md/)
}

console.log("final operation compatibility documentation tests passed")
