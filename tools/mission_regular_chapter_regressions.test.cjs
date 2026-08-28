require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "mission-regular-chapter-regressions-db-"),
)
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR
let db
let restoreContentSnapshot = () => {}
let cleaned = false

function restoreEnvironment() {
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
}

function cleanup() {
    if (cleaned) return
    cleaned = true
    const errors = []
    for (const action of [
        () => restoreContentSnapshot(),
        () => { if (db?.open) db.close() },
        () => fs.rmSync(databaseDirectory, { recursive: true, force: true }),
        restoreEnvironment,
    ]) {
        try { action() } catch (error) { errors.push(error) }
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, "chapter regression cleanup failed")
}

process.once("exit", cleanup)

const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
restoreContentSnapshot = installBundledGameplaySnapshot()

const mainQuests = require("../assets/main_quest.json")
const exQuests = require("../assets/ex_quest.json")
const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    getPlayerEquipmentListSync,
} = require("../src/data/domains/equipment")
const {
    insertDefaultPlayerSync,
} = require("../src/data/domains/player")
const {
    insertPlayerQuestProgressListSync,
} = require("../src/data/domains/quest")
const {
    getMissionMasterDefinitions,
} = require("../src/lib/mission/master-data")
const {
    getRegularQuestFactSection,
    isRegularQuestMissionSupported,
} = require("../src/lib/mission/regular-quest-facts")
const {
    getComputer,
} = require("../src/lib/mission/registry")
const {
    settleMissionCategories,
} = require("../src/lib/mission/settlement")

initializeDatabase()
db = getDb()

const enabledMissionIds = Object.freeze([
    10, 11, 12, 13, 14, 15, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80,
    81, 82, 83, 84, 85, 86, 90, 91, 92, 97, 98, 99, 101, 102, 103, 104, 105,
    106, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120,
])
const evaluationTime = new Date("2026-08-28T04:00:00.000Z")
const chapters = Object.freeze(Array.from({ length: 12 }, (_, index) => index + 1))

function getQuestsByChapter(table) {
    const result = new Map(chapters.map(chapter => [chapter, []]))
    for (const questIdText of Object.keys(table)) {
        const questId = Number(questIdText)
        assert.ok(Number.isSafeInteger(questId) && questId > 0)
        const chapter = Math.floor(questId / 1_000_000)
        assert.ok(result.has(chapter), `unexpected chapter ${chapter}: ${questId}`)
        result.get(chapter).push(questId)
    }
    return result
}

function assertChapterSectionsAreNonEmpty() {
    for (const chapter of chapters) {
        assert.ok(mainQuestsByChapter.get(chapter).length > 0, `main chapter ${chapter} is empty`)
        assert.ok(exQuestsByChapter.get(chapter).length > 0, `high-difficulty chapter ${chapter} is empty`)
    }
}

function insertQuestProgress(playerId, section, questIds) {
    insertPlayerQuestProgressListSync(playerId, {
        [String(section)]: questIds.map(questId => ({
            questId,
            finished: true,
            clearRank: 4,
        })),
    })
}

function getExpectedEquipmentInventories(playerId) {
    const inventory = getPlayerEquipmentListSync(playerId)
    const singleIds = [3080002, 3020003, 3060010]
    const fiveStackIds = [5030037, 5050033, 5010057, 5090028, 5100016, 5080029]
    for (const equipmentId of singleIds) {
        assert.deepEqual(inventory[String(equipmentId)], { level: 1, enhancementLevel: 0, protection: false, stack: 0 })
    }
    for (const equipmentId of fiveStackIds) {
        assert.deepEqual(inventory[String(equipmentId)], { level: 1, enhancementLevel: 0, protection: false, stack: 4 })
    }
    return new Set([...singleIds, ...fiveStackIds])
}

const mainQuestsByChapter = getQuestsByChapter(mainQuests)
const exQuestsByChapter = getQuestsByChapter(exQuests)
assertChapterSectionsAreNonEmpty()

function isMissionEnabledAt(missionId) {
    const { isMissionEnabledAt: enabledAt } = require("../src/lib/mission/patterns")
    return enabledAt(1, missionId, evaluationTime)
}

const definitions = getMissionMasterDefinitions(1)
    .filter(definition => Number(definition.row[2]) === 22)
    .filter(definition => isMissionEnabledAt(definition.missionId))

assert.deepEqual(
    definitions.map(definition => definition.missionId),
    enabledMissionIds,
)
assert.ok(definitions.every(definition => isRegularQuestMissionSupported(definition.missionId)))
for (const definition of definitions) {
    assert.equal(
        getRegularQuestFactSection(definition),
        Number(definition.row[7]) === 0 ? 1 : 4,
    )
}

const mainGaps = chapters.map(chapter => {
    const quests = mainQuestsByChapter.get(chapter).sort((left, right) => left - right)
    return quests[quests.length - 1]
})
const exGaps = chapters.map(chapter => {
    const quests = exQuestsByChapter.get(chapter).sort((left, right) => left - right)
    return quests[quests.length - 1]
})

const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `mission-regular-chapter-regressions-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
insertQuestProgress(
    playerId,
    1,
    chapters.flatMap(chapter => mainQuestsByChapter.get(chapter).filter(questId => !mainGaps.includes(questId))),
)
insertQuestProgress(
    playerId,
    4,
    chapters.flatMap(chapter => exQuestsByChapter.get(chapter).filter(questId => !exGaps.includes(questId))),
)

const regularComputer = getComputer(1)
const partialContext = regularComputer.buildContext(playerId, 1)
const progressByMissionId = new Map(definitions.map(definition => [
    definition.missionId,
    regularComputer.compute(definition.missionId, partialContext, 0),
]))
for (const definition of definitions) {
    assert.equal(progressByMissionId.get(definition.missionId), 0)
    assert.equal(
        regularComputer.compute(definition.missionId, partialContext, 1),
        1,
        `persisted progress for mission ${definition.missionId} must not roll back`,
    )
}

insertQuestProgress(playerId, 1, mainGaps)
const mainCompleteContext = regularComputer.buildContext(playerId, 1)
for (const definition of definitions) {
    const expected = Number(definition.row[7]) === 0 ? 1 : 0
    assert.equal(
        regularComputer.compute(definition.missionId, mainCompleteContext, 0),
        expected,
        `mission ${definition.missionId} after main completion should be ${expected}`,
    )
}

insertQuestProgress(playerId, 4, exGaps)
const completeContext = regularComputer.buildContext(playerId, 1)
for (const definition of definitions) {
    assert.equal(
        regularComputer.compute(definition.missionId, completeContext, 0),
        1,
        `mission ${definition.missionId} must complete after both sections`,
    )
}

const firstSettlement = settleMissionCategories(
    playerId,
    [{ category: 1, missionIds: enabledMissionIds }],
    evaluationTime,
)
const settledMissionIds = firstSettlement.missionInfo.map(info => info.mission_id)
assert.equal(new Set(settledMissionIds).size, 48)
assert.deepEqual([...new Set(settledMissionIds)].sort((left, right) => left - right), enabledMissionIds)
assert.deepEqual(
    firstSettlement.missionInfo.map(info => info.mission_category_id),
    Array.from({ length: 48 }, () => 1),
)

const projectedEquipmentIds = new Set(firstSettlement.equipmentList.map(equipment => equipment.equipment_id))
assert.deepEqual(
    [...getExpectedEquipmentInventories(playerId)].sort((left, right) => left - right),
    [...projectedEquipmentIds].sort((left, right) => left - right),
)

const equipmentBeforeRepeat = getPlayerEquipmentListSync(playerId)
const repeatedSettlement = settleMissionCategories(
    playerId,
    [{ category: 1, missionIds: enabledMissionIds }],
    evaluationTime,
)
assert.deepEqual(repeatedSettlement.missionInfo, [])
assert.deepEqual(getPlayerEquipmentListSync(playerId), equipmentBeforeRepeat)

console.log("regular chapter regressions passed")
cleanup()
