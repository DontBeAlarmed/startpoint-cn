const assert = require("node:assert/strict")
const Database = require("better-sqlite3")

require("ts-node/register/transpile-only")

const {
    ShopBalanceError,
    executeGenericShopBatchPurchaseSync,
} = require("../src/lib/event-shop-purchase")
const {
    ShopItemRewardType,
    ShopItemUserCostType,
} = require("../src/lib/types")

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
            shop_item_id INTEGER NOT NULL,
            count INTEGER NOT NULL,
            PRIMARY KEY (player_id, shop_item_id)
        );
        INSERT INTO player_state VALUES (7, 500, 20, 3, 0);
        INSERT INTO item_state VALUES (7, 10, ${itemBalance});
    `)

    let failGrant = false
    let manaSpent = 0
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
    const getPurchaseCount = (playerId, shopItemId) => db.prepare(
        "SELECT count FROM purchase_state WHERE player_id = ? AND shop_item_id = ?",
    ).get(playerId, shopItemId)?.count ?? 0

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
            getPurchaseCount,
            addPurchaseCount(playerId, shopItemId, amount) {
                db.prepare(`
                    INSERT INTO purchase_state VALUES (?, ?, ?)
                    ON CONFLICT(player_id, shop_item_id) DO UPDATE SET count = count + excluded.count
                `).run(playerId, shopItemId, amount)
                return getPurchaseCount(playerId, shopItemId)
            },
            recordManaSpent(_playerId, amount) { manaSpent += amount },
            grantRewards(playerId, rewards) {
                if (failGrant) throw new Error("injected reward failure")
                const items = {}
                for (const reward of rewards) {
                    if (reward.type !== 0) throw new Error("unexpected reward type")
                    const total = getItem(playerId, reward.id) + reward.count
                    this.setItem(playerId, reward.id, total)
                    items[String(reward.id)] = total
                }
                return {
                    user_info: { free_mana: 0, free_vmoney: 0, exp_pool: 0 },
                    character_list: [],
                    joined_character_id_list: [],
                    equipment_list: [],
                    items,
                }
            },
        },
        getPlayer,
        getItem,
        getPurchaseCount,
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
}
const itemB = {
    costs: [{ id: 10, amount: 5 }],
    rewards: [{ type: ShopItemRewardType.ITEM, id: 10, count: 100 }],
    userCost: { type: ShopItemUserCostType.MANA, amount: 100 },
    availableFrom: "2024-01-01 00:00:00",
    availableUntil: null,
    stock: 1,
}

{
    const harness = createHarness()
    const result = executeGenericShopBatchPurchaseSync({
        playerId: 7,
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
    harness.db.close()
}

{
    const harness = createHarness(10)
    assert.throws(() => executeGenericShopBatchPurchaseSync({
        playerId: 7,
        purchases: [
            { shopItemId: 101, purchaseAmount: 1, shopItem: itemA },
            { shopItemId: 102, purchaseAmount: 1, shopItem: itemB },
        ],
        nowMs: Date.parse("2024-02-01T00:00:00Z"),
        enforcePeriod: true,
    }, harness.dependencies), ShopBalanceError)
    assert.equal(harness.getItem(7, 10), 10, "本批奖励不能支付本批成本")
    assert.equal(harness.getItem(7, 20), 0)
    assert.equal(harness.getPurchaseCount(7, 101), 0)
    assert.equal(harness.getPlayer(7).freeMana, 500)
    harness.db.close()
}

{
    const harness = createHarness()
    harness.failGrant()
    assert.throws(() => executeGenericShopBatchPurchaseSync({
        playerId: 7,
        purchases: [{ shopItemId: 101, purchaseAmount: 1, shopItem: itemA }],
        nowMs: Date.parse("2024-02-01T00:00:00Z"),
        enforcePeriod: true,
    }, harness.dependencies), /injected reward failure/)
    assert.equal(harness.getItem(7, 10), 20)
    assert.equal(harness.getPurchaseCount(7, 101), 0)
    harness.db.close()
}

console.log("shop bulk purchase tests passed")
