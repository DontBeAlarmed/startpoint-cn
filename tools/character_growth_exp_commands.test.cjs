"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const playerDomain = require("../src/data/domains/player")
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

test("reward EXP trusts an explicit zero pool and reads a standalone player only once", () => {
    const fixture = createCharacterGrowthC4Fixture()
    const originalGetPlayerSync = playerDomain.getPlayerSync
    try {
        const playerId = fixture.createPlayer()
        fixture.setPlayer(playerId, { expPool: 1000 })
        let playerReads = 0
        playerDomain.getPlayerSync = (...args) => {
            playerReads += 1
            return originalGetPlayerSync(...args)
        }
        const explicit = fixture.db.transaction(() => rewardExp.grantCharacterExpWithinTransactionSync({
            playerId,
            characterIds: [1],
            amount: 1,
            knownExpPool: 0,
        }))()
        assert.equal(playerReads, 0)
        assert.equal(explicit.exp_pool, 0)

        fixture.addCharacter(playerId, 341003, { exp: 37241, overLimitStep: 0 })
        const standalone = rewardExp.grantCharacterExp({
            playerId,
            characterIds: [341003],
            amount: 20,
        })
        assert.equal(playerReads, 1)
        assert.equal(standalone.exp_pool, 1020)
        assert.equal(fixture.setPlayer(playerId, {}).expPool, 1020)
    } finally {
        playerDomain.getPlayerSync = originalGetPlayerSync
        fixture.cleanup()
    }
})

test("reward EXP rejects raw persisted Growth corruption before writing", () => {
    const fixture = createCharacterGrowthC4Fixture()
    try {
        const playerId = fixture.createPlayer()
        fixture.db.prepare(`
            UPDATE players_characters
            SET protection = 2
            WHERE player_id = ? AND id = 1
        `).run(playerId)
        const before = fixture.db.prepare(`
            SELECT exp, update_time
            FROM players_characters
            WHERE player_id = ? AND id = 1
        `).get(playerId)

        assert.throws(
            () => rewardExp.grantCharacterExp({
                playerId,
                characterIds: [1],
                amount: 1,
                knownExpPool: 0,
            }),
            error => error.code === "INVALID_GROWTH_STATE"
                && /protection must be 0 or 1/.test(error.message),
        )
        assert.deepEqual(fixture.db.prepare(`
            SELECT exp, update_time
            FROM players_characters
            WHERE player_id = ? AND id = 1
        `).get(playerId), before)
    } finally {
        fixture.cleanup()
    }
})

test("reward EXP keeps character and bond-token reads before its single batch write", () => {
    const source = fs.readFileSync(path.join(
        __dirname,
        "../src/lib/character-growth/commands/grant-character-exp.ts",
    ), "utf8")
    const seedRead = source.indexOf("const seeds = readProjectionSeeds(")
    const batchWrite = source.indexOf("updateCharacterGrowthRowsSync(command.playerId, updates)")

    assert.ok(seedRead >= 0 && batchWrite > seedRead)
    assert.equal((source.match(/getPlayerSync\(/g) ?? []).length, 1)
    assert.equal((source.match(/getPlayerCharactersWithStoredGrowthByIdsSync\(/g) ?? []).length, 1)
    assert.match(source, /storedCharactersSnapshot:\s*seeds\.storedCharacters/)
    assert.match(source, /bondTokenSnapshots:\s*seeds\.bondTokens/)
    assert.doesNotMatch(source.slice(batchWrite), /getPlayerCharactersWithStoredGrowthByIdsSync\(/)
    assert.doesNotMatch(source.slice(batchWrite), /getPlayerSync\(/)
})
