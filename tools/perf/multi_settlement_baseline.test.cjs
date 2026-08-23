"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

const {
    admitMultiSettlementReport,
    createMultiSettlementReport,
    runMultiSettlementBaseline,
} = require("./multi_settlement_baseline.cjs")
require("ts-node/register/transpile-only")
const settlementOrchestrator = require("../../src/multi/settlement/orchestrator")
const settlementResponse = require("../../src/multi/settlement/response")
const {
    createHardMultiEventQuestFixture,
    createSettlementProtocolSignature,
} = require("./multi_settlement_scenarios.cjs")

test("settlement baseline targets the focused production module boundary", () => {
    assert.equal(typeof settlementOrchestrator.prepareMultiplayerSettlement, "function")
    assert.equal(typeof settlementOrchestrator.runMultiplayerSettlementOrchestration, "function")
    assert.equal(typeof settlementResponse.projectMultiplayerFinishResponse, "function")
})

test("settlement fixture removes only quest 2001 common reward counts", () => {
    const bundled = require("../../assets/hard_multi_event_quest.json")
    const bundledBefore = structuredClone(bundled)
    const bundledQuest = bundled["2001"]
    const bundledQuestBefore = structuredClone(bundledQuest)
    const expected = structuredClone(bundled)
    delete expected["2001"].commonRewardCounts

    const fixture = createHardMultiEventQuestFixture()

    assert.deepEqual(fixture, expected)
    assert.deepEqual(bundled, bundledBefore)
    assert.deepEqual(bundled["2001"], bundledQuestBefore)
    assert.strictEqual(require("../../assets/hard_multi_event_quest.json"), bundled)
    assert.strictEqual(bundled["2001"], bundledQuest)
    assert.notEqual(fixture, bundled)
})

test("protocol signature normalizes the settlement wall-clock fields", () => {
    const response = {
        body: {
            data: {
                character_list: [{
                    create_time: "2024-08-14 12:00:00",
                    join_time: "2024-08-14 12:00:00",
                    update_time: "2024-08-14 12:00:00",
                }],
                exp_pooled_time: 1_723_636_800,
                stamina_heal_time: 1_723_636_800,
                start_time: 1_723_636_800,
            },
            data_headers: { result_code: 0, servertime: 1_723_636_800 },
        },
        contentType: "application/x-msgpack",
    }
    const later = structuredClone(response)
    later.body.data.character_list[0].create_time = "2024-08-14 13:00:00"
    later.body.data.character_list[0].join_time = "2024-08-14 13:00:00"
    later.body.data.character_list[0].update_time = "2024-08-14 13:00:00"
    later.body.data.exp_pooled_time += 3_600
    later.body.data.stamina_heal_time += 3_600
    later.body.data.start_time += 3_600
    later.body.data_headers.servertime += 3_600

    assert.equal(
        createSettlementProtocolSignature(later),
        createSettlementProtocolSignature(response),
    )

    const missingField = structuredClone(response)
    delete missingField.body.data.stamina_heal_time
    assert.notEqual(
        createSettlementProtocolSignature(missingField),
        createSettlementProtocolSignature(response),
    )
})

test("protocol signature preserves battle timing and non-whitelisted time-like fields", () => {
    const response = {
        body: {
            data: {
                best_elapsed_time_ms: 1_000,
                clear_time: 1_000,
                elapsed_time_ms: 1_000,
                start_date: "2024-08-14",
                time_bonus: 5_000,
                update_timestamp: 1_723_636_800_000,
            },
            data_headers: { result_code: 0 },
        },
        contentType: "application/x-msgpack",
    }

    for (const [field, value] of Object.entries(response.body.data)) {
        const changed = structuredClone(response)
        changed.body.data[field] = typeof value === "number" ? value + 1 : `${value}-changed`
        assert.notEqual(
            createSettlementProtocolSignature(changed),
            createSettlementProtocolSignature(response),
            `${field} must remain part of the protocol signature`,
        )
    }
})

test("protocol signature covers the response envelope and content type", () => {
    const response = {
        body: {
            data: { rewards: [] },
            data_headers: { result_code: 0 },
        },
        contentType: "application/x-msgpack",
    }
    const changedHeaders = structuredClone(response)
    changedHeaders.body.data_headers.result_code = 1
    const changedContentType = {
        ...structuredClone(response),
        contentType: "application/json",
    }

    assert.notEqual(
        createSettlementProtocolSignature(changedHeaders),
        createSettlementProtocolSignature(response),
    )
    assert.notEqual(
        createSettlementProtocolSignature(changedContentType),
        createSettlementProtocolSignature(response),
    )
})

test("normalizes a deterministic multiplayer settlement report", () => {
    assert.deepEqual(createMultiSettlementReport({
        finish: {
            activeQuestCleared: true,
            eventLoopDelayMs: 0.5,
            latencyMs: 12.5,
            outputSignature: `sha256:${"a".repeat(64)}`,
            sql: {
                byTable: { players: { reads: 1, statements: 2, writes: 1 } },
                selectStatements: 1,
                statements: 4,
                transactionStatements: 2,
                writeStatements: 1,
            },
            statusCode: 200,
            verificationBeforeTransaction: true,
        },
    }), {
        schemaVersion: 1,
        scenarios: {
            finish: {
                activeQuestCleared: true,
                observations: { eventLoopDelayMs: 0.5, latencyMs: 12.5 },
                outputSignature: `sha256:${"a".repeat(64)}`,
                sql: {
                    byTable: { players: { reads: 1, statements: 2, writes: 1 } },
                    selectStatements: 1,
                    statements: 4,
                    transactionStatements: 2,
                    writeStatements: 1,
                },
                statusCode: 200,
                verificationBeforeTransaction: true,
            },
        },
    })
})

test("runs production multiplayer finish with SQL and ordering observations", async () => {
    const report = await runMultiSettlementBaseline()
    const finish = report.scenarios.finish

    assert.equal(finish.statusCode, 200)
    assert.equal(finish.activeQuestCleared, true)
    assert.equal(finish.verificationBeforeTransaction, true)
    assert.match(finish.outputSignature, /^sha256:[a-f0-9]{64}$/)
    assert.ok(finish.sql.selectStatements > 0)
    assert.ok(finish.sql.writeStatements > 0)
    assert.ok(finish.sql.transactionStatements >= 2)
    assert.ok(finish.sql.statements
        === finish.sql.selectStatements + finish.sql.writeStatements + finish.sql.transactionStatements)
    assert.ok(finish.observations.latencyMs >= 0)
    assert.ok(finish.observations.eventLoopDelayMs >= 0)
})

test("deletes the persisted active quest exactly once before Awake publication", async () => {
    const scenario = require("./multi_settlement_scenarios.cjs").SCENARIOS
        .find(entry => entry.name === "finish")
    const result = await scenario.run()
    const trace = result.sqlTrace
    const deleteIndexes = trace
        .map((sql, index) => /^DELETE FROM players_active_quests\b/i.test(sql.trim()) ? index : -1)
        .filter(index => index >= 0)
    const publicationIndex = trace.findIndex(sql => /\bplayers_character_awake_unlocks\b/i.test(sql))
    assert.deepEqual(deleteIndexes.length, 1, trace.join("\n"))
    assert.ok(publicationIndex >= 0, trace.join("\n"))
    assert.ok(deleteIndexes[0] < publicationIndex, trace.join("\n"))
})

test("production settlement baseline is deterministic across consecutive runs", async () => {
    const first = await runMultiSettlementBaseline()
    const second = await runMultiSettlementBaseline()

    assert.equal(
        second.scenarios.finish.outputSignature,
        first.scenarios.finish.outputSignature,
    )
    assert.deepEqual(second.scenarios.finish.sql, first.scenarios.finish.sql)
})

test("admits stable settlement structure without comparing wall-clock observations", async () => {
    const current = await runMultiSettlementBaseline()
    assert.deepEqual(admitMultiSettlementReport(current), {
        admitted: true,
        failures: [],
    })

    const snapshot = structuredClone(current)
    snapshot.scenarios.finish.observations = {
        eventLoopDelayMs: current.scenarios.finish.observations.eventLoopDelayMs + 10_000,
        latencyMs: current.scenarios.finish.observations.latencyMs + 10_000,
    }

    assert.deepEqual(admitMultiSettlementReport(current, { snapshot }), {
        admitted: true,
        failures: [],
    })

    const changedOutput = structuredClone(snapshot)
    changedOutput.scenarios.finish.outputSignature = `sha256:${"0".repeat(64)}`
    assert.equal(admitMultiSettlementReport(current, { snapshot: changedOutput }).admitted, false)

    const regressedSql = structuredClone(snapshot)
    regressedSql.scenarios.finish.sql.selectStatements--
    regressedSql.scenarios.finish.sql.statements--
    assert.equal(admitMultiSettlementReport(current, { snapshot: regressedSql }).admitted, false)

    const unexpectedTable = structuredClone(current)
    unexpectedTable.scenarios.finish.sql.byTable.unexpected_table = {
        reads: 1,
        statements: 1,
        writes: 0,
    }
    assert.equal(admitMultiSettlementReport(unexpectedTable, { snapshot }).admitted, false)
})

test("admits SQL optimizations that eliminate an expected table", () => {
    const snapshot = createMultiSettlementReport({
        finish: {
            activeQuestCleared: true,
            eventLoopDelayMs: 1,
            latencyMs: 1,
            outputSignature: `sha256:${"a".repeat(64)}`,
            sql: {
                byTable: {
                    players: { reads: 1, statements: 1, writes: 0 },
                    players_equipment: { reads: 1, statements: 1, writes: 0 },
                },
                selectStatements: 2,
                statements: 2,
                transactionStatements: 0,
                writeStatements: 0,
            },
            statusCode: 200,
            verificationBeforeTransaction: true,
        },
    })
    const current = structuredClone(snapshot)
    delete current.scenarios.finish.sql.byTable.players_equipment
    current.scenarios.finish.sql.selectStatements--
    current.scenarios.finish.sql.statements--

    assert.deepEqual(admitMultiSettlementReport(current, { snapshot }), {
        admitted: true,
        failures: [],
    })
})

test("rejects malformed settlement metrics", () => {
    assert.throws(() => createMultiSettlementReport({
        finish: {
            activeQuestCleared: true,
            eventLoopDelayMs: -1,
            latencyMs: 1,
            outputSignature: `sha256:${"a".repeat(64)}`,
            sql: {
                byTable: {},
                selectStatements: 0,
                statements: 0,
                transactionStatements: 0,
                writeStatements: 0,
            },
            statusCode: 200,
            verificationBeforeTransaction: true,
        },
    }), /eventLoopDelayMs must be a non-negative finite number/)
})
