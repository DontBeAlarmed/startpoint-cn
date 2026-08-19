const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    getSessionServerStatus,
    startSessionServer,
    stopSessionServer,
} = require("../src/multi/tcp/server")
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
        maxFrameBytes: 64,
        maxBufferBytes: 128,
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
        createServer(connectionListener) {
            server = new FakeServer(connectionListener)
            return server
        },
    })
    const accepted = new GuardrailSocket()
    const slow = new GuardrailSocket([false])

    server.accept(accepted)
    assert.deepEqual(accepted.keepAlive, { enabled: true, initialDelay: 4321 })
    accepted.emit("data", "x".repeat(1025))
    assert.equal(accepted.destroyed, true)

    assert.equal(sendFrameReliably(slow, "first\0"), "sent")
    assert.equal(sendFrameReliably(slow, "second\0"), "queued")
    assert.deepEqual(getReliableSendQueueStats(slow), {
        messages: 1,
        bytes: Buffer.byteLength("second\0"),
        blocked: true,
    })
    assert.equal(sendFrameReliably(slow, "overflow\0"), "closed")

    await stopSessionServer()
    const afterStop = new GuardrailSocket([false])
    assert.equal(sendFrameReliably(afterStop, "first\0"), "sent")
    assert.equal(sendFrameReliably(afterStop, "second\0"), "queued")
    assert.equal(sendFrameReliably(afterStop, "third\0"), "queued")
    afterStop.destroy()
})

test("explicit low-level guardrails override transport tuning", async () => {
    const server = await startFakeServer({ transportTuning: TRANSPORT_TUNING })
    const oversized = new GuardrailSocket()
    const idle = new GuardrailSocket()

    server.accept(oversized)
    server.accept(idle)
    assert.deepEqual(oversized.keepAlive, { enabled: true, initialDelay: 10_000 })
    oversized.emit("data", "x".repeat(65))

    assert.equal(oversized.destroyed, true)
    await waitFor(() => idle.destroyed, "explicit handshake timeout did not take priority")
})

test("a failed server start restores default reliable send tuning", async () => {
    await assert.rejects(startSessionServer({
        transportTuning: TRANSPORT_TUNING,
        createServer() {
            throw new Error("injected startup failure")
        },
    }), /injected startup failure/)
    const socket = new GuardrailSocket([false])

    assert.equal(sendFrameReliably(socket, "first\0"), "sent")
    assert.equal(sendFrameReliably(socket, "second\0"), "queued")
    assert.equal(sendFrameReliably(socket, "third\0"), "queued")
    socket.destroy()
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
    complete.emit("data", `${JSON.stringify({ socklet: "x".repeat(80) })}\0`)
    unterminated.emit("data", "x".repeat(65))

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
    socket.emit("data", `${JSON.stringify([0, ["x".repeat(45)]])}\0`)
    socket.emit("data", `${JSON.stringify([0, ["y".repeat(45)]])}\0`)
    socket.emit("data", `${JSON.stringify([0, ["z".repeat(45)]])}\0`)

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
    whitespace.emit("data", `${" ".repeat(65)}\0`)
    pendingFrame.emit("data", `${JSON.stringify({ socklet: "cooperation_room" })}\0`)
    pendingFrame.emit("data", `${"x".repeat(65)}\0`)

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
