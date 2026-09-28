"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { getQuestEntryContentCatalog } = require("../src/lib/quest-entry-content")
const { getDailyChallengeCatalog } = require("../src/lib/quest/daily-challenge")
const {
    createFrozenTestContentRepository,
} = require("./helpers/content-snapshot-fixture.cjs")

function repository(marker, overrides = {}) {
    return createFrozenTestContentRepository({
        assetVersion: `quest-daily-${marker}`,
        tables: {
            "quest_entry_costs.json": {
                "1_1001": { itemId: 0, itemCount: 0, stamina: marker },
            },
            "quest_unlock_costs.json": {
                "1001": { itemIds: [60000], itemCounts: [marker] },
            },
            // quest-entry-content fail-closed reads the derived prerequisite
            // table alongside the cost tables; an empty one is valid.
            "quest_prerequisites.json": {},
            "daily_challenge_point_lookup.json": {
                "1": { maxPoint: marker, isRecovery: true, name: "challenge" },
            },
            "event_challenge_point_map.json": { "expert_1": 1 },
            ...overrides,
        },
    })
}

test("Quest Entry and Daily Challenge catalogs cache by repository identity", () => {
    const first = repository(1)
    const second = repository(2)
    const firstEntry = getQuestEntryContentCatalog(first)
    const firstDaily = getDailyChallengeCatalog(first)

    assert.strictEqual(getQuestEntryContentCatalog(first), firstEntry)
    assert.strictEqual(getDailyChallengeCatalog(first), firstDaily)
    assert.notStrictEqual(getQuestEntryContentCatalog(second), firstEntry)
    assert.notStrictEqual(getDailyChallengeCatalog(second), firstDaily)
    assert.equal(firstEntry.entries["1_1001"].stamina, 1)
    assert.equal(getQuestEntryContentCatalog(second).entries["1_1001"].stamina, 2)
    assert.equal(Object.isFrozen(firstDaily.definitions[0]), true)
    assert.equal(Object.isFrozen(firstDaily.eventPointMap), true)
})

test("Quest Entry catalog rejects negative costs and free malformed unlocks", () => {
    assert.throws(
        () => getQuestEntryContentCatalog(repository(1, {
            "quest_entry_costs.json": {
                "1_1001": { itemId: -1, itemCount: -1, stamina: -10 },
            },
        })),
        /quest_entry_costs.*itemId.*non-negative/i,
    )
    assert.throws(
        () => getQuestEntryContentCatalog(repository(1, {
            "quest_unlock_costs.json": {
                "1001": { itemIds: [60000], itemCounts: [0] },
            },
        })),
        /itemCounts\[0\].*positive/i,
    )
    assert.throws(
        () => getQuestEntryContentCatalog(repository(1, {
            "quest_unlock_costs.json": {
                "1001": { itemIds: [60000, 60001], itemCounts: [1] },
            },
        })),
        /equal non-zero length/i,
    )
})

test("Daily Challenge catalog rejects malformed values and dangling event references", () => {
    assert.throws(
        () => getDailyChallengeCatalog(repository(1, {
            "daily_challenge_point_lookup.json": {
                "1": { maxPoint: -5, isRecovery: "yes", name: "challenge" },
            },
        })),
        /maxPoint.*non-negative/i,
    )
    assert.throws(
        () => getDailyChallengeCatalog(repository(1, {
            "daily_challenge_point_lookup.json": {
                "1": { maxPoint: 1, isRecovery: "yes", name: "challenge" },
            },
        })),
        /isRecovery.*boolean/i,
    )
    assert.throws(
        () => getDailyChallengeCatalog(repository(1, {
            "event_challenge_point_map.json": { "expert_1": 2 },
        })),
        /references missing point 2/i,
    )
})
