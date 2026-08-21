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
    const fixture = createHardMultiEventQuestFixture()

    assert.equal(fixture["2001"].commonRewardCounts, undefined)
    assert.deepEqual(fixture["2001"].scoreRewardGroupId, bundled["2001"].scoreRewardGroupId)
    assert.deepEqual(fixture["2001"].name, bundled["2001"].name)
    assert.deepEqual(fixture["1002001"], bundled["1002001"])
    assert.notEqual(fixture, bundled)
})

test("protocol signature preserves dynamic time fields while normalizing their values", () => {
    const response = {
        body: {
            data: {
                exp_pooled_time: 1_723_636_800,
                nested: {
                    start_date: "2024-08-14",
                    update_timestamp: 1_723_636_800_000,
                },
                stamina_heal_time: 1_723_636_800,
            },
            data_headers: { result_code: 0, servertime: 1_723_636_800 },
        },
        contentType: "application/x-msgpack",
    }
    const later = structuredClone(response)
    later.body.data.exp_pooled_time += 3_600
    later.body.data.nested.start_date = "2024-08-15"
    later.body.data.nested.update_timestamp += 3_600_000
    later.body.data.stamina_heal_time += 3_600
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
