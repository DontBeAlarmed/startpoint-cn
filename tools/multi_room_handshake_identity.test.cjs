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
    getRoom,
    isRoomMember,
    updateRoomState,
} = require("../src/multi/room/manager")
const { sessionManager } = require("../src/multi/state/SessionManager")
const { handleHandshake } = require("../src/multi/tcp/handshake")
const { AdmissionRegistry } = require("../src/multi/admission/registry")
const {
    configureReconnectGraceMs,
    handleSocketDisconnect,
    resetReconnectGraceMs,
} = require("../src/multi/tcp/lobby")
const { handleMessage: handleLobbyMessage } = require("../src/multi/tcp/lobby")

class FakeSocket extends EventEmitter {
    constructor() {
        super()
        this.writable = true
        this.ended = false
        this.destroyed = false
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

    destroy() {
        this.destroyed = true
        this.writable = false
        this.emit("close")
        return this
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
    assert.equal(sessionManager.getUniqueRoomClientByViewerId(201, "missing-room"), undefined)

    const battleRoom = createRoom(101, 1_101, 1, 1, 501, 0, 101)
    updateRoomState(battleRoom.room_number, 4)
    const battle = await handshake(battleRoom, 202)
    assert.equal(battle.ended, true)
    assert.equal(sessionManager.getUniqueRoomClientByViewerId(202, battleRoom.room_number), undefined)
    disbandRoom(battleRoom.room_number)

    const mismatchRoom = createRoom(102, 1_102, 1, 1, 502, 0, 101)
    const mismatch = await handshake(mismatchRoom, 203, { questId: 999 })
    assert.equal(mismatch.ended, true)
    assert.equal(sessionManager.getUniqueRoomClientByViewerId(203, mismatchRoom.room_number), undefined)
    disbandRoom(mismatchRoom.room_number)

    const fullRoom = createRoom(103, 1_103, 1, 1, 503, 0, 101)
    addRoomMember(fullRoom.room_number, { nodeSessionId: "embedded", viewerId: 204 })
    addRoomMember(fullRoom.room_number, { nodeSessionId: "embedded", viewerId: 205 })
    t.after(() => disbandRoom(fullRoom.room_number))
    const full = await handshake(fullRoom, 206)
    assert.equal(full.ended, true)
    assert.equal(sessionManager.getUniqueRoomClientByViewerId(206, fullRoom.room_number), undefined)

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
    const host = sessionManager.getUniqueRoomClientByViewerId(111, room.room_number)
    const guest = sessionManager.getUniqueRoomClientByViewerId(222, room.room_number)
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
    assert.equal(isRoomMember(room, { nodeSessionId: "embedded", viewerId: 222 }), true)
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

test("room handshake rejects an admission whose participant viewer differs from the TCP viewer", async t => {
    const room = createRoom(114, 1_114, 1, 1, 514, 0, 101)
    t.after(() => disbandRoom(room.room_number))
    const socket = await handshake(room, 226, {}, {
        registry: {
            consume: () => ({
                roomNumber: room.room_number,
                participant: { nodeSessionId: "node-a", viewerId: 227 },
                snapshot: snapshot(227),
                expiresAt: 6_000,
            }),
        },
        admit: false,
    })

    assert.equal(socket.ended, true)
    assert.deepEqual(socket.messages.at(-1), [3, "HANDSHAKE_DENIED"])
    assert.equal(sessionManager.getClientByParticipant(room.room_number, {
        nodeSessionId: "node-a",
        viewerId: 227,
    }), undefined)
})

test("an active room participant rejects the same viewer id from a different node", async t => {
    const registry = new AdmissionRegistry({ now: () => 1_000 })
    const nodeA = { nodeSessionId: "node-a", viewerId: 116 }
    const nodeB = { nodeSessionId: "node-b", viewerId: 116 }
    const room = createRoom(116, 1_116, 1, 1, 516, 0, 101, false, nodeA)
    registry.issue({
        roomNumber: room.room_number,
        participant: nodeA,
        snapshot: snapshot(116),
        expiresAt: 6_000,
    })
    const socketA = await handshake(room, 116, { connectionId: "cid-node-a" }, {
        registry,
        admit: false,
    })
    registry.issue({
        roomNumber: room.room_number,
        participant: nodeB,
        snapshot: snapshot(116),
        expiresAt: 6_000,
    })
    const socketB = await handshake(room, 116, { connectionId: "cid-node-b" }, {
        registry,
        admit: false,
    })
    t.after(() => {
        sessionManager.removeClientBySocket(socketB)
        sessionManager.removeClientBySocket(socketA)
        disbandRoom(room.room_number)
    })

    assert.equal(socketB.ended, true)
    assert.deepEqual(socketB.messages.at(-1), [3, "HANDSHAKE_DENIED"])
    assert.equal(sessionManager.getClientByParticipant(room.room_number, nodeA)?.socket, socketA)
    assert.equal(sessionManager.getClientByParticipant(room.room_number, nodeB), undefined)

    handleLobbyMessage(socketB, [0, [0, { party: snapshot(116).party }]])
    handleLobbyMessage(socketB, [0, [6]])
    assert.notEqual(room.raising_state, 4)

    handleLobbyMessage(socketA, [0, [0, { party: snapshot(116).party }]])
    handleLobbyMessage(socketA, [0, [6]])
    assert.equal(room.raising_state, 4)
    assert.equal(sessionManager.isBattleHostParticipant(room.room_number, nodeA), true)
    assert.equal(sessionManager.isBattleHostParticipant(room.room_number, nodeB), false)
})

test("the same node participant can reconnect without an identity conflict", async t => {
    const registry = new AdmissionRegistry({ now: () => 1_000 })
    const participant = { nodeSessionId: "node-a", viewerId: 117 }
    const room = createRoom(117, 1_117, 1, 1, 517, 0, 101, false, participant)
    const issueAdmission = () => registry.issue({
        roomNumber: room.room_number,
        participant,
        snapshot: snapshot(117),
        expiresAt: 6_000,
    })
    issueAdmission()
    const first = await handshake(room, 117, { connectionId: "cid-first" }, {
        registry,
        admit: false,
    })
    issueAdmission()
    const reconnected = await handshake(room, 117, { connectionId: "cid-reconnected" }, {
        registry,
        admit: false,
    })
    t.after(() => {
        sessionManager.removeClientBySocket(reconnected)
        sessionManager.removeClientBySocket(first)
        disbandRoom(room.room_number)
    })

    assert.equal(first.ended, false)
    assert.equal(reconnected.ended, false)
    assert.equal(first.destroyed, true)
    assert.equal(sessionManager.removeClientBySocket(first), false)
    assert.equal(sessionManager.getClientByParticipant(room.room_number, participant)?.socket, reconnected)
    assert.equal(sessionManager.getUniqueRoomClientByViewerId(117, room.room_number)?.socket, reconnected)
    assert.deepEqual(getRoom(room.room_number)?.member_participants, [participant])
    assert.equal(getRoom(room.room_number)?.room_number, room.room_number)
})

test("a TCP room reconnect cancels the pending network-disconnect cleanup", async t => {
    configureReconnectGraceMs(25)
    const registry = new AdmissionRegistry({ now: () => 1_000 })
    const participant = { nodeSessionId: "node-reconnect", viewerId: 118 }
    const room = createRoom(118, 1_118, 1, 1, 518, 0, 101, false, participant)
    const issueAdmission = () => registry.issue({
        roomNumber: room.room_number,
        participant,
        snapshot: snapshot(participant.viewerId),
        expiresAt: 6_000,
    })
    issueAdmission()
    const first = await handshake(room, participant.viewerId, { connectionId: "network-old" }, {
        registry,
        admit: false,
    })
    assert.equal(first.ended, false)
    assert.equal(handleSocketDisconnect(first), true)

    issueAdmission()
    const reconnected = await handshake(room, participant.viewerId, { connectionId: "network-new" }, {
        registry,
        admit: false,
    })
    t.after(() => {
        resetReconnectGraceMs()
        sessionManager.removeClientBySocket(reconnected)
        disbandRoom(room.room_number)
    })
    assert.equal(reconnected.ended, false)
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(isRoomMember(room, participant), true)
})

test("guest reconnect Enter makes the new connection authoritative for battle", async t => {
    const room = createRoom(118, 1_118, 1, 1, 518, 0, 101)
    const hostSocket = await handshake(room, 118, { connectionId: "host-authority-cid" })
    const firstGuest = await handshake(room, 228, { connectionId: "guest-old-cid" })
    handleLobbyMessage(hostSocket, [0, [0, { party: snapshot(118).party }]])
    handleLobbyMessage(firstGuest, [0, [0, { party: snapshot(228).party }]])
    const hostClient = sessionManager.getUniqueRoomClientByViewerId(118, room.room_number)
    assert.ok(hostClient)
    hostClient.mates.push({
        viewerId: 990000001,
        connectionId: "npc-stable-cid",
        comId: 1,
        party: {},
        state: [1],
    })

    const reconnectedGuest = await handshake(room, 228, { connectionId: "guest-new-cid" })
    handleLobbyMessage(reconnectedGuest, [0, [0, { party: snapshot(228).party }]])
    const newGuestClient = sessionManager.getUniqueRoomClientByViewerId(228, room.room_number)
    t.after(() => {
        sessionManager.removeClientBySocket(hostSocket)
        sessionManager.removeClientBySocket(firstGuest)
        sessionManager.removeClientBySocket(reconnectedGuest)
        sessionManager.removeBattleClient("guest-new-cid")
        disbandRoom(room.room_number)
    })

    assert.equal(firstGuest.destroyed, true)
    assert.equal(sessionManager.getClientBySocket(firstGuest), undefined)
    assert.equal(newGuestClient?.connectionId, "guest-new-cid")
    assert.deepEqual(hostClient.mates.map(mate => mate.connectionId), [
        "host-authority-cid",
        "guest-new-cid",
        "npc-stable-cid",
    ])

    handleLobbyMessage(hostSocket, [0, [6]])
    assert.equal(room.raising_state, 4)
    assert.equal(sessionManager.getBattleParticipant(room.room_number, "guest-old-cid"), undefined)
    assert.deepEqual(
        sessionManager.getBattleParticipant(room.room_number, "guest-new-cid")?.participant,
        { nodeSessionId: "embedded", viewerId: 228 },
    )

    const oldBattleSocket = new FakeSocket()
    await handleHandshake(oldBattleSocket, {
        socklet: "cooperation_battle",
        room_number: room.room_number,
        connection_id: "guest-old-cid",
    })
    assert.equal(oldBattleSocket.ended, true)

    const newBattleSocket = new FakeSocket()
    await handleHandshake(newBattleSocket, {
        socklet: "cooperation_battle",
        room_number: room.room_number,
        connection_id: "guest-new-cid",
    })
    assert.equal(newBattleSocket.ended, false)
    assert.deepEqual(newBattleSocket.messages.at(-1), [0, room.room_number, ""])
})

test("guest reconnect preserves its three-player mate slot through battle handshake", async t => {
    const room = createRoom(119, 1_119, 1, 1, 519, 0, 101)
    const hostSocket = await handshake(room, 119, { connectionId: "host-order-cid" })
    const firstGuestA = await handshake(room, 229, { connectionId: "guest-a-old-cid" })
    const guestB = await handshake(room, 339, { connectionId: "guest-b-cid" })
    handleLobbyMessage(hostSocket, [0, [0, { party: snapshot(119).party }]])
    handleLobbyMessage(firstGuestA, [0, [0, { party: snapshot(229).party }]])
    handleLobbyMessage(guestB, [0, [0, { party: snapshot(339).party }]])

    const reconnectedGuestA = await handshake(room, 229, {
        connectionId: "guest-a-new-cid",
    })
    handleLobbyMessage(reconnectedGuestA, [0, [0, { party: snapshot(229).party }]])
    const hostClient = sessionManager.getUniqueRoomClientByViewerId(119, room.room_number)
    t.after(() => {
        sessionManager.removeClientBySocket(hostSocket)
        sessionManager.removeClientBySocket(firstGuestA)
        sessionManager.removeClientBySocket(guestB)
        sessionManager.removeClientBySocket(reconnectedGuestA)
        sessionManager.removeBattleClient("host-order-cid")
        sessionManager.removeBattleClient("guest-a-new-cid")
        sessionManager.removeBattleClient("guest-b-cid")
        disbandRoom(room.room_number)
    })

    assert.equal(firstGuestA.destroyed, true)
    assert.equal(sessionManager.getClientBySocket(firstGuestA), undefined)
    assert.deepEqual(hostClient?.mates.map(mate => mate.connectionId), [
        "host-order-cid",
        "guest-a-new-cid",
        "guest-b-cid",
    ])

    handleLobbyMessage(hostSocket, [0, [6]])
    assert.equal(room.raising_state, 4)
    assert.equal(sessionManager.getBattleParticipant(room.room_number, "guest-a-old-cid"), undefined)
    assert.deepEqual(
        sessionManager.getBattleParticipant(room.room_number, "guest-a-new-cid")?.participant,
        { nodeSessionId: "embedded", viewerId: 229 },
    )
    assert.deepEqual(
        sessionManager.getBattleParticipant(room.room_number, "guest-b-cid")?.participant,
        { nodeSessionId: "embedded", viewerId: 339 },
    )

    const oldBattleSocket = new FakeSocket()
    await handleHandshake(oldBattleSocket, {
        socklet: "cooperation_battle",
        room_number: room.room_number,
        connection_id: "guest-a-old-cid",
    })
    assert.equal(oldBattleSocket.ended, true)

    for (const connectionId of ["host-order-cid", "guest-a-new-cid", "guest-b-cid"]) {
        const battleSocket = new FakeSocket()
        await handleHandshake(battleSocket, {
            socklet: "cooperation_battle",
            room_number: room.room_number,
            connection_id: connectionId,
        })
        assert.equal(battleSocket.ended, false)
        assert.deepEqual(battleSocket.messages.at(-1), [0, room.room_number, ""])
    }
})

test("remote participant completes room and battle handshakes without local player storage", async t => {
    const registry = new AdmissionRegistry({ now: () => 1_000 })
    const remoteParticipant = { nodeSessionId: "remote-node-session", viewerId: 115 }
    const room = createRoom(115, 1_115, 1, 1, 515, 0, 101, false, remoteParticipant)
    registry.issue({
        roomNumber: room.room_number,
        participant: remoteParticipant,
        snapshot: snapshot(115),
        expiresAt: 6_000,
    })
    t.after(() => disbandRoom(room.room_number))

    const roomSocket = await handshake(room, 115, {}, { registry, admit: false })
    const roomClient = sessionManager.getClientByParticipant(
        room.room_number,
        remoteParticipant,
    )
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
    assert.equal(isRoomMember(room, { nodeSessionId: "embedded", viewerId: 223 }), true)
})
