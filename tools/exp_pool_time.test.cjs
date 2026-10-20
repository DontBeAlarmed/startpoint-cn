"use strict"

const assert = require("node:assert/strict")

require("ts-node/register/transpile-only")

const {
    calculatePooledExpAtRealTime,
    clientTimestampToExpPoolRealDate,
    expPoolRealDateToClientTimestamp,
} = require("../src/lib/exp-pool-time")

const REAL_NOW = Date.parse("2026-08-20T00:00:00.000Z")
const MINUTE = 60 * 1000

function dateAt(offsetMs) {
    return new Date(REAL_NOW + offsetMs)
}

assert.deepEqual(
    calculatePooledExpAtRealTime(10, dateAt(-10 * MINUTE), dateAt(0), 365 * 24 * 60 * MINUTE),
    {
        expPool: 20,
        expPooledTime: dateAt(0),
        earned: 10,
        repaired: false,
    },
    "pool growth must use real elapsed time even while virtual time is shifted",
)

assert.deepEqual(
    calculatePooledExpAtRealTime(42, dateAt(24 * 60 * MINUTE), dateAt(0), -365 * 24 * 60 * MINUTE),
    {
        expPool: 42,
        expPooledTime: dateAt(0),
        earned: 0,
        repaired: true,
    },
    "a future anchor must be repaired without removing the existing balance",
)

const legacyOffset = 365 * 24 * 60 * MINUTE
const legacyVirtualAnchor = dateAt(0).getTime() + legacyOffset - 2 * MINUTE
const legacyResult = calculatePooledExpAtRealTime(
    7,
    new Date(legacyVirtualAnchor),
    dateAt(0),
    legacyOffset,
)
assert.deepEqual(
    legacyResult,
    {
        expPool: 9,
        expPooledTime: dateAt(0),
        earned: 2,
        repaired: true,
    },
    "old virtual anchors must migrate to the real clock without a huge catch-up grant",
)

const clientTimestamp = expPoolRealDateToClientTimestamp(dateAt(-2 * MINUTE), legacyOffset)
assert.equal(
    clientTimestampToExpPoolRealDate(clientTimestamp, legacyOffset).getTime(),
    dateAt(-2 * MINUTE).getTime(),
    "client timestamps must round-trip through the virtual clock",
)

// F-18（池上限对齐客户端）：亿级存量池登录不再被砍到旧 10 万上限
const hugePoolResult = calculatePooledExpAtRealTime(995_501_598, dateAt(-10 * MINUTE), dateAt(0))
assert.equal(
    hugePoolResult.expPool,
    995_501_598 + 10,
    "亿级存量池必须在累积后原样增长（不再被 100000 上限砍掉）",
)

// 上限封顶在 20 亿（客户端真值），不再回卷
const cappedResult = calculatePooledExpAtRealTime(1_999_999_999, dateAt(-10 * MINUTE), dateAt(0))
assert.equal(
    cappedResult.expPool,
    2_000_000_000,
    "累积封顶必须是客户端上限 20 亿",
)

console.log("exp pool time tests passed")
