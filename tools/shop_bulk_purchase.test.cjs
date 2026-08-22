const assert = require("node:assert/strict")
const Database = require("better-sqlite3")
const fs = require("node:fs")
const path = require("node:path")

require("ts-node/register/transpile-only")

const {
    ShopBalanceError,
    ShopStockError,
    calculateShopStockQuantity,
    executeGenericShopBatchPurchaseSync,
} = require("../src/lib/event-shop-purchase")
const {
    ShopItemRewardType,
    ShopItemUserCostType,
    ShopType,
} = require("../src/lib/types")

const eventShopPurchaseSource = fs.readFileSync(
    path.join(__dirname, "../src/lib/event-shop-purchase.ts"),
    "utf8",
)
assert.match(
    eventShopPurchaseSource,
    /interface GenericShopBatchPurchaseDependencies\s+extends Omit<\s*GenericShopPurchaseDependencies,\s*"getPurchaseCounts"\s*\|\s*"addPurchaseCounts"\s*>/,
    "batch dependencies must omit individual reads and the rereading add writer",
)
assert.doesNotMatch(
    eventShopPurchaseSource,
    /typeof getShopPurchaseQueryKey|getGenericShopPurchaseQueryKey/,
    "shop purchase query keys must use the required domain import without a fallback",
)
const batchImplementationSource = eventShopPurchaseSource.slice(
    eventShopPurchaseSource.indexOf("export function executeGenericShopBatchPurchaseSync"),
)
assert.equal(
    (batchImplementationSource.match(/dependencies\.getPurchaseCountsBulk\(/g) ?? []).length,
    1,
    "each non-empty batch must directly call the required bulk reader once",
)
assert.doesNotMatch(
    batchImplementationSource,
    /getPurchaseCountsBulk\s*\?\?/,
    "batch purchase must not keep an optional bulk-reader fallback",
)
assert.doesNotMatch(
    batchImplementationSource,
    /dependencies\.getPurchaseCounts\(/,
    "batch purchase must not call the individual purchase-count reader",
)
assert.equal(
    (batchImplementationSource.match(/dependencies\.addPurchaseCountsFromSnapshot\(/g) ?? []).length,
    1,
    "batch commits must use the snapshot-owned writer",
)
assert.doesNotMatch(
    batchImplementationSource,
    /dependencies\.addPurchaseCounts\(/,
    "batch commits must not use the rereading single-purchase writer",
)

function createHarness(itemBalance = 20) {
    const db = new Database(":memory:")
    db.exec(`
        CREATE TABLE player_state (
            id INTEGER PRIMARY KEY,
            free_mana INTEGER NOT NULL,
            free_vmoney INTEGER NOT NULL,
            bond_token INTEGER NOT NULL,
            exp_pool INTEGER NOT NULL
        );
        CREATE TABLE item_state (
            player_id INTEGER NOT NULL,
            item_id INTEGER NOT NULL,
            amount INTEGER NOT NULL,
            PRIMARY KEY (player_id, item_id)
        );
        CREATE TABLE purchase_state (
            player_id INTEGER NOT NULL,
            shop_type INTEGER NOT NULL,
            shop_item_id INTEGER NOT NULL,
            period_type TEXT NOT NULL,
            period_key TEXT NOT NULL,
            count INTEGER NOT NULL,
            PRIMARY KEY (player_id, shop_type, shop_item_id, period_type, period_key)
        );
        INSERT INTO player_state VALUES (7, 500, 20, 3, 0);
        INSERT INTO item_state VALUES (7, 10, ${itemBalance});
    `)

    let failGrant = false
    let manaSpent = 0
    let individualPurchaseCountReads = 0
    const bulkPurchaseCountRequests = []
    const purchaseCountAdds = []
    const getPlayer = playerId => {
        const row = db.prepare("SELECT * FROM player_state WHERE id = ?").get(playerId)
        return row === undefined ? null : {
            id: row.id,
            freeMana: row.free_mana,
            freeVmoney: row.free_vmoney,
            bondToken: row.bond_token,
            expPool: row.exp_pool,
        }
    }
    const getItem = (playerId, itemId) => db.prepare(
        "SELECT amount FROM item_state WHERE player_id = ? AND item_id = ?",
    ).get(playerId, itemId)?.amount ?? 0
    const readPurchaseCounts = (playerId, shopType, shopItemId, keys) => {
        const get = (periodType, periodKey) => db.prepare(`
            SELECT count FROM purchase_state
            WHERE player_id = ? AND shop_type = ? AND shop_item_id = ?
              AND period_type = ? AND period_key = ?
        `).get(playerId, shopType, shopItemId, periodType, periodKey)?.count ?? 0
        return {
            daily: get("daily", keys.daily),
            monthly: get("monthly", keys.monthly),
            total: get("total", ""),
        }
    }
    const addPurchaseCountsFromSnapshot = (
        playerId, shopType, shopItemId, amount, keys, currentCounts,
    ) => {
        purchaseCountAdds.push({ playerId, shopType, shopItemId, amount, keys, currentCounts })
        const finalCounts = {
            daily: currentCounts.daily + amount,
            monthly: currentCounts.monthly + amount,
            total: currentCounts.total + amount,
        }
        const set = (periodType, periodKey, count) => db.prepare(`
            INSERT INTO purchase_state VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(player_id, shop_type, shop_item_id, period_type, period_key)
            DO UPDATE SET count = excluded.count
        `).run(playerId, shopType, shopItemId, periodType, periodKey, count)
        set("daily", keys.daily, finalCounts.daily)
        set("monthly", keys.monthly, finalCounts.monthly)
        set("total", "", finalCounts.total)
        return finalCounts
    }

    return {
        db,
        dependencies: {
            transaction: operation => db.transaction(operation)(),
            getPlayer,
            updatePlayer(player) {
                db.prepare(`
                    UPDATE player_state
                    SET free_mana = ?, free_vmoney = ?, bond_token = ?, exp_pool = ?
                    WHERE id = ?
                `).run(player.freeMana, player.freeVmoney, player.bondToken, player.expPool, player.id)
            },
            getItem,
            setItem(playerId, itemId, amount) {
                db.prepare(`
                    INSERT INTO item_state VALUES (?, ?, ?)
                    ON CONFLICT(player_id, item_id) DO UPDATE SET amount = excluded.amount
                `).run(playerId, itemId, amount)
            },
            getPurchaseCounts() {
                individualPurchaseCountReads++
                throw new Error("batch prevalidation must not use individual purchase-count reads")
            },
            getPurchaseCountsBulk(playerId, queries) {
                bulkPurchaseCountRequests.push(queries)
                return new Map(queries.map(query => [
                    `${query.shopType}:${query.shopItemId}:${query.keys.daily}:${query.keys.monthly}`,
                    readPurchaseCounts(
                        playerId,
                        query.shopType,
                        query.shopItemId,
                        query.keys,
                    ),
                ]))
            },
            addPurchaseCountsFromSnapshot,
            recordManaSpent(_playerId, amount) { manaSpent += amount },
            grantRewards(playerId, rewards, knownPlayerBefore) {
                if (failGrant) throw new Error("injected reward failure")
                const items = {}
                for (const reward of rewards) {
                    if (reward.type !== 0) throw new Error("unexpected reward type")
                    const total = getItem(playerId, reward.id) + reward.count
                    this.setItem(playerId, reward.id, total)
                    items[String(reward.id)] = total
                }
                const rewardResult = {
                    user_info: { free_mana: 0, free_vmoney: 0, exp_pool: 0 },
                    character_list: [],
                    joined_character_id_list: [],
                    equipment_list: [],
                    items,
                }
                return {
                    rewardResult,
                    playerAfter: {
                        freeMana: knownPlayerBefore.freeMana,
                        freeVmoney: knownPlayerBefore.freeVmoney,
                        expPool: knownPlayerBefore.expPool,
                    },
                }
            },
        },
        getPlayer,
        getItem,
        getPurchaseCounts: readPurchaseCounts,
        getIndividualPurchaseCountReads: () => individualPurchaseCountReads,
        getBulkPurchaseCountRequests: () => bulkPurchaseCountRequests,
        getPurchaseCountAdds: () => purchaseCountAdds,
        getManaSpent: () => manaSpent,
        failGrant: () => { failGrant = true },
    }
}

const itemA = {
    costs: [{ id: 10, amount: 7 }],
    rewards: [{ type: ShopItemRewardType.ITEM, id: 20, count: 2 }],
    availableFrom: "2024-01-01 00:00:00",
    availableUntil: null,
    stock: 3,
    maxFrequency: 4,
    dailyStock: 2,
    monthlyStock: 3,
}
const itemB = {
    costs: [{ id: 10, amount: 5 }],
    rewards: [{ type: ShopItemRewardType.ITEM, id: 10, count: 100 }],
    userCost: { type: ShopItemUserCostType.MANA, amount: 100 },
    availableFrom: "2024-01-01 00:00:00",
    availableUntil: null,
    stock: 1,
}

assert.equal(calculateShopStockQuantity(itemA, { daily: 1, monthly: 1, total: 1 }), 1)
assert.equal(calculateShopStockQuantity(itemB, { daily: 0, monthly: 0, total: 0 }), -1)

{
    const harness = createHarness()
    const unlimitedItem = {
        costs: [],
        rewards: [],
        availableFrom: "2024-01-01 00:00:00",
        availableUntil: null,
        stock: -1,
    }
    executeGenericShopBatchPurchaseSync({
        playerId: 7,
        shopType: ShopType.EVENT_ITEM,
        purchases: [
            { shopItemId: 201, purchaseAmount: 1, shopItem: unlimitedItem },
            { shopItemId: 202, purchaseAmount: 1, shopItem: unlimitedItem },
        ],
        nowMs: Date.parse("2024-02-01T00:00:00Z"),
        enforcePeriod: true,
    }, harness.dependencies)

    assert.equal(
        harness.getBulkPurchaseCountRequests().length,
        1,
        "无库存限制的非空批次仍必须读取一次计数快照",
    )
    assert.equal(harness.getIndividualPurchaseCountReads(), 0)
    assert.deepEqual(
        harness.getBulkPurchaseCountRequests()[0].map(query => query.shopItemId),
        [201, 202],
    )
    harness.db.close()
}

{
    const harness = createHarness()
    const result = executeGenericShopBatchPurchaseSync({
        playerId: 7,
        shopType: ShopType.EVENT_ITEM,
        purchases: [
            { shopItemId: 101, purchaseAmount: 2, shopItem: itemA },
            { shopItemId: 102, purchaseAmount: 1, shopItem: itemB },
        ],
        nowMs: Date.parse("2024-02-01T00:00:00Z"),
        enforcePeriod: true,
    }, harness.dependencies)

    assert.equal(result.player.freeMana, 400)
    assert.equal(harness.getItem(7, 10), 101)
    assert.equal(harness.getItem(7, 20), 4)
    assert.deepEqual(result.itemList, { 10: 101, 20: 4 })
    assert.deepEqual(result.purchaseCounts, { 101: 2, 102: 1 })
    assert.equal(harness.getManaSpent(), 100)
    assert.equal(harness.getIndividualPurchaseCountReads(), 0)
    assert.equal(harness.getBulkPurchaseCountRequests().length, 1)
    assert.deepEqual(
        harness.getBulkPurchaseCountRequests()[0].map(query => [
            query.shopType,
            query.shopItemId,
            query.keys.daily,
            query.keys.monthly,
        ]),
        [
            [ShopType.EVENT_ITEM, 101, "2024-02-01", "2024-02"],
            [ShopType.EVENT_ITEM, 102, "2024-02-01", "2024-02"],
        ],
    )
    assert.equal(
        harness.getPurchaseCountAdds()[0].keys,
        harness.getBulkPurchaseCountRequests()[0][0].keys,
        "commit must reuse the period keys built for bulk prevalidation",
    )
    assert.equal(
        harness.getPurchaseCountAdds()[1].keys,
        harness.getBulkPurchaseCountRequests()[0][1].keys,
        "each batch entry must calculate period keys only once",
    )
    assert.deepEqual(harness.getPurchaseCountAdds().map(call => call.currentCounts), [
        { daily: 0, monthly: 0, total: 0 },
        { daily: 0, monthly: 0, total: 0 },
    ])
    harness.db.close()
}

{
    const harness = createHarness(10)
    assert.throws(() => executeGenericShopBatchPurchaseSync({
        playerId: 7,
        shopType: ShopType.EVENT_ITEM,
        purchases: [
            { shopItemId: 101, purchaseAmount: 1, shopItem: itemA },
            { shopItemId: 102, purchaseAmount: 1, shopItem: itemB },
        ],
        nowMs: Date.parse("2024-02-01T00:00:00Z"),
        enforcePeriod: true,
    }, harness.dependencies), ShopBalanceError)
    assert.equal(harness.getItem(7, 10), 10, "本批奖励不能支付本批成本")
    assert.equal(harness.getItem(7, 20), 0)
    assert.equal(harness.getPurchaseCounts(7, ShopType.EVENT_ITEM, 101, {
        daily: "2024-02-01", monthly: "2024-02",
    }).total, 0)
    assert.equal(harness.getPlayer(7).freeMana, 500)
    harness.db.close()
}

{
    const harness = createHarness()
    harness.failGrant()
    assert.throws(() => executeGenericShopBatchPurchaseSync({
        playerId: 7,
        shopType: ShopType.EVENT_ITEM,
        purchases: [{ shopItemId: 101, purchaseAmount: 1, shopItem: itemA }],
        nowMs: Date.parse("2024-02-01T00:00:00Z"),
        enforcePeriod: true,
    }, harness.dependencies), /injected reward failure/)
    assert.equal(harness.getItem(7, 10), 20)
    assert.equal(harness.getPurchaseCounts(7, ShopType.EVENT_ITEM, 101, {
        daily: "2024-02-01", monthly: "2024-02",
    }).total, 0)
    harness.db.close()
}

{
    const harness = createHarness(100)
    executeGenericShopBatchPurchaseSync({
        playerId: 7,
        shopType: ShopType.EVENT_ITEM,
        purchases: [{ shopItemId: 101, purchaseAmount: 2, shopItem: itemA }],
        nowMs: Date.parse("2024-02-01T00:00:00Z"),
        enforcePeriod: true,
    }, harness.dependencies)
    assert.throws(() => executeGenericShopBatchPurchaseSync({
        playerId: 7,
        shopType: ShopType.EVENT_ITEM,
        purchases: [{ shopItemId: 101, purchaseAmount: 1, shopItem: itemA }],
        nowMs: Date.parse("2024-02-01T01:00:00Z"),
        enforcePeriod: true,
    }, harness.dependencies), ShopStockError)
    executeGenericShopBatchPurchaseSync({
        playerId: 7,
        shopType: ShopType.EVENT_ITEM,
        purchases: [{ shopItemId: 101, purchaseAmount: 1, shopItem: itemA }],
        nowMs: Date.parse("2024-02-01T21:00:00Z"),
        enforcePeriod: true,
    }, harness.dependencies)
    assert.equal(harness.getPurchaseCounts(7, ShopType.EVENT_ITEM, 101, {
        daily: "2024-02-02", monthly: "2024-02",
    }).daily, 1)
    assert.equal(harness.getPurchaseCounts(7, ShopType.EVENT_ITEM, 101, {
        daily: "2024-02-02", monthly: "2024-02",
    }).monthly, 3)
    harness.db.close()
}

console.log("shop bulk purchase tests passed")
