#!/usr/bin/env node
"use strict"

const fs = require("node:fs")
const net = require("node:net")
const { performance } = require("node:perf_hooks")

const {
    MultiHubProcessHarness,
    reserveLoopbackPorts,
} = require("../../tests/helpers/multi-hub-process-harness")
const {
    FORMAL_MULTI_PROFILE,
    SMOKE_MULTI_PROFILE,
    createBehaviorSignature,
    createMultiHubAdmission,
} = require("./multi_hub_load_metrics.cjs")

const FIXED_TIME = "2024-08-14T12:00:00.000Z"
const DEFAULT_CLEANUP_TIMEOUT_MS = 30_000
const DEFAULT_RUNTIME_SETUP_TIMEOUT_MS = 120_000
const DEFAULT_PARTICIPANTS_TIMEOUT_MS = 120_000

function copyProfile(profile) {
    return {
        activeIdentities: profile.activeIdentities,
        clientOwnedRooms: profile.clientOwnedRooms,
        concurrencySteps: [...profile.concurrencySteps],
        hostOwnedRooms: profile.hostOwnedRooms,
        totalRooms: profile.totalRooms,
    }
}

function parseArgs(argv) {
    let formal = false
    let output = null
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index]
        if (argument === "--formal") {
            if (formal) throw new Error("--formal may only be specified once")
            formal = true
            continue
        }
        if (argument === "--output") {
            if (output !== null) throw new Error("--output may only be specified once")
            const value = argv[++index]
            if (value === undefined || value.startsWith("--")) {
                throw new Error("--output requires a path")
            }
            output = value
            continue
        }
        throw new Error(`unknown argument: ${argument}`)
    }
    return {
        formal,
        output,
        profile: copyProfile(formal ? FORMAL_MULTI_PROFILE : SMOKE_MULTI_PROFILE),
    }
}

function percentile(values, quantile) {
    if (values.length === 0) return 0
    const sorted = [...values].sort((left, right) => left - right)
    return sorted[Math.max(1, Math.ceil(sorted.length * quantile)) - 1]
}

function chunk(values, size) {
    if (!Number.isSafeInteger(size) || size <= 0) throw new TypeError("chunk size must be positive")
    const chunks = []
    for (let index = 0; index < values.length; index += size) {
        chunks.push(values.slice(index, index + size))
    }
    return chunks
}

function createScenarioPlan(profile) {
    return Array.from({ length: profile.totalRooms }, (_, scenarioIndex) => ({
        scenarioIndex,
        ownerSide: scenarioIndex < profile.hostOwnedRooms ? "host" : "client",
    }))
}

function finiteScenarioError(_error, scenarioIndex, stage) {
    const index = Number.isSafeInteger(scenarioIndex) && scenarioIndex >= 0
        ? scenarioIndex
        : "step"
    const safeStage = typeof stage === "string" && /^[a-z -]{1,48}$/.test(stage)
        ? stage
        : "scenario"
    return `scenario ${index} ${safeStage} failed`
}

function validateCleanupTimeout(cleanupTimeoutMs) {
    if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs <= 0) {
        throw new TypeError("cleanupTimeoutMs must be a positive safe integer")
    }
}

function validateTimeout(timeoutMs, name) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        throw new TypeError(`${name} must be a positive safe integer`)
    }
}

async function runWithinTimeout(task, timeoutMs, stage) {
    let timer
    const controller = new AbortController()
    const operation = Promise.resolve().then(() => task(controller.signal))
    try {
        return await Promise.race([
            operation,
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    const error = new Error(`${stage} timed out`)
                    reject(error)
                    controller.abort(error)
                }, timeoutMs)
            }),
        ])
    } finally {
        clearTimeout(timer)
    }
}

async function runCleanupWithinTimeout(task, timeoutMs) {
    let timer
    const operation = Promise.resolve().then(task)
    try {
        return await Promise.race([
            operation,
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    const timeout = new Error("harness cleanup timed out")
                    reject(new AggregateError(
                        [timeout],
                        "harness cleanup failed",
                        { cause: timeout },
                    ))
                }, timeoutMs)
            }),
        ])
    } finally {
        clearTimeout(timer)
    }
}

function throwIfAborted(signal) {
    signal?.throwIfAborted()
}

function remainingMs(deadline) {
    return Math.max(1, deadline - Date.now())
}

async function setupRealRuntime({ harness, signal, timeoutMs }) {
    const deadline = Date.now() + timeoutMs
    throwIfAborted(signal)
    harness.installRuntimeTables({ timeoutMs: remainingMs(deadline) })
    throwIfAborted(signal)
    const credential = harness.createCredential("multi-load-client", {
        timeoutMs: remainingMs(deadline),
    })
    throwIfAborted(signal)
    const [hostHttp, hubControl, hubTcp, clientHttp] = await reserveLoopbackPorts(4)
    throwIfAborted(signal)
    const host = { dataKey: "host", url: `http://127.0.0.1:${hostHttp}` }
    const client = { dataKey: "client-b", url: `http://127.0.0.1:${clientHttp}` }
    throwIfAborted(signal)
    const hostRuntime = harness.spawnRuntime("multi-load-host", {
        CN_LISTEN_PORT: String(hostHttp),
        DATA_DIR: harness.dataDir(host.dataKey),
        MULTI_HUB_HOST: "127.0.0.1",
        MULTI_HUB_PORT: String(hubControl),
        MULTI_MODE: "host",
        SESSION_HOST: "127.0.0.1",
        SESSION_PORT: String(hubTcp),
        SESSION_PUBLIC_HOST: "127.0.0.1",
    }, [hostHttp, hubControl, hubTcp])
    throwIfAborted(signal)
    const clientRuntime = harness.spawnRuntime("multi-load-client", {
        CN_LISTEN_PORT: String(clientHttp),
        DATA_DIR: harness.dataDir(client.dataKey),
        MULTI_HUB_TOKEN: credential.token,
        MULTI_HUB_URL: `http://127.0.0.1:${hubControl}/`,
        MULTI_MODE: "client",
    }, [clientHttp])
    throwIfAborted(signal)
    await Promise.all([
        harness.waitForHealth(host.url, hostRuntime, remainingMs(deadline), signal),
        harness.waitForHealth(client.url, clientRuntime, remainingMs(deadline), signal),
    ])
    throwIfAborted(signal)
    for (const node of [host, client]) {
        throwIfAborted(signal)
        const response = await harness.json(
            node.url,
            `/api/server/time?time=${encodeURIComponent(FIXED_TIME)}`,
            { signal },
        )
        throwIfAborted(signal)
        if (response.status !== 200) throw new Error("runtime time setup failed")
    }
    return { host, client, ports: [hostHttp, hubControl, hubTcp, clientHttp] }
}

function defaultScenarioDependencies() {
    const scenarios = require("./multi_hub_load_scenarios.cjs")
    return {
        participantsFactory: scenarios.createParticipants,
        batchRunner: scenarios.runScenarioBatch,
        activeQuestCounter: scenarios.countActiveQuests,
    }
}

function addCounters(target, source) {
    for (const key of Object.keys(target)) target[key] += source[key]
}

function finiteDuration(value) {
    if (!Number.isFinite(value) || value < 0) return 0
    return Math.min(value, Number.MAX_SAFE_INTEGER)
}

function listenOnce(port) {
    return new Promise((resolve, reject) => {
        const server = net.createServer()
        server.once("error", reject)
        server.listen({ host: "127.0.0.1", port }, () => {
            server.close(error => error ? reject(error) : resolve())
        })
    })
}

async function probeRealCleanup({ harness, ports, remainingRooms }) {
    const reservedPorts = [...new Set([
        ...ports,
        ...harness.processes.flatMap(runtime => runtime.ports ?? []),
    ])]
    let portsReleased = true
    try { await Promise.all(reservedPorts.map(listenOnce)) } catch { portsReleased = false }
    return {
        activePeers: harness.peers.filter(peer => !peer.closed).length,
        activeProcesses: harness.processes.filter(runtime => (
            runtime.child.exitCode === null && runtime.child.signalCode === null
        )).length,
        portsReleased,
        remainingRooms,
        temporaryRootExists: fs.existsSync(harness.root),
    }
}

async function runMultiHubStep(options) {
    const {
        profile,
        concurrency,
        cleanupTimeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
        runtimeSetupTimeoutMs = DEFAULT_RUNTIME_SETUP_TIMEOUT_MS,
        participantsTimeoutMs = DEFAULT_PARTICIPANTS_TIMEOUT_MS,
        harnessFactory = () => new MultiHubProcessHarness(),
        runtimeSetup = setupRealRuntime,
        cleanupProbe = probeRealCleanup,
    } = options
    validateCleanupTimeout(cleanupTimeoutMs)
    validateTimeout(runtimeSetupTimeoutMs, "runtimeSetupTimeoutMs")
    validateTimeout(participantsTimeoutMs, "participantsTimeoutMs")
    const defaults = options.participantsFactory && options.batchRunner
        ? {}
        : defaultScenarioDependencies()
    const participantsFactory = options.participantsFactory ?? defaults.participantsFactory
    const batchRunner = options.batchRunner ?? defaults.batchRunner
    const activeQuestCounter = options.activeQuestCounter ?? defaults.activeQuestCounter
    const harness = harnessFactory()
    const roomRecords = []
    const errors = []
    const coexistence = { attempted: 0, completed: 0, errors: 0, routes: { auth: 0, load: 0, mission: 0 } }
    let runtime = { ports: [] }
    let participants = null
    let remainingRooms = 0
    let activeQuestsAfter = 1
    let cleanup = {
        activePeers: 0,
        activeProcesses: 0,
        portsReleased: false,
        remainingRooms: 0,
        temporaryRootExists: true,
    }
    try {
        runtime = await runWithinTimeout(
            signal => runtimeSetup({
                harness,
                profile,
                concurrency,
                signal,
                timeoutMs: runtimeSetupTimeoutMs,
            }),
            runtimeSetupTimeoutMs,
            "runtime setup",
        )
        participants = await runWithinTimeout(
            signal => participantsFactory({
                harness,
                profile,
                runtime,
                signal,
                timeoutMs: participantsTimeoutMs,
            }),
            participantsTimeoutMs,
            "participant initialization",
        )
        for (const batch of chunk(participants.scenarios, concurrency)) {
            const result = await batchRunner({
                harness,
                runtime,
                scenarios: batch,
                spectators: participants.spectators,
            })
            roomRecords.push(...result.rooms)
            addCounters(coexistence.routes, result.coexistence.routes)
            coexistence.attempted += result.coexistence.attempted
            coexistence.completed += result.coexistence.completed
            coexistence.errors += result.coexistence.errors
            errors.push(...(result.coexistence.errorMessages ?? []))
        }
    } catch (error) {
        errors.push(finiteScenarioError(error, null, "setup"))
    } finally {
        remainingRooms = roomRecords.filter(record => record.remainingRoom === true).length
        try {
            if (participants === null || typeof activeQuestCounter !== "function") {
                throw new Error("active quest inspection unavailable")
            }
            const counted = activeQuestCounter({ harness, participants })
            if (!Number.isSafeInteger(counted) || counted < 0) {
                throw new Error("active quest inspection invalid")
            }
            activeQuestsAfter = counted
        } catch {
            activeQuestsAfter = 1
            errors.push(finiteScenarioError(null, null, "active quest inspection"))
        }
        try {
            await runCleanupWithinTimeout(() => harness.cleanup(), cleanupTimeoutMs)
        } catch (error) {
            errors.push(finiteScenarioError(error, null, "cleanup"))
        }
        try {
            cleanup = await cleanupProbe({ harness, ports: runtime.ports ?? [], remainingRooms })
        } catch (error) {
            errors.push(finiteScenarioError(error, null, "cleanup probe"))
        }
    }

    const completed = roomRecords.filter(record => record.outcome)
    const failed = roomRecords.filter(record => !record.outcome)
    const completedOwners = {
        host: completed.filter(record => record.outcome.ownerSide === "host").length,
        client: completed.filter(record => record.outcome.ownerSide === "client").length,
    }
    errors.push(...failed.map(record => finiteScenarioError(
        record.error,
        record.scenarioIndex,
        record.stage ?? "scenario",
    )))
    const signatures = [...new Set(completed.map(record => createBehaviorSignature(record.outcome)))].sort()
    const latencies = completed.map(record => finiteDuration(record.durationMs))
    return {
        concurrency,
        rooms: {
            attempted: profile.totalRooms,
            completed: completed.length,
            hostOwned: completedOwners.host,
            clientOwned: completedOwners.client,
        },
        players: { attempted: profile.activeIdentities, completed: completed.length * 2 },
        coexistence,
        settlement: {
            duplicateFinishRejected: completed.reduce((sum, record) => (
                sum + record.outcome.duplicateFinishRejected
            ), 0),
            activeQuestsAfter,
            errors: failed.length,
        },
        cleanup,
        behaviorSignatures: signatures,
        latencyMs: {
            p50: percentile(latencies, 0.5),
            p95: percentile(latencies, 0.95),
            p99: percentile(latencies, 0.99),
        },
        errors,
    }
}

async function runMultiHubLoadWorkload(options = {}) {
    const profile = copyProfile(options.profile ?? SMOKE_MULTI_PROFILE)
    const steps = []
    for (const concurrency of profile.concurrencySteps) {
        steps.push(await runMultiHubStep({ ...options, profile, concurrency }))
    }
    const core = { schemaVersion: 1, profile, steps }
    return { ...core, gate: createMultiHubAdmission(core) }
}

async function runCli({
    argv = process.argv.slice(2),
    runWorkload = runMultiHubLoadWorkload,
    writeStdout = value => process.stdout.write(value),
} = {}) {
    const options = parseArgs(argv)
    const report = await runWorkload({ profile: options.profile })
    const output = `${JSON.stringify(report, null, 2)}\n`
    if (options.output) fs.writeFileSync(options.output, output, "utf8")
    writeStdout(output)
    return report.gate?.admitted === true ? 0 : 1
}

if (require.main === module) {
    runCli().then(code => { process.exitCode = code }).catch(() => {
        process.stderr.write("multi-hub load workload failed\n")
        process.exitCode = 1
    })
}

module.exports = {
    DEFAULT_CLEANUP_TIMEOUT_MS,
    DEFAULT_PARTICIPANTS_TIMEOUT_MS,
    DEFAULT_RUNTIME_SETUP_TIMEOUT_MS,
    FIXED_TIME,
    chunk,
    createScenarioPlan,
    finiteScenarioError,
    parseArgs,
    percentile,
    runCli,
    runMultiHubLoadWorkload,
    runMultiHubStep,
}
