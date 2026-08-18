"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")
const { activeQuests } = require("../../src/lib/quest/active-quest-service")
const { createActiveQuestSentinel } = require("./non_multi_mixed_battle.cjs")
const {
    prepareActiveQuests,
    restoreActiveQuests,
} = require("./non_multi_mixed_active_quests.cjs")

function captureEntries() {
    return Object.entries(activeQuests)
        .map(([playerId, quest]) => [playerId, structuredClone(quest)])
}

test("active quest fixture avoids occupied sentinel keys and restores the initial snapshot", () => {
    const initial = captureEntries()
    const occupied = Object.prototype.hasOwnProperty.call(activeQuests, "999999")
    const external = occupied
        ? structuredClone(activeQuests[999999])
        : { ...createActiveQuestSentinel(), playId: "pre-existing-external" }
    if (!occupied) activeQuests[999999] = external
    try {
        const fixture = prepareActiveQuests({ createSentinel: createActiveQuestSentinel })
        assert.notEqual(fixture.sentinelKey, 999999)
        assert.deepEqual(activeQuests[999999], external)
        restoreActiveQuests(fixture.initial)
        assert.deepEqual(activeQuests[999999], external)
    } finally {
        restoreActiveQuests(initial)
    }
})
