"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
    createEventSettlementDescriptor,
} = require("../src/lib/quest/finish/event-settlement-descriptor")
const { QuestCategory } = require("../src/lib/types")

const baseQuest = {
    name: "fixture",
    enemyLevel: 1,
    bRankTime: 0,
    aRankTime: 0,
    sRankTime: 0,
    sPlusRankTime: 0,
    rankPointReward: 0,
    characterExpReward: 0,
    manaReward: 0,
    poolExpReward: 0,
    availableFromMs: 100,
    availableUntilMs: 200,
}

test("resolves one immutable descriptor for each built-in Event mode", () => {
    const cases = [
        [QuestCategory.RUSH_EVENT, {
            ...baseQuest,
            rushEventId: 700001,
            rushEventFolderId: 2,
            rushEventRound: 3,
        }, undefined, { kind: "rush", eventId: 700001, folderId: 2, round: 3 }],
        [QuestCategory.RAID_EVENT, {
            ...baseQuest,
            killCountWeight: 4,
        }, 600001, { kind: "raid", eventId: 600001, killCountWeight: 4 }],
        [QuestCategory.CARNIVAL_EVENT, {
            ...baseQuest,
            eventId: 500001,
            folderId: 7,
            difficultyScore: 1_000,
            timeLimitMs: 30_000,
        }, undefined, {
            kind: "carnival",
            eventId: 500001,
            folderId: 7,
            difficultyScore: 1_000,
            timeLimitMs: 30_000,
        }],
        [QuestCategory.SCORE_ATTACK_EVENT, {
            ...baseQuest,
            eventId: 900001,
            scoreAttackQuestId: 10,
        }, undefined, {
            kind: "scoreAttack",
            eventId: 900001,
            scoreAttackQuestId: 10,
        }],
    ]

    for (const [questCategory, quest, activeEventId, expected] of cases) {
        const descriptor = createEventSettlementDescriptor({
            questCategory,
            questId: 123,
            quest,
            activeEventId,
        })
        assert.deepEqual(descriptor, {
            questId: 123,
            window: { availableFromMs: 100, availableUntilMs: 200 },
            ...expected,
        })
        assert.equal(Object.isFrozen(descriptor), true)
        assert.equal(Object.isFrozen(descriptor.window), true)
    }
})

test("normal quests and incomplete Event linkage fail closed to none", () => {
    const cases = [{
        questCategory: QuestCategory.MAIN,
        questId: 1,
        quest: baseQuest,
    }, {
        questCategory: QuestCategory.RUSH_EVENT,
        questId: 1,
        quest: baseQuest,
    }, {
        questCategory: QuestCategory.RAID_EVENT,
        questId: 1,
        quest: { ...baseQuest, killCountWeight: 1 },
    }, {
        questCategory: QuestCategory.CARNIVAL_EVENT,
        questId: 1,
        quest: { ...baseQuest, eventId: 1, folderId: 1, difficultyScore: 1 },
    }, {
        questCategory: QuestCategory.SCORE_ATTACK_EVENT,
        questId: 1,
        quest: { ...baseQuest, eventId: 1 },
    }]
    for (const input of cases) {
        assert.deepEqual(createEventSettlementDescriptor(input), { kind: "none" })
    }
})
