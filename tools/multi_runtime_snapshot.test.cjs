const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    checkBattleRuntimeInvariants,
    sessionManager,
} = require("../src/multi/state/SessionManager")
const { createRoom, disbandRoom, updateRoomState } = require("../src/multi/room/manager")
const { handleBattleMessage } = require("../src/multi/tcp/battle")
const { handleHandshake } = require("../src/multi/tcp/handshake")

class FakeSocket extends EventEmitter {
    constructor() {
        super()
        this.destroyed = false
        this.writable = true
        this.writes = []
    }

    write(value) {
        this.writes.push(String(value))
        return true
    }

    end() { this.writable = false }

    destroy() {
        this.destroyed = true
        this.writable = false
    }
}

const HOST = { nodeSessionId: "embedded", viewerId: 800000701 }
const GUEST = { nodeSessionId: "embedded", viewerId: 800000702 }

function snapshotOf(t, participants = [HOST, GUEST]) {
    const room = createRoom(
        HOST.viewerId,
        HOST.viewerId + 1000,
        1,
        1,
        5101,
        0,
        1,
        false,
        HOST,
    )
    sessionManager.setBattleParticipants(room.room_number, participants.map((participant, index) => ({
        connectionId: `${room.room_number}-p${index}`,
        participant,
    })), participants[0])
    assert.equal(updateRoomState(room.room_number, 4), true)
    t.after(() => {
        sessionManager.clearBattleExpectedCount(room.room_number)
        disbandRoom(room.room_number)
    })
    return room
}

function baseSnapshot(overrides) {
    return {
        roomNumber: "snapshot-room",
        hasBattle: true,
        expectedCount: 2,
        sceneGeneration: 0,
        barrierReleased: false,
        battleSessionId: "session-1",
        hostParticipant: HOST,
        participantIdentities: [HOST, GUEST],
        participantConnectionIds: ["p0", "p1"],
        battleClientConnectionIds: ["p0", "p1"],
        sceneReadyConnectionIds: [],
        finalizedParticipantKeys: [],
        battleFactParticipantIdentities: [HOST, GUEST],
        ...overrides,
    }
}

test.after(() => {})

test("runtime snapshots are frozen and never leak live maps", t => {
    const room = snapshotOf(t)
    const snapshot = sessionManager.getBattleRuntimeSnapshot(room.room_number)

    assert.equal(Object.isFrozen(snapshot), true)
    assert.equal(snapshot.hasBattle, true)
    assert.equal(snapshot.expectedCount, 2)
    assert.equal(snapshot.sceneGeneration, 0)
    assert.equal(snapshot.hostParticipant.viewerId, HOST.viewerId)
    assert.deepEqual(
        snapshot.participantIdentities.map(p => p.viewerId),
        [HOST.viewerId, GUEST.viewerId],
    )

    assert.throws(() => { "use strict"; snapshot.expectedCount = 5 }, TypeError)
    assert.throws(() => { "use strict"; snapshot.participantIdentities.push(GUEST) }, TypeError)

    // mutating the copy must not touch manager state
    sessionManager.battleClients.get(room.room_number)?.clear()
    assert.equal(
        sessionManager.getBattleRuntimeSnapshot(room.room_number).battleClientConnectionIds.length,
        0,
        "the snapshot must be rebuilt per call from live state",
    )
})

test("a healthy battle lifecycle keeps every invariant clean", async t => {
    const room = snapshotOf(t)
    const participants = sessionManager.battleParticipants.get(room.room_number)
    const connectionIds = [...participants.keys()]

    let empty = sessionManager.getBattleRuntimeSnapshot(room.room_number)
    assert.deepEqual(checkBattleRuntimeInvariants(empty), [])

    const sockets = []
    for (const connectionId of connectionIds) {
        const socket = new FakeSocket()
        await handleHandshake(socket, {
            socklet: "cooperation_battle",
            room_number: room.room_number,
            connection_id: connectionId,
        })
        sockets.push(socket)
    }
    let loading = sessionManager.getBattleRuntimeSnapshot(room.room_number)
    assert.equal(loading.battleClientConnectionIds.length, 2)
    assert.deepEqual(checkBattleRuntimeInvariants(loading), [])

    handleBattleMessage(sockets[0], [0, [0]])
    let halfReady = sessionManager.getBattleRuntimeSnapshot(room.room_number)
    assert.deepEqual(halfReady.sceneReadyConnectionIds, [connectionIds[0]])
    assert.deepEqual(checkBattleRuntimeInvariants(halfReady), [])

    handleBattleMessage(sockets[1], [0, [0]])
    let released = sessionManager.getBattleRuntimeSnapshot(room.room_number)
    assert.equal(released.barrierReleased, true)
    assert.equal(released.expectedCount, 0)
    assert.deepEqual(checkBattleRuntimeInvariants(released), [])

    sessionManager.clearBattleExpectedCount(room.room_number)
    let cleared = sessionManager.getBattleRuntimeSnapshot(room.room_number)
    assert.equal(cleared.hasBattle, false)
    assert.equal(cleared.battleSessionId, null)
    assert.deepEqual(checkBattleRuntimeInvariants(cleared), [])
})

test("the invariant checker names each cross-map inconsistency", () => {
    assert.deepEqual(checkBattleRuntimeInvariants(baseSnapshot()), [])

    assert.deepEqual(
        checkBattleRuntimeInvariants(baseSnapshot({
            hostParticipant: { nodeSessionId: "embedded", viewerId: 999999 },
        })),
        ["HOST_NOT_IN_PARTICIPANTS"],
    )

    assert.deepEqual(
        checkBattleRuntimeInvariants(baseSnapshot({ expectedCount: -1 })),
        ["NEGATIVE_EXPECTED_COUNT"],
    )

    assert.deepEqual(
        checkBattleRuntimeInvariants(baseSnapshot({
            sceneReadyConnectionIds: ["p0", "ghost-cid"],
        })),
        ["SCENE_READY_EXCEEDS_CONNECTIONS"],
    )

    assert.deepEqual(
        checkBattleRuntimeInvariants(baseSnapshot({
            sceneReadyConnectionIds: ["p0", "p1", "p0x"],
            battleClientConnectionIds: ["p0", "p1"],
            participantConnectionIds: ["p0", "p1", "p0x"],
            participantIdentities: [HOST, GUEST, { nodeSessionId: "embedded", viewerId: 3 }],
        })),
        ["SCENE_READY_EXCEEDS_CONNECTIONS", "BATTLE_FACT_PARTICIPANT_MISMATCH"],
    )

    assert.deepEqual(
        checkBattleRuntimeInvariants(baseSnapshot({ sceneGeneration: null })),
        ["MISSING_SCENE_GENERATION"],
    )

    assert.deepEqual(
        checkBattleRuntimeInvariants(baseSnapshot({ battleSessionId: null })),
        ["BATTLE_FACT_MISSING"],
    )

    assert.deepEqual(
        checkBattleRuntimeInvariants(baseSnapshot({
            participantIdentities: [HOST],
            participantConnectionIds: ["p0"],
        })),
        ["BATTLE_FACT_PARTICIPANT_MISMATCH"],
    )

    assert.deepEqual(
        checkBattleRuntimeInvariants(baseSnapshot({
            participantIdentities: [],
            participantConnectionIds: [],
            hostParticipant: null,
        })),
        ["PARTICIPANTS_MISSING"],
    )
})

test("a live corruption probe surfaces through real state", t => {
    const room = snapshotOf(t)
    assert.deepEqual(
        checkBattleRuntimeInvariants(sessionManager.getBattleRuntimeSnapshot(room.room_number)),
        [],
    )

    sessionManager.battleHostParticipants.set(room.room_number, {
        nodeSessionId: "embedded",
        viewerId: 424242,
    })
    assert.deepEqual(
        checkBattleRuntimeInvariants(sessionManager.getBattleRuntimeSnapshot(room.room_number)),
        ["HOST_NOT_IN_PARTICIPANTS"],
    )
})
