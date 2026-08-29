"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const clearRewards = require("../assets/clear_reward.json")
const mainQuests = require("../assets/main_quest.json")
const rushEventQuestFolders = require("../assets/rush_event_quest_folder.json")
const {
    getDefaultPlayerRushEventSync,
    insertPlayerRushEventSync,
} = require("../src/data/domains/rushEvent")
const { QuestCategory, RewardType } = require("../src/lib/types")
const { getMaxStamina, getRankDegree } = require("../src/lib/stamina")
const { getServerTime, realToVirtual } = require("../src/utils")
const {
    MAIN_QUEST_ID,
    withSingleBattleHarness,
} = require("./perf/single_battle_settlement_harness.cjs")

const CLEAR_REWARD_ID = 990026201
const S_PLUS_REWARD_ID = 990026202
const ADDITIONAL_GROUP_ID = 990026203
const CARNIVAL_REWARD_ID = 990026204
const CARNIVAL_DEGREE_ID = 61000
const CARNIVAL_QUEST_ID = 1001
const RUSH_EVENT_ID = 700007
const RUSH_FOLDER_ID = 1
const RUSH_QUEST_ID = 700007002
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

function noIncidentalRewardOverrides() {
    return {
        "score_reward.json": {},
        "additional_reward_rules.json": {
            groups: {},
            collectItemRules: [],
            bossPickupRules: [],
        },
        ...EMPTY_MISSION_OVERRIDES,
    }
}

function assertFinalUserInfo(userInfo, persisted) {
    assert.deepEqual(userInfo, {
        free_mana: persisted.freeMana,
        exp_pool: persisted.expPool,
        exp_pooled_time: realToVirtual(persisted.expPooledTime),
        free_vmoney: persisted.freeVmoney,
        rank_point: persisted.rankPoint,
        degree_id: persisted.degreeId,
        stamina: persisted.stamina,
        stamina_heal_time: realToVirtual(persisted.staminaHealTime),
        boost_point: persisted.boostPoint,
        boss_boost_point: persisted.bossBoostPoint,
    })
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

test("single finish rolls back when the stored challenge point is exhausted", async () => {
    await withSingleBattleHarness("final-exhausted-challenge-point", async harness => {
        const activeQuest = harness.createActiveQuest({
            playId: "task-26d2-exhausted-point",
        })
        activeQuest.dailyChallengePointId = 9001
        harness.insertActiveQuest(activeQuest)
        harness.db.prepare(`
            INSERT INTO daily_challenge_point_list_entries (id, point, player_id)
            VALUES (9001, 0, ?)
        `).run(harness.playerId)
        const before = harness.snapshotState()

        const response = await harness.post(
            "finish",
            harness.finishPayload({ playId: "task-26d2-exhausted-point" }),
            { normalize: false },
        )

        assert.equal(response.statusCode, 400, JSON.stringify(response))
        assert.deepEqual(harness.snapshotState(), before)
        assert.equal(harness.db.prepare(`
            SELECT point FROM daily_challenge_point_list_entries
            WHERE id = 9001 AND player_id = ?
        `).get(harness.playerId)?.point, 0)
        assert.deepEqual(harness.db.prepare(`
            SELECT play_id, daily_challenge_point_id
            FROM players_active_quests
            WHERE player_id = ?
        `).get(harness.playerId), {
            play_id: "task-26d2-exhausted-point",
            daily_challenge_point_id: 9001,
        })
    }, {
        tableOverrides: noIncidentalRewardOverrides(),
    })
})

test("single finish user_info is the final persisted player projection", async () => {
    await withSingleBattleHarness("final-player", async harness => {
        const before = harness.getPlayer()
        const data = await finishFirstClear(
            harness,
            "task-26d2-final-player",
            { normalize: false },
        )
        const persisted = harness.getPlayer()
        assert.ok(before && persisted)

        assert.deepEqual({
            freeMana: persisted.freeMana - before.freeMana,
            expPool: persisted.expPool - before.expPool,
        }, {
            freeMana: 20 + 11 + 37,
            expPool: 13 + 19,
        })
        assertFinalUserInfo(data.user_info, persisted)
    }, {
        tableOverrides: rewardOverrides(
            { name: "clear exp", type: RewardType.EXP, count: 19 },
            { name: "S+ mana", type: RewardType.MANA, count: 37 },
        ),
    })
})

test("single failed finish applies rank refill after releasing entry stamina", async () => {
    await withSingleBattleHarness("final-failed-rank-up-refill", async harness => {
        const playId = "task-26d2-failed-rank-up-refill"
        const rankPointBefore = 93
        const currentStamina = 90
        harness.updatePlayer({
            rankPoint: rankPointBefore,
            stamina: currentStamina,
            staminaHealTime: new Date(Date.now() + 250),
        })
        const activeQuest = harness.createActiveQuest({ playId })
        activeQuest.staminaCost = 10
        harness.insertActiveQuest(activeQuest)

        const payload = harness.finishPayload({ playId })
        payload.is_accomplished = false
        const response = await harness.post("finish", payload, { normalize: false })
        assert.equal(response.statusCode, 200, JSON.stringify(response))

        const persisted = harness.getPlayer()
        assert.ok(persisted)
        const newDegreeId = getRankDegree(rankPointBefore + 3)
        const releasedAfterStamina = currentStamina + 10
        const expectedStamina = Math.min(
            releasedAfterStamina + getMaxStamina(newDegreeId),
            999,
        )
        assert.equal(persisted.stamina, expectedStamina)
        assert.equal(response.data.user_info.stamina, expectedStamina)
    }, {
        tableOverrides: noIncidentalRewardOverrides(),
    })
})

test("single rank-up final stamina is capped at the absolute overflow maximum", async () => {
    await withSingleBattleHarness("final-rank-up-overflow-cap", async harness => {
        const playId = "task-26d2-rank-up-overflow-cap"
        harness.updatePlayer({
            rankPoint: 93,
            stamina: 995,
            staminaHealTime: new Date(Date.now() + 250),
        })
        harness.insertActiveQuest(harness.createActiveQuest({ playId }))

        const response = await harness.post(
            "finish",
            harness.finishPayload({ playId }),
            { normalize: false },
        )
        assert.equal(response.statusCode, 200, JSON.stringify(response))

        const persisted = harness.getPlayer()
        assert.ok(persisted)
        assert.equal(persisted.stamina, 999)
        assert.equal(response.data.user_info.stamina, 999)
    }, {
        tableOverrides: noIncidentalRewardOverrides(),
    })
})

test("single finish keeps the equipped degree when Carnival grants a new degree", async () => {
    await withSingleBattleHarness("final-carnival-degree", async harness => {
        const playId = "task-26d2-carnival-degree"
        harness.insertActiveQuest(harness.createActiveQuest({
            category: QuestCategory.CARNIVAL_EVENT,
            questId: CARNIVAL_QUEST_ID,
            playId,
        }))
        const response = await harness.post("finish", harness.finishPayload({
            addMana: 0,
            category: QuestCategory.CARNIVAL_EVENT,
            characterId: 1,
            playId,
            questId: CARNIVAL_QUEST_ID,
        }), { normalize: false })
        assert.equal(response.statusCode, 200, JSON.stringify(response))
        const persisted = harness.getPlayer()
        assert.ok(persisted)

        assert.deepEqual(response.data.carnival_event.new_degree_ids, [CARNIVAL_DEGREE_ID])
        assert.deepEqual(response.data.carnival_event.reward_ids, [CARNIVAL_REWARD_ID])
        assert.deepEqual(harness.db.prepare(`
            SELECT degree_id FROM players_degrees
            WHERE player_id = ? AND degree_id = ?
        `).all(harness.playerId, CARNIVAL_DEGREE_ID), [{ degree_id: CARNIVAL_DEGREE_ID }])
        assert.equal(response.data.user_info.degree_id, persisted.degreeId)
    }, {
        tableOverrides: {
            ...noIncidentalRewardOverrides(),
            "carnival_event_total_score_reward.json": {
                [CARNIVAL_REWARD_ID]: {
                    id: CARNIVAL_REWARD_ID,
                    eventId: 1,
                    score: 1,
                    reasonId: 20001,
                    rewards: [{ kind: 7, id: CARNIVAL_DEGREE_ID, amount: 1 }],
                },
            },
        },
    })
})

test("single finish projects Additional mana from the committed player", async () => {
    const additionalMana = 31
    await withSingleBattleHarness("final-additional-mana", async harness => {
        const before = harness.getPlayer()
        const data = await finishFirstClear(
            harness,
            "task-26d2-additional-mana",
            { normalize: false },
        )
        const persisted = harness.getPlayer()
        assert.ok(before && persisted)

        assert.deepEqual(data.drop_additional_reward_ids, [{
            group_id: ADDITIONAL_GROUP_ID,
            index: 1,
            number: additionalMana,
        }])
        assert.equal(persisted.freeMana - before.freeMana, 62)
        assertFinalUserInfo(data.user_info, persisted)
    }, {
        additionalSettlementOverride(_table, _input, dependencies) {
            const rewardResult = dependencies.grantRewards([{
                type: RewardType.MANA,
                count: additionalMana,
            }])
            return {
                dropAdditionalRewardIds: [{
                    group_id: ADDITIONAL_GROUP_ID,
                    index: 1,
                    number: additionalMana,
                }],
                rewardResult,
            }
        },
        tableOverrides: rewardOverrides(
            { name: "clear item", type: 0, id: 920265, count: 1 },
            { name: "S+ item", type: 0, id: 920266, count: 1 },
        ),
    })
})

test("single finish projects Rush EXP from the committed player", async () => {
    const rushExp = 41
    const folders = structuredClone(rushEventQuestFolders)
    folders[String(RUSH_EVENT_ID)][String(RUSH_FOLDER_ID)] = [{
        type: RewardType.EXP,
        count: rushExp,
    }]
    await withSingleBattleHarness("final-rush-exp", async harness => {
        insertPlayerRushEventSync(
            harness.playerId,
            getDefaultPlayerRushEventSync(RUSH_EVENT_ID),
        )
        const playId = "task-26d2-rush-exp"
        harness.insertActiveQuest(harness.createActiveQuest({
            category: QuestCategory.RUSH_EVENT,
            questId: RUSH_QUEST_ID,
            playId,
        }))
        const before = harness.getPlayer()
        const response = await harness.post("finish", harness.finishPayload({
            addMana: 0,
            category: QuestCategory.RUSH_EVENT,
            characterId: 1,
            playId,
            questId: RUSH_QUEST_ID,
        }), { normalize: false })
        assert.equal(response.statusCode, 200, JSON.stringify(response))
        const persisted = harness.getPlayer()
        assert.ok(before && persisted)

        assert.equal(persisted.expPool - before.expPool, 99)
        assertFinalUserInfo(response.data.user_info, persisted)
    }, {
        tableOverrides: {
            ...noIncidentalRewardOverrides(),
            "rush_event_quest_folder.json": folders,
        },
    })
})
