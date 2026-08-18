"use strict"

const assert = require("node:assert/strict")
const {
    postCnRequest,
    requireSuccessfulCnResponse,
} = require("./non_multi_mixed_http.cjs")

const SHOP_TYPE = 8
const SHOP_ITEM_ID = 100001
const SHOP_REWARD_EQUIPMENT_ID = 5010005

function requireState(context, name, identity) {
    const inspect = context.inspectShopIdentity
    if (typeof inspect !== "function") throw new TypeError("shop scenario requires context.inspectShopIdentity")
    const state = inspect(identity)
    assert.ok(Number.isSafeInteger(state?.bondToken), `${name} bondToken`)
    assert.ok(Number.isSafeInteger(state?.purchaseCount), `${name} purchaseCount`)
    assert.ok(Number.isSafeInteger(state?.rewardEquipmentCount), `${name} rewardEquipmentCount`)
    return state
}

async function fetchSalesList(app, identity, label) {
    const response = await postCnRequest(app, "/api/index.php/shop/get_sales_list", {
        viewer_id: identity.viewerId,
        api_count: 1,
        shop_types: [SHOP_TYPE],
        boss_coin_shop_category_ids: [],
        equipment_enhancement_shop_category_ids: [],
        event_list: [],
    })
    const payload = requireSuccessfulCnResponse(response, label)
    assert.equal(payload.data_headers?.viewer_id, identity.viewerId)
    const salesList = payload.data?.sales_list
    assert.ok(Array.isArray(salesList) && salesList.length > 0, "shop sales_list must be non-empty")
    return salesList
}

async function executeShopScenario(app, identity, context = {}) {
    if (typeof context.prepareShopIdentity !== "function") {
        throw new TypeError("shop scenario requires context.prepareShopIdentity")
    }
    if (!context.skipPrepare) context.prepareShopIdentity(identity)
    const before = requireState(context, "shop before", identity)

    const salesList = await fetchSalesList(app, identity, "shop list")
    const selected = salesList.find(item => (
        item?.shop_type === SHOP_TYPE && item?.shop_item_id === SHOP_ITEM_ID
    ))
    assert.ok(selected, "shop fixture item must be listed")
    assert.equal(selected.stock_quantity, 1)
    assert.equal(selected.total_purchase_num, 0)

    const buyResponse = await postCnRequest(app, "/api/index.php/shop/buy", {
        viewer_id: identity.viewerId,
        api_count: 1,
        shop_type: SHOP_TYPE,
        shop_item_id: SHOP_ITEM_ID,
        number: 1,
    })
    const buyPayload = requireSuccessfulCnResponse(buyResponse, "shop buy")
    assert.equal(buyPayload.data_headers?.viewer_id, identity.viewerId)
    const after = requireState(context, "shop after", identity)
    assert.equal(after.bondToken, before.bondToken - 50)
    assert.equal(after.purchaseCount, before.purchaseCount + 1)
    assert.equal(after.rewardEquipmentCount, before.rewardEquipmentCount + 1)
    assert.equal(buyPayload.data?.user_info?.bond_token, after.bondToken)
    assert.ok(Array.isArray(buyPayload.data?.equipment_list), "shop equipment_list must be an array")
    assert.equal(
        buyPayload.data.equipment_list.some(equipment => (
            equipment?.equipment_id === SHOP_REWARD_EQUIPMENT_ID
        )),
        true,
        "shop buy response must contain the purchased equipment",
    )
    const salesAfter = await fetchSalesList(app, identity, "shop list after buy")
    const selectedAfter = salesAfter.find(item => (
        item?.shop_type === SHOP_TYPE && item?.shop_item_id === SHOP_ITEM_ID
    ))
    assert.ok(selectedAfter, "purchased shop fixture item must remain listed")
    assert.equal(selectedAfter.stock_quantity, 0)
    assert.equal(selectedAfter.total_purchase_num, 1)

    return {
        entry: "shop",
        adapter: "fastify-route:/api/index.php/shop/get_sales_list->buy->get_sales_list",
        statusCode: buyResponse.statusCode,
        resultCode: buyPayload.data_headers.result_code,
        salesCount: salesList.length,
        shopType: SHOP_TYPE,
        shopItemId: SHOP_ITEM_ID,
        currency: {
            kind: "bond-token",
            before: before.bondToken,
            after: after.bondToken,
            spent: before.bondToken - after.bondToken,
        },
        stock: {
            before: selected.stock_quantity,
            after: selectedAfter.stock_quantity,
            purchaseCountAfter: after.purchaseCount,
        },
        reward: {
            equipmentId: SHOP_REWARD_EQUIPMENT_ID,
            equipmentCountAfter: after.rewardEquipmentCount,
        },
    }
}

module.exports = {
    SHOP_ITEM_ID,
    SHOP_REWARD_EQUIPMENT_ID,
    SHOP_TYPE,
    executeShopScenario,
}
