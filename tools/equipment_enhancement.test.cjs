require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

let planEquipmentEnhancementPurchase
try {
    ({ planEquipmentEnhancementPurchase } = require("../src/lib/equipment-enhancement"))
} catch {
    assert.fail("equipment enhancement purchase planner is missing")
}
const {
    recordEquipmentEnhancementPurchaseSync,
} = require("../src/lib/event-shop-purchase")

assert.deepEqual(planEquipmentEnhancementPurchase(1, 1, 69, 5, 5), {
    ok: true,
    newLevel: 2,
})
assert.deepEqual(planEquipmentEnhancementPurchase(1, 68, 69, 5, 5), {
    ok: true,
    newLevel: 69,
})
assert.deepEqual(planEquipmentEnhancementPurchase(1, 69, 69, 5, 5), {
    ok: false,
    message: "Enhancement purchase exceeds the current stage."
})
assert.deepEqual(planEquipmentEnhancementPurchase(1, 1, 69, 4, 5), {
    ok: false,
    message: "Equipment awakening level is too low."
})
assert.deepEqual(planEquipmentEnhancementPurchase(1, 1.5, 69, 5, 5), {
    ok: false,
    message: "Invalid enhancement purchase amount."
})

assert.equal(
    typeof recordEquipmentEnhancementPurchaseSync,
    "function",
    "equipment enhancement route must use an executable purchase-count unit",
)
{
    const periodKeys = { daily: "2024-08-14", monthly: "specified:2024-07" }
    const periodCalls = []
    const addCalls = []
    const result = recordEquipmentEnhancementPurchaseSync({
        playerId: 7,
        shopType: 10,
        shopItemId: 2001,
        purchaseAmount: 68,
        nowMs: Date.parse("2024-08-14T04:00:00Z"),
        specifiedMonths: [1, 7],
    }, {
        getShopPurchasePeriodKeys(nowMs, specifiedMonths) {
            periodCalls.push({ nowMs, specifiedMonths })
            return periodKeys
        },
        addPurchaseCounts(playerId, shopType, shopItemId, amount, keys) {
            addCalls.push({ playerId, shopType, shopItemId, amount, keys })
            return { daily: 68, monthly: 68, total: 68 }
        },
    })

    assert.deepEqual(result, { daily: 68, monthly: 68, total: 68 })
    assert.equal(periodCalls.length, 1)
    assert.equal(addCalls.length, 1)
    assert.deepEqual(addCalls[0], {
        playerId: 7,
        shopType: 10,
        shopItemId: 2001,
        amount: 68,
        keys: periodKeys,
    })
}

const shopRouteSource = fs.readFileSync(
    path.join(__dirname, "../src/routes/api/shop.ts"),
    "utf8",
)
const enhancementTransaction = shopRouteSource.match(
    /\/\/ Equipment enhancement shop: update equipment enhancement level[\s\S]*?getDb\(\)\.transaction\(\(\) => \{([\s\S]*?)\n\s*\}\)\(\)/,
)?.[1]
assert.ok(enhancementTransaction, "equipment enhancement transaction must remain discoverable")
assert.equal(
    (enhancementTransaction.match(/recordEquipmentEnhancementPurchaseSync\(/g) ?? []).length,
    1,
    "successful TREASURE_EQUIPMENT transaction must call the production counter unit once",
)
assert.equal(
    (enhancementTransaction.match(/addPlayerShopPurchaseCountsByTypeSync\(/g) ?? []).length,
    0,
    "equipment enhancement route must not call the counter domain directly",
)
assert.doesNotMatch(
    enhancementTransaction,
    /for\s*\([^)]*purchaseAmount[^)]*\)/,
    "equipment enhancement route must not loop over purchaseAmount",
)

console.log("equipment enhancement tests passed")
