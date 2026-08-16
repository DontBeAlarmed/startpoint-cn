#!/usr/bin/env node
"use strict"

require("ts-node/register/transpile-only")

const fs = require("node:fs")
const path = require("node:path")

const { RUNTIME_COMMIT_MARKER } = require("./git-object-runtime.cjs")
const {
    runMissionEntryLayeredLoad,
} = require("../perf/mission_entry_layered_load.cjs")
const {
    ENTRY_NAMES,
    getRuntimeDependencies,
} = require("../perf/mission_entry_load_scenarios.cjs")

function createReference(report, runtimeCommit) {
    return {
        version: 1,
        runtimeCommit,
        fixedTime: report.fixedTime,
        entries: Object.fromEntries(ENTRY_NAMES.map(entry => {
            const measurements = report.steps.map(step => step.entries[entry])
            const signatures = [...new Set(measurements.flatMap(item => item.behaviorSignatures))]
            return [entry, {
                behaviorSignature: signatures.length === 1 ? signatures[0] : null,
                sqlReads: Math.max(...measurements.map(item => item.structural.sqlReadsMax)),
                sqlWrites: Math.max(...measurements.map(item => item.structural.sqlWritesMax)),
                missionComputes: Math.max(...measurements.map(item => (
                    item.structural.missionComputesMax
                ))),
            }]
        })),
    }
}

async function collect(runtimeRoot) {
    const originalLog = console.log
    console.log = () => {}
    try {
        const runtimeCommit = fs.readFileSync(
            path.join(runtimeRoot, RUNTIME_COMMIT_MARKER),
            "utf8",
        ).trim()
        const report = await runMissionEntryLayeredLoad({
            concurrencies: [1],
            players: 4,
            reference: null,
            runtime: getRuntimeDependencies(runtimeRoot),
        })
        return createReference(report, runtimeCommit)
    } finally {
        console.log = originalLog
    }
}

if (process.argv.length !== 3) {
    throw new Error("mission entry BASE collector requires one archived runtime root")
}
collect(path.resolve(process.argv[2])).then(reference => {
    process.stdout.write(`${JSON.stringify(reference, null, 2)}\n`)
}).catch(error => {
    process.stderr.write(`${error.stack ?? error}\n`)
    process.exitCode = 1
})
