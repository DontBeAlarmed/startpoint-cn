"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-degree-settlement-session-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

const { initializeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { settleMissionCategories } = require("../src/lib/mission/settlement")
const { DegreeComputer } = require("../src/lib/mission/computer-degree")
const { MissionEvaluationSession } = require("../src/lib/mission/evaluation-session")

initializeDatabase()

function cleanup() {
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
}

process.once("exit", cleanup)

const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `degree-settlement-session-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id

const originalLegacyBuilder = DegreeComputer.buildContext
const originalSessionBuilder = DegreeComputer.buildContextFromSession
let sessionBuilderCalls = 0
DegreeComputer.buildContext = () => {
    throw new Error("Category 5 settlement still uses legacy context")
}
DegreeComputer.buildContextFromSession = (...args) => {
    sessionBuilderCalls++
    return originalSessionBuilder(...args)
}

try {
    settleMissionCategories(
        playerId,
        [{ category: 5, missionIds: [1000] }],
        new Date("2024-08-14T12:00:00.000Z"),
    )
} finally {
    DegreeComputer.buildContext = originalLegacyBuilder
    DegreeComputer.buildContextFromSession = originalSessionBuilder
}

assert.equal(sessionBuilderCalls, 1)

const originalCompute = DegreeComputer.compute
const originalGetFact = MissionEvaluationSession.prototype.getFact
const originalGetFactFromPlan = MissionEvaluationSession.prototype.getFactFromPlan
let computeStarted = false
let readsAfterCompute = 0
DegreeComputer.compute = (...args) => {
    computeStarted = true
    return originalCompute(...args)
}
MissionEvaluationSession.prototype.getFact = function trackedGetFact(...args) {
    if (computeStarted) readsAfterCompute++
    return originalGetFact.apply(this, args)
}
MissionEvaluationSession.prototype.getFactFromPlan = function trackedGetFactFromPlan(...args) {
    if (computeStarted) readsAfterCompute++
    return originalGetFactFromPlan.apply(this, args)
}
try {
    settleMissionCategories(
        playerId,
        [{ category: 5, missionIds: [1000] }],
        new Date("2024-08-14T12:00:00.000Z"),
    )
} finally {
    DegreeComputer.compute = originalCompute
    MissionEvaluationSession.prototype.getFact = originalGetFact
    MissionEvaluationSession.prototype.getFactFromPlan = originalGetFactFromPlan
}
assert.equal(readsAfterCompute, 0)

console.log("degree settlement Session routing test passed")
cleanup()
process.removeListener("exit", cleanup)
