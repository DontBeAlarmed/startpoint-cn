"use strict"

const assert = require("node:assert/strict")
const { spawnSync } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const {
    FORMAL_MULTI_PROFILE,
    SMOKE_MULTI_PROFILE,
    createBehaviorSignature,
} = require("./multi_hub_load_metrics.cjs")
const projectRoot = path.resolve(__dirname, "../..")
const workloadPath = path.join(__dirname, "multi_hub_load_workload.cjs")
const { startOwnedProcess } = require("./multi_hub_load_process_fixture.cjs")
const workload = require(workloadPath)
const scenariosModule = require("./multi_hub_load_scenarios.cjs")
const {
    cleanupFixture,
    coexistenceHarness,
    fakeDependencies,
    successfulBatch,
    successfulHttp,
} = require("./multi_hub_load_workload_test_helpers.cjs")

test("parseArgs defaults to the locked smoke profile", () => {
    assert.deepEqual(workload.parseArgs([]), {
        formal: false,
        output: null,
        profile: {
            activeIdentities: 2,
            clientOwnedRooms: 0,
            concurrencySteps: [1],
            hostOwnedRooms: 1,
            totalRooms: 1,
        },
    })
})

test("parseArgs selects formal and output never changes the profile", () => {
    assert.deepEqual(workload.parseArgs(["--formal"]), {
        formal: true,
        output: null,
        profile: {
            activeIdentities: 120,
            clientOwnedRooms: 30,
            concurrencySteps: [5, 10, 20],
            hostOwnedRooms: 30,
            totalRooms: 60,
        },
    })
    assert.deepEqual(workload.parseArgs(["--output", "reports/multi.json"]), {
        formal: false,
        output: "reports/multi.json",
        profile: {
            activeIdentities: 2,
            clientOwnedRooms: 0,
            concurrencySteps: [1],
            hostOwnedRooms: 1,
            totalRooms: 1,
        },
    })
})

test("parseArgs rejects custom scale, unknown, duplicate, and incomplete flags", () => {
    for (const flag of ["--players", "--rooms", "--concurrency"]) {
        assert.throws(() => workload.parseArgs([flag, "2"]), new RegExp(`unknown argument: ${flag}`))
    }
    assert.throws(() => workload.parseArgs(["--formal", "--formal"]), /--formal may only be specified once/)
    assert.throws(() => workload.parseArgs(["--output", "a", "--output", "b"]), /--output may only be specified once/)
    assert.throws(() => workload.parseArgs(["--output"]), /--output requires a path/)
    assert.throws(() => workload.parseArgs(["--output", "--formal"]), /--output requires a path/)
    assert.throws(() => workload.parseArgs(["--unknown"]), /unknown argument: --unknown/)
})

test("parseArgs profiles are safe copies", () => {
    const first = workload.parseArgs([])
    first.profile.activeIdentities = 999
    first.profile.concurrencySteps.push(99)
    assert.deepEqual(workload.parseArgs([]).profile, {
        activeIdentities: 2,
        clientOwnedRooms: 0,
        concurrencySteps: [1],
        hostOwnedRooms: 1,
        totalRooms: 1,
    })
    assert.equal(SMOKE_MULTI_PROFILE.activeIdentities, 2)
})

test("loading the workload is silent", () => {
    const result = spawnSync(process.execPath, ["-e", "require(process.argv[1])", workloadPath], { encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, "")
    assert.equal(result.stderr, "")
})

test("percentile and chunk helpers are deterministic", () => {
    assert.equal(workload.percentile([], 0.5), 0)
    assert.equal(workload.percentile([9, 1, 5, 3], 0.5), 3)
    assert.equal(workload.percentile([9, 1, 5, 3], 0.95), 9)
    assert.equal(workload.percentile([9, 1, 5, 3], 0.99), 9)
    assert.deepEqual(workload.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
    assert.throws(() => workload.chunk([1], 0), /chunk size/)
})

test("scenario plan locks host-owned rooms before client-owned rooms", () => {
    const plan = workload.createScenarioPlan(FORMAL_MULTI_PROFILE)
    assert.equal(plan.length, 60)
    assert.deepEqual(plan.slice(0, 30).map(item => item.ownerSide), Array(30).fill("host"))
    assert.deepEqual(plan.slice(30).map(item => item.ownerSide), Array(30).fill("client"))
    assert.deepEqual(plan.map(item => item.scenarioIndex), Array.from({ length: 60 }, (_, i) => i))
    assert.ok(plan.every(item => Object.keys(item).sort().join(",") === "ownerSide,scenarioIndex"))
})

test("finiteScenarioError removes runtime identifiers and raw protocol data", () => {
    const secret = "viewer-token-device-room-port-path-raw"
    const source = new AggregateError([new Error(secret), new Error("HTTP 503 result_code 4507")], secret)
    const message = workload.finiteScenarioError(source, 4, "coexistence client load")
    assert.equal(message, "scenario 4 coexistence client load failed")
    assert.doesNotMatch(message, /viewer|token|device|room|port|path|raw|503|4507/)
})

test("a heartbeat failure cleans only that room while peers in the batch settle", async () => {
    const cleaned = []
    const settled = []
    const scenarios = [0, 1].map(scenarioIndex => ({
        scenarioIndex,
        ownerSide: "host",
        nodes: [{ dataKey: "host" }, { dataKey: "client-b" }],
    }))
    const result = await scenariosModule.runScenarioBatch({
        harness: {},
        scenarios,
        spectators: [],
        openParty: async (_harness, scenario) => ({ roomNumber: scenario.scenarioIndex, lobby: [] }),
        coexistenceRunner: async () => ({
            attempted: 0,
            completed: 0,
            errors: 0,
            routes: { auth: 0, load: 0, mission: 0 },
            errorMessages: [],
        }),
        heartbeatRunner: async entry => {
            if (entry.scenario.scenarioIndex === 0) throw new Error("dynamic heartbeat failure")
        },
        cleanupRunner: async (_harness, entry) => {
            cleaned.push(entry.scenario.scenarioIndex)
            return { remainingRoom: false, errors: [] }
        },
        settleRunner: async (_harness, entry) => {
            settled.push(entry.scenario.scenarioIndex)
            return successfulBatch([entry.scenario]).rooms[0]
        },
    })
    assert.deepEqual(cleaned, [0])
    assert.deepEqual(settled, [1])
    assert.equal(result.rooms.length, 2)
    assert.equal(result.rooms[0].scenarioIndex, 0)
    assert.equal(result.rooms[0].stage, "heartbeat")
    assert.equal(result.rooms[0].outcome, null)
    assert.equal(result.rooms[1].outcome.hostRewarded, true)
})

test("runScenarioBatch bounds never-settling Enter and consumes late rejection", async () => {
    const scenarios = [0, 1, 2].map(scenarioIndex => ({
        scenarioIndex,
        ownerSide: "host",
        nodes: [{ dataKey: "host" }, { dataKey: "client-b" }],
    }))
    const result = await Promise.race([
        scenariosModule.runScenarioBatch({
            harness: {},
            scenarios,
            spectators: [],
            stageTimeoutMs: 5,
            openParty: async (_harness, scenario) => {
                if (scenario.scenarioIndex === 0) return new Promise(() => {})
                if (scenario.scenarioIndex === 1) return new Promise((_, reject) => {
                    setTimeout(() => reject(new Error("late-device-room-raw")), 20)
                })
                return { roomNumber: 3, lobby: [] }
            },
            coexistenceRunner: async () => ({
                attempted: 0,
                completed: 0,
                errors: 0,
                routes: { auth: 0, load: 0, mission: 0 },
                errorMessages: [],
            }),
            heartbeatRunner: async () => {},
            settleRunner: async (_harness, entry) => successfulBatch([entry.scenario]).rooms[0],
        }),
        new Promise((_, reject) => setTimeout(
            () => reject(new Error("test observed unbounded Enter")),
            60,
        )),
    ])
    assert.equal(result.rooms.length, 3)
    assert.deepEqual(result.rooms.slice(0, 2).map(room => ({
        scenarioIndex: room.scenarioIndex,
        stage: room.stage,
        outcome: room.outcome,
    })), [
        { scenarioIndex: 0, stage: "enter", outcome: null },
        { scenarioIndex: 1, stage: "enter", outcome: null },
    ])
    assert.equal(result.rooms[2].outcome.hostRewarded, true)
    await new Promise(resolve => setTimeout(resolve, 30))
})

test("runScenarioBatch validates stageTimeoutMs", async () => {
    for (const stageTimeoutMs of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        await assert.rejects(
            scenariosModule.runScenarioBatch({
                harness: {},
                scenarios: [],
                spectators: [],
                stageTimeoutMs,
            }),
            /stageTimeoutMs must be a positive safe integer/,
        )
    }
})

test("HTTP coexistence accepts MsgPack from Headers and plain header objects", async () => {
    const { harness, node } = coexistenceHarness()
    const result = await scenariosModule.runCoexistence(harness, [node])
    assert.deepEqual(result, {
        attempted: 3,
        completed: 3,
        errors: 0,
        routes: { auth: 1, load: 1, mission: 1 },
        errorMessages: [],
    })
})

test("HTTP coexistence rejects JSON content type and malformed load data", async () => {
    const mutations = [
        responses => { responses.auth.headers = new Headers({ "content-type": "application/json" }) },
        responses => {
            const data = []
            data.unfinished_quest_list = []
            data.unfinished_multi_quest_list = []
            responses.load.body.data = data
        },
        responses => { responses.load.body.data.unfinished_quest_list = [{ play_id: "unexpected" }] },
        responses => {
            responses.load.body.data.unfinished_multi_quest_list = [{ play_id: "unexpected" }]
        },
    ]
    for (const mutate of mutations) {
        const { harness, node } = coexistenceHarness(mutate)
        const result = await scenariosModule.runCoexistence(harness, [node])
        assert.equal(result.completed, 2)
        assert.equal(result.errors, 1)
    }
})

test("HTTP coexistence rejects empty and malformed mission progress", async () => {
    const missionLists = [
        [],
        [{ mission_category: 1, mission_id: 1, progress_value: -1, stage: 1 }],
        [{ mission_category: 1, mission_id: 1, progress_value: 0, stage: 0 }],
        [Object.assign(new Date(), {
            mission_category: 1,
            mission_id: 1,
            progress_value: 0,
            stage: 1,
        })],
    ]
    for (const missionProgressList of missionLists) {
        const { harness, node } = coexistenceHarness(responses => {
            responses.mission.body.data.mission_progress_list = missionProgressList
        })
        const result = await scenariosModule.runCoexistence(harness, [node])
        assert.equal(result.completed, 2)
        assert.equal(result.errors, 1)
    }
})

test("cleanupEntry records peer close rejection and timeout", async () => {
    const peerError = new Error("viewer-device-raw")
    const rejected = cleanupFixture({ peer: { close: async () => { throw peerError } } })
    const rejectedResult = await scenariosModule.cleanupEntry(
        rejected.harness,
        rejected.entry,
        { stageTimeoutMs: 5 },
    )
    assert.equal(rejectedResult.remainingRoom, false)
    assert.deepEqual(rejectedResult.errors, [peerError])

    const timedOut = cleanupFixture({ peer: { close: async () => new Promise(() => {}) } })
    const timedOutResult = await scenariosModule.cleanupEntry(
        timedOut.harness,
        timedOut.entry,
        { stageTimeoutMs: 5 },
    )
    assert.equal(timedOutResult.remainingRoom, false)
    assert.match(timedOutResult.errors[0].message, /peer cleanup timed out/)
})

test("cleanupEntry retains disband failure even when search says the room is absent", async () => {
    const { harness, entry } = cleanupFixture({
        disband: { status: 503, body: { data_headers: { result_code: 4507 } } },
    })
    const result = await scenariosModule.cleanupEntry(harness, entry)
    assert.equal(result.remainingRoom, false)
    assert.deepEqual(result.errors.map(error => error.message), ["disband cleanup failed"])
})

test("cleanupEntry treats search HTTP and room_exists schema failures as leaks", async () => {
    for (const search of [
        { status: 503, body: { data_headers: { result_code: 4507 } } },
        successfulHttp({ room_exists: "false" }),
    ]) {
        const { harness, entry } = cleanupFixture({ search })
        const result = await scenariosModule.cleanupEntry(harness, entry)
        assert.equal(result.remainingRoom, true)
        assert.deepEqual(result.errors.map(error => error.message), ["room search cleanup failed"])
    }
})

test("cleanupEntry records a cleanup error when the room still exists", async () => {
    const { harness, entry } = cleanupFixture({
        search: successfulHttp({ room_exists: true }),
    })
    const result = await scenariosModule.cleanupEntry(harness, entry)
    assert.equal(result.remainingRoom, true)
    assert.deepEqual(result.errors.map(error => error.message), ["room cleanup failed"])
})

test("settleEntry invalidates a successful outcome when cleanup reports an error", async () => {
    const { harness, entry } = cleanupFixture()
    const result = await scenariosModule.settleEntry(harness, entry, {
        battleRunner: async () => ({
            ownerSide: "host",
            hostRewarded: true,
            guestRewarded: true,
            duplicateFinishRejected: 2,
        }),
        cleanupRunner: async () => ({
            remainingRoom: false,
            errors: [new Error("peer cleanup failed")],
        }),
    })
    assert.equal(result.outcome, null)
    assert.equal(result.stage, "cleanup")
    assert.equal(result.error.message, "room cleanup failed")
})

test("cleanupEntry records abort HTTP failure and persisted active quest state", async () => {
    for (const fixture of [
        {
            abort: { status: 503, body: { data_headers: { result_code: 4507 } } },
            states: [1],
        },
        { abort: successfulHttp(), states: [1, 1] },
    ]) {
        const { harness, entry, node } = cleanupFixture({ abort: fixture.abort })
        entry.playIds = new Map([[node.dataKey, "scenario-0-host"]])
        let reads = 0
        const result = await scenariosModule.cleanupEntry(harness, entry, {
            stateReader: () => ({ activeQuests: fixture.states[Math.min(reads++, fixture.states.length - 1)] }),
        })
        assert.deepEqual(result.errors.map(error => error.message), ["abort cleanup failed"])
    }
})

test("runMultiHubStep maps batches, owners, signatures, latency, and cleanup", async () => {
    const observed = { harnesses: [], cleaned: [], runtimeHarnesses: [], batches: [] }
    const profile = {
        activeIdentities: 8,
        clientOwnedRooms: 2,
        concurrencySteps: [2],
        hostOwnedRooms: 2,
        totalRooms: 4,
    }
    const step = await workload.runMultiHubStep({ profile, concurrency: 2, ...fakeDependencies(observed) })

    assert.deepEqual(observed.runtimeHarnesses, [0])
    assert.deepEqual(observed.batches, [[0, 1], [2, 3]])
    assert.deepEqual(observed.cleaned, [0])
    assert.deepEqual(step.rooms, { attempted: 4, completed: 4, hostOwned: 2, clientOwned: 2 })
    assert.deepEqual(step.players, { attempted: 8, completed: 8 })
    assert.deepEqual(step.coexistence, { attempted: 12, completed: 12, errors: 0, routes: { auth: 4, load: 4, mission: 4 } })
    assert.deepEqual(step.settlement, { duplicateFinishRejected: 8, activeQuestsAfter: 0, errors: 0 })
    assert.equal(step.behaviorSignatures.length, 2)
    assert.deepEqual(step.latencyMs, { p50: 1.25, p95: 3.25, p99: 3.25 })
    assert.deepEqual(step.errors, [])
    assert.deepEqual(step.cleanup, { activePeers: 0, activeProcesses: 0, portsReleased: true, remainingRooms: 0, temporaryRootExists: false })
})

test("room owner counters describe completed outcomes instead of the target profile", async () => {
    const observed = { harnesses: [], cleaned: [], runtimeHarnesses: [], batches: [] }
    const dependencies = fakeDependencies(observed)
    const profile = {
        activeIdentities: 4,
        clientOwnedRooms: 1,
        concurrencySteps: [2],
        hostOwnedRooms: 1,
        totalRooms: 2,
    }
    const step = await workload.runMultiHubStep({
        profile,
        concurrency: 2,
        ...dependencies,
        batchRunner: async ({ scenarios }) => ({
            rooms: [
                successfulBatch([scenarios[0]]).rooms[0],
                {
                    scenarioIndex: scenarios[1].scenarioIndex,
                    durationMs: 1,
                    outcome: null,
                    error: new Error("dynamic client failure"),
                    stage: "finish",
                    remainingRoom: false,
                },
            ],
            coexistence: successfulBatch([]).coexistence,
        }),
    })
    assert.deepEqual(step.rooms, {
        attempted: 2,
        completed: 1,
        hostOwned: 1,
        clientOwned: 0,
    })
    assert.equal(step.rooms.hostOwned + step.rooms.clientOwned, step.rooms.completed)
})

test("batch failure still queries active quests before harness cleanup", async () => {
    const observed = { harnesses: [], cleaned: [], runtimeHarnesses: [], batches: [] }
    const dependencies = fakeDependencies(observed)
    let counterCalls = 0
    const step = await workload.runMultiHubStep({
        profile: SMOKE_MULTI_PROFILE,
        concurrency: 1,
        ...dependencies,
        batchRunner: async () => { throw new Error("dynamic batch failure") },
        activeQuestCounter() {
            counterCalls++
            assert.deepEqual(observed.cleaned, [])
            return 0
        },
    })
    assert.equal(counterCalls, 1)
    assert.equal(step.settlement.activeQuestsAfter, 0)
    assert.ok(step.errors.includes("scenario step setup failed"))
})

test("unknown active quest state uses a nonzero sentinel and finite error", async () => {
    const observed = { harnesses: [], cleaned: [], runtimeHarnesses: [], batches: [] }
    const dependencies = fakeDependencies(observed)
    const counterFailure = await workload.runMultiHubStep({
        profile: SMOKE_MULTI_PROFILE,
        concurrency: 1,
        ...dependencies,
        activeQuestCounter() { throw new Error("database-device-path-raw") },
    })
    assert.ok(counterFailure.settlement.activeQuestsAfter > 0)
    assert.ok(counterFailure.errors.includes("scenario step active quest inspection failed"))

    const missingParticipants = await workload.runMultiHubStep({
        profile: SMOKE_MULTI_PROFILE,
        concurrency: 1,
        ...dependencies,
        participantsFactory: async () => { throw new Error("participants-device-raw") },
        activeQuestCounter: () => assert.fail("counter must not run without participants"),
    })
    assert.ok(missingParticipants.settlement.activeQuestsAfter > 0)
    assert.ok(missingParticipants.errors.includes("scenario step active quest inspection failed"))
})

test("harness cleanup timeout returns a rejected gate without waiting forever", async () => {
    const observed = { harnesses: [], cleaned: [], runtimeHarnesses: [], batches: [] }
    const dependencies = fakeDependencies(observed)
    const report = await Promise.race([
        workload.runMultiHubLoadWorkload({
            profile: SMOKE_MULTI_PROFILE,
            ...dependencies,
            cleanupTimeoutMs: 5,
            harnessFactory() {
                const peer = { close: () => new Promise(() => {}) }
                const harness = {
                    id: 0,
                    peers: [peer],
                    processes: [],
                    root: "/finite-root-cleanup-timeout",
                    cleanup() { return Promise.allSettled(this.peers.map(item => item.close())) },
                }
                observed.harnesses.push(harness)
                return harness
            },
            cleanupProbe: async () => ({
                activePeers: 1,
                activeProcesses: 0,
                portsReleased: true,
                remainingRooms: 0,
                temporaryRootExists: false,
            }),
        }),
        new Promise((_, reject) => setTimeout(
            () => reject(new Error("test observed unbounded harness cleanup")),
            60,
        )),
    ])
    assert.equal(report.gate.admitted, false)
    assert.ok(report.steps[0].errors.includes("scenario step cleanup failed"))
})

test("harness cleanup timeout consumes a late rejection", async () => {
    const observed = { harnesses: [], cleaned: [], runtimeHarnesses: [], batches: [] }
    const dependencies = fakeDependencies(observed)
    const startedAt = performance.now()
    const report = await workload.runMultiHubLoadWorkload({
        profile: SMOKE_MULTI_PROFILE,
        ...dependencies,
        cleanupTimeoutMs: 5,
        harnessFactory() {
            const peer = {
                close() {
                    return new Promise((_, reject) => setTimeout(
                        () => reject(new Error("late-viewer-device-raw")),
                        20,
                    ))
                },
            }
            const harness = {
                id: 0,
                peers: [peer],
                processes: [],
                root: "/finite-root-late-cleanup",
                cleanup() { return Promise.allSettled(this.peers.map(item => item.close())) },
            }
            observed.harnesses.push(harness)
            return harness
        },
        cleanupProbe: async () => ({
            activePeers: 0,
            activeProcesses: 0,
            portsReleased: true,
            remainingRooms: 0,
            temporaryRootExists: false,
        }),
    })
    assert.ok(performance.now() - startedAt < 15, "cleanup must return at its outer timeout")
    assert.equal(report.gate.admitted, false)
    assert.ok(report.steps[0].errors.includes("scenario step cleanup failed"))
    await new Promise(resolve => setTimeout(resolve, 30))
})

test("cleanupTimeoutMs must be a positive safe integer", async () => {
    for (const cleanupTimeoutMs of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        await assert.rejects(
            workload.runMultiHubStep({
                profile: SMOKE_MULTI_PROFILE,
                concurrency: 1,
                cleanupTimeoutMs,
                harnessFactory: () => assert.fail("invalid timeout must fail before harness creation"),
            }),
            /cleanupTimeoutMs must be a positive safe integer/,
        )
    }
})

test("runMultiHubLoadWorkload uses a fresh harness for every concurrency step", async () => {
    const observed = { harnesses: [], cleaned: [], runtimeHarnesses: [], batches: [] }
    const report = await workload.runMultiHubLoadWorkload({ profile: FORMAL_MULTI_PROFILE, ...fakeDependencies(observed) })
    assert.equal(observed.harnesses.length, 3)
    assert.equal(new Set(observed.harnesses).size, 3)
    assert.deepEqual(observed.runtimeHarnesses, [0, 1, 2])
    assert.deepEqual(observed.cleaned, [0, 1, 2])
    assert.equal(report.schemaVersion, 1)
    assert.deepEqual(report.profile, {
        activeIdentities: 120,
        clientOwnedRooms: 30,
        concurrencySteps: [5, 10, 20],
        hostOwnedRooms: 30,
        totalRooms: 60,
    })
    assert.equal(report.steps.length, 3)
    assert.equal(report.gate.admitted, true)
})

test("fake smoke keeps the admitted gate contract", async () => {
    const observed = { harnesses: [], cleaned: [], runtimeHarnesses: [], batches: [] }
    const report = await workload.runMultiHubLoadWorkload({
        profile: SMOKE_MULTI_PROFILE,
        ...fakeDependencies(observed),
    })
    assert.equal(report.gate.admitted, true)
    assert.deepEqual(report.steps[0].rooms, {
        attempted: 1,
        completed: 1,
        hostOwned: 1,
        clientOwned: 0,
    })
})

test("runCli writes identical JSON and returns one for a rejected gate", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "multi-workload-cli-"))
    const outputPath = path.join(directory, "report.json")
    let stdout = ""
    try {
        const exitCode = await workload.runCli({
            argv: ["--output", outputPath],
            runWorkload: async () => ({ gate: { admitted: false }, reason: "finite" }),
            writeStdout: value => { stdout += value },
        })
        assert.equal(exitCode, 1)
        assert.equal(fs.readFileSync(outputPath, "utf8"), stdout)
        assert.deepEqual(JSON.parse(stdout), { gate: { admitted: false }, reason: "finite" })
    } finally {
        fs.rmSync(directory, { recursive: true, force: true })
    }
})

test("runCli defaults to smoke and returns zero for its admitted gate", async () => {
    let observedProfile
    let stdout = ""
    const exitCode = await workload.runCli({
        argv: [],
        runWorkload: async ({ profile }) => {
            observedProfile = profile
            return { gate: { admitted: true }, profile }
        },
        writeStdout: value => { stdout += value },
    })
    assert.equal(exitCode, 0)
    assert.deepEqual(observedProfile, {
        activeIdentities: 2,
        clientOwnedRooms: 0,
        concurrencySteps: [1],
        hostOwnedRooms: 1,
        totalRooms: 1,
    })
    assert.equal(JSON.parse(stdout).gate.admitted, true)
})

test("real locked smoke CLI writes only its admitted JSON report to stdout", {
    timeout: 180_000,
    skip: process.platform === "win32" ? "process signal coverage is POSIX-only" : false,
}, async t => {
    const owner = startOwnedProcess({
        command: process.execPath,
        args: [workloadPath],
        cwd: projectRoot,
        timeoutMs: 165_000,
    })
    t.after(() => owner.cleanup())
    let result
    try {
        result = await owner.result
    } finally {
        await owner.cleanup()
    }
    assert.equal(result.code, 0, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(result.stdout, `${JSON.stringify(report, null, 2)}\n`)
    assert.equal(report.profile.activeIdentities, 2)
    const step = report.steps[0]
    assert.deepEqual(step.rooms, { attempted: 1, completed: 1, hostOwned: 1, clientOwned: 0 })
    assert.deepEqual(step.players, { attempted: 2, completed: 2 })
    assert.deepEqual(step.coexistence, {
        attempted: 6,
        completed: 6,
        errors: 0,
        routes: { auth: 2, load: 2, mission: 2 },
    })
    assert.deepEqual(step.settlement, {
        duplicateFinishRejected: 2,
        activeQuestsAfter: 0,
        errors: 0,
    })
    assert.deepEqual(step.cleanup, {
        activePeers: 0,
        activeProcesses: 0,
        portsReleased: true,
        remainingRooms: 0,
        temporaryRootExists: false,
    })
    assert.equal(report.gate.admitted, true)
})

test("real step completes host-owned and client-owned rooms in one runtime", {
    timeout: 180_000,
    skip: process.platform === "win32" ? "process signal coverage is POSIX-only" : false,
}, async () => {
    const profile = {
        activeIdentities: 4,
        clientOwnedRooms: 1,
        concurrencySteps: [2],
        hostOwnedRooms: 1,
        totalRooms: 2,
    }
    const step = await workload.runMultiHubStep({ profile, concurrency: 2 })
    assert.deepEqual(step.rooms, { attempted: 2, completed: 2, hostOwned: 1, clientOwned: 1 })
    assert.equal(step.rooms.hostOwned + step.rooms.clientOwned, step.rooms.completed)
    assert.deepEqual(step.players, { attempted: 4, completed: 4 })
    assert.deepEqual(step.coexistence, { attempted: 6, completed: 6, errors: 0, routes: { auth: 2, load: 2, mission: 2 } })
    assert.deepEqual(step.settlement, { duplicateFinishRejected: 4, activeQuestsAfter: 0, errors: 0 })
    assert.deepEqual(step.behaviorSignatures, ["client", "host"].map(ownerSide => (
        createBehaviorSignature({
            ownerSide,
            hostRewarded: true,
            guestRewarded: true,
            duplicateFinishRejected: 2,
        })
    )).sort())
    assert.deepEqual(step.cleanup, { activePeers: 0, activeProcesses: 0, portsReleased: true, remainingRooms: 0, temporaryRootExists: false })
    assert.deepEqual(step.errors, [])
})
