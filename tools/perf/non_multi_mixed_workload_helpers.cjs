"use strict"

const crypto = require("node:crypto")

const {
    ENTRY_NAMES,
    WRITE_ENTRY_NAMES,
} = require("./non_multi_mixed_metrics.cjs")
const { summarizeLatencies } = require("./mission_entry_load_metrics.cjs")

const OMITTED_BEHAVIOR_KEYS = /^(?:account|device|player|viewer)(?:_?id)?$|^(?:seed|time|timestamp|date)$/i
const OMITTED_BEHAVIOR_CONTAINERS = /^(?:payload|raw|response|request)$/i

function round(value) {
    return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0
}

function canonicalize(value, key = "") {
    if (OMITTED_BEHAVIOR_KEYS.test(key) || OMITTED_BEHAVIOR_CONTAINERS.test(key)) return undefined
    if (Array.isArray(value)) return value.map(item => canonicalize(item)).filter(item => item !== undefined)
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.keys(value).sort().flatMap(childKey => {
            const child = canonicalize(value[childKey], childKey)
            return child === undefined ? [] : [[childKey, child]]
        }))
    }
    return value
}

function canonicalJson(value) {
    return JSON.stringify(canonicalize(value))
}

function behaviorSignature(value) {
    return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex")
}

function delayMilliseconds(nanoseconds) {
    return round(Number(nanoseconds) / 1_000_000)
}

function summarizeEntries(results, rollbackVerification) {
    return ENTRY_NAMES.map(name => {
        const samples = results.filter(result => result.entry === name)
        const errors = samples.filter(result => result.error !== null)
        const signatures = [...new Set(samples
            .map(result => result.behaviorSignature)
            .filter(Boolean))].sort()
        return {
            name,
            requests: samples.length,
            errors: errors.length,
            latencyMs: summarizeLatencies(samples.map(result => result.durationMs)),
            behaviorSignatures: signatures,
            sql: {
                readsMax: Math.max(0, ...samples.map(result => result.sql.selectStatements)),
                writesMax: Math.max(0, ...samples.map(result => result.sql.writeStatements)),
            },
            rollbackVerified: !WRITE_ENTRY_NAMES.includes(name)
                || rollbackVerification?.[name] === true,
        }
    })
}

function createMetadata(profile, entryRequests, fixedTime) {
    return {
        fixedTime,
        activeIdentitiesAreConcurrentRequests: false,
        entryDistribution: ENTRY_NAMES.map((name, index) => ({
            name,
            requests: entryRequests[index],
            weight: round(entryRequests[index] / profile.activeIdentities),
        })),
        entryDistributionNote: "acceptance coverage; not production traffic proportions",
    }
}

function createStepSummary({
    concurrency,
    results,
    elapsedMs,
    eventLoopDelay,
    rollbackVerification,
}) {
    return {
        concurrency,
        requests: results.length,
        errors: results.filter(result => result.error !== null).length,
        throughputPerSecond: round(results.length / (elapsedMs / 1000)),
        latencyMs: summarizeLatencies(results.map(result => result.durationMs)),
        eventLoopDelayMs: {
            p50: delayMilliseconds(eventLoopDelay.percentile(50)),
            p95: delayMilliseconds(eventLoopDelay.percentile(95)),
            max: delayMilliseconds(eventLoopDelay.max),
        },
        entries: summarizeEntries(results, rollbackVerification),
    }
}

module.exports = {
    behaviorSignature,
    canonicalJson,
    createMetadata,
    createStepSummary,
    round,
}
