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
        timers,
        restore() {
            global.setTimeout = originalSetTimeout
            global.clearTimeout = originalClearTimeout
        },
    }
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

test("constructor snapshots battle tuning and configure applies to later clients", () => {
    const captured = captureTimeouts()
    const configured = { loadingLeaseMs: 30, heartbeatLeaseMs: 30 }
    const manager = new SessionManager({ battleTuning: configured })
    let first
    let second
    try {
        configured.loadingLeaseMs = 1_000
        first = createBattleClient(manager, "heartbeat-snapshot-a")
        const firstTimer = captured.timers.at(-1)
        assert.equal(firstTimer.delayMs, 30)

        manager.configureBattleTuning({ loadingLeaseMs: 120, heartbeatLeaseMs: 120 })
        second = createBattleClient(manager, "heartbeat-snapshot-b")
        const secondTimer = captured.timers.at(-1)
        assert.equal(secondTimer.delayMs, 120)

        firstTimer.callback()
        assert.equal(first.socket.destroyed, true)
        assert.equal(second.socket.destroyed, false)

        secondTimer.callback()
        assert.equal(second.socket.destroyed, true)
    } finally {
        if (first && !first.socket.destroyed) manager.removeClient(first.client)
        if (second && !second.socket.destroyed) manager.removeClient(second.client)
        captured.restore()
    }
})

test("resetBattleTuning applies defaults to later clients", () => {
    const captured = captureTimeouts()
    const manager = new SessionManager()
    let battle
    try {
        manager.configureBattleTuning({ loadingLeaseMs: 30, heartbeatLeaseMs: 30 })
        manager.resetBattleTuning()
        battle = createBattleClient(manager, "heartbeat-reset-default")
        const loadingTimer = captured.timers.at(-1)

        assert.equal(loadingTimer.delayMs, 60_000)
        assert.equal(battle.socket.destroyed, false)
        manager.removeClient(battle.client)
        assert.equal(loadingTimer.cleared, true)
    } finally {
        if (battle && manager.getBattleClient(battle.client.connectionId) === battle.client) {
            manager.removeClient(battle.client)
        }
        captured.restore()
    }
})

test("an old active timer cannot take ownership from a replacement connection", () => {
    const captured = captureTimeouts()
    const manager = new SessionManager({
        battleTuning: { loadingLeaseMs: 30, heartbeatLeaseMs: 40 },
    })
    const roomNumber = "heartbeat-active-ownership"
    const connectionId = "heartbeat-active-stable-cid"
    let first
    let second
    try {
        manager.setBattleExpectedCount(roomNumber, 1)
        first = createBattleClient(manager, roomNumber, connectionId)
        const firstLoadingTimer = captured.timers.at(-1)
        assert.equal(manager.markSceneReady(connectionId, roomNumber), true)
        const firstActiveTimer = captured.timers.at(-1)
        assert.equal(firstLoadingTimer.cleared, true)
        assert.equal(firstActiveTimer.delayMs, 40)

        second = createBattleClient(manager, roomNumber, connectionId)
        const secondLoadingTimer = captured.timers.at(-1)
        assert.equal(firstActiveTimer.cleared, true)
        assert.equal(manager.markSceneReady(connectionId, roomNumber), false)
        const secondActiveTimer = captured.timers.at(-1)
        assert.equal(secondLoadingTimer.cleared, true)
        assert.equal(secondActiveTimer.delayMs, 40)

        firstActiveTimer.callback()
        assert.equal(second.socket.destroyed, false)

        manager.removeClient(second.client)
        assert.equal(secondActiveTimer.cleared, true)
        secondActiveTimer.callback()
        assert.equal(second.socket.destroyed, false)
        assert.equal(manager.getBattleClient(connectionId), undefined)
    } finally {
        if (first && manager.getBattleClient(connectionId) === first.client) {
            manager.removeClient(first.client)
        }
        if (second && manager.getBattleClient(connectionId) === second.client) {
            manager.removeClient(second.client)
        }
        captured.restore()
    }
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
