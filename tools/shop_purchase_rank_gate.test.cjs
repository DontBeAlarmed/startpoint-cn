"use strict"

// #11(双审 P2 落地):release_rank 服务端同门——改机客户端绕过 UI 拦截时,
// /shop/buy 必须拒绝 RANK 低于商品 release_rank 的购买。
// 帮助:装备强化「玩家等级达 90 解锁」;客户端 EquipmentEnhancementShop
// Values.parseAt24(col24) 与 OwnedOverLimit 同族 UI 门。

require("./test-workflow/bootstrap.cjs").bootstrap()

const assert = require("node:assert/strict")
const test = require("node:test")

const { prepareShopPurchase } = require("../src/lib/shop/purchase-plan")
const { ShopOfferNotPurchasableError } = require("../src/lib/shop/effective-offer")

const { ShopType } = require("../src/lib/types")
// CN: TREASURE_EQUIPMENT=10 承载特殊装备强化(帮助等级 90 门所在 shop_type)

const GOOD = {
    costs: [{ itemId: 990008, amount: 5 }],
    rewards: [{ type: 0, id: 14001, count: 1 }],
    availableFrom: "2020-01-01 00:00:00",
    availableUntil: null,
    stock: -1,
    releaseRank: 90,
    shopCategoryId: 1,
}

const CATALOG = {
    entries: {
        [`${ShopType.TREASURE_EQUIPMENT}:9001`]: {
            shopType: ShopType.TREASURE_EQUIPMENT,
            shopItemId: 9001,
            kind: "purchase",
            item: GOOD,
            periods: [{ availableFrom: "2020-01-01 00:00:00", availableUntil: null }],
            listed: true,
            scope: { kind: "equipment", shopCategoryId: 1 },
        },
    },
}

function plan(playerRank) {
    return prepareShopPurchase({
        catalog: CATALOG,
        shopType: ShopType.TREASURE_EQUIPMENT,
        entries: [{ shopItemId: 9001, purchaseAmount: 1 }],
        virtualNowMs: Date.parse("2024-08-14T12:00:00.000Z"),
        purchasePeriodNowMs: Date.parse("2024-08-14T12:00:00.000Z"),
        playerRank,
    })
}

test("release_rank gate rejects purchases below the item rank floor", () => {
    assert.throws(() => plan(89), ShopOfferNotPurchasableError)
    assert.throws(() => plan(1), ShopOfferNotPurchasableError)
})

test("release_rank gate lets equal-or-higher ranks through and omits undefined gates", () => {
    const prepared = plan(90)
    assert.equal(prepared.entries[0].shopItemId, 9001)
    assert.equal(prepared.entries[0].offer.item.releaseRank, 90)
    assert.ok(plan(162).entries.length === 1)
})
