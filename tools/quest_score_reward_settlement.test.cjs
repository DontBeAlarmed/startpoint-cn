const assert = require("node:assert/strict")

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
stubModule("../src/data/domains/character", { getPlayerCharacterSync: () => null })
stubModule("../src/data/domains/player", {
    getPlayerSync: () => ({ freeMana: 0, totalManaObtained: 0, expPool: 0 }),
    updatePlayerSync: () => undefined,
})
stubModule("../src/data/domains/item", {
    givePlayerItemSync(_playerId, itemId, count) {
        const total = (itemTotals.get(itemId) ?? 0) + count
        itemTotals.set(itemId, total)
        return total
    },
})
stubModule("../src/lib/assets", {
    getRareScoreRewardGroup: groupId => groupId === 3013 ? [
        { position: 1, type: 0, id: 443001, count: 1, rarity: 0.3 },
        { position: 2, type: 0, id: 443002, count: 2, rarity: 0.7 },
    ] : null,
})
stubModule("../src/lib/character", { givePlayerCharacterSync: () => null })
stubModule("../src/lib/equipment", { givePlayerEquipmentSync: () => ({}) })
stubModule("../src/lib/event-currency", { resolveEventCurrencyId: id => id })
stubModule("../src/utils", {
    getDateFromServerTime: () => new Date("2024-08-14T12:00:00.000Z"),
    getServerTime: () => Date.parse("2024-08-14T12:00:00.000Z") / 1000,
})
stubModule("../src/data/domains/server-settings", {
    getServerGameplaySettingsSync: () => ({ dropMultiplier: 1 }),
})

const { givePlayerScoreRewardsSync } = require("../src/lib/quest")
const { RewardType, ScoreRewardType } = require("../src/lib/types")

function sequence(values) {
    let index = 0
    return () => values[index++]
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
]

const result = givePlayerScoreRewardsSync(
    7,
    8001,
    scoreRewards,
    false,
    0,
    { commonRewardCount: 1, random: sequence([0.6, 0, 0.699999]) },
)

assert.deepEqual(result.drop_score_reward_ids, [{ group_id: 8001, index: 2, number: 3 }])
assert.deepEqual(result.drop_rare_reward_ids, [{ group_id: 3013, index: 2, number: 2 }])
assert.equal(itemTotals.get(400001), undefined)
assert.equal(itemTotals.get(400002), 3)
assert.equal(itemTotals.get(443001), undefined)
assert.equal(itemTotals.get(443002), 2)

console.log("quest score reward settlement tests passed")
