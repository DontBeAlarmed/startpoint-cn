"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

let planning
try {
    planning = require("../src/lib/shop/purchase-plan")
} catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error
    planning = {}
}
const {
    completeShopPurchasePlan,
    prepareShopPurchase,
    validateShopItemCostBalances,
    InvalidShopPurchaseCommandError,
    ShopPurchaseArithmeticError,
    ShopPurchaseBalancePlanError,
    ShopPurchaseLimitPlanError,
} = planning
const {
    RewardType,
    ShopItemRewardType,
    ShopItemUserCostType,
    ShopType,
} = require("../src/lib/types")
const { buildShopCatalog, ShopOfferPeriodError } = require("../src/lib/shop")

function shopItem(overrides = {}) {
    return {
        costs: [],
        rewards: [],
        availableFrom: "2024-01-01 00:00:00",
        availableUntil: null,
        stock: -1,
        ...overrides,
    }
}

function catalog(items) {
    return {
        entries: Object.fromEntries(Object.entries(items).map(([id, item]) => [
            `${ShopType.EVENT_ITEM}:${id}`,
            {
                kind: "purchase",
                shopType: ShopType.EVENT_ITEM,
                shopItemId: Number(id),
                item,
                periods: [{
                    availableFrom: item.availableFrom,
                    availableUntil: item.availableUntil,
                }],
                listed: true,
                scope: { kind: "event", eventType: 4, eventId: 100001 },
            },
        ])),
        productIdsByType: {},
        eventProductIds: {},
        bossProductIds: {},
        equipmentGroupProductIds: {},
        rewardProductKeys: {},
        scheduleRowsByMonth: {},
    }
}

function player(overrides = {}) {
    return {
        vmoney: 100,
        freeVmoney: 50,
        paidMana: 100,
        freeMana: 150,
        bondToken: 20,
        expPool: 0,
        ...overrides,
    }
}

function prepare(items, entries, overrides = {}) {
    return prepareShopPurchase({
        catalog: catalog(items),
        shopType: ShopType.EVENT_ITEM,
        entries,
        virtualNowMs: Date.parse("2024-08-01T00:00:00Z"),
        purchasePeriodNowMs: Date.parse("2024-08-01T00:00:00Z"),
        resetHour: 5,
        ...overrides,
    })
}

function countsFor(prepared, values = {}) {
    return new Map(prepared.purchaseQueries.map(query => [
        query.key,
        values[query.shopItemId] ?? { daily: 0, monthly: 0, total: 0 },
    ]))
}

test("single is a one-entry batch and bulk uses canonical numeric order", () => {
    assert.equal(typeof prepareShopPurchase, "function")
    const items = {
        101: shopItem(),
        102: shopItem(),
    }
    const single = prepare(items, [{ shopItemId: 101, purchaseAmount: 1 }])
    const batch = prepare(items, [
        { shopItemId: 102, purchaseAmount: 2 },
        { shopItemId: 101, purchaseAmount: 1 },
    ])
    assert.deepEqual(single.entries.map(entry => entry.shopItemId), [101])
    assert.deepEqual(batch.entries.map(entry => entry.shopItemId), [101, 102])
    assert.deepEqual(single.purchaseQueries[0], {
        shopType: ShopType.EVENT_ITEM,
        shopItemId: 101,
        keys: { daily: "2024-08-01", monthly: "2024-08" },
        key: `${ShopType.EVENT_ITEM}:101:2024-08-01:2024-08`,
    })

    const singlePlan = completeShopPurchasePlan(single, {
        player: player(),
        purchaseCounts: countsFor(single),
        itemBalances: {},
    })
    assert.deepEqual(singlePlan.entries.map(entry => entry.shopItemId), [101])
})

test("period and every product limit are validated before rewards expand", () => {
    const expired = {
        101: shopItem({ availableUntil: "2024-01-31 23:59:59" }),
    }
    assert.throws(
        () => prepare(expired, [{ shopItemId: 101, purchaseAmount: 1 }]),
        error => error instanceof ShopOfferPeriodError,
    )

    const items = {
        101: shopItem({
            stock: 1,
            rewards: [{ type: ShopItemRewardType.CHARACTER, id: 151001 }],
        }),
    }
    const prepared = prepare(items, [{
        shopItemId: 101,
        purchaseAmount: Number.MAX_SAFE_INTEGER,
    }])
    assert.throws(
        () => completeShopPurchasePlan(prepared, {
            player: player(),
            purchaseCounts: countsFor(prepared),
            itemBalances: {},
        }),
        error => error instanceof ShopPurchaseLimitPlanError,
    )

    const unbounded = prepare({
        101: shopItem({
            rewards: [{ type: ShopItemRewardType.CHARACTER, id: 151001 }],
        }),
    }, [{ shopItemId: 101, purchaseAmount: 1 }])
    assert.throws(
        () => completeShopPurchasePlan(unbounded, {
            player: player(),
            purchaseCounts: countsFor(unbounded),
            itemBalances: {},
        }),
        error => error instanceof ShopPurchaseArithmeticError,
    )
})

test("plan aggregates payment, item costs, ordered rewards and write intents", () => {
    const items = {
        101: shopItem({
            stock: 5,
            maxFrequency: 5,
            userCost: { type: ShopItemUserCostType.MANA, amount: 100 },
            costs: [{ id: 10, amount: 3 }],
            rewards: [
                { type: ShopItemRewardType.ITEM, id: 10, count: 2 },
                { type: ShopItemRewardType.CHARACTER, id: 151001 },
            ],
            passCardPoints: 4,
        }),
        102: shopItem({
            userCost: { type: ShopItemUserCostType.BEADS, amount: 20 },
            costs: [{ id: 10, amount: 5 }, { id: 20, amount: 1 }],
            rewards: [{ type: ShopItemRewardType.MANA, count: 30 }],
        }),
    }
    const prepared = prepare(items, [
        { shopItemId: 101, purchaseAmount: 2 },
        { shopItemId: 102, purchaseAmount: 1 },
    ])
    const plan = completeShopPurchasePlan(prepared, {
        player: player(),
        purchaseCounts: countsFor(prepared, {
            101: { daily: 1, monthly: 1, total: 1 },
        }),
        itemBalances: { 10: 100, 20: 100 },
    })

    assert.deepEqual(plan.playerAfterPayment, {
        vmoney: 100,
        freeVmoney: 30,
        paidMana: 50,
        freeMana: 0,
        bondToken: 20,
        expPool: 0,
    })
    assert.equal(plan.manaSpent, 200)
    assert.deepEqual(plan.itemCosts, [
        { itemId: 10, amount: 11 },
        { itemId: 20, amount: 1 },
    ])
    assert.deepEqual(plan.preloadItemIds, [10, 20])
    assert.deepEqual(plan.rewards, [
        { type: RewardType.ITEM, id: 10, count: 4 },
        { type: RewardType.CHARACTER, id: 151001 },
        { type: RewardType.CHARACTER, id: 151001 },
        { type: RewardType.MANA, count: 30 },
    ])
    assert.deepEqual(plan.effects, [
        { kind: "passCardPoint", shopItemId: 101, points: 8 },
        { kind: "standard", shopItemId: 102 },
    ])
    assert.deepEqual(plan.purchaseCountIntents.map(intent => ({
        shopItemId: intent.shopItemId,
        amount: intent.amount,
        currentTotal: intent.beforeCounts.total,
    })), [
        { shopItemId: 101, amount: 2, currentTotal: 1 },
        { shopItemId: 102, amount: 1, currentTotal: 0 },
    ])
    assert.equal(Object.isFrozen(plan), true)
})

test("every product limit is validated before any player balance", () => {
    const items = {
        101: shopItem({ userCost: { type: ShopItemUserCostType.MANA, amount: 1_000 } }),
        102: shopItem({ maxFrequency: 1 }),
    }
    const prepared = prepare(items, [
        { shopItemId: 101, purchaseAmount: 1 },
        { shopItemId: 102, purchaseAmount: 1 },
    ])
    assert.throws(
        () => completeShopPurchasePlan(prepared, {
            player: player({ freeMana: 0, paidMana: 0 }),
            purchaseCounts: countsFor(prepared, {
                102: { daily: 0, monthly: 0, total: 1 },
            }),
            itemBalances: {},
        }),
        error => error instanceof ShopPurchaseLimitPlanError,
    )
})

test("stock, daily, monthly and total limits share one validation rule", () => {
    const cases = [
        { item: { stock: 1 }, counts: { daily: 0, monthly: 0, total: 0 } },
        { item: { dailyStock: 1 }, counts: { daily: 1, monthly: 0, total: 0 } },
        { item: { monthlyStock: 1 }, counts: { daily: 0, monthly: 1, total: 0 } },
        { item: { maxFrequency: 1 }, counts: { daily: 0, monthly: 0, total: 1 } },
    ]
    for (const entry of cases) {
        const prepared = prepare(
            { 101: shopItem(entry.item) },
            [{ shopItemId: 101, purchaseAmount: entry.item.stock === 1 ? 2 : 1 }],
        )
        assert.throws(
            () => completeShopPurchasePlan(prepared, {
                player: player(),
                purchaseCounts: countsFor(prepared, { 101: entry.counts }),
                itemBalances: {},
            }),
            error => error instanceof ShopPurchaseLimitPlanError,
        )
    }
})

test("paid-only beads and Bond Token payments produce absolute after-state", () => {
    const items = {
        101: shopItem({ userCost: { type: ShopItemUserCostType.AMITY_SCROLL, amount: 3 } }),
        102: shopItem({ userCost: { type: ShopItemUserCostType.PAID_BEADS, amount: 30 } }),
    }
    const prepared = prepare(items, [
        { shopItemId: 102, purchaseAmount: 2 },
        { shopItemId: 101, purchaseAmount: 2 },
    ])
    const plan = completeShopPurchasePlan(prepared, {
        player: player(),
        purchaseCounts: countsFor(prepared),
        itemBalances: {},
    })
    assert.equal(plan.playerAfterPayment.bondToken, 14)
    assert.equal(plan.playerAfterPayment.vmoney, 40)
    assert.equal(plan.playerAfterPayment.freeVmoney, 50)
})

test("virtual offer time and real purchase-count time remain independent", () => {
    const prepared = prepare(
        { 101: shopItem() },
        [{ shopItemId: 101, purchaseAmount: 1 }],
        {
            virtualNowMs: Date.parse("2024-08-01T00:00:00Z"),
            purchasePeriodNowMs: Date.parse("2026-08-26T20:59:59Z"),
            resetHour: 5,
        },
    )
    assert.deepEqual(prepared.purchaseQueries[0].keys, {
        daily: "2026-08-26",
        monthly: "2026-08",
    })
})

test("planner never freezes or embeds the data-layer purchase snapshot", () => {
    const prepared = prepare(
        { 101: shopItem() },
        [{ shopItemId: 101, purchaseAmount: 1 }],
    )
    const metadata = Symbol("legacy")
    const rawSnapshot = { daily: 1, monthly: 2, total: 3, [metadata]: { firstTouch: true } }
    const plan = completeShopPurchasePlan(prepared, {
        player: player(),
        purchaseCounts: new Map([[prepared.purchaseQueries[0].key, rawSnapshot]]),
        itemBalances: {},
    })
    const intent = plan.purchaseCountIntents[0]
    assert.equal(Object.isFrozen(rawSnapshot), false)
    assert.deepEqual(rawSnapshot[metadata], { firstTouch: true })
    assert.equal(intent.snapshotKey, prepared.purchaseQueries[0].key)
    assert.deepEqual(intent.beforeCounts, { daily: 1, monthly: 2, total: 3 })
    assert.deepEqual(intent.afterCounts, { daily: 2, monthly: 3, total: 4 })
    assert.equal("currentCounts" in intent, false)
})

test("same item reward cannot fund its cost", () => {
    const items = {
        101: shopItem({
            costs: [{ id: 10, amount: 5 }],
            rewards: [{ type: ShopItemRewardType.ITEM, id: 10, count: 100 }],
        }),
    }
    const prepared = prepare(items, [{ shopItemId: 101, purchaseAmount: 1 }])
    assert.throws(
        () => completeShopPurchasePlan(prepared, {
            player: player(),
            purchaseCounts: countsFor(prepared),
            itemBalances: { 10: 4 },
        }),
        error => error instanceof ShopPurchaseBalancePlanError,
    )
    const plan = completeShopPurchasePlan(prepared, {
        player: player(),
        purchaseCounts: countsFor(prepared),
        itemBalances: { 10: 5 },
    })
    assert.deepEqual(plan.rewards, [{ type: RewardType.ITEM, id: 10, count: 100 }])
    assert.doesNotThrow(() => validateShopItemCostBalances(plan, { 10: 5 }))
})

test("all multiplication and aggregation fail closed outside safe integers", () => {
    const items = {
        101: shopItem({ costs: [{ id: 10, amount: 2 }] }),
    }
    const prepared = prepare(items, [{
        shopItemId: 101,
        purchaseAmount: Number.MAX_SAFE_INTEGER,
    }])
    assert.throws(
        () => completeShopPurchasePlan(prepared, {
            player: player(),
            purchaseCounts: countsFor(prepared),
            itemBalances: { 10: Number.MAX_SAFE_INTEGER },
        }),
        error => error instanceof ShopPurchaseArithmeticError,
    )
})

test("all Item cost arithmetic and balances precede reward materialization", () => {
    const items = {
        101: shopItem({
            stock: 3,
            rewards: [{ type: ShopItemRewardType.CHARACTER, id: 151001 }],
        }),
        102: shopItem({ costs: [{ id: 10, amount: Number.MAX_SAFE_INTEGER }] }),
    }
    const prepared = prepare(items, [
        { shopItemId: 101, purchaseAmount: 3 },
        { shopItemId: 102, purchaseAmount: 2 },
    ])
    assert.throws(
        () => completeShopPurchasePlan(prepared, {
            player: player(),
            purchaseCounts: countsFor(prepared),
            itemBalances: { 10: Number.MAX_SAFE_INTEGER },
        }),
        error => error instanceof ShopPurchaseArithmeticError,
    )
})

test("equipment product becomes a typed effect instead of a reward", () => {
    const item = shopItem({
        shopCategoryId: 3,
        groupId: 21,
        stage: 2,
        equipmentId: 5020042,
        enhancementMaxLevel: 70,
        requireAwakeningLevel: 5,
    })
    const equipmentCatalog = catalog({ 700002: item })
    const entry = equipmentCatalog.entries[`${ShopType.EVENT_ITEM}:700002`]
    delete equipmentCatalog.entries[`${ShopType.EVENT_ITEM}:700002`]
    entry.shopType = ShopType.TREASURE_EQUIPMENT
    entry.scope = {
        kind: "equipmentEnhancement",
        categoryId: 3,
        groupId: 21,
        equipmentId: 5020042,
    }
    equipmentCatalog.entries[`${ShopType.TREASURE_EQUIPMENT}:700002`] = entry
    const prepared = prepareShopPurchase({
        catalog: equipmentCatalog,
        shopType: ShopType.TREASURE_EQUIPMENT,
        entries: [{ shopItemId: 700002, purchaseAmount: 1 }],
        virtualNowMs: Date.parse("2024-08-01T00:00:00Z"),
        purchasePeriodNowMs: Date.parse("2024-08-01T00:00:00Z"),
    })
    const plan = completeShopPurchasePlan(prepared, {
        player: player(),
        purchaseCounts: countsFor(prepared),
        itemBalances: {},
    })
    assert.deepEqual(plan.effects, [{
        kind: "equipmentEnhancement",
        shopItemId: 700002,
        equipmentId: 5020042,
        stage: 2,
        enhancementMaxLevel: 70,
        requireAwakeningLevel: 5,
        purchaseAmount: 1,
    }])
})

test("empty, invalid and duplicate commands are server-boundary guards", () => {
    const items = { 101: shopItem() }
    assert.throws(
        () => prepare(items, []),
        error => error instanceof InvalidShopPurchaseCommandError,
    )
    assert.throws(
        () => prepare(items, [
            { shopItemId: 101, purchaseAmount: 1 },
            { shopItemId: 101, purchaseAmount: 1 },
        ]),
        error => error instanceof InvalidShopPurchaseCommandError,
    )
    assert.throws(
        () => prepare(items, [{ shopItemId: 101, purchaseAmount: 0 }]),
        error => error instanceof InvalidShopPurchaseCommandError,
    )
    for (const purchasePeriodNowMs of [
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.MAX_VALUE,
        8_640_000_000_000_001,
    ]) {
        assert.throws(
            () => prepare(items, [{ shopItemId: 101, purchaseAmount: 1 }], {
                purchasePeriodNowMs,
            }),
            error => error instanceof InvalidShopPurchaseCommandError,
        )
    }
    for (const resetHour of [-1, 24, 1.5]) {
        assert.throws(
            () => prepare(items, [{ shopItemId: 101, purchaseAmount: 1 }], { resetHour }),
            error => error instanceof InvalidShopPurchaseCommandError,
        )
    }
    for (const resetHour of [0, 5, 23]) {
        assert.doesNotThrow(
            () => prepare(items, [{ shopItemId: 101, purchaseAmount: 1 }], { resetHour }),
        )
    }
    assert.throws(
        () => prepareShopPurchase({
            catalog: catalog(items),
            shopType: ShopType.GENERAL,
            entries: [
                { shopItemId: 101, purchaseAmount: 1 },
                { shopItemId: 102, purchaseAmount: 1 },
            ],
            virtualNowMs: Date.parse("2024-08-01T00:00:00Z"),
            purchasePeriodNowMs: Date.parse("2024-08-01T00:00:00Z"),
        }),
        error => error instanceof InvalidShopPurchaseCommandError,
    )
})

test("every bundled Character product has an authoritative finite limit", () => {
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
    const bundled = buildShopCatalog({
        info: () => ({ source: "bundled" }),
        table: name => tables[name],
    })
    const characterProducts = Object.values(bundled.entries).filter(entry => (
        entry.kind === "purchase"
        && entry.item.rewards.some(reward => reward.type === ShopItemRewardType.CHARACTER)
    ))
    assert.equal(characterProducts.length, 52)
    assert.equal(characterProducts.every(entry => (
        entry.item.stock >= 0
        || entry.item.dailyStock !== undefined
        || entry.item.monthlyStock !== undefined
        || entry.item.maxFrequency !== undefined
    )), true)
})
