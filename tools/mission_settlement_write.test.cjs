"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-write-"))
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
const { getPlayerSync, insertDefaultPlayerSync } = require("../src/data/domains/player")
const { getDb } = require("../src/data/db")
const { evaluateMissionCandidates } = require("../src/lib/mission/settlement-evaluate")
const { prepareMissionSettlement } = require("../src/lib/mission/settlement-prepare")
const {
    settleMissionEvaluation,
    settleMissionEvaluationWithInvalidations,
} = require("../src/lib/mission/settlement-write")

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

function evaluate(playerId, scopes) {
    const prepared = prepareMissionSettlement(playerId, scopes, evaluationTime)
    return evaluateMissionCandidates(prepared)
}

test("settle writes progress and first stages from EvaluationResult with compatible response", () => {
    const playerId = createPlayer("write-first")
    const initialVmoney = getPlayerSync(playerId).freeVmoney
    updatePlayerCategoryMissionSync(playerId, 1, 1, 30)
    const result = db.transaction(() => settleMissionEvaluation(evaluate(playerId, [1])))()

    assert.deepEqual(result, {
        missionInfo: [
            { mission_category_id: 1, mission_id: 1, mission_reward_id: 1001 },
            { mission_category_id: 1, mission_id: 1, mission_reward_id: 1002 },
            { mission_category_id: 1, mission_id: 1, mission_reward_id: 1003 },
        ],
        itemList: {},
        characterList: [],
        equipmentList: [],
        degreeIds: [],
        passCardPoints: {},
        userInfo: {
            free_vmoney: initialVmoney + 15,
            free_mana: 2000,
            exp_pool: 0,
        },
    })
    assert.deepEqual(getPlayerCategoryMissionsSync(playerId, 1)[1], {
        progress: 30,
        stages: { 1: true, 2: true, 3: true },
    })

    const repeated = db.transaction(() => settleMissionEvaluation(evaluate(playerId, [1])))()
    assert.deepEqual(repeated, {
        missionInfo: [],
        itemList: {},
        characterList: [],
        equipmentList: [],
        degreeIds: [],
        passCardPoints: {},
    })
    assert.equal(getPlayerSync(playerId).freeVmoney, initialVmoney + 15)
})

test("settle skips unchanged progress writes", () => {
    const playerId = createPlayer("write-unchanged")
    updatePlayerCategoryMissionSync(playerId, 1, 1, 7)
    const evaluation = evaluate(playerId, [{ category: 1, missionIds: [1] }])
    assert.equal(evaluation.missions[0].finalProgress, 7)
    db.exec(`
        CREATE TRIGGER reject_unchanged_progress_write
        BEFORE INSERT ON players_category_missions
        WHEN NEW.player_id = ${playerId}
        BEGIN
            SELECT RAISE(ABORT, 'unchanged progress write');
        END;
    `)
    assert.doesNotThrow(() => db.transaction(() => settleMissionEvaluation(evaluation))())
})

test("repeated settlement has no reward invalidation after the first grant", () => {
    const playerId = createPlayer("write-invalidation-repeat")
    updatePlayerCategoryMissionSync(playerId, 1, 1, 10)

    const first = db.transaction(() => settleMissionEvaluationWithInvalidations(evaluate(playerId, [1])))()
    assert.equal(first.invalidatedFactKeys.some(key => key.kind === "player"), true)

    const repeated = db.transaction(() => settleMissionEvaluationWithInvalidations(evaluate(playerId, [1])))()
    assert.deepEqual(repeated.invalidatedFactKeys, [])
    assert.deepEqual(repeated.settlement.missionInfo, [])
})

test("reward persistence failure rolls progress stages and reward back together", () => {
    const playerId = createPlayer("write-rollback")
    const initialVmoney = getPlayerSync(playerId).freeVmoney
    updatePlayerCategoryMissionSync(playerId, 1, 1, 10)
    const evaluation = evaluate(playerId, [{ category: 1, missionIds: [1] }])
    db.exec(`
        CREATE TRIGGER reject_mission_reward_player_write
        BEFORE UPDATE ON players
        WHEN NEW.id = ${playerId}
        BEGIN
            SELECT RAISE(ABORT, 'injected reward persistence failure');
        END;
    `)
    assert.throws(
        () => db.transaction(() => settleMissionEvaluation(evaluation))(),
        /injected reward persistence failure/,
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
