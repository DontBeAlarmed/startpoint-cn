"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { AdmissionRegistry } = require("../src/multi/admission/registry")
const { MULTI_PROTOCOL_VERSION } = require("../src/multi/coordinator/contracts")
const { EmbeddedMultiCoordinator } = require("../src/multi/coordinator/embedded")
const { NodeSessionRegistry } = require("../src/multi/hub/node-sessions")
const { sessionManager } = require("../src/multi/state/SessionManager")
const {
    disbandRoom,
    getRoom,
    startRoomCleanup,
    stopRoomCleanup,
    updateRoomState,
} = require("../src/multi/room/manager")

const compatibility = Object.freeze({
    multiProtocolVersion: MULTI_PROTOCOL_VERSION,
    APP_VER: "1.8.1",
    RES_VER: "20240814",
    cdnTargetVersion: "cn-20240814",
    contentDigest: `sha256:${"a".repeat(64)}`,
    modeDigest: `sha256:${"b".repeat(64)}`,
})

function snapshot(viewerId) {
    return Object.freeze({
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
        npcParties: [],
    })
}

class FakeSocket {
    constructor(options = {}) {
        this.destroyed = false
        this.destroyCalls = 0
        this.throwOnDestroy = options.throwOnDestroy === true
        this.writable = true
        this.writes = []
    }

    write(raw) {
        this.writes.push(JSON.parse(String(raw).replace(/\0$/, "")))
        return true
    }

    destroy() {
        this.destroyCalls++
        this.destroyed = true
        this.writable = false
        if (this.throwOnDestroy) throw new Error("injected destroy failure")
        return this
    }
}

async function createGuestInvalidationFixture(t, mode) {
    let now = 1_000
    let credentialEnabled = true
    const generated = ["invalidated-guest-node", "g".repeat(43)]
    let generatedIndex = 0
    const coordinator = new EmbeddedMultiCoordinator({ allowRemoteParticipants: true })
    const cleanupResults = []
    const sessions = new NodeSessionRegistry({
        now: () => now,
        sessionTtlMs: 100,
        generateId: () => generated[generatedIndex++],
        isCredentialEnabled: () => credentialEnabled,
        onInvalidated(nodeSessionId) {
            cleanupResults.push(coordinator.cleanupNodeSession(nodeSessionId))
        },
    })
    const registered = sessions.register("invalidated-guest-credential", MULTI_PROTOCOL_VERSION)
    const guest = { nodeSessionId: registered.nodeSessionId, viewerId: 902 }
    const rooms = []

    for (let index = 0; index < 2; index++) {
        const host = { nodeSessionId: `invalidation-host-${mode}-${index}`, viewerId: 900 + index }
        const created = await coordinator.createRoom({
            requestId: `invalidation-${mode}-${index}`,
            participant: host,
            partyId: 1,
            category: 1,
            questId: 501,
            leaderCharacterId: 101,
            compatibility,
        })
        assert.equal(created.ok, true)
        const roomNumber = created.value.roomNumber
        const room = getRoom(roomNumber)
        room.member_participants.push({ ...guest })
        const hostConnectionId = `invalidation-host-${mode}-${index}`
        const guestConnectionId = `invalidation-guest-${mode}-${index}`
        const hostLobbySocket = new FakeSocket()
        const hostLobby = sessionManager.createClient(
            hostLobbySocket,
            host.viewerId,
            roomNumber,
            `invalidation-lobby-host-${mode}-${index}`,
        )
        hostLobby.participant = host
        assert.equal(sessionManager.addClientToRoom(hostLobby).ok, true)
        const guestLobbySocket = new FakeSocket()
        const guestLobby = sessionManager.createClient(
            guestLobbySocket,
            guest.viewerId,
            roomNumber,
            `invalidation-lobby-${mode}-${index}`,
        )
        guestLobby.participant = guest
        assert.equal(sessionManager.addClientToRoom(guestLobby).ok, true)
        const lobbyMates = [
            { viewerId: host.viewerId, connectionId: hostLobby.connectionId, party: {} },
            { viewerId: guest.viewerId, connectionId: guestLobby.connectionId, party: {} },
        ]
        hostLobby.mates = [...lobbyMates]
        guestLobby.mates = [...lobbyMates]
        room.mates = lobbyMates.map(mate => ({ viewer_id: mate.viewerId, com_id: 0 }))
        const guestBattleSocket = new FakeSocket({ throwOnDestroy: index === 0 })
        const guestBattle = sessionManager.createClient(
            guestBattleSocket,
            guest.viewerId,
            roomNumber,
            guestConnectionId,
        )
        guestBattle.participant = guest
        guestBattle.isBattle = true
        sessionManager.addBattleClient(guestConnectionId, guestBattle)
        sessionManager.setBattleParticipants(roomNumber, [
            { connectionId: hostConnectionId, participant: host },
            { connectionId: guestConnectionId, participant: guest },
        ], host)
        updateRoomState(roomNumber, 4)
        const battleSessionId = sessionManager.getActiveBattleSessionId(roomNumber)
        assert.equal(typeof battleSessionId, "string")
        sessionManager.markParticipantFinalizedBattle(roomNumber, host)
        const finalized = await coordinator.finalizeBattle({ participant: host, roomNumber, battleSessionId })
        assert.equal(finalized.ok, true)
        assert.equal(finalized.value.finalized, true)
        rooms.push({
            battleSessionId,
            guestBattleSocket,
            guestLobbySocket,
            hostLobby,
            host,
            roomNumber,
        })
    }

    t.after(() => {
        for (const room of rooms) {
            sessionManager.closeRoomClients(room.roomNumber)
            disbandRoom(room.roomNumber)
        }
    })
    return {
        cleanupResults,
        coordinator,
        expire() {
            if (mode === "expiry") now = registered.expiresAt
            else credentialEnabled = false
            return sessions.sweep()
        },
        guest,
        rooms,
        sessions,
    }
}

for (const mode of ["expiry", "revoke"]) {
    test(`invalidated guest cleanup converges finalized rooms after ${mode}`, async t => {
        const fixture = await createGuestInvalidationFixture(t, mode)

        // The home save already committed its abort, but the Hub abort request was lost.
        assert.equal(fixture.sessions.isValid(fixture.guest.nodeSessionId), true)
        assert.equal(fixture.expire(), 1)
        assert.deepEqual(fixture.cleanupResults, [2])
        for (const room of fixture.rooms) {
            assert.equal(getRoom(room.roomNumber).raising_state, 1)
            assert.equal(sessionManager.getActiveBattleSessionId(room.roomNumber), null)
            assert.equal(room.guestLobbySocket.destroyed, true)
            assert.equal(room.guestBattleSocket.destroyed, true)
            assert.deepEqual(getRoom(room.roomNumber).member_participants, [room.host])
            assert.deepEqual(getRoom(room.roomNumber).mates, [{
                viewer_id: room.host.viewerId,
                com_id: 0,
            }])
            assert.deepEqual(room.hostLobby.mates.map(mate => mate.viewerId), [room.host.viewerId])
            assert.equal((await fixture.coordinator.getBattleStatus({
                participant: room.host,
                roomNumber: room.roomNumber,
                battleSessionId: room.battleSessionId,
            })).ok, true)
            assert.deepEqual(await fixture.coordinator.getBattleStatus({
                participant: fixture.guest,
                roomNumber: room.roomNumber,
                battleSessionId: room.battleSessionId,
            }), { ok: false, error: "ROOM_PERMISSION_DENIED" })
        }
    })
}

test("invalidated guest cleanup continues after one room state cleanup throws", async t => {
    const fixture = await createGuestInvalidationFixture(t, "expiry")
    const originalCleanup = sessionManager.removeNodeSessionBattleState
    let injected = false
    sessionManager.removeNodeSessionBattleState = function (...args) {
        const result = originalCleanup.apply(this, args)
        if (!injected) {
            injected = true
            throw new Error("injected room state cleanup failure")
        }
        return result
    }
    t.after(() => {
        sessionManager.removeNodeSessionBattleState = originalCleanup
    })

    assert.equal(fixture.expire(), 1)
    assert.deepEqual(fixture.cleanupResults, [2])
    for (const room of fixture.rooms) {
        assert.equal(sessionManager.getActiveBattleSessionId(room.roomNumber), null)
        assert.equal(getRoom(room.roomNumber).raising_state, 1)
    }
})

test("invalid remote sessions remove their unconnected rooms and admissions only", async t => {
    let now = 1_000
    const enabled = new Map([
        ["credential-a", true],
        ["credential-b", true],
    ])
    const generated = [
        "remote-node-a", "a".repeat(43),
        "remote-node-b", "b".repeat(43),
    ]
    let generatedIndex = 0
    const admissions = new AdmissionRegistry({ now: () => now })
    const coordinator = new EmbeddedMultiCoordinator({ allowRemoteParticipants: true })
    const invalidations = []
    const sessions = new NodeSessionRegistry({
        now: () => now,
        sessionTtlMs: 100,
        generateId: () => generated[generatedIndex++],
        isCredentialEnabled: credentialId => enabled.get(credentialId) === true,
        onInvalidated(nodeSessionId) {
            invalidations.push(nodeSessionId)
            admissions.removeByNodeSession(nodeSessionId)
            coordinator.cleanupNodeSession(nodeSessionId)
        },
    })
    const firstSession = sessions.register("credential-a", MULTI_PROTOCOL_VERSION)
    const secondSession = sessions.register("credential-b", MULTI_PROTOCOL_VERSION)
    const firstParticipant = { nodeSessionId: firstSession.nodeSessionId, viewerId: 501 }
    const secondParticipant = { nodeSessionId: secondSession.nodeSessionId, viewerId: 502 }
    const create = participant => coordinator.createRoom({
        requestId: `create-${participant.viewerId}`,
        participant,
        partyId: 1,
        category: 1,
        questId: 501,
        leaderCharacterId: 101,
        compatibility,
    })
    const firstRoom = await create(firstParticipant)
    const secondRoom = await create(secondParticipant)
    assert.equal(firstRoom.ok, true)
    assert.equal(secondRoom.ok, true)
    t.after(async () => {
        await coordinator.disbandRoom({
            participant: firstParticipant,
            roomNumber: firstRoom.value.roomNumber,
        })
        await coordinator.disbandRoom({
            participant: secondParticipant,
            roomNumber: secondRoom.value.roomNumber,
        })
    })
    for (const [room, participant] of [
        [firstRoom.value, firstParticipant],
        [secondRoom.value, secondParticipant],
    ]) {
        admissions.issue({
            roomNumber: room.roomNumber,
            participant,
            snapshot: snapshot(participant.viewerId),
            expiresAt: 5_000,
        })
    }

    enabled.set("credential-a", false)
    assert.equal(sessions.isValid(firstSession.nodeSessionId), false)
    assert.equal(sessions.isValid(firstSession.nodeSessionId), false)
    assert.deepEqual(invalidations, [firstSession.nodeSessionId])
    assert.equal(admissions.consume(firstRoom.value.roomNumber, 501), null)
    assert.deepEqual(await coordinator.getRoomStatus({
        participant: secondParticipant,
        roomNumber: firstRoom.value.roomNumber,
    }), { ok: false, error: "ROOM_NOT_FOUND" })
    assert.equal((await coordinator.getRoomStatus({
        participant: secondParticipant,
        roomNumber: secondRoom.value.roomNumber,
    })).ok, true)
    assert.equal(admissions.consume(secondRoom.value.roomNumber, 502)?.participant.viewerId, 502)

    admissions.issue({
        roomNumber: secondRoom.value.roomNumber,
        participant: secondParticipant,
        snapshot: snapshot(502),
        expiresAt: 5_000,
    })
    now = 1_100
    assert.equal(sessions.sweep(), 1)
    assert.equal(sessions.sweep(), 0)
    assert.deepEqual(invalidations, [
        firstSession.nodeSessionId,
        secondSession.nodeSessionId,
    ])
    assert.equal(admissions.consume(secondRoom.value.roomNumber, 502), null)
    assert.deepEqual(await coordinator.getRoomStatus({
        participant: firstParticipant,
        roomNumber: secondRoom.value.roomNumber,
    }), { ok: false, error: "ROOM_NOT_FOUND" })
})

test("invalidating a host closes every lobby and battle client in its room", async t => {
    const coordinator = new EmbeddedMultiCoordinator({ allowRemoteParticipants: true })
    const host = { nodeSessionId: "remote-node-a", viewerId: 601 }
    const guest = { nodeSessionId: "remote-node-b", viewerId: 602 }
    const otherHost = { nodeSessionId: "remote-node-b", viewerId: 603 }
    const created = await coordinator.createRoom({
        requestId: "cleanup-connected-room",
        participant: host,
        partyId: 1,
        category: 1,
        questId: 501,
        leaderCharacterId: 101,
        compatibility,
    })
    const other = await coordinator.createRoom({
        requestId: "cleanup-other-room",
        participant: otherHost,
        partyId: 1,
        category: 1,
        questId: 501,
        leaderCharacterId: 101,
        compatibility,
    })
    assert.equal(created.ok, true)
    assert.equal(other.ok, true)

    const roomNumber = created.value.roomNumber
    const hostLobbySocket = new FakeSocket()
    const guestLobbySocket = new FakeSocket()
    const hostBattleSocket = new FakeSocket()
    const guestBattleSocket = new FakeSocket()
    const otherSocket = new FakeSocket()
    const addLobbyClient = (socket, participant, connectionId) => {
        const client = sessionManager.createClient(socket, participant.viewerId, roomNumber, connectionId)
        client.participant = participant
        assert.equal(sessionManager.addClientToRoom(client).ok, true)
        return client
    }
    addLobbyClient(hostLobbySocket, host, "cleanup-lobby-host")
    addLobbyClient(guestLobbySocket, guest, "cleanup-lobby-guest")
    const addBattleClient = (socket, participant, connectionId) => {
        const client = sessionManager.createClient(socket, participant.viewerId, roomNumber, connectionId)
        client.participant = participant
        client.isBattle = true
        sessionManager.addBattleClient(connectionId, client)
        return client
    }
    const hostBattle = addBattleClient(hostBattleSocket, host, "cleanup-battle-host")
    const guestBattle = addBattleClient(guestBattleSocket, guest, "cleanup-battle-guest")
    sessionManager.setBattleParticipants(roomNumber, [
        { connectionId: hostBattle.connectionId, participant: host },
        { connectionId: guestBattle.connectionId, participant: guest },
    ], host)
    updateRoomState(roomNumber, 4)

    const otherRoomNumber = other.value.roomNumber
    const otherClient = sessionManager.createClient(otherSocket, otherHost.viewerId, otherRoomNumber, "other-room-host")
    otherClient.participant = otherHost
    sessionManager.addClientToRoom(otherClient)
    t.after(() => {
        disbandRoom(roomNumber)
        disbandRoom(otherRoomNumber)
        sessionManager.removeClientBySocket(hostLobbySocket)
        sessionManager.removeClientBySocket(guestLobbySocket)
        sessionManager.removeClientBySocket(hostBattleSocket)
        sessionManager.removeClientBySocket(guestBattleSocket)
        sessionManager.removeClientBySocket(otherSocket)
    })

    assert.equal(coordinator.cleanupNodeSession(host.nodeSessionId), 1)
    assert.equal(getRoom(roomNumber), undefined)
    assert.deepEqual(sessionManager.getClientsInRoom(roomNumber), [])
    assert.deepEqual(sessionManager.getBattleClientsInRoom(roomNumber), [])
    for (const socket of [hostLobbySocket, guestLobbySocket, hostBattleSocket, guestBattleSocket]) {
        assert.equal(socket.destroyed, true)
        assert.equal(socket.destroyCalls, 1)
        assert.equal(sessionManager.getClientBySocket(socket), undefined)
    }
    assert.equal(sessionManager.getBattleClient("cleanup-battle-host"), undefined)
    assert.equal(sessionManager.getBattleClient("cleanup-battle-guest"), undefined)
    assert.deepEqual(hostLobbySocket.writes[0], [1, [6, "multibattle_room_dismissed"]])
    assert.deepEqual(guestLobbySocket.writes[0], [1, [6, "multibattle_room_dismissed"]])
    assert.deepEqual(guestBattleSocket.writes[0], [1, [0, "cleanup-battle-host"]])
    assert.equal(getRoom(otherRoomNumber)?.room_number, otherRoomNumber)
    assert.equal(otherSocket.destroyed, false)
    assert.equal(sessionManager.getClientBySocket(otherSocket), otherClient)
})

test("revoked room teardown never releases a partially ready battle barrier", async t => {
    const coordinator = new EmbeddedMultiCoordinator({ allowRemoteParticipants: true })
    for (const [index, order] of [
        [0, ["host", "guest"]],
        [1, ["guest", "host"]],
    ]) {
        const host = { nodeSessionId: `barrier-host-${index}`, viewerId: 800 + index * 10 }
        const guest = { nodeSessionId: `barrier-guest-${index}`, viewerId: host.viewerId + 1 }
        const created = await coordinator.createRoom({
            requestId: `barrier-room-${index}`,
            participant: host,
            partyId: 1,
            category: 1,
            questId: 501,
            leaderCharacterId: 101,
            compatibility,
        })
        assert.equal(created.ok, true)
        const roomNumber = created.value.roomNumber
        const sockets = {
            host: new FakeSocket({ throwOnDestroy: index === 0 }),
            guest: new FakeSocket(),
        }
        const clients = {
            host: sessionManager.createClient(sockets.host, host.viewerId, roomNumber, `barrier-host-${index}`),
            guest: sessionManager.createClient(sockets.guest, guest.viewerId, roomNumber, `barrier-guest-${index}`),
        }
        clients.host.participant = host
        clients.guest.participant = guest
        clients.host.isBattle = true
        clients.guest.isBattle = true
        sessionManager.setBattleParticipants(roomNumber, [
            { connectionId: clients.host.connectionId, participant: host },
            { connectionId: clients.guest.connectionId, participant: guest },
        ], host)
        updateRoomState(roomNumber, 4)
        for (const role of order) {
            sessionManager.addBattleClient(clients[role].connectionId, clients[role])
        }
        t.after(() => {
            sessionManager.closeRoomClients(roomNumber)
            disbandRoom(roomNumber)
        })

        assert.equal(sessionManager.markSceneReady(clients.guest.connectionId, roomNumber), false)
        assert.equal(coordinator.cleanupNodeSession(host.nodeSessionId), 1)

        for (const socket of Object.values(sockets)) {
            assert.equal(socket.destroyed, true)
            assert.equal(socket.destroyCalls, 1)
            assert.equal(sessionManager.getClientBySocket(socket), undefined)
            assert.equal(socket.writes.some(message => (
                JSON.stringify(message) === JSON.stringify([1, [1]])
            )), false)
        }
        assert.deepEqual(sessionManager.getBattleClientsInRoom(roomNumber), [])
        assert.equal(sessionManager.getBattleClient(clients.host.connectionId), undefined)
        assert.equal(sessionManager.getBattleClient(clients.guest.connectionId), undefined)
        assert.equal(sessionManager.getBattleParticipant(roomNumber, clients.host.connectionId), undefined)
        assert.equal(sessionManager.getBattleParticipant(roomNumber, clients.guest.connectionId), undefined)
        assert.equal(sessionManager.markSceneReady(clients.guest.connectionId, roomNumber), false)
        assert.equal(sessionManager.beginNextBattleScene(clients.guest.connectionId, roomNumber), false)
        assert.equal(sessionManager.canFinalizeBattle(roomNumber, false), false)
        assert.equal(sessionManager.replayBattleStartIfNeeded(clients.guest.connectionId, roomNumber), false)
        assert.equal(coordinator.cleanupNodeSession(host.nodeSessionId), 0)
        assert.equal(sessionManager.closeRoomClients(roomNumber), 0)
    }
})

test("expired rooms do not leave a host-session cleanup index", async t => {
    const coordinator = new EmbeddedMultiCoordinator({ allowRemoteParticipants: true })
    const participant = { nodeSessionId: "expired-node", viewerId: 701 }
    const created = await coordinator.createRoom({
        requestId: "expired-room",
        participant,
        partyId: 1,
        category: 1,
        questId: 501,
        leaderCharacterId: 101,
        compatibility,
    })
    assert.equal(created.ok, true)
    const room = getRoom(created.value.roomNumber)
    assert.ok(room)
    room.host_entry_time = 0

    let cleanupCallback
    const timer = { unref() {} }
    startRoomCleanup({
        createInterval(callback) {
            cleanupCallback = callback
            return timer
        },
        clearInterval() {},
    })
    t.after(() => {
        stopRoomCleanup()
        disbandRoom(created.value.roomNumber)
    })
    cleanupCallback()

    assert.equal(getRoom(created.value.roomNumber), undefined)
    assert.equal(coordinator.cleanupNodeSession(participant.nodeSessionId), 0)
    assert.equal("hostRoomsByNodeSession" in coordinator, false)
})
