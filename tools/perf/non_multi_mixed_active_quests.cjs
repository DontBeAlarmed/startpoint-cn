"use strict"

const assert = require("node:assert/strict")
const { activeQuests } = require("../../src/lib/quest/active-quest-service")

function captureActiveQuests() {
    return Object.entries(activeQuests)
        .map(([playerId, quest]) => [playerId, structuredClone(quest)])
}

function prepareActiveQuests({ createSentinel, startKey = 999999 } = {}) {
    if (typeof createSentinel !== "function") throw new TypeError("createSentinel must be a function")
    const initial = captureActiveQuests()
    let sentinelKey = startKey
    while (Object.prototype.hasOwnProperty.call(activeQuests, String(sentinelKey))) sentinelKey++
    activeQuests[sentinelKey] = createSentinel()
    return { initial, sentinelKey }
}

function restoreActiveQuests(entries) {
    for (const playerId of Object.keys(activeQuests)) delete activeQuests[playerId]
    for (const [playerId, quest] of entries) activeQuests[playerId] = structuredClone(quest)
    assert.deepEqual(Object.entries(activeQuests), entries)
}

module.exports = { prepareActiveQuests, restoreActiveQuests }
