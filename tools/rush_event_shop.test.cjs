const assert = require("node:assert/strict")
const Database = require("better-sqlite3")

require("ts-node/register/transpile-only")

const { after } = require("node:test")
const { installBundledShopSnapshot } = require("./helpers/install-bundled-shop-snapshot.cjs")
const restoreBundledShopSnapshot = installBundledShopSnapshot({
    additionalTableNames: ["rush_event_quest_folder.json"],
})
after(restoreBundledShopSnapshot)

const {
    getEventShopItemsSync,
    getRushEventFolderClearRewards,
    getShopItemSync,
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
    const originalEventId = eventId - 10
    const compatibilityItems = getEventShopItemsSync(11, eventId)
    const originalItems = getEventShopItemsSync(11, originalEventId)
    assert.notEqual(compatibilityItems, null)
    assert.notEqual(originalItems, null)
    assert.deepEqual(
        Object.keys(compatibilityItems),
        Object.keys(originalItems),
        `常驻狂热激战 ${eventId} 必须兼容复用原始批次 ${originalEventId} 的全部商品`,
    )
    for (const [itemId, compatibilityItem] of Object.entries(compatibilityItems)) {
        const { compatibilityPeriods, ...baseItem } = compatibilityItem
        assert.deepEqual(baseItem, originalItems[itemId])
        assert.deepEqual(compatibilityPeriods, [{
            availableFrom: "2025-06-26 12:00:00",
            availableUntil: "2025-08-14 23:59:59",
        }])
    }
    assert.deepEqual(
        getRushEventFolderClearRewards(eventId, 1),
        getRushEventFolderClearRewards(originalEventId, 1),
        `常驻狂热激战 ${eventId} 必须兼容复用原始批次 ${originalEventId} 的文件夹代币奖励`,
    )
}

assert.equal(
    getEventShopItemsSync(6, 700011),
    null,
    "常驻兼容回退只能用于服务端 Rush event_type=11",
)

const eventItemShopAsset = require("../assets/event_item_shop.json")
assert.deepEqual(getShopItemSync(4, 700000).compatibilityPeriods, [{
    availableFrom: "2025-06-26 12:00:00",
    availableUntil: "2025-08-14 23:59:59",
}])
eventItemShopAsset["11"]["700011"] = {}
try {
    assert.equal(
        Object.keys(getEventShopItemsSync(11, 700011)).length,
        33,
        "空的常驻商品对象仍表示 CDN 尚未补全，必须继续兼容回退",
    )
    assert.notEqual(getShopItemSync(4, 700000).compatibilityPeriods, undefined)

    eventItemShopAsset["11"]["700011"] = {
        "999999": eventItemShopAsset["11"]["700001"]["700000"],
    }
    assert.equal(
        getShopItemSync(4, 700000).compatibilityPeriods,
        undefined,
        "常驻活动出现非空精确 CDN 商品后必须关闭旧商品的兼容直购期",
    )
} finally {
    delete eventItemShopAsset["11"]["700011"]
}

const sourceShopItem = eventItemShopAsset["11"]["700001"]["700000"]
sourceShopItem.compatibilityPeriods = [{
    availableFrom: "2024-01-01 00:00:00",
    availableUntil: "2024-01-02 00:00:00",
}]
try {
    assert.deepEqual(
        getEventShopItemsSync(11, 700011)["700000"].compatibilityPeriods,
        [
            {
                availableFrom: "2024-01-01 00:00:00",
                availableUntil: "2024-01-02 00:00:00",
            },
            {
                availableFrom: "2025-06-26 12:00:00",
                availableUntil: "2025-08-14 23:59:59",
            },
        ],
        "常驻兼容期必须追加到商品已有的附加开放期",
    )
} finally {
    delete sourceShopItem.compatibilityPeriods
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
assert.throws(() => parseShopJstTimestamp("2025-02-31 12:00:00"), /Invalid shop period/)
assert.throws(() => parseShopJstTimestamp("2025-01-01 24:00:00"), /Invalid shop period/)
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
        CREATE TABLE mission_counter_state (
            player_id INTEGER PRIMARY KEY,
            used_mana INTEGER NOT NULL DEFAULT 0
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
        recordManaSpent(playerId, amount) {
            db.prepare(`
                INSERT INTO mission_counter_state VALUES (?, ?)
                ON CONFLICT(player_id) DO UPDATE SET used_mana = used_mana + excluded.used_mana
            `).run(playerId, amount)
            maybeFail("counter")
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
                missionCounters: db.prepare("SELECT * FROM mission_counter_state ORDER BY player_id").all(),
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
    executeGenericShopPurchaseSync({
        playerId: 17,
        shopItemId: 800001,
        purchaseAmount: 2,
        shopItem: {
            ...shopItem,
            costs: [],
            rewards: [],
            userCost: { type: 1, amount: 120 },
        },
        nowMs: activeTime,
        enforcePeriod: false,
    }, harness.dependencies)
    assert.deepEqual(
        harness.snapshot().missionCounters,
        [{ player_id: 17, used_mana: 240 }],
        "玛纳购买必须按实际消费量累计 Active Mission 历史计数",
    )
}

for (const userCostType of [0, 2]) {
    const harness = createPurchaseHarness()
    executeGenericShopPurchaseSync({
        playerId: 17,
        shopItemId: 800002 + userCostType,
        purchaseAmount: 1,
        shopItem: {
            ...shopItem,
            costs: [],
            rewards: [],
            userCost: { type: userCostType, amount: 10 },
        },
        nowMs: activeTime,
        enforcePeriod: false,
    }, harness.dependencies)
    assert.deepEqual(
        harness.snapshot().missionCounters,
        [],
        "星导石和羁绊卷轴购买不能计入玛纳消费",
    )
}

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

for (const failAt of ["cost", "reward", "purchase", "counter"]) {
    const harness = createPurchaseHarness({ failAt })
    const before = harness.snapshot()
    assert.throws(() => executeGenericShopPurchaseSync({
        playerId: 17,
        shopItemId: 700000,
        purchaseAmount: 1,
        shopItem: {
            ...shopItem,
            userCost: { type: 1, amount: 10 },
        },
        nowMs: activeTime,
        enforcePeriod: true,
    }, harness.dependencies), new RegExp(`injected ${failAt} failure`))
    assert.deepEqual(harness.snapshot(), before, `${failAt} 失败必须回滚全部写入`)
}

console.log("rush event shop asset tests passed")
