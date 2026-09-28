"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { after, test } = require("node:test")

const { installFrozenTestContentSnapshot } = require("./helpers/content-snapshot-fixture.cjs")

const {
    getRushEventFolderClearRewards,
    resolveRushEventFolderClearRewards,
} = require("../src/lib/rush-event-content")
const {
    RUSH_FINAL_OPERATION_OVERRIDE,
    addRushFinalOperationCompatibilityPeriod,
    getRushFinalOperationOverrideEvent,
    getRushFinalOperationOverrideForSourceEvent,
    isRushFinalOperationOverridePurchaseCandidate,
    resolveRushFinalOperationOverride,
    resolveRushFinalOperationEventView,
    RUSH_EVENT_TYPE,
} = require("../src/lib/rush-final-operation-override")
const { buildShopCatalog } = require("../src/lib/shop/catalog")
const { selectShopSalesCatalogItems } = require("../src/lib/shop/sales-catalog")
const { ShopType } = require("../src/lib/types")

function folderTable() {
    return {
        700001: {
            1: [{ type: 0, id: 2370001, count: 75 }, { type: 0, id: 46, count: 4 }],
            2: [{ type: 0, id: 2370001, count: 150 }],
        },
        700002: { 1: [{ type: 3, count: 400 }] },
        700003: { 1: [{ type: 0, id: 2370003, count: 75 }] },
        700011: { 1: [], 2: [] },
        700013: { 1: [] },
    }
}

function installFolderSnapshot(tables) {
    const install = installFrozenTestContentSnapshot({
        targetVersion: "rush-override-fixture",
        tables: { "rush_event_quest_folder.json": tables },
    })
    after(install.restore)
    return install
}

const ENABLED = resolveRushFinalOperationOverride(true)
const DISABLED = resolveRushFinalOperationOverride(false)

test("override scope is limited to the explicit 700011-700017 target set", () => {
    assert.deepEqual(
        Object.keys(RUSH_FINAL_OPERATION_OVERRIDE).map(Number).sort((left, right) => left - right),
        [700011, 700012, 700013, 700014, 700015, 700016, 700017],
    )
    for (const [targetEventId, event] of Object.entries(RUSH_FINAL_OPERATION_OVERRIDE)) {
        assert.equal(Number(targetEventId) - event.sourceEventId, 10)
        assert.equal(event.provenance, "PRIVATE_OVERRIDE")
    }
    for (const outside of [700010, 700018, 700099, 700001, 0, -1]) {
        assert.equal(
            getRushFinalOperationOverrideEvent(ENABLED, outside),
            null,
            `${outside} must never be covered by the override`,
        )
    }
    assert.equal(DISABLED, null)
})

test("folder clear reward provenance distinguishes official content from the private override", () => {
    const folders = folderTable()
    folders[700017] = { 1: [] }
    const restore = installFolderSnapshot(folders)
    try {
        assert.deepEqual(
            resolveRushEventFolderClearRewards(700001, 1, ENABLED),
            {
                rewards: [{ type: 0, id: 2370001, count: 75 }, { type: 0, id: 46, count: 4 }],
                provenance: "OFFICIAL_CONTENT",
            },
            "non-empty official rows must win even with the override enabled",
        )
        assert.deepEqual(
            resolveRushEventFolderClearRewards(700011, 1, ENABLED),
            {
                rewards: [{ type: 0, id: 2370001, count: 75 }, { type: 0, id: 46, count: 4 }],
                provenance: "PRIVATE_OVERRIDE",
            },
        )
        assert.deepEqual(
            resolveRushEventFolderClearRewards(700013, 1, ENABLED),
            { rewards: [{ type: 0, id: 2370003, count: 75 }], provenance: "PRIVATE_OVERRIDE" },
            "700013 must map to its own 700003 source event",
        )
        assert.deepEqual(
            resolveRushEventFolderClearRewards(700011, 1, DISABLED),
            { rewards: [], provenance: "OFFICIAL_CONTENT" },
            "disabled policy must leave official late-period empty rewards observable",
        )
        assert.deepEqual(
            resolveRushEventFolderClearRewards(700011, 1, null),
            { rewards: [], provenance: "OFFICIAL_CONTENT" },
        )
        assert.deepEqual(
            resolveRushEventFolderClearRewards(700017, 1, ENABLED),
            { rewards: [], provenance: "OFFICIAL_CONTENT" },
            "an absent source row must not fabricate override content",
        )
        assert.deepEqual(
            resolveRushEventFolderClearRewards(700001, 1, DISABLED),
            {
                rewards: [{ type: 0, id: 2370001, count: 75 }, { type: 0, id: 46, count: 4 }],
                provenance: "OFFICIAL_CONTENT",
            },
            "official events with real content are never affected by the policy",
        )
        assert.equal(getRushEventFolderClearRewards(700011, 1, DISABLED), null)
        assert.deepEqual(getRushEventFolderClearRewards(700011, 1, ENABLED), [
            { type: 0, id: 2370001, count: 75 },
            { type: 0, id: 46, count: 4 },
        ])
    } finally {
        restore.restore()
    }
})

test("malformed official folder rows throw instead of silently falling back to private content", () => {
    const malformed = folderTable()
    malformed[700011][1] = { notAnArray: true }
    const restore = installFolderSnapshot(malformed)
    try {
        assert.throws(
            () => resolveRushEventFolderClearRewards(700011, 1, ENABLED),
            /Rush event folder clear rewards are invalid/,
        )
    } finally {
        restore.restore()
    }
})

test("missing official target event or folder throws instead of enabling private content", () => {
    const missingEvent = folderTable()
    delete missingEvent[700011]
    const missingEventSnapshot = installFolderSnapshot(missingEvent)
    try {
        assert.throws(
            () => resolveRushEventFolderClearRewards(700011, 1, ENABLED),
            /Rush event folder clear rewards are invalid/,
        )
    } finally {
        missingEventSnapshot.restore()
    }

    const missingFolder = folderTable()
    delete missingFolder[700011][1]
    const missingFolderSnapshot = installFolderSnapshot(missingFolder)
    try {
        assert.throws(
            () => resolveRushEventFolderClearRewards(700011, 1, ENABLED),
            /Rush event folder clear rewards are invalid/,
        )
    } finally {
        missingFolderSnapshot.restore()
    }
})

test("event view composition and item transforms stay out of the official catalog", () => {
    const shopItem = (overrides = {}) => ({
        costs: [],
        rewards: [],
        availableFrom: "2023-11-23 12:00:00",
        availableUntil: "2023-12-18 11:59:59",
        stock: 9,
        ...overrides,
    })
    const repository = {
        info: () => ({ source: "bundled" }),
        table(name) {
            const tables = {
                "shop_item_campaign.json": {},
                "shop_select_item_campaign.json": {},
                "cdn_general_shop_whitelist.json": [],
                "shop_cost_item_schedule.json": {},
                "treasure_shop.json": {},
                "special_pack_shop.json": {},
                "mana_shop.json": {},
                "general_shop.json": {},
                "star_grain_shop.json": {},
                "equipment_enhancement_shop.json": {},
                "event_item_shop.json": {
                    [String(RUSH_EVENT_TYPE)]: {
                        700001: { "310001": shopItem() },
                        700003: { "310003": shopItem() },
                    },
                },
                "boss_coin_shop.json": {},
            }
            return tables[name]
        },
    }
    const catalog = buildShopCatalog(repository)
    assert.equal(catalog.eventProductIds[`${RUSH_EVENT_TYPE}:700011`], undefined)
    assert.equal(catalog.entries[`${ShopType.EVENT_ITEM}:310001`].periods.length, 1)

    const withOverride = selectShopSalesCatalogItems(catalog, {
        shopTypes: [],
        eventList: [
            { eventType: RUSH_EVENT_TYPE, eventIds: [700011, 700013] },
            { eventType: 2, eventIds: [100006] },
        ],
        bossCategoryIds: [],
    }, ENABLED)
    assert.deepEqual(Object.keys(withOverride[ShopType.EVENT_ITEM] ?? {}).sort(), ["310001", "310003"])
    assert.deepEqual(
        withOverride[ShopType.EVENT_ITEM]["310001"].compatibilityPeriods,
        [{ availableFrom: "2025-06-26 12:00:00", availableUntil: "2025-08-14 23:59:59" }],
    )
    assert.equal(
        withOverride[ShopType.EVENT_ITEM]["310003"].compatibilityPeriods.length,
        1,
        "the second representative target event must compose too",
    )
    assert.equal(catalog.entries[`${ShopType.EVENT_ITEM}:310001`].periods.length, 1)
    assert.equal(
        catalog.entries[`${ShopType.EVENT_ITEM}:310001`].item.compatibilityPeriods,
        undefined,
        "composition must not mutate the frozen official catalog item",
    )

    const withoutOverride = selectShopSalesCatalogItems(catalog, {
        shopTypes: [],
        eventList: [{ eventType: RUSH_EVENT_TYPE, eventIds: [700011, 700013] }],
        bossCategoryIds: [],
    }, DISABLED)
    assert.equal(withoutOverride[ShopType.EVENT_ITEM], undefined)

    const otherEvent = selectShopSalesCatalogItems(catalog, {
        shopTypes: [],
        eventList: [{ eventType: RUSH_EVENT_TYPE, eventIds: [700001] }],
        bossCategoryIds: [],
    }, ENABLED)
    assert.deepEqual(
        Object.keys(otherEvent[ShopType.EVENT_ITEM]),
        ["310001"],
        "source event views keep their own official products",
    )

    assert.equal(
        getRushFinalOperationOverrideForSourceEvent(catalog, ENABLED, 700001) !== null,
        true,
    )
    assert.equal(
        getRushFinalOperationOverrideForSourceEvent(catalog, ENABLED, 700008),
        null,
        "source events outside the batch mapping are never overridden",
    )

    const transformed = addRushFinalOperationCompatibilityPeriod(
        shopItem(),
        RUSH_FINAL_OPERATION_OVERRIDE[700011],
    )
    assert.equal(transformed.compatibilityPeriods.length, 1)
    assert.equal(
        addRushFinalOperationCompatibilityPeriod(
            transformed,
            RUSH_FINAL_OPERATION_OVERRIDE[700011],
        ).compatibilityPeriods.length,
        1,
        "re-applying the same period must stay idempotent",
    )

    const view = resolveRushFinalOperationEventView(catalog, DISABLED, RUSH_EVENT_TYPE, 700011, [])
    assert.equal(view.itemTransform, null)
    assert.deepEqual(view.productIds, [])
})

test("purchase settings are only needed for mapped Rush source-event products", () => {
    const shopItem = () => ({
        costs: [],
        rewards: [],
        availableFrom: "2023-11-23 12:00:00",
        availableUntil: "2023-12-18 11:59:59",
        stock: 9,
    })
    const repository = {
        info: () => ({ source: "bundled" }),
        table(name) {
            const tables = {
                "shop_item_campaign.json": {},
                "shop_select_item_campaign.json": {},
                "cdn_general_shop_whitelist.json": [],
                "shop_cost_item_schedule.json": {},
                "treasure_shop.json": {},
                "special_pack_shop.json": {},
                "mana_shop.json": {},
                "general_shop.json": {},
                "star_grain_shop.json": {},
                "equipment_enhancement_shop.json": {},
                "event_item_shop.json": {
                    [String(RUSH_EVENT_TYPE)]: {
                        700001: { "310001": shopItem() },
                        700099: { "310099": shopItem() },
                    },
                },
                "boss_coin_shop.json": {},
            }
            return tables[name]
        },
    }
    const catalog = buildShopCatalog(repository)

    assert.equal(
        isRushFinalOperationOverridePurchaseCandidate(
            catalog,
            ShopType.EVENT_ITEM,
            [310001],
        ),
        true,
    )
    assert.equal(
        isRushFinalOperationOverridePurchaseCandidate(
            catalog,
            ShopType.EVENT_ITEM,
            [310099],
        ),
        false,
    )
    assert.equal(
        isRushFinalOperationOverridePurchaseCandidate(
            catalog,
            ShopType.GENERAL,
            [310001],
        ),
        false,
    )
})

test("hard multi final-operation events and 700099 are structurally outside the override", () => {
    for (const hardMulti of [1001, 1002, 1003, 1004, 1005, 1006]) {
        assert.equal(getRushFinalOperationOverrideEvent(ENABLED, hardMulti), null)
    }
    assert.equal(getRushFinalOperationOverrideEvent(ENABLED, 700099), null)
    assert.equal(RUSH_FINAL_OPERATION_OVERRIDE[700099], undefined)
})
