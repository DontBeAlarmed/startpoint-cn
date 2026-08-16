#!/usr/bin/env node
"use strict"

require("ts-node/register/transpile-only")

const { AsyncLocalStorage } = require("node:async_hooks")
const fs = require("node:fs")
const { monitorEventLoopDelay } = require("node:perf_hooks")
const os = require("node:os")
const path = require("node:path")
const BetterSqlite3 = require("better-sqlite3")

const {
    createAdmissionGate,
    parseArgs,
    runBounded,
    summarizeLatencies,
} = require("./mission_entry_load_metrics.cjs")
const {
    ENTRY_NAMES,
    behaviorSignature,
    createRouteApp,
    executeEntry,
    getRuntimeDependencies,
    seedPlayers,
} = require("./mission_entry_load_scenarios.cjs")
const { createSqlCounter } = require("./mission_settlement_sql.cjs")

const FIXED_TIME = "2024-08-14T12:00:00.000Z"
const FIXED_BASE_COMMIT = "f85a01c1eb730afa3ff9e6de00fd7b7a9d992c32"
const REFERENCE_PATH = path.join(
    __dirname,
    "__snapshots__",
    "mission_entry_layered_load_reference.json",
)

function round(value) {
    return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0
}

function delayMilliseconds(value) {
    return round(Number(value) / 1_000_000)
}

function stableSql(sql) {
    return {
        statements: sql.statements,
        selectStatements: sql.selectStatements,
        writeStatements: sql.writeStatements,
        transactionStatements: sql.transactionStatements,
    }
}

function installComputeCounter(runtime, storage) {
    const installed = []
    const computers = new Set()
    for (let category = 1; category <= 10; category++) computers.add(runtime.getComputer(category))
    for (const computer of computers) {
        const original = computer.compute
        const wrapper = function countedCompute(...args) {
            const request = storage.getStore()
            if (request) request.missionComputes++
            return original.apply(this, args)
        }
        computer.compute = wrapper
        installed.push({ computer, original, wrapper })
    }
    return () => {
        for (const { computer, original, wrapper } of installed.reverse()) {
            if (computer.compute === wrapper) computer.compute = original
        }
    }
}

function structuralEntry(results, entry) {
    const samples = results.filter(result => result.entry === entry)
    return {
        requests: samples.length,
        sqlReadsMax: Math.max(0, ...samples.map(sample => sample.sql.selectStatements)),
        sqlWritesMax: Math.max(0, ...samples.map(sample => sample.sql.writeStatements)),
        missionComputesMax: Math.max(0, ...samples.map(sample => sample.missionComputes)),
    }
}

function summarizeEntries(results, elapsedMs) {
    return Object.fromEntries(ENTRY_NAMES.map(entry => {
        const samples = results.filter(result => result.entry === entry)
        const errors = samples.filter(sample => sample.error !== null)
        const signatures = [...new Set(samples
            .map(sample => sample.behaviorSignature)
            .filter(Boolean))]
        return [entry, {
            boundary: samples[0]?.boundary ?? null,
            requests: samples.length,
            throughputPerSecond: round(samples.length / (elapsedMs / 1000)),
            latencyMs: summarizeLatencies(samples.map(sample => sample.durationMs)),
            errors: errors.length,
            errorRate: samples.length === 0 ? 0 : round(errors.length / samples.length),
            errorMessages: [...new Set(errors.map(sample => sample.error))],
            behaviorSignatures: signatures,
            structural: structuralEntry(results, entry),
        }]
    }))
}

function verifyTaskRollback(runtime, identity, fixedTime) {
    const db = runtime.getDb()
    const before = {
        pass: db.prepare(`
            SELECT event_id, point, is_buy, login_baseline
            FROM players_pass_cards WHERE player_id = ? ORDER BY event_id
        `).all(identity.playerId),
        mission: runtime.getPlayerCategoryMissionsSync(identity.playerId, 8),
    }
    const trigger = `mission_entry_load_rollback_${identity.playerId}`
    db.exec(`
        CREATE TRIGGER ${trigger}
        BEFORE INSERT ON players_category_missions
        WHEN NEW.player_id = ${identity.playerId} AND NEW.category = 8
        BEGIN
            SELECT RAISE(ABORT, 'injected layered load rollback');
        END;
    `)
    let error = null
    try {
        runtime.settleMissionCategories(identity.playerId, [{
            category: 8,
            eventId: 3,
            missionIds: [13],
        }], fixedTime)
    } catch (caught) {
        error = caught
    } finally {
        db.exec(`DROP TRIGGER ${trigger}`)
    }
    const after = {
        pass: db.prepare(`
            SELECT event_id, point, is_buy, login_baseline
            FROM players_pass_cards WHERE player_id = ? ORDER BY event_id
        `).all(identity.playerId),
        mission: runtime.getPlayerCategoryMissionsSync(identity.playerId, 8),
    }
    return {
        verified: error instanceof Error
            && /injected layered load rollback/.test(error.message)
            && JSON.stringify(after) === JSON.stringify(before),
        injectedError: error instanceof Error ? error.message : null,
    }
}

async function runStep({
    concurrency,
    fixedTime,
    players,
    runDirectory,
    runtime,
    seedDirectory,
}) {
    fs.cpSync(seedDirectory, runDirectory, { recursive: true })
    const storage = new AsyncLocalStorage()
    const sqlCounter = createSqlCounter()
    let measureSql = false
    let database = null
    let app = null
    let restoreComputes = null
    let primaryError = null
    let summary
    try {
        const paths = runtime.resolveRuntimeDataPaths({ DATA_DIR: runDirectory })
        database = runtime.initializeDatabase({
            paths,
            databaseFactory: databasePath => new BetterSqlite3(databasePath, {
                verbose(sql) {
                    if (!measureSql) return
                    sqlCounter.observe(sql)
                    storage.getStore()?.sql.observe(sql)
                },
            }),
        })
        app = await createRouteApp(runtime)
        restoreComputes = installComputeCounter(runtime, storage)
        const delay = monitorEventLoopDelay({ resolution: 10 })
        delay.enable()
        await new Promise(resolve => setImmediate(resolve))
        measureSql = true
        sqlCounter.reset()
        const startedAt = performance.now()
        const tasks = players.map(identity => async () => {
            const request = {
                missionComputes: 0,
                sql: createSqlCounter(),
            }
            return storage.run(request, async () => {
                const requestStartedAt = performance.now()
                let behavior = null
                let error = null
                try {
                    behavior = await executeEntry(runtime, app, identity, fixedTime)
                } catch (caught) {
                    error = caught
                }
                return {
                    entry: identity.entry,
                    boundary: behavior?.adapter ?? null,
                    durationMs: round(performance.now() - requestStartedAt),
                    sql: request.sql.snapshot(),
                    missionComputes: request.missionComputes,
                    behaviorSignature: behavior === null ? null : behaviorSignature(behavior),
                    error: error instanceof Error ? error.message : error === null ? null : String(error),
                }
            })
        })
        const results = await runBounded(tasks, concurrency)
        const elapsedMs = performance.now() - startedAt
        measureSql = false
        await new Promise(resolve => setImmediate(resolve))
        delay.disable()
        const rollback = verifyTaskRollback(runtime, players[0], fixedTime)
        summary = {
            concurrency,
            requests: players.length,
            elapsedMs: round(elapsedMs),
            throughputPerSecond: round(players.length / (elapsedMs / 1000)),
            latencyMs: summarizeLatencies(results.map(result => result.durationMs)),
            eventLoopDelayMs: {
                p50: delayMilliseconds(delay.percentile(50)),
                p95: delayMilliseconds(delay.percentile(95)),
                max: delayMilliseconds(delay.max),
            },
            sql: stableSql(sqlCounter.snapshot()),
            errors: results.filter(result => result.error !== null).length,
            rollback,
            entries: summarizeEntries(results, elapsedMs),
        }
    } catch (error) {
        primaryError = error
    }
    measureSql = false
    const cleanupErrors = []
    for (const cleanup of [
        async () => restoreComputes?.(),
        async () => { if (app) await app.close() },
        async () => runtime.closeDatabase(),
        async () => { if (database?.open) database.close() },
    ]) {
        try { await cleanup() } catch (error) { cleanupErrors.push(error) }
    }
    if (primaryError !== null) {
        if (cleanupErrors.length > 0 && primaryError instanceof Error) {
            primaryError.cause = cleanupErrors.length === 1
                ? cleanupErrors[0]
                : new AggregateError(cleanupErrors, "Layered load cleanup failed")
        }
        throw primaryError
    }
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Layered load cleanup failed")
    return summary
}

function assertFixedBaseRuntime(runtimeCommit) {
    if (runtimeCommit !== FIXED_BASE_COMMIT) {
        throw new Error(
            `Mission entry reference requires fixed BASE runtime ${FIXED_BASE_COMMIT}`,
        )
    }
}

function evaluateReport(report, reference) {
    assertFixedBaseRuntime(reference?.runtimeCommit)
    const structuralComparisons = []
    let behaviorEquivalent = true
    for (const step of report.steps) {
        for (const entry of ENTRY_NAMES) {
            const actual = step.entries[entry]
            const expected = reference?.entries?.[entry]
            const signatures = actual.behaviorSignatures
            const behaviorMatches = expected !== undefined
                && signatures.length === 1
                && signatures[0] === expected.behaviorSignature
            behaviorEquivalent &&= behaviorMatches
            structuralComparisons.push({
                concurrency: step.concurrency,
                entry,
                sqlNonIncreasing: expected !== undefined
                    && actual.structural.sqlReadsMax <= expected.sqlReads
                    && actual.structural.sqlWritesMax <= expected.sqlWrites,
                computeNonIncreasing: expected !== undefined
                    && actual.structural.missionComputesMax <= expected.missionComputes,
                actual: actual.structural,
                expected: expected ?? null,
            })
        }
    }
    const gate = createAdmissionGate({
        errors: report.steps.reduce((sum, step) => sum + step.errors, 0),
        behaviorEquivalent,
        rollbackVerified: report.steps.every(step => step.rollback.verified),
        structuralComparisons,
    })
    return { gate, structuralComparisons }
}

async function runMissionEntryLayeredLoad({
    concurrencies,
    players: playerCount,
    reference = fs.existsSync(REFERENCE_PATH) ? require(REFERENCE_PATH) : null,
    runtime = getRuntimeDependencies(),
    temporaryParent = os.tmpdir(),
}) {
    const suiteDirectory = fs.mkdtempSync(path.join(temporaryParent, "mission-entry-load-"))
    const seedDirectory = path.join(suiteDirectory, "seed")
    fs.mkdirSync(seedDirectory)
    const originalLog = console.log
    const originalTimeOffset = runtime.getTimeOffset()
    let restoreContent = null
    let seedDatabase = null
    let primaryError = null
    let report
    try {
        console.log = () => {}
        runtime.setServerTimeOffset(Date.parse(FIXED_TIME) - Date.now())
        restoreContent = runtime.installBundledGameplaySnapshot()
        const seedPaths = runtime.resolveRuntimeDataPaths({ DATA_DIR: seedDirectory })
        seedDatabase = runtime.initializeDatabase({ paths: seedPaths })
        const players = seedPlayers(runtime, playerCount)
        runtime.checkpointDatabase()
        runtime.closeDatabase()
        if (seedDatabase.open) seedDatabase.close()
        seedDatabase = null

        const steps = []
        for (const concurrency of concurrencies) {
            const runDirectory = path.join(suiteDirectory, `concurrency-${concurrency}`)
            fs.mkdirSync(runDirectory)
            steps.push(await runStep({
                concurrency,
                fixedTime: new Date(FIXED_TIME),
                players,
                runDirectory,
                runtime,
                seedDirectory,
            }))
        }
        report = {
            version: 1,
            fixedTime: FIXED_TIME,
            playerPool: {
                preparedIndependentStates: playerCount,
                requestsPerStep: playerCount,
                concurrencySteps: [...concurrencies],
                note: "Prepared player states are an online-pool model; concurrency is only the in-flight request limit.",
            },
            boundaries: {
                "get-progress": "Fastify route /get_mission_progress",
                "single-finish": "mission-finish-boundary adapter, not full battle HTTP protocol",
                "multi-finish": "mission-finish-boundary adapter, not full battle HTTP protocol",
                "character-bond": "Fastify route /open_mana_board through its mission settlement boundary",
            },
            steps,
        }
        if (reference !== null) Object.assign(report, evaluateReport(report, reference))
    } catch (error) {
        primaryError = error
    }
    const cleanupErrors = []
    for (const cleanup of [
        () => runtime.closeDatabase(),
        () => { if (seedDatabase?.open) seedDatabase.close() },
        () => restoreContent?.(),
        () => runtime.setServerTimeOffset(originalTimeOffset),
        () => { console.log = originalLog },
        () => fs.rmSync(suiteDirectory, { recursive: true, force: true }),
    ]) {
        try { cleanup() } catch (error) { cleanupErrors.push(error) }
    }
    if (primaryError !== null) {
        if (cleanupErrors.length > 0 && primaryError instanceof Error) {
            primaryError.cause = cleanupErrors.length === 1
                ? cleanupErrors[0]
                : new AggregateError(cleanupErrors, "Layered load suite cleanup failed")
        }
        throw primaryError
    }
    if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, "Layered load suite cleanup failed")
    }
    return report
}

async function main() {
    const options = parseArgs(process.argv.slice(2))
    const report = await runMissionEntryLayeredLoad(options)
    const serialized = `${JSON.stringify(report, null, 2)}\n`
    if (options.output) fs.writeFileSync(options.output, serialized, "utf8")
    process.stdout.write(serialized)
    if (!report.gate.admitted) process.exitCode = 1
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`${error.stack ?? error}\n`)
        process.exitCode = 1
    })
}

module.exports = {
    FIXED_TIME,
    FIXED_BASE_COMMIT,
    REFERENCE_PATH,
    evaluateReport,
    runMissionEntryLayeredLoad,
}
