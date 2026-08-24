"use strict"

const { isDeepStrictEqual } = require("node:util")
const {
    canonicalizeCheckedAwakeOwnerFocusedReport,
} = require("./awake_owner_focused_report.cjs")

const UPPER_BOUND_METRICS = Object.freeze(["missionComputes", "sqlReads", "sqlWrites"])
const SQL_TABLE_METRICS = Object.freeze(["reads", "statements", "writes"])

function exactEvidenceView(report) {
    return {
        version: report.version,
        fixedTime: report.fixedTime,
        evidenceRegistry: report.evidenceRegistry,
        sqlUpperBounds: report.sqlUpperBounds,
        scenarios: Object.fromEntries(Object.entries(report.scenarios).map(([name, scenario]) => {
            const {
                missionComputes: _missionComputes,
                sqlByTable: _sqlByTable,
                sqlReads: _sqlReads,
                sqlWrites: _sqlWrites,
                ...exactEvidence
            } = scenario
            return [name, exactEvidence]
        })),
    }
}

function metricFailure(scenario, metric, actual, upperBound) {
    return {
        type: "metric-upper-bound",
        source: "current",
        scenario,
        metric,
        reason: `${scenario}.${metric}=${actual} exceeds checked snapshot upper bound ${upperBound}`,
    }
}

function compareUpperBoundMetrics(current, snapshot, failures) {
    for (const [scenarioName, currentScenario] of Object.entries(current.scenarios)) {
        const snapshotScenario = snapshot.scenarios[scenarioName]
        for (const metric of UPPER_BOUND_METRICS) {
            if (currentScenario[metric] > snapshotScenario[metric]) {
                failures.push(metricFailure(
                    scenarioName,
                    metric,
                    currentScenario[metric],
                    snapshotScenario[metric],
                ))
            }
        }
        for (const [table, currentRow] of Object.entries(currentScenario.sqlByTable)) {
            const snapshotRow = snapshotScenario.sqlByTable[table]
            for (const metric of SQL_TABLE_METRICS) {
                const upperBound = snapshotRow?.[metric] ?? 0
                if (currentRow[metric] > upperBound) {
                    failures.push(metricFailure(
                        scenarioName,
                        `sqlByTable.${table}.${metric}`,
                        currentRow[metric],
                        upperBound,
                    ))
                }
            }
        }
    }
}

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
    if (checkedCurrent && checkedSnapshot) {
        if (!isDeepStrictEqual(exactEvidenceView(checkedCurrent), exactEvidenceView(checkedSnapshot))) {
            failures.push({
                type: "exact-evidence-drift",
                source: "current",
                reason: "behavior, state, seed, publication, loader, owner, or boundary evidence differs from snapshot",
            })
        }
        compareUpperBoundMetrics(checkedCurrent, checkedSnapshot, failures)
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
