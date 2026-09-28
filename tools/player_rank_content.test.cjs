"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    getPlayerRankContent,
    getPlayerRankLevel,
    parsePlayerRankContent,
} = require("../src/lib/player-rank-content")
const {
    createFrozenTestContentRepository,
} = require("./helpers/content-snapshot-fixture.cjs")

// 联机投影统一走完整 Rank 内容（player_rank_full.json，0-250），
// 不再使用只有 101-250 的 CDN 子集表（低等级玩家投影断崖为 1）。
function repository() {
    return createFrozenTestContentRepository({
        tables: {
            "cdndata/player_rank_full.json": {
                "1": [["19", "0", "0.0"]],
                "2": [["22", "10", "0.0"]],
                "100": [["82", "90", "0.0"]],
                "101": [["90", "100", "0.3"]],
                "250": [["150", "1000", "0.3"]],
            },
        },
    })
}

test("multi rank projection uses the full rank content owner without low-rank cliffs", () => {
    const repo = repository()
    assert.equal(getPlayerRankLevel(5, repo), 1)
    assert.equal(getPlayerRankLevel(10, repo), 2)
    assert.equal(getPlayerRankLevel(95, repo), 100, "低等级不得断崖为 1")
    assert.equal(getPlayerRankLevel(99, repo), 100)
    assert.equal(getPlayerRankLevel(100, repo), 101)
    assert.equal(getPlayerRankLevel(110, repo), 101)
    assert.equal(getPlayerRankLevel(1000, repo), 250)
    assert.equal(Number.isFinite(getPlayerRankLevel(110, repo)), true)
    // 与统一 owner 同一实现：stamina 的 getRankDegree 与联机投影一致
    assert.equal(getPlayerRankContent(repo).getRankDegree(95), 100)
})

test("rank content caches by repository identity", () => {
    const first = repository()
    const second = repository()
    const firstContent = getPlayerRankContent(first)
    assert.strictEqual(getPlayerRankContent(first), firstContent)
    assert.notStrictEqual(getPlayerRankContent(second), firstContent)
})

test("rank parser rejects malformed roots, keys, rows and boundary gaps", () => {
    assert.throws(() => parsePlayerRankContent([]), /invalid player rank table/i)
    assert.throws(
        () => parsePlayerRankContent({ bad: [["19", "0", "0"]] }),
        /invalid player rank degree: bad/i,
    )
    assert.throws(
        () => parsePlayerRankContent({ "1": [["19", "x", "0"]] }),
        /invalid player rank entry: 1/i,
    )
    assert.throws(
        () => parsePlayerRankContent({ "1": [["19", "0", "0"]] }),
        /missing required boundary ranks/i,
    )
})
