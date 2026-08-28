"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")
require("ts-node/register/transpile-only")

const adventEventQuests = require("../assets/advent_event_quest.json")
const { QuestCategory, RewardType } = require("../src/lib/types")
const {
    getRescueFragmentAdditionalReward,
    getRescueFragmentReward,
    RESCUE_PURPLE_FRAGMENT_ITEM_ID,
    RESCUE_GOLD_FRAGMENT_ITEM_ID,
    RESCUE_SILVER_FRAGMENT_ITEM_ID,
    settleRescueFragmentReward,
} = require("../src/multi/rescue-fragment-reward")

test("maps supported multiplayer quest tiers to ten rescue fragments", () => {
    assert.deepEqual(
        getRescueFragmentReward(QuestCategory.BOSS_BATTLE, 1001001),
        { type: RewardType.ITEM, id: RESCUE_SILVER_FRAGMENT_ITEM_ID, count: 10 },
    )
    assert.deepEqual(
        getRescueFragmentReward(QuestCategory.BOSS_BATTLE, 1001003),
        { type: RewardType.ITEM, id: RESCUE_PURPLE_FRAGMENT_ITEM_ID, count: 10 },
    )
    assert.deepEqual(
        getRescueFragmentReward(QuestCategory.HARD_MULTI_EVENT, 1001),
        { type: RewardType.ITEM, id: RESCUE_PURPLE_FRAGMENT_ITEM_ID, count: 10 },
    )
    assert.equal(getRescueFragmentReward(QuestCategory.MAIN, 1), null)
})

test("normalizes single-player advent category to the multiplayer advent table", () => {
    const rewardsByItemId = new Map()
    for (const [rawQuestId, quest] of Object.entries(adventEventQuests)) {
        const questId = Number(rawQuestId)
        if (!Number.isSafeInteger(questId) || quest.rankPointReward === undefined) continue
        const reward = getRescueFragmentReward(QuestCategory.ADVENT_EVENT_MULTI, questId)
        if (reward === null) continue

        const questIds = rewardsByItemId.get(reward.id) ?? []
        questIds.push(questId)
        rewardsByItemId.set(reward.id, questIds)
        assert.deepEqual(getRescueFragmentReward(QuestCategory.ADVENT_EVENT_SINGLE, questId), reward)
    }

    const expectedItemIds = [
        RESCUE_SILVER_FRAGMENT_ITEM_ID,
        RESCUE_GOLD_FRAGMENT_ITEM_ID,
        RESCUE_PURPLE_FRAGMENT_ITEM_ID,
    ]
    for (const itemId of expectedItemIds) {
        const questIds = rewardsByItemId.get(itemId) ?? []
        assert.ok(questIds.length > 0)
        assert.deepEqual(
            getRescueFragmentReward(QuestCategory.ADVENT_EVENT_SINGLE, questIds[0]),
            getRescueFragmentReward(QuestCategory.ADVENT_EVENT_MULTI, questIds[0]),
        )
    }
    assert.equal(getRescueFragmentReward(QuestCategory.ADVENT_EVENT_SINGLE, 999999999), null)
    assert.deepEqual(
        getRescueFragmentReward(QuestCategory.MAIN, 1),
        null,
    )
    assert.deepEqual(
        getRescueFragmentReward(QuestCategory.BOSS_BATTLE, 1001001),
        { type: RewardType.ITEM, id: RESCUE_SILVER_FRAGMENT_ITEM_ID, count: 10 },
    )
    assert.deepEqual(
        getRescueFragmentReward(QuestCategory.HARD_MULTI_EVENT, 1001),
        { type: RewardType.ITEM, id: RESCUE_PURPLE_FRAGMENT_ITEM_ID, count: 10 },
    )
})

test("projects rescue fragments into the additional reward protocol", () => {
    const reward = getRescueFragmentReward(QuestCategory.BOSS_BATTLE, 1001001)
    assert.deepEqual(getRescueFragmentAdditionalReward(reward), {
        group_id: 490000,
        index: 1,
        number: 10,
    })
})

test("settles only successful enabled multiplayer compatibility rewards", () => {
    const granted = []
    const grant = rewards => {
        granted.push(rewards)
        return { items: { [rewards[0].id]: 25 } }
    }
    const enabled = settleRescueFragmentReward({
        enabled: true,
        questAccomplished: true,
        questCategory: QuestCategory.BOSS_BATTLE,
        questId: 1001001,
    }, grant)
    assert.equal(granted.length, 1)
    assert.equal(enabled.rewardResult.items[RESCUE_SILVER_FRAGMENT_ITEM_ID], 25)
    assert.equal(enabled.additionalReward.number, 10)

    for (const input of [
        { enabled: false, questAccomplished: true },
        { enabled: true, questAccomplished: false },
    ]) {
        assert.deepEqual(settleRescueFragmentReward({
            ...input,
            questCategory: QuestCategory.BOSS_BATTLE,
            questId: 1001001,
        }, grant), { rewardResult: null, additionalReward: null })
    }
    assert.equal(granted.length, 1)
})

test("settles normalized advent rewards with the same success gate", () => {
    const granted = []
    const grant = rewards => {
        granted.push(rewards)
        return { items: { [rewards[0].id]: 10 } }
    }
    const enabled = settleRescueFragmentReward({
        enabled: true,
        questAccomplished: true,
        questCategory: QuestCategory.ADVENT_EVENT_SINGLE,
        questId: 1002,
    }, grant)
    assert.equal(granted.length, 1)
    assert.equal(enabled.rewardResult.items[RESCUE_SILVER_FRAGMENT_ITEM_ID], 10)
    assert.equal(enabled.additionalReward.number, 10)

    for (const input of [
        { enabled: false, questAccomplished: true },
        { enabled: true, questAccomplished: false },
    ]) {
        assert.deepEqual(settleRescueFragmentReward({
            ...input,
            questCategory: QuestCategory.ADVENT_EVENT_SINGLE,
            questId: 1002,
        }, grant), { rewardResult: null, additionalReward: null })
    }
    assert.equal(granted.length, 1)
})
