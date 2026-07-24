require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { computeActiveMissionFactProgress } = require("../src/lib/mission/active-reconciliation")

const row = rangeKind => {
    const values = []
    values[34] = String(rangeKind)
    values[35] = "1,2"
    values[36] = "(None)"
    values[37] = "(None)"
    return values
}

const state = {
    player: { totalLoginDays: 0, totalStaminaUsed: 0 },
    battleCounters: {},
    finishedQuestIds: new Set(),
    questProgress: [
        { category: 1, questId: 1001002, finished: true, clearRank: 5, multiClearCount: 0 },
        { category: 1, questId: 2001001, finished: true, clearRank: 5, multiClearCount: 0 },
        { category: 4, questId: 1001001, finished: true, clearRank: 5, multiClearCount: 0 },
        { category: 4, questId: 2001001, finished: true, clearRank: 5, multiClearCount: 0 },
    ],
    chapterQuestIds: {
        "1": [1001002, 2001001],
        "4": [11001001, 12001001],
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

assert.equal(computeActiveMissionFactProgress(66, row(0), state), 1)
assert.equal(computeActiveMissionFactProgress(66, row(1), state), 1)
assert.equal(computeActiveMissionFactProgress(66, row(0), {
    ...state,
    questProgress: state.questProgress.map(progress => (
        progress.questId === 2001001 && progress.category === 1
            ? { ...progress, clearRank: 4 }
            : progress
    )),
}), 0)
assert.equal(computeActiveMissionFactProgress(66, row(0), {
    ...state,
    chapterQuestIds: { ...state.chapterQuestIds, "1": [] },
}), null)

console.log("active mission chapter fact tests passed")
