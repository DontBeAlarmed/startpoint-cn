const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { QuestCategory } = require("../src/lib/types")
const { canFinishMultiBattleQuest, cleanupAbortedMultiBattle } = require("../src/multi/http/battle")
const { createRoom, disbandRoom } = require("../src/multi/room/manager")
const { sessionManager } = require("../src/multi/state/SessionManager")
const { handleBattleMessage } = require("../src/multi/tcp/battle")
const { handleHandshake } = require("../src/multi/tcp/handshake")
const { handleMessage: handleLobbyMessage } = require("../src/multi/tcp/lobby")

class FakeSocket {
    constructor() {
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
}

const cleanup = []

function createBattle(questId, count, category = QuestCategory.BOSS_BATTLE) {
    const room = createRoom(800000001, 1, 1, category, questId, 0, 1, true)
    const clients = []
    for (let index = 0; index < count; index++) {
        const socket = new FakeSocket()
        const connectionId = `multiscene-${room.room_number}-${index}`
        const client = sessionManager.createClient(socket, 800000001 + index, room.room_number, connectionId, 100 + index)
        client.isBattle = true
        sessionManager.addBattleClient(connectionId, client)
        clients.push({ client, socket })
    }
    sessionManager.setBattleExpectedCount(room.room_number, count)
    cleanup.push({ clients, lobbyClients: [], room })
    return { clients, room }
}

function notify(entry, message) {
    handleBattleMessage(entry.socket, [0, message])
}

function countMessage(entry, expected) {
    return entry.socket.writes.filter(value => JSON.stringify(value) === JSON.stringify(expected)).length
}

test.afterEach(() => {
    while (cleanup.length > 0) {
        const { clients, lobbyClients, room } = cleanup.pop()
        for (const { client } of clients) sessionManager.removeBattleClient(client.connectionId)
        for (const client of lobbyClients) sessionManager.removeClient(client)
        sessionManager.clearBattleExpectedCount(room.room_number)
        disbandRoom(room.room_number)
    }
})

test("BothBoss performs a second SceneReady barrier and finalizes only after index 2", () => {
    const battle = createBattle(1001002, 2)
    const [first, second] = battle.clients

    notify(first, [0])
    notify(second, [0])
    assert.equal(countMessage(first, [1, [1]]), 1)
    assert.equal(countMessage(second, [1, [1]]), 1)

    notify(first, [2])
    assert.equal(countMessage(first, [1, [2]]), 0, "second scene must finish before Finalized")
    assert.equal(canFinishMultiBattleQuest({ isBothBoss: true }, battle.room.room_number, first.client.playerId), false)

    notify(first, [1])
    notify(second, [0])
    notify(first, [0])
    assert.equal(countMessage(first, [1, [1]]), 1, "stale first-scene ready must not satisfy generation 1")
    notify(first, [2])
    assert.equal(countMessage(first, [1, [2]]), 0, "second SceneReady barrier must finish before Finalized")
    notify(second, [1])
    notify(second, [0])
    assert.equal(countMessage(first, [1, [1]]), 2)
    assert.equal(countMessage(second, [1, [1]]), 2)
    assert.equal(countMessage(first, [1, [2]]), 0)

    notify(first, [2])
    assert.equal(countMessage(first, [1, [2]]), 1)
    assert.equal(canFinishMultiBattleQuest({ isBothBoss: true }, battle.room.room_number, first.client.playerId), true)
})

test("ordinary boss battle ignores LevelNext", () => {
    const battle = createBattle(1001001, 1)
    const [client] = battle.clients

    notify(client, [0])
    notify(client, [1])
    notify(client, [0])
    assert.equal(countMessage(client, [1, [1]]), 1)
    assert.equal(countMessage(client, [1, [2]]), 0)

    notify(client, [2])
    assert.equal(countMessage(client, [1, [2]]), 1)
})

test("non-boss multiplayer quest still finalizes after its first barrier", () => {
    const battle = createBattle(200015001, 1, QuestCategory.ADVENT_EVENT_SINGLE)
    const [client] = battle.clients

    notify(client, [0])
    notify(client, [2])
    assert.equal(countMessage(client, [1, [2]]), 1)
})

test("disconnect releases the remaining client from the next-scene barrier", () => {
    const battle = createBattle(1001003, 2)
    const [first, second] = battle.clients

    notify(first, [0])
    notify(second, [0])
    notify(first, [1])
    notify(first, [0])
    sessionManager.removeClient(second.client)

    assert.equal(countMessage(first, [1, [1]]), 2)
})

test("a participant reconnecting after barrier release receives only its missed BattleStart", async () => {
    const battle = createBattle(1001002, 2)
    const [host, guest] = battle.clients
    battle.room.raising_state = 4
    sessionManager.setBattleParticipants(battle.room.room_number, [
        { connectionId: host.client.connectionId, viewerId: host.client.viewerId, playerId: host.client.playerId },
        { connectionId: guest.client.connectionId, viewerId: guest.client.viewerId, playerId: guest.client.playerId },
    ])

    notify(host, [0])
    sessionManager.removeClient(guest.client)
    assert.equal(countMessage(host, [1, [1]]), 1)
    notify(host, [1])
    notify(host, [0])
    assert.equal(countMessage(host, [1, [1]]), 2)

    const socket = new FakeSocket()
    await handleHandshake(socket, {
        socklet: "cooperation_battle",
        room_number: battle.room.room_number,
        connection_id: guest.client.connectionId,
    })
    const client = sessionManager.getBattleClient(guest.client.connectionId)
    assert.equal(client?.playerId, guest.client.playerId)
    const reconnected = { client, socket }
    notify(reconnected, [0])

    assert.equal(countMessage(reconnected, [1, [1]]), 1)
    assert.equal(countMessage(host, [1, [1]]), 2, "existing players must not receive a duplicate BattleStart")
    notify(reconnected, [1])
    notify(reconnected, [0])
    assert.equal(countMessage(reconnected, [1, [1]]), 2)
    assert.equal(countMessage(host, [1, [1]]), 2)
    sessionManager.removeClient(client)
})

test("an unwritable BattleStart target remains eligible for reconnect replay", async () => {
    const battle = createBattle(1001002, 2)
    const [host, guest] = battle.clients
    battle.room.raising_state = 4
    sessionManager.setBattleParticipants(battle.room.room_number, [
        { connectionId: host.client.connectionId, viewerId: host.client.viewerId, playerId: host.client.playerId },
        { connectionId: guest.client.connectionId, viewerId: guest.client.viewerId, playerId: guest.client.playerId },
    ])

    guest.socket.writable = false
    notify(host, [0])
    notify(guest, [0])
    assert.equal(countMessage(host, [1, [1]]), 1)
    assert.equal(countMessage(guest, [1, [1]]), 0)
    sessionManager.removeClient(guest.client)

    const socket = new FakeSocket()
    await handleHandshake(socket, {
        socklet: "cooperation_battle",
        room_number: battle.room.room_number,
        connection_id: guest.client.connectionId,
    })
    const client = sessionManager.getBattleClient(guest.client.connectionId)
    const reconnected = { client, socket }
    notify(reconnected, [0])
    assert.equal(countMessage(reconnected, [1, [1]]), 1)
    assert.equal(countMessage(host, [1, [1]]), 1)
    sessionManager.removeClient(client)
})

test("scene cleanup preserves each real player's Finalize until that player consumes it", () => {
    const battle = createBattle(1001002, 2)
    const [first, second] = battle.clients

    notify(first, [0])
    notify(second, [0])
    notify(first, [1])
    notify(second, [1])
    notify(first, [0])
    notify(second, [0])
    notify(first, [2])
    notify(second, [2])

    assert.equal(sessionManager.consumePlayerFinalizedBattle(
        battle.room.room_number,
        first.client.playerId,
    ), true)
    sessionManager.clearBattleSceneState(battle.room.room_number)
    assert.equal(sessionManager.hasPlayerFinalizedBattle(
        battle.room.room_number,
        first.client.playerId,
    ), false)
    assert.equal(sessionManager.hasPlayerFinalizedBattle(
        battle.room.room_number,
        second.client.playerId,
    ), true)
    assert.equal(sessionManager.consumePlayerFinalizedBattle(
        battle.room.room_number,
        second.client.playerId,
    ), true)
})

test("battle handshake requires an identity from the host StartBattle snapshot", async () => {
    const room = createRoom(800000101, 201, 1, QuestCategory.BOSS_BATTLE, 1001002, 0, 1, false)
    const lobbySocket = new FakeSocket()
    const lobbyClient = sessionManager.createClient(lobbySocket, 800000101, room.room_number, "bound-cid", 201)
    lobbyClient.yourself = {
        viewerId: lobbyClient.viewerId,
        playerId: lobbyClient.playerId,
        connectionId: lobbyClient.connectionId,
        state: [1],
    }
    lobbyClient.mates = [lobbyClient.yourself]
    sessionManager.addClientToRoom(lobbyClient)
    handleLobbyMessage(lobbySocket, [0, [6]])
    assert.equal(room.raising_state, 4)

    const lateLobbySocket = new FakeSocket()
    const lateLobbyClient = sessionManager.createClient(lateLobbySocket, 800000102, room.room_number, "late-cid", 202)
    sessionManager.addClientToRoom(lateLobbyClient)
    const entry = { clients: [], lobbyClients: [lobbyClient, lateLobbyClient], room }
    cleanup.push(entry)

    const anonymousSocket = new FakeSocket()
    await handleHandshake(anonymousSocket, {
        socklet: "cooperation_battle",
        room_number: room.room_number,
        connection_id: "anonymous-cid",
    })
    assert.equal(anonymousSocket.ended, true)
    assert.equal(sessionManager.getBattleClient("anonymous-cid"), undefined)

    const lateBattleSocket = new FakeSocket()
    await handleHandshake(lateBattleSocket, {
        socklet: "cooperation_battle",
        room_number: room.room_number,
        connection_id: "late-cid",
    })
    assert.equal(lateBattleSocket.ended, true, "late lobby identity must not join an active battle")
    assert.equal(sessionManager.getBattleClient("late-cid"), undefined)

    sessionManager.removeClient(lobbyClient)
    const battleSocket = new FakeSocket()
    await handleHandshake(battleSocket, {
        socklet: "cooperation_battle",
        room_number: room.room_number,
        connection_id: "bound-cid",
    })
    const battleClient = sessionManager.getBattleClient("bound-cid")
    assert.equal(battleClient?.viewerId, 800000101)
    assert.equal(battleClient?.playerId, 201)
    sessionManager.removeClient(battleClient)

    const reconnectedSocket = new FakeSocket()
    await handleHandshake(reconnectedSocket, {
        socklet: "cooperation_battle",
        room_number: room.room_number,
        connection_id: "bound-cid",
    })
    const reconnectedClient = sessionManager.getBattleClient("bound-cid")
    assert.equal(reconnectedSocket.ended, false, "battle disconnect must not revoke the start snapshot")
    assert.equal(reconnectedClient?.viewerId, 800000101)
    assert.equal(reconnectedClient?.playerId, 201)
    sessionManager.removeClient(reconnectedClient)
    assert.equal(sessionManager.getClient(800000101, room.room_number), undefined)
})

test("only the room host can freeze the StartBattle participant snapshot", () => {
    const room = createRoom(800000201, 301, 1, QuestCategory.BOSS_BATTLE, 1001002, 0, 1, false)
    const hostSocket = new FakeSocket()
    const guestSocket = new FakeSocket()
    const host = sessionManager.createClient(hostSocket, 800000201, room.room_number, "host-start-cid", 301)
    const guest = sessionManager.createClient(guestSocket, 800000202, room.room_number, "guest-start-cid", 302)
    host.yourself = { viewerId: host.viewerId, playerId: host.playerId, connectionId: host.connectionId, state: [1] }
    guest.yourself = { viewerId: guest.viewerId, playerId: guest.playerId, connectionId: guest.connectionId, state: [1] }
    host.mates = [host.yourself, guest.yourself]
    guest.mates = [host.yourself, guest.yourself]
    sessionManager.addClientToRoom(host)
    sessionManager.addClientToRoom(guest)
    cleanup.push({ clients: [], lobbyClients: [host, guest], room })

    handleLobbyMessage(guestSocket, [0, [6]])
    assert.equal(room.raising_state, 2)

    handleLobbyMessage(hostSocket, [0, [6]])
    assert.equal(room.raising_state, 4)
})

test("guest abort removes only that battle participant and preserves host settlement", () => {
    assert.equal(typeof cleanupAbortedMultiBattle, "function")
    const battle = createBattle(1001002, 2)
    const [host, guest] = battle.clients
    battle.room.host_player_id = host.client.playerId
    sessionManager.setBattleParticipants(battle.room.room_number, [
        { connectionId: host.client.connectionId, viewerId: host.client.viewerId, playerId: host.client.playerId },
        { connectionId: guest.client.connectionId, viewerId: guest.client.viewerId, playerId: guest.client.playerId },
    ])
    sessionManager.markPlayerFinalizedBattle(battle.room.room_number, host.client.playerId)
    sessionManager.markPlayerFinalizedBattle(battle.room.room_number, guest.client.playerId)

    cleanupAbortedMultiBattle(battle.room.room_number, guest.client.playerId)

    assert.equal(sessionManager.getBattleClient(guest.client.connectionId), undefined)
    assert.equal(sessionManager.getBattleClient(host.client.connectionId), host.client)
    assert.equal(sessionManager.hasPlayerFinalizedBattle(battle.room.room_number, guest.client.playerId), false)
    assert.equal(sessionManager.hasPlayerFinalizedBattle(battle.room.room_number, host.client.playerId), true)
})

test("CN measurement, line warning, and heartbeat indices do not alias finalize", () => {
    const battle = createBattle(1001002, 2)
    const [first, second] = battle.clients

    notify(first, [3, 42, 12.5])
    assert.equal(first.socket.writes[0][0], 1)
    assert.deepEqual(first.socket.writes[0][1].slice(0, 3), [3, 42, 12.5])
    assert.equal(first.socket.writes[0][1][3], 2000)

    notify(first, [4, 0.75])
    assert.equal(countMessage(first, [1, [4, first.client.connectionId, 0.75]]), 1)
    assert.equal(countMessage(second, [1, [4, first.client.connectionId, 0.75]]), 1)

    const beforeHeartbeat = first.socket.writes.length
    notify(first, [5])
    assert.equal(first.socket.writes.length, beforeHeartbeat)
    assert.equal(countMessage(first, [1, [2]]), 0)
})
