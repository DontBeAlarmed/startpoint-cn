"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { ContentRepository } = require("../src/content/runtime/content-repository")
const {
    productionContentSnapshotProvider,
} = require("../src/content/runtime/content-snapshot")
const {
    getBossCoinShopItemsSync,
    getEventShopItemsSync,
    getGenericShopItemsSync,
    getShopItemSync,
    getShopSelectItemCampaignsSync,
} = require("../src/lib/assets")
const { resolveEventCurrencyId } = require("../src/lib/event-currency")
const { ShopType } = require("../src/lib/types")

const SHOP_TABLES = Object.freeze([
    "general_shop.json",
    "event_item_shop.json",
    "event_item_shop_id_map.json",
    "boss_coin_shop.json",
    "boss_coin_shop_item_category_map.json",
    "shop_item_campaign.json",
    "shop_select_item_campaign.json",
    "star_grain_shop.json",
    "treasure_shop.json",
    "equipment_enhancement_shop.json",
])
const SHOP_RUNTIME_TABLES = Object.freeze([...SHOP_TABLES, "item_lookup.json"])

test("shop runtime facades read all ten tables from one initialized snapshot", () => {
    const previousSnapshot = productionContentSnapshotProvider.snapshot
    const requested = []
    const item = Object.freeze({
        costs: Object.freeze([{ id: 800, amount: 1 }]),
        rewards: Object.freeze([{ type: 0, id: 900, count: 1 }]),
        availableFrom: "2024-01-01 00:00:00",
        availableUntil: null,
        stock: 1,
    })
    const eventItem = Object.freeze({
        ...item,
        costs: Object.freeze([{ id: 70001, amount: 1 }]),
    })
    const tables = Object.freeze({
        "general_shop.json": Object.freeze({ "101": item }),
        "event_item_shop.json": Object.freeze({
            "11": Object.freeze({ "700001": Object.freeze({ "102": eventItem }) }),
        }),
        "event_item_shop_id_map.json": Object.freeze({
            "102": Object.freeze({ eventType: 11, eventId: 700001 }),
        }),
        "boss_coin_shop.json": Object.freeze({
            "5": Object.freeze({ "103": item }),
        }),
        "boss_coin_shop_item_category_map.json": Object.freeze({ "103": 5 }),
        "shop_item_campaign.json": Object.freeze({ "4": Object.freeze({}), "7": Object.freeze({}) }),
        "shop_select_item_campaign.json": Object.freeze({ "4": Object.freeze({}), "7": Object.freeze({}) }),
        "star_grain_shop.json": Object.freeze({ "104": item }),
        "treasure_shop.json": Object.freeze({ "105": item }),
        "equipment_enhancement_shop.json": Object.freeze({ "106": item }),
        "item_lookup.json": Object.freeze({ "70001": "活动代币" }),
    })
    const repository = Object.freeze({
        info: () => Object.freeze({
            source: "release",
            assetVersion: "test-shop-release",
            generatorVersion: 1,
            releaseDigest: null,
        }),
        table: tableName => {
            requested.push(tableName)
            if (!(tableName in tables)) throw new Error(`unexpected table ${tableName}`)
            return tables[tableName]
        },
    })
    productionContentSnapshotProvider.snapshot = Object.freeze({
        cdn: Object.freeze({ targetVersion: "test-shop-release" }),
        repository,
    })

    try {
        assert.strictEqual(getGenericShopItemsSync(ShopType.GENERAL)["101"], item)
        assert.strictEqual(getGenericShopItemsSync(ShopType.STAR_GRAIN)["104"], item)
        assert.strictEqual(getGenericShopItemsSync(ShopType.TREASURE)["105"], item)
        assert.strictEqual(getGenericShopItemsSync(ShopType.TREASURE_EQUIPMENT)["106"], item)
        assert.strictEqual(getEventShopItemsSync(11, 700001)["102"], eventItem)
        assert.strictEqual(getBossCoinShopItemsSync(5)["103"], item)
        const directEventItem = getShopItemSync(ShopType.EVENT_ITEM, 102)
        const { compatibilityPeriods, ...baseEventItem } = directEventItem
        assert.deepEqual(baseEventItem, eventItem)
        assert.deepEqual(compatibilityPeriods, [{
            availableFrom: "2025-06-26 12:00:00",
            availableUntil: "2025-08-14 23:59:59",
        }])
        assert.strictEqual(getShopItemSync(ShopType.BOSS_COIN, 103), item)
        assert.deepEqual(getShopSelectItemCampaignsSync(), { "4": {}, "7": {} })
        assert.equal(resolveEventCurrencyId(70001, new Date("2024-01-02T00:00:00Z")), 70001)
        assert.deepEqual(new Set(requested), new Set(SHOP_RUNTIME_TABLES))
        assert.ok(requested.length >= SHOP_RUNTIME_TABLES.length)
        assert.strictEqual(productionContentSnapshotProvider.snapshot.repository, repository)
    } finally {
        productionContentSnapshotProvider.snapshot = previousSnapshot
    }
})

test("bundled ContentRepository exposes all ten controlled shop imports", async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shop-repository-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const controlled = Object.fromEntries(SHOP_TABLES.map((tableName, index) => [
        tableName,
        Object.freeze({ tableName, nested: Object.freeze({ index }) }),
    ]))
    const repository = await ContentRepository.load({
        projectRoot: path.resolve(__dirname, ".."),
        env: {
            CDN_DIR: path.join(root, "cdn"),
            CONTENT_DIR: path.join(root, "content"),
            CONTENT_RUNTIME_DIR: path.join(root, "runtime"),
        },
    }, {
        importBundledTable: async (_projectRoot, tableName) => (
            controlled[tableName] ?? Object.freeze({ placeholder: tableName })
        ),
    })

    assert.equal(repository.info().source, "bundled")
    for (const tableName of SHOP_TABLES) {
        assert.strictEqual(repository.table(tableName), controlled[tableName], tableName)
    }
})

test("bundled snapshot helper users register a restoration hook", () => {
    for (const testFile of [
        "event_currency.test.cjs",
        "rush_event_shop.test.cjs",
        "rush_event_shop_route.test.cjs",
    ]) {
        const source = fs.readFileSync(path.join(__dirname, testFile), "utf8")
        assert.match(source, /after\(restoreBundledShopSnapshot\)/, testFile)
    }
})

test("quick:content includes the shop Repository regression suite", () => {
    const { TEST_GROUPS } = require("./test-workflow/groups.cjs")
    assert.ok(TEST_GROUPS["quick:content"].tests.includes(
        "tools/shop_repository.test.cjs",
    ))
})
