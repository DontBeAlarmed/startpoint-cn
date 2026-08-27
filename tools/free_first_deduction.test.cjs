"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
    planFreeFirstDeduction,
} = require("../src/lib/economy/free-first-deduction")

test("free-first deduction consumes free currency before paid currency", () => {
    assert.deepEqual(planFreeFirstDeduction(100, 50, 80), {
        freeBalance: 20,
        paidBalance: 50,
        freeSpent: 80,
        paidSpent: 0,
    })
    assert.deepEqual(planFreeFirstDeduction(30, 70, 80), {
        freeBalance: 0,
        paidBalance: 20,
        freeSpent: 30,
        paidSpent: 50,
    })
    assert.deepEqual(planFreeFirstDeduction(0, 100, 80), {
        freeBalance: 0,
        paidBalance: 20,
        freeSpent: 0,
        paidSpent: 80,
    })
})

test("free-first deduction rejects invalid or insufficient balances", () => {
    for (const input of [
        [30, 40, 80],
        [-1, 100, 50],
        [100, -1, 50],
        [100, 100, -1],
        [100, 100, 1.5],
        [Number.MAX_SAFE_INTEGER, 1, 1],
    ]) {
        assert.equal(planFreeFirstDeduction(...input), null, JSON.stringify(input))
    }
})
