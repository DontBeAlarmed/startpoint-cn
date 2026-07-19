require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { canUseEquipmentAwakeningCrystal } = require("../src/lib/equipment-upgrade")

assert.equal(canUseEquipmentAwakeningCrystal(12001, 1), true)
assert.equal(canUseEquipmentAwakeningCrystal(12001, 4), true)
assert.equal(canUseEquipmentAwakeningCrystal(12001, 5), false)
assert.equal(canUseEquipmentAwakeningCrystal(12002, 5), true)
assert.equal(canUseEquipmentAwakeningCrystal(12002, 4), false)
assert.equal(canUseEquipmentAwakeningCrystal(100000, 5), false)
assert.equal(canUseEquipmentAwakeningCrystal(990008, 5), false)

console.log("inventory rule tests passed")
