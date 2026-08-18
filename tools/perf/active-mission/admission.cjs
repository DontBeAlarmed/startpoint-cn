"use strict"

const { isDeepStrictEqual } = require("node:util")

const {
    STRUCTURAL_METRICS,
    inspectActiveMissionReport,
} = require("./report.cjs")

const GATES = Object.freeze([
    "behaviorEquivalent",
    "fixtureEquivalent",
    "unsupportedMissionSetEquivalent",
    "structuralNonIncreasing",
    "reportStructureValid",
    "metricsValid",
])

function failedAdmission(failures = []) {
    return {
        behaviorEquivalent: false,
        fixtureEquivalent: false,
        unsupportedMissionSetEquivalent: false,
        structuralNonIncreasing: false,
        reportStructureValid: false,
        metricsValid: false,
        admitted: false,
        failures,
    }
}

function evaluateActiveMissionReport(baseline, current) {
    try {
        const baselineInspection = inspectActiveMissionReport(baseline)
        const currentInspection = inspectActiveMissionReport(current)
        if (!baselineInspection.valid || !currentInspection.valid) {
            return failedAdmission([
                ...baselineInspection.failures.map(reason => `baseline: ${reason}`),
                ...currentInspection.failures.map(reason => `current: ${reason}`),
            ])
        }

        const expected = baselineInspection.report
        const actual = currentInspection.report
        const fixtureEquivalent = ["name", "profile", "scale"].every(field => (
            actual.fixture[field] === expected.fixture[field]
        ))
        const behaviorEquivalent = fixtureEquivalent
            && actual.behaviorHash === expected.behaviorHash
            && isDeepStrictEqual(actual.unsupportedMissionIds, expected.unsupportedMissionIds)
        const unsupportedMissionSetEquivalent = isDeepStrictEqual(
            actual.unsupportedMissionIds,
            expected.unsupportedMissionIds,
        )
        const structuralMetricsNonIncreasing = STRUCTURAL_METRICS.every(metric => (
            actual.structural[metric] <= expected.structural[metric]
        ))
        const repeatedFactLoaders = Object.entries(actual.factLoaders)
            .filter(([, loader]) => loader.calls > 1)
        const structuralNonIncreasing = structuralMetricsNonIncreasing
            && repeatedFactLoaders.length === 0
        const result = {
            behaviorEquivalent,
            fixtureEquivalent,
            unsupportedMissionSetEquivalent,
            structuralNonIncreasing,
            reportStructureValid: true,
            metricsValid: true,
            admitted: false,
            failures: [],
        }
        if (!fixtureEquivalent) result.failures.push("fixture/workload mismatch")
        if (actual.behaviorHash !== expected.behaviorHash) {
            result.failures.push("behavior hash differs")
        }
        if (!unsupportedMissionSetEquivalent) {
            result.failures.push("unsupported mission set differs")
        }
        if (!structuralMetricsNonIncreasing) result.failures.push("structural metric increased")
        for (const [name, loader] of repeatedFactLoaders) {
            result.failures.push(`fact loader ${name} has multiple calls (${loader.calls})`)
        }
        result.admitted = GATES.every(gate => result[gate])
        return result
    } catch (error) {
        return failedAdmission([error instanceof Error ? error.message : "malformed active mission report"])
    }
}

module.exports = { evaluateActiveMissionReport }
