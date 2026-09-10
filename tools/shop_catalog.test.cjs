"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { performance } = require("node:perf_hooks")
const test = require("node:test")

let shop
try {
    shop = require("../src/lib/shop")
} catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error
    shop = {}
}
const shopLoadBoundaryViolations = Object.keys(require.cache).filter(file => (
    file.includes(`${path.sep}src${path.sep}data${path.sep}`)
    || file.includes(`${path.sep}better-sqlite3${path.sep}`)
))

const {
    buildShopCatalog,
    getShopCatalog,
    resolveEffectiveShopOffer,
    ShopOfferNotPurchasableError,
    ShopOfferPeriodError,
    ShopOfferScheduleError,
} = shop
const { ShopType } = require("../src/lib/types")
const { selectShopSalesCatalogItems } = require("../src/lib/shop/sales-catalog")
const { buildShopSalesListSync } = require("../src/lib/shop-sales-list")
const {
    RUSH_FINAL_OPERATION_OVERRIDE,
    resolveRushFinalOperationOverride,
} = require("../src/lib/rush-final-operation-override")

function item(overrides = {}) {
    return {
        costs: [],
        rewards: [],
        availableFrom: "2024-01-01 00:00:00",
        availableUntil: null,
        stock: 99,
        ...overrides,
    }
}

function fixtureTables() {
    return {
        "general_shop.json": {
            "220032": item({
                costScheduleId: "equipment_awaking_crystal_piece",
                rewards: [{ type: 0, id: 13001, count: 1 }],
            }),
            "999999": item({ rewards: [{ type: 0, id: 777, count: 1 }] }),
        },
        "treasure_shop.json": { "200001": item() },
        "special_pack_shop.json": {
            "200003": item({
                purchaseKind: "purchase",
                specialExchangeCampaignId: 0,
                rewards: [{ type: 0, id: 101, count: 10 }],
            }),
            "200001": item({
                purchaseKind: "specialExchangeLink",
                specialExchangeCampaignId: 11,
            }),
        },
        "mana_shop.json": {
            "200002": item({ rewards: [{ type: 2, count: 30000 }] }),
        },
        "star_grain_shop.json": { "100001": item() },
        "equipment_enhancement_shop.json": {
            "700002": item({
                shopCategoryId: 3,
                groupId: 21,
                stage: 2,
                equipmentId: 5020042,
                enhancementMaxLevel: 70,
                requireAwakeningLevel: 5,
            }),
            "700001": item({
                shopCategoryId: 3,
                groupId: 21,
                stage: 1,
                equipmentId: 5020042,
                enhancementMaxLevel: 60,
                requireAwakeningLevel: 5,
            }),
        },
        "event_item_shop.json": {
            "11": {
                "700001": {
                    "310001": item({
                        costs: [{ id: 70001, amount: 1 }],
                        availableUntil: "2024-12-31 23:59:59",
                        rewards: [{ type: 0, id: 777, count: 2 }],
                    }),
                },
            },
        },
        "event_item_shop_id_map.json": {
            "310001": { eventType: 11, eventId: 700001 },
        },
        "boss_coin_shop.json": {
            "5": { "410001": item({ rewards: [{ type: 4, id: 5010001, count: 1 }] }) },
        },
        "boss_coin_shop_item_category_map.json": { "410001": 5 },
        "shop_item_campaign.json": {
            "4": { "310001": { campaignId: 10, lineupId: 1010 } },
            "7": { "410001": { campaignId: 20 } },
        },
        "shop_select_item_campaign.json": {
            "4": { "10": { availableFrom: "2024-01-01 00:00:00", availableUntil: "2025-01-01 00:00:00", lineupIds: [1010] } },
            "7": { "20": { availableFrom: "2024-01-01 00:00:00", availableUntil: "2025-01-01 00:00:00", lineupIds: [] } },
        },
        "shop_cost_item_schedule.json": {
            equipment_awaking_crystal_piece: [{
                availableFrom: "2023-01-01 05:00:00",
                availableUntil: null,
                month: 8,
                costs: [{ id: 40122, amount: 75 }, { id: 40052, amount: 75 }],
            }],
        },
        "cdn_general_shop_whitelist.json": [220032],
    }
}

function repository(tables = fixtureTables()) {
    const calls = []
    return {
        calls,
        table(name) {
            calls.push(name)
            if (!(name in tables)) throw new Error(`unexpected table ${name}`)
            return tables[name]
        },
    }
}

function bundledRepository() {
    const assetsRoot = path.resolve(__dirname, "../assets")
    const tableNames = [
        "shop_item_campaign.json",
        "shop_select_item_campaign.json",
        "cdn_general_shop_whitelist.json",
        "shop_cost_item_schedule.json",
        "treasure_shop.json",
        "special_pack_shop.json",
        "mana_shop.json",
        "general_shop.json",
        "star_grain_shop.json",
        "equipment_enhancement_shop.json",
        "event_item_shop.json",
        "boss_coin_shop.json",
    ]
    const tables = Object.fromEntries(tableNames.map(name => [
        name,
        JSON.parse(fs.readFileSync(path.join(assetsRoot, name), "utf8")),
    ]))
    const calls = []
    return {
        calls,
        info() {
            return { source: "bundled" }
        },
        table(name) {
            calls.push(name)
            return tables[name]
        },
    }
}

test("loading the Shop catalog boundary does not load database modules", () => {
    assert.deepEqual(shopLoadBoundaryViolations, [])
})

test("Shop catalog exposes typed scopes and stable indexes without private overrides", () => {
    assert.equal(typeof buildShopCatalog, "function")
    const catalog = buildShopCatalog(repository())

    assert.equal(catalog.entries[`${ShopType.MANA}:200002`].scope.kind, "ordinary")
    assert.deepEqual(catalog.entries[`${ShopType.EVENT_ITEM}:310001`].scope, {
        kind: "event",
        eventType: 11,
        eventId: 700001,
        campaignId: 10,
        lineupId: 1010,
    })
    assert.deepEqual(catalog.entries[`${ShopType.BOSS_COIN}:410001`].scope, {
        kind: "bossCoin",
        categoryId: 5,
        campaignId: 20,
    })
    assert.equal(catalog.entries[`${ShopType.GENERAL}:220032`].listed, true)
    assert.equal(catalog.entries[`${ShopType.GENERAL}:999999`].listed, false)
    assert.equal(
        catalog.eventProductIds["11:700011"],
        undefined,
        "official-only catalog must not index private override products",
    )
    assert.equal(
        catalog.entries[`${ShopType.EVENT_ITEM}:310001`].periods.length,
        1,
        "official-only catalog must not bake compatibility periods into entries",
    )
    assert.deepEqual(catalog.equipmentGroupProductIds["3:21:5020042"], [700001, 700002])
    assert.deepEqual(catalog.rewardProductKeys["0:777"], [
        `${ShopType.GENERAL}:999999`,
        `${ShopType.EVENT_ITEM}:310001`,
    ])
    assert.deepEqual(catalog.campaignsByKey["4:10"], {
        shopType: ShopType.EVENT_ITEM,
        campaignId: 10,
        availableFromMs: shop.parseShopCnTimestamp("2024-01-01 00:00:00"),
        availableUntilMs: shop.parseShopCnTimestamp("2025-01-01 00:00:00"),
        lineupIds: [1010],
    })
    assert.deepEqual(catalog.eventCurrencyWindowsByItemId["70001"], [{
        fromMs: shop.parseShopCnTimestamp("2024-01-01 00:00:00"),
        untilMs: shop.parseShopCnTimestamp("2024-12-31 23:59:59"),
    }], "Rush compatibility must not become an official Event Currency window")
    assert.equal(Object.isFrozen(catalog), true)
    assert.equal(Object.isFrozen(catalog.entries), true)
    assert.equal(Object.isFrozen(catalog.entries[`${ShopType.EVENT_ITEM}:310001`]), true)
})

test("rush final-operation override composes at query time and never touches official rows", () => {
    const start = shop.parseShopCnTimestamp("2025-06-26 12:00:00")
    const end = shop.parseShopCnTimestamp("2025-08-14 23:59:59")
    const catalog = buildShopCatalog(repository())
    const key = `${ShopType.EVENT_ITEM}:310001`
    assert.equal(catalog.entries[key].periods.length, 1)

    assert.equal(RUSH_FINAL_OPERATION_OVERRIDE[700011].provenance, "PRIVATE_OVERRIDE")
    assert.equal(RUSH_FINAL_OPERATION_OVERRIDE[700011].sourceEventId, 700001)
    const override = resolveRushFinalOperationOverride(true)
    assert.equal(resolveRushFinalOperationOverride(false), null)

    assert.equal(
        resolveEffectiveShopOffer(catalog, ShopType.EVENT_ITEM, 310001, start, override).shopItemId,
        310001,
    )
    assert.equal(
        resolveEffectiveShopOffer(catalog, ShopType.EVENT_ITEM, 310001, end, override).shopItemId,
        310001,
    )
    assert.throws(
        () => resolveEffectiveShopOffer(catalog, ShopType.EVENT_ITEM, 310001, start - 1, override),
        error => error instanceof ShopOfferPeriodError,
    )
    assert.throws(
        () => resolveEffectiveShopOffer(catalog, ShopType.EVENT_ITEM, 310001, end + 1, override),
        error => error instanceof ShopOfferPeriodError,
    )
    assert.throws(
        () => resolveEffectiveShopOffer(catalog, ShopType.EVENT_ITEM, 310001, start),
        error => error instanceof ShopOfferPeriodError,
        "without the override the official period must reject final-operation purchases",
    )
    assert.equal(catalog.entries[key].periods.length, 1, "composition must not mutate the catalog")

    const targetView = selectShopSalesCatalogItems(catalog, {
        shopTypes: [],
        eventList: [{ eventType: 11, eventIds: [700011] }],
        bossCategoryIds: [],
    }, override)
    assert.deepEqual(Object.keys(targetView[ShopType.EVENT_ITEM] ?? {}), ["310001"])
    assert.deepEqual(
        targetView[ShopType.EVENT_ITEM]["310001"].compatibilityPeriods,
        [{ availableFrom: "2025-06-26 12:00:00", availableUntil: "2025-08-14 23:59:59" }],
    )
    const officialView = selectShopSalesCatalogItems(catalog, {
        shopTypes: [],
        eventList: [{ eventType: 11, eventIds: [700011] }],
        bossCategoryIds: [],
    }, null)
    assert.equal(officialView[ShopType.EVENT_ITEM], undefined)
    const disabledView = selectShopSalesCatalogItems(catalog, {
        shopTypes: [],
        eventList: [{ eventType: 11, eventIds: [700011] }],
        bossCategoryIds: [],
    }, resolveRushFinalOperationOverride(false))
    assert.equal(disabledView[ShopType.EVENT_ITEM], undefined)

    const targetTables = fixtureTables()
    targetTables["event_item_shop.json"]["11"]["700011"] = {
        "310999": item({ availableFrom: "2025-01-01 00:00:00" }),
    }
    const targetCatalog = buildShopCatalog(repository(targetTables))
    assert.deepEqual(targetCatalog.eventProductIds["11:700011"], [310999])
    assert.equal(targetCatalog.entries[key].periods.length, 1)
    assert.throws(
        () => resolveEffectiveShopOffer(
            targetCatalog,
            ShopType.EVENT_ITEM,
            310001,
            start,
            override,
        ),
        error => error instanceof ShopOfferPeriodError,
        "exact official target rows must win over the override",
    )
    const exactView = selectShopSalesCatalogItems(targetCatalog, {
        shopTypes: [],
        eventList: [{ eventType: 11, eventIds: [700011] }],
        bossCategoryIds: [],
    }, override)
    assert.deepEqual(Object.keys(exactView[ShopType.EVENT_ITEM]), ["310999"])
    assert.equal(exactView[ShopType.EVENT_ITEM]["310999"].compatibilityPeriods, undefined)
})

test("effective offer resolves CN UTC+8 month, row period and purchase discriminant", () => {
    assert.equal(typeof resolveEffectiveShopOffer, "function")
    const catalog = buildShopCatalog(repository())
    const august = Date.parse("2024-08-01T00:00:00.000Z")
    const offer = resolveEffectiveShopOffer(catalog, ShopType.GENERAL, 220032, august)
    assert.deepEqual(offer.item.costs, [
        { id: 40122, amount: 75 },
        { id: 40052, amount: 75 },
    ])
    assert.equal(offer.virtualMonthCn, 8)

    assert.throws(
        () => resolveEffectiveShopOffer(catalog, ShopType.SPECIAL_PACK, 200001, august),
        error => error instanceof ShopOfferNotPurchasableError,
    )
    assert.throws(
        () => resolveEffectiveShopOffer(
            catalog,
            ShopType.GENERAL,
            220032,
            Date.parse("2023-12-31T15:59:59.000Z"),
        ),
        error => error instanceof ShopOfferPeriodError,
    )
})

test("schedule selection is inclusive, host-timezone independent and fails closed on ambiguity", () => {
    const tables = fixtureTables()
    tables["general_shop.json"]["220032"].availableFrom = "2023-01-01 05:00:00"
    tables["shop_cost_item_schedule.json"].equipment_awaking_crystal_piece = [{
        availableFrom: "2024-08-01 00:00:00",
        availableUntil: "2024-08-31 23:59:59",
        month: 8,
        costs: [{ id: 1, amount: 1 }],
    }]
    const catalog = buildShopCatalog(repository(tables))
    const start = Date.parse("2024-07-31T16:00:00.000Z")
    const end = Date.parse("2024-08-31T15:59:59.000Z")
    assert.deepEqual(resolveEffectiveShopOffer(catalog, ShopType.GENERAL, 220032, start).item.costs, [{ id: 1, amount: 1 }])
    assert.deepEqual(resolveEffectiveShopOffer(catalog, ShopType.GENERAL, 220032, end).item.costs, [{ id: 1, amount: 1 }])
    assert.throws(
        () => resolveEffectiveShopOffer(catalog, ShopType.GENERAL, 220032, start - 1),
        error => error instanceof ShopOfferScheduleError,
    )
    assert.throws(
        () => resolveEffectiveShopOffer(catalog, ShopType.GENERAL, 220032, end + 1),
        error => error instanceof ShopOfferScheduleError,
    )
    assert.throws(
        () => resolveEffectiveShopOffer(catalog, ShopType.GENERAL, 220032, Date.parse("2024-10-01T00:00:00Z")),
        error => error instanceof ShopOfferScheduleError,
    )

    const ambiguousTables = fixtureTables()
    ambiguousTables["shop_cost_item_schedule.json"].equipment_awaking_crystal_piece.push({
        availableFrom: "2024-01-01 00:00:00",
        availableUntil: null,
        month: 8,
        costs: [{ id: 9, amount: 9 }],
    })
    const ambiguous = buildShopCatalog(repository(ambiguousTables))
    assert.throws(
        () => resolveEffectiveShopOffer(ambiguous, ShopType.GENERAL, 220032, Date.parse("2024-08-01T00:00:00Z")),
        error => error instanceof ShopOfferScheduleError,
    )

    const historyTables = fixtureTables()
    historyTables["shop_cost_item_schedule.json"].equipment_awaking_crystal_piece = [
        {
            availableFrom: "2023-08-01 00:00:00",
            availableUntil: "2023-08-31 23:59:59",
            month: 8,
            costs: [{ id: 3, amount: 3 }],
        },
        {
            availableFrom: "2024-08-01 00:00:00",
            availableUntil: "2024-08-31 23:59:59",
            month: 8,
            costs: [{ id: 4, amount: 4 }],
        },
        {
            availableFrom: "2024-09-01 00:00:00",
            availableUntil: "2024-09-30 23:59:59",
            month: 9,
            costs: [{ id: 5, amount: 5 }],
        },
    ]
    const history = buildShopCatalog(repository(historyTables))
    assert.deepEqual(
        resolveEffectiveShopOffer(history, ShopType.GENERAL, 220032, Date.parse("2024-08-31T15:59:59Z")).item.costs,
        [{ id: 4, amount: 4 }],
    )
    assert.deepEqual(
        resolveEffectiveShopOffer(history, ShopType.GENERAL, 220032, Date.parse("2024-08-31T16:00:00Z")).item.costs,
        [{ id: 5, amount: 5 }],
    )
})

test("catalog is built once per repository identity", () => {
    assert.equal(typeof getShopCatalog, "function")
    const source = repository()
    const first = getShopCatalog(source)
    const callsAfterFirst = source.calls.length
    const second = getShopCatalog(source)
    assert.strictEqual(second, first)
    assert.equal(source.calls.length, callsAfterFirst)

    const isolatedTables = fixtureTables()
    isolatedTables["general_shop.json"]["220032"].rewards = [{ type: 0, id: 999, count: 1 }]
    const isolatedSource = repository(isolatedTables)
    const isolated = getShopCatalog(isolatedSource)
    assert.notStrictEqual(isolated, first)
    assert.equal(isolated.entries[`${ShopType.GENERAL}:220032`].item.rewards[0].id, 999)
    assert.strictEqual(getShopCatalog(isolatedSource), isolated)
})

test("catalog rejects invalid navigation product invariants", () => {
    const wrongType = fixtureTables()
    wrongType["general_shop.json"]["220032"].purchaseKind = "specialExchangeLink"
    wrongType["general_shop.json"]["220032"].specialExchangeCampaignId = 1
    assert.throws(() => buildShopCatalog(repository(wrongType)), /Invalid special exchange link/)

    const missingCampaign = fixtureTables()
    missingCampaign["special_pack_shop.json"]["200001"].specialExchangeCampaignId = 0
    assert.throws(() => buildShopCatalog(repository(missingCampaign)), /Invalid special exchange link/)
})

test("catalog rejects malformed or dangling Campaign definitions", () => {
    const malformedPeriod = fixtureTables()
    malformedPeriod["shop_select_item_campaign.json"]["4"]["10"].availableFrom = "invalid"
    assert.throws(() => buildShopCatalog(repository(malformedPeriod)), /Invalid shop period/)

    const missingCampaign = fixtureTables()
    delete missingCampaign["shop_select_item_campaign.json"]["4"]["10"]
    assert.throws(() => buildShopCatalog(repository(missingCampaign)), /campaign does not exist/)

    const missingLineup = fixtureTables()
    missingLineup["shop_select_item_campaign.json"]["4"]["10"].lineupIds = [9999]
    assert.throws(() => buildShopCatalog(repository(missingLineup)), /lineup does not exist/)
})

test("runtime repository whitelist is the only General listing authority", () => {
    const tables = fixtureTables()
    tables["cdn_general_shop_whitelist.json"] = [999999]
    const catalog = buildShopCatalog(repository(tables))
    const selected = selectShopSalesCatalogItems(catalog, {
        shopTypes: [ShopType.GENERAL],
        eventList: [],
        bossCategoryIds: [],
    })
    assert.deepEqual(Object.keys(selected[ShopType.GENERAL]), ["999999"])
    const sales = buildShopSalesListSync({
        playerId: 1,
        itemsByType: selected,
        nowMs: Date.parse("2024-08-01T00:00:00Z"),
        isItemVisible: () => true,
    }, {
        getPurchaseCountsBulk: (_playerId, queries) => new Map(queries.map(query => [
            `${query.shopType}:${query.shopItemId}:${query.keys.daily}:${query.keys.monthly}`,
            { daily: 0, monthly: 0, total: 0 },
        ])),
    }).salesList
    assert.deepEqual(sales.map(sale => sale.shop_item_id), [999999])
})

test("bundled shop content builds one complete immutable catalog", () => {
    const source = bundledRepository()
    const buildStartedAt = performance.now()
    const catalog = buildShopCatalog(source)
    const buildDurationMs = performance.now() - buildStartedAt
    assert.equal(Object.keys(catalog.entries).length, 15488)
    assert.deepEqual(
        Object.fromEntries(Object.entries(catalog.productIdsByType).map(([type, ids]) => [type, ids.length])),
        { 2: 108, 3: 158, 4: 8532, 5: 3, 7: 6132, 8: 290, 9: 74, 10: 191 },
    )
    assert.equal(Object.keys(catalog.eventProductIds).length, 154)
    assert.equal(Object.keys(catalog.bossProductIds).length, 50)
    assert.equal(Object.keys(catalog.equipmentGroupProductIds).length, 29)
    assert.equal(Object.keys(catalog.rewardProductKeys).length, 812)
    assert.equal(Object.keys(catalog.scheduleRowsByMonth).length, 12)
    assert.equal(Object.keys(catalog.campaignsByKey).length, 6)
    assert.equal(Object.keys(catalog.eventCurrencyWindowsByItemId).length > 0, true)
    assert.equal(catalog.eventProductIds["11:700011"], undefined)
    assert.equal(Object.isFrozen(catalog.scheduleRowsByMonth), true)

    const special = catalog.productIdsByType[String(ShopType.SPECIAL_PACK)]
        .map(id => catalog.entries[`${ShopType.SPECIAL_PACK}:${id}`])
    const links = special.filter(entry => entry.kind === "specialExchangeLink")
    assert.equal(special.filter(entry => entry.kind === "purchase").length, 156)
    assert.deepEqual(links.map(entry => entry.specialExchangeCampaignId), [11, 12])
    for (const link of links) {
        assert.throws(
            () => resolveEffectiveShopOffer(catalog, ShopType.SPECIAL_PACK, link.shopItemId, Date.parse("2024-08-01T00:00:00Z")),
            error => error instanceof ShopOfferNotPurchasableError,
        )
    }
    assert.deepEqual(
        resolveEffectiveShopOffer(catalog, ShopType.GENERAL, 220032, Date.parse("2024-08-01T00:00:00Z")).item.costs,
        [{ id: 40122, amount: 75 }, { id: 40052, amount: 75 }],
    )
    assert.equal(catalog.entries[`${ShopType.GENERAL}:220032`].listed, true)
    assert.equal(catalog.productIdsByType[String(ShopType.GENERAL)]
        .every(id => catalog.entries[`${ShopType.GENERAL}:${id}`].listed === true), true)
    const rushItemId = catalog.eventProductIds["11:700001"][0]
    const rushEntry = catalog.entries[`${ShopType.EVENT_ITEM}:${rushItemId}`]
    assert.equal(rushEntry.periods.length, 1, "bundled catalog stays official-only")
    assert.equal(
        resolveEffectiveShopOffer(
            catalog,
            ShopType.EVENT_ITEM,
            rushItemId,
            shop.parseShopCnTimestamp("2025-07-01 12:00:00"),
            resolveRushFinalOperationOverride(true),
        ).shopItemId,
        rushItemId,
    )

    const lookupStartedAt = performance.now()
    for (let index = 0; index < 100_000; index++) {
        assert.ok(catalog.entries[`${ShopType.GENERAL}:220032`])
    }
    const lookupDurationMs = performance.now() - lookupStartedAt
    assert.ok(buildDurationMs < 2_000, `catalog build took ${buildDurationMs.toFixed(1)}ms`)
    assert.ok(lookupDurationMs < 500, `100k catalog lookups took ${lookupDurationMs.toFixed(1)}ms`)
    assert.equal(source.calls.length, 12)
})
