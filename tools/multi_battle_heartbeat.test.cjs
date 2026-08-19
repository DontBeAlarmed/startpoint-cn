const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { SessionManager } = require("../src/multi/state/SessionManager")

const SHORT_BATTLE_TUNING = Object.freeze({
    loadingLeaseMs: 80,
    heartbeatLeaseMs: 80,
})

function createManager() {
    return new SessionManager({ battleTuning: SHORT_BATTLE_TUNING })
}

function waitFor(predicate, message, timeoutMs = 500) {
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

class HeartbeatSocket extends EventEmitter {
    constructor() {
        super()
        this.destroyed = false
        this.writable = true
        this.frames = []
    }

    write(frame) {
        this.frames.push(frame)
        return true
    }

    destroy() {
        if (this.destroyed) return this
        this.destroyed = true
        this.writable = false
        this.emit("close")
        return this
    }
}

let sequence = 0

function createBattleClient(manager, roomNumber, connectionId = `heartbeat-${++sequence}`) {
    const socket = new HeartbeatSocket()
    const client = manager.createClient(
        socket,
        910_000_000 + sequence,
        roomNumber,
        connectionId,
    )
    client.isBattle = true
    client.participant = {
        nodeSessionId: `heartbeat-node-${sequence}`,
        viewerId: client.viewerId,
    }
    manager.addBattleClient(connectionId, client)
    socket.on("close", () => manager.removeClient(client))
    return { client, socket }
}

test("a battle connection that never reaches SceneReady expires its loading lease", async () => {
    const manager = createManager()
    const { client, socket } = createBattleClient(manager, "heartbeat-loading-room")

    await waitFor(() => socket.destroyed, "loading battle socket did not expire")

    assert.equal(manager.getBattleClient(client.connectionId), undefined)
})

test("battle activity extends the active lease without recreating the connection", async () => {
    const manager = createManager()
    const roomNumber = "heartbeat-active-room"
    manager.setBattleExpectedCount(roomNumber, 1)
    const { client, socket } = createBattleClient(manager, roomNumber)

    assert.equal(manager.markSceneReady(client.connectionId, roomNumber), true)
    await new Promise(resolve => setTimeout(resolve, 45))
    manager.noteBattleActivity(client.connectionId)
    await new Promise(resolve => setTimeout(resolve, 45))
    assert.equal(socket.destroyed, false)

    await waitFor(() => socket.destroyed, "active battle socket did not expire after inactivity")
})

test("replacing a same-room battle socket cancels the old lease", async () => {
    const manager = createManager()
    const first = createBattleClient(manager, "heartbeat-replace-room", "stable-cid")
    const second = createBattleClient(manager, "heartbeat-replace-room", "stable-cid")

    assert.equal(first.socket.destroyed, true)
    assert.equal(manager.getBattleClient("stable-cid"), second.client)
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(second.socket.destroyed, true)
})

test("a reconnect after the scene barrier is released enters the active lease", async () => {
    const manager = createManager()
    const roomNumber = "heartbeat-reconnect-room"
    manager.setBattleExpectedCount(roomNumber, 1)
    const first = createBattleClient(manager, roomNumber, "reconnect-cid")

    assert.equal(manager.markSceneReady(first.client.connectionId, roomNumber), true)
    const second = createBattleClient(manager, roomNumber, "reconnect-cid")
    assert.equal(manager.markSceneReady(second.client.connectionId, roomNumber), false)

    await new Promise(resolve => setTimeout(resolve, 45))
    manager.noteBattleActivity(second.client.connectionId)
    await new Promise(resolve => setTimeout(resolve, 45))
    assert.equal(second.socket.destroyed, false)

    await waitFor(() => second.socket.destroyed, "reconnected active battle socket did not expire")
})

test("clearing battle state cancels leases and rejects late SceneReady", async () => {
    const manager = createManager()
    const roomNumber = "heartbeat-cleared-room"
    manager.setBattleExpectedCount(roomNumber, 1)
    const { client, socket } = createBattleClient(manager, roomNumber)

    manager.clearBattleExpectedCount(roomNumber)
    assert.equal(manager.markSceneReady(client.connectionId, roomNumber), false)
    await new Promise(resolve => setTimeout(resolve, 100))

    assert.equal(socket.destroyed, false)
    manager.removeClient(client)
})

test("constructor snapshots battle tuning and configure applies to later clients", async () => {
    const configured = { loadingLeaseMs: 30, heartbeatLeaseMs: 30 }
    const manager = new SessionManager({ battleTuning: configured })
    configured.loadingLeaseMs = 1_000
    const first = createBattleClient(manager, "heartbeat-snapshot-a")

    manager.configureBattleTuning({ loadingLeaseMs: 120, heartbeatLeaseMs: 120 })
    const second = createBattleClient(manager, "heartbeat-snapshot-b")

    await waitFor(() => first.socket.destroyed, "constructor tuning was not snapshotted", 100)
    assert.equal(second.socket.destroyed, false)
    await waitFor(() => second.socket.destroyed, "configured tuning was not applied", 180)
})

test("resetBattleTuning applies defaults to later clients", async () => {
    const manager = new SessionManager()

    manager.configureBattleTuning({ loadingLeaseMs: 30, heartbeatLeaseMs: 30 })
    manager.resetBattleTuning()
    const { client, socket } = createBattleClient(manager, "heartbeat-reset-default")

    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(socket.destroyed, false)
    manager.removeClient(client)
})

test("battle tuning rejects non-positive, fractional, unsafe, and oversized durations", () => {
    const invalidValues = [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 2_147_483_648]

    for (const value of invalidValues) {
        assert.throws(
            () => new SessionManager({
                battleTuning: { loadingLeaseMs: value, heartbeatLeaseMs: 80 },
            }),
            TypeError,
        )
        assert.throws(
            () => new SessionManager({
                battleTuning: { loadingLeaseMs: 80, heartbeatLeaseMs: value },
            }),
            TypeError,
        )
    }

    const manager = new SessionManager()
    assert.throws(
        () => manager.configureBattleTuning({ loadingLeaseMs: 0, heartbeatLeaseMs: 80 }),
        TypeError,
    )
})
