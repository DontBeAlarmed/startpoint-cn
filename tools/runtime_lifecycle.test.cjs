"use strict"

const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const net = require("node:net")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    createRuntimeCoordinator,
    startupExitCode,
} = require("../src/runtime/lifecycle")
const { createMultiRuntimeService } = require("../src/multi/runtime/service")

function deferred() {
    let resolve
    let reject
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, reject, resolve }
}

test("host multiplayer startup failure is degraded and does not block core readiness", async () => {
    const hostConfig = {
        http: { host: "127.0.0.1", port: 18001 },
        multi: {
            mode: "host",
            tcp: { host: "127.0.0.1", port: 18003, publicHost: "hub.internal" },
            hub: { host: "127.0.0.1", port: 18004 },
            credentialsPath: path.join(os.tmpdir(), "unused-host-credentials.json"),
        },
        assetProvider: { mode: "client-owned" },
    }
    const harness = createHarness({
        loadConfig() {
            harness.calls.push("config")
            return hostConfig
        },
        async startMulti() {
            harness.calls.push("multi-start-failure")
            harness.setMultiStatus({
                mode: "host",
                state: "degraded",
                coordinator: { kind: "local", available: true },
                hub: { available: false, endpoint: "http://127.0.0.1:18004" },
                tcp: { available: false, endpoint: "hub.internal:18003" },
            })
            throw Object.assign(new Error("Hub unavailable"), { code: "EADDRINUSE" })
        },
    })

    await harness.coordinator.start()

    assert.equal(harness.coordinator.getPhase(), "ready")
    const health = harness.coordinator.getHealthSnapshot()
    assert.equal(health.statusCode, 200)
    assert.equal(health.body.status, "ready")
    assert.equal(health.body.services.tcp, false)
    assert.equal(health.body.multiplayer.state, "degraded")
    assert.deepEqual(harness.exitCodes, [])
    await harness.coordinator.stop()
})

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject)
            resolve()
        })
    })
}

function closeServer(server) {
    if (!server.listening) return Promise.resolve()
    return new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
    })
}

test("occupied embedded SESSION_PORT remains fatal with TCP exit 14", async t => {
    const blocker = net.createServer()
    await listen(blocker)
    t.after(() => closeServer(blocker))
    const address = blocker.address()
    assert.ok(address && typeof address === "object")

    const multiService = createMultiRuntimeService()
    const embeddedConfig = {
        http: { host: "127.0.0.1", port: 18001 },
        multi: {
            mode: "embedded",
            tcp: { host: "127.0.0.1", port: address.port },
        },
        assetProvider: { mode: "client-owned" },
    }
    const harness = createHarness({
        loadConfig() {
            harness.calls.push("config")
            return embeddedConfig
        },
        startMulti: config => multiService.start(config.multi),
        stopMulti: () => multiService.stop(),
        getMultiStatus: () => multiService.getStatus(),
    })
    t.after(() => harness.coordinator.stop())

    await harness.coordinator.start()

    assert.equal(harness.coordinator.getPhase(), "failed")
    assert.deepEqual(harness.exitCodes, [14])
    const health = harness.coordinator.getHealthSnapshot()
    assert.equal(health.statusCode, 503)
    assert.equal(health.body.status, "failed")
    assert.equal(health.body.services.tcp, false)
    assert.equal(harness.calls.some(call => Array.isArray(call) && call[0] === "http-listen"), false)
})

function createHarness(overrides = {}) {
    const calls = []
    const exitCodes = []
    const processTarget = new EventEmitter()
    let httpListening = false
    let multiStatus = {
        mode: "embedded",
        state: "unavailable",
        coordinator: { kind: "local", available: false },
        hub: null,
        tcp: { available: false, endpoint: "127.0.0.1:18003" },
    }
    const config = {
        http: { host: "127.0.0.1", port: 18001 },
        multi: {
            mode: "embedded",
            tcp: { host: "127.0.0.1", port: 18003 },
        },
        assetProvider: { mode: "client-owned" },
    }
    const dependencies = {
        loadConfig() { calls.push("config"); return config },
        configureHttp(value) { calls.push(["configure-http", value]) },
        initializeDatabase() { calls.push("database") },
        restoreTimeOffset() { calls.push("time") },
        async initializeContent(value) { calls.push(["content", value.assetProvider.mode]) },
        async readyHttp() { calls.push("http-ready") },
        async listenHttp(value) {
            calls.push(["http-listen", value.http])
            httpListening = true
        },
        async closeHttp() { calls.push("http-close"); httpListening = false },
        async startMulti(value) {
            calls.push(["multi-start", value.multi])
            multiStatus = {
                mode: "embedded",
                state: "ready",
                coordinator: { kind: "local", available: true },
                hub: null,
                tcp: { available: true, endpoint: "127.0.0.1:18003" },
            }
        },
        async stopMulti() {
            calls.push("multi-stop")
            multiStatus = {
                ...multiStatus,
                state: "unavailable",
                coordinator: { ...multiStatus.coordinator, available: false },
                tcp: { ...multiStatus.tcp, available: false },
            }
        },
        async forceCloseHttp() { calls.push("http-force-close"); httpListening = false },
        checkpointDatabase() { calls.push("checkpoint") },
        closeDatabase() { calls.push("database-close") },
        getDatabaseHealth() { return { ready: true, schema: 4 } },
        isHttpListening() { return httpListening },
        getMultiStatus() { return multiStatus },
        processTarget,
        setExitCode(code) { exitCodes.push(code) },
        bundleVersion: "1.0.1",
        bundleId: "sha256:test-bundle",
        nodeVersion: "v20.12.0",
        adminAvailable: true,
        shutdownStepTimeoutMs: 25,
        reportShutdownFailures(failures) { calls.push(["shutdown-failures", failures]) },
        ...overrides,
    }
    return {
        calls,
        config,
        coordinator: createRuntimeCoordinator(dependencies),
        exitCodes,
        processTarget,
        setMultiStatus(value) { multiStatus = value },
    }
}

test("successful startup follows the embedded contract order", async () => {
    const harness = createHarness()

    await harness.coordinator.start()

    assert.deepEqual(harness.calls, [
        "config",
        "database",
        "time",
        ["content", "client-owned"],
        ["multi-start", harness.config.multi],
        ["configure-http", harness.config],
        "http-ready",
        ["http-listen", harness.config.http],
    ])
    assert.equal(harness.coordinator.getPhase(), "ready")
    assert.equal(harness.coordinator.getHealthSnapshot().statusCode, 200)
    assert.deepEqual(harness.exitCodes, [])
    assert.equal(harness.processTarget.listenerCount("SIGTERM"), 1)
    assert.equal(harness.processTarget.listenerCount("SIGINT"), 1)

    await harness.coordinator.stop()
})

test("startup error classes retain stable exit codes including reserved runtime pack", () => {
    assert.equal(startupExitCode("config"), 10)
    assert.equal(startupExitCode("runtime-pack"), 11)
    assert.equal(startupExitCode("database"), 12)
    assert.equal(startupExitCode("http"), 13)
    assert.equal(startupExitCode("tcp"), 14)
    assert.equal(startupExitCode("multi"), 14)
    assert.equal(startupExitCode("content"), 15)
    assert.equal(startupExitCode("unknown"), 1)
})

for (const scenario of [
    { name: "config", method: "loadConfig", code: 10, cleanup: [] },
    { name: "database", method: "initializeDatabase", code: 12, cleanup: [], noHttpAttempt: true },
    { name: "database restore", method: "restoreTimeOffset", code: 12, cleanup: ["checkpoint", "database-close"], noHttpAttempt: true },
    { name: "content", method: "initializeContent", code: 15, cleanup: ["checkpoint", "database-close"], noHttpAttempt: true },
    { name: "HTTP configure", method: "configureHttp", code: 13, cleanup: ["http-close", "multi-stop", "checkpoint", "database-close"] },
    { name: "HTTP ready", method: "readyHttp", code: 13, cleanup: ["http-close", "multi-stop", "checkpoint", "database-close"] },
    { name: "HTTP", method: "listenHttp", code: 13, cleanup: ["http-close", "multi-stop", "checkpoint", "database-close"] },
]) {
    test(`${scenario.name} startup failure maps its exit code and cleans up in reverse order`, async () => {
        const harness = createHarness({
            [scenario.method]() {
                harness.calls.push(`${scenario.name}-failure`)
                throw new Error("sensitive startup error")
            },
        })

        await harness.coordinator.start()

        assert.equal(harness.coordinator.getPhase(), "failed")
        assert.deepEqual(harness.exitCodes, [scenario.code])
        const cleanupCalls = harness.calls.filter(call => [
            "multi-stop",
            "http-close",
            "http-force-close",
            "checkpoint",
            "database-close",
        ].includes(call))
        assert.deepEqual(cleanupCalls, scenario.cleanup)
        if (scenario.noHttpAttempt) {
            assert.equal(harness.calls.some(call => (
                Array.isArray(call) && call[0] === "configure-http"
            )), false)
        }
        assert.equal(harness.processTarget.listenerCount("SIGTERM"), 0)
        assert.equal(harness.processTarget.listenerCount("SIGINT"), 0)
    })
}

test("crossed and repeated signals reuse one stop promise and close once", async () => {
    const gate = deferred()
    const harness = createHarness({
        closeHttp() {
            harness.calls.push("http-close")
            return gate.promise
        },
    })
    await harness.coordinator.start()
    harness.calls.length = 0

    harness.processTarget.emit("SIGTERM")
    const first = harness.coordinator.stop()
    harness.processTarget.emit("SIGINT")
    const second = harness.coordinator.stop()

    assert.equal(harness.coordinator.getPhase(), "stopping")
    assert.equal(first, second)
    await Promise.resolve()
    assert.deepEqual(harness.calls, ["http-close"])
    gate.resolve()
    await first

    assert.deepEqual(harness.calls, ["http-close", "multi-stop", "checkpoint", "database-close"])
    assert.deepEqual(harness.exitCodes, [0])
    assert.equal(harness.coordinator.getPhase(), "stopped")
    assert.equal(harness.processTarget.listenerCount("SIGTERM"), 0)
    assert.equal(harness.processTarget.listenerCount("SIGINT"), 0)
})

test("checkpoint failure still closes the database and remains a terminal failure", async () => {
    const harness = createHarness({
        checkpointDatabase() {
            harness.calls.push("checkpoint")
            throw new Error("checkpoint failed")
        },
    })
    await harness.coordinator.start()
    harness.calls.length = 0

    harness.processTarget.emit("SIGINT")
    await harness.coordinator.stop()

    assert.deepEqual(harness.calls, [
        "http-close",
        "multi-stop",
        "checkpoint",
        "database-close",
        ["shutdown-failures", [{ step: "database-checkpoint", code: null }]],
    ])
    assert.deepEqual(harness.exitCodes, [1])
    assert.equal(harness.coordinator.getPhase(), "failed")

    const callsAfterFailure = [...harness.calls]
    await harness.coordinator.stop()
    assert.deepEqual(harness.calls, callsAfterFailure)
    assert.deepEqual(harness.exitCodes, [1])
    assert.equal(harness.coordinator.getPhase(), "failed")
})

test("shutdown collects safe errors, continues every step, and permits retry", async () => {
    let fail = true
    const harness = createHarness({
        closeHttp() {
            harness.calls.push("http-close")
            if (fail) throw Object.assign(new Error("/private/http detail"), { code: "E_HTTP_CLOSE" })
        },
        forceCloseHttp() {
            harness.calls.push("http-force-close")
            if (fail) throw new Error("/private/force detail")
        },
        stopMulti() {
            harness.calls.push("multi-stop")
            if (fail) throw Object.assign(new Error("multi detail"), { code: "E_MULTI_STOP" })
        },
        checkpointDatabase() {
            harness.calls.push("checkpoint")
            if (fail) throw new Error("checkpoint detail")
        },
        closeDatabase() {
            harness.calls.push("database-close")
            if (fail) throw Object.assign(new Error("db detail"), { code: "E_DB_CLOSE" })
        },
    })
    await harness.coordinator.start()
    harness.calls.length = 0

    harness.processTarget.emit("SIGTERM")
    await harness.coordinator.stop()

    assert.deepEqual(harness.calls, [
        "http-close",
        "http-force-close",
        "multi-stop",
        "checkpoint",
        "database-close",
        ["shutdown-failures", [
            { step: "http-close", code: "E_HTTP_CLOSE" },
            { step: "http-force-close", code: null },
            { step: "multi-stop", code: "E_MULTI_STOP" },
            { step: "database-checkpoint", code: null },
            { step: "database-close", code: "E_DB_CLOSE" },
        ]],
    ])
    assert.doesNotMatch(JSON.stringify(harness.calls), /private|detail/)
    assert.deepEqual(harness.exitCodes, [1])
    assert.equal(harness.coordinator.getPhase(), "failed")

    fail = false
    harness.calls.length = 0
    await harness.coordinator.stop()
    assert.deepEqual(harness.calls, ["http-close", "multi-stop", "checkpoint", "database-close"])
    assert.deepEqual(harness.exitCodes, [1, 1])
    assert.equal(harness.coordinator.getPhase(), "failed")

    await harness.coordinator.stop()
    assert.deepEqual(harness.exitCodes, [1, 1])
})

test("a signal during startup switches phase immediately and prevents later stages", async () => {
    const content = deferred()
    const harness = createHarness({
        initializeContent() {
            harness.calls.push("content")
            return content.promise
        },
    })
    const starting = harness.coordinator.start()

    harness.processTarget.emit("SIGTERM")
    assert.equal(harness.coordinator.getPhase(), "stopping")
    content.resolve()
    await Promise.all([starting, harness.coordinator.stop()])

    assert.equal(harness.calls.includes("http-ready"), false)
    assert.deepEqual(harness.calls.slice(-2), ["checkpoint", "database-close"])
    assert.deepEqual(harness.exitCodes, [0])
})

test("a signal during multiplayer startup stops it before later startup stages", async () => {
    const multi = deferred()
    const harness = createHarness({
        startMulti() {
            harness.calls.push("multi-start")
            return multi.promise
        },
    })
    const starting = harness.coordinator.start()
    for (let attempt = 0; attempt < 20 && !harness.calls.includes("multi-start"); attempt++) {
        await new Promise(resolve => setImmediate(resolve))
    }
    assert.equal(harness.calls.includes("multi-start"), true)
    harness.calls.length = 0

    harness.processTarget.emit("SIGTERM")

    assert.equal(harness.coordinator.getPhase(), "stopping")
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(harness.calls, ["multi-stop"])
    multi.resolve()
    await Promise.all([starting, harness.coordinator.stop()])
    assert.deepEqual(harness.calls, ["multi-stop", "checkpoint", "database-close"])
})

test("partial signal listener registration failure rolls back and maps unknown exit 1", async () => {
    const processTarget = new EventEmitter()
    const originalOn = processTarget.on.bind(processTarget)
    processTarget.on = (event, listener) => {
        if (event === "SIGTERM") throw new Error("registration failed")
        return originalOn(event, listener)
    }
    const harness = createHarness({ processTarget })

    await harness.coordinator.start()

    assert.equal(harness.coordinator.getPhase(), "failed")
    assert.deepEqual(harness.exitCodes, [1])
    assert.equal(processTarget.listenerCount("SIGINT"), 0)
    assert.equal(processTarget.listenerCount("SIGTERM"), 0)
})

test("stop before start is inert and one later start registers listeners normally", async () => {
    const harness = createHarness()

    await harness.coordinator.stop()
    assert.equal(harness.coordinator.getPhase(), "stopped")
    assert.deepEqual(harness.calls, [])
    assert.deepEqual(harness.exitCodes, [])
    assert.equal(harness.processTarget.listenerCount("SIGINT"), 0)
    assert.equal(harness.processTarget.listenerCount("SIGTERM"), 0)

    await harness.coordinator.start()
    assert.equal(harness.coordinator.getPhase(), "ready")
    assert.equal(harness.processTarget.listenerCount("SIGINT"), 1)
    assert.equal(harness.processTarget.listenerCount("SIGTERM"), 1)
    assert.equal(harness.coordinator.start(), harness.coordinator.start())
    await harness.coordinator.stop()
})

test("HTTP close timeout is unrefed, force-closes, and cannot block later cleanup", async () => {
    let timeoutUnrefed = false
    let blocked = true
    const closeNever = deferred()
    const forceNever = deferred()
    const originalSetTimeout = global.setTimeout
    const keepAlive = originalSetTimeout(() => {}, 1_000)
    global.setTimeout = (callback, delay, ...args) => {
        const timer = originalSetTimeout(callback, delay, ...args)
        const originalUnref = timer.unref.bind(timer)
        timer.unref = () => {
            timeoutUnrefed = true
            return originalUnref()
        }
        return timer
    }
    const harness = createHarness({
        shutdownStepTimeoutMs: 5,
        closeHttp() {
            harness.calls.push("http-close")
            return blocked ? closeNever.promise : undefined
        },
        forceCloseHttp() {
            harness.calls.push("http-force-close")
            return blocked ? forceNever.promise : undefined
        },
    })
    try {
        await harness.coordinator.start()
        harness.calls.length = 0

        harness.processTarget.emit("SIGTERM")
        await harness.coordinator.stop()

        assert.equal(timeoutUnrefed, true)
        assert.deepEqual(harness.calls, [
            "http-close",
            "http-force-close",
            "multi-stop",
            "checkpoint",
            "database-close",
            ["shutdown-failures", [
                { step: "http-close", code: "TIMEOUT" },
                { step: "http-force-close", code: "TIMEOUT" },
            ]],
        ])
        assert.equal(harness.coordinator.getPhase(), "failed")
        assert.deepEqual(harness.exitCodes, [1])

        blocked = false
        harness.calls.length = 0
        await harness.coordinator.stop()
        assert.deepEqual(harness.calls, ["http-close"])
        assert.equal(harness.coordinator.getPhase(), "failed")
        assert.deepEqual(harness.exitCodes, [1, 1])
    } finally {
        global.setTimeout = originalSetTimeout
        clearTimeout(keepAlive)
        closeNever.resolve()
        forceNever.resolve()
    }
})

test("multiplayer stop timeout is unrefed, continues database cleanup, and stays failed after late settlement", async () => {
    let timeoutUnrefed = false
    const stopNever = deferred()
    const originalSetTimeout = global.setTimeout
    const keepAlive = originalSetTimeout(() => {}, 1_000)
    global.setTimeout = (callback, delay, ...args) => {
        const timer = originalSetTimeout(callback, delay, ...args)
        const originalUnref = timer.unref.bind(timer)
        timer.unref = () => {
            timeoutUnrefed = true
            return originalUnref()
        }
        return timer
    }
    const harness = createHarness({
        shutdownStepTimeoutMs: 5,
        stopMulti() {
            harness.calls.push("multi-stop")
            return stopNever.promise
        },
    })
    try {
        await harness.coordinator.start()
        harness.calls.length = 0

        harness.processTarget.emit("SIGTERM")
        await harness.coordinator.stop()

        assert.equal(timeoutUnrefed, true)
        assert.deepEqual(harness.calls, [
            "http-close",
            "multi-stop",
            "checkpoint",
            "database-close",
            ["shutdown-failures", [{ step: "multi-stop", code: "TIMEOUT" }]],
        ])
        assert.deepEqual(harness.exitCodes, [1])
        assert.equal(harness.coordinator.getPhase(), "failed")

        stopNever.resolve()
        await new Promise(resolve => setImmediate(resolve))
        assert.deepEqual(harness.exitCodes, [1])
        assert.equal(harness.coordinator.getPhase(), "failed")

        harness.calls.length = 0
        await harness.coordinator.stop()
        assert.deepEqual(harness.calls, ["multi-stop"])
        assert.deepEqual(harness.exitCodes, [1, 1])
        assert.equal(harness.coordinator.getPhase(), "failed")

        await harness.coordinator.stop()
        assert.deepEqual(harness.calls, ["multi-stop"])
        assert.deepEqual(harness.exitCodes, [1, 1])
    } finally {
        global.setTimeout = originalSetTimeout
        clearTimeout(keepAlive)
        stopNever.resolve()
    }
})

test("degraded multiplayer status never turns a ready core into a fatal runtime", async () => {
    const harness = createHarness()
    await harness.coordinator.start()
    harness.calls.length = 0
    harness.setMultiStatus({
        mode: "host",
        state: "degraded",
        coordinator: { kind: "local", available: true },
        hub: { available: false, endpoint: "http://0.0.0.0:8004" },
        tcp: { available: false, endpoint: "192.0.2.20:8003" },
    })

    const health = harness.coordinator.getHealthSnapshot()

    assert.equal(health.statusCode, 200)
    assert.equal(health.body.status, "ready")
    assert.equal(health.body.multiplayer.state, "degraded")
    assert.equal(health.body.services.tcp, false)
    assert.equal(harness.coordinator.getPhase(), "ready")
    assert.deepEqual(harness.exitCodes, [])
    await harness.coordinator.stop()
})
