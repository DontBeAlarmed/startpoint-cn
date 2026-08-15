"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-periodic-session-db-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

const { initializeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerCategoryMissionsSync } = require("../src/data/domains/mission")
const {
    getMissionBattleCountersSync,
    recordMissionBattleResultSync,
} = require("../src/data/domains/mission_battle_facts")
const playerDomain = require("../src/data/domains/player")
const realGetPlayerSync = playerDomain.getPlayerSync
let observedPlayerReads = null
playerDomain.getPlayerSync = function observedGetPlayerSync(playerId) {
    if (observedPlayerReads !== null) observedPlayerReads++
    return realGetPlayerSync(playerId)
}
const { getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } = playerDomain
const { getDb } = require("../src/data/db")
const {
    MissionEvaluationSession,
    MissionFactLoaderRegistry,
    createProductionMissionFactLoaderRegistry,
    getMissionCatalog,
    getMissionFactRequirementRegistry,
} = require("../src/lib/mission")
const { RegularComputer } = require("../src/lib/mission/computer-regular")
const { PassComputer } = require("../src/lib/mission/pass")
const { settleMissionCategories } = require("../src/lib/mission/settlement")
const { takeSnapshot } = require("../src/lib/mission/snapshot")

initializeDatabase()
const db = getDb()
const evaluationTime = new Date("2024-08-14T12:00:00.000Z")
const catalog = getMissionCatalog()
const requirementRegistry = getMissionFactRequirementRegistry(catalog)

function cleanup() {
    if (db.open) db.close()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
}

test.after(cleanup)

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

function seedPeriodicCounters(playerId) {
    updatePlayerSync({
        id: playerId,
        totalDashes: 12,
        totalStaminaUsed: 80,
        totalLoginDays: 5,
    })
    for (let index = 0; index < 5; index++) {
        recordMissionBattleResultSync(playerId, { isMulti: false, accomplished: true })
    }
    for (let index = 0; index < 3; index++) {
        recordMissionBattleResultSync(playerId, { isMulti: true, accomplished: true })
    }
}

function snapshot(overrides = {}) {
    return {
        questClears: 0,
        staminaUsed: 0,
        rankSs: 0,
        rankS: 0,
        rankA: 0,
        rankB: 0,
        singlePlayCount: 0,
        singleClearCount: 0,
        multiPlayCount: 0,
        multiClearCount: 0,
        multiHostClearCount: 0,
        multiGuestClearCount: 0,
        dashCount: 0,
        powerFlipCount: 0,
        loginDays: 0,
        ...overrides,
    }
}

function createProductionSession(playerId, candidates) {
    return new MissionEvaluationSession({
        playerId,
        evaluationTime,
        catalog,
        requirementRegistry,
        candidates,
        orchestratorFacts: [{ kind: "player" }],
        loaders: createProductionMissionFactLoaderRegistry(),
    })
}

function assertComputerEquivalent(playerId, computer, category) {
    const missionIds = catalog.getMissionIds(category)
    const legacyContext = computer.buildContext(playerId, category, evaluationTime, missionIds)
    const session = createProductionSession(
        playerId,
        missionIds.map(missionId => ({ category, missionId })),
    )
    const sessionContext = computer.buildContextFromSession(session, category, missionIds)

    assert.deepEqual(sessionContext.questProgress, {}, `category ${category} must not load quest progress`)
    for (const missionId of missionIds) {
        for (const dbProgress of [0, 2]) {
            assert.equal(
                computer.compute(missionId, sessionContext, dbProgress),
                computer.compute(missionId, legacyContext, dbProgress),
                `category ${category} mission ${missionId} dbProgress ${dbProgress}`,
            )
        }
    }
}

test("legacy and Session contexts compute every category 2/10/6 mission equivalently", () => {
    const playerId = createPlayer("mission-periodic-equivalence")
    seedPeriodicCounters(playerId)

    db.prepare("DELETE FROM players_periodic_snapshots WHERE player_id = ?").run(playerId)
    assertComputerEquivalent(playerId, RegularComputer, 2)
    assertComputerEquivalent(playerId, RegularComputer, 10)
    assertComputerEquivalent(playerId, PassComputer, 6)

    takeSnapshot(playerId, "daily", snapshot({
        staminaUsed: 20,
        singleClearCount: 1,
        multiClearCount: 1,
        dashCount: 3,
    }))
    takeSnapshot(playerId, "weekly", snapshot({ loginDays: 2, multiClearCount: 1 }))
    assertComputerEquivalent(playerId, RegularComputer, 2)
    assertComputerEquivalent(playerId, RegularComputer, 10)
    assertComputerEquivalent(playerId, PassComputer, 6)
})

test("category 2 and 6 share daily facts while category 10 loads weekly once", () => {
    const playerId = createPlayer("mission-periodic-loader-sharing")
    const calls = { player: 0, battle: 0, daily: 0, weekly: 0, quest: 0 }
    const loaders = new MissionFactLoaderRegistry()
        .register("player", () => {
            calls.player++
            return getPlayerSync(playerId)
        })
        .register("missionBattleCounters", () => {
            calls.battle++
            return getMissionBattleCountersSync(playerId)
        })
        .register("periodicSnapshot", ({ key }) => {
            calls[key.snapshotKind]++
            return snapshot()
        })
        .register("questProgress", () => {
            calls.quest++
            return {}
        })
    const candidates = [
        { category: 2, missionId: 11 },
        { category: 2, missionId: 14 },
        { category: 6, missionId: 9 },
        { category: 6, missionId: 10 },
        { category: 10, missionId: 1 },
        { category: 10, missionId: 2 },
    ]
    const session = new MissionEvaluationSession({
        playerId,
        evaluationTime,
        catalog,
        requirementRegistry,
        candidates,
        orchestratorFacts: [{ kind: "player" }],
        loaders,
    })

    RegularComputer.buildContextFromSession(session, 2, [11, 14])
    PassComputer.buildContextFromSession(session, 6, [9, 10])
    RegularComputer.buildContextFromSession(session, 10, [1, 2])

    assert.deepEqual(calls, { player: 1, battle: 1, daily: 1, weekly: 1, quest: 0 })
})

test("persisted and unsupported candidates load only the orchestrator player fact", () => {
    const playerId = createPlayer("mission-periodic-noncomputed")
    const calls = { player: 0, battle: 0, snapshot: 0, quest: 0 }
    const loaders = new MissionFactLoaderRegistry()
        .register("player", () => {
            calls.player++
            return getPlayerSync(playerId)
        })
        .register("missionBattleCounters", () => {
            calls.battle++
            return getMissionBattleCountersSync(playerId)
        })
        .register("periodicSnapshot", () => {
            calls.snapshot++
            return snapshot()
        })
        .register("questProgress", () => {
            calls.quest++
            return {}
        })
    const missionIds = [2, 10075]
    const session = new MissionEvaluationSession({
        playerId,
        evaluationTime,
        catalog,
        requirementRegistry,
        candidates: missionIds.map(missionId => ({ category: 2, missionId })),
        orchestratorFacts: [{ kind: "player" }],
        loaders,
    })

    const context = RegularComputer.buildContextFromSession(session, 2, missionIds)
    assert.equal(RegularComputer.compute(2, context, 7), 7)
    assert.equal(RegularComputer.compute(10075, context, 9), 9)
    assert.deepEqual(calls, { player: 1, battle: 0, snapshot: 0, quest: 0 })
})

test("Session context builders reject categories outside their migrated boundaries", () => {
    const playerId = createPlayer("mission-periodic-boundary")
    const session = createProductionSession(playerId, [{ category: 1, missionId: 1 }])

    assert.doesNotThrow(() => RegularComputer.buildContextFromSession(session, 1, [1]))
    assert.throws(
        () => RegularComputer.buildContextFromSession(session, 3, [1]),
        /only supports categories 1, 2 and 10/i,
    )
    assert.throws(
        () => PassComputer.buildContextFromSession(session, 7, [1]),
        /only supports category 6/i,
    )
})

test("settlement shares production facts and keeps daily all-clear semantics", () => {
    const playerId = createPlayer("mission-periodic-settlement")
    seedPeriodicCounters(playerId)
    takeSnapshot(playerId, "daily", snapshot())
    const loads = []

    settleMissionCategories(
        playerId,
        [2, { category: 6, eventId: 3, missionIds: [9, 10, 11, 12] }],
        evaluationTime,
        { onMissionFactLoaderCall(key) { loads.push(key) } },
    )

    assert.equal(loads.filter(key => key.kind === "player").length, 1)
    assert.equal(loads.filter(key => key.kind === "missionBattleCounters").length, 1)
    assert.equal(loads.filter(key => key.kind === "periodicSnapshot"
        && key.snapshotKind === "daily").length, 1)
    assert.equal(loads.filter(key => key.kind === "questProgress").length, 0)
    assert.equal(getPlayerCategoryMissionsSync(playerId, 2)[17].progress, 4)
})

test("missing-player settlement preserves its boundary error with one player read", () => {
    const missingPlayerId = 999_999_999
    observedPlayerReads = 0
    try {
        assert.throws(
            () => settleMissionCategories(missingPlayerId, [10], evaluationTime),
            new Error(`Player ${missingPlayerId} not found during mission settlement.`),
        )
        assert.equal(observedPlayerReads, 1)
    } finally {
        observedPlayerReads = null
    }
})
