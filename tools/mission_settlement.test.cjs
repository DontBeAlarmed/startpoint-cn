require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-settlement-db-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR
let db

function cleanup() {
    if (db?.open) db.close()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
}

process.once("exit", cleanup)

const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerCategoryMissionsSync, updatePlayerCategoryMissionSync } = require("../src/data/domains/mission")
const { getPlayerSync, insertDefaultPlayerSync } = require("../src/data/domains/player")
const { givePlayerItemSync } = require("../src/data/domains/item")
const { settleMissionCategories } = require("../src/lib/mission/settlement")
const { takeSnapshot } = require("../src/lib/mission/snapshot")

initializeDatabase()
db = getDb()

function createPlayer(label) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `${label}-${randomUUID()}`,
        status: "normal",
    })
    return insertDefaultPlayerSync(account.id).id
}

const evaluationTime = new Date("2025-01-01T12:00:00.000Z")
const playerId = createPlayer("mission-settlement")
const initialVmoney = getPlayerSync(playerId).freeVmoney
updatePlayerCategoryMissionSync(playerId, 1, 1, 30)

const first = settleMissionCategories(playerId, [1], evaluationTime)
assert.deepEqual(first.missionInfo, [
    { mission_category_id: 1, mission_id: 1, mission_reward_id: 1001 },
    { mission_category_id: 1, mission_id: 1, mission_reward_id: 1002 },
    { mission_category_id: 1, mission_id: 1, mission_reward_id: 1003 },
])
assert.equal(first.userInfo.free_vmoney, initialVmoney + 15)
assert.equal(getPlayerSync(playerId).freeVmoney, initialVmoney + 15)
assert.deepEqual(getPlayerCategoryMissionsSync(playerId, 1)[1], {
    progress: 30,
    stages: { 1: true, 2: true, 3: true },
})

const repeated = settleMissionCategories(playerId, [1], evaluationTime)
assert.deepEqual(repeated.missionInfo, [])
assert.deepEqual(repeated.itemList, {})
assert.equal(getPlayerSync(playerId).freeVmoney, initialVmoney + 15)

const collectPlayerId = createPlayer("mission-collect-settlement")
givePlayerItemSync(collectPlayerId, 80001, 50)
const collectSettlement = settleMissionCategories(
    collectPlayerId,
    [{ category: 4, eventId: 1 }],
    new Date("2020-02-21T03:00:00.000Z"),
)
assert.deepEqual(collectSettlement.missionInfo, [
    { mission_category_id: 4, mission_id: 1500, mission_reward_id: 1500001 },
])
assert.deepEqual(getPlayerCategoryMissionsSync(collectPlayerId, 4)[1500], {
    progress: 50,
    stages: { 1: true },
})

const wrongEventPlayerId = createPlayer("mission-collect-wrong-event")
givePlayerItemSync(wrongEventPlayerId, 80001, 50)
const wrongEventSettlement = settleMissionCategories(
    wrongEventPlayerId,
    [{ category: 4, eventId: 2 }],
    new Date("2020-02-21T03:00:00.000Z"),
)
assert.deepEqual(wrongEventSettlement.missionInfo, [])
assert.equal(getPlayerCategoryMissionsSync(wrongEventPlayerId, 4)[1500], undefined)

const duplicateScopePlayerId = createPlayer("mission-duplicate-scope")
const duplicateScopeVmoney = getPlayerSync(duplicateScopePlayerId).freeVmoney
updatePlayerCategoryMissionSync(duplicateScopePlayerId, 1, 1, 10)
const duplicateScopeSettlement = settleMissionCategories(
    duplicateScopePlayerId,
    [{ category: 1, eventId: 1 }, { category: 1, eventId: 2 }],
    evaluationTime,
)
assert.equal(duplicateScopeSettlement.missionInfo.length, 1)
assert.equal(getPlayerSync(duplicateScopePlayerId).freeVmoney, duplicateScopeVmoney + 5)

const periodicPlayerId = createPlayer("mission-periodic-nonnegative")
takeSnapshot(periodicPlayerId, "daily", {
    questClears: 100,
    staminaUsed: 100,
    rankSs: 100,
    rankS: 100,
    rankA: 100,
    rankB: 100,
})
settleMissionCategories(periodicPlayerId, [2], evaluationTime)
for (const mission of Object.values(getPlayerCategoryMissionsSync(periodicPlayerId, 2))) {
    assert.equal(mission.progress >= 0, true)
}

const rollbackPlayerId = createPlayer("mission-settlement-rollback")
const rollbackVmoney = getPlayerSync(rollbackPlayerId).freeVmoney
updatePlayerCategoryMissionSync(rollbackPlayerId, 1, 1, 10)
db.exec(`
    CREATE TRIGGER fail_mission_stage_insert
    AFTER INSERT ON players_category_mission_stages
    WHEN NEW.player_id = ${rollbackPlayerId}
    BEGIN
        SELECT RAISE(ABORT, 'injected mission stage failure');
    END;
`)
assert.throws(
    () => settleMissionCategories(rollbackPlayerId, [1], evaluationTime),
    /injected mission stage failure/,
)
assert.equal(getPlayerSync(rollbackPlayerId).freeVmoney, rollbackVmoney)
assert.deepEqual(getPlayerCategoryMissionsSync(rollbackPlayerId, 1)[1], {
    progress: 10,
    stages: [],
})

console.log("mission settlement tests passed")
cleanup()
process.removeListener("exit", cleanup)
