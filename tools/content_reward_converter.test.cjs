"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { convertRewards } = require("../src/content/converters/reward")

function columns(length, values) {
    const output = Array.from({ length }, () => "")
    for (const [index, value] of Object.entries(values)) output[Number(index)] = String(value)
    return output.join(",")
}

function reader(flat, nested) {
    return {
        async read(logicalPath) {
            const rows = flat[logicalPath]
            if (!rows) throw new Error(`unexpected flat source: ${logicalPath}`)
            return rows
        },
        async readNested(logicalPath) {
            const rows = nested[logicalPath]
            if (!rows) throw new Error(`unexpected nested source: ${logicalPath}`)
            return rows
        },
    }
}

function fixtureReader() {
    const flat = {
        "master/reward/clear_reward.orderedmap": [
            { key: "1", text: "beads,3,,15" },
            { key: "2", text: "character,2,123001," },
        ],
        "master/quest/event/score_attack_border_reward.orderedmap": [
            {
                key: "1002",
                text: columns(24, {
                    1: 7, 2: 3, 4: 1200.0, 5: 16001,
                    6: 0, 7: 40501, 8: 2,
                    9: 4, 10: "", 11: 500,
                    12: "(None)", 13: "", 14: "(None)",
                    15: "(None)", 18: "(None)", 21: "(None)",
                }),
            },
        ],
    }
    const nested = {
        "master/reward/score_reward.orderedmap": [{
            key: "10",
            rows: [
                { key: "2", text: "currency,0,4,,20,500,," },
                { key: "1", text: "rare,1,,,,,2101,0.5" },
            ],
        }],
        "master/reward/rare_score_reward.orderedmap": [{
            key: "2101",
            rows: [
                { key: "1", text: "mana,4,,100,0.25,false" },
                { key: "2", text: "item,0,42,3,0.75,false" },
            ],
        }],
        "master/quest/event/rush_event_quest_folder.orderedmap": [{
            key: "700001",
            rows: [{
                key: "2",
                text: columns(37, {
                    7: 0, 8: 2370001, 9: 50,
                    10: 4, 11: "", 12: 500,
                    13: "(None)", 16: "(None)", 19: "(None)",
                    22: "(None)", 25: "(None)", 28: "(None)",
                    31: "(None)", 34: "(None)",
                }),
            }],
        }],
        "master/quest/event/rush_event_ranking_reward.orderedmap": [{
            key: "700001",
            rows: [
                { key: "2", text: "4,5,14002,7,64001,1" },
                { key: "1", text: "2,3,14001,7,64000,1" },
            ],
        }],
    }
    return reader(flat, nested)
}

test("reward converter restores all six runtime reward projections", async () => {
    const output = await convertRewards(fixtureReader())

    assert.deepEqual(output["clear_reward.json"], {
        1: { name: "", type: 3, count: 15 },
        2: { name: "", type: 2, id: 123001 },
    })
    assert.deepEqual(output["score_reward.json"], {
        10: [
            { name: "", position: 1, type: 1, id: 2101, rarity: 0.5 },
            { name: "", position: 2, type: 0, reward_type: 4, count: 20, field5: 500 },
        ],
    })
    assert.deepEqual(output["rare_score_reward.json"], {
        2101: [
            { name: "", position: 1, type: 4, count: 100, rarity: 0.25 },
            { name: "", position: 2, type: 0, id: 42, count: 3, rarity: 0.75 },
        ],
    })
    assert.deepEqual(output["score_attack_border_reward.json"], {
        "7_3": [{
            id: 1002,
            eventId: 7,
            questId: 3,
            score: 1200,
            reasonId: 16001,
            rewards: [
                { kind: 0, id: 40501, amount: 2 },
                { kind: 4, amount: 500 },
            ],
        }],
    })
    assert.deepEqual(output["rush_event_quest_folder.json"], {
        700001: {
            2: [
                { type: 0, id: 2370001, count: 50 },
                { type: 4, count: 500 },
            ],
        },
    })
    assert.deepEqual(output["rush_event_ranking_reward.json"], {
        700001: {
            1: [{ fromRank: 2, toRank: 3, kind: 7, kindId: 64000, number: 1 }],
            2: [{ fromRank: 4, toRank: 5, kind: 7, kindId: 64001, number: 1 }],
        },
    })
    assert.equal(Object.isFrozen(output), true)
    assert.equal(Object.isFrozen(output["score_reward.json"][10][0]), true)
})

test("reward converter rejects malformed rows instead of publishing partial tables", async () => {
    const source = fixtureReader()
    source.read = async logicalPath => (
        logicalPath === "master/reward/clear_reward.orderedmap"
            ? [{ key: "1", text: "broken,row" }]
            : fixtureReader().read(logicalPath)
    )
    await assert.rejects(convertRewards(source), /invalid reward content.*clear_reward\[1\].*4 columns/i)
})
