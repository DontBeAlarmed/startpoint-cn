"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-awake-session-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
const restoreContentSnapshot = installBundledGameplaySnapshot()
const { initializeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerCharacterSync } = require("../src/data/domains/character")
const {
    getPlayerCategoryMissionsSync,
    updatePlayerCategoryMissionStageSync,
    updatePlayerCategoryMissionSync,
} = require("../src/data/domains/mission")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { getDb } = require("../src/data/db")
const { AwakeComputer, buildAwakeContext } = require("../src/lib/mission/computer-awake")
const { MissionEvaluationSession } = require("../src/lib/mission/evaluation-session")
const { getMissionCatalog } = require("../src/lib/mission/mission-catalog")
const { createProductionMissionFactLoaderRegistry } = require("../src/lib/mission/production-fact-loaders")
const { getMissionFactRequirementRegistry } = require("../src/lib/mission/requirements/registry")
const { evaluateMissionCandidates } = require("../src/lib/mission/settlement-evaluate")
const { prepareMissionSettlement } = require("../src/lib/mission/settlement-prepare")
const { getAwakeBattleMissionIds } = require("../src/lib/mission/awake-settlement")
const {
    requirement,
    requirementRegistry,
} = require("./helpers/mission-evaluation-session-fixture.cjs")

initializeDatabase()
const db = getDb()
const evaluationTime = new Date("2025-01-01T12:00:00.000Z")

function createPlayer(label) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `${label}-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    insertDefaultPlayerCharacterSync(playerId, 341005)
    db.prepare(`
        INSERT INTO players_character_quest_clears (
            player_id, character_id, clear_count, multi_count,
            leader_clear_count, leader_multi_count, leader_power_flip_count
        ) VALUES (?, 341005, 5, 2, 3, 1, 0)
    `).run(playerId)
    return playerId
}

test("battle candidates use only Catalog character indexes and valid direct mission IDs", () => {
    const requestedCharacters = []
    const catalog = {
        getAwakeMissionIdsByCharacter(characterId) {
            requestedCharacters.push(characterId)
            return characterId === 341005 ? [3410054, 3410051, 3410051] : []
        },
        getDefinition(category, missionId) {
            return category === 9 && missionId === 1110013 ? { category, missionId } : undefined
        },
    }

    assert.deepEqual(
        getAwakeBattleMissionIds(
            [341005, 999999, 341005, -1, 1.5],
            [1110013, 1110013, 15000, -1, 1.5],
            catalog,
        ),
        [1110013, 3410051, 3410054],
    )
    assert.deepEqual(requestedCharacters, [341005, 999999])
})

test("all-complete Session plans child facts and scoped evaluation matches legacy", () => {
    const playerId = createPlayer("awake-session")
    updatePlayerCategoryMissionSync(playerId, 9, 3410051, 1)
    updatePlayerCategoryMissionSync(playerId, 9, 3410052, 4)
    updatePlayerCategoryMissionSync(playerId, 9, 3410053, 5)
    updatePlayerCategoryMissionSync(playerId, 9, 3410054, 1)
    updatePlayerCategoryMissionStageSync(playerId, 9, 1, 3410051, true)

    const catalog = getMissionCatalog()
    const registry = getMissionFactRequirementRegistry(catalog)
    const session = new MissionEvaluationSession({
        playerId,
        evaluationTime,
        catalog,
        requirementRegistry: registry,
        candidates: [{ category: 9, missionId: 3410054 }],
        orchestratorFacts: [{ kind: "player" }],
        loaders: createProductionMissionFactLoaderRegistry(),
    })
    assert.deepEqual(session.factLoadPlan.keyIds, [
        "categoryMissionProgress:9:3410051,3410052,3410053",
        "characterClearCounters",
        "player",
    ])

    const legacyContext = buildAwakeContext(playerId)
    const scopedContext = AwakeComputer.buildContextFromSession(session, 9, [3410054])
    const persisted = getPlayerCategoryMissionsSync(playerId, 9)
    for (const missionId of [3410051, 3410052, 3410053, 3410054]) {
        const dbProgress = persisted[missionId]?.progress ?? 0
        assert.equal(
            AwakeComputer.compute(missionId, scopedContext, dbProgress),
            AwakeComputer.compute(missionId, legacyContext, dbProgress),
            `mission ${missionId}`,
        )
    }

    const prepared = prepareMissionSettlement(
        playerId,
        [{ category: 9, missionIds: [3410054] }],
        evaluationTime,
    )
    const originalLegacyBuilder = AwakeComputer.buildContext
    AwakeComputer.buildContext = () => { throw new Error("Category 9 evaluation must use Session context") }
    let evaluation
    try {
        evaluation = evaluateMissionCandidates(prepared)
    } finally {
        AwakeComputer.buildContext = originalLegacyBuilder
    }

    assert.deepEqual(evaluation.missions, [{
        category: 9,
        missionId: 3410054,
        declaredFactDependencies: [{
            kind: "categoryMissionProgress",
            category: 9,
            missionIds: [3410051, 3410052, 3410053],
        }],
        dbProgress: 1,
        computedProgress: 3,
        finalProgress: 3,
        receivedStages: [],
    }])
    const loaderKinds = evaluation.observer.loaderCalls.map(key => key.kind)
    assert.equal(loaderKinds.filter(kind => kind === "player").length, 1)
    assert.equal(loaderKinds.filter(kind => kind === "characterClearCounters").length, 1)
    assert.equal(loaderKinds.filter(kind => kind === "categoryMissionProgress").length, 1)
})

test("mixed Event and Awake evaluation keeps Category 9 progress scoped to Awake", () => {
    const playerId = createPlayer("awake-mixed-category-progress")
    updatePlayerCategoryMissionSync(playerId, 9, 1110011, 3)
    updatePlayerCategoryMissionSync(playerId, 9, 1110012, 10)
    updatePlayerCategoryMissionSync(playerId, 9, 1110013, 1)

    const prepared = scopes => Object.freeze({
        playerId,
        evaluationTime: evaluationTime.toISOString(),
        scopes: Object.freeze(scopes.map(scope => Object.freeze({
            category: scope.category,
            candidateCount: 1,
            enabledMissionIds: Object.freeze([scope.missionId]),
        }))),
        candidates: Object.freeze(scopes.map(scope => Object.freeze({
            category: scope.category,
            missionId: scope.missionId,
        }))),
        passPreparation: Object.freeze({
            weeklyEventIds: Object.freeze([]),
            loginEventIds: Object.freeze([]),
        }),
    })
    const awakeAlone = evaluateMissionCandidates(prepared([
        { category: 9, missionId: 1110014 },
    ])).missions.find(mission => mission.category === 9)
    const mixed = evaluateMissionCandidates(prepared([
        { category: 3, missionId: 1454 },
        { category: 9, missionId: 1110014 },
    ])).missions.find(mission => mission.category === 9)

    assert.equal(awakeAlone.finalProgress, 3)
    assert.deepEqual(mixed, awakeAlone)
})

test("Awake Session context rejects wrong category, batch, and requirement facts", () => {
    const playerId = createPlayer("awake-session-fail-closed")
    const catalog = getMissionCatalog()
    const loaders = createProductionMissionFactLoaderRegistry()
    const validSession = new MissionEvaluationSession({
        playerId,
        evaluationTime,
        catalog,
        requirementRegistry: getMissionFactRequirementRegistry(catalog),
        candidates: [{ category: 9, missionId: 3410051 }],
        orchestratorFacts: [{ kind: "player" }],
        loaders,
    })
    assert.throws(
        () => AwakeComputer.buildContextFromSession(validSession, 8, [3410051]),
        /Awake Session context requires category 9/,
    )
    assert.throws(
        () => AwakeComputer.buildContextFromSession(validSession, 9, [3410052]),
        /Awake mission 3410052 is outside the current Session candidate batch/,
    )

    const missingFactsSession = new MissionEvaluationSession({
        playerId,
        evaluationTime,
        catalog,
        requirementRegistry: requirementRegistry([{
            category: 9,
            missionId: 3410051,
            requirement: requirement([]),
        }]),
        candidates: [{ category: 9, missionId: 3410051 }],
        orchestratorFacts: [{ kind: "player" }],
        loaders,
    })
    assert.throws(
        () => AwakeComputer.buildContextFromSession(missingFactsSession, 9, [3410051]),
        /Awake requirement mismatch for 9:3410051/,
    )

    const wrongCategoryProgressSession = new MissionEvaluationSession({
        playerId,
        evaluationTime,
        catalog,
        requirementRegistry: requirementRegistry([{
            category: 9,
            missionId: 1110014,
            requirement: requirement([{
                kind: "categoryMissionProgress",
                category: 3,
                missionIds: [1454],
            }]),
        }]),
        candidates: [{ category: 9, missionId: 1110014 }],
        orchestratorFacts: [{ kind: "player" }],
        loaders,
    })
    assert.throws(
        () => AwakeComputer.buildContextFromSession(
            wrongCategoryProgressSession,
            9,
            [1110014],
        ),
        /Awake requirement mismatch for 9:1110014/,
    )
})

test("Category 9 persisted progress and stages are read once for the scoped candidate batch", () => {
    const playerId = createPlayer("awake-persisted-batch")
    updatePlayerCategoryMissionSync(playerId, 9, 3410051, 1)
    updatePlayerCategoryMissionStageSync(playerId, 9, 1, 3410051, true)
    const prepared = prepareMissionSettlement(
        playerId,
        [{ category: 9, missionIds: [3410051, 3410052] }],
        evaluationTime,
    )
    const originalPrepare = db.prepare.bind(db)
    let progressReads = 0
    let stageReads = 0
    db.prepare = sql => {
        const normalized = String(sql).replace(/\s+/g, " ").trim()
        if (normalized.includes("FROM players_category_missions")
            && normalized.includes("category = ?")
            && normalized.includes("id IN")) progressReads++
        if (normalized.includes("FROM players_category_mission_stages")
            && normalized.includes("category = ?")
            && normalized.includes("mission_id IN")) stageReads++
        return originalPrepare(sql)
    }
    let evaluation
    try {
        evaluation = evaluateMissionCandidates(prepared)
    } finally {
        db.prepare = originalPrepare
    }

    assert.equal(progressReads, 1)
    assert.equal(stageReads, 1)
    assert.deepEqual(evaluation.missions.map(mission => ({
        missionId: mission.missionId,
        dbProgress: mission.dbProgress,
        receivedStages: mission.receivedStages,
    })), [
        { missionId: 3410051, dbProgress: 1, receivedStages: [1] },
        { missionId: 3410052, dbProgress: 0, receivedStages: [] },
    ])
})

test("Awake Session loads every used fact kind at most once", () => {
    const playerId = createPlayer("awake-all-facts")
    db.prepare(`
        INSERT INTO players_party_member_co_clears (
            player_id, char_id_a, char_id_b, co_clear_count
        ) VALUES (?, 211001, 231001, 5)
    `).run(playerId)
    const catalog = getMissionCatalog()
    const calls = []
    const session = new MissionEvaluationSession({
        playerId,
        evaluationTime,
        catalog,
        requirementRegistry: getMissionFactRequirementRegistry(catalog),
        candidates: [
            { category: 9, missionId: 1410032 },
            { category: 9, missionId: 1410033 },
            { category: 9, missionId: 2110012 },
            { category: 9, missionId: 2630022 },
            { category: 9, missionId: 3410051 },
            { category: 9, missionId: 3410054 },
        ],
        orchestratorFacts: [{ kind: "player" }],
        loaders: createProductionMissionFactLoaderRegistry(),
        observer: { onLoaderCall(key) { calls.push(key.kind) } },
    })

    const context = AwakeComputer.buildContextFromSession(session, 9, [
        1410032, 1410033, 2110012, 2630022, 3410051, 3410054,
    ])
    assert.equal(AwakeComputer.compute(2110012, context, 0), 5)
    AwakeComputer.buildContextFromSession(session, 9, [2110012])
    assert.deepEqual(Object.fromEntries([
        "player",
        "characters",
        "questProgress",
        "characterClearCounters",
        "partyCoClearCounters",
        "categoryMissionProgress",
    ].map(kind => [kind, calls.filter(call => call === kind).length])), {
        player: 1,
        characters: 1,
        questProgress: 1,
        characterClearCounters: 1,
        partyCoClearCounters: 1,
        categoryMissionProgress: 1,
    })
})

test("persisted Awake families declare their own scoped progress fact", () => {
    const catalog = getMissionCatalog()
    const requirement = getMissionFactRequirementRegistry(catalog)
        .getRequirement(9, 2310012)
    assert.deepEqual(requirement.facts, [{
        kind: "categoryMissionProgress",
        category: 9,
        missionIds: [2310012],
    }])
})

test("full and mission-scoped Awake Session contexts match legacy mission by mission", () => {
    const playerId = createPlayer("awake-full-scoped-equivalence")
    updatePlayerCategoryMissionSync(playerId, 9, 2310012, 2)
    updatePlayerCategoryMissionSync(playerId, 9, 3310032, 1)
    const persisted = getPlayerCategoryMissionsSync(playerId, 9)
    const catalog = getMissionCatalog()
    const registry = getMissionFactRequirementRegistry(catalog)
    const missionIds = catalog.getMissionIds(9)
    const fullLoaderCalls = []
    const fullSession = new MissionEvaluationSession({
        playerId,
        evaluationTime,
        catalog,
        requirementRegistry: registry,
        candidates: missionIds.map(missionId => ({ category: 9, missionId })),
        orchestratorFacts: [{ kind: "player" }],
        loaders: createProductionMissionFactLoaderRegistry(),
        observer: { onLoaderCall(key) { fullLoaderCalls.push(key.kind) } },
    })
    const fullContext = AwakeComputer.buildContextFromSession(fullSession, 9, missionIds)
    const legacyContext = buildAwakeContext(playerId)

    for (const missionId of missionIds) {
        const dbProgress = persisted[missionId]?.progress ?? 0
        const legacyProgress = AwakeComputer.compute(missionId, legacyContext, dbProgress)
        assert.equal(
            AwakeComputer.compute(missionId, fullContext, dbProgress),
            legacyProgress,
            `full mission ${missionId}`,
        )
        const scopedSession = new MissionEvaluationSession({
            playerId,
            evaluationTime,
            catalog,
            requirementRegistry: registry,
            candidates: [{ category: 9, missionId }],
            orchestratorFacts: [{ kind: "player" }],
            loaders: createProductionMissionFactLoaderRegistry(),
        })
        const scopedContext = AwakeComputer.buildContextFromSession(
            scopedSession,
            9,
            [missionId],
        )
        assert.equal(
            AwakeComputer.compute(missionId, scopedContext, dbProgress),
            legacyProgress,
            `scoped mission ${missionId}`,
        )
    }
    for (const kind of new Set(fullLoaderCalls)) {
        assert.equal(
            fullLoaderCalls.filter(call => call === kind).length,
            1,
            `${kind} loader`,
        )
    }
})

test.after(() => {
    if (db.open) db.close()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
})
