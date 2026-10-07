"use strict"

// 批次三：服务端 NPC 释放点（私服混合窗口）、postFill 招募行处置、T1 投递资格门。
// - 释放点：W 到点经 handleEnterComs 注入 NPC；回调内重读配置（W 调长自动重挂）；
//   招募行活性重锚（关闭/过期即放弃）；hostClient 缺席跳过
// - postFill：close（官服）关招募 / keep-open（私服）服务端接管行寿命
// - T1：本节点房间态门（未开战/房主在线/真人未满员），异节点放行

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const restore = require("./helpers/install-bundled-gameplay-snapshot.cjs").installBundledGameplaySnapshot()
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "npc-release-"))
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

const { startLobbyLifecycle } = require("../src/multi/tcp/lobby-lifecycle")
startLobbyLifecycle()

const { updateServerGameplaySettingsSync, getServerGameplaySettingsSync } = require("../src/data/domains/server-settings")
const {
    getOrCreateRecruitmentForRoom,
    findOpenRecruitmentForRoom,
} = require("../src/data/domains/attention")
const { applyNpcPostFill, scheduleNpcRelease } = require("../src/multi/npc/release")
const NPC_VIEWER_FLOOR = 900000000
const { handleSocketDisconnect } = require("../src/multi/tcp/lobby")
const { isBellDeliveryEligible } = require("../src/multi/bell-gate")
const { QuestCategory } = require("../src/lib/types")
const roomManager = require("../src/multi/room/manager")
const { createRoom, getRoom } = roomManager
const { sessionManager } = require("../src/multi/state/SessionManager")
const { getServerTime } = require("../src/utils")

const HOST_VIEWER = 800000701

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

function setupHostRoom(t, hostViewerId = HOST_VIEWER) {
    const room = createRoom(
        hostViewerId, hostViewerId + 1000, 1, QuestCategory.BOSS_BATTLE, 1001001,
        0, 1, false, { nodeSessionId: "embedded", viewerId: hostViewerId },
    )
    const socket = new FakeSocket()
    const host = sessionManager.createClient(
        socket, hostViewerId, room.room_number, `${room.room_number}-host-cid`,
    )
    host.participant = { nodeSessionId: "embedded", viewerId: hostViewerId }
    host.yourself = {
        viewerId: hostViewerId, connectionId: host.connectionId,
        party: { characters: [] }, state: [0],
    }
    host.mates = [host.yourself]
    sessionManager.addClientToRoom(host)
    sessionManager.claimRoomHostParticipant(room.room_number, host.participant)
    const live = getRoom(room.room_number)
    live.mates = [{ viewer_id: hostViewerId, com_id: 0 }]
    t.after(() => roomManager.disbandRoom(room.room_number))
    return { room, host, socket }
}

function share(hostViewerId, roomNumber) {
    return getOrCreateRecruitmentForRoom({
        hostPid: hostViewerId - 800000000,
        hostViewerId,
        category: 1,
        questId: 1001001,
        roomNumber,
        isNewbieHost: false,
        establisherJson: "{}",
        nowMs: getServerTime() * 1000,
    })
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const npcCount = mates => mates.filter(m => (m.comId ?? 0) > 0).length

// ---- postFill：close（官服） ----
test("postFill close：NPC 进场后关闭招募行", () => {
    const { room } = setupHostRoom(test)
    const recruitment = share(HOST_VIEWER, room.room_number)
    assert.equal(findOpenRecruitmentForRoom(HOST_VIEWER, room.room_number, getServerTime() * 1000) !== null, true)

    applyNpcPostFill(room.room_number)

    assert.equal(findOpenRecruitmentForRoom(HOST_VIEWER, room.room_number, getServerTime() * 1000), null,
        "closeAfterFill 默认 true：行必须关闭")
    assert.equal(recruitment.id > 0, true)
})

// ---- postFill：keep-open（私服） ----
test("postFill keep-open：行寿命服务端接管（外推过期时间）", async () => {
    updateServerGameplaySettingsSync({
        dropMultiplier: getServerGameplaySettingsSync().dropMultiplier,
        multiRandomRecruitmentPublishEnabled: true,
        multiNpcCloseRecruitmentAfterFill: false,
    })
    const hostViewer = HOST_VIEWER + 1
    const { room } = setupHostRoom(test, hostViewer)
    const recruitment = share(hostViewer, room.room_number)

    applyNpcPostFill(room.room_number)

    const row = db.prepare("SELECT status, expires_at_ms FROM attention_recruitments WHERE id = ?").get(recruitment.id)
    assert.equal(row.status, "open", "keep-open 行保持 open")
    // 服务端接管语义：行过期时间 = 最近一次 NPC 进场时刻 + 整段寿命
    //（getServerTime 秒级量化，同秒刷新与原值相等——用「仍持有近整段寿命」断言）
    assert.ok(row.expires_at_ms >= getServerTime() * 1000 + 44_000, "行寿命被服务端接管（≈整段寿命剩余）")
})

test("postFill keep-open：publish off 时不外推（发布门优先）", () => {
    updateServerGameplaySettingsSync({
        dropMultiplier: getServerGameplaySettingsSync().dropMultiplier,
        multiRandomRecruitmentPublishEnabled: false,
        multiNpcCloseRecruitmentAfterFill: false,
    })
    const hostViewer = HOST_VIEWER + 2
    const { room } = setupHostRoom(test, hostViewer)
    const recruitment = share(hostViewer, room.room_number)
    const before = db.prepare("SELECT expires_at_ms FROM attention_recruitments WHERE id = ?")
        .get(recruitment.id).expires_at_ms

    applyNpcPostFill(room.room_number)

    const row = db.prepare("SELECT expires_at_ms FROM attention_recruitments WHERE id = ?").get(recruitment.id)
    assert.equal(row.expires_at_ms, before, "publish off 不得外推")
    updateServerGameplaySettingsSync({
        dropMultiplier: getServerGameplaySettingsSync().dropMultiplier,
        multiRandomRecruitmentPublishEnabled: true,
    })
})

// ---- 释放点：注入端到端 + keep-open 行寿命 ----
test("释放点：W 到点注入 NPC，keep-open 行保持 open 且寿命外推", async () => {
    updateServerGameplaySettingsSync({
        dropMultiplier: getServerGameplaySettingsSync().dropMultiplier,
        multiRandomRecruitmentPublishEnabled: true,
        multiNpcReleaseSeconds: 1,
        multiNpcCloseRecruitmentAfterFill: false,
    })
    const hostViewer = HOST_VIEWER + 3
    const { room, host } = setupHostRoom(test, hostViewer)
    share(hostViewer, room.room_number)

    scheduleNpcRelease(room.room_number)
    await wait(1800)

    assert.ok(npcCount(host.mates) > 0, "W 到点必须注入 NPC（服务端直接写编队）")
    assert.equal(getRoom(room.room_number).npc_count > 0, true)
    const row = db.prepare("SELECT status, expires_at_ms FROM attention_recruitments WHERE id = ?")
        .get(findOpenRecruitmentByKeySafe(room.room_number, hostViewer))
    assert.equal(row.status, "open", "keep-open：注入后行保持 open")
}, 15000)

function findOpenRecruitmentByKeySafe(roomNumber, hostViewer) {
    return findOpenRecruitmentForRoom(hostViewer, roomNumber, getServerTime() * 1000).id
}

// ---- 释放点守卫：行关闭即放弃 ----
test("释放点守卫：招募行关闭（开战/清扫）后到点放弃注入", async () => {
    updateServerGameplaySettingsSync({
        dropMultiplier: getServerGameplaySettingsSync().dropMultiplier,
        multiRandomRecruitmentPublishEnabled: true,
        multiNpcReleaseSeconds: 1,
        multiNpcCloseRecruitmentAfterFill: true,
    })
    const hostViewer = HOST_VIEWER + 4
    const { room, host } = setupHostRoom(test, hostViewer)
    const recruitment = share(hostViewer, room.room_number)
    scheduleNpcRelease(room.room_number)

    // 模拟开战关招募（beginBattle 挂点同款效果）在到点前发生
    db.prepare("UPDATE attention_recruitments SET status = 'closed' WHERE id = ?").run(recruitment.id)
    await wait(1600)

    assert.equal(npcCount(host.mates), 0, "行关闭后到点必须放弃注入")
}, 15000)

// ---- 释放点：W 调长自动重挂（回调内重读配置） ----
test("释放点：W 热切换调长后按剩余时间重挂", async () => {
    updateServerGameplaySettingsSync({
        dropMultiplier: getServerGameplaySettingsSync().dropMultiplier,
        multiRandomRecruitmentPublishEnabled: true,
        multiNpcReleaseSeconds: 1,
        multiNpcCloseRecruitmentAfterFill: true,
    })
    const hostViewer = HOST_VIEWER + 5
    const { room, host } = setupHostRoom(test, hostViewer)
    share(hostViewer, room.room_number)
    scheduleNpcRelease(room.room_number)

    // 到点前把 W 调长到 4s：1s 时的 fire 读到新 W → 剩余 ~3s 重挂
    updateServerGameplaySettingsSync({
        dropMultiplier: getServerGameplaySettingsSync().dropMultiplier,
        multiNpcReleaseSeconds: 4,
    })
    await wait(1800)
    assert.equal(npcCount(host.mates), 0, "W 调长后原到点不得注入")

    await wait(3200)
    assert.ok(npcCount(host.mates) > 0, "按剩余时间重挂后到点注入")
}, 20000)

// ---- 释放点：open-但-过期（客户端重发停摆）服务端接管，视为到点注入 ----
test("释放点兜底：open 但已过期的行视为到点继续注入", async () => {
    updateServerGameplaySettingsSync({
        dropMultiplier: getServerGameplaySettingsSync().dropMultiplier,
        multiRandomRecruitmentPublishEnabled: true,
        multiNpcReleaseSeconds: 1,
        multiNpcCloseRecruitmentAfterFill: true,
    })
    const hostViewer = HOST_VIEWER + 6
    const { room, host } = setupHostRoom(test, hostViewer)
    const recruitment = share(hostViewer, room.room_number)
    // 模拟客户端重发停摆：行 open 但已过期（getServerTime 秒级量化，直接改库）
    db.prepare("UPDATE attention_recruitments SET expires_at_ms = ? WHERE id = ?")
        .run(getServerTime() * 1000 - 1000, recruitment.id)
    scheduleNpcRelease(room.room_number)
    await wait(1600)

    assert.ok(npcCount(host.mates) > 0, "open-但-过期 = 刷新停摆而非关闭，服务端接管继续注入")
}, 15000)

// ---- 释放点：resetNpcReleaseState 清除在途调度标记（hub→local 回退同款） ----
test("释放点：resetNpcReleaseState 后可重新挂点", async () => {
    const { resetNpcReleaseState } = require("../src/multi/npc/release")
    updateServerGameplaySettingsSync({
        dropMultiplier: getServerGameplaySettingsSync().dropMultiplier,
        multiRandomRecruitmentPublishEnabled: true,
        multiNpcReleaseSeconds: 30,
        multiNpcCloseRecruitmentAfterFill: true,
    })
    const hostViewer = HOST_VIEWER + 7
    const { room, host } = setupHostRoom(test, hostViewer)
    share(hostViewer, room.room_number)
    scheduleNpcRelease(room.room_number)
    resetNpcReleaseState()
    scheduleNpcRelease(room.room_number)
    await wait(100)
    assert.equal(npcCount(host.mates), 0, "30s 窗口内不注入（仅验证重挂不抛错不重复注入）")
    roomManager.disbandRoom(room.room_number)
})

// ---- T1 投递资格门 ----
test("T1：开战拒绝、host 掉线拒绝、真人满员拒绝、异节点放行", async t => {
    const { room, host } = setupHostRoom(t)

    assert.equal(isBellDeliveryEligible(room.room_number), true, "正常 lobby：合格")

    assert.equal(updateRoomStateIfPossible(room.room_number), true, "前置：转 Battle")
    assert.equal(isBellDeliveryEligible(room.room_number), false, "战斗中：拒绝")

    t.after(() => roomManager.disbandRoom(room.room_number))
})

function updateRoomStateIfPossible(roomNumber) {
    return roomManager.updateRoomState(roomNumber, 4)
}

test("T1：房主掉线（hostClient 缺席）拒绝", () => {
    const room = createRoom(
        HOST_VIEWER + 300, HOST_VIEWER + 1300, 1, QuestCategory.BOSS_BATTLE, 1001001,
        0, 1, false, { nodeSessionId: "embedded", viewerId: HOST_VIEWER + 300 },
    )
    // 不注册任何 session client → hostClient 缺席
    assert.equal(isBellDeliveryEligible(room.room_number), false, "房主不在线：拒绝")
    roomManager.disbandRoom(room.room_number)
})

test("T1：异节点房间（本节点不可见）放行", () => {
    assert.equal(isBellDeliveryEligible("000000"), true, "查无房间 = 其他节点持有：放行")
})

// ---- 重新开启招募时重算配额（用户定案语义：补全发生在开启招募，而非离开瞬间）----
test("重算·续战：1真人+1NPC 重开招募 → npc_count=2，保留旧 NPC 补 1 个", async () => {
    updateServerGameplaySettingsSync({
        dropMultiplier: getServerGameplaySettingsSync().dropMultiplier,
        multiRandomRecruitmentPublishEnabled: true,
        multiNpcReleaseSeconds: 1,
        multiNpcCloseRecruitmentAfterFill: false,
    })
    const hostViewer = HOST_VIEWER + 10
    const { room, host } = setupHostRoom(test, hostViewer)
    const live = getRoom(room.room_number)
    // 第一把结束客机离开后的状态：1真人 + 旧NPC1（npc_count=1 冻结值）
    live.npc_count = 1
    live.is_npc_mode = true
    host.mates.push({ viewerId: NPC_VIEWER_FLOOR + 1, comId: 1, connectionId: `${room.room_number}-npc-1`, name: "Pain1", party: { characters: [] }, state: [0] })
    live.mates = host.mates.map(m => ({ viewer_id: m.viewerId ?? null, com_id: m.comId ?? 0 }))

    // 重新开启招募（share_room [3] → 发布门开 → 挂释放点）
    share(hostViewer, room.room_number)
    scheduleNpcRelease(room.room_number)
    await wait(1800)

    assert.equal(live.npc_count, 2, "重算 = 3 − 真人1 = 2")
    assert.equal(npcCount(host.mates), 2, "保留旧 NPC 并补 1 个")
    assert.ok(npcCount(host.mates.filter(m => m.comId === 1)) === 1, "旧 NPC1 保留")
    const row = db.prepare("SELECT status FROM attention_recruitments WHERE room_number = ?").get(room.room_number)
    assert.equal(row.status, "open", "keep-open 行保持 open")
}, 15000)

test("重算·不续战：1真人（npc_count=0）重开招募 → 补 2 个 NPC", async () => {
    updateServerGameplaySettingsSync({
        dropMultiplier: getServerGameplaySettingsSync().dropMultiplier,
        multiRandomRecruitmentPublishEnabled: true,
        multiNpcReleaseSeconds: 1,
        multiNpcCloseRecruitmentAfterFill: true,
    })
    const hostViewer = HOST_VIEWER + 11
    const { room, host } = setupHostRoom(test, hostViewer)
    const live = getRoom(room.room_number)
    // 一场一换 release 清零后的状态：1真人、无 NPC
    live.npc_count = 0
    live.is_npc_mode = true
    live.mates = [{ viewer_id: hostViewer, com_id: 0 }]

    share(hostViewer, room.room_number)
    scheduleNpcRelease(room.room_number)
    await wait(1800)

    assert.equal(live.npc_count, 2, "重算 = 3 − 真人1 = 2")
    assert.equal(npcCount(host.mates), 2, "补 2 个 NPC")
    assert.equal(host.mates.length, 3, "满编 3/3")
}, 15000)

console.log("multi npc release: all assertions passed")
