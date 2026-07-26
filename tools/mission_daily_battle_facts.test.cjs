require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-daily-battle-facts-db-"))
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
const { getPlayerCategoryMissionsSync } = require("../src/data/domains/mission")
const { getPlayerSync, insertDefaultPlayerSync } = require("../src/data/domains/player")
const { recordMissionBattleFacts } = require("../src/lib/mission/battle-facts")
const { recordDailyMissionBattleFacts } = require("../src/lib/mission/daily-battle-facts")
const { settleMissionCategories } = require("../src/lib/mission/settlement")

initializeDatabase()
db = getDb()
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `mission-daily-battle-facts-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
const player = getPlayerSync(playerId)
const activeTime = new Date("2024-08-14T12:00:00.000Z")

function context(overrides = {}) {
    return {
        playerId,
        questCategory: 7,
        questId: 200015001,
        questAccomplished: true,
        clearTime: 1000,
        clearRank: 5,
        party: { characters: [], unison_characters: [] },
        statistics: {
            clear_phase: 1,
            party: { characters: [], unison_characters: [] },
            zones: [],
        },
        player,
        questPreviouslyCompleted: false,
        questProgress: null,
        isMulti: true,
        isMultiHost: true,
        ...overrides,
    }
}

function dailyProgress(missionId) {
    return getPlayerCategoryMissionsSync(playerId, 2)[missionId]?.progress ?? 0
}

assert.deepEqual(
    recordDailyMissionBattleFacts(context(), activeTime),
    [800115, 800116, 800117],
    "Advent selector 200015 应分别匹配三条活动每日任务",
)
assert.deepEqual(
    [800115, 800116, 800117].map(dailyProgress),
    [1, 1, 1],
    "三条 Advent 任务必须独立持久增长",
)
assert.deepEqual(
    settleMissionCategories(playerId, [2], activeTime).missionInfo.map(info => info.mission_id),
    [800115],
    "首次 Advent 通关只应完成阈值为 1 的任务",
)

recordDailyMissionBattleFacts(context({ questId: 200015005 }), activeTime)
assert.deepEqual(
    [800115, 800116, 800117].map(dailyProgress),
    [2, 2, 2],
    "同一 selector 的后续合法关卡仍应分别增长三条任务",
)
assert.deepEqual(
    settleMissionCategories(playerId, [2], activeTime).missionInfo.map(info => info.mission_id),
    [800116],
    "第二次 Advent 通关只应完成阈值为 2 的任务",
)
recordDailyMissionBattleFacts(context({ questId: 200015003 }), activeTime)
assert.deepEqual(
    settleMissionCategories(playerId, [2], activeTime).missionInfo.map(info => info.mission_id),
    [800117],
    "第三次 Advent 通关只应完成阈值为 3 的任务",
)

for (const invalid of [
    { questId: 200016001 },
    { questId: 200015006 },
    { questCategory: 1, questId: 200015001 },
    { isMulti: false },
    { questAccomplished: false },
]) {
    recordDailyMissionBattleFacts(context(invalid), activeTime)
}
assert.deepEqual(
    [800115, 800116, 800117].map(dailyProgress),
    [3, 3, 3],
    "错误 Advent selector、category、单人和失败不得增长",
)

const beforeAdvent = new Date("2024-07-31T12:00:00.000Z")
const afterAdvent = new Date("2024-08-17T00:00:00.000Z")
assert.deepEqual(recordDailyMissionBattleFacts(context(), beforeAdvent), [])
assert.deepEqual(recordDailyMissionBattleFacts(context(), afterAdvent), [])
assert.deepEqual(
    [800115, 800116, 800117].map(dailyProgress),
    [3, 3, 3],
    "Advent 每日任务必须遵守开放期",
)

const bossContext = context({ questCategory: 2, questId: 1014001 })
assert.deepEqual(
    recordDailyMissionBattleFacts(bossContext, activeTime),
    [800124, 800125, 800126],
    "BossBattle category 2 应匹配三条活动每日任务",
)
assert.deepEqual(
    [800124, 800125, 800126].map(dailyProgress),
    [1, 1, 1],
    "三条 BossBattle 任务必须独立持久增长",
)
assert.deepEqual(
    settleMissionCategories(playerId, [2], activeTime).missionInfo.map(info => info.mission_id),
    [800124],
    "首次 BossBattle 通关只应完成阈值为 1 的任务",
)
recordDailyMissionBattleFacts({ ...bossContext, questId: 1001001 }, activeTime)
assert.deepEqual(
    settleMissionCategories(playerId, [2], activeTime).missionInfo.map(info => info.mission_id),
    [800125],
    "BossBattle 全范围的第二次通关应完成阈值为 2 的任务",
)
recordDailyMissionBattleFacts(bossContext, activeTime)
assert.deepEqual(
    settleMissionCategories(playerId, [2], activeTime).missionInfo.map(info => info.mission_id),
    [800126],
    "第三次 BossBattle 通关只应完成阈值为 3 的任务",
)

for (const invalid of [
    { questCategory: 7 },
    { questCategory: 2, isMulti: false },
    { questCategory: 2, questAccomplished: false },
]) {
    recordDailyMissionBattleFacts({ ...bossContext, ...invalid }, activeTime)
}
assert.deepEqual(
    [800124, 800125, 800126].map(dailyProgress),
    [3, 3, 3],
    "错误 Boss category、单人和失败不得增长",
)

assert.deepEqual(
    recordDailyMissionBattleFacts(bossContext, new Date("2024-08-07T11:59:59.000Z")),
    [],
)
assert.deepEqual(
    recordDailyMissionBattleFacts(bossContext, new Date("2024-08-22T00:00:00.000Z")),
    [],
)

const scoreAttackTime = new Date("2024-09-27T04:00:00.000Z")
const scoreAttackContext = context({
    questCategory: 27,
    questId: 1001,
    isMulti: undefined,
    isMultiHost: undefined,
})
assert.deepEqual(
    recordDailyMissionBattleFacts(scoreAttackContext, scoreAttackTime),
    [10075],
    "无限演武每日任务必须匹配 event 1 的成功单人关卡",
)
assert.equal(dailyProgress(10075), 1)
const scoreAttackSettlement = settleMissionCategories(playerId, [2], scoreAttackTime)
assert.deepEqual(
    scoreAttackSettlement.missionInfo.map(info => info.mission_id),
    [10075],
    "无限演武每日任务达到 1 次后必须正常结算奖励",
)
assert.equal(scoreAttackSettlement.itemList["40501"], 6, "无限演武每日任务必须发放 6 个无限金币")
for (const invalid of [
    { isMulti: true },
    { questCategory: 1 },
    { questId: 999999 },
    { questAccomplished: false },
]) {
    recordDailyMissionBattleFacts({ ...scoreAttackContext, ...invalid }, scoreAttackTime)
}
recordDailyMissionBattleFacts(scoreAttackContext, new Date("2024-09-27T03:59:59.999Z"))
assert.equal(dailyProgress(10075), 1, "错误模式、关卡、失败和开放前结算不得增长无限演武每日任务")

const anyBattleTime = new Date("2025-06-26T04:00:00.000Z")
const anySingleBattleContext = context({
    questCategory: 1,
    questId: 100101,
    isMulti: undefined,
    isMultiHost: undefined,
})
assert.deepEqual(
    recordDailyMissionBattleFacts(anySingleBattleContext, anyBattleTime),
    [800392],
    "通关单人/协力战斗每日任务必须接受成功单人结算",
)
assert.equal(dailyProgress(800392), 1)
const anyBattleSettlement = settleMissionCategories(playerId, [2], anyBattleTime)
assert.deepEqual(
    anyBattleSettlement.missionInfo.map(info => info.mission_id),
    [800392],
    "通关单人/协力战斗每日任务达到 1 次后必须正常结算奖励",
)
assert.equal(anyBattleSettlement.itemList["10000072"], 1, "单人/协力每日任务必须发放主数据奖励")
assert.deepEqual(
    recordDailyMissionBattleFacts(context({
        questCategory: 2,
        questId: 1014001,
        isMulti: true,
        isMultiHost: true,
    }), anyBattleTime),
    [800392],
    "通关单人/协力战斗每日任务必须接受成功协力结算",
)
recordDailyMissionBattleFacts({ ...anySingleBattleContext, questAccomplished: false }, anyBattleTime)
recordDailyMissionBattleFacts(anySingleBattleContext, new Date("2025-06-26T03:59:59.999Z"))
assert.equal(dailyProgress(800392), 2, "失败和开放前结算不得增长单人/协力每日任务")

const routeAccount = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `mission-daily-battle-route-${randomUUID()}`,
    status: "normal",
})
const routePlayerId = insertDefaultPlayerSync(routeAccount.id).id
const routePlayer = getPlayerSync(routePlayerId)
const routeContext = { ...bossContext, playerId: routePlayerId, player: routePlayer }
recordMissionBattleFacts(routeContext, activeTime)
recordMissionBattleFacts({ ...routeContext, questAccomplished: false }, activeTime)
assert.deepEqual(
    [800124, 800125, 800126].map(missionId => (
        getPlayerCategoryMissionsSync(routePlayerId, 2)[missionId]?.progress ?? 0
    )),
    [1, 1, 1],
    "成功结算才接入活动每日事实，失败 finish 不得记录",
)

console.log("mission daily battle facts tests passed")
cleanup()
process.removeListener("exit", cleanup)
