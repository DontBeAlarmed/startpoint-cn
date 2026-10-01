"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { test } = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-cond28-gates-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

let restoreContentSnapshot = () => {}
const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
restoreContentSnapshot = installBundledGameplaySnapshot()

const { initializeDatabase, closeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerCategoryMissionsSync } = require("../src/data/domains/mission")
const { getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { recordDailyMissionBattleFacts } = require("../src/lib/mission/daily-battle-facts")
const {
    recordCollectMissionBattleFacts,
    recordCollectMissionZoneStatisticsFacts,
} = require("../src/lib/mission/collect-battle-facts")
const { settleMissionCategories } = require("../src/lib/mission/settlement")

initializeDatabase()

const ACTIVE_TIME = new Date("2024-08-14T12:00:00.000Z")
const WINDOW = ["2020-01-01 12:00:00", "2030-01-01 11:59:59"]

function dailyRow() {
    const row = []
    row[0] = "cond28_gate_skill"
    row[2] = "28"
    row[3] = "4" // statistics code 4 = skill uses
    row[5] = "3" // battle kind any
    row[7] = "6" // StoryEventSingle
    row[8] = "100001"
    row[9] = ""
    row[10] = "2,3,4,5"
    row[25] = WINDOW[0]
    row[26] = WINDOW[1]
    return row
}

function collectBattleRow() {
    const row = []
    row[0] = "11001"
    row[2] = "cond28_gate_single"
    row[4] = "16"
    row[7] = "1" // battle kind single-only at the collect column
    row[9] = "(None)"
    row[10] = ""
    row[11] = ""
    row[12] = ""
    row[27] = WINDOW[0]
    row[28] = WINDOW[1]
    return row
}

function collectFeverRow() {
    const row = []
    row[0] = "11001"
    row[2] = "cond28_gate_fever"
    row[4] = "28"
    row[5] = "5" // statistics code 5 = fever
    row[9] = "2" // BossBattle, empty selectors = whole category
    row[10] = ""
    row[11] = ""
    row[12] = ""
    row[27] = WINDOW[0]
    row[28] = WINDOW[1]
    return row
}

// Daily reward layout: target at 1, kind at 5, amount at 6.
function dailyRewardRow(rewardId) {
    const row = []
    row[0] = rewardId
    row[1] = "1"
    row[5] = "0"
    row[6] = "1"
    return row
}

// Collect reward layout: target at 2, kind at 6, amount at 7.
function collectRewardRow(rewardId) {
    const row = []
    row[0] = rewardId
    row[2] = "1"
    row[6] = "0"
    row[7] = "1"
    return row
}

function installSyntheticMissions() {
    restoreContentSnapshot()
    const daily = structuredClone(require("../assets/mission_daily.json"))
    daily["990002"] = [dailyRow()]
    const dailyReward = structuredClone(require("../assets/mission_daily_reward.json"))
    dailyReward["990002"] = { "1": [dailyRewardRow("9900211")] }
    const collect = structuredClone(require("../assets/mission_collect_item.json"))
    collect["990001"] = [collectBattleRow()]
    collect["990003"] = [collectFeverRow()]
    const collectReward = structuredClone(require("../assets/mission_collect_item_reward.json"))
    collectReward["990001"] = { "1": [collectRewardRow("9900111")] }
    collectReward["990003"] = { "1": [collectRewardRow("9900311")] }
    restoreContentSnapshot = installBundledGameplaySnapshot({
        tableOverrides: {
            "mission_daily.json": daily,
            "mission_daily_reward.json": dailyReward,
            "mission_collect_item.json": collect,
            "mission_collect_item_reward.json": collectReward,
        },
    })
}

let account = null
let playerId = 0
function freshPlayer(label) {
    account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `cond28-gates-${label}-${randomUUID()}`,
        status: "normal",
    })
    playerId = insertDefaultPlayerSync(account.id).id
    return playerId
}

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
            zones: [{ use_skill_count: 6, fever_count: 4 }],
            max_skill_chain_count: 3,
        },
        player: getPlayerSync(playerId),
        questPreviouslyCompleted: false,
        questProgress: null,
        isMulti: false,
        isMultiHost: undefined,
        ...overrides,
    }
}

function progress(category, missionId) {
    return getPlayerCategoryMissionsSync(playerId, category)[missionId]?.progress ?? 0
}

test("F-1: collect battle kind is read from the collect column (7)", () => {
    installSyntheticMissions()
    freshPlayer("f1")
    // Mission 990001 pins battle kind single-only at column 7; a coop clear
    // of an Advent quest must not count it even though the range is open.
    const matchedMulti = recordCollectMissionBattleFacts(
        context({ isMulti: true, isMultiHost: true }), ACTIVE_TIME)
    assert.equal(matchedMulti.includes(990001), false,
        "col7=1 的单人限定收集任务不得接受协力结算")
    const matchedSingle = recordCollectMissionBattleFacts(context(), ACTIVE_TIME)
    assert.equal(matchedSingle.includes(990001), true,
        "col7=1 的单人限定收集任务必须接受单人结算")
})

test("F-2: daily cond-28 statistics rows respect their quest range", () => {
    installSyntheticMissions()
    freshPlayer("f2")
    // 990002 pins StoryEventSingle event 100001 suffixes 2..5; an Advent
    // (category 7) battle carrying skill statistics must not count.
    const advent = recordDailyMissionBattleFacts(context(), ACTIVE_TIME)
    assert.equal(advent.includes(990002), false,
        "范围外的战斗不得增长 cond-28 统计任务")
    const storyEvent = recordDailyMissionBattleFacts(
        context({ questCategory: 10, questId: 100001002 }), ACTIVE_TIME)
    assert.equal(storyEvent.includes(990002), true,
        "范围内的战斗必须增长 cond-28 统计任务")
    assert.equal(progress(2, 990002), 6, "增量应为 zone 技能求和 6")
})

test("F-3: computeDaily cond-28 fallback only serves the dash code", () => {
    installSyntheticMissions()
    freshPlayer("f3")
    recordDailyMissionBattleFacts(
        context({ questCategory: 10, questId: 100001002 }), ACTIVE_TIME)
    assert.equal(progress(2, 990002), 6)
    updatePlayerSync({ id: playerId, totalDashes: 100 })
    settleMissionCategories(playerId, [2], ACTIVE_TIME)
    assert.equal(progress(2, 990002), 6,
        "非冲刺统计码的任务进度不得被每日冲刺总量抬高")
})

test("F-5: collect zone-statistics rows respect their quest range", () => {
    installSyntheticMissions()
    freshPlayer("f5")
    // 990003 pins BossBattle (whole category); an Advent battle carrying
    // fever statistics must not count, a boss battle must.
    const advent = recordCollectMissionZoneStatisticsFacts(context(), ACTIVE_TIME)
    assert.equal(advent.includes(990003), false,
        "范围外的战斗不得增长收集统计任务")
    const boss = recordCollectMissionZoneStatisticsFacts(
        context({ questCategory: 2, questId: 1009001 }), ACTIVE_TIME)
    assert.equal(boss.includes(990003), true,
        "范围内的战斗必须增长收集统计任务")
    assert.equal(progress(4, 990003), 4, "增量应为 zone FEVER 求和 4")
})

test.after(() => {
    closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})
