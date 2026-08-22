"use strict"

const { isDeepStrictEqual } = require("node:util")

const {
    AWAKE_REQUEST_CONTEXT_SCENARIO_KEYS,
    STRUCTURAL_METRICS,
    TABLE_FIELDS,
    canonicalizeCheckedReport,
} = require("./awake_request_context_report.cjs")

function evaluateAwakeRequestContextAdmission(current, snapshot) {
    const failures = []
    let checkedCurrent
    let checkedSnapshot

    for (const [source, report] of [["current", current], ["snapshot", snapshot]]) {
        try {
            const checked = canonicalizeCheckedReport(report, source)
            if (source === "current") checkedCurrent = checked
            else checkedSnapshot = checked
            for (const scenario of checked.hashMismatches) {
                failures.push({
                    type: "behavior-integrity",
                    scenario,
                    metric: "behaviorSha256",
                    reason: `${source} behavior hash does not match its canonical payload`,
                })
            }
        } catch (error) {
            failures.push({
                type: "report-schema",
                scenario: source,
                metric: "report",
                reason: error instanceof Error ? error.message : "invalid report",
            })
        }
    }

    if (!checkedCurrent || !checkedSnapshot) {
        return { admitted: false, failures, canonicalReport: null }
    }

    for (const scenario of AWAKE_REQUEST_CONTEXT_SCENARIO_KEYS) {
        const actual = checkedCurrent.report.scenarios[scenario]
        const expected = checkedSnapshot.report.scenarios[scenario]
        if (!isDeepStrictEqual(actual.behavior, expected.behavior)) {
            failures.push({
                type: "behavior-equivalence",
                scenario,
                metric: "behavior",
                reason: "behavior payload differs from the checked snapshot",
            })
        }
        for (const metric of STRUCTURAL_METRICS) {
            if (actual[metric] > expected[metric]) {
                failures.push({
                    type: "structural-regression",
                    scenario,
                    metric,
                    reason: "current metric exceeds the checked snapshot",
                })
            }
        }
        for (const table of Object.keys(actual.sqlByTable)) {
            const expectedTable = expected.sqlByTable[table]
            if (expectedTable === undefined) {
                if (table.startsWith("sqlite_")) continue
                failures.push({
                    type: "table-drift",
                    scenario,
                    metric: `sqlByTable.${table}`,
                    reason: "current report contains a new business SQL table",
                })
                continue
            }
            for (const metric of TABLE_FIELDS) {
                if (actual.sqlByTable[table][metric] > expectedTable[metric]) {
                    failures.push({
                        type: "structural-regression",
                        scenario,
                        metric: `sqlByTable.${table}.${metric}`,
                        reason: "current table metric exceeds the checked snapshot",
                    })
                }
            }
        }
    }

    return {
        admitted: failures.length === 0,
        failures,
        canonicalReport: failures.length === 0 ? checkedCurrent.report : null,
    }
}

function printable(value) {
    if (value === undefined) return "undefined"
    try {
        return JSON.stringify(value)
    } catch {
        return "[unserializable]"
    }
}

function formatAwakeRequestContextAdmissionFailures(admission) {
    return admission.failures.map(failure => (
        `${failure.scenario}.${failure.metric}: ${failure.reason}`
        + (failure.actual === undefined && failure.expected === undefined
            ? ""
            : `; current=${printable(failure.actual)}, snapshot=${printable(failure.expected)}`)
    ))
}

module.exports = {
    evaluateAwakeRequestContextAdmission,
    formatAwakeRequestContextAdmissionFailures,
}
