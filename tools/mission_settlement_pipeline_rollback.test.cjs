"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-pipeline-rollback-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

const { initializeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerCategoryMissionsSync, updatePlayerCategoryMissionSync } = require("../src/data/domains/mission")
const { getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { getDb } = require("../src/data/db")
const { MissionEvaluationSession } = require("../src/lib/mission/evaluation-session")
const { settleMissionCategories } = require("../src/lib/mission/settlement")

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

function passRows(playerId) {
    return db.prepare(`
        SELECT event_id, point, is_buy, login_baseline
        FROM players_pass_cards
        WHERE player_id = ?
        ORDER BY event_id
    `).all(playerId)
}

function snapshotRows(playerId) {
    return db.prepare(`
        SELECT period_type
        FROM players_periodic_snapshots
        WHERE player_id = ? AND period_type LIKE 'pass-week:%'
    `).all(playerId)
}

test("prepare failure rolls back Pass weekly initialization", () => {
    const playerId = createPlayer("rollback-prepare")
    updatePlayerSync({ id: playerId, totalStaminaUsed: 40 })
    db.exec(`
        CREATE TRIGGER reject_pipeline_prepare
        BEFORE INSERT ON players_periodic_snapshots
        WHEN NEW.player_id = ${playerId} AND NEW.period_type LIKE 'pass-week:%'
        BEGIN
            SELECT RAISE(ABORT, 'injected prepare failure');
        END;
    `)
    assert.throws(
        () => settleMissionCategories(
            playerId,
            [{ category: 7, eventId: 3, missionIds: [9] }],
            evaluationTime,
        ),
        /injected prepare failure/,
    )
    assert.deepEqual(snapshotRows(playerId), [])
    assert.deepEqual(getPlayerCategoryMissionsSync(playerId, 7), {})
})

test("evaluate failure rolls back Pass login initialization", () => {
    const playerId = createPlayer("rollback-evaluate")
    updatePlayerSync({ id: playerId, totalLoginDays: 5 })
    const originalGetFact = MissionEvaluationSession.prototype.getFact
    MissionEvaluationSession.prototype.getFact = function rejectEvaluation() {
        throw new Error("injected evaluate failure")
    }
    try {
        assert.throws(
            () => settleMissionCategories(
                playerId,
                [{ category: 8, eventId: 3, missionIds: [13] }],
                evaluationTime,
            ),
            /injected evaluate failure/,
        )
    } finally {
        MissionEvaluationSession.prototype.getFact = originalGetFact
    }
    assert.deepEqual(passRows(playerId), [])
    assert.deepEqual(getPlayerCategoryMissionsSync(playerId, 8), {})
})

test("settle progress failure rolls back Pass prepare progress stage and reward", () => {
    const playerId = createPlayer("rollback-settle")
    updatePlayerSync({ id: playerId, totalLoginDays: 5 })
    db.exec(`
        CREATE TRIGGER reject_pipeline_settle
        BEFORE INSERT ON players_category_missions
        WHEN NEW.player_id = ${playerId} AND NEW.category = 8
        BEGIN
            SELECT RAISE(ABORT, 'injected settle failure');
        END;
    `)
    assert.throws(
        () => settleMissionCategories(
            playerId,
            [{ category: 8, eventId: 3, missionIds: [13] }],
            evaluationTime,
        ),
        /injected settle failure/,
    )
    assert.deepEqual(passRows(playerId), [])
    assert.deepEqual(getPlayerCategoryMissionsSync(playerId, 8), {})
})

test("reward failure rolls Pass prepare progress stages and all rewards back", () => {
    const playerId = createPlayer("rollback-reward")
    const initialVmoney = getPlayerSync(playerId).freeVmoney
    updatePlayerSync({ id: playerId, totalLoginDays: 5 })
    updatePlayerCategoryMissionSync(playerId, 1, 1, 10)
    db.exec(`
        CREATE TRIGGER reject_pipeline_reward
        BEFORE UPDATE ON players
        WHEN NEW.id = ${playerId} AND NEW.free_vmoney > OLD.free_vmoney
        BEGIN
            SELECT RAISE(ABORT, 'injected reward failure');
        END;
    `)
    assert.throws(
        () => settleMissionCategories(playerId, [
            { category: 1, missionIds: [1] },
            { category: 8, eventId: 3, missionIds: [13] },
        ], evaluationTime),
        /injected reward failure/,
    )
    assert.deepEqual(passRows(playerId), [])
    assert.deepEqual(getPlayerCategoryMissionsSync(playerId, 1)[1], {
        progress: 10,
        stages: [],
    })
    assert.deepEqual(getPlayerCategoryMissionsSync(playerId, 8), {})
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
