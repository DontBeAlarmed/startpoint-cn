"use strict"

// 装备获得 × 常规任务即时结算回归（got_equip_kind_count =「获得新装备」33 族）：
// 新装备种类入队（givePlayerEquipmentSync 覆盖邮件/商店/交换所/登录奖励等
// 非扭蛋路径；扭蛋批量已在自身奖励流内结算）必须当场结算；同种类叠加
// （stack 增长）不改变种类数、不得重复结算。

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const { setServerTimeOffset } = require("../src/utils")

function freshPlayerWithEquipmentKindMission(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "equip-acq-mission-"))
    process.env.WDFP_DATABASE_DIR = dir
    const restore = require("./helpers/install-bundled-gameplay-snapshot.cjs")
        .installBundledGameplaySnapshot()
    const { initializeDatabase } = require("../src/data")
    const { getDb } = require("../src/data/db")
    initializeDatabase()
    const db = getDb()
    setServerTimeOffset(Date.parse("2023-04-23T12:00:00Z") - Date.now())
    const { insertAccountSync } = require("../src/data/domains/account")
    const { insertDefaultPlayerSync } = require("../src/data/domains/player")
    const { getMissionCatalog } = require("../src/lib/mission/mission-catalog")
    const account = insertAccountSync({
        appId: "wf_cn", idpAlias: "", idpCode: "t",
        idpId: `equip-acq-${Date.now()}-${Math.random()}`, status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    // 播种全部 got_equip_kind_count（33 族）任务板行（对齐生产 /load 播种）
    for (const definition of getMissionCatalog().getDefinitionsByPattern("got_equip_kind_count")) {
        db.prepare(
            "INSERT INTO players_category_missions (category, id, progress, player_id) VALUES (1, ?, 0, ?)",
        ).run(definition.missionId, playerId)
    }
    t.after(() => {
        try { db.close() } catch {}
        restore()
        fs.rmSync(dir, { recursive: true, force: true })
    })
    return { db, playerId }
}

test("新装备种类入队当场结算 got_equip_kind_count", t => {
    const { db, playerId } = freshPlayerWithEquipmentKindMission(t)
    const { givePlayerEquipmentSync } = require("../src/lib/equipment")

    givePlayerEquipmentSync(playerId, 9001, 1)
    givePlayerEquipmentSync(playerId, 9002, 1)

    // 只断言 33 族（结算为全量评估，其他族进度各行其是）
    const equipKindIds = require("../src/lib/mission/mission-catalog")
        .getMissionCatalog().getDefinitionsByPattern("got_equip_kind_count")
        .map(d => d.missionId)
    const rows33 = db.prepare(
        "SELECT id, progress FROM players_category_missions WHERE player_id = ? AND progress > 0",
    ).all(playerId).filter(row => equipKindIds.includes(row.id))
    assert.ok(rows33.length > 0, "33 族任务必须被当场结算")
    for (const row of rows33) assert.ok(row.progress >= 2, `进度 = 已有种类数（${row.progress} ≥ 2）`)
})

test("同种类叠加不重复推进（stack 增长不算新种类）", t => {
    const { db, playerId } = freshPlayerWithEquipmentKindMission(t)
    const { givePlayerEquipmentSync } = require("../src/lib/equipment")

    givePlayerEquipmentSync(playerId, 9001, 1)
    const afterFirst = db.prepare(
        "SELECT id, progress FROM players_category_missions WHERE player_id = ? AND progress > 0",
    ).all(playerId)
    const totalAfterFirst = afterFirst.reduce((sum, row) => sum + row.progress, 0)

    givePlayerEquipmentSync(playerId, 9001, 5) // 同种类叠加
    const afterSecond = db.prepare(
        "SELECT id, progress FROM players_category_missions WHERE player_id = ? AND progress > 0",
    ).all(playerId)
    const totalAfterSecond = afterSecond.reduce((sum, row) => sum + row.progress, 0)

    assert.equal(totalAfterSecond, totalAfterFirst, "同种类叠加不得重复计数")
})
