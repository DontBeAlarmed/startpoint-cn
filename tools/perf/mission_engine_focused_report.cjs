"use strict"

const crypto = require("node:crypto")
const { isDeepStrictEqual } = require("node:util")

const FOCUSED_REPORT_VERSION = 1
const FOCUSED_FIXED_TIME = "2025-01-01T12:00:00.000Z"
const REPORT_FIELDS = Object.freeze(["fixedTime", "scenarios", "version"])
const SCENARIO_FIELDS = Object.freeze([
    "behavior",
    "behaviorSha256",
    "missionComputes",
    "sqlReads",
    "sqlWrites",
])
const STRUCTURAL_METRICS = Object.freeze([
    "sqlReads",
    "sqlWrites",
    "missionComputes",
])
const CANONICAL_REPORT = Symbol("canonical-focused-mission-report")

function isPlainObject(value) {
    if (value === null || typeof value !== "object") return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

function sortedOwnKeys(value) {
    return Object.keys(value).sort()
}

function hasExactFields(value, expectedFields) {
    return isDeepStrictEqual(sortedOwnKeys(value), expectedFields)
}

function canonicalizeBehavior(value) {
    const ancestors = new WeakSet()

    function visit(current, path) {
        if (current === null || typeof current === "boolean" || typeof current === "string") {
            return current
        }
        if (typeof current === "number") {
            if (!Number.isFinite(current)) {
                throw new TypeError(`${path} must be a finite number`)
            }
            return Object.is(current, -0) ? 0 : current
        }
        if (typeof current !== "object") {
            throw new TypeError(`${path} contains unsupported ${typeof current}`)
        }
        if (!Array.isArray(current) && !isPlainObject(current)) {
            throw new TypeError(`${path} must contain only arrays and plain objects`)
        }
        if (ancestors.has(current)) throw new TypeError(`${path} contains a circular reference`)

        ancestors.add(current)
        try {
            if (Array.isArray(current)) {
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

            const keys = Reflect.ownKeys(current)
            for (const key of keys) {
                if (typeof key !== "string") {
                    throw new TypeError(`${path} contains a Symbol key`)
                }
                const descriptor = Object.getOwnPropertyDescriptor(current, key)
                if (!descriptor?.enumerable || !("value" in descriptor)) {
                    throw new TypeError(`${path}.${key} must be an enumerable data value`)
                }
            }
            return Object.fromEntries(keys.sort()
                .map(key => [key, visit(current[key], `${path}.${key}`)]))
        } finally {
            ancestors.delete(current)
        }
    }

    return visit(value, "behavior")
}

function createBehaviorSummary(behavior) {
    const stableBehavior = canonicalizeBehavior(behavior)
    return {
        behavior: stableBehavior,
        behaviorSha256: crypto.createHash("sha256")
            .update(JSON.stringify(stableBehavior))
            .digest("hex"),
    }
}

function validMetric(value) {
    return Number.isSafeInteger(value) && value >= 0
}

function createCanonicalFocusedReport(report, behaviorSummaries) {
    const scenarios = Object.fromEntries(Object.keys(report.scenarios).map(name => {
        const scenario = report.scenarios[name]
        const behaviorSummary = behaviorSummaries.get(name)
        if (behaviorSummary === undefined) {
            throw new TypeError(`missing canonical behavior for scenario ${name}`)
        }
        return [name, {
            sqlReads: scenario.sqlReads,
            sqlWrites: scenario.sqlWrites,
            missionComputes: scenario.missionComputes,
            behavior: behaviorSummary.behavior,
            behaviorSha256: behaviorSummary.behaviorSha256,
        }]
    }))
    const canonicalReport = {
        version: report.version,
        fixedTime: report.fixedTime,
        scenarios,
    }
    Object.defineProperty(canonicalReport, CANONICAL_REPORT, { value: true })
    return canonicalReport
}

function assertCanonicalFocusedReport(report) {
    if (report?.[CANONICAL_REPORT] !== true) {
        throw new TypeError("snapshot writer requires a validated canonical focused report")
    }
}

function inspectFocusedReportEnvelope(report, source) {
    const failures = []
    if (!isPlainObject(report)) {
        failures.push({
            type: "report-schema",
            scenario: source,
            metric: "report",
            actual: report,
            expected: "plain object",
            reason: `${source} report must be a plain object`,
        })
        return { failures, scenarios: null }
    }
    if (!hasExactFields(report, REPORT_FIELDS)) {
        failures.push({
            type: "report-schema",
            scenario: source,
            metric: "fields",
            actual: sortedOwnKeys(report),
            expected: REPORT_FIELDS,
            reason: `${source} report must contain exactly the checked fields`,
        })
    }
    if (report.version !== FOCUSED_REPORT_VERSION) {
        failures.push({
            type: "metadata",
            scenario: source,
            metric: "version",
            actual: report.version,
            expected: FOCUSED_REPORT_VERSION,
            reason: `${source} report version differs from the focused contract`,
        })
    }
    if (report.fixedTime !== FOCUSED_FIXED_TIME) {
        failures.push({
            type: "metadata",
            scenario: source,
            metric: "fixedTime",
            actual: report.fixedTime,
            expected: FOCUSED_FIXED_TIME,
            reason: `${source} report fixedTime differs from the focused contract`,
        })
    }
    if (!isPlainObject(report.scenarios) || sortedOwnKeys(report.scenarios).length === 0) {
        failures.push({
            type: "report-schema",
            scenario: source,
            metric: "scenarios",
            actual: report.scenarios,
            expected: "non-empty plain object",
            reason: `${source} report scenarios must be a non-empty plain object`,
        })
        return { failures, scenarios: null }
    }
    return { failures, scenarios: report.scenarios }
}

module.exports = {
    FOCUSED_FIXED_TIME,
    FOCUSED_REPORT_VERSION,
    REPORT_FIELDS,
    SCENARIO_FIELDS,
    STRUCTURAL_METRICS,
    assertCanonicalFocusedReport,
    canonicalizeBehavior,
    createCanonicalFocusedReport,
    createBehaviorSummary,
    hasExactFields,
    inspectFocusedReportEnvelope,
    isPlainObject,
    sortedOwnKeys,
    validMetric,
}
