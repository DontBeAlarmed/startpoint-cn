const assert = require("node:assert/strict")

require("ts-node/register/transpile-only")

const tableAccessPath = require.resolve("../src/content/runtime/table-access")
let requestedTable = null
require.cache[tableAccessPath] = {
    id: tableAccessPath,
    filename: tableAccessPath,
    loaded: true,
    exports: {
        getRuntimeContentTableSync(tableName, fallback) {
            requestedTable = { tableName, fallback }
            return {
                1: {
                    id: 1,
                    startAtMs: Date.parse("2024-07-01T00:00:00Z"),
                    endAtMs: Date.parse("2024-07-31T23:59:59Z"),
                    rewardKind: 0,
                    rate: 2,
                    categories: [13],
                    keyQueries: [[1], [2]],
                },
            }
        },
    },
}

const { getRewardCampaignRates } = require("../src/lib/reward-campaign")

assert.deepEqual(
    getRewardCampaignRates(13, 1002, new Date("2024-07-15T00:00:00Z")),
    { item: 2, exp: 1, mana: 1 },
)
assert.equal(requestedTable.tableName, "reward_campaign.json")
assert.equal(typeof requestedTable.fallback, "object")

console.log("reward campaign runtime tests passed")
