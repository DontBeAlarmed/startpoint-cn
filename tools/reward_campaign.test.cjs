const assert = require("node:assert/strict")

require("ts-node/register/transpile-only")

const {
    calculateCharacterBattleExp,
    calculateFixedQuestMana,
    calculateScoreRewardAmount,
    resolveRewardCampaignRates,
} = require("../src/lib/reward-campaign")
const { RewardType } = require("../src/lib/types")
const bundledCampaigns = require("../assets/reward_campaign.json")

const window = {
    startAtMs: Date.parse("2024-07-01T00:00:00Z"),
    endAtMs: Date.parse("2024-07-31T23:59:59Z"),
}
const campaigns = {
    1: { id: 1, ...window, rewardKind: 0, rate: 1.5, categories: [13], keyQueries: [[1], [1, 2]] },
    2: { id: 2, ...window, rewardKind: 0, rate: 2, categories: [13], keyQueries: [[1], [2]] },
    3: { id: 3, ...window, rewardKind: 1, rate: 1.5, categories: [13], keyQueries: [[1], null] },
    4: { id: 4, ...window, rewardKind: 2, rate: 2, categories: [6, 14, 13, 20], keyQueries: [] },
}

assert.deepEqual(
    resolveRewardCampaignRates(campaigns, 13, 1002, new Date("2024-07-15T00:00:00Z")),
    { item: 2, exp: 1.5, mana: 2 },
)
assert.deepEqual(
    resolveRewardCampaignRates(campaigns, 13, 2002, new Date("2024-07-15T00:00:00Z")),
    { item: 1, exp: 1, mana: 2 },
)
assert.deepEqual(
    resolveRewardCampaignRates(campaigns, 13, 1002, new Date("2024-08-01T00:00:00Z")),
    { item: 1, exp: 1, mana: 1 },
)

const rates = { item: 2, exp: 1.5, mana: 2 }
assert.equal(calculateScoreRewardAmount(3, RewardType.ITEM, rates, true, 1), 9)
assert.equal(calculateScoreRewardAmount(3, RewardType.EXP, rates, true, 1), 7)
assert.equal(calculateScoreRewardAmount(3, RewardType.MANA, rates, false, 1), 6)
assert.equal(calculateScoreRewardAmount(3, RewardType.CHARACTER, rates, true, 10), 1)
assert.equal(calculateScoreRewardAmount(3, RewardType.ITEM, rates, true, 2), 18)
assert.equal(
    calculateScoreRewardAmount(1, RewardType.ITEM, { ...rates, item: 1.5 }, false, 2),
    2,
)
assert.equal(calculateCharacterBattleExp(3, rates), 5)
assert.equal(calculateFixedQuestMana(3, rates), 6)

assert.deepEqual(
    resolveRewardCampaignRates(
        bundledCampaigns,
        13,
        1001,
        new Date("2025-02-14T00:00:00Z"),
    ),
    { item: 2, exp: 1, mana: 1 },
)
assert.deepEqual(
    resolveRewardCampaignRates(
        bundledCampaigns,
        14,
        1001,
        new Date("2025-02-14T00:00:00Z"),
    ),
    { item: 1, exp: 2, mana: 2 },
)

console.log("reward campaign tests passed")
