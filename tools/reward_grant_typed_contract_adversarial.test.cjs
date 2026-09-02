"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
    RewardGrantContractValidationError,
    createRewardGrantExecutionPlan,
    createRewardGrantExecutionResult,
    snapshotRewardGrantExecutionResultForPlan,
} = require("../src/lib/reward-grant")
const { RewardType } = require("../src/lib/types/rewards")

function item(itemId, requestedAmount, beforeAmount) {
    return {
        itemId,
        requestedAmount,
        acceptedAmount: requestedAmount,
        overflowAmount: 0,
        beforeAmount,
        afterAmount: beforeAmount + requestedAmount,
    }
}

function emptyPlayer(playerId) {
    return { playerId, freeMana: 0, freeVmoney: 0, expPool: 0 }
}

function characterOutcome(characterId, overrides = {}) {
    return {
        kind: "character",
        characterId,
        isNew: true,
        after: { character_id: characterId, bond_token_list: [{ status: 0 }] },
        compensationItem: null,
        ...overrides,
    }
}

function canonicalItemResult(playerId = 41) {
    const plan = createRewardGrantExecutionPlan([
        { type: RewardType.ITEM, id: 101, count: 2 },
        { type: RewardType.ITEM, id: 102, count: 3 },
    ])
    const result = createRewardGrantExecutionResult(playerId, plan, [
        { kind: "item", item: item(101, 2, 0) },
        { kind: "item", item: item(102, 3, 0) },
    ], emptyPlayer(playerId))
    return { plan, result }
}

test("owned asset snapshots reject accessors without executing them", () => {
    const plan = createRewardGrantExecutionPlan([{ type: RewardType.CHARACTER, id: 201 }])
    let getterCalls = 0
    const after = { character_id: 201 }
    Object.defineProperty(after, "stack", {
        enumerable: true,
        get() {
            getterCalls++
            return 0
        },
    })

    assert.throws(
        () => createRewardGrantExecutionResult(
            42,
            plan,
            [characterOutcome(201, { after })],
            emptyPlayer(42),
        ),
        RewardGrantContractValidationError,
    )
    assert.equal(getterCalls, 0)
})

test("execution plans and outcome lists reject sparse top-level arrays", () => {
    const sparsePlanEntries = Array(1)
    assert.throws(
        () => createRewardGrantExecutionPlan(sparsePlanEntries),
        error => error instanceof RewardGrantContractValidationError
            && error.entryIndex === 0
            && error.field === "entry",
    )

    const plan = createRewardGrantExecutionPlan([{ type: RewardType.ITEM, id: 101, count: 1 }])
    assert.throws(
        () => createRewardGrantExecutionResult(42, plan, Array(1), emptyPlayer(42)),
        error => error instanceof RewardGrantContractValidationError
            && error.entryIndex === 0
            && error.field === "outcome",
    )
})

test("revoked snapshot proxies fail with the typed contract error", () => {
    const plan = createRewardGrantExecutionPlan([{ type: RewardType.CHARACTER, id: 207 }])
    const revocable = Proxy.revocable({ character_id: 207 }, {})
    revocable.revoke()
    assert.throws(
        () => createRewardGrantExecutionResult(
            42,
            plan,
            [characterOutcome(207, { after: revocable.proxy })],
            emptyPlayer(42),
        ),
        error => error instanceof RewardGrantContractValidationError
            && error.field === "snapshot",
    )
})

test("owned snapshots reject unsupported values holes and property shapes", () => {
    const plan = createRewardGrantExecutionPlan([{ type: RewardType.CHARACTER, id: 202 }])
    const cycle = {}
    cycle.self = cycle
    const customPrototype = Object.create({ inherited: true })
    customPrototype.value = 1
    const sparse = Array(2)
    sparse[0] = 1
    const extraArrayProperty = [1]
    extraArrayProperty.extra = 2
    const nonEnumerable = { value: 1 }
    Object.defineProperty(nonEnumerable, "hidden", { value: 2 })
    const symbolKey = { value: 1 }
    symbolKey[Symbol("hidden")] = 2

    for (const invalid of [
        undefined,
        cycle,
        customPrototype,
        new Map(),
        new Set(),
        new Date(0),
        sparse,
        extraArrayProperty,
        nonEnumerable,
        symbolKey,
    ]) {
        assert.throws(
            () => createRewardGrantExecutionResult(
                43,
                plan,
                [characterOutcome(202, { after: { character_id: 202, invalid } })],
                emptyPlayer(43),
            ),
            RewardGrantContractValidationError,
            String(invalid),
        )
    }
})

test("owned snapshots preserve __proto__ as inert data", () => {
    const plan = createRewardGrantExecutionPlan([{ type: RewardType.CHARACTER, id: 203 }])
    const after = JSON.parse('{"character_id":203,"__proto__":{"polluted":true}}')
    const result = createRewardGrantExecutionResult(
        44,
        plan,
        [characterOutcome(203, { after })],
        emptyPlayer(44),
    )
    const snapshot = result.entries[0].outcome.after

    assert.equal(Object.getPrototypeOf(snapshot), Object.prototype)
    assert.equal(Object.hasOwn(snapshot, "__proto__"), true)
    assert.deepEqual(snapshot.__proto__, { polluted: true })
    assert.equal(snapshot.polluted, undefined)
    assert.equal({}.polluted, undefined)
})

test("Character and Equipment require plain object top-level after-state", () => {
    const characterPlan = createRewardGrantExecutionPlan([
        { type: RewardType.CHARACTER, id: 204 },
    ])
    const equipmentPlan = createRewardGrantExecutionPlan([
        { type: RewardType.EQUIPMENT, id: 304, count: 1 },
    ])
    for (const after of [null, true, 42, "invalid", []]) {
        assert.throws(() => createRewardGrantExecutionResult(
            45,
            characterPlan,
            [characterOutcome(204, { after })],
            emptyPlayer(45),
        ), RewardGrantContractValidationError)
        assert.throws(() => createRewardGrantExecutionResult(
            45,
            equipmentPlan,
            [{ kind: "equipment", equipmentId: 304, requestedAmount: 1, after }],
            emptyPlayer(45),
        ), RewardGrantContractValidationError)
    }
})

test("Character acquisition and compensation transitions are monotonic", () => {
    const singlePlan = createRewardGrantExecutionPlan([
        { type: RewardType.CHARACTER, id: 205 },
    ])
    assert.throws(() => createRewardGrantExecutionResult(
        46,
        singlePlan,
        [characterOutcome(205, { compensationItem: item(14002, 1, 0) })],
        emptyPlayer(46),
    ), RewardGrantContractValidationError)

    const repeatedPlan = createRewardGrantExecutionPlan([
        { type: RewardType.CHARACTER, id: 205 },
        { type: RewardType.CHARACTER, id: 205 },
    ])
    for (const outcomes of [
        [characterOutcome(205), characterOutcome(205)],
        [
            characterOutcome(205, { isNew: false, compensationItem: item(14002, 1, 0) }),
            characterOutcome(205),
        ],
    ]) {
        assert.throws(
            () => createRewardGrantExecutionResult(46, repeatedPlan, outcomes, emptyPlayer(46)),
            RewardGrantContractValidationError,
        )
    }
})

test("result snapshot validation rejects sparse missing extra reordered and identity mismatches", () => {
    const { plan, result } = canonicalItemResult()
    const sparseItems = Array(result.assets.items.length)
    const variants = [
        { ...result, entries: result.entries.slice(0, 1) },
        { ...result, entries: [...result.entries, result.entries[0]] },
        { ...result, entries: [result.entries[1], result.entries[0]] },
        { ...result, entries: [{ ...result.entries[0], index: 1 }, result.entries[1]] },
        { ...result, entries: [{ ...result.entries[0], reward: { type: RewardType.ITEM, id: 999, count: 2 } }, result.entries[1]] },
        { ...result, entries: [{ ...result.entries[0], outcome: { kind: "item", item: item(999, 2, 0) } }, result.entries[1]] },
        { ...result, assets: { ...result.assets, items: sparseItems } },
        { ...result, playerAfter: { ...result.playerAfter, playerId: 999 } },
    ]
    for (const variant of variants) {
        assert.throws(
            () => snapshotRewardGrantExecutionResultForPlan(41, plan, variant),
            RewardGrantContractValidationError,
        )
    }

    const fullPlan = createRewardGrantExecutionPlan([
        { type: RewardType.CHARACTER, id: 206 },
        { type: RewardType.EQUIPMENT, id: 306, count: 1 },
        { type: RewardType.MANA, count: 2 },
    ])
    const fullResult = createRewardGrantExecutionResult(41, fullPlan, [
        characterOutcome(206),
        { kind: "equipment", equipmentId: 306, requestedAmount: 1, after: { stack: 0 } },
        { kind: "currency", currency: "freeMana", requestedAmount: 2, beforeAmount: 0, afterAmount: 2 },
    ], { playerId: 41, freeMana: 2, freeVmoney: 0, expPool: 0 })
    for (const field of ["characters", "equipment", "currencies"]) {
        const forged = {
            ...fullResult,
            assets: { ...fullResult.assets, [field]: Array(fullResult.assets[field].length) },
        }
        assert.throws(
            () => snapshotRewardGrantExecutionResultForPlan(41, fullPlan, forged),
            RewardGrantContractValidationError,
            field,
        )
    }
})

test("empty and multi-currency results bind player identity and remain deeply immutable", () => {
    const emptyPlan = createRewardGrantExecutionPlan([])
    const empty = createRewardGrantExecutionResult(47, emptyPlan, [], emptyPlayer(47))
    assert.deepEqual(empty.entries, [])
    assert.throws(
        () => createRewardGrantExecutionResult(48, emptyPlan, [], emptyPlayer(47)),
        error => error instanceof RewardGrantContractValidationError && error.field === "playerId",
    )

    const plan = createRewardGrantExecutionPlan([
        { type: RewardType.BEADS, count: 2 },
        { type: RewardType.EXP, count: 3 },
    ])
    const result = createRewardGrantExecutionResult(47, plan, [
        { kind: "currency", currency: "freeVmoney", requestedAmount: 2, beforeAmount: 10, afterAmount: 12 },
        { kind: "currency", currency: "expPool", requestedAmount: 3, beforeAmount: 20, afterAmount: 23 },
    ], { playerId: 47, freeMana: 0, freeVmoney: 12, expPool: 23 })
    const before = JSON.stringify(result)
    assert.throws(() => { result.entries[0].outcome.afterAmount = 99 }, TypeError)
    assert.throws(() => { result.assets.currencies.push({}) }, TypeError)
    assert.throws(() => { result.playerAfter.expPool = 99 }, TypeError)
    assert.equal(JSON.stringify(result), before)
    assert.deepEqual(snapshotRewardGrantExecutionResultForPlan(47, plan, result), result)
})
