"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")
const { productionContentSnapshotProvider } = require("../src/content/runtime/content-snapshot")
const { getStarCrumbExchangeCatalog } = require("../src/lib/star-crumb-exchange/catalog")
const { getBondTokenExchangeCatalog } = require("../src/lib/bond-token-exchange/catalog")
const { getExBoostContentCatalog } = require("../src/lib/ex-boost-content")
const { getCharacterElectionCatalog } = require("../src/lib/character-election")
const { createGameCalendarPolicy } = require("../src/time/game-calendar")
const {
    createFrozenTestContentRepository,
} = require("./helpers/content-snapshot-fixture.cjs")

test("Star Crumb and Bond Token keep independent strict Content entry points", () => {
    const previousSnapshot = productionContentSnapshotProvider.snapshot
    productionContentSnapshotProvider.snapshot = null
    try {
        for (const getter of [
            getStarCrumbExchangeCatalog,
            getBondTokenExchangeCatalog,
            getExBoostContentCatalog,
            getCharacterElectionCatalog,
        ]) {
            assert.throws(
                () => getter(),
                error => error?.code === "CONTENT_SNAPSHOT_NOT_INITIALIZED",
            )
        }
    } finally {
        productionContentSnapshotProvider.snapshot = previousSnapshot
    }
})

test("Bond Token exchange windows start at the explicit +540 epoch", () => {
    const calendar540 = createGameCalendarPolicy(540)
    const repository = createFrozenTestContentRepository({
        tables: {
            "bond_token_exchange.json": {
                4001: [["100", "50", "2024-01-01 00:00:00", "2024-01-31 23:59:59"]],
            },
        },
    })
    const catalog540 = getBondTokenExchangeCatalog(repository, calendar540)
    const start540 = Date.parse("2024-01-01T00:00:00+09:00")
    const end540 = Date.parse("2024-01-31T23:59:59+09:00")
    assert.equal(catalog540.resolve(4001, start540 - 1).kind, "outOfPeriod",
        "+540 开放边界前一刻必须关闭")
    assert.equal(catalog540.resolve(4001, start540).ok, true)
    assert.equal(catalog540.resolve(4001, end540).ok, true)
    assert.equal(catalog540.resolve(4001, end540 + 1).kind, "outOfPeriod",
        "+540 关闭边界后一刻必须关闭")
    assert.deepEqual(catalog540.list(start540).map(product => product.equipmentId), [4001])

    // The +480 catalog is a distinct cached instance and must never satisfy
    // the +540 window instant.
    const catalog480 = getBondTokenExchangeCatalog(repository)
    assert.notStrictEqual(catalog480, catalog540)
    assert.equal(catalog480.resolve(4001, start540).ok, false)
    assert.equal(catalog480.list(start540).length, 0)
})
