"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const Fastify = require("fastify")
const BetterSqlite3 = require("better-sqlite3")
const { unpack } = require("msgpackr")

const AWAKE_CHARACTER_ID = 263002
const ITEM_ID = 1
const MANA_THRESHOLD = 604800
const NO_ERROR = Symbol("no error")

let app = null
let database = null
let databaseDirectory = null
let previousDataDirectory
let previousDatabaseDirectory
let environmentCaptured = false
let restoreContentSnapshot = null
let cleanupComplete = false
let data
let insertAccountSync
let insertDefaultPlayerCharacterSync
let insertPlayerCharacterManaNodesSync
let updatePlayerCharacterSync
let getPlayerCharacterAwakeUnlocksSync
let givePlayerItemSync
let getPlayerItemSync
let updatePlayerCategoryMissionSync
let getPlayerSync
let insertDefaultPlayerSync
let updatePlayerSync
let insertSessionWithToken
let SessionType
let characterAssets
let characterExpCaps
let itemRoutes
let registerCnMsgpackOnSend
let nextViewerId = 860000000

function cleanupActions() {
    return [
        async () => {
            const instance = app
            app = null
            if (instance !== null) await instance.close()
        },
        () => {
            database = null
            if (data !== undefined) data.closeDatabase()
        },
        () => {
            const restore = restoreContentSnapshot
            restoreContentSnapshot = null
            if (restore !== null) restore()
        },
        () => {
            const directory = databaseDirectory
            databaseDirectory = null
            if (directory !== null) fs.rmSync(directory, { recursive: true, force: true })
        },
        () => {
            if (!environmentCaptured) return
            environmentCaptured = false
            if (previousDataDirectory === undefined) delete process.env.DATA_DIR
            else process.env.DATA_DIR = previousDataDirectory
            if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
            else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
        },
    ]
}

async function completeCleanup(primaryError, actions) {
    if (cleanupComplete) {
        if (primaryError !== NO_ERROR) throw primaryError
        return
    }

    const cleanupErrors = []
    for (const action of actions) {
        try {
            await action()
        } catch (error) {
            cleanupErrors.push(error instanceof Error
                ? error
                : new Error("Item sell Awake cleanup threw a non-Error value", { cause: error }))
        }
    }
    cleanupComplete = true

    if (primaryError !== NO_ERROR) {
        const normalizedPrimary = primaryError instanceof Error
            ? primaryError
            : new Error("Item sell Awake initialization threw a non-Error value", {
                cause: primaryError,
            })
        if (cleanupErrors.length > 0) {
            throw new AggregateError(
                [normalizedPrimary, ...cleanupErrors],
                `Item sell Awake cleanup failed after: ${normalizedPrimary.message}`,
            )
        }
        throw normalizedPrimary
    }
    if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, "Item sell Awake cleanup failed")
    }
}

async function createAwakeReadyPlayer(label, itemCount = 1) {
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

    insertDefaultPlayerCharacterSync(playerId, AWAKE_CHARACTER_ID)
    const character = characterAssets.getCharacterDataSync(AWAKE_CHARACTER_ID)
    updatePlayerCharacterSync(playerId, AWAKE_CHARACTER_ID, {
        exp: characterExpCaps[character.rarity][0],
    })
    insertPlayerCharacterManaNodesSync(
        playerId,
        AWAKE_CHARACTER_ID,
        Object.keys(characterAssets.getCharacterManaNodesSync(AWAKE_CHARACTER_ID, 1)).map(Number),
    )
    updatePlayerCategoryMissionSync(playerId, 9, 2630021, 3)
    updatePlayerCategoryMissionSync(playerId, 9, 2630023, 1)
    updatePlayerSync({ id: playerId, totalManaObtained: MANA_THRESHOLD - 5 })
    givePlayerItemSync(playerId, ITEM_ID, itemCount)

    return { playerId, viewerId }
}

async function sellOne(viewerId) {
    return app.inject({
        method: "POST",
        url: "/item/sell",
        payload: {
            viewer_id: viewerId,
            api_count: 1,
            item_id: ITEM_ID,
            sell_number: 1,
        },
    })
}

function decodeSuccess(response) {
    assert.equal(response.statusCode, 200, response.body)
    return unpack(Buffer.from(response.body, "base64"))
}

function getAwakeCharacter(responseData) {
    return responseData.character_list?.find(
        character => character.character_id === AWAKE_CHARACTER_ID,
    )
}

test.before(async () => {
    try {
        previousDataDirectory = process.env.DATA_DIR
        previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
        environmentCaptured = true
        databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "item-sell-awake-"))
        process.env.DATA_DIR = databaseDirectory
        delete process.env.WDFP_DATABASE_DIR

        restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
            .installBundledGameplaySnapshot()
        data = require("../src/data")
        ;({ insertAccountSync } = require("../src/data/domains/account"))
        ;({
            insertDefaultPlayerCharacterSync,
            insertPlayerCharacterManaNodesSync,
            updatePlayerCharacterSync,
        } = require("../src/data/domains/character"))
        ;({
            getPlayerCharacterAwakeUnlocksSync,
        } = require("../src/data/domains/character_awake"))
        ;({ givePlayerItemSync, getPlayerItemSync } = require("../src/data/domains/item"))
        ;({ updatePlayerCategoryMissionSync } = require("../src/data/domains/mission"))
        ;({
            getPlayerSync,
            insertDefaultPlayerSync,
            updatePlayerSync,
        } = require("../src/data/domains/player"))
        ;({ insertSessionWithToken } = require("../src/data/domains/session"))
        ;({ SessionType } = require("../src/data/types"))
        characterAssets = require("../src/lib/assets")
        ;({ characterExpCaps } = require("../src/lib/character"))
        itemRoutes = require("../src/routes/api/item").default
        ;({ registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack"))

        database = data.initializeDatabase({
            databaseFactory: databasePath => new BetterSqlite3(databasePath),
        })
        app = Fastify({ logger: false })
        registerCnMsgpackOnSend(app)
        await app.register(itemRoutes, { prefix: "/item" })
        await app.ready()
    } catch (error) {
        await completeCleanup(error, cleanupActions())
    }
})

test.after(async () => completeCleanup(NO_ERROR, cleanupActions()))

test("item sale publishes the 263002 Awake unlock after crossing lifetime Mana", async () => {
    const { playerId, viewerId } = await createAwakeReadyPlayer("threshold")

    const responseData = decodeSuccess(await sellOne(viewerId)).data

    assert.equal(getPlayerSync(playerId).totalManaObtained, MANA_THRESHOLD)
    assert.equal(getPlayerItemSync(playerId, ITEM_ID), 0)
    assert.deepEqual(
        getPlayerCharacterAwakeUnlocksSync(playerId).get(String(AWAKE_CHARACTER_ID)),
        { 1: 1 },
    )
    assert.deepEqual(getAwakeCharacter(responseData)?.mana_board_awake, { 1: 1 })
})

test("repeated item sale publication keeps the Awake unlock idempotent", async () => {
    const { playerId, viewerId } = await createAwakeReadyPlayer("idempotent", 2)

    const firstResponseData = decodeSuccess(await sellOne(viewerId)).data
    const secondResponseData = decodeSuccess(await sellOne(viewerId)).data

    assert.deepEqual(getAwakeCharacter(firstResponseData)?.mana_board_awake, { 1: 1 })
    assert.equal(getPlayerSync(playerId).totalManaObtained, MANA_THRESHOLD + 5)
    assert.equal(getPlayerItemSync(playerId, ITEM_ID), 0)
    assert.deepEqual(
        getPlayerCharacterAwakeUnlocksSync(playerId).get(String(AWAKE_CHARACTER_ID)),
        { 1: 1 },
    )
    assert.equal(secondResponseData.character_list, undefined)
    assert.equal(database.prepare(`
        SELECT COUNT(*) AS count
        FROM players_character_awake_unlocks
        WHERE player_id = ? AND character_id = ? AND board_index = 1
    `).get(playerId, AWAKE_CHARACTER_ID).count, 1)
})

test("Awake publication failure preserves the committed item sale", async t => {
    const { playerId, viewerId } = await createAwakeReadyPlayer("publication-failure")
    const freeManaBefore = getPlayerSync(playerId).freeMana
    database.exec(`
        CREATE TRIGGER reject_item_sell_awake_publication
        BEFORE INSERT ON players_character_awake_unlocks
        WHEN NEW.player_id = ${playerId} AND NEW.character_id = ${AWAKE_CHARACTER_ID}
        BEGIN SELECT RAISE(ABORT, 'injected item sale Awake publication failure'); END;
    `)
    t.after(() => database.exec("DROP TRIGGER IF EXISTS reject_item_sell_awake_publication"))

    const originalConsoleError = console.error
    const publicationErrors = []
    console.error = (...args) => publicationErrors.push(args)
    let response
    try {
        response = await sellOne(viewerId)
    } finally {
        console.error = originalConsoleError
    }
    const responseData = decodeSuccess(response).data

    assert.equal(getPlayerSync(playerId).totalManaObtained, MANA_THRESHOLD)
    assert.equal(getPlayerSync(playerId).freeMana, freeManaBefore + 5)
    assert.equal(getPlayerItemSync(playerId, ITEM_ID), 0)
    assert.equal(getPlayerCharacterAwakeUnlocksSync(playerId).has(String(AWAKE_CHARACTER_ID)), false)
    assert.equal(responseData.character_list, undefined)
    assert.equal(publicationErrors.length, 1)
    assert.match(String(publicationErrors[0][0]), /Failed to publish character unlocks/)
    const publicationError = publicationErrors[0][1]
    assert.ok(publicationError instanceof Error)
    assert.equal(publicationError.message, "injected item sale Awake publication failure")
    assert.equal(publicationError.code, "SQLITE_CONSTRAINT_TRIGGER")
})
