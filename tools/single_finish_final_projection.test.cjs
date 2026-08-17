"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const clearRewards = require("../assets/clear_reward.json")
const mainQuests = require("../assets/main_quest.json")
const { getServerTime, realToVirtual } = require("../src/utils")
const {
    MAIN_QUEST_ID,
    withSingleBattleHarness,
} = require("./perf/single_battle_settlement_harness.cjs")

const CLEAR_REWARD_ID = 990026201
const S_PLUS_REWARD_ID = 990026202
const EMPTY_MISSION_OVERRIDES = Object.fromEntries([
    "mission_regular.json",
    "mission_daily.json",
    "mission_event.json",
    "mission_collect_item.json",
    "mission_degree.json",
    "mission_weekly_def.json",
    "mission_pass_daily.json",
    "mission_pass_week.json",
    "mission_pass_event.json",
    "mission_active.json",
    "mission_active_event.json",
].map(tableName => [tableName, {}]))

function rewardOverrides(clearReward, sPlusReward) {
    const quests = structuredClone(mainQuests)
    quests[String(MAIN_QUEST_ID)] = {
        ...quests[String(MAIN_QUEST_ID)],
        clearRewardId: CLEAR_REWARD_ID,
        sPlusRewardId: S_PLUS_REWARD_ID,
    }
    return {
        "main_quest.json": quests,
        "clear_reward.json": {
            ...clearRewards,
            [CLEAR_REWARD_ID]: clearReward,
            [S_PLUS_REWARD_ID]: sPlusReward,
        },
        "score_reward.json": {},
        "additional_reward_rules.json": {
            groups: {},
            collectItemRules: [],
            bossPickupRules: [],
        },
        ...EMPTY_MISSION_OVERRIDES,
    }
}

async function finishFirstClear(harness, playId, options) {
    harness.insertActiveQuest(harness.createActiveQuest({ playId }))
    const response = await harness.post(
        "finish",
        harness.finishPayload({ characterId: 1, playId }),
        options,
    )
    assert.equal(response.statusCode, 200, JSON.stringify(response))
    return response.data
}

test("single finish returns clear and S+ item rewards at their persisted absolute inventory", async () => {
    const clearItemId = 920261
    const sPlusItemId = 920262
    await withSingleBattleHarness("final-items", async harness => {
        harness.setItem(clearItemId, 7)
        harness.setItem(sPlusItemId, 11)

        const data = await finishFirstClear(harness, "task-26d2-final-items")

        assert.equal(data.item_list[clearItemId], harness.getItem(clearItemId))
        assert.equal(data.item_list[sPlusItemId], harness.getItem(sPlusItemId))
        assert.equal(data.item_list[clearItemId], 9)
        assert.equal(data.item_list[sPlusItemId], 14)
    }, {
        tableOverrides: rewardOverrides(
            { name: "clear item", type: 0, id: clearItemId, count: 2 },
            { name: "S+ item", type: 0, id: sPlusItemId, count: 3 },
        ),
    })
})

test("single finish keeps the final inventory when clear and S+ touch the same item", async () => {
    const itemId = 920263
    await withSingleBattleHarness("final-duplicate-item", async harness => {
        harness.setItem(itemId, 10)

        const data = await finishFirstClear(harness, "task-26d2-duplicate-item")

        assert.equal(harness.getItem(itemId), 15)
        assert.equal(data.item_list[itemId], harness.getItem(itemId))
    }, {
        tableOverrides: rewardOverrides(
            { name: "clear duplicate item", type: 0, id: itemId, count: 2 },
            { name: "S+ duplicate item", type: 0, id: itemId, count: 3 },
        ),
    })
})

test("single finish user_info is the final persisted player projection", async () => {
    await withSingleBattleHarness("final-player", async harness => {
        const data = await finishFirstClear(
            harness,
            "task-26d2-final-player",
            { normalize: false },
        )
        const persisted = harness.getPlayer()
        assert.ok(persisted)

        assert.deepEqual(data.user_info, {
            free_mana: persisted.freeMana,
            exp_pool: persisted.expPool,
            exp_pooled_time: getServerTime(persisted.expPooledTime),
            free_vmoney: persisted.freeVmoney,
            rank_point: persisted.rankPoint,
            degree_id: persisted.degreeId,
            stamina: persisted.stamina,
            stamina_heal_time: realToVirtual(persisted.staminaHealTime),
            boost_point: persisted.boostPoint,
            boss_boost_point: persisted.bossBoostPoint,
        })
    }, {
        tableOverrides: rewardOverrides(
            { name: "clear exp", type: 5, count: 19 },
            { name: "S+ mana", type: 3, count: 37 },
        ),
    })
})
