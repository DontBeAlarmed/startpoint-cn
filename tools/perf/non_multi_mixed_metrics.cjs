"use strict"

const FORMAL_INDEPENDENT_SAVES = 1000
const FORMAL_ACTIVE_IDENTITIES = 600
const FORMAL_CONCURRENCY_STEPS = Object.freeze([10, 25, 50, 100])
const ENTRY_NAMES = Object.freeze([
    "auth",
    "load",
    "mission-progress",
    "single-battle",
    "shop",
    "gacha",
    "mail",
])
const FORMAL_ENTRY_REQUESTS = Object.freeze([86, 86, 86, 86, 86, 85, 85])
const WRITE_ENTRY_NAMES = Object.freeze(["single-battle", "shop", "gacha", "mail"])
const WRITE_ENTRY_SET = new Set(WRITE_ENTRY_NAMES)

const REPORT_FIELDS = Object.freeze(["profile", "steps"])
const PROFILE_FIELDS = Object.freeze([
    "activeIdentities",
    "concurrencySteps",
    "independentSaves",
])
const STEP_FIELDS = Object.freeze([
    "concurrency",
    "entries",
    "errors",
    "latencyMs",
    "requests",
])
const ENTRY_FIELDS = Object.freeze([
    "behaviorSignatures",
    "errors",
    "latencyMs",
    "name",
    "requests",
    "rollbackVerified",
])
const LATENCY_FIELDS = Object.freeze(["p50", "p95"])

function isPlainObject(value) {
    if (value === null || typeof value !== "object") return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

function hasExactFields(value, fields) {
    const keys = Object.keys(value).sort()
    return keys.length === fields.length && keys.every((key, index) => key === fields[index])
}

function isDenseArray(value) {
    if (!Array.isArray(value) || Reflect.ownKeys(value).length !== value.length + 1) {
        return false
    }
    for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor?.enumerable || !("value" in descriptor)) return false
    }
    return true
}

function isNonNegativeSafeInteger(value) {
    return Number.isSafeInteger(value) && value >= 0
}

function isPositiveSafeInteger(value) {
    return Number.isSafeInteger(value) && value > 0
}

function validLatency(latency) {
    return isPlainObject(latency)
        && hasExactFields(latency, LATENCY_FIELDS)
        && Number.isFinite(latency.p50)
        && latency.p50 >= 0
        && Number.isFinite(latency.p95)
        && latency.p95 >= latency.p50
}

function hasExactEntryOrder(entries) {
    if (!isDenseArray(entries) || entries.length !== ENTRY_NAMES.length) return false
    for (let index = 0; index < entries.length; index++) {
        if (entries[index]?.name !== ENTRY_NAMES[index]) return false
    }
    return true
}

function hasValidBehaviorSignatures(signatures) {
    if (!isDenseArray(signatures) || signatures.length === 0) return false
    for (let index = 0; index < signatures.length; index++) {
        if (typeof signatures[index] !== "string" || signatures[index].length === 0) {
            return false
        }
    }
    return true
}

function inspectReportStructure(report) {
    if (!isPlainObject(report) || !hasExactFields(report, REPORT_FIELDS)) return null
    const profile = report.profile
    if (!isPlainObject(profile)
        || !hasExactFields(profile, PROFILE_FIELDS)
        || !isPositiveSafeInteger(profile.independentSaves)
        || !isPositiveSafeInteger(profile.activeIdentities)
        || profile.activeIdentities > profile.independentSaves
        || !isDenseArray(profile.concurrencySteps)
        || profile.concurrencySteps.length === 0
        || !isDenseArray(report.steps)
        || report.steps.length !== profile.concurrencySteps.length) {
        return null
    }
    const concurrencies = new Set()
    for (let index = 0; index < profile.concurrencySteps.length; index++) {
        const concurrency = profile.concurrencySteps[index]
        if (!isPositiveSafeInteger(concurrency)
            || concurrency > profile.activeIdentities
            || concurrencies.has(concurrency)) {
            return null
        }
        concurrencies.add(concurrency)
    }

    for (let stepIndex = 0; stepIndex < report.steps.length; stepIndex++) {
        const step = report.steps[stepIndex]
        if (!isPlainObject(step)
            || !hasExactFields(step, STEP_FIELDS)
            || step.concurrency !== profile.concurrencySteps[stepIndex]
            || !isPositiveSafeInteger(step.requests)
            || !isNonNegativeSafeInteger(step.errors)
            || step.errors > step.requests
            || !validLatency(step.latencyMs)
            || !hasExactEntryOrder(step.entries)) {
            return null
        }

        let entryRequests = 0
        let entryErrors = 0
        for (let entryIndex = 0; entryIndex < step.entries.length; entryIndex++) {
            const entry = step.entries[entryIndex]
            if (!isPlainObject(entry)
                || !hasExactFields(entry, ENTRY_FIELDS)
                || !isPositiveSafeInteger(entry.requests)
                || !isNonNegativeSafeInteger(entry.errors)
                || entry.errors > entry.requests
                || !validLatency(entry.latencyMs)
                || !hasValidBehaviorSignatures(entry.behaviorSignatures)
                || typeof entry.rollbackVerified !== "boolean"
                || !Number.isSafeInteger(entryRequests + entry.requests)
                || !Number.isSafeInteger(entryErrors + entry.errors)) {
                return null
            }
            entryRequests += entry.requests
            entryErrors += entry.errors
        }
        if (step.requests !== entryRequests || step.errors !== entryErrors) return null
    }

    return report
}

function validateReportStructure(report) {
    try {
        return inspectReportStructure(report) !== null
    } catch {
        return false
    }
}

function arraysEqual(actual, expected) {
    if (actual.length !== expected.length) return false
    for (let index = 0; index < actual.length; index++) {
        if (actual[index] !== expected[index]) return false
    }
    return true
}

function hasStableBehavior(report) {
    const expected = new Map()
    for (let stepIndex = 0; stepIndex < report.steps.length; stepIndex++) {
        const step = report.steps[stepIndex]
        for (let entryIndex = 0; entryIndex < step.entries.length; entryIndex++) {
            const entry = step.entries[entryIndex]
            if (entry.behaviorSignatures.length !== 1) return false
            const signature = entry.behaviorSignatures[0]
            if (expected.has(entry.name) && expected.get(entry.name) !== signature) return false
            expected.set(entry.name, signature)
        }
    }
    return expected.size === ENTRY_NAMES.length
}

function isFormalLoadProfile(report) {
    if (report.profile.independentSaves !== FORMAL_INDEPENDENT_SAVES
        || report.profile.activeIdentities !== FORMAL_ACTIVE_IDENTITIES
        || !arraysEqual(report.profile.concurrencySteps, FORMAL_CONCURRENCY_STEPS)
        || report.steps.length !== FORMAL_CONCURRENCY_STEPS.length) {
        return false
    }
    for (let stepIndex = 0; stepIndex < report.steps.length; stepIndex++) {
        const step = report.steps[stepIndex]
        if (step.concurrency !== FORMAL_CONCURRENCY_STEPS[stepIndex]
            || step.requests !== FORMAL_ACTIVE_IDENTITIES) {
            return false
        }
        for (let entryIndex = 0; entryIndex < ENTRY_NAMES.length; entryIndex++) {
            if (step.entries[entryIndex].requests !== FORMAL_ENTRY_REQUESTS[entryIndex]) {
                return false
            }
        }
    }
    return true
}

function createAdmissionGate(report) {
    try {
        const inspected = inspectReportStructure(report)
        if (inspected === null) throw new Error("invalid mixed-load report")

        let zeroErrors = true
        let rollbackVerified = true
        for (let stepIndex = 0; stepIndex < inspected.steps.length; stepIndex++) {
            const step = inspected.steps[stepIndex]
            if (step.errors !== 0) zeroErrors = false
            for (let entryIndex = 0; entryIndex < step.entries.length; entryIndex++) {
                const entry = step.entries[entryIndex]
                if (WRITE_ENTRY_SET.has(entry.name) && !entry.rollbackVerified) {
                    rollbackVerified = false
                }
            }
        }
        const gate = {
            reportStructureValid: true,
            zeroErrors,
            behaviorStable: hasStableBehavior(inspected),
            rollbackVerified,
            loadProfileValid: isFormalLoadProfile(inspected),
        }
        return { ...gate, admitted: Object.values(gate).every(Boolean) }
    } catch {
        return {
            reportStructureValid: false,
            zeroErrors: false,
            behaviorStable: false,
            rollbackVerified: false,
            loadProfileValid: false,
            admitted: false,
        }
    }
}

module.exports = {
    ENTRY_NAMES,
    FORMAL_ACTIVE_IDENTITIES,
    FORMAL_CONCURRENCY_STEPS,
    FORMAL_ENTRY_REQUESTS,
    FORMAL_INDEPENDENT_SAVES,
    WRITE_ENTRY_NAMES,
    createAdmissionGate,
    validateReportStructure,
}
