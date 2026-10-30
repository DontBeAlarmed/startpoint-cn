"use strict"

const assert = require("node:assert/strict")
const { after, test } = require("node:test")

require("./test-workflow/bootstrap.cjs").bootstrap()

const { createRoom, disbandRoom, getRoom } = require("../src/multi/room/manager")
const { sessionManager } = require("../src/multi/state/SessionManager")

const DISMISS_FRAME = [1, [6, "multibattle_room_dismissed"]]

class FakeSocket {
    constructor() {
        this.destroyed = false
        this.destroyCalls = 0
        this.writable = true
        this.writes = []
        this.closeHandlers = []
    }

    write(raw) {
        this.writes.push(JSON.parse(String(raw).replace(/\0$/, "")))
        return true
    }

    once(event, handler) {
        if (event === "close") this.closeHandlers.push(handler)
        return this
    }

    close() {
        if (this.destroyed) return
        this.destroyed = true
        this.writable = false
        for (const handler of this.closeHandlers.splice(0)) handler()
    }

    destroy() {
        this.destroyCalls++
        this.close()
        return this
    }

    end() {
        this.close()
    }
}

function addRoomClient(room, socket, viewerId = room.host_viewer_id) {
    const client = sessionManager.createClient(
        socket,
        viewerId,
        room.room_number,
        `teardown-${viewerId}-${Math.random().toString(16).slice(2)}`,
    )
    client.participant = { nodeSessionId: "embedded", viewerId }
    const added = sessionManager.addClientToRoom(client)
    assert.equal(added.ok, true)
    return client
}

const createdRooms = []

function makeRoom() {
    const room = createRoom(101, 201, 1, 1, 301, 1, 401)
    createdRooms.push(room.room_number)
    return room
}

after(() => {
    sessionManager.resetDismissFallback()
    for (const roomNumber of createdRooms) disbandRoom(roomNumber)
})

test("disband sends exactly one dismiss and keeps the room socket open", () => {
    const room = makeRoom()
    const socket = new FakeSocket()
    addRoomClient(room, socket)

    assert.equal(disbandRoom(room.room_number), true)

    assert.equal(getRoom(room.room_number), undefined)
    assert.deepEqual(socket.writes, [DISMISS_FRAME])
    assert.equal(socket.destroyCalls, 0)
    assert.equal(sessionManager.getClientBySocket(socket), undefined)
})

test("dismiss fallback reclaims a half-open socket after the configured bound", async () => {
    sessionManager.configureDismissFallback(20)
    try {
        const room = makeRoom()
        const socket = new FakeSocket()
        addRoomClient(room, socket)

        disbandRoom(room.room_number)
        assert.equal(socket.destroyCalls, 0)

        await new Promise(resolve => setTimeout(resolve, 60))
        assert.equal(socket.destroyCalls, 1)
    } finally {
        sessionManager.resetDismissFallback()
    }
})

test("client close clears the dismiss fallback", async () => {
    sessionManager.configureDismissFallback(20)
    try {
        const room = makeRoom()
        const socket = new FakeSocket()
        addRoomClient(room, socket)

        disbandRoom(room.room_number)
        socket.close()

        await new Promise(resolve => setTimeout(resolve, 60))
        assert.equal(socket.destroyCalls, 0)
    } finally {
        sessionManager.resetDismissFallback()
    }
})

test("dismissSingleClient uses the same dismiss-only contract", () => {
    const room = makeRoom()
    const socket = new FakeSocket()
    const client = addRoomClient(room, socket)

    sessionManager.dismissSingleClient(client)

    assert.deepEqual(socket.writes, [DISMISS_FRAME])
    assert.equal(socket.destroyCalls, 0)
    assert.equal(sessionManager.getClientBySocket(socket), undefined)
})

test("closeBattleClientsForRoom closes battle sockets immediately", () => {
    const room = makeRoom()
    const socket = new FakeSocket()
    const battle = sessionManager.createClient(
        socket,
        room.host_viewer_id,
        room.room_number,
        "teardown-battle-1",
    )
    battle.participant = { nodeSessionId: "embedded", viewerId: room.host_viewer_id }
    battle.isBattle = true
    assert.equal(sessionManager.addBattleClient("teardown-battle-1", battle), true)

    const closed = sessionManager.closeBattleClientsForRoom(room.room_number)

    assert.equal(closed, 1)
    assert.equal(socket.destroyCalls, 1)
    assert.deepEqual(socket.writes, [])
})
