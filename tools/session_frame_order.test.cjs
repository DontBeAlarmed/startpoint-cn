const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { createRoom, disbandRoom, updateRoomState } = require("../src/multi/room/manager")
const { sessionManager } = require("../src/multi/state/SessionManager")
const { handleHandshake } = require("../src/multi/tcp/handshake")
const {
    getSessionServerStatus,
    startSessionServer,
    stopSessionServer,
} = require("../src/multi/tcp/server")

function deferred() {
    let resolve
    const promise = new Promise(resolvePromise => { resolve = resolvePromise })
    return { promise, resolve }
}

function waitFor(predicate, message, timeoutMs = 2_000) {
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

class RecordingSocket extends EventEmitter {
    constructor() {
        super()
        this.destroyed = false
        this.pauseCalls = 0
        this.resumeCalls = 0
        this.writable = true
        this.writableEnded = false
        this.writes = []
    }

    setEncoding() {}

    write(value) {
        this.writes.push(JSON.parse(String(value).replace(/\0$/, "")))
        return true
    }

    end() {
        this.writableEnded = true
        this.writable = false
    }

    pause() {
        this.pauseCalls++
        return this
    }

    resume() {
        this.resumeCalls++
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

async function startFakeSessionServer(options = {}) {
    let fakeServer
    await startSessionServer({
        ...options,
        createServer(connectionListener) {
            fakeServer = new FakeServer(connectionListener)
            return fakeServer
        },
    })
    return fakeServer
}

async function captureConsole(callback) {
    const entries = []
    const originals = {}
    for (const method of ["log", "warn", "error"]) {
        originals[method] = console[method]
        console[method] = (...args) => entries.push(args.map(String).join(" "))
    }
    try {
        await callback()
    } finally {
        for (const method of ["log", "warn", "error"]) console[method] = originals[method]
    }
    return entries.join("\n")
}

test("coalesced battle handshake and SceneReady preserve frame order", async t => {
    const room = createRoom(95, 1_095, 1, 1, 502, 0, 102)
    const participant = { nodeSessionId: "coalesced-node", viewerId: 95 }
    const connectionId = "coalesced-battle-cid"
    sessionManager.setBattleParticipants(room.room_number, [{ connectionId, participant }], participant)
    updateRoomState(room.room_number, 4)
    t.after(async () => {
        await stopSessionServer()
        sessionManager.removeBattleClient(connectionId)
        sessionManager.clearBattleExpectedCount(room.room_number)
        disbandRoom(room.room_number)
    })

    const fakeServer = await startFakeSessionServer()
    const socket = new RecordingSocket()
    fakeServer.accept(socket)
    const handshake = JSON.stringify({
        socklet: "cooperation_battle",
        room_number: room.room_number,
        connection_id: connectionId,
    })
    socket.emit("data", `${handshake}\0${JSON.stringify([0, [0]])}\0`)

    await waitFor(
        () => socket.writes.some(message => message[0] === 1 && message[1]?.[0] === 1),
        "coalesced SceneReady was not processed after the battle handshake",
    )
    assert.deepEqual(socket.writes.slice(0, 2), [
        [0, room.room_number, ""],
        [1, [1]],
    ])
    assert.equal(socket.pauseCalls, 1)
    assert.equal(socket.resumeCalls, 1)
})

test("later battle data waits for a pending handshake", async t => {
    const room = createRoom(98, 1_098, 1, 1, 504, 0, 104)
    const participant = { nodeSessionId: "pending-node", viewerId: 98 }
    const connectionId = "pending-battle-cid"
    const releaseHandshake = deferred()
    sessionManager.setBattleParticipants(room.room_number, [{ connectionId, participant }], participant)
    updateRoomState(room.room_number, 4)
    t.after(async () => {
        await stopSessionServer()
        sessionManager.removeBattleClient(connectionId)
        sessionManager.clearBattleExpectedCount(room.room_number)
        disbandRoom(room.room_number)
    })

    const fakeServer = await startFakeSessionServer({
        async handleHandshake(socket, data, lifecycle) {
            await releaseHandshake.promise
            await handleHandshake(socket, data, lifecycle)
        },
    })
    const socket = new RecordingSocket()
    fakeServer.accept(socket)
    socket.emit("data", `${JSON.stringify({
        socklet: "cooperation_battle",
        room_number: room.room_number,
        connection_id: connectionId,
    })}\0`)
    await waitFor(
        () => getSessionServerStatus().pendingHandshakes === 1,
        "battle handshake was not held pending",
    )

    socket.emit("data", `${JSON.stringify([0, [0]])}\0`)
    assert.deepEqual(socket.writes, [])
    releaseHandshake.resolve()

    await waitFor(
        () => socket.writes.some(message => message[0] === 1 && message[1]?.[0] === 1),
        "later SceneReady was not processed after the pending handshake",
    )
    assert.deepEqual(socket.writes.slice(0, 2), [
        [0, room.room_number, ""],
        [1, [1]],
    ])
})

test("coalesced room handshake and Enter preserve frame order", async t => {
    const viewerId = 97
    const connectionId = "coalesced-room-cid"
    const room = createRoom(viewerId, 1_097, 1, 1, 503, 0, 103)
    const participant = { nodeSessionId: "coalesced-room-node", viewerId }
    const party = {
        characters: [[1], [1], [1]],
        unison_characters: [[1], [1], [1]],
        equipments: [[1], [1], [1]],
        abilitySoulIds: [[1], [1], [1]],
    }
    t.after(async () => {
        await stopSessionServer()
        disbandRoom(room.room_number)
    })

    const fakeServer = await startFakeSessionServer({
        admissionProvider: {
            consume: () => ({
                roomNumber: room.room_number,
                participant,
                snapshot: {
                    viewerId,
                    name: "coalesced-room-player",
                    rank: 1,
                    degreeId: 1,
                    mainCharacterId: 103,
                    playerRoleKind: 1,
                    isNewbie: false,
                    currentPartyId: 1,
                    party,
                    npcParties: [],
                },
                expiresAt: 6_000,
            }),
        },
    })
    const socket = new RecordingSocket()
    fakeServer.accept(socket)
    const handshake = JSON.stringify({
        socklet: "cooperation_room",
        viewerId,
        room_number: room.room_number,
        connection_id: connectionId,
        questCategory: room.category,
        questId: room.quest_id,
    })
    socket.emit("data", `${handshake}\0${JSON.stringify([0, [0, { party }]])}\0`)

    await waitFor(
        () => socket.writes.some(message => message[0] === 1 && message[1]?.[0] === 0),
        "coalesced Enter was not processed after the room handshake",
    )
    assert.equal(socket.writes[0][0], 0)
    assert.deepEqual(socket.writes[0].slice(1), [connectionId, room.room_number])
    assert.equal(socket.writes[1][0], 1)
    assert.equal(socket.writes[1][1][0], 0)
})

test("rejected coalesced handshake drops queued protocol frames", async t => {
    t.after(() => stopSessionServer())
    const fakeServer = await startFakeSessionServer()
    const socket = new RecordingSocket()
    const output = await captureConsole(async () => {
        fakeServer.accept(socket)
        const handshake = JSON.stringify({
            socklet: "cooperation_room",
            viewerId: 96,
            room_number: "missing-room",
            connection_id: "rejected-coalesced-cid",
        })
        socket.emit("data", `${handshake}\0${JSON.stringify([0, [99]])}\0`)
        await waitFor(
            () => getSessionServerStatus().pendingHandshakes === 0,
            "rejected coalesced handshake did not settle",
        )
    })

    assert.deepEqual(socket.writes, [[3, "HANDSHAKE_DENIED"]])
    assert.doesNotMatch(output, /no client found for socket/)
    assert.equal(socket.pauseCalls, 1)
    assert.equal(socket.resumeCalls, 0)
})
