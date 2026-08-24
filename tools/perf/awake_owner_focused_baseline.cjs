#!/usr/bin/env node
"use strict"

require("ts-node/register/transpile-only")

const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const {
    evaluateAwakeOwnerFocusedAdmission,
    formatAwakeOwnerFocusedAdmissionFailures,
} = require("./awake_owner_focused_admission.cjs")
const {
    AWAKE_OWNER_FOCUSED_FIXED_TIME,
    canonicalizeCheckedAwakeOwnerFocusedReport,
    createAwakeOwnerFocusedReport,
} = require("./awake_owner_focused_report.cjs")
const {
    AWAKE_OWNER_FOCUSED_SCENARIO_KEYS,
    createAwakeOwnerFocusedScenarios,
} = require("./awake_owner_focused_scenarios.cjs")
const { installComputeCounter } = require("./mission_engine_focused_baseline.cjs")
const { createSqlCounter } = require("./mission_settlement_sql.cjs")
const {
    closeAwakeOwnerFactPublicationFixture,
    createAwakeOwnerFactPublicationFixture,
} = require("../helpers/awake-owner-fact-publication-fixture.cjs")

const SNAPSHOT_PATH = path.join(
    __dirname,
    "__snapshots__",
    "awake_owner_focused_baseline.json",
)

function installSqlExecutionCounter(database) {
    const counter = createSqlCounter()
    const originalPrepare = database.prepare
    database.prepare = function countedPrepare(sql) {
        const statement = originalPrepare.call(this, sql)
        let proxy
        proxy = new Proxy(statement, {
            get(target, property) {
                const value = Reflect.get(target, property, target)
                if (typeof value !== "function") return value
                if (["all", "get", "iterate", "run"].includes(property)) {
                    return (...args) => {
                        counter.observe(sql)
                        return Reflect.apply(value, target, args)
                    }
                }
                return (...args) => {
                    const result = Reflect.apply(value, target, args)
                    return result === target ? proxy : result
                }
            },
        })
        return proxy
    }
    return {
        snapshot: () => counter.snapshot(),
        restore() { database.prepare = originalPrepare },
    }
}

function installLoaderCounter() {
    const module = require("../../src/lib/mission/production-fact-loaders")
    const { getFactKeyId } = require("../../src/lib/mission/facts/fact-key")
    const original = module.createProductionMissionFactLoaderRegistry
    const calls = []
    module.createProductionMissionFactLoaderRegistry = (...args) => {
        const registry = original(...args)
        return {
            get(key) {
                const loader = registry.get(key)
                if (loader === undefined) return undefined
                return context => {
                    calls.push(getFactKeyId(context.key))
                    return loader(context)
                }
            },
        }
    }
    return {
        calls,
        restore() { module.createProductionMissionFactLoaderRegistry = original },
    }
}

function installAwakeEvaluationCounter() {
    const { AwakeComputer } = require("../../src/lib/mission/computer-awake")
    const original = AwakeComputer.buildContextFromSession
    let count = 0
    AwakeComputer.buildContextFromSession = function countedBuildContext(...args) {
        count++
        return original.apply(this, args)
    }
    return {
        get count() { return count },
        restore() { AwakeComputer.buildContextFromSession = original },
    }
}

function loadRuntime(fixture) {
    const characterDomain = require("../../src/data/domains/character")
    const awakeDomain = require("../../src/data/domains/character_awake")
    const missionDomain = require("../../src/data/domains/mission")
    const questDomain = require("../../src/data/domains/quest")
    const assets = require("../../src/lib/assets")
    const { characterExpCaps, givePlayerCharacterSync } = require("../../src/lib/character")
    const {
        createAwakeRequestContext,
        reconcileAwakeUnlockCharacterListStrict,
    } = require("../../src/lib/mission")
    const {
        publishAwakeCharacterListBestEffort,
    } = require("../../src/lib/mission/awake-best-effort-context")
    const { sellItemSync } = require("../../src/lib/item-sell")
    const { getDb } = require("../../src/data/db")

    return {
        fixture,
        assets,
        awakeDomain,
        characterDomain,
        characterExpCaps,
        createAwakeRequestContext,
        getDb,
        givePlayerCharacterSync,
        itemDomain: fixture.itemDomain,
        missionDomain,
        passCardDomain: fixture.passCardDomain,
        playerDomain: fixture.playerDomain,
        publishAwakeCharacterListBestEffort,
        questDomain,
        raidEventDomain: fixture.raidEventDomain,
        reconcileAwakeUnlockCharacterListStrict,
        sellItemSync,
    }
}

async function runScenario(scenario, runtime) {
    const fixture = await scenario.prepare()
    const dbBefore = scenario.state(fixture)
    const request = scenario.request(fixture)
    let sqlCounter = null
    let loaderCounter = null
    let computeCounter = null
    let evaluationCounter = null
    let result
    let primaryError = null
    try {
        sqlCounter = installSqlExecutionCounter(runtime.getDb())
        loaderCounter = installLoaderCounter()
        computeCounter = installComputeCounter(
            require("../../src/lib/mission/registry").getComputer,
        )
        evaluationCounter = installAwakeEvaluationCounter()
        result = await scenario.execute(fixture)
    } catch (error) {
        primaryError = error
    }
    const sql = sqlCounter?.snapshot()
    const measurements = {
        category9Evaluations: evaluationCounter?.count ?? 0,
        fixtureActiveQuestRemoved: runtime.fixture.activeQuests[fixture.playerId] === undefined,
    }
    const loaderCalls = [...(loaderCounter?.calls ?? [])]
    const missionComputes = computeCounter?.count ?? 0
    const cleanupErrors = []
    for (const restore of [
        () => evaluationCounter?.restore(),
        () => computeCounter?.restore(),
        () => loaderCounter?.restore(),
        () => sqlCounter?.restore(),
    ]) {
        try { restore() } catch (error) { cleanupErrors.push(error) }
    }
    if (primaryError !== null || cleanupErrors.length > 0) {
        const errors = [...(primaryError === null ? [] : [primaryError]), ...cleanupErrors]
        if (errors.length === 1) throw errors[0]
        throw new AggregateError(errors, `${scenario.name} measurement cleanup failed`)
    }
    const response = scenario.response(result, measurements)
    const dbAfter = scenario.state(fixture)
    return {
        request,
        response,
        dbBefore,
        dbAfter,
        characterSeeds: scenario.characterSeeds,
        factSeeds: scenario.factSeeds,
        directMissionSeeds: scenario.directMissionSeeds,
        loaderCalls,
        missionComputes,
        snapshotSource: scenario.snapshotSource,
        rereadReason: scenario.rereadReason,
        freshPostWriteEvaluationRequired: scenario.freshPostWriteEvaluationRequired,
        sqlReads: sql.selectStatements,
        sqlWrites: sql.writeStatements,
        sqlByTable: sql.byTable,
    }
}

async function runAwakeOwnerFocusedBaseline() {
    const originalLog = console.log
    const originalError = console.error
    let fixture = null
    let primaryError = null
    let report
    try {
        console.log = () => {}
        console.error = () => {}
        fixture = await createAwakeOwnerFactPublicationFixture()
        const { setServerTimeOffset } = require("../../src/utils")
        setServerTimeOffset(Date.parse(AWAKE_OWNER_FOCUSED_FIXED_TIME) - Date.now())
        const runtime = loadRuntime(fixture)
        const scenarios = createAwakeOwnerFocusedScenarios(runtime)
        if (JSON.stringify(scenarios.map(entry => entry.name))
            !== JSON.stringify(AWAKE_OWNER_FOCUSED_SCENARIO_KEYS)) {
            throw new Error("Unexpected Awake owner-focused scenario set")
        }
        const results = {}
        for (const scenario of scenarios) results[scenario.name] = await runScenario(scenario, runtime)
        report = createAwakeOwnerFocusedReport(results)
    } catch (error) {
        primaryError = error
    }
    const cleanupErrors = []
    if (fixture !== null) {
        try { await closeAwakeOwnerFactPublicationFixture(fixture) } catch (error) {
            cleanupErrors.push(error)
        }
    }
    console.log = originalLog
    console.error = originalError
    if (primaryError !== null || cleanupErrors.length > 0) {
        const errors = [...(primaryError === null ? [] : [primaryError]), ...cleanupErrors]
        if (errors.length === 1) throw errors[0]
        throw new AggregateError(errors, "Awake owner-focused baseline cleanup failed")
    }
    return report
}

function parseArgs(argv) {
    if (argv.length === 0) return { write: false }
    if (argv.length === 1 && argv[0] === "--write") return { write: true }
    throw new Error(`unknown argument: ${argv.join(" ")}`)
}

function writeSnapshotAtomic(report, snapshotPath = SNAPSHOT_PATH) {
    const checked = canonicalizeCheckedAwakeOwnerFocusedReport(report, "snapshot-write")
    const temporaryPath = path.join(
        path.dirname(snapshotPath),
        `.${path.basename(snapshotPath)}.${process.pid}.${randomUUID()}.tmp`,
    )
    try {
        fs.writeFileSync(temporaryPath, `${JSON.stringify(checked, null, 2)}\n`, {
            encoding: "utf8",
            flag: "wx",
        })
        fs.renameSync(temporaryPath, snapshotPath)
    } catch (error) {
        fs.rmSync(temporaryPath, { force: true })
        throw error
    }
}

function admitAwakeOwnerFocusedReport(report, { snapshotPath = SNAPSHOT_PATH, write = false } = {}) {
    if (!fs.existsSync(snapshotPath)) {
        if (!write) throw new Error(`Awake owner-focused snapshot does not exist: ${snapshotPath}`)
        const admission = evaluateAwakeOwnerFocusedAdmission(report, report)
        if (admission.admitted) writeSnapshotAtomic(admission.canonicalReport, snapshotPath)
        return admission
    }
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"))
    const admission = evaluateAwakeOwnerFocusedAdmission(report, snapshot)
    if (write && admission.admitted) writeSnapshotAtomic(admission.canonicalReport, snapshotPath)
    return admission
}

async function main() {
    const { write } = parseArgs(process.argv.slice(2))
    const report = await runAwakeOwnerFocusedBaseline()
    const admission = admitAwakeOwnerFocusedReport(report, { write })
    process.stdout.write(`${JSON.stringify({ report, admission: {
        admitted: admission.admitted,
        failures: admission.failures,
    } }, null, 2)}\n`)
    if (!admission.admitted) {
        for (const failure of formatAwakeOwnerFocusedAdmissionFailures(admission)) {
            process.stderr.write(`Awake owner-focused admission failed: ${failure}\n`)
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
    admitAwakeOwnerFocusedReport,
    parseArgs,
    runAwakeOwnerFocusedBaseline,
    writeSnapshotAtomic,
}
