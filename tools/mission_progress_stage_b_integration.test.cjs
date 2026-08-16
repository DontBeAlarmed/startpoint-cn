"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-stage-b-real-"))
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
const { getPassWeekSnapshotType } = require("../src/lib/mission/snapshot")
const { getMissionFactRequirementRegistry } = require("../src/lib/mission/requirements/registry")
const settlementEvaluate = require("../src/lib/mission/settlement-evaluate")
const { evaluateMissionProgressStageB } = require("../src/lib/mission/progress-stage-b")

initializeDatabase()
const db = getDb()
const evaluationTime = new Date("2024-08-14T12:00:00.000Z")
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `mission-stage-b-real-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id

function mission(category, missionId, dbProgress = 0) {
    const requirement = getMissionFactRequirementRegistry().getRequirement(category, missionId)
    return {
        category,
        missionId,
        declaredFactDependencies: requirement.facts,
        dbProgress,
        computedProgress: dbProgress,
        finalProgress: dbProgress,
        receivedStages: [],
    }
}

function persistedState() {
    return {
        mission1: getPlayerCategoryMissionsSync(playerId, 1),
        mission7: getPlayerCategoryMissionsSync(playerId, 7),
        mission8: getPlayerCategoryMissionsSync(playerId, 8),
        passCards: db.prepare(`
            SELECT *
            FROM players_pass_cards
            WHERE player_id = ?
            ORDER BY event_id
        `).all(playerId),
        snapshots: db.prepare(`
            SELECT *
            FROM players_periodic_snapshots
            WHERE player_id = ?
            ORDER BY period_type
        `).all(playerId),
        player: getPlayerSync(playerId),
    }
}

test("real Stage B uses a read-only Session for Pass and standard candidates", () => {
    updatePlayerCategoryMissionSync(playerId, 1, 1, 10)
    db.prepare(`
        INSERT INTO players_pass_cards (player_id, event_id, point, is_buy, login_baseline)
        VALUES (?, ?, ?, ?, ?)
    `).run(playerId, 3, 200, 1, 17)
    db.prepare(`
        INSERT INTO players_periodic_snapshots (
            player_id, period_type, quest_clears, stamina_used,
            rank_ss, rank_s, rank_a, rank_b,
            single_play_count, single_clear_count,
            multi_play_count, multi_clear_count,
            multi_host_clear_count, multi_guest_clear_count,
            dash_count, power_flip_count, login_days, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        playerId, getPassWeekSnapshotType(3),
        11, 12, 13, 14, 15, 16, 17, 18, 19,
        20, 21, 22, 23, 24, 25,
        "2024-08-14T11:22:33.000Z",
    )

    const stageA = {
        prepared: {
            playerId,
            evaluationTime: evaluationTime.toISOString(),
            scopes: [
                { category: 1, candidateCount: 1, enabledMissionIds: [1] },
                { category: 7, eventId: 3, candidateCount: 1, enabledMissionIds: [9] },
                { category: 8, eventId: 3, candidateCount: 1, enabledMissionIds: [13] },
            ],
            candidates: [
                { category: 1, missionId: 1 },
                { category: 7, missionId: 9 },
                { category: 8, missionId: 13 },
            ],
            passPreparation: { weeklyEventIds: [], loginEventIds: [] },
        },
        evaluation: {
            playerId,
            evaluationTime: evaluationTime.toISOString(),
            player: getPlayerSync(playerId),
            missions: [mission(1, 1, 10), mission(7, 9), mission(8, 13)],
            observer: { candidateCount: 3, computeCount: 3, loaderCalls: [] },
        },
        settlement: {
            missionInfo: [], itemList: {}, characterList: [], equipmentList: [], degreeIds: [], passCardPoints: {},
        },
        invalidatedFactKeys: [
            { kind: "player" },
            { kind: "periodicSnapshot", snapshotKind: "passWeek", eventId: 3 },
            { kind: "passState", eventId: 3 },
        ],
    }
    const before = persistedState()
    const result = evaluateMissionProgressStageB(stageA)

    assert.deepEqual(result.missions.map(entry => [entry.category, entry.missionId]), [
        [1, 1],
        [7, 9],
        [8, 13],
    ])
    assert.equal(result.observer.computeCount, 3)
    assert.deepEqual(persistedState(), before)
})

test("empty invalidation and no-hit invalidation do not construct a Session", () => {
    const originalEvaluate = settlementEvaluate.evaluateMissionCandidates
    let evaluationCalls = 0
    settlementEvaluate.evaluateMissionCandidates = () => {
        evaluationCalls++
        throw new Error("Stage B Session should not be constructed")
    }
    const stageA = {
        prepared: {},
        evaluation: {
            missions: [mission(1, 1)],
        },
        settlement: {},
        invalidatedFactKeys: [],
    }
    try {
        assert.equal(evaluateMissionProgressStageB(stageA), null)
        assert.equal(evaluateMissionProgressStageB({
            ...stageA,
            invalidatedFactKeys: [{ kind: "equipment" }],
        }), null)
    } finally {
        settlementEvaluate.evaluateMissionCandidates = originalEvaluate
    }
    assert.equal(evaluationCalls, 0)
})

test.after(() => {
    if (db.open) db.close()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
})
