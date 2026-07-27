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
const {
    getPlayerCategoryMissionsSync,
    updatePlayerCategoryMissionSync,
} = require("../src/data/domains/mission")
const { getPlayerSync, insertDefaultPlayerSync } = require("../src/data/domains/player")
const {
    BATTLE_SETTLEMENT_CATEGORIES,
    recordMissionBattleFacts,
} = require("../src/lib/mission/battle-facts")
const {
    getExactEventBattleRuleCoverage,
    getExactEventBattleMissionIds,
    hasSingleEventMissionTarget,
    loadExactEventBattleRules,
    recordEventMissionBattleFacts,
} = require("../src/lib/mission/event-battle-facts")
const { settleMissionCategories } = require("../src/lib/mission/settlement")
const eventMissionRewards = require("../assets/mission_event_reward.json")

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
assert.deepEqual(
    getExactEventBattleMissionIds().filter(missionId => [1200, 1208, 1209, 1210, 1211, 1216, 1223].includes(missionId)),
    [1200, 1208, 1209, 1210, 1211, 1216, 1223],
    "7 个权威统计事实必须进入机器覆盖",
)
assert.deepEqual(
    getExactEventBattleMissionIds().filter(missionId => [600001, 900809].includes(missionId)),
    [600001, 900809],
    "两条 type86 歼灭者 SS 条件必须进入机器覆盖",
)
for (const missionId of [600001, 900809]) {
    assert.equal(hasSingleEventMissionTarget(eventMissionRewards[String(missionId)]), true)
}
for (const rewards of [
    null,
    [],
    {},
    { "1": [] },
    { "1": [["600001001", "2"]] },
    { "1": [["600001001", "1"]], "2": [["600001002", "2"]] },
]) {
    assert.equal(hasSingleEventMissionTarget(rewards), false, "type86 只接受单阶段目标 1")
}
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
    exactPhaseRules: 29,
    exactSingleClearRules: 8,
    exactStatisticsRules: 7,
    exactStatisticsRuleMissionIds: [1200, 1208, 1209, 1210, 1211, 1216, 1223],
    exactResistanceDebuffRules: 2,
    exactResistanceDebuffRuleMissionIds: [600001, 900809],
})
assert.deepEqual(BATTLE_SETTLEMENT_CATEGORIES, [1, 2, 3, 6, 7, 8, 10])

const statisticEventTime = new Date("2019-12-04T04:00:00.000Z")
const statisticBattleContext = finishContext({
    clearRank: 5,
    statistics: {
        clear_phase: 1,
        max_power: 12345,
        zones: [{ use_dash_count: 2 }, { use_dash_count: 3 }],
        party: { characters: [], unison_characters: [] },
    },
})
assert.deepEqual(
    recordEventMissionBattleFacts(statisticBattleContext, statisticEventTime)
        .filter(missionId => [1200, 1208, 1209, 1210, 1211, 1216, 1223].includes(missionId))
        .sort((left, right) => left - right),
    [1200, 1208, 1209, 1210, 1211, 1216, 1223],
    "type26/27/28 的 7 条权威统计事实必须匹配成功结算",
)
for (const missionId of [1200, 1211, 1223]) assert.equal(missionProgress(missionId), 5)
for (const missionId of [1208, 1209, 1210]) assert.equal(missionProgress(missionId), 1)
assert.equal(missionProgress(1216), 12345)

const statisticSingleContext = {
    ...statisticBattleContext,
    isMulti: false,
    isMultiHost: undefined,
    clearRank: 4,
    statistics: {
        ...statisticBattleContext.statistics,
        max_power: 20000,
        zones: [{ use_dash_count: 1 }],
    },
}
const statisticSingleMatches = recordEventMissionBattleFacts(statisticSingleContext, statisticEventTime)
assert.deepEqual(
    statisticSingleMatches.filter(missionId => [1200, 1208, 1209, 1210, 1211, 1216, 1223].includes(missionId))
        .sort((left, right) => left - right),
    [1200, 1211, 1216, 1223],
    "battle_kind=3 必须接受成功单人结算，type26 不应误读 clearRank=4",
)
for (const missionId of [1200, 1211, 1223]) assert.equal(missionProgress(missionId), 6)
for (const missionId of [1208, 1209, 1210]) assert.equal(missionProgress(missionId), 1)
assert.equal(missionProgress(1216), 20000, "type27 必须用 ensure/max 保留单场最大战力")
recordEventMissionBattleFacts({
    ...statisticSingleContext,
    statistics: { ...statisticSingleContext.statistics, max_power: 1000, zones: [{ use_dash_count: 0 }] },
}, statisticEventTime)
assert.equal(missionProgress(1216), 20000, "type27 的较低 max_power 不得覆盖历史最大值")

const singleSsBefore = missionProgress(1208)
assert.equal(recordEventMissionBattleFacts({ ...statisticBattleContext, isMulti: false, isMultiHost: undefined }, statisticEventTime).includes(1208), true)
assert.equal(missionProgress(1208), singleSsBefore + 1, "单人成功 SS 必须持久化增加 type26")
for (const invalidContext of [
    { ...statisticBattleContext, isMulti: false, isMultiHost: undefined, questAccomplished: false },
    { ...statisticBattleContext, isMulti: false, isMultiHost: undefined, clearRank: 4 },
]) {
    recordEventMissionBattleFacts(invalidContext, statisticEventTime)
    assert.equal(missionProgress(1208), singleSsBefore + 1, "失败或错误 rank 不得改变 type26 持久化进度")
}
for (const outsideTime of [
    new Date("2019-11-27T20:59:59.000Z"),
    new Date("2019-12-16T12:00:00.000Z"),
]) {
    recordEventMissionBattleFacts({ ...statisticBattleContext, isMulti: false, isMultiHost: undefined }, outsideTime)
    assert.equal(missionProgress(1208), singleSsBefore + 1, "开放期外不得改变 type26 持久化进度")
}

const nearMaxProgress = Number.MAX_SAFE_INTEGER
updatePlayerCategoryMissionSync(playerId, 3, 1200, nearMaxProgress)
for (const missionId of [1211, 1223]) updatePlayerCategoryMissionSync(playerId, 3, missionId, 10)
const overflowMatches = recordEventMissionBattleFacts({
    ...statisticBattleContext,
    statistics: { ...statisticBattleContext.statistics, zones: [{ use_dash_count: 1 }] },
}, statisticEventTime)
for (const missionId of [1200, 1211, 1223]) {
    assert.equal(overflowMatches.includes(missionId), false, "type28 批次溢出时不得计入 matched")
}
assert.equal(missionProgress(1200), nearMaxProgress, "混合 type28 批次溢出时 1200 不得改变")
assert.equal(missionProgress(1211), 10, "混合 type28 批次溢出时 1211 不得改变")
assert.equal(missionProgress(1223), 10, "混合 type28 批次溢出时 1223 不得改变")

db.prepare(`
    DELETE FROM players_category_missions
    WHERE player_id = ? AND category = 3 AND id IN (?, ?, ?)
`).run(playerId, 1200, 1211, 1223)
const zeroDashMatches = recordEventMissionBattleFacts({
    ...statisticBattleContext,
    statistics: { ...statisticBattleContext.statistics, zones: [{ use_dash_count: 0 }] },
}, statisticEventTime)
for (const missionId of [1200, 1211, 1223]) {
    assert.equal(zeroDashMatches.includes(missionId), false, "zero dash 合计不得加入 matched")
    assert.equal(missionProgress(missionId), 0, "zero dash 合计不得创建或改变 progress")
}

const statisticsMissionIds = [1200, 1208, 1209, 1210, 1211, 1216, 1223]
assert.deepEqual(
    recordEventMissionBattleFacts({ ...statisticBattleContext, questAccomplished: false }, statisticEventTime)
        .filter(missionId => statisticsMissionIds.includes(missionId)),
    [],
    "失败结算不得匹配新增事实",
)
const wrongRankMatches = recordEventMissionBattleFacts(
    { ...statisticBattleContext, clearRank: 4 },
    statisticEventTime,
).filter(missionId => statisticsMissionIds.includes(missionId))
assert.equal(wrongRankMatches.some(missionId => [1208, 1209, 1210].includes(missionId)), false)

const maxPowerBeforeInvalid = missionProgress(1216)
for (const maxPower of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    recordEventMissionBattleFacts({
        ...statisticBattleContext,
        statistics: { ...statisticBattleContext.statistics, max_power: maxPower },
    }, statisticEventTime)
}
assert.equal(missionProgress(1216), maxPowerBeforeInvalid, "非法 max_power 不得写入 type27")

const dashProgressBeforeInvalid = missionProgress(1200)
for (const zones of [
    [{ use_dash_count: -1 }],
    [{ use_dash_count: 1.5 }],
    [{ use_dash_count: Number.MAX_SAFE_INTEGER }, { use_dash_count: 1 }],
    [{ use_dash_count: 1 }, {}],
]) {
    recordEventMissionBattleFacts({
        ...statisticBattleContext,
        statistics: { ...statisticBattleContext.statistics, zones },
    }, statisticEventTime)
}
assert.equal(missionProgress(1200), dashProgressBeforeInvalid, "非法或溢出 dash 统计不得写入 type28")
assert.deepEqual(
    recordEventMissionBattleFacts(statisticBattleContext, new Date("2019-12-16T12:00:00.000Z"))
        .filter(missionId => [1200, 1208, 1209, 1210, 1211, 1216, 1223].includes(missionId)),
    [],
    "开放期外不得匹配新增事实",
)

function resistanceDebuffContext(overrides = {}) {
    return finishContext({
        questCategory: 26,
        questId: 1001,
        clearTime: 120_000,
        clearRank: 5,
        statistics: {
            clear_phase: 0,
            party: { characters: [], unison_characters: [] },
            zones: [
                { members: [{ debuff_r: 0 }, { debuff_r: 0 }, { debuff_r: 0 }] },
                { members: [{ debuff_r: 0 }, null, { debuff_r: 0 }] },
            ],
        },
        ...overrides,
    })
}

const limitedHardMultiTime = new Date("2024-08-20T04:00:00.000Z")
assert.equal(
    recordEventMissionBattleFacts(resistanceDebuffContext(), limitedHardMultiTime).includes(600001),
    true,
    "限定歼灭者任务必须在全部 zone/member 未收到抗性下降且 SS 时完成",
)
assert.equal(missionProgress(600001), 1)
recordEventMissionBattleFacts(resistanceDebuffContext(), limitedHardMultiTime)
assert.equal(missionProgress(600001), 1, "type86 重复成功结算必须幂等")

const permanentHardMultiTime = new Date("2025-07-20T04:00:00.000Z")
updatePlayerCategoryMissionSync(playerId, 3, 900809, -1)
assert.equal(recordEventMissionBattleFacts(resistanceDebuffContext({
    questId: 1001001,
}), permanentHardMultiTime).includes(900809), false)
assert.equal(missionProgress(900809), -1, "非法负进度不得被 type86 静默修复")
db.prepare(`
    DELETE FROM players_category_missions
    WHERE player_id = ? AND category = 3 AND id = 900809
`).run(playerId)
assert.equal(recordEventMissionBattleFacts(resistanceDebuffContext({
    questId: 1001001,
}), permanentHardMultiTime).includes(900809), true)
assert.equal(missionProgress(900809), 1)
db.prepare(`
    DELETE FROM players_category_missions
    WHERE player_id = ? AND category = 3 AND id = 900809
`).run(playerId)
assert.equal(recordEventMissionBattleFacts(resistanceDebuffContext({
    questId: 1001002,
}), permanentHardMultiTime).includes(900809), false)
assert.equal(missionProgress(900809), 0, "同活动的相邻关卡不得命中固定 type86 兼容规则")

for (const invalidContext of [
    resistanceDebuffContext({ questAccomplished: false }),
    resistanceDebuffContext({ questAccomplished: 1 }),
    resistanceDebuffContext({ questAccomplished: "true" }),
    resistanceDebuffContext({ isMulti: false, isMultiHost: undefined }),
    resistanceDebuffContext({ isMulti: undefined, isMultiHost: undefined }),
    resistanceDebuffContext({ clearRank: 4 }),
    resistanceDebuffContext({ clearRank: null }),
    resistanceDebuffContext({ questCategory: 25 }),
    resistanceDebuffContext({ questId: 2001 }),
    resistanceDebuffContext({ questId: 1002 }),
    resistanceDebuffContext({ clearTime: undefined }),
    resistanceDebuffContext({ clearTime: 0 }),
    resistanceDebuffContext({ clearTime: -1 }),
    resistanceDebuffContext({ clearTime: 1.5 }),
    resistanceDebuffContext({ statistics: { clear_phase: 0, party: { characters: [], unison_characters: [] } } }),
    resistanceDebuffContext({ statistics: { clear_phase: 0, party: { characters: [], unison_characters: [] }, zones: [] } }),
    resistanceDebuffContext({ statistics: { clear_phase: 0, party: { characters: [], unison_characters: [] }, zones: [null] } }),
    resistanceDebuffContext({ statistics: { clear_phase: 0, party: { characters: [], unison_characters: [] }, zones: [{}] } }),
    resistanceDebuffContext({ statistics: { clear_phase: 0, party: { characters: [], unison_characters: [] }, zones: [{ members: [] }] } }),
    resistanceDebuffContext({ statistics: { clear_phase: 0, party: { characters: [], unison_characters: [] }, zones: [{ members: [null] }] } }),
    resistanceDebuffContext({
        statistics: {
            clear_phase: 0,
            party: { characters: [], unison_characters: [] },
            zones: [
                { members: [{ debuff_r: 0 }, { debuff_r: 0 }] },
                { members: [{ debuff_r: 0 }, null, { debuff_r: 1 }] },
            ],
        },
    }),
    ...[undefined, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 1].map(debuffR => (
        resistanceDebuffContext({
            statistics: {
                clear_phase: 0,
                party: { characters: [], unison_characters: [] },
                zones: [{ members: [{ ...(debuffR === undefined ? {} : { debuff_r: debuffR }) }] }],
            },
        })
    )),
]) {
    db.prepare(`
        DELETE FROM players_category_missions
        WHERE player_id = ? AND category = 3 AND id = 600001
    `).run(playerId)
    assert.equal(
        recordEventMissionBattleFacts(invalidContext, limitedHardMultiTime).includes(600001),
        false,
        "失败、非多人、非 SS、错误关卡或非法 debuff_r 统计均不得推进 type86",
    )
    assert.equal(missionProgress(600001), 0, "非法 type86 输入不得写入任务进度")
}
for (const outsideTime of [
    new Date("2024-08-16T03:59:59.000Z"),
    new Date("2024-08-29T16:00:00.000Z"),
]) {
    db.prepare(`
        DELETE FROM players_category_missions
        WHERE player_id = ? AND category = 3 AND id = 600001
    `).run(playerId)
    assert.equal(
        recordEventMissionBattleFacts(resistanceDebuffContext(), outsideTime).includes(600001),
        false,
        "开放期外不得推进限定 type86",
    )
    assert.equal(missionProgress(600001), 0)
}

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

const phaseTime = new Date("2020-11-02T04:00:00.000Z")
const phaseContext = finishContext({
    questCategory: 11,
    questId: 2001,
    isMulti: false,
    isMultiHost: undefined,
    statistics: { clear_phase: 4, party: { characters: [], unison_characters: [] } },
})
const phaseMatches = recordEventMissionBattleFacts(phaseContext, phaseTime)
assert.equal(phaseMatches.includes(200831), true)
assert.equal(phaseMatches.includes(2008341), true, "clear_phase=4 应完成同关卡 Phase 1 至 4")
assert.equal(
    recordEventMissionBattleFacts({ ...phaseContext, isMulti: undefined }, phaseTime)
        .includes(2008341),
    true,
    "真实单人 finish 未设置 isMulti 时仍应推进 Ranking Phase",
)
assert.equal(missionProgress(2008341), 1, "Ranking Phase 重复结算必须保持幂等")
const phaseMissionIds = [200831, 200832, 200833, 2008341]
for (const invalidContext of [
    { ...phaseContext, questAccomplished: false },
    { ...phaseContext, isMulti: true, isMultiHost: true },
    { ...phaseContext, questCategory: 10 },
    { ...phaseContext, questId: 2002 },
    { ...phaseContext, statistics: { ...phaseContext.statistics, clear_phase: 0 } },
    { ...phaseContext, statistics: { ...phaseContext.statistics, clear_phase: 4.5 } },
    { ...phaseContext, statistics: { ...phaseContext.statistics, clear_phase: 5 } },
]) {
    assert.equal(
        recordEventMissionBattleFacts(invalidContext, phaseTime)
            .some(missionId => phaseMissionIds.includes(missionId)),
        false,
        "失败、多人、错误关卡/category 和非法 phase 均不得推进 Ranking Phase",
    )
}
assert.equal(
    recordEventMissionBattleFacts(phaseContext, new Date("2024-08-14T12:00:00.000Z"))
        .some(missionId => phaseMissionIds.includes(missionId)),
    false,
    "非开放期不得推进 Ranking Phase",
)

const singleClearTime = new Date("2019-12-03T04:00:00.000Z")
const labyrinthContext = finishContext({
    questCategory: 6,
    questId: 1001,
    isMulti: undefined,
    isMultiHost: undefined,
})
assert.equal(recordEventMissionBattleFacts(labyrinthContext, singleClearTime).includes(1300), true)
assert.equal(recordEventMissionBattleFacts(labyrinthContext, singleClearTime).includes(1300), true)
assert.equal(missionProgress(1300), 2, "摇曳迷宫累计任务必须逐次记录成功单人结算")
assert.equal(recordEventMissionBattleFacts(
    { ...labyrinthContext, isMulti: true, isMultiHost: true },
    singleClearTime,
).includes(1300), false)
assert.equal(missionProgress(1300), 2, "多人结算不得推进单人累计任务")
assert.equal(recordEventMissionBattleFacts(
    { ...labyrinthContext, questCategory: 7 },
    singleClearTime,
).includes(1300), false)

assert.equal(recordEventMissionBattleFacts({
    ...labyrinthContext,
    questCategory: 4,
}, singleClearTime).includes(1221), true, "EX 全范围规则应接受成功单人结算")
assert.equal(recordEventMissionBattleFacts({
    ...labyrinthContext,
    questCategory: 13,
    questId: 1001,
}, singleClearTime).includes(1303), true)
assert.equal(recordEventMissionBattleFacts({
    ...labyrinthContext,
    questCategory: 13,
    questId: 1002,
}, singleClearTime).includes(1304), true)
assert.equal(recordEventMissionBattleFacts({
    ...labyrinthContext,
    questCategory: 13,
    questId: 1003,
}, singleClearTime).some(missionId => missionId === 1303 || missionId === 1304), false)
assert.equal(recordEventMissionBattleFacts(
    labyrinthContext,
    new Date("2024-08-14T12:00:00.000Z"),
).includes(1300), false, "非开放期不得推进单人累计任务")

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
const allRangeBefore = missionProgress(1224)
assert.equal(recordEventMissionBattleFacts(allRangeContext, allRangeTime).includes(1224), true)
assert.equal(
    missionProgress(1224),
    allRangeBefore + 1,
    "quest_kind=(None) 的 type16 必须匹配任意多人关卡",
)

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
