require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const { isNewsVisibleAt } = require("../src/lib/news-visibility")
const { createGameCalendarPolicy } = require("../src/time/game-calendar")

test("公告时间未到时不可见", () => {
    assert.equal(
        isNewsVisibleAt(
            { date: "2026-08-14 18:00:00" },
            Date.parse("2026-08-14T09:59:59.999Z"),
        ),
        false,
    )
})

test("公告时间到达时可见", () => {
    assert.equal(
        isNewsVisibleAt(
            { date: "2026-08-14 18:00:00" },
            Date.parse("2026-08-14T10:00:00.000Z"),
        ),
        true,
    )
})

test("数据库公告使用 UTC 发布时间且未来不可见", () => {
    assert.equal(
        isNewsVisibleAt(
            { publishedAtReal: "2026-08-14T10:00:00.000Z" },
            Date.parse("2026-08-14T09:59:59.999Z"),
        ),
        false,
    )
    assert.equal(
        isNewsVisibleAt(
            { publishedAtReal: "2026-08-14T10:00:00.000Z" },
            Date.parse("2026-08-14T10:00:00.000Z"),
        ),
        true,
    )
})

test("数据库公告拒绝历法无效的 UTC 发布时间", () => {
    assert.equal(
        isNewsVisibleAt(
            { publishedAtReal: "2026-02-30T12:00:00Z" },
            Date.parse("2026-03-02T12:00:01.000Z"),
        ),
        false,
    )
})

test("legacy ISO 时区公告按边界时间显示", () => {
    const boundary = Date.parse("2026-08-14T10:00:00.000Z")
    assert.equal(
        isNewsVisibleAt({ date: "2026-08-14T10:00:00Z" }, boundary - 1),
        false,
    )
    assert.equal(isNewsVisibleAt({ date: "2026-08-14T10:00:00Z" }, boundary), true)
})

test("缺少或无效日期的旧公告保持可见", () => {
    assert.equal(isNewsVisibleAt({}, Date.parse("2026-08-06T00:00:00.000Z")), true)
    assert.equal(
        isNewsVisibleAt(
            { date: "not-a-date" },
            Date.parse("2026-08-06T00:00:00.000Z"),
        ),
        true,
    )
})

test("legacy offset-less dates follow an explicit +540 calendar while ISO offsets stay absolute", () => {
    const calendar540 = createGameCalendarPolicy(540)
    // "2026-08-14 18:00:00" is 10:00Z under +480 but 09:00Z under +540.
    assert.equal(
        isNewsVisibleAt(
            { date: "2026-08-14 18:00:00" },
            Date.parse("2026-08-14T08:59:59.999Z"),
            calendar540,
        ),
        false,
        "+540 口径下无时区旧日期必须在 09:00Z 前不可见",
    )
    assert.equal(
        isNewsVisibleAt(
            { date: "2026-08-14 18:00:00" },
            Date.parse("2026-08-14T09:00:00.000Z"),
            calendar540,
        ),
        true,
    )

    // Explicit ISO offsets remain absolute regardless of the calendar policy.
    const plusEightIso = { date: "2026-08-14T11:00:00+08:00" } // absolute 03:00Z
    const plusEightBoundary = Date.parse("2026-08-14T03:00:00.000Z")
    assert.equal(isNewsVisibleAt(plusEightIso, plusEightBoundary - 1, calendar540), false)
    assert.equal(isNewsVisibleAt(plusEightIso, plusEightBoundary, calendar540), true)
    const utcIso = { date: "2026-08-14T02:00:00Z" }
    const utcBoundary = Date.parse("2026-08-14T02:00:00.000Z")
    assert.equal(isNewsVisibleAt(utcIso, utcBoundary - 1, calendar540), false)
    assert.equal(isNewsVisibleAt(utcIso, utcBoundary, calendar540), true)
})
