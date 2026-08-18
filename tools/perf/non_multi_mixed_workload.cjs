#!/usr/bin/env node
"use strict"

require("ts-node/register/transpile-only")

const { AsyncLocalStorage } = require("node:async_hooks")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const BetterSqlite3 = require("better-sqlite3")
const { monitorEventLoopDelay } = require("node:perf_hooks")

const {
    FORMAL_ACTIVE_IDENTITIES,
    FORMAL_CONCURRENCY_STEPS,
    FORMAL_INDEPENDENT_SAVES,
    createAdmissionGate,
} = require("./non_multi_mixed_metrics.cjs")
const { runBounded } = require("./mission_entry_load_metrics.cjs")
const {
    behaviorSignature,
    createMetadata,
    createStepSummary,
    round,
} = require("./non_multi_mixed_workload_helpers.cjs")
const {
    createRouteApp,
    loadRuntime,
    loadScenarioDependencies,
} = require("./non_multi_mixed_workload_runtime.cjs")
const {
    createStepContext,
    prepareSeed,
} = require("./non_multi_mixed_workload_setup.cjs")
const { createSqlCounter } = require("./mission_settlement_sql.cjs")

const FIXED_TIME = "2024-08-14T12:00:00.000Z"
const DEFAULT_PROFILE = Object.freeze({
    independentSaves: 7,
    activeIdentities: 7,
    concurrencySteps: Object.freeze([2]),
})
const FORMAL_PROFILE = Object.freeze({
    independentSaves: FORMAL_INDEPENDENT_SAVES,
    activeIdentities: FORMAL_ACTIVE_IDENTITIES,
    concurrencySteps: FORMAL_CONCURRENCY_STEPS,
})

function parseArgs(argv) {
    let formal = false
    let output = null
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index]
        if (argument === "--formal") {
            if (formal) throw new Error("--formal may only be specified once")
            formal = true
        } else if (argument === "--output") {
            const value = argv[++index]
            if (value === undefined || value.startsWith("--")) {
                throw new Error("--output requires a path")
            }
            if (output !== null) throw new Error("--output may only be specified once")
            output = value
        } else {
            throw new Error(`unknown argument: ${argument}`)
        }
    }
    const profile = formal ? FORMAL_PROFILE : DEFAULT_PROFILE
    return {
        formal,
        output,
        profile: {
            independentSaves: profile.independentSaves,
            activeIdentities: profile.activeIdentities,
            concurrencySteps: [...profile.concurrencySteps],
        },
    }
}

async function runStep({
    runtime,
    scenarioDependencies,
    seedDirectory,
    runDirectory,
    pool,
    mailFixtureByIdentity,
    concurrency,
}) {
    const storage = new AsyncLocalStorage()
    let runDirectoryCreated = false
    let databaseOwned = false
    let measureSql = false
    let database = null
    let app = null
    let primaryError = null
    let summary
    const delay = monitorEventLoopDelay({ resolution: 10 })
    try {
        fs.mkdirSync(runDirectory)
        runDirectoryCreated = true
        fs.cpSync(seedDirectory, runDirectory, { recursive: true })
        const databaseStatus = runtime.getDatabaseStatus?.()
        if (databaseStatus?.open || databaseStatus?.ready) {
            throw new Error("non-multi mixed step requires the shared database to be closed")
        }
        const paths = runtime.resolveRuntimeDataPaths({ DATA_DIR: runDirectory })
        database = runtime.initializeDatabase({
            paths,
            databaseFactory: databasePath => new BetterSqlite3(databasePath, {
                verbose(sql) {
                    if (!measureSql) return
                    storage.getStore()?.sql.observe(sql)
                },
            }),
        })
        databaseOwned = true
        app = await createRouteApp(runtime)
        delay.enable()
        await new Promise(resolve => setImmediate(resolve))
        measureSql = true
        const startedAt = performance.now()
        const context = createStepContext(runtime, mailFixtureByIdentity, pool.activeIdentities)
        const results = await runBounded(pool.activeIdentities.map(identity => async () => {
            const request = { sql: createSqlCounter() }
            return storage.run(request, async () => {
                const requestStartedAt = performance.now()
                let behavior = null
                let error = null
                try {
                    behavior = await scenarioDependencies.executeScenario(app, identity, context)
                } catch (caught) {
                    error = caught
                }
                return {
                    entry: identity.entryName,
                    durationMs: round(performance.now() - requestStartedAt),
                    sql: request.sql.snapshot(),
                    behaviorSignature: behavior === null ? null : behaviorSignature(behavior),
                    error: error instanceof Error ? error.message : error === null ? null : String(error),
                }
            })
        }), concurrency)
        const elapsedMs = performance.now() - startedAt
        measureSql = false
        await new Promise(resolve => setImmediate(resolve))
        delay.disable()
        summary = createStepSummary({
            concurrency,
            results,
            elapsedMs,
            eventLoopDelay: delay,
        })
    } catch (error) {
        primaryError = error
    }
    measureSql = false
    delay.disable()
    const cleanupErrors = []
    for (const cleanup of [
        async () => { if (app) await app.close() },
        async () => { if (databaseOwned) runtime.closeDatabase() },
        async () => { if (database?.open) database.close() },
        async () => {
            if (runDirectoryCreated) fs.rmSync(runDirectory, { recursive: true, force: true })
        },
    ]) {
        try { await cleanup() } catch (error) { cleanupErrors.push(error) }
    }
    if (primaryError !== null) {
        if (cleanupErrors.length > 0 && primaryError instanceof Error) {
            primaryError.cause = cleanupErrors.length === 1
                ? cleanupErrors[0]
                : new AggregateError(cleanupErrors, "non-multi mixed step cleanup failed")
        }
        throw primaryError
    }
    if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, "non-multi mixed step cleanup failed")
    }
    return summary
}

async function runNonMultiMixedWorkload({
    profile = DEFAULT_PROFILE,
    temporaryParent = os.tmpdir(),
    runtime = null,
} = {}) {
    const consoleMethods = ["error", "info", "log", "warn"]
    const originalConsole = Object.fromEntries(consoleMethods.map(name => [name, console[name]]))
    let suiteDirectory = null
    let seedDirectory = null
    let originalTimeOffset
    let restoreActive = null
    let restoreContent = null
    let scenarioDependencies = null
    let primaryError = null
    let databaseOwned = false
    let timeOffsetCaptured = false
    try {
        for (const name of consoleMethods) console[name] = () => {}
        suiteDirectory = fs.mkdtempSync(path.join(temporaryParent, "non-multi-mixed-"))
        seedDirectory = path.join(suiteDirectory, "seed")
        fs.mkdirSync(seedDirectory)
        runtime ??= loadRuntime()
        const databaseStatus = runtime.getDatabaseStatus?.()
        if (databaseStatus?.open || databaseStatus?.ready) {
            throw new Error("non-multi mixed workload requires the shared database to be closed")
        }
        scenarioDependencies = loadScenarioDependencies()
        originalTimeOffset = runtime.getTimeOffset()
        timeOffsetCaptured = true
        restoreActive = scenarioDependencies.prepareActiveQuests({
            createSentinel: scenarioDependencies.createActiveQuestSentinel,
        })
        runtime.setServerTimeOffset(Date.parse(FIXED_TIME) - Date.now())
        restoreContent = runtime.installBundledGameplaySnapshot({
            additionalTableNames: [
                "event_item_shop.json",
                "event_item_shop_id_map.json",
                "gacha.json",
                "general_shop.json",
            ],
        })
        databaseOwned = true
        const prepared = prepareSeed(runtime, scenarioDependencies, seedDirectory, profile)
        databaseOwned = false
        const steps = []
        for (const concurrency of profile.concurrencySteps) {
            steps.push(await runStep({
                runtime,
                scenarioDependencies,
                seedDirectory,
                runDirectory: path.join(suiteDirectory, `run-${concurrency}`),
                pool: prepared.pool,
                mailFixtureByIdentity: prepared.mailFixtureByIdentity,
                concurrency,
            }))
        }
        const report = {
            profile: {
                independentSaves: profile.independentSaves,
                activeIdentities: profile.activeIdentities,
                concurrencySteps: [...profile.concurrencySteps],
            },
            metadata: createMetadata(
                profile,
                prepared.pool.entryRequests,
                FIXED_TIME,
            ),
            steps,
        }
        return { ...report, gate: createAdmissionGate(report) }
    } catch (error) {
        primaryError = error
        throw error
    } finally {
        const cleanupErrors = []
        for (const cleanup of [
            () => { if (databaseOwned) runtime.closeDatabase() },
            () => restoreContent?.(),
            () => { if (timeOffsetCaptured) runtime.setServerTimeOffset(originalTimeOffset) },
            () => {
                if (restoreActive !== null && scenarioDependencies !== null) {
                    scenarioDependencies.restoreActiveQuests(restoreActive.initial)
                }
            },
            () => {
                if (suiteDirectory !== null) {
                    fs.rmSync(suiteDirectory, { recursive: true, force: true })
                }
            },
            () => {
                for (const name of consoleMethods) console[name] = originalConsole[name]
            },
        ]) {
            try { cleanup() } catch (error) { cleanupErrors.push(error) }
        }
        if (primaryError !== null && cleanupErrors.length > 0 && primaryError instanceof Error) {
            primaryError.cause = cleanupErrors.length === 1
                ? cleanupErrors[0]
                : new AggregateError(cleanupErrors, "non-multi mixed workload cleanup failed")
        } else if (primaryError === null && cleanupErrors.length > 0) {
            throw new AggregateError(cleanupErrors, "non-multi mixed workload cleanup failed")
        }
    }
}

async function main() {
    const options = parseArgs(process.argv.slice(2))
    const report = await runNonMultiMixedWorkload({ profile: options.profile })
    const output = `${JSON.stringify(report, null, 2)}\n`
    if (options.output) fs.writeFileSync(options.output, output, "utf8")
    process.stdout.write(output)
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`${error.stack ?? error}\n`)
        process.exitCode = 1
    })
}

module.exports = {
    DEFAULT_PROFILE,
    FIXED_TIME,
    FORMAL_PROFILE,
    behaviorSignature,
    createRouteApp,
    parseArgs,
    runNonMultiMixedWorkload,
    runStep,
}
