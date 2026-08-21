"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

const { SMOKE_MULTI_PROFILE } = require("./multi_hub_load_metrics.cjs")
const scenarios = require("./multi_hub_load_scenarios.cjs")
const workload = require("./multi_hub_load_workload.cjs")
const {
    cleanupFixture,
    fakeDependencies,
    successfulBatch,
} = require("./multi_hub_load_workload_test_helpers.cjs")

async function withWatchdog(operation, timeoutMs, message) {
    let timer
    try {
        return await Promise.race([
            operation,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(message)), timeoutMs)
            }),
        ])
    } finally {
        clearTimeout(timer)
    }
}

test("heartbeat and cleanup failures preserve their original error chain", async () => {
    const scenario = {
        scenarioIndex: 2,
        ownerSide: "client",
        nodes: [{ dataKey: "client-b" }, { dataKey: "host" }],
    }
    const heartbeatError = new Error("viewer-device-room-raw")
    const cleanupError = new Error("token-port-path-raw")
    const result = await scenarios.runScenarioBatch({
        harness: {},
        scenarios: [scenario],
        spectators: [],
        openParty: async () => ({ roomNumber: 999_999, lobby: [] }),
        coexistenceRunner: async () => ({
            attempted: 0,
            completed: 0,
            errors: 0,
            routes: { auth: 0, load: 0, mission: 0 },
            errorMessages: [],
        }),
        heartbeatRunner: async () => { throw heartbeatError },
        cleanupRunner: async () => { throw cleanupError },
    })
    const [room] = result.rooms
    assert.equal(room.remainingRoom, true)
    assert.equal(room.error instanceof AggregateError, true)
    assert.equal(room.error.message, "heartbeat failed")
    assert.equal(room.error.cause, heartbeatError)
    assert.deepEqual(room.error.errors, [heartbeatError, cleanupError])
})

test("cleanupEntry preserves abort, disband, and search errors", async () => {
    for (const stage of ["abort", "disband", "search"]) {
        const error = new Error(`${stage}-viewer-token-room-port-path-raw`)
        const fixture = cleanupFixture(stage === "search" ? {} : { [`${stage}Error`]: error })
        if (stage === "abort") {
            fixture.entry.playIds = new Map([[fixture.node.dataKey, "scenario-0-host"]])
        }
        const result = await scenarios.cleanupEntry(fixture.harness, fixture.entry, {
            stateReader: () => ({ activeQuests: stage === "abort" ? 1 : 0 }),
            searchRunner: stage === "search"
                ? async () => { throw error }
                : undefined,
        })
        assert.equal(result.errors.includes(error), true)
    }
})

test("settleEntry preserves battle and cleanupRunner failures while reports stay finite", async () => {
    const { harness, entry } = cleanupFixture()
    const battleError = new Error("battle-viewer-device-room-raw")
    const cleanupError = new Error("cleanup-token-port-path-raw")
    const result = await scenarios.settleEntry(harness, entry, {
        battleRunner: async () => { throw battleError },
        cleanupRunner: async () => { throw cleanupError },
    })
    assert.equal(result.error instanceof AggregateError, true)
    assert.equal(result.error.cause, battleError)
    assert.deepEqual(result.error.errors, [battleError, cleanupError])

    const observed = { harnesses: [], cleaned: [], runtimeHarnesses: [], batches: [] }
    const step = await workload.runMultiHubStep({
        profile: SMOKE_MULTI_PROFILE,
        concurrency: 1,
        ...fakeDependencies(observed),
        batchRunner: async () => ({
            rooms: [result],
            coexistence: successfulBatch([]).coexistence,
        }),
    })
    assert.deepEqual(step.errors, ["scenario 0 finish failed"])
    assert.equal(JSON.stringify(step).includes(battleError.message), false)
    assert.equal(JSON.stringify(step).includes(cleanupError.message), false)
})

test("runtime setup and participant initialization time out and still clean the harness", async () => {
    for (const hangingStage of ["runtime", "participants"]) {
        const observed = { harnesses: [], cleaned: [], runtimeHarnesses: [], batches: [] }
        const dependencies = fakeDependencies(observed)
        let stageSignal
        const step = await Promise.race([
            workload.runMultiHubStep({
                profile: SMOKE_MULTI_PROFILE,
                concurrency: 1,
                ...dependencies,
                runtimeSetupTimeoutMs: 5,
                participantsTimeoutMs: 5,
                runtimeSetup: hangingStage === "runtime"
                    ? async ({ signal }) => {
                        stageSignal = signal
                        return new Promise(() => {})
                    }
                    : dependencies.runtimeSetup,
                participantsFactory: hangingStage === "participants"
                    ? async ({ signal }) => {
                        stageSignal = signal
                        return new Promise(() => {})
                    }
                    : dependencies.participantsFactory,
            }),
            new Promise((_, reject) => setTimeout(
                () => reject(new Error(`${hangingStage} initialization remained pending`)),
                80,
            )),
        ])
        assert.equal(stageSignal instanceof AbortSignal, true)
        assert.equal(stageSignal.aborted, true)
        assert.deepEqual(observed.cleaned, [0])
        assert.ok(step.errors.includes("scenario step setup failed"))
    }
})

test("initialization timeout consumes late resolve and rejection from both stages", async () => {
    const unhandled = []
    const onUnhandled = error => unhandled.push(error)
    process.on("unhandledRejection", onUnhandled)
    try {
        for (const stage of ["runtime", "participants"]) {
            for (const outcome of ["resolve", "reject"]) {
                const observed = { harnesses: [], cleaned: [], runtimeHarnesses: [], batches: [] }
                const dependencies = fakeDependencies(observed)
                let stageSignal
                const lateOperation = async ({ signal }) => new Promise((resolve, reject) => {
                    stageSignal = signal
                    signal.addEventListener("abort", () => setTimeout(() => {
                        if (outcome === "resolve") resolve({ ports: [] })
                        else reject(new Error("late-viewer-device-raw"))
                    }, 10), { once: true })
                })
                const step = await withWatchdog(workload.runMultiHubStep({
                    profile: SMOKE_MULTI_PROFILE,
                    concurrency: 1,
                    ...dependencies,
                    runtimeSetupTimeoutMs: 5,
                    participantsTimeoutMs: 5,
                    runtimeSetup: stage === "runtime" ? lateOperation : dependencies.runtimeSetup,
                    participantsFactory: stage === "participants"
                        ? lateOperation
                        : dependencies.participantsFactory,
                }), 250, `${stage} initialization remained pending`)
                assert.equal(stageSignal instanceof AbortSignal, true)
                assert.equal(stageSignal.aborted, true)
                assert.deepEqual(observed.cleaned, [0])
                assert.equal(step.rooms.completed, 0)
                assert.ok(step.errors.includes("scenario step setup failed"))
            }
        }
        await new Promise(resolve => setTimeout(resolve, 30))
        assert.deepEqual(unhandled, [])
    } finally {
        process.off("unhandledRejection", onUnhandled)
    }
})

test("normal setup and participant initialization receive live AbortSignals", async () => {
    const observed = { harnesses: [], cleaned: [], runtimeHarnesses: [], batches: [] }
    const dependencies = fakeDependencies(observed)
    const signals = []
    const step = await workload.runMultiHubStep({
        profile: SMOKE_MULTI_PROFILE,
        concurrency: 1,
        ...dependencies,
        runtimeSetup: async options => {
            signals.push(options.signal)
            return dependencies.runtimeSetup(options)
        },
        participantsFactory: async options => {
            signals.push(options.signal)
            return dependencies.participantsFactory(options)
        },
    })
    assert.equal(step.errors.length, 0)
    assert.equal(signals.every(signal => signal instanceof AbortSignal), true)
    assert.equal(signals.every(signal => signal.aborted === false), true)
})

test("participant creation stops before database side effects after cancellation", async () => {
    const controller = new AbortController()
    let observedSignal
    let databaseCalls = 0
    const harness = {
        async gamePost(_url, _route, _payload, _headers, options) {
            observedSignal = options?.signal
            controller.abort()
            return { status: 200, body: { data_headers: { viewer_id: 7 } } }
        },
        withDatabase() {
            databaseCalls++
            throw new Error("database should not run after cancellation")
        },
    }
    await assert.rejects(
        scenarios.createParticipants({
            harness,
            profile: SMOKE_MULTI_PROFILE,
            runtime: {
                host: { dataKey: "host", url: "host" },
                client: { dataKey: "client", url: "client" },
            },
            signal: controller.signal,
        }),
        error => error?.name === "AbortError",
    )
    assert.equal(observedSignal, controller.signal)
    assert.equal(databaseCalls, 0)
})

test("initialization timeouts must be positive safe integers before harness creation", async () => {
    for (const option of ["runtimeSetupTimeoutMs", "participantsTimeoutMs"]) {
        for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
            await assert.rejects(
                workload.runMultiHubStep({
                    profile: SMOKE_MULTI_PROFILE,
                    concurrency: 1,
                    [option]: value,
                    harnessFactory: () => assert.fail("invalid timeout must precede harness creation"),
                }),
                new RegExp(`${option} must be a positive safe integer`),
            )
        }
    }
})
