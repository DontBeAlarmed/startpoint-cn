"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const BetterSqlite3 = require("better-sqlite3")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const Fastify = require("fastify")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "box-gacha-exec-tx-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const BOX_GACHA_ID = 99001
const CURRENCY_ITEM_ID = 999001
const REWARD_ITEM_ID = 10002
const REWARD_CHARACTER_ID = 151006
const tableOverrides = {
    "box_gacha.json": {
        [BOX_GACHA_ID]: {
            itemId: CURRENCY_ITEM_ID,
            count: 10,
            availableCounts: { 1: 10, 2: 10, 3: 10, 4: 1 },
        },
    },
    "box_reward.json": {
        [BOX_GACHA_ID]: {
            1: {
                99001001: { type: 0, count: 1, available: 10, tier: 2, id: REWARD_ITEM_ID },
            },
            2: {
                99001002: { type: 0, count: 1, available: 10, tier: 2, id: REWARD_ITEM_ID },
            },
            3: {
                99001003: { type: 0, count: 1, available: 10, tier: 2, id: REWARD_ITEM_ID },
            },
            4: {
                99001004: { type: 5, count: 1, available: 1, tier: 2, id: REWARD_CHARACTER_ID },
            },
        },
    },
    "box_gacha_box_settings.json": {
        [BOX_GACHA_ID]: {
            1: {
                requiredBoxId: null,
                resetKind: 0,
                resetLimit: null,
                availableFrom: "2010-01-01 00:00:00",
                availableUntil: "2199-12-31 23:59:59",
                closeKind: 1,
            },
            2: {
                requiredBoxId: null,
                resetKind: 2,
                resetLimit: null,
                availableFrom: "2010-01-01 00:00:00",
                availableUntil: "2199-12-31 23:59:59",
                closeKind: 1,
            },
            3: {
                requiredBoxId: null,
                resetKind: 1,
                resetLimit: null,
                availableFrom: "2010-01-01 00:00:00",
                availableUntil: "2199-12-31 23:59:59",
                closeKind: 1,
            },
            4: {
                requiredBoxId: null,
                resetKind: 0,
                resetLimit: null,
                availableFrom: "2010-01-01 00:00:00",
                availableUntil: "2199-12-31 23:59:59",
                closeKind: 1,
            },
        },
    },
}
const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot({ tableOverrides })
const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    getPlayerBoxGachaDrawnRewardsSync,
    getPlayerBoxGachaSync,
} = require("../src/data/domains/boxGacha")
const { getPlayerCharacterSync, getPlayerCharactersSync } = require("../src/data/domains/character")
const { getPlayerEquipmentListSync } = require("../src/data/domains/equipment")
const {
    getPlayerCollectedItemTotalSync,
    getPlayerCollectedItemTotalsSync,
    getPlayerItemSync,
    getPlayerItemsSync,
} = require("../src/data/domains/item")
const { setInventoryFixtureItemExactSync } = require("./helpers/inventory-fixture.cjs")
const { getPlayerSync, insertDefaultPlayerSync } = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const boxGachaRoutes = require("../src/routes/api/boxGacha").default
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")

let database
let app
let nextViewerId = 870000000
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

async function createPlayer(label, currency = 1000) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `${label}-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const viewerId = nextViewerId++
    setInventoryFixtureItemExactSync(playerId, CURRENCY_ITEM_ID, currency)
    await insertSessionWithToken({
        token: String(viewerId),
        accountId: account.id,
        expires: new Date("2099-01-01T00:00:00.000Z"),
        type: SessionType.VIEWER,
    })
    return { playerId, viewerId }
}

function snapshot(playerId, boxId) {
    const player = getPlayerSync(playerId)
    return {
        freeMana: player.freeMana,
        expPool: player.expPool,
        characters: getPlayerCharactersSync(playerId),
        equipment: getPlayerEquipmentListSync(playerId),
        items: getPlayerItemsSync(playerId),
        collectedItems: getPlayerCollectedItemTotalsSync(playerId),
        box: getPlayerBoxGachaSync(playerId, BOX_GACHA_ID, boxId),
        drawn: getPlayerBoxGachaDrawnRewardsSync(playerId, BOX_GACHA_ID, boxId),
    }
}

async function execBox(viewerId, boxId, number, stopOnFeaturedRewards) {
    return app.inject({
        method: "POST",
        url: "/box_gacha/exec",
        payload: {
            viewer_id: viewerId,
            box_gacha_id: BOX_GACHA_ID,
            box_id: boxId,
            number,
            stop_on_featured_rewards: stopOnFeaturedRewards,
            api_count: 1,
        },
    })
}

test.before(async () => {
    database = data.initializeDatabase({
        databaseFactory: databasePath => new BetterSqlite3(databasePath, {
            verbose: sql => { if (sqlTrace.active) sqlTrace.statements.push(sql) },
        }),
    })
    app = Fastify({ logger: false })
    registerCnMsgpackOnSend(app)
    await app.register(boxGachaRoutes, { prefix: "/box_gacha" })
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

test("box gacha exec rolls rewards box history and currency back together", async t => {
    const { playerId, viewerId } = await createPlayer("box-exec-rollback")
    const before = snapshot(playerId, 1)
    database.exec(`
        CREATE TRIGGER reject_box_gacha_currency
        BEFORE UPDATE ON players_items
        WHEN OLD.player_id = ${playerId} AND OLD.id = ${CURRENCY_ITEM_ID}
        BEGIN SELECT RAISE(ABORT, 'forced box currency failure'); END;
    `)
    t.after(() => database.exec("DROP TRIGGER IF EXISTS reject_box_gacha_currency"))

    const response = await execBox(viewerId, 1, 1, false)

    assert.equal(response.statusCode, 500)
    assert.match(response.body, /forced box currency failure/)
    assert.deepEqual(snapshot(playerId, 1), before)
})

test("box gacha exec rolls flushed Inventory and rewards back on late drawn-history failure", async t => {
    const { playerId, viewerId } = await createPlayer("box-exec-late-history")
    const before = snapshot(playerId, 1)
    database.exec(`
        CREATE TRIGGER reject_box_gacha_drawn_history
        BEFORE INSERT ON players_box_gacha_drawn_rewards
        WHEN NEW.player_id = ${playerId}
        BEGIN SELECT RAISE(ABORT, 'forced box drawn history failure'); END;
    `)
    t.after(() => database.exec("DROP TRIGGER IF EXISTS reject_box_gacha_drawn_history"))

    const measured = await captureSqlAsync(() => execBox(viewerId, 1, 1, false))

    assert.equal(measured.result.statusCode, 500)
    assert.match(measured.result.body, /forced box drawn history failure/)
    assert.deepEqual(snapshot(playerId, 1), before)
    const itemWrites = measured.statements.filter(sql => (
        /^\s*INSERT\s+INTO\s+players_items\b/i.test(sql)
    ))
    assert.equal(itemWrites.length, 2, itemWrites.join("\n---\n"))
    const historyWriteIndex = measured.statements.findIndex(sql => (
        /^\s*INSERT\s+INTO\s+players_box_gacha_drawn_rewards\b/i.test(sql)
    ))
    assert.notEqual(historyWriteIndex, -1)
    assert.equal(measured.statements.findLastIndex(sql => (
        /^\s*INSERT\s+INTO\s+players_items\b/i.test(sql)
    )) < historyWriteIndex, true, "RewardGrant Inventory flush must precede the forced late history failure")
    assert.equal(
        measured.statements.filter(sql => /^\s*(?:SAVEPOINT|RELEASE)\b/i.test(sql)).length,
        0,
    )
})

for (const invalid of [
    { name: "zero", number: 0, stop: false },
    { name: "negative", number: -1, stop: false },
    { name: "fraction", number: 1.5, stop: false },
    { name: "over remaining", number: 11, stop: false },
    { name: "non-boolean stop", number: 1, stop: "true" },
]) {
    test(`box gacha exec rejects ${invalid.name} without writes`, async () => {
        const { playerId, viewerId } = await createPlayer(`box-invalid-${invalid.name}`)
        const before = snapshot(playerId, 1)

        const response = await execBox(viewerId, 1, invalid.number, invalid.stop)

        assert.equal(response.statusCode, 400, response.body)
        assert.deepEqual(snapshot(playerId, 1), before)
    })
}

test("featured early stop charges only the actual draw count", async () => {
    const { playerId, viewerId } = await createPlayer("box-featured-stop")
    const currencyObtainedBefore = getPlayerCollectedItemTotalSync(playerId, CURRENCY_ITEM_ID)
    const rewardObtainedBefore = getPlayerCollectedItemTotalSync(playerId, REWARD_ITEM_ID)

    const measured = await captureSqlAsync(() => execBox(viewerId, 1, 10, true))
    const response = measured.result

    assert.equal(response.statusCode, 200, response.body)
    const payload = require("msgpackr").unpack(Buffer.from(response.body, "base64"))
    const after = snapshot(playerId, 1)
    assert.equal(after.items[String(CURRENCY_ITEM_ID)], 990)
    assert.equal(after.items[String(REWARD_ITEM_ID)], 1)
    assert.equal(getPlayerItemSync(playerId, CURRENCY_ITEM_ID), 990)
    assert.equal(getPlayerItemSync(playerId, REWARD_ITEM_ID), 1)
    assert.equal(payload.data.item_list[CURRENCY_ITEM_ID], 990)
    assert.equal(payload.data.item_list[REWARD_ITEM_ID], 1)
    assert.deepEqual(payload.data.joined_character_id_list, [])
    assert.equal(getPlayerCollectedItemTotalSync(playerId, CURRENCY_ITEM_ID), currencyObtainedBefore)
    assert.equal(getPlayerCollectedItemTotalSync(playerId, REWARD_ITEM_ID), rewardObtainedBefore + 1)
    assert.equal(after.drawn.reduce((sum, reward) => sum + reward.number, 0), 1)
    assert.equal(after.box.remainingNumber, 9)
    assert.equal(
        measured.statements.filter(sql => /^\s*SELECT[\s\S]*\bFROM\s+players_items\b/i.test(sql)).length,
        2,
        "Box reads pull currency once and direct reward Items in one stable batch",
    )
    const itemWrites = measured.statements.filter(sql => (
        /^\s*INSERT\s+INTO\s+players_items\b/i.test(sql)
    ))
    assert.equal(itemWrites.length, 2, itemWrites.join("\n---\n"))
    assert.equal(itemWrites.filter(sql => new RegExp(
        `VALUES\\s*\\(${CURRENCY_ITEM_ID}(?:\\.0+)?,\\s*990(?:\\.0+)?,`,
        "i",
    ).test(sql)).length, 1)
    assert.equal(itemWrites.filter(sql => new RegExp(
        `VALUES\\s*\\(${REWARD_ITEM_ID}(?:\\.0+)?,\\s*1(?:\\.0+)?,`,
        "i",
    ).test(sql)).length, 1)
    const collectedWrites = measured.statements.filter(sql => (
        /^\s*INSERT\s+INTO\s+players_collected_items\b/i.test(sql)
    ))
    assert.equal(collectedWrites.length, 1, collectedWrites.join("\n---\n"))
    assert.equal(new RegExp(
        `VALUES\\s*\\([^,]+,\\s*${REWARD_ITEM_ID}(?:\\.0+)?,\\s*1(?:\\.0+)?`,
        "i",
    ).test(collectedWrites[0]), true)
    assert.equal(
        measured.statements.filter(sql => /^\s*(?:SAVEPOINT|RELEASE)\b/i.test(sql)).length,
        0,
    )
})

test("box gacha keeps its legacy empty joined-character projection for a real new-character draw", async () => {
    const { playerId, viewerId } = await createPlayer("box-character-projection")

    const response = await execBox(viewerId, 4, 1, false)

    assert.equal(response.statusCode, 200, response.body)
    const payload = require("msgpackr").unpack(Buffer.from(response.body, "base64"))
    assert.notEqual(getPlayerCharacterSync(playerId, REWARD_CHARACTER_ID), null)
    assert.deepEqual(payload.data.joined_character_id_list, [])
    assert.equal(payload.data.character_list.length, 1)
    assert.equal(payload.data.character_list[0].character_id, REWARD_CHARACTER_ID)
    assert.equal(payload.data.item_list[CURRENCY_ITEM_ID], 990)
})

test("resettable box ignores featured early stop and empties the requested inventory", async () => {
    const { playerId, viewerId } = await createPlayer("box-resettable-stop")

    const response = await execBox(viewerId, 2, 10, true)

    assert.equal(response.statusCode, 200, response.body)
    const after = snapshot(playerId, 2)
    assert.equal(after.items[String(CURRENCY_ITEM_ID)], 900)
    assert.equal(after.items[String(REWARD_ITEM_ID)], 10)
    assert.equal(after.drawn.reduce((sum, reward) => sum + reward.number, 0), 10)
    assert.equal(after.box.remainingNumber, 0)
})

test("manual reset button box also ignores featured early stop", async () => {
    const { playerId, viewerId } = await createPlayer("box-manual-reset-stop")

    const response = await execBox(viewerId, 3, 10, true)

    assert.equal(response.statusCode, 200, response.body)
    const after = snapshot(playerId, 3)
    assert.equal(after.items[String(CURRENCY_ITEM_ID)], 900)
    assert.equal(after.drawn.reduce((sum, reward) => sum + reward.number, 0), 10)
    assert.equal(after.box.remainingNumber, 0)
})
