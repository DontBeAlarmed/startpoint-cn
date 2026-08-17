"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

function stubModule(relativePath, exports) {
    const modulePath = require.resolve(relativePath)
    require.cache[modulePath] = {
        id: modulePath,
        filename: modulePath,
        loaded: true,
        exports,
    }
}

const forbiddenPlayerWrites = []
const runtimeReadCalls = []
stubModule("../src/data/domains/player", {
    getPlayerSync: () => forbiddenPlayerWrites.push("get-player"),
    updatePlayerSync: () => forbiddenPlayerWrites.push("update-player"),
})
stubModule("../src/data/domains/item", {
    givePlayerItemSync: () => forbiddenPlayerWrites.push("give-item"),
})
stubModule("../src/lib/character", {
    givePlayerCharacterSync: () => forbiddenPlayerWrites.push("give-character"),
})
stubModule("../src/lib/equipment", {
    givePlayerEquipmentSync: () => forbiddenPlayerWrites.push("give-equipment"),
})

const rareGroups = {
    3013: [
        { position: 7, type: 4, count: 5, rarity: 0.7 },
        { position: 9, type: 2, id: 310009, rarity: 0.3 },
    ],
    3014: [
        { position: 6, type: 7, id: 4, count: 2, rarity: 1 },
    ],
    3999: [],
}

stubModule("../src/lib/assets", {
    getRareScoreRewardGroup: groupId => rareGroups[groupId] ?? null,
})
stubModule("../src/lib/event-currency", {
    resolveEventCurrencyId: (itemId, at) => {
        assert.equal(at.toISOString(), "2024-08-14T12:00:00.000Z")
        return itemId + 100000
    },
})
stubModule("../src/data/domains/server-settings", {
    getServerGameplaySettingsSync: () => {
        runtimeReadCalls.push("settings")
        return { dropMultiplier: 2 }
    },
})
stubModule("../src/utils", {
    getDateFromServerTime: () => {
        runtimeReadCalls.push("date")
        return new Date("2024-08-14T12:00:00.000Z")
    },
    getServerTime: () => {
        runtimeReadCalls.push("time")
        return 0
    },
})

const rewardElementMap = require("../assets/reward_element_map.json")
const { RewardType, ScoreRewardType } = require("../src/lib/types/rewards")

function sequence(values, calls) {
    let index = 0
    return () => {
        assert.ok(index < values.length, "random sequence exhausted")
        const value = values[index++]
        calls.push(value)
        return value
    }
}

function loadSelection() {
    return require("../src/lib/quest/score-reward-selection")
}

test("runtime wrapper preserves settings then server time dependency order", () => {
    const { selectScoreRewardGrantPlan } = loadSelection()
    runtimeReadCalls.length = 0

    selectScoreRewardGrantPlan(8000, [], false, 0)

    assert.deepEqual(runtimeReadCalls.slice(0, 3), ["settings", "time", "date"])
})

test("selection preserves common then rare draw order and emits normalized grant sources", () => {
    const { selectScoreRewardGrantPlan } = loadSelection()
    const randomCalls = []
    const scoreRewards = [
        {
            position: 2,
            type: ScoreRewardType.ITEM,
            reward_type: RewardType.ITEM,
            id: 400001,
            count: 2,
            field5: 10,
        },
        {
            position: 5,
            type: ScoreRewardType.ITEM,
            reward_type: RewardType.ELEMENT,
            id: 4,
            count: 3,
            field5: 90,
        },
        { position: 8, type: ScoreRewardType.RARE_POOL, id: 3013, rarity: 0.5 },
        { position: 10, type: ScoreRewardType.RARE_POOL, id: 3014, rarity: 1 },
    ]

    const selection = selectScoreRewardGrantPlan(
        8001,
        scoreRewards,
        true,
        0,
        {
            commonRewardCount: 2,
            random: sequence([0.95, 0.2, 0, 0, 0.4, 0.8], randomCalls),
            rewardCampaignRates: { item: 1.5, exp: 2, mana: 1 },
            rewardDate: new Date("2024-08-14T12:00:00.000Z"),
        },
    )

    const elementItemId = Number(rewardElementMap["1"]["4"]["3"][0][0])
    const aetherItemId = Number(rewardElementMap["2"]["4"]["3"][0][0])
    assert.deepEqual(randomCalls, [0.95, 0.2, 0, 0, 0.4, 0.8])
    assert.deepEqual(selection.plan.entries, [
        {
            source: { kind: "score_common", groupId: 8001, index: 2, number: 10 },
            reward: { type: RewardType.ITEM, id: 500001, count: 10 },
        },
        {
            source: { kind: "score_common", groupId: 8001, index: 5, number: 14 },
            reward: { type: RewardType.ELEMENT, id: elementItemId, count: 14 },
        },
        {
            source: { kind: "score_rare", groupId: 3014, index: 6, number: 10 },
            reward: { type: RewardType.AETHER, id: aetherItemId, count: 10 },
        },
        {
            source: { kind: "score_rare", groupId: 3013, index: 9, number: 1 },
            reward: { type: RewardType.CHARACTER, id: 310009 },
        },
    ])
    assert.equal(Object.isFrozen(selection.plan), true)
    assert.equal(Object.isFrozen(selection.plan.entries), true)
    assert.deepEqual(forbiddenPlayerWrites, [])
})

test("omitted common count selects every common without consuming common random rolls", () => {
    const { selectScoreRewardGrantPlan } = loadSelection()
    const randomCalls = []
    const scoreRewards = [
        {
            position: 4,
            type: ScoreRewardType.ITEM,
            reward_type: RewardType.MANA,
            count: 3,
            field5: 1,
        },
        {
            position: 2,
            type: ScoreRewardType.ITEM,
            reward_type: RewardType.EXP,
            count: 5,
            field5: 1,
        },
        { position: 3, type: ScoreRewardType.RARE_POOL, id: 3014, rarity: 1 },
    ]

    const selection = selectScoreRewardGrantPlan(8002, scoreRewards, false, 0, {
        random: sequence([0, 0], randomCalls),
        rewardCampaignRates: { item: 1, exp: 2, mana: 3 },
        rewardDate: new Date("2024-08-14T12:00:00.000Z"),
    })

    assert.deepEqual(randomCalls, [0, 0])
    assert.deepEqual(selection.plan.entries.map(entry => entry.source), [
        { kind: "score_common", groupId: 8002, index: 4, number: 18 },
        { kind: "score_common", groupId: 8002, index: 2, number: 20 },
        { kind: "score_rare", groupId: 3014, index: 6, number: 4 },
    ])
    assert.deepEqual(forbiddenPlayerWrites, [])
})

test("drop ids are projected from the same source facts as grant entries", () => {
    const { projectScoreRewardDropIds } = loadSelection()
    const selection = {
        plan: {
            entries: [
                {
                    source: { kind: "score_common", groupId: 81, index: 2, number: 3 },
                    reward: { type: RewardType.MANA, count: 3 },
                },
                {
                    source: { kind: "score_rare", groupId: 91, index: 7, number: 1 },
                    reward: { type: RewardType.CHARACTER, id: 300001 },
                },
            ],
        },
    }

    assert.deepEqual(projectScoreRewardDropIds(selection), {
        drop_score_reward_ids: [{ group_id: 81, index: 2, number: 3 }],
        drop_rare_reward_ids: [{ group_id: 91, index: 7, number: 1 }],
    })
})

test("malformed Rare rewards fail closed with typed fields before player writes", () => {
    const { selectScoreRewardGrantPlan } = loadSelection()
    const invalidRewards = [
        [{ position: 1, type: RewardType.MANA, rarity: 1 }, "count"],
        [{ position: 2, type: RewardType.ITEM, id: 1, rarity: 1 }, "count"],
        [{ position: 3, type: RewardType.CHARACTER, rarity: 1 }, "id"],
        [{ position: 4, type: RewardType.EQUIPMENT, id: Number.NaN, count: 1, rarity: 1 }, "id"],
        [{ position: 5, type: RewardType.BEADS, count: -1, rarity: 1 }, "count"],
        [{ position: 6, type: RewardType.EXP, count: 1.5, rarity: 1 }, "count"],
        [{ position: 7, type: RewardType.ITEM, id: 1, count: Number.NaN, rarity: 1 }, "count"],
        [{ position: 8, type: RewardType.ITEM, id: 1, count: 1, rarity: 1, name: 7 }, "name"],
        [{ position: 9, type: 999, id: 1, count: 1, rarity: 1 }, "type"],
    ]

    for (const [reward, expectedField] of invalidRewards) {
        rareGroups[3999] = [reward]
        let caught
        try {
            selectScoreRewardGrantPlan(
                8100,
                [{ position: 1, type: ScoreRewardType.RARE_POOL, id: 3999, rarity: 1 }],
                false,
                0,
                {
                    random: sequence([0, 0], []),
                    rewardCampaignRates: { item: 1, exp: 1, mana: 1 },
                    rewardDate: new Date("2024-08-14T12:00:00.000Z"),
                },
            )
        } catch (error) {
            caught = error
        }

        assert.equal(caught?.name, "ScoreRewardNormalizationError")
        assert.equal(caught?.groupId, 3999)
        assert.equal(caught?.index, reward.position)
        assert.equal(caught?.field, expectedField)
        assert.deepEqual(forbiddenPlayerWrites, [])
    }
})
