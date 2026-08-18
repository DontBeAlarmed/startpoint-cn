"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const official = require("./fixtures/content-character-mana/official-1.4.54-summary.json")

let buildManaBoardParentIndex
try {
    ({ buildManaBoardParentIndex } = require("../src/content/mana-board-parent-index"))
} catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error
}

function row(nodeId, parent = "(None)") {
    return [[String(nodeId), "0", "0", "road", "0", String(parent)]]
}

function validTable() {
    return {
        "10": {
            "1": { "1": row(101), "2": row(102, 101), "3": row(103, 102) },
            "2": { "1": row(201) },
        },
    }
}

test("parent index parses roots and same-board parent links without changing the source", () => {
    assert.equal(typeof buildManaBoardParentIndex, "function")
    const source = validTable()
    const before = structuredClone(source)
    const index = buildManaBoardParentIndex(source)

    assert.equal(index["10"]["1"]["101"], null)
    assert.equal(index["10"]["1"]["102"], 101)
    assert.equal(index["10"]["1"]["103"], 102)
    assert.deepEqual(source, before)
    assert.equal(Object.isFrozen(index["10"]["1"]), true)
})

test("parent index rejects missing, cross-board, and self parent references", () => {
    const missing = validTable()
    missing["10"]["1"]["2"] = row(102, 999)
    assert.throws(() => buildManaBoardParentIndex(missing), /parent 999.*same board/i)

    const crossBoard = validTable()
    crossBoard["10"]["1"]["2"] = row(102, 201)
    assert.throws(() => buildManaBoardParentIndex(crossBoard), /parent 201.*same board/i)

    const self = validTable()
    self["10"]["1"]["2"] = row(102, 102)
    assert.throws(() => buildManaBoardParentIndex(self), /must not reference itself/i)
})

test("parent index rejects non-canonical keys, node ids, and malformed rows", () => {
    for (const source of [
        { "01": validTable()["10"] },
        { "10": { "01": validTable()["10"]["1"] } },
        { "10": { "1": { "01": row(101) } } },
        { "10": { "1": { "1": row("0101") } } },
        { "10": { "1": { "1": [["101"]] } } },
    ]) {
        assert.throws(() => buildManaBoardParentIndex(source), /invalid mana board parent content/i)
    }
})

test("bundled official board matches the tracked parent summary", () => {
    const index = buildManaBoardParentIndex(require("../assets/mana_board.json"))
    let boards = 0
    let nodes = 0
    let nodesWithParent = 0
    for (const character of Object.values(index)) {
        for (const board of Object.values(character)) {
            boards += 1
            for (const parent of Object.values(board)) {
                nodes += 1
                if (parent !== null) nodesWithParent += 1
            }
        }
    }
    assert.equal(Object.keys(index).length, official.manaBoardSummary.characters)
    assert.equal(boards, official.manaBoardSummary.boards)
    assert.equal(nodes, official.manaBoardSummary.nodes)
    assert.equal(nodesWithParent, official.manaBoardSummary.nodesWithParent)
})
