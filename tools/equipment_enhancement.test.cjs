const assert = require("node:assert/strict")

let planEquipmentEnhancementPurchase
try {
    ({ planEquipmentEnhancementPurchase } = require("../out/lib/equipment-enhancement"))
} catch {
    assert.fail("equipment enhancement purchase planner is missing")
}

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

console.log("equipment enhancement tests passed")
