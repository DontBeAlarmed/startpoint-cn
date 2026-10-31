"use strict"

require("./test-workflow/bootstrap.cjs").bootstrap()

const assert = require("node:assert/strict")
const test = require("node:test")

const {
    STACK_CHARACTER_GROWTH_FIELDS,
    characterGrowthProjectionStateFromPlayerCharacter,
    projectCharacterGrowthEntry,
} = require("../src/lib/character-growth/response-projector")
const { projectCharacterPatch } = require("../src/lib/common-response/entities")
const {
    RewardGrantContractValidationError,
    createRewardGrantExecutionPlan,
    createRewardGrantExecutionResult,
    collectRewardGrantItemOverflowDispositions,
    rewardGrantFingerprint,
    snapshotRewardGrantExecutionResultForPlan,
} = require("../src/lib/reward-grant")
const { RewardType } = require("../src/lib/types/rewards")

function item(
    itemId,
    requestedAmount,
    acceptedAmount,
    overflowAmount,
    beforeAmount,
    overflowDispositions = [],
) {
    return {
        itemId,
        requestedAmount,
        acceptedAmount,
        overflowAmount,
        beforeAmount,
        afterAmount: beforeAmount + acceptedAmount,
        ...(overflowDispositions.length > 0 ? { overflowDispositions } : {}),
    }
}

function assertDeepFrozen(value, seen = new Set()) {
    if (!value || typeof value !== "object" || seen.has(value)) return
    seen.add(value)
    assert.equal(Object.isFrozen(value), true)
    for (const key of Reflect.ownKeys(value)) assertDeepFrozen(value[key], seen)
}

test("execution plan owns only ordered asset commands and excludes source metadata", () => {
    const input = [
        { type: RewardType.ITEM, id: 101, count: 2, name: "display", source: { draw: 1 } },
        { type: RewardType.CHARACTER, id: 201, source: { draw: 2 } },
        { type: RewardType.MANA, count: 30, source: { mission: 3 } },
    ]
    const plan = createRewardGrantExecutionPlan(input)

    assert.deepEqual(plan.entries, [
        { type: RewardType.ITEM, id: 101, count: 2 },
        { type: RewardType.CHARACTER, id: 201 },
        { type: RewardType.MANA, count: 30 },
    ])
    assert.equal("source" in plan.entries[0], false)
    assert.equal("name" in plan.entries[0], false)
    assert.equal(rewardGrantFingerprint(plan.entries[0]), `${RewardType.ITEM}:101:2`)
    assert.equal(rewardGrantFingerprint(plan.entries[1]), `${RewardType.CHARACTER}:201:1`)
    input[0].count = 99
    input.reverse()
    assert.equal(plan.entries[0].count, 2)
    assertDeepFrozen(plan)
})

test("execution plan accepts all eight current positive reward types", () => {
    const rewards = [
        { type: RewardType.ITEM, id: 1, count: 1 },
        { type: RewardType.EQUIPMENT, id: 2, count: 2 },
        { type: RewardType.CHARACTER, id: 3 },
        { type: RewardType.BEADS, count: 4 },
        { type: RewardType.MANA, count: 5 },
        { type: RewardType.EXP, count: 6 },
        { type: RewardType.ELEMENT, id: 7, count: 7 },
        { type: RewardType.AETHER, id: 8, count: 8 },
    ]
    assert.deepEqual(createRewardGrantExecutionPlan(rewards).entries, rewards)
})

test("execution plan rejects invalid runtime reward identity", () => {
    for (const [reward, field] of [
        [{ type: 999, id: 1, count: 1 }, "type"],
        [{ type: RewardType.ITEM, id: 0, count: 1 }, "id"],
        [{ type: RewardType.ITEM, id: 1, count: 0 }, "count"],
        [{ type: RewardType.CHARACTER, id: -1 }, "id"],
        [{ type: RewardType.MANA, count: Number.MAX_SAFE_INTEGER + 1 }, "count"],
    ]) {
        assert.throws(
            () => createRewardGrantExecutionPlan([reward]),
            error => error instanceof RewardGrantContractValidationError
                && error.entryIndex === 0
                && error.field === field,
        )
    }
})

test("typed result preserves entry outcomes and aggregates final assets in first-seen order", () => {
    const plan = createRewardGrantExecutionPlan([
        { type: RewardType.ITEM, id: 101, count: 5 },
        { type: RewardType.CHARACTER, id: 201 },
        { type: RewardType.ITEM, id: 101, count: 4 },
        { type: RewardType.EQUIPMENT, id: 301, count: 2 },
        { type: RewardType.EQUIPMENT, id: 301, count: 3 },
        { type: RewardType.MANA, count: 10 },
        { type: RewardType.MANA, count: 5 },
        { type: RewardType.CHARACTER, id: 201 },
    ])
    const result = createRewardGrantExecutionResult(7, plan, [
        { kind: "item", item: item(101, 5, 3, 2, 10, [{
            kind: "mail",
            itemId: 101,
            overflowAmount: 2,
        }]) },
        {
            kind: "character",
            characterId: 201,
            isNew: true,
            after: { character_id: 201, stack: 0, bond_token_list: [{ status: 0 }] },
            compensationItem: null,
        },
        { kind: "item", item: item(101, 4, 4, 0, 13) },
        { kind: "equipment", equipmentId: 301, requestedAmount: 2, after: { stack: 1 } },
        { kind: "equipment", equipmentId: 301, requestedAmount: 3, after: { stack: 4 } },
        { kind: "currency", currency: "freeMana", requestedAmount: 10, beforeAmount: 100, afterAmount: 110 },
        { kind: "currency", currency: "freeMana", requestedAmount: 5, beforeAmount: 110, afterAmount: 115 },
        {
            kind: "character",
            characterId: 201,
            isNew: false,
            after: { character_id: 201, stack: 1, bond_token_list: [{ status: 0 }] },
            compensationItem: item(102, 2, 2, 0, 0),
        },
    ], {
        playerId: 7,
        freeMana: 115,
        freeVmoney: 20,
        expPool: 30,
    })

    assert.deepEqual(result.entries.map(entry => entry.index), [0, 1, 2, 3, 4, 5, 6, 7])
    assert.deepEqual(result.assets.items, [
        item(101, 9, 7, 2, 10, [{ kind: "mail", itemId: 101, overflowAmount: 2 }]),
        item(102, 2, 2, 0, 0),
    ])
    assert.deepEqual(result.assets.characters, [{
        characterId: 201,
        joined: true,
        after: { character_id: 201, stack: 1, bond_token_list: [{ status: 0 }] },
    }])
    assert.deepEqual(result.assets.equipment, [{
        equipmentId: 301,
        requestedAmount: 5,
        after: { stack: 4 },
    }])
    assert.deepEqual(result.assets.currencies, [{
        currency: "freeMana",
        requestedAmount: 15,
        beforeAmount: 100,
        afterAmount: 115,
    }])
    assertDeepFrozen(result)
    assert.throws(() => { result.entries[0].index = 9 }, TypeError)
    assert.throws(() => { result.assets.characters[0].after.bond_token_list[0].status = 2 }, TypeError)
})

test("duplicate Character outcomes in one plan preserve initial new-character fields under stack-only updates", () => {
    const plan = createRewardGrantExecutionPlan([
        { type: RewardType.CHARACTER, id: 201 },
        { type: RewardType.CHARACTER, id: 201 },
        { type: RewardType.CHARACTER, id: 201 },
    ])
    const joinTime = new Date("2026-01-01T00:00:00.000Z")
    const baseCharacter = {
        entryCount: 1,
        evolutionLevel: 0,
        overLimitStep: 0,
        protection: false,
        joinTime,
        updateTime: joinTime,
        exp: 0,
        stack: 0,
        manaBoardIndex: 1,
        bondTokenList: [{ manaBoardIndex: 1, status: 0 }],
    }
    const initialAfter = projectCharacterGrowthEntry({
        characterId: 201,
        character: baseCharacter,
        state: characterGrowthProjectionStateFromPlayerCharacter(201, baseCharacter),
        viewerId: 0,
        fields: [
            "entry_count",
            "exp",
            "exp_total",
            "bond_token_list",
            "mana_board_index",
            "create_time",
            "update_time",
            "join_time",
        ],
    })
    const firstDuplicateCharacter = {
        ...baseCharacter,
        stack: 1,
        updateTime: new Date("2026-01-01T00:00:01.000Z"),
    }
    const firstStackPatchAfter = projectCharacterGrowthEntry({
        characterId: 201,
        character: firstDuplicateCharacter,
        state: characterGrowthProjectionStateFromPlayerCharacter(201, firstDuplicateCharacter),
        fields: STACK_CHARACTER_GROWTH_FIELDS,
    })
    const secondDuplicateCharacter = {
        ...baseCharacter,
        stack: 2,
        updateTime: new Date("2026-01-01T00:00:02.000Z"),
    }
    const secondStackPatchAfter = projectCharacterGrowthEntry({
        characterId: 201,
        character: secondDuplicateCharacter,
        state: characterGrowthProjectionStateFromPlayerCharacter(201, secondDuplicateCharacter),
        fields: STACK_CHARACTER_GROWTH_FIELDS,
    })
    const result = createRewardGrantExecutionResult(7, plan, [
        {
            kind: "character",
            characterId: 201,
            isNew: true,
            after: initialAfter,
            compensationItem: null,
        },
        {
            kind: "character",
            characterId: 201,
            isNew: false,
            after: firstStackPatchAfter,
            compensationItem: item(102, 1, 1, 0, 0),
        },
        {
            kind: "character",
            characterId: 201,
            isNew: false,
            after: secondStackPatchAfter,
            compensationItem: item(102, 1, 1, 0, 1),
        },
    ], {
        playerId: 7,
        freeMana: 0,
        freeVmoney: 0,
        expPool: 0,
    })

    assert.equal("stack" in result.entries[0].outcome.after, false)
    assert.equal("entry_count" in result.entries[1].outcome.after, false)
    assert.equal("entry_count" in result.entries[2].outcome.after, false)
    assert.deepEqual(result.assets.characters, [{
        characterId: 201,
        joined: true,
        after: {
            ...initialAfter,
            ...firstStackPatchAfter,
            ...secondStackPatchAfter,
        },
    }])
    const projectedPatch = projectCharacterPatch(result.assets.characters[0].after)
    assert.equal(projectedPatch.character_id, 201)
    assert.equal(projectedPatch.entry_count, 1)
    assert.equal(projectedPatch.exp, 0)
    assert.equal(projectedPatch.exp_total, 0)
    assert.equal(projectedPatch.mana_board_index, 1)
    assert.deepEqual(projectedPatch.bond_token_list, [{ mana_board_index: 1, status: 0 }])
    assert.equal(projectedPatch.stack, 2)
    assertDeepFrozen(result)
    assert.deepEqual(snapshotRewardGrantExecutionResultForPlan(7, plan, result), result)
    assert.throws(
        () => snapshotRewardGrantExecutionResultForPlan(7, plan, {
            ...result,
            assets: {
                ...result.assets,
                characters: [{
                    characterId: 201,
                    joined: true,
                    after: secondStackPatchAfter,
                }],
            },
        }),
        RewardGrantContractValidationError,
    )
})

test("collects direct and Character compensation dispositions in execution order", () => {
    const plan = createRewardGrantExecutionPlan([
        { type: RewardType.ITEM, id: 101, count: 2 },
        { type: RewardType.CHARACTER, id: 201 },
    ])
    const result = createRewardGrantExecutionResult(70, plan, [
        { kind: "item", item: item(101, 2, 1, 1, 0, [{
            kind: "mail", itemId: 101, overflowAmount: 1,
        }]) },
        {
            kind: "character",
            characterId: 201,
            isNew: false,
            after: { character_id: 201, stack: 1 },
            compensationItem: item(102, 1, 0, 1, 0, [{
                kind: "mail", itemId: 102, overflowAmount: 1,
            }]),
        },
    ], { playerId: 70, freeMana: 0, freeVmoney: 0, expPool: 0 })

    assert.deepEqual(collectRewardGrantItemOverflowDispositions(result), [
        { kind: "mail", itemId: 101, overflowAmount: 1 },
        { kind: "mail", itemId: 102, overflowAmount: 1 },
    ])
})

test("direct Item and character compensation share one continuous final Item result", () => {
    const plan = createRewardGrantExecutionPlan([
        { type: RewardType.ITEM, id: 14002, count: 2 },
        { type: RewardType.CHARACTER, id: 1 },
    ])
    const result = createRewardGrantExecutionResult(8, plan, [
        { kind: "item", item: item(14002, 2, 2, 0, 4) },
        {
            kind: "character",
            characterId: 1,
            isNew: false,
            after: { character_id: 1, stack: 1 },
            compensationItem: item(14002, 1, 1, 0, 6),
        },
    ], { playerId: 8, freeMana: 0, freeVmoney: 0, expPool: 0 })

    assert.deepEqual(result.assets.items, [item(14002, 3, 3, 0, 4)])
    assert.equal(result.assets.items[0].afterAmount, 7)
})

test("typed result rejects outcome identity allocation and sequence mismatches", () => {
    const plan = createRewardGrantExecutionPlan([
        { type: RewardType.ITEM, id: 101, count: 2 },
        { type: RewardType.ITEM, id: 101, count: 3 },
    ])
    const playerAfter = { playerId: 9, freeMana: 0, freeVmoney: 0, expPool: 0 }
    for (const outcomes of [
        [{ kind: "item", item: item(999, 2, 2, 0, 0) }, { kind: "item", item: item(101, 3, 3, 0, 2) }],
        [{ kind: "currency", currency: "freeMana", requestedAmount: 2, beforeAmount: 0, afterAmount: 2 }, { kind: "item", item: item(101, 3, 3, 0, 2) }],
        [{ kind: "item", item: item(101, 2, 1, 0, 0) }, { kind: "item", item: item(101, 3, 3, 0, 1) }],
        [{ kind: "item", item: item(101, 2, 2, 0, 0) }, { kind: "item", item: item(101, 3, 3, 0, 7) }],
        [{ kind: "item", item: item(101, 2, 1, 1, 0, [{
            kind: "mail", itemId: 999, overflowAmount: 1,
        }]) }, { kind: "item", item: item(101, 3, 3, 0, 1) }],
    ]) {
        assert.throws(
            () => createRewardGrantExecutionResult(9, plan, outcomes, playerAfter),
            RewardGrantContractValidationError,
        )
    }
})

test("snapshot validator rejects post-execution index reward and asset mismatches", () => {
    const plan = createRewardGrantExecutionPlan([{ type: RewardType.ITEM, id: 101, count: 2 }])
    const canonical = createRewardGrantExecutionResult(
        10,
        plan,
        [{ kind: "item", item: item(101, 2, 2, 0, 0) }],
        { playerId: 10, freeMana: 0, freeVmoney: 0, expPool: 0 },
    )
    assert.deepEqual(snapshotRewardGrantExecutionResultForPlan(10, plan, canonical), canonical)

    for (const forged of [
        { ...canonical, entries: [{ ...canonical.entries[0], index: 1 }] },
        { ...canonical, entries: [{ ...canonical.entries[0], reward: { type: RewardType.ITEM, id: 102, count: 2 } }] },
        { ...canonical, assets: { ...canonical.assets, items: [] } },
    ]) {
        assert.throws(
            () => snapshotRewardGrantExecutionResultForPlan(10, plan, forged),
            RewardGrantContractValidationError,
        )
    }
})
