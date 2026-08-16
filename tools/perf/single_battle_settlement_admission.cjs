"use strict"

const fs = require("node:fs")
const path = require("node:path")
const { isDeepStrictEqual } = require("node:util")

const {
    canonicalizeBehavior,
    createBehaviorSummary,
    hasExactFields,
    isPlainObject,
    sortedOwnKeys,
    validMetric,
} = require("./mission_engine_focused_report.cjs")

const SINGLE_BATTLE_REPORT_VERSION = 1
const SINGLE_BATTLE_FIXED_TIME = "2025-01-01T12:00:00.000Z"
const REPORT_FIELDS = Object.freeze(["fixedTime", "scenarios", "version"])
const SCENARIO_FIELDS = Object.freeze(["behavior", "behaviorSha256", "sql"])
const SQL_FIELDS = Object.freeze([
    "byTable",
    "selectStatements",
    "statements",
    "transactionStatements",
    "writeStatements",
])
const TABLE_FIELDS = Object.freeze(["reads", "statements", "writes"])
const STRUCTURAL_SQL_FIELDS = Object.freeze([
    "statements",
    "selectStatements",
    "writeStatements",
    "transactionStatements",
])

function canonicalizeSql(sql) {
    if (!isPlainObject(sql) || !hasExactFields(sql, SQL_FIELDS)) {
        throw new TypeError("SQL metrics must use the checked baseline schema")
    }
    for (const field of SQL_FIELDS.filter(field => field !== "byTable")) {
        if (!validMetric(sql[field])) throw new TypeError(`SQL metric ${field} is invalid`)
    }
    if (sql.statements !== sql.selectStatements
        + sql.writeStatements
        + sql.transactionStatements) {
        throw new TypeError("SQL statement totals are inconsistent")
    }
    if (!isPlainObject(sql.byTable)) throw new TypeError("SQL byTable must be a plain object")
    const nonTransactionStatements = sql.selectStatements + sql.writeStatements
    const tableMetricLimits = {
        statements: nonTransactionStatements,
        reads: nonTransactionStatements,
        writes: sql.writeStatements,
    }
    let byTableWriteStatements = 0
    const byTable = Object.fromEntries(sortedOwnKeys(sql.byTable).map(table => {
        if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new TypeError(`invalid SQL table ${table}`)
        const metrics = sql.byTable[table]
        if (!isPlainObject(metrics) || !hasExactFields(metrics, TABLE_FIELDS)) {
            throw new TypeError(`SQL table ${table} uses an invalid schema`)
        }
        for (const field of TABLE_FIELDS) {
            if (!validMetric(metrics[field])) {
                throw new TypeError(`SQL table ${table} metric ${field} is invalid`)
            }
            if (metrics[field] > tableMetricLimits[field]) {
                throw new TypeError(`SQL table ${table} metric ${field} exceeds its summary`)
            }
        }
        if (metrics.statements < Math.max(metrics.reads, metrics.writes)
            || metrics.statements > metrics.reads + metrics.writes) {
            throw new TypeError(`SQL table ${table} statement totals are inconsistent`)
        }
        if (metrics.writes > sql.writeStatements - byTableWriteStatements) {
            throw new TypeError("SQL byTable write totals are inconsistent")
        }
        byTableWriteStatements += metrics.writes
        return [table, {
            statements: metrics.statements,
            reads: metrics.reads,
            writes: metrics.writes,
        }]
    }))
    if (byTableWriteStatements !== sql.writeStatements) {
        throw new TypeError("SQL byTable write totals are inconsistent")
    }
    return {
        statements: sql.statements,
        selectStatements: sql.selectStatements,
        writeStatements: sql.writeStatements,
        transactionStatements: sql.transactionStatements,
        byTable,
    }
}

function createSingleBattleReport(scenarios) {
    if (!isPlainObject(scenarios) || sortedOwnKeys(scenarios).length === 0) {
        throw new TypeError("single battle scenarios must be a non-empty plain object")
    }
    return {
        version: SINGLE_BATTLE_REPORT_VERSION,
        fixedTime: SINGLE_BATTLE_FIXED_TIME,
        scenarios: Object.fromEntries(sortedOwnKeys(scenarios).map(name => {
            const scenario = scenarios[name]
            if (!isPlainObject(scenario)) throw new TypeError(`scenario ${name} must be an object`)
            const behaviorSummary = createBehaviorSummary(scenario.behavior)
            return [name, {
                behavior: behaviorSummary.behavior,
                behaviorSha256: behaviorSummary.behaviorSha256,
                sql: canonicalizeSql(scenario.sql),
            }]
        })),
    }
}

function inspectReport(report, source) {
    const failures = []
    if (!isPlainObject(report)) {
        failures.push(`${source} report must be a plain object`)
        return { failures, scenarios: null }
    }
    if (!hasExactFields(report, REPORT_FIELDS)) failures.push(`${source} report fields differ`)
    if (report.version !== SINGLE_BATTLE_REPORT_VERSION) failures.push(`${source} version differs`)
    if (report.fixedTime !== SINGLE_BATTLE_FIXED_TIME) failures.push(`${source} fixedTime differs`)
    if (!isPlainObject(report.scenarios) || sortedOwnKeys(report.scenarios).length === 0) {
        failures.push(`${source} scenarios must be a non-empty plain object`)
        return { failures, scenarios: null }
    }
    return { failures, scenarios: report.scenarios }
}

function inspectScenario(name, scenario, source) {
    const failures = []
    if (!isPlainObject(scenario) || !hasExactFields(scenario, SCENARIO_FIELDS)) {
        failures.push(`${source}.${name} fields differ`)
        return { failures, canonical: null }
    }
    try {
        const behavior = canonicalizeBehavior(scenario.behavior)
        const summary = createBehaviorSummary(behavior)
        if (scenario.behaviorSha256 !== summary.behaviorSha256) {
            failures.push(`${source}.${name} behavior hash differs from payload`)
        }
        const sql = canonicalizeSql(scenario.sql)
        return {
            failures,
            canonical: { behavior, behaviorSha256: summary.behaviorSha256, sql },
        }
    } catch (error) {
        failures.push(`${source}.${name} is invalid: ${error.message}`)
        return { failures, canonical: null }
    }
}

function migrateSnapshotStaminaTimeSemantics(value) {
    if (Array.isArray(value)) return value.map(migrateSnapshotStaminaTimeSemantics)
    if (value === null || typeof value !== "object") return value
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => {
        if (key === "staminaHealTime") {
            if (nested === "fixture-stamina-time") return [key, "fixed-fixture-time"]
            if (nested === "start-request-time" || nested === "rank-up-settlement-time") {
                return [key, "within-request-window"]
            }
        }
        if (key === "stamina_heal_time"
            && [
                "fixture-stamina-time",
                "start-request-time",
                "rank-up-settlement-time",
            ].includes(nested)) {
            return [key, "matches-database-virtual-time"]
        }
        return [key, migrateSnapshotStaminaTimeSemantics(nested)]
    }))
}

function evaluateSingleBattleAdmission(current, snapshot, {
    allowSqlReduction = false,
    allowTimeSemanticsMigration = false,
} = {}) {
    const currentReport = inspectReport(current, "current")
    const snapshotReport = inspectReport(snapshot, "snapshot")
    const failures = [...currentReport.failures, ...snapshotReport.failures]
    if (!currentReport.scenarios || !snapshotReport.scenarios) {
        return { admitted: false, failures }
    }
    const currentNames = sortedOwnKeys(currentReport.scenarios)
    const snapshotNames = sortedOwnKeys(snapshotReport.scenarios)
    if (!isDeepStrictEqual(currentNames, snapshotNames)) failures.push("scenario set differs")
    for (const name of new Set([...currentNames, ...snapshotNames])) {
        if (!Object.hasOwn(currentReport.scenarios, name)
            || !Object.hasOwn(snapshotReport.scenarios, name)) continue
        const currentScenario = inspectScenario(name, currentReport.scenarios[name], "current")
        const snapshotScenario = inspectScenario(name, snapshotReport.scenarios[name], "snapshot")
        failures.push(...currentScenario.failures, ...snapshotScenario.failures)
        if (!currentScenario.canonical || !snapshotScenario.canonical) continue
        let snapshotBehavior = {
            behavior: snapshotScenario.canonical.behavior,
            behaviorSha256: snapshotScenario.canonical.behaviorSha256,
        }
        if (allowTimeSemanticsMigration) {
            const migratedBehavior = migrateSnapshotStaminaTimeSemantics(
                snapshotScenario.canonical.behavior,
            )
            snapshotBehavior = createBehaviorSummary(migratedBehavior)
        }
        if (!isDeepStrictEqual(
            {
                behavior: currentScenario.canonical.behavior,
                behaviorSha256: currentScenario.canonical.behaviorSha256,
            },
            snapshotBehavior,
        )) {
            failures.push(`${name} behavior differs`)
        }
        if (allowSqlReduction) {
            for (const field of STRUCTURAL_SQL_FIELDS) {
                if (currentScenario.canonical.sql[field] > snapshotScenario.canonical.sql[field]) {
                    failures.push(`${name}.${field} structural SQL regression`)
                }
            }
            const currentTables = currentScenario.canonical.sql.byTable
            const snapshotTables = snapshotScenario.canonical.sql.byTable
            for (const table of sortedOwnKeys(currentTables)) {
                if (!Object.hasOwn(snapshotTables, table)) {
                    failures.push(`${name}.byTable.${table} is a new SQL table`)
                    continue
                }
                for (const field of TABLE_FIELDS) {
                    if (currentTables[table][field] > snapshotTables[table][field]) {
                        failures.push(`${name}.byTable.${table}.${field} structural SQL regression`)
                    }
                }
            }
        } else if (!isDeepStrictEqual(
            currentScenario.canonical.sql,
            snapshotScenario.canonical.sql,
        )) {
            failures.push(`${name} SQL differs`)
        }
    }
    return { admitted: failures.length === 0, failures }
}

function writeAdmittedSnapshot(report, snapshotPath, {
    renameSync = fs.renameSync,
} = {}) {
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"))
    const admission = evaluateSingleBattleAdmission(
        report,
        snapshot,
        { allowSqlReduction: true, allowTimeSemanticsMigration: true },
    )
    if (!admission.admitted) {
        throw new Error(`Single battle snapshot admission failed:\n${admission.failures.join("\n")}`)
    }
    const targetDirectory = path.dirname(snapshotPath)
    const temporaryPath = path.join(
        targetDirectory,
        `.${path.basename(snapshotPath)}.${process.pid}.tmp`,
    )
    try {
        fs.writeFileSync(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, {
            encoding: "utf8",
            flag: "wx",
        })
        renameSync(temporaryPath, snapshotPath)
    } finally {
        try { fs.unlinkSync(temporaryPath) } catch { /* renamed or never created */ }
    }
}

module.exports = {
    SINGLE_BATTLE_FIXED_TIME,
    SINGLE_BATTLE_REPORT_VERSION,
    createSingleBattleReport,
    evaluateSingleBattleAdmission,
    writeAdmittedSnapshot,
}
