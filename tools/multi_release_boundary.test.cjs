const assert = require("node:assert/strict")
const test = require("node:test")

require("./test-workflow/bootstrap.cjs").bootstrap()

const { addRoomMember, createRoom, disbandRoom, updateRoomState } = require("../src/multi/room/manager")
const { sessionManager } = require("../src/multi/state/SessionManager")
const { EmbeddedMultiCoordinator } = require("../src/multi/coordinator/embedded")

const HOST = Object.freeze({ nodeSessionId: "embedded", viewerId: 900000601 })
const GUEST = Object.freeze({ nodeSessionId: "release-guest-node", viewerId: 900000602 })

function createFinalizedBattle(t) {
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
    addRoomMember(room.room_number, GUEST)
    sessionManager.setBattleParticipants(room.room_number, [
        { connectionId: "release-host-cid", participant: HOST },
        { connectionId: "release-guest-cid", participant: GUEST },
    ], HOST)
    assert.equal(updateRoomState(room.room_number, 4), true)
    sessionManager.markParticipantFinalizedBattle(room.room_number, HOST)
    sessionManager.markParticipantFinalizedBattle(room.room_number, GUEST)
    const battleSessionId = sessionManager.getActiveBattleSessionId(room.room_number)
    assert.notEqual(battleSessionId, null)

    t.after(() => {
        sessionManager.clearBattleExpectedCount(room.room_number)
        disbandRoom(room.room_number)
    })
    return { room, battleSessionId, coordinator: new EmbeddedMultiCoordinator({ allowRemoteParticipants: true }) }
}

test("finalize releases seats and clears the battle runtime but stays Battle", async t => {
    const { room, battleSessionId, coordinator } = createFinalizedBattle(t)

    const released = await coordinator.finalizeBattle({
        participant: HOST,
        roomNumber: room.room_number,
        battleSessionId,
    })
    assert.equal(released.ok, true)
    assert.equal(room.raising_state, 4, "Finish keeps state 4")
    assert.equal(sessionManager.getActiveBattleSessionId(room.room_number), null)
    assert.equal(sessionManager.battleParticipants.has(room.room_number), false)
    assert.equal(sessionManager.battleExpectedCount.has(room.room_number), false)
    assert.deepEqual(room.member_participants, [HOST], "seats release to the host")
    assert.deepEqual(room.battle_participants, [HOST, GUEST], "serving projection keeps the battle participants")

    // state 4 的服务矩阵仍认返回客机为成员；座位释放不改变成员判定。
    const guestStatus = await coordinator.getRoomStatus({
        participant: GUEST,
        roomNumber: room.room_number,
    })
    assert.equal(guestStatus.ok, true)
    assert.equal(guestStatus.value.raisingState, 4)
    assert.deepEqual(
        guestStatus.value.members.map(member => member.viewerId).sort(),
        [HOST.viewerId, GUEST.viewerId].sort(),
    )
})

test("a guest abort finalizes without 4→1", async t => {
    const { room, coordinator } = createFinalizedBattle(t)

    const aborted = await coordinator.abortBattle({
        participant: GUEST,
        roomNumber: room.room_number,
    })
    assert.equal(aborted.ok, true)
    assert.equal(room.raising_state, 4)
    assert.equal(sessionManager.getActiveBattleSessionId(room.room_number), null)
    assert.deepEqual(room.member_participants, [HOST])
})

test("node-session cleanup keeps Battle", t => {
    const { room } = createFinalizedBattle(t)

    const coordinator = new EmbeddedMultiCoordinator({ allowRemoteParticipants: true })
    coordinator.cleanupNodeSession(GUEST.nodeSessionId)

    assert.equal(room.raising_state, 4)
    assert.equal(sessionManager.getActiveBattleSessionId(room.room_number), null)
    assert.deepEqual(room.member_participants, [HOST])
})

test("a stale previous-generation finalize must not release the room running a newer battle", async t => {
    const first = createFinalizedBattle(t)
    const sessionA = first.battleSessionId

    const releasedA = await first.coordinator.finalizeBattle({
        participant: HOST,
        roomNumber: first.room.room_number,
        battleSessionId: sessionA,
    })
    assert.equal(releasedA.ok, true)
    assert.equal(first.room.raising_state, 4, "Finish keeps state 4")

    sessionManager.setBattleParticipants(first.room.room_number, [
        { connectionId: "release-host-cid", participant: HOST },
        { connectionId: "release-guest-cid", participant: GUEST },
    ], HOST)
    assert.equal(updateRoomState(first.room.room_number, 4), true)
    const sessionB = sessionManager.getActiveBattleSessionId(first.room.room_number)
    assert.notEqual(sessionB, null)
    assert.notEqual(sessionB, sessionA, "新一代战斗必须持有新的 battleSessionId")

    const stale = await first.coordinator.finalizeBattle({
        participant: HOST,
        roomNumber: first.room.room_number,
        battleSessionId: sessionA,
    })
    assert.equal(stale.ok, true, "retained 事实仍然可读（重试授权语义不变）")
    assert.equal(first.room.raising_state, 4, "迟到 finalize 不得释放新一代战斗")
    assert.equal(sessionManager.getActiveBattleSessionId(first.room.room_number), sessionB)
    assert.equal(sessionManager.battleExpectedCount.has(first.room.room_number), true, "新局 SceneReady 运行时必须完好")
    assert.equal(sessionManager.battleParticipants.has(first.room.room_number), true, "新局成员快照必须完好")

    sessionManager.markParticipantFinalizedBattle(first.room.room_number, HOST)
    sessionManager.markParticipantFinalizedBattle(first.room.room_number, GUEST)
    const releasedB = await first.coordinator.finalizeBattle({
        participant: HOST,
        roomNumber: first.room.room_number,
        battleSessionId: sessionB,
    })
    assert.equal(releasedB.ok, true)
    assert.equal(first.room.raising_state, 4, "B 的 Finish 也保持 state 4")
    assert.equal(sessionManager.getActiveBattleSessionId(first.room.room_number), null)
})
