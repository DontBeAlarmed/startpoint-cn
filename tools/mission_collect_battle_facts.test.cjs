"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-collect-battle-facts-db-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

function cleanup() {
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
}
process.once("exit", cleanup)

const { initializeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    getPlayerCategoryMissionsSync,
    updatePlayerCategoryMissionsSync,
} = require("../src/data/domains/mission")
const { getPlayerSync, insertDefaultPlayerSync } = require("../src/data/domains/player")
const {
    recordCollectMissionBattleFacts,
    recordCollectMissionManaSpend,
} = require("../src/lib/mission/collect-battle-facts")
const { settleMissionCategories } = require("../src/lib/mission/settlement")

initializeDatabase()
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `mission-collect-battle-facts-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
const player = getPlayerSync(playerId)

function context(overrides = {}) {
    return {
        playerId,
        questCategory: 7,
        questId: 100009001,
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
        isMulti: false,
        isMultiHost: undefined,
        ...overrides,
    }
}

function collectProgress(missionId) {
    return getPlayerCategoryMissionsSync(playerId, 4)[missionId]?.progress ?? 0
}

// Mission 2102: type 23 (any battle), Advent event 100009, empty-suffix
// wildcard; window 2024-03-07 .. 2024-03-21, stage target 20.
const adventTime = new Date("2024-03-10T12:00:00.000Z")
// Event 11001 also has 2114 (same Advent shape) and 2107/2116 (any-coop
// type 16) open in this window; the single Advent clear counts the two
// any-mode rows only.
assert.deepEqual(
    recordCollectMissionBattleFacts(context(), adventTime),
    [2102, 2114],
    "Advent 通关除草魔像任务必须接受成功单人结算",
)
assert.deepEqual(
    recordCollectMissionBattleFacts(context({ isMulti: true, isMultiHost: true }), adventTime),
    [2102, 2107, 2114, 2116],
    "协力结算必须同时计入任意协力与除草魔像任务",
)
assert.deepEqual(
    [2102, 2107, 2114, 2116].map(collectProgress),
    [2, 1, 2, 1],
    "type 23 任意模式与 type 16 协力模式必须按各自语义增长",
)
for (const invalid of [
    { questId: 100010001 },
    { questCategory: 2, questId: 1009001 },
    { questAccomplished: false },
]) {
    recordCollectMissionBattleFacts(context(invalid), adventTime)
}
assert.deepEqual(
    [2102, 2107, 2114, 2116].map(collectProgress),
    [2, 1, 2, 1],
    "错误事件、category 与失败结算不得增长",
)
// Before the 2102-family window (12:00 CN = 04:00Z) other concurrently
// open collect missions (2073/2074) may legitimately match; the assertion
// is that THIS family's progress is frozen outside its window.
recordCollectMissionBattleFacts(context(), new Date("2024-03-07T03:59:59.999Z"))
assert.deepEqual(
    [2102, 2107, 2114, 2116].map(collectProgress),
    [2, 1, 2, 1],
    "收集战斗事实必须遵守各自开放期",
)

// Mission 1653: type 16 (multi), BossBattle world 1 chapter 9 wildcard third
// selector; window 2020-05-27 .. 2020-06-12.
const bossTime = new Date("2020-06-01T12:00:00.000Z")
// 1653 and 1654 both pin boss world 1 chapter 9 (潮汐巨妖); both count.
assert.deepEqual(
    recordCollectMissionBattleFacts(context({
        questCategory: 2,
        questId: 1009001,
        isMulti: true,
        isMultiHost: true,
    }), bossTime),
    [1653, 1654],
    "BossBattle 协力通关必须计入收集任务",
)
recordCollectMissionBattleFacts(context({
    questCategory: 2,
    questId: 1009005,
    isMulti: true,
    isMultiHost: false,
}), bossTime)
assert.deepEqual(
    [1653, 1654].map(collectProgress),
    [2, 2],
    "第三段选择器 (None) 必须按不限处理",
)
recordCollectMissionBattleFacts(context({ questCategory: 2, questId: 1009001 }), bossTime)
assert.deepEqual(
    [1653, 1654].map(collectProgress),
    [2, 2],
    "type 16 默认只接受协力模式",
)

// Mission 1742: type 46 mana spend, window 2020-07-21 .. 2020-09-01,
// stage target 50000.
const manaTime = new Date("2020-08-01T12:00:00.000Z")
assert.deepEqual(recordCollectMissionManaSpend(playerId, 30000, manaTime), [1742])
assert.equal(collectProgress(1742), 30000)
assert.deepEqual(recordCollectMissionManaSpend(playerId, 20000, manaTime), [1742])
assert.equal(collectProgress(1742), 50000)
assert.deepEqual(
    recordCollectMissionManaSpend(playerId, 1000, new Date("2020-09-02T00:00:00.000Z")),
    [],
    "玛纳消耗记账必须自带开放期门",
)
assert.equal(collectProgress(1742), 50000)
const manaSettlement = settleMissionCategories(playerId, [{ category: 4, eventId: 10002 }], manaTime)
assert.deepEqual(
    manaSettlement.missionInfo.map(info => info.mission_id),
    [1742],
    "玛纳消耗达到 50000 后必须结算奖励",
)

// Mission 1660: type 13 complete-all over deps 1653..1659 in event 10001.
const depsTime = new Date("2020-06-01T12:00:00.000Z")
updatePlayerCategoryMissionsSync(playerId, [
    { category: 4, missionId: 1653, progress: 5 },
    { category: 4, missionId: 1654, progress: 10 },
    { category: 4, missionId: 1655, progress: 5 },
    { category: 4, missionId: 1656, progress: 10 },
    { category: 4, missionId: 1657, progress: 5 },
    { category: 4, missionId: 1658, progress: 10 },
    { category: 4, missionId: 1659, progress: 10 },
    { category: 4, missionId: 1660, progress: 0 },
])
const depsSettlement = settleMissionCategories(playerId, [{ category: 4, eventId: 10001 }], depsTime)
assert.deepEqual(
    depsSettlement.missionInfo.map(info => info.mission_id),
    [1653, 1654, 1655, 1656, 1657, 1658, 1659, 1660],
    "依赖全部达标后,七条依赖与 1660 必须在同一次结算完成",
)

// Action shapes: 1745 (type 28, FEVER code 5, target 20, window from
// 2020-07-31), 1738 (type 31, skill chain 9, window from 2020-07-21),
// and a stamina-39 row 2096 (event 11001, target 100).
const actionContext = context({
    statistics: {
        clear_phase: 1,
        party: { characters: [], unison_characters: [] },
        zones: [
            { fever_count: 3, use_dash_count: 2, enemy_kill_count: 9 },
            { fever_count: 2, use_dash_count: 1, enemy_kill_count: 4 },
        ],
        max_skill_chain_count: 11,
    },
})
const actionTime = new Date("2020-08-01T12:00:00.000Z")
// 1749 (enemy, code 7) shares the window; the dash row 1756 only opens on
// 2020-08-13, so a second call inside its window proves the dash code.
assert.deepEqual(
    require("../src/lib/mission/collect-battle-facts").recordCollectMissionZoneStatisticsFacts(actionContext, actionTime),
    [1745, 1749],
    "zone 统计码必须按各自字段求和计入",
)
assert.equal(collectProgress(1745), 5, "FEVER 码 5 求和为 3+2")
assert.equal(collectProgress(1749), 13, "敌人码 7 求和为 9+4")
assert.deepEqual(
    require("../src/lib/mission/collect-battle-facts").recordCollectMissionZoneStatisticsFacts(actionContext, new Date("2020-08-14T12:00:00.000Z")),
    [1745, 1749, 1756],
    "冲刺码 2 的任务开放后必须计入",
)
assert.equal(collectProgress(1756), 3, "冲刺码 2 求和为 2+1")
assert.deepEqual(
    require("../src/lib/mission/collect-battle-facts").recordCollectMissionSkillChainFacts(actionContext, actionTime),
    [1738],
    "技能连锁条件必须记录本场最大连锁",
)
assert.equal(collectProgress(1738), 11)
assert.deepEqual(
    require("../src/lib/mission/collect-battle-facts").recordCollectMissionSkillChainFacts(
        { ...actionContext, statistics: { ...actionContext.statistics, max_skill_chain_count: 7 } },
        actionTime,
    ),
    [1738],
)
assert.equal(collectProgress(1738), 11, "连锁进度必须只增不减")
assert.deepEqual(
    require("../src/lib/mission/collect-battle-facts").recordCollectMissionStaminaSpend(playerId, 40, new Date("2024-03-10T12:00:00.000Z")),
    [2096, 2106, 2115],
    "体力消耗记账必须命中开放期内的全部收集任务",
)
assert.equal(collectProgress(2096), 40)

// Current-state shapes (2024-03 window, event 11001): 2098 completes when
// any character has a proven over-limit step; the state is a safe lower
// bound merged with persisted progress.
const { insertPlayerCharacterSync } = require("../src/data/domains/character")
const stateTime = new Date("2024-01-01T00:00:00.000Z")
insertPlayerCharacterSync(playerId, 10, {
    entryCount: 1,
    evolutionLevel: 0,
    overLimitStep: 1,
    protection: false,
    joinTime: stateTime,
    updateTime: stateTime,
    exp: 0,
    stack: 0,
    manaBoardIndex: 1,
    bondTokenList: [],
})
const stateSettlement = settleMissionCategories(playerId, [{ category: 4, eventId: 11001 }], new Date("2024-03-10T12:00:00.000Z"))
assert.deepEqual(
    stateSettlement.missionInfo.map(info => info.mission_id).includes(2098),
    true,
    "上限突破 current-state 任务必须在角色突破后结算",
)
const stateProgress = getPlayerCategoryMissionsSync(playerId, 4)[2098]?.progress ?? 0
assert.equal(stateProgress, 1, "current-state 进度取安全下界 1")

console.log("mission collect battle facts tests passed")
