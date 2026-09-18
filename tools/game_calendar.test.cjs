"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")
require("ts-node/register/transpile-only")

const {
    DEFAULT_GAME_CALENDAR_UTC_OFFSET_MINUTES,
    createGameCalendarPolicy,
    parseGameCalendarUtcOffsetMinutes,
} = require("../src/time/game-calendar")

test("calendar offset configuration defaults to CN and accepts fixed minute offsets", () => {
    assert.equal(DEFAULT_GAME_CALENDAR_UTC_OFFSET_MINUTES, 480)
    assert.equal(parseGameCalendarUtcOffsetMinutes(undefined), 480)
    assert.equal(parseGameCalendarUtcOffsetMinutes("480"), 480)
    assert.equal(parseGameCalendarUtcOffsetMinutes("+540"), 540)
    assert.equal(parseGameCalendarUtcOffsetMinutes("-210"), -210)
    assert.equal(parseGameCalendarUtcOffsetMinutes("-840"), -840)
    assert.equal(parseGameCalendarUtcOffsetMinutes("840"), 840)
    for (const value of ["", " 480", "480 ", "0480", "1.5", "841", "-841", "UTC+8"])
        assert.throws(() => parseGameCalendarUtcOffsetMinutes(value), /game calendar/i)
    for (const value of [841, -841, 1.5, Number.NaN])
        assert.throws(() => createGameCalendarPolicy(value), /game calendar/i)
})

test("CN calendar strictly parses and formats master timestamps", () => {
    const cn = createGameCalendarPolicy(480)
    const epoch = cn.parseMasterTimestamp("2024-08-14 20:00:00")
    assert.equal(new Date(epoch).toISOString(), "2024-08-14T12:00:00.000Z")
    assert.equal(cn.formatMasterTimestamp(epoch), "2024-08-14 20:00:00")
    assert.equal(
        new Date(cn.parseMasterTimestamp("2024-02-29 00:00:00")).toISOString(),
        "2024-02-28T16:00:00.000Z",
    )
    for (const value of [
        "2023-02-29 00:00:00", "2024-13-01 00:00:00", "2024-01-01 24:00:00",
        "2024-1-01 00:00:00", "2024-01-01T00:00:00", " 2024-01-01 00:00:00",
    ]) assert.throws(() => cn.parseMasterTimestamp(value), /master timestamp/i)
})

test("non-CN fixed offsets round-trip without host timezone", () => {
    for (const offset of [540, 330, 345, -210]) {
        const calendar = createGameCalendarPolicy(offset)
        const text = "2026-09-17 12:34:56"
        assert.equal(calendar.formatMasterTimestamp(calendar.parseMasterTimestamp(text)), text)
    }
})

test("calendar buckets use the configured offset and reset hour", () => {
    const cn = createGameCalendarPolicy(480)
    const before = Date.parse("2024-08-13T20:59:59.999Z")
    const at = Date.parse("2024-08-13T21:00:00.000Z")
    assert.notDeepEqual(cn.getDayBucket(before, 5), cn.getDayBucket(at, 5))
    assert.equal(cn.getMonth(Date.parse("2024-08-31T16:00:00.000Z")), 9)
    assert.notDeepEqual(cn.getWeekBucket(before, 5), cn.getWeekBucket(at + 6 * 86400_000, 5))
    for (const resetHour of [-1, 24, 1.5])
        assert.throws(() => cn.getDayBucket(at, resetHour), /reset hour/i)
})

test("formatting rejects non-finite values outside the four-digit contract", () => {
    const cn = createGameCalendarPolicy(480)
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.throws(() => cn.formatMasterTimestamp(value), /epoch/i)
    }
})
