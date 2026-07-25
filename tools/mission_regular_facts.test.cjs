require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-regular-facts-db-"))
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
const {
    getMissionBattleCountersSync,
    recordMissionBattleResultSync,
} = require("../src/data/domains/mission_battle_facts")
const { insertPlayerQuestProgressSync } = require("../src/data/domains/quest")
const {
    dailyResetPlayerDataSync,
    getPlayerSync,
    insertDefaultPlayerSync,
    updatePlayerSync,
} = require("../src/data/domains/player")
const { getComputer } = require("../src/lib/mission/registry")
const { settleMissionCategories } = require("../src/lib/mission/settlement")
const { getSnapshot, takeSnapshot } = require("../src/lib/mission/snapshot")
const { getRankDegree } = require("../src/lib/stamina")
const { getMergedPlayerDataSync } = require("../src/data/utils/player-data")
const { replacePlayerDataSync } = require("../src/data/domains/player")

initializeDatabase()
db = getDb()

const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `mission-regular-facts-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
assert.equal(getPlayerSync(playerId).totalLoginDays, 1, "新存档创建当天应计为首个登录日")
assert.equal(getSnapshot(playerId, "daily").staminaUsed, 0)
assert.equal(
    getSnapshot(playerId, "weekly").loginDays,
    0,
    "新存档的每周基线应保留首日登录进度",
)

assert.deepEqual(getMissionBattleCountersSync(playerId), {
    singlePlayCount: 0,
    singleClearCount: 0,
    multiPlayCount: 0,
    multiClearCount: 0,
    multiHostClearCount: 0,
    multiGuestClearCount: 0,
    singleRankSsCount: 0,
    rankSsCount: 0,
    rankSCount: 0,
    rankACount: 0,
    rankBCount: 0,
    challengeDungeonClearCount: 0,
})

recordMissionBattleResultSync(playerId, {
    isMulti: false,
    questCategory: 13,
    accomplished: false,
})
for (let index = 0; index < 3; index++) {
    recordMissionBattleResultSync(playerId, {
        isMulti: false,
        questCategory: 13,
        accomplished: true,
        clearRank: index === 0 ? 5 : 4,
    })
}
recordMissionBattleResultSync(playerId, {
    isMulti: true,
    questCategory: 13,
    isHost: true,
    accomplished: true,
})
recordMissionBattleResultSync(playerId, {
    isMulti: true,
    questCategory: 13,
    isHost: false,
    accomplished: false,
})
for (let index = 0; index < 14; index++) {
    recordMissionBattleResultSync(playerId, {
        isMulti: true,
        questCategory: 13,
        isHost: false,
        accomplished: true,
    })
}

assert.deepEqual(getMissionBattleCountersSync(playerId), {
    singlePlayCount: 4,
    singleClearCount: 3,
    multiPlayCount: 16,
    multiClearCount: 15,
    multiHostClearCount: 1,
    multiGuestClearCount: 14,
    singleRankSsCount: 1,
    rankSsCount: 1,
    rankSCount: 2,
    rankACount: 0,
    rankBCount: 0,
    challengeDungeonClearCount: 18,
})

assert.throws(() => {
    db.transaction(() => {
        recordMissionBattleResultSync(playerId, {
            isMulti: false,
            questCategory: 13,
            accomplished: true,
        })
        throw new Error("rollback challenge dungeon fact")
    })()
}, /rollback challenge dungeon fact/)
assert.equal(
    getMissionBattleCountersSync(playerId).challengeDungeonClearCount,
    18,
    "结算事务回滚后不得留下挑战副本累计次数",
)

insertPlayerQuestProgressSync(playerId, 1, {
    questId: 101,
    finished: true,
    clearRank: 5,
})
updatePlayerSync({
    id: playerId,
    rankPoint: 10000,
    totalStaminaUsed: 50,
    totalPowerflips: 7,
    totalDashes: 10,
    totalLoginDays: 3,
})
takeSnapshot(playerId, "daily", {
    questClears: 0,
    staminaUsed: 0,
    rankSs: 0,
    rankS: 0,
    rankA: 0,
    rankB: 0,
    singlePlayCount: 0,
    singleClearCount: 0,
    multiPlayCount: 0,
    multiClearCount: 0,
    multiHostClearCount: 0,
    multiGuestClearCount: 0,
    dashCount: 0,
    powerFlipCount: 0,
    loginDays: 0,
})
takeSnapshot(playerId, "weekly", {
    questClears: 0,
    staminaUsed: 0,
    rankSs: 0,
    rankS: 0,
    rankA: 0,
    rankB: 0,
    singlePlayCount: 0,
    singleClearCount: 0,
    multiPlayCount: 0,
    multiClearCount: 0,
    multiHostClearCount: 0,
    multiGuestClearCount: 0,
    dashCount: 0,
    powerFlipCount: 0,
    loginDays: 0,
})

const regular = getComputer(1)
const regularContext = regular.buildContext(playerId, 1)
assert.equal(regular.compute(2, regularContext, 0), 1, "SS 评价按 clear_rank=5 的累计达成次数计算")
assert.equal(regular.compute(3, regularContext, 0), 10)
assert.equal(regular.compute(6, regularContext, 0), 3, "重复通关同一关也必须增加累计通关")
assert.equal(regular.compute(7, regularContext, 0), 7)
assert.equal(regular.compute(22, regularContext, 0), getRankDegree(10000))
assert.equal(regular.compute(24, regularContext, 0), 3)
assert.equal(regular.compute(25, regularContext, 0), 15)
assert.equal(regular.compute(26, regularContext, 0), 1)
assert.equal(regular.compute(27, regularContext, 0), 14)

const daily = getComputer(2)
const dailyContext = daily.buildContext(playerId, 2)
assert.equal(daily.compute(11, dailyContext, 0), 3)
assert.equal(daily.compute(13, dailyContext, 0), 15)
assert.equal(daily.compute(14, dailyContext, 0), 10)
assert.equal(daily.compute(16, dailyContext, 0), 50)

const weekly = getComputer(10)
const weeklyContext = weekly.buildContext(playerId, 10)
assert.equal(weekly.compute(1, weeklyContext, 0), 3, "每周登录必须读取 category 10 自身主数据")
assert.equal(weekly.compute(2, weeklyContext, 0), 15, "每周协力必须读取本周期累计通关")

const weeklySettlement = settleMissionCategories(playerId, [10], new Date("2024-08-14T12:00:00.000Z"))
assert.deepEqual(
    weeklySettlement.missionInfo.map(entry => entry.mission_id),
    [1, 2],
    "每周只应结算现有的登录与协力两条任务",
)
const reloadedWeeklyContext = getComputer(10).buildContext(playerId, 10)
assert.equal(weekly.compute(1, reloadedWeeklyContext, 0), 3, "重新读取仍应保留本周登录进度")
assert.equal(weekly.compute(2, reloadedWeeklyContext, 0), 15, "重新读取仍应保留本周协力进度")
assert.deepEqual(
    settleMissionCategories(playerId, [10], new Date("2024-08-14T12:00:00.000Z")).missionInfo,
    [],
    "重复结算不得再次发放每周任务奖励",
)

const evaluationTime = new Date("2024-08-14T12:00:00.000Z")
const dailySettlement = settleMissionCategories(playerId, [2], evaluationTime)
assert.deepEqual(
    dailySettlement.missionInfo
        .filter(entry => entry.mission_id < 100)
        .map(entry => entry.mission_id),
    [11, 13, 14, 16, 17],
    "四项基础每日任务应在同一次结算中触发全部完成任务",
)

const boundaryAccount = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `mission-weekly-boundary-${randomUUID()}`,
    status: "normal",
})
const boundaryPlayerId = insertDefaultPlayerSync(boundaryAccount.id).id
updatePlayerSync({
    id: boundaryPlayerId,
    lastLoginTime: new Date("2024-08-18T20:00:00.000Z"),
})
for (let index = 0; index < 2; index++) {
    recordMissionBattleResultSync(boundaryPlayerId, {
        isMulti: true,
        isHost: false,
        accomplished: true,
    })
}

assert.equal(
    dailyResetPlayerDataSync(
        getPlayerSync(boundaryPlayerId),
        new Date("2024-08-18T20:59:59.999Z"),
    ),
    false,
    "北京时间周一 05:00 前不得重置周常",
)
assert.equal(getSnapshot(boundaryPlayerId, "weekly").multiClearCount, 0)
assert.equal(
    dailyResetPlayerDataSync(
        getPlayerSync(boundaryPlayerId),
        new Date("2024-08-18T21:00:00.000Z"),
    ),
    true,
    "北京时间周一 05:00 必须生成新的周常快照",
)
assert.equal(getSnapshot(boundaryPlayerId, "weekly").multiClearCount, 2)

for (let index = 0; index < 3; index++) {
    recordMissionBattleResultSync(boundaryPlayerId, {
        isMulti: true,
        isHost: false,
        accomplished: true,
    })
}
const boundaryWeeklyContext = getComputer(10).buildContext(boundaryPlayerId, 10)
assert.equal(getComputer(10).compute(2, boundaryWeeklyContext, 0), 3)
assert.equal(
    dailyResetPlayerDataSync(
        getPlayerSync(boundaryPlayerId),
        new Date("2024-08-18T21:00:01.000Z"),
    ),
    false,
    "同一周重复 load 不得再次重置",
)
const repeatedLoadContext = getComputer(10).buildContext(boundaryPlayerId, 10)
assert.equal(
    getComputer(10).compute(2, repeatedLoadContext, 0),
    3,
    "重复 load 后本周协力进度必须保持",
)

recordMissionBattleResultSync(playerId, {
    isMulti: false,
    questCategory: 1,
    accomplished: true,
})
assert.equal(
    getMissionBattleCountersSync(playerId).challengeDungeonClearCount,
    18,
    "普通关卡成功不得污染挑战副本累计次数",
)

const replacement = getMergedPlayerDataSync(playerId)
assert.ok(replacement)
replacePlayerDataSync(replacement)
const replacedPlayer = getPlayerSync(playerId)
assert.equal(getSnapshot(playerId, "daily").staminaUsed, replacedPlayer.totalStaminaUsed)
assert.equal(getSnapshot(playerId, "daily").dashCount, replacedPlayer.totalDashes)
assert.equal(getSnapshot(playerId, "weekly").loginDays, replacedPlayer.totalLoginDays)

console.log("mission regular facts tests passed")
cleanup()
process.removeListener("exit", cleanup)
