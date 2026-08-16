"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const {
    SCENARIO_KEYS,
    createBehaviorSummary,
    runMissionEngineFocusedBaseline,
} = require("./mission_engine_focused_baseline.cjs")
const { createFocusedScenarios } = require("./mission_engine_focused_scenarios.cjs")

const snapshotPath = path.join(
    __dirname,
    "__snapshots__",
    "mission_engine_focused_baseline.json",
)

function emptySettlement() {
    return {
        missionInfo: [],
        itemList: {},
        characterList: [],
        equipmentList: [],
        degreeIds: [],
    }
}

test("scenario summaries run after SQL and compute metrics are frozen", async () => {
    const temporaryParent = fs.mkdtempSync(path.join(os.tmpdir(), "mission-focused-summary-"))
    const computer = { compute: () => 7 }
    let database
    const runtime = {
        closeDatabase() {
            if (database?.open) database.close()
        },
        createFocusedScenarios() {
            return SCENARIO_KEYS.map((name, index) => ({
                name,
                prepare: () => 41,
                execute: () => ({ name }),
                ...(index === 0 ? {
                    summarize(outcome, playerId, evaluationTime) {
                        const selected = database.prepare("SELECT 7 AS value").pluck().get()
                        computer.compute()
                        return {
                            ...outcome,
                            selected,
                            playerId,
                            evaluationTime: evaluationTime.toISOString(),
                        }
                    },
                } : {}),
            }))
        },
        getComputer: () => computer,
        getDatabaseStatus: () => ({ open: false, ready: false, schema: null }),
        getTimeOffset: () => 0,
        initializeDatabase({ databaseFactory }) {
            database = databaseFactory(":memory:")
            return database
        },
        installBundledGameplaySnapshot: () => () => {},
        resolveRuntimeDataPaths: () => ({}),
        setServerTimeOffset() {},
    }

    try {
        const report = await runMissionEngineFocusedBaseline({
            runtimeLoader: () => runtime,
            temporaryParent,
        })
        const result = report.scenarios[SCENARIO_KEYS[0]]
        assert.equal(result.behavior.selected, 7)
        assert.equal(result.behavior.playerId, 41)
        assert.equal(result.sqlReads, 0)
        assert.equal(result.missionComputes, 0)
    } finally {
        fs.rmSync(temporaryParent, { recursive: true, force: true })
    }
})

test("finish SQL metrics exclude post-settlement behavior reads", () => {
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"))
    assert.equal(snapshot.scenarios["single-battle-finish"].sqlReads, 58)
    assert.equal(snapshot.scenarios["multi-battle-finish"].sqlReads, 59)
})

test("finish summaries cover only computed standard refs and enabled Awake refs", () => {
    const progress = {
        1: {
            101: { progress: 3 },
            102: { progress: 30 },
        },
        9: {
            901: { progress: 4 },
            902: { progress: 40 },
        },
    }
    const stages = new Map([
        ["1:101", 1],
        ["1:102", 2],
        ["9:901", 3],
        ["9:902", 4],
    ])
    let settledAwakeIds
    const runtime = {
        buildBattleMissionSettlementScopes: () => [{ category: 1 }],
        getAwakeBattleMissionIds: () => [901, 902],
        getCurrentStage: (category, missionId) => stages.get(`${category}:${missionId}`),
        getMissionIdsByCategory() {
            throw new Error("finish summary must not expand category definitions")
        },
        getPlayerCategoryMissionsSync: (_playerId, category) => progress[category],
        getPlayerSync: () => ({ id: 77 }),
        isMissionEnabledAt: (_category, missionId) => missionId === 901,
        recordMissionBattleFacts: () => ({ awakeMissionIds: [902] }),
        settleAwakeMissionCandidates(_playerId, missionIds) {
            settledAwakeIds = [...missionIds]
            return emptySettlement()
        },
        settleMissionCategories(_playerId, _scopes, _time, observer) {
            observer?.onMissionComputed?.(1, 101)
            return emptySettlement()
        },
    }
    const scenario = createFocusedScenarios(runtime)
        .find(candidate => candidate.name === "single-battle-finish")
    const evaluationTime = new Date("2025-01-01T12:00:00.000Z")

    const outcome = scenario.execute(77, evaluationTime)
    assert.deepEqual(outcome.standardMissionRefs, [[1, 101]])
    assert.deepEqual(outcome.awakeCandidateIds, [901])
    assert.deepEqual(settledAwakeIds, [901])

    const initial = scenario.summarize(outcome, 77, evaluationTime)
    assert.equal(initial.standard.missionProgressCount, 1)
    assert.equal(initial.awake.missionProgressCount, 1)

    progress[1][102].progress++
    progress[9][902].progress++
    stages.set("1:102", 8)
    stages.set("9:902", 9)
    const unrelatedChanged = scenario.summarize(outcome, 77, evaluationTime)
    assert.equal(
        createBehaviorSummary(unrelatedChanged).behaviorSha256,
        createBehaviorSummary(initial).behaviorSha256,
    )

    progress[1][101].progress++
    const progressChanged = scenario.summarize(outcome, 77, evaluationTime)
    assert.notEqual(
        createBehaviorSummary(progressChanged).behaviorSha256,
        createBehaviorSummary(initial).behaviorSha256,
    )

    stages.set("9:901", 10)
    const stageChanged = scenario.summarize(outcome, 77, evaluationTime)
    assert.notEqual(
        createBehaviorSummary(stageChanged).behaviorSha256,
        createBehaviorSummary(progressChanged).behaviorSha256,
    )
})
