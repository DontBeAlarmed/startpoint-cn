"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-collected-batch-db-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

const { initializeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const itemDomain = require("../src/data/domains/item")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { getDb } = require("../src/data/db")

initializeDatabase()
const db = getDb()

test.after(() => {
    if (db.open) db.close()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
})

test("selected collected item IDs use one parameterized SQL query", () => {
    assert.equal(typeof itemDomain.getPlayerCollectedItemTotalsByIdsSync, "function")
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `mission-collected-batch-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    db.prepare(`
        INSERT INTO players_collected_items (player_id, item_id, total_obtained)
        VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)
    `).run(playerId, 11, 5, playerId, 22, 7, playerId, 33, 9)

    const sql = []
    const originalPrepare = db.prepare.bind(db)
    db.prepare = statement => {
        sql.push(String(statement))
        return originalPrepare(statement)
    }
    try {
        assert.deepEqual(
            itemDomain.getPlayerCollectedItemTotalsByIdsSync(playerId, [33, 11, 44]),
            { 11: 5, 33: 9 },
        )
    } finally {
        db.prepare = originalPrepare
    }

    assert.equal(sql.length, 1)
    assert.match(sql[0], /item_id\s+IN\s*\(\s*\?\s*,\s*\?\s*,\s*\?\s*\)/i)
    assert.doesNotMatch(sql[0], /item_id\s*=\s*\?/i)
})

test("legacy Regular state reads only the configured craft-point item", () => {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `mission-regular-craft-point-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    db.prepare(`
        INSERT INTO players_collected_items (player_id, item_id, total_obtained)
        VALUES (?, ?, ?), (?, ?, ?)
    `).run(playerId, 100000, 13, playerId, 999999, 99)

    const collectedSql = []
    const originalPrepare = db.prepare.bind(db)
    db.prepare = statement => {
        if (/players_collected_items/i.test(String(statement))) {
            collectedSql.push(String(statement))
        }
        return originalPrepare(statement)
    }
    let facts
    try {
        const { getRegularStateFactsSync } = require("../src/lib/mission/regular-state-facts")
        facts = getRegularStateFactsSync(playerId)
    } finally {
        db.prepare = originalPrepare
    }

    assert.equal(facts.craftPointObtainedCount, 13)
    assert.equal(collectedSql.length, 1)
    assert.match(collectedSql[0], /item_id\s+(?:=\s*\?|IN\s*\(\s*\?\s*\))/i)
})
