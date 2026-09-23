const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
const restoreContentSnapshot = installBundledGameplaySnapshot()
const { QuestCategory } = require("../src/lib/types")
const { createRoom, disbandRoom } = require("../src/multi/room/manager")
const { sessionManager } = require("../src/multi/state/SessionManager")
const { EmbeddedMultiCoordinator } = require("../src/multi/coordinator/embedded")
const { handleBattleMessage } = require("../src/multi/tcp/battle")
const { handleHandshake } = require("../src/multi/tcp/handshake")
const { handleMessage: handleLobbyMessage } = require("../src/multi/tcp/lobby")
const { NpcMateProvider } = require("../src/multi/npc/controller")

const HOST_VIEWER_ID = 800000401
const INITIAL_PARTY = { characters: [{ id: 1 }] }
const CHANGED_PARTY = { characters: [{ id: 2 }] }

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

function flushPromises() {
    return new Promise(resolve => setImmediate(resolve))
}

// Drive a real host StartBattle: lobby Enter (2 -> 1), StartBattle (-> 4),
// battle handshake from the frozen snapshot, SceneReady barrier completion,
// then drop every battle socket while the battle fact stays unreleased.
function startUnreleasedBattle(t) {
    const room = createRoom(
        HOST_VIEWER_ID,
        HOST_VIEWER_ID + 1000,
        1,
        QuestCategory.BOSS_BATTLE,
        1001001,
        0,
        1,
        false,
        { nodeSessionId: "embedded", viewerId: HOST_VIEWER_ID },
    )
    const socket = new FakeSocket()
    const client = sessionManager.createClient(
        socket,
        HOST_VIEWER_ID,
        room.room_number,
        `${room.room_number}-host-cid`,
    )
    client.participant = { nodeSessionId: "embedded", viewerId: HOST_VIEWER_ID }
    client.yourself = {
        viewerId: HOST_VIEWER_ID,
        connectionId: client.connectionId,
        party: INITIAL_PARTY,
        state: [0],
    }
    client.mates = [client.yourself]
    sessionManager.addClientToRoom(client)
    sessionManager.claimRoomHostParticipant(room.room_number, client.participant)

    handleLobbyMessage(socket, [0, [0, { party: INITIAL_PARTY }]])
    assert.equal(room.raising_state, 1, "host Enter must move the room to Ready")

    handleLobbyMessage(socket, [0, [6]])
    assert.equal(room.raising_state, 4, "host StartBattle must move the room to Battle")
    assert.equal(
        sessionManager.getActiveBattleSessionId(room.room_number) !== null,
        true,
        "StartBattle must publish a battle fact",
    )

    t.after(() => {
        const battleClient = sessionManager.getBattleClient(client.connectionId)
        if (battleClient) sessionManager.removeClient(battleClient)
        sessionManager.removeClient(client)
        sessionManager.clearBattleExpectedCount(room.room_number)
        disbandRoom(room.room_number)
    })

    return { room, socket, client }
}

// Complete the SceneReady barrier, then remove all battle sockets. The room
// stays at raising_state=4 with an active (unfinalized) battle fact — the
// stale-lobby window the lock must cover.
async function clearSceneAndDropBattleSockets(t, room, hostClient) {
    const battleSocket = new FakeSocket()
    await handleHandshake(battleSocket, {
        socklet: "cooperation_battle",
        room_number: room.room_number,
        connection_id: hostClient.connectionId,
    })
    const battleClient = sessionManager.getBattleClient(hostClient.connectionId)
    assert.ok(battleClient, "battle handshake must accept the frozen snapshot identity")

    handleBattleMessage(battleSocket, [0, [0]])
    assert.equal(
        sessionManager.isBattleSceneBarrierReleased(room.room_number),
        true,
        "SceneReady must release the barrier",
    )

    sessionManager.removeClient(battleClient)
    assert.equal(sessionManager.hasBattleClients(room.room_number), false)
    assert.equal(
        sessionManager.isRoomBattleOccupied(room.room_number),
        false,
        "precondition: no battle sockets and no expected clients remain",
    )
    assert.equal(room.raising_state, 4)
    assert.equal(
        sessionManager.getActiveBattleSessionId(room.room_number) !== null,
        true,
        "the battle fact must still hold the unfinished battle",
    )
    return battleSocket
}

function stubRecruitment(t) {
    const originalOnRecruit = NpcMateProvider.prototype.onRecruit
    NpcMateProvider.prototype.onRecruit = async () => ({ recruitedMates: [] })
    t.after(() => { NpcMateProvider.prototype.onRecruit = originalOnRecruit })
}

test.after(() => restoreContentSnapshot())

test("stale lobby ChangeParty cannot rewrite the party of an unreleased battle", async t => {
    const { room, socket, client } = startUnreleasedBattle(t)
    await clearSceneAndDropBattleSockets(t, room, client)

    handleLobbyMessage(socket, [0, [2, { party: CHANGED_PARTY }]])

    assert.deepEqual(client.yourself.party, INITIAL_PARTY)
    assert.equal(
        sessionManager.getActiveBattleSessionId(room.room_number) !== null,
        true,
        "the battle fact must survive a rejected lobby mutation",
    )
})

test("stale lobby Ready cannot flip readiness inside an unreleased battle", async t => {
    const { room, socket, client } = startUnreleasedBattle(t)
    await clearSceneAndDropBattleSockets(t, room, client)

    handleLobbyMessage(socket, [0, [3, [1]]])

    assert.equal(client.isReady, false)
    assert.deepEqual(client.mates[0].state, [0])
    assert.equal(
        socket.writes.some(frame => JSON.stringify(frame) === JSON.stringify(
            [1, [2, client.connectionId, [1]]],
        )),
        false,
        "a rejected Ready must not broadcast StateChanged",
    )
})

test("stale lobby EnterComs cannot recruit NPCs into an unreleased battle", async t => {
    const { room, socket, client } = startUnreleasedBattle(t)
    await clearSceneAndDropBattleSockets(t, room, client)
    stubRecruitment(t)

    handleLobbyMessage(socket, [0, [10, []]])
    await flushPromises()

    assert.equal(room.is_npc_mode, false, "NPC recruitment must stay locked until release")
    assert.equal(room.npc_count, 0)
    assert.equal(
        client.mates.some(mate => mate.comId),
        false,
        "no NPC roster entries may join the frozen battle room",
    )
})

test("stale lobby Enter cannot flip an unreleased battle room back to Ready", async t => {
    const { room, socket, client } = startUnreleasedBattle(t)
    await clearSceneAndDropBattleSockets(t, room, client)

    handleLobbyMessage(socket, [0, [0, { party: CHANGED_PARTY }]])

    assert.equal(client.enterData, null, "StartBattle must stay the last lobby word on enterData")
    assert.deepEqual(client.yourself.party, INITIAL_PARTY)
    assert.equal(room.raising_state, 4, "only the official release may move Battle back to Ready")
    assert.equal(
        sessionManager.getActiveBattleSessionId(room.room_number) !== null,
        true,
    )
})

test("the official release reopens the lobby for the rematch", async t => {
    const { room, socket, client } = startUnreleasedBattle(t)
    await clearSceneAndDropBattleSockets(t, room, client)
    stubRecruitment(t)

    // Real release path: every remaining participant finalizes, coordinator
    // returns the room to Ready and clears the battle runtime.
    sessionManager.markParticipantFinalizedBattle(room.room_number, client.participant)
    const battleSessionId = sessionManager.getActiveBattleSessionId(room.room_number)
    const coordinator = new EmbeddedMultiCoordinator()
    const finalized = await coordinator.finalizeBattle({
        participant: client.participant,
        roomNumber: room.room_number,
        battleSessionId,
    })
    assert.equal(finalized.ok, true)
    assert.equal(room.raising_state, 1, "release must return the room to Ready")
    assert.equal(sessionManager.getActiveBattleSessionId(room.room_number), null)

    handleLobbyMessage(socket, [0, [0, { party: CHANGED_PARTY }]])
    assert.deepEqual(client.yourself.party, CHANGED_PARTY, "Enter must work again after release")
    assert.notEqual(client.enterData, null)

    handleLobbyMessage(socket, [0, [2, { party: INITIAL_PARTY }]])
    assert.deepEqual(client.yourself.party, INITIAL_PARTY, "ChangeParty must work again")

    handleLobbyMessage(socket, [0, [3, [1]]])
    assert.equal(client.isReady, true, "Ready must work again")
    assert.equal(
        socket.writes.some(frame => JSON.stringify(frame) === JSON.stringify(
            [1, [2, client.connectionId, [1]]],
        )),
        true,
        "Ready must broadcast StateChanged again",
    )

    handleLobbyMessage(socket, [0, [10, []]])
    await flushPromises()
    assert.equal(room.is_npc_mode, true, "EnterComs must work again after release")
    assert.equal(room.raising_state, 1)
})
