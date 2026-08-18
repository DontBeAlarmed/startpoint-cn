require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "shop-period-db-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory
let db

function cleanup() {
    if (db?.open) db.close()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
}

process.once("exit", cleanup)

const { closeDatabase, initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const {
    addPlayerShopPurchaseCountsByTypeSync,
    getPlayerShopPurchaseCountsByTypeBulkSync,
    getPlayerShopPurchaseCountsByTypeSync,
    getShopPurchaseQueryKey,
} = require("../src/data/domains/shopPurchase")

initializeDatabase()
db = getDb()
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `shop-period-${Date.now()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
const first = { daily: "2024-02-01", monthly: "2024-02" }
const nextDay = { daily: "2024-02-02", monthly: "2024-02" }

assert.deepEqual(getPlayerShopPurchaseCountsByTypeSync(playerId, 4, 300001, first), {
    daily: 0,
    monthly: 0,
    total: 0,
})
assert.deepEqual(addPlayerShopPurchaseCountsByTypeSync(playerId, 4, 300001, 2, first), {
    daily: 2,
    monthly: 2,
    total: 2,
})
assert.deepEqual(getPlayerShopPurchaseCountsByTypeSync(playerId, 4, 300001, nextDay), {
    daily: 0,
    monthly: 2,
    total: 2,
})
assert.deepEqual(getPlayerShopPurchaseCountsByTypeSync(playerId, 7, 300001, first), {
    daily: 0,
    monthly: 0,
    total: 0,
}, "跨商店重名商品必须隔离")
const bulkCounts = getPlayerShopPurchaseCountsByTypeBulkSync(playerId, [
    { shopType: 4, shopItemId: 300001, keys: first },
    { shopType: 7, shopItemId: 300001, keys: first },
])
assert.deepEqual(bulkCounts.get(getShopPurchaseQueryKey({
    shopType: 4, shopItemId: 300001, keys: first,
})), { daily: 2, monthly: 2, total: 2 })
assert.deepEqual(bulkCounts.get(getShopPurchaseQueryKey({
    shopType: 7, shopItemId: 300001, keys: first,
})), { daily: 0, monthly: 0, total: 0 })

db.prepare(`
    INSERT INTO players_shop_purchases (player_id, shop_item_id, count)
    VALUES (?, ?, ?)
`).run(playerId, 300002, 3)
closeDatabase()
db = initializeDatabase()
assert.equal(
    getPlayerShopPurchaseCountsByTypeSync(playerId, 4, 300002, first).total,
    3,
    "升级前累计次数应在第一次使用时保留",
)
assert.equal(
    addPlayerShopPurchaseCountsByTypeSync(playerId, 4, 300002, 1, first).total,
    4,
)
closeDatabase()
db = initializeDatabase()
assert.equal(
    getPlayerShopPurchaseCountsByTypeSync(playerId, 7, 300002, first).total,
    0,
    "旧累计迁入一个商店类型后，重启不得再次导入并污染同 ID 商品",
)

console.log("shop purchase period storage tests passed")
cleanup()
process.removeListener("exit", cleanup)
