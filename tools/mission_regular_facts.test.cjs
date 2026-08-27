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
const { recordDegreeBattleStatsSync } = require("../src/data/domains/degree_battle_stats")
const { deletePlayerEquipmentSync, insertPlayerEquipmentSync } = require("../src/data/domains/equipment")
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
const {
    countAbilitySoulEquipments,
    recordMissionOperationFactsSync,
} = require("../src/lib/mission/degree-operation-facts")
const {
    settleAbilitySoulEquipFactsSync,
} = require("../src/lib/mission/operation-fact-settlement")
const { recordRegularMissionBattleFactsSync } = require("../src/lib/mission/regular-battle-facts")
const { recordDegreeMissionBattleFacts } = require("../src/lib/mission/degree-battle-facts")
const { getPlayerCategoryMissionsSync } = require("../src/data/domains/mission")
const { getMergedPlayerDataSync } = require("../src/data/utils/player-data")
const { replacePlayerDataSync } = require("../src/data/domains/player")
const mainQuests = require("../assets/main_quest.json")
const exQuests = require("../assets/ex_quest.json")

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
    singleScoreMax: 0,
    singleClearTimeMin: 0,
    bossBattleClearCount: 0,
    skillUseCount: 0,
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
    singleScoreMax: 0,
    singleClearTimeMin: 0,
    bossBattleClearCount: 0,
    skillUseCount: 0,
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
    totalManaObtained: 1234,
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

recordMissionBattleResultSync(playerId, {
    isMulti: false,
    questCategory: 1,
    accomplished: true,
    score: 10_000_000,
})
recordMissionBattleResultSync(playerId, {
    isMulti: false,
    questCategory: 1,
    accomplished: true,
    score: 50_000_000,
})
recordMissionBattleResultSync(playerId, {
    isMulti: true,
    questCategory: 1,
    accomplished: true,
    score: 99_999_999,
})
recordMissionBattleResultSync(playerId, {
    isMulti: false,
    questCategory: 1,
    accomplished: false,
    score: 99_999_999,
})
recordMissionBattleResultSync(playerId, {
    isMulti: false,
    questCategory: 1,
    accomplished: true,
    clearTime: 12_000,
})
recordMissionBattleResultSync(playerId, {
    isMulti: false,
    questCategory: 1,
    accomplished: true,
    clearTime: 4_000,
})
recordMissionBattleResultSync(playerId, {
    isMulti: true,
    questCategory: 1,
    accomplished: true,
    clearTime: 1,
})
recordMissionBattleResultSync(playerId, {
    isMulti: false,
    questCategory: 1,
    accomplished: false,
    clearTime: 1,
})
recordMissionBattleResultSync(playerId, {
    isMulti: false,
    questCategory: 2,
    accomplished: true,
})
recordMissionBattleResultSync(playerId, {
    isMulti: true,
    questCategory: 2,
    accomplished: true,
})
recordMissionBattleResultSync(playerId, {
    isMulti: false,
    questCategory: 2,
    accomplished: false,
})
assert.equal(
    getMissionBattleCountersSync(playerId).singleScoreMax,
    50_000_000,
    "单人最高分应保留成功战斗中的最大分数",
)
assert.equal(
    getMissionBattleCountersSync(playerId).singleClearTimeMin,
    4_000,
    "单人最快成功时间应保留最小耗时",
)
assert.equal(
    getMissionBattleCountersSync(playerId).bossBattleClearCount,
    2,
    "领主战累计只应统计 category 2 的成功结算",
)
recordMissionBattleResultSync(playerId, {
    isMulti: false,
    accomplished: true,
    skillUseCount: 25,
})
recordMissionBattleResultSync(playerId, {
    isMulti: true,
    accomplished: true,
    skillUseCount: 75,
})
recordMissionBattleResultSync(playerId, {
    isMulti: false,
    accomplished: false,
    skillUseCount: 1000,
})
assert.equal(
    getMissionBattleCountersSync(playerId).skillUseCount,
    100,
    "技能使用累计只应统计成功结算中的合法次数",
)
recordDegreeBattleStatsSync(playerId, {
    feverCount: 7,
    feverMs: 0,
    debuffEnemyCount: 0,
    clearEnemyBuffCount: 0,
    clearSelfDebuffCount: 0,
    buffPartyCount: 0,
    healPartyCount: 0,
    emotionCount: 0,
    enemyKillCount: 19,
    weakPointAttackCount: 11,
    powerFlipLv3Count: 0,
    coffinReducedCount: 0,
    damageDealMax: 0,
    revivalCoffinMax: 0,
    partyPowerMax: 500,
    skillChainMax: 4,
})
insertPlayerEquipmentSync(playerId, 100001, {
    level: 1,
    enhancementLevel: 0,
    protection: false,
    stack: 0,
})
insertPlayerEquipmentSync(playerId, 200001, {
    level: 5,
    enhancementLevel: 0,
    protection: false,
    stack: 0,
})

insertPlayerQuestProgressSync(playerId, 3, {
    questId: 101001,
    finished: true,
})
for (const questId of Object.keys(mainQuests).map(Number)
    .filter(questId => Math.floor(questId / 1_000_000) === 1)) {
    insertPlayerQuestProgressSync(playerId, 1, {
        questId,
        finished: true,
    })
}
for (const questId of Object.keys(exQuests).map(Number)
    .filter(questId => Math.floor(questId / 1_000_000) === 1)) {
    insertPlayerQuestProgressSync(playerId, 4, {
        questId,
        finished: true,
    })
}
insertPlayerQuestProgressSync(playerId, 15, {
    questId: 1,
    finished: true,
})

const expandedRegularContext = regular.buildContext(playerId, 1)
assert.equal(regular.compute(8, expandedRegularContext, 0), 100, "技能成就应读取成功结算累计")
assert.equal(
    regular.compute(9, expandedRegularContext, 0),
    getRankDegree(10_000),
    "character_level 是玩家等级成就，不读取角色经验",
)
assert.equal(regular.compute(10, expandedRegularContext, 0), 1, "第 1 章全部普通关卡完成后应达成")
assert.equal(regular.compute(16, expandedRegularContext, 0), 1, "第 1 章全部高难关卡完成后应达成")
assert.equal(regular.compute(69, expandedRegularContext, 0), 1, "新版第 1 章高难定义应使用相同官方范围")
assert.equal(regular.compute(23, expandedRegularContext, 0), 1, "角色故事应按完成记录累计")
assert.equal(regular.compute(42, expandedRegularContext, 0), 1, "指定主线关卡应按 QuestRange 精确完成")
assert.equal(regular.compute(56, expandedRegularContext, 0), 1, "任意属性假人只需完成候选关卡之一")
assert.equal(regular.compute(5, expandedRegularContext, 0), 11, "弱点攻击读取累计战斗事实")
assert.equal(regular.compute(28, expandedRegularContext, 0), 4, "最大技能连锁读取历史最大值")
assert.equal(regular.compute(30, expandedRegularContext, 0), 500, "通关战力读取历史最大值")
assert.equal(regular.compute(31, expandedRegularContext, 0), 7, "狂热发动次数读取累计事实")
assert.equal(regular.compute(34, expandedRegularContext, 0), 50_000_000, "分数成就读取单人最高分")
assert.equal(regular.compute(35, expandedRegularContext, 0), 19, "敌人讨伐读取累计事实")
assert.equal(regular.compute(33, expandedRegularContext, 0), 2, "装备种类按当前不同 ID 复算")
assert.equal(
    regular.compute(40, expandedRegularContext, 0),
    getPlayerSync(playerId).totalManaObtained,
    "累计玛纳读取玩家历史累计",
)
assert.equal(regular.compute(68, expandedRegularContext, 0), 1, "只有实际达到 5 级的装备才计数")
recordMissionOperationFactsSync(playerId, "treasure_mana", 250)
recordMissionOperationFactsSync(playerId, "equipment_upgrade", 3)
const operationRegularContext = regular.buildContext(playerId, 1)
const operationProgress = getPlayerCategoryMissionsSync(playerId, 1)
assert.equal(
    regular.compute(41, operationRegularContext, operationProgress[41].progress),
    250,
    "珍品商店玛纳消耗必须保留累计历史",
)
assert.equal(
    regular.compute(67, operationRegularContext, operationProgress[67].progress),
    4,
    "装备觉醒以当前状态与累计历史的较大值为准",
)
deletePlayerEquipmentSync(playerId, 200001)
assert.equal(
    regular.compute(67, regular.buildContext(playerId, 1), operationProgress[67].progress),
    3,
    "装备被移除后仍必须保留累计觉醒历史",
)
recordRegularMissionBattleFactsSync({
    playerId,
    questCategory: 1,
    isMulti: false,
    questAccomplished: true,
    manaObtained: 80,
    statistics: { clear_phase: 1, party: { characters: [], unison_characters: [] } },
})
recordRegularMissionBattleFactsSync({
    playerId,
    questCategory: 21,
    isMulti: false,
    questAccomplished: true,
    manaObtained: 20,
    statistics: { clear_phase: 1, party: { characters: [], unison_characters: [] } },
})
recordRegularMissionBattleFactsSync({
    playerId,
    questCategory: 21,
    isMulti: true,
    questAccomplished: true,
    manaObtained: 0,
    statistics: { clear_phase: 1, party: { characters: [], unison_characters: [] } },
})
recordRegularMissionBattleFactsSync({
    playerId,
    questCategory: 2,
    isMulti: true,
    questAccomplished: true,
    manaObtained: 0,
    statistics: {
        clear_phase: 1,
        is_mvp: true,
        party: { characters: [], unison_characters: [] },
    },
})
recordRegularMissionBattleFactsSync({
    playerId,
    questCategory: 2,
    isMulti: false,
    questAccomplished: true,
    manaObtained: 0,
    statistics: {
        clear_phase: 1,
        is_mvp: true,
        party: { characters: [], unison_characters: [] },
    },
})
assert.deepEqual(recordDegreeMissionBattleFacts({
    playerId,
    questCategory: 2,
    questId: 1001001,
    questAccomplished: true,
    isMulti: true,
    isMvp: true,
}, evaluationTime).filter(missionId => [26000, 26010, 26020].includes(missionId)), [
    26000, 26010, 26020,
], "官方 is_mvp=true 应同时生产三档 MVP 称号事实")
assert.equal(countAbilitySoulEquipments(
    [{ abilitySoulIds: [null, 1001, 1002] }],
    [{ abilitySoulIds: [1001, 1001, null] }],
), 1, "新增装配计一次，未变化与卸下不计数")
const abilitySoulSettlement = settleAbilitySoulEquipFactsSync(
    playerId,
    [{ abilitySoulIds: [null, 1001, 1002] }],
    [{ abilitySoulIds: [1001, 2001, null] }],
    evaluationTime,
)
assert.equal(abilitySoulSettlement.amount, 2, "新增和替换魂珠各计一次")
assert.deepEqual(
    abilitySoulSettlement.settlement?.missionInfo.map(entry => [entry.mission_category_id, entry.mission_id]),
    [[1, 65]],
    "魂珠装配达到条件时必须在本次操作中结算普通任务奖励",
)
const battleOperationProgress = getPlayerCategoryMissionsSync(playerId, 1)
assert.equal(battleOperationProgress[4].progress, 100, "战斗获得玛纳按真实到账值累计")
assert.equal(battleOperationProgress[29].progress, 1, "成功多人结算只接受官方 is_mvp=true")
assert.equal(battleOperationProgress[65].progress, 2, "魂珠任务按成功配队编辑中的装配变化累计")
assert.equal(battleOperationProgress[94].progress, 1, "单人挑战只统计成功的单人 ExpertSingleEvent")
const degreeOperationProgress = getPlayerCategoryMissionsSync(playerId, 5)
assert.equal(degreeOperationProgress[8000].progress, 2, "魂珠称号与普通任务共享装配事实")
assert.equal(degreeOperationProgress[26000].progress, 1, "MVP 称号读取官方结算字段")
assert.throws(() => {
    db.transaction(() => {
        recordMissionBattleResultSync(playerId, {
            isMulti: false,
            questCategory: 2,
            accomplished: true,
        })
        throw new Error("rollback boss battle fact")
    })()
}, /rollback boss battle fact/)
assert.equal(
    getMissionBattleCountersSync(playerId).bossBattleClearCount,
    2,
    "领主战事实事务回滚后不得留下累计次数",
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
