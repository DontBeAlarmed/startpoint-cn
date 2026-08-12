require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const {
    getQuestFromCategorySync,
    QuestConfigurationError,
} = require("../src/lib/assets")
const { QuestCategory } = require("../src/lib/types")
const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
const hardMultiQuests = require("../assets/hard_multi_event_quest.json")

function assertConfigurationError(operation, expected) {
    assert.throws(operation, error => {
        assert.ok(error instanceof QuestConfigurationError)
        assert.equal(error.category, QuestCategory.HARD_MULTI_EVENT)
        assert.equal(error.questId, 100002001)
        assert.equal(error.rewardId, expected.rewardId)
        assert.equal(error.field, expected.field)
        assert.match(error.message, new RegExp(`category=26.*questId=100002001.*rewardId=${expected.rewardId}.*field=${expected.field}`))
        return true
    })
}

function withHardMultiOverride(patch, operation) {
    const quests = structuredClone(hardMultiQuests)
    Object.assign(quests["100002001"], patch)
    const restore = installBundledGameplaySnapshot({
        tableOverrides: { "hard_multi_event_quest.json": quests },
    })
    try {
        return operation()
    } finally {
        restore()
    }
}

withHardMultiOverride({}, () => {
    const validQuest = getQuestFromCategorySync(QuestCategory.HARD_MULTI_EVENT, 100002001)
    assert.ok(validQuest)
    assert.equal(validQuest.clearReward?.type, 3)
    assert.equal(validQuest.clearReward?.id, undefined)
    assert.equal(validQuest.clearReward?.count, 30)
    assert.equal(validQuest.sPlusReward?.type, 3)
    assert.equal(validQuest.sPlusReward?.id, undefined)
    assert.equal(validQuest.sPlusReward?.count, 30)
    assert.equal(validQuest.availableFromMs, 1750305600000)
    assert.equal(validQuest.availableUntilMs, 1752163199000)
})

withHardMultiOverride({ availableFromMs: 10, availableUntilMs: 20 }, () => {
    const quest = getQuestFromCategorySync(QuestCategory.HARD_MULTI_EVENT, 100002001)
    assert.equal(quest.availableFromMs, 10)
    assert.equal(quest.availableUntilMs, 20)
})

withHardMultiOverride({ clearRewardId: 999999999 }, () => {
    assertConfigurationError(
        () => getQuestFromCategorySync(QuestCategory.HARD_MULTI_EVENT, 100002001),
        { rewardId: 999999999, field: "clearRewardId" },
    )
})

withHardMultiOverride({ sPlusRewardId: 999999998 }, () => {
    assertConfigurationError(
        () => getQuestFromCategorySync(QuestCategory.HARD_MULTI_EVENT, 100002001),
        { rewardId: 999999998, field: "sPlusRewardId" },
    )
})

console.log("quest reward configuration tests passed")
