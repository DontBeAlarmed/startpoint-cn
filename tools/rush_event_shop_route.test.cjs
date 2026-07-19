const assert = require("node:assert/strict")
const Database = require("better-sqlite3")
const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")

require("ts-node/register/transpile-only")

function stubModule(relativePath, exports) {
    const modulePath = require.resolve(relativePath)
    require.cache[modulePath] = {
        id: modulePath,
        filename: modulePath,
        loaded: true,
        exports,
    }
}

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

function getPlayer(playerId) {
    const row = db.prepare("SELECT * FROM player_state WHERE id = ?").get(playerId)
    return row === undefined ? null : {
        id: row.id,
        freeMana: row.free_mana,
        freeVmoney: row.free_vmoney,
        bondToken: row.bond_token,
        expPool: row.exp_pool,
    }
}

function getItem(playerId, itemId) {
    return db.prepare(
        "SELECT amount FROM item_state WHERE player_id = ? AND item_id = ?",
    ).get(playerId, itemId)?.amount ?? null
}

function getPurchaseCount(playerId, shopItemId) {
    return db.prepare(
        "SELECT count FROM purchase_state WHERE player_id = ? AND shop_item_id = ?",
    ).get(playerId, shopItemId)?.count ?? 0
}

function snapshot() {
    return {
        players: db.prepare("SELECT * FROM player_state ORDER BY id").all(),
        items: db.prepare("SELECT * FROM item_state ORDER BY item_id").all(),
        purchases: db.prepare("SELECT * FROM purchase_state ORDER BY shop_item_id").all(),
    }
}

let globalNowSeconds = Date.parse("2023-12-01T00:00:00+09:00") / 1000
let failRewardAfterWrite = false

stubModule("../src/data/db", { getDb: () => db })
stubModule("../src/data/domains/shopPurchase", {
    getPlayerShopPurchasesMapSync(playerId) {
        return Object.fromEntries(db.prepare(
            "SELECT shop_item_id, count FROM purchase_state WHERE player_id = ?",
        ).all(playerId).map(row => [row.shop_item_id, row.count]))
    },
    getPlayerShopPurchaseCountSync: getPurchaseCount,
    addPlayerShopPurchaseCountSync(playerId, shopItemId, amount) {
        db.prepare(`
            INSERT INTO purchase_state VALUES (?, ?, ?)
            ON CONFLICT(player_id, shop_item_id) DO UPDATE SET count = count + excluded.count
        `).run(playerId, shopItemId, amount)
        return getPurchaseCount(playerId, shopItemId)
    },
    addPlayerShopPurchaseSync(playerId, shopItemId) {
        return this.addPlayerShopPurchaseCountSync(playerId, shopItemId, 1)
    },
})
stubModule("../src/data/domains/account", { getAccountPlayers: () => [] })
stubModule("../src/data/domains/equipment", {
    getPlayerEquipmentSync: () => null,
    playerOwnsEquipmentSync: () => false,
    updatePlayerEquipmentSync() {},
})
stubModule("../src/data/domains/item", {
    getPlayerItemSync: getItem,
    updatePlayerItemSync(playerId, itemId, amount) {
        db.prepare(`
            INSERT INTO item_state VALUES (?, ?, ?)
            ON CONFLICT(player_id, item_id) DO UPDATE SET amount = excluded.amount
        `).run(playerId, Number(itemId), amount)
    },
})
stubModule("../src/data/domains/player", {
    getPlayerSync: getPlayer,
    updatePlayerSync(player) {
        const current = getPlayer(player.id)
        db.prepare(`
            UPDATE player_state
            SET free_mana = ?, free_vmoney = ?, bond_token = ?, exp_pool = ?
            WHERE id = ?
        `).run(
            player.freeMana ?? current.freeMana,
            player.freeVmoney ?? current.freeVmoney,
            player.bondToken ?? current.bondToken,
            player.expPool ?? current.expPool,
            player.id,
        )
    },
})
stubModule("../src/data/domains/session", {
    getSession: async viewerId => viewerId === "123" ? { accountId: 9 } : null,
})
stubModule("../src/data/activeAccount", { resolvePlayerIdSync: () => 17 })
stubModule("../src/utils", {
    generateDataHeaders(values = {}) {
        return { viewer_id: values.viewer_id ?? 0, result_code: values.result_code ?? 1 }
    },
    getServerDate: () => new Date(globalNowSeconds * 1000),
    getServerTime: () => globalNowSeconds,
    realToVirtual: date => Math.floor(date.getTime() / 1000),
})
stubModule("../src/lib/quest", {
    givePlayerRewardsSync(playerId, rewards) {
        const items = {}
        let mana = 0
        let expPool = 0
        for (const reward of rewards) {
            if (reward.type === 0) {
                const amount = (getItem(playerId, reward.id) ?? 0) + reward.count
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
        if (failRewardAfterWrite) throw new Error("injected reward failure")
        return {
            user_info: { free_mana: mana, free_vmoney: 0, exp_pool: expPool },
            character_list: [],
            joined_character_id_list: [],
            equipment_list: [],
            items,
        }
    },
})
stubModule("../src/lib/stamina", { computeRealTimeStamina: () => 100 })
stubModule("../src/lib/equipment", { clientSerializeEquipment: value => value })
stubModule("../src/lib/equipment-enhancement", {
    planEquipmentEnhancementPurchase: () => ({ ok: false, message: "unused" }),
})
stubModule("../src/lib/mission", {
    reconcileAwakeUnlockCharacterList: (_playerId, list) => list,
})

const shopRoutes = require("../src/routes/api/shop.ts").default

async function createServer() {
    const fastify = Fastify()
    fastify.addHook("onSend", async (_request, reply, payload) => {
        const contentType = String(reply.getHeader("content-type") ?? "")
        if (!contentType.includes("application/x-msgpack") || Buffer.isBuffer(payload)) return payload
        const value = typeof payload === "string" ? JSON.parse(payload) : payload
        return pack(value)
    })
    await fastify.register(shopRoutes)
    await fastify.ready()
    return fastify
}

function decode(response) {
    return unpack(response.rawPayload)
}

async function getRushSales(fastify, eventType, eventId) {
    const response = await fastify.inject({
        method: "POST",
        url: "/get_sales_list",
        payload: {
            viewer_id: 123,
            shop_types: [4],
            boss_coin_shop_category_ids: [],
            equipment_enhancement_shop_category_ids: [],
            browse_treasure_flag: false,
            event_list: [{ event_type: eventType, event_ids: [eventId] }],
        },
    })
    assert.equal(response.statusCode, 200)
    return decode(response).data.sales_list
}

async function main() {
    const fastify = await createServer()
    try {
        globalNowSeconds = Date.parse("2023-12-01T00:00:00+09:00") / 1000
        assert.equal((await getRushSales(fastify, 11, 700001)).length, 33)
        assert.equal((await getRushSales(fastify, 6, 700001)).length, 0)
        assert.equal((await getRushSales(fastify, 11, 700011)).length, 0)

        globalNowSeconds = Date.parse("2023-12-18T12:00:00+09:00") / 1000
        assert.equal(
            (await getRushSales(fastify, 11, 700001)).length,
            0,
            "列表必须使用全局服务器时间过滤开放期",
        )

        const beforeExpired = snapshot()
        const expired = await fastify.inject({
            method: "POST",
            url: "/buy",
            payload: { viewer_id: 123, shop_type: 4, shop_item_id: 700000, number: 1 },
        })
        assert.equal(expired.statusCode, 200)
        assert.equal(decode(expired).data_headers.result_code, 2053)
        assert.deepEqual(snapshot(), beforeExpired)

        db.prepare(`
            INSERT INTO purchase_state VALUES (?, ?, ?)
            ON CONFLICT(player_id, shop_item_id) DO UPDATE SET count = excluded.count
        `).run(17, 700000, 5)
        const beforeExpiredAndSoldOut = snapshot()
        const expiredAndSoldOut = await fastify.inject({
            method: "POST",
            url: "/buy",
            payload: { viewer_id: 123, shop_type: 4, shop_item_id: 700000, number: 1 },
        })
        assert.equal(
            expiredAndSoldOut.statusCode,
            200,
            "过期商品即使库存已耗尽，也必须返回客户端识别的 2053",
        )
        assert.equal(decode(expiredAndSoldOut).data_headers.result_code, 2053)
        assert.deepEqual(snapshot(), beforeExpiredAndSoldOut)
        db.prepare("DELETE FROM purchase_state WHERE player_id = ? AND shop_item_id = ?").run(17, 700000)

        for (const invalidNumber of [0, -1, 1.5]) {
            const response = await fastify.inject({
                method: "POST",
                url: "/buy",
                payload: { viewer_id: 123, shop_type: 4, shop_item_id: 700000, number: invalidNumber },
            })
            assert.equal(response.statusCode, 400, `购买数量 ${invalidNumber} 必须被路由拒绝`)
        }

        globalNowSeconds = Date.parse("2023-12-01T00:00:00+09:00") / 1000
        const success = await fastify.inject({
            method: "POST",
            url: "/buy",
            payload: { viewer_id: 123, shop_type: 4, shop_item_id: 700000, number: 2 },
        })
        assert.equal(success.statusCode, 200)
        const successBody = decode(success)
        assert.equal(successBody.data.item_list[2370001], 600)
        assert.equal(successBody.data.item_list[49100], 5)
        assert.equal(getPurchaseCount(17, 700000), 2)

        const reloadedServer = await createServer()
        try {
            const reloadedSales = await getRushSales(reloadedServer, 11, 700001)
            const purchasedItem = reloadedSales.find(item => item.shop_item_id === 700000)
            assert.equal(purchasedItem.total_purchase_num, 2)
            assert.equal(purchasedItem.stock_quantity, 3)
        } finally {
            await reloadedServer.close()
        }

        const beforeFailure = snapshot()
        failRewardAfterWrite = true
        const failed = await fastify.inject({
            method: "POST",
            url: "/buy",
            payload: { viewer_id: 123, shop_type: 4, shop_item_id: 700001, number: 1 },
        })
        failRewardAfterWrite = false
        assert.equal(failed.statusCode, 500)
        assert.deepEqual(snapshot(), beforeFailure, "路由中的发奖异常必须回滚扣币和购买数")
    } finally {
        await fastify.close()
    }
}

main().then(() => {
    console.log("rush event shop route transaction tests passed")
}).catch(error => {
    console.error(error)
    process.exitCode = 1
})
