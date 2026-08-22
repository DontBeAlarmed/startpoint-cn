"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")
const { buildShopSalesListSync } = require("../src/lib/shop-sales-list")
const { ShopType } = require("../src/lib/types")

const AVAILABLE_FROM = "1970-01-01 00:00:00"
const SHOP_TYPE = 2
const item = (overrides = {}) => ({
    costs: [],
    rewards: [],
    availableFrom: AVAILABLE_FROM,
    availableUntil: null,
    stock: -1,
    ...overrides,
})

test("shop sales list uses one bulk purchase-count read for visible items", () => {
    const bulkRequests = []
    let individualReads = 0
    const countsByKey = new Map([
        [`${SHOP_TYPE}:101:2024-08-14:2024-08`, { daily: 1, monthly: 2, total: 4 }],
        [`${SHOP_TYPE}:102:2024-08-14:2024-08`, { daily: 0, monthly: 0, total: 2 }],
    ])
    const result = buildShopSalesListSync({
        playerId: 7,
        nowMs: Date.parse("2024-08-14T00:00:00.000Z"),
        itemsByType: {
            [SHOP_TYPE]: {
                101: item({ dailyStock: 3, monthlyStock: 10, maxFrequency: 20 }),
                102: item({ maxFrequency: 5 }),
            },
        },
        isItemVisible: () => true,
    }, {
        getPurchaseCounts() {
            individualReads++
            throw new Error("individual purchase-count reads must not be used")
        },
        getPurchaseCountsBulk(_playerId, requests) {
            bulkRequests.push(requests)
            return new Map(requests.map(request => [
                `${request.shopType}:${request.shopItemId}:${request.keys.daily}:${request.keys.monthly}`,
                countsByKey.get(`${request.shopType}:${request.shopItemId}:2024-08-14:2024-08`),
            ]))
        },
    })

    assert.equal(individualReads, 0)
    assert.equal(bulkRequests.length, 1)
    assert.deepEqual(
        bulkRequests[0].map(request => [request.shopType, request.shopItemId]),
        [[SHOP_TYPE, 101], [SHOP_TYPE, 102]],
    )
    assert.deepEqual(
        result.salesList.map(sale => [sale.shop_item_id, sale.stock_quantity, sale.total_purchase_num]),
        [[101, 2, 4], [102, 3, 2]],
    )
})

test("equipment enhancement groups remain isolated across shop categories", () => {
    const result = buildShopSalesListSync({
        playerId: 7,
        nowMs: Date.parse("2024-10-15T18:02:19.000Z"),
        equipmentEnhancementCategoryIds: [1, 3],
        itemsByType: {
            [ShopType.TREASURE_EQUIPMENT]: {
                101: item({
                    shopCategoryId: 1,
                    groupId: 21,
                    stage: 1,
                    equipmentId: 5020040,
                    enhancementMaxLevel: 1,
                }),
                301: item({
                    shopCategoryId: 3,
                    groupId: 21,
                    stage: 1,
                    equipmentId: 5020042,
                    enhancementMaxLevel: 1,
                }),
            },
        },
        isItemVisible: () => true,
    }, {
        getEquipmentEnhancementLevel(_playerId, equipmentId) {
            return equipmentId === 5020042 ? 0 : -1
        },
    })

    assert.deepEqual(
        result.salesList.map(sale => sale.shop_item_id).sort((left, right) => left - right),
        [101, 301],
        "the same groupId in another category must not replace or merge a different equipment",
    )
})
