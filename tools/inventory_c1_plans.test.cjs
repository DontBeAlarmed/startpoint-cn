"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    findItemInventoryPolicy,
    getItemInventoryPolicyCatalog,
    parseItemInventoryPolicyCatalog,
} = require("../src/lib/inventory/item-inventory-policy")
const { planItemCap } = require("../src/lib/inventory/item-cap-plan")
const {
    isEventTradeExpiredAt,
    planEventTradeExpiry,
} = require("../src/lib/inventory/event-trade-expiry-plan")
const { planManaCapacity } = require("../src/lib/inventory/mana-capacity-plan")
const {
    installBundledGameplaySnapshot,
} = require("./helpers/install-bundled-gameplay-snapshot.cjs")

const restoreDefaultSnapshot = installBundledGameplaySnapshot()
test.after(restoreDefaultSnapshot)

const CN_CONTENT_MAX_EPOCH_MS = Date.UTC(9999, 11, 31, 23, 59, 59)
    - 8 * 60 * 60 * 1000

function policy(overrides = {}) {
    return {
        effectKind: 9,
        category: 3,
        salePrice: 10,
        maxCount: 9999,
        sellable: true,
        startTimeMs: 1_000,
        endTimeMs: 5_000,
        ...overrides,
    }
}

function catalog(byItemId) {
    return parseItemInventoryPolicyCatalog({
        byItemId,
        eventTradeItemIds: Object.entries(byItemId)
            .filter(([, value]) => value.effectKind === 9)
            .map(([itemId]) => Number(itemId))
            .sort((left, right) => left - right),
    })
}

function assertDeepFrozen(value, seen = new Set()) {
    if (!value || typeof value !== "object" || seen.has(value)) return
    seen.add(value)
    assert.equal(Object.isFrozen(value), true)
    for (const key of Reflect.ownKeys(value)) assertDeepFrozen(value[key], seen)
}

test("typed Item policy uses the deeply frozen initialized runtime snapshot", () => {
    const loaded = getItemInventoryPolicyCatalog()
    assert.ok(Object.keys(loaded.byItemId).length > 1_000)
    assert.ok(loaded.eventTradeItemIds.length > 0)
    assert.deepEqual([...loaded.eventTradeItemIds].sort((a, b) => a - b), loaded.eventTradeItemIds)
    assert.equal(findItemInventoryPolicy(loaded, loaded.eventTradeItemIds[0]).effectKind, 9)
    assertDeepFrozen(loaded)
})

test("typed Item policy prefers and validates the active runtime snapshot", t => {
    const runtime = {
        byItemId: {
            "901": policy({ effectKind: 14, endTimeMs: null }),
            "902": policy({ effectKind: 17, endTimeMs: null }),
            "903": policy({ sellable: false }),
        },
        eventTradeItemIds: [903],
    }
    const restore = installBundledGameplaySnapshot({
        tableOverrides: { "item_inventory_policy.json": runtime },
    })
    t.after(restore)
    const loaded = getItemInventoryPolicyCatalog()
    assert.deepEqual(Object.keys(loaded.byItemId), ["901", "902", "903"])
    assert.deepEqual(loaded.eventTradeItemIds, [903])
    assert.equal(loaded.byItemId["901"].effectKind, 14)
    assert.equal(loaded.byItemId["902"].effectKind, 17)
    assertDeepFrozen(loaded)
})

test("typed Item policy rejects an invalid active runtime snapshot without bundled fallback", () => {
    const restore = installBundledGameplaySnapshot({
        tableOverrides: {
            "item_inventory_policy.json": {
                byItemId: { "901": policy({ effectKind: 23 }) },
                eventTradeItemIds: [],
            },
        },
    })
    try {
        assert.throws(
            () => getItemInventoryPolicyCatalog(),
            /invalid item inventory policy catalog.*effectKind.*0 through 22/i,
        )
    } finally {
        restore()
    }
    const restored = getItemInventoryPolicyCatalog()
    assert.ok(Object.keys(restored.byItemId).length > 1_000)
})

test("typed Item policy accepts epoch zero and the UTC+8 four-digit year upper bound", () => {
    const loaded = parseItemInventoryPolicyCatalog({
        byItemId: {
            "1": policy({ effectKind: 14, startTimeMs: 0, endTimeMs: null }),
            "2": policy({
                startTimeMs: CN_CONTENT_MAX_EPOCH_MS,
                endTimeMs: CN_CONTENT_MAX_EPOCH_MS,
            }),
        },
        eventTradeItemIds: [2],
    })
    assert.equal(loaded.byItemId["1"].startTimeMs, 0)
    assert.equal(loaded.byItemId["2"].startTimeMs, CN_CONTENT_MAX_EPOCH_MS)
    assert.equal(loaded.byItemId["2"].endTimeMs, CN_CONTENT_MAX_EPOCH_MS)
})

for (const [name, overrides, expected] of [
    ["non-second start epoch", { startTimeMs: 1_001 }, /startTimeMs must have second precision/i],
    ["non-second end epoch", { endTimeMs: 5_001 }, /endTimeMs must have second precision/i],
    [
        "epoch above the UTC+8 four-digit year range",
        { startTimeMs: CN_CONTENT_MAX_EPOCH_MS + 1_000, endTimeMs: null },
        /startTimeMs exceeds the UTC\+8 four-digit year range/i,
    ],
]) {
    test(`typed Item policy rejects ${name}`, () => {
        assert.throws(() => parseItemInventoryPolicyCatalog({
            byItemId: { "1": policy(overrides) },
            eventTradeItemIds: [1],
        }), expected)
    })
}

test("active runtime snapshot fails closed for invalid epoch precision and range", () => {
    const invalidPolicies = [
        [policy({ startTimeMs: 1_001 }), /startTimeMs must have second precision/i],
        [policy({ endTimeMs: 5_001 }), /endTimeMs must have second precision/i],
        [
            policy({ startTimeMs: CN_CONTENT_MAX_EPOCH_MS + 1_000, endTimeMs: null }),
            /startTimeMs exceeds the UTC\+8 four-digit year range/i,
        ],
    ]
    for (const [invalidPolicy, expected] of invalidPolicies) {
        const restore = installBundledGameplaySnapshot({
            tableOverrides: {
                "item_inventory_policy.json": {
                    byItemId: { "901": invalidPolicy },
                    eventTradeItemIds: [901],
                },
            },
        })
        try {
            assert.throws(() => getItemInventoryPolicyCatalog(), expected)
        } finally {
            restore()
        }
    }
    const restored = getItemInventoryPolicyCatalog()
    assert.ok(Object.keys(restored.byItemId).length > 1_000)
})

for (const [name, raw, expected] of [
    ["negative kind", { byItemId: { "1": policy({ effectKind: -1 }) }, eventTradeItemIds: [] }, /effectKind/i],
    ["kind 23", { byItemId: { "1": policy({ effectKind: 23 }) }, eventTradeItemIds: [] }, /0 through 22/i],
    ["non-integer kind", { byItemId: { "1": policy({ effectKind: 9.5 }) }, eventTradeItemIds: [] }, /safe integer/i],
    ["inverted window", { byItemId: { "1": policy({ startTimeMs: 6_000 }) }, eventTradeItemIds: [1] }, /inverted/i],
    ["wrong EventTrade index", { byItemId: { "1": policy() }, eventTradeItemIds: [] }, /exactly match/i],
]) {
    test(`typed Item policy rejects ${name}`, () => {
        assert.throws(() => parseItemInventoryPolicyCatalog(raw), expected)
    })
}

test("Item cap plans accepted and overflow amounts without reducing historical over-cap stock", () => {
    assert.deepEqual(planItemCap({ currentAmount: 8, requestedAmount: 5, maxCount: 10 }), {
        beforeAmount: 8,
        afterAmount: 10,
        acceptedAmount: 2,
        overflowAmount: 3,
    })
    assert.deepEqual(planItemCap({ currentAmount: 12, requestedAmount: 5, maxCount: 10 }), {
        beforeAmount: 12,
        afterAmount: 12,
        acceptedAmount: 0,
        overflowAmount: 5,
    })
    assert.deepEqual(planItemCap({ currentAmount: 0, requestedAmount: 0, maxCount: 0 }), {
        beforeAmount: 0,
        afterAmount: 0,
        acceptedAmount: 0,
        overflowAmount: 0,
    })
})

test("Item cap rejects negative, fractional and unsafe inputs", () => {
    for (const input of [
        { currentAmount: -1, requestedAmount: 1, maxCount: 1 },
        { currentAmount: 0, requestedAmount: 1.5, maxCount: 1 },
        { currentAmount: 0, requestedAmount: Number.MAX_SAFE_INTEGER + 1, maxCount: 1 },
    ]) assert.throws(() => planItemCap(input), /safe integer/i)
})

test("EventTrade expiry keeps the ending second valid and returns stable expired entries", () => {
    assert.equal(isEventTradeExpiredAt(9_999, 9_000), false)
    assert.equal(isEventTradeExpiredAt(10_000, 9_000), true)
    const typedCatalog = catalog({
        "101": policy({ effectKind: 0, endTimeMs: null }),
        "102": policy({ endTimeMs: null }),
        "103": policy({ endTimeMs: 9_000 }),
        "104": policy({ salePrice: 3, sellable: false }),
        "105": policy({ salePrice: 4 }),
    })
    assert.deepEqual(planEventTradeExpiry(
        [{ itemId: 104, amount: 2 }],
        typedCatalog,
        5_999,
    ), { entries: [], totalMana: 0 })

    const owned = [
        { itemId: 105, amount: 3 },
        { itemId: 999, amount: 7 },
        { itemId: 104, amount: 2 },
        { itemId: 103, amount: 1 },
        { itemId: 102, amount: 1 },
        { itemId: 101, amount: 1 },
    ]
    const before = structuredClone(owned)
    const plan = planEventTradeExpiry(owned, typedCatalog, 6_000)
    assert.deepEqual(plan, {
        entries: [
            { itemId: 104, amount: 2, salePrice: 3, mana: 6 },
            { itemId: 105, amount: 3, salePrice: 4, mana: 12 },
        ],
        totalMana: 18,
    })
    assert.deepEqual(owned, before)
    assertDeepFrozen(plan)
})

test("EventTrade expiry rejects duplicate and unsafe owned amounts, products and totals", () => {
    const typedCatalog = catalog({
        "1": policy({ salePrice: 2 }),
        "2": policy({ salePrice: 1 }),
        "3": policy({ salePrice: 1 }),
    })
    assert.throws(
        () => planEventTradeExpiry(
            [{ itemId: 1, amount: 1 }, { itemId: 1, amount: 1 }],
            typedCatalog,
            6_000,
        ),
        /duplicate/i,
    )
    assert.throws(
        () => planEventTradeExpiry(
            [{ itemId: 1, amount: Number.MAX_SAFE_INTEGER }],
            typedCatalog,
            6_000,
        ),
        /safe integer/i,
    )
    assert.throws(
        () => planEventTradeExpiry([
            { itemId: 2, amount: Number.MAX_SAFE_INTEGER },
            { itemId: 3, amount: 1 },
        ], typedCatalog, 6_000),
        /total Mana must be a safe integer/i,
    )
    assert.throws(
        () => planEventTradeExpiry([{ itemId: 1, amount: -1 }], typedCatalog, 6_000),
        /safe integer/i,
    )
})

test("Mana capacity includes paid Mana and preserves historical over-max balances", () => {
    assert.deepEqual(planManaCapacity({
        freeMana: 70,
        paidMana: 20,
        maxMana: 100,
        requestedMana: 25,
    }), {
        currentTotalMana: 90,
        capacityMana: 10,
        acceptedMana: 10,
        overflowMana: 15,
    })
    assert.deepEqual(planManaCapacity({
        freeMana: 120,
        paidMana: 5,
        maxMana: 100,
        requestedMana: 25,
    }), {
        currentTotalMana: 125,
        capacityMana: 0,
        acceptedMana: 0,
        overflowMana: 25,
    })
})

test("Mana capacity rejects unsafe totals and invalid inputs", () => {
    assert.throws(() => planManaCapacity({
        freeMana: Number.MAX_SAFE_INTEGER,
        paidMana: 1,
        maxMana: Number.MAX_SAFE_INTEGER,
        requestedMana: 0,
    }), /current total Mana must be a safe integer/i)
    assert.throws(() => planManaCapacity({
        freeMana: 0,
        paidMana: -1,
        maxMana: 10,
        requestedMana: 1,
    }), /paidMana must be a non-negative safe integer/i)
})
