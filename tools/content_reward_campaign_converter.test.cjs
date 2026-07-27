const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    REWARD_CAMPAIGN_PATH,
    convertRewardCampaigns,
} = require("../src/content/converters/reward-campaign")
const bundledCampaigns = require("../assets/reward_campaign.json")

function row(key, values) {
    const fields = Array.from({ length: 11 }, () => "")
    for (const [index, value] of Object.entries(values)) fields[Number(index)] = String(value)
    return {
        key: String(key),
        text: fields.map(value => value.includes(",") ? `"${value}"` : value).join(","),
    }
}

test("reward campaign converter preserves time, reward kind and quest range queries", async () => {
    const output = await convertRewardCampaigns({
        async read(path) {
            assert.equal(path, REWARD_CAMPAIGN_PATH)
            return [
                row(1, {
                    0: 0, 1: "2024-07-11 12:00:00", 2: "2024-08-01 23:59:59",
                    5: 0, 6: 2, 7: 0, 8: "(None)", 9: "(None)", 10: "(None)",
                }),
                row(2, {
                    0: 0, 1: "2024-07-11 12:00:00", 2: "2024-08-01 23:59:59",
                    5: 0, 6: 1.5, 7: 7, 8: 1, 10: "1,2",
                }),
                row(3, {
                    0: 0, 1: "2024-07-11 12:00:00", 2: "2024-08-01 23:59:59",
                    5: 1, 6: 2, 7: 12,
                }),
            ]
        },
    })

    assert.deepEqual(output["reward_campaign.json"], {
        1: {
            id: 1,
            startAtMs: Date.parse("2024-07-11T12:00:00+09:00"),
            endAtMs: Date.parse("2024-08-01T23:59:59+09:00"),
            rewardKind: 0,
            rate: 2,
            categories: [1],
            keyQueries: [null, null, null],
        },
        2: {
            id: 2,
            startAtMs: Date.parse("2024-07-11T12:00:00+09:00"),
            endAtMs: Date.parse("2024-08-01T23:59:59+09:00"),
            rewardKind: 0,
            rate: 1.5,
            categories: [13],
            keyQueries: [[1], [1, 2]],
        },
        3: {
            id: 3,
            startAtMs: Date.parse("2024-07-11T12:00:00+09:00"),
            endAtMs: Date.parse("2024-08-01T23:59:59+09:00"),
            rewardKind: 1,
            rate: 2,
            categories: [6, 14, 13, 20],
            keyQueries: [],
        },
    })
})

test("reward campaign converter rejects unsupported recurrence and malformed rates", async () => {
    await assert.rejects(
        convertRewardCampaigns({ read: async () => [row(1, {
            0: 1, 1: "2024-07-11 12:00:00", 2: "2024-08-01 23:59:59",
            3: 1, 4: "01:00:00", 5: 0, 6: 2, 7: 0,
            8: "(None)", 9: "(None)", 10: "(None)",
        })] }),
        /weekly.*not supported/i,
    )
    await assert.rejects(
        convertRewardCampaigns({ read: async () => [row(1, {
            0: 0, 1: "2024-07-11 12:00:00", 2: "2024-08-01 23:59:59",
            5: 0, 6: 0.5, 7: 0, 8: "(None)", 9: "(None)", 10: "(None)",
        })] }),
        /rate.*at least 1/i,
    )
})

test("bundled 1.4.54 fallback contains the complete official campaign distribution", () => {
    const counts = Object.values(bundledCampaigns).reduce((result, campaign) => {
        result[campaign.rewardKind] = (result[campaign.rewardKind] ?? 0) + 1
        return result
    }, {})
    assert.equal(Object.keys(bundledCampaigns).length, 203)
    assert.deepEqual(counts, { 0: 179, 1: 12, 2: 12 })
})
