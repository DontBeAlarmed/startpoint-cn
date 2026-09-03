"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const BetterSqlite3 = require("better-sqlite3")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "shop-count-storage-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = dataDirectory
let trace = null

const data = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const {
    addPlayerShopPurchaseCountsByTypeFromSnapshotSync,
    getPlayerShopPurchaseCountSnapshotSync,
    getPlayerShopPurchaseCountsByTypeBulkSync,
} = require("../src/data/domains/shopPurchase")

let database
let playerId
const keys = { daily: "2026-09-04", monthly: "2026-09" }

function insertCounter(shopType, itemId, periodType, periodKey, count) {
    database.prepare(`
        INSERT INTO players_shop_purchase_counters (
            player_id, shop_type, shop_item_id, period_type, period_key, count
        ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(playerId, shopType, itemId, periodType, periodKey, count)
}

test.before(() => {
    database = data.initializeDatabase({
        databaseFactory: databasePath => new BetterSqlite3(databasePath, {
            verbose: statement => {
                if (trace !== null) trace.push(statement)
            },
        }),
    })
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `shop-count-${Date.now()}`,
        status: "normal",
    })
    playerId = insertDefaultPlayerSync(account.id).id
})

test.after(() => {
    data.closeDatabase()
    fs.rmSync(dataDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test("daily monthly total counts remain isolated by Shop type", () => {
    insertCounter(4, 100, "daily", keys.daily, 2)
    insertCounter(4, 100, "monthly", keys.monthly, 3)
    insertCounter(4, 100, "total", "", 4)
    insertCounter(7, 100, "total", "", 9)
    assert.deepEqual(getPlayerShopPurchaseCountSnapshotSync(playerId, 4, 100, keys), {
        daily: 2, monthly: 3, total: 4,
    })
    assert.deepEqual(getPlayerShopPurchaseCountSnapshotSync(playerId, 7, 100, keys), {
        daily: 0, monthly: 0, total: 9,
    })
})

test("first-touch merges duplicate legacy mirrors once and preserves opaque metadata", () => {
    database.prepare(`
        INSERT INTO players_shop_purchases (player_id, shop_item_id, count)
        VALUES (?, 101, 5)
    `).run(playerId)
    insertCounter(-1, 101, "total", "", 7)
    insertCounter(4, 101, "total", "", 3)
    const snapshot = getPlayerShopPurchaseCountSnapshotSync(playerId, 4, 101, keys)
    assert.equal(snapshot.total, 10, "typed total plus max of the two legacy mirrors")
    assert.throws(() => addPlayerShopPurchaseCountsByTypeFromSnapshotSync(
        playerId, 4, 101, 1, keys, { daily: 0, monthly: 0, total: 10 },
    ), /purchase count snapshot/i)
    const after = addPlayerShopPurchaseCountsByTypeFromSnapshotSync(
        playerId, 4, 101, 1, keys, snapshot,
    )
    assert.deepEqual(after, { daily: 1, monthly: 1, total: 11 })
    assert.equal(database.prepare(`
        SELECT 1 FROM players_shop_purchases WHERE player_id = ? AND shop_item_id = 101
    `).get(playerId), undefined)
    assert.equal(database.prepare(`
        SELECT 1 FROM players_shop_purchase_counters
        WHERE player_id = ? AND shop_type = -1 AND shop_item_id = 101
    `).get(playerId), undefined)
    assert.equal(getPlayerShopPurchaseCountSnapshotSync(playerId, 7, 101, keys).total, 0)
})

test("corrupt counts and safe-integer overflow fail before legacy deletion or writes", () => {
    insertCounter(4, 102, "total", "", "corrupt")
    assert.throws(
        () => getPlayerShopPurchaseCountSnapshotSync(playerId, 4, 102, keys),
        /non-negative safe integer/i,
    )

    database.prepare(`
        INSERT INTO players_shop_purchases (player_id, shop_item_id, count)
        VALUES (?, 103, 1)
    `).run(playerId)
    insertCounter(4, 103, "total", "", Number.MAX_SAFE_INTEGER - 1)
    const snapshot = getPlayerShopPurchaseCountSnapshotSync(playerId, 4, 103, keys)
    assert.throws(() => addPlayerShopPurchaseCountsByTypeFromSnapshotSync(
        playerId, 4, 103, 1, keys, snapshot,
    ), /safe integer range/i)
    assert.notEqual(database.prepare(`
        SELECT 1 FROM players_shop_purchases WHERE player_id = ? AND shop_item_id = 103
    `).get(playerId), undefined)
    assert.equal(database.prepare(`
        SELECT count FROM players_shop_purchase_counters
        WHERE player_id = ? AND shop_type = 4 AND shop_item_id = 103
          AND period_type = 'total' AND period_key = ''
    `).get(playerId).count, Number.MAX_SAFE_INTEGER - 1)
})

test("bulk reader uses two fixed indexed reads and equals single snapshots", () => {
    database.prepare(`
        WITH RECURSIVE unrelated(value) AS (
            VALUES (1) UNION ALL SELECT value + 1 FROM unrelated WHERE value < 1000
        )
        INSERT INTO players_shop_purchase_counters (
            player_id, shop_type, shop_item_id, period_type, period_key, count
        )
        SELECT ?, 20 + (value % 5), 400000 + value, 'total', '', value
        FROM unrelated
    `).run(playerId)
    const queries = [
        { shopType: 4, shopItemId: 100, keys },
        { shopType: 7, shopItemId: 100, keys },
    ]
    const statements = []
    trace = statements
    const bulk = getPlayerShopPurchaseCountsByTypeBulkSync(playerId, queries)
    trace = null
    assert.equal(statements.filter(statement => /CROSS JOIN players_shop_purchase_counters/i.test(statement)).length, 1)
    assert.equal(statements.filter(statement => /CROSS JOIN players_shop_purchases/i.test(statement)).length, 1)
    for (const query of queries) {
        const key = `${query.shopType}:${query.shopItemId}:${keys.daily}:${keys.monthly}`
        assert.deepEqual(bulk.get(key), getPlayerShopPurchaseCountSnapshotSync(
            playerId, query.shopType, query.shopItemId, keys,
        ))
    }

    const counterSql = statements.find(statement => (
        /CROSS JOIN players_shop_purchase_counters/i.test(statement)
    ))
    const legacySql = statements.find(statement => (
        /CROSS JOIN players_shop_purchases/i.test(statement)
    ))
    assert.notEqual(counterSql, undefined)
    assert.notEqual(legacySql, undefined)
    const counterPlan = database.prepare(`EXPLAIN QUERY PLAN ${counterSql}`)
        .all().map(row => row.detail).join("\n")
    const legacyPlan = database.prepare(`EXPLAIN QUERY PLAN ${legacySql}`)
        .all().map(row => row.detail).join("\n")
    assert.match(counterPlan, /player_id=.*shop_type=.*shop_item_id=.*period_type=.*period_key=/i)
    assert.match(legacyPlan, /player_id=.*shop_item_id=/i)
})
