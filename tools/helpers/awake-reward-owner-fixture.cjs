"use strict"

const AWAKE_CHARACTER_ID = 341005
const AWAKE_MISSION_ID = 3410051
const AWAKE_ITEM_ID = 920271

function awakeRewardRow(rewardId, targetProgress, rewards) {
    const row = []
    row[0] = String(rewardId)
    row[1] = "(None)"
    row[5] = String(targetProgress)
    row[6] = "(None)"
    for (const [index, reward] of rewards.entries()) {
        const base = 9 + index * 6
        row[base] = String(reward.kind)
        row[base + 1] = String(reward.amount)
        if (reward.itemId !== undefined) row[base + 2] = String(reward.itemId)
    }
    return row
}

function awakeRewardTable({ multipleStages = false } = {}) {
    const stages = {
        1: [awakeRewardRow(34100511, 1, multipleStages
            ? [
                { kind: 1, amount: 2, itemId: AWAKE_ITEM_ID },
                { kind: 3, amount: 7 },
            ]
            : [
                { kind: 1, amount: 2, itemId: AWAKE_ITEM_ID },
                { kind: 0, amount: 13 },
                { kind: 3, amount: 7 },
                { kind: 5, amount: 11 },
            ])],
    }
    if (multipleStages) {
        stages[2] = [awakeRewardRow(34100512, 5, [
            { kind: 1, amount: 3, itemId: AWAKE_ITEM_ID },
            { kind: 0, amount: 13 },
            { kind: 5, amount: 11 },
        ])]
    }
    return { [AWAKE_MISSION_ID]: stages }
}

module.exports = {
    AWAKE_CHARACTER_ID,
    AWAKE_ITEM_ID,
    AWAKE_MISSION_ID,
    awakeRewardTable,
}
