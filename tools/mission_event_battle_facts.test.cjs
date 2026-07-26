require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-event-facts-db-"))
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
const {
    BATTLE_SETTLEMENT_CATEGORIES,
    recordMissionBattleFacts,
} = require("../src/lib/mission/battle-facts")
const {
    getExactEventBattleRuleCoverage,
    loadExactEventBattleRules,
    recordEventMissionBattleFacts,
} = require("../src/lib/mission/event-battle-facts")
const { settleMissionCategories } = require("../src/lib/mission/settlement")

initializeDatabase()
db = getDb()
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `mission-event-facts-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
const player = getPlayerSync(playerId)

assert.equal(typeof loadExactEventBattleRules, "function")
const checkedInRules = require("../assets/mission_event_battle_rules.json")
const firstRule = checkedInRules.rules[0]
const bossRule = checkedInRules.rules.find(rule => rule.missionId === 1416)
const adventRule = checkedInRules.rules.find(rule => rule.missionId === 1625)

assert.equal(loadExactEventBattleRules({ schemaVersion: 1, rules: [firstRule] }).length, 1)
assert.deepEqual(
    loadExactEventBattleRules({ schemaVersion: 1, rules: [firstRule], extra: true }),
    [],
    "顶层未知字段必须拒绝整个资产",
)
assert.deepEqual(
    loadExactEventBattleRules({ schemaVersion: 1, rules: [firstRule, { ...firstRule }] }),
    [],
    "重复 mission ID 必须拒绝整个资产，不能双计",
)
assert.deepEqual(
    loadExactEventBattleRules({
        schemaVersion: 1,
        rules: [firstRule, { ...firstRule, role: "attention" }],
    }),
    [],
    "即使重复项本身无效，重复 mission ID 仍必须拒绝整个资产",
)
assert.deepEqual(
    loadExactEventBattleRules({
        schemaVersion: 1,
        rules: [{ ...bossRule, questIds: bossRule.questIds.slice(0, -1) }],
    }),
    [],
    "有限 questIds 缺少 selector 下任一 tracked 合法 ID 时必须拒绝",
)
assert.deepEqual(
    loadExactEventBattleRules({
        schemaVersion: 1,
        rules: [{ ...bossRule, questIds: [...bossRule.questIds, 1014999] }],
    }),
    [],
    "编码分量匹配但 tracked 主表不存在的虚构 ID 必须拒绝",
)

for (const invalidRule of [
    { ...firstRule, extra: true },
    { ...firstRule, missionId: 0 },
    { ...firstRule, role: "attention" },
    { ...firstRule, selector: { kind: "All" } },
    { ...firstRule, selector: { range: "Unknown", keys: [] } },
    { ...firstRule, selector: { range: "All", keys: [{ kind: "All" }] } },
    { ...firstRule, selector: { range: "BossBattle", keys: [{ kind: "All" }] } },
    { ...firstRule, selector: { range: "AdventEvent", keys: [{ kind: "All" }] } },
    {
        ...firstRule,
        selector: {
            range: "WorldStoryEventBossBattle",
            keys: [{ kind: "All" }, { kind: "All" }, { kind: "All" }],
        },
    },
    { ...firstRule, compatibility: "legacy" },
    { ...firstRule, rank: 5 },
    { ...firstRule, categories: [2] },
    { ...firstRule, questIds: [1001001] },
    { ...bossRule, categories: [] },
    { ...bossRule, categories: [0] },
    { ...bossRule, categories: [2, 2] },
    { ...bossRule, categories: [3, 2] },
    { ...bossRule, questIds: [] },
    { ...bossRule, questIds: [-1014001] },
    { ...bossRule, questIds: [1014001, 1014001] },
    { ...bossRule, questIds: [1014002, 1014001] },
    {
        ...bossRule,
        selector: {
            ...bossRule.selector,
            keys: [
                { kind: "Within", values: [] },
                bossRule.selector.keys[1],
                bossRule.selector.keys[2],
            ],
        },
    },
    {
        ...bossRule,
        selector: {
            ...bossRule.selector,
            keys: [
                { kind: "Within", values: [1, 1] },
                bossRule.selector.keys[1],
                bossRule.selector.keys[2],
            ],
        },
    },
    {
        ...bossRule,
        selector: {
            ...bossRule.selector,
            keys: [
                { kind: "Within", values: [2, 1] },
                bossRule.selector.keys[1],
                bossRule.selector.keys[2],
            ],
        },
    },
    {
        ...bossRule,
        selector: {
            ...bossRule.selector,
            keys: [
                bossRule.selector.keys[0],
                { kind: "Within", values: [15] },
                bossRule.selector.keys[2],
            ],
        },
        questIds: [1015001],
    },
    { ...bossRule, categories: [7] },
    { ...bossRule, questIds: [1015001] },
    {
        ...adventRule,
        selector: {
            ...adventRule.selector,
            keys: [adventRule.selector.keys[0], { kind: "Within", values: [3] }],
        },
        questIds: [6003],
    },
    {
        ...bossRule,
        categories: [19],
        selector: {
            range: "WorldStoryEventBossBattle",
            keys: [{ kind: "Within", values: [100100] }, { kind: "Within", values: [1] }],
        },
        questIds: [100100001],
    },
]) {
    assert.deepEqual(
        loadExactEventBattleRules({ schemaVersion: 1, rules: [invalidRule] }),
        [],
        "未知枚举和未启用兼容/rank 规则必须逐条 fail closed",
    )
}

function finishContext(overrides = {}) {
    return {
        playerId,
        questCategory: 2,
        questId: 1001001,
        questAccomplished: true,
        clearTime: 10_000,
        clearRank: 5,
        party: { characters: [], unison_characters: [] },
        statistics: { clear_phase: 1, party: { characters: [], unison_characters: [] } },
        player,
        questPreviouslyCompleted: false,
        questProgress: null,
        isMulti: true,
        isMultiHost: true,
        ...overrides,
    }
}

assert.deepEqual(getExactEventBattleRuleCoverage(), {
    totalEventMissions: 2512,
    exactMultiRules: 805,
    roles: { any: 792, host: 12, guest: 1 },
    exactClearRules: 257,
    clearRulesByCategory: { 7: 63, 10: 7, 13: 60, 23: 80, 24: 47 },
})
assert.deepEqual(BATTLE_SETTLEMENT_CATEGORIES, [1, 2, 3, 6, 7, 8, 10])

function missionProgress(missionId) {
    return getPlayerCategoryMissionsSync(playerId, 3)[missionId]?.progress ?? 0
}

const legacyTime = new Date("2020-01-01T03:00:00.000Z")
assert.equal(recordEventMissionBattleFacts(finishContext(), legacyTime).includes(1400), false)
assert.equal(missionProgress(1400), 0, "空 selector 的旧 939 规则不得再自动增长")

const raidClearTime = new Date("2023-09-10T04:00:00.000Z")
const raidClearContext = finishContext({
    questCategory: 23,
    questId: 1001,
    isMulti: false,
    isMultiHost: undefined,
})
assert.equal(recordEventMissionBattleFacts(raidClearContext, raidClearTime).includes(400001), true)
assert.equal(missionProgress(400001), 1, "Raid type23 必须按精确单人关卡增长")
assert.equal(recordEventMissionBattleFacts(
    { ...raidClearContext, isMulti: true },
    raidClearTime,
).includes(400001), false, "battle_kind=1 不得接受多人结算")
assert.equal(recordEventMissionBattleFacts(
    { ...raidClearContext, questId: 1005 },
    raidClearTime,
).includes(400001), false, "同活动错误 suffix 不得增长")

const adventClearTime = new Date("2022-08-06T04:00:00.000Z")
const adventClearContext = finishContext({
    questCategory: 7,
    questId: 9003,
    isMulti: false,
    isMultiHost: undefined,
})
assert.equal(recordEventMissionBattleFacts(adventClearContext, adventClearTime).includes(1652), true)
assert.equal(recordEventMissionBattleFacts(
    { ...adventClearContext, isMulti: true },
    adventClearTime,
).includes(1652), true, "battle_kind=3 应接受单人和多人成功结算")

const finiteTime = new Date("2020-08-14T03:00:00.000Z")
const finiteContext = finishContext({
    questCategory: 7,
    questId: 6002,
    isMultiHost: undefined,
})
assert.equal(recordEventMissionBattleFacts(finiteContext, finiteTime).includes(1625), true)
assert.equal(missionProgress(1625), 1, "有限 type16 规则必须按精确 quest ID 增长")

const allRangeTime = new Date("2019-12-04T03:00:00.000Z")
const allRangeContext = finishContext({
    questCategory: 24,
    questId: 987654321,
    isMultiHost: undefined,
})
assert.equal(recordEventMissionBattleFacts(allRangeContext, allRangeTime).includes(1224), true)
assert.equal(missionProgress(1224), 1, "quest_kind=(None) 的 type16 必须匹配任意多人关卡")

const hostTime = new Date("2020-04-01T03:00:00.000Z")
const hostContext = finishContext({ questCategory: 7, questId: 3002 })
assert.equal(recordEventMissionBattleFacts(
    { ...hostContext, isMultiHost: false },
    hostTime,
).includes(1412), false)
assert.equal(recordEventMissionBattleFacts(
    { ...hostContext, isMultiHost: undefined },
    hostTime,
).includes(1412), false)
assert.equal(recordEventMissionBattleFacts(hostContext, hostTime).includes(1412), true)
assert.equal(missionProgress(1412), 1, "host 仅接受 isMultiHost=true")

const guestTime = new Date("2021-07-01T03:00:00.000Z")
const guestContext = finishContext({ questCategory: 7, questId: 14001 })
assert.equal(recordEventMissionBattleFacts(guestContext, guestTime).includes(800000), false)
assert.equal(recordEventMissionBattleFacts(
    { ...guestContext, isMultiHost: undefined },
    guestTime,
).includes(800000), false)
assert.equal(recordEventMissionBattleFacts(
    { ...guestContext, isMultiHost: false },
    guestTime,
).includes(800000), true)
assert.equal(missionProgress(800000), 1, "guest 仅接受 isMultiHost=false")

assert.deepEqual(recordEventMissionBattleFacts(
    { ...finiteContext, questAccomplished: false },
    finiteTime,
), [])
assert.deepEqual(recordEventMissionBattleFacts(
    { ...finiteContext, isMulti: false },
    finiteTime,
), [])
assert.deepEqual(recordEventMissionBattleFacts(
    { ...finiteContext, questId: 6001 },
    finiteTime,
), [])
assert.deepEqual(recordEventMissionBattleFacts(
    { ...finiteContext, questCategory: 8 },
    finiteTime,
), [])
assert.deepEqual(recordEventMissionBattleFacts(
    finiteContext,
    new Date("2024-08-14T12:00:00.000Z"),
), [])
assert.equal(missionProgress(1625), 1, "失败、单人、错误关卡/category 和非开放期均不得增长")

recordMissionBattleFacts(finiteContext, finiteTime)
assert.equal(
    missionProgress(1625),
    2,
    "通用 finish 事实入口必须同时记录严格活动任务事实",
)

const settlement = settleMissionCategories(playerId, [3], hostTime)
assert.equal(settlement.missionInfo.some(info => info.mission_id === 1412), true)
assert.equal(settlement.itemList["49001"] >= 5, true, "严格 host 规则至少可结算一项代表奖励")

console.log("mission event battle facts tests passed")
cleanup()
process.removeListener("exit", cleanup)
