"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const EXPECTED_SCENARIO_KEYS = [
    "degree-routing-fallback",
    "degree-focused",
    "degree-behavior-characterization",
    "event-routing-fallback",
    "event-focused",
    "event-behavior-characterization",
    "awake-character-page",
    "get-progress-no-invalidation",
    "get-progress-item-invalidation",
    "get-progress-character-invalidation",
    "get-progress-equipment-invalidation",
    "single-battle-finish",
    "multi-battle-finish",
]
const APPROVED_SETTLEMENT_SHA256 =
    "76b36e0b20002644562a553913ba2e17ab0a5006292e3dc7fba144e169716337"
const snapshotPath = path.join(
    __dirname,
    "__snapshots__",
    "mission_engine_focused_baseline.json",
)
const legacyDegreeFixture = require("../fixtures/mission-degree/legacy-f8be414.json")

function readSnapshot() {
    assert.equal(
        fs.existsSync(snapshotPath),
        true,
        "focused mission engine snapshot must exist and cover all 13 scenarios",
    )
    return JSON.parse(fs.readFileSync(snapshotPath, "utf8"))
}

function assertScenarioShape(name, scenario) {
    assert.equal(Number.isInteger(scenario.sqlReads), true, `${name} sqlReads must be an integer`)
    assert.equal(Number.isInteger(scenario.sqlWrites), true, `${name} sqlWrites must be an integer`)
    assert.equal(
        Number.isInteger(scenario.missionComputes),
        true,
        `${name} missionComputes must be an integer`,
    )
    assert.equal(scenario.sqlReads >= 0, true)
    assert.equal(scenario.sqlWrites >= 0, true)
    assert.equal(scenario.missionComputes >= 0, true)
    assert.equal(
        scenario.behavior !== null
            && typeof scenario.behavior === "object"
            && !Array.isArray(scenario.behavior),
        true,
        `${name} behavior must be a comparable object`,
    )
    assert.match(scenario.behaviorSha256, /^[a-f0-9]{64}$/)
}

test("snapshot covers the focused mission engine scenario set and metric shape", () => {
    const snapshot = readSnapshot()
    assert.deepEqual(Object.keys(snapshot.scenarios), EXPECTED_SCENARIO_KEYS)
    for (const [name, scenario] of Object.entries(snapshot.scenarios)) {
        assertScenarioShape(name, scenario)
    }
})

test("snapshot pins the completed mission engine structural performance values", () => {
    const scenarios = readSnapshot().scenarios
    assert.deepEqual({
        awakeCharacterPage: {
            sqlReads: scenarios["awake-character-page"].sqlReads,
            sqlWrites: scenarios["awake-character-page"].sqlWrites,
            missionComputes: scenarios["awake-character-page"].missionComputes,
        },
        getProgressNoInvalidation: {
            sqlReads: scenarios["get-progress-no-invalidation"].sqlReads,
            sqlWrites: scenarios["get-progress-no-invalidation"].sqlWrites,
            missionComputes: scenarios["get-progress-no-invalidation"].missionComputes,
        },
        singleBattleFinish: {
            sqlReads: scenarios["single-battle-finish"].sqlReads,
            sqlWrites: scenarios["single-battle-finish"].sqlWrites,
            missionComputes: scenarios["single-battle-finish"].missionComputes,
        },
        multiBattleFinish: {
            sqlReads: scenarios["multi-battle-finish"].sqlReads,
            sqlWrites: scenarios["multi-battle-finish"].sqlWrites,
            missionComputes: scenarios["multi-battle-finish"].missionComputes,
        },
    }, {
        awakeCharacterPage: { sqlReads: 11, sqlWrites: 0, missionComputes: 7 },
        getProgressNoInvalidation: { sqlReads: 14, sqlWrites: 1, missionComputes: 110 },
        singleBattleFinish: { sqlReads: 31, sqlWrites: 32, missionComputes: 425 },
        multiBattleFinish: { sqlReads: 32, sqlWrites: 38, missionComputes: 425 },
    })
})

test("mission progress summaries cover every tuple and detect progress or stage changes", () => {
    const {
        createMissionProgressSummary,
    } = require("./mission_engine_focused_helpers.cjs")
    const rows = [
        { mission_category: 5, mission_id: 20, progress_value: 3, stage: 1 },
        { mission_category: 1, mission_id: 10, progress_value: 2, stage: 4 },
    ]
    const summary = createMissionProgressSummary(rows)
    assert.equal(summary.missionProgressCount, 2)
    assert.match(summary.missionProgressSha256, /^[a-f0-9]{64}$/)
    assert.deepEqual(summary, createMissionProgressSummary([...rows].reverse()))

    const progressChanged = structuredClone(rows)
    progressChanged[0].progress_value++
    assert.notEqual(
        createMissionProgressSummary(progressChanged).missionProgressSha256,
        summary.missionProgressSha256,
    )
    const stageChanged = structuredClone(rows)
    stageChanged[1].stage++
    assert.notEqual(
        createMissionProgressSummary(stageChanged).missionProgressSha256,
        summary.missionProgressSha256,
    )
})

test("page and finish scenarios retain complete mission progress semantics", () => {
    const scenarios = readSnapshot().scenarios
    for (const name of [
        "get-progress-no-invalidation",
        "get-progress-item-invalidation",
        "get-progress-character-invalidation",
        "get-progress-equipment-invalidation",
    ]) {
        assert.equal(Number.isInteger(scenarios[name].behavior.missionProgressCount), true, name)
        assert.match(scenarios[name].behavior.missionProgressSha256, /^[a-f0-9]{64}$/, name)
    }
    for (const name of ["single-battle-finish", "multi-battle-finish"]) {
        const { standard, awake } = scenarios[name].behavior
        assert.equal(standard.missionProgressCount > 0, true, `${name} standard count`)
        assert.match(standard.missionProgressSha256, /^[a-f0-9]{64}$/, name)
        assert.equal(awake.missionProgressCount, awake.candidateIds.length, name)
        assert.match(awake.missionProgressSha256, /^[a-f0-9]{64}$/, name)
    }
})

test("invalidation scenarios identify the real reward rule and observed target mission", () => {
    const scenarios = readSnapshot().scenarios
    const expected = {
        "get-progress-item-invalidation": {
            invalidationRule: "regular-33-item-100000-to-degree-41000",
            targetMission: {
                mission_category: 5,
                mission_id: 41000,
                progress_value: 300,
                stage: 1,
            },
        },
        "get-progress-character-invalidation": {
            invalidationRule: "event-2571-character-231003-to-degree-2000",
            targetMission: {
                mission_category: 5,
                mission_id: 2000,
                progress_value: 2,
                stage: 1,
            },
        },
        "get-progress-equipment-invalidation": {
            invalidationRule: "regular-56-equipment-200001-to-degree-43000",
            targetMission: {
                mission_category: 5,
                mission_id: 43000,
                progress_value: 1,
                stage: 1,
            },
        },
    }
    for (const [name, evidence] of Object.entries(expected)) {
        assert.deepEqual({
            invalidationRule: scenarios[name].behavior.invalidationRule,
            targetMission: scenarios[name].behavior.targetMission,
        }, evidence, name)
    }
})

test("finish adapters capture standard and Awake settlement results", () => {
    const scenarios = readSnapshot().scenarios
    for (const name of ["single-battle-finish", "multi-battle-finish"]) {
        const behavior = scenarios[name].behavior
        assert.equal(behavior.adapter, "mission-finish-boundary")
        for (const result of [behavior.standard, behavior.awake]) {
            assert.equal(Array.isArray(result.missionInfo), true, `${name} missionInfo`)
            assert.equal(Array.isArray(result.itemIds), true, `${name} itemIds`)
            assert.equal(Array.isArray(result.characterIds), true, `${name} characterIds`)
            assert.equal(Array.isArray(result.equipmentIds), true, `${name} equipmentIds`)
            assert.equal(Array.isArray(result.degreeIds), true, `${name} degreeIds`)
        }
        assert.equal(behavior.awake.candidateIds.length > 0, true, `${name} Awake candidates`)
        assert.equal(behavior.awake.missionInfo.length > 0, true, `${name} Awake settlement`)
    }
})

test("focused behavior summaries are deterministic and include their payload", () => {
    const { createBehaviorSummary } = require("./mission_engine_focused_baseline.cjs")
    const left = createBehaviorSummary({ z: [2, { b: true, a: 1 }], a: "stable" })
    const right = createBehaviorSummary({ a: "stable", z: [2, { a: 1, b: true }] })
    assert.deepEqual(left, right)
    assert.deepEqual(left.behavior, { a: "stable", z: [2, { a: 1, b: true }] })
    assert.equal(
        left.behaviorSha256,
        crypto.createHash("sha256").update(JSON.stringify(left.behavior)).digest("hex"),
    )
})

test("behavior baseline comparison ignores performance metric improvements", () => {
    const { createBehaviorBaselineView } = require("./mission_engine_focused_baseline.cjs")
    const snapshot = {
        version: 1,
        fixedTime: "2025-01-01T12:00:00.000Z",
        scenarios: {
            focused: {
                sqlReads: 20,
                sqlWrites: 10,
                missionComputes: 30,
                behavior: { result: "stable" },
                behaviorSha256: "a".repeat(64),
            },
        },
    }
    const improved = structuredClone(snapshot)
    improved.scenarios.focused.sqlReads = 2
    improved.scenarios.focused.sqlWrites = 1
    improved.scenarios.focused.missionComputes = 3
    assert.deepEqual(
        createBehaviorBaselineView(improved),
        createBehaviorBaselineView(snapshot),
    )
})

test("Event Session focused settlement preserves behavior without increasing SQL or compute", () => {
    const scenarios = readSnapshot().scenarios
    const legacy = scenarios["event-routing-fallback"]
    const session = scenarios["event-focused"]

    assert.deepEqual(session.behavior, legacy.behavior)
    assert.equal(session.behaviorSha256, legacy.behaviorSha256)
    assert.equal(session.sqlReads <= legacy.sqlReads, true)
    assert.equal(session.sqlWrites, legacy.sqlWrites)
    assert.equal(session.missionComputes, legacy.missionComputes)
})

test("compute counter installation rolls back earlier wrappers when a later patch fails", () => {
    const { installComputeCounter } = require("./mission_engine_focused_baseline.cjs")
    const firstOriginal = function firstOriginal() { return 1 }
    const secondOriginal = function secondOriginal() { return 2 }
    const first = { compute: firstOriginal }
    const second = {}
    let secondCurrent = secondOriginal
    Object.defineProperty(second, "compute", {
        configurable: true,
        get: () => secondCurrent,
        set(value) {
            secondCurrent = value
            throw new Error("injected compute patch failure")
        },
    })

    assert.throws(
        () => installComputeCounter(category => category === 1 ? first : second),
        /injected compute patch failure/,
    )
    assert.equal(first.compute, firstOriginal)
    assert.equal(second.compute, secondOriginal)
})

test("compute counter restore preserves a method replaced after installation", () => {
    const { installComputeCounter } = require("./mission_engine_focused_baseline.cjs")
    const original = function original() { return 1 }
    const replacement = function replacement() { return 2 }
    const computer = { compute: original }
    const counter = installComputeCounter(() => computer)
    assert.notEqual(computer.compute, original)
    computer.compute = replacement

    counter.restore()

    assert.equal(computer.compute, replacement)
})

test("mission page closes Fastify without replacing register, ready, or inject failures", async () => {
    const { requestMissionPage } = require("./mission_engine_focused_helpers.cjs")
    for (const failingPhase of ["register", "ready", "inject"]) {
        let closeCalls = 0
        const app = {
            addHook() {},
            async register() {
                if (failingPhase === "register") throw new Error("injected register failure")
            },
            async ready() {
                if (failingPhase === "ready") throw new Error("injected ready failure")
            },
            async inject() {
                if (failingPhase === "inject") throw new Error("injected inject failure")
                throw new Error("inject should not run")
            },
            async close() {
                closeCalls++
                throw new Error("injected Fastify close failure")
            },
        }

        await assert.rejects(
            requestMissionPage(
                { missionRoutes: async () => {} },
                [{ category: 1 }],
                { fastifyFactory: () => app },
            ),
            error => {
                assert.match(error.message, new RegExp(`injected ${failingPhase} failure`))
                assert.match(error.cause?.message ?? "", /injected Fastify close failure/)
                return true
            },
        )
        assert.equal(closeCalls, 1, failingPhase)
    }
})

test("current focused mission engine behavior matches the checked-in behavior", async () => {
    const {
        SCENARIO_KEYS,
        admitFocusedMissionReport,
        createBehaviorBaselineView,
        runMissionEngineFocusedBaseline,
    } = require("./mission_engine_focused_baseline.cjs")
    assert.deepEqual(SCENARIO_KEYS, EXPECTED_SCENARIO_KEYS)
    const current = await runMissionEngineFocusedBaseline()
    for (const [name, scenario] of Object.entries(current.scenarios)) {
        assertScenarioShape(name, scenario)
    }
    const snapshot = readSnapshot()
    const admission = admitFocusedMissionReport(current, {
        snapshotPath,
        write: false,
    })
    assert.equal(admission.admitted, true)
    assert.deepEqual(
        createBehaviorBaselineView(current),
        createBehaviorBaselineView(snapshot),
    )
    for (const name of ["single-battle-finish", "get-progress-no-invalidation"]) {
        const regressed = structuredClone(current)
        regressed.scenarios[name].sqlReads++
        const regressionAdmission = admitFocusedMissionReport(regressed, {
            snapshotPath,
            write: false,
        })
        assert.equal(regressionAdmission.admitted, false, name)
        assert.ok(
            regressionAdmission.failures.some(failure => (
                failure.scenario === name && failure.metric === "sqlReads"
            )),
            name,
        )
    }
    const routingFallback = current.scenarios["degree-routing-fallback"]
    const session = current.scenarios["degree-focused"]
    const behavior = current.scenarios["degree-behavior-characterization"]
    assert.deepEqual({
        routingFallback: {
            sqlReads: routingFallback.sqlReads,
            sqlWrites: routingFallback.sqlWrites,
            missionComputes: routingFallback.missionComputes,
        },
        session: {
            sqlReads: session.sqlReads,
            sqlWrites: session.sqlWrites,
            missionComputes: session.missionComputes,
        },
    }, {
        routingFallback: { sqlReads: 9, sqlWrites: 1, missionComputes: 5 },
        session: { sqlReads: 8, sqlWrites: 1, missionComputes: 5 },
    })
    assert.deepEqual(behavior.behavior, legacyDegreeFixture.settlement)
})

test("cleanup attempts every scenario and suite restoration after failures", async () => {
    const { runMissionEngineFocusedBaseline } = require("./mission_engine_focused_baseline.cjs")
    const temporaryParent = fs.mkdtempSync(path.join(os.tmpdir(), "mission-focused-cleanup-"))
    const originalLog = console.log
    const database = {
        open: true,
        close() { this.open = false },
    }
    const timeOffsets = []
    let contentRestoreAttempted = false
    const computer = {
        compute() { return 0 },
    }
    const scenarioNames = [...EXPECTED_SCENARIO_KEYS]
    const runtime = {
        closeDatabase() { throw new Error("injected shared database close failure") },
        createFocusedScenarios() {
            return scenarioNames.map(name => ({
                name,
                prepare: () => 1,
                execute() { throw new Error("injected focused scenario failure") },
            }))
        },
        getComputer: () => computer,
        getDatabaseStatus: () => ({ open: false, ready: false, schema: null }),
        getTimeOffset: () => 12345,
        initializeDatabase: () => database,
        installBundledGameplaySnapshot() {
            return () => {
                contentRestoreAttempted = true
                throw new Error("injected content restore failure")
            }
        },
        resolveRuntimeDataPaths: () => ({}),
        setServerTimeOffset(value) {
            timeOffsets.push(value)
            if (value === 12345) throw new Error("injected time restore failure")
        },
    }

    try {
        await assert.rejects(
            runMissionEngineFocusedBaseline({
                runtimeLoader: () => runtime,
                temporaryParent,
            }),
            /injected focused scenario failure/,
        )
        assert.equal(database.open, false, "fallback database close must run")
        assert.equal(contentRestoreAttempted, true)
        assert.equal(timeOffsets.at(-1), 12345, "time restore must still be attempted")
        assert.equal(console.log, originalLog, "console.log must be restored")
        assert.deepEqual(fs.readdirSync(temporaryParent), [], "temporary directories must be removed")
    } finally {
        console.log = originalLog
        fs.rmSync(temporaryParent, { recursive: true, force: true })
    }
})

test("mission settlement behavior summary matches the approved baseline", () => {
    const { createStableSummary } = require("./mission_settlement_baseline.cjs")
    const historicalPath = path.join(
        __dirname,
        "__snapshots__",
        "mission_settlement_baseline.json",
    )
    const baseline = JSON.parse(fs.readFileSync(historicalPath, "utf8"))
    const recomputed = createStableSummary(baseline)
    assert.equal(recomputed.sha256, baseline.sha256)
    assert.equal(recomputed.sha256, APPROVED_SETTLEMENT_SHA256)
})
