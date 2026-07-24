require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { computeActiveMissionFactProgress } = require("../src/lib/mission/active-reconciliation")

const row = ({ battleKind, rangeKind, first, third } = {}) => {
    const values = []
    values[32] = String(battleKind)
    if (rangeKind !== undefined) values[34] = String(rangeKind)
    if (first !== undefined) values[35] = String(first)
    if (third !== undefined) values[37] = String(third)
    values[46] = "121033"
    return values
}

const state = {
    player: { totalLoginDays: 0, totalStaminaUsed: 0 },
    battleCounters: {},
    finishedQuestIds: new Set(),
    questProgress: [
        {
            category: 21,
            questId: 1003,
            finished: true,
            leaderCharacterId: 121033,
            multiClearCount: 0,
        },
        {
            category: 21,
            questId: 1004,
            finished: true,
            leaderCharacterId: 999999,
            multiClearCount: 0,
        },
    ],
    chapterQuestIds: {},
    practiceQuestChallengeCount: 0,
    leaderClearCounts: {
        "121033": { all: 4, multi: 2 },
    },
    characterStoryQuestIds: {},
    characters: {},
    equipment: [],
    manaNodes: {},
    manaBoardNodes: {},
    manaNodeSlots: {},
    partyAbilitySoulCount: 0,
    treasureShopPurchaseCount: 0,
    bossCoinShopPurchaseCount: 0,
    bossCoinEquipmentShopPurchaseCount: 0,
    totalUsedManaCount: 0,
    totalGachaCharacterCount: 0,
    totalEquipmentEquipCount: 0,
    totalUnisonSetCount: 0,
    totalPartyCharacterSetCount: 0,
    totalInjectedExpCount: 0,
    totalGachaCampaignCount: 0,
}

assert.equal(computeActiveMissionFactProgress(70, row({ battleKind: 1 }), state), 2)
assert.equal(computeActiveMissionFactProgress(70, row({ battleKind: 2 }), state), 2)
assert.equal(computeActiveMissionFactProgress(70, row({ battleKind: 3 }), state), 4)
assert.equal(computeActiveMissionFactProgress(70, row({
    battleKind: 1,
    rangeKind: 14,
    first: 1,
    third: 3,
}), state), 1)
assert.equal(computeActiveMissionFactProgress(70, row({
    battleKind: 2,
    rangeKind: 14,
    first: 1,
    third: 3,
}), state), null)
assert.equal(computeActiveMissionFactProgress(70, row({ battleKind: 3 }), {
    ...state,
    leaderClearCounts: {},
}), 0)

console.log("active mission specific party fact tests passed")
