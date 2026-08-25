"use strict"

const assert = require("node:assert/strict")

require("ts-node/register/transpile-only")

const {
    getDayBucket,
    getBusinessDayKey,
} = require("../src/lib/time-utils")
const {
    getDailyChallengePointId,
    assertDailyChallengePointAvailable,
} = require("../src/lib/quest/daily-challenge")
const {
    getShopPurchasePeriodKeys,
} = require("../src/lib/event-shop-purchase")
const { QuestCategory } = require("../src/lib/types")

const at = value => new Date(value)

assert.equal(getBusinessDayKey(at("2026-08-26T20:59:59.000Z"), 5), "2026-08-26")
assert.equal(getBusinessDayKey(at("2026-08-26T21:00:00.000Z"), 5), "2026-08-27")
assert.deepEqual(getDayBucket(at("2026-08-26T16:00:00.000Z"), 0), { y: 2026, m: 7, d: 27 })
assert.deepEqual(getDayBucket(at("2026-08-26T22:59:59.000Z"), 23), { y: 2026, m: 7, d: 26 })

assert.equal(
    getShopPurchasePeriodKeys(Date.parse("2026-08-26T20:59:59.000Z"), undefined, 5).daily,
    "2026-08-26",
)
assert.equal(
    getShopPurchasePeriodKeys(Date.parse("2026-08-26T20:59:59.000Z"), undefined, 0).daily,
    "2026-08-27",
)
assert.equal(
    getShopPurchasePeriodKeys(Date.parse("2026-08-26T20:59:59.000Z"), undefined, 23).daily,
    "2026-08-26",
)

const challengePointMap = {
    expert_2: 251,
    solo_1: 5001,
    story_200031001: 401,
}
assert.equal(getDailyChallengePointId(QuestCategory.EXPERT_SINGLE_EVENT, 0, 2, challengePointMap), 251)
assert.equal(getDailyChallengePointId(QuestCategory.SOLO_TIME_ATTACK_EVENT, 0, 1, challengePointMap), 5001)
assert.equal(getDailyChallengePointId(QuestCategory.STORY_EVENT_SINGLE, 200031001, undefined, challengePointMap), 401)
assert.equal(getDailyChallengePointId(QuestCategory.MAIN, 1, undefined, challengePointMap), undefined)

assert.throws(
    () => assertDailyChallengePointAvailable(401, [{ id: 401, point: 0 }]),
    /daily challenge point 401 is exhausted/i,
)
assert.throws(
    () => assertDailyChallengePointAvailable(401, []),
    /daily challenge point 401 is unavailable/i,
)
assert.doesNotThrow(
    () => assertDailyChallengePointAvailable(401, [{ id: 401, point: 1 }]),
)
assert.doesNotThrow(
    () => assertDailyChallengePointAvailable(undefined, [{ id: 401, point: 0 }]),
)

console.log("daily challenge and shop time tests passed")
