require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const { isNewsVisibleAt } = require("../src/lib/news-visibility")

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
