#!/usr/bin/env node
"use strict"

require("ts-node/register/transpile-only")

const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const BetterSqlite3 = require("better-sqlite3")

const {
    evaluateFocusedMissionAdmission,
    formatFocusedMissionAdmissionFailures,
} = require("./mission_engine_focused_admission.cjs")
const {
    FOCUSED_FIXED_TIME,
    FOCUSED_REPORT_VERSION,
    assertCanonicalFocusedReport,
    createBehaviorSummary,
} = require("./mission_engine_focused_report.cjs")
const { createSqlCounter } = require("./mission_settlement_sql.cjs")

const FIXED_TIME = FOCUSED_FIXED_TIME
const SNAPSHOT_PATH = path.join(
    __dirname,
    "__snapshots__",
    "mission_engine_focused_baseline.json",
)
const SCENARIO_KEYS = Object.freeze([
    "degree-routing-fallback",
    "degree-focused",
    "degree-behavior-characterization",
    "event-routing-fallback",
    "event-focused",
    "event-behavior-characterization",
    "awake-character-page",
    "get-progress-no-invalidation",
    "get-progress-item-invalidation",
    "get-progress-character-invalidation",
    "get-progress-equipment-invalidation",
    "single-battle-finish",
    "multi-battle-finish",
])
let runtimeDependencies

function getRuntimeDependencies() {
    if (runtimeDependencies) return runtimeDependencies
    const data = require("../../src/data")
    const { getDb } = require("../../src/data/db")
    const character = require("../../src/data/domains/character")
    const item = require("../../src/data/domains/item")
    const mission = require("../../src/data/domains/mission")
    const player = require("../../src/data/domains/player")
    const assets = require("../../src/lib/assets")
    const characterLib = require("../../src/lib/character")
    const awakeSettlement = require("../../src/lib/mission/awake-settlement")
    const battleFacts = require("../../src/lib/mission/battle-facts")
    const patterns = require("../../src/lib/mission/patterns")
    const { getComputer } = require("../../src/lib/mission/registry")
    const { settleMissionCategories } = require("../../src/lib/mission/settlement")
    const stages = require("../../src/lib/mission/stages")
    const missionRoutes = require("../../src/routes/api/mission").default
    const { resolveRuntimeDataPaths } = require("../../src/runtime/data-paths")
    const { getTimeOffset, setServerTimeOffset } = require("../../src/utils")
    const { SCENARIOS } = require("./mission_settlement_scenarios.cjs")
    const { createFocusedScenarios } = require("./mission_engine_focused_scenarios.cjs")
    const {
        installBundledGameplaySnapshot,
    } = require("../helpers/install-bundled-gameplay-snapshot.cjs")

    runtimeDependencies = {
        ...data,
        ...character,
        ...item,
        ...mission,
        ...player,
        ...assets,
        ...characterLib,
        ...awakeSettlement,
        ...battleFacts,
        ...patterns,
        ...stages,
        createBasePlayer: SCENARIOS[0].create,
        createFocusedScenarios,
        getComputer,
        getDb,
        getTimeOffset,
        installBundledGameplaySnapshot,
        missionRoutes,
        resolveRuntimeDataPaths,
        setServerTimeOffset,
        settleMissionCategories,
    }
    return runtimeDependencies
}

function createBehaviorBaselineView(report) {
    return {
        version: report.version,
        fixedTime: report.fixedTime,
        scenarios: Object.fromEntries(Object.entries(report.scenarios).map(([name, scenario]) => [
            name,
            {
                behavior: scenario.behavior,
                behaviorSha256: scenario.behaviorSha256,
            },
        ])),
    }
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
                : new AggregateError(cleanupErrors, "Focused mission baseline cleanup failed")
            if (primaryError.cause === undefined) primaryError.cause = cleanupCause
            else primaryError.cleanupCause = cleanupCause
        }
        throw primaryError
    }
    if (cleanupErrors.length === 1) throw cleanupErrors[0]
    if (cleanupErrors.length > 1) {
        throw new AggregateError(cleanupErrors, "Focused mission baseline cleanup failed")
    }
}

function installComputeCounter(getComputer) {
    let count = 0
    const installed = []
    const computers = new Set()
    for (let category = 1; category <= 10; category++) computers.add(getComputer(category))
    try {
        for (const computer of computers) {
            const original = computer.compute
            const wrapper = function countedCompute(...args) {
                count++
                return original.apply(this, args)
            }
            installed.push({ computer, original, wrapper })
            computer.compute = wrapper
        }
    } catch (error) {
        completeCleanup(error, [...installed].reverse().map(entry => () => {
            if (entry.computer.compute === entry.wrapper) {
                entry.computer.compute = entry.original
            }
        }))
    }
    return {
        get count() { return count },
        restore() {
            completeCleanup(null, [...installed].reverse().map(entry => () => {
                if (entry.computer.compute === entry.wrapper) {
                    entry.computer.compute = entry.original
                }
            }))
        },
    }
}

async function runScenario(scenario, suiteDirectory, fixedTime, runtime) {
    const runDirectory = fs.mkdtempSync(path.join(suiteDirectory, `${scenario.name}-`))
    const counter = createSqlCounter()
    let database = null
    let computeCounter = null
    let measureSql = false
    let primaryError = null
    let result
    try {
        const evaluationTime = new Date(scenario.serverTime ?? fixedTime)
        runtime.setServerTimeOffset(evaluationTime.getTime() - Date.now())
        database = runtime.initializeDatabase({
            paths: runtime.resolveRuntimeDataPaths({ DATA_DIR: runDirectory }),
            databaseFactory: databasePath => new BetterSqlite3(databasePath, {
                verbose: sql => { if (measureSql) counter.observe(sql) },
            }),
        })
        const playerId = await scenario.prepare()
        computeCounter = installComputeCounter(runtime.getComputer)
        counter.reset()
        measureSql = true
        const outcome = await scenario.execute(playerId, evaluationTime)
        measureSql = false
        const sql = counter.snapshot()
        const missionComputes = computeCounter.count
        const behavior = scenario.summarize
            ? await scenario.summarize(outcome, playerId, evaluationTime)
            : outcome
        result = {
            sqlReads: sql.selectStatements,
            sqlWrites: sql.writeStatements,
            missionComputes,
            ...createBehaviorSummary(behavior),
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

async function runMissionEngineFocusedBaseline({
    runtimeLoader = getRuntimeDependencies,
    temporaryParent = os.tmpdir(),
} = {}) {
    const suiteDirectory = fs.mkdtempSync(
        path.join(temporaryParent, "mission-engine-focused-baseline-"),
    )
    const originalDateNow = Date.now
    Date.now = () => Date.parse(FIXED_TIME)
    const originalLog = console.log
    let runtime
    let restoreContent = null
    let originalTimeOffset
    let primaryError = null
    let report
    try {
        console.log = () => {}
        runtime = runtimeLoader()
        const databaseStatus = runtime.getDatabaseStatus()
        if (databaseStatus.open || databaseStatus.ready) {
            throw new Error(
                "Mission engine focused baseline refuses to run while the shared database is open.",
            )
        }
        originalTimeOffset = runtime.getTimeOffset()
        runtime.setServerTimeOffset(Date.parse(FIXED_TIME) - Date.now())
        restoreContent = runtime.installBundledGameplaySnapshot()
        const scenarios = runtime.createFocusedScenarios(runtime)
        const scenarioKeys = scenarios.map(scenario => scenario.name)
        if (JSON.stringify(scenarioKeys) !== JSON.stringify(SCENARIO_KEYS)) {
            throw new Error(`Unexpected focused mission scenario set: ${scenarioKeys.join(",")}`)
        }

        const results = {}
        const fixedTime = new Date(FIXED_TIME)
        for (const scenario of scenarios) {
            results[scenario.name] = await runScenario(
                scenario,
                suiteDirectory,
                fixedTime,
                runtime,
            )
        }
        report = {
            version: FOCUSED_REPORT_VERSION,
            fixedTime: FIXED_TIME,
            scenarios: results,
        }
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
        () => { Date.now = originalDateNow },
        () => fs.rmSync(suiteDirectory, { recursive: true, force: true }),
    ])
    return report
}

function parseArgs(argv) {
    if (argv.length === 0) return { write: false }
    if (argv.length === 1 && argv[0] === "--write") return { write: true }
    throw new Error(`unknown argument: ${argv[0]}`)
}

function serializeFocusedMissionReport(report) {
    const scenarios = Object.fromEntries(Object.keys(report.scenarios).map(name => {
        const scenario = report.scenarios[name]
        return [name, {
            sqlReads: scenario.sqlReads,
            sqlWrites: scenario.sqlWrites,
            missionComputes: scenario.missionComputes,
            behavior: scenario.behavior,
            behaviorSha256: scenario.behaviorSha256,
        }]
    }))
    return `${JSON.stringify({
        version: report.version,
        fixedTime: report.fixedTime,
        scenarios,
    }, null, 2)}\n`
}

function writeFocusedMissionSnapshotAtomic(report, snapshotPath, {
    fileSystem = fs,
    temporaryPathFactory = targetPath => path.join(
        path.dirname(targetPath),
        `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
    ),
} = {}) {
    assertCanonicalFocusedReport(report)
    const temporaryPath = temporaryPathFactory(snapshotPath)
    try {
        fileSystem.writeFileSync(
            temporaryPath,
            serializeFocusedMissionReport(report),
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

function admitFocusedMissionReport(report, {
    snapshotPath = SNAPSHOT_PATH,
    write = false,
} = {}) {
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"))
    const admission = evaluateFocusedMissionAdmission(report, snapshot)
    if (write && admission.admitted) {
        writeFocusedMissionSnapshotAtomic(admission.canonicalReport, snapshotPath)
    }
    return admission
}

async function main() {
    const { write } = parseArgs(process.argv.slice(2))
    const report = await runMissionEngineFocusedBaseline()
    const serialized = `${JSON.stringify(report, null, 2)}\n`
    const admission = admitFocusedMissionReport(report, { write })
    process.stdout.write(serialized)
    if (!admission.admitted) {
        for (const failure of formatFocusedMissionAdmissionFailures(admission)) {
            process.stderr.write(`Focused mission admission failed: ${failure}\n`)
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
    FIXED_TIME,
    SCENARIO_KEYS,
    admitFocusedMissionReport,
    createBehaviorBaselineView,
    createBehaviorSummary,
    installComputeCounter,
    parseArgs,
    runMissionEngineFocusedBaseline,
    writeFocusedMissionSnapshotAtomic,
}
