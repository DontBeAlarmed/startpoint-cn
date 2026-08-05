const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const test = require("node:test")

require("ts-node/register/transpile-only")

const originalRandomBytes = crypto.randomBytes
const originalRandomInt = crypto.randomInt
let accessTokenGenerationCalls = 0
let roomNumberGenerationCalls = 0
let roomNumberCandidates = []
let roomNumberFallback = null

crypto.randomBytes = (...args) => {
    accessTokenGenerationCalls++
    return originalRandomBytes(...args)
}
crypto.randomInt = (...args) => {
    roomNumberGenerationCalls++
    if (roomNumberCandidates.length > 0) return roomNumberCandidates.shift()
    return roomNumberFallback ?? originalRandomInt(...args)
}

const {
    createRoom,
    disbandRoom,
    getRoom,
    getRoomCleanupStatus,
    startRoomCleanup,
    stopRoomCleanup,
} = require("../src/multi/room/manager")
const { RoomState } = require("../src/multi/types")
const { sessionManager } = require("../src/multi/state/SessionManager")
const { getServerTime } = require("../src/utils")

function useRoomNumbers(...candidates) {
    roomNumberCandidates = [...candidates]
    roomNumberFallback = candidates[candidates.length - 1] ?? null
}

test.afterEach(() => {
    stopRoomCleanup()
    roomNumberGenerationCalls = 0
    roomNumberCandidates = []
    roomNumberFallback = null
})

test.after(() => {
    crypto.randomBytes = originalRandomBytes
    crypto.randomInt = originalRandomInt
})

test("importing the room manager does not create a cleanup interval", () => {
    const projectRoot = path.resolve(__dirname, "..")
    const script = [
        "require('ts-node/register/transpile-only')",
        "global.setInterval = () => { throw new Error('interval created during import') }",
        "require('./src/multi/room/manager')",
    ].join(";")
    const result = spawnSync(process.execPath, ["-e", script], {
        cwd: projectRoot,
        encoding: "utf8",
        timeout: 10_000,
    })

    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.signal, null)
})

test("room cleanup interval is unrefed and repeated start and stop are idempotent", () => {
    const fakeTimer = {
        unrefCalls: 0,
        unref() { this.unrefCalls++ },
    }
    let createCalls = 0
    let clearCalls = 0
    let callback

    const options = {
        intervalMs: 1234,
        createInterval(cleanup, intervalMs) {
            createCalls++
            callback = cleanup
            assert.equal(intervalMs, 1234)
            return fakeTimer
        },
        clearInterval(timer) {
            clearCalls++
            assert.equal(timer, fakeTimer)
        },
    }

    assert.deepEqual(getRoomCleanupStatus(), { running: false })
    startRoomCleanup(options)
    startRoomCleanup(options)
    assert.equal(typeof callback, "function")
    assert.equal(createCalls, 1)
    assert.equal(fakeTimer.unrefCalls, 1)
    assert.deepEqual(getRoomCleanupStatus(), { running: true })

    stopRoomCleanup()
    stopRoomCleanup()
    assert.equal(clearCalls, 1)
    assert.deepEqual(getRoomCleanupStatus(), { running: false })
})

test("stopping room cleanup preserves in-memory rooms", () => {
    const fakeTimer = { unref() {} }
    startRoomCleanup({
        createInterval() { return fakeTimer },
        clearInterval() {},
    })
    const room = createRoom(101, 201, 1, 1, 301, 1, 401)

    stopRoomCleanup()

    assert.equal(getRoom(room.room_number), room)
    assert.equal(disbandRoom(room.room_number), true)
})

test("room creation retries a colliding number and preserves the active room", () => {
    useRoomNumbers(123456)
    const existing = createRoom(102, 202, 1, 1, 302, 1, 402)
    const existingSnapshot = structuredClone(existing)

    useRoomNumbers(123456, 654321)
    const created = createRoom(103, 203, 1, 1, 303, 1, 403)

    assert.equal(created.room_number, "654321")
    assert.equal(getRoom(existing.room_number), existing)
    assert.deepEqual(existing, existingSnapshot)
    assert.equal(getRoom(created.room_number), created)

    assert.equal(disbandRoom(existing.room_number), true)
    assert.equal(disbandRoom(created.room_number), true)
})

test("room creation accepts the tenth candidate after nine collisions", t => {
    useRoomNumbers(456789)
    const existing = createRoom(107, 207, 1, 1, 307, 1, 407)
    let created
    t.after(() => {
        disbandRoom(existing.room_number)
        if (created) disbandRoom(created.room_number)
    })

    roomNumberGenerationCalls = 0
    useRoomNumbers(...Array(9).fill(456789), 567890)
    created = createRoom(108, 208, 1, 1, 308, 1, 408)

    assert.equal(roomNumberGenerationCalls, 10)
    assert.equal(created.room_number, "567890")
    assert.equal(getRoom(existing.room_number), existing)
    assert.equal(getRoom(created.room_number), created)
})

test("room number exhaustion fails without consuming or mutating room state", t => {
    useRoomNumbers(234567)
    const existing = createRoom(104, 204, 1, 1, 304, 1, 404)
    const participant = { nodeSessionId: "collision-test", viewerId: existing.host_viewer_id }
    const roomState = sessionManager.getRoomState(existing.room_number)
    assert.equal(roomState.tryTransition(RoomState.Ready).allowed, true)
    sessionManager.setBattleParticipants(existing.room_number, [{
        connectionId: "collision-test-host",
        participant,
    }], participant)
    const battleSessionId = sessionManager.getActiveBattleSessionId(existing.room_number)
    assert.equal(typeof battleSessionId, "string")

    let cleanup
    startRoomCleanup({
        createInterval(callback) {
            cleanup = callback
            return { unref() {} }
        },
        clearInterval() {},
    })
    const broadcasts = []
    const originalBroadcastToRoom = sessionManager.broadcastToRoom
    sessionManager.broadcastToRoom = (roomNumber, message) => {
        broadcasts.push({ roomNumber, message })
    }
    t.after(() => { sessionManager.broadcastToRoom = originalBroadcastToRoom })
    existing.host_entry_time = getServerTime() - 880
    cleanup()
    assert.equal(broadcasts.length, 1)
    const existingSnapshot = structuredClone(existing)

    accessTokenGenerationCalls = 0
    roomNumberGenerationCalls = 0
    useRoomNumbers(...Array(10).fill(234567))
    assert.throws(
        () => createRoom(105, 205, 1, 1, 305, 1, 405),
        /failed to allocate an unused room number after 10 attempts/,
    )

    assert.equal(accessTokenGenerationCalls, 0)
    assert.equal(roomNumberGenerationCalls, 10)
    assert.equal(getRoom(existing.room_number), existing)
    assert.deepEqual(existing, existingSnapshot)
    assert.equal(sessionManager.getRoomState(existing.room_number), roomState)
    assert.equal(roomState.getState(), RoomState.Ready)
    assert.equal(sessionManager.getActiveBattleSessionId(existing.room_number), battleSessionId)
    cleanup()
    assert.equal(broadcasts.length, 1)

    useRoomNumbers(345678)
    const next = createRoom(106, 206, 1, 1, 306, 1, 406)
    assert.equal(next.room_sequence, existing.room_sequence + 1)
    assert.equal(accessTokenGenerationCalls, 1)

    existing.host_entry_time = getServerTime() - 1_000
    cleanup()
    assert.equal(getRoom(existing.room_number), undefined)
    assert.equal(disbandRoom(next.room_number), true)
})
