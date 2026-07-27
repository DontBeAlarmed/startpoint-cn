"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    installBundledGameplaySnapshot,
} = require("./helpers/install-bundled-gameplay-snapshot.cjs")

test("gameplay readers use the active Content snapshot instead of static bundled tables", t => {
    const restore = installBundledGameplaySnapshot({
        tableOverrides: {
            "carnival_event_total_score_reward.json": {
                "9001": {
                    id: 9001,
                    eventId: 77,
                    score: 10,
                    reasonId: 20002,
                    rewards: [{ kind: 3, amount: 50 }],
                },
            },
            "equipment_gacha_movie_probability.json": {
                "fixture": {
                    stringId: "fixture",
                    probabilityEruption: 0.5,
                    probabilityTreasureUp3To5: 0,
                    probabilityTreasureUp4To5: 0,
                    probabilityTreasureUp3To4: 0,
                    guaranteeProbabilityTreasureUp3To5: 0,
                    guaranteeProbabilityTreasureUp4To5: 0,
                    guaranteeProbabilityTreasureUp3To4: 0,
                },
            },
            "ex_boost.json": {
                "99001": { tier: 3, count: 2, element: 4 },
            },
            "ex_status.json": {
                "1": [991],
                "2": [992],
                "3": [993],
            },
            "raid_event.json": {
                "77": { requiredKillCount: 321 },
            },
        },
    })
    t.after(restore)

    const carnival = require("../src/lib/carnival-rewards")
    const equipmentMovie = require("../src/lib/gacha-equipment-movie")
    const assets = require("../src/lib/assets")
    const raid = require("../src/lib/raid-event-master")

    assert.deepEqual(carnival.getCarnivalRewardDefinitions(77), [{
        id: 9001,
        eventId: 77,
        score: 10,
        reasonId: 20002,
        rewards: [{ kind: 3, amount: 50 }],
    }])
    assert.equal(carnival.getCarnivalRewardDefinitions(1).length, 0)
    assert.equal(
        equipmentMovie.getEquipmentGachaMovieProbabilitySync("fixture").probabilityEruption,
        0.5,
    )
    assert.equal(equipmentMovie.getEquipmentGachaMovieProbabilitySync("1"), null)
    assert.deepEqual(assets.getExBoostItemSync(99001), { tier: 3, count: 2, element: 4 })
    assert.equal(assets.getExBoostItemSync(10001), null)
    assert.deepEqual(assets.getExStatusPoolSync(2), [992])
    assert.equal(raid.getRaidEventRequiredKillCount(77), 321)
})
