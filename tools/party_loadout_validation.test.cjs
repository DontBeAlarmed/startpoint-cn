require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const {
    validatePartyLoadouts,
} = require("../src/lib/party-loadout-validation")

function party(equipmentIds, abilitySoulIds) {
    return { equipment_ids: equipmentIds, ability_soul_ids: abilitySoulIds }
}

const inventory = {
    equipments: {
        "5010001": { stack: 3 },
        "5010002": { stack: 0 },
    },
    items: {
        "5010101": 2,
        "5010102": 1,
    },
}

assert.deepEqual(validatePartyLoadouts([
    party([5010001, 5010002, null], [5010101, 5010101, 5010102]),
], inventory), { ok: true })

assert.deepEqual(validatePartyLoadouts([
    party([5010001, 5010001, null], [null, null, null]),
], inventory), {
    ok: false,
    reason: "duplicate_equipment",
    id: 5010001,
})

assert.deepEqual(validatePartyLoadouts([
    party([5019999, null, null], [null, null, null]),
], inventory), {
    ok: false,
    reason: "equipment_not_owned",
    id: 5019999,
})

assert.deepEqual(validatePartyLoadouts([
    party([null, null, null], [5010101, 5010101, 5010101]),
], inventory), {
    ok: false,
    reason: "ability_soul_shortage",
    id: 5010101,
})

assert.deepEqual(validatePartyLoadouts([
    party([5010001, null, null], [5010101, null, null]),
    party([5010001, null, null], [5010101, 5010101, null]),
], inventory), { ok: true })

assert.deepEqual(validatePartyLoadouts([
    party([5010001, null, null], [5010999, null, null]),
], inventory), {
    ok: false,
    reason: "ability_soul_shortage",
    id: 5010999,
})

assert.deepEqual(validatePartyLoadouts([
    party([5010001, null, null], [5010999, null, null]),
], inventory, [
    party([5010001, null, null], [5010999, null, null]),
]), { ok: true })

assert.deepEqual(validatePartyLoadouts([
    party([5010001, null, null], [5010999, 5010999, null]),
], inventory, [
    party([5010001, null, null], [5010999, null, null]),
]), {
    ok: false,
    reason: "ability_soul_shortage",
    id: 5010999,
})

console.log("party loadout validation tests passed")
