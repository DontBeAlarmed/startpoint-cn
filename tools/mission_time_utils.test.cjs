require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { isNewDay, isNewWeek } = require("../src/lib/time-utils")

const sundayAfterReset = new Date("2024-08-18T04:00:00.000Z") // 北京周日 12:00
assert.equal(
    isNewWeek(new Date("2024-08-18T20:59:59.999Z"), sundayAfterReset),
    false,
)
assert.equal(
    isNewWeek(new Date("2024-08-18T21:00:00.000Z"), sundayAfterReset),
    true,
    "国服周常必须在北京时间周一 05:00 重置",
)

const previousDayAfterReset = new Date("2024-08-13T04:00:00.000Z") // 北京 12:00
assert.equal(
    isNewDay(new Date("2024-08-13T20:59:59.999Z"), previousDayAfterReset),
    false,
)
assert.equal(
    isNewDay(new Date("2024-08-13T21:00:00.000Z"), previousDayAfterReset),
    true,
    "国服日常必须在北京时间 05:00 重置",
)

console.log("mission time utility tests passed")
