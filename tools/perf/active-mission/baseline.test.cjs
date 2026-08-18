"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const EXPECTED_SCENARIO_NAMES = Object.freeze([
    "load-large-change",
    "load-large-stable",
    "load-new",
    "receive-batch-1",
    "receive-batch-8",
    "receive-batch-32",
    "single-finish-active",
    "single-finish-no-match",
    "story-finish-first",
    "story-finish-repeat",
])

const EXPECTED_UNSUPPORTED_MISSION_IDS = Object.freeze([
    21030,
    25009,
    25010,
    25011,
    25012,
    25013,
    25014,
    25017,
    25018,
    25022,
])

function assertBehaviorSummary(name, summary) {
    assert.equal(typeof summary.statusCode, "number", `${name}: statusCode`)
    assert.equal(typeof summary.activeMissionDelta, "object", `${name}: activeMissionDelta`)
    assert.equal(typeof summary.allActiveMissionState, "object", `${name}: allActiveMissionState`)
    assert.equal(typeof summary.awakeMissionState, "object", `${name}: awakeMissionState`)
    assert.equal(typeof summary.rewardState, "object", `${name}: rewardState`)
    assert.deepEqual(summary.unsupportedMissionIds, EXPECTED_UNSUPPORTED_MISSION_IDS, name)
}

let reportPromise

function getReport() {
    reportPromise ??= require("./baseline.cjs").runFocusedScenarios()
    return reportPromise
}

test("active mission focused baseline covers the ten successful real scenarios", async () => {
    const { SCENARIO_NAMES } = require("./baseline.cjs")

    assert.deepEqual(SCENARIO_NAMES, EXPECTED_SCENARIO_NAMES)
    const report = await getReport()
    assert.deepEqual(Object.keys(report.scenarios), EXPECTED_SCENARIO_NAMES)
    assert.deepEqual(report.unsupportedMissionIds, EXPECTED_UNSUPPORTED_MISSION_IDS)

    for (const name of EXPECTED_SCENARIO_NAMES) {
        assertBehaviorSummary(name, report.scenarios[name])
        assert.equal(report.scenarios[name].statusCode, 200, name)
    }
})

test("successful scenarios retain change, stable, repeat, no-match, and batch semantics", async () => {
    const { scenarios } = await getReport()

    assert.equal(scenarios["load-large-change"].activeMissionDelta.length > 0, true)
    assert.deepEqual(scenarios["load-large-stable"].activeMissionDelta, [])
    assert.equal(scenarios["load-new"].activeMissionDelta.length > 0, true)
    assert.equal(scenarios["single-finish-active"].activeMissionDelta.length > 0, true)
    assert.deepEqual(scenarios["single-finish-no-match"].activeMissionDelta, [])
    assert.equal(scenarios["story-finish-first"].activeMissionDelta.length > 0, true)
    assert.deepEqual(scenarios["story-finish-repeat"].activeMissionDelta, [])
    assert.equal(scenarios["receive-batch-1"].activeMissionDelta.length, 1)
    assert.equal(scenarios["receive-batch-8"].activeMissionDelta.length, 8)
    assert.equal(scenarios["receive-batch-32"].activeMissionDelta.length, 32)
})

test("four isolated fault runs report the correct rollback owners", async () => {
    const report = await getReport()

    assert.deepEqual(report.rollback, {
        load: true,
        singleFinish: true,
        storyFinish: true,
        receive: true,
    })
})

test("validateReport rejects a non-200 scenario before snapshot writing", () => {
    const { validateReport } = require("./baseline.cjs")
    const report = {
        scenarios: Object.fromEntries(EXPECTED_SCENARIO_NAMES.map(name => [name, {
            statusCode: 200,
            activeMissionDelta: [],
            allActiveMissionState: {},
            awakeMissionState: {},
            rewardState: {},
            unsupportedMissionIds: [...EXPECTED_UNSUPPORTED_MISSION_IDS],
        }])),
        unsupportedMissionIds: [...EXPECTED_UNSUPPORTED_MISSION_IDS],
        rollback: {
            load: true,
            singleFinish: true,
            storyFinish: true,
            receive: true,
        },
    }
    report.scenarios["load-new"].statusCode = 500

    assert.throws(() => validateReport(report), /load-new: statusCode/)
})

test("runIsolated fails closed around an existing caller database", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "active-mission-caller-db-"))
    const data = require("../../../src/data")
    const { resolveRuntimeDataPaths } = require("../../../src/runtime/data-paths")
    const { createRuntime } = require("./baseline.cjs")
    let database
    let setupCalled = false
    try {
        database = data.initializeDatabase({
            paths: resolveRuntimeDataPaths({ DATA_DIR: directory }),
        })
        database.exec("CREATE TABLE caller_marker (value TEXT NOT NULL)")
        database.prepare("INSERT INTO caller_marker (value) VALUES (?)").run("preserved")

        await assert.rejects(createRuntime().runIsolated({
            name: "caller-db-rejection",
            setup() {
                setupCalled = true
                return { playerId: 1, viewerId: 1 }
            },
            execute() { return "unexpected" },
        }), /open caller database/i)

        assert.equal(setupCalled, false)
        assert.equal(data.getDatabaseStatus().open, true)
        assert.equal(database.open, true)
        assert.deepEqual(database.prepare("SELECT value FROM caller_marker").all(), [
            { value: "preserved" },
        ])
    } finally {
        data.closeDatabase()
        if (database?.open) database.close()
        fs.rmSync(directory, { recursive: true, force: true })
    }
})

test("runIsolated restores the complete caller active quest registry", async () => {
    const { activeQuests } = require("../../../src/lib/quest/active-quest-service")
    const { createRuntime } = require("./baseline.cjs")
    const originalEntries = Object.entries(activeQuests)
    const sentinel = { playId: "caller-active-quest", nested: { preserved: true } }
    for (const playerId of Object.keys(activeQuests)) delete activeQuests[playerId]
    activeQuests[700001] = sentinel
    try {
        const outcome = await createRuntime().runIsolated({
            name: "active-quest-restore",
            setup({ createPlayer }) {
                activeQuests[700002] = { playId: "isolated-setup" }
                return createPlayer("active-quest-restore", 800000799)
            },
            execute() {
                activeQuests[700003] = { playId: "isolated-execute" }
                return "preserved-outcome"
            },
        })

        assert.equal(outcome, "preserved-outcome")
        assert.deepEqual(Object.keys(activeQuests), ["700001"])
        assert.equal(activeQuests[700001], sentinel)
    } finally {
        for (const playerId of Object.keys(activeQuests)) delete activeQuests[playerId]
        Object.assign(activeQuests, Object.fromEntries(originalEntries))
    }
})

test("rollback marker helper rejects an unrelated 500 response", () => {
    const { isInjectedRollback } = require("./baseline.cjs")
    const before = { player: { freeMana: 10 } }
    const after = structuredClone(before)

    assert.equal(isInjectedRollback({
        response: {
            statusCode: 500,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ message: "failure before injected trigger" }),
        },
        marker: "ACTIVE_MISSION_ROLLBACK_MARKER",
        before,
        after,
    }), false)
})

function createFastifyLifecycleProbe({ readyError = null, closeError = null, onClose }) {
    return {
        addContentTypeParser() {},
        addHook() {},
        async register() {},
        async ready() {
            if (readyError) throw new Error(readyError)
        },
        async close() {
            onClose?.()
            if (closeError) throw new Error(closeError)
        },
    }
}

test("runIsolated closes a Fastify app registered before ready fails", async () => {
    const { createRuntime } = require("./baseline.cjs")
    let closeCalls = 0
    const runtime = createRuntime({
        fastifyFactory: () => createFastifyLifecycleProbe({
            readyError: "ready lifecycle probe",
            onClose: () => { closeCalls++ },
        }),
    })

    await assert.rejects(runtime.runIsolated({
        name: "fastify-ready-close-probe",
        setup: async ({ createApp }) => {
            await createApp(async () => {}, {})
            throw new Error("setup should not continue after ready failure")
        },
        execute() { return "unexpected" },
    }), /ready lifecycle probe/)
    assert.equal(closeCalls, 1)
})

test("runIsolated rejects when Fastify cleanup throws", async () => {
    const { createRuntime } = require("./baseline.cjs")
    const runtime = createRuntime({
        fastifyFactory: () => createFastifyLifecycleProbe({
            closeError: "close lifecycle probe",
        }),
    })

    await assert.rejects(runtime.runIsolated({
        name: "fastify-close-error-probe",
        setup: ({ createPlayer }) => createPlayer("fastify-close-error-probe", 800000798),
        execute: async ({ createApp }) => {
            await createApp(async () => {}, {})
            return "must not be returned"
        },
    }), /close lifecycle probe/)
})
