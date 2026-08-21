#!/usr/bin/env node
"use strict"

const fs = require("node:fs")
const path = require("node:path")

const SNAPSHOT_PATH = path.join(
    __dirname,
    "__snapshots__",
    "multi_settlement_baseline.json",
)

const SQL_COUNT_FIELDS = Object.freeze([
    "selectStatements",
    "statements",
    "transactionStatements",
    "writeStatements",
])

function nonNegativeSafeInteger(value, field) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${field} must be a non-negative safe integer`)
    }
    return value
}

function nonNegativeFinite(value, field) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new TypeError(`${field} must be a non-negative finite number`)
    }
    return value
}

function normalizeTableStats(byTable, scenarioName) {
    if (!byTable || typeof byTable !== "object" || Array.isArray(byTable)) {
        throw new TypeError(`${scenarioName}.sql.byTable must be an object`)
    }
    return Object.fromEntries(Object.keys(byTable).sort().map(table => {
        const counts = byTable[table]
        return [table, Object.freeze({
            reads: nonNegativeSafeInteger(counts?.reads, `${table}.reads`),
            statements: nonNegativeSafeInteger(counts?.statements, `${table}.statements`),
            writes: nonNegativeSafeInteger(counts?.writes, `${table}.writes`),
        })]
    }))
}

function normalizeScenario(name, scenario) {
    if (!scenario || typeof scenario !== "object") throw new TypeError(`${name} must be an object`)
    if (scenario.activeQuestCleared !== true) {
        throw new TypeError(`${name}.activeQuestCleared must be true`)
    }
    if (scenario.verificationBeforeTransaction !== true) {
        throw new TypeError(`${name}.verificationBeforeTransaction must be true`)
    }
    if (typeof scenario.outputSignature !== "string"
        || !/^sha256:[a-f0-9]{64}$/.test(scenario.outputSignature)) {
        throw new TypeError(`${name}.outputSignature must be a sha256 digest`)
    }
    const sql = {}
    for (const field of SQL_COUNT_FIELDS) {
        sql[field] = nonNegativeSafeInteger(scenario.sql?.[field], `${name}.sql.${field}`)
    }
    if (sql.statements !== sql.selectStatements + sql.writeStatements + sql.transactionStatements) {
        throw new TypeError(`${name}.sql statement totals do not balance`)
    }
    sql.byTable = normalizeTableStats(scenario.sql?.byTable, name)
    return Object.freeze({
        activeQuestCleared: true,
        observations: Object.freeze({
            eventLoopDelayMs: nonNegativeFinite(
                scenario.observations?.eventLoopDelayMs ?? scenario.eventLoopDelayMs,
                "eventLoopDelayMs",
            ),
            latencyMs: nonNegativeFinite(
                scenario.observations?.latencyMs ?? scenario.latencyMs,
                "latencyMs",
            ),
        }),
        outputSignature: scenario.outputSignature,
        sql: Object.freeze(sql),
        statusCode: nonNegativeSafeInteger(scenario.statusCode, `${name}.statusCode`),
        verificationBeforeTransaction: true,
    })
}

function createMultiSettlementReport(scenarios) {
    if (!scenarios || typeof scenarios !== "object" || Array.isArray(scenarios)) {
        throw new TypeError("scenarios must be an object")
    }
    const normalized = {}
    for (const name of Object.keys(scenarios).sort()) {
        normalized[name] = normalizeScenario(name, scenarios[name])
    }
    return Object.freeze({ schemaVersion: 1, scenarios: Object.freeze(normalized) })
}

function readSnapshot(snapshotPath = SNAPSHOT_PATH) {
    return JSON.parse(fs.readFileSync(snapshotPath, "utf8"))
}

function admitMultiSettlementReport(report, {
    snapshot = readSnapshot(),
} = {}) {
    const current = createMultiSettlementReport(report?.scenarios)
    const expected = createMultiSettlementReport(snapshot?.scenarios)
    const failures = []
    const currentNames = Object.keys(current.scenarios)
    const expectedNames = Object.keys(expected.scenarios)
    if (JSON.stringify(currentNames) !== JSON.stringify(expectedNames)) {
        failures.push(`scenario set changed: expected=${expectedNames.join(",")} actual=${currentNames.join(",")}`)
    }
    for (const name of expectedNames) {
        const actualScenario = current.scenarios[name]
        const expectedScenario = expected.scenarios[name]
        if (!actualScenario) continue
        for (const field of [
            "activeQuestCleared",
            "outputSignature",
            "statusCode",
            "verificationBeforeTransaction",
        ]) {
            if (actualScenario[field] !== expectedScenario[field]) {
                failures.push(`${name}.${field} changed`)
            }
        }
        for (const field of SQL_COUNT_FIELDS) {
            if (actualScenario.sql[field] > expectedScenario.sql[field]) {
                failures.push(
                    `${name}.sql.${field} regressed: expected<=${expectedScenario.sql[field]} actual=${actualScenario.sql[field]}`,
                )
            }
        }
        const actualTables = Object.keys(actualScenario.sql.byTable)
        const expectedTables = Object.keys(expectedScenario.sql.byTable)
        const unexpectedTables = actualTables.filter(table => !expectedTables.includes(table))
        if (unexpectedTables.length > 0) {
            failures.push(
                `${name}.sql.byTable added: ${unexpectedTables.join(",")}`,
            )
        }
        for (const [table, expectedCounts] of Object.entries(expectedScenario.sql.byTable)) {
            const actualCounts = actualScenario.sql.byTable[table]
            if (!actualCounts) continue
            for (const field of ["reads", "statements", "writes"]) {
                if (actualCounts[field] > expectedCounts[field]) {
                    failures.push(
                        `${name}.sql.byTable.${table}.${field} regressed: expected<=${expectedCounts[field]} actual=${actualCounts[field]}`,
                    )
                }
            }
        }
    }
    return Object.freeze({ admitted: failures.length === 0, failures: Object.freeze(failures) })
}

async function runMultiSettlementBaseline({
    scenarioLoader = () => require("./multi_settlement_scenarios.cjs").SCENARIOS,
} = {}) {
    const results = {}
    for (const scenario of scenarioLoader()) {
        if (!scenario || typeof scenario.name !== "string" || scenario.name.length === 0) {
            throw new TypeError("multiplayer settlement scenario requires a name")
        }
        if (Object.hasOwn(results, scenario.name)) {
            throw new Error(`duplicate multiplayer settlement scenario ${scenario.name}`)
        }
        results[scenario.name] = await scenario.run()
    }
    return createMultiSettlementReport(results)
}

async function main() {
    const report = await runMultiSettlementBaseline()
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`${error.stack ?? error}\n`)
        process.exitCode = 1
    })
}

module.exports = {
    SNAPSHOT_PATH,
    admitMultiSettlementReport,
    createMultiSettlementReport,
    readSnapshot,
    runMultiSettlementBaseline,
}
