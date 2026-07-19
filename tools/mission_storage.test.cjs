require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-storage-db-"))
process.env.WDFP_DATABASE_DIR = databaseDirectory
let db

function cleanupDatabase() {
    if (db?.open) db.close()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    delete process.env.WDFP_DATABASE_DIR
}

process.once("exit", cleanupDatabase)

const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const {
    deletePlayerCategoryMissionsSync,
    getPlayerActiveMissionsSync,
    getPlayerCategoryMissionsSync,
    incrementPlayerCategoryMissionSync,
    updatePlayerActiveMissionStageSync,
    updatePlayerActiveMissionSync,
    updatePlayerCategoryMissionStageSync,
    updatePlayerCategoryMissionSync,
} = require("../src/data/domains/mission")

db = getDb()

db.exec("BEGIN")
try {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `mission-storage-test-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const missionId = 987654321

    updatePlayerCategoryMissionSync(playerId, 1, missionId, 5)
    updatePlayerCategoryMissionStageSync(playerId, 1, 1, missionId, true)
    updatePlayerCategoryMissionSync(playerId, 2, missionId, 7)
    incrementPlayerCategoryMissionSync(playerId, 1, missionId, 2)

    assert.equal(getPlayerCategoryMissionsSync(playerId, 1)[missionId].progress, 7)
    assert.equal(getPlayerCategoryMissionsSync(playerId, 1)[missionId].stages[1], true)
    assert.equal(getPlayerCategoryMissionsSync(playerId, 2)[missionId].progress, 7)

    deletePlayerCategoryMissionsSync(playerId, 2)
    assert.equal(getPlayerCategoryMissionsSync(playerId, 2)[missionId], undefined)
    assert.equal(getPlayerCategoryMissionsSync(playerId, 1)[missionId].progress, 7)

    updatePlayerActiveMissionSync(playerId, missionId, 10)
    updatePlayerActiveMissionStageSync(playerId, 1, missionId, true)
    updatePlayerActiveMissionSync(playerId, missionId, 11)
    assert.equal(getPlayerActiveMissionsSync(playerId)[missionId].stages[1], true)

    console.log("mission storage tests passed")
} finally {
    db.exec("ROLLBACK")
}
cleanupDatabase()
process.removeListener("exit", cleanupDatabase)
