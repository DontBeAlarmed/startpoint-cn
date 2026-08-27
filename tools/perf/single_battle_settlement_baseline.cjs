#!/usr/bin/env node
"use strict"

const fs = require("node:fs")
const path = require("node:path")

const {
    createSingleBattleReport,
    evaluateSingleBattleAdmission,
    writeAdmittedSnapshot,
} = require("./single_battle_settlement_admission.cjs")

const SNAPSHOT_PATH = path.join(
    __dirname,
    "__snapshots__",
    "single_battle_settlement_baseline.json",
)

function parseArgs(argv) {
    let write = false
    let acceptBehaviorChange = false
    for (const argument of argv) {
        if (argument === "--write") {
            if (write) throw new Error("duplicate --write")
            write = true
            continue
        }
        if (argument === "--accept-behavior-change") {
            if (acceptBehaviorChange) throw new Error("duplicate --accept-behavior-change")
            acceptBehaviorChange = true
            continue
        }
        throw new Error(`unknown argument: ${argument}`)
    }
    if (acceptBehaviorChange && !write) {
        throw new Error("--accept-behavior-change requires --write")
    }
    return { write, acceptBehaviorChange }
}

async function runSingleBattleSettlementBaseline({
    scenarioLoader = () => require("./single_battle_settlement_scenarios.cjs").SCENARIOS,
} = {}) {
    const scenarios = {}
    for (const scenario of scenarioLoader()) {
        if (Object.hasOwn(scenarios, scenario.name)) {
            throw new Error(`duplicate single battle scenario ${scenario.name}`)
        }
        scenarios[scenario.name] = await scenario.run()
    }
    return createSingleBattleReport(scenarios)
}

function readSnapshot(snapshotPath = SNAPSHOT_PATH) {
    return JSON.parse(fs.readFileSync(snapshotPath, "utf8"))
}

function admitSingleBattleReport(report, {
    snapshotPath = SNAPSHOT_PATH,
    write = false,
    acceptBehaviorChange = false,
} = {}) {
    if (write) {
        writeAdmittedSnapshot(report, snapshotPath, {
            allowBehaviorChange: acceptBehaviorChange,
        })
    }
    return evaluateSingleBattleAdmission(report, readSnapshot(snapshotPath))
}

async function main() {
    const options = parseArgs(process.argv.slice(2))
    const report = await runSingleBattleSettlementBaseline()
    const admission = admitSingleBattleReport(report, options)
    if (!admission.admitted) {
        throw new Error(`Single battle baseline admission failed:\n${admission.failures.join("\n")}`)
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`${error.stack ?? error}\n`)
        process.exitCode = 1
    })
}

module.exports = {
    SNAPSHOT_PATH,
    admitSingleBattleReport,
    parseArgs,
    readSnapshot,
    runSingleBattleSettlementBaseline,
}
