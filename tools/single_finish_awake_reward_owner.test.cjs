"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const mainQuests = require("../assets/main_quest.json")
const clearRewards = require("../assets/clear_reward.json")
const {
    AWAKE_ITEM_ID,
    AWAKE_MISSION_ID,
    awakeRewardTable,
} = require("./helpers/awake-reward-owner-fixture.cjs")
const {
    MAIN_QUEST_ID,
    withSingleBattleHarness,
} = require("./perf/single_battle_settlement_harness.cjs")

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
const CLEAR_REWARD_ID = 990027201
const S_PLUS_REWARD_ID = 990027202

function tableOverrides() {
    const quests = structuredClone(mainQuests)
    quests[String(MAIN_QUEST_ID)] = {
        ...quests[String(MAIN_QUEST_ID)],
        clearRewardId: CLEAR_REWARD_ID,
        sPlusRewardId: S_PLUS_REWARD_ID,
        scoreRewardGroupId: 0,
        characterExpReward: 0,
        manaReward: 0,
        poolExpReward: 0,
    }
    return {
        ...EMPTY_MISSION_OVERRIDES,
        "main_quest.json": quests,
        "clear_reward.json": {
            ...clearRewards,
            [CLEAR_REWARD_ID]: { name: "unrelated clear", type: 0, id: 920272, count: 1 },
            [S_PLUS_REWARD_ID]: { name: "unrelated S+", type: 0, id: 920273, count: 1 },
        },
        "score_reward.json": {},
        "additional_reward_rules.json": {
            groups: {},
            collectItemRules: [],
            bossPickupRules: [],
        },
        "mission_char_awake_reward.json": awakeRewardTable({ multipleStages: true }),
    }
}

async function finishAwakeBattle(harness, playId, options) {
    harness.makeAwakeEligible()
    harness.setItem(AWAKE_ITEM_ID, 10)
    harness.insertActiveQuest(harness.createActiveQuest({ playId }))
    return harness.post("finish", harness.finishPayload({
        addMana: 0,
        playId,
    }), options)
}

test("single finish returns final Awake item and currency state after multiple owner grants", async () => {
    await withSingleBattleHarness("awake-owner-final", async harness => {
        const before = harness.getPlayer()
        const response = await finishAwakeBattle(
            harness,
            "awake-owner-final",
            { normalize: false },
        )
        const after = harness.getPlayer()

        assert.equal(response.statusCode, 200, JSON.stringify(response))
        assert.equal(harness.getItem(AWAKE_ITEM_ID), 15)
        assert.equal(response.data.item_list[AWAKE_ITEM_ID], 15)
        assert.equal(after.freeMana, before.freeMana + 7)
        assert.equal(after.freeVmoney, before.freeVmoney + 13)
        assert.equal(after.expPool, before.expPool + 11)
        assert.equal(response.data.user_info.free_mana, after.freeMana)
        assert.equal(response.data.user_info.free_vmoney, after.freeVmoney)
        assert.equal(response.data.user_info.exp_pool, after.expPool)
        assert.deepEqual(response.data.mission_info.filter(entry => (
            entry.mission_category_id === 9 && entry.mission_id === AWAKE_MISSION_ID
        )), [
            { mission_category_id: 9, mission_id: AWAKE_MISSION_ID, mission_reward_id: 34100511 },
            { mission_category_id: 9, mission_id: AWAKE_MISSION_ID, mission_reward_id: 34100512 },
        ])
    }, { tableOverrides: tableOverrides() })
})

for (const fault of [
    {
        label: "owner grant",
        trigger: `
            CREATE TRIGGER reject_awake_owner_item
            BEFORE UPDATE OF amount ON players_items
            WHEN NEW.id = ${AWAKE_ITEM_ID}
            BEGIN SELECT RAISE(ABORT, 'forced Awake owner grant failure'); END;
        `,
    },
    {
        label: "final active quest write",
        trigger: `
            CREATE TRIGGER reject_awake_active_delete
            BEFORE DELETE ON players_active_quests
            BEGIN SELECT RAISE(ABORT, 'forced Awake final write failure'); END;
        `,
    },
]) {
    test(`single finish rolls all state back on ${fault.label} failure`, async () => {
        await withSingleBattleHarness(`awake-${fault.label.replaceAll(" ", "-")}`, async harness => {
            harness.makeAwakeEligible()
            harness.setItem(AWAKE_ITEM_ID, 10)
            const playId = `awake-${fault.label.replaceAll(" ", "-")}`
            harness.insertActiveQuest(harness.createActiveQuest({ playId }))
            const before = harness.snapshotState()
            harness.db.exec(fault.trigger)

            const response = await harness.post("finish", harness.finishPayload({
                addMana: 0,
                playId,
            }))

            assert.equal(response.statusCode, 500)
            assert.deepEqual(harness.snapshotState(), before)
        }, { tableOverrides: tableOverrides() })
    })
}
