"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")
const {
    buildDegreeRuleCatalog,
    getMissionCatalog,
    repositoryWith,
} = require("./helpers/mission-degree-session-fixture.cjs")

function countedCatalog(source, label) {
    let manaBoardReads = 0
    const base = repositoryWith({ "mana_board.json": source }, label)
    const repository = {
        ...base,
        table(tableName) {
            if (tableName === "mana_board.json") manaBoardReads++
            return base.table(tableName)
        },
    }
    return {
        catalog: getMissionCatalog(repository),
        reads: () => manaBoardReads,
    }
}

test("Degree Content snapshots are cached per Catalog while rules stay request-local", () => {
    const source = { 111001: { 2: { a: [[101]] } } }
    const firstCatalog = countedCatalog(source, "degree-cache-first")
    const specific = buildDegreeRuleCatalog(firstCatalog.catalog, [1111001])
    source[111001][2].a[0][0] = 999
    const repeated = buildDegreeRuleCatalog(firstCatalog.catalog, [1111001])
    const aggregate = buildDegreeRuleCatalog(firstCatalog.catalog, [55000])

    assert.equal(firstCatalog.reads(), 1)
    assert.equal(specific.tables.manaBoard, repeated.tables.manaBoard)
    assert.equal(specific.tables.manaBoard, aggregate.tables.manaBoard)
    assert.notEqual(specific.rules, repeated.rules)
    assert.equal(specific.tables.manaBoard[111001][2].a[0][0], 101)

    const secondCatalog = countedCatalog(source, "degree-cache-second")
    const isolated = buildDegreeRuleCatalog(secondCatalog.catalog, [1111001])
    assert.equal(secondCatalog.reads(), 1)
    assert.notEqual(isolated.tables.manaBoard, specific.tables.manaBoard)
    assert.equal(isolated.tables.manaBoard[111001][2].a[0][0], 999)
})
