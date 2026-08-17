"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
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
const {
    saturatingAddNonNegativeSafeIntegers,
} = require("../src/lib/quest/finish/powerflip-tracker")
const {
    trackLeaderPowerflip,
} = require("../src/lib/quest/finish/leader-powerflip-tracker")

const INT32_MAX = 2_147_483_647

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

test("powerflip tracker saturates safe totals and normalizes invalid existing values", () => {
    assert.equal(typeof saturatingAddNonNegativeSafeIntegers, "function")
    assert.equal(saturatingAddNonNegativeSafeIntegers(10, 5), 15)
    assert.equal(
        saturatingAddNonNegativeSafeIntegers(Number.MAX_SAFE_INTEGER - 1, 2),
        Number.MAX_SAFE_INTEGER,
    )
    for (const existing of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.equal(saturatingAddNonNegativeSafeIntegers(existing, 3), 3)
    }
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
                messagePattern: /^Invalid request body\.$/,
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

test("single finish rejects malformed request results before writing", async t => {
    await withSingleBattleHarness("finish-request-validation", async harness => {
        const validStatistics = harness.finishPayload().statistics
        const withoutStatistic = field => {
            const statistics = { ...validStatistics }
            delete statistics[field]
            return statistics
        }
        const malformedCases = [
            ["statistics null", { statistics: null }],
            ["party missing", { statistics: { clear_phase: 1 } }],
            ["clear phase missing", { statistics: withoutStatistic("clear_phase") }],
            ["zones missing", { statistics: withoutStatistic("zones") }],
            ["zones null member", {
                statistics: { ...validStatistics, zones: [null] },
            }],
            ["characters non-array", {
                statistics: {
                    ...validStatistics,
                    party: { ...validStatistics.party, characters: {} },
                },
            }],
            ["character id invalid", {
                statistics: {
                    ...validStatistics,
                    party: { ...validStatistics.party, characters: [{ id: 0 }, null, null] },
                },
            }],
            ["characters without a positive id", {
                statistics: {
                    ...validStatistics,
                    party: { ...validStatistics.party, characters: [null] },
                },
            }],
            ["power flip count invalid", {
                statistics: {
                    ...validStatistics,
                    zones: [{ ...validStatistics.zones[0], use_power_flip_count: Infinity }],
                },
            }],
            ["max combo count invalid", {
                statistics: { ...validStatistics, max_combo_count: Infinity },
            }],
            ["power flip aggregate exceeds int32", {
                statistics: {
                    ...validStatistics,
                    zones: [
                        { ...validStatistics.zones[0], use_power_flip_count: INT32_MAX },
                        { use_power_flip_count: 1 },
                    ],
                },
            }],
            ["elapsed time invalid", { elapsed_time_ms: 0 }],
            ["add mana invalid", { add_mana: -1 }],
            ["score invalid", { score: -1 }],
            ["equipment element invalid", { equipment_element: [-1] }],
        ]

        for (const [name, payloadOverrides] of malformedCases) {
            await t.test(name, () => assertRejectedWithoutWrites(harness, {
                name: `request-${name.replaceAll(" ", "-")}`,
                payloadOverrides,
                messagePattern: /^Invalid request body\.$/,
            }))
        }
    })
})

test("single finish powerflip tracker saturates database totals", async () => {
    await withSingleBattleHarness("finish-powerflip-saturation", async harness => {
        const playId = "gate-task-21a-powerflip-saturation"
        harness.db.prepare(`
            UPDATE players SET total_powerflips = ?, total_dashes = ? WHERE id = ?
        `).run(Number.MAX_SAFE_INTEGER - 1, 1.5, harness.playerId)
        harness.insertActiveQuest(harness.createActiveQuest({ playId }))
        const payload = harness.finishPayload({ playId })
        payload.statistics.zones = [{
            ...payload.statistics.zones[0],
            use_power_flip_count: 2,
            use_dash_count: 3,
        }]

        const measured = await measureFinish(harness, payload)
        const totals = harness.db.prepare(`
            SELECT total_powerflips AS powerflips, total_dashes AS dashes
            FROM players WHERE id = ?
        `).get(harness.playerId)

        assert.equal(measured.value.statusCode, 200)
        assert.deepEqual(totals, {
            powerflips: Number.MAX_SAFE_INTEGER,
            dashes: 3,
        })
    })
})

test("single finish leader powerflip counter saturates through the real route", async () => {
    await withSingleBattleHarness("finish-leader-powerflip-saturation", async harness => {
        const playId = "gate-task-21a-leader-powerflip-saturation"
        const payload = harness.finishPayload({ playId })
        const leaderId = payload.statistics.party.characters[0].id
        harness.db.prepare(`
            INSERT INTO players_character_quest_clears (
                player_id, character_id, clear_count, multi_count,
                leader_clear_count, leader_multi_count, leader_power_flip_count
            ) VALUES (?, ?, 0, 0, 0, 0, ?)
        `).run(harness.playerId, leaderId, Number.MAX_SAFE_INTEGER - 1)
        harness.insertActiveQuest(harness.createActiveQuest({ playId }))
        payload.statistics.zones = [{
            ...payload.statistics.zones[0],
            use_power_flip_count: 2,
        }]

        const measured = await measureFinish(harness, payload)
        const counter = harness.db.prepare(`
            SELECT leader_power_flip_count AS value
            FROM players_character_quest_clears
            WHERE player_id = ? AND character_id = ?
        `).get(harness.playerId, leaderId).value

        assert.equal(measured.value.statusCode, 200)
        assert.equal(counter, Number.MAX_SAFE_INTEGER)
        assert.equal(Number.isSafeInteger(counter), true)
    })
})

test("leader powerflip tracker preserves insert and safe update semantics", async t => {
    await withSingleBattleHarness("leader-powerflip-upsert", async harness => {
        const payload = harness.finishPayload()
        const leaderId = payload.statistics.party.characters[0].id
        const context = {
            playerId: harness.playerId,
            party: payload.statistics.party,
            statistics: payload.statistics,
        }
        for (const [name, existing, expected] of [
            ["insert", null, 2],
            ["normal update", 7, 9],
            ["negative recovery", -5, 2],
        ]) {
            await t.test(name, () => {
                harness.db.prepare(`
                    DELETE FROM players_character_quest_clears
                    WHERE player_id = ? AND character_id = ?
                `).run(harness.playerId, leaderId)
                if (existing !== null) {
                    harness.db.prepare(`
                        INSERT INTO players_character_quest_clears (
                            player_id, character_id, clear_count, multi_count,
                            leader_clear_count, leader_multi_count, leader_power_flip_count
                        ) VALUES (?, ?, 0, 0, 0, 0, ?)
                    `).run(harness.playerId, leaderId, existing)
                }
                trackLeaderPowerflip({
                    ...context,
                    statistics: { ...context.statistics, zones: [{ use_power_flip_count: 2 }] },
                })
                const counter = harness.db.prepare(`
                    SELECT leader_power_flip_count AS value
                    FROM players_character_quest_clears
                    WHERE player_id = ? AND character_id = ?
                `).get(harness.playerId, leaderId).value
                assert.equal(counter, expected)
            })
        }
    })
})

test("single finish accepts unknown result extensions", async () => {
    await withSingleBattleHarness("finish-request-extensions", async harness => {
        const playId = "gate-task-21a-extensions"
        harness.insertActiveQuest(harness.createActiveQuest({ playId }))
        const payload = harness.finishPayload({ playId })
        payload.statistics.future_statistics_field = { accepted: true }
        payload.statistics.zones.push({ future_zone_field: ["accepted"] })
        payload.sub_statistics = { future_payload: true }
        payload.equipment_element = [0, 1]

        const measured = await measureFinish(harness, payload)

        assert.equal(measured.value.statusCode, 200)
    })
})

test("single finish route validates before identity and party access", () => {
    const routePath = path.join(__dirname, "../src/routes/api/singleBattleQuest.ts")
    const source = fs.readFileSync(routePath, "utf8")
    const finishStart = source.indexOf('fastify.post("/finish"')
    const finishEnd = source.indexOf('fastify.post("/abort"', finishStart)
    const finishSource = source.slice(finishStart, finishEnd)
    const validationCall = finishSource.indexOf("validateSingleFinishRequest(request.body)")
    const validatedBody = finishSource.indexOf("const body = validationResult.body")
    const identityGate = finishSource.indexOf("validateSessionAndPlayer")
    const orchestratorCall = finishSource.indexOf("settleSingleBattleQuest({")

    assert.ok(validationCall >= 0, "finish must call the pure request validator")
    assert.ok(validatedBody > validationCall, "finish must use the validated body")
    assert.ok(identityGate > validatedBody, "request validation must precede the identity gate")
    assert.ok(orchestratorCall > identityGate, "orchestrator must follow validation and identity")
    assert.doesNotMatch(finishSource, /body\.statistics\.party/)
    assert.doesNotMatch(finishSource, /party:\s*body\.statistics\.party\s+as\s+any/)
    assert.doesNotMatch(finishSource, /statistics:\s*\(body\s+as\s+any\)\.statistics/)
})
