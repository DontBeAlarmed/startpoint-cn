const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    getSessionServerStatus,
    startSessionServer,
    stopSessionServer,
} = require("../src/multi/tcp/server")
const { sessionManager } = require("../src/multi/state/SessionManager")
const { DEFAULT_MULTI_BATTLE_TUNING } = require("../src/multi/runtime/tuning")
const {
    getReliableSendQueueStats,
    sendFrameReliably,
} = require("../src/multi/tcp/reliable-send")

const TRANSPORT_TUNING = Object.freeze({
    handshakeTimeoutMs: 40,
    maxFrameBytes: 1024,
    maxBufferBytes: 2048,
    keepAliveInitialDelayMs: 4321,
    sendQueueMaxMessages: 1,
    sendQueueMaxBytes: 1024,
    sendQueueMaxAgeMs: 30,
})
const BATTLE_TUNING = Object.freeze({ loadingLeaseMs: 70, heartbeatLeaseMs: 60 })

function transportTuning(overrides = {}) {
    return Object.freeze({ ...TRANSPORT_TUNING, ...overrides })
}

function waitFor(predicate, message, timeoutMs = 1_000) {
    const startedAt = Date.now()
    return new Promise((resolve, reject) => {
        const poll = () => {
            if (predicate()) {
                resolve()
                return
            }
            if (Date.now() - startedAt >= timeoutMs) {
                reject(new Error(message))
                return
            }
            setTimeout(poll, 5)
        }
        poll()
    })
}

class GuardrailSocket extends EventEmitter {
    constructor(writeResults = []) {
        super()
        this.destroyed = false
        this.destroyCalls = 0
        this.writable = true
        this.writableEnded = false
        this.noDelay = null
        this.keepAlive = null
        this.writeResults = [...writeResults]
        this.writes = []
    }

    setEncoding() {}

    setNoDelay(enabled) {
        this.noDelay = enabled
        return this
    }

    setKeepAlive(enabled, initialDelay) {
        this.keepAlive = { enabled, initialDelay }
        return this
    }

    write(frame) {
        this.writes.push(frame)
        return this.writeResults.length > 0 ? this.writeResults.shift() : true
    }

    pause() {
        return this
    }

    resume() {
        return this
    }

    destroy() {
        this.destroyCalls++
        if (this.destroyed) return this
        this.destroyed = true
        this.writable = false
        this.emit("close")
        return this
    }
}

class FakeServer extends EventEmitter {
    constructor(connectionListener) {
        super()
        this.connectionListener = connectionListener
        this.listening = false
    }

    listen(_port, _host, callback) {
        this.listening = true
        queueMicrotask(callback)
        return this
    }

    close(callback) {
        this.listening = false
        queueMicrotask(callback)
        return this
    }

    accept(socket) {
        this.connectionListener(socket)
    }
}

async function startFakeServer(options = {}) {
    let server
    await startSessionServer({
        handshakeTimeoutMs: 25,
        maxFrameBytes: 1024,
        maxBufferBytes: 2048,
        keepAliveInitialDelayMs: 10_000,
        ...options,
        createServer(connectionListener) {
            server = new FakeServer(connectionListener)
            return server
        },
    })
    return server
}

test.afterEach(async () => {
    await stopSessionServer()
    assert.equal(getSessionServerStatus().activeSockets, 0)
})

test("accepted sockets enable low-latency TCP settings", async () => {
    const server = await startFakeServer()
    const socket = new GuardrailSocket()

    server.accept(socket)

    assert.equal(socket.noDelay, true)
    assert.deepEqual(socket.keepAlive, { enabled: true, initialDelay: 10_000 })
})

test("transport tuning configures guardrails and reliable send for one server generation", async () => {
    let server
    await startSessionServer({
        transportTuning: TRANSPORT_TUNING,
        battleTuning: BATTLE_TUNING,
        createServer(connectionListener) {
            server = new FakeServer(connectionListener)
            return server
        },
    })
    assert.deepEqual(sessionManager.battleTuning, BATTLE_TUNING)
    assert.equal(Object.isFrozen(sessionManager.battleTuning), true)
    const accepted = new GuardrailSocket()
    const limitSlow = new GuardrailSocket([false])
    const activeSlow = new GuardrailSocket([false])

    server.accept(accepted)
    server.accept(activeSlow)
    assert.deepEqual(accepted.keepAlive, { enabled: true, initialDelay: 4321 })
    accepted.emit("data", "x".repeat(1025))
    assert.equal(accepted.destroyed, true)

    assert.equal(sendFrameReliably(limitSlow, "first\0"), "sent")
    assert.equal(sendFrameReliably(limitSlow, "second\0"), "queued")
    assert.deepEqual(getReliableSendQueueStats(limitSlow), {
        messages: 1,
        bytes: Buffer.byteLength("second\0"),
        blocked: true,
    })
    assert.equal(sendFrameReliably(limitSlow, "overflow\0"), "closed")
    const originalSetTimeout = global.setTimeout
    const originalClearTimeout = global.clearTimeout
    let backpressureTimer
    let backpressureTimerCleared = false
    global.setTimeout = (callback, delay, ...args) => {
        const timer = originalSetTimeout(callback, delay, ...args)
        if (backpressureTimer === undefined && delay <= TRANSPORT_TUNING.sendQueueMaxAgeMs) {
            backpressureTimer = timer
        }
        return timer
    }
    global.clearTimeout = timer => {
        if (timer === backpressureTimer) backpressureTimerCleared = true
        return originalClearTimeout(timer)
    }
    try {
        assert.equal(sendFrameReliably(activeSlow, "first\0"), "sent")
        assert.equal(sendFrameReliably(activeSlow, "second\0"), "queued")
        await stopSessionServer()
    } finally {
        global.setTimeout = originalSetTimeout
        global.clearTimeout = originalClearTimeout
    }
    assert.equal(sessionManager.battleTuning, DEFAULT_MULTI_BATTLE_TUNING)
    assert.deepEqual(getReliableSendQueueStats(activeSlow), {
        messages: 0,
        bytes: 0,
        blocked: false,
    })
    assert.ok(backpressureTimer)
    assert.equal(backpressureTimerCleared, true)
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(activeSlow.destroyCalls, 1)

    const afterStop = new GuardrailSocket([false])
    assert.equal(sendFrameReliably(afterStop, "first\0"), "sent")
    assert.equal(sendFrameReliably(afterStop, "second\0"), "queued")
    assert.equal(sendFrameReliably(afterStop, "third\0"), "queued")
    afterStop.destroy()

    let nextServer
    await startSessionServer({
        transportTuning: transportTuning({ sendQueueMaxMessages: 2 }),
        battleTuning: { loadingLeaseMs: 90, heartbeatLeaseMs: 80 },
        createServer(connectionListener) {
            nextServer = new FakeServer(connectionListener)
            return nextServer
        },
    })
    assert.deepEqual(sessionManager.battleTuning, {
        loadingLeaseMs: 90,
        heartbeatLeaseMs: 80,
    })
    const nextSlow = new GuardrailSocket([false])
    nextServer.accept(nextSlow)
    assert.equal(sendFrameReliably(nextSlow, "first\0"), "sent")
    assert.equal(sendFrameReliably(nextSlow, "second\0"), "queued")
    assert.equal(sendFrameReliably(nextSlow, "third\0"), "queued")
    assert.equal(sendFrameReliably(nextSlow, "overflow\0"), "closed")
})

test("explicit low-level guardrails override transport tuning", async () => {
    let releaseHandshake
    const pending = new Promise(resolve => { releaseHandshake = resolve })
    const server = await startFakeServer({
        transportTuning: transportTuning({
            handshakeTimeoutMs: 1.5,
            maxFrameBytes: 1023,
            maxBufferBytes: 1023,
            keepAliveInitialDelayMs: 0,
        }),
        maxFrameBytes: 1536,
        maxBufferBytes: 3072,
        async handleHandshake() {
            await pending
        },
    })
    const whitespace = new GuardrailSocket()
    const buffered = new GuardrailSocket()
    const idle = new GuardrailSocket()

    server.accept(whitespace)
    server.accept(buffered)
    server.accept(idle)
    assert.deepEqual(whitespace.keepAlive, { enabled: true, initialDelay: 10_000 })
    whitespace.emit("data", `${" ".repeat(1200)}\0`)
    buffered.emit("data", `${JSON.stringify({ socklet: "cooperation_room" })}\0`)
    buffered.emit("data", `${JSON.stringify([0, ["x".repeat(1150)]])}\0`)
    buffered.emit("data", `${JSON.stringify([0, ["y".repeat(1150)]])}\0`)

    assert.equal(whitespace.destroyed, false)
    assert.equal(buffered.destroyed, false)
    await waitFor(() => idle.destroyed, "explicit handshake timeout did not take priority")
    releaseHandshake()
    buffered.destroy()
})

test("invalid final transport values fail atomically before server creation", async () => {
    const invalidOptions = [
        { handshakeTimeoutMs: 0 },
        { handshakeTimeoutMs: 1.5 },
        { handshakeTimeoutMs: 2_147_483_648 },
        { maxFrameBytes: 1023 },
        { maxFrameBytes: Number.MAX_SAFE_INTEGER + 1 },
        { maxFrameBytes: 1024, maxBufferBytes: 1023 },
        { maxFrameBytes: 1024, maxBufferBytes: 2048.5 },
        { maxBufferBytes: Number.MAX_SAFE_INTEGER + 1 },
        { keepAliveInitialDelayMs: 0 },
        { keepAliveInitialDelayMs: 1.5 },
        { keepAliveInitialDelayMs: Number.MAX_SAFE_INTEGER + 1 },
        { transportTuning: transportTuning({ maxFrameBytes: 1023 }) },
        { transportTuning: transportTuning({ sendQueueMaxAgeMs: 2_147_483_648 }) },
        { battleTuning: { loadingLeaseMs: 0, heartbeatLeaseMs: 60 } },
        { battleTuning: { loadingLeaseMs: 70, heartbeatLeaseMs: 2_147_483_648 } },
        {
            transportTuning: TRANSPORT_TUNING,
            battleTuning: { loadingLeaseMs: 1.5, heartbeatLeaseMs: 60 },
        },
    ]

    for (const options of invalidOptions) {
        let createCalls = 0
        const result = await startSessionServer({
            ...options,
            createServer(connectionListener) {
                createCalls++
                return new FakeServer(connectionListener)
            },
        }).then(
            () => ({ status: "resolved" }),
            error => ({ status: "rejected", error }),
        )
        const phase = getSessionServerStatus().phase
        if (result.status === "resolved") await stopSessionServer()

        assert.equal(result.status, "rejected")
        assert.equal(result.error instanceof TypeError, true)
        assert.equal(createCalls, 0)
        assert.equal(phase, "failed")
        assert.equal(sessionManager.battleTuning, DEFAULT_MULTI_BATTLE_TUNING)
    }

    const socket = new GuardrailSocket([false])
    assert.equal(sendFrameReliably(socket, "first\0"), "sent")
    assert.equal(sendFrameReliably(socket, "second\0"), "queued")
    assert.equal(sendFrameReliably(socket, "third\0"), "queued")
    socket.destroy()
})

test("a failed server start restores default reliable send tuning", async () => {
    await assert.rejects(startSessionServer({
        transportTuning: TRANSPORT_TUNING,
        battleTuning: BATTLE_TUNING,
        createServer() {
            throw new Error("injected startup failure")
        },
    }), /injected startup failure/)
    assert.equal(sessionManager.battleTuning, DEFAULT_MULTI_BATTLE_TUNING)
    const socket = new GuardrailSocket([false])

    assert.equal(sendFrameReliably(socket, "first\0"), "sent")
    assert.equal(sendFrameReliably(socket, "second\0"), "queued")
    assert.equal(sendFrameReliably(socket, "third\0"), "queued")
    socket.destroy()
})

test("an asynchronous listen error restores default reliable send tuning", async () => {
    let failedServer
    const startPromise = startSessionServer({
        transportTuning: TRANSPORT_TUNING,
        battleTuning: BATTLE_TUNING,
        createServer(connectionListener) {
            failedServer = new FakeServer(connectionListener)
            failedServer.listen = function failListen() {
                queueMicrotask(() => this.emit("error", new Error("async listen failure")))
                return this
            }
            return failedServer
        },
    })

    await assert.rejects(startPromise, /async listen failure/)
    await waitFor(
        () => failedServer.listenerCount("error") === 0,
        "failed startup server retained its error listener",
    )
    assert.equal(sessionManager.battleTuning, DEFAULT_MULTI_BATTLE_TUNING)
    const socket = new GuardrailSocket([false])
    assert.equal(sendFrameReliably(socket, "first\0"), "sent")
    assert.equal(sendFrameReliably(socket, "second\0"), "queued")
    assert.equal(sendFrameReliably(socket, "third\0"), "queued")
    socket.destroy()
})

test("runtime fatal teardown clears active backpressure state and restores defaults", async () => {
    let server
    await startSessionServer({
        transportTuning: TRANSPORT_TUNING,
        battleTuning: BATTLE_TUNING,
        createServer(connectionListener) {
            server = new FakeServer(connectionListener)
            return server
        },
    })
    const active = new GuardrailSocket([false])
    server.accept(active)
    assert.equal(sendFrameReliably(active, "first\0"), "sent")
    assert.equal(sendFrameReliably(active, "second\0"), "queued")

    server.emit("error", new Error("runtime fatal failure"))
    await waitFor(
        () => !server.listening && server.listenerCount("error") === 0,
        "fatal teardown did not finish",
    )
    assert.equal(sessionManager.battleTuning, DEFAULT_MULTI_BATTLE_TUNING)
    assert.deepEqual(getReliableSendQueueStats(active), {
        messages: 0,
        bytes: 0,
        blocked: false,
    })
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(active.destroyCalls, 1)

    const afterFatal = new GuardrailSocket([false])
    assert.equal(sendFrameReliably(afterFatal, "first\0"), "sent")
    assert.equal(sendFrameReliably(afterFatal, "second\0"), "queued")
    assert.equal(sendFrameReliably(afterFatal, "third\0"), "queued")
    afterFatal.destroy()
})

test("a connection that never sends a handshake is retired", async () => {
    const server = await startFakeServer()
    const socket = new GuardrailSocket()

    server.accept(socket)
    await waitFor(() => socket.destroyed, "idle pre-handshake socket was not retired")
})

test("malformed JSON and a non-handshake first frame close only that socket", async () => {
    const server = await startFakeServer()
    const malformed = new GuardrailSocket()
    const wrongFirstFrame = new GuardrailSocket()
    const healthy = new GuardrailSocket()

    server.accept(malformed)
    server.accept(wrongFirstFrame)
    server.accept(healthy)
    malformed.emit("data", "not-json\0")
    wrongFirstFrame.emit("data", `${JSON.stringify([0, [0]])}\0`)

    assert.equal(malformed.destroyed, true)
    assert.equal(wrongFirstFrame.destroyed, true)
    assert.equal(healthy.destroyed, false)
})

test("oversized complete and unterminated frames are rejected", async () => {
    const server = await startFakeServer()
    const complete = new GuardrailSocket()
    const unterminated = new GuardrailSocket()

    server.accept(complete)
    server.accept(unterminated)
    complete.emit("data", `${JSON.stringify({ socklet: "x".repeat(1100) })}\0`)
    unterminated.emit("data", "x".repeat(1025))

    assert.equal(complete.destroyed, true)
    assert.equal(unterminated.destroyed, true)
})

test("the accumulated receive buffer is bounded while a handshake is pending", async () => {
    let releaseHandshake
    const pending = new Promise(resolve => { releaseHandshake = resolve })
    const server = await startFakeServer({
        async handleHandshake() {
            await pending
        },
    })
    const socket = new GuardrailSocket()

    server.accept(socket)
    socket.emit("data", `${JSON.stringify({ socklet: "cooperation_room" })}\0`)
    socket.emit("data", `${JSON.stringify([0, ["x".repeat(700)]])}\0`)
    socket.emit("data", `${JSON.stringify([0, ["y".repeat(700)]])}\0`)
    socket.emit("data", `${JSON.stringify([0, ["z".repeat(700)]])}\0`)

    assert.equal(socket.destroyed, true)
    releaseHandshake()
    await waitFor(
        () => getSessionServerStatus().pendingHandshakes === 0,
        "released handshake did not settle",
    )
})

test("frame size is enforced before whitespace skipping and while handshake work is pending", async () => {
    let releaseHandshake
    const pending = new Promise(resolve => { releaseHandshake = resolve })
    const server = await startFakeServer({
        async handleHandshake() {
            await pending
        },
    })
    const whitespace = new GuardrailSocket()
    const pendingFrame = new GuardrailSocket()

    server.accept(whitespace)
    server.accept(pendingFrame)
    whitespace.emit("data", `${" ".repeat(1025)}\0`)
    pendingFrame.emit("data", `${JSON.stringify({ socklet: "cooperation_room" })}\0`)
    pendingFrame.emit("data", `${"x".repeat(1025)}\0`)

    assert.equal(whitespace.destroyed, true)
    assert.equal(pendingFrame.destroyed, true)
    releaseHandshake()
    await waitFor(
        () => getSessionServerStatus().pendingHandshakes === 0,
        "oversized pending handshake did not settle",
    )
})

test("a valid first frame clears the pre-handshake timeout", async () => {
    let handshakes = 0
    const server = await startFakeServer({
        async handleHandshake() {
            handshakes++
        },
    })
    const socket = new GuardrailSocket()

    server.accept(socket)
    socket.emit("data", `${JSON.stringify({ socklet: "cooperation_room" })}\0`)
    await new Promise(resolve => setTimeout(resolve, 40))

    assert.equal(handshakes, 1)
    assert.equal(socket.destroyed, false)
})

test("malformed JSON after the handshake closes only the offending socket", async () => {
    const server = await startFakeServer({
        async handleHandshake() {},
    })
    const malformed = new GuardrailSocket()
    const healthy = new GuardrailSocket()

    server.accept(malformed)
    server.accept(healthy)
    malformed.emit(
        "data",
        `${JSON.stringify({ socklet: "cooperation_room" })}\0not-json\0`,
    )

    await waitFor(() => malformed.destroyed, "post-handshake malformed frame was accepted")
    assert.equal(healthy.destroyed, false)
})
