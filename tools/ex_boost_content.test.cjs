"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")
const { buildExBoostContentCatalog, getExBoostContentCatalog } = require("../src/lib/ex-boost-content")
const { createFrozenTestContentRepository } = require("./helpers/content-snapshot-fixture.cjs")

function repository(overrides = {}) {
    return createFrozenTestContentRepository({ tables: {
        "ex_boost.json": { 10001: { tier: 1, count: 5 }, 14001: { tier: 1, count: 1, element: 0 } },
        "ex_status.json": { 1: [7], 2: [4], 3: [1] },
        "ex_ability.json": {
            1: [["atk_self_r3"]], 2: [["atk_self_r4"]], 3: [["atk_self_r5"]],
            4: [["heal_self_r3"]], 5: [["heal_self_r4"]],
            6: [["powerflipdamage_buffextend_r5"]],
        },
        ...overrides,
    } })
}

test("EX Boost Catalog caches by repository and returns isolated mutable draw pools", () => {
    const source = repository()
    const catalog = getExBoostContentCatalog(source)
    assert.strictEqual(getExBoostContentCatalog(source), catalog)
    assert.notStrictEqual(getExBoostContentCatalog(repository()), catalog)
    assert.deepEqual(catalog.resolveMaterial(10001), { tier: 1, count: 5 })
    assert.deepEqual(catalog.resolveMaterial(14001), { tier: 1, count: 1, element: 0 })
    assert.deepEqual(catalog.resolveStatusPool(3), [1])
    const first = catalog.createAbilityDrawPools()
    const second = catalog.createAbilityDrawPools()
    assert.deepEqual(first.A, { 1: [1], 2: [2], 3: [3] })
    assert.deepEqual(first.B, { 1: [4], 2: [5], 3: [6] })
    first.A[1].pop()
    assert.deepEqual(second.A[1], [1])
})

test("EX Boost Catalog rejects representative malformed Content", () => {
    assert.throws(() => buildExBoostContentCatalog(repository({
        "ex_status.json": { 1: [], 2: [4], 3: [1] },
    })), /status tier 1/)
    assert.throws(() => buildExBoostContentCatalog(repository({
        "ex_boost.json": { 10001: { tier: 4, count: 1 } },
    })), /material 10001/)
    assert.throws(() => buildExBoostContentCatalog(repository({
        "ex_ability.json": { 1: [["broken"]] },
    })), /ability 1 name/)
})
