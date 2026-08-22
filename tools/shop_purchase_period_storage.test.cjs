require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const BetterSqlite3 = require("better-sqlite3")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "shop-period-db-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory
let db
let sqlTrace = null

function databaseFactory(databasePath) {
    return new BetterSqlite3(databasePath, {
        verbose: statement => {
            if (sqlTrace !== null) sqlTrace.push(statement)
        },
    })
}

function captureSql(operation) {
    const statements = []
    sqlTrace = statements
    try {
        return { result: operation(), statements }
    } finally {
        sqlTrace = null
    }
}

function summarizePurchaseCountSql(statements) {
    return {
        selects: statements.filter(statement => /^\s*SELECT\b/i.test(statement)).length,
        upserts: statements.filter(statement => (
            /^\s*INSERT\s+INTO\s+players_shop_purchase_counters\b/i.test(statement)
        )).length,
        deletes: statements.filter(statement => /^\s*DELETE\b/i.test(statement)).length,
    }
}

function summarizeLegacyDeletes(statements) {
    return statements
        .filter(statement => /^\s*DELETE\b/i.test(statement))
        .map(statement => {
            if (/players_shop_purchase_counters/i.test(statement)) return "counter"
            if (/players_shop_purchases/i.test(statement)) return "purchase"
            return "unknown"
        })
}

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
    addPlayerShopPurchaseCountsByTypeFromSnapshotSync,
    addPlayerShopPurchaseCountsByTypeSync,
    getPlayerShopPurchaseCountSnapshotSync,
    getPlayerShopPurchaseCountsByTypeBulkSync,
    getPlayerShopPurchaseCountsByTypeSync,
    getShopPurchaseQueryKey,
} = require("../src/data/domains/shopPurchase")
const {
    executeGenericShopBatchPurchaseSync,
    executeGenericShopPurchaseSync,
    ShopStockError,
} = require("../src/lib/event-shop-purchase")

initializeDatabase({ databaseFactory })
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

const singleSql = captureSql(() => (
    addPlayerShopPurchaseCountsByTypeSync(playerId, 4, 300010, 1, first)
))
const bulkQueries = [300011, 300012].map(shopItemId => ({
    shopType: 4,
    shopItemId,
    keys: first,
}))
const bulkSql = captureSql(() => {
    const snapshots = getPlayerShopPurchaseCountsByTypeBulkSync(playerId, bulkQueries)
    for (const query of bulkQueries) {
        addPlayerShopPurchaseCountsByTypeFromSnapshotSync(
            playerId,
            query.shopType,
            query.shopItemId,
            1,
            query.keys,
            snapshots.get(getShopPurchaseQueryKey(query)),
        )
    }
})

db.prepare(`
    INSERT INTO players_shop_purchase_counters (
        player_id, shop_type, shop_item_id, period_type, period_key, count
    ) VALUES (?, -1, 300013, 'total', '', 3)
`).run(playerId)
const counterOnlySql = captureSql(() => (
    addPlayerShopPurchaseCountsByTypeSync(playerId, 4, 300013, 1, first)
))

db.prepare(`
    INSERT INTO players_shop_purchases (player_id, shop_item_id, count)
    VALUES (?, 300014, 4)
`).run(playerId)
const purchaseOnlySql = captureSql(() => (
    addPlayerShopPurchaseCountsByTypeSync(playerId, 4, 300014, 1, first)
))

db.prepare(`
    INSERT INTO players_shop_purchase_counters (
        player_id, shop_type, shop_item_id, period_type, period_key, count
    ) VALUES
        (?, 4, 300015, 'total', '', 2),
        (?, -1, 300015, 'total', '', 3)
`).run(playerId, playerId)
db.prepare(`
    INSERT INTO players_shop_purchases (player_id, shop_item_id, count)
    VALUES (?, 300015, 5)
`).run(playerId)
const overlappingSql = captureSql(() => (
    addPlayerShopPurchaseCountsByTypeSync(playerId, 4, 300015, 1, first)
))
const migratedAgainSql = captureSql(() => (
    addPlayerShopPurchaseCountsByTypeSync(playerId, 4, 300015, 1, first)
))

assert.deepEqual({
    single: summarizePurchaseCountSql(singleSql.statements),
    bulk: summarizePurchaseCountSql(bulkSql.statements),
    counterOnly: {
        counts: counterOnlySql.result,
        deletes: summarizeLegacyDeletes(counterOnlySql.statements),
    },
    purchaseOnly: {
        counts: purchaseOnlySql.result,
        deletes: summarizeLegacyDeletes(purchaseOnlySql.statements),
    },
    overlapping: {
        counts: overlappingSql.result,
        deletes: summarizeLegacyDeletes(overlappingSql.statements),
    },
    migratedAgain: {
        counts: migratedAgainSql.result,
        deletes: summarizeLegacyDeletes(migratedAgainSql.statements),
    },
}, {
    single: { selects: 2, upserts: 3, deletes: 0 },
    bulk: { selects: 2, upserts: 6, deletes: 0 },
    counterOnly: {
        counts: { daily: 1, monthly: 1, total: 4 },
        deletes: ["counter"],
    },
    purchaseOnly: {
        counts: { daily: 1, monthly: 1, total: 5 },
        deletes: ["purchase"],
    },
    overlapping: {
        counts: { daily: 1, monthly: 1, total: 8 },
        deletes: ["counter", "purchase"],
    },
    migratedAgain: {
        counts: { daily: 2, monthly: 2, total: 9 },
        deletes: [],
    },
}, "计数 snapshot 应消除固定成本并只迁移实际存在的 legacy 来源")

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
db = initializeDatabase({ databaseFactory })
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
db = initializeDatabase({ databaseFactory })
assert.equal(
    getPlayerShopPurchaseCountsByTypeSync(playerId, 7, 300002, first).total,
    0,
    "旧累计迁入一个商店类型后，重启不得再次导入并污染同 ID 商品",
)

const legacyBatchItemId = 300003
db.prepare(`
    INSERT INTO players_shop_purchases (player_id, shop_item_id, count)
    VALUES (?, ?, ?)
`).run(playerId, legacyBatchItemId, 3)
const batchItem = maxFrequency => ({
    costs: [],
    rewards: [],
    availableFrom: "2024-01-01 00:00:00",
    availableUntil: null,
    stock: -1,
    maxFrequency,
})
const batchDependencies = {
    transaction: operation => db.transaction(operation)(),
    getPlayer: id => ({
        id,
        vmoney: 0,
        freeMana: 0,
        freeVmoney: 0,
        bondToken: 0,
        expPool: 0,
    }),
    updatePlayer() {},
    getItem() { return 0 },
    setItem() {},
    getPurchaseCounts() {
        throw new Error("batch purchase must not use the individual count reader")
    },
    getPurchaseCountsBulk: getPlayerShopPurchaseCountsByTypeBulkSync,
    addPurchaseCountsFromSnapshot: addPlayerShopPurchaseCountsByTypeFromSnapshotSync,
    recordManaSpent() {},
    grantRewards(_id, _rewards, knownPlayerBefore) {
        return {
            rewardResult: {
                user_info: { free_mana: 0, free_vmoney: 0, exp_pool: 0 },
                character_list: [],
                joined_character_id_list: [],
                equipment_list: [],
                items: {},
            },
            playerAfter: knownPlayerBefore,
        }
    },
}
const legacyBatchInput = maxFrequency => ({
    playerId,
    shopType: 4,
    purchases: [{
        shopItemId: legacyBatchItemId,
        purchaseAmount: 1,
        shopItem: batchItem(maxFrequency),
    }],
    nowMs: Date.parse("2024-02-01T00:00:00Z"),
    enforcePeriod: true,
})

assert.throws(
    () => executeGenericShopBatchPurchaseSync(legacyBatchInput(3), batchDependencies),
    ShopStockError,
    "旧表累计必须参与批量购买库存校验",
)
const firstLegacyBatchResult = executeGenericShopBatchPurchaseSync(
    legacyBatchInput(5),
    batchDependencies,
)
assert.equal(firstLegacyBatchResult.purchaseCounts[legacyBatchItemId], 4)
assert.equal(db.prepare(`
    SELECT count FROM players_shop_purchases
    WHERE player_id = ? AND shop_item_id = ?
`).get(playerId, legacyBatchItemId), undefined, "首次原子增量后应删除旧表记录")
assert.equal(
    executeGenericShopBatchPurchaseSync(legacyBatchInput(5), batchDependencies)
        .purchaseCounts[legacyBatchItemId],
    5,
    "旧累计只能迁移一次，后续 total 只增加本次购买量",
)

const overlappingLegacyItemId = 300004
db.prepare(`
    INSERT INTO players_shop_purchase_counters (
        player_id, shop_type, shop_item_id, period_type, period_key, count
    ) VALUES
        (?, 4, ?, 'total', '', 2),
        (?, -1, ?, 'total', '', 3)
`).run(playerId, overlappingLegacyItemId, playerId, overlappingLegacyItemId)
db.prepare(`
    INSERT INTO players_shop_purchases (player_id, shop_item_id, count)
    VALUES (?, ?, 4)
`).run(playerId, overlappingLegacyItemId)

assert.equal(
    getPlayerShopPurchaseCountsByTypeSync(playerId, 4, overlappingLegacyItemId, first).total,
    6,
    "单品读取必须把 typed total 与两份 legacy 镜像的最大值合并",
)
const overlappingQuery = {
    shopType: 4,
    shopItemId: overlappingLegacyItemId,
    keys: first,
}
assert.equal(
    getPlayerShopPurchaseCountsByTypeBulkSync(playerId, [overlappingQuery])
        .get(getShopPurchaseQueryKey(overlappingQuery)).total,
    6,
    "批量预校验必须把 typed total 与两份 legacy 镜像的最大值合并",
)
const overlappingResult = executeGenericShopBatchPurchaseSync({
    playerId,
    shopType: 4,
    purchases: [{
        shopItemId: overlappingLegacyItemId,
        purchaseAmount: 1,
        shopItem: batchItem(7),
    }],
    nowMs: Date.parse("2024-02-01T00:00:00Z"),
    enforcePeriod: true,
}, batchDependencies)
assert.equal(overlappingResult.purchaseCounts[overlappingLegacyItemId], 7)
assert.equal(
    getPlayerShopPurchaseCountsByTypeSync(playerId, 4, overlappingLegacyItemId, first).total,
    7,
    "迁移后的单品读取必须保持最终总数",
)
assert.equal(db.prepare(`
    SELECT count FROM players_shop_purchase_counters
    WHERE player_id = ? AND shop_type = -1 AND shop_item_id = ?
      AND period_type = 'total' AND period_key = ''
`).get(playerId, overlappingLegacyItemId), undefined, "legacy -1 counter 应在首次写入时清理")
assert.equal(db.prepare(`
    SELECT count FROM players_shop_purchases
    WHERE player_id = ? AND shop_item_id = ?
`).get(playerId, overlappingLegacyItemId), undefined, "旧累计源记录应在首次写入时清理")

const reverseLegacyMirrorItemId = 300006
db.prepare(`
    INSERT INTO players_shop_purchase_counters (
        player_id, shop_type, shop_item_id, period_type, period_key, count
    ) VALUES (?, -1, ?, 'total', '', 5)
`).run(playerId, reverseLegacyMirrorItemId)
db.prepare(`
    INSERT INTO players_shop_purchases (player_id, shop_item_id, count)
    VALUES (?, ?, 4)
`).run(playerId, reverseLegacyMirrorItemId)
const reverseLegacyQuery = {
    shopType: 4,
    shopItemId: reverseLegacyMirrorItemId,
    keys: first,
}
assert.equal(
    getPlayerShopPurchaseCountsByTypeSync(playerId, 4, reverseLegacyMirrorItemId, first).total,
    5,
    "legacy counter 较大时必须取 counter，不能相加两份镜像",
)
assert.equal(
    getPlayerShopPurchaseCountsByTypeBulkSync(playerId, [reverseLegacyQuery])
        .get(getShopPurchaseQueryKey(reverseLegacyQuery)).total,
    5,
    "bulk reader 必须与单品 reader 使用同一 legacy 镜像规则",
)

const singleOverlappingItemId = 300005
db.prepare(`
    INSERT INTO players_shop_purchase_counters (
        player_id, shop_type, shop_item_id, period_type, period_key, count
    ) VALUES
        (?, 4, ?, 'total', '', 2),
        (?, -1, ?, 'total', '', 3)
`).run(playerId, singleOverlappingItemId, playerId, singleOverlappingItemId)
db.prepare(`
    INSERT INTO players_shop_purchases (player_id, shop_item_id, count)
    VALUES (?, ?, 3)
`).run(playerId, singleOverlappingItemId)
const singleResult = executeGenericShopPurchaseSync({
    playerId,
    shopType: 4,
    shopItemId: singleOverlappingItemId,
    purchaseAmount: 1,
    shopItem: batchItem(6),
    nowMs: Date.parse("2024-02-01T00:00:00Z"),
    enforcePeriod: true,
}, {
    ...batchDependencies,
    getPurchaseCounts: getPlayerShopPurchaseCountSnapshotSync,
    addPurchaseCounts: addPlayerShopPurchaseCountsByTypeFromSnapshotSync,
})
assert.equal(singleResult.purchaseCount, 6, "单品购买也必须保留交叠 legacy 累计")
assert.equal(db.prepare(`
    SELECT count FROM players_shop_purchase_counters
    WHERE player_id = ? AND shop_type = -1 AND shop_item_id = ?
      AND period_type = 'total' AND period_key = ''
`).get(playerId, singleOverlappingItemId), undefined)
assert.equal(db.prepare(`
    SELECT count FROM players_shop_purchases
    WHERE player_id = ? AND shop_item_id = ?
`).get(playerId, singleOverlappingItemId), undefined)

console.log("shop purchase period storage tests passed")
cleanup()
process.removeListener("exit", cleanup)
