require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const BetterSqlite3 = require("better-sqlite3")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "shop-snapshot-db-"))
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

function captureSqlFailure(operation) {
    const statements = []
    sqlTrace = statements
    let error = null
    try {
        operation()
    } catch (caught) {
        error = caught
    } finally {
        sqlTrace = null
    }
    return { error, statements }
}

function collectCheck(failures, label, operation) {
    try {
        operation()
    } catch (error) {
        failures.push(`${label}: ${error.stack ?? error}`)
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

function cleanup() {
    if (db?.open) db.close()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
}

process.once("exit", cleanup)

const { initializeDatabase } = require("../src/data")
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
const { executeGenericShopPurchaseSync } = require("../src/lib/event-shop-purchase")

initializeDatabase({ databaseFactory })
db = getDb()
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `shop-snapshot-${Date.now()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
const keys = { daily: "2024-02-01", monthly: "2024-02" }

const completeSinglePurchaseSql = captureSql(() => executeGenericShopPurchaseSync({
    playerId,
    shopType: 4,
    shopItemId: 300027,
    purchaseAmount: 1,
    shopItem: {
        costs: [],
        rewards: [],
        availableFrom: "2024-01-01 00:00:00",
        availableUntil: null,
        stock: -1,
    },
    nowMs: Date.parse("2024-02-01T00:00:00Z"),
    enforcePeriod: true,
}, {
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
    getPurchaseCounts: getPlayerShopPurchaseCountSnapshotSync,
    addPurchaseCounts: addPlayerShopPurchaseCountsByTypeFromSnapshotSync,
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
}))
assert.equal(completeSinglePurchaseSql.result.purchaseCount, 1)
assert.deepEqual(summarizePurchaseCountSql(completeSinglePurchaseSql.statements), {
    selects: 2,
    upserts: 3,
    deletes: 0,
}, "完整单购计数链必须复用库存校验 snapshot")

db.prepare(`
    WITH RECURSIVE unrelated(value) AS (
        VALUES (1)
        UNION ALL
        SELECT value + 1 FROM unrelated WHERE value < 1000
    )
    INSERT INTO players_shop_purchase_counters (
        player_id, shop_type, shop_item_id, period_type, period_key, count
    )
    SELECT ?, 20 + (value % 5), 400000 + value, 'total', '', value
    FROM unrelated
`).run(playerId)
const plannedRead = captureSql(() => (
    getPlayerShopPurchaseCountsByTypeSync(playerId, 4, 300020, keys)
))
const plannedCountersSelect = plannedRead.statements.find(statement => (
    /^\s*SELECT\s+shop_type,\s*period_type,\s*period_key,\s*count\b/i.test(statement)
))
assert.notEqual(plannedCountersSelect, undefined, "必须捕获生产 snapshot counters 查询")
const snapshotQueryPlan = db.prepare(
    `EXPLAIN QUERY PLAN ${plannedCountersSelect}`,
).all().map(row => row.detail)
console.log(`shop purchase snapshot query plan: ${snapshotQueryPlan.join(" | ")}`)

const failures = []
collectCheck(failures, "snapshot counters 查询计划", () => {
    assert.match(
        snapshotQueryPlan.join("\n"),
        /\(player_id=\? AND shop_type=\? AND shop_item_id=\?/,
        `查询计划必须按 player/shop/item 定位，实际为 ${snapshotQueryPlan.join(" | ")}`,
    )
})

const bulkItemId = 300030
const secondBulkItemId = 300031
const bulkQueries = [
    { shopType: 4, shopItemId: bulkItemId, keys },
    { shopType: 4, shopItemId: bulkItemId, keys },
    {
        shopType: 4,
        shopItemId: bulkItemId,
        keys: { daily: "2024-01-31", monthly: "2024-01" },
    },
    { shopType: 5, shopItemId: bulkItemId, keys },
    { shopType: 4, shopItemId: secondBulkItemId, keys },
]
db.prepare(`
    INSERT INTO players_shop_purchase_counters (
        player_id, shop_type, shop_item_id, period_type, period_key, count
    ) VALUES
        (?, 4, ?, 'daily', '2024-02-01', 2),
        (?, 4, ?, 'daily', '2024-01-31', 3),
        (?, 4, ?, 'monthly', '2024-02', 5),
        (?, 4, ?, 'monthly', '2024-01', 7),
        (?, 4, ?, 'total', '', 11),
        (?, 5, ?, 'daily', '2024-02-01', 13),
        (?, 5, ?, 'monthly', '2024-02', 17),
        (?, 5, ?, 'total', '', 19),
        (?, -1, ?, 'total', '', 23),
        (?, 4, ?, 'daily', '2024-02-01', 29),
        (?, 4, ?, 'monthly', '2024-02', 31),
        (?, 4, ?, 'total', '', 37),
        (?, -1, ?, 'total', '', 41),
        (?, 4, ?, 'daily', '1999-12-31', 1000),
        (?, 4, ?, 'monthly', '1999-12', 1000),
        (?, 6, ?, 'total', '', 1000)
`).run(
    playerId, bulkItemId,
    playerId, bulkItemId,
    playerId, bulkItemId,
    playerId, bulkItemId,
    playerId, bulkItemId,
    playerId, bulkItemId,
    playerId, bulkItemId,
    playerId, bulkItemId,
    playerId, bulkItemId,
    playerId, secondBulkItemId,
    playerId, secondBulkItemId,
    playerId, secondBulkItemId,
    playerId, secondBulkItemId,
    playerId, bulkItemId,
    playerId, bulkItemId,
    playerId, bulkItemId,
)
db.prepare(`
    INSERT INTO players_shop_purchases (player_id, shop_item_id, count)
    VALUES (?, ?, 43), (?, ?, 47)
`).run(playerId, bulkItemId, playerId, secondBulkItemId)
db.prepare(`
    WITH RECURSIVE unrelated(value) AS (
        VALUES (1)
        UNION ALL
        SELECT value + 1 FROM unrelated WHERE value < 1000
    )
    INSERT INTO players_shop_purchases (player_id, shop_item_id, count)
    SELECT ?, 500000 + value, value
    FROM unrelated
`).run(playerId)

const emptyBulkRead = captureSql(() => getPlayerShopPurchaseCountsByTypeBulkSync(playerId, []))
collectCheck(failures, "空 bulk query", () => {
    assert.equal(emptyBulkRead.result.size, 0)
    assert.deepEqual(emptyBulkRead.statements, [])
})

const bulkRead = captureSql(() => (
    getPlayerShopPurchaseCountsByTypeBulkSync(playerId, bulkQueries)
))
const bulkTableReads = bulkRead.statements.filter(statement => (
    /\b(?:FROM|JOIN)\s+players_shop_purchase(?:_counters|s)\b/i.test(statement)
))
const bulkCountersSelect = bulkTableReads.find(statement => (
    /\b(?:FROM|JOIN)\s+players_shop_purchase_counters\b/i.test(statement)
))
const bulkLegacySelect = bulkTableReads.find(statement => (
    /\b(?:FROM|JOIN)\s+players_shop_purchases\b/i.test(statement)
))
assert.notEqual(bulkCountersSelect, undefined, "必须捕获 bulk counters 查询")
assert.notEqual(bulkLegacySelect, undefined, "必须捕获 bulk legacy 查询")
const bulkCountersPlan = db.prepare(`EXPLAIN QUERY PLAN ${bulkCountersSelect}`).all()
    .map(row => row.detail)
const bulkLegacyPlan = db.prepare(`EXPLAIN QUERY PLAN ${bulkLegacySelect}`).all()
    .map(row => row.detail)
console.log(`shop purchase bulk counters query plan: ${bulkCountersPlan.join(" | ")}`)
console.log(`shop purchase bulk legacy query plan: ${bulkLegacyPlan.join(" | ")}`)

collectCheck(failures, "bulk 精确范围与结果", () => {
    assert.equal(bulkRead.statements.length, 2, bulkRead.statements.join("\n---\n"))
    assert.equal(bulkTableReads.length, 2, bulkRead.statements.join("\n---\n"))
    assert.match(
        bulkCountersPlan.join("\n"),
        /\(player_id=\? AND shop_type=\? AND shop_item_id=\? AND period_type=\? AND period_key=\?\)/,
        `counters 查询必须按完整目标键定位，实际为 ${bulkCountersPlan.join(" | ")}`,
    )
    assert.match(
        bulkLegacyPlan.join("\n"),
        /\(player_id=\? AND shop_item_id=\?\)/,
        `legacy 查询必须按目标 item 定位，实际为 ${bulkLegacyPlan.join(" | ")}`,
    )
    assert.equal(bulkRead.result.size, 4, "重复 query 必须折叠为同一 snapshot key")
    assert.deepEqual(
        bulkRead.result.get(getShopPurchaseQueryKey(bulkQueries[0])),
        { daily: 2, monthly: 5, total: 54 },
    )
    assert.deepEqual(
        bulkRead.result.get(getShopPurchaseQueryKey(bulkQueries[2])),
        { daily: 3, monthly: 7, total: 54 },
    )
    assert.deepEqual(
        bulkRead.result.get(getShopPurchaseQueryKey(bulkQueries[3])),
        { daily: 13, monthly: 17, total: 62 },
    )
    assert.deepEqual(
        bulkRead.result.get(getShopPurchaseQueryKey(bulkQueries[4])),
        { daily: 29, monthly: 31, total: 84 },
    )
})

const plainCountsItemId = 300021
db.prepare(`
    INSERT INTO players_shop_purchase_counters (
        player_id, shop_type, shop_item_id, period_type, period_key, count
    ) VALUES
        (?, 4, ?, 'total', '', 2),
        (?, -1, ?, 'total', '', 3)
`).run(playerId, plainCountsItemId, playerId, plainCountsItemId)
db.prepare(`
    INSERT INTO players_shop_purchases (player_id, shop_item_id, count)
    VALUES (?, ?, 4)
`).run(playerId, plainCountsItemId)
const plainCounts = getPlayerShopPurchaseCountsByTypeSync(playerId, 4, plainCountsItemId, keys)
const plainCountsRowsBefore = {
    counters: db.prepare(`
        SELECT shop_type, period_type, period_key, count
        FROM players_shop_purchase_counters
        WHERE player_id = ? AND shop_item_id = ?
        ORDER BY shop_type, period_type, period_key
    `).all(playerId, plainCountsItemId),
    purchase: db.prepare(`
        SELECT count FROM players_shop_purchases
        WHERE player_id = ? AND shop_item_id = ?
    `).get(playerId, plainCountsItemId),
}
const plainSnapshotWrite = captureSqlFailure(() => (
    addPlayerShopPurchaseCountsByTypeFromSnapshotSync(
        playerId, 4, plainCountsItemId, 1, keys, plainCounts,
    )
))
collectCheck(failures, "普通 counts 冒充 snapshot", () => {
    assert.match(plainSnapshotWrite.error?.message ?? "", /snapshot/i)
    assert.deepEqual(summarizePurchaseCountSql(plainSnapshotWrite.statements), {
        selects: 0,
        upserts: 0,
        deletes: 0,
    })
    assert.deepEqual({
        counters: db.prepare(`
            SELECT shop_type, period_type, period_key, count
            FROM players_shop_purchase_counters
            WHERE player_id = ? AND shop_item_id = ?
            ORDER BY shop_type, period_type, period_key
        `).all(playerId, plainCountsItemId),
        purchase: db.prepare(`
            SELECT count FROM players_shop_purchases
            WHERE player_id = ? AND shop_item_id = ?
        `).get(playerId, plainCountsItemId),
    }, plainCountsRowsBefore, "拒绝普通 counts 时必须零写入")
})

const overflowItemId = 300022
db.prepare(`
    INSERT INTO players_shop_purchase_counters (
        player_id, shop_type, shop_item_id, period_type, period_key, count
    ) VALUES
        (?, 4, ?, 'total', '', ?),
        (?, -1, ?, 'total', '', 2)
`).run(
    playerId, overflowItemId, Number.MAX_SAFE_INTEGER,
    playerId, overflowItemId,
)
const overflowWrite = captureSqlFailure(() => (
    addPlayerShopPurchaseCountsByTypeSync(playerId, 4, overflowItemId, 1, keys)
))
collectCheck(failures, "typed 与 legacy 合并溢出", () => {
    assert.match(overflowWrite.error?.message ?? "", /safe integer|overflow/i)
    assert.deepEqual(summarizePurchaseCountSql(overflowWrite.statements), {
        selects: 2,
        upserts: 0,
        deletes: 0,
    }, "snapshot 构造溢出必须零写入")
})

for (const [label, shopItemId, count] of [
    ["文本", 300023, "broken"],
    ["负数", 300024, -1],
    ["非整数", 300025, 1.5],
]) {
    db.prepare(`
        INSERT INTO players_shop_purchase_counters (
            player_id, shop_type, shop_item_id, period_type, period_key, count
        ) VALUES (?, 4, ?, 'daily', ?, ?)
    `).run(playerId, shopItemId, keys.daily, count)
    const corruptValueWrite = captureSqlFailure(() => (
        addPlayerShopPurchaseCountsByTypeSync(playerId, 4, shopItemId, 1, keys)
    ))
    collectCheck(failures, `数据库${label}计数`, () => {
        assert.match(corruptValueWrite.error?.message ?? "", /non-negative safe integer/i)
        assert.deepEqual(summarizePurchaseCountSql(corruptValueWrite.statements), {
            selects: 2,
            upserts: 0,
            deletes: 0,
        }, `数据库${label}计数必须零写入`)
    })
}

const writerOverflowItemId = 300026
db.prepare(`
    INSERT INTO players_shop_purchase_counters (
        player_id, shop_type, shop_item_id, period_type, period_key, count
    ) VALUES
        (?, 4, ?, 'total', '', 1),
        (?, -1, ?, 'total', '', 2)
`).run(playerId, writerOverflowItemId, playerId, writerOverflowItemId)
db.prepare(`
    INSERT INTO players_shop_purchases (player_id, shop_item_id, count)
    VALUES (?, ?, 3)
`).run(playerId, writerOverflowItemId)
const writerOverflowQuery = {
    shopType: 4,
    shopItemId: writerOverflowItemId,
    keys,
}
const writerOverflowSnapshot = getPlayerShopPurchaseCountsByTypeBulkSync(
    playerId, [writerOverflowQuery],
).get(getShopPurchaseQueryKey(writerOverflowQuery))
writerOverflowSnapshot.total = Number.MAX_SAFE_INTEGER
const writerOverflow = captureSqlFailure(() => (
    addPlayerShopPurchaseCountsByTypeFromSnapshotSync(
        playerId, 4, writerOverflowItemId, 2, keys, writerOverflowSnapshot,
    )
))
collectCheck(failures, "snapshot writer 相加溢出", () => {
    assert.match(writerOverflow.error?.message ?? "", /safe integer|overflow/i)
    assert.deepEqual(summarizePurchaseCountSql(writerOverflow.statements), {
        selects: 0,
        upserts: 0,
        deletes: 0,
    }, "溢出必须在 legacy DELETE 前失败")
    assert.equal(db.prepare(`
        SELECT count FROM players_shop_purchase_counters
        WHERE player_id = ? AND shop_type = -1 AND shop_item_id = ?
          AND period_type = 'total' AND period_key = ''
    `).get(playerId, writerOverflowItemId)?.count, 2)
    assert.equal(db.prepare(`
        SELECT count FROM players_shop_purchases
        WHERE player_id = ? AND shop_item_id = ?
    `).get(playerId, writerOverflowItemId)?.count, 3)
})

assert.equal(failures.length, 0, failures.join("\n\n"))
console.log("shop purchase snapshot contract tests passed")
cleanup()
process.removeListener("exit", cleanup)
