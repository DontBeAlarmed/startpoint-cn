require("ts-node/register/transpile-only")

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
process.once("exit", () => { restoreContentSnapshot() })


const assert = require("node:assert/strict")
const { getRaidEventRequiredKillCount } = require("../src/lib/raid-event-master")

assert.equal(getRaidEventRequiredKillCount(1), 193_680_000)
assert.equal(getRaidEventRequiredKillCount(4), 500_000)
assert.equal(getRaidEventRequiredKillCount(7), 76_000)
assert.equal(getRaidEventRequiredKillCount(999), undefined)

console.log("raid event master tests passed")
