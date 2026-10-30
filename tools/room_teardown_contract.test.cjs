"use strict"

const assert = require("node:assert/strict")
const { after, test } = require("node:test")

require("./test-workflow/bootstrap.cjs").bootstrap()

const {
    createRoom,
    disbandRoom,
    getRoom,
    getRoomCleanupDiagnostics,
    setRoomDisbandListener,
} = require("../src/multi/room/manager")
const { installDisbandLifecycleListener } = require("../src/multi/room/disband-listener")
const { sessionManager } = require("../src/multi/state/SessionManager")
const { lifecycleRegistry } = require("../src/multi/lifecycle")

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
    client.lifecycleGeneration = lifecycleRegistry.get(room.room_number)?.generation
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
        const stats = sessionManager.getDismissFallbackStats()
        assert.equal(stats.forcedCloses, 1, "the forced close must be counted")
        assert.equal(stats.last?.roomNumber, room.room_number)
        assert.ok((stats.last?.ageMs ?? 0) >= 20)
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
        assert.equal(sessionManager.getDismissFallbackStats().forcedCloses, 0,
            "a client-driven close must not count as a forced close")
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

function installCloseConfirmation() {
    installDisbandLifecycleListener()
    // 本文件不建库：只保留生产 closeConfirmed 钩子，摘掉持久层 listener。
    setRoomDisbandListener(null)
}

function seatKernelGuest(roomNumber, viewerId) {
    const identity = `viewer:${viewerId}`
    lifecycleRegistry.dispatch(roomNumber, generation => ({ type: "admit", generation, identity }))
    lifecycleRegistry.dispatch(roomNumber, generation => ({ type: "handshake", generation, identity }))
    lifecycleRegistry.dispatch(roomNumber, generation => ({
        type: "enter",
        generation,
        identity,
        nowMs: Date.now(),
    }))
}

test("a dismissed socket close drives closing → closed", () => {
    lifecycleRegistry.reset()
    installCloseConfirmation()
    try {
        const room = makeRoom()
        const socket = new FakeSocket()
        addRoomClient(room, socket)

        assert.equal(disbandRoom(room.room_number), true)
        assert.equal(lifecycleRegistry.get(room.room_number).phase, "closing")
        assert.equal(getRoomCleanupDiagnostics().closingRooms, 1,
            "a live dismissed socket must be visible as closing")
        assert.equal(socket.destroyCalls, 0, "dismiss-only：socket 保持到客户端断开")
        socket.close()
        assert.equal(lifecycleRegistry.get(room.room_number), undefined)
        assert.equal(getRoomCleanupDiagnostics().closingRooms, 0,
            "client close must clear the closing entry without waiting for the fallback")
    } finally {
        sessionManager.onDismissedSocketClosed = null
        setRoomDisbandListener(null)
    }
})

test("a stale-generation close does not confirm the current room", () => {
    lifecycleRegistry.reset()
    installCloseConfirmation()
    try {
        const room = makeRoom()
        const socket = new FakeSocket()
        const client = addRoomClient(room, socket)
        client.lifecycleGeneration = 0

        assert.equal(disbandRoom(room.room_number), true)
        assert.equal(lifecycleRegistry.get(room.room_number).phase, "closing")
        socket.close()
        assert.equal(
            lifecycleRegistry.get(room.room_number)?.phase,
            "closing",
            "旧代次 socket 的迟到关闭不得确认当前房间",
        )
    } finally {
        lifecycleRegistry.reset()
        sessionManager.onDismissedSocketClosed = null
        setRoomDisbandListener(null)
    }
})

test("closing waits for every live dismissed socket to close", () => {
    lifecycleRegistry.reset()
    installCloseConfirmation()
    try {
        const room = makeRoom()
        const hostSocket = new FakeSocket()
        const guestSocket = new FakeSocket()
        addRoomClient(room, hostSocket)
        addRoomClient(room, guestSocket, 202)
        seatKernelGuest(room.room_number, 202)

        assert.equal(disbandRoom(room.room_number), true)
        assert.equal(lifecycleRegistry.get(room.room_number).phase, "closing")

        hostSocket.close()
        assert.equal(
            lifecycleRegistry.get(room.room_number)?.phase,
            "closing",
            "剩余活 socket 未确认前不得 closed",
        )

        guestSocket.close()
        assert.equal(
            lifecycleRegistry.get(room.room_number),
            undefined,
            "全部 socket 确认后关闭并回收注册表",
        )
    } finally {
        sessionManager.onDismissedSocketClosed = null
        setRoomDisbandListener(null)
    }
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
