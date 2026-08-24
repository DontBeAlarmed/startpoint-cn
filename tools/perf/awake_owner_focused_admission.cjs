"use strict"

const { isDeepStrictEqual } = require("node:util")
const {
    canonicalizeCheckedAwakeOwnerFocusedReport,
} = require("./awake_owner_focused_report.cjs")

function evaluateAwakeOwnerFocusedAdmission(current, snapshot) {
    const failures = []
    let checkedCurrent
    let checkedSnapshot
    for (const [source, report] of [["current", current], ["snapshot", snapshot]]) {
        try {
            const checked = canonicalizeCheckedAwakeOwnerFocusedReport(report, source)
            if (source === "current") checkedCurrent = checked
            else checkedSnapshot = checked
        } catch (error) {
            failures.push({
                type: "report-schema",
                source,
                reason: error instanceof Error ? error.message : "invalid report",
            })
        }
    }
    if (checkedCurrent && checkedSnapshot && !isDeepStrictEqual(checkedCurrent, checkedSnapshot)) {
        failures.push({
            type: "exact-evidence-drift",
            source: "current",
            reason: "behavior, state, seed, loader, compute, or SQL evidence differs from snapshot",
        })
    }
    return {
        admitted: failures.length === 0,
        failures,
        canonicalReport: failures.length === 0 ? checkedCurrent : null,
    }
}

function formatAwakeOwnerFocusedAdmissionFailures(admission) {
    return admission.failures.map(failure => `${failure.source}: ${failure.reason}`)
}

module.exports = {
    evaluateAwakeOwnerFocusedAdmission,
    formatAwakeOwnerFocusedAdmissionFailures,
}
