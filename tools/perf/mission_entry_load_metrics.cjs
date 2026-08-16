"use strict"

const DEFAULT_CONCURRENCIES = Object.freeze([1, 10, 25, 50, 100])

function positiveInteger(value, label) {
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`${label} must contain positive integers`)
    }
    return parsed
}

function parseArgs(argv) {
    const result = {
        players: 600,
        concurrencies: [...DEFAULT_CONCURRENCIES],
        output: null,
    }
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index]
        const value = argv[++index]
        if (value === undefined || value.startsWith("--")) {
            throw new Error(`${argument} requires a value`)
        }
        if (argument === "--players") result.players = positiveInteger(value, "players")
        else if (argument === "--concurrency") {
            const values = value.split(",")
            if (values.length === 0) throw new Error("concurrency must contain positive integers")
            result.concurrencies = [...new Set(values.map(item => (
                positiveInteger(item, "concurrency")
            )))]
        } else if (argument === "--output") result.output = value
        else throw new Error(`unknown argument: ${argument}`)
    }
    return result
}

async function runBounded(tasks, concurrency) {
    positiveInteger(concurrency, "concurrency")
    const results = new Array(tasks.length)
    let nextIndex = 0
    async function worker() {
        while (nextIndex < tasks.length) {
            const index = nextIndex++
            results[index] = await tasks[index]()
        }
    }
    await Promise.all(Array.from(
        { length: Math.min(concurrency, tasks.length) },
        () => worker(),
    ))
    return results
}

function percentile(sorted, fraction) {
    if (sorted.length === 0) return 0
    const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1)
    return sorted[index]
}

function summarizeLatencies(values) {
    const sorted = [...values].sort((left, right) => left - right)
    return {
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
    }
}

function createAdmissionGate({
    errors,
    behaviorEquivalent,
    rollbackVerified,
    structuralComparisons,
}) {
    const gate = {
        zeroErrors: errors === 0,
        behaviorEquivalent,
        rollbackVerified,
        sqlComputeNonIncreasing: structuralComparisons.every(comparison => (
            comparison.sqlNonIncreasing && comparison.computeNonIncreasing
        )),
    }
    return { ...gate, admitted: Object.values(gate).every(Boolean) }
}

module.exports = {
    DEFAULT_CONCURRENCIES,
    createAdmissionGate,
    parseArgs,
    runBounded,
    summarizeLatencies,
}
