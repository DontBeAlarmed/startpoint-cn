"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const Fastify = require("fastify")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "gacha-write-tx-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot({ additionalTableNames: ["gacha.json"] })
const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { getActiveMissionCountersSync } = require("../src/data/domains/active_mission_counters")
const { getPlayerCharacterSync, getPlayerCharactersSync } = require("../src/data/domains/character")
const { getPlayerEquipmentSync, getPlayerEquipmentListSync } = require("../src/data/domains/equipment")
const { getPlayerGachaInfoSync, insertPlayerGachaInfoSync } = require("../src/data/domains/gacha")
const { getPlayerItemSync, getPlayerItemsSync, givePlayerItemSync } = require("../src/data/domains/item")
const { getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const gachaRoutes = require("../src/routes/api/gacha").default
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
const { rewardPlayerGachaDrawResultSync } = require("../src/lib/gacha")
const { GachaType } = require("../src/lib/types")

let database
let app
let nextViewerId = 860000000

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

function historyCount(playerId) {
    return database.prepare(`
        SELECT COUNT(*) AS count FROM players_receive_history WHERE player_id = ?
    `).get(playerId).count
}

function drawState(playerId, gachaId) {
    const player = getPlayerSync(playerId)
    return {
        freeVmoney: player.freeVmoney,
        vmoney: player.vmoney,
        characters: getPlayerCharactersSync(playerId),
        equipment: getPlayerEquipmentListSync(playerId),
        items: getPlayerItemsSync(playerId),
        gachaInfo: getPlayerGachaInfoSync(playerId, gachaId),
        historyCount: historyCount(playerId),
        activeMissionCounters: getActiveMissionCountersSync(playerId),
    }
}

test.before(async () => {
    database = data.initializeDatabase()
    app = Fastify({ logger: false })
    registerCnMsgpackOnSend(app)
    await app.register(gachaRoutes, { prefix: "/gacha" })
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

test("character pity exchange rolls reward back when history insertion fails", async t => {
    const { playerId, viewerId } = await createPlayer("gacha-character-exchange")
    insertPlayerGachaInfoSync(playerId, {
        gachaId: 29,
        isAccountFirst: false,
        isDailyFirst: false,
        gachaExchangePoint: 250,
    })
    database.exec(`
        CREATE TRIGGER reject_character_exchange_history
        BEFORE INSERT ON players_receive_history
        WHEN NEW.player_id = ${playerId} AND NEW.type_id = 151009
        BEGIN SELECT RAISE(ABORT, 'forced character exchange history failure'); END;
    `)
    t.after(() => database.exec("DROP TRIGGER IF EXISTS reject_character_exchange_history"))

    const response = await app.inject({
        method: "POST",
        url: "/gacha/exchange_character",
        payload: {
            viewer_id: viewerId,
            gacha_id: 29,
            character_id: 151009,
            api_count: 1,
        },
    })

    assert.equal(response.statusCode, 500)
    assert.match(response.body, /forced character exchange history failure/)
    assert.equal(getPlayerCharacterSync(playerId, 151009), null)
    assert.equal(getPlayerGachaInfoSync(playerId, 29).gachaExchangePoint, 250)
    assert.equal(historyCount(playerId), 0)
})

test("equipment pity exchange rolls reward and history back when points fail", async t => {
    const { playerId, viewerId } = await createPlayer("gacha-equipment-exchange")
    insertPlayerGachaInfoSync(playerId, {
        gachaId: 5000,
        isAccountFirst: false,
        isDailyFirst: false,
        gachaExchangePoint: 250,
    })
    database.exec(`
        CREATE TRIGGER reject_equipment_exchange_points
        BEFORE UPDATE OF gacha_exchange_point ON players_gacha_info
        WHEN OLD.player_id = ${playerId} AND OLD.gacha_id = 5000
        BEGIN SELECT RAISE(ABORT, 'forced equipment exchange points failure'); END;
    `)
    t.after(() => database.exec("DROP TRIGGER IF EXISTS reject_equipment_exchange_points"))

    const response = await app.inject({
        method: "POST",
        url: "/gacha/exchange_equipment",
        payload: {
            viewer_id: viewerId,
            gacha_id: 5000,
            equipment_id: 5040016,
            api_count: 1,
        },
    })

    assert.equal(response.statusCode, 500)
    assert.match(response.body, /forced equipment exchange points failure/)
    assert.equal(getPlayerEquipmentSync(playerId, 5040016), null)
    assert.equal(getPlayerGachaInfoSync(playerId, 5000).gachaExchangePoint, 250)
    assert.equal(historyCount(playerId), 0)
})

test("gacha exec rolls every persistent result back on late mission failure", async t => {
    const { playerId, viewerId } = await createPlayer("gacha-exec")
    updatePlayerSync({ id: playerId, freeVmoney: 1000, vmoney: 0 })
    const before = drawState(playerId, 1)
    database.exec(`
        CREATE TRIGGER reject_gacha_mission_counter
        BEFORE INSERT ON players_active_mission_counters
        WHEN NEW.player_id = ${playerId}
        BEGIN SELECT RAISE(ABORT, 'forced gacha mission counter failure'); END;
    `)
    t.after(() => database.exec("DROP TRIGGER IF EXISTS reject_gacha_mission_counter"))

    const response = await app.inject({
        method: "POST",
        url: "/gacha/exec",
        payload: {
            viewer_id: viewerId,
            gacha_id: 1,
            payment_type: 1,
            number_of_exec: 1,
            type: 1,
            api_count: 1,
        },
    })

    assert.equal(response.statusCode, 500)
    assert.match(response.body, /forced gacha mission counter failure/)
    assert.deepEqual(drawState(playerId, 1), before)
})

test("gacha exec commits charge reward history points and mission fact together", async () => {
    const { playerId, viewerId } = await createPlayer("gacha-exec-success")
    updatePlayerSync({ id: playerId, freeVmoney: 1000, vmoney: 0 })

    const response = await app.inject({
        method: "POST",
        url: "/gacha/exec",
        payload: {
            viewer_id: viewerId,
            gacha_id: 1,
            payment_type: 1,
            number_of_exec: 1,
            type: 1,
            api_count: 1,
        },
    })

    assert.equal(response.statusCode, 200, response.body)
    const after = drawState(playerId, 1)
    assert.equal(after.freeVmoney, 850)
    assert.equal(after.vmoney, 0)
    assert.equal(Object.keys(after.characters).length, 2)
    assert.equal(after.gachaInfo.gachaExchangePoint, 1)
    assert.equal(after.historyCount, 1)
    assert.equal(after.activeMissionCounters.totalGachaCharacterCount, 1)
})

test("character duplicate gacha item_list reports the post-reward inventory", async () => {
    const { playerId } = await createPlayer("gacha-duplicate-item-list")
    const characterId = 1
    const exBoostItemId = 14002
    givePlayerItemSync(playerId, exBoostItemId, 20)

    const result = rewardPlayerGachaDrawResultSync(
        playerId,
        { type: GachaType.CHARACTER },
        [characterId],
        undefined,
        [{
            characterId,
            rarity: 4,
            movieId: "normal",
            seed: 1,
            requiresVerification: true,
        }],
    )

    assert.equal(getPlayerItemSync(playerId, exBoostItemId), 21)
    assert.equal(result.draw[0].ex_boost_item.count, 1)
    assert.equal(result.items[exBoostItemId], 21)
})
