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
    equipment: [{ level: 5, maxLevel: 5 }, { level: 1, maxLevel: 5 }],
    manaNodes: { "1": [101, 102, 201, 202] },
    manaBoardNodes: { "1": { "2": [201, 202] } },
    manaNodeSlots: { "1": { "101": 1, "102": 4, "201": 2, "202": 4 } },
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
assert.equal(
    computeActiveMissionFactProgress(21, row(), {
        ...state,
        finishedQuestIds: new Set(),
    }),
    0,
)

console.log("active mission character fact tests passed")
