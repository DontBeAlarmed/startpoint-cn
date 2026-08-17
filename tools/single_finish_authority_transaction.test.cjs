"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
    runSingleFinishSettlementTransaction,
    SingleFinishSettlementValidationError,
} = require("../src/lib/quest/single-finish-settlement")

function activeQuest(overrides = {}) {
    return {
        questId: 1001002,
        category: 1,
        useBossBoostPoint: false,
        useBoostPoint: false,
        isAutoStartMode: false,
        isMulti: false,
        coordinatorOrigin: null,
        playId: "task-26d1-authority",
        continueCount: 0,
        ...overrides,
    }
}

function requestIdentity(quest) {
    return {
        playId: quest.playId,
        questId: quest.questId,
        category: quest.category,
        continueCount: quest.continueCount,
    }
}

function playerSnapshot(overrides = {}) {
    return {
        id: 73,
        boostPoint: 10,
        bossBoostPoint: 3,
        rankPoint: 17,
        ...overrides,
    }
}

function authorityDependencies({ player, progress, events }) {
    let transactionActive = false
    return {
        transaction(operation) {
            assert.equal(transactionActive, false)
            transactionActive = true
            events.push("transaction:start")
            try {
                const result = operation()
                events.push("transaction:commit")
                return result
            } finally {
                transactionActive = false
            }
        },
        getStoredActiveQuest() {
            assert.equal(transactionActive, true)
            events.push("active:read")
            return activeQuest()
        },
        getPlayer() {
            assert.equal(transactionActive, true)
            events.push("player:read")
            return player
        },
        getQuestProgress(playerId, category, questId) {
            assert.equal(transactionActive, true)
            assert.deepEqual([playerId, category, questId], [73, 1, 1001002])
            events.push("progress:read")
            return progress
        },
        assertTransactionActive() {
            assert.equal(transactionActive, true)
        },
    }
}

test("single finish reads active, Player, and old progress inside the transaction before writes", () => {
    const events = []
    const player = playerSnapshot()
    const progress = { questId: 1001002, finished: true, highScore: 456 }
    const dependencies = authorityDependencies({ player, progress, events })

    const result = runSingleFinishSettlementTransaction({
        playerId: 73,
        memoryQuest: activeQuest(),
        request: requestIdentity(activeQuest()),
        settle(context) {
            dependencies.assertTransactionActive()
            events.push("settlement:writes")
            assert.equal(context.player, player)
            assert.equal(context.questProgress, progress)
            return context
        },
        dependencies,
    })

    assert.equal(result.player, player)
    assert.equal(result.questProgress, progress)
    assert.deepEqual(events, [
        "transaction:start",
        "active:read",
        "player:read",
        "progress:read",
        "settlement:writes",
        "transaction:commit",
    ])
})

test("single finish fails closed for a missing Player before progress or writes", () => {
    const events = []
    const dependencies = authorityDependencies({ player: null, progress: null, events })
    let settleCalls = 0

    assert.throws(() => runSingleFinishSettlementTransaction({
        playerId: 73,
        memoryQuest: activeQuest(),
        request: requestIdentity(activeQuest()),
        settle() { settleCalls++ },
        dependencies,
    }), error => (
        error instanceof SingleFinishSettlementValidationError
        && error.message === "Invalid viewer id."
    ))

    assert.equal(settleCalls, 0)
    assert.deepEqual(events, ["transaction:start", "active:read", "player:read"])
})

test("single finish validates transaction Player Boost before progress or writes", () => {
    const events = []
    const dependencies = authorityDependencies({
        player: playerSnapshot({ boostPoint: 1.5 }),
        progress: null,
        events,
    })
    let settleCalls = 0

    assert.throws(() => runSingleFinishSettlementTransaction({
        playerId: 73,
        memoryQuest: activeQuest(),
        request: requestIdentity(activeQuest()),
        settle() { settleCalls++ },
        dependencies,
    }), error => (
        error instanceof SingleFinishSettlementValidationError
        && /invalid boost balance/i.test(error.message)
    ))

    assert.equal(settleCalls, 0)
    assert.deepEqual(events, ["transaction:start", "active:read", "player:read"])
})

test("single finish uses Player and progress changed after identity resolution", () => {
    const identity = { playerId: 73 }
    const staleRoutePlayer = playerSnapshot({ rankPoint: 5 })
    const staleRouteProgress = { questId: 1001002, finished: false, highScore: 10 }
    let currentPlayer = staleRoutePlayer
    let currentProgress = staleRouteProgress

    currentPlayer = playerSnapshot({ rankPoint: 99 })
    currentProgress = { questId: 1001002, finished: true, highScore: 999 }

    const events = []
    const dependencies = authorityDependencies({
        player: currentPlayer,
        progress: currentProgress,
        events,
    })
    const authority = runSingleFinishSettlementTransaction({
        playerId: identity.playerId,
        memoryQuest: activeQuest(),
        request: requestIdentity(activeQuest()),
        settle: context => context,
        dependencies,
    })

    assert.equal(authority.player, currentPlayer)
    assert.notEqual(authority.player, staleRoutePlayer)
    assert.equal(authority.questProgress, currentProgress)
    assert.notEqual(authority.questProgress, staleRouteProgress)
})
