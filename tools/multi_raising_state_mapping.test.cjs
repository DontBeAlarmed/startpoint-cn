"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const {
    prepareFailureRaisingState,
    restoreRoomUnavailableRaisingState,
    roomUnavailableRaisingState,
} = require("../src/multi/http/join-result.ts")
const {
    createRoom,
    disbandRoom,
    updateRoomState,
} = require("../src/multi/room/manager")
const { sessionManager } = require("../src/multi/state/SessionManager")
const { RoomState } = require("../src/multi/types")

function createOwnerRoom(t) {
    const room = createRoom(8100001, 1, 1, 1, 5101, 0, 1, true)
    t.after(() => disbandRoom(room.room_number))
    return room
}

// CN 1.8.1 MultiBattleQuestPrepareRealRemote：raising_state 仅 1/2/9 合法
//（3/4/7/8/10/11/12/13 抛 ClientError 5001）；其余失败走 A-error
// 4503/4507/4509 → RoomDataNotFound/Failure/RoomDataPeriodOutdated。
test("prepare failure mapping never emits a fatal raising_state", () => {
    assert.equal(prepareFailureRaisingState("ROOM_NOT_FOUND"), 9)
    assert.equal(prepareFailureRaisingState("ROOM_FULL"), null, "满房必须走 4507 A-error，不得回 raising_state 3")
    assert.equal(prepareFailureRaisingState("ROOM_MEMBER_MISMATCH"), null)
    assert.equal(prepareFailureRaisingState("HUB_UNAVAILABLE"), null)
    assert.equal(prepareFailureRaisingState("QUEST_NOT_AVAILABLE"), null)
})

// CN 1.8.1 MultiBattleQuestSelectRoomRealRemote：1/2/3/4/7/8/9/10/11/12 全部合法
//（3=Filled、7=NotPlayable、13 才致命）。
test("select_room failure mapping keeps client-legal states", () => {
    assert.equal(roomUnavailableRaisingState("ROOM_NOT_FOUND"), 9)
    assert.equal(roomUnavailableRaisingState("ROOM_FULL"), 3)
    assert.equal(roomUnavailableRaisingState("ROOM_MEMBER_MISMATCH"), 7)
    assert.equal(roomUnavailableRaisingState("QUEST_NOT_AVAILABLE"), 7)
})

// CN 1.8.1 MultiBattleQuestRestoreRoomRealRemote：9=Disbanded、13=NotMate 合法。
test("restore_room failure mapping uses disbanded and not-mate states", () => {
    assert.equal(restoreRoomUnavailableRaisingState("ROOM_NOT_FOUND"), 9)
    assert.equal(restoreRoomUnavailableRaisingState("ROOM_FULL"), 13)
    assert.equal(restoreRoomUnavailableRaisingState("ROOM_MEMBER_MISMATCH"), 13)
})

test("multi HTTP sources use the endpoint-specific mappings", () => {
    const roomSource = fs.readFileSync(
        path.join(__dirname, "../src/multi/http/room.ts"), "utf8")
    const lobbySource = fs.readFileSync(
        path.join(__dirname, "../src/multi/http/lobby.ts"), "utf8")

    // prepare 只接受 ROOM_NOT_FOUND 的 9；其余错误一律 4507 result_code
    assert.match(roomSource, /prepareFailureRaisingState\(/)
    assert.doesNotMatch(
        roomSource.split("fastify.post(\"/summon\"")[0],
        /ROOM_NOT_FOUND" \|\| error === "ROOM_FULL"/,
        "prepareFailure 不得再把 ROOM_FULL 映射为 raising_state",
    )
    // select_room 保持通用映射（3/7/9 对该端点合法）
    assert.match(lobbySource, /roomUnavailableRaisingState\(room\.error\)/)
    // restore_room 使用 9/13 专用映射
    assert.match(roomSource, /restoreRoomUnavailableRaisingState\(/)
})

test("room owner persists only raising_state 1/2/4 through the state machine", t => {
    const room = createOwnerRoom(t)
    assert.equal(room.raising_state, 2)
    const machine = sessionManager.getRoomState(room.room_number)
    assert.equal(machine.getState(), RoomState.Filled)

    assert.equal(updateRoomState(room.room_number, 1), true)
    assert.equal(room.raising_state, 1)
    assert.equal(machine.getState(), RoomState.Ready)

    assert.equal(updateRoomState(room.room_number, 4), true)
    assert.equal(room.raising_state, 4)
    assert.equal(machine.getState(), RoomState.Battle)

    assert.equal(updateRoomState(room.room_number, 1), true)
    assert.equal(room.raising_state, 1)
    assert.equal(machine.getState(), RoomState.Ready)

    assert.equal(updateRoomState(room.room_number, 1), true, "same-state rewrite stays legal")
})

test("unknown raising states fail closed without touching the room or machine", t => {
    const room = createOwnerRoom(t)
    assert.equal(updateRoomState(room.room_number, 4), true)
    const machine = sessionManager.getRoomState(room.room_number)
    const raisingBefore = room.raising_state
    const machineBefore = machine.getState()

    for (const bad of [0, 3, 7, 9, 13, 99, 2.5, Number.NaN, "4", null, undefined]) {
        assert.equal(
            updateRoomState(room.room_number, bad),
            false,
            `state=${String(bad)} must fail closed`,
        )
        assert.equal(room.raising_state, raisingBefore, `state=${String(bad)} must not touch the room`)
        assert.equal(machine.getState(), machineBefore, `state=${String(bad)} must not touch the machine`)
    }
})

test("room owner keeps the persistable state union exhaustive and typed", () => {
    const managerSource = fs.readFileSync(
        path.join(__dirname, "../src/multi/room/manager.ts"), "utf8")
    assert.match(managerSource, /PersistentRaisingState/)
    assert.doesNotMatch(
        managerSource,
        /export function updateRoomState\(roomNumber: string, state: number\)/,
        "updateRoomState must not accept an untyped state",
    )
})
