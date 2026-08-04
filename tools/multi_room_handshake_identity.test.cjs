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
    resolveMultiPlayerContext: async () => { throw new Error("handshake must not resolve player context") },
})
stubModule("../src/data/domains/party", {
    getPlayerPartyGroupListSync: () => { throw new Error("handshake must not read parties") },
})
stubModule("../src/data/domains/character", {
    getPlayerCharacterManaNodesSync: () => { throw new Error("handshake must not read mana nodes") },
    getPlayerCharacterSync: () => { throw new Error("handshake must not read characters") },
})
stubModule("../src/data/domains/equipment", {
    getPlayerEquipmentSync: () => { throw new Error("handshake must not read equipment") },
})

const {
    addRoomMember,
    createRoom,
    disbandRoom,
    isRoomMember,
    updateRoomState,
} = require("../src/multi/room/manager")
const { sessionManager } = require("../src/multi/state/SessionManager")
const { handleHandshake } = require("../src/multi/tcp/handshake")
const { AdmissionRegistry } = require("../src/multi/admission/registry")
const { handleMessage: handleLobbyMessage } = require("../src/multi/tcp/lobby")

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

function snapshot(viewerId) {
    return {
        viewerId,
        name: `Player${viewerId}`,
        rank: 1,
        degreeId: 1,
        mainCharacterId: 101,
        playerRoleKind: 1,
        isNewbie: true,
        currentPartyId: 1,
        party: {
            characters: [[1], [1], [1]],
            unison_characters: [[1], [1], [1]],
            equipments: [[1], [1], [1]],
            abilitySoulIds: [[1], [1], [1]],
        },
        npcParties: [{ marker: "npc-one" }, { marker: "npc-two" }],
    }
}

async function handshake(room, viewerId, extra = {}, options = {}) {
    const socket = new FakeSocket()
    const registry = options.registry ?? new AdmissionRegistry({ now: () => 1_000 })
    if (options.admit !== false && room) {
        registry.issue({
            roomNumber: room.room_number,
            participant: { nodeSessionId: "embedded", viewerId },
            snapshot: snapshot(viewerId),
            expiresAt: 6_000,
        })
    }
    await handleHandshake(socket, {
        socklet: "cooperation_room",
        viewerId,
        roomNumber: room?.room_number ?? "missing-room",
        questCategory: room?.category ?? 1,
        questId: room?.quest_id ?? 501,
        connectionId: `cid-${viewerId}`,
        ...extra,
    }, undefined, { admissionProvider: registry })
    socket.registry = registry
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
    assert.deepEqual(guest?.participant, { nodeSessionId: "embedded", viewerId: 222 })
    assert.equal(guest?.snapshot?.name, "Player222")
    assert.deepEqual(guest?.npcPartySnapshots, [{ marker: "npc-one" }, { marker: "npc-two" }])
    assert.equal("localPlayerId" in guest, false)
    assert.equal("playerId" in guest.yourself, false)
    assert.equal(isRoomMember(room, 222), true)
})

test("room admission is required and consumed once", async t => {
    const room = createRoom(113, 1_113, 1, 1, 513, 0, 101)
    t.after(() => disbandRoom(room.room_number))
    const registry = new AdmissionRegistry({ now: () => 1_000 })
    registry.issue({
        roomNumber: room.room_number,
        participant: { nodeSessionId: "embedded", viewerId: 224 },
        snapshot: snapshot(224),
        expiresAt: 6_000,
    })

    const accepted = await handshake(room, 224, {}, { registry })
    const replayed = await handshake(room, 224, {}, { registry, admit: false })
    const missing = await handshake(room, 225, {}, { admit: false })
    t.after(() => sessionManager.removeClientBySocket(accepted))

    assert.equal(accepted.ended, false)
    assert.deepEqual(replayed.messages.at(-1), [3, "HANDSHAKE_DENIED"])
    assert.deepEqual(missing.messages.at(-1), [3, "HANDSHAKE_DENIED"])
})

test("remote participant completes room and battle handshakes without local player storage", async t => {
    const room = createRoom(115, 1_115, 1, 1, 515, 0, 101)
    const registry = new AdmissionRegistry({ now: () => 1_000 })
    const remoteParticipant = { nodeSessionId: "remote-node-session", viewerId: 115 }
    registry.issue({
        roomNumber: room.room_number,
        participant: remoteParticipant,
        snapshot: snapshot(115),
        expiresAt: 6_000,
    })
    t.after(() => disbandRoom(room.room_number))

    const roomSocket = await handshake(room, 115, {}, { registry, admit: false })
    const roomClient = sessionManager.getClient(115, room.room_number)
    t.after(() => sessionManager.removeClientBySocket(roomSocket))
    assert.deepEqual(roomClient?.participant, remoteParticipant)
    assert.equal("localPlayerId" in roomClient, false)

    handleLobbyMessage(roomSocket, [0, [0, { party: snapshot(115).party }]])
    handleLobbyMessage(roomSocket, [0, [6]])
    assert.equal(room.raising_state, 4)

    const battleSocket = new FakeSocket()
    await handleHandshake(battleSocket, {
        socklet: "cooperation_battle",
        room_number: room.room_number,
        connection_id: "cid-115",
    })
    const battleClient = sessionManager.getBattleClient("cid-115")
    t.after(() => {
        if (battleClient) sessionManager.removeClient(battleClient)
    })

    assert.equal(battleSocket.ended, false)
    assert.deepEqual(battleSocket.messages.at(-1), [0, room.room_number, ""])
    assert.deepEqual(battleClient?.participant, remoteParticipant)
    assert.equal("localPlayerId" in battleClient, false)
})

test("invalid handshake identity is rejected before admission consumption", async t => {
    const room = createRoom(114, 1_114, 1, 1, 514, 0, 101)
    t.after(() => disbandRoom(room.room_number))
    const registry = new AdmissionRegistry({ now: () => 1_000 })
    registry.issue({
        roomNumber: room.room_number,
        participant: { nodeSessionId: "embedded", viewerId: 226 },
        snapshot: snapshot(226),
        expiresAt: 6_000,
    })

    const rejected = await handshake(room, 226, {
        viewerId: "226",
        connectionId: " ",
    }, { registry, admit: false })

    assert.deepEqual(rejected.messages.at(-1), [3, "HANDSHAKE_DENIED"])
    assert.equal(registry.consume(room.room_number, 226)?.snapshot.viewerId, 226)
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
