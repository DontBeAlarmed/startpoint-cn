"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { after, test } = require("node:test")

require("ts-node/register/transpile-only")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "room-dismissal-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()

const { initializeDatabase, closeDatabase } = require("../src/data")
const {
    createRoom,
    disbandRoom,
    getRoom,
    setRoomDisbandListener,
    startRoomCleanup,
    stopRoomCleanup,
} = require("../src/multi/room/manager")
const { installDisbandLifecycleListener } = require("../src/multi/room/disband-listener")
const { sessionManager } = require("../src/multi/state/SessionManager")
const { getServerTime } = require("../src/utils")

const broadcasts = []
const closedRooms = []
const originalBroadcastToRoom = sessionManager.broadcastToRoom
const originalCloseRoomClients = sessionManager.closeRoomClients

sessionManager.broadcastToRoom = (roomNumber, message) => {
    broadcasts.push({ roomNumber, message })
}
sessionManager.closeRoomClients = roomNumber => {
    closedRooms.push(roomNumber)
    return 0
}

let cleanup
startRoomCleanup({
    createInterval(callback) {
        cleanup = callback
        return { unref() {} }
    },
    clearInterval() {},
})

initializeDatabase()
installDisbandLifecycleListener()

function dismissedBroadcasts(roomNumber) {
    return broadcasts.filter(entry => (
        entry.roomNumber === roomNumber
        && JSON.stringify(entry.message) === JSON.stringify([1, [6, "multibattle_room_dismissed"]])
    ))
}

test("idle-expired rooms broadcast the client dismissal and drop their sockets", () => {
    const room = createRoom(101, 201, 1, 1, 301, 1, 401)
    room.host_entry_time = getServerTime() - 10_000

    cleanup()

    assert.equal(getRoom(room.room_number), undefined, "expired room must be deleted")
    assert.equal(dismissedBroadcasts(room.room_number).length, 1,
        "cleaner disband must tell clients the room is dismissed")
    assert.equal(closedRooms.filter(roomNumber => roomNumber === room.room_number).length, 1,
        "cleaner disband must close the room's sockets")
})

test("the disband choke point broadcasts for every caller", () => {
    const room = createRoom(102, 202, 1, 1, 302, 1, 402)

    // Direct disbandRoom callers (e.g. aborted multi battle cleanup) funnel
    // through the same listener as the cleaner.
    assert.equal(disbandRoom(room.room_number), true)
    assert.equal(getRoom(room.room_number), undefined)
    assert.equal(dismissedBroadcasts(room.room_number).length, 1)
    assert.equal(closedRooms.filter(roomNumber => roomNumber === room.room_number).length, 1)
})

test("disbanding a missing room broadcasts nothing", () => {
    const before = broadcasts.length
    assert.equal(disbandRoom("999999"), false)
    assert.equal(broadcasts.length, before)
})

after(() => {
    stopRoomCleanup()
    setRoomDisbandListener(null)
    sessionManager.broadcastToRoom = originalBroadcastToRoom
    sessionManager.closeRoomClients = originalCloseRoomClients
    closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})
