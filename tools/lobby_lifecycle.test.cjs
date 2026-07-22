const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { sessionManager } = require("../src/multi/state/SessionManager")
const { createRoom, disbandRoom } = require("../src/multi/room/manager")
let lobbyLifecycle = {}
try {
    lobbyLifecycle = require("../src/multi/tcp/lobby-lifecycle")
} catch {
    // RED: lifecycle module does not exist yet.
}
const { getLobbyLifecycleStatus, startLobbyLifecycle, stopLobbyLifecycle } = lobbyLifecycle
const { handleMessage } = require("../src/multi/tcp/lobby")
const { NpcMateProvider } = require("../src/multi/npc/controller")

function deferred() {
    let resolve
    const promise = new Promise(resolvePromise => { resolve = resolvePromise })
    return { promise, resolve }
}

class FakeSocket extends EventEmitter {
    constructor() {
        super()
        this.destroyed = false
        this.writable = true
    }

    write() { return true }
    destroy() {
        this.destroyed = true
        this.writable = false
    }
}

test.afterEach(() => {
    if (typeof stopLobbyLifecycle === "function") stopLobbyLifecycle()
})

test("all three lobby timeout paths are unrefed, cancelled, and inert after stop", async t => {
    assert.equal(typeof startLobbyLifecycle, "function")
    assert.equal(typeof stopLobbyLifecycle, "function")
    assert.equal(typeof getLobbyLifecycleStatus, "function")
    const timers = []
    const cleared = []
    const createTimer = (callback, delayMs) => {
        const timer = {
            callback,
            delayMs,
            unrefCalls: 0,
            unref() { this.unrefCalls++ },
        }
        timers.push(timer)
        return timer
    }
    startLobbyLifecycle({
        createTimer,
        clearTimer(timer) { cleared.push(timer) },
    })

    const room = createRoom(501, 601, 1, 1, 701, 1, 801)
    room.npc_count = 2
    const socket = new FakeSocket()
    const client = sessionManager.createClient(socket, 501, room.room_number, "lobby-timer-cid", null)
    client.yourself = {
        viewerId: 501,
        connectionId: "lobby-timer-cid",
        party: {},
        state: [0],
    }
    client.mates = [client.yourself]
    sessionManager.addClientToRoom(client)
    t.after(() => {
        sessionManager.removeClientBySocket(socket)
        disbandRoom(room.room_number)
    })

    handleMessage(socket, [0, [10, [{ name: "NPC1" }, { name: "NPC2" }]]])
    await new Promise(resolve => setImmediate(resolve))
    handleMessage(socket, [0, [0, { party: {} }]])

    assert.equal(timers.length, 3)
    assert.deepEqual(timers.map(timer => timer.unrefCalls), [1, 1, 1])
    assert.deepEqual(getLobbyLifecycleStatus(), { running: true, activeTimers: 3 })

    const originalSendJson = sessionManager.sendJson
    const originalBroadcast = sessionManager.broadcastToRoom
    let sideEffects = 0
    sessionManager.sendJson = () => { sideEffects++ }
    sessionManager.broadcastToRoom = () => { sideEffects++ }
    try {
        stopLobbyLifecycle()
        assert.deepEqual(cleared, timers)
        assert.deepEqual(getLobbyLifecycleStatus(), { running: false, activeTimers: 0 })
        for (const timer of timers) timer.callback()
        await new Promise(resolve => setImmediate(resolve))
        assert.equal(sideEffects, 0)
    } finally {
        sessionManager.sendJson = originalSendJson
        sessionManager.broadcastToRoom = originalBroadcast
    }
})

test("an async lobby timer callback cannot mutate state after its generation stops", async t => {
    const timers = []
    startLobbyLifecycle({
        createTimer(callback) {
            const timer = { callback, unref() {} }
            timers.push(timer)
            return timer
        },
        clearTimer() {},
    })

    const room = createRoom(502, 602, 1, 1, 702, 1, 802)
    room.npc_count = 2
    const socket = new FakeSocket()
    const client = sessionManager.createClient(socket, 502, room.room_number, "async-lobby-cid", null)
    client.yourself = {
        viewerId: 502,
        connectionId: "async-lobby-cid",
        party: {},
        state: [0],
    }
    client.mates = [client.yourself]
    sessionManager.addClientToRoom(client)
    t.after(() => {
        sessionManager.removeClientBySocket(socket)
        disbandRoom(room.room_number)
    })

    const recruitment = deferred()
    const originalOnRecruit = NpcMateProvider.prototype.onRecruit
    NpcMateProvider.prototype.onRecruit = () => recruitment.promise
    try {
        handleMessage(socket, [0, [0, { party: {} }]])
        assert.equal(timers.length, 1)
        timers[0].callback()
        await new Promise(resolve => setImmediate(resolve))

        stopLobbyLifecycle()
        startLobbyLifecycle()
        recruitment.resolve({
            recruitedMates: [
                { viewer_id: 900000001, com_id: 1 },
                { viewer_id: 900000002, com_id: 2 },
            ],
        })
        await new Promise(resolve => setImmediate(resolve))

        assert.equal(client.mates.length, 1)
        assert.equal(timers.length, 1)
    } finally {
        NpcMateProvider.prototype.onRecruit = originalOnRecruit
    }
})
