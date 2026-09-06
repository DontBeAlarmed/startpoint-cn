"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const { productionContentSnapshotProvider } = require("../src/content/runtime/content-snapshot")
const { assertValidGachaSaveState } = require("../src/lib/gacha-owner/save-validation")

function tables(entries) {
    return new Map(Object.entries(entries))
}

test("Gacha save validation reads Content only for Content-bound child state", () => {
    const previousSnapshot = productionContentSnapshotProvider.snapshot
    productionContentSnapshotProvider.snapshot = null
    try {
        assert.doesNotThrow(() => assertValidGachaSaveState(tables({
            players_gacha_info: [{ gacha_id: 10, crazy_draw_count: null }],
            players_gacha_conversions: [{
                gacha_id: 10,
                pending_point: 1,
                converted_at: 1,
                shown: 0,
            }],
        })))

        assert.throws(
            () => assertValidGachaSaveState(tables({
                players_gacha_info: [{ gacha_id: 10, crazy_draw_count: null }],
                players_stars_gacha_campaigns: [{ gacha_id: 10 }],
            })),
            error => error?.code === "CONTENT_SNAPSHOT_NOT_INITIALIZED",
        )
    } finally {
        productionContentSnapshotProvider.snapshot = previousSnapshot
    }
})
