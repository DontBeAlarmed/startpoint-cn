"use strict"

const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    createRuntimeCoordinator,
    startupExitCode,
} = require("../src/runtime/lifecycle")

function deferred() {
    let resolve
    let reject
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, reject, resolve }
}

function createHarness(overrides = {}) {
    const calls = []
    const exitCodes = []
    const processTarget = new EventEmitter()
    let httpListening = false
    let tcpListening = false
    let tcpFatalHandler = null
    const config = {
        http: { host: "127.0.0.1", port: 18001 },
        tcp: { host: "127.0.0.1", port: 18003 },
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
        async startTcp(value, onFatalError) {
            calls.push(["tcp-start", value.tcp])
            tcpFatalHandler = onFatalError
            tcpListening = true
        },
        async stopTcp() { calls.push("tcp-stop"); tcpListening = false },
        async forceCloseHttp() { calls.push("http-force-close"); httpListening = false },
        checkpointDatabase() { calls.push("checkpoint") },
        closeDatabase() { calls.push("database-close") },
        getDatabaseHealth() { return { ready: true, schema: 4 } },
        isHttpListening() { return httpListening },
        isTcpListening() { return tcpListening },
        processTarget,
        setExitCode(code) { exitCodes.push(code) },
        bundleVersion: "1.0.1",
        bundleId: "sha256:test-bundle",
        nodeVersion: "v20.12.0",
        adminAvailable: false,
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
        setTcpListening(value) { tcpListening = value },
        triggerTcpFatal(failure = { stage: "runtime", code: "E_RUNTIME_TEST" }) {
            assert.equal(typeof tcpFatalHandler, "function")
            tcpListening = false
            tcpFatalHandler(failure)
        },
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
        ["configure-http", harness.config],
        "http-ready",
        ["http-listen", harness.config.http],
        ["tcp-start", harness.config.tcp],
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
    assert.equal(startupExitCode("content"), 15)
    assert.equal(startupExitCode("unknown"), 1)
})

for (const scenario of [
    { name: "config", method: "loadConfig", code: 10, cleanup: [] },
    { name: "database", method: "initializeDatabase", code: 12, cleanup: [], noHttpAttempt: true },
    { name: "database restore", method: "restoreTimeOffset", code: 12, cleanup: ["checkpoint", "database-close"], noHttpAttempt: true },
    { name: "content", method: "initializeContent", code: 15, cleanup: ["checkpoint", "database-close"], noHttpAttempt: true },
    { name: "HTTP configure", method: "configureHttp", code: 13, cleanup: ["http-close", "checkpoint", "database-close"] },
    { name: "HTTP ready", method: "readyHttp", code: 13, cleanup: ["http-close", "checkpoint", "database-close"] },
    { name: "HTTP", method: "listenHttp", code: 13, cleanup: ["http-close", "checkpoint", "database-close"] },
    { name: "TCP", method: "startTcp", code: 14, cleanup: ["tcp-stop", "http-close", "checkpoint", "database-close"] },
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
            "tcp-stop",
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

    assert.deepEqual(harness.calls, ["http-close", "tcp-stop", "checkpoint", "database-close"])
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
        "tcp-stop",
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
        stopTcp() {
            harness.calls.push("tcp-stop")
            if (fail) throw Object.assign(new Error("tcp detail"), { code: "E_TCP_STOP" })
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
        "tcp-stop",
        "checkpoint",
        "database-close",
        ["shutdown-failures", [
            { step: "http-close", code: "E_HTTP_CLOSE" },
            { step: "http-force-close", code: null },
            { step: "tcp-stop", code: "E_TCP_STOP" },
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
    assert.deepEqual(harness.calls, ["http-close", "tcp-stop", "checkpoint", "database-close"])
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

test("a signal during TCP startup starts closing HTTP before TCP startup settles", async () => {
    const tcp = deferred()
    const harness = createHarness({
        startTcp() {
            harness.calls.push("tcp-start")
            return tcp.promise
        },
    })
    const starting = harness.coordinator.start()
    for (let attempt = 0; attempt < 20 && !harness.calls.includes("tcp-start"); attempt++) {
        await new Promise(resolve => setImmediate(resolve))
    }
    assert.equal(harness.calls.includes("tcp-start"), true)
    harness.calls.length = 0

    harness.processTarget.emit("SIGTERM")

    assert.equal(harness.coordinator.getPhase(), "stopping")
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(harness.calls, ["http-close", "tcp-stop"])
    tcp.resolve()
    await Promise.all([starting, harness.coordinator.stop()])
    assert.deepEqual(harness.calls, ["http-close", "tcp-stop", "checkpoint", "database-close"])
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
            "tcp-stop",
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

test("TCP stop timeout is unrefed, continues database cleanup, and stays failed after late settlement", async () => {
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
        stopTcp() {
            harness.calls.push("tcp-stop")
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
            "tcp-stop",
            "checkpoint",
            "database-close",
            ["shutdown-failures", [{ step: "tcp-stop", code: "TIMEOUT" }]],
        ])
        assert.deepEqual(harness.exitCodes, [1])
        assert.equal(harness.coordinator.getPhase(), "failed")

        stopNever.resolve()
        await new Promise(resolve => setImmediate(resolve))
        assert.deepEqual(harness.exitCodes, [1])
        assert.equal(harness.coordinator.getPhase(), "failed")

        harness.calls.length = 0
        await harness.coordinator.stop()
        assert.deepEqual(harness.calls, ["tcp-stop"])
        assert.deepEqual(harness.exitCodes, [1, 1])
        assert.equal(harness.coordinator.getPhase(), "failed")

        await harness.coordinator.stop()
        assert.deepEqual(harness.calls, ["tcp-stop"])
        assert.deepEqual(harness.exitCodes, [1, 1])
    } finally {
        global.setTimeout = originalSetTimeout
        clearTimeout(keepAlive)
        stopNever.resolve()
    }
})

test("TCP runtime fatal immediately fails health, preserves exit 14, and reuses app shutdown", async () => {
    const harness = createHarness()
    await harness.coordinator.start()
    harness.calls.length = 0

    harness.triggerTcpFatal()
    const firstStop = harness.coordinator.stop()
    const secondStop = harness.coordinator.stop()

    assert.equal(firstStop, secondStop)
    assert.equal(harness.coordinator.getPhase(), "failed")
    assert.equal(harness.coordinator.getHealthSnapshot().statusCode, 503)
    assert.deepEqual(harness.exitCodes, [14])
    await firstStop
    assert.deepEqual(harness.calls, ["http-close", "tcp-stop", "checkpoint", "database-close"])
    assert.equal(harness.coordinator.getPhase(), "failed")
    assert.deepEqual(harness.exitCodes, [14, 14])
})

test("TCP fatal cleanup retry preserves exit 14 until resources converge", async () => {
    let failTcpStop = true
    const harness = createHarness({
        stopTcp() {
            harness.calls.push("tcp-stop")
            if (failTcpStop) throw Object.assign(new Error("tcp detail"), { code: "E_TCP_STOP" })
        },
    })
    await harness.coordinator.start()
    harness.calls.length = 0

    harness.triggerTcpFatal()
    await harness.coordinator.stop()

    assert.equal(harness.coordinator.getPhase(), "failed")
    assert.deepEqual(harness.exitCodes, [14, 14])
    assert.deepEqual(harness.calls.at(-1), [
        "shutdown-failures",
        [{ step: "tcp-stop", code: "E_TCP_STOP" }],
    ])

    failTcpStop = false
    harness.calls.length = 0
    await harness.coordinator.stop()
    assert.deepEqual(harness.calls, ["tcp-stop"])
    assert.equal(harness.coordinator.getPhase(), "failed")
    assert.deepEqual(harness.exitCodes, [14, 14, 14])
})

test("health reconciles a ready coordinator with a non-listening TCP service", async () => {
    const harness = createHarness()
    await harness.coordinator.start()
    harness.calls.length = 0
    harness.setTcpListening(false)

    const health = harness.coordinator.getHealthSnapshot()

    assert.equal(health.statusCode, 503)
    assert.equal(health.body.status, "failed")
    assert.equal(harness.coordinator.getPhase(), "failed")
    assert.deepEqual(harness.exitCodes, [14])
    await harness.coordinator.stop()
})
