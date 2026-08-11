const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const Fastify = require("fastify")
const { unpack } = require("msgpackr")

require("ts-node/register/transpile-only")

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "how-to-get-route-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = dataDirectory
delete process.env.WDFP_DATABASE_DIR

const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
const { productionContentSnapshotProvider } = require("../src/content/runtime/content-snapshot")

initializeDatabase()
const db = getDb()
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: "how-to-get-route-account",
    status: "normal",
})
const player = insertDefaultPlayerSync(account.id)
const viewerId = 740000000 + player.id
db.prepare(`
    INSERT INTO sessions (token, account_id, expires, type)
    VALUES (?, ?, ?, 2)
`).run(viewerId.toString(), account.id, new Date(Date.now() + 3600_000).toISOString())
db.prepare(`
    INSERT INTO players_shop_campaign_lineups (
        player_id, shop_type, campaign_id, lineup_id, selected_at
    ) VALUES (?, 4, 9001, 1, ?)
`).run(player.id, "2024-08-14T12:00:00.000Z")

const snapshotTables = {
    "general_shop.json": {},
    "star_grain_shop.json": {},
    "treasure_shop.json": {},
    "equipment_enhancement_shop.json": {},
    "event_item_shop.json": {
        "11": {
            "700001": {
                "41001": {
                    costs: [{ id: 9001, amount: 1 }],
                    rewards: [{ type: 0, id: 1001, count: 1 }],
                    availableFrom: "2024-08-01 00:00:00",
                    availableUntil: "2024-09-01 00:00:00",
                    stock: 10,
                },
                "41002": {
                    costs: [{ id: 9002, amount: 1001 }],
                    rewards: [{ type: 0, id: 1001, count: 1 }],
                    availableFrom: "2024-08-01 00:00:00",
                    availableUntil: "2024-09-01 00:00:00",
                    stock: 10,
                },
                "41003": {
                    costs: [{ id: 1001, amount: 1 }],
                    rewards: [{ type: 0, id: 1002, count: 1 }],
                    availableFrom: "2024-08-01 00:00:00",
                    availableUntil: "2024-09-01 00:00:00",
                    stock: 10,
                },
                "41004": {
                    costs: [{ id: 9003, amount: 1 }],
                    rewards: [{ type: 4, id: 5001, count: 1 }],
                    availableFrom: "2024-08-01 00:00:00",
                    availableUntil: "2024-09-01 00:00:00",
                    stock: 10,
                },
            },
        },
    },
    "boss_coin_shop.json": {},
    "boss_coin_shop_item_category_map.json": {},
    "shop_item_campaign.json": {
        "4": {
            "41001": { campaignId: 9001, lineupId: 1 },
            "41002": { campaignId: 9001, lineupId: 2 },
            "41003": { campaignId: 9001, lineupId: 1 },
            "41004": { campaignId: 9001, lineupId: 1 },
        },
    },
    "shop_select_item_campaign.json": {
        "4": {
            "9001": {
                availableFrom: "2024-08-01 00:00:00",
                availableUntil: "2024-09-01 00:00:00",
                lineupIds: [1, 2],
            },
        },
    },
    "box_gacha.json": {
        "3001": { itemId: 1001, count: 1, availableCounts: { "1": 1 } },
        "3002": { itemId: 1001, count: 1, availableCounts: { "1": 1 } },
        "3003": { itemId: 9005, count: 1, availableCounts: { "1": 1 } },
        "3004": { itemId: 1001, count: 1, availableCounts: { "1": 1 } },
        "3005": { itemId: 1001, count: 1, availableCounts: { "1": 1, "2": 1 } },
    },
    "box_reward.json": {
        "3001": {
            "1": {
                "1": { type: 0, id: 1001, count: 1, available: 1, tier: 0 },
            },
        },
        "3002": {
            "1": {
                "1": { type: 0, id: 1002, count: 1, available: 1, tier: 0 },
            },
        },
        "3003": {
            "1": {
                "1": { type: 1, id: 5001, count: 1, available: 1, tier: 0 },
            },
        },
        "3004": {
            "1": {
                "1": { type: 0, id: 1001, count: 1, available: 1, tier: 0 },
            },
        },
        "3005": {
            "1": {
                "1": { type: 0, id: 1002, count: 1, available: 1, tier: 0 },
            },
            "2": {
                "1": { type: 0, id: 1001, count: 1, available: 1, tier: 0 },
            },
        },
    },
    "box_gacha_box_settings.json": {
        "3001": { "1": { requiredBoxId: null, resetKind: 0, resetLimit: null, availableFrom: "2024-08-01 00:00:00", availableUntil: null, closeKind: 0 } },
        "3002": { "1": { requiredBoxId: null, resetKind: 0, resetLimit: null, availableFrom: "2024-08-01 00:00:00", availableUntil: null, closeKind: 0 } },
        "3003": { "1": { requiredBoxId: null, resetKind: 0, resetLimit: null, availableFrom: "2024-08-01 00:00:00", availableUntil: null, closeKind: 0 } },
        "3004": { "1": { requiredBoxId: null, resetKind: 0, resetLimit: null, availableFrom: "2025-08-01 00:00:00", availableUntil: null, closeKind: 0 } },
        "3005": {
            "1": { requiredBoxId: null, resetKind: 0, resetLimit: null, availableFrom: "2024-08-01 00:00:00", availableUntil: null, closeKind: 0 },
            "2": { requiredBoxId: 1, resetKind: 0, resetLimit: null, availableFrom: "2025-08-01 00:00:00", availableUntil: null, closeKind: 0 },
        },
    },
}

const previousSnapshot = productionContentSnapshotProvider.snapshot
productionContentSnapshotProvider.snapshot = {
    cdn: { targetVersion: "1.4.54" },
    repository: {
        info: () => ({ source: "test", assetVersion: "1.4.54", generatorVersion: 1, releaseDigest: null }),
        table(tableName) {
            if (!(tableName in snapshotTables)) throw new Error(`unexpected test table ${tableName}`)
            return snapshotTables[tableName]
        },
    },
}

function decode(response) {
    assert.equal(response.headers["content-type"], "application/x-msgpack")
    return unpack(Buffer.from(response.body, "base64"))
}

function snapshot() {
    return {
        purchases: db.prepare("SELECT * FROM players_shop_purchase_counters ORDER BY shop_type, shop_item_id, period_key").all(),
        lineups: db.prepare("SELECT * FROM players_shop_campaign_lineups ORDER BY shop_type, campaign_id").all(),
        items: db.prepare("SELECT * FROM players_items WHERE player_id = ? ORDER BY id").all(player.id),
    }
}

async function createApp() {
    const app = Fastify()
    registerCnMsgpackOnSend(app)
    let routes = null
    try {
        routes = require("../src/routes/api/howToGet").default
    } catch (error) {
        if (error?.code !== "MODULE_NOT_FOUND") throw error
    }
    if (routes) await app.register(routes, {
        prefix: "/api/index.php/how_to_get",
        now: () => Date.parse("2024-08-14T04:00:00.000Z"),
    })
    await app.ready()
    return app
}

test.after(async () => {
    productionContentSnapshotProvider.snapshot = previousSnapshot
    if (db.open) db.close()
    fs.rmSync(dataDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
})

test("how-to-get route returns authoritative sources and keeps the request read-only", async () => {
    const app = await createApp()
    try {
        const before = snapshot()
        const response = await app.inject({
            method: "POST",
            url: "/api/index.php/how_to_get/get_list",
            payload: { viewer_id: viewerId, api_count: 0, item_id: 1001 },
        })

        assert.equal(response.statusCode, 200, response.body)
        const decoded = decode(response)
        assert.deepEqual(decoded.data.box_gacha_id_list, [3001])
        assert.deepEqual(decoded.data.shop_sales_list.map(item => item.shop_item_id), [41001])
        assert.deepEqual(decoded.data.unselected_lineup_shop_sales_list, [])
        assert.ok(decoded.data.shop_sales_list.every(item => "group_info" in item && "shop_type" in item))
        assert.deepEqual(snapshot(), before)

        db.prepare(`
            DELETE FROM players_shop_campaign_lineups
            WHERE player_id = ? AND shop_type = 4 AND campaign_id = 9001
        `).run(player.id)
        const beforeUnselected = snapshot()
        const unselectedResponse = await app.inject({
            method: "POST",
            url: "/api/index.php/how_to_get/get_list",
            payload: { viewer_id: viewerId, api_count: 1, item_id: 1001 },
        })
        const unselectedData = decode(unselectedResponse).data
        assert.deepEqual(unselectedData.shop_sales_list, [])
        assert.deepEqual(
            unselectedData.unselected_lineup_shop_sales_list.map(item => item.shop_item_id),
            [41001, 41002],
        )
        assert.deepEqual(snapshot(), beforeUnselected)

        db.prepare(`
            INSERT INTO players_shop_campaign_lineups (
                player_id, shop_type, campaign_id, lineup_id, selected_at
            ) VALUES (?, 4, 9001, 1, ?)
        `).run(player.id, "2024-08-14T12:00:00.000Z")

        const equipmentResponse = await app.inject({
            method: "POST",
            url: "/api/index.php/how_to_get/get_list",
            payload: { viewer_id: viewerId, api_count: 1, equipment_id: 5001 },
        })
        assert.equal(equipmentResponse.statusCode, 200, equipmentResponse.body)
        const equipmentData = decode(equipmentResponse).data
        assert.deepEqual(equipmentData.box_gacha_id_list, [3003])
        assert.deepEqual(equipmentData.shop_sales_list.map(item => item.shop_item_id), [41004])
        assert.deepEqual(equipmentData.unselected_lineup_shop_sales_list, [])

        const unknownResponse = await app.inject({
            method: "POST",
            url: "/api/index.php/how_to_get/get_list",
            payload: { viewer_id: viewerId, api_count: 2, item_id: 999999 },
        })
        assert.deepEqual(decode(unknownResponse).data, {
            box_gacha_id_list: [],
            shop_sales_list: [],
            unselected_lineup_shop_sales_list: [],
        })

        for (const payload of [
            { viewer_id: viewerId, item_id: 1001, equipment_id: 5001 },
            { viewer_id: viewerId },
            { viewer_id: viewerId, item_id: 0 },
            { viewer_id: viewerId, item_id: 1.5 },
            { viewer_id: viewerId, item_id: Number.MAX_SAFE_INTEGER + 1 },
        ]) {
            const invalid = await app.inject({
                method: "POST",
                url: "/api/index.php/how_to_get/get_list",
                payload,
            })
            assert.equal(invalid.statusCode, 400)
        }
        assert.deepEqual(snapshot(), before)
    } finally {
        await app.close()
    }
})

test("cn server includes how-to-get route registration", () => {
    const serverSource = fs.readFileSync(path.join(__dirname, "../src/cn-server.ts"), "utf8")
    assert.match(serverSource, /routes\/api\/howToGet/)
    assert.match(serverSource, /howToGetApiPlugin.*prefix:.*how_to_get/s)
})
