"use strict"

// 角色获得 × 常规任务即时结算回归（characters_count =「让新角色成为伙伴」）：
// 新角色入队（givePlayerCharacterSync 覆盖教程/剧情/直领/奖励引擎全部非扭蛋
// 路径；扭蛋已在自身奖励流内结算）必须在入队事务内当场重算 characters_count
// 并落进度/发奖——而不是延迟到下一次任意任务评估（如点满 mana 板）才补发。
// 前置：任务板行需已播种（生产由 /load 初始化，与线上一致）。

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const { setServerTimeOffset } = require("../src/utils")

function freshPlayerWithMissionBoard(t, missionId = 32) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "char-acq-mission-"))
    process.env.WDFP_DATABASE_DIR = dir
    const restore = require("./helpers/install-bundled-gameplay-snapshot.cjs")
        .installBundledGameplaySnapshot()
    const { initializeDatabase } = require("../src/data")
    const { getDb } = require("../src/data/db")
    initializeDatabase()
    const db = getDb()
    // 内容纪元内的虚拟钟（任务启用窗口校验依赖服务器日期）
    setServerTimeOffset(Date.parse("2023-04-23T12:00:00Z") - Date.now())
    const { insertAccountSync } = require("../src/data/domains/account")
    const { insertDefaultPlayerSync } = require("../src/data/domains/player")
    const account = insertAccountSync({
        appId: "wf_cn", idpAlias: "", idpCode: "t",
        idpId: `char-acq-${missionId}-${Date.now()}-${Math.random()}`, status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    db.prepare(
        "INSERT INTO players_category_missions (category, id, progress, player_id) VALUES (1, ?, 0, ?)",
    ).run(missionId, playerId)
    t.after(() => {
        try { db.close() } catch {}
        restore()
        fs.rmSync(dir, { recursive: true, force: true })
    })
    return { db, playerId }
}

test("新角色入队当场结算 characters_count（不再延迟到点板等其他评估点）", t => {
    const { db, playerId } = freshPlayerWithMissionBoard(t, 32)
    const { givePlayerCharacterSync } = require("../src/lib/character")

    // 初始 roster = 1（默认角色计入持有数）；再获得 2 名 → 3 < 目标 4 不发奖
    for (const characterId of [341005, 341006]) givePlayerCharacterSync(playerId, characterId)
    const midway = db.prepare(
        "SELECT progress FROM players_category_missions WHERE player_id = ? AND id = 32",
    ).get(playerId)
    assert.equal(midway.progress, 3, "每获得一名角色进度立即推进（3 < 目标 4 不发奖）")

    givePlayerCharacterSync(playerId, 341007)
    const completed = db.prepare(
        "SELECT progress FROM players_category_missions WHERE player_id = ? AND id = 32",
    ).get(playerId)
    assert.ok(completed.progress >= 4, "第 4 名角色入队即达标（progress ≥ 4）")
})

test("已有角色重复获得不推进 characters_count（stack/限界不算新伙伴）", t => {
    const { db, playerId } = freshPlayerWithMissionBoard(t, 32)
    const { givePlayerCharacterSync } = require("../src/lib/character")

    givePlayerCharacterSync(playerId, 341005)
    givePlayerCharacterSync(playerId, 341005) // 重复获得 → stack 记账
    const row = db.prepare(
        "SELECT progress FROM players_category_missions WHERE player_id = ? AND id = 32",
    ).get(playerId)
    assert.equal(row.progress, 2, "重复获得不重复计数（1 初始 + 1 新）")
})
