require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { createGameCalendarPolicy } = require("../src/time/game-calendar")
const { getDayBucket, isNewDay, isNewWeek, getWeekBucket } = require("../src/lib/time-utils")

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

const previousDayAtSix = new Date("2024-08-13T05:00:00.000Z") // 北京 13:00
assert.equal(
    isNewDay(new Date("2024-08-13T21:59:59.999Z"), previousDayAtSix, 6),
    false,
)
assert.equal(
    isNewDay(new Date("2024-08-13T22:00:00.000Z"), previousDayAtSix, 6),
    true,
    "自定义重置时间必须在传入的小时生效",
)

// Explicit non-default calendar: +540 moves the business day/week bucket by
// one hour compared with the +480 default. 2024-08-11 is a Sunday; with a
// 05:00 reset the weekly boundary sits at 21:00Z under +480 but already at
// 20:00Z under +540, so 20:30Z crosses only under +540.
const calendar480 = createGameCalendarPolicy(480)
const calendar540 = createGameCalendarPolicy(540)
const hourBoundary480 = new Date("2024-08-11T15:30:00.000Z")
assert.deepEqual(getDayBucket(hourBoundary480, 0), { y: 2024, m: 7, d: 11 })
assert.deepEqual(getDayBucket(hourBoundary480, 0, calendar540), { y: 2024, m: 7, d: 12 })
const weekBoundary = new Date("2024-08-11T20:30:00.000Z")
assert.equal(getWeekBucket(weekBoundary, 5, calendar540).w, getWeekBucket(weekBoundary, 5, calendar480).w + 1,
    "+540 的周日桶必须比 +480 提前一小时跨入周一")

console.log("mission time utility tests passed")
