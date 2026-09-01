"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")
const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")

const rewardExp = require("../src/lib/character-growth/commands/grant-character-exp")
const rewardStack = require("../src/lib/character-growth/commands/grant-character-stack")
const injectExp = require("../src/lib/character-growth/commands/inject-exp")
const stackToExp = require("../src/lib/character-growth/commands/stack-to-exp")
const { createCharacterGrowthC4Fixture } = require("./helpers/character-growth-c4-fixture.cjs")
const expodRoutes = require("../src/routes/api/expod").default
const characterRoutes = require("../src/routes/api/character").default

test("C4 reward collaborators expose Growth-owned character boundaries", () => {
    assert.equal(typeof rewardExp.grantCharacterExp, "function")
    assert.equal(typeof rewardStack.grantCharacterStack, "function")
})

test("Growth EXP transaction rolls back pool, character, and mission fact together", () => {
    const fixture = createCharacterGrowthC4Fixture()
    try {
        const playerId = fixture.createPlayer()
        fixture.setPlayer(playerId, { expPool: 100 })
        const before = {
            player: fixture.db.prepare("SELECT exp_pool FROM players WHERE id = ?").get(playerId),
            character: fixture.db.prepare("SELECT exp FROM players_characters WHERE player_id = ? AND id = 1").get(playerId),
            counter: fixture.db.prepare("SELECT total_injected_exp_count FROM players_active_mission_counters WHERE player_id = ?").get(playerId),
        }
        fixture.db.exec(`
            CREATE TRIGGER reject_growth_exp
            BEFORE UPDATE OF exp ON players_characters
            WHEN OLD.player_id = ${playerId}
            BEGIN SELECT RAISE(ABORT, 'forced growth exp failure'); END;
        `)
        assert.throws(
            () => injectExp.executeInjectCharacterExp({
                playerId,
                characterId: 1,
                addExp: 50,
                evaluationTime: new Date("2026-08-31T00:00:00.000Z"),
            }),
        )
        assert.deepEqual({
            player: fixture.db.prepare("SELECT exp_pool FROM players WHERE id = ?").get(playerId),
            character: fixture.db.prepare("SELECT exp FROM players_characters WHERE player_id = ? AND id = 1").get(playerId),
            counter: fixture.db.prepare("SELECT total_injected_exp_count FROM players_active_mission_counters WHERE player_id = ?").get(playerId),
        }, before)
    } finally {
        fixture.cleanup()
    }
})

test("stack conversion rolls stack, EXP pool, current item, and collection fact back together", () => {
    const fixture = createCharacterGrowthC4Fixture()
    try {
        const playerId = fixture.createPlayer()
        fixture.setPlayer(playerId, { expPool: 100 })
        fixture.addCharacter(playerId, 341003, {
            stack: 3,
            overLimitStep: 8,
            protection: false,
        })
        const readState = () => ({
            player: fixture.db.prepare("SELECT exp_pool FROM players WHERE id = ?").get(playerId),
            character: fixture.db.prepare(`
                SELECT stack
                FROM players_characters
                WHERE player_id = ? AND id = 341003
            `).get(playerId),
            item: fixture.db.prepare(`
                SELECT amount
                FROM players_items
                WHERE player_id = ? AND id = 990008
            `).get(playerId),
            collectedItem: fixture.db.prepare(`
                SELECT total_obtained
                FROM players_collected_items
                WHERE player_id = ? AND item_id = 990008
            `).get(playerId),
        })
        const before = readState()
        fixture.db.exec(`
            CREATE TRIGGER reject_stack_conversion_reward_fact
            BEFORE INSERT ON players_collected_items
            WHEN NEW.player_id = ${playerId} AND NEW.item_id = 990008
            BEGIN SELECT RAISE(ABORT, 'forced stack conversion reward fact failure'); END;
        `)

        assert.throws(
            () => stackToExp.executeStackToExp({
                playerId,
                characterId: 341003,
                useStackCount: 2,
                evaluationTime: new Date("2026-08-31T00:00:00.000Z"),
            }),
            /forced stack conversion reward fact failure/,
        )
        assert.deepEqual(readState(), before)
    } finally {
        fixture.cleanup()
    }
})

test("duplicate character reward returns final absolute stack and rolls back with its compensation item", () => {
    const fixture = createCharacterGrowthC4Fixture()
    try {
        const playerId = fixture.createPlayer()
        fixture.addCharacter(playerId, 341003, { stack: 4 })
        const first = rewardStack.grantCharacterStack({ playerId, characterId: 341003 })
        assert.equal(first.character.stack, 5)
        assert.equal(fixture.item(playerId, 14010), 1)

        fixture.db.exec(`
            CREATE TRIGGER reject_stack_growth
            BEFORE UPDATE OF stack ON players_characters
            WHEN OLD.player_id = ${playerId} AND OLD.id = 341003
            BEGIN SELECT RAISE(ABORT, 'forced growth stack failure'); END;
        `)
        assert.throws(() => rewardStack.grantCharacterStack({ playerId, characterId: 341003 }))
        assert.equal(fixture.addCharacter(playerId, 341003).stack, 5)
        assert.equal(fixture.item(playerId, 14010), 1)
    } finally {
        fixture.cleanup()
    }
})

test("repository rejects invalid persisted EXP/stack values at the save boundary", () => {
    const fixture = createCharacterGrowthC4Fixture()
    try {
        const playerId = fixture.createPlayer()
        fixture.db.prepare("UPDATE players_characters SET exp = ? WHERE player_id = ? AND id = 1").run(-1, playerId)
        assert.throws(
            () => injectExp.executeInjectCharacterExp({
                playerId,
                characterId: 1,
                addExp: 1,
                evaluationTime: new Date("2026-08-31T00:00:00.000Z"),
            }),
            error => error.code === "INVALID_GROWTH_STATE",
        )
        fixture.db.prepare("UPDATE players_characters SET exp = 0, stack = ? WHERE player_id = ? AND id = 1")
            .run(1.5, playerId)
        assert.throws(
            () => rewardStack.grantCharacterStack({ playerId, characterId: 1 }),
            error => error.code === "INVALID_GROWTH_STATE",
        )
    } finally {
        fixture.cleanup()
    }
})

test("inject_exp maps persisted Growth corruption to HTTP 500", async () => {
    const fixture = createCharacterGrowthC4Fixture()
    const app = Fastify({ logger: false })
    try {
        const playerId = fixture.createPlayer()
        const viewerId = await fixture.createViewer(playerId, 890000009)
        fixture.db.prepare("UPDATE players_characters SET exp = -1 WHERE player_id = ? AND id = 1")
            .run(playerId)
        await app.register(expodRoutes)
        await app.ready()

        const response = await app.inject({
            method: "POST",
            url: "/inject_exp",
            payload: { viewer_id: viewerId, character_id: 1, exp: 1 },
        })
        assert.equal(response.statusCode, 500, response.body)
        assert.equal(JSON.parse(response.body).error, "Internal Server Error")
        assert.match(JSON.parse(response.body).message, /INVALID_GROWTH_STATE/)
    } finally {
        await app.close()
        fixture.cleanup()
    }
})

test("all five CN growth routes keep their transport response shape", async () => {
    const fixture = createCharacterGrowthC4Fixture()
    const app = Fastify({ logger: false })
    app.addHook("onSend", (_request, reply, payload, done) => {
        if (String(reply.getHeader("content-type") ?? "").includes("application/x-msgpack")) {
            done(null, pack(payload).toString("base64"))
            return
        }
        done(null, payload)
    })
    try {
        const playerId = fixture.createPlayer()
        const viewerId = await fixture.createViewer(playerId, 890000001)
        fixture.setPlayer(playerId, { expPool: 1000 })
        fixture.addCharacter(playerId, 341003, { stack: 2, overLimitStep: 8 })
        fixture.addCharacter(playerId, 341004, { stack: 1, overLimitStep: 8 })
        fixture.addCharacter(playerId, 341005, { stack: 1, overLimitStep: 0 })
        fixture.giveItem(playerId, 10002, 1)
        await app.register(expodRoutes)
        await app.register(characterRoutes)
        await app.ready()
        const post = (url, payload) => app.inject({ method: "POST", url, payload })
        const inject = await post("/inject_exp", { viewer_id: viewerId, character_id: 1, exp: 100 })
        assert.equal(inject.statusCode, 200)
        assert.equal(unpack(Buffer.from(inject.body, "base64")).data.add_exp_list[0].character_id, 1)

        const stack = await post("/stack_to_exp", {
            viewer_id: viewerId, character_id: 341003, number: 1,
        })
        assert.equal(stack.statusCode, 200)
        assert.equal(unpack(Buffer.from(stack.body, "base64")).data.character_list[0].stack, 1)

        const bulkStack = await post("/bulk_stack_to_exp", { viewer_id: viewerId })
        assert.equal(bulkStack.statusCode, 200)
        assert.equal(unpack(Buffer.from(bulkStack.body, "base64")).data.character_list.length, 2)

        const overLimit = await post("/over_limit", {
            viewer_id: viewerId, character_id: 1, use_stack: false,
            item_id: 10002, over_limit_count: 1,
        })
        assert.equal(overLimit.statusCode, 200)
        assert.equal(unpack(Buffer.from(overLimit.body, "base64")).data.character_list[0].over_limit_step, 1)

        const bulkOverLimit = await post("/bulk_over_limit", { viewer_id: viewerId })
        assert.equal(bulkOverLimit.statusCode, 200)
        const bulkPayload = unpack(Buffer.from(bulkOverLimit.body, "base64"))
        assert.deepEqual(bulkPayload.data.character_list.map(character => character.character_id), [341005])
    } finally {
        await app.close()
        fixture.cleanup()
    }
})
