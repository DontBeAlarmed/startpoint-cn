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
const SHORT_BATTLE_TUNING = Object.freeze({ loadingLeaseMs: 35, heartbeatLeaseMs: 35 })
const LONG_BATTLE_TUNING = Object.freeze({ loadingLeaseMs: 120, heartbeatLeaseMs: 120 })

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

async function waitForImmediate(predicate, message, attempts = 20) {
    for (let attempt = 0; attempt < attempts; attempt++) {
        if (predicate()) return
        await new Promise(resolve => setImmediate(resolve))
    }
    throw new Error(message)
}

function captureTimeouts() {
    const originalSetTimeout = global.setTimeout
    const originalClearTimeout = global.clearTimeout
    const timers = []
    const handles = new Set()

    global.setTimeout = (callback, delayMs, ...args) => {
        const timer = {
            callback: () => callback(...args),
            cleared: false,
            delayMs,
            unref() { return this },
        }
        timers.push(timer)
        handles.add(timer)
        return timer
    }
    global.clearTimeout = timer => {
        if (handles.has(timer)) {
            timer.cleared = true
            return
        }
        originalClearTimeout(timer)
    }

    return {
        mark: () => timers.length,
        since: mark => timers.slice(mark),
        oneSince(mark, delayMs, phase) {
            const matches = timers.slice(mark).filter(timer => timer.delayMs === delayMs)
            assert.equal(matches.length, 1, `${phase} expected one ${delayMs}ms timer`)
            return matches[0]
        },
        restore() {
            global.setTimeout = originalSetTimeout
            global.clearTimeout = originalClearTimeout
        },
    }
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

let battleSequence = 0

async function registerBattleClient(socket, data) {
    const viewerId = 920_000_000 + ++battleSequence
    const roomNumber = data.room_number
    const connectionId = data.connection_id
    const client = sessionManager.createClient(socket, viewerId, roomNumber, connectionId)
    client.isBattle = true
    client.participant = { nodeSessionId: `guardrail-node-${battleSequence}`, viewerId }
    if (!sessionManager.addBattleClient(connectionId, client)) {
        throw new Error("battle client registration failed")
    }
}

async function connectBattleClient(
    server,
    label,
    connectionId = `guardrail-battle-${label}-${++battleSequence}`,
    writeResults = [],
) {
    const socket = new GuardrailSocket(writeResults)
    server.accept(socket)
    socket.emit("data", `${JSON.stringify({
        socklet: "cooperation_battle",
        room_number: `guardrail-room-${label}`,
        connection_id: connectionId,
    })}\0`)
    await waitForImmediate(
        () => sessionManager.getBattleClientBySocket(socket)?.connectionId === connectionId,
        "battle handshake did not register a session",
    )
    return socket
}

async function startDefaultBattleGeneration(captured, label, connectionId) {
    const server = await startFakeServer({ handleHandshake: registerBattleClient })
    const mark = captured.mark()
    const socket = await connectBattleClient(server, label, connectionId)
    const handshakeTimer = captured.oneSince(mark, 25, `${label} handshake`)
    const loadingTimer = captured.oneSince(mark, 60_000, `${label} loading`)
    assert.equal(handshakeTimer.cleared, true)
    assert.equal(loadingTimer.cleared, false)
    return { loadingTimer, server, socket }
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
        createServer(connectionListener) {
            server = new FakeServer(connectionListener)
            return server
        },
    })
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
        createServer(connectionListener) {
            nextServer = new FakeServer(connectionListener)
            return nextServer
        },
    })
    const nextSlow = new GuardrailSocket([false])
    nextServer.accept(nextSlow)
    assert.equal(sendFrameReliably(nextSlow, "first\0"), "sent")
    assert.equal(sendFrameReliably(nextSlow, "second\0"), "queued")
    assert.equal(sendFrameReliably(nextSlow, "third\0"), "queued")
    assert.equal(sendFrameReliably(nextSlow, "overflow\0"), "closed")
})

test("battle lease tuning follows server generations and retired timers stay cleared", async () => {
    const captured = captureTimeouts()
    const connectionId = "guardrail-shared-generation-cid"
    try {
        const firstServer = await startFakeServer({
            battleTuning: SHORT_BATTLE_TUNING,
            handleHandshake: registerBattleClient,
        })
        const firstMark = captured.mark()
        const first = await connectBattleClient(firstServer, "generation-a", connectionId)
        const firstHandshakeTimer = captured.oneSince(firstMark, 25, "generation A handshake")
        const firstLoadingTimer = captured.oneSince(firstMark, 35, "generation A loading")
        assert.equal(firstHandshakeTimer.cleared, true)
        assert.equal(firstLoadingTimer.cleared, false)

        await stopSessionServer()
        assert.equal(firstLoadingTimer.cleared, true)
        assert.equal(first.destroyCalls, 1)

        const secondServer = await startFakeServer({
            battleTuning: LONG_BATTLE_TUNING,
            handleHandshake: registerBattleClient,
        })
        const secondMark = captured.mark()
        const second = await connectBattleClient(secondServer, "generation-b", connectionId)
        const secondHandshakeTimer = captured.oneSince(secondMark, 25, "generation B handshake")
        const secondLoadingTimer = captured.oneSince(secondMark, 120, "generation B loading")
        assert.equal(secondHandshakeTimer.cleared, true)
        assert.equal(secondLoadingTimer.cleared, false)

        firstLoadingTimer.callback()
        assert.equal(first.destroyCalls, 1)
        assert.equal(second.destroyed, false)

        assert.equal(sessionManager.removeClientBySocket(second), true)
        assert.equal(secondLoadingTimer.cleared, true)
        secondLoadingTimer.callback()
        assert.equal(second.destroyed, false)
        assert.equal(sessionManager.getBattleClientBySocket(second), undefined)

        await stopSessionServer()
        const defaultGeneration = await startDefaultBattleGeneration(
            captured,
            "generation-default-after-stop",
            connectionId,
        )
        defaultGeneration.loadingTimer.callback()
        assert.equal(defaultGeneration.socket.destroyed, true)
    } finally {
        await stopSessionServer()
        captured.restore()
    }
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

test("invalid final transport and battle values fail atomically before server creation", async () => {
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
    }

    const socket = new GuardrailSocket([false])
    assert.equal(sendFrameReliably(socket, "first\0"), "sent")
    assert.equal(sendFrameReliably(socket, "second\0"), "queued")
    assert.equal(sendFrameReliably(socket, "third\0"), "queued")
    socket.destroy()
})

test("a failed server start restores default reliable send tuning", async () => {
    const captured = captureTimeouts()
    try {
        await assert.rejects(startSessionServer({
            transportTuning: TRANSPORT_TUNING,
            battleTuning: SHORT_BATTLE_TUNING,
            createServer() {
                throw new Error("injected startup failure")
            },
        }), /injected startup failure/)

        const defaultGeneration = await startDefaultBattleGeneration(
            captured,
            "generation-default-after-startup-failure",
            "guardrail-startup-failure-cid",
        )
        assert.equal(defaultGeneration.loadingTimer.delayMs, 60_000)

        const socket = new GuardrailSocket([false])
        const reliableMark = captured.mark()
        assert.equal(sendFrameReliably(socket, "first\0"), "sent")
        assert.equal(sendFrameReliably(socket, "second\0"), "queued")
        assert.equal(sendFrameReliably(socket, "third\0"), "queued")
        const reliableTimers = captured.since(reliableMark)
        assert.equal(reliableTimers.length, 3)
        assert.equal(reliableTimers.every(timer => timer.delayMs > 0 && timer.delayMs <= 15_000), true)
        assert.deepEqual(reliableTimers.map(timer => timer.cleared), [true, true, false])
        socket.destroy()
        assert.equal(reliableTimers.at(-1).cleared, true)
    } finally {
        await stopSessionServer()
        captured.restore()
    }
})

test("an asynchronous listen error restores default reliable send tuning", async () => {
    const captured = captureTimeouts()
    let failedServer
    try {
        const startPromise = startSessionServer({
            transportTuning: TRANSPORT_TUNING,
            battleTuning: SHORT_BATTLE_TUNING,
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
        await waitForImmediate(
            () => failedServer.listenerCount("error") === 0,
            "failed startup server retained its error listener",
        )
        const defaultGeneration = await startDefaultBattleGeneration(
            captured,
            "generation-default-after-async-startup-failure",
            "guardrail-async-startup-failure-cid",
        )
        assert.equal(defaultGeneration.loadingTimer.delayMs, 60_000)

        const socket = new GuardrailSocket([false])
        assert.equal(sendFrameReliably(socket, "first\0"), "sent")
        assert.equal(sendFrameReliably(socket, "second\0"), "queued")
        assert.equal(sendFrameReliably(socket, "third\0"), "queued")
        socket.destroy()
    } finally {
        await stopSessionServer()
        captured.restore()
    }
})

test("runtime fatal teardown clears active backpressure state and restores defaults", async () => {
    const captured = captureTimeouts()
    const connectionId = "guardrail-fatal-shared-cid"
    let server
    try {
        await startSessionServer({
            transportTuning: TRANSPORT_TUNING,
            battleTuning: SHORT_BATTLE_TUNING,
            handleHandshake: registerBattleClient,
            createServer(connectionListener) {
                server = new FakeServer(connectionListener)
                return server
            },
        })
        const battleMark = captured.mark()
        const active = await connectBattleClient(server, "fatal-a", connectionId, [false])
        const loadingTimer = captured.oneSince(battleMark, 35, "fatal generation loading")
        assert.equal(captured.oneSince(battleMark, 40, "fatal generation handshake").cleared, true)

        const reliableMark = captured.mark()
        assert.deepEqual(active.writes, [])
        assert.deepEqual(active.writeResults, [false])
        assert.equal(sendFrameReliably(active, "first\0"), "sent")
        assert.equal(sendFrameReliably(active, "second\0"), "queued")
        const reliableTimers = captured.since(reliableMark)
        assert.equal(reliableTimers.length, 2)
        assert.equal(reliableTimers.every(timer => timer.delayMs > 0 && timer.delayMs <= 30), true)
        assert.deepEqual(reliableTimers.map(timer => timer.cleared), [true, false])

        server.emit("error", new Error("runtime fatal failure"))
        await waitForImmediate(
            () => !server.listening && server.listenerCount("error") === 0,
            "fatal teardown did not finish",
        )
        assert.equal(loadingTimer.cleared, true)
        assert.equal(reliableTimers.at(-1).cleared, true)
        assert.deepEqual(getReliableSendQueueStats(active), {
            messages: 0,
            bytes: 0,
            blocked: false,
        })
        assert.equal(active.destroyCalls, 1)

        const defaultGeneration = await startDefaultBattleGeneration(
            captured,
            "generation-default-after-fatal",
            connectionId,
        )
        loadingTimer.callback()
        assert.equal(active.destroyCalls, 1)
        assert.equal(defaultGeneration.socket.destroyed, false)

        defaultGeneration.loadingTimer.callback()
        assert.equal(defaultGeneration.socket.destroyed, true)

        const afterFatal = new GuardrailSocket([false])
        assert.equal(sendFrameReliably(afterFatal, "first\0"), "sent")
        assert.equal(sendFrameReliably(afterFatal, "second\0"), "queued")
        assert.equal(sendFrameReliably(afterFatal, "third\0"), "queued")
        afterFatal.destroy()
    } finally {
        await stopSessionServer()
        captured.restore()
    }
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
