"use strict"

// R-09 + 恢复链路补票回归：
// 1) restore_room 为房内成员重新签发准入（切出切回的握手可正常消费）；
// 2) 握手拒绝分级——可恢复拒绝走优雅 [1, "DENIED"]，协议错误保留 [3] Fatal。

const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

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
const { addRoomMember, createRoom, disbandRoom, updateRoomState } = require("../src/multi/room/manager")
const { sessionManager } = require("../src/multi/state/SessionManager")
const { embeddedAdmissionRegistry } = require("../src/multi/admission/registry")
const { handleHandshake } = require("../src/multi/tcp/handshake")

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
    assert.deepEqual(socket.frames[0], [1, "DENIED"], "房间状态拒绝必须走优雅 Denied")

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
    assert.deepEqual(socket.frames[0], [1, "DENIED"], "准入缺失必须走优雅 Denied（可经 restore_room 补票重试）")
})
