const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

require("ts-node/register/transpile-only")

function stubModule(relativePath, exports) {
    const modulePath = require.resolve(relativePath)
    require.cache[modulePath] = {
        id: modulePath,
        filename: modulePath,
        loaded: true,
        exports,
    }
}

const itemTotals = new Map()
const writeTrace = []
const rareGroupTrace = []
const randomTrace = []
let playerExists = true
const rewardElementMap = require("../assets/reward_element_map.json")
stubModule("../src/data/domains/character", { getPlayerCharacterSync: () => null })
stubModule("../src/data/domains/player", {
    getPlayerSync: () => playerExists
        ? ({ freeMana: 0, totalManaObtained: 0, expPool: 0 })
        : null,
    updatePlayerSync: values => writeTrace.push(["player", values]),
})
stubModule("../src/data/domains/item", {
    givePlayerItemSync(_playerId, itemId, count) {
        writeTrace.push(["item", itemId, count])
        const total = (itemTotals.get(itemId) ?? 0) + count
        itemTotals.set(itemId, total)
        return total
    },
})
stubModule("../src/lib/assets", {
    getRareScoreRewardGroup(groupId) {
        rareGroupTrace.push(groupId)
        return groupId === 3013 ? [
            { position: 1, type: 0, id: 443001, count: 1, rarity: 0.3 },
            { position: 2, type: 0, id: 443002, count: 2, rarity: 0.7 },
        ] : groupId === 3014 ? [
            { position: 1, type: 6, id: 4, count: 2, rarity: 1 },
        ] : groupId === 3015 ? [
            { position: 3, type: 4, count: 7, rarity: 1 },
        ] : groupId === 3016 ? [
            { position: 4, type: 4, rarity: 1 },
        ] : null
    },
})
stubModule("../src/lib/character", { givePlayerCharacterSync: () => null })
stubModule("../src/lib/equipment", { givePlayerEquipmentSync: () => ({}) })
stubModule("../src/lib/event-currency", { resolveEventCurrencyId: id => id })
stubModule("../src/utils", {
    getDateFromServerTime: () => new Date("2024-08-14T12:00:00.000Z"),
    getServerTime: () => { throw new Error("结算已提供时间时不得再次读取服务器时间") },
})
stubModule("../src/data/domains/server-settings", {
    getServerGameplaySettingsSync: () => ({ dropMultiplier: 1 }),
})

const { givePlayerScoreRewardsSync } = require("../src/lib/quest")
const { RewardType, ScoreRewardType } = require("../src/lib/types")

function sequence(values) {
    let index = 0
    return () => {
        assert.ok(index < values.length, "random sequence exhausted")
        const value = values[index++]
        randomTrace.push(value)
        return value
    }
}

const scoreRewards = [
    {
        position: 1,
        type: ScoreRewardType.ITEM,
        reward_type: RewardType.ITEM,
        id: 400001,
        count: 1,
        field5: 10,
    },
    {
        position: 2,
        type: ScoreRewardType.ITEM,
        reward_type: RewardType.ITEM,
        id: 400002,
        count: 3,
        field5: 90,
    },
    { position: 3, type: ScoreRewardType.RARE_POOL, id: 3013, rarity: 0.5 },
    { position: 4, type: ScoreRewardType.RARE_POOL, id: 3014, rarity: 1 },
]

const result = givePlayerScoreRewardsSync(
    7,
    8001,
    scoreRewards,
    false,
    0,
    {
        commonRewardCount: 1,
        random: sequence([0.6, 0, 0.699999, 0, 0]),
        rewardCampaignRates: { item: 1.5, exp: 2, mana: 1 },
        rewardDate: new Date("2024-08-14T12:00:00.000Z"),
    },
)

assert.deepEqual(result.drop_score_reward_ids, [{ group_id: 8001, index: 2, number: 4 }])
assert.deepEqual(result.drop_rare_reward_ids, [
    { group_id: 3014, index: 1, number: 3 },
    { group_id: 3013, index: 2, number: 3 },
])
assert.equal(itemTotals.get(400001), undefined)
assert.equal(itemTotals.get(400002), 4)
assert.equal(itemTotals.get(443001), undefined)
assert.equal(itemTotals.get(443002), 3)
const elementItemId = Number(rewardElementMap["1"]["4"]["3"][0][0])
assert.equal(itemTotals.get(4), undefined)
assert.equal(itemTotals.get(elementItemId), 3)
assert.deepEqual(randomTrace, [0.6, 0, 0.699999, 0, 0])
assert.deepEqual(rareGroupTrace, [3014, 3013])
assert.deepEqual(writeTrace, [
    ["item", 400002, 4],
    ["item", elementItemId, 3],
    ["item", 443002, 3],
])

const questSource = fs.readFileSync(
    path.join(__dirname, "../src/lib/quest.ts"),
    "utf8",
)
const scoreFunctionStart = questSource.indexOf("export function givePlayerScoreRewardsSync(")
const scoreFunctionEnd = questSource.indexOf("/**\n * Batch gives", scoreFunctionStart)
const scoreFunctionSource = questSource.slice(scoreFunctionStart, scoreFunctionEnd)
assert.match(questSource, /from "\.\/quest\/score-reward-selection"/)
assert.match(scoreFunctionSource, /selectScoreRewardGrantPlan\s*\(/)
assert.doesNotMatch(scoreFunctionSource, /selectCommonScoreRewards\s*\(/)
assert.doesNotMatch(scoreFunctionSource, /selectRareScoreRewards\s*\(/)

const writesBeforeMalformedRare = writeTrace.length
assert.throws(
    () => givePlayerScoreRewardsSync(
        7,
        8003,
        [{ position: 1, type: ScoreRewardType.RARE_POOL, id: 3016, rarity: 1 }],
        false,
        0,
        {
            random: sequence([0]),
            rewardCampaignRates: { item: 1, exp: 1, mana: 1 },
            rewardDate: new Date("2024-08-14T12:00:00.000Z"),
        },
    ),
    error => error?.name === "ScoreRewardNormalizationError"
        && error.field === "count",
)
assert.equal(writeTrace.length, writesBeforeMalformedRare)

playerExists = false
const missingPlayerResult = givePlayerScoreRewardsSync(
    999,
    8002,
    [{ position: 1, type: ScoreRewardType.RARE_POOL, id: 3015, rarity: 1 }],
    false,
    0,
    {
        random: sequence([0, 0]),
        rewardCampaignRates: { item: 1, exp: 1, mana: 1 },
        rewardDate: new Date("2024-08-14T12:00:00.000Z"),
    },
)
assert.deepEqual(missingPlayerResult.drop_score_reward_ids, [])
assert.deepEqual(missingPlayerResult.drop_rare_reward_ids, [])
assert.deepEqual(missingPlayerResult.user_info, {
    free_mana: 0,
    free_vmoney: 0,
    exp_pool: 0,
})

console.log("quest score reward settlement tests passed")
