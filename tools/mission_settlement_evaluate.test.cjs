"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-evaluate-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

const { initializeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    getPlayerCategoryMissionsSync,
    updatePlayerCategoryMissionStageSync,
    updatePlayerCategoryMissionSync,
} = require("../src/data/domains/mission")
const { insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { getDb } = require("../src/data/db")
const { PassComputer } = require("../src/lib/mission/pass")
const { evaluateMissionCandidates } = require("../src/lib/mission/settlement-evaluate")
const { prepareMissionSettlement } = require("../src/lib/mission/settlement-prepare")

initializeDatabase()
const db = getDb()
const evaluationTime = new Date("2024-08-14T12:00:00.000Z")

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

function persistedState(playerId) {
    return {
        categories: Object.fromEntries([1, 2, 7, 8].map(category => [
            category,
            getPlayerCategoryMissionsSync(playerId, category),
        ])),
        passCards: db.prepare(`
            SELECT event_id, point, is_buy, login_baseline
            FROM players_pass_cards
            WHERE player_id = ?
            ORDER BY event_id
        `).all(playerId),
        snapshots: db.prepare(`
            SELECT period_type, stamina_used, multi_clear_count
            FROM players_periodic_snapshots
            WHERE player_id = ?
            ORDER BY period_type
        `).all(playerId),
    }
}

function assertDeepFrozen(value, seen = new Set()) {
    if (value === null || typeof value !== "object" || seen.has(value)) return
    seen.add(value)
    assert.equal(Object.isFrozen(value), true)
    for (const key of Reflect.ownKeys(value)) assertDeepFrozen(value[key], seen)
}

test("evaluate returns a deeply immutable focused result without writing", () => {
    const playerId = createPlayer("evaluate-result")
    updatePlayerCategoryMissionSync(playerId, 1, 1, 10)
    updatePlayerCategoryMissionStageSync(playerId, 1, 1, 1, true)
    const prepared = db.transaction(() => prepareMissionSettlement(
        playerId,
        [{ category: 1, missionIds: [1, 1] }],
        evaluationTime,
    ))()
    const before = persistedState(playerId)
    const computed = []
    const result = evaluateMissionCandidates(prepared, {
        onMissionComputed(category, missionId) { computed.push([category, missionId]) },
    })

    assert.deepEqual(persistedState(playerId), before)
    assert.deepEqual(computed, [[1, 1]])
    assert.deepEqual(result.missions, [{
        category: 1,
        missionId: 1,
        declaredFactDependencies: [{ kind: "player" }],
        dbProgress: 10,
        computedProgress: 10,
        finalProgress: 10,
        receivedStages: [1],
    }])
    assert.equal(result.player.id, playerId)
    assert.equal(typeof result.player.lastLoginTime, "string")
    assert.equal(result.observer.candidateCount, 1)
    assert.equal(result.observer.computeCount, 1)
    assert.equal(result.observer.loaderCalls.filter(key => key.kind === "player").length, 1)
    assert.equal(Object.isFrozen(result), true)
    assert.equal(Object.isFrozen(result.player), true)
    assert.equal(Object.isFrozen(result.missions), true)
    assert.equal(Object.isFrozen(result.missions[0]), true)
    assert.equal(Object.isFrozen(result.missions[0].receivedStages), true)
    assert.equal(Object.isFrozen(result.observer), true)
    assert.equal(Object.isFrozen(result.observer.loaderCalls), true)
    assert.throws(() => result.missions.push({}), TypeError)
})

test("evaluate records normalized declared fact dependencies for every mission", () => {
    const playerId = createPlayer("evaluate-declared-facts")
    const prepared = db.transaction(() => prepareMissionSettlement(
        playerId,
        [{ category: 5, missionIds: [9000, 8000, 3000] }],
        evaluationTime,
    ))()
    const result = evaluateMissionCandidates(prepared)
    const byMissionId = Object.fromEntries(result.missions.map(mission => [
        mission.missionId,
        mission.declaredFactDependencies,
    ]))

    assert.deepEqual(byMissionId, {
        3000: [{ kind: "characters" }],
        8000: [],
        9000: [{ kind: "questProgress", sections: [1, 4] }],
    })
    assert.ok(result.observer.loaderCalls.some(key => key.kind === "player"))
    assert.deepEqual(byMissionId[8000], [])
    assert.deepEqual(byMissionId[3000], [{ kind: "characters" }])
    for (const mission of result.missions) {
        assertDeepFrozen(mission.declaredFactDependencies)
    }
})

test("evaluate applies daily all-clear in memory without persisting progress", () => {
    const playerId = createPlayer("evaluate-daily")
    updatePlayerSync({ id: playerId, totalDashes: 10, totalStaminaUsed: 50 })
    db.prepare(`
        INSERT INTO players_mission_battle_counters (
            player_id, single_play_count, single_clear_count,
            multi_play_count, multi_clear_count
        ) VALUES (?, 3, 3, 1, 1)
    `).run(playerId)
    const prepared = db.transaction(() => prepareMissionSettlement(
        playerId,
        [{ category: 2, missionIds: [17] }],
        evaluationTime,
    ))()
    const result = evaluateMissionCandidates(prepared)
    const allClear = result.missions.find(mission => mission.category === 2 && mission.missionId === 17)

    assert.equal(allClear.finalProgress, 4)
    assert.equal(getPlayerCategoryMissionsSync(playerId, 2)[17], undefined)
})

test("evaluate migrates Pass 7 and 8 to Session and keeps prepare state read-only", () => {
    const playerId = createPlayer("evaluate-pass")
    updatePlayerSync({ id: playerId, totalStaminaUsed: 40, totalLoginDays: 5 })
    const prepared = db.transaction(() => prepareMissionSettlement(playerId, [
        { category: 7, eventId: 3, missionIds: [9] },
        { category: 8, eventId: 3, missionIds: [13] },
    ], evaluationTime))()
    const before = persistedState(playerId)
    const originalLegacy = PassComputer.buildContext
    const sessionCategories = []
    const originalSession = PassComputer.buildContextFromSession
    PassComputer.buildContext = () => { throw new Error("Pass legacy context must not run") }
    PassComputer.buildContextFromSession = function trackedSession(...args) {
        sessionCategories.push(args[1])
        return originalSession.apply(this, args)
    }
    let result
    try {
        result = evaluateMissionCandidates(prepared)
    } finally {
        PassComputer.buildContext = originalLegacy
        PassComputer.buildContextFromSession = originalSession
    }

    assert.deepEqual(persistedState(playerId), before)
    assert.deepEqual(sessionCategories, [7, 8])
    assert.equal(result.missions.find(mission => mission.category === 7).finalProgress, 0)
    assert.equal(result.missions.find(mission => mission.category === 8).finalProgress, 1)
    assert.equal(result.observer.loaderCalls.filter(key => key.kind === "passState").length, 1)
    assert.equal(result.observer.loaderCalls.filter(key => key.kind === "periodicSnapshot"
        && key.snapshotKind === "passWeek").length, 1)
})

test("evaluate keeps Pass Session contexts scoped to each mission event", () => {
    const playerId = createPlayer("evaluate-pass-event-scope")
    updatePlayerSync({ id: playerId, totalStaminaUsed: 40, totalLoginDays: 5 })
    const prepared = db.transaction(() => prepareMissionSettlement(playerId, [7, 8], evaluationTime))()
    const sessionScopes = []
    const originalSession = PassComputer.buildContextFromSession
    PassComputer.buildContextFromSession = function trackedSession(...args) {
        sessionScopes.push({ category: args[1], missionIds: [...args[2]] })
        return originalSession.apply(this, args)
    }
    try {
        evaluateMissionCandidates(prepared)
    } finally {
        PassComputer.buildContextFromSession = originalSession
    }
    assert.deepEqual(sessionScopes, [
        { category: 7, missionIds: [9, 10, 11, 12] },
        { category: 8, missionIds: [13, 15, 16] },
    ])
})

test.after(() => {
    if (db.open) db.close()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
})
