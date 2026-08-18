"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

let ManaNodeMutationValidationError
let planAwakeManaNodeMutation
let planLearnManaNodeMutation
try {
    ({
        ManaNodeMutationValidationError,
        planAwakeManaNodeMutation,
        planLearnManaNodeMutation,
    } = require("../src/lib/character-mana-mutation-plan"))
} catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error
}

const requirements = {
    "1": { abilityLevels: [null, 10, null, null, null, null], skillEvolutionLevel: 25 },
    "2": { abilityLevels: [null, 10, null, null, null, null], skillEvolutionLevel: 25 },
    "3": { abilityLevels: [null, 10, 40, 90, 95, 100], skillEvolutionLevel: 25 },
    "4": { abilityLevels: [null, 10, 40, 90, 95, 100], skillEvolutionLevel: 25 },
    "5": { abilityLevels: [null, 10, 40, 90, 95, 100], skillEvolutionLevel: 25 },
}

function node({
    manaCost = 10,
    items = { "1": 2 },
    field1 = "0",
    field5 = "0",
    field6 = "1",
} = {}) {
    return { manaCost, items, field1, field5, field6 }
}

function content(overrides = {}) {
    return {
        characterId: 10,
        boardId: 1,
        nodes: {
            "101": node({ field1: "1", field5: "", field6: "" }),
            "102": node({ manaCost: 20, items: { "1": 3 }, field6: "1" }),
            "103": node({ manaCost: 30, items: { "2": 4 }, field6: "2" }),
            "104": node({ manaCost: 40, items: { "3": 5 }, field5: "2", field6: "" }),
        },
        parents: { "101": null, "102": 101, "103": 102, "104": null },
        levelRequirements: requirements,
        ...overrides,
    }
}

function snapshot(overrides = {}) {
    return {
        mana: 1000,
        items: { "1": 100, "2": 100, "3": 100 },
        nodeAwakeLevels: {},
        ...overrides,
    }
}

function learn(overrides = {}) {
    return {
        characterId: 10,
        boardId: 1,
        characterRarity: 5,
        characterLevel: 100,
        requestedNodeIds: [101],
        content: content(),
        snapshot: snapshot(),
        ...overrides,
    }
}

function awake(overrides = {}) {
    return {
        ...learn(),
        requestedNodeIds: [101],
        targetAwakeLevel: 1,
        awakeCosts: { "101": { manaCost: 7, items: { "1": 1 } } },
        snapshot: snapshot({ nodeAwakeLevels: { "101": 0 } }),
        ...overrides,
    }
}

function expectCode(action, code) {
    assert.throws(action, error => (
        error instanceof ManaNodeMutationValidationError && error.code === code
    ))
}

test("learn validates non-empty canonical unique ids and current content scope", () => {
    assert.equal(typeof planLearnManaNodeMutation, "function")
    for (const requestedNodeIds of [[], [0], [-1], [1.5], [Number.MAX_SAFE_INTEGER + 1], ["101"]]) {
        expectCode(() => planLearnManaNodeMutation(learn({ requestedNodeIds })), "INVALID_REQUEST")
    }
    expectCode(
        () => planLearnManaNodeMutation(learn({ requestedNodeIds: [101, 101] })),
        "DUPLICATE_NODE",
    )
    expectCode(
        () => planLearnManaNodeMutation(learn({ requestedNodeIds: [999] })),
        "UNKNOWN_NODE",
    )
    expectCode(
        () => planLearnManaNodeMutation(learn({ content: content({ characterId: 11 }) })),
        "CONTENT_SCOPE_MISMATCH",
    )
    expectCode(
        () => planLearnManaNodeMutation(learn({ content: content({ boardId: 2 }) })),
        "CONTENT_SCOPE_MISMATCH",
    )
})

test("planner rejects string-valued costs and parents in damaged parsed content", () => {
    const stringCostNodes = content().nodes
    stringCostNodes[101] = node({ items: { "1": "2" } })
    expectCode(() => planLearnManaNodeMutation(learn({
        content: content({ nodes: stringCostNodes }),
    })), "CONTENT_INVALID")

    expectCode(() => planLearnManaNodeMutation(learn({
        requestedNodeIds: [102],
        content: content({ parents: { ...content().parents, "102": "101" } }),
        snapshot: snapshot({ nodeAwakeLevels: { "101": 0 } }),
    })), "CONTENT_INVALID")
})

test("learn accepts persisted or earlier parents and rejects later or unavailable parents", () => {
    const persisted = planLearnManaNodeMutation(learn({
        requestedNodeIds: [102],
        snapshot: snapshot({ nodeAwakeLevels: { "101": 0 } }),
    }))
    assert.deepEqual(persisted.nodeUpdates, [{ nodeId: 102, awakeLevel: 0 }])

    const earlier = planLearnManaNodeMutation(learn({ requestedNodeIds: [101, 102] }))
    assert.deepEqual(earlier.finalLearnedNodeIds, [101, 102])

    expectCode(
        () => planLearnManaNodeMutation(learn({ requestedNodeIds: [102, 101] })),
        "PARENT_NOT_LEARNED",
    )
    expectCode(
        () => planLearnManaNodeMutation(learn({
            requestedNodeIds: [103],
            snapshot: snapshot({ nodeAwakeLevels: { "101": 0 } }),
        })),
        "PARENT_NOT_LEARNED",
    )
})

test("learn rejects learned nodes and awake rejects unlearned nodes", () => {
    expectCode(
        () => planLearnManaNodeMutation(learn({
            snapshot: snapshot({ nodeAwakeLevels: { "101": 0 } }),
        })),
        "ALREADY_LEARNED",
    )
    expectCode(
        () => planAwakeManaNodeMutation(awake({
            requestedNodeIds: [102],
            awakeCosts: { "102": { manaCost: 1, items: {} } },
        })),
        "NOT_LEARNED",
    )
})

test("rarity requirements cover ability slots 1 through 6, skill evolution, and Episode", () => {
    const exactRequirements = Object.fromEntries([1, 2, 3, 4, 5].map(rarity => [String(rarity), {
        abilityLevels: [2, 3, 4, 5, 6, 7],
        skillEvolutionLevel: 8,
    }]))
    const nodes = {}
    const parents = {}
    for (let slot = 1; slot <= 6; slot += 1) {
        nodes[String(200 + slot)] = node({ field6: String(slot), items: {} })
        parents[String(200 + slot)] = null
    }
    nodes[207] = node({ field5: "2", field6: "", items: {} })
    nodes[208] = node({ field1: "1", field5: "", field6: "", items: {} })
    parents[207] = null
    parents[208] = null
    const scoped = content({ nodes, parents, levelRequirements: exactRequirements })

    for (let slot = 1; slot <= 6; slot += 1) {
        const nodeId = 200 + slot
        expectCode(() => planLearnManaNodeMutation(learn({
            content: scoped,
            characterLevel: slot,
            requestedNodeIds: [nodeId],
        })), "LEVEL_REQUIRED")
        assert.equal(planLearnManaNodeMutation(learn({
            content: scoped,
            characterLevel: slot + 1,
            requestedNodeIds: [nodeId],
        })).nodeUpdates[0].nodeId, nodeId)
    }
    expectCode(() => planLearnManaNodeMutation(learn({
        content: scoped,
        characterLevel: 7,
        requestedNodeIds: [207],
    })), "LEVEL_REQUIRED")
    assert.equal(planLearnManaNodeMutation(learn({
        content: scoped,
        characterLevel: 1,
        requestedNodeIds: [208],
    })).nodeUpdates[0].nodeId, 208)
})

test("learn simulates ordered costs, aggregates shared items, and returns final state", () => {
    const plan = planLearnManaNodeMutation(learn({
        requestedNodeIds: [101, 102, 103],
        snapshot: snapshot({ mana: 60, items: { "1": 5, "2": 4, "3": 0 } }),
    }))
    assert.deepEqual(plan.nodeUpdates, [
        { nodeId: 101, awakeLevel: 0 },
        { nodeId: 102, awakeLevel: 0 },
        { nodeId: 103, awakeLevel: 0 },
    ])
    assert.deepEqual(plan.responseNodeEntries, [
        { multiplied_id: 101, awake_level: 0 },
        { multiplied_id: 102, awake_level: 0 },
        { multiplied_id: 103, awake_level: 0 },
    ])
    assert.deepEqual(plan.totalItemCosts, { "1": 5, "2": 4 })
    assert.equal(plan.totalManaCost, 60)
    assert.equal(plan.remainingMana, 0)
    assert.deepEqual(plan.remainingItems, { "1": 0, "2": 0, "3": 0 })
    assert.deepEqual(plan.finalAwakeLevels, { "101": 0, "102": 0, "103": 0 })
    assert.equal(plan.hasResourceWrites, true)
})

test("cost simulation fails closed on ordered shortages and safe integer overflow", () => {
    expectCode(() => planLearnManaNodeMutation(learn({
        requestedNodeIds: [101, 102],
        snapshot: snapshot({ mana: 29 }),
    })), "INSUFFICIENT_MANA")
    expectCode(() => planLearnManaNodeMutation(learn({
        requestedNodeIds: [101, 102],
        snapshot: snapshot({ items: { "1": 4 } }),
    })), "INSUFFICIENT_ITEM")

    const overflowNodes = {
        "301": node({ manaCost: Number.MAX_SAFE_INTEGER, items: {} }),
        "302": node({ manaCost: 1, items: {} }),
    }
    expectCode(() => planLearnManaNodeMutation(learn({
        content: content({
            nodes: overflowNodes,
            parents: { "301": null, "302": 301 },
        }),
        requestedNodeIds: [301, 302],
        snapshot: snapshot({ mana: Number.MAX_SAFE_INTEGER }),
    })), "COST_OVERFLOW")

    const itemOverflowNodes = {
        "401": node({ manaCost: 0, items: { "1": Number.MAX_SAFE_INTEGER } }),
        "402": node({ manaCost: 0, items: { "1": 1 } }),
    }
    expectCode(() => planLearnManaNodeMutation(learn({
        content: content({
            nodes: itemOverflowNodes,
            parents: { "401": null, "402": 401 },
        }),
        requestedNodeIds: [401, 402],
        snapshot: snapshot({ items: { "1": Number.MAX_SAFE_INTEGER } }),
    })), "COST_OVERFLOW")
})

test("awake keeps reached targets as entries while charging only updated nodes", () => {
    const plan = planAwakeManaNodeMutation(awake({
        requestedNodeIds: [101, 102],
        targetAwakeLevel: 2,
        awakeCosts: {
            "101": { manaCost: 7, items: { "1": 1 } },
            "102": { manaCost: 11, items: { "1": 2 } },
        },
        snapshot: snapshot({ nodeAwakeLevels: { "101": 2, "102": 1 } }),
    }))
    assert.deepEqual(plan.nodeUpdates, [{ nodeId: 102, awakeLevel: 2 }])
    assert.deepEqual(plan.responseNodeEntries, [
        { multiplied_id: 101, awake_level: 2 },
        { multiplied_id: 102, awake_level: 2 },
    ])
    assert.deepEqual(plan.finalAwakeLevels, { "101": 2, "102": 2 })
    assert.equal(plan.totalManaCost, 11)
    assert.deepEqual(plan.totalItemCosts, { "1": 2 })
    assert.equal(plan.hasResourceWrites, true)
})

test("awake all-no-op plan is explicit and target validation rejects downgrades", () => {
    const plan = planAwakeManaNodeMutation(awake({
        targetAwakeLevel: 2,
        awakeCosts: {},
        snapshot: snapshot({ nodeAwakeLevels: { "101": 2 } }),
    }))
    assert.deepEqual(plan.nodeUpdates, [])
    assert.equal(plan.totalManaCost, 0)
    assert.deepEqual(plan.totalItemCosts, {})
    assert.equal(plan.hasResourceWrites, false)
    assert.deepEqual(plan.responseNodeEntries, [{ multiplied_id: 101, awake_level: 2 }])

    for (const targetAwakeLevel of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        expectCode(() => planAwakeManaNodeMutation(awake({ targetAwakeLevel })), "INVALID_AWAKE_TARGET")
    }
    expectCode(() => planAwakeManaNodeMutation(awake({
        targetAwakeLevel: 1,
        snapshot: snapshot({ nodeAwakeLevels: { "101": 2 } }),
    })), "INVALID_AWAKE_TARGET")
})

test("awake costs fail closed when missing or balances are insufficient", () => {
    expectCode(() => planAwakeManaNodeMutation(awake({ awakeCosts: undefined })), "AWAKE_COST_MISSING")
    expectCode(() => planAwakeManaNodeMutation(awake({
        snapshot: snapshot({ mana: 6, nodeAwakeLevels: { "101": 0 } }),
    })), "INSUFFICIENT_MANA")
    expectCode(() => planAwakeManaNodeMutation(awake({
        snapshot: snapshot({ items: {}, nodeAwakeLevels: { "101": 0 } }),
    })), "INSUFFICIENT_ITEM")
})

test("planners do not mutate content, snapshot, costs, or request arrays", () => {
    const learnInput = learn({ requestedNodeIds: [101, 102] })
    const learnBefore = structuredClone(learnInput)
    planLearnManaNodeMutation(learnInput)
    assert.deepEqual(learnInput, learnBefore)

    const awakeInput = awake()
    const awakeBefore = structuredClone(awakeInput)
    planAwakeManaNodeMutation(awakeInput)
    assert.deepEqual(awakeInput, awakeBefore)
})

test("quick character selector includes the pure mutation planner", () => {
    const { TEST_GROUPS } = require("./test-workflow/groups.cjs")
    assert.ok(TEST_GROUPS["quick:character"].tests.includes(
        "tools/character_mana_mutation_plan.test.cjs",
    ))
})
