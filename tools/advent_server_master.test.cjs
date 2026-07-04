require("ts-node/register")

const assert = require("node:assert/strict")
const test = require("node:test")

const { getAdventEventQuest, getQuestFromCategorySync } = require("../src/lib/assets.ts")
const {
    resolveBattleStartEntryCost,
    resolveBattleStartStaminaCost,
    canContinueBattle,
    canStartQuestBySelectableNeed,
    canStartQuestByPrerequisites,
    hasClearedSelectableNeedQuestForCategory,
    hasClearedQuestPrerequisiteForCategory,
} = require("../src/lib/quest/start-handler.ts")
const { QuestCategory } = require("../src/lib/types")

test("advent battle quests use official full master fields", () => {
    const quest = getAdventEventQuest(200076002)

    assert.equal(quest.name, "\u6b69\u5175\u6b7c\u706d\u8005 ::quest_rank::")
    assert.equal(quest.eventId, 200076)
    assert.equal(quest.element, 5)
    assert.equal(quest.scoreRewardGroupId, 11000483)
    assert.equal(quest.rankPointReward, 1013)
    assert.equal(quest.characterExpReward, 2435)
    assert.equal(quest.manaReward, 2490)
    assert.equal(quest.poolExpReward, 2435)
    assert.equal(quest.staminaCost, 20)
    assert.equal(quest.availablePlayKind, 2)
    assert.deepEqual(quest.rankItemCounts, { c: 1, b: 1, a: 2, s: 3, ss: 4 })
})

test("advent story quests remain story-shaped for story finish and battle start rejection", () => {
    const quest = getQuestFromCategorySync(QuestCategory.ADVENT_EVENT_SINGLE, 200076001)

    assert.equal(quest.name, "\u5411\u661f\u661f\u8bb8\u613f")
    assert.equal("rankPointReward" in quest, false)
    assert.equal("sPlusReward" in quest, false)
    assert.ok(quest.clearReward)
})

test("advent quests expose official viewable and selectable prerequisite fields", () => {
    const storyQuest = getQuestFromCategorySync(QuestCategory.ADVENT_EVENT_SINGLE, 200076001)
    const battleQuest = getAdventEventQuest(200076002)
    const chapter2Quest = getQuestFromCategorySync(QuestCategory.ADVENT_EVENT_SINGLE, 200076007)

    assert.deepEqual(storyQuest.viewableNeedQuests, [])
    assert.deepEqual(storyQuest.selectableNeedQuests, [])
    assert.deepEqual(battleQuest.viewableNeedQuests.map((quest) => quest.id), [200076001])
    assert.deepEqual(battleQuest.selectableNeedQuests, [])
    assert.deepEqual(chapter2Quest.viewableNeedQuests.map((quest) => quest.id), [200076005, 200076006])
})

test("battle start rejects quests whose official prerequisites are not cleared", () => {
    const quest = getAdventEventQuest(200076002)
    const chapter2Quest = getAdventEventQuest(200076007)

    assert.equal(typeof canStartQuestByPrerequisites, "function")
    assert.deepEqual(canStartQuestByPrerequisites(quest, () => false), {
        ok: false,
        message: "Required quest is not cleared."
    })
    assert.deepEqual(canStartQuestByPrerequisites(quest, (questId) => questId === 200076001), { ok: true })
    assert.deepEqual(canStartQuestByPrerequisites(chapter2Quest, (questId) => questId === 200076005), {
        ok: false,
        message: "Required quest is not cleared."
    })
    assert.deepEqual(
        canStartQuestByPrerequisites(chapter2Quest, (questId) => questId === 200076005 || questId === 200076006),
        { ok: true }
    )

    assert.deepEqual(canStartQuestBySelectableNeed(quest, () => false), canStartQuestByPrerequisites(quest, () => false))
})

test("advent selectable prerequisites accept either single or multi progress sections", () => {
    assert.equal(typeof hasClearedSelectableNeedQuestForCategory, "function")
    assert.equal(typeof hasClearedQuestPrerequisiteForCategory, "function")

    const clearedSections = new Map([
        [`${QuestCategory.ADVENT_EVENT_SINGLE}:200076001`, { finished: true }],
        [`${QuestCategory.ADVENT_EVENT_MULTI}:200076002`, { finished: true }],
        [`${QuestCategory.MAIN}:100`, { finished: true }],
    ])
    const getProgress = (section, questId) => clearedSections.get(`${section}:${questId}`) ?? null

    assert.equal(hasClearedSelectableNeedQuestForCategory(QuestCategory.ADVENT_EVENT_MULTI, 200076001, getProgress), true)
    assert.equal(hasClearedSelectableNeedQuestForCategory(QuestCategory.ADVENT_EVENT_SINGLE, 200076002, getProgress), true)
    assert.equal(hasClearedSelectableNeedQuestForCategory(QuestCategory.ADVENT_EVENT_SINGLE, 200076009, getProgress), false)
    assert.equal(hasClearedSelectableNeedQuestForCategory(QuestCategory.MAIN, 100, getProgress), true)
    assert.equal(hasClearedSelectableNeedQuestForCategory(QuestCategory.MAIN, 101, getProgress), false)

    assert.equal(hasClearedQuestPrerequisiteForCategory(QuestCategory.ADVENT_EVENT_MULTI, 200076001, getProgress), true)
    assert.equal(hasClearedQuestPrerequisiteForCategory(QuestCategory.ADVENT_EVENT_SINGLE, 200076002, getProgress), true)
    assert.equal(hasClearedQuestPrerequisiteForCategory(QuestCategory.ADVENT_EVENT_SINGLE, 200076009, getProgress), false)
})

test("advent item-gated battles resolve official item costs and max continue", () => {
    const quest = getAdventEventQuest(200076009)
    const entryCost = resolveBattleStartEntryCost(quest, { itemId: 0, itemCount: 0, stamina: 30 })

    assert.deepEqual(entryCost, { itemId: 10000072, itemCount: 1, stamina: 30 })
    assert.equal(resolveBattleStartStaminaCost(quest, { baseCost: 0, cost: 0, rate: 1 }), 30)
    assert.deepEqual(canContinueBattle(quest, 0), {
        ok: false,
        message: "Quest cannot be continued."
    })
})
