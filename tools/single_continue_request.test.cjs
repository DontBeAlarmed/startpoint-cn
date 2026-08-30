require("ts-node/register/transpile-only")
const assert = require("node:assert/strict")
const test = require("node:test")
const {
    parseSingleContinueExpectedCount,
} = require("../src/lib/quest/single-continue-request")

test("sums CN zone continue counts without a synthetic top-level field", () => {
    const statistics = { zones: [
        { floor: 0, zone: 0, continue_count: 1 },
        { floor: 0, zone: 1, continue_count: 0 },
        { floor: 1, zone: 0, continue_count: 1 },
    ] }
    assert.equal(Object.hasOwn(statistics, "continue_count"), false)
    assert.equal(parseSingleContinueExpectedCount(statistics), 2)
})

test("does not accept the old synthetic top-level count", () => {
    assert.equal(parseSingleContinueExpectedCount({ continue_count: 0 }), null)
})

test("rejects malformed zone statistics", () => {
    const invalidStatistics = [
        undefined,
        null,
        [],
        {},
        { zones: [] },
        { zones: [null] },
        { zones: [{}] },
        { zones: [{ continue_count: -1 }] },
        { zones: [{ continue_count: 0.5 }] },
        { zones: [{ continue_count: "0" }] },
        { zones: [{ continue_count: Number.MAX_SAFE_INTEGER }, { continue_count: 1 }] },
    ]
    for (const statistics of invalidStatistics) {
        assert.equal(parseSingleContinueExpectedCount(statistics), null, statistics)
    }
})

test("ignores a synthetic top-level continue count", () => {
    assert.equal(
        parseSingleContinueExpectedCount({ zones: [{ continue_count: 0 }], continue_count: 999 }),
        0,
    )
})
