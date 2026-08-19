const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    clearReliableSendState,
    configureReliableSendTuning,
    getReliableSendQueueStats,
    resetReliableSendTuning,
    sendFrameReliably,
} = require("../src/multi/tcp/reliable-send")

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

class BackpressureSocket extends EventEmitter {
    constructor(writeResults = []) {
        super()
        this.destroyed = false
        this.writable = true
        this.writeResults = [...writeResults]
        this.writes = []
    }

    write(frame) {
        this.writes.push(frame)
        return this.writeResults.length > 0 ? this.writeResults.shift() : true
    }

    destroy() {
        if (this.destroyed) return this
        this.destroyed = true
        this.writable = false
        this.emit("close")
        return this
    }
}

test.beforeEach(() => {
    configureReliableSendTuning({
        maxMessages: 2,
        maxBytes: 1024,
        maxAgeMs: 30,
    })
})

test.afterEach(() => {
    resetReliableSendTuning()
})

test("reliable send tuning rejects unsafe queue limits", () => {
    for (const maxMessages of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => configureReliableSendTuning({
            maxMessages,
            maxBytes: 1024,
            maxAgeMs: 30,
        }), TypeError)
    }
    for (const maxAgeMs of [
        0,
        -1,
        1.5,
        2_147_483_648,
        Number.MAX_SAFE_INTEGER + 1,
    ]) {
        assert.throws(() => configureReliableSendTuning({
            maxMessages: 2,
            maxBytes: 1024,
            maxAgeMs,
        }), TypeError)
    }
    for (const maxBytes of [1023, 1024.5, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => configureReliableSendTuning({
            maxMessages: 2,
            maxBytes,
            maxAgeMs: 30,
        }), TypeError)
    }
})

test("frames after backpressure wait for drain and preserve order", () => {
    const socket = new BackpressureSocket([false, true, true])

    assert.equal(sendFrameReliably(socket, "first\0"), "sent")
    assert.equal(sendFrameReliably(socket, "second\0"), "queued")
    assert.equal(sendFrameReliably(socket, "third\0"), "queued")
    assert.deepEqual(socket.writes, ["first\0"])
    assert.deepEqual(getReliableSendQueueStats(socket), {
        messages: 2,
        bytes: Buffer.byteLength("second\0third\0"),
        blocked: true,
    })

    socket.emit("drain")

    assert.deepEqual(socket.writes, ["first\0", "second\0", "third\0"])
    assert.deepEqual(getReliableSendQueueStats(socket), {
        messages: 0,
        bytes: 0,
        blocked: false,
    })
    clearReliableSendState(socket)
})

test("queue overflow disconnects only the slow socket", () => {
    const slow = new BackpressureSocket([false])
    const healthy = new BackpressureSocket()

    assert.equal(sendFrameReliably(slow, "first\0"), "sent")
    assert.equal(sendFrameReliably(slow, "second\0"), "queued")
    assert.equal(sendFrameReliably(slow, "third\0"), "queued")
    assert.equal(sendFrameReliably(slow, "overflow\0"), "closed")

    assert.equal(slow.destroyed, true)
    assert.equal(healthy.destroyed, false)
    assert.equal(sendFrameReliably(healthy, "healthy\0"), "sent")
    assert.deepEqual(healthy.writes, ["healthy\0"])
    clearReliableSendState(healthy)
})

test("a socket that never drains is retired without affecting peers", async () => {
    const slow = new BackpressureSocket([false])
    const healthy = new BackpressureSocket()

    sendFrameReliably(slow, "blocked\0")
    sendFrameReliably(slow, "queued\0")
    await waitFor(() => slow.destroyed, "backpressured socket was not retired")

    assert.equal(healthy.destroyed, false)
    assert.equal(sendFrameReliably(healthy, "still-open\0"), "sent")
    clearReliableSendState(healthy)
})

test("a queued frame that exceeds the byte limit closes only that socket", () => {
    const slow = new BackpressureSocket([false])
    const healthy = new BackpressureSocket()

    assert.equal(sendFrameReliably(slow, "first\0"), "sent")
    assert.equal(sendFrameReliably(slow, `${"x".repeat(1_025)}\0`), "closed")
    assert.equal(slow.destroyed, true)
    assert.equal(sendFrameReliably(healthy, "healthy\0"), "sent")
    assert.equal(healthy.destroyed, false)
    clearReliableSendState(healthy)
})

test("a drain event on an unwritable socket does not strand its queue", () => {
    const socket = new BackpressureSocket([false])

    sendFrameReliably(socket, "first\0")
    sendFrameReliably(socket, "queued\0")
    socket.writable = false
    socket.emit("drain")

    assert.equal(socket.destroyed, true)
    assert.deepEqual(getReliableSendQueueStats(socket), {
        messages: 0,
        bytes: 0,
        blocked: false,
    })
    clearReliableSendState(socket)
})

test("closed sockets and synchronous write failures return closed", () => {
    const closed = new BackpressureSocket()
    closed.destroy()
    const throwing = new BackpressureSocket()
    throwing.write = () => { throw new Error("write failed") }

    assert.equal(sendFrameReliably(closed, "closed\0"), "closed")
    assert.equal(sendFrameReliably(throwing, "throwing\0"), "closed")
    assert.equal(throwing.destroyed, true)
})
