"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")
const { productionContentSnapshotProvider } = require("../src/content/runtime/content-snapshot")
const { getStarCrumbExchangeCatalog } = require("../src/lib/star-crumb-exchange/catalog")
const { getBondTokenExchangeCatalog } = require("../src/lib/bond-token-exchange/catalog")
const { getExBoostContentCatalog } = require("../src/lib/ex-boost-content")
const { getCharacterElectionCatalog } = require("../src/lib/character-election")

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
