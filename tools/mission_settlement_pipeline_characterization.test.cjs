"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-pipeline-base-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

const { initializeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    getPlayerCategoryMissionsSync,
    updatePlayerCategoryMissionSync,
} = require("../src/data/domains/mission")
const {
    getPlayerSync,
    insertDefaultPlayerSync,
    updatePlayerSync,
} = require("../src/data/domains/player")
const { getDb } = require("../src/data/db")
const { settleMissionCategories } = require("../src/lib/mission/settlement")
const baseEvidence = require("./fixtures/mission-settlement-pipeline-base.json")

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

test("BASE freezes complete first repeated and empty settlement behavior", () => {
    const playerId = createPlayer("pipeline-response")
    const initialVmoney = getPlayerSync(playerId).freeVmoney
    updatePlayerCategoryMissionSync(playerId, 1, 1, 30)

    assert.deepEqual(
        settleMissionCategories(playerId, [1], evaluationTime),
        baseEvidence.settlement.firstResponse,
    )
    assert.deepEqual(
        getPlayerCategoryMissionsSync(playerId, 1)[1],
        baseEvidence.settlement.firstPersisted,
    )
    assert.deepEqual(
        settleMissionCategories(playerId, [1], evaluationTime),
        baseEvidence.settlement.repeatedResponse,
    )
    assert.equal(getPlayerSync(playerId).freeVmoney, initialVmoney + 15)

    const emptyPlayerId = createPlayer("pipeline-empty")
    assert.deepEqual(
        settleMissionCategories(emptyPlayerId, [{ category: 1, missionIds: [] }], evaluationTime),
        baseEvidence.settlement.emptyResponse,
    )
})

test("BASE freezes daily all-clear and event scope behavior", () => {
    const dailyPlayerId = createPlayer("pipeline-daily")
    updatePlayerSync({ id: dailyPlayerId, totalDashes: 10, totalStaminaUsed: 50 })
    db.prepare(`
        INSERT INTO players_mission_battle_counters (
            player_id, single_play_count, single_clear_count,
            multi_play_count, multi_clear_count
        ) VALUES (?, 3, 3, 1, 1)
    `).run(dailyPlayerId)
    settleMissionCategories(dailyPlayerId, [{ category: 2, missionIds: [17] }], evaluationTime)
    assert.equal(
        getPlayerCategoryMissionsSync(dailyPlayerId, 2)[17].progress,
        baseEvidence.dailyAllClear.persisted.progress,
    )

    const eventPlayerId = createPlayer("pipeline-event")
    db.prepare("INSERT INTO players_items (id, amount, player_id) VALUES (80001, 50, ?)")
        .run(eventPlayerId)
    assert.deepEqual(settleMissionCategories(
        eventPlayerId,
        [{ category: 4, eventId: 2 }],
        new Date("2020-02-21T04:00:00.000Z"),
    ), baseEvidence.eventScope.response)
    assert.deepEqual(getPlayerCategoryMissionsSync(eventPlayerId, 4), baseEvidence.eventScope.persisted)
})

test("BASE fixture independently records the pre-pipeline Pass boundary", () => {
    assert.equal(baseEvidence.runtimeCommit, "f85a01c1eb730afa3ff9e6de00fd7b7a9d992c32")
    assert.deepEqual(baseEvidence.passLegacyBoundary, {
        legacyCategories: [7, 8],
        sessionCategories: [],
        weeklySnapshotCreated: true,
    })
    assert.deepEqual(baseEvidence.passReward.firstResponse.passCardPoints, { 3: 100 })
})

test("BASE freezes progress stage reward rollback", () => {
    const playerId = createPlayer("pipeline-rollback")
    const initialVmoney = getPlayerSync(playerId).freeVmoney
    updatePlayerCategoryMissionSync(playerId, 1, 1, 10)
    db.exec(`
        CREATE TRIGGER fail_pipeline_stage
        AFTER INSERT ON players_category_mission_stages
        WHEN NEW.player_id = ${playerId}
        BEGIN
            SELECT RAISE(ABORT, 'injected pipeline stage failure');
        END;
    `)
    assert.throws(
        () => settleMissionCategories(playerId, [1], evaluationTime),
        /injected pipeline stage failure/,
    )
    assert.deepEqual(getPlayerCategoryMissionsSync(playerId, 1)[1], {
        progress: 10,
        stages: [],
    })
    assert.equal(getPlayerSync(playerId).freeVmoney, initialVmoney)
})

test.after(() => {
    if (db.open) db.close()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
})
