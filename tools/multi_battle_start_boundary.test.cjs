const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
const restoreContentSnapshot = installBundledGameplaySnapshot()
const { QuestCategory } = require("../src/lib/types")
const roomManager = require("../src/multi/room/manager")
const { createRoom, disbandRoom } = roomManager
const { sessionManager } = require("../src/multi/state/SessionManager")
const { handleMessage: handleLobbyMessage } = require("../src/multi/tcp/lobby")

const HOST_VIEWER_ID = 800000501
const QUEST_ID = 1001001

class FakeSocket extends EventEmitter {
    constructor() {
        super()
        this.destroyed = false
        this.ended = false
        this.writable = true
        this.writes = []
    }

    write(value) {
        this.writes.push(JSON.parse(String(value).replace(/\0$/, "")))
        return true
    }

    end() {
        this.ended = true
        this.writable = false
    }

    destroy() {
        this.destroyed = true
        this.writable = false
    }
}

function createHostRoom(t, hostViewerId = HOST_VIEWER_ID) {
    const room = createRoom(
        hostViewerId,
        hostViewerId + 1000,
        1,
        QuestCategory.BOSS_BATTLE,
        QUEST_ID,
        0,
        1,
        false,
        { nodeSessionId: "embedded", viewerId: hostViewerId },
    )
    const socket = new FakeSocket()
    const client = sessionManager.createClient(
        socket,
        hostViewerId,
        room.room_number,
        `${room.room_number}-host-cid`,
    )
    client.participant = { nodeSessionId: "embedded", viewerId: hostViewerId }
    client.yourself = {
        viewerId: hostViewerId,
        connectionId: client.connectionId,
        party: { characters: [] },
        state: [0],
    }
    client.mates = [client.yourself]
    sessionManager.addClientToRoom(client)
    sessionManager.claimRoomHostParticipant(room.room_number, client.participant)
    handleLobbyMessage(socket, [0, [0, { party: client.yourself.party }]])
    assert.equal(room.raising_state, 1)

    t.after(() => {
        sessionManager.removeClient(client)
        sessionManager.clearBattleExpectedCount(room.room_number)
        disbandRoom(room.room_number)
    })
    return { room, socket, client }
}

function addGuest(t, room, viewerId) {
    const socket = new FakeSocket()
    const client = sessionManager.createClient(
        socket,
        viewerId,
        room.room_number,
        `${room.room_number}-guest-${viewerId}`,
    )
    client.participant = { nodeSessionId: "embedded", viewerId }
    client.yourself = {
        viewerId,
        connectionId: client.connectionId,
        party: { characters: [] },
        state: [0],
    }
    client.mates = [client.yourself]
    sessionManager.addClientToRoom(client)
    t.after(() => sessionManager.removeClient(client))
    return { socket, client }
}

function assertNoBattleRuntime(room) {
    assert.equal(room.raising_state !== 4, true, "room must not enter Battle")
    assert.equal(
        sessionManager.getActiveBattleSessionId(room.room_number),
        null,
        "no battle fact may be published",
    )
    assert.equal(
        sessionManager.battleParticipants.has(room.room_number),
        false,
        "no participant snapshot may be published",
    )
    assert.equal(
        sessionManager.battleExpectedCount.has(room.room_number),
        false,
        "no expected count may be published",
    )
    assert.equal(
        sessionManager.battleSceneGeneration.has(room.room_number),
        false,
        "no scene generation may be published",
    )
}

function countStartFrames(socket) {
    return socket.writes.filter(frame => Array.isArray(frame)
        && frame[0] === 1
        && Array.isArray(frame[1])
        && frame[1][0] === 5).length
}

test.after(() => restoreContentSnapshot())

test("a rejected Battle transition rolls the freshly published runtime back", t => {
    const { room, socket, client } = createHostRoom(t)
    const originalUpdateRoomState = roomManager.updateRoomState
    roomManager.updateRoomState = () => false
    try {
        handleLobbyMessage(socket, [0, [6]])
    } finally {
        roomManager.updateRoomState = originalUpdateRoomState
    }

    assert.equal(room.raising_state, 1, "the room must stay in preparation")
    assertNoBattleRuntime(room)
    assert.equal(countStartFrames(socket), 0, "no Start frame may be broadcast")
    assert.notEqual(client.enterData, null, "a rejected start must not consume the enter data")
})

test("duplicate StartBattle keeps the first battle snapshot", t => {
    const { room, socket, client } = createHostRoom(t)

    handleLobbyMessage(socket, [0, [6]])
    assert.equal(room.raising_state, 4)
    const firstSessionId = sessionManager.getActiveBattleSessionId(room.room_number)
    assert.notEqual(firstSessionId, null)

    handleLobbyMessage(socket, [0, [6]])
    assert.equal(
        sessionManager.getActiveBattleSessionId(room.room_number),
        firstSessionId,
        "a duplicate start must not republish the battle",
    )
    assert.equal(countStartFrames(socket), 1, "a duplicate start must not rebroadcast Start")
})

test("non-host StartBattle never publishes a battle", t => {
    const { room } = createHostRoom(t)
    const { socket } = addGuest(t, room, HOST_VIEWER_ID + 1)

    handleLobbyMessage(socket, [0, [6]])

    assertNoBattleRuntime(room)
    assert.equal(room.raising_state, 1)
})

test("a real member without a resolvable participant rejects the whole start", t => {
    const { room, socket, client } = createHostRoom(t)
    const ghost = {
        viewerId: HOST_VIEWER_ID + 99,
        connectionId: `${room.room_number}-ghost-cid`,
        party: {},
        state: [0],
    }
    client.mates = [client.yourself, ghost]

    handleLobbyMessage(socket, [0, [6]])

    assertNoBattleRuntime(room)
    assert.equal(countStartFrames(socket), 0,
        "no member may be silently dropped from the frozen battle snapshot")
})

test("an empty real-member snapshot rejects the start", t => {
    const { room, socket, client } = createHostRoom(t)
    client.mates = []

    handleLobbyMessage(socket, [0, [6]])

    assertNoBattleRuntime(room)
    assert.equal(countStartFrames(socket), 0, "a battle without members cannot start")
})
