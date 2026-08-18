"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

const officialRows = require("./fixtures/content-mana-node/official-1.4.54-rows.json")

require("ts-node/register/transpile-only")

const {
    serializeNestedOrderedMap,
    serializeOrderedMap,
} = require("./orderedmap_serializer.cjs")

let convertManaNodes
let parseManaNodeEvolutionSemantics
try {
    ({ convertManaNodes } = require("../src/content/converters/mana-node"))
    const semantics = require("../src/content/mana-node-semantics")
    parseManaNodeEvolutionSemantics = semantics.parseManaNodeEvolutionSemantics
} catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error
}

const MANA_NODE_PATH = "master/mana_board/mana_node.orderedmap"

function encodeCsv(fields) {
    return fields.map(field => (
        /[",\r\n]/.test(field)
            ? `"${field.replaceAll('"', '""')}"`
            : field
    )).join(",")
}

function fixture(itemIds = "1,2", itemCounts = "5,3", fields = {}) {
    const { field1 = "0", field5 = "0", field6 = "2" } = fields
    const rows = serializeOrderedMap([
        { key: "1", row: encodeCsv(["2201", field1, itemIds, itemCounts, "340", field5, field6]) },
    ])
    const boards = serializeNestedOrderedMap([{ key: "1", row: rows }])
    const root = serializeNestedOrderedMap([{ key: "101", row: boards }])
    return {
        requested: [],
        reader: {
            async readBytes(logicalPath) {
                this.requested?.push?.(logicalPath)
                return root
            },
        },
        root,
    }
}

function officialFixture() {
    const rows = serializeOrderedMap(officialRows.rows.map(row => ({
        key: row.key,
        row: row.text,
    })))
    const boards = serializeNestedOrderedMap([{ key: officialRows.boardId, row: rows }])
    const root = serializeNestedOrderedMap([{ key: officialRows.characterId, row: boards }])
    return {
        async readBytes(logicalPath) {
            assert.equal(logicalPath, officialRows.source)
            return root
        },
    }
}

function assertDeepFrozen(value, seen = new Set()) {
    if (!value || typeof value !== "object" || seen.has(value)) return
    seen.add(value)
    assert.equal(Object.isFrozen(value), true)
    for (const key of Reflect.ownKeys(value)) assertDeepFrozen(value[key], seen)
}

test("mana node converter derives character board costs from the official nested map", async () => {
    assert.equal(typeof convertManaNodes, "function", "应导出 convertManaNodes")
    const source = fixture()
    const requested = []
    source.reader.readBytes = async logicalPath => {
        requested.push(logicalPath)
        return source.root
    }
    const output = await convertManaNodes(source.reader)

    assert.deepEqual(requested, [MANA_NODE_PATH])
    assert.deepEqual(output, {
        "mana_node.json": {
            "101": {
                "1": {
                    "2201": {
                        items: { "1": 5, "2": 3 },
                        manaCost: 340,
                        field1: "0",
                        field5: "0",
                        field6: "2",
                    },
                },
            },
        },
    })
    assertDeepFrozen(output)
})

test("converter validates raw fields and the shared parser derives CN evolution semantics", async () => {
    assert.equal(typeof convertManaNodes, "function", "应导出 convertManaNodes")
    assert.equal(typeof parseManaNodeEvolutionSemantics, "function", "应导出共享 ManaNode 语义解析器")
    assert.equal(officialRows.sourceSha256, "099050892f7f78b214e2b5bcb35caf194b1bd1483ff009eb346033c51e5df4dd")

    const output = await convertManaNodes(officialFixture())
    const nodes = output["mana_node.json"][officialRows.characterId][officialRows.boardId]
    assert.deepEqual(Object.keys(nodes["2201"]).sort(), [
        "field1",
        "field5",
        "field6",
        "items",
        "manaCost",
    ])

    assert.deepEqual(Object.fromEntries(Object.entries(nodes).map(([nodeId, node]) => [
        nodeId,
        parseManaNodeEvolutionSemantics(node),
    ])), {
        "2201": { abilitySlotIndex: 1, isSkillEvolutionRequisite: false },
        "2207": { abilitySlotIndex: 2, isSkillEvolutionRequisite: false },
        "2213": { abilitySlotIndex: 3, isSkillEvolutionRequisite: false },
        "2219": { abilitySlotIndex: null, isSkillEvolutionRequisite: true },
        "2220": { abilitySlotIndex: null, isSkillEvolutionRequisite: false },
    })
})

test("mana node converter rejects unknown or malformed evolution semantic fields", async () => {
    await assert.rejects(
        convertManaNodes(fixture("1", "1", { field1: "9" }).reader),
        /field1 must identify an ability or episode node/i,
    )
    await assert.rejects(
        convertManaNodes(fixture("1", "1", { field5: "9" }).reader),
        /field5 has an unknown ability effect kind/i,
    )
    await assert.rejects(
        convertManaNodes(fixture("1", "1", { field6: "" }).reader),
        /ability slot index must be a non-negative integer/i,
    )
})

test("mana node converter rejects mismatched item and count lists", async () => {
    assert.equal(typeof convertManaNodes, "function", "应导出 convertManaNodes")
    const source = fixture("1,2", "5")
    await assert.rejects(
        convertManaNodes(source.reader),
        /mana_node\[101\]\[1\].*item and count list lengths/i,
    )
})
