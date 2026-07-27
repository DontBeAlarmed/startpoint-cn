"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    serializeNestedOrderedMap,
    serializeOrderedMap,
} = require("./orderedmap_serializer.cjs")

let convertManaNodes
try {
    ({ convertManaNodes } = require("../src/content/converters/mana-node"))
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

function fixture(itemIds = "1,2", itemCounts = "5,3") {
    const rows = serializeOrderedMap([
        { key: "1", row: encodeCsv(["2201", "0", itemIds, itemCounts, "340", "0", "2"]) },
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

test("mana node converter rejects mismatched item and count lists", async () => {
    assert.equal(typeof convertManaNodes, "function", "应导出 convertManaNodes")
    const source = fixture("1,2", "5")
    await assert.rejects(
        convertManaNodes(source.reader),
        /mana_node\[101\]\[1\].*item and count list lengths/i,
    )
})
