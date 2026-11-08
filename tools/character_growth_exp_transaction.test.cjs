"use strict"

require("./test-workflow/bootstrap.cjs").bootstrap()

const assert = require("node:assert/strict")
const test = require("node:test")
const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")

const rewardExp = require("../src/lib/character-growth/commands/grant-character-exp")
const rewardStack = require("../src/lib/character-growth/commands/grant-character-stack")
const injectExp = require("../src/lib/character-growth/commands/inject-exp")
const stackToExp = require("../src/lib/character-growth/commands/stack-to-exp")
const overLimit = require("../src/lib/character-growth/commands/over-limit")
const { createCharacterGrowthC4Fixture } = require("./helpers/character-growth-c4-fixture.cjs")
const expodRoutes = require("../src/routes/api/expod").default
const characterRoutes = require("../src/routes/api/character").default
const { givePlayerCharacterSync } = require("../src/lib/character")

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
        assert.equal(fixture.db.prepare(`
            SELECT total_obtained
            FROM players_collected_items
            WHERE player_id = ? AND item_id = 14010
        `).get(playerId).total_obtained, 1)

        fixture.db.exec(`
            CREATE TRIGGER reject_stack_growth
            BEFORE UPDATE OF stack ON players_characters
            WHEN OLD.player_id = ${playerId} AND OLD.id = 341003
            BEGIN SELECT RAISE(ABORT, 'forced growth stack failure'); END;
        `)
        assert.throws(() => rewardStack.grantCharacterStack({ playerId, characterId: 341003 }))
        assert.equal(fixture.addCharacter(playerId, 341003).stack, 5)
        assert.equal(fixture.item(playerId, 14010), 1)
        assert.equal(fixture.db.prepare(`
            SELECT total_obtained
            FROM players_collected_items
            WHERE player_id = ? AND item_id = 14010
        `).get(playerId).total_obtained, 1)
    } finally {
        fixture.cleanup()
    }
})

test("duplicate-character ingress rejects malformed protection before stack or compensation writes", () => {
    const fixture = createCharacterGrowthC4Fixture()
    try {
        const playerId = fixture.createPlayer()
        fixture.addCharacter(playerId, 341003, { stack: 4 })
        fixture.db.prepare(`
            UPDATE players_characters
            SET protection = 2
            WHERE player_id = ? AND id = 341003
        `).run(playerId)
        const readState = () => ({
            character: fixture.db.prepare(`
                SELECT stack, protection
                FROM players_characters
                WHERE player_id = ? AND id = 341003
            `).get(playerId),
            compensation: fixture.db.prepare(`
                SELECT amount
                FROM players_items
                WHERE player_id = ? AND id = 14010
            `).get(playerId) ?? null,
        })
        const before = readState()
        assert.throws(
            () => givePlayerCharacterSync(playerId, 341003),
            error => error.code === "INVALID_GROWTH_STATE",
        )
        assert.deepEqual(readState(), before)
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

test("over_limit keeps reachable Item shortage as HTTP 400 after Inventory migration", async () => {
    const fixture = createCharacterGrowthC4Fixture()
    const app = Fastify({ logger: false })
    try {
        const playerId = fixture.createPlayer()
        const viewerId = await fixture.createViewer(playerId, 890000010)
        fixture.addCharacter(playerId, 341003, { overLimitStep: 0 })
        await app.register(characterRoutes)
        await app.ready()

        const response = await app.inject({
            method: "POST",
            url: "/over_limit",
            payload: {
                viewer_id: viewerId,
                character_id: 341003,
                use_stack: false,
                item_id: 10001,
                over_limit_count: 1,
            },
        })
        assert.equal(response.statusCode, 400, response.body)
        assert.match(response.body, /INSUFFICIENT_ITEM/)
        assert.equal(fixture.addCharacter(playerId, 341003).overLimitStep, 0)
        assert.equal(fixture.item(playerId, 10001) ?? 0, 0)
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

test("duplicate character compensation grants 3 Sublime Starstones for 5-star across elements, 1 for 3/4-star, and none for 1/2-star", () => {
    assert.equal(typeof rewardStack.getCharacterStackCompensation, "function")
    assert.deepEqual(rewardStack.getCharacterStackCompensation(5, 0), { id: 14003, count: 3 })
    assert.deepEqual(rewardStack.getCharacterStackCompensation(5, 1), { id: 14006, count: 3 })
    assert.deepEqual(rewardStack.getCharacterStackCompensation(5, 2), { id: 14009, count: 3 })
    assert.deepEqual(rewardStack.getCharacterStackCompensation(5, 3), { id: 14012, count: 3 })
    assert.deepEqual(rewardStack.getCharacterStackCompensation(5, 4), { id: 14018, count: 3 })
    assert.deepEqual(rewardStack.getCharacterStackCompensation(5, 5), { id: 14015, count: 3 })
    assert.deepEqual(rewardStack.getCharacterStackCompensation(4, 0), { id: 14002, count: 1 })
    assert.deepEqual(rewardStack.getCharacterStackCompensation(3, 0), { id: 14001, count: 1 })
    assert.equal(rewardStack.getCharacterStackCompensation(2, 0), undefined)
    assert.equal(rewardStack.getCharacterStackCompensation(1, 0), undefined)

    const fixture = createCharacterGrowthC4Fixture()
    try {
        const playerId = fixture.createPlayer()
        const fiveStarCases = [
            { characterId: 111001, itemId: 14003 },
            { characterId: 121001, itemId: 14006 },
            { characterId: 131001, itemId: 14009 },
            { characterId: 141001, itemId: 14012 },
            { characterId: 151001, itemId: 14018 },
            { characterId: 161001, itemId: 14015 },
        ]
        for (const { characterId, itemId } of fiveStarCases) {
            fixture.addCharacter(playerId, characterId, { stack: 0 })
            const granted = rewardStack.grantCharacterStack({ playerId, characterId })
            assert.equal(granted.isNew, false)
            assert.equal(granted.character.stack, 1)
            assert.deepEqual(granted.item, { id: itemId, count: 3 })
            assert.equal(granted.itemAfterAmount, 3)
            assert.equal(fixture.item(playerId, itemId), 3)
            assert.equal(fixture.db.prepare(`
                SELECT total_obtained
                FROM players_collected_items
                WHERE player_id = ? AND item_id = ?
            `).get(playerId, itemId).total_obtained, 3)
        }

        fixture.addCharacter(playerId, 251001, { stack: 1 })
        const fourStar = rewardStack.grantCharacterStack({ playerId, characterId: 251001 })
        assert.equal(fourStar.character.stack, 2)
        assert.deepEqual(fourStar.item, { id: 14017, count: 1 })
        assert.equal(fixture.item(playerId, 14017), 1)

        fixture.addCharacter(playerId, 311001, { stack: 0 })
        const threeStar = rewardStack.grantCharacterStack({ playerId, characterId: 311001 })
        assert.equal(threeStar.character.stack, 1)
        assert.deepEqual(threeStar.item, { id: 14001, count: 1 })
        assert.equal(fixture.item(playerId, 14001), 1)

        fixture.addCharacter(playerId, 412004, { stack: 0 })
        const twoStar = rewardStack.grantCharacterStack({ playerId, characterId: 412004 })
        assert.equal(twoStar.character.stack, 1)
        assert.equal(twoStar.item, undefined)

        fixture.addCharacter(playerId, 512001, { stack: 0 })
        const oneStar = rewardStack.grantCharacterStack({ playerId, characterId: 512001 })
        assert.equal(oneStar.character.stack, 1)
        assert.equal(oneStar.item, undefined)
    } finally {
        fixture.cleanup()
    }
})

test("standalone and non-gacha RewardGrant 5-star duplicate character grants settle 3-item capacity overflow", () => {
    const fixture = createCharacterGrowthC4Fixture()
    try {
        const { setInventoryFixtureItemExactSync } = require("./helpers/inventory-fixture.cjs")
        const { getPlayerMailsSync, MailType } = require("../src/data/domains/mail")
        const { getPlayerSync } = require("../src/data/domains/player")
        const {
            createRewardGrantExecutionPlan,
            executeRewardGrantExecutionPlanAsTransactionOwnerSync,
        } = require("../src/lib/reward-grant")
        const { createRewardGrantItemOverflowPolicy } = require("../src/lib/reward-grant-item-overflow")
        const { RewardType } = require("../src/lib/types")

        const playerId = fixture.createPlayer()
        fixture.addCharacter(playerId, 111001, { stack: 0 })
        setInventoryFixtureItemExactSync(playerId, 14003, 99998)

        const partialCap = givePlayerCharacterSync(playerId, 111001)
        assert.equal(partialCap.isNew, false)
        assert.equal(partialCap.character.stack, 1)
        assert.deepEqual(partialCap.item, { id: 14003, count: 3 })
        assert.equal(partialCap.itemAfterAmount, 99999)
        assert.deepEqual(partialCap.itemOverflowDispositions, [{
            kind: "mail",
            itemId: 14003,
            overflowAmount: 2,
        }])
        assert.equal(fixture.item(playerId, 14003), 99999)

        const fullCap = givePlayerCharacterSync(playerId, 111001)
        assert.equal(fullCap.character.stack, 2)
        assert.deepEqual(fullCap.item, { id: 14003, count: 3 })
        assert.equal(fullCap.itemAfterAmount, 99999)
        assert.deepEqual(fullCap.itemOverflowDispositions, [{
            kind: "mail",
            itemId: 14003,
            overflowAmount: 3,
        }])
        const standaloneMails = getPlayerMailsSync(playerId, 1, 100, true)
            .filter(mail => mail.type === MailType.ITEM && mail.type_id === 14003)
        assert.deepEqual(standaloneMails.map(mail => mail.number).sort((a, b) => a - b), [2, 3])

        const ownerPlayerId = fixture.createPlayer()
        setInventoryFixtureItemExactSync(ownerPlayerId, 14006, 99997)
        const playerBefore = getPlayerSync(ownerPlayerId)
        const plan = createRewardGrantExecutionPlan([
            { type: RewardType.CHARACTER, id: 121001 },
            { type: RewardType.CHARACTER, id: 121001 },
            { type: RewardType.CHARACTER, id: 251001 },
            { type: RewardType.CHARACTER, id: 251001 },
        ])
        const ownerResult = fixture.db.transaction(() => executeRewardGrantExecutionPlanAsTransactionOwnerSync(
            ownerPlayerId,
            plan,
            {
                playerId: playerBefore.id,
                freeMana: playerBefore.freeMana,
                freeVmoney: playerBefore.freeVmoney,
                expPool: playerBefore.expPool,
            },
            { itemOverflow: createRewardGrantItemOverflowPolicy(ownerPlayerId) },
        ))()

        assert.equal(ownerResult.entries[0].outcome.isNew, true)
        assert.equal(ownerResult.entries[0].outcome.compensationItem, null)
        assert.equal(ownerResult.entries[1].outcome.isNew, false)
        assert.deepEqual(ownerResult.entries[1].outcome.compensationItem, {
            itemId: 14006,
            requestedAmount: 3,
            acceptedAmount: 2,
            overflowAmount: 1,
            beforeAmount: 99997,
            afterAmount: 99999,
            overflowDispositions: [{
                kind: "mail",
                itemId: 14006,
                overflowAmount: 1,
            }],
        })
        assert.equal(ownerResult.entries[3].outcome.compensationItem.requestedAmount, 1)
        assert.equal(ownerResult.entries[3].outcome.compensationItem.afterAmount, 1)
        assert.equal(fixture.item(ownerPlayerId, 14006), 99999)
        assert.equal(fixture.item(ownerPlayerId, 14017), 1)
        const ownerMails = getPlayerMailsSync(ownerPlayerId, 1, 100, true)
            .filter(mail => mail.type === MailType.ITEM && mail.type_id === 14006)
        assert.deepEqual(ownerMails.map(mail => mail.number), [1])
    } finally {
        fixture.cleanup()
    }
})


test("duplicate at stack cap 99 auto-converts to exp + star grain", () => {
    const fixture = createCharacterGrowthC4Fixture()
    try {
        const playerId = fixture.createPlayer()
        fixture.addCharacter(playerId, 341003, { stack: 99 }) // ★3
        const poolBefore = fixture.db.prepare("SELECT exp_pool FROM players WHERE id = ?").get(playerId).exp_pool
        const result = rewardStack.grantCharacterStack({ playerId, characterId: 341003 })
        assert.equal(result.character.stack, 99, "本体保持 99 不再累加")
        assert.deepEqual(result.item, { id: 990008, count: 2 }, "★3 溢出重复=500exp+2 星之粒")
        assert.equal(fixture.item(playerId, 990008), 2)
        assert.equal(fixture.db.prepare("SELECT exp_pool FROM players WHERE id = ?").get(playerId).exp_pool,
            poolBefore + 500)
        assert.equal(fixture.item(playerId, 14010), null, "突破结晶不再发放(溢出重复无突破用途)")
    } finally {
        fixture.cleanup()
    }
})

test("over-limit crystal must match the character rarity (client rule)", () => {
    const fixture = createCharacterGrowthC4Fixture()
    try {
        const playerId = fixture.createPlayer()
        const star3Id = 341003 // ★3(内容层实测 rarity=3)
        const at = new Date("2026-01-01T00:00:00.000Z")

        fixture.addCharacter(playerId, 211003, { stack: 0 }) // ★4
        fixture.giveItem(playerId, 10001, 1)
        assert.throws(
            () => overLimit.executeOverLimit({
                playerId, characterId: 211003, overLimitCount: 1,
                useStack: false, itemId: 10001, evaluationTime: at,
            }),
            /invalid item for this character rarity/,
            "★4 不得被 ★3 结晶突破(修复目标)",
        )

        fixture.giveItem(playerId, 10002, 1)
        const ok = overLimit.executeOverLimit({
            playerId, characterId: 211003, overLimitCount: 1,
            useStack: false, itemId: 10002, evaluationTime: at,
        })
        assert.equal(ok.itemId, 10002)

        fixture.addCharacter(playerId, star3Id, { stack: 0 }) // ★3
        // 10002 allow_below=true(CN 主数据 col11):★3 可用 ★4 结晶(双审 P2 修正)
        fixture.giveItem(playerId, 10002, 1)
        const okLow = overLimit.executeOverLimit({
            playerId, characterId: star3Id, overLimitCount: 1,
            useStack: false, itemId: 10002, evaluationTime: at,
        })
        assert.equal(okLow.itemId, 10002)
        fixture.giveItem(playerId, 10001, 1)
        const ok3 = overLimit.executeOverLimit({
            playerId, characterId: star3Id, overLimitCount: 1,
            useStack: false, itemId: 10001, evaluationTime: at,
        })
        assert.equal(ok3.itemId, 10001)
    } finally {
        fixture.cleanup()
    }
})
