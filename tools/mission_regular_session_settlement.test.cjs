"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
test.after(restoreContentSnapshot)
const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-regular-session-settlement-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

const { initializeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { getDb } = require("../src/data/db")
const { MissionEvaluationSession } = require("../src/lib/mission/evaluation-session")
const { RegularComputer } = require("../src/lib/mission/computer-regular")
const { settleMissionCategories } = require("../src/lib/mission/settlement")

initializeDatabase()
const db = getDb()

test.after(() => {
    if (db.open) db.close()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
})

function createPlayer() {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `regular-session-settlement-${randomUUID()}`,
        status: "normal",
    })
    return insertDefaultPlayerSync(account.id).id
}

test("Category 1 settlement uses Session context and stops reading it before compute/write", () => {
    const playerId = createPlayer()
    const originalLegacy = RegularComputer.buildContext
    const originalSession = RegularComputer.buildContextFromSession
    const originalCompute = RegularComputer.compute
    const originalGetFact = MissionEvaluationSession.prototype.getFact
    const originalGetFactFromPlan = MissionEvaluationSession.prototype.getFactFromPlan
    let sessionContexts = 0
    let computeCalls = 0
    let computeStarted = false
    let readsAfterComputeStarted = 0
    RegularComputer.buildContext = () => {
        throw new Error("Category 1 settlement used legacy context")
    }
    RegularComputer.buildContextFromSession = (...args) => {
        sessionContexts++
        return originalSession.call(RegularComputer, ...args)
    }
    RegularComputer.compute = (...args) => {
        computeStarted = true
        computeCalls++
        return originalCompute.call(RegularComputer, ...args)
    }
    MissionEvaluationSession.prototype.getFact = function trackedGetFact(...args) {
        if (computeStarted) readsAfterComputeStarted++
        return originalGetFact.apply(this, args)
    }
    MissionEvaluationSession.prototype.getFactFromPlan = function trackedGetFactFromPlan(...args) {
        if (computeStarted) readsAfterComputeStarted++
        return originalGetFactFromPlan.apply(this, args)
    }
    try {
        settleMissionCategories(
            playerId,
            [1],
            new Date("2024-08-14T12:00:00.000Z"),
        )
    } finally {
        RegularComputer.buildContext = originalLegacy
        RegularComputer.buildContextFromSession = originalSession
        RegularComputer.compute = originalCompute
        MissionEvaluationSession.prototype.getFact = originalGetFact
        MissionEvaluationSession.prototype.getFactFromPlan = originalGetFactFromPlan
    }

    assert.equal(sessionContexts, 1)
    assert.equal(computeCalls > 0, true)
    assert.equal(readsAfterComputeStarted, 0)
})

test("mission 9 computes from owned character levels while mission 22 keeps player rank", () => {
    function categoryContext({ playerRankDegree, maxCharacterLevel }) {
        return {
            category: 1,
            missionPatterns: new Map([[9, "character_level"], [22, "user_rank"]]),
            battleCounters: {},
            player: {},
            regularStats: {
                degreeBattleStats: {},
                state: { maxCharacterLevel },
            },
            ...(playerRankDegree === undefined ? {} : { playerRankDegree }),
        }
    }

    // high player Rank, low best character level: mission 9 must not borrow Rank
    const rankHigh = categoryContext({ playerRankDegree: 100, maxCharacterLevel: 60 })
    assert.equal(RegularComputer.compute(9, rankHigh, 0), 60)
    assert.equal(RegularComputer.compute(22, rankHigh, 0), 100)

    // low player Rank, high best character level: mission 9 follows the character level
    const levelHigh = categoryContext({ playerRankDegree: 10, maxCharacterLevel: 100 })
    assert.equal(RegularComputer.compute(9, levelHigh, 0), 100)
    assert.equal(RegularComputer.compute(22, levelHigh, 0), 10)

    // proven level cannot lower persisted progress, same as every other pattern
    assert.equal(RegularComputer.compute(9, rankHigh, 70), 70)
})
