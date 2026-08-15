"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const masterData = require("../src/lib/mission/master-data")
const patterns = require("../src/lib/mission/patterns")
const rewards = require("../src/lib/mission/rewards")
const stages = require("../src/lib/mission/stages")

const STANDARD_TABLES = [
    "mission_regular.json",
    "mission_daily.json",
    "mission_event.json",
    "mission_collect_item.json",
    "mission_degree.json",
    "mission_pass_daily.json",
    "mission_pass_week.json",
    "mission_pass_event.json",
    "mission_char_awake.json",
    "mission_weekly_def.json",
    "mission_regular_reward.json",
    "mission_daily_reward.json",
    "mission_event_reward.json",
    "mission_collect_item_reward.json",
    "mission_degree_reward.json",
    "mission_pass_daily_reward.json",
    "mission_pass_week_reward.json",
    "mission_pass_event_reward.json",
    "mission_char_awake_reward.json",
    "mission_weekly_reward.json",
]

function emptyTables() {
    return Object.fromEntries(STANDARD_TABLES.map(tableName => [tableName, {}]))
}

function repository(tables, source = "wrapper-fixture") {
    return {
        info: () => ({ source }),
        table(tableName) {
            if (!Object.hasOwn(tables, tableName)) throw new Error(`${source} missing ${tableName}`)
            return tables[tableName]
        },
    }
}

function definitionRow(pattern, start = "2026-01-01 00:00:00") {
    const row = []
    row[0] = pattern
    row[24] = "wrapper-marker"
    row[25] = start
    row[26] = "2026-12-31 23:59:59"
    return row
}

function rewardRow(rewardId, targetProgress, itemId) {
    const row = []
    row[0] = String(rewardId)
    row[1] = String(targetProgress)
    row[5] = "1"
    row[6] = "2"
    row[7] = String(itemId)
    return row
}

function activeRewardRow(itemId) {
    const row = []
    row[3] = "7"
    row[4] = "(None)"
    row[7] = "1"
    row[8] = "3"
    row[9] = String(itemId)
    return row
}

function awakeDefinitionRow(characterId) {
    const row = []
    row[1] = String(characterId)
    row[2] = "wrapper-awake"
    row[27] = "2026-01-01 00:00:00"
    row[28] = "2026-12-31 23:59:59"
    return row
}

function awakeRewardRow() {
    const row = []
    row[0] = "9011"
    row[1] = "0"
    row[2] = "901"
    row[3] = "1"
    row[4] = "2"
    row[5] = "3"
    row[6] = "90"
    row[9] = "1"
    row[10] = "4"
    row[11] = "301"
    return row
}

function wrapperRepository() {
    const tables = emptyTables()
    tables["mission_regular.json"] = {
        101: [definitionRow("wrapper-valid")],
        102: [definitionRow("wrapper-definition-only")],
        103: [definitionRow("wrapper-malformed")],
    }
    tables["mission_regular_reward.json"] = {
        101: {
            2: [rewardRow(1012, 10, 302)],
            1: [rewardRow(1011, 10, 301)],
        },
        103: { 1: [rewardRow("bad", 1, 303)] },
        104: { 1: [rewardRow(1041, 1, 304)] },
    }
    return repository(tables)
}

function throwingRepository() {
    let tableCalls = 0
    return {
        repository: {
            info: () => ({ source: "throwing-wrapper-fixture" }),
            table() {
                tableCalls++
                throw new Error("mission catalog table read")
            },
        },
        tableCalls: () => tableCalls,
    }
}

function assertPropagatesTableFailure(callback) {
    const fixture = throwingRepository()
    assert.throws(
        () => callback(fixture.repository),
        /mission catalog table read/,
    )
    assert.equal(fixture.tableCalls(), 1)
}

test("unsupported category wrappers preserve defaults without reading the repository", () => {
    const fixture = throwingRepository()
    const contentRepository = fixture.repository

    assert.deepEqual(stages.getMissionIdsByCategory(99, contentRepository), [])
    assert.equal(stages.getCurrentStage(99, 1, 10, contentRepository), 1)
    assert.deepEqual(stages.getCompletedStageNumbers(99, 1, 10, contentRepository), [])
    assert.equal(stages.isMissionProgressComplete(99, 1, 10, contentRepository), false)
    assert.deepEqual(stages.getMissionStageIds(99, 1, contentRepository), [])
    assert.equal(patterns.getMissionPattern(99, 1, contentRepository), "")
    assert.equal(patterns.getMissionDefinition(99, 1, contentRepository), undefined)
    assert.equal(patterns.isMissionEnabledAt(
        99,
        1,
        new Date("2026-01-01T00:00:00.000Z"),
        undefined,
        contentRepository,
    ), false)
    assert.throws(
        () => masterData.getMissionMasterDefinitions(99, contentRepository),
        /unsupported mission category: 99/,
    )
    assert.throws(
        () => masterData.getMissionMasterDefinition(99, 1, contentRepository),
        /unsupported mission category: 99/,
    )
    assert.equal(
        rewards.getCategoryMissionRewardStageDefinition(99, 1, 1, contentRepository),
        null,
    )
    assert.equal(fixture.tableCalls(), 0)
})

test("supported category and pattern-wide wrappers propagate repository failures", () => {
    for (const callback of [
        repository => stages.getMissionIdsByCategory(1, repository),
        repository => stages.getCurrentStage(1, 1, 10, repository),
        repository => stages.getCompletedStageNumbers(1, 1, 10, repository),
        repository => stages.isMissionProgressComplete(1, 1, 10, repository),
        repository => stages.getMissionStageIds(1, 1, repository),
        repository => patterns.getMissionPattern(1, 1, repository),
        repository => patterns.getMissionDefinition(1, 1, repository),
        repository => patterns.isMissionEnabledAt(
            1,
            1,
            new Date("2026-01-01T00:00:00.000Z"),
            undefined,
            repository,
        ),
        repository => patterns.getMissionsByPattern("wrapper-valid", repository),
        repository => masterData.getMissionMasterDefinitions(1, repository),
        repository => masterData.getMissionMasterDefinition(1, 1, repository),
        repository => rewards.getCategoryMissionRewardStageDefinition(1, 1, 1, repository),
    ]) assertPropagatesTableFailure(callback)
})

test("standard wrappers share one explicit catalog and fail closed together", () => {
    const contentRepository = wrapperRepository()

    assert.equal(masterData.getMissionMasterDefinition(1, 101, contentRepository).pattern, "wrapper-valid")
    assert.deepEqual(patterns.getMissionsByPattern("wrapper-valid", contentRepository), [{
        missionId: 101,
        category: 1,
    }])
    assert.equal(patterns.getMissionPattern(1, 101, contentRepository), "wrapper-valid")
    assert.equal(patterns.getMissionDefinition(1, 101, contentRepository)[24], "wrapper-marker")
    assert.equal(patterns.isMissionEnabledAt(
        1,
        101,
        new Date("2026-06-01T00:00:00.000Z"),
        undefined,
        contentRepository,
    ), true)
    assert.deepEqual(stages.getMissionIdsByCategory(1, contentRepository), [101])
    assert.deepEqual(stages.getMissionStageIds(1, 101, contentRepository), [1, 2])
    assert.deepEqual(stages.getCompletedStageNumbers(1, 101, 10, contentRepository), [1, 2])
    assert.equal(stages.getCurrentStage(1, 101, 0, contentRepository), 1)
    assert.equal(stages.isMissionProgressComplete(1, 101, 10, contentRepository), true)
    assert.deepEqual(rewards.getCategoryMissionRewardStageDefinition(1, 101, 1, contentRepository), {
        missionRewardId: 1011,
        targetProgress: 10,
        rewards: [{ kind: 1, amount: 2, itemId: 301 }],
    })
    assert.deepEqual(rewards.getRegularMissionRewards(101, 1, contentRepository), [
        { kind: 1, amount: 2, itemId: 301 },
    ])

    for (const missionId of [102, 103, 104]) {
        assert.equal(masterData.getMissionMasterDefinition(1, missionId, contentRepository), undefined)
        assert.equal(patterns.getMissionPattern(1, missionId, contentRepository), "")
        assert.equal(patterns.getMissionDefinition(1, missionId, contentRepository), undefined)
        assert.deepEqual(stages.getMissionStageIds(1, missionId, contentRepository), [])
        assert.equal(stages.getCurrentStage(1, missionId, 99, contentRepository), 1)
        assert.equal(stages.isMissionProgressComplete(1, missionId, 99, contentRepository), false)
        assert.equal(
            rewards.getCategoryMissionRewardStageDefinition(1, missionId, 1, contentRepository),
            null,
        )
        assert.deepEqual(rewards.getRegularMissionRewards(missionId, 1, contentRepository), [])
    }
    assert.deepEqual(patterns.getMissionsByPattern("wrapper-definition-only", contentRepository), [])
    assert.deepEqual(patterns.getMissionsByPattern("wrapper-malformed", contentRepository), [])
})

test("wrapper results are mutable copies that cannot pollute the cached catalog", () => {
    const contentRepository = wrapperRepository()

    const matches = patterns.getMissionsByPattern("wrapper-valid", contentRepository)
    matches[0].missionId = 999
    matches.push({ missionId: 998, category: 1 })
    assert.deepEqual(patterns.getMissionsByPattern("wrapper-valid", contentRepository), [{
        missionId: 101,
        category: 1,
    }])

    const definition = patterns.getMissionDefinition(1, 101, contentRepository)
    definition[0] = "polluted"
    assert.equal(patterns.getMissionDefinition(1, 101, contentRepository)[0], "wrapper-valid")

    const stageIds = stages.getMissionStageIds(1, 101, contentRepository)
    stageIds.push(99)
    assert.deepEqual(stages.getMissionStageIds(1, 101, contentRepository), [1, 2])

    const rewardStage = rewards.getCategoryMissionRewardStageDefinition(1, 101, 1, contentRepository)
    rewardStage.missionRewardId = 999
    rewardStage.rewards[0].itemId = 999
    rewardStage.rewards.push({ kind: 0, amount: 999 })
    assert.deepEqual(rewards.getCategoryMissionRewardStageDefinition(1, 101, 1, contentRepository), {
        missionRewardId: 1011,
        targetProgress: 10,
        rewards: [{ kind: 1, amount: 2, itemId: 301 }],
    })

    const awakeTables = emptyTables()
    awakeTables["mission_char_awake.json"][9011] = [awakeDefinitionRow(901)]
    awakeTables["mission_char_awake_reward.json"][9011] = { 1: [awakeRewardRow()] }
    const awakeRepository = repository(awakeTables, "awake-wrapper-fixture")
    const awakeStage = rewards.getAwakeMissionRewardStageDefinition(9011, 1, awakeRepository)
    awakeStage.specialReward.characterId = 999
    awakeStage.rewards[0].itemId = 999
    assert.deepEqual(rewards.getAwakeMissionRewardStageDefinition(9011, 1, awakeRepository), {
        missionRewardId: 9011,
        targetProgress: 3,
        targetClearSeconds: 90,
        specialReward: { characterId: 901, boardIndex: 1, awakeLevel: 2 },
        rewards: [{ kind: 1, amount: 4, itemId: 301 }],
    })
})

test("legacy unsupported categories and strict date boundaries remain compatible", () => {
    const contentRepository = wrapperRepository()
    assert.deepEqual(masterData.MISSION_CATEGORIES, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    assert.equal(Object.isFrozen(masterData.MISSION_CATEGORIES), true)
    assert.throws(
        () => masterData.getMissionMasterDefinitions(99, contentRepository),
        /unsupported mission category: 99/,
    )
    assert.deepEqual(stages.getMissionIdsByCategory(99, contentRepository), [])
    assert.equal(stages.getCurrentStage(99, 1, 10, contentRepository), 1)
    assert.equal(rewards.getCategoryMissionRewardStageDefinition(99, 1, 1, contentRepository), null)

    const valid = masterData.getMissionMasterDefinition(1, 101, contentRepository)
    assert.equal(
        masterData.isMissionDefinitionEnabledAt(valid, new Date("2026-01-01T00:00:00.000Z")),
        true,
    )
    assert.equal(masterData.isMissionDefinitionEnabledAt(
        { ...valid, enableStart: "2026-02-30 00:00:00" },
        new Date("2026-03-03T00:00:00.000Z"),
    ), false)
})

test("Active Mission rewards remain independent from standard catalog tables", () => {
    const tables = {
        "mission_active_reward.json": { 9001: { 1: [activeRewardRow(701)] } },
    }
    const activeOnlyRepository = repository(tables, "active-only")

    assert.deepEqual(rewards.getMissionRewardStageDefinition(9001, 1, activeOnlyRepository), {
        targetProgress: 7,
        targetClearSeconds: undefined,
        rewards: [{ kind: 1, amount: 3, itemId: 701 }],
    })
    assert.deepEqual(rewards.getActiveMissionRewards(9001, 1, activeOnlyRepository), [
        { kind: 1, amount: 3, itemId: 701 },
    ])
})
