"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    getMultiPlayerRankLevels,
    getPlayerRankLevel,
    parseMultiPlayerRankLevels,
} = require("../src/lib/player-rank-content")
const {
    createFrozenTestContentRepository,
} = require("./helpers/content-snapshot-fixture.cjs")

function repository(threshold) {
    return createFrozenTestContentRepository({
        tables: {
            "cdndata/player_rank.json": {
                "101": [["90", String(threshold), "0.3"]],
                "102": [["90", String(threshold + 10), "0.3"]],
            },
        },
    })
}

test("Multi rank catalog caches by repository identity and returns finite response ranks", () => {
    const firstRepository = repository(100)
    const secondRepository = repository(200)
    const first = getMultiPlayerRankLevels(firstRepository)
    assert.strictEqual(getMultiPlayerRankLevels(firstRepository), first)
    assert.notStrictEqual(getMultiPlayerRankLevels(secondRepository), first)
    assert.equal(getPlayerRankLevel(99, firstRepository), 1)
    assert.equal(getPlayerRankLevel(100, firstRepository), 101)
    assert.equal(getPlayerRankLevel(110, firstRepository), 102)
    assert.equal(Number.isFinite(getPlayerRankLevel(110, firstRepository)), true)
})

test("Multi rank parser rejects malformed roots, keys, rows and thresholds", () => {
    assert.throws(() => parseMultiPlayerRankLevels([]), /invalid multi player rank table/i)
    assert.throws(
        () => parseMultiPlayerRankLevels({ bad: [["x", "0", "x"]] }),
        /invalid multi player rank: bad/i,
    )
    assert.throws(
        () => parseMultiPlayerRankLevels({ "101": [["90", "bad", "0.3"]] }),
        /invalid multi player rank threshold/i,
    )
    assert.throws(
        () => parseMultiPlayerRankLevels({
            "101": [["90", "100", "0.3"]],
            "102": [["90", "100", "0.3"]],
        }),
        /thresholds must be strictly increasing/i,
    )
    assert.throws(() => parseMultiPlayerRankLevels({}), /must not be empty/i)
})
