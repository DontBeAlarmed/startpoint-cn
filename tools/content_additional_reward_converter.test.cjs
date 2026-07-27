"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    ADDITIONAL_REWARD_PATHS,
    convertAdditionalRewards,
} = require("../src/content/converters/additional-reward")

function fields(length, values) {
    const result = Array(length).fill("")
    for (const [index, value] of Object.entries(values)) result[Number(index)] = String(value)
    return result
}

function row(key, values) {
    return { key: String(key), text: values.join(",") }
}

test("additional reward converter joins groups, collect-item rules and boss pickup schedules", async () => {
    const flat = new Map([
        [ADDITIONAL_REWARD_PATHS.collectItemEvents, [row(1, fields(28, {
            20: "2024-08-01 12:00:00",
            21: "2024-08-31 23:59:59",
            23: 0,
            24: 1,
            25: 4,
            26: 2,
            27: 1004002,
        }))]],
        [ADDITIONAL_REWARD_PATHS.bossPickupEvents, [row(2, fields(8, {
            6: "2024-08-01 12:00:00",
            7: "2024-08-31 23:59:59",
        }))]],
    ])
    const nested = new Map([
        [ADDITIONAL_REWARD_PATHS.groups, [
            { key: "200001", rows: [row(1, ["collect_item", "0", "80001", "5", "1"])] },
            { key: "200002", rows: [row(1, ["collect_item_50", "0", "80001", "3", "1"])] },
            { key: "200003", rows: [row(1, ["boss_pickup", "0", "80002", "1", "1"])] },
        ]],
        [ADDITIONAL_REWARD_PATHS.collectItemQuestRelations, [{ key: "1", rows: [
            row(1, ["1001", "0", "1", "4", "2", "11"]),
        ] }]],
        [ADDITIONAL_REWARD_PATHS.collectItemRewardRelations, [{ key: "11", rows: [
            row(0, ["1100", "tier0", "200001"]),
            row(50, ["1150", "tier50", "200002"]),
        ] }]],
        [ADDITIONAL_REWARD_PATHS.bossPickupSchedules, [{ key: "2", rows: [
            row(1, ["1", "12", "background", "200003", "3", "1",
                "2024-08-10 12:00:00", "2024-08-11 23:59:59"]),
        ] }]],
    ])

    const output = await convertAdditionalRewards({
        read: async path => flat.get(path) ?? [],
        readNested: async path => nested.get(path) ?? [],
    })

    assert.deepEqual(output["additional_reward_rules.json"], {
        groups: {
            200001: [{ index: 1, groupStringId: "collect_item", type: 0, id: 80001, number: 5, weight: 1 }],
            200002: [{ index: 1, groupStringId: "collect_item_50", type: 0, id: 80001, number: 3, weight: 1 }],
            200003: [{ index: 1, groupStringId: "boss_pickup", type: 0, id: 80002, number: 1, weight: 1 }],
        },
        collectItemRules: [{
            eventId: 1,
            startAtMs: Date.parse("2024-08-01T12:00:00+08:00"),
            endAtMs: Date.parse("2024-08-31T23:59:59+08:00"),
            prerequisite: { category: 1, questId: 1004002 },
            categories: [1],
            keyQueries: [[1], [4], [2]],
            thresholds: [
                { enemyLevelMin: 0, groupId: 200001 },
                { enemyLevelMin: 50, groupId: 200002 },
            ],
        }],
        bossPickupRules: [{
            eventId: 2,
            startAtMs: Date.parse("2024-08-10T12:00:00+08:00"),
            endAtMs: Date.parse("2024-08-11T23:59:59+08:00"),
            categories: [2],
            keyQueries: [[1], [12], null],
            groupId: 200003,
            availableRank: 3,
        }],
    })
})
