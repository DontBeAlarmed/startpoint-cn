"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    productionContentSnapshotProvider,
} = require("../src/content/runtime/content-snapshot")

const previousSnapshot = productionContentSnapshotProvider.snapshot
productionContentSnapshotProvider.snapshot = null

const activeMasterData = require("../src/lib/mission/active-master-data")
const awakeRuleCatalog = require("../src/lib/mission/awake-rule-catalog")
const characterQueries = require("../src/lib/mission/character-queries")
const masterData = require("../src/lib/mission/master-data")
const rewards = require("../src/lib/mission/rewards")
const stages = require("../src/lib/mission/stages")

const bundledAwakeDefinitions = require("../assets/mission_char_awake.json")

function clone(value) {
    return JSON.parse(JSON.stringify(value))
}

function masterRow(pattern, marker) {
    const row = []
    row[0] = pattern
    row[24] = marker
    row[25] = "2026-01-01 00:00:00"
    row[26] = "2026-12-31 23:59:59"
    return row
}

function regularRewardRow(rewardId, targetProgress, itemId) {
    const row = []
    row[0] = String(rewardId)
    row[1] = String(targetProgress)
    row[5] = "1"
    row[6] = "2"
    row[7] = String(itemId)
    return row
}

function activeRewardRow(targetProgress, itemId) {
    const row = []
    row[3] = String(targetProgress)
    row[4] = "(None)"
    row[7] = "1"
    row[8] = "3"
    row[9] = String(itemId)
    return row
}

function awakeRewardRow(rewardId, targetProgress, itemId) {
    const row = []
    row[0] = String(rewardId)
    row[1] = "(None)"
    row[5] = String(targetProgress)
    row[6] = "(None)"
    row[9] = "1"
    row[10] = "4"
    row[11] = String(itemId)
    return row
}

function awakeDefinitions(characterId, allCompletePattern) {
    const table = clone(bundledAwakeDefinitions)
    table["1110012"][0][1] = String(characterId)
    table["1110012"][0][24] = String(characterId)
    table["1110014"][0][4] = allCompletePattern
    return table
}

function releaseTables(marker) {
    const missionId = marker * 1000 + 1
    const eventId = marker * 1000 + 2
    const characterId = marker * 1000 + 3
    const questId = marker * 1000 + 4
    const rewardId = marker * 1000 + 5
    const itemId = marker * 1000 + 6
    return {
        ids: { missionId, eventId, characterId, questId, rewardId, itemId },
        tables: {
            "mission_active.json": { [missionId]: [[`active-${marker}`]] },
            "mission_active_event.json": { [eventId]: [[`event-${marker}`]] },
            "character_quest_lookup.json": {
                [questId]: [[String(characterId), "(None)", "(None)"]],
            },
            "mission_regular.json": {
                [missionId]: [masterRow(`runtime-${marker}`, `marker-${marker}`)],
            },
            "mission_regular_reward.json": {
                [missionId]: { 1: [regularRewardRow(rewardId, marker, itemId)] },
            },
            "mission_active_reward.json": {
                [missionId]: { 1: [activeRewardRow(marker, itemId)] },
            },
            "mission_char_awake.json": awakeDefinitions(
                characterId,
                marker === 2 ? "96" : "13",
            ),
            "mission_char_awake_reward.json": {
                [missionId]: { 1: [awakeRewardRow(rewardId, marker, itemId)] },
            },
        },
    }
}

function repository(tables, source) {
    return {
        info: () => ({
            source,
            assetVersion: source,
            generatorVersion: 1,
            releaseDigest: source,
        }),
        table(tableName) {
            if (!Object.hasOwn(tables, tableName)) {
                throw new Error(`${source} missing whole table ${tableName}`)
            }
            return tables[tableName]
        },
    }
}

function installRelease(release, source) {
    productionContentSnapshotProvider.snapshot = {
        cdn: { targetVersion: source },
        archiveSources: { schemaVersion: 1, archives: [] },
        repository: repository(release.tables, source),
    }
}

test.after(() => {
    productionContentSnapshotProvider.snapshot = previousSnapshot
})

test("mission tables imported before snapshot follow the current complete runtime release", () => {
    const first = releaseTables(1)
    const second = releaseTables(2)

    installRelease(first, "release-a")
    assert.deepEqual(
        activeMasterData.getActiveMissionMasterDefinitions().map(entry => entry.missionId),
        [first.ids.missionId],
    )
    assert.deepEqual(
        activeMasterData.getActiveMissionEventMasterDefinitions().map(entry => entry.eventId),
        [first.ids.eventId],
    )
    assert.deepEqual(
        characterQueries.getCharacterStoryQuestIds(first.ids.characterId),
        [first.ids.questId],
    )
    assert.equal(
        masterData.getMissionMasterDefinition(1, first.ids.missionId).pattern,
        "runtime-1",
    )
    assert.equal(
        rewards.getCategoryMissionRewardStageDefinition(1, first.ids.missionId, 1).targetProgress,
        1,
    )
    assert.equal(
        rewards.getMissionRewardStageDefinition(first.ids.missionId, 1).targetProgress,
        1,
    )
    assert.equal(
        rewards.getAwakeMissionRewardStageDefinition(first.ids.missionId, 1).targetProgress,
        1,
    )
    assert.deepEqual(stages.getMissionIdsByCategory(1), [first.ids.missionId])
    assert.equal(awakeRuleCatalog.getAwakeMissionDefinitionRow(1110012)[1], String(first.ids.characterId))
    assert.equal(
        awakeRuleCatalog.getAwakeGenericCharacterClearRules()
            .find(rule => rule.missionId === 1110012).characterId,
        first.ids.characterId,
    )
    assert.equal(
        awakeRuleCatalog.getAwakeMissionIdsByFamily("all-complete").includes(1110014),
        true,
    )

    installRelease(second, "release-b")
    assert.equal(activeMasterData.getActiveMissionMasterDefinition(first.ids.missionId), undefined)
    assert.equal(
        activeMasterData.getActiveMissionMasterDefinition(second.ids.missionId).row[0],
        "active-2",
    )
    assert.equal(
        activeMasterData.getActiveMissionEventMasterDefinition(second.ids.eventId).row[0],
        "event-2",
    )
    assert.deepEqual(characterQueries.getCharacterStoryQuestIds(first.ids.characterId), [])
    assert.deepEqual(
        characterQueries.getCharacterStoryQuestIds(second.ids.characterId),
        [second.ids.questId],
    )
    assert.equal(masterData.getMissionMasterDefinition(1, first.ids.missionId), undefined)
    assert.equal(
        masterData.getMissionMasterDefinition(1, second.ids.missionId).row[24],
        "marker-2",
    )
    assert.equal(
        rewards.getRegularMissionRewards(second.ids.missionId, 1)[0].itemId,
        second.ids.itemId,
    )
    assert.equal(
        rewards.getActiveMissionRewards(second.ids.missionId, 1)[0].itemId,
        second.ids.itemId,
    )
    assert.equal(
        rewards.getAwakeMissionRewards(second.ids.missionId, 1)[0].itemId,
        second.ids.itemId,
    )
    assert.deepEqual(stages.getMissionStageIds(1, second.ids.missionId), [1])
    assert.equal(awakeRuleCatalog.getAwakeMissionDefinitionRow(1110012)[1], String(second.ids.characterId))
    assert.equal(
        awakeRuleCatalog.getAwakeGenericCharacterClearRules()
            .find(rule => rule.missionId === 1110012).characterId,
        second.ids.characterId,
    )
    assert.equal(
        awakeRuleCatalog.getAwakeMissionRuleFamilies()
            .find(family => family.family === "story-read").missionIds.includes(1110014),
        true,
    )
    assert.equal(
        awakeRuleCatalog.getAwakeMissionRuleFamilies()
            .find(family => family.family === "all-complete").missionIds.includes(1110014),
        false,
    )
})

test("explicit repositories take priority over the installed runtime release", () => {
    const runtime = releaseTables(3)
    const explicit = releaseTables(4)
    const explicitRepository = repository(explicit.tables, "explicit")
    installRelease(runtime, "runtime")

    assert.deepEqual(
        activeMasterData.getActiveMissionMasterDefinitions(explicitRepository)
            .map(entry => entry.missionId),
        [explicit.ids.missionId],
    )
    assert.deepEqual(
        characterQueries.getCharacterStoryQuestIds(explicit.ids.characterId, explicitRepository),
        [explicit.ids.questId],
    )
    assert.equal(
        masterData.getMissionMasterDefinition(1, explicit.ids.missionId, explicitRepository).pattern,
        "runtime-4",
    )
    assert.equal(
        rewards.getRegularMissionRewards(explicit.ids.missionId, 1, explicitRepository)[0].itemId,
        explicit.ids.itemId,
    )
    assert.deepEqual(
        stages.getMissionStageIds(1, explicit.ids.missionId, explicitRepository),
        [1],
    )
    assert.equal(
        awakeRuleCatalog.getAwakeMissionDefinitionRow(1110012, explicitRepository)[1],
        String(explicit.ids.characterId),
    )
})

test("initialized runtime table failures never fall back to bundled mission data", () => {
    productionContentSnapshotProvider.snapshot = {
        cdn: { targetVersion: "broken" },
        archiveSources: { schemaVersion: 1, archives: [] },
        repository: {
            info: () => ({
                source: "release",
                assetVersion: "broken",
                generatorVersion: 1,
                releaseDigest: "broken",
            }),
            table: () => { throw new Error("broken mission release") },
        },
    }

    assert.throws(
        () => activeMasterData.getActiveMissionMasterDefinitions(),
        /broken mission release/,
    )
    assert.throws(
        () => characterQueries.getCharacterStoryQuestIds(111001),
        /broken mission release/,
    )
    assert.throws(
        () => masterData.getMissionMasterDefinitions(1),
        /broken mission release/,
    )
    assert.throws(
        () => rewards.getRegularMissionRewards(1, 1),
        /broken mission release/,
    )
    assert.throws(
        () => stages.getMissionIdsByCategory(1),
        /broken mission release/,
    )
    assert.throws(
        () => awakeRuleCatalog.getAwakeMissionDefinitionRow(11),
        /broken mission release/,
    )
})
