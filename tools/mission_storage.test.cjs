require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-storage-db-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
delete process.env.DATA_DIR
process.env.WDFP_DATABASE_DIR = databaseDirectory
let db

function cleanupDatabase() {
    if (db?.open) db.close()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
}

process.once("exit", cleanupDatabase)

const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const {
    deletePlayerCategoryMissionsSync,
    getPlayerActiveMissionsSync,
    getPlayerCategoryMissionsSync,
    incrementPlayerCategoryMissionsIfSafeSync,
    incrementPlayerCategoryMissionSync,
    incrementPlayerCategoryMissionIfSafeSync,
    updatePlayerActiveMissionStageSync,
    updatePlayerActiveMissionSync,
    updatePlayerCategoryMissionStageSync,
    updatePlayerCategoryMissionSync,
} = require("../src/data/domains/mission")

initializeDatabase()
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

    const safeMissionId = missionId + 1
    assert.equal(incrementPlayerCategoryMissionIfSafeSync(playerId, 1, safeMissionId, 3), true)
    assert.equal(getPlayerCategoryMissionsSync(playerId, 1)[safeMissionId].progress, 3)
    assert.equal(incrementPlayerCategoryMissionIfSafeSync(playerId, 1, safeMissionId, 2), true)
    assert.equal(getPlayerCategoryMissionsSync(playerId, 1)[safeMissionId].progress, 5)
    updatePlayerCategoryMissionSync(playerId, 1, safeMissionId, Number.MAX_SAFE_INTEGER - 1)
    assert.equal(incrementPlayerCategoryMissionIfSafeSync(playerId, 1, safeMissionId, 1), true)
    assert.equal(getPlayerCategoryMissionsSync(playerId, 1)[safeMissionId].progress, Number.MAX_SAFE_INTEGER)
    assert.equal(incrementPlayerCategoryMissionIfSafeSync(playerId, 1, safeMissionId, 1), false)
    assert.equal(getPlayerCategoryMissionsSync(playerId, 1)[safeMissionId].progress, Number.MAX_SAFE_INTEGER)
    assert.equal(incrementPlayerCategoryMissionIfSafeSync(playerId, 1, safeMissionId, Number.MAX_SAFE_INTEGER + 1), false)

    const batchMissionIds = [missionId + 2, missionId + 3]
    assert.equal(incrementPlayerCategoryMissionsIfSafeSync(playerId, 1, [
        { missionId: batchMissionIds[0], delta: 3 },
        { missionId: batchMissionIds[1], delta: 4 },
    ]), true)
    assert.equal(getPlayerCategoryMissionsSync(playerId, 1)[batchMissionIds[0]].progress, 3)
    assert.equal(getPlayerCategoryMissionsSync(playerId, 1)[batchMissionIds[1]].progress, 4)
    assert.equal(incrementPlayerCategoryMissionsIfSafeSync(playerId, 1, [
        { missionId: batchMissionIds[0], delta: 2 },
        { missionId: batchMissionIds[1], delta: 1 },
    ]), true)
    assert.equal(getPlayerCategoryMissionsSync(playerId, 1)[batchMissionIds[0]].progress, 5)
    assert.equal(getPlayerCategoryMissionsSync(playerId, 1)[batchMissionIds[1]].progress, 5)
    updatePlayerCategoryMissionSync(playerId, 1, batchMissionIds[0], Number.MAX_SAFE_INTEGER - 1)
    updatePlayerCategoryMissionSync(playerId, 1, batchMissionIds[1], 8)
    assert.equal(incrementPlayerCategoryMissionsIfSafeSync(playerId, 1, [
        { missionId: batchMissionIds[0], delta: 2 },
        { missionId: batchMissionIds[1], delta: 1 },
    ]), false)
    assert.equal(getPlayerCategoryMissionsSync(playerId, 1)[batchMissionIds[0]].progress, Number.MAX_SAFE_INTEGER - 1)
    assert.equal(getPlayerCategoryMissionsSync(playerId, 1)[batchMissionIds[1]].progress, 8)
    for (const entries of [
        [{ missionId: 0, delta: 1 }],
        [{ missionId: -1, delta: 1 }],
        [{ missionId: batchMissionIds[0], delta: -1 }],
        [{ missionId: batchMissionIds[0], delta: 1 }, { missionId: batchMissionIds[0], delta: 1 }],
    ]) {
        assert.equal(incrementPlayerCategoryMissionsIfSafeSync(playerId, 1, entries), false)
    }

    const invalidSingleIds = [0, NaN, -1, Number.MAX_SAFE_INTEGER + 1]
    for (const invalidMissionId of invalidSingleIds) {
        assert.equal(incrementPlayerCategoryMissionIfSafeSync(playerId, 1, invalidMissionId, 1), false)
    }
    const zeroSingleMissionId = missionId + 7
    assert.equal(incrementPlayerCategoryMissionIfSafeSync(playerId, 1, zeroSingleMissionId, 0), false)
    assert.equal(getPlayerCategoryMissionsSync(playerId, 1)[zeroSingleMissionId], undefined)
    const zeroBatchMissionIds = [missionId + 8, missionId + 9]
    assert.equal(incrementPlayerCategoryMissionsIfSafeSync(playerId, 1, zeroBatchMissionIds.map(id => ({
        missionId: id,
        delta: 0,
    }))), false)
    for (const zeroBatchMissionId of zeroBatchMissionIds) {
        assert.equal(getPlayerCategoryMissionsSync(playerId, 1)[zeroBatchMissionId], undefined)
    }

    const invalidHistory = [
        { missionId: missionId + 10, progress: 1.5 },
        { missionId: missionId + 11, progress: -1 },
        { missionId: missionId + 12, progress: Number.MAX_SAFE_INTEGER + 1 },
    ]
    const insertInvalidHistory = db.prepare(`
        INSERT INTO players_category_missions (category, id, progress, player_id)
        VALUES (?, ?, ?, ?)
    `)
    for (const entry of invalidHistory) {
        if (entry.progress > Number.MAX_SAFE_INTEGER) {
            db.prepare(`
                INSERT INTO players_category_missions (category, id, progress, player_id)
                VALUES (?, ?, 9007199254740992, ?)
            `).run(1, entry.missionId, playerId)
        } else {
            insertInvalidHistory.run(1, entry.missionId, entry.progress, playerId)
        }
        assert.equal(incrementPlayerCategoryMissionIfSafeSync(playerId, 1, entry.missionId, 1), false)
        assert.equal(
            db.prepare(`SELECT progress FROM players_category_missions WHERE category = ? AND id = ? AND player_id = ?`)
                .get(1, entry.missionId, playerId).progress,
            entry.progress,
        )
    }

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
