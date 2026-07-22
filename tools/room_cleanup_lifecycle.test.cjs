const assert = require("node:assert/strict")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    createRoom,
    disbandRoom,
    getRoom,
    getRoomCleanupStatus,
    startRoomCleanup,
    stopRoomCleanup,
} = require("../src/multi/room/manager")

test.afterEach(() => stopRoomCleanup())

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
