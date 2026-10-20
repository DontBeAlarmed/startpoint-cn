"use strict"

// F-11 回归：updaters 的 v4 段（players_periodic_snapshots 迁移）缺表时只跳过
// 本段，不得裸 return 跳过后续 v18/v22 迁移——调用方会无条件推进 user_version，
// 裸 return 会留下"版本号已达标但迁移没跑"的半迁移库。

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const restore = require("./helpers/install-bundled-gameplay-snapshot.cjs").installBundledGameplaySnapshot()
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-missing-table-"))
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
const { updateAfterInit } = require("../src/data/updaters/wdfpData")

test("a v3 database missing players_periodic_snapshots still receives later migrations (F-11)", () => {
    // 构造半迁移 v3 库：无 periodic 快照表，但 login_bonus 新旧表并存且有数据
    const { insertAccountSync } = require("../src/data/domains/account")
    const { insertDefaultPlayerSync } = require("../src/data/domains/player")
    const account = insertAccountSync({
        appId: "wf_cn", idpAlias: "", idpCode: "test",
        idpId: "migration-missing-table", status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    db.prepare("DROP TABLE IF EXISTS players_periodic_snapshots").run()
    db.prepare("DROP TABLE IF EXISTS players_login_bonus_progress_old").run()
    db.exec(`
        CREATE TABLE players_login_bonus_progress_old (
            player_id INTEGER NOT NULL,
            group_id TEXT NOT NULL,
            last_granted_index INTEGER NOT NULL,
            last_granted_business_day TEXT NOT NULL,
            received_at INTEGER NOT NULL,
            shown_at INTEGER NOT NULL
        );
    `)
    db.prepare(`
        INSERT INTO players_login_bonus_progress_old
        VALUES (?, 'normal_2022', 2, '2026-08-01', 100, 200)
    `).run(playerId)
    db.pragma("user_version = 3")

    updateAfterInit(db, 3)

    // v18 迁移必须照跑：旧表被清、数据并入新表
    const oldTableGone = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='players_login_bonus_progress_old'"
    ).get()
    assert.equal(oldTableGone, undefined, "v18 迁移不得被 v4 段缺表短路")
    const migrated = db.prepare(`
        SELECT last_granted_index FROM players_login_bonus_progress
        WHERE player_id = ? AND group_id = 'normal_2022'
    `).get(playerId)
    assert.equal(migrated?.last_granted_index, 2, "旧表数据必须并入新表")
})

test("account-dimension lookups use indexes on all three tables (F-12)", () => {
    for (const [table, where] of [
        ["players", "account_id = ?"],
        ["sessions", "account_id = ?"],
        ["device_bindings", "account_id = ?"],
    ]) {
        const plan = db.prepare(
            `EXPLAIN QUERY PLAN SELECT 1 FROM ${table} WHERE ${where}`
        ).all(1)
        const planText = plan.map(step => step.detail).join(" | ")
        assert.match(
            planText,
            /USING (COVERING )?INDEX idx_\w+account_id/,
            `${table} 按 account_id 查询必须走索引（实际计划：${planText}）`,
        )
    }
})
