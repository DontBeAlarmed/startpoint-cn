const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const test = require("node:test")

require("ts-node/register/transpile-only")

function stubModule(relativePath, exports) {
    const modulePath = require.resolve(relativePath)
    require.cache[modulePath] = {
        id: modulePath,
        filename: modulePath,
        loaded: true,
        exports,
    }
}

stubModule("../src/utils", { getServerTime: () => 1_725_000_000 })
stubModule("../src/multi/player-context", {
    getPlayerRankLevel: () => 1,
    resolveMultiPlayerContext: async viewerId => ({
        playerId: viewerId + 1_000,
        player: {
            id: viewerId + 1_000,
            name: `Player${viewerId}`,
            rankPoint: 0,
            degreeId: 1,
            leaderCharacterId: 101,
            role: 1,
            tutorialStep: 1,
            partySlot: 1,
        },
    }),
})
stubModule("../src/data/domains/party", { getPlayerPartyGroupListSync: () => ({}) })
stubModule("../src/data/domains/character", {
    getPlayerCharacterManaNodesSync: () => [],
    getPlayerCharacterSync: () => null,
})
stubModule("../src/data/domains/equipment", { getPlayerEquipmentSync: () => null })

const {
    addRoomMember,
    createRoom,
    disbandRoom,
    isRoomMember,
    updateRoomState,
} = require("../src/multi/room/manager")
const { sessionManager } = require("../src/multi/state/SessionManager")
const { handleHandshake } = require("../src/multi/tcp/handshake")

class FakeSocket extends EventEmitter {
    constructor() {
        super()
        this.writable = true
        this.ended = false
        this.messages = []
        this.remoteAddress = "127.0.0.1"
        this.remotePort = 12345
    }

    write(raw) {
        const text = String(raw).replace(/\0$/, "")
        this.messages.push(JSON.parse(text))
        return true
    }

    end() {
        this.ended = true
        this.writable = false
    }
}

async function handshake(room, viewerId, extra = {}) {
    const socket = new FakeSocket()
    await handleHandshake(socket, {
        socklet: "cooperation_room",
        viewerId,
        roomNumber: room?.room_number ?? "missing-room",
        questCategory: room?.category ?? 1,
        questId: room?.quest_id ?? 501,
        connectionId: `cid-${viewerId}`,
        ...extra,
    })
    return socket
}

test("room handshake rejects unknown, non-joinable, mismatched and full rooms", async t => {
    const missing = await handshake(null, 201)
    assert.equal(missing.ended, true)
    assert.deepEqual(missing.messages.at(-1), [3, "HANDSHAKE_DENIED"])
    assert.equal(sessionManager.getClient(201, "missing-room"), undefined)

    const battleRoom = createRoom(101, 1_101, 1, 1, 501, 0, 101)
    updateRoomState(battleRoom.room_number, 4)
    const battle = await handshake(battleRoom, 202)
    assert.equal(battle.ended, true)
    assert.equal(sessionManager.getClient(202, battleRoom.room_number), undefined)
    disbandRoom(battleRoom.room_number)

    const mismatchRoom = createRoom(102, 1_102, 1, 1, 502, 0, 101)
    const mismatch = await handshake(mismatchRoom, 203, { questId: 999 })
    assert.equal(mismatch.ended, true)
    assert.equal(sessionManager.getClient(203, mismatchRoom.room_number), undefined)
    disbandRoom(mismatchRoom.room_number)

    const fullRoom = createRoom(103, 1_103, 1, 1, 503, 0, 101)
    addRoomMember(fullRoom.room_number, 204)
    addRoomMember(fullRoom.room_number, 205)
    t.after(() => disbandRoom(fullRoom.room_number))
    const full = await handshake(fullRoom, 206)
    assert.equal(full.ended, true)
    assert.equal(sessionManager.getClient(206, fullRoom.room_number), undefined)

    const reconnect = await handshake(fullRoom, 204)
    assert.equal(reconnect.ended, false)
    assert.deepEqual(reconnect.messages.at(-1), [0, "cid-204", fullRoom.room_number])
    sessionManager.removeClientBySocket(reconnect)
})

test("successful handshakes record membership and derive host role from the room", async t => {
    const room = createRoom(111, 1_111, 1, 1, 511, 0, 101)
    t.after(() => disbandRoom(room.room_number))

    const hostSocket = await handshake(room, 111)
    const guestSocket = await handshake(room, 222)
    const host = sessionManager.getClient(111, room.room_number)
    const guest = sessionManager.getClient(222, room.room_number)
    t.after(() => {
        sessionManager.removeClientBySocket(guestSocket)
        sessionManager.removeClientBySocket(hostSocket)
    })

    assert.equal(host?.yourself?.isHost, true)
    assert.equal(guest?.yourself?.isHost, false)
    assert.equal(isRoomMember(room, 222), true)
})

test("NPC slots remain replaceable by a real room member", async t => {
    const room = createRoom(112, 1_112, 1, 1, 512, 0, 101)
    room.mates = [
        { viewer_id: 112, com_id: 0 },
        { viewer_id: 900_000_001, com_id: 1 },
        { viewer_id: 900_000_002, com_id: 2 },
    ]
    t.after(() => disbandRoom(room.room_number))

    const guestSocket = await handshake(room, 223)
    t.after(() => sessionManager.removeClientBySocket(guestSocket))

    assert.equal(guestSocket.ended, false)
    assert.equal(isRoomMember(room, 223), true)
})
