"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
    createBattleSettlementValuePlan,
} = require("../src/lib/quest/finish/battle-settlement-values")

function input(overrides = {}) {
    return {
        player: {
            freeMana: 2_000,
            expPool: 100,
            rankPoint: 0,
            boostPoint: 3,
            bossBoostPoint: 2,
            totalManaObtained: 500,
            maxComboAchieved: 20,
        },
        quest: {
            rankPointReward: 100,
            characterExpReward: 15,
            manaReward: 30,
            poolExpReward: 20,
        },
        useBoostPoint: false,
        useBossBoostPoint: false,
        fieldMana: 7,
        maxComboCount: 12,
        rewardCampaignRates: { item: 1, exp: 1.5, mana: 2 },
        ...overrides,
    }
}

test("shared settlement values preserve normal Single and Multi calculations", () => {
    const plan = createBattleSettlementValuePlan(input())

    assert.deepEqual(plan, {
        useBoostPoint: false,
        rewardCampaignRates: { item: 1, exp: 1.5, mana: 2 },
        fixedManaReward: 60,
        fixedPoolExpReward: 30,
        characterBattleExp: 23,
        fieldMana: 7,
        manaObtained: 67,
        beforeRankPoint: 0,
        newRankPoint: 100,
        oldDegreeId: 1,
        newDegreeId: 8,
        didLevelUp: true,
        playerValues: {
            freeMana: 2_067,
            expPool: 130,
            rankPoint: 100,
            boostPoint: 3,
            bossBoostPoint: 2,
            totalManaObtained: 567,
            maxComboAchieved: 20,
        },
    })
})

test("boost source affects fixed rewards and only consumes its own balance", () => {
    const boost = createBattleSettlementValuePlan(input({
        useBoostPoint: true,
        maxComboCount: 30,
    }))
    const bossBoost = createBattleSettlementValuePlan(input({
        useBossBoostPoint: true,
        maxComboCount: 30,
    }))

    for (const plan of [boost, bossBoost]) {
        assert.equal(plan.useBoostPoint, true)
        assert.equal(plan.fixedManaReward, 90)
        assert.equal(plan.fixedPoolExpReward, 50)
        assert.equal(plan.characterBattleExp, 23)
        assert.equal(plan.playerValues.maxComboAchieved, 30)
    }
    assert.deepEqual(
        [boost.playerValues.boostPoint, boost.playerValues.bossBoostPoint],
        [2, 2],
    )
    assert.deepEqual(
        [bossBoost.playerValues.boostPoint, bossBoost.playerValues.bossBoostPoint],
        [3, 1],
    )
})

test("the shared plan and its nested values are immutable", () => {
    const rates = { item: 1, exp: 1, mana: 1 }
    const plan = createBattleSettlementValuePlan(input({ rewardCampaignRates: rates }))

    rates.mana = 99
    assert.equal(plan.rewardCampaignRates.mana, 1)
    assert.equal(Object.isFrozen(plan), true)
    assert.equal(Object.isFrozen(plan.rewardCampaignRates), true)
    assert.equal(Object.isFrozen(plan.playerValues), true)
})
