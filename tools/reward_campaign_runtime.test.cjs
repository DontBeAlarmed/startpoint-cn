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

const { getRewardCampaignRates, resolveRewardCampaignRates } = require("../src/lib/reward-campaign")
const { createGameCalendarPolicy } = require("../src/time/game-calendar")

assert.deepEqual(
    getRewardCampaignRates(13, 1002, new Date("2024-07-15T00:00:00Z")),
    { item: 2, exp: 1, mana: 1 },
)
assert.equal(requestedTable.tableName, "reward_campaign.json")

// The weekly reset bucket must follow an explicit +540 calendar: the instant
// 2024-07-14T20:30Z is still Sunday under +480 but Monday 00:30 under +540.
assert.deepEqual(
    resolveRewardCampaignRates({
        5: {
            id: 5,
            repeatKind: "weekly",
            startAtMs: Date.parse("2024-07-01T00:00:00Z"),
            endAtMs: Date.parse("2024-07-31T23:59:59Z"),
            dayOfWeek: 1,
            resetTimeMs: 5 * 60 * 60 * 1000,
            rewardKind: 0,
            rate: 4,
            categories: [13],
            keyQueries: [[1], [2]],
        },
    }, 13, 1002, new Date("2024-07-14T20:30:00Z"), createGameCalendarPolicy(540)),
    { item: 4, exp: 1, mana: 1 },
    "+540 周桶必须在提前一小时的时刻跨过周一重置",
)

console.log("reward campaign runtime tests passed")
