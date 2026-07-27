"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    resolveAdditionalRewardSelections,
    settleAdditionalRewardsSync,
} = require("../src/lib/additional-reward")

const table = {
    groups: {
        1: [{ index: 1, groupStringId: "tier0", type: 0, id: 80001, number: 2, weight: 1 }],
        2: [{ index: 1, groupStringId: "tier50", type: 0, id: 80001, number: 3, weight: 1 }],
        3: [{ index: 1, groupStringId: "boss", type: 0, id: 80002, number: 1, weight: 1 }],
        4: [
            { index: 1, groupStringId: "future-a", type: 0, id: 80003, number: 1, weight: 1 },
            { index: 2, groupStringId: "future-b", type: 0, id: 80004, number: 1, weight: 1 },
        ],
    },
    collectItemRules: [{
        eventId: 10,
        startAtMs: Date.parse("2024-08-01T04:00:00Z"),
        endAtMs: Date.parse("2024-08-31T15:59:59Z"),
        prerequisite: { category: 1, questId: 1004002 },
        categories: [1],
        keyQueries: [[1], [4], [2]],
        thresholds: [
            { enemyLevelMin: 0, groupId: 1 },
            { enemyLevelMin: 50, groupId: 2 },
            { enemyLevelMin: 60, groupId: 4 },
        ],
    }],
    bossPickupRules: [{
        eventId: 20,
        startAtMs: Date.parse("2024-08-10T04:00:00Z"),
        endAtMs: Date.parse("2024-08-11T15:59:59Z"),
        categories: [2],
        keyQueries: [[1], [12], null],
        groupId: 3,
        availableRank: 3,
    }],
}

const base = {
    questCategory: 1,
    questId: 1004002,
    enemyLevel: 60,
    nowMs: Date.parse("2024-08-15T00:00:00Z"),
    isMulti: false,
    isQuestCleared: () => true,
}

test("collect-item rewards require the event period, prerequisite and quest range", () => {
    assert.deepEqual(resolveAdditionalRewardSelections(table, base).map(value => value.groupId), [1, 2])
    assert.deepEqual(resolveAdditionalRewardSelections(table, {
        ...base,
        isQuestCleared: () => false,
    }), [])
    assert.deepEqual(resolveAdditionalRewardSelections(table, {
        ...base,
        questId: 1005002,
    }), [])
    assert.deepEqual(resolveAdditionalRewardSelections(table, {
        ...base,
        nowMs: Date.parse("2024-09-01T00:00:00Z"),
    }), [])
})
test("boss pickup rewards require a multi battle and matching schedule", () => {
    const input = {
        ...base,
        questCategory: 2,
        questId: 1012003,
        nowMs: Date.parse("2024-08-10T12:00:00Z"),
    }
    assert.deepEqual(resolveAdditionalRewardSelections(table, input), [])
    assert.deepEqual(
        resolveAdditionalRewardSelections(table, { ...input, isMulti: true }).map(value => value.groupId),
        [3],
    )
})

test("settlement applies item campaign, Boost and server multiplier while preserving drop keys", () => {
    let granted
    const result = settleAdditionalRewardsSync(table, {
        ...base,
        rewardCampaignRates: { item: 1.5, exp: 1, mana: 1 },
        boostPointUsed: true,
        serverDropMultiplier: 2,
    }, {
        grantRewards(rewards) {
            granted = rewards
            return {
                user_info: { free_mana: 0, free_vmoney: 0, exp_pool: 0 },
                character_list: [], joined_character_id_list: [], equipment_list: [],
                items: { 80001: 24 },
            }
        },
    })

    assert.deepEqual(granted, [{ type: 0, id: 80001, count: 24 }])
    assert.deepEqual(result.dropAdditionalRewardIds, [
        { group_id: 1, index: 1, number: 10 },
        { group_id: 2, index: 1, number: 14 },
    ])
    assert.deepEqual(result.rewardResult.items, { 80001: 24 })
})
