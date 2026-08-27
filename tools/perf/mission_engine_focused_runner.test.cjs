"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const {
    SCENARIO_KEYS,
    admitFocusedMissionReport,
    createBehaviorSummary,
    parseArgs,
    runMissionEngineFocusedBaseline,
    writeFocusedMissionSnapshotAtomic,
} = require("./mission_engine_focused_baseline.cjs")
const {
    evaluateFocusedMissionAdmission,
} = require("./mission_engine_focused_admission.cjs")
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

function createAdmissionReport() {
    const behavior = createBehaviorSummary({ result: "stable" })
    return {
        version: 1,
        fixedTime: "2025-01-01T12:00:00.000Z",
        scenarios: {
            focused: {
                sqlReads: 10,
                sqlWrites: 5,
                missionComputes: 20,
                ...behavior,
            },
        },
    }
}

test("focused baseline requires write mode for explicit behavior approval", () => {
    assert.deepEqual(parseArgs([]), { write: false, acceptBehaviorChange: false })
    assert.deepEqual(parseArgs(["--write"]), { write: true, acceptBehaviorChange: false })
    assert.deepEqual(
        parseArgs(["--write", "--accept-behavior-change"]),
        { write: true, acceptBehaviorChange: true },
    )
    assert.throws(
        () => parseArgs(["--accept-behavior-change"]),
        /requires --write/,
    )
})

test("focused snapshot writer replaces atomically and cleans failed temporary files", () => {
    const temporaryParent = fs.mkdtempSync(path.join(os.tmpdir(), "mission-focused-write-"))
    const temporarySnapshot = path.join(temporaryParent, "snapshot.json")
    const temporaryFile = path.join(temporaryParent, ".snapshot.test.tmp")
    const checked = createAdmissionReport()
    const improved = createAdmissionReport()
    improved.scenarios.focused.sqlReads = 9
    const canonicalImproved = evaluateFocusedMissionAdmission(improved, checked).canonicalReport
    const checkedJson = `${JSON.stringify(checked, null, 2)}\n`
    fs.writeFileSync(temporarySnapshot, checkedJson)

    try {
        writeFocusedMissionSnapshotAtomic(canonicalImproved, temporarySnapshot, {
            temporaryPathFactory: () => temporaryFile,
        })
        assert.deepEqual(JSON.parse(fs.readFileSync(temporarySnapshot, "utf8")), improved)
        assert.equal(fs.existsSync(temporaryFile), false)

        for (const failingOperation of ["write", "rename"]) {
            fs.writeFileSync(temporarySnapshot, checkedJson)
            const fileSystem = {
                writeFileSync(...args) {
                    if (failingOperation === "write") {
                        fs.writeFileSync(args[0], "partial", "utf8")
                        throw new Error("injected write failure")
                    }
                    return fs.writeFileSync(...args)
                },
                renameSync(...args) {
                    if (failingOperation === "rename") {
                        throw new Error("injected rename failure")
                    }
                    return fs.renameSync(...args)
                },
                rmSync: (...args) => fs.rmSync(...args),
            }

            assert.throws(
                () => writeFocusedMissionSnapshotAtomic(canonicalImproved, temporarySnapshot, {
                    fileSystem,
                    temporaryPathFactory: () => temporaryFile,
                }),
                new RegExp(`injected ${failingOperation} failure`),
            )
            assert.equal(fs.readFileSync(temporarySnapshot, "utf8"), checkedJson)
            assert.equal(fs.existsSync(temporaryFile), false)
        }
    } finally {
        fs.rmSync(temporaryParent, { recursive: true, force: true })
    }
})

test("focused admission keeps ordinary runs read-only and blocks behavior-changing writes", () => {
    const temporaryParent = fs.mkdtempSync(path.join(os.tmpdir(), "mission-focused-admission-"))
    const temporarySnapshot = path.join(temporaryParent, "snapshot.json")
    const checked = createAdmissionReport()
    const improved = createAdmissionReport()
    improved.scenarios.focused.sqlReads = 9
    const checkedJson = `${JSON.stringify(checked, null, 2)}\n`
    fs.writeFileSync(temporarySnapshot, checkedJson)

    try {
        const readOnly = admitFocusedMissionReport(improved, {
            snapshotPath: temporarySnapshot,
            write: false,
        })
        assert.equal(readOnly.admitted, true)
        assert.equal(fs.readFileSync(temporarySnapshot, "utf8"), checkedJson)

        const written = admitFocusedMissionReport(improved, {
            snapshotPath: temporarySnapshot,
            write: true,
        })
        assert.equal(written.admitted, true)
        assert.deepEqual(JSON.parse(fs.readFileSync(temporarySnapshot, "utf8")), improved)

        fs.writeFileSync(temporarySnapshot, checkedJson)
        const changed = createAdmissionReport()
        Object.assign(
            changed.scenarios.focused,
            createBehaviorSummary({ result: "changed" }),
        )
        const rejected = admitFocusedMissionReport(changed, {
            snapshotPath: temporarySnapshot,
            write: true,
        })
        assert.equal(rejected.admitted, false)
        assert.equal(fs.readFileSync(temporarySnapshot, "utf8"), checkedJson)

        const accepted = admitFocusedMissionReport(changed, {
            snapshotPath: temporarySnapshot,
            write: true,
            acceptBehaviorChange: true,
        })
        assert.equal(accepted.admitted, true)
        assert.deepEqual(
            JSON.parse(fs.readFileSync(temporarySnapshot, "utf8")),
            changed,
        )

        fs.writeFileSync(temporarySnapshot, checkedJson)
        changed.scenarios.focused.sqlReads++
        const structuralRegression = admitFocusedMissionReport(changed, {
            snapshotPath: temporarySnapshot,
            write: true,
            acceptBehaviorChange: true,
        })
        assert.equal(structuralRegression.admitted, false)
        assert.equal(fs.readFileSync(temporarySnapshot, "utf8"), checkedJson)
    } finally {
        fs.rmSync(temporaryParent, { recursive: true, force: true })
    }
})

test("focused admission writes its validated canonical behavior", () => {
    const temporaryParent = fs.mkdtempSync(path.join(os.tmpdir(), "mission-focused-canonical-"))
    const temporarySnapshot = path.join(temporaryParent, "snapshot.json")
    const checked = createAdmissionReport()
    Object.assign(checked.scenarios.focused, createBehaviorSummary({ a: 1, z: 2 }))
    const current = structuredClone(checked)
    current.scenarios.focused.behavior = { z: 2, a: 1 }
    fs.writeFileSync(temporarySnapshot, `${JSON.stringify(checked, null, 2)}\n`)

    try {
        const admission = admitFocusedMissionReport(current, {
            snapshotPath: temporarySnapshot,
            write: true,
        })
        const written = JSON.parse(fs.readFileSync(temporarySnapshot, "utf8"))

        assert.equal(admission.admitted, true)
        assert.deepEqual(Object.keys(written.scenarios.focused.behavior), ["a", "z"])
        assert.deepEqual(written.scenarios.focused.behavior, checked.scenarios.focused.behavior)
    } finally {
        fs.rmSync(temporaryParent, { recursive: true, force: true })
    }
})

test("focused admission never overwrites a snapshot with invalid behavior", () => {
    const temporaryParent = fs.mkdtempSync(path.join(os.tmpdir(), "mission-focused-invalid-"))
    const temporarySnapshot = path.join(temporaryParent, "snapshot.json")
    const checked = createAdmissionReport()
    const checkedJson = `${JSON.stringify(checked, null, 2)}\n`
    fs.writeFileSync(temporarySnapshot, checkedJson)
    const current = createAdmissionReport()
    current.scenarios.focused.behavior.self = current.scenarios.focused.behavior

    try {
        let admission
        assert.doesNotThrow(() => {
            admission = admitFocusedMissionReport(current, {
                snapshotPath: temporarySnapshot,
                write: true,
            })
        })
        assert.equal(admission.admitted, false)
        assert.equal(fs.readFileSync(temporarySnapshot, "utf8"), checkedJson)

        const dateReport = createAdmissionReport()
        dateReport.scenarios.focused.behavior = new Date("2025-01-01T12:00:00.000Z")
        assert.throws(
            () => writeFocusedMissionSnapshotAtomic(dateReport, temporarySnapshot),
            /validated canonical focused report/,
        )
        assert.equal(fs.readFileSync(temporarySnapshot, "utf8"), checkedJson)
    } finally {
        fs.rmSync(temporaryParent, { recursive: true, force: true })
    }
})

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
    assert.equal(snapshot.scenarios["single-battle-finish"].sqlReads, 31)
    assert.equal(snapshot.scenarios["multi-battle-finish"].sqlReads, 32)
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
