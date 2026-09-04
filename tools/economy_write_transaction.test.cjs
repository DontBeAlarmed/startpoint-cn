"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { unpack } = require("msgpackr")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const Fastify = require("fastify")
const BetterSqlite3 = require("better-sqlite3")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "economy-write-tx-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    getPlayerCharacterSync,
    insertDefaultPlayerCharacterSync,
    updatePlayerCharacterSync,
} = require("../src/data/domains/character")
const {
    getPlayerCollectedItemTotalSync,
    getPlayerItemSync,
} = require("../src/data/domains/item")
const { playerOwnsEquipmentSync } = require("../src/data/domains/equipment")
const { setInventoryFixtureItemExactSync } = require("./helpers/inventory-fixture.cjs")
const { getPlayerMailsSync, MailType } = require("../src/data/domains/mail")
const { createRewardGrantItemOverflowPolicy } = require("../src/lib/reward-grant-item-overflow")
const { getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const exchangeRoutes = require("../src/routes/api/exchange").default
const expodRoutes = require("../src/routes/api/expod").default
const characterRoutes = require("../src/routes/api/character").default
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")

let database
let app
let nextViewerId = 850000000
const sqlTrace = { active: false, statements: [] }

async function captureSqlAsync(operation) {
    sqlTrace.statements = []
    sqlTrace.active = true
    try {
        return { result: await operation(), statements: [...sqlTrace.statements] }
    } finally {
        sqlTrace.active = false
    }
}

function countSql(statements, pattern) {
    return statements.filter(statement => pattern.test(statement)).length
}

async function createPlayer(label) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `${label}-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const viewerId = nextViewerId++
    await insertSessionWithToken({
        token: String(viewerId),
        accountId: account.id,
        expires: new Date("2099-01-01T00:00:00.000Z"),
        type: SessionType.VIEWER,
    })
    return { playerId, viewerId }
}

test.before(async () => {
    database = data.initializeDatabase({
        databaseFactory: databasePath => new BetterSqlite3(databasePath, {
            verbose: sql => { if (sqlTrace.active) sqlTrace.statements.push(sql) },
        }),
    })
    app = Fastify({ logger: false })
    registerCnMsgpackOnSend(app)
    await app.register(exchangeRoutes, { prefix: "/exchange" })
    await app.register(expodRoutes, { prefix: "/expod" })
    await app.register(characterRoutes, { prefix: "/character" })
    await app.ready()
})

test.after(async () => {
    await app.close()
    data.closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test("star crumb item exchange rolls charge and reward back together", async t => {
    const { playerId, viewerId } = await createPlayer("star-crumb-item")
    updatePlayerSync({ id: playerId, starCrumb: 1000 })
    database.exec(`
        CREATE TRIGGER reject_star_crumb_item_fact
        BEFORE INSERT ON players_collected_items
        WHEN NEW.player_id = ${playerId} AND NEW.item_id = 10002
        BEGIN SELECT RAISE(ABORT, 'forced collected item failure'); END;
    `)
    t.after(() => database.exec("DROP TRIGGER IF EXISTS reject_star_crumb_item_fact"))

    const measured = await captureSqlAsync(() => app.inject({
        method: "POST",
        url: "/exchange/star_crumb",
        payload: { viewer_id: viewerId, exchange_id: 9000001, api_count: 1 },
    }))
    const response = measured.result
    assert.equal(measured.statements.length, 9)
    assert.equal(countSql(measured.statements, /FROM players\s+WHERE id =/), 1)
    assert.equal(countSql(measured.statements, /^COMMIT$/), 0)
    assert.equal(countSql(measured.statements, /^ROLLBACK$/), 1)

    assert.equal(response.statusCode, 500)
    assert.equal(getPlayerSync(playerId).starCrumb, 1000)
    assert.equal(getPlayerItemSync(playerId, 10002), null)
    assert.equal(getPlayerCollectedItemTotalSync(playerId, 10002), 0)
})

test("star crumb character exchange rolls character internals and charge back", async t => {
    const { playerId, viewerId } = await createPlayer("star-crumb-character")
    updatePlayerSync({ id: playerId, starCrumb: 1000 })
    database.exec(`
        CREATE TRIGGER reject_star_crumb_bond_token
        BEFORE INSERT ON players_characters_bond_tokens
        WHEN NEW.player_id = ${playerId} AND NEW.character_id = 111001
        BEGIN SELECT RAISE(ABORT, 'forced bond token failure'); END;
    `)
    t.after(() => database.exec("DROP TRIGGER IF EXISTS reject_star_crumb_bond_token"))

    const response = await app.inject({
        method: "POST",
        url: "/exchange/star_crumb",
        payload: { viewer_id: viewerId, exchange_id: 1, api_count: 1 },
    })

    assert.equal(response.statusCode, 500)
    assert.equal(getPlayerSync(playerId).starCrumb, 1000)
    assert.equal(getPlayerCharacterSync(playerId, 111001), null)
    assert.equal(database.prepare(`
        SELECT COUNT(*) AS count
        FROM players_characters_bond_tokens
        WHERE player_id = ? AND character_id = 111001
    `).get(playerId).count, 0)
})

test("bulk stack conversion rolls every character and reward back on late failure", async t => {
    const { playerId, viewerId } = await createPlayer("bulk-stack-exp")
    insertDefaultPlayerCharacterSync(playerId, 111001)
    insertDefaultPlayerCharacterSync(playerId, 211001)
    updatePlayerCharacterSync(playerId, 111001, { overLimitStep: 4, stack: 2 })
    updatePlayerCharacterSync(playerId, 211001, { overLimitStep: 6, stack: 3 })
    const beforeExpPool = getPlayerSync(playerId).expPool
    database.exec(`
        CREATE TRIGGER reject_bulk_stack_reward_fact
        BEFORE INSERT ON players_collected_items
        WHEN NEW.player_id = ${playerId} AND NEW.item_id = 990008
        BEGIN SELECT RAISE(ABORT, 'forced bulk reward failure'); END;
    `)
    t.after(() => database.exec("DROP TRIGGER IF EXISTS reject_bulk_stack_reward_fact"))

    const response = await app.inject({
        method: "POST",
        url: "/expod/bulk_stack_to_exp",
        payload: { viewer_id: viewerId, api_count: 1 },
    })

    assert.equal(response.statusCode, 500)
    assert.equal(getPlayerCharacterSync(playerId, 111001).stack, 2)
    assert.equal(getPlayerCharacterSync(playerId, 211001).stack, 3)
    assert.equal(getPlayerSync(playerId).expPool, beforeExpPool)
    assert.equal(getPlayerItemSync(playerId, 990008), null)
    assert.equal(getPlayerCollectedItemTotalSync(playerId, 990008), 0)
})

test("star crumb item exchange preserves the successful response state", async () => {
    const { playerId, viewerId } = await createPlayer("star-crumb-item-success")
    updatePlayerSync({ id: playerId, starCrumb: 1000 })

    const measured = await captureSqlAsync(() => app.inject({
        method: "POST",
        url: "/exchange/star_crumb",
        payload: { viewer_id: viewerId, exchange_id: 9000001, api_count: 1 },
    }))
    const response = measured.result
    assert.equal(measured.statements.length, 13)
    assert.equal(countSql(measured.statements, /FROM players\s+WHERE id =/), 1)
    assert.equal(countSql(measured.statements, /^COMMIT$/), 2)
    assert.equal(countSql(measured.statements, /^ROLLBACK$/), 0)

    assert.equal(response.statusCode, 200, response.body)
    assert.equal(getPlayerSync(playerId).starCrumb, 700)
    assert.equal(getPlayerItemSync(playerId, 10002), 1)
    assert.equal(getPlayerCollectedItemTotalSync(playerId, 10002), 1)
})

test("star crumb Item exchange sends capped overflow to Mail", async () => {
    const { playerId, viewerId } = await createPlayer("star-crumb-item-overflow")
    updatePlayerSync({ id: playerId, starCrumb: 1000 })
    const itemId = 10002
    const policy = createRewardGrantItemOverflowPolicy(playerId)
    setInventoryFixtureItemExactSync(playerId, itemId, policy.maxCount(itemId) - 1)

    const accepted = await app.inject({
        method: "POST",
        url: "/exchange/star_crumb",
        payload: { viewer_id: viewerId, exchange_id: 9000001, api_count: 1 },
    })
    assert.equal(accepted.statusCode, 200, accepted.body)
    assert.equal(getPlayerItemSync(playerId, itemId), policy.maxCount(itemId))
    assert.equal(getPlayerMailsSync(playerId, 1, 100, true).length, 0)

    const response = await app.inject({
        method: "POST",
        url: "/exchange/star_crumb",
        payload: { viewer_id: viewerId, exchange_id: 9000001, api_count: 2 },
    })

    assert.equal(response.statusCode, 200, response.body)
    assert.equal(getPlayerItemSync(playerId, itemId), policy.maxCount(itemId))
    assert.deepEqual(getPlayerMailsSync(playerId, 1, 100, true).map(mail => ({
        type: mail.type,
        type_id: mail.type_id,
        number: mail.number,
    })), [{ type: MailType.ITEM, type_id: itemId, number: 1 }])
    assert.equal(getPlayerSync(playerId).starCrumb, 400)
})

test("star crumb character exchange commits typed grant and absolute response", async () => {
    const { playerId, viewerId } = await createPlayer("star-crumb-character-success")
    updatePlayerSync({ id: playerId, starCrumb: 1000 })

    const response = await app.inject({
        method: "POST",
        url: "/exchange/star_crumb",
        payload: { viewer_id: viewerId, exchange_id: 1, api_count: 1 },
    })

    assert.equal(response.statusCode, 200, response.body)
    const payload = unpack(Buffer.from(response.body, "base64"))
    assert.equal(payload.data.user_info.star_crumb, 400)
    assert.equal(payload.data.character_list.length, 1)
    assert.equal(getPlayerSync(playerId).starCrumb, 400)
    assert.notEqual(getPlayerCharacterSync(playerId, 111001), null)
    assert.deepEqual(payload.data.item_list, {})
    assert.deepEqual(payload.data.equipment_list, [])
    assert.equal(payload.data.over_max, null)
})

test("star crumb character exchange rejects an already owned character without writes", async () => {
    const { playerId, viewerId } = await createPlayer("star-crumb-character-duplicate")
    updatePlayerSync({ id: playerId, starCrumb: 1000 })
    insertDefaultPlayerCharacterSync(playerId, 111001)

    const response = await app.inject({
        method: "POST",
        url: "/exchange/star_crumb",
        payload: { viewer_id: viewerId, exchange_id: 1, api_count: 1 },
    })

    assert.equal(response.statusCode, 400)
    assert.equal(JSON.parse(response.body).message, "Character already owned.")
    assert.equal(getPlayerSync(playerId).starCrumb, 1000)
})

test("star crumb catalog is immutable per repository and resolves cost from typed rows", async () => {
    const { getStarCrumbExchangeCatalog, resolveStarCrumbExchangeProduct } = require("../src/lib/star-crumb-exchange")
    // WeakMap 缓存：同 repository 只构建一次，不随请求重复读取 Content 表
    const catalog = getStarCrumbExchangeCatalog()
    assert.equal(catalog === getStarCrumbExchangeCatalog(), true)
    assert.equal(Object.isFrozen(catalog), true)
    assert.deepEqual(Object.keys(catalog), ["resolve"])
    const character = resolveStarCrumbExchangeProduct(1)
    const item = resolveStarCrumbExchangeProduct(9000001)
    const equipment = resolveStarCrumbExchangeProduct(475)
    assert.deepEqual([character.ok, character.product.kind, character.product.targetId, character.product.cost],
        [true, "character", 111001, 600])
    assert.deepEqual([item.ok, item.product.kind, item.product.targetId, item.product.cost],
        [true, "item", 10002, 300])
    assert.deepEqual([equipment.ok, equipment.product.kind, equipment.product.targetId, equipment.product.cost],
        [true, "equipment", 4010010, 200])
    assert.equal(resolveStarCrumbExchangeProduct(987654321).ok, false)

    let tableReads = 0
    const cachedRepository = {
        table(name) {
            tableReads += 1
            if (name === "star_crumb_exchange.json") {
                return { "1": [["0", "111001", "", "", "", "", "", "", "5"]] }
            }
            if (name === "star_crumb_exchange_cost.json") {
                return { "0": [["300", "600"]] }
            }
            throw new Error(`unexpected table ${name}`)
        },
    }
    const firstCached = getStarCrumbExchangeCatalog(cachedRepository)
    assert.equal(firstCached, getStarCrumbExchangeCatalog(cachedRepository))
    assert.equal(tableReads, 2)
    assert.equal(firstCached.resolve(1).ok, true)

    const malformedRepository = {
        table(name) {
            if (name === "star_crumb_exchange.json") {
                return { "1": [["0", "111001", "", "", "", "", "", "", "5"]] }
            }
            if (name === "star_crumb_exchange_cost.json") {
                return { "0": [["300", "Infinity"]] }
            }
            throw new Error(`unexpected table ${name}`)
        },
    }
    assert.deepEqual(getStarCrumbExchangeCatalog(malformedRepository).resolve(1), {
        ok: false,
        kind: "invalidCost",
        rawKind: 0,
        rarity: 5,
    })
})

test("star crumb equipment exchange commits typed grant and absolute response", async () => {
    const { playerId, viewerId } = await createPlayer("star-crumb-equipment-success")
    updatePlayerSync({ id: playerId, starCrumb: 1000 })

    const response = await app.inject({
        method: "POST",
        url: "/exchange/star_crumb",
        payload: { viewer_id: viewerId, exchange_id: 475, api_count: 1 },
    })

    assert.equal(response.statusCode, 200, response.body)
    const payload = unpack(Buffer.from(response.body, "base64"))
    assert.equal(payload.data.user_info.star_crumb, 800)
    assert.equal(payload.data.equipment_list.length, 1)
    assert.equal(getPlayerSync(playerId).starCrumb, 800)
    assert.equal(playerOwnsEquipmentSync(playerId, 4010010), true)
    assert.deepEqual(payload.data.character_list, [])
    assert.deepEqual(payload.data.item_list, {})
})

test("bulk stack conversion commits the complete planned result", async () => {
    const { playerId, viewerId } = await createPlayer("bulk-stack-exp-success")
    insertDefaultPlayerCharacterSync(playerId, 111001)
    insertDefaultPlayerCharacterSync(playerId, 211001)
    updatePlayerCharacterSync(playerId, 111001, { overLimitStep: 4, stack: 2 })
    updatePlayerCharacterSync(playerId, 211001, { overLimitStep: 6, stack: 3 })
    const beforeExpPool = getPlayerSync(playerId).expPool

    const response = await app.inject({
        method: "POST",
        url: "/expod/bulk_stack_to_exp",
        payload: { viewer_id: viewerId, api_count: 1 },
    })

    assert.equal(response.statusCode, 200, response.body)
    assert.equal(getPlayerCharacterSync(playerId, 111001).stack, 0)
    assert.equal(getPlayerCharacterSync(playerId, 211001).stack, 0)
    assert.equal(getPlayerSync(playerId).expPool, beforeExpPool + 26000)
    assert.equal(getPlayerItemSync(playerId, 990008), 90)
    assert.equal(getPlayerCollectedItemTotalSync(playerId, 990008), 90)
})

test("character protection can be changed and is returned in the response", async () => {
    const { playerId, viewerId } = await createPlayer("character-protection")
    insertDefaultPlayerCharacterSync(playerId, 111001)
    insertDefaultPlayerCharacterSync(playerId, 211001)

    const response = await app.inject({
        method: "POST",
        url: "/character/set_protection",
        payload: {
            viewer_id: viewerId,
            protection: true,
            character_ids: [111001, 211001, 999999999],
        },
    })

    assert.equal(response.statusCode, 200, response.body)
    assert.equal(getPlayerCharacterSync(playerId, 111001).protection, true)
    assert.equal(getPlayerCharacterSync(playerId, 211001).protection, true)
    const returned = unpack(Buffer.from(response.body, "base64"))
    assert.deepEqual(
        returned.data.character_list.map(entry => [entry.character_id, entry.protection]),
        [[111001, true], [211001, true]],
    )
})

test("bulk stack conversion skips protected characters", async () => {
    const { playerId, viewerId } = await createPlayer("bulk-stack-exp-protection")
    insertDefaultPlayerCharacterSync(playerId, 111001)
    insertDefaultPlayerCharacterSync(playerId, 211001)
    updatePlayerCharacterSync(playerId, 111001, { overLimitStep: 4, stack: 2, protection: true })
    updatePlayerCharacterSync(playerId, 211001, { overLimitStep: 6, stack: 3 })

    const response = await app.inject({
        method: "POST",
        url: "/expod/bulk_stack_to_exp",
        payload: { viewer_id: viewerId, api_count: 1 },
    })

    assert.equal(response.statusCode, 200, response.body)
    assert.equal(getPlayerCharacterSync(playerId, 111001).stack, 2)
    assert.equal(getPlayerCharacterSync(playerId, 211001).stack, 0)
})
