"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")

const {
    getVisibleManaBoardIndex,
    isSecondManaBoardAvailable,
    parseManaBoard2OpenConditionTable,
} = require("../src/lib/mana-board-availability")

const sample = {
    111105: [["2024-09-05 12:00:00", "2199-12-31 23:59:59"]],
}
const parsed = parseManaBoard2OpenConditionTable(sample)
assert.equal(
    parsed.get(111105).startTime.toISOString(),
    "2024-09-05T03:00:00.000Z",
    "官方日历字段必须按 JST 转换为 UTC 时刻",
)
assert.equal(
    isSecondManaBoardAvailable(111105, 5, new Date("2024-09-05T02:59:59.000Z"), parsed),
    false,
)
assert.equal(
    isSecondManaBoardAvailable(111105, 5, new Date("2024-09-05T03:00:00.000Z"), parsed),
    true,
)
assert.equal(
    isSecondManaBoardAvailable(111105, 2, new Date("2026-01-01T00:00:00.000Z"), parsed),
    false,
    "一、二星角色即使存在表行也不能开放板二",
)
assert.equal(
    isSecondManaBoardAvailable(999999, 5, new Date("2026-01-01T00:00:00.000Z"), parsed),
    false,
    "缺失官方条件必须 fail closed",
)
assert.equal(
    getVisibleManaBoardIndex(2, 111105, 5, new Date("2024-09-05T02:59:59.000Z"), parsed),
    1,
)
assert.equal(
    getVisibleManaBoardIndex(2, 111105, 5, new Date("2024-09-05T03:00:00.000Z"), parsed),
    2,
)
assert.equal(getVisibleManaBoardIndex(1, 111105, 5, new Date(), parsed), 1)

for (const malformed of [
    null,
    [],
    { 1: [] },
    { 1: [["2024-02-30 12:00:00", "2199-12-31 23:59:59"]] },
    { 1: [["2024-01-01 12:00:00", "2023-01-01 12:00:00"]] },
]) {
    assert.throws(() => parseManaBoard2OpenConditionTable(malformed))
}

console.log("mana board availability tests passed")
