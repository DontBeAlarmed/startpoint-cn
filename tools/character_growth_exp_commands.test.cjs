"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const exp = require("../src/lib/character-growth/commands/inject-exp")
const rewardExp = require("../src/lib/character-growth/commands/grant-character-exp")
const stack = require("../src/lib/character-growth/commands/stack-to-exp")
const bulk = require("../src/lib/character-growth/commands/bulk-stack-to-exp")
const { createCharacterGrowthC4Fixture } = require("./helpers/character-growth-c4-fixture.cjs")

test("C4 EXP commands expose the approved Growth entry points", () => {
    assert.equal(typeof exp.executeInjectCharacterExp, "function")
    assert.equal(typeof rewardExp.grantCharacterExpWithinTransactionSync, "function")
    assert.equal(typeof stack.executeStackToExp, "function")
    assert.equal(typeof bulk.executeBulkStackToExp, "function")
})

test("inject_exp spends the pool, caps character EXP, and returns overflow to the pool", () => {
    const fixture = createCharacterGrowthC4Fixture()
    try {
        const playerId = fixture.createPlayer()
        fixture.setPlayer(playerId, { expPool: 1000 })
        const first = exp.executeInjectCharacterExp({
            playerId,
            characterId: 1,
            addExp: 1000,
            evaluationTime: new Date("2026-08-31T00:00:00.000Z"),
        })
        assert.equal(first.expPool, 0)
        assert.equal(fixture.setPlayer(playerId, {}).expPool, 0)
        assert.equal(first.after.exp, 1010)

        for (const addExp of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
            assert.throws(
                () => exp.executeInjectCharacterExp({
                    playerId,
                    characterId: 1,
                    addExp,
                    evaluationTime: new Date("2026-08-31T00:00:00.000Z"),
                }),
                error => error.code === "INVALID_REQUEST",
            )
        }

        fixture.setPlayer(playerId, { expPool: 0 })
        fixture.addCharacter(playerId, 341003, { exp: 37241, overLimitStep: 0 })
        const overflow = rewardExp.grantCharacterExp({
            playerId,
            characterIds: [341003],
            amount: 20,
            evaluationTime: new Date("2026-08-31T00:00:00.000Z"),
        })
        assert.equal(overflow.add_exp_list[0].after_exp, 37241)
        assert.equal(overflow.add_exp_list[0].add_exp_pool, 20)
        assert.equal(overflow.exp_pool, 20)
    } finally {
        fixture.cleanup()
    }
})
