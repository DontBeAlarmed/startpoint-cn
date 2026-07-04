require("ts-node/register")

const assert = require("node:assert/strict")
const test = require("node:test")

const scoreRewardGroups = require("../assets/score_reward.json")
const rareScoreRewardGroups = require("../assets/rare_score_reward.json")
const { selectCommonScoreRewardsForClearRank, selectRareScoreRewardFromGroup } = require("../src/lib/quest.ts")

test("advent common score rewards are rolled by clear rank count and weight", () => {
    const rewards = scoreRewardGroups["11000483"]
    const rolls = [0, 0.99]
    const selected = selectCommonScoreRewardsForClearRank(
        rewards,
        3,
        { c: 1, b: 1, a: 2, s: 3, ss: 4 },
        () => rolls.shift() ?? 0
    )

    assert.deepEqual(selected.map((reward) => reward.position), [1, 3])
})

test("score reward selection preserves old common behavior without rank item counts", () => {
    const rewards = scoreRewardGroups["11000483"]
    const selected = selectCommonScoreRewardsForClearRank(rewards, 3)

    assert.deepEqual(selected.map((reward) => reward.position), [1, 2, 3])
})

test("rare score reward selection uses official probability order and keeps master index", () => {
    const group = rareScoreRewardGroups["2101"]

    assert.deepEqual(selectRareScoreRewardFromGroup(group, () => 0.49), {
        index: 2,
        reward: group[1],
    })
    assert.deepEqual(selectRareScoreRewardFromGroup(group, () => 0.79), {
        index: 3,
        reward: group[2],
    })
    assert.deepEqual(selectRareScoreRewardFromGroup(group, () => 0.99), {
        index: 1,
        reward: group[0],
    })
})
