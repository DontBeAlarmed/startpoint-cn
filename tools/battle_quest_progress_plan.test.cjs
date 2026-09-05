"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
    createBattleQuestProgressPlan,
} = require("../src/lib/quest/finish/battle-quest-progress-plan")

function input(overrides = {}) {
    return {
        questAccomplished: true,
        questId: 1001,
        clearTime: 12_000,
        score: 400,
        clearRank: 5,
        leaderCharacterId: 101,
        missingLeader: "preserve",
        existing: null,
        ...overrides,
    }
}

test("failed battle settlement plans no quest-history write", () => {
    assert.deepEqual(createBattleQuestProgressPlan(input({
        questAccomplished: false,
    })), { kind: "none" })
})

test("new clears produce the shared insert values", () => {
    assert.deepEqual(createBattleQuestProgressPlan(input()), {
        kind: "insert",
        values: {
            questId: 1001,
            finished: true,
            bestElapsedTimeMs: 12_000,
            highScore: 400,
            clearRank: 5,
            leaderCharacterId: 101,
        },
    })
})

test("existing clears keep monotonic best values and preserve a missing Single leader", () => {
    assert.deepEqual(createBattleQuestProgressPlan(input({
        clearTime: 15_000,
        score: 600,
        clearRank: 4,
        leaderCharacterId: undefined,
        existing: {
            bestElapsedTimeMs: 10_000,
            highScore: 500,
            clearRank: 5,
        },
    })), {
        kind: "update",
        values: {
            questId: 1001,
            finished: true,
            bestElapsedTimeMs: 10_000,
            highScore: 600,
            clearRank: 5,
        },
    })
})

test("Multi can explicitly clear a missing leader and persist host completion", () => {
    assert.deepEqual(createBattleQuestProgressPlan(input({
        leaderCharacterId: null,
        missingLeader: "clear",
        hostFinished: true,
        clearRank: null,
        existing: {
            bestElapsedTimeMs: null,
            highScore: 700,
            clearRank: 4,
        },
    })), {
        kind: "update",
        values: {
            questId: 1001,
            finished: true,
            bestElapsedTimeMs: 12_000,
            highScore: 700,
            leaderCharacterId: null,
            hostFinished: true,
        },
    })
})

test("progress plans expose immutable write values", () => {
    const plan = createBattleQuestProgressPlan(input())
    assert.equal(Object.isFrozen(plan), true)
    assert.equal(Object.isFrozen(plan.values), true)
})
