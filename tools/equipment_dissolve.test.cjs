"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    installBundledGameplaySnapshot,
} = require("./helpers/install-bundled-gameplay-snapshot.cjs")

const restoreContentSnapshot = installBundledGameplaySnapshot()
test.after(restoreContentSnapshot)

const { calculateDissolveRewards } = require("../src/lib/equipment-dissolve")

const equipmentId = 5020043

assert.deepEqual(
    calculateDissolveRewards(equipmentId, 1).abilitySouls,
    {},
    "stack and bulk sale paths follow the CDN generate_ability_soul flag",
)
const soulEquipmentId = 3020003
assert.deepEqual(
    calculateDissolveRewards(soulEquipmentId, 3).abilitySouls,
    { [soulEquipmentId]: 3 },
    "dissolving three soul-producing equipment units grants three souls",
)

console.log("equipment dissolve tests passed")
