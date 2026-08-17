"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const lifecycle = require("../../src/lib/quest/single-continue-lifecycle")

function createActiveQuest(overrides = {}) {
    return {
        playerId: 7,
        playId: "single-continue-play",
        questId: 1001001,
        category: 1,
        isMulti: false,
        continueCount: 2,
        ...overrides,
    }
}

function createInput(memoryQuest = createActiveQuest(), overrides = {}) {
    return {
        playerId: 7,
        memoryQuest,
        playId: "single-continue-play",
        questId: 1001001,
        category: 1,
        expectedContinueCount: 2,
        cost: 50,
        ...overrides,
    }
}

function createFixture({
    player = { freeVmoney: 30, vmoney: 40 },
    storedQuest = createActiveQuest(),
    failCommit = false,
    beforeTransaction,
} = {}) {
    let databaseState = structuredClone({ player, storedQuest })
    let transactionActive = false
    let transactionCalls = 0
    const writes = []

    const dependencies = {
        transaction(operation) {
            beforeTransaction?.(databaseState)
            const snapshot = structuredClone(databaseState)
            transactionCalls++
            transactionActive = true
            try {
                const result = operation()
                if (failCommit) throw new Error("simulated continue commit failure")
                return result
            } catch (error) {
                databaseState = snapshot
                throw error
            } finally {
                transactionActive = false
            }
        },
        getPlayer() {
            assert.equal(transactionActive, true)
            return databaseState.player
        },
        getStoredActiveQuest() {
            assert.equal(transactionActive, true)
            return databaseState.storedQuest
        },
        updatePlayerCurrency(_playerId, freeVmoney, vmoney) {
            assert.equal(transactionActive, true)
            writes.push("player")
            databaseState.player = { freeVmoney, vmoney }
        },
        updateStoredContinueCount(_playerId, continueCount) {
            assert.equal(transactionActive, true)
            writes.push("activeQuest")
            databaseState.storedQuest.continueCount = continueCount
        },
    }

    return {
        dependencies,
        getState: () => structuredClone(databaseState),
        getTransactionCalls: () => transactionCalls,
        writes,
    }
}

module.exports = { createActiveQuest, createFixture, createInput, lifecycle }
