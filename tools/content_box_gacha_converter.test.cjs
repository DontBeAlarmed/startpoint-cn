"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    serializeNestedOrderedMap,
    serializeOrderedMap,
} = require("./orderedmap_serializer.cjs")

let convertBoxGachaTables
try {
    ({ convertBoxGachaTables } = require("../src/content/converters/box-gacha"))
} catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error
}

const PATHS = Object.freeze({
    gacha: "master/box_gacha/box_gacha.orderedmap",
    reward: "master/box_gacha/box_reward.orderedmap",
    box: "master/box_gacha/box.orderedmap",
})

function encodeCsv(fields) {
    return fields.map(field => (
        /[",\r\n]/.test(field)
            ? `"${field.replaceAll('"', '""')}"`
            : field
    )).join(",")
}

function fields(length, values) {
    const result = Array(length).fill("")
    for (const [index, value] of Object.entries(values)) result[Number(index)] = String(value)
    return result
}

function fixture({ rewardAvailable = 2 } = {}) {
    const rewardRows = serializeOrderedMap([
        { key: "1", row: encodeCsv(["1000101001", "10", "0", "70001", "1", String(rewardAvailable), "2"]) },
        { key: "2", row: encodeCsv(["1000101002", "20", "3", "", "500", "3", "0"]) },
    ])
    const rewardBoxes = serializeNestedOrderedMap([{ key: "1", row: rewardRows }])
    const rewardRoot = serializeNestedOrderedMap([{ key: "1", row: rewardBoxes }])
    const boxRows = serializeOrderedMap([{ key: "1", row: encodeCsv(fields(16, {
        3: "(None)",
        11: 2,
        12: "(None)",
        13: "2025-01-01 05:00:00",
        14: "2025-01-31 11:59:59",
        15: 1,
    })) }])
    const boxRoot = serializeNestedOrderedMap([{ key: "1", row: boxRows }])
    const requested = []
    return {
        requested,
        reader: {
            async read(logicalPath) {
                requested.push(["read", logicalPath])
                if (logicalPath !== PATHS.gacha) throw new Error(`missing fixture ${logicalPath}`)
                return [{ key: "1", text: encodeCsv(fields(8, { 2: 30101, 3: 10 })) }]
            },
            async readBytes(logicalPath) {
                requested.push(["readBytes", logicalPath])
                if (logicalPath === PATHS.reward) return rewardRoot
                if (logicalPath === PATHS.box) return boxRoot
                throw new Error(`missing fixture ${logicalPath}`)
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

test("box gacha converter derives rewards, inventory totals, and reset settings together", async () => {
    assert.equal(typeof convertBoxGachaTables, "function", "应导出 convertBoxGachaTables")
    const source = fixture()
    const output = await convertBoxGachaTables(source.reader)

    assert.deepEqual(source.requested, [
        ["read", PATHS.gacha],
        ["readBytes", PATHS.reward],
        ["readBytes", PATHS.box],
    ])
    assert.deepEqual(output["box_reward.json"], {
        "1": {
            "1": {
                "1000101001": { type: 0, count: 1, available: 2, tier: 2, id: 70001 },
                "1000101002": { type: 3, count: 500, available: 3, tier: 0 },
            },
        },
    })
    assert.deepEqual(output["box_gacha.json"], {
        "1": { itemId: 30101, count: 10, availableCounts: { "1": 5 } },
    })
    assert.deepEqual(output["box_gacha_box_settings.json"], {
        "1": {
            "1": {
                requiredBoxId: null,
                resetKind: 2,
                resetLimit: null,
                availableFrom: "2025-01-01 05:00:00",
                availableUntil: "2025-01-31 11:59:59",
                closeKind: 1,
            },
        },
    })
    assertDeepFrozen(output)
})

test("box gacha converter rejects reward and settings box-set drift", async () => {
    assert.equal(typeof convertBoxGachaTables, "function", "应导出 convertBoxGachaTables")
    const source = fixture()
    source.reader.readBytes = async logicalPath => (
        logicalPath === PATHS.reward
            ? serializeNestedOrderedMap([{ key: "1", row: serializeNestedOrderedMap([]) }])
            : fixture().reader.readBytes(logicalPath)
    )

    await assert.rejects(
        convertBoxGachaTables(source.reader),
        /box gacha 1 box sets do not match/i,
    )
})
