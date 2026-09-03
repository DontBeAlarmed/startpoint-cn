"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
    planItemOverflowDisposition,
} = require("../src/lib/item-overflow/disposition")

function policy({ sellable, salePrice, category = 2, maxCount = 9999 }) {
    return Object.freeze({
        effectKind: 0,
        category,
        salePrice,
        maxCount,
        sellable,
        startTimeMs: 0,
        endTimeMs: null,
    })
}

test("sellable Item overflow plans a safe Mana sale", () => {
    assert.deepEqual(planItemOverflowDisposition({
        itemId: 1,
        overflowAmount: 12,
        policy: policy({ sellable: true, salePrice: 5 }),
        freeMana: 100,
        paidMana: 20,
        maxMana: 999,
    }), {
        kind: "sold",
        itemId: 1,
        overflowAmount: 12,
        soldMana: 60,
        manaBefore: 100,
        acceptedMana: 60,
        overflowMana: 0,
        manaAfter: 160,
    })
})

test("unsellable Item overflow plans Mail even with a positive sale price", () => {
    assert.deepEqual(planItemOverflowDisposition({
        itemId: 30102,
        overflowAmount: 20,
        policy: policy({ sellable: false, salePrice: 100, category: 3, maxCount: 99999 }),
        freeMana: 100,
        paidMana: 0,
        maxMana: 999,
    }), {
        kind: "mail",
        itemId: 30102,
        overflowAmount: 20,
    })
})

test("sellable overflow splits sold Mana at the total free plus paid cap", () => {
    assert.deepEqual(planItemOverflowDisposition({
        itemId: 40090,
        overflowAmount: 48,
        policy: policy({ sellable: true, salePrice: 3, category: 6 }),
        freeMana: 900,
        paidMana: 50,
        maxMana: 1000,
    }), {
        kind: "sold",
        itemId: 40090,
        overflowAmount: 48,
        soldMana: 144,
        manaBefore: 900,
        acceptedMana: 50,
        overflowMana: 94,
        manaAfter: 950,
    })
})

test("historical Mana over-cap sends the complete sale value to overflow", () => {
    assert.deepEqual(planItemOverflowDisposition({
        itemId: 9,
        overflowAmount: 4,
        policy: policy({ sellable: true, salePrice: 5 }),
        freeMana: 1200,
        paidMana: 10,
        maxMana: 1000,
    }), {
        kind: "sold",
        itemId: 9,
        overflowAmount: 4,
        soldMana: 20,
        manaBefore: 1200,
        acceptedMana: 0,
        overflowMana: 20,
        manaAfter: 1200,
    })
})

test("disposition rejects invalid identity, amounts, and unsafe arithmetic", () => {
    const base = {
        itemId: 1,
        overflowAmount: 1,
        policy: policy({ sellable: true, salePrice: 5 }),
        freeMana: 0,
        paidMana: 0,
        maxMana: 999,
    }
    for (const override of [
        { itemId: 0 },
        { itemId: 1.5 },
        { overflowAmount: 0 },
        { overflowAmount: -1 },
        { overflowAmount: 1.5 },
        { freeMana: -1 },
        { paidMana: Number.MAX_SAFE_INTEGER, freeMana: 1 },
        { maxMana: -1 },
        { policy: policy({ sellable: true, salePrice: Number.MAX_SAFE_INTEGER }), overflowAmount: 2 },
    ]) {
        assert.throws(() => planItemOverflowDisposition({ ...base, ...override }))
    }
})

test("disposition results are frozen owned values", () => {
    const result = planItemOverflowDisposition({
        itemId: 1,
        overflowAmount: 2,
        policy: policy({ sellable: true, salePrice: 5 }),
        freeMana: 0,
        paidMana: 0,
        maxMana: 999,
    })
    assert.equal(Object.isFrozen(result), true)
    assert.throws(() => { result.soldMana = 999 })
    assert.equal(result.soldMana, 10)
})
