"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { buildCharacterManaMutationContent } = require(
    "../src/lib/character-mana-mutation-content",
)

const nodes = {
    "101": { items: { "1": 2 }, manaCost: 3, field1: "0", field5: "0", field6: "1" },
    "102": { items: {}, manaCost: 4, field1: "0", field5: "0", field6: "2" },
}

const levelRequirements = Object.fromEntries([1, 2, 3, 4, 5].map(rarity => [String(rarity), {
    abilityLevels: [null, null, null, null, null, null],
    skillEvolutionLevel: null,
}]))

test("planner content adapter uses one board's nodes, parent index, and level requirements", () => {
    const content = buildCharacterManaMutationContent(10, 1, {
        manaNodes: { "10": { "1": nodes } },
        manaBoard: {
            "10": {
                "1": {
                    "1": [["101", "0", "2", "1", "3", "(None)"]],
                    "2": [["102", "0", "", "", "4", "101"]],
                },
            },
        },
        levelRequirements,
    })

    assert.equal(content.characterId, 10)
    assert.equal(content.boardId, 1)
    assert.deepEqual(content.nodes, nodes)
    assert.deepEqual(content.parents, { "101": null, "102": 101 })
    assert.equal(content.levelRequirements["1"].abilityLevels[0], null)
})

test("planner content adapter fails closed for a missing board", () => {
    assert.throws(
        () => buildCharacterManaMutationContent(10, 2, {
            manaNodes: { "10": { "1": nodes } },
            manaBoard: {},
            levelRequirements,
        }),
        error => error.code === "CONTENT_INVALID",
    )
})

test("planner content adapter normalizes malformed parent content", () => {
    assert.throws(
        () => buildCharacterManaMutationContent(10, 1, {
            manaNodes: { "10": { "1": nodes } },
            manaBoard: {
                "10": {
                    "1": {
                        "1": [["101", "0", "2", "1", "3", "not-a-node"]],
                    },
                },
            },
            levelRequirements,
        }),
        error => error.code === "CONTENT_INVALID"
            && error.name === "ManaNodeMutationValidationError",
    )
})

test("planner content adapter wraps malformed parent content with a stable code", () => {
    assert.throws(
        () => buildCharacterManaMutationContent(10, 1, {
            manaNodes: { "10": { "1": nodes } },
            manaBoard: {
                "10": {
                    "1": {
                        "1": [["101", "0", "2", "1", "3", "malformed-parent"]],
                        "2": [["102", "0", "", "", "4", "101"]],
                    },
                },
            },
            levelRequirements,
        }),
        error => {
            assert.equal(error.name, "ManaNodeMutationValidationError")
            assert.equal(error.code, "CONTENT_INVALID")
            assert.match(error.message, /invalid mana board parent content/)
            return true
        },
    )
})
