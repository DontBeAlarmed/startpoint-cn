const assert = require("node:assert/strict")
const Database = require("better-sqlite3")
const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")

require("ts-node/register/transpile-only")

const { after } = require("node:test")
const { installBundledShopSnapshot } = require("./helpers/install-bundled-shop-snapshot.cjs")
const restoreBundledShopSnapshot = installBundledShopSnapshot()
after(restoreBundledShopSnapshot)

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
    CREATE TABLE mission_counter_state (
        player_id INTEGER PRIMARY KEY,
        used_mana INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE equipment_state (
        player_id INTEGER NOT NULL,
        equipment_id INTEGER NOT NULL,
        level INTEGER NOT NULL,
        enhancement_level INTEGER NOT NULL,
        PRIMARY KEY (player_id, equipment_id)
    );
    CREATE TABLE players_mails (
        player_id INTEGER NOT NULL,
        receive_time TEXT NOT NULL
    );
    CREATE TABLE campaign_selection_state (
        player_id INTEGER NOT NULL,
        shop_type INTEGER NOT NULL,
        campaign_id INTEGER NOT NULL,
        lineup_id INTEGER NOT NULL,
        PRIMARY KEY (player_id, shop_type, campaign_id)
    );
    INSERT INTO player_state VALUES (17, 1000, 100, 20, 50);
    INSERT INTO item_state VALUES (17, 2370001, 1000);
    INSERT INTO item_state VALUES (17, 49100, 3);
    INSERT INTO item_state VALUES (17, 40401, 5);
    INSERT INTO item_state VALUES (17, 40000, 100);
    INSERT INTO equipment_state VALUES (17, 5020042, 5, 0);
    INSERT INTO players_mails VALUES (17, '0000-00-00 00:00:00');
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
        missionCounters: db.prepare("SELECT * FROM mission_counter_state ORDER BY player_id").all(),
        equipments: db.prepare("SELECT * FROM equipment_state ORDER BY equipment_id").all(),
        campaignSelections: db.prepare(`
            SELECT * FROM campaign_selection_state ORDER BY shop_type, campaign_id
        `).all(),
    }
}

function getUsedManaCount(playerId) {
    return db.prepare(
        "SELECT used_mana FROM mission_counter_state WHERE player_id = ?",
    ).get(playerId)?.used_mana ?? 0
}

let globalNowSeconds = Date.parse("2023-12-01T00:00:00+08:00") / 1000
let failRewardAfterWrite = false

stubModule("../src/data/db", { getDb: () => db })
stubModule("../src/data/domains/shopPurchase", {
    getPlayerShopPurchasesMapSync(playerId) {
        return Object.fromEntries(db.prepare(
            "SELECT shop_item_id, count FROM purchase_state WHERE player_id = ?",
        ).all(playerId).map(row => [row.shop_item_id, row.count]))
    },
    getPlayerShopPurchaseCountSync: getPurchaseCount,
    getPlayerShopPurchaseCountsByTypeSync(playerId, _shopType, shopItemId) {
        return { daily: 0, monthly: 0, total: getPurchaseCount(playerId, shopItemId) }
    },
    addPlayerShopPurchaseCountsByTypeSync(playerId, _shopType, shopItemId, amount) {
        db.prepare(`
            INSERT INTO purchase_state VALUES (?, ?, ?)
            ON CONFLICT(player_id, shop_item_id) DO UPDATE SET count = count + excluded.count
        `).run(playerId, shopItemId, amount)
        return { daily: 0, monthly: 0, total: getPurchaseCount(playerId, shopItemId) }
    },
    addPlayerShopPurchaseCountSync(playerId, shopItemId, amount) {
        db.prepare(`
            INSERT INTO purchase_state VALUES (?, ?, ?)
            ON CONFLICT(player_id, shop_item_id) DO UPDATE SET count = count + excluded.count
        `).run(playerId, shopItemId, amount)
        return getPurchaseCount(playerId, shopItemId)
    },
    addPlayerShopPurchaseSync(playerId, shopItemId) {
        db.prepare(`
            INSERT INTO purchase_state VALUES (?, ?, 1)
            ON CONFLICT(player_id, shop_item_id) DO UPDATE SET count = count + 1
        `).run(playerId, shopItemId)
        return getPurchaseCount(playerId, shopItemId)
    },
})
stubModule("../src/data/domains/account", { getAccountPlayers: () => [] })
stubModule("../src/data/domains/equipment", {
    getPlayerEquipmentSync(playerId, equipmentId) {
        const row = db.prepare(
            "SELECT * FROM equipment_state WHERE player_id = ? AND equipment_id = ?",
        ).get(playerId, equipmentId)
        return row === undefined ? null : {
            level: row.level,
            enhancementLevel: row.enhancement_level,
        }
    },
    playerOwnsEquipmentSync(playerId, equipmentId) {
        return db.prepare(
            "SELECT 1 FROM equipment_state WHERE player_id = ? AND equipment_id = ?",
        ).get(playerId, equipmentId) !== undefined
    },
    updatePlayerEquipmentSync(playerId, equipmentId, patch) {
        db.prepare(`
            UPDATE equipment_state
            SET enhancement_level = ?
            WHERE player_id = ? AND equipment_id = ?
        `).run(patch.enhancementLevel, playerId, equipmentId)
    },
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
stubModule("../src/data/domains/shop-campaign-lineup", {
    getPlayerShopCampaignLineupSync(playerId, shopType, campaignId) {
        return db.prepare(`
            SELECT lineup_id FROM campaign_selection_state
            WHERE player_id = ? AND shop_type = ? AND campaign_id = ?
        `).get(playerId, shopType, campaignId)?.lineup_id ?? null
    },
    getPlayerShopCampaignLineupsSync(playerId) {
        return Object.fromEntries(db.prepare(`
            SELECT shop_type, campaign_id, lineup_id FROM campaign_selection_state
            WHERE player_id = ? ORDER BY shop_type, campaign_id
        `).all(playerId).map(row => [`${row.shop_type}:${row.campaign_id}`, row.lineup_id]))
    },
    selectPlayerShopCampaignLineupSync(playerId, shopType, campaignId, lineupId) {
        const inserted = db.prepare(`
            INSERT OR IGNORE INTO campaign_selection_state VALUES (?, ?, ?, ?)
        `).run(playerId, shopType, campaignId, lineupId).changes === 1
        if (inserted) return "inserted"
        const selected = db.prepare(`
            SELECT lineup_id FROM campaign_selection_state
            WHERE player_id = ? AND shop_type = ? AND campaign_id = ?
        `).get(playerId, shopType, campaignId).lineup_id
        return selected === lineupId ? "unchanged" : "conflict"
    },
})
stubModule("../src/data/activeAccount", { resolvePlayerIdSync: () => 17 })
const degreeOperationCalls = []
stubModule("../src/data/domains/active_mission_counters", {
    incrementActiveMissionUsedManaCountSync(playerId, amount) {
        db.prepare(`
            INSERT INTO mission_counter_state VALUES (?, ?)
            ON CONFLICT(player_id) DO UPDATE SET used_mana = used_mana + excluded.used_mana
        `).run(playerId, amount)
    },
})
stubModule("../src/lib/mission/degree-operation-facts", {
    recordDegreeOperationFactsSync: (...args) => degreeOperationCalls.push(args),
})
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
    planEquipmentEnhancementPurchase(currentLevel, purchaseAmount) {
        return { ok: true, newLevel: currentLevel + purchaseAmount }
    },
})
stubModule("../src/lib/mission", {
    reconcileAwakeUnlockCharacterList: (_playerId, list) => list,
})

const shopRoutes = require("../src/routes/api/shop.ts").default
const eventItemShopAsset = require("../assets/event_item_shop.json")
const equipmentEnhancementShopAsset = require("../assets/equipment_enhancement_shop.json")

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
        globalNowSeconds = Date.parse("2022-12-23T12:00:00+08:00") / 1000
        const campaignBefore = await fastify.inject({
            method: "POST",
            url: "/get_campaign_lineup_id",
            payload: { viewer_id: 123, shop_type: 4, campaign_id: 10 },
        })
        assert.equal(campaignBefore.statusCode, 200)
        assert.equal(decode(campaignBefore).data.lineup_id, null)

        const campaignSalesBefore = await getRushSales(fastify, 4, 1)
        assert.equal(campaignSalesBefore.some(item => item.shop_item_id === 100030), true)
        assert.equal(campaignSalesBefore.some(item => item.shop_item_id === 100010), false)
        assert.equal(campaignSalesBefore.some(item => item.shop_item_id === 100020), false)

        const selectCampaign = await fastify.inject({
            method: "POST",
            url: "/set_campaign_lineup_id",
            payload: { viewer_id: 123, shop_type: 4, campaign_id: 10, lineup_id: 1010 },
        })
        assert.equal(selectCampaign.statusCode, 200, selectCampaign.body)
        const retryCampaign = await fastify.inject({
            method: "POST",
            url: "/set_campaign_lineup_id",
            payload: { viewer_id: 123, shop_type: 4, campaign_id: 10, lineup_id: 1010 },
        })
        assert.equal(retryCampaign.statusCode, 200)
        const conflictingCampaign = await fastify.inject({
            method: "POST",
            url: "/set_campaign_lineup_id",
            payload: { viewer_id: 123, shop_type: 4, campaign_id: 10, lineup_id: 1020 },
        })
        assert.equal(conflictingCampaign.statusCode, 400)

        const campaignAfter = await fastify.inject({
            method: "POST",
            url: "/get_campaign_lineup_id",
            payload: { viewer_id: 123, shop_type: 4, campaign_id: 10 },
        })
        assert.equal(decode(campaignAfter).data.lineup_id, 1010)
        const campaignSalesAfter = await getRushSales(fastify, 4, 1)
        assert.equal(campaignSalesAfter.some(item => item.shop_item_id === 100030), true)
        assert.equal(campaignSalesAfter.some(item => item.shop_item_id === 100010), true)
        assert.equal(campaignSalesAfter.some(item => item.shop_item_id === 100020), false)

        const beforeUnauthorizedCampaignBuy = snapshot()
        const unauthorizedCampaignBuy = await fastify.inject({
            method: "POST",
            url: "/buy",
            payload: { viewer_id: 123, shop_type: 4, shop_item_id: 100020, number: 1 },
        })
        assert.equal(unauthorizedCampaignBuy.statusCode, 400)
        assert.deepEqual(snapshot(), beforeUnauthorizedCampaignBuy)

        globalNowSeconds = Date.parse("2023-01-06T12:00:00+08:00") / 1000
        const expiredCampaign = await fastify.inject({
            method: "POST",
            url: "/get_campaign_lineup_id",
            payload: { viewer_id: 123, shop_type: 4, campaign_id: 10 },
        })
        assert.equal(expiredCampaign.statusCode, 200)
        assert.equal(decode(expiredCampaign).data_headers.result_code, 1652)

        globalNowSeconds = Date.parse("2023-12-01T00:00:00+08:00") / 1000
        assert.equal((await getRushSales(fastify, 11, 700001)).length, 33)
        assert.equal((await getRushSales(fastify, 6, 700001)).length, 0)
        assert.equal(
            (await getRushSales(fastify, 11, 700011)).length,
            33,
            "常驻 Rush 商店必须在原始批次商品开放期内兼容复用商品",
        )

        globalNowSeconds = Date.parse("2025-07-12T12:00:00+08:00") / 1000
        assert.equal(
            (await getRushSales(fastify, 11, 700011)).length,
            33,
            "常驻 Rush 商店必须在常驻活动自身开放期内显示兼容商品",
        )
        const compatibilityPurchase = await fastify.inject({
            method: "POST",
            url: "/buy",
            payload: { viewer_id: 123, shop_type: 4, shop_item_id: 700032, number: 1 },
        })
        assert.equal(compatibilityPurchase.statusCode, 200)
        assert.equal(decode(compatibilityPurchase).data_headers.result_code, 1)
        db.prepare("UPDATE item_state SET amount = 1000 WHERE player_id = ? AND item_id = ?")
            .run(17, 2370001)
        db.prepare("DELETE FROM item_state WHERE player_id = ? AND item_id = ?").run(17, 100000)
        db.prepare("DELETE FROM purchase_state WHERE player_id = ? AND shop_item_id = ?").run(17, 700032)

        eventItemShopAsset["11"]["700011"] = {
            "999999": eventItemShopAsset["11"]["700001"]["700000"],
        }
        try {
            const beforeExactShopPurchase = snapshot()
            const oldItemPurchase = await fastify.inject({
                method: "POST",
                url: "/buy",
                payload: { viewer_id: 123, shop_type: 4, shop_item_id: 700000, number: 1 },
            })
            assert.equal(oldItemPurchase.statusCode, 200)
            assert.equal(
                decode(oldItemPurchase).data_headers.result_code,
                2053,
                "常驻活动出现非空精确商品后必须关闭旧商品的常驻期直购",
            )
            assert.deepEqual(snapshot(), beforeExactShopPurchase)
        } finally {
            delete eventItemShopAsset["11"]["700011"]
        }

        const staminaRecovery = await fastify.inject({
            method: "POST",
            url: "/recover_stamina",
            payload: { viewer_id: 123 },
        })
        assert.equal(staminaRecovery.statusCode, 200, staminaRecovery.body)
        assert.equal(decode(staminaRecovery).data.mail_arrived, true)

        globalNowSeconds = Date.parse("2025-06-26T11:59:59+08:00") / 1000
        assert.equal((await getRushSales(fastify, 11, 700011)).length, 0)
        globalNowSeconds = Date.parse("2025-06-26T12:00:00+08:00") / 1000
        assert.equal((await getRushSales(fastify, 11, 700011)).length, 33)
        globalNowSeconds = Date.parse("2025-08-14T23:59:59+08:00") / 1000
        assert.equal((await getRushSales(fastify, 11, 700011)).length, 33)
        globalNowSeconds = Date.parse("2025-08-15T00:00:00+08:00") / 1000
        assert.equal((await getRushSales(fastify, 11, 700011)).length, 0)

        globalNowSeconds = Date.parse("2023-12-18T12:00:00+08:00") / 1000
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

        const expiredBulk = await fastify.inject({
            method: "POST",
            url: "/bulk_buy",
            payload: {
                viewer_id: 123,
                shop_type: 4,
                buy_item_list: { 700000: 1, 700001: 1 },
            },
        })
        assert.equal(expiredBulk.statusCode, 200)
        assert.equal(decode(expiredBulk).data_headers.result_code, 2053)
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

        globalNowSeconds = Date.parse("2023-12-01T00:00:00+08:00") / 1000
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

        db.prepare("UPDATE item_state SET amount = 2000 WHERE player_id = ? AND item_id = ?")
            .run(17, 2370001)
        const bulkSuccess = await fastify.inject({
            method: "POST",
            url: "/bulk_buy",
            payload: {
                viewer_id: 123,
                shop_type: 4,
                buy_item_list: { 700001: 1, 700002: 1 },
            },
        })
        assert.equal(bulkSuccess.statusCode, 200, bulkSuccess.body)
        const bulkBody = decode(bulkSuccess)
        assert.equal(bulkBody.data.item_list[2370001], 600)
        assert.equal(getPurchaseCount(17, 700001), 1)
        assert.equal(getPurchaseCount(17, 700002), 1)
        assert.equal(bulkBody.data.mail_arrived, true)

        const beforeInsufficientBulk = snapshot()
        const insufficientBulk = await fastify.inject({
            method: "POST",
            url: "/bulk_buy",
            payload: {
                viewer_id: 123,
                shop_type: 4,
                buy_item_list: { 700003: 1, 700004: 1 },
            },
        })
        assert.equal(insufficientBulk.statusCode, 400)
        assert.deepEqual(snapshot(), beforeInsufficientBulk)

        const bossBulk = await fastify.inject({
            method: "POST",
            url: "/bulk_buy",
            payload: {
                viewer_id: 123,
                shop_type: 7,
                buy_item_list: { 200101: 1, 200102: 1 },
            },
        })
        assert.equal(bossBulk.statusCode, 200, bossBulk.body)
        assert.equal(decode(bossBulk).data.item_list[40000], 40)
        assert.equal(getPurchaseCount(17, 200101), 1)
        assert.equal(getPurchaseCount(17, 200102), 1)

        const unsupportedBulk = await fastify.inject({
            method: "POST",
            url: "/bulk_buy",
            payload: { viewer_id: 123, shop_type: 8, buy_item_list: { 1: 1 } },
        })
        assert.equal(unsupportedBulk.statusCode, 400)

        const manaPurchase = await fastify.inject({
            method: "POST",
            url: "/buy",
            payload: { viewer_id: 123, shop_type: 2, shop_item_id: 200001, number: 1 },
        })
        assert.equal(manaPurchase.statusCode, 200)
        assert.equal(getUsedManaCount(17), 1, "通用商店路由必须累计实际消费的玛纳")
        assert.deepEqual(degreeOperationCalls.at(-1), [17, "treasure_mana", 1])

        const enhancementItem = equipmentEnhancementShopAsset["2001"]
        enhancementItem.userCost = { type: 1, amount: 30 }
        try {
            const enhancementPurchase = await fastify.inject({
                method: "POST",
                url: "/buy",
                payload: { viewer_id: 123, shop_type: 10, shop_item_id: 2001, number: 1 },
            })
            assert.equal(enhancementPurchase.statusCode, 200, enhancementPurchase.body)
            assert.equal(
                getUsedManaCount(17),
                31,
                "追忆强化独立事务也必须累计实际消费的玛纳",
            )
        } finally {
            delete enhancementItem.userCost
        }

        const reloadedServer = await createServer()
        try {
            const reloadedSales = await getRushSales(reloadedServer, 11, 700001)
            const purchasedItem = reloadedSales.find(item => item.shop_item_id === 700000)
            assert.equal(purchasedItem.total_purchase_num, 2)
            assert.equal(
                purchasedItem.stock_quantity,
                3,
                "buy_max_count 只限制单次购买，剩余库存由官方 max_frequency 计算",
            )
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
