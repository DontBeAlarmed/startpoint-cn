"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-degree-settlement-failure-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

const { initializeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    getPlayerCategoryMissionsSync,
    updatePlayerCategoryMissionSync,
} = require("../src/data/domains/mission")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { getDb } = require("../src/data/db")
const { MissionEvaluationSession } = require("../src/lib/mission/evaluation-session")
const missionCatalogModule = require("../src/lib/mission/mission-catalog")
const {
    bundledMissionContentRepository,
} = require("../src/lib/mission/mission-catalog-source")
const { settleMissionCategories } = require("../src/lib/mission/settlement")
const buildMissionCatalog = missionCatalogModule.getMissionCatalog

initializeDatabase()
const db = getDb()

function clone(value) {
    return JSON.parse(JSON.stringify(value))
}

function createPlayer() {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `degree-settlement-failure-${randomUUID()}`,
        status: "normal",
    })
    return insertDefaultPlayerSync(account.id).id
}

function malformedCatalog() {
    const definitions = clone(bundledMissionContentRepository.table("mission_degree.json"))
    definitions[14000][0][2] = "单人战斗获得不是数字以上的分数"
    return buildMissionCatalog({
        info: () => bundledMissionContentRepository.info(),
        table(tableName) {
            return tableName === "mission_degree.json"
                ? definitions
                : bundledMissionContentRepository.table(tableName)
        },
    })
}

test("malformed Degree Catalog allows orchestrator player, rejects Degree facts, and rolls back writes", () => {
    const playerId = createPlayer()
    updatePlayerCategoryMissionSync(playerId, 5, 14000, 7)
    const before = getPlayerCategoryMissionsSync(playerId, 5)[14000]
    const originalGetMissionCatalog = missionCatalogModule.getMissionCatalog
    const originalGetFact = MissionEvaluationSession.prototype.getFact
    const originalGetFactFromPlan = MissionEvaluationSession.prototype.getFactFromPlan
    const originalPrepare = db.prepare.bind(db)
    const writes = []
    const loaderCalls = { orchestrator: [], degree: [] }
    missionCatalogModule.getMissionCatalog = () => malformedCatalog()
    MissionEvaluationSession.prototype.getFact = function trackedGetFact(...args) {
        loaderCalls.orchestrator.push(args[0])
        return originalGetFact.apply(this, args)
    }
    MissionEvaluationSession.prototype.getFactFromPlan = function trackedDegreeFact(...args) {
        loaderCalls.degree.push(args[0])
        return originalGetFactFromPlan.apply(this, args)
    }
    db.prepare = statement => {
        if (/^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(String(statement))) writes.push(String(statement))
        return originalPrepare(statement)
    }
    try {
        assert.throws(
            () => settleMissionCategories(
                playerId,
                [{ category: 5, missionIds: [14000] }],
                new Date("2024-08-14T12:00:00.000Z"),
            ),
            /Degree Session invariant failed.*(?:mode|facts|selector)/i,
        )
    } finally {
        db.prepare = originalPrepare
        MissionEvaluationSession.prototype.getFact = originalGetFact
        MissionEvaluationSession.prototype.getFactFromPlan = originalGetFactFromPlan
        missionCatalogModule.getMissionCatalog = originalGetMissionCatalog
    }

    // Shared candidate preparation owns player; Degree facts begin at getFactFromPlan.
    assert.deepEqual(loaderCalls, {
        orchestrator: [{ kind: "player" }],
        degree: [],
    })
    assert.deepEqual(writes, [])
    assert.deepEqual(getPlayerCategoryMissionsSync(playerId, 5)[14000], before)
})

test.after(() => {
    if (db.open) db.close()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
})
