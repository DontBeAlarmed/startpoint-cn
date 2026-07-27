"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    productionContentSnapshotProvider,
} = require("../src/content/runtime/content-snapshot")
const assets = require("../src/lib/assets")

test("reward readers use the active Content snapshot instead of static bundled tables", t => {
    const previous = productionContentSnapshotProvider.snapshot
    t.after(() => { productionContentSnapshotProvider.snapshot = previous })
    const tables = {
        "clear_reward.json": { 99001: { type: 3, count: 7 } },
        "score_reward.json": { 99002: [{ type: 0, reward_type: 4, count: 8 }] },
        "rare_score_reward.json": { 99003: [{ type: 0, id: 42, count: 9 }] },
        "rush_event_quest_folder.json": { 99004: { 2: [{ type: 3, count: 10 }] } },
        "score_attack_border_reward.json": { "99005_3": [{ id: 11, score: 12 }] },
        "rush_event_ranking_reward.json": {
            99006: { 1: [{ fromRank: 1, toRank: 3, kind: 7, kindId: 64, number: 2 }] },
        },
    }
    productionContentSnapshotProvider.snapshot = {
        cdn: { targetVersion: "fixture" },
        repository: {
            info: () => ({ source: "release", assetVersion: "fixture" }),
            table(tableName) {
                if (!(tableName in tables)) throw new Error(`unexpected reward table ${tableName}`)
                return tables[tableName]
            },
        },
    }

    assert.deepEqual(assets.getClearRewardSync(99001), { type: 3, count: 7 })
    assert.deepEqual(assets.getScoreRewardGroup(99002), [{ type: 0, reward_type: 4, count: 8 }])
    assert.deepEqual(assets.getRareScoreRewardGroup(99003), [{ type: 0, id: 42, count: 9 }])
    assert.deepEqual(assets.getRushEventFolderClearRewards(99004, 2), [{ type: 3, count: 10 }])
    assert.deepEqual(
        assets.getScoreAttackBorderRewards()["99005_3"],
        [{ id: 11, score: 12 }],
    )
    assert.deepEqual(
        assets.getRushEventRankingRewards()[99006],
        { 1: [{ fromRank: 1, toRank: 3, kind: 7, kindId: 64, number: 2 }] },
    )

    const routeSource = fs.readFileSync(
        path.join(__dirname, "../src/routes/api/rushEvent.ts"),
        "utf8",
    )
    assert.doesNotMatch(routeSource, /assets\/rush_event_ranking_reward\.json/)
    assert.match(routeSource, /getRushEventRankingRewards\(\)/)
})
