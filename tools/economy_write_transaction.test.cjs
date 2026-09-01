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
    database = data.initializeDatabase()
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

    const response = await app.inject({
        method: "POST",
        url: "/exchange/star_crumb",
        payload: { viewer_id: viewerId, exchange_id: 9000001, api_count: 1 },
    })

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

    const response = await app.inject({
        method: "POST",
        url: "/exchange/star_crumb",
        payload: { viewer_id: viewerId, exchange_id: 9000001, api_count: 1 },
    })

    assert.equal(response.statusCode, 200, response.body)
    assert.equal(getPlayerSync(playerId).starCrumb, 700)
    assert.equal(getPlayerItemSync(playerId, 10002), 1)
    assert.equal(getPlayerCollectedItemTotalSync(playerId, 10002), 1)
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
