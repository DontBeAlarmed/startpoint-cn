const assert = require("node:assert/strict")

const { getDb } = require("../out/data/db")
const {
    deletePlayerCategoryMissionsSync,
    getPlayerActiveMissionsSync,
    getPlayerCategoryMissionsSync,
    incrementPlayerCategoryMissionSync,
    updatePlayerActiveMissionStageSync,
    updatePlayerActiveMissionSync,
    updatePlayerCategoryMissionStageSync,
    updatePlayerCategoryMissionSync,
} = require("../out/data/domains/mission")

const db = getDb()
const player = db.prepare("SELECT id FROM players ORDER BY id LIMIT 1").get()

if (!player) {
    console.log("mission storage tests skipped: no local player")
    process.exit(0)
}

db.exec("BEGIN")
try {
    const playerId = player.id
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
