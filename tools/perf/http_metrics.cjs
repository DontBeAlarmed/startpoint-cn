"use strict"

function percentile(values, quantile) {
    const sorted = [...values].sort((left, right) => left - right)
    const rank = Math.max(1, Math.ceil(sorted.length * quantile)) - 1
    return sorted[rank]
}

function summarizeHttpSamples(samples) {
    if (!Array.isArray(samples) || samples.length === 0) {
        throw new Error("summarizeHttpSamples requires at least one sample")
    }

    const durations = samples
        .map(sample => sample?.durationMs)
        .filter(duration => Number.isFinite(duration) && duration >= 0)
    if (durations.length !== samples.length) {
        throw new Error("every HTTP sample must include a non-negative durationMs")
    }

    const statusCounts = {}
    let errors = 0
    let httpErrors = 0
    for (const sample of samples) {
        if (sample.error) {
            errors++
            continue
        }
        if (!Number.isInteger(sample.status)) {
            errors++
            continue
        }
        const key = String(sample.status)
        statusCounts[key] = (statusCounts[key] ?? 0) + 1
        if (sample.status < 200 || sample.status >= 400) httpErrors++
    }

    return {
        count: samples.length,
        completed: samples.length - errors,
        errors,
        httpErrors,
        p50Ms: percentile(durations, 0.5),
        p95Ms: percentile(durations, 0.95),
        p99Ms: percentile(durations, 0.99),
        statusCounts,
    }
}

module.exports = { percentile, summarizeHttpSamples }
