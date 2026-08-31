"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const stack = require("../src/lib/character-growth/commands/stack-to-exp")
const bulk = require("../src/lib/character-growth/commands/bulk-stack-to-exp")
const { createCharacterGrowthC4Fixture } = require("./helpers/character-growth-c4-fixture.cjs")

test("C4 stack commands have single and batch APIs", () => {
    assert.equal(typeof stack.executeStackToExp, "function")
    assert.equal(typeof bulk.executeBulkStackToExp, "function")
})

test("stack_to_exp preserves protection, moves EXP/Star Grain, and returns absolute stack", () => {
    const fixture = createCharacterGrowthC4Fixture()
    try {
        const playerId = fixture.createPlayer()
        fixture.addCharacter(playerId, 341003, { stack: 3, overLimitStep: 8, protection: false })
        const result = stack.executeStackToExp({
            playerId,
            characterId: 341003,
            useStackCount: 2,
            evaluationTime: new Date("2026-08-31T00:00:00.000Z"),
        })
        assert.equal(result.after.stack, 1)
        assert.equal(result.addExp, 1000)
        assert.equal(result.addStarGrain, 4)
        assert.equal(result.expPool, 1000)
        assert.equal(fixture.item(playerId, 990008), 4)

        fixture.addCharacter(playerId, 341003, { stack: 1, protection: true })
        assert.throws(
            () => stack.executeStackToExp({
                playerId,
                characterId: 341003,
                useStackCount: 1,
                evaluationTime: new Date("2026-08-31T00:00:00.000Z"),
            }),
            error => error.code === "INVALID_REQUEST",
        )
        assert.equal(fixture.item(playerId, 990008), 4)
    } finally {
        fixture.cleanup()
    }
})

test("bulk_stack_to_exp reads and writes all eligible characters as one growth operation", () => {
    const fixture = createCharacterGrowthC4Fixture()
    try {
        const playerId = fixture.createPlayer()
        fixture.addCharacter(playerId, 341003, { stack: 2, overLimitStep: 8, protection: false })
        fixture.addCharacter(playerId, 341004, { stack: 1, overLimitStep: 8, protection: false })
        const result = bulk.executeBulkStackToExp({
            playerId,
            evaluationTime: new Date("2026-08-31T00:00:00.000Z"),
        })
        assert.deepEqual(result.characters.map(character => character.characterId), [341003, 341004])
        assert.deepEqual(result.characters.map(character => character.stack), [0, 0])
        assert.equal(result.addExp, 1500)
        assert.equal(result.addStarGrain, 6)
        assert.equal(fixture.item(playerId, 990008), 6)
    } finally {
        fixture.cleanup()
    }
})
