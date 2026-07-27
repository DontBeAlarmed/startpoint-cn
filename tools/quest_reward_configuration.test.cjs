require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const {
    getQuestFromCategorySync,
    QuestConfigurationError,
} = require("../src/lib/assets")
const { QuestCategory } = require("../src/lib/types")
const hardMultiQuests = require("../assets/hard_multi_event_quest.json")
const { installBundledCharacterAndRewardSnapshot } = require("./helpers/install-bundled-character-reward-snapshot.cjs")
const restoreContentSnapshot = installBundledCharacterAndRewardSnapshot()

const validQuest = getQuestFromCategorySync(QuestCategory.HARD_MULTI_EVENT, 100002001)
assert.ok(validQuest)
assert.equal(validQuest.clearReward?.type, 3)
assert.equal(validQuest.clearReward?.id, undefined)
assert.equal(validQuest.clearReward?.count, 30)
assert.equal(validQuest.sPlusReward?.type, 3)
assert.equal(validQuest.sPlusReward?.id, undefined)
assert.equal(validQuest.sPlusReward?.count, 30)

const originalQuest = { ...hardMultiQuests["100002001"] }

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

try {
    hardMultiQuests["100002001"].clearRewardId = 999999999
    assertConfigurationError(
        () => getQuestFromCategorySync(QuestCategory.HARD_MULTI_EVENT, 100002001),
        { rewardId: 999999999, field: "clearRewardId" },
    )

    hardMultiQuests["100002001"].clearRewardId = originalQuest.clearRewardId
    hardMultiQuests["100002001"].sPlusRewardId = 999999998
    assertConfigurationError(
        () => getQuestFromCategorySync(QuestCategory.HARD_MULTI_EVENT, 100002001),
        { rewardId: 999999998, field: "sPlusRewardId" },
    )
} finally {
    hardMultiQuests["100002001"] = originalQuest
    restoreContentSnapshot()
}

console.log("quest reward configuration tests passed")
