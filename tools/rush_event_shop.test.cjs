const assert = require("node:assert/strict")
const Database = require("better-sqlite3")

require("ts-node/register/transpile-only")

const {
    getEventShopItemsSync,
    getRushEventFolderClearRewards,
} = require("../src/lib/assets.ts")

const primaryShopCounts = new Map([
    [700001, 33],
    [700002, 31],
    [700003, 29],
    [700004, 29],
    [700005, 29],
    [700006, 29],
    [700007, 29],
])

for (const [eventId, expectedCount] of primaryShopCounts) {
    const items = getEventShopItemsSync(11, eventId)
    assert.notEqual(items, null, `原始活动批次 ${eventId} 必须存在活动商店`)
    assert.equal(
        Object.keys(items).length,
        expectedCount,
        `原始活动批次 ${eventId} 商品数量必须与 CN 主数据一致`,
    )
}

assert.equal(
    getEventShopItemsSync(6, 700001),
    null,
    "客户端枚举下标 6 不能冒充服务端 event_type=11",
)

for (let eventId = 700011; eventId <= 700017; eventId++) {
    assert.equal(
        getEventShopItemsSync(11, eventId),
        null,
        `常驻狂热激战 ${eventId} 必须严格返回空商店，不能共享原始批次库存`,
    )
    assert.equal(
        getRushEventFolderClearRewards(eventId, 1),
        null,
        `常驻狂热激战 ${eventId} 不得共享原始批次文件夹代币奖励`,
    )
}

const {
    InvalidShopPurchaseAmountError,
    ShopBalanceError,
    ShopPeriodError,
    ShopStockError,
    executeGenericShopPurchaseSync,
    isShopItemAvailable,
    parseShopJstTimestamp,
    validateShopPurchaseAmount,
} = require("../src/lib/event-shop-purchase.ts")

for (const invalidAmount of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1", null]) {
    assert.throws(
        () => validateShopPurchaseAmount(invalidAmount),
        InvalidShopPurchaseAmountError,
        `购买数量 ${String(invalidAmount)} 必须被拒绝`,
    )
}
assert.equal(validateShopPurchaseAmount(1), 1)

const periodItem = {
    costs: [],
    rewards: [],
    availableFrom: "2023-11-23 12:00:00",
    availableUntil: "2023-12-18 11:59:59",
    stock: 1,
}
const periodStart = parseShopJstTimestamp(periodItem.availableFrom)
const periodEnd = parseShopJstTimestamp(periodItem.availableUntil)
assert.equal(periodStart, Date.parse("2023-11-23T12:00:00+09:00"))
assert.equal(isShopItemAvailable(periodItem, periodStart - 1), false)
assert.equal(isShopItemAvailable(periodItem, periodStart), true, "开放起点必须包含")
assert.equal(isShopItemAvailable(periodItem, periodEnd), true, "开放终点必须包含")
assert.equal(isShopItemAvailable(periodItem, periodEnd + 1), false)

function createPurchaseHarness(options = {}) {
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
            shop_item_id INTEGER NOT NULL,
            count INTEGER NOT NULL,
            PRIMARY KEY (player_id, shop_item_id)
        );
        INSERT INTO player_state VALUES (17, 1000, 100, 20, 50);
        INSERT INTO item_state VALUES (17, 2370001, 1000);
        INSERT INTO item_state VALUES (17, 49100, 3);
    `)

    const maybeFail = phase => {
        if (options.failAt === phase) throw new Error(`injected ${phase} failure`)
    }
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

    const dependencies = {
        transaction: operation => db.transaction(operation)(),
        getPlayer,
        updatePlayer(player) {
            db.prepare(`
                UPDATE player_state
                SET free_mana = ?, free_vmoney = ?, bond_token = ?, exp_pool = ?
                WHERE id = ?
            `).run(player.freeMana, player.freeVmoney, player.bondToken, player.expPool, player.id)
            maybeFail("cost")
        },
        getItem,
        setItem(playerId, itemId, amount) {
            db.prepare(`
                INSERT INTO item_state VALUES (?, ?, ?)
                ON CONFLICT(player_id, item_id) DO UPDATE SET amount = excluded.amount
            `).run(playerId, itemId, amount)
            maybeFail("cost")
        },
        getPurchaseCount(playerId, shopItemId) {
            return db.prepare(
                "SELECT count FROM purchase_state WHERE player_id = ? AND shop_item_id = ?",
            ).get(playerId, shopItemId)?.count ?? 0
        },
        addPurchaseCount(playerId, shopItemId, amount) {
            db.prepare(`
                INSERT INTO purchase_state VALUES (?, ?, ?)
                ON CONFLICT(player_id, shop_item_id) DO UPDATE SET count = count + excluded.count
            `).run(playerId, shopItemId, amount)
            maybeFail("purchase")
            return this.getPurchaseCount(playerId, shopItemId)
        },
        grantRewards(playerId, rewards) {
            const items = {}
            let mana = 0
            let expPool = 0
            for (const reward of rewards) {
                if (reward.type === 0) {
                    const amount = getItem(playerId, reward.id) + reward.count
                    db.prepare(`
                        INSERT INTO item_state VALUES (?, ?, ?)
                        ON CONFLICT(player_id, item_id) DO UPDATE SET amount = excluded.amount
                    `).run(playerId, reward.id, amount)
                    items[String(reward.id)] = amount
                } else if (reward.type === 4) {
                    db.prepare("UPDATE player_state SET free_mana = free_mana + ? WHERE id = ?")
                        .run(reward.count, playerId)
                    mana += reward.count
                } else if (reward.type === 5) {
                    db.prepare("UPDATE player_state SET exp_pool = exp_pool + ? WHERE id = ?")
                        .run(reward.count, playerId)
                    expPool += reward.count
                }
            }
            maybeFail("reward")
            return {
                user_info: { free_mana: mana, free_vmoney: 0, exp_pool: expPool },
                character_list: [],
                joined_character_id_list: [],
                equipment_list: [],
                items,
            }
        },
    }

    return {
        db,
        dependencies,
        snapshot() {
            return {
                player: db.prepare("SELECT * FROM player_state ORDER BY id").all(),
                items: db.prepare("SELECT * FROM item_state ORDER BY item_id").all(),
                purchases: db.prepare("SELECT * FROM purchase_state ORDER BY shop_item_id").all(),
            }
        },
    }
}

const shopItem = {
    costs: [{ id: 2370001, amount: 100 }],
    rewards: [
        { type: 0, id: 49100, count: 2 },
        { type: 2, count: 300 },
    ],
    availableFrom: "2023-11-23 12:00:00",
    availableUntil: "2023-12-18 11:59:59",
    stock: 3,
}
const activeTime = parseShopJstTimestamp("2023-12-01 00:00:00")

{
    const harness = createPurchaseHarness()
    const result = executeGenericShopPurchaseSync({
        playerId: 17,
        shopItemId: 700000,
        purchaseAmount: 2,
        shopItem,
        nowMs: activeTime,
        enforcePeriod: true,
    }, harness.dependencies)
    assert.equal(harness.dependencies.getItem(17, 2370001), 800)
    assert.equal(harness.dependencies.getItem(17, 49100), 7)
    assert.equal(result.player.freeMana, 1600)
    assert.equal(result.purchaseCount, 2)
    assert.deepEqual(result.itemList, { "2370001": 800, "49100": 7 })

    executeGenericShopPurchaseSync({
        playerId: 17,
        shopItemId: 700000,
        purchaseAmount: 1,
        shopItem,
        nowMs: activeTime,
        enforcePeriod: true,
    }, harness.dependencies)
    assert.equal(harness.dependencies.getPurchaseCount(17, 700000), 3)
}

{
    const harness = createPurchaseHarness()
    const before = harness.snapshot()
    assert.throws(() => executeGenericShopPurchaseSync({
        playerId: 17,
        shopItemId: 700000,
        purchaseAmount: 1,
        shopItem,
        nowMs: periodEnd + 1,
        enforcePeriod: true,
    }, harness.dependencies), ShopPeriodError)
    assert.deepEqual(harness.snapshot(), before)
}

{
    const harness = createPurchaseHarness()
    harness.db.prepare("INSERT INTO purchase_state VALUES (17, 700000, 3)").run()
    const before = harness.snapshot()
    assert.throws(() => executeGenericShopPurchaseSync({
        playerId: 17,
        shopItemId: 700000,
        purchaseAmount: 1,
        shopItem,
        nowMs: activeTime,
        enforcePeriod: true,
    }, harness.dependencies), ShopStockError)
    assert.deepEqual(harness.snapshot(), before)
}

{
    const harness = createPurchaseHarness()
    harness.db.prepare("UPDATE item_state SET amount = 99 WHERE item_id = 2370001").run()
    const before = harness.snapshot()
    assert.throws(() => executeGenericShopPurchaseSync({
        playerId: 17,
        shopItemId: 700000,
        purchaseAmount: 1,
        shopItem,
        nowMs: activeTime,
        enforcePeriod: true,
    }, harness.dependencies), ShopBalanceError)
    assert.deepEqual(harness.snapshot(), before)
}

for (const failAt of ["cost", "reward", "purchase"]) {
    const harness = createPurchaseHarness({ failAt })
    const before = harness.snapshot()
    assert.throws(() => executeGenericShopPurchaseSync({
        playerId: 17,
        shopItemId: 700000,
        purchaseAmount: 1,
        shopItem,
        nowMs: activeTime,
        enforcePeriod: true,
    }, harness.dependencies), new RegExp(`injected ${failAt} failure`))
    assert.deepEqual(harness.snapshot(), before, `${failAt} 失败必须回滚全部写入`)
}

console.log("rush event shop asset tests passed")
