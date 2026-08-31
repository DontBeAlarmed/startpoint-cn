"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const overLimit = require("../src/lib/character-growth/commands/over-limit")
const bulk = require("../src/lib/character-growth/commands/bulk-over-limit")
const { createCharacterGrowthC4Fixture } = require("./helpers/character-growth-c4-fixture.cjs")

test("C4 over-limit commands have single and batch APIs", () => {
    assert.equal(typeof overLimit.executeOverLimit, "function")
    assert.equal(typeof bulk.executeBulkOverLimit, "function")
})

test("over_limit spends either duplicate stack or the rarity-appropriate item atomically", () => {
    const fixture = createCharacterGrowthC4Fixture()
    try {
        const playerId = fixture.createPlayer()
        fixture.addCharacter(playerId, 341003, { stack: 3, overLimitStep: 0 })
        const stackResult = overLimit.executeOverLimit({
            playerId,
            characterId: 341003,
            overLimitCount: 2,
            useStack: true,
            evaluationTime: new Date("2026-08-31T00:00:00.000Z"),
        })
        assert.equal(stackResult.after.overLimitStep, 2)
        assert.equal(stackResult.after.stack, 1)

        fixture.giveItem(playerId, 10001, 1)
        const itemResult = overLimit.executeOverLimit({
            playerId,
            characterId: 341003,
            overLimitCount: 1,
            useStack: false,
            itemId: 10001,
            evaluationTime: new Date("2026-08-31T00:00:00.000Z"),
        })
        assert.equal(itemResult.after.overLimitStep, 3)
        assert.equal(itemResult.after.stack, 1)
        assert.equal(itemResult.itemCount, 0)
        assert.equal(fixture.item(playerId, 10001), 0)

        assert.throws(
            () => overLimit.executeOverLimit({
                playerId,
                characterId: 341003,
                overLimitCount: 6,
                useStack: true,
                evaluationTime: new Date("2026-08-31T00:00:00.000Z"),
            }),
            error => error.code === "INVALID_REQUEST",
        )

        assert.throws(
            () => overLimit.executeOverLimit({
                playerId,
                characterId: 341003,
                overLimitCount: 1,
                useStack: false,
                itemId: 10003,
                evaluationTime: new Date("2026-08-31T00:00:00.000Z"),
            }),
            error => error.code === "INVALID_REQUEST",
        )
    } finally {
        fixture.cleanup()
    }
})

test("bulk_over_limit consumes eligible stack in a single batch write and never exceeds cap", () => {
    const fixture = createCharacterGrowthC4Fixture()
    try {
        const playerId = fixture.createPlayer()
        fixture.addCharacter(playerId, 341003, { stack: 3, overLimitStep: 7 })
        fixture.addCharacter(playerId, 341004, { stack: 10, overLimitStep: 0 })
        const result = bulk.executeBulkOverLimit({
            playerId,
            evaluationTime: new Date("2026-08-31T00:00:00.000Z"),
        })
        assert.deepEqual(result.characters.map(character => [
            character.characterId,
            character.overLimitStep,
            character.stack,
        ]), [
            [341003, 8, 2],
            [341004, 8, 2],
        ])
    } finally {
        fixture.cleanup()
    }
})
