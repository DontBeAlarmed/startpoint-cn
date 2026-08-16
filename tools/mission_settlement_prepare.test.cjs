"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-prepare-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

const { initializeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const passCardDomain = require("../src/data/domains/pass-card")
const { getPlayerPassCardStateSync } = passCardDomain
const { insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { getDb } = require("../src/data/db")
const snapshotModule = require("../src/lib/mission/snapshot")
const { getPassWeekSnapshotType, getSnapshot, takeSnapshot } = snapshotModule

let ensureCalls = 0
const realEnsure = passCardDomain.ensurePlayerPassCardLoginProgressSync
passCardDomain.ensurePlayerPassCardLoginProgressSync = function trackedEnsure(...args) {
    ensureCalls++
    return realEnsure(...args)
}

const {
    prepareMissionSettlement,
} = require("../src/lib/mission/settlement-prepare")

initializeDatabase()
const db = getDb()
const originalPrepare = db.prepare.bind(db)
let trackedReads = null
db.prepare = statement => {
    if (trackedReads !== null && /^\s*SELECT\b/i.test(String(statement))) {
        const sql = String(statement)
        if (/\bFROM\s+players\s+WHERE\b/i.test(sql)) trackedReads.player++
        if (/\bFROM\s+players_quest_progress\b/i.test(sql)) trackedReads.quest++
        if (/\bFROM\s+players_mission_battle_counters\b/i.test(sql)) trackedReads.counters++
        if (/\bFROM\s+players_periodic_snapshots\b/i.test(sql)) trackedReads.snapshots++
    }
    return originalPrepare(statement)
}
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

function selectedPassWeeks(candidates) {
    return Object.freeze({
        evaluationTime: evaluationTime.toISOString(),
        scopes: Object.freeze([]),
        candidates: Object.freeze(candidates.map(missionId => Object.freeze({
            category: 7,
            missionId,
        }))),
    })
}

function prepareSelectedPassWeeks(playerId, missionIds) {
    trackedReads = { player: 0, quest: 0, counters: 0, snapshots: 0 }
    try {
        db.transaction(() => prepareMissionSettlement(
            playerId,
            [],
            evaluationTime,
            undefined,
            selectedPassWeeks(missionIds),
        ))()
        return { ...trackedReads }
    } finally {
        trackedReads = null
    }
}

test("prepare returns a focused deeply immutable candidate plan with fixed time", () => {
    const playerId = createPlayer("prepare-plan")
    const mutableTime = new Date(evaluationTime)
    const prepared = db.transaction(() => prepareMissionSettlement(playerId, [
        { category: 1, missionIds: [1, 1, 16, 999999999] },
        { category: 1, missionIds: [2] },
    ], mutableTime))()
    mutableTime.setUTCFullYear(2030)

    assert.equal(prepared.playerId, playerId)
    assert.equal(prepared.evaluationTime, "2024-08-14T12:00:00.000Z")
    assert.deepEqual(prepared.scopes, [{
        category: 1,
        candidateCount: 3,
        enabledMissionIds: [1, 2],
    }])
    assert.deepEqual(prepared.candidates, [
        { category: 1, missionId: 1 },
        { category: 1, missionId: 2 },
    ])
    assert.deepEqual(prepared.passPreparation, {
        weeklyEventIds: [],
        loginEventIds: [],
    })
    assert.equal(Object.isFrozen(prepared), true)
    assert.equal(Object.isFrozen(prepared.scopes), true)
    assert.equal(Object.isFrozen(prepared.scopes[0]), true)
    assert.equal(Object.isFrozen(prepared.scopes[0].enabledMissionIds), true)
    assert.equal(Object.isFrozen(prepared.candidates), true)
    assert.equal(Object.isFrozen(prepared.candidates[0]), true)
    assert.equal(Object.isFrozen(prepared.passPreparation), true)
    assert.throws(() => prepared.candidates.push({ category: 1, missionId: 3 }), TypeError)
})

test("prepare returns empty before player or Pass reads", () => {
    assert.doesNotThrow(() => prepareMissionSettlement(
        999999999,
        [{ category: 1, missionIds: [] }, { category: 7, eventId: 3, missionIds: [] }],
        evaluationTime,
    ))
    const prepared = prepareMissionSettlement(
        999999999,
        [{ category: 1, missionIds: [] }],
        evaluationTime,
    )
    assert.deepEqual(prepared.candidates, [])
})

test("prepare deduplicates Pass events and keeps existing weekly and login baselines", () => {
    const playerId = createPlayer("prepare-pass")
    updatePlayerSync({ id: playerId, totalStaminaUsed: 40, totalLoginDays: 5 })
    const existingWeek = snapshot({ staminaUsed: 12, multiClearCount: 2 })
    takeSnapshot(playerId, getPassWeekSnapshotType(3), existingWeek)
    realEnsure(playerId, 3, 3)
    const beforeState = getPlayerPassCardStateSync(playerId, 3)
    ensureCalls = 0

    const prepared = db.transaction(() => prepareMissionSettlement(playerId, [
        { category: 7, eventId: 3, missionIds: [9, 10] },
        { category: 7, eventId: 3, missionIds: [9] },
        { category: 8, eventId: 3, missionIds: [13] },
        { category: 8, eventId: 3, missionIds: [13, 15] },
    ], evaluationTime))()

    assert.deepEqual(prepared.passPreparation, {
        weeklyEventIds: [3],
        loginEventIds: [3],
    })
    assert.equal(ensureCalls, 1)
    assert.deepEqual(getSnapshot(playerId, getPassWeekSnapshotType(3)), existingWeek)
    assert.deepEqual(getPlayerPassCardStateSync(playerId, 3), {
        ...beforeState,
        isBuy: true,
    })
    assert.equal(getPlayerPassCardStateSync(playerId, 3).loginBaseline, 2)
})

test("prepare creates each missing Pass weekly snapshot once", () => {
    const playerId = createPlayer("prepare-pass-new")
    updatePlayerSync({ id: playerId, totalStaminaUsed: 40, totalLoginDays: 5 })
    const prepared = db.transaction(() => prepareMissionSettlement(playerId, [
        { category: 7, eventId: 3, missionIds: [9] },
        { category: 7, eventId: 3, missionIds: [10] },
    ], evaluationTime))()

    assert.deepEqual(prepared.passPreparation.weeklyEventIds, [3])
    assert.equal(getSnapshot(playerId, getPassWeekSnapshotType(3)).staminaUsed, 40)
})

test("Pass weekly cold start shares constant reads across overlapping events", () => {
    const singlePlayerId = createPlayer("prepare-pass-single-cold")
    const overlappingPlayerId = createPlayer("prepare-pass-overlap-cold")

    assert.deepEqual(prepareSelectedPassWeeks(singlePlayerId, [9]), {
        player: 1,
        quest: 1,
        counters: 1,
        snapshots: 1,
    })
    assert.deepEqual(prepareSelectedPassWeeks(overlappingPlayerId, [9, 13]), {
        player: 1,
        quest: 1,
        counters: 1,
        snapshots: 1,
    })
})

test("existing Pass weekly snapshots skip unrelated cold-start facts", () => {
    const playerId = createPlayer("prepare-pass-existing-weeks")
    takeSnapshot(playerId, getPassWeekSnapshotType(3), snapshot({ staminaUsed: 3 }))
    takeSnapshot(playerId, getPassWeekSnapshotType(4), snapshot({ staminaUsed: 4 }))

    assert.deepEqual(prepareSelectedPassWeeks(playerId, [9, 13]), {
        player: 0,
        quest: 0,
        counters: 0,
        snapshots: 1,
    })
})

test("Pass weekly cold start preserves the settlement missing-player error", () => {
    assert.throws(
        () => prepareSelectedPassWeeks(999999999, [9]),
        /Player 999999999 not found during mission settlement\./,
    )
})

test.after(() => {
    passCardDomain.ensurePlayerPassCardLoginProgressSync = realEnsure
    db.prepare = originalPrepare
    if (db.open) db.close()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
})
