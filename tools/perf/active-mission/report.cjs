"use strict"

const {
    describeActiveMissionFixture,
} = require("./fixture.cjs")

const ACTIVE_MISSION_REPORT_VERSION = 1
const REPORT_FIELDS = Object.freeze([
    "behaviorHash",
    "factLoaders",
    "fixture",
    "structural",
    "unsupportedMissionIds",
    "version",
])
const STRUCTURAL_METRICS = Object.freeze([
    "sqlReads",
    "sqlWrites",
    "definitionVisits",
    "loaderCalls",
    "staticComputes",
    "dependencyComputes",
])
const FIXTURE_FIELDS = Object.freeze(["name", "profile", "scale"])
const RESERVED_FACT_LOADER_NAMES = new Set(["__proto__", "constructor", "prototype"])

function isPlainObject(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

function isNonNegativeSafeInteger(value) {
    return Number.isSafeInteger(value) && value >= 0
}

function isDenseArray(value) {
    return Array.isArray(value)
        && Object.keys(value).length === value.length
        && Object.keys(value).every(key => String(Number(key)) === key)
}

function deepFreeze(value) {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value
    for (const nested of Object.values(value)) deepFreeze(nested)
    return Object.freeze(value)
}

function normalizeMissionIds(value) {
    if (!isDenseArray(value)) throw new TypeError("unsupportedMissionIds must be a dense array")
    const ids = value.map(id => {
        if (!isNonNegativeSafeInteger(id)) {
            throw new TypeError("unsupportedMissionIds must contain non-negative safe integers")
        }
        return id
    }).sort((left, right) => left - right)
    for (let index = 1; index < ids.length; index++) {
        if (ids[index] === ids[index - 1]) throw new TypeError("unsupportedMissionIds must be unique")
    }
    return ids
}

function normalizeFactLoaders(value) {
    if (!isPlainObject(value)) throw new TypeError("factLoaders must be a plain object")
    const result = Object.create(null)
    for (const name of Object.keys(value).sort()) {
        if (RESERVED_FACT_LOADER_NAMES.has(name)) {
            throw new TypeError(`fact loader name ${name} is reserved`)
        }
        const loader = value[name]
        if (!isPlainObject(loader)
            || Object.keys(loader).sort().join(",") !== "calls,rows"
            || !isNonNegativeSafeInteger(loader.calls)
            || !isNonNegativeSafeInteger(loader.rows)) {
            throw new TypeError(`fact loader ${name} is malformed`)
        }
        result[name] = { calls: loader.calls, rows: loader.rows }
    }
    return result
}

function normalizeFixture(value) {
    if (!isPlainObject(value)) throw new TypeError("fixture must be a plain object")
    const expected = describeActiveMissionFixture(value.profile ?? value.name)
    if (Object.keys(value).sort().join(",") !== [...FIXTURE_FIELDS].sort().join(",")
        || FIXTURE_FIELDS.some(field => value[field] !== expected[field])) {
        throw new TypeError("fixture does not match the active mission scale contract")
    }
    return { ...expected }
}

function normalizeStructural(value, factLoaders) {
    if (!isPlainObject(value)) throw new TypeError("structural must be a plain object")
    if (Object.keys(value).sort().join(",") !== [...STRUCTURAL_METRICS].sort().join(",")) {
        throw new TypeError("structural fields are incomplete or unexpected")
    }
    const structural = {}
    for (const metric of STRUCTURAL_METRICS) {
        if (!isNonNegativeSafeInteger(value[metric])) {
            throw new TypeError(`${metric} must be a non-negative safe integer`)
        }
        structural[metric] = value[metric]
    }
    const loaderCalls = Object.values(factLoaders)
        .reduce((total, loader) => total + loader.calls, 0)
    if (structural.loaderCalls !== loaderCalls) {
        throw new TypeError("loaderCalls contradicts factLoaders")
    }
    return structural
}

function canonicalizeActiveMissionReport(report) {
    if (!isPlainObject(report)) throw new TypeError("active mission report must be a plain object")
    if (Object.keys(report).sort().join(",") !== [...REPORT_FIELDS].sort().join(",")) {
        throw new TypeError("active mission report fields are incomplete or unexpected")
    }
    if (report.version !== ACTIVE_MISSION_REPORT_VERSION) throw new TypeError("unsupported report version")
    if (typeof report.behaviorHash !== "string" || !/^[a-f0-9]{64}$/.test(report.behaviorHash)) {
        throw new TypeError("behaviorHash must be a lowercase 64-character hash")
    }
    const unsupportedMissionIds = normalizeMissionIds(report.unsupportedMissionIds)
    const factLoaders = normalizeFactLoaders(report.factLoaders)
    const fixture = normalizeFixture(report.fixture)
    const structural = normalizeStructural(report.structural, factLoaders)
    return deepFreeze({
        version: report.version,
        fixture,
        behaviorHash: report.behaviorHash,
        unsupportedMissionIds: Object.freeze(unsupportedMissionIds),
        factLoaders,
        structural,
    })
}

function createActiveMissionReport({
    behaviorHash,
    fixture,
    observer,
    observerSnapshot,
    structural,
    unsupportedMissionIds,
}) {
    const metrics = observerSnapshot ?? observer?.snapshot?.()
    if (!isPlainObject(metrics)) throw new TypeError("observer snapshot is required")
    const factLoaders = normalizeFactLoaders(metrics.factLoaders)
    const report = {
        version: ACTIVE_MISSION_REPORT_VERSION,
        fixture: describeActiveMissionFixture(fixture),
        behaviorHash,
        unsupportedMissionIds,
        factLoaders,
        structural: {
            ...structural,
            definitionVisits: metrics.definitionVisits,
            loaderCalls: Object.values(factLoaders).reduce((total, loader) => total + loader.calls, 0),
            staticComputes: metrics.staticComputes,
            dependencyComputes: metrics.dependencyComputes,
        },
    }
    return canonicalizeActiveMissionReport(report)
}

function inspectActiveMissionReport(report) {
    try {
        return { valid: true, report: canonicalizeActiveMissionReport(report), failures: [] }
    } catch (error) {
        return {
            valid: false,
            report: null,
            failures: [error instanceof Error ? error.message : "malformed active mission report"],
        }
    }
}

module.exports = {
    ACTIVE_MISSION_REPORT_VERSION,
    REPORT_FIELDS,
    STRUCTURAL_METRICS,
    canonicalizeActiveMissionReport,
    createActiveMissionReport,
    inspectActiveMissionReport,
    isDenseArray,
    isNonNegativeSafeInteger,
    isPlainObject,
}
