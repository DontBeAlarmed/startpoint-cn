require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const {
    computeActiveMissionFactProgress,
} = require("../src/lib/mission/active-reconciliation")

const state = {
    player: { totalLoginDays: 1, totalStaminaUsed: 0 },
    finishedQuestIds: new Set([101, 102]),
    characterStoryQuestIds: { "1": [101, 102, 103] },
    characters: {
        "1": {
            rarity: 1,
            exp: 11416,
            evolutionLevel: 1,
            overLimitStep: 2,
            bondTokenList: [{ status: 1 }, { status: 0 }],
        },
        "2": {
            rarity: 1,
            exp: 0,
            evolutionLevel: 0,
            overLimitStep: 1,
            bondTokenList: [{ status: 1 }],
        },
    },
    equipment: [
        { level: 5, maxLevel: 5, enhancementLevel: 20 },
        { level: 1, maxLevel: 5, enhancementLevel: 8 },
    ],
    manaNodes: { "1": [101, 102, 201, 202] },
    manaBoardNodes: { "1": { "2": [201, 202] } },
    manaNodeSlots: { "1": { "101": 1, "102": 4, "201": 2, "202": 4 } },
    partyAbilitySoulCount: 1,
    treasureShopPurchaseCount: 2,
    bossCoinShopPurchaseCount: 3,
    bossCoinEquipmentShopPurchaseCount: 1,
    totalUsedManaCount: 120,
    totalGachaCharacterCount: 5,
    totalEquipmentEquipCount: 1,
    totalUnisonSetCount: 1,
    totalPartyCharacterSetCount: 1,
}

const row = (characterId = "(None)") => {
    const values = []
    values[43] = characterId
    return values
}

assert.equal(computeActiveMissionFactProgress(21, row(), state), 2)
assert.equal(computeActiveMissionFactProgress(5, row(), state), 40)
assert.equal(computeActiveMissionFactProgress(4, row(1), state), 1)
assert.equal(computeActiveMissionFactProgress(4, row(999), state), 0)
assert.equal(computeActiveMissionFactProgress(61, row(), state), 1)
assert.equal(computeActiveMissionFactProgress(36, row(), state), 1)
assert.equal(computeActiveMissionFactProgress(48, row(), state), 1)
assert.equal(computeActiveMissionFactProgress(9, row(), state), 3)
assert.equal(computeActiveMissionFactProgress(8, row(), state), 2)
assert.equal(computeActiveMissionFactProgress(62, row(), state), 2)
assert.equal(computeActiveMissionFactProgress(7, row(), state), 4)
assert.equal(computeActiveMissionFactProgress(34, row(), state), 4)
assert.equal(computeActiveMissionFactProgress(35, row(), state), 1)
assert.equal(computeActiveMissionFactProgress(45, row(), state), 2)
assert.equal(computeActiveMissionFactProgress(58, row(), state), 1)
assert.equal(computeActiveMissionFactProgress(59, row(), state), 1)
assert.equal(computeActiveMissionFactProgress(60, row(), state), 1)
assert.equal(computeActiveMissionFactProgress(64, row(), state), 1)
assert.equal(computeActiveMissionFactProgress(84, row(), state), 3)
assert.equal(computeActiveMissionFactProgress(46, row(), state), 120)
assert.equal(computeActiveMissionFactProgress(78, row(), state), 5)
assert.equal(
    computeActiveMissionFactProgress(21, row(), {
        ...state,
        finishedQuestIds: new Set(),
    }),
    0,
)

console.log("active mission character fact tests passed")
