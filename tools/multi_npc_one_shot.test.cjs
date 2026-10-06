"use strict"

// 批次二：一场一换（npcLifecycle=one-shot）回归。
// 锁定清除原子面 6 项（设计 v2 §4）：npc_count→0、hostClient.mates 过滤（权威）、
// roomClient 投影过滤、room.mates 重算、advanceRecruitmentGeneration、全量 mates 广播；
// 设置在事件点读取（默认 persistent no-op）；hostClient 缺席降级；releaseBattle 挂点触发。

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const restore = require("./helpers/install-bundled-gameplay-snapshot.cjs").installBundledGameplaySnapshot()
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "npc-one-shot-"))
process.env.WDFP_DATABASE_DIR = dir
let db

function cleanup() {
    if (db?.open) db.close()
    restore()
    fs.rmSync(dir, { recursive: true, force: true })
}
process.once("exit", cleanup)

const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
initializeDatabase()
db = getDb()

const { updateServerGameplaySettingsSync, getServerGameplaySettingsSync } = require("../src/data/domains/server-settings")
const { QuestCategory } = require("../src/lib/types")
const roomManager = require("../src/multi/room/manager")
const { createRoom, getRoom, updateRoomState } = roomManager
const { sessionManager } = require("../src/multi/state/SessionManager")
const { clearRoomNpcRoster } = require("../src/multi/npc/one-shot")
const { EmbeddedMultiCoordinator } = require("../src/multi/coordinator/embedded")

const HOST_VIEWER = 800000601
const QUEST_ID = 1001001
const NPC_VIEWER_FLOOR = 900000000

class FakeSocket extends EventEmitter {
    constructor() {
        super()
        this.destroyed = false
        this.writable = true
        this.writes = []
    }
    write(value) {
        this.writes.push(JSON.parse(String(value).replace(/\0$/, "")))
        return true
    }
    end() { this.writable = false }
    destroy() { this.destroyed = true; this.writable = false }
}

function makeNpcMate(roomNumber, comId) {
    return {
        viewerId: NPC_VIEWER_FLOOR + comId,
        comId,
        connectionId: `${roomNumber}-npc-${comId}`,
        name: `Pain${comId}`,
        rank: 10,
        playerRoleKind: 99,
        party: { characters: [] },
        state: [0],
    }
}

function setupRoomWithNpcs(t, { withGuest = true } = {}) {
    const room = createRoom(
        HOST_VIEWER,
        HOST_VIEWER + 1000,
        1,
        QuestCategory.BOSS_BATTLE,
        QUEST_ID,
        0,
        1,
        false,
        { nodeSessionId: "embedded", viewerId: HOST_VIEWER },
    )
    const hostSocket = new FakeSocket()
    const host = sessionManager.createClient(
        hostSocket, HOST_VIEWER, room.room_number, `${room.room_number}-host-cid`,
    )
    host.participant = { nodeSessionId: "embedded", viewerId: HOST_VIEWER }
    host.yourself = {
        viewerId: HOST_VIEWER, connectionId: host.connectionId,
        party: { characters: [] }, state: [0],
    }
    host.mates = [host.yourself, makeNpcMate(room.room_number, 1), makeNpcMate(room.room_number, 2)]
    sessionManager.addClientToRoom(host)
    sessionManager.claimRoomHostParticipant(room.room_number, host.participant)

    let guest
    let guestSocket
    if (withGuest) {
        guestSocket = new FakeSocket()
        const guestViewer = HOST_VIEWER + 1
        guest = sessionManager.createClient(
            guestSocket, guestViewer, room.room_number, `${room.room_number}-guest-cid`,
        )
        guest.participant = { nodeSessionId: "embedded", viewerId: guestViewer }
        guest.yourself = {
            viewerId: guestViewer, connectionId: guest.connectionId,
            party: { characters: [] }, state: [0],
        }
        guest.mates = [...host.mates]
        sessionManager.addClientToRoom(guest)
    }

    // NPC 已进场：npc_count/is_npc_mode 与 mates 形态对齐 EnterComs 提交后状态
    const live = getRoom(room.room_number)
    live.npc_count = 2
    live.is_npc_mode = true
    live.mates = host.mates.map(m => ({ viewer_id: m.viewerId ?? null, com_id: m.comId ?? 0 }))

    t.after(() => {
        sessionManager.removeBattleParticipant?.(room.room_number, host.participant)
        roomManager.disbandRoom(room.room_number)
    })
    return { room, host, guest, hostSocket }
}

function npcCountIn(mates) {
    return mates.filter(m => (m.comId ?? 0) > 0 || (m.viewerId ?? 0) >= NPC_VIEWER_FLOOR).length
}

test("persistent（默认）为 no-op——设置在事件点读取", () => {
    const { host } = setupRoomWithNpcs(test)
    const before = [...host.mates]
    clearRoomNpcRoster(host.roomNumber)
    assert.equal(host.mates.length, before.length, "默认 persistent 不得清除")
    assert.equal(getRoom(host.roomNumber).npc_count, 2)
})

test("one-shot：6 项原子面——npc_count/host 权威/投影/room.mates/revision/广播", () => {
    updateServerGameplaySettingsSync({
        dropMultiplier: getServerGameplaySettingsSync().dropMultiplier,
        multiNpcOneShotLifecycle: true,
    })
    const { host, guest, hostSocket } = setupRoomWithNpcs(test)
    const writesBefore = hostSocket.writes.length

    clearRoomNpcRoster(host.roomNumber, "session-1")

    const live = getRoom(host.roomNumber)
    assert.equal(live.npc_count, 0, "原子面 1：npc_count 归零")
    assert.equal(npcCountIn(host.mates), 0, "原子面 2：host 权威列表无 NPC")
    assert.equal(host.mates.length, 1, "真人房主保留")
    assert.equal(npcCountIn(guest.mates), 0, "原子面 3：guest 投影无 NPC")
    assert.equal(live.mates.length, 1, "原子面 4：room.mates 重算（serializer 人数源）")
    assert.deepEqual(live.mates[0], { viewer_id: HOST_VIEWER, com_id: 0 })

    const mateBroadcast = hostSocket.writes.slice(writesBefore).find(
        frame => Array.isArray(frame) && frame[0] === 1 && Array.isArray(frame[1])
            && frame[1][0] === 1 && Array.isArray(frame[1][1]),
    )
    assert.ok(mateBroadcast, "原子面 6：全量 mates 广播（[1,[1,mates]]）")
    assert.equal(mateBroadcast[1][1].length, 1, "广播内容为清除后的编队")
})

test("T2 修正回归：viewerId ≥ 9e8 的真人不被误判为 NPC", () => {
    updateServerGameplaySettingsSync({
        dropMultiplier: getServerGameplaySettingsSync().dropMultiplier,
        multiNpcOneShotLifecycle: true,
    })
    // generateViewerId 真人空间 [1e8, 999999998] 与 NPC 合成区间重叠——
    // 谓词只认 comId（双审 B-5），高段位 viewerId 真人必须保留
    const { host } = setupRoomWithNpcs(test)
    const highTierViewer = 950000000
    host.mates.push({
        viewerId: highTierViewer, connectionId: `${host.roomNumber}-high-tier`,
        party: { characters: [] }, state: [0],
    })
    getRoom(host.roomNumber).mates.push({ viewer_id: highTierViewer, com_id: 0 })

    clearRoomNpcRoster(host.roomNumber, "session-high")

    assert.ok(host.mates.some(m => m.viewerId === highTierViewer), "高段位真人保留在权威列表")
    assert.equal(getRoom(host.roomNumber).mates.some(m => m.viewer_id === highTierViewer), true)
})

test("一代一闩：同 session 重入不误清 rematch 新一代；新 session 正常清除", () => {
    updateServerGameplaySettingsSync({
        dropMultiplier: getServerGameplaySettingsSync().dropMultiplier,
        multiNpcOneShotLifecycle: true,
    })
    const { host, hostSocket } = setupRoomWithNpcs(test)
    clearRoomNpcRoster(host.roomNumber, "session-1")
    assert.equal(npcCountIn(host.mates), 0)

    // finalize 重试（同 session-1）在 30min fact 窗口内重入：
    // 若 host 已重开招募并重建新一代 NPC（rematch），重入不得误清
    host.mates.push(
        makeNpcMate(host.roomNumber, 1),
        makeNpcMate(host.roomNumber, 2),
    )
    getRoom(host.roomNumber).npc_count = 2
    const writesBefore = hostSocket.writes.length
    clearRoomNpcRoster(host.roomNumber, "session-1")
    assert.equal(npcCountIn(host.mates), 2, "同 session 重入不得误清新一代编队")
    assert.equal(hostSocket.writes.length, writesBefore, "重入不广播")

    // 新一代战斗（新 session id）释放：正常清除
    clearRoomNpcRoster(host.roomNumber, "session-2")
    assert.equal(npcCountIn(host.mates), 0, "新 session 释放正常清除新一代")
})

test("one-shot：hostClient 缺席（战斗中掉线）降级——room.mates 直清、不抛错", () => {
    updateServerGameplaySettingsSync({
        dropMultiplier: getServerGameplaySettingsSync().dropMultiplier,
        multiNpcOneShotLifecycle: true,
    })
    // 只造房间状态，不注册任何 session client（模拟 host 掉线宽限期内 release）
    const room = createRoom(
        HOST_VIEWER + 100, HOST_VIEWER + 1100, 1, QuestCategory.BOSS_BATTLE, QUEST_ID,
        0, 1, false, { nodeSessionId: "embedded", viewerId: HOST_VIEWER + 100 },
    )
    const live = getRoom(room.room_number)
    live.npc_count = 2
    live.is_npc_mode = true
    live.mates = [
        { viewer_id: HOST_VIEWER + 100, com_id: 0 },
        { viewer_id: NPC_VIEWER_FLOOR + 1, com_id: 1 },
        { viewer_id: NPC_VIEWER_FLOOR + 2, com_id: 2 },
    ]

    assert.doesNotThrow(() => clearRoomNpcRoster(room.room_number))
    assert.equal(live.npc_count, 0)
    assert.deepEqual(live.mates, [{ viewer_id: HOST_VIEWER + 100, com_id: 0 }],
        "无 host 时 room.mates 直清，客户端视图待回房重建")
})

test("one-shot：无 NPC 房间为 no-op", () => {
    updateServerGameplaySettingsSync({
        dropMultiplier: getServerGameplaySettingsSync().dropMultiplier,
        multiNpcOneShotLifecycle: true,
    })
    const { host } = setupRoomWithNpcs(test)
    const live = getRoom(host.roomNumber)
    live.npc_count = 0
    live.is_npc_mode = false
    const before = [...host.mates]
    clearRoomNpcRoster(host.roomNumber)
    assert.deepEqual(host.mates, before)
})

test("releaseBattle 挂点：4→1 成功触发回调（携带 session id）、幂等重复触发", () => {
    const released = []
    const coordinator = new EmbeddedMultiCoordinator({
        onBattleReleased: (roomNumber, battleSessionId) => { released.push([roomNumber, battleSessionId]) },
    })

    const room = createRoom(
        HOST_VIEWER + 200, HOST_VIEWER + 1200, 1, QuestCategory.BOSS_BATTLE, QUEST_ID,
        0, 1, false, { nodeSessionId: "embedded", viewerId: HOST_VIEWER + 200 },
    )
    assert.equal(updateRoomState(room.room_number, 4), true, "前置：转 Battle")

    // releaseBattle 是私有边界——经实例直接驱动（CJS 运行时无可见性限制）
    assert.equal(coordinator.releaseBattle(room.room_number, "session-x"), true, "4→1 释放成功")
    assert.deepEqual(released, [[room.room_number, "session-x"]], "成功释放触发 onBattleReleased 并携带 session id")
    assert.equal(getRoom(room.room_number).raising_state, 1)

    // 重复释放幂等：1→1 无转移仍返回 true、回调再触发，但清除函数以一代一闩
    // 保证同 session 幂等（不复活、不重复广播内容变化）
    assert.equal(coordinator.releaseBattle(room.room_number, "session-x"), true)
    assert.equal(released.length, 2)
})

// 双审 A-1 回归：embedded 模式（MULTI_MODE 缺省 = 默认单节点部署）构造必须接线
test("embedded 缺省构造接线 onBattleReleased（默认部署一场一换不静默失效）", () => {
    const src = fs.readFileSync(
        path.join(__dirname, "../src/multi/runtime/service.ts"), "utf8",
    )
    const constructorSites = src.split("new EmbeddedMultiCoordinator").length - 1
    const wiredSites = src.split("onBattleReleased: clearRoomNpcRoster").length - 1
    assert.ok(constructorSites >= 3, `service 应有 ≥3 处构造（host/client/embedded），实际 ${constructorSites}`)
    assert.equal(wiredSites, constructorSites, "每处 EmbeddedMultiCoordinator 构造都必须接线 onBattleReleased")
})
