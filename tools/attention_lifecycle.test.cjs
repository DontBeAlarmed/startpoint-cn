"use strict"

// A1 铃铛域层生命周期回归：get-or-create 稳定 key、读时惰性投递、
// accepted/declined 单向转移、close/expiry 收敛、establisher 快照解析。
// 官方契约依据：房主客户端每 15s 重发 share_room（上限 20 次），
// guest 轮询 /attention/check 拉取 multi[]（AttentionCheckRealRemoteService）。

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const restore = require("./helpers/install-bundled-gameplay-snapshot.cjs").installBundledGameplaySnapshot()
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attention-lifecycle-"))
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

const {
    buildEstablisherSnapshot,
    closeRecruitmentForRoom,
    deliverOpenRecruitmentsToViewer,
    findOpenRecruitmentByKey,
    getOrCreateRecruitmentForRoom,
    getRecruitmentLifetimeMs,
    parseEstablisherSnapshot,
    recordResponse,
} = require("../src/data/domains/attention")

const HOST_VIEWER = 9001
const HOST_PID = 101
const ROOM = "123456"

let nowMs = 1_000_000

function share(input = {}) {
    return getOrCreateRecruitmentForRoom({
        hostPid: HOST_PID,
        hostViewerId: HOST_VIEWER,
        category: 1,
        questId: 1001001,
        roomNumber: ROOM,
        isNewbieHost: true,
        establisherJson: buildEstablisherSnapshot({
            character: 341005,
            rankLevel: 42,
            hostEntryTime: 1700,
        }),
        nowMs,
        ...input,
    })
}

// ---- get-or-create：同 (房主, 房间) 恒定 key，重发只刷新 ----
{
    const first = share()
    assert.equal(first.created, true)
    assert.match(first.attentionKey, /^attention_\d{6}_9001$/)

    const expiresBefore = db.prepare(
        "SELECT expires_at_ms FROM attention_recruitments WHERE id = ?"
    ).get(first.id).expires_at_ms
    nowMs += 15_000
    const second = share({ isNewbieHost: false, establisherJson: buildEstablisherSnapshot({ character: 2, rankLevel: 7, hostEntryTime: 999 }) })
    assert.equal(second.created, false, "重发不得创建新招募")
    assert.equal(second.attentionKey, first.attentionKey, "重发不得更换 attention_key")
    const row = db.prepare("SELECT * FROM attention_recruitments WHERE id = ?").get(first.id)
    assert.equal(row.expires_at_ms, nowMs + getRecruitmentLifetimeMs(), "重发必须刷新过期时间")
    assert.equal(row.is_newbie_host, 0, "重发刷新新手标记")
    assert.equal(JSON.parse(row.establisher_json).rankLevel, 7, "重发刷新房主快照")

    // 不同房间 → 不同招募行
    const otherRoom = share({ roomNumber: "654321" })
    assert.equal(otherRoom.created, true)
    assert.notEqual(otherRoom.attentionKey, first.attentionKey)
    closeRecruitmentForRoom(HOST_VIEWER, "654321")
}

// ---- 读时惰性投递 ----
{
    const viewerB = 9002
    const bells = deliverOpenRecruitmentsToViewer(viewerB, nowMs, 3)
    assert.equal(bells.length, 1)
    assert.equal(bells[0].roomNumber, ROOM)
    assert.equal(bells[0].isNewbieHost, false, "投递携带最新冻结标记")

    // 投递行已写入且 state=delivered
    const delivery = db.prepare(
        "SELECT * FROM attention_deliveries WHERE viewer_id = ?"
    ).all(viewerB)
    assert.equal(delivery.length, 1)
    assert.equal(delivery[0].state, "delivered")

    // 再次轮询：仍可见（delivered 未响应），不产生重复投递行
    const again = deliverOpenRecruitmentsToViewer(viewerB, nowMs, 3)
    assert.equal(again.length, 1)
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM attention_deliveries WHERE viewer_id = ?").get(viewerB).n, 1)

    // 房主看不见自己的招募
    assert.equal(deliverOpenRecruitmentsToViewer(HOST_VIEWER, nowMs, 3).length, 0)

    // 接受后不再出现在铃铛列表
    recordResponse(bells[0].id, viewerB, "accepted", nowMs + 1)
    assert.equal(deliverOpenRecruitmentsToViewer(viewerB, nowMs + 2, 3).length, 0, "accepted 必须收敛")
}

// ---- recordResponse 单向转移（仅 delivered 可变） ----
{
    const viewerC = 9003
    share()
    const bells = deliverOpenRecruitmentsToViewer(viewerC, nowMs, 3)
    assert.equal(bells.length, 1)
    const recruitmentId = bells[0].id

    recordResponse(recruitmentId, viewerC, "declined", 5_555)
    const declined = db.prepare(
        "SELECT * FROM attention_deliveries WHERE recruitment_id = ? AND viewer_id = ?"
    ).get(recruitmentId, viewerC)
    assert.equal(declined.state, "declined")
    assert.equal(declined.acted_at_ms, 5_555)

    // 对已响应状态重复写必须 no-op（不降级、不刷新 acted_at）
    recordResponse(recruitmentId, viewerC, "accepted", 7_777)
    const still = db.prepare(
        "SELECT * FROM attention_deliveries WHERE recruitment_id = ? AND viewer_id = ?"
    ).get(recruitmentId, viewerC)
    assert.equal(still.state, "declined")
    assert.equal(still.acted_at_ms, 5_555)
}

// ---- findOpenRecruitmentByKey：accept 路径解析 + 防伪 ----
{
    const fresh = share({ roomNumber: "222333" })
    const found = findOpenRecruitmentByKey(fresh.attentionKey, nowMs)
    assert.ok(found !== null)
    assert.equal(found.roomNumber, "222333")
    assert.equal(found.hostViewerId, HOST_VIEWER)

    assert.equal(findOpenRecruitmentByKey("attention_000000_1", nowMs), null, "未知 key 必须拒绝")

    // 过期后失效
    const expired = findOpenRecruitmentByKey(fresh.attentionKey, nowMs + getRecruitmentLifetimeMs() + 1)
    assert.equal(expired, null, "过期招募不得被 accept")

    // 关闭后失效
    const fresh2 = share({ roomNumber: "333444" })
    closeRecruitmentForRoom(HOST_VIEWER, "333444")
    assert.equal(findOpenRecruitmentByKey(fresh2.attentionKey, nowMs), null, "关闭招募不得被 accept")
}

// ---- limit（return_attention_max_num）与多房主并存 ----
{
    db.prepare("DELETE FROM attention_recruitments").run()
    db.prepare("DELETE FROM attention_deliveries").run()
    const viewer = 9010
    for (let i = 0; i < 5; i++) {
        getOrCreateRecruitmentForRoom({
            hostPid: 200 + i,
            hostViewerId: 9100 + i,
            category: 1,
            questId: 1001001,
            roomNumber: `70000${i}`,
            isNewbieHost: false,
            establisherJson: "{}",
            nowMs: nowMs + i,
        })
    }
    const limited = deliverOpenRecruitmentsToViewer(viewer, nowMs, 3)
    assert.equal(limited.length, 3, "单次 check 最多 return_attention_max_num 个铃铛")
    // 最新招募优先（posted_at DESC）
    assert.equal(limited[0].roomNumber, "700004")
    assert.equal(limited[2].roomNumber, "700002")
}

// ---- expiry 收敛：过期行不再投递 ----
{
    const stale = getOrCreateRecruitmentForRoom({
        hostPid: 300, hostViewerId: 9200, category: 1, questId: 1001001,
        roomNumber: "800001", isNewbieHost: false, establisherJson: "{}",
        nowMs: nowMs - getRecruitmentLifetimeMs() - 10,
    })
    assert.equal(stale.created, true)
    assert.equal(deliverOpenRecruitmentsToViewer(9011, nowMs, 3).some(r => r.id === stale.id), false,
        "过期招募不得出现在投递中")
}

// ---- establisher 快照解析：容错 ----
{
    const valid = parseEstablisherSnapshot(buildEstablisherSnapshot({ character: 341005, rankLevel: 42, hostEntryTime: 1700 }))
    assert.deepEqual(valid, { character: 341005, rankLevel: 42, hostEntryTime: 1700 })
    assert.deepEqual(parseEstablisherSnapshot("not-json"), { character: 0, rankLevel: 0, hostEntryTime: 0 })
    assert.deepEqual(parseEstablisherSnapshot(null), { character: 0, rankLevel: 0, hostEntryTime: 0 })
    assert.deepEqual(parseEstablisherSnapshot("{}"), { character: 0, rankLevel: 0, hostEntryTime: 0 })
}

// ---- close 只影响目标房间 ----
{
    const keep = share({ roomNumber: "444555" })
    const doomed = share({ roomNumber: "555666" })
    closeRecruitmentForRoom(HOST_VIEWER, "555666")
    assert.ok(findOpenRecruitmentByKey(keep.attentionKey, nowMs) !== null, "其它房间的招募不受影响")
    assert.equal(findOpenRecruitmentByKey(doomed.attentionKey, nowMs), null, "关闭房间必须失效")
}

console.log("attention lifecycle: all assertions passed")
