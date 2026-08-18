"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

let computeCharacterEvolutionLevel
let buildCharacterEvolutionNodes
try {
    ({
        buildCharacterEvolutionNodes,
        computeCharacterEvolutionLevel,
    } = require("../src/lib/character-evolution"))
} catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error
}

const nodes = [
    { id: 2201, abilitySlotIndex: 1, isSkillEvolutionRequisite: false },
    { id: 2202, abilitySlotIndex: 1, isSkillEvolutionRequisite: false },
    { id: 2207, abilitySlotIndex: 2, isSkillEvolutionRequisite: false },
    { id: 2213, abilitySlotIndex: 3, isSkillEvolutionRequisite: false },
    { id: 2219, abilitySlotIndex: null, isSkillEvolutionRequisite: true },
    { id: 2220, abilitySlotIndex: null, isSkillEvolutionRequisite: false },
    { id: 2401, abilitySlotIndex: 4, isSkillEvolutionRequisite: false },
    { id: 2419, abilitySlotIndex: null, isSkillEvolutionRequisite: true },
]

function compute(learnedNodeIds, awakeLevels = new Map(), definitions = nodes) {
    assert.equal(typeof computeCharacterEvolutionLevel, "function", "应导出纯 evolution 计算函数")
    return computeCharacterEvolutionLevel({
        nodes: definitions,
        learnedNodeIds: new Set(learnedNodeIds),
        awakeLevels,
    })
}

test("未满一板但每个 ability slot 和 skill-evolution requisite 均已学习时进化为 1", () => {
    assert.equal(compute([2201, 2207, 2213, 2219]), 1)
})

test("缺少任一一板 ability slot 时不进化", () => {
    assert.equal(compute([2201, 2207, 2219]), 0)
})

test("存在 skill-evolution requisite 但未学习时不进化", () => {
    assert.equal(compute([2201, 2207, 2213]), 0)
})

test("没有 skill-evolution requisite 的角色在 slot 条件满足时进化为 1", () => {
    const withoutSkillEvolution = nodes.filter(node => !node.isSkillEvolutionRequisite)
    assert.equal(compute([2201, 2207, 2213], new Map(), withoutSkillEvolution), 1)
})

test("第一枚 skill-evolution requisite 的 awake 1/2 对应进化 2/3", () => {
    const learned = [2201, 2207, 2213, 2219]
    assert.equal(compute(learned, new Map([[2219, 1]])), 2)
    assert.equal(compute(learned, new Map([[2219, 2]])), 3)
})

test("觉醒普通节点不会提高进化等级", () => {
    assert.equal(
        compute([2201, 2207, 2213, 2219, 2220], new Map([[2220, 2]])),
        1,
    )
})

test("二板节点不贡献 slot、requisite 或 awake 等级", () => {
    assert.equal(compute([2201, 2207, 2219, 2401, 2419], new Map([[2419, 2]])), 0)
})

test("runtime adapter parses retained raw fields and rejects unknown semantics", () => {
    assert.deepEqual(buildCharacterEvolutionNodes({
        "2201": { items: {}, manaCost: 0, field1: "0", field5: "0", field6: "1" },
        "2219": { items: {}, manaCost: 0, field1: "0", field5: "2", field6: "" },
    }), [
        { id: 2201, abilitySlotIndex: 1, isSkillEvolutionRequisite: false },
        { id: 2219, abilitySlotIndex: null, isSkillEvolutionRequisite: true },
    ])
    assert.throws(
        () => buildCharacterEvolutionNodes({
            "2201": { items: {}, manaCost: 0, field1: "0", field5: "9", field6: "" },
        }),
        /unknown ability effect kind/i,
    )
})
