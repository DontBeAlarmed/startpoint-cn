require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { computeActiveMissionFactProgress } = require("../src/lib/mission/active-reconciliation")

const row = ({ battleKind = 3, rangeKind, first, second, third } = {}) => {
    const values = []
    values[29] = "23"
    values[32] = String(battleKind)
    if (rangeKind !== undefined) values[34] = String(rangeKind)
    if (first !== undefined) values[35] = first
    if (second !== undefined) values[36] = second
    if (third !== undefined) values[37] = third
    return values
}

const state = {
    player: { totalLoginDays: 0, totalStaminaUsed: 0 },
    battleCounters: {
        singleClearCount: 99,
        multiClearCount: 99,
        multiHostClearCount: 99,
        singleRankSsCount: 2,
        rankSsCount: 5,
    },
    finishedQuestIds: new Set(),
    questProgress: [
        { category: 14, questId: 1002, finished: true, multiClearCount: 0 },
        { category: 14, questId: 1003, finished: true, multiClearCount: 0 },
        { category: 2, questId: 1006003, finished: true, multiClearCount: 3 },
        { category: 2, questId: 1006004, finished: true, multiClearCount: 4 },
    ],
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

assert.equal(computeActiveMissionFactProgress(23, row({
    battleKind: 1,
    rangeKind: 4,
    first: "1",
    third: "2,4,6",
}), state), 1)

assert.equal(computeActiveMissionFactProgress(23, row({
    battleKind: 2,
    rangeKind: 2,
    first: "1",
    second: "6",
    third: "3",
}), state), 3)

assert.equal(computeActiveMissionFactProgress(23, row({
    battleKind: 3,
    rangeKind: 2,
    first: "1",
    second: "6",
    third: "3",
}), state), 3)

assert.equal(computeActiveMissionFactProgress(23, row({
    battleKind: 3,
    rangeKind: 2,
    first: "1",
    second: "6",
    third: "4",
}), state), 4)

assert.equal(computeActiveMissionFactProgress(23, row({ battleKind: 3 }), state), 9)
assert.equal(computeActiveMissionFactProgress(23, row({
    battleKind: 1,
    rangeKind: 4,
    first: "1",
    third: "8,10",
}), state), 0)

assert.doesNotThrow(() => computeActiveMissionFactProgress(23, row({ rangeKind: 99 }), state))
assert.equal(computeActiveMissionFactProgress(23, row({ rangeKind: 99 }), state), 0)
const rawMainState = {
    ...state,
    questProgress: [{ category: 1, questId: 1_008_004, finished: true, multiClearCount: 0 }],
}
assert.equal(computeActiveMissionFactProgress(23, row({
    rangeKind: "",
    first: "1",
    second: "8",
    third: "4",
}), rawMainState), 1)

assert.equal(computeActiveMissionFactProgress(26, row({ battleKind: 1 }), state), 2)
assert.equal(computeActiveMissionFactProgress(26, row({ battleKind: 2 }), state), 3)
assert.equal(computeActiveMissionFactProgress(26, row({ battleKind: 3 }), state), 5)
assert.equal(computeActiveMissionFactProgress(26, row({ battleKind: 3, rangeKind: 2 }), state), null)

console.log("active mission battle fact tests passed")
