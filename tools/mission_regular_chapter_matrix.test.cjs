"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-regular-chapter-matrix-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    getPlayerCategoryMissionsSync,
    updatePlayerCategoryMissionSync,
} = require("../src/data/domains/mission")
const { getPlayerSync, insertDefaultPlayerSync } = require("../src/data/domains/player")
const { insertPlayerQuestProgressSync } = require("../src/data/domains/quest")
const { RegularComputer } = require("../src/lib/mission/computer-regular")
const {
    getMissionCatalog,
    getMissionCatalogContentTable,
} = require("../src/lib/mission/mission-catalog")
const {
    computeRegularQuestProgress,
    getRegularQuestFactSection,
} = require("../src/lib/mission/regular-quest-facts")
const {
    getMissionFactRequirementRegistry,
} = require("../src/lib/mission/requirements/registry")
const { settleMissionCategories } = require("../src/lib/mission/settlement")

initializeDatabase()
const db = getDb()

test.after(() => {
    if (db.open) db.close()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
})

const referenceInstant = new Date("2026-08-28T00:00:00.000Z")
const MAIN_MISSION_IDS = Object.freeze([
    10, 11, 12, 13, 14, 15,
    42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55,
    90, 93, 97, 101, 104, 109, 110, 111, 112, 113, 114, 115, 118,
])
const HIGH_DIFFICULTY_MISSION_IDS = Object.freeze([
    69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83,
    84, 85, 86, 91, 92, 98, 99, 102, 103, 105, 106, 116, 117,
    119, 120,
])
const CHAPTER_MISSION_IDS = Object.freeze([
    ...MAIN_MISSION_IDS,
    ...HIGH_DIFFICULTY_MISSION_IDS,
])

function parseSelector(value) {
    if (value === null || value === undefined || value === "(None)") return null
    if (value === "") return []
    const values = String(value).split(",").map(Number)
    assert.equal(values.every(Number.isSafeInteger), true)
    return values
}

function matchesSelector(questId, worlds, chapters, quests) {
    const world = Math.floor(questId / 1_000_000)
    const chapter = Math.floor(questId / 1_000) % 1_000
    const quest = questId % 1_000
    return (worlds === null || worlds.includes(world))
        && (chapters === null || chapters.includes(chapter))
        && (quests === null || quests.includes(quest))
}

function deriveChapterMissions(catalog) {
    const mainQuests = getMissionCatalogContentTable(catalog, "main_quest.json")
    const exQuests = getMissionCatalogContentTable(catalog, "ex_quest.json")
    return catalog.getDefinitions(1)
        .filter(definition => {
            const rangeKind = Number(definition.row[7])
            return (rangeKind === 0 || rangeKind === 1)
                && catalog.isEnabledAt(1, definition.missionId, referenceInstant)
        })
        .map(definition => {
            const rangeKind = Number(definition.row[7])
            const worlds = parseSelector(definition.row[8])
            const chapters = parseSelector(definition.row[9])
            const quests = parseSelector(definition.row[10])
            const table = rangeKind === 0 ? mainQuests : exQuests
            const candidates = Object.keys(table)
                .map(Number)
                .filter(questId => Number.isSafeInteger(questId)
                    && matchesSelector(questId, worlds, chapters, quests))
                .sort((left, right) => left - right)
            return {
                missionId: definition.missionId,
                definition,
                section: rangeKind === 0 ? 1 : 4,
                candidates,
            }
        })
        .sort((left, right) => left.missionId - right.missionId)
}

function questProgressContext(mission, questIds) {
    return {
        category: 1,
        questProgress: {
            [String(mission.section)]: questIds.map(questId => ({
                questId,
                finished: true,
                clearRank: 1,
            })),
        },
    }
}

function createPlayer(prefix) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `${prefix}-${randomUUID()}`,
        status: "normal",
    })
    return insertDefaultPlayerSync(account.id).id
}

test("enabled Regular chapter matrix and fact requirements match the reference data", () => {
    const catalog = getMissionCatalog()
    const missions = deriveChapterMissions(catalog)
    const mainMissions = missions.filter(mission => mission.section === 1)
    const highDifficultyMissions = missions.filter(mission => mission.section === 4)

    assert.deepEqual(mainMissions.map(mission => mission.missionId), MAIN_MISSION_IDS)
    assert.deepEqual(
        highDifficultyMissions.map(mission => mission.missionId),
        HIGH_DIFFICULTY_MISSION_IDS,
    )
    assert.equal(missions.length, 63)
    assert.equal(mainMissions.length, 33)
    assert.equal(highDifficultyMissions.length, 30)

    const requirements = getMissionFactRequirementRegistry(catalog)
    const mainCandidateTotal = mainMissions.reduce((total, mission) => {
        assert.equal(mission.candidates.length > 0, true)
        return total + mission.candidates.length
    }, 0)
    const highDifficultyCandidateTotal = highDifficultyMissions.reduce((total, mission) => {
        assert.equal(mission.candidates.length > 0, true)
        return total + mission.candidates.length
    }, 0)
    assert.equal(mainCandidateTotal, 644)
    assert.equal(highDifficultyCandidateTotal, 562)

    for (const mission of missions) {
        const expectedSection = mission.section === 1 ? 1 : 4
        assert.equal(getRegularQuestFactSection(mission.definition), expectedSection)
        const requirement = requirements.getRequirement(1, mission.missionId)
        assert.deepEqual(requirement, {
            mode: "computed",
            facts: [{ kind: "questProgress", sections: [expectedSection] }],
            missionDependencies: [],
        })
    }
})

test("Regular chapter quest progress is selector-bound and cannot roll back", () => {
    const catalog = getMissionCatalog()
    const missionsById = new Map(
        deriveChapterMissions(catalog).map(mission => [mission.missionId, mission]),
    )

    for (const mission of missionsById.values()) {
        const noProgress = computeRegularQuestProgress(
            mission.missionId,
            { category: 1, questProgress: {} },
        )
        assert.equal(noProgress, 0)

        const partialQuests = mission.candidates.slice(0, -1)
        const partialProgress = computeRegularQuestProgress(
            mission.missionId,
            questProgressContext(mission, partialQuests),
        )
        assert.equal(partialProgress, 0)
        assert.equal(
            RegularComputer.compute(mission.missionId, questProgressContext(mission, partialQuests), 1),
            1,
        )

        const completeProgress = computeRegularQuestProgress(
            mission.missionId,
            questProgressContext(mission, mission.candidates),
        )
        assert.equal(completeProgress, 1)
    }

    const mainMission = missionsById.get(42)
    assert.equal(mainMission.candidates.includes(1004002), true)
    assert.equal(computeRegularQuestProgress(42, questProgressContext(mainMission, [1001001])), 0)

    const highDifficultyMission = missionsById.get(69)
    assert.equal(highDifficultyMission.candidates.includes(2001001), false)
    assert.equal(
        computeRegularQuestProgress(69, questProgressContext(highDifficultyMission, [2001002])),
        0,
    )
})

test("settlement rewards each chapter mission once without player-scoped leakage", () => {
    const catalog = getMissionCatalog()
    const missions = deriveChapterMissions(catalog)
    const missionOne = missions.find(mission => mission.missionId === 42)
    assert.ok(missionOne)

    const playerA = createPlayer("mission-regular-chapter-matrix")
    const playerBefore = getPlayerSync(playerA)
    updatePlayerCategoryMissionSync(playerA, 1, 42, 1)
    for (const questId of missionOne.candidates) {
        insertPlayerQuestProgressSync(playerA, 1, {
            questId,
            finished: true,
            clearRank: 1,
        })
    }

    const firstSettlement = settleMissionCategories(playerA, [1], referenceInstant)
    const firstStage = catalog.getRewardStage(1, 42, 1)
    assert.ok(firstStage)
    assert.deepEqual(firstSettlement.missionInfo, [{
        mission_category_id: 1,
        mission_id: 42,
        mission_reward_id: firstStage.missionRewardId,
    }])
    assert.deepEqual(firstStage.rewards, [{ kind: 0, amount: 30 }])
    assert.deepEqual(firstSettlement.itemList, {})
    assert.deepEqual(firstSettlement.characterList, [])
    assert.deepEqual(firstSettlement.equipmentList, [])
    assert.deepEqual(firstSettlement.degreeIds, [])
    assert.ok(firstSettlement.userInfo)
    assert.equal(
        firstSettlement.userInfo.free_vmoney - playerBefore.freeVmoney,
        30,
    )
    const persistedAfterFirst = getPlayerCategoryMissionsSync(playerA, 1)
    assert.equal(persistedAfterFirst[42].progress, 1)
    assert.deepEqual(persistedAfterFirst[42].stages, { 1: true })

    const insertedCandidates = new Set(["1:1004002"])
    const insertAllCandidates = db.transaction(() => {
        for (const mission of missions) {
            for (const questId of mission.candidates) {
                const key = `${mission.section}:${questId}`
                if (insertedCandidates.has(key)) continue
                insertedCandidates.add(key)
                insertPlayerQuestProgressSync(playerA, mission.section, {
                    questId,
                    finished: true,
                    clearRank: 1,
                })
            }
        }
    })
    insertAllCandidates()

    const secondSettlement = settleMissionCategories(playerA, [1], referenceInstant)
    assert.equal(secondSettlement.missionInfo.some(entry => entry.mission_id === 42), false)
    const allSettled = [...firstSettlement.missionInfo, ...secondSettlement.missionInfo]
        .sort((left, right) => left.mission_id - right.mission_id)
    assert.deepEqual(
        allSettled.map(entry => entry.mission_id),
        [...CHAPTER_MISSION_IDS].sort((left, right) => left - right),
    )
    assert.equal(new Set(allSettled.map(entry => entry.mission_id)).size, 63)
    assert.deepEqual(allSettled.map(entry => entry.mission_category_id), missions.map(() => 1))

    let rewardDrivenSettlement = settleMissionCategories(playerA, [1], referenceInstant)
    while (rewardDrivenSettlement.missionInfo.length > 0) {
        assert.equal(rewardDrivenSettlement.missionInfo.some(entry => (
            CHAPTER_MISSION_IDS.includes(entry.mission_id)
        )), false)
        rewardDrivenSettlement = settleMissionCategories(playerA, [1], referenceInstant)
    }

    const repeatedSettlement = settleMissionCategories(playerA, [1], referenceInstant)
    assert.deepEqual(repeatedSettlement.missionInfo, [])

    const playerB = createPlayer("mission-regular-chapter-matrix-blank")
    const playerBSettlement = settleMissionCategories(playerB, [1], referenceInstant)
    const playerBChapterIds = new Set(
        playerBSettlement.missionInfo
            .filter(entry => CHAPTER_MISSION_IDS.includes(entry.mission_id))
            .map(entry => entry.mission_id),
    )
    assert.equal(playerBChapterIds.size, 0)
})
