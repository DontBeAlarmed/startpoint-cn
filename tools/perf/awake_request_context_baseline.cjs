#!/usr/bin/env node
"use strict"

require("ts-node/register/transpile-only")

const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const BetterSqlite3 = require("better-sqlite3")

const {
    evaluateAwakeRequestContextAdmission,
    formatAwakeRequestContextAdmissionFailures,
} = require("./awake_request_context_admission.cjs")
const {
    AWAKE_REQUEST_CONTEXT_FIXED_TIME,
    AWAKE_REQUEST_CONTEXT_SCENARIO_KEYS,
    assertCanonicalAwakeRequestContextReport,
    createAwakeRequestContextReport,
} = require("./awake_request_context_report.cjs")
const { createAwakeRequestContextScenarios } = require("./awake_request_context_scenarios.cjs")
const { installComputeCounter } = require("./mission_engine_focused_baseline.cjs")
const { createSqlCounter } = require("./mission_settlement_sql.cjs")

const SNAPSHOT_PATH = path.join(
    __dirname,
    "__snapshots__",
    "awake_request_context_baseline.json",
)
let runtimeDependencies

function getRuntimeDependencies() {
    if (runtimeDependencies) return runtimeDependencies
    const data = require("../../src/data")
    const account = require("../../src/data/domains/account")
    const character = require("../../src/data/domains/character")
    const awakeData = require("../../src/data/domains/character_awake")
    const mission = require("../../src/data/domains/mission")
    const player = require("../../src/data/domains/player")
    const assets = require("../../src/lib/assets")
    const characterLib = require("../../src/lib/character")
    const awakeMission = require("../../src/lib/mission")
    const { getDb } = require("../../src/data/db")
    const { resolveRuntimeDataPaths } = require("../../src/runtime/data-paths")
    const { getTimeOffset, setServerTimeOffset } = require("../../src/utils")
    const {
        installBundledGameplaySnapshot,
    } = require("../helpers/install-bundled-gameplay-snapshot.cjs")

    runtimeDependencies = {
        ...data,
        ...account,
        ...character,
        ...awakeData,
        ...mission,
        ...player,
        ...assets,
        ...characterLib,
        ...awakeMission,
        fixedTime: AWAKE_REQUEST_CONTEXT_FIXED_TIME,
        getDb,
        getTimeOffset,
        installBundledGameplaySnapshot,
        resolveRuntimeDataPaths,
        setServerTimeOffset,
    }
    return runtimeDependencies
}

function completeCleanup(primaryError, actions) {
    const cleanupErrors = []
    for (const action of actions) {
        try {
            action()
        } catch (error) {
            cleanupErrors.push(error)
        }
    }
    if (primaryError !== null) {
        if (cleanupErrors.length > 0 && primaryError instanceof Error) {
            const cleanupCause = cleanupErrors.length === 1
                ? cleanupErrors[0]
                : new AggregateError(cleanupErrors, "Awake request-context cleanup failed")
            if (primaryError.cause === undefined) primaryError.cause = cleanupCause
            else primaryError.cleanupCause = cleanupCause
        }
        throw primaryError
    }
    if (cleanupErrors.length === 1) throw cleanupErrors[0]
    if (cleanupErrors.length > 1) {
        throw new AggregateError(cleanupErrors, "Awake request-context cleanup failed")
    }
}

async function runScenario(scenario, suiteDirectory, runtime) {
    const runDirectory = fs.mkdtempSync(path.join(suiteDirectory, `${scenario.name}-`))
    const sqlCounter = createSqlCounter()
    let database = null
    let computeCounter = null
    let measureSql = false
    let measureTargetCalls = 0
    let measuredSql = null
    let measuredMissionComputes = null
    let primaryError = null
    let result
    try {
        runtime.setServerTimeOffset(Date.parse(AWAKE_REQUEST_CONTEXT_FIXED_TIME) - Date.now())
        database = runtime.initializeDatabase({
            paths: runtime.resolveRuntimeDataPaths({ DATA_DIR: runDirectory }),
            databaseFactory: databasePath => new BetterSqlite3(databasePath, {
                verbose: sql => { if (measureSql) sqlCounter.observe(sql) },
            }),
        })
        const fixture = await scenario.prepare()
        computeCounter = installComputeCounter(runtime.getComputer)
        function measureTarget(operation) {
            measureTargetCalls++
            if (measureTargetCalls !== 1 || typeof operation !== "function") {
                throw new Error(`${scenario.name} must call measureTarget exactly once`)
            }
            const computesBefore = computeCounter.count
            sqlCounter.reset()
            measureSql = true
            try {
                const outcome = operation()
                if (outcome && typeof outcome.then === "function") {
                    throw new TypeError(`${scenario.name} measureTarget operation must be synchronous`)
                }
                return outcome
            } finally {
                measureSql = false
                measuredSql = sqlCounter.snapshot()
                measuredMissionComputes = computeCounter.count - computesBefore
            }
        }
        const outcome = await scenario.execute(fixture, measureTarget)
        if (measureTargetCalls !== 1 || measuredSql === null || measuredMissionComputes === null) {
            throw new Error(`${scenario.name} must call measureTarget exactly once`)
        }
        const behavior = await scenario.summarize(outcome, fixture)
        result = {
            sqlReads: measuredSql.selectStatements,
            sqlWrites: measuredSql.writeStatements,
            missionComputes: measuredMissionComputes,
            sqlByTable: measuredSql.byTable,
            behavior,
        }
    } catch (error) {
        primaryError = error
    }
    measureSql = false
    completeCleanup(primaryError, [
        () => computeCounter?.restore(),
        () => runtime.closeDatabase(),
        () => { if (database?.open) database.close() },
        () => fs.rmSync(runDirectory, { recursive: true, force: true }),
    ])
    return result
}

async function runAwakeRequestContextBaseline({
    runtimeLoader = getRuntimeDependencies,
    scenarioFactory = createAwakeRequestContextScenarios,
    temporaryParent = os.tmpdir(),
} = {}) {
    const suiteDirectory = fs.mkdtempSync(
        path.join(temporaryParent, "awake-request-context-baseline-"),
    )
    const originalLog = console.log
    const originalError = console.error
    let runtime
    let restoreContent = null
    let originalTimeOffset
    let primaryError = null
    let report
    try {
        console.log = () => {}
        console.error = () => {}
        runtime = runtimeLoader()
        const databaseStatus = runtime.getDatabaseStatus()
        if (databaseStatus.open || databaseStatus.ready) {
            throw new Error(
                "Awake request-context baseline refuses to run while the shared database is open.",
            )
        }
        originalTimeOffset = runtime.getTimeOffset()
        runtime.setServerTimeOffset(
            Date.parse(AWAKE_REQUEST_CONTEXT_FIXED_TIME) - Date.now(),
        )
        restoreContent = runtime.installBundledGameplaySnapshot()
        const scenarios = scenarioFactory(runtime)
        const scenarioKeys = scenarios.map(scenario => scenario.name)
        if (JSON.stringify(scenarioKeys) !== JSON.stringify(AWAKE_REQUEST_CONTEXT_SCENARIO_KEYS)) {
            throw new Error(`Unexpected Awake request-context scenario set: ${scenarioKeys.join(",")}`)
        }
        const results = {}
        for (const scenario of scenarios) {
            results[scenario.name] = await runScenario(scenario, suiteDirectory, runtime)
        }
        report = createAwakeRequestContextReport(results)
    } catch (error) {
        primaryError = error
    }
    completeCleanup(primaryError, [
        () => { if (restoreContent) restoreContent() },
        () => {
            if (runtime && originalTimeOffset !== undefined) {
                runtime.setServerTimeOffset(originalTimeOffset)
            }
        },
        () => { console.log = originalLog },
        () => { console.error = originalError },
        () => fs.rmSync(suiteDirectory, { recursive: true, force: true }),
    ])
    return report
}

function parseArgs(argv) {
    if (argv.length === 0) return { write: false }
    if (argv.length === 1 && argv[0] === "--write") return { write: true }
    throw new Error(`unknown argument: ${argv.join(" ")}`)
}

function serializeAwakeRequestContextReport(report) {
    return `${JSON.stringify(report, null, 2)}\n`
}

function writeAwakeRequestContextSnapshotAtomic(report, snapshotPath, {
    fileSystem = fs,
    temporaryPathFactory = targetPath => path.join(
        path.dirname(targetPath),
        `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
    ),
} = {}) {
    assertCanonicalAwakeRequestContextReport(report)
    const temporaryPath = temporaryPathFactory(snapshotPath)
    try {
        fileSystem.writeFileSync(
            temporaryPath,
            serializeAwakeRequestContextReport(report),
            { encoding: "utf8", flag: "wx" },
        )
        fileSystem.renameSync(temporaryPath, snapshotPath)
    } catch (error) {
        try {
            fileSystem.rmSync(temporaryPath, { force: true })
        } catch (cleanupError) {
            if (error instanceof Error && error.cause === undefined) error.cause = cleanupError
        }
        throw error
    }
}

function admitAwakeRequestContextReport(report, {
    snapshotPath = SNAPSHOT_PATH,
    write = false,
} = {}) {
    if (!fs.existsSync(snapshotPath)) {
        if (!write) throw new Error(`Awake request-context snapshot does not exist: ${snapshotPath}`)
        const bootstrapAdmission = evaluateAwakeRequestContextAdmission(report, report)
        if (bootstrapAdmission.admitted) {
            writeAwakeRequestContextSnapshotAtomic(
                bootstrapAdmission.canonicalReport,
                snapshotPath,
            )
        }
        return bootstrapAdmission
    }
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"))
    const admission = evaluateAwakeRequestContextAdmission(report, snapshot)
    if (write && admission.admitted) {
        writeAwakeRequestContextSnapshotAtomic(admission.canonicalReport, snapshotPath)
    }
    return admission
}

async function main() {
    const { write } = parseArgs(process.argv.slice(2))
    const report = await runAwakeRequestContextBaseline()
    const admission = admitAwakeRequestContextReport(report, { write })
    process.stdout.write(`${JSON.stringify({
        report,
        admission: {
            admitted: admission.admitted,
            failures: admission.failures,
        },
    }, null, 2)}\n`)
    if (!admission.admitted) {
        for (const failure of formatAwakeRequestContextAdmissionFailures(admission)) {
            process.stderr.write(`Awake request-context admission failed: ${failure}\n`)
        }
        process.exitCode = 1
    }
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`${error.stack ?? error}\n`)
        process.exitCode = 1
    })
}

module.exports = {
    SNAPSHOT_PATH,
    admitAwakeRequestContextReport,
    parseArgs,
    runAwakeRequestContextBaseline,
    writeAwakeRequestContextSnapshotAtomic,
}
