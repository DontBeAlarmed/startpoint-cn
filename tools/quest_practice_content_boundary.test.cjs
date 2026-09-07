"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { installFrozenTestContentSnapshot } = require("./helpers/content-snapshot-fixture.cjs")
const { QuestCategory } = require("../src/lib/types")
const { getPracticeQuestSync, getQuestFromCategorySync } = require("../src/lib/quest-content")

test("practice quest reads the active runtime snapshot", () => {
    const installed = installFrozenTestContentSnapshot({
        tables: {
            "practice_quest.json": {
                9001: {
                    name: "runtime practice",
                    clearRewardId: 1,
                    bRankTime: 1,
                    aRankTime: 1,
                    sRankTime: 1,
                    sPlusRankTime: 1,
                },
            },
            "clear_reward.json": {
                1: { type: 3, count: 1 },
            },
        },
    })
    try {
        assert.equal(getPracticeQuestSync(9001)?.name, "runtime practice")
        assert.equal(
            getQuestFromCategorySync(QuestCategory.PRACTICE, 9001)?.name,
            "runtime practice",
        )
    } finally {
        installed.restore()
    }
})
