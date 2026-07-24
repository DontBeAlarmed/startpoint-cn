require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-pass-db-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR
let db
let restoreTimeOffset = () => {}

function cleanup() {
    if (db?.open) db.close()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
    restoreTimeOffset()
}

process.once("exit", cleanup)

const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    getPlayerCategoryMissionsSync,
    updatePlayerCategoryMissionSync,
} = require("../src/data/domains/mission")
const {
    dailyResetPlayerDataSync,
    getPlayerSync,
    insertDefaultPlayerSync,
    updatePlayerSync,
} = require("../src/data/domains/player")
const { settleMissionCategories } = require("../src/lib/mission/settlement")
const { getTimeOffset, setServerTimeOffset } = require("../src/utils")

const previousTimeOffset = getTimeOffset()
restoreTimeOffset = () => setServerTimeOffset(previousTimeOffset)

initializeDatabase()
db = getDb()

const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `mission-pass-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
const evaluationTime = new Date("2024-08-14T12:00:00.000Z")

updatePlayerCategoryMissionSync(playerId, 6, 9, 1)
const first = settleMissionCategories(playerId, [6], evaluationTime)
assert.deepEqual(first.missionInfo, [{
    mission_category_id: 6,
    mission_id: 9,
    mission_reward_id: 9001,
}])
assert.deepEqual(first.passCardPoints, { 3: 50 })
assert.equal(db.prepare(`
    SELECT point FROM players_pass_cards WHERE player_id = ? AND event_id = 3
`).get(playerId).point, 50)
assert.deepEqual(getPlayerCategoryMissionsSync(playerId, 6)[9], {
    progress: 1,
    stages: { 1: true },
})

const repeated = settleMissionCategories(playerId, [6], evaluationTime)
assert.deepEqual(repeated.missionInfo, [])
assert.deepEqual(repeated.passCardPoints, {})
assert.equal(db.prepare(`
    SELECT point FROM players_pass_cards WHERE player_id = ? AND event_id = 3
`).get(playerId).point, 50)

const eventLogin = settleMissionCategories(playerId, [8], evaluationTime)
assert.deepEqual(eventLogin.missionInfo, [{
    mission_category_id: 8,
    mission_id: 13,
    mission_reward_id: 13001,
}])
assert.deepEqual(eventLogin.passCardPoints, { 3: 150 })
assert.equal(db.prepare(`
    SELECT point FROM players_pass_cards WHERE player_id = ? AND event_id = 3
`).get(playerId).point, 150)

db.prepare(`
    UPDATE players_pass_cards SET point = 5990 WHERE player_id = ? AND event_id = 3
`).run(playerId)
updatePlayerCategoryMissionSync(playerId, 6, 10, 10)
const capped = settleMissionCategories(playerId, [6], evaluationTime)
assert.deepEqual(capped.passCardPoints, { 3: 6000 })
assert.equal(db.prepare(`
    SELECT point FROM players_pass_cards WHERE player_id = ? AND event_id = 3
`).get(playerId).point, 6000)

const resetAccount = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `mission-pass-reset-${randomUUID()}`,
    status: "normal",
})
const resetPlayerId = insertDefaultPlayerSync(resetAccount.id).id
updatePlayerCategoryMissionSync(resetPlayerId, 6, 9, 1)
updatePlayerCategoryMissionSync(resetPlayerId, 7, 9, 40)
updatePlayerSync({ id: resetPlayerId, lastLoginTime: new Date("2024-08-13T12:00:00.000Z") })
assert.equal(
    dailyResetPlayerDataSync(
        getPlayerSync(resetPlayerId),
        new Date("2024-08-14T12:00:00.000Z"),
    ),
    true,
)
assert.deepEqual(getPlayerCategoryMissionsSync(resetPlayerId, 6), {})
assert.equal(getPlayerCategoryMissionsSync(resetPlayerId, 7)[9].progress, 40)

updatePlayerCategoryMissionSync(resetPlayerId, 6, 9, 1)
assert.equal(
    dailyResetPlayerDataSync(
        getPlayerSync(resetPlayerId),
        new Date("2024-08-19T12:00:00.000Z"),
    ),
    true,
)
assert.deepEqual(getPlayerCategoryMissionsSync(resetPlayerId, 6), {})
assert.deepEqual(getPlayerCategoryMissionsSync(resetPlayerId, 7), {})

const rollbackAccount = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `mission-pass-reset-rollback-${randomUUID()}`,
    status: "normal",
})
const rollbackPlayerId = insertDefaultPlayerSync(rollbackAccount.id).id
const rollbackLastLogin = new Date("2024-08-13T12:00:00.000Z")
const rollbackLogin = new Date("2024-08-14T12:00:00.000Z")
updatePlayerSync({
    id: rollbackPlayerId,
    lastLoginTime: rollbackLastLogin,
    bossBoostPoint: 1,
    boostPoint: 1,
})
updatePlayerCategoryMissionSync(rollbackPlayerId, 6, 9, 1)
const rollbackBefore = getPlayerSync(rollbackPlayerId)
db.exec(`
    CREATE TRIGGER reject_pass_login_after_player_update
    BEFORE INSERT ON players_pass_cards
    WHEN NEW.player_id = ${rollbackPlayerId}
    BEGIN
        SELECT RAISE(ABORT, 'injected pass login failure');
    END
`)
assert.throws(
    () => dailyResetPlayerDataSync(getPlayerSync(rollbackPlayerId), rollbackLogin),
    /injected pass login failure/,
)
db.exec("DROP TRIGGER reject_pass_login_after_player_update")
const rollbackAfterFailure = getPlayerSync(rollbackPlayerId)
assert.equal(rollbackAfterFailure.lastLoginTime.toISOString(), rollbackBefore.lastLoginTime.toISOString())
assert.equal(rollbackAfterFailure.totalLoginDays, rollbackBefore.totalLoginDays)
assert.equal(rollbackAfterFailure.bossBoostPoint, rollbackBefore.bossBoostPoint)
assert.equal(rollbackAfterFailure.boostPoint, rollbackBefore.boostPoint)
assert.equal(getPlayerCategoryMissionsSync(rollbackPlayerId, 6)[9].progress, 1)
assert.equal(
    dailyResetPlayerDataSync(getPlayerSync(rollbackPlayerId), rollbackLogin),
    true,
    "失败回滚后同一次跨日登录必须仍可重试",
)
assert.deepEqual(getPlayerCategoryMissionsSync(rollbackPlayerId, 6), {})
assert.equal(getPlayerSync(rollbackPlayerId).bossBoostPoint, 3)
assert.equal(getPlayerSync(rollbackPlayerId).boostPoint, 3)

const lateRollbackAccount = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `mission-pass-late-reset-rollback-${randomUUID()}`,
    status: "normal",
})
const lateRollbackPlayerId = insertDefaultPlayerSync(lateRollbackAccount.id).id
const lateRollbackLastLogin = new Date("2024-08-18T12:00:00.000Z")
const lateRollbackLogin = new Date("2024-08-19T12:00:00.000Z")
updatePlayerSync({
    id: lateRollbackPlayerId,
    lastLoginTime: lateRollbackLastLogin,
    bossBoostPoint: 1,
    boostPoint: 1,
})
updatePlayerCategoryMissionSync(lateRollbackPlayerId, 6, 9, 1)
updatePlayerCategoryMissionSync(lateRollbackPlayerId, 7, 9, 40)
const lateRollbackBefore = getPlayerSync(lateRollbackPlayerId)
db.exec(`
    CREATE TRIGGER reject_weekly_pass_reset
    BEFORE DELETE ON players_category_missions
    WHEN OLD.player_id = ${lateRollbackPlayerId} AND OLD.category = 7
    BEGIN
        SELECT RAISE(ABORT, 'injected late pass reset failure');
    END
`)
assert.throws(
    () => dailyResetPlayerDataSync(getPlayerSync(lateRollbackPlayerId), lateRollbackLogin),
    /injected late pass reset failure/,
)
db.exec("DROP TRIGGER reject_weekly_pass_reset")
const lateRollbackAfter = getPlayerSync(lateRollbackPlayerId)
assert.equal(lateRollbackAfter.lastLoginTime.toISOString(), lateRollbackBefore.lastLoginTime.toISOString())
assert.equal(lateRollbackAfter.totalLoginDays, lateRollbackBefore.totalLoginDays)
assert.equal(lateRollbackAfter.bossBoostPoint, lateRollbackBefore.bossBoostPoint)
assert.equal(lateRollbackAfter.boostPoint, lateRollbackBefore.boostPoint)
assert.equal(getPlayerCategoryMissionsSync(lateRollbackPlayerId, 6)[9].progress, 1)
assert.equal(getPlayerCategoryMissionsSync(lateRollbackPlayerId, 7)[9].progress, 40)
assert.equal(
    dailyResetPlayerDataSync(getPlayerSync(lateRollbackPlayerId), lateRollbackLogin),
    true,
    "嵌套日常删除完成后的失败也必须允许同一次跨周登录重试",
)
assert.deepEqual(getPlayerCategoryMissionsSync(lateRollbackPlayerId, 6), {})
assert.deepEqual(getPlayerCategoryMissionsSync(lateRollbackPlayerId, 7), {})

setServerTimeOffset(Date.parse("2025-09-01T04:00:00.000Z") - Date.now())
const loginAccount = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `mission-pass-login-${randomUUID()}`,
    status: "normal",
})
const loginPlayerId = insertDefaultPlayerSync(loginAccount.id).id
for (const day of [2, 3, 4, 5]) {
    dailyResetPlayerDataSync(
        getPlayerSync(loginPlayerId),
        new Date(`2025-09-0${day}T04:00:00.000Z`),
    )
}
const delayedLoginSettlement = settleMissionCategories(
    loginPlayerId,
    [8],
    new Date("2025-09-05T04:00:00.000Z"),
)
assert.deepEqual(
    delayedLoginSettlement.missionInfo.map(info => info.mission_id),
    [92, 93, 94, 95, 96, 97],
    "玩家不打开 Pass 页面时也必须累计活动窗口内的每日登录",
)

console.log("mission pass settlement tests passed")
cleanup()
process.removeListener("exit", cleanup)
