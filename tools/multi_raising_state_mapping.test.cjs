"use strict"

require("./test-workflow/bootstrap.cjs").bootstrap()

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
const { createLifecycle, decide } = require("../src/multi/lifecycle")
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

test("room owner persists only raising_state 1/2/4 (kernel-derived, D5 oracle)", t => {
    const room = createOwnerRoom(t)
    assert.equal(room.raising_state, 2)

    assert.equal(updateRoomState(room.room_number, 1), true)
    assert.equal(room.raising_state, 1)

    assert.equal(updateRoomState(room.room_number, 4), true)
    assert.equal(room.raising_state, 4)

    assert.equal(updateRoomState(room.room_number, 1), true)
    assert.equal(room.raising_state, 1)

    assert.equal(updateRoomState(room.room_number, 1), true, "same-state rewrite stays legal")
})

test("D5 oracle: the kernel decides every transition the old edge table allowed", t => {
    // 旧 RoomStateMachine 九条边(语义映射)在内核 decide() 的对等覆盖:
    // [Waiting,Ready]=建房→host enter;[Ready,Filled]/[Filled,Ready]=同值重写;
    // [Ready,Battle]/[Filled,Battle]=startBattle;[Battle,Ready]=hostReturn;
    // [Ready,Filled→Disbanded]/[Battle,Disbanded]=disband→closing
    let state = createLifecycle({ roomNumber: "901001", generation: 1, host: "viewer:901" })
    const ok2 = (s, event) => {
        const result = decide(s, event)
        assert.equal(result.rejected, undefined, `unexpected: ${result.rejected}`)
        return result.state
    }
    // Waiting→Ready(host enter)
    state = ok2(state, { type: "enter", generation: 1, identity: "viewer:901", nowMs: 1_000 })
    assert.equal(state.phase, "ready")
    // Ready→Battle(startBattle)
    state = ok2(state, { type: "startBattle", generation: 1, identity: "viewer:901", battleSessionId: "o1" })
    assert.equal(state.phase, "battle")
    // Battle→Ready(hostReturn,finalized 需先 finish)
    state = ok2(state, { type: "finish", generation: 1, identity: "viewer:901", nowMs: 1_100, battleDeadlineMs: 900_000, battleSessionId: "o1" })
    state = ok2(state, { type: "hostReturn", generation: 1, identity: "viewer:901", nowMs: 1_200 })
    assert.equal(state.phase, "ready")
    // Ready→Battle→Disbanded(disband→closing)
    state = ok2(state, { type: "startBattle", generation: 1, identity: "viewer:901", battleSessionId: "o2" })
    state = ok2(state, { type: "disband", generation: 1, identity: "viewer:901", nowMs: 1_300, closeDeadlineMs: 300_000 })
    assert.equal(state.phase, "closing")
    // Battle→Ready 的另一序:hostReturnPending 下最后 finish 直 4→1 已由 core 测试覆盖
})

test("unknown raising states fail closed without touching the room", t => {
    const room = createOwnerRoom(t)
    assert.equal(updateRoomState(room.room_number, 4), true)
    const raisingBefore = room.raising_state

    for (const bad of [0, 3, 7, 9, 13, 99, 2.5, Number.NaN, "4", null, undefined]) {
        assert.equal(
            updateRoomState(room.room_number, bad),
            false,
            `state=${String(bad)} must fail closed`,
        )
        assert.equal(room.raising_state, raisingBefore, `state=${String(bad)} must not touch the room`)
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

test("unified raising_state projection decision table (slice 1 step 2)", () => {
    const { projectRaisingStateForViewer } = require("../src/multi/room/raising-state-projection")
    const project = overrides => projectRaisingStateForViewer({
        state: 2, isHost: false, isMember: false, hostOnline: true, flow: "select", ...overrides,
    })

    // 房主:4→2(等待横幅),其余→1
    assert.deepEqual(project({ isHost: true, state: 4 }), { raisingState: 2, prepareFailure4507: false })
    assert.deepEqual(project({ isHost: true, state: 1 }), { raisingState: 1, prepareFailure4507: false })
    assert.deepEqual(project({ isHost: true, state: 2 }), { raisingState: 1, prepareFailure4507: false })

    // state 4 非房主:select 成员→2 局外人→4;prepare 成员→2 局外人→4507;
    // restore 成员→4(客户端 restore case 4=Battle 恢复通道)
    assert.equal(project({ state: 4, isMember: true, flow: "select" }).raisingState, 2)
    assert.equal(project({ state: 4, isMember: false, flow: "select" }).raisingState, 4)
    assert.equal(project({ state: 4, isMember: true, flow: "prepare" }).raisingState, 2)
    assert.deepEqual(project({ state: 4, isMember: false, flow: "prepare" }), {
        raisingState: 4, prepareFailure4507: true,
    })
    assert.equal(project({ state: 4, isMember: true, flow: "restore" }).raisingState, 4)

    // 房主离线未开战→2;其余透传(异节点注册值原样)
    assert.equal(project({ hostOnline: false }).raisingState, 2)
    assert.equal(project({ state: 1 }).raisingState, 1)
    assert.equal(project({ state: 9 }).raisingState, 9)

    // 列表流:无 viewer 上下文,4 直通(不按离线投影成 2)、离线→2、透传
    assert.equal(project({ state: 4, flow: "list" }).raisingState, 4)
    assert.equal(project({ hostOnline: false, flow: "list" }).raisingState, 2)
    assert.equal(project({ state: 1, flow: "list" }).raisingState, 1)
})

test("projection parity locks (dual-review P1/P2): restore offline-first and falsified-assertion guard", () => {
    const { projectRaisingStateForViewer } = require("../src/multi/room/raising-state-projection")
    const project = overrides => projectRaisingStateForViewer({
        state: 2, isHost: false, isMember: true, hostOnline: true, flow: "restore", ...overrides,
    })

    // 双审 P1 锁:restore × state4 × 房主离线 → 2(旧链离线覆盖先于透传)
    assert.deepEqual(project({ state: 4, hostOnline: false }), {
        raisingState: 2, prepareFailure4507: false,
    })
    // 对照:在线时 restore 成员透传 4(旧链 parity,客户端终态弹窗)
    assert.deepEqual(project({ state: 4, hostOnline: true }), {
        raisingState: 4, prepareFailure4507: false,
    })
    // restore 非战斗离线 → 2
    assert.equal(project({ state: 1, hostOnline: false }).raisingState, 2)
    // select/prepare × state4 × 离线:state4 分支先于离线(顺序锁)
    assert.equal(project({ state: 4, isMember: true, flow: "select", hostOnline: false }).raisingState, 2)
    assert.equal(project({ state: 4, isMember: false, flow: "select", hostOnline: false }).raisingState, 4)
    assert.deepEqual(project({ state: 4, isMember: false, flow: "prepare", hostOnline: false }), {
        raisingState: 4, prepareFailure4507: true,
    })
    // 房主 × state 9/13 → 1(房主分支不透传非 4 值)
    assert.equal(project({ isHost: true, state: 9 }).raisingState, 1)
    assert.equal(project({ isHost: true, state: 13 }).raisingState, 1)
    // state 13 非房主透传;输出冻结
    assert.equal(project({ state: 13 }).raisingState, 13)
    assert.ok(Object.isFrozen(project({ state: 4 })))
    // list 流离线时 prepareFailure4507 恒 false
    assert.equal(project({ hostOnline: false, flow: "list" }).prepareFailure4507, false)
})
