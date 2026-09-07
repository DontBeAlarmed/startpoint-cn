"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { installFrozenTestContentSnapshot } = require("./helpers/content-snapshot-fixture.cjs")
const { getRankDegree } = require("../src/lib/stamina")

test("stamina rank degree follows the active runtime snapshot", () => {
    const installed = installFrozenTestContentSnapshot({
        tables: {
            "cdndata/player_rank_full.json": {
                1: [["22", "0", "0.0"]],
                2: [["24", "1", "0.25"]],
                250: [["100", "999999999", "0.5"]],
            },
        },
    })
    try {
        assert.equal(getRankDegree(1_000_000), 2)
    } finally {
        installed.restore()
    }
})
