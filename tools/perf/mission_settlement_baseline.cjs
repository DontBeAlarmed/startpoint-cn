#!/usr/bin/env node
"use strict"

require("ts-node/register/transpile-only")

const crypto = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const BetterSqlite3 = require("better-sqlite3")

const { percentile } = require("./http_metrics.cjs")
const { createSqlCounter } = require("./mission_settlement_sql.cjs")

const FIXED_TIME = "2024-08-14T12:00:00.000Z"
const CATEGORIES = Object.freeze([1, 2, 3, 6, 7, 8, 10])
const DEFAULT_WARMUPS = 2
const DEFAULT_MEASUREMENTS = 5
let runtimeDependencies

function getRuntimeDependencies() {
    if (runtimeDependencies) return runtimeDependencies
    const originalLog = console.log
    try {
        console.log = () => {}
        const { closeDatabase, initializeDatabase } = require("../../src/data")
        const { resolveRuntimeDataPaths } = require("../../src/runtime/data-paths")
        const { settleMissionCategories } = require("../../src/lib/mission/settlement")
        const { SCENARIOS } = require("./mission_settlement_scenarios.cjs")
        runtimeDependencies = {
            closeDatabase,
            initializeDatabase,
            resolveRuntimeDataPaths,
            settleMissionCategories,
            SCENARIOS,
        }
        return runtimeDependencies
    } finally {
        console.log = originalLog
    }
}

function parseInteger(value, name, allowZero) {
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
        throw new Error(`${name} must be a ${allowZero ? "non-negative" : "positive"} integer`)
    }
    return parsed
}

function parseArgs(argv) {
    const parsed = {
        measurements: DEFAULT_MEASUREMENTS,
        output: null,
        warmups: DEFAULT_WARMUPS,
    }
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index]
        const value = argv[++index]
        if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`)
        if (argument === "--warmups") parsed.warmups = parseInteger(value, "warmups", true)
        else if (argument === "--measurements") {
            parsed.measurements = parseInteger(value, "measurements", false)
        } else if (argument === "--output") parsed.output = value
        else throw new Error(`unknown argument: ${argument}`)
    }
    return parsed
}

function createMissionDiagnostics() {
    const byCategory = Object.fromEntries(CATEGORIES.map(category => [String(category), {
        candidates: 0,
        computed: 0,
        progressChanged: 0,
        rewards: 0,
    }]))
    return {
        observer: {
            onCategoryCandidates(category, count) {
                byCategory[String(category)].candidates += count
            },
            onMissionComputed(category) {
                byCategory[String(category)].computed++
            },
            onMissionProgressChanged(category) {
                byCategory[String(category)].progressChanged++
            },
        },
        finish(missionInfo) {
            for (const reward of missionInfo) {
                byCategory[String(reward.mission_category_id)].rewards++
            }
            return {
                candidates: Object.values(byCategory)
                    .reduce((sum, category) => sum + category.candidates, 0),
                computed: Object.values(byCategory)
                    .reduce((sum, category) => sum + category.computed, 0),
                progressChanged: Object.values(byCategory)
                    .reduce((sum, category) => sum + category.progressChanged, 0),
                byCategory,
            }
        },
    }
}

function runOnce(scenario, suiteDirectory, fixedTime, runtime) {
    const runDirectory = fs.mkdtempSync(path.join(suiteDirectory, `${scenario.name}-`))
    const counter = createSqlCounter()
    try {
        const paths = runtime.resolveRuntimeDataPaths({ DATA_DIR: runDirectory })
        runtime.initializeDatabase({
            paths,
            databaseFactory: databasePath => new BetterSqlite3(databasePath, {
                verbose: sql => counter.observe(sql),
            }),
        })
        const playerId = scenario.create()
        counter.reset()

        const diagnostics = createMissionDiagnostics()
        const startedAt = performance.now()
        const result = runtime.settleMissionCategories(
            playerId,
            CATEGORIES,
            fixedTime,
            diagnostics.observer,
        )
        const durationMs = performance.now() - startedAt
        const missions = diagnostics.finish(result.missionInfo)
        return {
            durationMs,
            sql: counter.snapshot(),
            missions,
            rewards: result.missionInfo.length,
        }
    } finally {
        runtime.closeDatabase()
        fs.rmSync(runDirectory, { recursive: true, force: true })
    }
}

function structuralResult(sample) {
    return {
        sql: sample.sql,
        missions: sample.missions,
        rewards: sample.rewards,
    }
}

function assertStableSamples(name, samples) {
    const expected = JSON.stringify(structuralResult(samples[0]))
    for (const sample of samples.slice(1)) {
        if (JSON.stringify(structuralResult(sample)) !== expected) {
            throw new Error(`scenario ${name} produced non-deterministic structural metrics`)
        }
    }
}

function sortedObject(value) {
    if (Array.isArray(value)) return value.map(sortedObject)
    if (value === null || typeof value !== "object") return value
    return Object.fromEntries(Object.keys(value).sort()
        .map(key => [key, sortedObject(value[key])]))
}

function createStableSummary(report) {
    const data = sortedObject({
        version: report.version,
        fixedTime: report.fixedTime,
        categories: report.categories ?? CATEGORIES,
        warmups: report.warmups,
        measurements: report.measurements,
        scenarios: report.scenarios.map(scenario => ({
            name: scenario.name,
            sql: scenario.sql,
            missions: scenario.missions,
            rewards: scenario.rewards,
        })),
    })
    return sortedObject({
        sha256: crypto.createHash("sha256").update(JSON.stringify(data)).digest("hex"),
        fixedTime: data.fixedTime,
        categories: data.categories,
        warmups: data.warmups,
        measurements: data.measurements,
        scenarios: data.scenarios.map(scenario => ({
            name: scenario.name,
            sql: {
                total: scenario.sql.total,
                select: scenario.sql.select,
                writes: scenario.sql.writes,
                other: scenario.sql.other,
            },
            missions: {
                candidates: scenario.missions.candidates,
                computed: scenario.missions.computed,
                progressChanged: scenario.missions.progressChanged,
            },
            rewards: scenario.rewards,
        })),
    })
}

function runMissionSettlementBaseline({
    measurements = DEFAULT_MEASUREMENTS,
    temporaryParent = os.tmpdir(),
    warmups = DEFAULT_WARMUPS,
} = {}) {
    const normalizedWarmups = parseInteger(warmups, "warmups", true)
    const normalizedMeasurements = parseInteger(measurements, "measurements", false)
    const fixedTime = new Date(FIXED_TIME)
    const suiteDirectory = fs.mkdtempSync(path.join(temporaryParent, "mission-settlement-baseline-"))
    const runtime = getRuntimeDependencies()

    try {
        const scenarios = runtime.SCENARIOS.map(scenario => {
            for (let index = 0; index < normalizedWarmups; index++) {
                runOnce(scenario, suiteDirectory, fixedTime, runtime)
            }
            const samples = Array.from(
                { length: normalizedMeasurements },
                () => runOnce(scenario, suiteDirectory, fixedTime, runtime),
            )
            assertStableSamples(scenario.name, samples)
            const stable = structuralResult(samples[0])
            const durations = samples.map(sample => sample.durationMs)
            return {
                name: scenario.name,
                fixedTime: FIXED_TIME,
                warmups: normalizedWarmups,
                measurements: normalizedMeasurements,
                latencyMs: {
                    p50: percentile(durations, 0.5),
                    p95: percentile(durations, 0.95),
                },
                ...stable,
            }
        })
        const report = {
            version: 1,
            fixedTime: FIXED_TIME,
            categories: [...CATEGORIES],
            warmups: normalizedWarmups,
            measurements: normalizedMeasurements,
            scenarios,
        }
        return { ...report, stableSummary: createStableSummary(report) }
    } finally {
        fs.rmSync(suiteDirectory, { recursive: true, force: true })
    }
}

function writeReport(report, { output = null, stdout = value => process.stdout.write(value) } = {}) {
    const serialized = `${JSON.stringify(report, null, 2)}\n`
    if (output) fs.writeFileSync(output, serialized, "utf8")
    stdout(serialized)
}

function main() {
    const options = parseArgs(process.argv.slice(2))
    const report = runMissionSettlementBaseline(options)
    writeReport(report, options)
}

if (require.main === module) {
    try {
        main()
    } catch (error) {
        process.stderr.write(`${error.stack ?? error}\n`)
        process.exitCode = 1
    }
}

module.exports = {
    CATEGORIES,
    FIXED_TIME,
    createSqlCounter,
    createStableSummary,
    parseArgs,
    runMissionSettlementBaseline,
    writeReport,
}
