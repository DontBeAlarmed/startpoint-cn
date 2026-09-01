"use strict"

const crypto = require("node:crypto")
const { isDeepStrictEqual, types } = require("node:util")

const AWAKE_REQUEST_CONTEXT_REPORT_VERSION = 1
const AWAKE_REQUEST_CONTEXT_FIXED_TIME = "2025-01-01T12:00:00.000Z"
const AWAKE_REQUEST_CONTEXT_SCENARIO_KEYS = Object.freeze([
    "full-publication",
    "candidate-one",
    "empty-candidate-permanent-unlock",
    "strict-failure-rollback",
    "best-effort-failure",
])
const REPORT_FIELDS = Object.freeze(["fixedTime", "scenarios", "version"])
const INPUT_SCENARIO_FIELDS = Object.freeze([
    "behavior",
    "missionComputes",
    "sqlByTable",
    "sqlReads",
    "sqlWrites",
])
const SCENARIO_FIELDS = Object.freeze([
    "behavior",
    "behaviorSha256",
    "missionComputes",
    "sqlByTable",
    "sqlReads",
    "sqlWrites",
])
const TABLE_FIELDS = Object.freeze(["reads", "statements", "writes"])
const STRUCTURAL_METRICS = Object.freeze(["sqlReads", "sqlWrites", "missionComputes"])
const CANONICAL_REPORT = Symbol("canonical-awake-request-context-report")

function sortedOwnKeys(value) {
    return Object.keys(value).sort()
}

function assertDataObject(value, path, { allowCanonicalMarker = false } = {}) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError(`${path} must be a plain object`)
    }
    if (types.isProxy(value)) throw new TypeError(`${path} must not be a Proxy`)
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`${path} must use a plain object prototype`)
    }
    for (const key of Reflect.ownKeys(value)) {
        if (key === CANONICAL_REPORT && allowCanonicalMarker) {
            const marker = Object.getOwnPropertyDescriptor(value, key)
            if (!marker || marker.enumerable || !("value" in marker) || marker.value !== true) {
                throw new TypeError(`${path} contains an invalid canonical marker`)
            }
            continue
        }
        if (typeof key !== "string") throw new TypeError(`${path} must not contain Symbol keys`)
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor?.enumerable || !("value" in descriptor)) {
            throw new TypeError(`${path}.${key} must be an enumerable data value`)
        }
    }
    return value
}

function assertExactFields(value, expected, path, options) {
    assertDataObject(value, path, options)
    const actual = sortedOwnKeys(value)
    if (!isDeepStrictEqual(actual, expected)) {
        throw new TypeError(`${path} fields differ: ${actual.join(",")}`)
    }
}

function assertMetric(value, path) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${path} must be a non-negative safe integer`)
    }
    return value
}

function canonicalizeBehavior(value) {
    const ancestors = new WeakSet()

    function visit(current, path) {
        if (current === null || typeof current === "boolean" || typeof current === "string") {
            return current
        }
        if (typeof current === "number") return assertMetric(current, path)
        if (typeof current !== "object") {
            throw new TypeError(`${path} contains unsupported ${typeof current}`)
        }
        if (types.isProxy(current)) throw new TypeError(`${path} must not contain a Proxy`)
        if (ancestors.has(current)) throw new TypeError(`${path} contains a circular reference`)
        ancestors.add(current)
        try {
            if (Array.isArray(current)) {
                if (Object.getPrototypeOf(current) !== Array.prototype) {
                    throw new TypeError(`${path} must use the standard Array prototype`)
                }
                for (const key of Reflect.ownKeys(current)) {
                    if (key === "length") continue
                    if (typeof key !== "string"
                        || !/^(?:0|[1-9][0-9]*)$/.test(key)
                        || Number(key) >= current.length) {
                        throw new TypeError(`${path} contains a non-JSON array property`)
                    }
                    const descriptor = Object.getOwnPropertyDescriptor(current, key)
                    if (!descriptor?.enumerable || !("value" in descriptor)) {
                        throw new TypeError(`${path}[${key}] must be an enumerable data value`)
                    }
                }
                return Array.from({ length: current.length }, (_unused, index) => {
                    if (!Object.hasOwn(current, index)) {
                        throw new TypeError(`${path}[${index}] must not be sparse`)
                    }
                    return visit(current[index], `${path}[${index}]`)
                })
            }
            assertDataObject(current, path)
            return Object.fromEntries(sortedOwnKeys(current)
                .map(key => [key, visit(current[key], `${path}.${key}`)]))
        } finally {
            ancestors.delete(current)
        }
    }

    return visit(value, "behavior")
}

function createBehaviorSummary(behavior) {
    const canonicalBehavior = canonicalizeBehavior(behavior)
    return {
        behavior: canonicalBehavior,
        behaviorSha256: crypto.createHash("sha256")
            .update(JSON.stringify(canonicalBehavior))
            .digest("hex"),
    }
}

function canonicalizeSqlByTable(sqlByTable, sqlReads, sqlWrites, path) {
    assertDataObject(sqlByTable, path)
    let writeTotal = 0
    const tables = Object.fromEntries(sortedOwnKeys(sqlByTable).map(table => {
        if (!/^[a-z_][a-z0-9_]*$/.test(table)) {
            throw new TypeError(`${path}.${table} is not a stable SQL table name`)
        }
        const tablePath = `${path}.${table}`
        const metrics = sqlByTable[table]
        assertExactFields(metrics, TABLE_FIELDS, tablePath)
        const reads = assertMetric(metrics.reads, `${tablePath}.reads`)
        const writes = assertMetric(metrics.writes, `${tablePath}.writes`)
        const statements = assertMetric(metrics.statements, `${tablePath}.statements`)
        if (reads > sqlReads || writes > sqlWrites) {
            throw new TypeError(`${tablePath} SQL metrics exceed the scenario summary`)
        }
        if (statements < Math.max(reads, writes) || statements > reads + writes) {
            throw new TypeError(`${tablePath} SQL statement metrics are inconsistent`)
        }
        writeTotal += writes
        return [table, { reads, writes, statements }]
    }))
    if (writeTotal !== sqlWrites) {
        throw new TypeError(`${path} SQL write totals are inconsistent`)
    }
    return tables
}

function canonicalizeScenario(scenario, path, { includesHash }) {
    assertExactFields(
        scenario,
        includesHash ? SCENARIO_FIELDS : INPUT_SCENARIO_FIELDS,
        path,
    )
    const sqlReads = assertMetric(scenario.sqlReads, `${path}.sqlReads`)
    const sqlWrites = assertMetric(scenario.sqlWrites, `${path}.sqlWrites`)
    const missionComputes = assertMetric(scenario.missionComputes, `${path}.missionComputes`)
    const sqlByTable = canonicalizeSqlByTable(
        scenario.sqlByTable,
        sqlReads,
        sqlWrites,
        `${path}.sqlByTable`,
    )
    if (scenario.behavior === null
        || typeof scenario.behavior !== "object"
        || Array.isArray(scenario.behavior)) {
        throw new TypeError(`${path}.behavior must be a non-array object`)
    }
    const behaviorSummary = createBehaviorSummary(scenario.behavior)
    if (includesHash
        && (typeof scenario.behaviorSha256 !== "string"
            || !/^[a-f0-9]{64}$/.test(scenario.behaviorSha256))) {
        throw new TypeError(`${path}.behaviorSha256 must be a lowercase SHA-256`)
    }
    return {
        sqlReads,
        sqlWrites,
        missionComputes,
        sqlByTable,
        ...behaviorSummary,
    }
}

function assertScenarioSet(scenarios, path) {
    assertDataObject(scenarios, path)
    const actual = sortedOwnKeys(scenarios)
    const expected = [...AWAKE_REQUEST_CONTEXT_SCENARIO_KEYS].sort()
    if (!isDeepStrictEqual(actual, expected)) {
        throw new TypeError(`${path} differs from the fixed Awake request-context scenario set`)
    }
}

function brandCanonicalReport(report) {
    Object.defineProperty(report, CANONICAL_REPORT, { value: true })
    return report
}

function createAwakeRequestContextReport(scenarios) {
    assertScenarioSet(scenarios, "scenarios")
    const canonicalScenarios = Object.fromEntries(AWAKE_REQUEST_CONTEXT_SCENARIO_KEYS.map(name => [
        name,
        canonicalizeScenario(scenarios[name], `scenarios.${name}`, { includesHash: false }),
    ]))
    return brandCanonicalReport({
        version: AWAKE_REQUEST_CONTEXT_REPORT_VERSION,
        fixedTime: AWAKE_REQUEST_CONTEXT_FIXED_TIME,
        scenarios: canonicalScenarios,
    })
}

function canonicalizeCheckedReport(report, source) {
    assertExactFields(report, REPORT_FIELDS, source, { allowCanonicalMarker: true })
    if (report.version !== AWAKE_REQUEST_CONTEXT_REPORT_VERSION) {
        throw new TypeError(`${source}.version differs from the fixed contract`)
    }
    if (report.fixedTime !== AWAKE_REQUEST_CONTEXT_FIXED_TIME) {
        throw new TypeError(`${source}.fixedTime differs from the fixed contract`)
    }
    assertScenarioSet(report.scenarios, `${source}.scenarios`)
    const hashMismatches = []
    const scenarios = Object.fromEntries(AWAKE_REQUEST_CONTEXT_SCENARIO_KEYS.map(name => {
        const path = `${source}.scenarios.${name}`
        const canonical = canonicalizeScenario(report.scenarios[name], path, { includesHash: true })
        if (report.scenarios[name].behaviorSha256 !== canonical.behaviorSha256) {
            hashMismatches.push(name)
        }
        return [name, canonical]
    }))
    return {
        report: brandCanonicalReport({
            version: AWAKE_REQUEST_CONTEXT_REPORT_VERSION,
            fixedTime: AWAKE_REQUEST_CONTEXT_FIXED_TIME,
            scenarios,
        }),
        hashMismatches,
    }
}

module.exports = {
    AWAKE_REQUEST_CONTEXT_FIXED_TIME,
    AWAKE_REQUEST_CONTEXT_REPORT_VERSION,
    AWAKE_REQUEST_CONTEXT_SCENARIO_KEYS,
    SCENARIO_FIELDS,
    STRUCTURAL_METRICS,
    TABLE_FIELDS,
    canonicalizeCheckedReport,
    createAwakeRequestContextReport,
    createBehaviorSummary,
}
