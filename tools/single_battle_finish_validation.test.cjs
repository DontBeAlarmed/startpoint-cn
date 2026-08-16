"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

const {
    MAIN_CATEGORY,
    MAIN_QUEST_ID,
    withSingleBattleHarness,
} = require("./perf/single_battle_settlement_harness.cjs")
const {
    runSingleFinishSettlementTransaction,
    SingleFinishSettlementValidationError,
} = require("../src/lib/quest/single-finish-settlement")

function createHelperActiveQuest(overrides = {}) {
    return {
        questId: MAIN_QUEST_ID,
        category: MAIN_CATEGORY,
        useBossBoostPoint: false,
        useBoostPoint: false,
        isAutoStartMode: false,
        isMulti: false,
        coordinatorOrigin: null,
        playId: "gate-task-19-helper",
        continueCount: 0,
        ...overrides,
    }
}

function assertHelperRejected({
    memoryOverrides = {},
    storedOverrides = {},
    playerOverrides = {},
    messagePattern,
}) {
    const storedQuest = createHelperActiveQuest(storedOverrides)
    let settleCalls = 0
    assert.throws(() => runSingleFinishSettlementTransaction({
        playerId: 1,
        memoryQuest: createHelperActiveQuest(memoryOverrides),
        request: {
            playId: storedQuest.playId,
            questId: storedQuest.questId,
            category: storedQuest.category,
            continueCount: storedQuest.continueCount,
        },
        player: {
            boostPoint: 10,
            bossBoostPoint: 3,
            ...playerOverrides,
        },
        settle: () => { settleCalls++ },
        dependencies: {
            transaction: operation => operation(),
            getStoredActiveQuest: () => storedQuest,
        },
    }), error => (
        error instanceof SingleFinishSettlementValidationError
        && messagePattern.test(error.message)
    ))
    assert.equal(settleCalls, 0)
}

function readBoostBalances(harness) {
    return harness.db.prepare(`
        SELECT boost_point AS boostPoint, boss_boost_point AS bossBoostPoint
        FROM players WHERE id = ?
    `).get(harness.playerId)
}

function captureSettlementState(harness) {
    return {
        settlement: harness.snapshotState(),
        boostBalances: readBoostBalances(harness),
    }
}

function resetSettlement(harness) {
    harness.db.prepare("DELETE FROM players_active_quests WHERE player_id = ?")
        .run(harness.playerId)
    harness.clearActiveQuest()
    harness.updatePlayer({ boostPoint: 10, bossBoostPoint: 3 })
}

async function measureFinish(harness, payload) {
    const measured = await harness.measure(() => harness.post("finish", payload))
    if (measured.error) throw measured.error
    return measured
}

async function assertRejectedWithoutWrites(harness, {
    name,
    activeOverrides = {},
    memoryMutation,
    persistedMutation,
    payloadOverrides = {},
    playerOverrides,
    messagePattern = /active quest|settlement identity|boost points/i,
    expectPersistedActive = true,
}) {
    resetSettlement(harness)
    if (playerOverrides) harness.updatePlayer(playerOverrides)
    const playId = `gate-task-19-${name}`
    const activeQuest = {
        ...harness.createActiveQuest({ playId }),
        ...activeOverrides,
    }
    harness.insertActiveQuest(activeQuest)
    memoryMutation?.(activeQuest)
    persistedMutation?.(harness)
    const before = captureSettlementState(harness)
    const measured = await measureFinish(harness, {
        ...harness.finishPayload({ playId }),
        ...payloadOverrides,
    })
    const after = captureSettlementState(harness)

    assert.equal(measured.value.statusCode, 400)
    assert.match(measured.value.message, messagePattern)
    assert.equal(measured.sql.writeStatements, 0)
    assert.deepEqual(after, before)
    assert.equal(after.settlement.databaseActive !== null, expectPersistedActive)
    assert.notEqual(after.settlement.memoryActive, null)
}

async function assertSuccessfulBoostSettlement(harness, boost) {
    resetSettlement(harness)
    harness.updatePlayer(boost.playerOverrides)
    const playId = `gate-task-19-${boost.name}`
    harness.insertActiveQuest({
        ...harness.createActiveQuest({ playId }),
        ...boost.activeOverrides,
    })
    const before = captureSettlementState(harness)
    const measured = await measureFinish(harness, harness.finishPayload({ playId }))
    const after = captureSettlementState(harness)

    assert.equal(measured.value.statusCode, 200)
    assert.equal(before.boostBalances[boost.balanceField], 1)
    assert.equal(after.boostBalances[boost.balanceField], 0)
    assert.equal(measured.value.data.user_info[
        boost.balanceField === "boostPoint" ? "boost_point" : "boss_boost_point"
    ], 0)
    assert.equal(after.settlement.databaseActive, null)
    assert.equal(after.settlement.memoryActive, null)
    assert.ok(Object.keys(after.settlement.items).length > 0)
    assert.equal(measured.sql.byTable.players_active_quests.reads, 1)
}

test("single finish helper rejects invalid Boost balances", async t => {
    for (const field of ["boostPoint", "bossBoostPoint"]) {
        for (const [label, value] of [
            ["fraction", 1.5],
            ["infinity", Infinity],
            ["NaN", NaN],
            ["negative", -1],
            ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
        ]) {
            await t.test(`rejects ${field} ${label}`, () => assertHelperRejected({
                playerOverrides: { [field]: value },
                messagePattern: /invalid boost balance/i,
            }))
        }
    }
})

test("single finish helper rejects mutually enabled Boost flags", () => {
    assertHelperRejected({
        memoryOverrides: { useBoostPoint: true, useBossBoostPoint: true },
        storedOverrides: { useBoostPoint: true, useBossBoostPoint: true },
        messagePattern: /invalid boost state/i,
    })
})

test("single finish validates settlement authority before writing", async t => {
    await withSingleBattleHarness("finish-validation", async harness => {
        const rejectionCases = [
            {
                title: "rejects a mismatched play_id",
                name: "play-id-mismatch",
                payloadOverrides: { play_id: "different-play-id" },
            },
            ...[
                ["quest_id", MAIN_QUEST_ID + 1],
                ["category", MAIN_CATEGORY + 1],
            ].map(([field, value]) => ({
                title: `rejects a mismatched ${field}`,
                name: `${field}-mismatch`,
                payloadOverrides: { [field]: value },
            })),
            {
                title: "rejects a mismatched continue_count",
                name: "continue-count-mismatch",
                payloadOverrides: { continue_count: 1 },
            },
            ...[
                ["play_id", undefined],
                ["quest_id", String(MAIN_QUEST_ID)],
                ["category", 1.5],
                ["continue_count", -1],
            ].map(([field, value]) => ({
                title: `rejects an invalid ${field} type or range`,
                name: `${field}-invalid`,
                payloadOverrides: { [field]: value },
            })),
            {
                title: "rejects a persisted identity mismatch",
                name: "persisted-identity-mismatch",
                persistedMutation: current => current.db.prepare(`
                    UPDATE players_active_quests SET play_id = ? WHERE player_id = ?
                `).run("persisted-different-play-id", current.playerId),
            },
            {
                title: "rejects a memory-only identity mismatch",
                name: "memory-identity-mismatch",
                memoryMutation: activeQuest => {
                    activeQuest.playId = "memory-different-play-id"
                },
            },
            {
                title: "rejects a missing persisted active quest",
                name: "persisted-active-missing",
                persistedMutation: current => current.db.prepare(`
                    DELETE FROM players_active_quests WHERE player_id = ?
                `).run(current.playerId),
                expectPersistedActive: false,
            },
            {
                title: "rejects a memory multi active quest",
                name: "memory-multi",
                memoryMutation: activeQuest => {
                    activeQuest.isMulti = true
                },
            },
            {
                title: "rejects a persisted multi active quest",
                name: "persisted-multi",
                persistedMutation: current => current.db.prepare(`
                    UPDATE players_active_quests SET is_multi = 1 WHERE player_id = ?
                `).run(current.playerId),
            },
            {
                title: "rejects persisted and memory Boost flag mismatch",
                name: "persisted-boost-mismatch",
                persistedMutation: current => current.db.prepare(`
                    UPDATE players_active_quests SET use_boost_point = 1 WHERE player_id = ?
                `).run(current.playerId),
            },
            {
                title: "rejects normal Boost with zero balance",
                name: "normal-boost-empty",
                activeOverrides: { useBoostPoint: true },
                playerOverrides: { boostPoint: 0 },
                messagePattern: /not enough boost points/i,
            },
            {
                title: "rejects Boss Boost with zero balance",
                name: "boss-boost-empty",
                activeOverrides: { useBossBoostPoint: true },
                playerOverrides: { bossBoostPoint: 0 },
                messagePattern: /not enough boost points/i,
            },
            ...[
                ["fractional-normal-balance", { boostPoint: 1.5 }],
                ["infinite-normal-balance", { boostPoint: Infinity }],
                ["fractional-boss-balance", { bossBoostPoint: 1.5 }],
                ["infinite-boss-balance", { bossBoostPoint: Infinity }],
            ].map(([name, playerOverrides]) => ({
                title: `rejects ${name.replaceAll("-", " ")}`,
                name,
                playerOverrides,
                messagePattern: /invalid boost balance/i,
            })),
            {
                title: "rejects mutually enabled normal and Boss Boost",
                name: "boost-flags-mutually-enabled",
                activeOverrides: {
                    useBoostPoint: true,
                    useBossBoostPoint: true,
                },
                messagePattern: /invalid boost state/i,
            },
        ]

        for (const { title, ...scenario } of rejectionCases) {
            await t.test(title, () => assertRejectedWithoutWrites(harness, scenario))
        }

        for (const boost of [
            {
                name: "normal-boost-one",
                activeOverrides: { useBoostPoint: true },
                playerOverrides: { boostPoint: 1 },
                balanceField: "boostPoint",
            },
            {
                name: "boss-boost-one",
                activeOverrides: { useBossBoostPoint: true },
                playerOverrides: { bossBoostPoint: 1 },
                balanceField: "bossBoostPoint",
            },
        ]) {
            await t.test(`settles ${boost.name} and deducts exactly one`, () => (
                assertSuccessfulBoostSettlement(harness, boost)
            ))
        }

        await t.test("settles without Boost and reads DB authority", async () => {
            resetSettlement(harness)
            const playId = "gate-task-19-no-boost"
            harness.insertActiveQuest(harness.createActiveQuest({ playId }))
            const before = captureSettlementState(harness)
            const measured = await measureFinish(harness, harness.finishPayload({ playId }))
            const after = captureSettlementState(harness)

            assert.equal(measured.value.statusCode, 200)
            assert.deepEqual(after.boostBalances, before.boostBalances)
            assert.equal(after.settlement.databaseActive, null)
            assert.equal(after.settlement.memoryActive, null)
            assert.ok(after.settlement.player.freeMana > before.settlement.player.freeMana)
            assert.ok(Object.keys(after.settlement.items).length > 0)
            assert.equal(measured.sql.byTable.players_active_quests.reads, 1)
        })

        await t.test("settles with persisted non-identity active quest fields", async () => {
            resetSettlement(harness)
            const playId = "gate-task-19-persisted-fields"
            const memoryEntryItemId = 919_901
            const persistedEntryItemId = 919_902
            harness.insertActiveQuest({
                ...harness.createActiveQuest({ playId }),
                entryItemId: memoryEntryItemId,
            })
            harness.db.prepare(`
                UPDATE players_active_quests SET entry_item_id = ? WHERE player_id = ?
            `).run(persistedEntryItemId, harness.playerId)

            const measured = await measureFinish(harness, harness.finishPayload({ playId }))

            assert.equal(measured.value.statusCode, 200)
            assert.equal(measured.value.data.item_list[persistedEntryItemId], 0)
            assert.equal(Object.hasOwn(measured.value.data.item_list, memoryEntryItemId), false)
            assert.equal(measured.sql.byTable.players_active_quests.reads, 1)
        })
    })
})
