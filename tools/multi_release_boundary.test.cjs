const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const roomManager = require("../src/multi/room/manager")
const { addRoomMember, createRoom, disbandRoom, updateRoomState } = roomManager
const { sessionManager } = require("../src/multi/state/SessionManager")
const { EmbeddedMultiCoordinator } = require("../src/multi/coordinator/embedded")

const HOST = Object.freeze({ nodeSessionId: "embedded", viewerId: 900000601 })
const GUEST = Object.freeze({ nodeSessionId: "release-guest-node", viewerId: 900000602 })

function withRoomStateFault(t) {
    const original = roomManager.updateRoomState
    let fail = false
    roomManager.updateRoomState = (roomNumber, state) => (
        fail ? false : original(roomNumber, state)
    )
    t.after(() => { roomManager.updateRoomState = original })
    return setFail => { fail = setFail }
}

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

function assertReleaseRuntimeRetained(room, battleSessionId) {
    assert.equal(room.raising_state, 4, "an unreleased room must stay in Battle")
    assert.notEqual(
        sessionManager.getActiveBattleSessionId(room.room_number),
        null,
        "the battle fact must stay authorized for finish retries",
    )
    assert.equal(
        sessionManager.battleParticipants.has(room.room_number),
        true,
        "the participant snapshot must survive a deferred release",
    )
    assert.equal(
        sessionManager.battleExpectedCount.has(room.room_number),
        true,
        "the SceneReady runtime must survive a deferred release",
    )
    assert.equal(
        sessionManager.hasParticipantFinalizedBattle(room.room_number, HOST),
        true,
        "the finalized retry authorization must survive a deferred release",
    )
}

test.after(() => {})

test("a refused 4->1 transition defers the release and keeps the runtime", async t => {
    const { room, battleSessionId, coordinator } = createFinalizedBattle(t)
    const setFault = withRoomStateFault(t)

    setFault(true)
    const deferred = await coordinator.finalizeBattle({
        participant: HOST,
        roomNumber: room.room_number,
        battleSessionId,
    })
    assert.equal(deferred.ok, true, "the local finalize fact itself stays valid")
    assertReleaseRuntimeRetained(room, battleSessionId)

    setFault(false)
    const released = await coordinator.finalizeBattle({
        participant: HOST,
        roomNumber: room.room_number,
        battleSessionId,
    })
    assert.equal(released.ok, true)
    assert.equal(room.raising_state, 1, "a retried release must return the room to Ready")
    assert.equal(sessionManager.getActiveBattleSessionId(room.room_number), null)
    assert.equal(sessionManager.battleParticipants.has(room.room_number), false)
    assert.equal(sessionManager.battleExpectedCount.has(room.room_number), false)

    const repeated = await coordinator.finalizeBattle({
        participant: HOST,
        roomNumber: room.room_number,
        battleSessionId,
    })
    assert.equal(repeated.ok, true, "a repeated release stays idempotent")
    assert.equal(room.raising_state, 1)
    assert.equal(sessionManager.getActiveBattleSessionId(room.room_number), null)
})

test("the room turns Ready before the battle runtime is cleared", async t => {
    const { room, battleSessionId, coordinator } = createFinalizedBattle(t)
    const original = roomManager.updateRoomState
    roomManager.updateRoomState = (roomNumber, state) => {
        if (state === 1) {
            assert.equal(
                sessionManager.battleExpectedCount.has(roomNumber),
                true,
                "the runtime must survive until the room has turned Ready",
            )
        }
        return original(roomNumber, state)
    }
    t.after(() => { roomManager.updateRoomState = original })

    const released = await coordinator.finalizeBattle({
        participant: HOST,
        roomNumber: room.room_number,
        battleSessionId,
    })
    assert.equal(released.ok, true)
    assert.equal(room.raising_state, 1)
})

test("a guest abort shares the deferred-release semantics", async t => {
    const { room, battleSessionId, coordinator } = createFinalizedBattle(t)

    const setFault = withRoomStateFault(t)
    setFault(true)
    const aborted = await coordinator.abortBattle({
        participant: GUEST,
        roomNumber: room.room_number,
    })
    assert.equal(aborted.ok, true, "the local abort removal stays committed")
    assertReleaseRuntimeRetained(room, battleSessionId)
})

test("a node-session cleanup shares the deferred-release semantics", t => {
    const { room, battleSessionId, coordinator } = createFinalizedBattle(t)

    const setFault = withRoomStateFault(t)
    setFault(true)
    coordinator.cleanupNodeSession(GUEST.nodeSessionId)
    assertReleaseRuntimeRetained(room, battleSessionId)
})

test("a stale previous-generation finalize must not release the room running a newer battle", async t => {
    // R-01 回归：retained 旧代 session（30min finish 重试窗口）的迟到 finalize
    // 曾把新一代战斗的房间重置回 Ready 并清掉新局 facts（全员无法结算）。
    const first = createFinalizedBattle(t)
    const sessionA = first.battleSessionId

    // 局 A 正常 finalize 释放（保留 retained 事实记录供 finish 重试）
    const releasedA = await first.coordinator.finalizeBattle({
        participant: HOST,
        roomNumber: first.room.room_number,
        battleSessionId: sessionA,
    })
    assert.equal(releasedA.ok, true)
    assert.equal(first.room.raising_state, 1)

    // 同房开新一代战斗 B
    sessionManager.setBattleParticipants(first.room.room_number, [
        { connectionId: "release-host-cid", participant: HOST },
        { connectionId: "release-guest-cid", participant: GUEST },
    ], HOST)
    assert.equal(updateRoomState(first.room.room_number, 4), true)
    const sessionB = sessionManager.getActiveBattleSessionId(first.room.room_number)
    assert.notEqual(sessionB, null)
    assert.notEqual(sessionB, sessionA, "新一代战斗必须持有新的 battleSessionId")

    // 迟到的 A finalize：事实本身仍可读（finish 重试授权），但不得触碰房间
    const stale = await first.coordinator.finalizeBattle({
        participant: HOST,
        roomNumber: first.room.room_number,
        battleSessionId: sessionA,
    })
    assert.equal(stale.ok, true, "retained 事实仍然可读（重试授权语义不变）")
    assert.equal(first.room.raising_state, 4, "迟到 finalize 不得把新一代战斗的房间重置回 Ready")
    assert.equal(sessionManager.getActiveBattleSessionId(first.room.room_number), sessionB)
    assert.equal(sessionManager.battleExpectedCount.has(first.room.room_number), true, "新局 SceneReady 运行时必须完好")
    assert.equal(sessionManager.battleParticipants.has(first.room.room_number), true, "新局成员快照必须完好")

    // B 自己的 finalize 仍然正常释放
    sessionManager.markParticipantFinalizedBattle(first.room.room_number, HOST)
    sessionManager.markParticipantFinalizedBattle(first.room.room_number, GUEST)
    const releasedB = await first.coordinator.finalizeBattle({
        participant: HOST,
        roomNumber: first.room.room_number,
        battleSessionId: sessionB,
    })
    assert.equal(releasedB.ok, true)
    assert.equal(first.room.raising_state, 1)
    assert.equal(sessionManager.getActiveBattleSessionId(first.room.room_number), null)
})
