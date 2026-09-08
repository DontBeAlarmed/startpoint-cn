"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { getLoginBonusCatalog } = require("../src/lib/login-bonus")
const {
    createFrozenTestContentRepository,
} = require("./helpers/content-snapshot-fixture.cjs")

function group(count = 1) {
    return {
        groupType: "Normal",
        availableFromMs: 0,
        availableUntilMs: null,
        conditionPeriodFromMs: null,
        conditionPeriodUntilMs: null,
        comebackInactivityDays: null,
        linkedComebackGroupId: null,
        includeBeginner: null,
        entries: [{ index: 1, rewards: [{ kind: 0, count }] }],
    }
}

function repository(table) {
    return createFrozenTestContentRepository({ tables: { "login_bonus.json": table } })
}

test("Login Bonus catalog validates once per repository identity", () => {
    const firstRepository = repository({ normal: group(1) })
    const secondRepository = repository({ normal: group(2) })
    const first = getLoginBonusCatalog(firstRepository)
    assert.strictEqual(getLoginBonusCatalog(firstRepository), first)
    assert.notStrictEqual(getLoginBonusCatalog(secondRepository), first)
    assert.equal(first.normal.entries[0].rewards[0].count, 1)
    assert.equal(getLoginBonusCatalog(secondRepository).normal.entries[0].rewards[0].count, 2)
})

test("Login Bonus catalog rejects empty and malformed output shapes", () => {
    assert.throws(() => getLoginBonusCatalog(repository([])), /catalog root must be an object/i)
    assert.throws(() => getLoginBonusCatalog(repository({})), /no login bonus groups/i)
    assert.throws(
        () => getLoginBonusCatalog(repository({
            normal: { ...group(), entries: [{ index: 1, rewards: [{ kind: 99, count: 1 }] }] },
        })),
        /reward\[0\].kind is invalid/i,
    )
})

test("Load validates Login Bonus Content before any daily-reset write path", () => {
    const source = fs.readFileSync(
        path.resolve(__dirname, "../src/routes/cn/load.ts"),
        "utf8",
    )
    const validation = source.indexOf("const loginBonusCatalog = getLoginBonusCatalog()")
    const dailyValidation = source.indexOf("getDailyChallengeCatalog()")
    assert.ok(validation >= 0)
    assert.ok(dailyValidation >= 0)
    assert.ok(validation < source.indexOf("dailyResetPlayerDataSync(player"))
    assert.ok(dailyValidation < source.indexOf("dailyResetPlayerDataSync(player"))
    assert.ok(validation < source.indexOf("refreshPlayerDailyChallengePointsForRealDaySync("))
    assert.ok(validation < source.indexOf("runPermanentValidators(playerId)"))
})
