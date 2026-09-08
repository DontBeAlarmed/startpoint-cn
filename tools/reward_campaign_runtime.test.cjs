const assert = require("node:assert/strict")

require("ts-node/register/transpile-only")

const contentSnapshotPath = require.resolve("../src/content/runtime/content-snapshot")
let requestedTable = null
require.cache[contentSnapshotPath] = {
    id: contentSnapshotPath,
    filename: contentSnapshotPath,
    loaded: true,
    exports: {
        getContentSnapshot() {
            return {
                repository: {
                    table(tableName) {
                        requestedTable = { tableName }
                        if (tableName !== "reward_campaign.json") {
                            throw new Error(`unexpected runtime table ${tableName}`)
                        }
                        return {
                            1: {
                                id: 1,
                                repeatKind: "once",
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
        },
    },
}

const { getRewardCampaignRates } = require("../src/lib/reward-campaign")

assert.deepEqual(
    getRewardCampaignRates(13, 1002, new Date("2024-07-15T00:00:00Z")),
    { item: 2, exp: 1, mana: 1 },
)
assert.equal(requestedTable.tableName, "reward_campaign.json")

console.log("reward campaign runtime tests passed")
