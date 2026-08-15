"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-shop-fact-db-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const playerDomain = require("../src/data/domains/player")
const shopDomain = require("../src/data/domains/shopPurchase")

initializeDatabase()
const db = getDb()
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `mission-shop-fact-${randomUUID()}`,
    status: "normal",
})
const playerId = playerDomain.insertDefaultPlayerSync(account.id).id

const insertCounter = db.prepare(`
    INSERT INTO players_shop_purchase_counters (
        player_id, shop_type, shop_item_id, period_type, period_key, count
    ) VALUES (?, ?, ?, 'total', '', ?)
`)
insertCounter.run(playerId, 2, 501, 3)
insertCounter.run(playerId, -1, 501, 11)
insertCounter.run(playerId, -1, 502, 7)
insertCounter.run(playerId, 3, 503, 5)

const calls = []
const originalGetPlayerShopPurchasesMapSync = shopDomain.getPlayerShopPurchasesMapSync
shopDomain.getPlayerShopPurchasesMapSync = (...args) => {
    calls.push(args)
    return originalGetPlayerShopPurchasesMapSync(...args)
}

const {
    createProductionMissionFactLoaderRegistry,
} = require("../src/lib/mission/production-fact-loaders")
const { createSession } = require("./helpers/mission-evaluation-session-fixture.cjs")

test.after(() => {
    shopDomain.getPlayerShopPurchasesMapSync = originalGetPlayerShopPurchasesMapSync
    if (db.open) db.close()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
})

test("production shop purchase fact preserves exact-shop priority and legacy fallback", () => {
    const session = createSession(
        [{ kind: "shopPurchases", shopType: 2 }],
        createProductionMissionFactLoaderRegistry(),
        { playerId },
    )

    assert.equal(calls.length, 0)
    const purchases = session.getFact({ kind: "shopPurchases", shopType: 2 })
    assert.deepEqual(purchases, { 501: 3, 502: 7 })
    assert.strictEqual(
        session.getFact({ kind: "shopPurchases", shopType: 2 }),
        purchases,
    )
    assert.deepEqual(calls, [[playerId, 2]])
})
