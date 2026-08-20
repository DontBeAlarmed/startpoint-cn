#!/usr/bin/env node
"use strict"

const fs = require("node:fs")
const path = require("node:path")

const SNAPSHOT_PATH = path.join(
    __dirname,
    "__snapshots__",
    "multi_snapshot_baseline.json",
)

const CALL_FIELDS = Object.freeze([
    "character",
    "equipment",
    "manaNode",
    "partyGroup",
    "playerContext",
])

function nonNegativeSafeInteger(value, field) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${field} must be a non-negative safe integer`)
    }
    return value
}

function normalizeScenario(name, scenario) {
    if (!scenario || typeof scenario !== "object") {
        throw new TypeError(`${name} must be an object`)
    }
    if (typeof scenario.outputSignature !== "string" || scenario.outputSignature.length === 0) {
        throw new TypeError(`${name}.outputSignature must be a non-empty string`)
    }
    const calls = {}
    let total = 0
    for (const field of CALL_FIELDS) {
        const value = nonNegativeSafeInteger(scenario.calls?.[field], field)
        calls[field] = value
        total += value
    }
    calls.total = nonNegativeSafeInteger(total, "total")
    return Object.freeze({
        calls: Object.freeze(calls),
        outputSignature: scenario.outputSignature,
        sqlSelectStatements: nonNegativeSafeInteger(
            scenario.sqlSelectStatements,
            `${name}.sqlSelectStatements`,
        ),
    })
}

function createMultiSnapshotReport(scenarios) {
    if (!scenarios || typeof scenarios !== "object" || Array.isArray(scenarios)) {
        throw new TypeError("scenarios must be an object")
    }
    const normalized = {}
    for (const name of Object.keys(scenarios).sort()) {
        if (name.length === 0) throw new TypeError("scenario name must not be empty")
        normalized[name] = normalizeScenario(name, scenarios[name])
    }
    return Object.freeze({
        schemaVersion: 1,
        scenarios: Object.freeze(normalized),
    })
}

function readSnapshot(snapshotPath = SNAPSHOT_PATH) {
    return JSON.parse(fs.readFileSync(snapshotPath, "utf8"))
}

function admitMultiSnapshotReport(report, {
    snapshot = readSnapshot(),
} = {}) {
    const current = createMultiSnapshotReport(report?.scenarios)
    const expected = createMultiSnapshotReport(snapshot?.scenarios)
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
        if (actualScenario.outputSignature !== expectedScenario.outputSignature) {
            failures.push(`${name} output signature changed`)
        }
        if (actualScenario.sqlSelectStatements > expectedScenario.sqlSelectStatements) {
            failures.push(
                `${name}.sqlSelectStatements regressed: expected<=${expectedScenario.sqlSelectStatements} actual=${actualScenario.sqlSelectStatements}`,
            )
        }
        for (const field of CALL_FIELDS) {
            if (actualScenario.calls[field] > expectedScenario.calls[field]) {
                failures.push(
                    `${name}.${field} regressed: expected<=${expectedScenario.calls[field]} actual=${actualScenario.calls[field]}`,
                )
            }
        }
    }
    return Object.freeze({ admitted: failures.length === 0, failures: Object.freeze(failures) })
}

async function runMultiSnapshotBaseline({
    scenarioLoader = () => require("./multi_snapshot_scenarios.cjs").SCENARIOS,
} = {}) {
    const results = {}
    for (const scenario of scenarioLoader()) {
        if (!scenario || typeof scenario.name !== "string" || scenario.name.length === 0) {
            throw new TypeError("multiplayer snapshot scenario requires a name")
        }
        if (Object.hasOwn(results, scenario.name)) {
            throw new Error(`duplicate multiplayer snapshot scenario ${scenario.name}`)
        }
        if (typeof scenario.run !== "function") {
            throw new TypeError(`multiplayer snapshot scenario ${scenario.name} requires run()`)
        }
        results[scenario.name] = await scenario.run()
    }
    return createMultiSnapshotReport(results)
}

async function main() {
    const report = await runMultiSnapshotBaseline()
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
    admitMultiSnapshotReport,
    createMultiSnapshotReport,
    readSnapshot,
    runMultiSnapshotBaseline,
}
