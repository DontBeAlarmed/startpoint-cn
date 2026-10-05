"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const { randomUUID } = require("node:crypto")
const os = require("node:os")
const path = require("node:path")

const restore = require("./helpers/install-bundled-gameplay-snapshot.cjs").installBundledGameplaySnapshot()
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rescue-counters-"))
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

const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const account = insertAccountSync({ appId: "wf_cn", idpAlias: "", idpCode: "t", idpId: `rc-${randomUUID()}`, status: "normal" })
const playerId = insertDefaultPlayerSync(account.id).id

const { addMissionCounterSync, getMissionCounterValueSync } = require("../src/lib/mission/mission-counters")
const {
    recordRescueBattleMissionCountersSync,
    rescueClearQuery,
    newbieRescueClearQuery,
} = require("../src/lib/mission/rescue-battle-counters")

const q = (cat, id) => db.prepare(
    "SELECT progress FROM players_category_missions WHERE player_id=? AND category=? AND id=?"
).get(playerId, cat, id)

// 通用计数器 add/get 与 qualifier 隔离
addMissionCounterSync(playerId, rescueClearQuery(), 1)
addMissionCounterSync(playerId, rescueClearQuery(2), 1)
assert.equal(getMissionCounterValueSync(playerId, rescueClearQuery()), 1)
assert.equal(getMissionCounterValueSync(playerId, rescueClearQuery(2)), 1)
assert.equal(getMissionCounterValueSync(playerId, rescueClearQuery(3)), 0)
assert.equal(getMissionCounterValueSync(playerId, newbieRescueClearQuery()), 0)

// 领主战 rank2 救援（灼炎超级 1026002）+ 新手救援
recordRescueBattleMissionCountersSync(playerId, { rescue: true, newbieRescue: true, questCategory: 2, questId: 1026002 })
assert.equal(getMissionCounterValueSync(playerId, rescueClearQuery()), 2, "总救援计数")
assert.equal(getMissionCounterValueSync(playerId, rescueClearQuery(2)), 2, "rank2 限定计数")
assert.equal(getMissionCounterValueSync(playerId, newbieRescueClearQuery()), 1, "新手救援计数")

// 降临 eventId5 救援（伊劳德雷斯 2020 代 cat7 5003）：推进 eventId5 任务行
recordRescueBattleMissionCountersSync(playerId, { rescue: true, newbieRescue: false, questCategory: 7, questId: 5003 })
assert.ok((q(2, 120017)?.progress ?? 0) >= 1, "降临 eventId5 每日救援任务必须推进")
assert.ok((q(3, 1561)?.progress ?? 0) >= 1, "cat3 eventId5 救援任务必须推进")

// 领主战 rank3 救援（伊劳德雷斯超级 1027003）：推进 rank3 任务行，不碰 rank1
recordRescueBattleMissionCountersSync(playerId, { rescue: true, newbieRescue: false, questCategory: 2, questId: 1027003 })
assert.ok((q(1, 64)?.progress ?? 0) >= 1, "rank3 领主战救援必须推进 rank3 常驻任务")
assert.equal(q(1, 62)?.progress ?? 0, 0, "rank3 领主战不得推进 rank1 任务")

// 非救援战斗不计
recordRescueBattleMissionCountersSync(playerId, { rescue: false, newbieRescue: false, questCategory: 2, questId: 1026003 })
assert.equal(getMissionCounterValueSync(playerId, rescueClearQuery()), 4, "非救援战斗不得改变救援计数")

console.log("rescue counters tests passed")
