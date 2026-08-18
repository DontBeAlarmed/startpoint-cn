"use strict"

const { isDeepStrictEqual } = require("node:util")

const {
    STRUCTURAL_METRICS,
    inspectActiveMissionReport,
} = require("./report.cjs")

const GATES = Object.freeze([
    "behaviorEquivalent",
    "unsupportedMissionSetEquivalent",
    "structuralNonIncreasing",
    "reportStructureValid",
    "metricsValid",
])

function failedAdmission(failures = []) {
    return {
        behaviorEquivalent: false,
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
        const behaviorEquivalent = actual.behaviorHash === expected.behaviorHash
            && isDeepStrictEqual(actual.unsupportedMissionIds, expected.unsupportedMissionIds)
        const unsupportedMissionSetEquivalent = isDeepStrictEqual(
            actual.unsupportedMissionIds,
            expected.unsupportedMissionIds,
        )
        const structuralNonIncreasing = STRUCTURAL_METRICS.every(metric => (
            actual.structural[metric] <= expected.structural[metric]
        ))
        const result = {
            behaviorEquivalent,
            unsupportedMissionSetEquivalent,
            structuralNonIncreasing,
            reportStructureValid: true,
            metricsValid: true,
            admitted: false,
            failures: [],
        }
        if (!behaviorEquivalent) result.failures.push("behavior or unsupported mission set differs")
        if (!structuralNonIncreasing) result.failures.push("structural metric increased")
        result.admitted = GATES.every(gate => result[gate])
        return result
    } catch (error) {
        return failedAdmission([error instanceof Error ? error.message : "malformed active mission report"])
    }
}

module.exports = { evaluateActiveMissionReport }
