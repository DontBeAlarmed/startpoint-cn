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
    getShopSelectItemCampaignsSync,
} = require("../src/lib/assets")
const { getShopCatalog } = require("../src/lib/shop")
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
    "special_pack_shop.json",
    "mana_shop.json",
    "shop_cost_item_schedule.json",
])
const SHOP_RUNTIME_TABLES = Object.freeze([
    ...SHOP_TABLES.filter(tableName => tableName !== "shop_cost_item_schedule.json"),
    "item_lookup.json",
])

test("shop runtime facades read all twelve product tables from one initialized snapshot", () => {
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
        "special_pack_shop.json": Object.freeze({
            "107": Object.freeze({ ...item, purchaseKind: "purchase", specialExchangeCampaignId: 0 }),
            "108": Object.freeze({ ...item, purchaseKind: "specialExchangeLink", specialExchangeCampaignId: 11 }),
        }),
        "mana_shop.json": Object.freeze({ "109": item }),
        "shop_cost_item_schedule.json": Object.freeze({}),
        "cdn_general_shop_whitelist.json": Object.freeze([101]),
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
        const catalog = getShopCatalog(repository)
        assert.equal(catalog.entries[`${ShopType.GENERAL}:101`].listed, true)
        assert.equal(catalog.entries[`${ShopType.STAR_GRAIN}:104`].kind, "purchase")
        assert.equal(catalog.entries[`${ShopType.TREASURE}:105`].kind, "purchase")
        assert.equal(catalog.entries[`${ShopType.TREASURE_EQUIPMENT}:106`].kind, "purchase")
        assert.equal(catalog.entries[`${ShopType.SPECIAL_PACK}:107`].kind, "purchase")
        assert.equal(catalog.entries[`${ShopType.SPECIAL_PACK}:108`].kind, "specialExchangeLink")
        assert.equal(catalog.entries[`${ShopType.MANA}:109`].kind, "purchase")
        assert.deepEqual(catalog.eventProductIds["11:700001"], [102])
        assert.deepEqual(catalog.bossProductIds["5"], [103])
        assert.deepEqual(catalog.entries[`${ShopType.EVENT_ITEM}:102`].periods[1], {
            availableFrom: "2025-06-26 12:00:00",
            availableUntil: "2025-08-14 23:59:59",
        })
        assert.deepEqual(getShopSelectItemCampaignsSync(), { "4": {}, "7": {} })
        assert.equal(resolveEventCurrencyId(70001, new Date("2024-01-02T00:00:00Z")), 70001)
        assert.equal(requested.includes("cdn_general_shop_whitelist.json"), true)
        assert.equal(requested.includes("item_lookup.json"), true)
        assert.equal(requested.length >= 12, true)
        assert.strictEqual(productionContentSnapshotProvider.snapshot.repository, repository)
    } finally {
        productionContentSnapshotProvider.snapshot = previousSnapshot
    }
})

test("bundled ContentRepository exposes all thirteen controlled shop imports", async t => {
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
