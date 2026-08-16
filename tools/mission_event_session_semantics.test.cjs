"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-event-session-semantics-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

const oracle = require("./fixtures/mission-event/legacy-d594854.json")
const { initializeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { givePlayerItemSync } = require("../src/data/domains/item")
const {
    getPlayerCategoryMissionsSync,
} = require("../src/data/domains/mission")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { insertPlayerQuestProgressSync } = require("../src/data/domains/quest")
const {
    MissionEvaluationSession,
    createProductionMissionFactLoaderRegistry,
    getMissionCatalog,
    getMissionFactRequirementRegistry,
} = require("../src/lib/mission")
const { EventSafeComputer } = require("../src/lib/mission/computer-event-safe")
const { settleMissionCategories } = require("../src/lib/mission/settlement")

initializeDatabase()
const catalog = getMissionCatalog()
const requirementRegistry = getMissionFactRequirementRegistry(catalog)

function createPlayer(label) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `${label}-${randomUUID()}`,
        status: "normal",
    })
    return insertDefaultPlayerSync(account.id).id
}

function buildContext(playerId, missionId, evaluationTime) {
    const session = new MissionEvaluationSession({
        playerId,
        evaluationTime,
        catalog,
        requirementRegistry,
        candidates: [{ category: 3, missionId }],
        orchestratorFacts: [{ kind: "player" }],
        loaders: createProductionMissionFactLoaderRegistry(),
    })
    return EventSafeComputer.buildContextFromSession(session, 3, [missionId])
}

function response(result) {
    return {
        missionInfo: result.missionInfo,
        itemList: result.itemList,
        characterList: result.characterList,
        equipmentList: result.equipmentList,
        degreeIds: result.degreeIds,
        passCardPoints: result.passCardPoints,
        userInfo: result.userInfo ?? null,
    }
}

function persisted(playerId) {
    const state = getPlayerCategoryMissionsSync(playerId, 3)[2316]
    return { missionId: 2316, progress: state.progress, stages: state.stages }
}

test.after(() => {
    const { closeDatabase } = require("../src/data")
    closeDatabase()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
})

test("Event Session compute matches the pre-migration oracle across mission classes", () => {
    const playerId = createPlayer("event-session-compute")
    givePlayerItemSync(playerId, 80111, 12)
    insertPlayerQuestProgressSync(playerId, 13, { questId: 1001, finished: true })
    insertPlayerQuestProgressSync(playerId, 13, { questId: 1002, finished: true })

    assert.equal(EventSafeComputer.compute(
        2316,
        buildContext(playerId, 2316, new Date("2023-11-30T04:00:00.000Z")),
        3,
    ), oracle.compute.item)
    assert.equal(EventSafeComputer.compute(
        1303,
        buildContext(playerId, 1303, new Date("2019-12-03T04:00:00.000Z")),
        0,
    ), oracle.compute.quest)
    assert.equal(EventSafeComputer.compute(
        1454,
        buildContext(playerId, 1454, new Date("2020-05-01T04:00:00.000Z")),
        0,
    ), oracle.compute.aggregate)
    assert.equal(EventSafeComputer.compute(
        1200,
        buildContext(playerId, 1200, new Date("2019-11-28T04:00:00.000Z")),
        7,
    ), oracle.compute.persisted)
    assert.equal(EventSafeComputer.compute(
        1402,
        buildContext(playerId, 1402, new Date("2020-05-01T04:00:00.000Z")),
        9,
    ), oracle.compute.unsupported)
})

test("Event Session current-state compute matches the independent d594854 oracle", () => {
    const playerId = createPlayer("event-session-current-state-oracle")
    const currentStateMissionIds = [
        1201, 1202, 1203, 1204, 1205, 1206, 1207, 1212,
        1217, 1218, 1219, 1220, 1305, 1306, 1307,
    ]
    const availableState = {
        maxCharacterLevel: 65,
        manaBoardNodeCount: 15,
        overLimitCount: 2,
        characterEpisodeClearCount: 4,
        clearedMainChapters: new Set([1, 3]),
        equipmentAwakeningCount: 3,
        hasEquippedAbilitySoul: true,
    }
    const unavailableState = {
        maxCharacterLevel: null,
        manaBoardNodeCount: null,
        overLimitCount: null,
        characterEpisodeClearCount: null,
        clearedMainChapters: null,
        equipmentAwakeningCount: null,
        hasEquippedAbilitySoul: null,
    }
    const actual = { available: {}, unavailable: {} }

    for (const missionId of currentStateMissionIds) {
        const context = buildContext(playerId, missionId, new Date("2019-12-03T04:00:00.000Z"))
        actual.available[String(missionId)] = EventSafeComputer.compute(
            missionId,
            { ...context, eventCurrentState: availableState },
            0,
        )
        actual.unavailable[String(missionId)] = EventSafeComputer.compute(
            missionId,
            { ...context, eventCurrentState: unavailableState },
            7,
        )
    }

    assert.deepEqual(actual, oracle.compute.currentState)
})

test("Event Session first and repeated settlement match the full legacy oracle", () => {
    const playerId = createPlayer("event-session-settlement-oracle")
    givePlayerItemSync(playerId, 80111, 10)
    const scope = [{ category: 3, missionIds: [2316] }]
    const evaluationTime = new Date("2023-11-30T04:00:00.000Z")

    const firstResult = settleMissionCategories(playerId, scope, evaluationTime)
    const first = { response: response(firstResult), persisted: persisted(playerId) }
    const repeatedResult = settleMissionCategories(playerId, scope, evaluationTime)
    const repeated = { response: response(repeatedResult), persisted: persisted(playerId) }

    assert.deepEqual({ first, repeated }, oracle.settlement)
})
