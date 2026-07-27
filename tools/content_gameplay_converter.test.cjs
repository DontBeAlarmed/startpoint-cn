"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

let convertGameplayTables
try {
    ({ convertGameplayTables } = require("../src/content/converters/gameplay"))
} catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error
}

const PATHS = Object.freeze({
    carnival: "master/quest/event/carnival_event_total_score_reward.orderedmap",
    equipmentMovie: "master/gacha/equipment_gacha_movie_probability.orderedmap",
    exBoost: "master/ex_boost/ex_boost.orderedmap",
    exStatus: "master/ex_boost/ex_status.orderedmap",
    raidEvent: "master/quest/event/raid_event.orderedmap",
})

function encodeCsv(fields) {
    return fields.map(field => (
        /[",\r\n]/.test(field)
            ? `"${field.replaceAll('"', '""')}"`
            : field
    )).join(",")
}

function row(key, fields) {
    return { key, text: encodeCsv(fields.map(String)) }
}

function fields(length, values) {
    const result = Array(length).fill("")
    for (const [index, value] of Object.entries(values)) result[Number(index)] = String(value)
    return result
}

function fixture(overrides = new Map()) {
    const requested = []
    const sources = new Map([
        [PATHS.carnival, [row("12", fields(22, {
            0: 3,
            2: 5000,
            3: 20002,
            4: 0,
            5: 90001,
            6: 4,
            7: 3,
            8: "(None)",
            9: 1000,
            10: 7,
            11: 61001,
            12: 1,
            13: "(None)",
            14: "",
            15: "(None)",
        }))]],
        [PATHS.equipmentMovie, [row("1", [
            "normal", "0.22", "0.2", "0.35", "0.25", "0", "0.35", "0",
        ])]],
        [PATHS.exBoost, [
            row("10001", ["5", "awaiking_crystal_r3", "5,1,3,0,4,2"]),
            row("10004", ["3", "alterite_r4", "0"]),
            row("10007", ["1", "awaiking_crystal_r5", "5,1,3,0,4,2"]),
        ]],
        [PATHS.exStatus, [
            row("3", ["higher_atk_r5", "150", "50", "5"]),
            row("9", ["higher_atk_r3", "30", "10", "3"]),
            row("6", ["higher_atk_r4", "70", "20", "4"]),
        ]],
        [PATHS.raidEvent, [row("2", fields(25, { 17: 100000000 }))]],
        ...overrides,
    ])
    return {
        requested,
        reader: {
            async read(logicalPath) {
                requested.push(logicalPath)
                if (!sources.has(logicalPath)) throw new Error(`missing fixture ${logicalPath}`)
                return sources.get(logicalPath)
            },
        },
    }
}

function assertDeepFrozen(value, seen = new Set()) {
    if (!value || typeof value !== "object" || seen.has(value)) return
    seen.add(value)
    assert.equal(Object.isFrozen(value), true)
    for (const key of Reflect.ownKeys(value)) assertDeepFrozen(value[key], seen)
}

test("gameplay converter emits the five runtime tables from authoritative rows", async () => {
    assert.equal(typeof convertGameplayTables, "function", "应导出 convertGameplayTables")
    const source = fixture()
    const output = await convertGameplayTables(source.reader)

    assert.deepEqual(source.requested, Object.values(PATHS))
    assert.deepEqual(output["carnival_event_total_score_reward.json"], {
        "12": {
            id: 12,
            eventId: 3,
            score: 5000,
            reasonId: 20002,
            rewards: [
                { kind: 0, id: 90001, amount: 4 },
                { kind: 3, amount: 1000 },
                { kind: 7, id: 61001, amount: 1 },
            ],
        },
    })
    assert.deepEqual(output["equipment_gacha_movie_probability.json"], {
        "1": {
            stringId: "normal",
            probabilityEruption: 0.22,
            probabilityTreasureUp3To5: 0.2,
            probabilityTreasureUp4To5: 0.35,
            probabilityTreasureUp3To4: 0.25,
            guaranteeProbabilityTreasureUp3To5: 0,
            guaranteeProbabilityTreasureUp4To5: 0.35,
            guaranteeProbabilityTreasureUp3To4: 0,
        },
    })
    assert.deepEqual(output["ex_boost.json"], {
        "10001": { tier: 1, count: 5 },
        "10004": { tier: 2, count: 3, element: 0 },
        "10007": { tier: 3, count: 1 },
    })
    assert.deepEqual(output["ex_status.json"], {
        "1": [9],
        "2": [6],
        "3": [3],
    })
    assert.deepEqual(output["raid_event.json"], {
        "2": { requiredKillCount: 100000000 },
    })
    assertDeepFrozen(output)
})

test("gameplay converter rejects malformed gameplay rows instead of emitting partial tables", async () => {
    assert.equal(typeof convertGameplayTables, "function", "应导出 convertGameplayTables")
    const source = fixture(new Map([
        [PATHS.raidEvent, [row("2", fields(25, { 17: 0 }))]],
    ]))

    await assert.rejects(
        convertGameplayTables(source.reader),
        /raid_event\[2\]\.requiredKillCount must be a positive integer/i,
    )
})
