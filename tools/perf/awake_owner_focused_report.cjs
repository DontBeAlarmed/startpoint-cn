"use strict"

const crypto = require("node:crypto")
const { isDeepStrictEqual, types } = require("node:util")

const {
    AWAKE_OWNER_FOCUSED_SCENARIO_KEYS,
    AWAKE_OWNER_RUNTIME_EVIDENCE_REGISTRY,
    AWAKE_OWNER_SQL_UPPER_BOUND_REGISTRY,
    SINGLE_REREAD_REASON,
} = require("./awake_owner_focused_scenarios.cjs")

const AWAKE_OWNER_FOCUSED_FIXED_TIME = "2024-08-14T12:00:00.000Z"
const AWAKE_OWNER_FOCUSED_REPORT_VERSION = 1
const REPORT_FIELDS = ["evidenceRegistry", "fixedTime", "scenarios", "sqlUpperBounds", "version"]
const INPUT_SCENARIO_FIELDS = [
    "characterSeeds", "dbAfter", "dbBefore", "directMissionSeeds", "factSeeds",
    "freshPostWriteEvaluationRequired", "loaderCalls", "missionComputes", "rereadReason",
    "request", "response", "snapshotSource", "sqlByTable", "sqlReads", "sqlWrites",
]
const CHECKED_SCENARIO_FIELDS = [...INPUT_SCENARIO_FIELDS, "behaviorSha256"].sort()
const TABLE_FIELDS = ["reads", "statements", "writes"]

function assertDataObject(value, path) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError(`${path} must be a plain object`)
    }
    if (types.isProxy(value)) throw new TypeError(`${path} must not be a Proxy`)
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`${path} must use a plain object prototype`)
    }
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string") throw new TypeError(`${path} must not contain Symbol keys`)
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor?.enumerable || !("value" in descriptor)) {
            throw new TypeError(`${path}.${key} must be an enumerable data value`)
        }
    }
}

function assertExactFields(value, fields, path) {
    assertDataObject(value, path)
    const actual = Object.keys(value).sort()
    const expected = [...fields].sort()
    if (!isDeepStrictEqual(actual, expected)) {
        throw new TypeError(`${path} fields differ: ${actual.join(",")}`)
    }
}

function canonicalize(value, path, ancestors = new Set()) {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value)) throw new TypeError(`${path} must contain safe integers`)
        return value
    }
    if (typeof value !== "object") throw new TypeError(`${path} contains unsupported data`)
    if (ancestors.has(value)) throw new TypeError(`${path} must not contain cycles`)
    ancestors.add(value)
    try {
        if (Array.isArray(value)) {
            return Array.from({ length: value.length }, (_unused, index) => {
                if (!Object.hasOwn(value, index)) throw new TypeError(`${path} must not be sparse`)
                return canonicalize(value[index], `${path}[${index}]`, ancestors)
            })
        }
        assertDataObject(value, path)
        return Object.fromEntries(Object.keys(value).sort().map(key => [
            key,
            canonicalize(value[key], `${path}.${key}`, ancestors),
        ]))
    } finally {
        ancestors.delete(value)
    }
}

function metric(value, path) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${path} must be a non-negative integer`)
    return value
}

function sortedUniqueStrings(value, path) {
    if (!Array.isArray(value) || value.some(entry => typeof entry !== "string" || entry.length === 0)) {
        throw new TypeError(`${path} must be an array of non-empty strings`)
    }
    const sorted = [...new Set(value)].sort()
    if (!isDeepStrictEqual(value, sorted)) throw new TypeError(`${path} must be normalized and unique`)
    return sorted
}

function stringList(value, path) {
    if (!Array.isArray(value) || value.some(entry => typeof entry !== "string" || entry.length === 0)) {
        throw new TypeError(`${path} must be an array of non-empty strings`)
    }
    return [...value]
}

function sortedUniqueIds(value, path) {
    if (!Array.isArray(value) || value.some(entry => !Number.isSafeInteger(entry) || entry <= 0)) {
        throw new TypeError(`${path} must be an array of positive integer IDs`)
    }
    const sorted = [...new Set(value)].sort((left, right) => left - right)
    if (!isDeepStrictEqual(value, sorted)) throw new TypeError(`${path} must be normalized and unique`)
    return sorted
}

function canonicalizeSql(sqlByTable, sqlReads, sqlWrites, path) {
    assertDataObject(sqlByTable, path)
    let readTotal = 0
    let writeTotal = 0
    const result = Object.fromEntries(Object.keys(sqlByTable).sort().map(table => {
        if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new TypeError(`${path}.${table} is not a stable table name`)
        const row = sqlByTable[table]
        assertExactFields(row, TABLE_FIELDS, `${path}.${table}`)
        const reads = metric(row.reads, `${path}.${table}.reads`)
        const writes = metric(row.writes, `${path}.${table}.writes`)
        const statements = metric(row.statements, `${path}.${table}.statements`)
        if (statements < Math.max(reads, writes) || statements > reads + writes) {
            throw new TypeError(`${path}.${table} statement totals are inconsistent`)
        }
        readTotal += reads
        writeTotal += writes
        return [table, { reads, statements, writes }]
    }))
    if (readTotal < sqlReads || writeTotal !== sqlWrites) {
        throw new TypeError(`${path} totals are inconsistent with scenario SQL metrics`)
    }
    return result
}

function behaviorHash(request, response) {
    return crypto.createHash("sha256")
        .update(JSON.stringify({ request, response }))
        .digest("hex")
}

function canonicalizeScenario(input, path, checked) {
    assertExactFields(input, checked ? CHECKED_SCENARIO_FIELDS : INPUT_SCENARIO_FIELDS, path)
    const request = canonicalize(input.request, `${path}.request`)
    const response = canonicalize(input.response, `${path}.response`)
    const sqlReads = metric(input.sqlReads, `${path}.sqlReads`)
    const sqlWrites = metric(input.sqlWrites, `${path}.sqlWrites`)
    const missionComputes = metric(input.missionComputes, `${path}.missionComputes`)
    if (input.snapshotSource !== "none") throw new TypeError(`${path}.snapshotSource must be none until a snapshot is injected`)
    if (typeof input.rereadReason !== "string" || input.rereadReason.length === 0) {
        throw new TypeError(`${path}.rereadReason must be specific`)
    }
    if (typeof input.freshPostWriteEvaluationRequired !== "boolean") {
        throw new TypeError(`${path}.freshPostWriteEvaluationRequired must be boolean`)
    }
    const result = {
        request,
        response,
        behaviorSha256: behaviorHash(request, response),
        dbBefore: canonicalize(input.dbBefore, `${path}.dbBefore`),
        dbAfter: canonicalize(input.dbAfter, `${path}.dbAfter`),
        characterSeeds: sortedUniqueIds(input.characterSeeds, `${path}.characterSeeds`),
        factSeeds: sortedUniqueStrings(input.factSeeds, `${path}.factSeeds`),
        directMissionSeeds: sortedUniqueIds(input.directMissionSeeds, `${path}.directMissionSeeds`),
        loaderCalls: stringList(input.loaderCalls, `${path}.loaderCalls`),
        missionComputes,
        snapshotSource: input.snapshotSource,
        rereadReason: input.rereadReason,
        freshPostWriteEvaluationRequired: input.freshPostWriteEvaluationRequired,
        sqlReads,
        sqlWrites,
        sqlByTable: canonicalizeSql(input.sqlByTable, sqlReads, sqlWrites, `${path}.sqlByTable`),
    }
    if (checked && input.behaviorSha256 !== result.behaviorSha256) {
        throw new TypeError(`${path}.behaviorSha256 does not match request/response`)
    }
    return result
}

function assertScenarioSet(scenarios, path) {
    assertDataObject(scenarios, path)
    if (!isDeepStrictEqual(Object.keys(scenarios), AWAKE_OWNER_FOCUSED_SCENARIO_KEYS)) {
        throw new TypeError(`${path} differs from the fixed owner-focused scenario set`)
    }
}

function assertSingleContract(scenarios, path) {
    const single = scenarios["single-finish"]
    if (single.snapshotSource !== "none"
        || single.rereadReason !== SINGLE_REREAD_REASON
        || single.freshPostWriteEvaluationRequired !== true) {
        throw new TypeError(`${path}.single-finish violates the fixed fresh post-write contract`)
    }
    if (single.response.category9Evaluations !== 2) {
        throw new TypeError(`${path}.single-finish must record exactly two Category 9 evaluations`)
    }
}

function registryView() {
    return canonicalize(AWAKE_OWNER_RUNTIME_EVIDENCE_REGISTRY, "evidenceRegistry")
}

function upperBoundView() {
    return canonicalize(AWAKE_OWNER_SQL_UPPER_BOUND_REGISTRY, "sqlUpperBounds")
}

function createAwakeOwnerFocusedReport(scenarios) {
    assertScenarioSet(scenarios, "scenarios")
    const canonicalScenarios = Object.fromEntries(AWAKE_OWNER_FOCUSED_SCENARIO_KEYS.map(name => [
        name,
        canonicalizeScenario(scenarios[name], `scenarios.${name}`, false),
    ]))
    assertSingleContract(canonicalScenarios, "scenarios")
    return {
        version: AWAKE_OWNER_FOCUSED_REPORT_VERSION,
        fixedTime: AWAKE_OWNER_FOCUSED_FIXED_TIME,
        evidenceRegistry: registryView(),
        sqlUpperBounds: upperBoundView(),
        scenarios: canonicalScenarios,
    }
}

function canonicalizeCheckedAwakeOwnerFocusedReport(report, source) {
    assertExactFields(report, REPORT_FIELDS, source)
    if (report.version !== AWAKE_OWNER_FOCUSED_REPORT_VERSION
        || report.fixedTime !== AWAKE_OWNER_FOCUSED_FIXED_TIME) {
        throw new TypeError(`${source} report identity differs from the fixed contract`)
    }
    if (!isDeepStrictEqual(canonicalize(report.evidenceRegistry, `${source}.evidenceRegistry`), registryView())
        || !isDeepStrictEqual(canonicalize(report.sqlUpperBounds, `${source}.sqlUpperBounds`), upperBoundView())) {
        throw new TypeError(`${source} evidence registry differs from the fixed contract`)
    }
    assertScenarioSet(report.scenarios, `${source}.scenarios`)
    const scenarios = Object.fromEntries(AWAKE_OWNER_FOCUSED_SCENARIO_KEYS.map(name => [
        name,
        canonicalizeScenario(report.scenarios[name], `${source}.scenarios.${name}`, true),
    ]))
    assertSingleContract(scenarios, `${source}.scenarios`)
    return {
        version: AWAKE_OWNER_FOCUSED_REPORT_VERSION,
        fixedTime: AWAKE_OWNER_FOCUSED_FIXED_TIME,
        evidenceRegistry: registryView(),
        sqlUpperBounds: upperBoundView(),
        scenarios,
    }
}

module.exports = {
    AWAKE_OWNER_FOCUSED_FIXED_TIME,
    AWAKE_OWNER_FOCUSED_REPORT_VERSION,
    canonicalizeCheckedAwakeOwnerFocusedReport,
    createAwakeOwnerFocusedReport,
}
