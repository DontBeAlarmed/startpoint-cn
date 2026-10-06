"use strict"

// multi /start（quest/start multi）铃铛进房解析语义回归：
// resolveBellRecruitmentForStart 只接受 open 且 (room_number, 房主) 与当前战斗
// 完全一致的招募；防伪 key / 跨房间 key / 过期 / 关闭一律 fail-open 为 null
// （退回实时 isNewbieHostSync 判定，不影响正常开战）。

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const restore = require("./helpers/install-bundled-gameplay-snapshot.cjs").installBundledGameplaySnapshot()
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attention-bell-start-"))
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
    getOrCreateRecruitmentForRoom,
} = require("../src/data/domains/attention")
const { resolveBellRecruitmentForStart } = require("../src/multi/http/battle")
// 被测代码内部用 getServerTime()*1000（虚拟钟）取时，测试造数必须同域，
// 否则一旦测试环境设置 timeOffset 就会以"招募过期"的方式碎掉
const { getServerTime } = require("../src/utils")

const HOST_VIEWER = 9501
const HOST_PID = 501
const ROOM = "998877"
const nowMs = getServerTime() * 1000

const recruitment = getOrCreateRecruitmentForRoom({
    hostPid: HOST_PID,
    hostViewerId: HOST_VIEWER,
    category: 1,
    questId: 1001001,
    roomNumber: ROOM,
    isNewbieHost: true,
    establisherJson: buildEstablisherSnapshot({ character: 341005, rankLevel: 42, hostEntryTime: 1700 }),
    nowMs,
})

// null / 空 key → null
assert.equal(resolveBellRecruitmentForStart(null, ROOM, HOST_VIEWER), null)

// 未知 key → null（防伪造）
assert.equal(resolveBellRecruitmentForStart("attention_000000_1", ROOM, HOST_VIEWER), null)

// 有效 key + 房间/房主一致 → 招募
const matched = resolveBellRecruitmentForStart(recruitment.attentionKey, ROOM, HOST_VIEWER)
assert.ok(matched !== null)
assert.equal(matched.id, recruitment.id)
assert.equal(matched.isNewbieHost, true, "cond92 冻结来源必须是招募行的 is_newbie_host")

// 房间号不一致（拿 A 房 key 开 B 房）→ null
assert.equal(resolveBellRecruitmentForStart(recruitment.attentionKey, "112233", HOST_VIEWER), null)

// 房主不一致（拿 A 房主的 key 加入 B 房主）→ null
const otherHost = getOrCreateRecruitmentForRoom({
    hostPid: 502, hostViewerId: 9502, category: 1, questId: 1001001,
    roomNumber: "445566", isNewbieHost: false, establisherJson: "{}", nowMs,
})
assert.equal(resolveBellRecruitmentForStart(recruitment.attentionKey, "445566", 9502), null)
assert.ok(resolveBellRecruitmentForStart(otherHost.attentionKey, "445566", 9502) !== null)

// 关闭 → null
closeRecruitmentForRoom(HOST_VIEWER, ROOM)
assert.equal(resolveBellRecruitmentForStart(recruitment.attentionKey, ROOM, HOST_VIEWER), null,
    "已关闭招募不得作为铃铛进房依据")

console.log("attention bell start: all assertions passed")
