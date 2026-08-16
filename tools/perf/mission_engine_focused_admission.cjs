"use strict"

const { isDeepStrictEqual } = require("node:util")

const {
    FOCUSED_FIXED_TIME,
    FOCUSED_REPORT_VERSION,
    SCENARIO_FIELDS,
    STRUCTURAL_METRICS,
    createCanonicalFocusedReport,
    createBehaviorSummary,
    hasExactFields,
    inspectFocusedReportEnvelope,
    isPlainObject,
    sortedOwnKeys,
    validMetric,
} = require("./mission_engine_focused_report.cjs")

function evaluateFocusedMissionAdmission(current, snapshot) {
    const failures = []
    const currentBehaviorSummaries = new Map()
    const flags = {
        behaviorEquivalent: true,
        structuralNonIncreasing: true,
        scenarioSetEquivalent: true,
        metricsValid: true,
        reportStructureValid: true,
        scenarioFieldsValid: true,
    }

    function fail(type, failure) {
        failures.push({ type, ...failure })
        if ([
            "report-schema",
            "metadata",
            "scenario-schema",
            "behavior-integrity",
            "metric-schema",
        ].includes(type)) {
            for (const flag of Object.keys(flags)) flags[flag] = false
        } else if (type === "scenario-set") {
            flags.scenarioSetEquivalent = false
            flags.behaviorEquivalent = false
            flags.structuralNonIncreasing = false
            flags.metricsValid = false
            flags.scenarioFieldsValid = false
        } else if (type === "behavior-equivalence") {
            flags.behaviorEquivalent = false
        } else if (type === "structural-regression") {
            flags.structuralNonIncreasing = false
        }
    }

    const currentEnvelope = inspectFocusedReportEnvelope(current, "current")
    const snapshotEnvelope = inspectFocusedReportEnvelope(snapshot, "snapshot")
    for (const { type, ...failure } of [
        ...currentEnvelope.failures,
        ...snapshotEnvelope.failures,
    ]) fail(type, failure)
    const currentScenarios = currentEnvelope.scenarios
    const snapshotScenarios = snapshotEnvelope.scenarios
    if (currentScenarios === null || snapshotScenarios === null) {
        return { ...flags, admitted: false, failures, canonicalReport: null }
    }

    const currentNames = sortedOwnKeys(currentScenarios)
    const snapshotNames = sortedOwnKeys(snapshotScenarios)
    for (const scenario of snapshotNames) {
        if (!Object.hasOwn(currentScenarios, scenario)) {
            fail("scenario-set", {
                scenario,
                metric: "scenario",
                actual: "missing",
                expected: "present",
                reason: "scenario is missing from the current report",
            })
        }
    }
    for (const scenario of currentNames) {
        if (!Object.hasOwn(snapshotScenarios, scenario)) {
            fail("scenario-set", {
                scenario,
                metric: "scenario",
                actual: "present",
                expected: "absent",
                reason: "scenario is not present in the checked snapshot",
            })
        }
    }

    for (const scenario of snapshotNames) {
        if (!Object.hasOwn(currentScenarios, scenario)) continue
        const actual = currentScenarios[scenario]
        const expected = snapshotScenarios[scenario]
        const records = [["current", actual], ["snapshot", expected]]
        const validity = {}

        for (const [source, record] of records) {
            const recordValid = isPlainObject(record)
            let behaviorSummary = null
            let hashFormatValid = false
            if (!recordValid) {
                fail("scenario-schema", {
                    scenario,
                    metric: "scenario",
                    actual: record,
                    expected: "plain object",
                    reason: `${source} scenario must be a plain object`,
                })
            } else if (!hasExactFields(record, SCENARIO_FIELDS)) {
                fail("scenario-schema", {
                    scenario,
                    metric: "fields",
                    actual: sortedOwnKeys(record),
                    expected: SCENARIO_FIELDS,
                    reason: `${source} scenario must contain exactly the checked fields`,
                })
            }

            const behaviorRootValid = recordValid
                && record.behavior !== undefined
                && record.behavior !== null
                && typeof record.behavior === "object"
                && !Array.isArray(record.behavior)
            if (!behaviorRootValid) {
                fail("behavior-integrity", {
                    scenario,
                    metric: "behavior",
                    actual: recordValid ? record.behavior : undefined,
                    expected: "non-array object",
                    reason: `${source} scenario behavior must be a non-array object`,
                })
            } else {
                try {
                    behaviorSummary = createBehaviorSummary(record.behavior)
                } catch (error) {
                    fail("behavior-integrity", {
                        scenario,
                        metric: "behavior",
                        actual: record.behavior,
                        expected: "JSON data tree",
                        reason: `${source} scenario behavior is invalid: ${error.message}`,
                    })
                }
            }

            hashFormatValid = recordValid
                && typeof record.behaviorSha256 === "string"
                && /^[a-f0-9]{64}$/.test(record.behaviorSha256)
            if (!hashFormatValid) {
                fail("behavior-integrity", {
                    scenario,
                    metric: "behaviorSha256",
                    actual: recordValid ? record.behaviorSha256 : undefined,
                    expected: "64 lowercase hexadecimal characters",
                    reason: `${source} scenario behaviorSha256 must be a 64-character lowercase hex string`,
                })
            }

            validity[source] = { recordValid, behaviorSummary, hashFormatValid }
            if (source === "current" && behaviorSummary !== null) {
                currentBehaviorSummaries.set(scenario, behaviorSummary)
            }
        }

        if (validity.current.behaviorSummary !== null
            && validity.snapshot.behaviorSummary !== null
            && !isDeepStrictEqual(
                validity.current.behaviorSummary.behavior,
                validity.snapshot.behaviorSummary.behavior,
            )) {
            fail("behavior-equivalence", {
                scenario,
                metric: "behavior",
                actual: actual.behavior,
                expected: expected.behavior,
                reason: "behavior payload differs from the checked snapshot",
            })
        }

        for (const [source, record] of records) {
            const recordValidity = validity[source]
            if (recordValidity.behaviorSummary !== null
                && recordValidity.hashFormatValid
                && record.behaviorSha256 !== recordValidity.behaviorSummary.behaviorSha256) {
                fail("behavior-integrity", {
                    scenario,
                    metric: "behaviorSha256",
                    actual: record.behaviorSha256,
                    expected: recordValidity.behaviorSummary.behaviorSha256,
                    reason: `${source} behavior hash does not match its canonical payload`,
                })
            }
        }

        if (!validity.current.recordValid || !validity.snapshot.recordValid) continue
        for (const metric of STRUCTURAL_METRICS) {
            if (!validMetric(actual[metric]) || !validMetric(expected[metric])) {
                fail("metric-schema", {
                    scenario,
                    metric,
                    actual: actual[metric],
                    expected: expected[metric],
                    reason: "current and snapshot metrics must be non-negative safe integers",
                })
            } else if (actual[metric] > expected[metric]) {
                fail("structural-regression", {
                    scenario,
                    metric,
                    actual: actual[metric],
                    expected: expected[metric],
                    reason: "current metric exceeds the checked snapshot",
                })
            }
        }
    }

    const admitted = Object.values(flags).every(Boolean)
    return {
        ...flags,
        admitted,
        failures,
        canonicalReport: admitted
            ? createCanonicalFocusedReport(current, currentBehaviorSummaries)
            : null,
    }
}

function printable(value) {
    if (value === undefined) return "undefined"
    const ancestors = []
    try {
        return JSON.stringify(value, function diagnosticReplacer(_key, nested) {
            if (typeof nested === "bigint") return `${nested}n`
            if (typeof nested === "number" && !Number.isFinite(nested)) return String(nested)
            if (nested === null || typeof nested !== "object") return nested
            while (ancestors.length > 0 && ancestors.at(-1) !== this) ancestors.pop()
            if (ancestors.includes(nested)) return "[Circular]"
            ancestors.push(nested)
            return nested
        })
    } catch (error) {
        return `[Unserializable: ${error.message}]`
    }
}

function formatFocusedMissionAdmissionFailures(admission) {
    return admission.failures.map(failure => (
        `${failure.scenario}.${failure.metric}: ${failure.reason}; `
        + `current=${printable(failure.actual)}, snapshot=${printable(failure.expected)}`
    ))
}

module.exports = {
    FOCUSED_FIXED_TIME,
    FOCUSED_REPORT_VERSION,
    STRUCTURAL_METRICS,
    createBehaviorSummary,
    evaluateFocusedMissionAdmission,
    formatFocusedMissionAdmissionFailures,
}
