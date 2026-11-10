"use strict"

// R-09 + 恢复链路补票回归：
// 1) restore_room 为房内成员重新签发准入（切出切回的握手可正常消费）；
// 2) 握手拒绝分级——可恢复拒绝走优雅 [1, ui_string key]，协议错误保留 [3] Fatal。

const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("./test-workflow/bootstrap.cjs").bootstrap()

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "handshake-grade-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
const restoreContentSnapshot = installBundledGameplaySnapshot()
const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const { addRoomMember, createRoom, disbandRoom, reconcileHostReturn, updateRoomState } = require("../src/multi/room/manager")
const { sessionManager } = require("../src/multi/state/SessionManager")
const { embeddedAdmissionRegistry } = require("../src/multi/admission/registry")
const { handleHandshake } = require("../src/multi/tcp/handshake")
const { lifecycleRegistry } = require("../src/multi/lifecycle")

initializeDatabase()

class RecordingSocket extends EventEmitter {
    constructor() {
        super()
        this.writable = true
        this.frames = []
    }

    write(value) {
        this.frames.push(JSON.parse(String(value).replace(/\0$/, "")))
        return true
    }

    end() {
        this.writable = false
    }
}

const HOST = Object.freeze({ nodeSessionId: "embedded", viewerId: 920000701 })
const GUEST = Object.freeze({ nodeSessionId: "embedded", viewerId: 920000702 })

function seedPlayer(viewerId) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `handshake-grade-${randomId()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    return { playerId, viewerId, account }
}

let seq = 0
function randomId() {
    seq += 1
    return `seq-${seq}-${Date.now()}`
}

test("恢复链路：restore_room 重签发准入 → 握手消费 → 接受帧 [0,...]", async t => {
    const room = createRoom(HOST.viewerId, HOST.viewerId + 1000, 1, 1, 5101, 0, 1, false, HOST)
    addRoomMember(room.room_number, GUEST)
    t.after(() => disbandRoom(room.room_number))

    // guest 已是成员（原始入场完成过），模拟切出切回：restore_room 重签发
    const { hasValidViewer } = require("../src/multi/http/context")
    void hasValidViewer
    const guestPlayer = seedPlayer(GUEST.viewerId)
    await insertSessionWithToken({
        token: String(GUEST.viewerId),
        accountId: guestPlayer.account.id,
        expires: new Date("2099-01-01T00:00:00.000Z"),
        type: SessionType.VIEWER,
    })

    // 直接经 admission registry 签发（restore_room 的成员分支语义）
    const issued = await embeddedAdmissionRegistry.issue({
        roomNumber: room.room_number,
        participant: { ...GUEST },
        snapshot: {
            viewerId: GUEST.viewerId,
            name: "reconnecting-guest",
            rank: 1,
            degreeId: 1,
            mainCharacterId: 393,
            playerRoleKind: 1,
            isNewbie: false,
            currentPartyId: 1,
            party: {},
            npcParties: [],
        },
        expiresAt: Date.now() + 60_000,
    })
    assert.equal(issued.ok, true, `准入签发必须成功: ${JSON.stringify(issued)}`)

    // 重连握手消费准入 → 接受
    const socket = new RecordingSocket()
    await handleHandshake(socket, {
        socklet: "cooperation_room",
        viewerId: GUEST.viewerId,
        room_number: room.room_number,
        questCategory: room.category,
        questId: room.quest_id,
    })
    assert.deepEqual(
        socket.frames[0],
        [0, socket.frames[0][1], room.room_number],
        "重连握手必须收到 Accept 帧",
    )
    assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM players_mails WHERE 1").get().n >= 0, true)
})

test("拒绝分级：房间状态不允许 → 优雅 [1, DENIED]；协议参数错误 → [3] Fatal", async t => {
    const room = createRoom(HOST.viewerId, HOST.viewerId + 1000, 1, 1, 5102, 0, 1, false, HOST)
    t.after(() => disbandRoom(room.room_number))
    updateRoomState(room.room_number, 4) // 开战中：可恢复拒绝

    const socket = new RecordingSocket()
    await handleHandshake(socket, {
        socklet: "cooperation_room",
        viewerId: HOST.viewerId + 5000,
        room_number: room.room_number,
        questCategory: room.category,
        questId: room.quest_id,
    })
    assert.deepEqual(socket.frames[0], [1, "multibattle_room_already_started"],
        "房间状态拒绝必须走优雅 Denied（合法 UI 文案 key）")

    const fatalSocket = new RecordingSocket()
    await handleHandshake(fatalSocket, { socklet: "cooperation_room" }) // 缺参：协议级
    assert.deepEqual(fatalSocket.frames[0], [3, "HANDSHAKE_DENIED"], "协议错误保留 Fatal")
})

test("拒绝分级：准入缺失（未签发/已消费）→ 优雅 [1, DENIED]", async t => {
    const room = createRoom(HOST.viewerId, HOST.viewerId + 1000, 1, 1, 5103, 0, 1, false, HOST)
    t.after(() => disbandRoom(room.room_number))
    // 非成员且未签发准入 → admission_unavailable
    const socket = new RecordingSocket()
    await handleHandshake(socket, {
        socklet: "cooperation_room",
        viewerId: HOST.viewerId + 6000,
        room_number: room.room_number,
        questCategory: room.category,
        questId: room.quest_id,
    })
    assert.deepEqual(socket.frames[0], [1, "multibattle_room_not_found"],
        "准入缺失必须走优雅 Denied（合法 UI 文案 key，可经 restore_room 补票重试）")
})

// ---------------------------------------------------------------------------
// 2026-11-10 真机 B.1：客机续战返回失败（1 NPC+1 客机，房主回房后客机握手
// 被 admission_unavailable 拒）。根因：hostReturn 4→1 清空内核 joiners，
// 而战斗等待期（select_room 轮询）签发的票仍在册；客机同代次重签走
// "返回原票"捷径、不重记内核 admit 意图 → 孤儿票：consume 成功但内核
// handshake 以 ADMISSION_REQUIRED 拒绝（被默认映射成 admission_unavailable）。
// ---------------------------------------------------------------------------

function setupRematchBattleRoom(t, room) {
    // 双双入内核（admit→handshake→enter 落座）→ 内核 startBattle → 全员 finish
    for (const viewerId of [HOST.viewerId, GUEST.viewerId]) {
        const identity = `viewer:${viewerId}`
        lifecycleRegistry.dispatch(room.room_number, generation => ({ type: "admit", generation, identity }))
        lifecycleRegistry.dispatch(room.room_number, generation => ({ type: "handshake", generation, identity }))
        lifecycleRegistry.dispatch(room.room_number, generation => ({ type: "enter", generation, identity, nowMs: 1_000 }))
    }
    const battleSessionId = "rematch-b1"
    const started = lifecycleRegistry.dispatch(room.room_number, generation => ({
        type: "startBattle", generation, identity: `viewer:${HOST.viewerId}`, battleSessionId,
    }))
    assert.equal(started?.rejected, undefined, "战斗必须能开局")
    const battleState = lifecycleRegistry.get(room.room_number)
    assert.equal(battleState.phase, "battle")
    for (const identity of battleState.battleParticipants) {
        lifecycleRegistry.dispatch(room.room_number, generation => ({
            type: "finish", generation, identity, nowMs: 2_000,
            battleDeadlineMs: 900_000, battleSessionId,
        }))
    }
    assert.equal(lifecycleRegistry.get(room.room_number).battleFinalized, true)
}

function issueGuestTicket(room) {
    return embeddedAdmissionRegistry.issue({
        roomNumber: room.room_number,
        participant: { ...GUEST },
        snapshot: {
            viewerId: GUEST.viewerId,
            name: "rematch-guest",
            rank: 1,
            degreeId: 1,
            mainCharacterId: 393,
            playerRoleKind: 1,
            isNewbie: false,
            currentPartyId: 1,
            party: {},
            npcParties: [],
        },
        expiresAt: Date.now() + 15_000,
        lifecycleGeneration: lifecycleRegistry.get(room.room_number)?.generation,
    })
}

function hostReturnAfterBattle(room) {
    lifecycleRegistry.dispatchHostReturnIfInBattle(room.room_number, `viewer:${HOST.viewerId}`)
    reconcileHostReturn(room.room_number)
    const state = lifecycleRegistry.get(room.room_number)
    assert.equal(state.phase, "ready", "hostReturn 后必须回到 ready 相位")
    assert.equal(state.joiners[`viewer:${GUEST.viewerId}`], undefined,
        "前置：hostReturn 必须已清空客机 joiner（孤儿票成因）")
}

test("续战回房：hostReturn 清 joiners 后同代次重签票必须自愈重记内核 admit", async t => {
    const room = createRoom(HOST.viewerId, HOST.viewerId + 1000, 1, 1, 5104, 0, 1, false, HOST)
    addRoomMember(room.room_number, GUEST)
    t.after(() => disbandRoom(room.room_number))

    setupRematchBattleRoom(t, room)

    // 战斗等待期：客机 select_room 轮询签发票（内核 joiner 随票建立）
    assert.equal(issueGuestTicket(room).ok, true)

    hostReturnAfterBattle(room)

    // 客机再次 select_room（同代次重签）：必须刷新票面并重记内核 admit
    const reIssued = issueGuestTicket(room)
    assert.equal(reIssued.ok, true, `同代次重签必须成功: ${JSON.stringify(reIssued)}`)
    const healed = lifecycleRegistry.get(room.room_number)
    assert.equal(healed.joiners[`viewer:${GUEST.viewerId}`], "admitted",
        "重签必须重记内核 admit 意图（孤儿票自愈）")

    // 客机握手消费 → Accept
    const socket = new RecordingSocket()
    await handleHandshake(socket, {
        socklet: "cooperation_room",
        viewerId: GUEST.viewerId,
        room_number: room.room_number,
        questCategory: room.category,
        questId: room.quest_id,
    })
    assert.deepEqual(socket.frames[0], [0, socket.frames[0][1], room.room_number],
        "续战回房握手必须收到 Accept 帧（B.1 主修复）")
})

test("续战回房竞态：select 与握手之间发生 hostReturn，握手消费时自愈", async t => {
    const room = createRoom(HOST.viewerId, HOST.viewerId + 1000, 1, 1, 5105, 0, 1, false, HOST)
    addRoomMember(room.room_number, GUEST)
    t.after(() => disbandRoom(room.room_number))

    setupRematchBattleRoom(t, room)
    assert.equal(issueGuestTicket(room).ok, true)
    hostReturnAfterBattle(room)

    // 客机不重签、直接握手（select 与 connect 之间夹入 hostReturn 的竞态窗口）：
    // consume 必须自愈重记 admit 意图，握手走到 Accept
    const socket = new RecordingSocket()
    await handleHandshake(socket, {
        socklet: "cooperation_room",
        viewerId: GUEST.viewerId,
        room_number: room.room_number,
        questCategory: room.category,
        questId: room.quest_id,
    })
    assert.deepEqual(socket.frames[0], [0, socket.frames[0][1], room.room_number],
        "竞态窗口内的握手必须经 consume 自愈后 Accept")
    assert.equal(
        lifecycleRegistry.get(room.room_number).joiners[`viewer:${GUEST.viewerId}`],
        "handshaked",
        "自愈后内核必须持有该客机的 handshaked joiner",
    )
})
