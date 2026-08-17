"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
    createRewardGrantPlan,
    RewardGrantPlanValidationError,
} = require("../src/lib/reward-grant")
const { RewardType } = require("../src/lib/types/rewards")

test("preserves entry order and source identity while snapshotting rewards", () => {
    const firstSource = { drawIndex: 2 }
    const secondSource = { mailId: 17 }
    const firstReward = { type: RewardType.ITEM, id: 910001, count: 2 }
    const input = [
        { source: firstSource, reward: firstReward },
        { source: secondSource, reward: { type: RewardType.MANA, count: 30 } },
    ]

    const plan = createRewardGrantPlan(input)

    assert.equal(plan.entries[0].source, firstSource)
    assert.equal(plan.entries[1].source, secondSource)
    assert.notEqual(plan.entries[0].reward, firstReward)
    assert.deepEqual(plan.entries.map(entry => entry.source), [firstSource, secondSource])
    assert.deepEqual(plan.entries[0].reward, firstReward)
    assert.equal(Object.isFrozen(plan), true)
    assert.equal(Object.isFrozen(plan.entries), true)
    assert.equal(Object.isFrozen(plan.entries[0]), true)
    assert.equal(Object.isFrozen(plan.entries[0].reward), true)
    assert.equal(Object.isFrozen(firstSource), false)

    firstReward.count = 99
    input.reverse()
    assert.equal(plan.entries[0].reward.count, 2)
    assert.equal(plan.entries[0].source, firstSource)
})

test("allows an empty immutable plan", () => {
    const plan = createRewardGrantPlan([])

    assert.deepEqual(plan.entries, [])
    assert.equal(Object.isFrozen(plan), true)
    assert.equal(Object.isFrozen(plan.entries), true)
})

test("accepts every known reward type with its required fields", () => {
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

    const plan = createRewardGrantPlan(rewards.map((reward, index) => ({
        source: index,
        reward,
    })))

    assert.deepEqual(plan.entries.map(entry => entry.reward), rewards)
})

test("rejects unknown reward types", () => {
    assert.throws(
        () => createRewardGrantPlan([{ source: "unknown", reward: { type: 999, id: 1, count: 1 } }]),
        error => error instanceof RewardGrantPlanValidationError
            && error.entryIndex === 0
            && error.field === "type",
    )
})

test("rejects malformed runtime plan containers entries and rewards with typed errors", () => {
    const scenarios = [
        { name: "null entries", input: null, entryIndex: -1, field: "entries" },
        { name: "object entries", input: {}, entryIndex: -1, field: "entries" },
        { name: "null entry", input: [null], entryIndex: 0, field: "entry" },
        { name: "empty entry", input: [{}], entryIndex: 0, field: "reward" },
        { name: "missing reward", input: [{ source: "missing" }], entryIndex: 0, field: "reward" },
        { name: "null reward", input: [{ source: "null", reward: null }], entryIndex: 0, field: "reward" },
    ]

    for (const scenario of scenarios) {
        assert.throws(
            () => createRewardGrantPlan(scenario.input),
            error => error instanceof RewardGrantPlanValidationError
                && error.entryIndex === scenario.entryIndex
                && error.field === scenario.field,
            scenario.name,
        )
    }
})

test("preserves an undefined source without validating or freezing it", () => {
    const plan = createRewardGrantPlan([{
        source: undefined,
        reward: { type: RewardType.MANA, count: 1 },
    }])

    assert.equal(plan.entries[0].source, undefined)
})

test("reads entry and reward fields once while creating an exact reward snapshot", () => {
    const source = { drawIndex: 9 }
    const entryReads = { source: 0, reward: 0 }
    const rewardReads = { name: 0, type: 0, id: 0, count: 0, extra: 0 }
    const reward = new Proxy({
        name: "snapshot",
        type: RewardType.ITEM,
        id: 910010,
        count: 3,
        extra: "must be dropped",
    }, {
        get(target, property, receiver) {
            if (property in rewardReads) rewardReads[property]++
            return Reflect.get(target, property, receiver)
        },
    })
    const entry = new Proxy({ source, reward }, {
        get(target, property, receiver) {
            if (property in entryReads) entryReads[property]++
            return Reflect.get(target, property, receiver)
        },
    })

    const plan = createRewardGrantPlan([entry])

    assert.deepEqual(entryReads, { source: 1, reward: 1 })
    assert.deepEqual(rewardReads, { name: 1, type: 1, id: 1, count: 1, extra: 0 })
    assert.equal(plan.entries[0].source, source)
    assert.deepEqual(plan.entries[0].reward, {
        name: "snapshot",
        type: RewardType.ITEM,
        id: 910010,
        count: 3,
    })
})

test("freezes the first getter snapshot instead of later invalid values", () => {
    const reads = { name: 0, type: 0, id: 0, count: 0 }
    const firstThen = (field, first, later) => {
        reads[field]++
        return reads[field] === 1 ? first : later
    }
    const reward = {
        get name() { return firstThen("name", "first", "later") },
        get type() { return firstThen("type", RewardType.ITEM, 999) },
        get id() { return firstThen("id", 910011, 0) },
        get count() { return firstThen("count", 2, -1) },
    }

    const plan = createRewardGrantPlan([{ source: "flip", reward }])

    assert.deepEqual(reads, { name: 1, type: 1, id: 1, count: 1 })
    assert.deepEqual(plan.entries[0].reward, {
        name: "first",
        type: RewardType.ITEM,
        id: 910011,
        count: 2,
    })
    assert.equal(Object.isFrozen(plan.entries[0].reward), true)
})

test("rejects non-string reward names without producing a plan", () => {
    for (const name of [{ text: "object" }, ["array"], 7, null]) {
        let plan

        assert.throws(
            () => {
                plan = createRewardGrantPlan([{
                    source: "invalid-name",
                    reward: { name, type: RewardType.ITEM, id: 910012, count: 1 },
                }])
            },
            error => error instanceof RewardGrantPlanValidationError
                && error.entryIndex === 0
                && error.field === "name",
        )
        assert.equal(plan, undefined)
    }
})

test("reads a flipping name getter once and snapshots its valid first value", () => {
    let nameReads = 0
    const reward = {
        get name() {
            nameReads++
            return nameReads === 1 ? "first" : { invalid: true }
        },
        type: RewardType.MANA,
        count: 5,
    }

    const plan = createRewardGrantPlan([{ source: "name-snapshot", reward }])

    assert.equal(nameReads, 1)
    assert.deepEqual(plan.entries[0].reward, {
        name: "first",
        type: RewardType.MANA,
        count: 5,
    })
})

const invalidNumbers = [undefined, NaN, Infinity, 1.5, 0, -1, Number.MAX_SAFE_INTEGER + 1]

for (const type of [
    RewardType.ITEM,
    RewardType.EQUIPMENT,
    RewardType.CHARACTER,
    RewardType.ELEMENT,
    RewardType.AETHER,
]) {
    test(`rejects every invalid id for reward type ${type}`, () => {
        for (const id of invalidNumbers) {
            const reward = { type, id, count: 1 }
            if (type === RewardType.CHARACTER) delete reward.count
            assert.throws(
                () => createRewardGrantPlan([{ source: type, reward }]),
                error => error instanceof RewardGrantPlanValidationError
                    && error.entryIndex === 0
                    && error.field === "id",
                `expected id ${String(id)} to be rejected`,
            )
        }
    })
}

for (const type of [
    RewardType.ITEM,
    RewardType.EQUIPMENT,
    RewardType.BEADS,
    RewardType.MANA,
    RewardType.EXP,
    RewardType.ELEMENT,
    RewardType.AETHER,
]) {
    test(`rejects every invalid count for reward type ${type}`, () => {
        for (const count of invalidNumbers) {
            const reward = { type, id: 1, count }
            if ([RewardType.BEADS, RewardType.MANA, RewardType.EXP].includes(type)) {
                delete reward.id
            }
            assert.throws(
                () => createRewardGrantPlan([{ source: type, reward }]),
                error => error instanceof RewardGrantPlanValidationError
                    && error.entryIndex === 0
                    && error.field === "count",
                `expected count ${String(count)} to be rejected`,
            )
        }
    })
}
