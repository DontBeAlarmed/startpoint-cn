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

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "gacha-write-tx-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot({
        additionalTableNames: [
            "gacha.json",
            "gacha_pool.json",
            "gacha_campaign_definitions.json",
            "stars_gacha_campaign.json",
            "gacha_exchange_rate.json",
        ],
    })
const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { getActiveMissionCountersSync } = require("../src/data/domains/active_mission_counters")
const { getPlayerCharacterSync, getPlayerCharactersSync } = require("../src/data/domains/character")
const { getPlayerEquipmentSync, getPlayerEquipmentListSync } = require("../src/data/domains/equipment")
const {
    getPlayerGachaCampaignSync,
    getPlayerGachaInfoSync,
    insertPlayerGachaCampaignSync,
    insertPlayerGachaInfoSync,
    updatePlayerGachaInfoSync,
} = require("../src/data/domains/gacha")
const {
    getPlayerCollectedItemTotalSync,
    getPlayerItemSync,
    getPlayerItemsSync,
} = require("../src/data/domains/item")
const {
    grantInventoryFixtureItemSync,
    setInventoryFixtureItemExactSync,
} = require("./helpers/inventory-fixture.cjs")
const { getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const gachaRoutes = require("../src/routes/api/gacha").default
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
const { rewardPlayerGachaDrawResultSync } = require("../src/lib/gacha")
const { givePlayerCharacterSync } = require("../src/lib/character")
const { getPlayerMailsSync, MailType } = require("../src/data/domains/mail")
const { createRewardGrantItemOverflowPolicy } = require("../src/lib/reward-grant-item-overflow")
const { getDefaultGachaSeedQuarantine } = require("../src/lib/gacha-seed-quarantine")
const { GachaType, RewardType } = require("../src/lib/types")
const {
    executeRewardGrantExecutionPlanAsTransactionOwnerSync,
    createRewardGrantExecutionPlan,
} = require("../src/lib/reward-grant")
const {
    grantGachaRewardPlanInTransactionOwnerWithInventorySync,
} = require("../src/lib/gacha-reward-grant")
const { withDeferredInventoryBatchContextWithinTransactionSync } = require("../src/lib/inventory")
const {
    executeGachaDrawSync,
    executeGachaExchangeSync,
    runGachaPostCommitEffects: runGachaPostCommitEffectsWithDependencies,
} = require("../src/lib/gacha-owner")
const runGachaPostCommitEffects = result => runGachaPostCommitEffectsWithDependencies(result, {
    publishGrowth: (_playerId, _characterIds, characters) => characters,
})
const { getGachaCatalog } = require("../src/lib/gacha-catalog")
const {
    grantPlayerComebackGachaPeriodSync,
    grantPlayerStarsGachaCampaignSync,
} = require("../src/lib/gacha-owner")
const {
    getPlayerStarsGachaCampaignByGachaSync,
    getPlayerGachaDetailSync,
    resetPlayerGachaDailyStateSync,
    upsertPlayerGachaDetailSync,
} = require("../src/data/domains/gacha-state")
const { getTimeOffset, setServerTimeOffset } = require("../src/utils")
const { getClientSerializedData } = require("../src/data/utils/player-data")

let database
let app
let nextViewerId = 860000000
const ACTIVE_CHARACTER_GACHA_ID = 1638
const ACTIVE_CHARACTER_EXCHANGE_ID = 121087
const ACTIVE_EQUIPMENT_GACHA_ID = 25030
const ACTIVE_EQUIPMENT_EXCHANGE_ID = 5070036
const sqlTrace = { active: false, statements: [] }
const previousTimeOffset = getTimeOffset()

function captureSql(operation) {
    sqlTrace.statements = []
    sqlTrace.active = true
    try {
        return { result: operation(), statements: [...sqlTrace.statements] }
    } finally {
        sqlTrace.active = false
    }
}

async function captureSqlAsync(operation) {
    sqlTrace.statements = []
    sqlTrace.active = true
    try {
        return { result: await operation(), statements: [...sqlTrace.statements] }
    } finally {
        sqlTrace.active = false
    }
}

async function captureGachaLogs(operation) {
    const originalLog = console.log
    const logs = []
    console.log = (...args) => {
        const message = args.map(String).join(" ")
        if (message.startsWith("[GACHA] reward_summary")) logs.push(message)
        originalLog(...args)
    }
    try {
        return { result: await operation(), logs }
    } finally {
        console.log = originalLog
    }
}

function rewardGrantPlayerSnapshot(playerId) {
    const player = getPlayerSync(playerId)
    return {
        playerId: player.id,
        freeMana: player.freeMana,
        freeVmoney: player.freeVmoney,
        expPool: player.expPool,
    }
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
    setServerTimeOffset(Date.parse("2024-08-14T12:00:00.000Z") - Date.now())
    database = data.initializeDatabase({
        databaseFactory: databasePath => new BetterSqlite3(databasePath, {
            verbose: sql => { if (sqlTrace.active) sqlTrace.statements.push(sql) },
        }),
    })
    app = Fastify({ logger: false })
    registerCnMsgpackOnSend(app)
    await app.register(gachaRoutes, { prefix: "/gacha" })
    await app.ready()
})

test.after(async () => {
    await app.close()
    data.closeDatabase()
    restoreContentSnapshot()
    setServerTimeOffset(previousTimeOffset)
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test("character pity exchange rolls reward back when history insertion fails", async t => {
    const { playerId, viewerId } = await createPlayer("gacha-character-exchange")
    insertPlayerGachaInfoSync(playerId, {
        gachaId: ACTIVE_CHARACTER_GACHA_ID,
        isAccountFirst: false,
        isDailyFirst: false,
        gachaExchangePoint: 250,
    })
    database.exec(`
        CREATE TRIGGER reject_character_exchange_history
        BEFORE INSERT ON players_receive_history
        WHEN NEW.player_id = ${playerId} AND NEW.type_id = ${ACTIVE_CHARACTER_EXCHANGE_ID}
        BEGIN SELECT RAISE(ABORT, 'forced character exchange history failure'); END;
    `)
    t.after(() => database.exec("DROP TRIGGER IF EXISTS reject_character_exchange_history"))

    const response = await app.inject({
        method: "POST",
        url: "/gacha/exchange_character",
        payload: {
            viewer_id: viewerId,
            gacha_id: ACTIVE_CHARACTER_GACHA_ID,
            character_id: ACTIVE_CHARACTER_EXCHANGE_ID,
            api_count: 1,
        },
    })

    assert.equal(response.statusCode, 500)
    assert.match(response.body, /forced character exchange history failure/)
    assert.equal(getPlayerCharacterSync(playerId, ACTIVE_CHARACTER_EXCHANGE_ID), null)
    assert.equal(getPlayerGachaInfoSync(playerId, ACTIVE_CHARACTER_GACHA_ID).gachaExchangePoint, 250)
    assert.equal(historyCount(playerId), 0)
})

test("character pity exchange publishes duplicate compensation overflow absolute state", async () => {
    const { playerId, viewerId } = await createPlayer("gacha-character-exchange-overflow")
    const characterId = ACTIVE_CHARACTER_EXCHANGE_ID
    const compensationItemId = 14006
    assert.equal(givePlayerCharacterSync(playerId, characterId).isNew, true)
    setInventoryFixtureItemExactSync(playerId, compensationItemId, 99999)
    insertPlayerGachaInfoSync(playerId, {
        gachaId: ACTIVE_CHARACTER_GACHA_ID,
        isAccountFirst: false,
        isDailyFirst: false,
        gachaExchangePoint: 250,
    })
    const stackBefore = getPlayerCharacterSync(playerId, characterId).stack
    const mailCountBefore = getPlayerMailsSync(playerId, 1, 100, true).length

    const response = await app.inject({
        method: "POST",
        url: "/gacha/exchange_character",
        payload: {
            viewer_id: viewerId,
            gacha_id: ACTIVE_CHARACTER_GACHA_ID,
            character_id: characterId,
            api_count: 1,
        },
    })

    assert.equal(response.statusCode, 200, response.body)
    const payload = require("msgpackr").unpack(Buffer.from(response.body, "base64")).data
    assert.equal(getPlayerCharacterSync(playerId, characterId).stack, stackBefore + 1)
    assert.equal(getPlayerItemSync(playerId, compensationItemId), 99999)
    assert.equal(payload.item_list[compensationItemId], 99999)
    assert.deepEqual(payload.over_max, [{
        process_type: 1,
        item: { item_id: compensationItemId, number: 1 },
    }])
    assert.equal(payload.mail_arrived, true)
    assert.equal(getPlayerGachaInfoSync(playerId, ACTIVE_CHARACTER_GACHA_ID).gachaExchangePoint, 0)
    assert.equal(historyCount(playerId), 1)
    const newMails = getPlayerMailsSync(playerId, 1, 100, true)
        .filter(mail => mail.type === MailType.ITEM && mail.type_id === compensationItemId)
    assert.equal(newMails.length, mailCountBefore + 1)
    assert.equal(newMails[0].number, 1)
})

test("equipment pity exchange rolls reward and history back when points fail", async t => {
    const { playerId, viewerId } = await createPlayer("gacha-equipment-exchange")
    insertPlayerGachaInfoSync(playerId, {
        gachaId: ACTIVE_EQUIPMENT_GACHA_ID,
        isAccountFirst: false,
        isDailyFirst: false,
        gachaExchangePoint: 250,
    })
    database.exec(`
        CREATE TRIGGER reject_equipment_exchange_points
        BEFORE UPDATE OF gacha_exchange_point ON players_gacha_info
        WHEN OLD.player_id = ${playerId} AND OLD.gacha_id = ${ACTIVE_EQUIPMENT_GACHA_ID}
        BEGIN SELECT RAISE(ABORT, 'forced equipment exchange points failure'); END;
    `)
    t.after(() => database.exec("DROP TRIGGER IF EXISTS reject_equipment_exchange_points"))

    const response = await app.inject({
        method: "POST",
        url: "/gacha/exchange_equipment",
        payload: {
            viewer_id: viewerId,
            gacha_id: ACTIVE_EQUIPMENT_GACHA_ID,
            equipment_id: ACTIVE_EQUIPMENT_EXCHANGE_ID,
            api_count: 1,
        },
    })

    assert.equal(response.statusCode, 500)
    assert.match(response.body, /forced equipment exchange points failure/)
    assert.equal(getPlayerEquipmentSync(playerId, ACTIVE_EQUIPMENT_EXCHANGE_ID), null)
    assert.equal(getPlayerGachaInfoSync(playerId, ACTIVE_EQUIPMENT_GACHA_ID).gachaExchangePoint, 250)
    assert.equal(historyCount(playerId), 0)
})

test("equipment exchange uses typed rate and preserves cost boundary", async () => {
    const success = await createPlayer("gacha-equipment-exchange-success")
    insertPlayerGachaInfoSync(success.playerId, {
        gachaId: ACTIVE_EQUIPMENT_GACHA_ID,
        isAccountFirst: true,
        isDailyFirst: true,
        gachaExchangePoint: 251,
    })
    const response = await app.inject({
        method: "POST",
        url: "/gacha/exchange_equipment",
        payload: {
            viewer_id: success.viewerId,
            gacha_id: ACTIVE_EQUIPMENT_GACHA_ID,
            equipment_id: ACTIVE_EQUIPMENT_EXCHANGE_ID,
            api_count: 1,
        },
    })
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(getPlayerGachaInfoSync(
        success.playerId,
        ACTIVE_EQUIPMENT_GACHA_ID,
    ).gachaExchangePoint, 1)
    assert.notEqual(getPlayerEquipmentSync(success.playerId, ACTIVE_EQUIPMENT_EXCHANGE_ID), null)
    assert.equal(historyCount(success.playerId), 1)
    updatePlayerGachaInfoSync(success.playerId, {
        gachaId: ACTIVE_EQUIPMENT_GACHA_ID,
        gachaExchangePoint: 250,
    })
    const repeated = await app.inject({
        method: "POST",
        url: "/gacha/exchange_equipment",
        payload: {
            viewer_id: success.viewerId,
            gacha_id: ACTIVE_EQUIPMENT_GACHA_ID,
            equipment_id: ACTIVE_EQUIPMENT_EXCHANGE_ID,
            api_count: 2,
        },
    })
    assert.equal(repeated.statusCode, 200, repeated.body)
    const repeatedPayload = require("msgpackr").unpack(
        Buffer.from(repeated.body, "base64"),
    ).data
    assert.equal(repeatedPayload.equipment_list[0].stack, 1)
    assert.equal(repeatedPayload.gacha_info_list[0].gacha_exchange_point, 0)
    assert.equal("character_list" in repeatedPayload, false)
    assert.equal("item_list" in repeatedPayload, false)
    assert.deepEqual(repeatedPayload.encyclopedia_info, [])
    assert.equal(typeof repeatedPayload.mail_arrived, "boolean")
    assert.equal(getPlayerEquipmentSync(success.playerId, ACTIVE_EQUIPMENT_EXCHANGE_ID).stack, 1)
    assert.equal(historyCount(success.playerId), 2)

    const insufficient = await createPlayer("gacha-equipment-exchange-insufficient")
    insertPlayerGachaInfoSync(insufficient.playerId, {
        gachaId: ACTIVE_EQUIPMENT_GACHA_ID,
        isAccountFirst: true,
        isDailyFirst: true,
        gachaExchangePoint: 249,
    })
    const rejected = await app.inject({
        method: "POST",
        url: "/gacha/exchange_equipment",
        payload: {
            viewer_id: insufficient.viewerId,
            gacha_id: ACTIVE_EQUIPMENT_GACHA_ID,
            equipment_id: ACTIVE_EQUIPMENT_EXCHANGE_ID,
            api_count: 1,
        },
    })
    assert.equal(rejected.statusCode, 400)
    assert.equal(getPlayerGachaInfoSync(
        insufficient.playerId,
        ACTIVE_EQUIPMENT_GACHA_ID,
    ).gachaExchangePoint, 249)
    assert.equal(getPlayerEquipmentSync(insufficient.playerId, ACTIVE_EQUIPMENT_EXCHANGE_ID), null)
})

test("exchange cost is read from the injected typed rate instead of a protocol constant", async () => {
    const { playerId } = await createPlayer("gacha-exchange-injected-rate")
    insertPlayerGachaInfoSync(playerId, {
        gachaId: ACTIVE_CHARACTER_GACHA_ID,
        isAccountFirst: true,
        isDailyFirst: true,
        gachaExchangePoint: 251,
    })
    const catalog = getGachaCatalog()
    const customCatalog = {
        ...catalog,
        exchangeRates: {
            ...catalog.exchangeRates,
            character: { ...catalog.exchangeRates.character, 5: 251 },
        },
    }
    const result = executeGachaExchangeSync({
        playerId,
        gachaId: ACTIVE_CHARACTER_GACHA_ID,
        targetId: ACTIVE_CHARACTER_EXCHANGE_ID,
        kind: "character",
        nowMs: Date.parse("2024-08-14T12:00:00.000Z"),
    }, { catalog: customCatalog })
    assert.equal(result.ok, true)
    assert.equal(getPlayerGachaInfoSync(playerId, ACTIVE_CHARACTER_GACHA_ID).gachaExchangePoint, 0)
})

test("new Character exchange keeps the client empty item-list shape", async () => {
    const { playerId, viewerId } = await createPlayer("gacha-character-exchange-new")
    insertPlayerGachaInfoSync(playerId, {
        gachaId: ACTIVE_CHARACTER_GACHA_ID,
        isAccountFirst: true,
        isDailyFirst: true,
        gachaExchangePoint: 250,
    })
    const response = await app.inject({
        method: "POST",
        url: "/gacha/exchange_character",
        payload: {
            viewer_id: viewerId,
            gacha_id: ACTIVE_CHARACTER_GACHA_ID,
            character_id: ACTIVE_CHARACTER_EXCHANGE_ID,
            api_count: 1,
        },
    })
    assert.equal(response.statusCode, 200, response.body)
    const payload = require("msgpackr").unpack(Buffer.from(response.body, "base64")).data
    assert.deepEqual(payload.item_list, [])
    assert.equal(payload.gacha_info_list[0].gacha_exchange_point, 0)
})

test("exchange rejects an active but non-exchangeable pool target", async () => {
    const { playerId, viewerId } = await createPlayer("gacha-nonexchangeable")
    insertPlayerGachaInfoSync(playerId, {
        gachaId: ACTIVE_CHARACTER_GACHA_ID,
        isAccountFirst: true,
        isDailyFirst: true,
        gachaExchangePoint: 250,
    })
    const response = await app.inject({
        method: "POST",
        url: "/gacha/exchange_character",
        payload: {
            viewer_id: viewerId,
            gacha_id: ACTIVE_CHARACTER_GACHA_ID,
            character_id: 111135,
            api_count: 1,
        },
    })
    assert.equal(response.statusCode, 400)
    assert.equal(getPlayerGachaInfoSync(playerId, ACTIVE_CHARACTER_GACHA_ID).gachaExchangePoint, 250)
})

test("expired exchange returns 1351 and keeps state unchanged", async () => {
    const { playerId, viewerId } = await createPlayer("gacha-exchange-expired")
    insertPlayerGachaInfoSync(playerId, {
        gachaId: 29,
        isAccountFirst: true,
        isDailyFirst: true,
        gachaExchangePoint: 250,
    })
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
    assert.equal(response.statusCode, 200)
    const payload = require("msgpackr").unpack(Buffer.from(response.body, "base64"))
    assert.equal(payload.data_headers.result_code, 1351)
    assert.equal(getPlayerCharacterSync(playerId, 151009), null)
    assert.equal(getPlayerGachaInfoSync(playerId, 29).gachaExchangePoint, 250)
})

test("25009 exchange follows the actual held-ticket extension window", async () => {
    const withTicket = await createPlayer("gacha-exchange-25009-ticket")
    grantInventoryFixtureItemSync(withTicket.playerId, 999004, 1)
    insertPlayerGachaInfoSync(withTicket.playerId, {
        gachaId: 25009,
        isAccountFirst: true,
        isDailyFirst: true,
        gachaExchangePoint: 250,
    })
    const success = await app.inject({
        method: "POST",
        url: "/gacha/exchange_equipment",
        payload: {
            viewer_id: withTicket.viewerId,
            gacha_id: 25009,
            equipment_id: 5070023,
            api_count: 1,
        },
    })
    assert.equal(success.statusCode, 200, success.body)
    assert.notEqual(getPlayerEquipmentSync(withTicket.playerId, 5070023), null)
    assert.equal(getPlayerItemSync(withTicket.playerId, 999004), 1)
    assert.equal(getPlayerGachaInfoSync(withTicket.playerId, 25009).gachaExchangePoint, 0)

    const withoutTicket = await createPlayer("gacha-exchange-25009-no-ticket")
    insertPlayerGachaInfoSync(withoutTicket.playerId, {
        gachaId: 25009,
        isAccountFirst: true,
        isDailyFirst: true,
        gachaExchangePoint: 250,
    })
    const rejected = await app.inject({
        method: "POST",
        url: "/gacha/exchange_equipment",
        payload: {
            viewer_id: withoutTicket.viewerId,
            gacha_id: 25009,
            equipment_id: 5070023,
            api_count: 1,
        },
    })
    assert.equal(rejected.statusCode, 200)
    const payload = require("msgpackr").unpack(Buffer.from(rejected.body, "base64"))
    assert.equal(payload.data_headers.result_code, 1351)
    assert.equal(getPlayerEquipmentSync(withoutTicket.playerId, 5070023), null)
    assert.equal(getPlayerGachaInfoSync(withoutTicket.playerId, 25009).gachaExchangePoint, 250)
})

test("Comeback exchange consumes the explicit player period instead of Master base time", async () => {
    const { playerId } = await createPlayer("gacha-exchange-comeback")
    grantPlayerComebackGachaPeriodSync({
        playerId,
        gachaId: 700000,
        periodStartTime: Math.floor(Date.parse("2024-08-14T00:00:00.000Z") / 1000),
        periodEndTime: Math.floor(Date.parse("2024-08-15T00:00:00.000Z") / 1000),
    })
    updatePlayerGachaInfoSync(playerId, {
        gachaId: 700000,
        gachaExchangePoint: 250,
    })
    const result = executeGachaExchangeSync({
        playerId,
        gachaId: 700000,
        targetId: 111039,
        kind: "character",
        nowMs: Date.parse("2024-08-14T12:00:00.000Z"),
    })
    assert.equal(result.ok, true)
    assert.notEqual(getPlayerCharacterSync(playerId, 111039), null)
    assert.equal(getPlayerGachaInfoSync(playerId, 700000).gachaExchangePoint, 0)
})

test("Stars exchange uses its independent player period and preserves cumulative counters", async () => {
    const granted = await createPlayer("gacha-exchange-stars")
    grantPlayerStarsGachaCampaignSync({
        playerId: granted.playerId,
        campaignId: 1,
        gachaId: 80000,
        periodStartTime: Math.floor(Date.parse("2023-09-01T00:00:00.000Z") / 1000),
        periodEndTime: Math.floor(Date.parse("2023-09-10T00:00:00.000Z") / 1000),
        freeOneTimes: 1,
        freeTenTimes: 2,
    })
    updatePlayerGachaInfoSync(granted.playerId, {
        gachaId: 80000,
        gachaExchangePoint: 250,
    })
    const result = executeGachaExchangeSync({
        playerId: granted.playerId,
        gachaId: 80000,
        targetId: 111039,
        kind: "character",
        nowMs: Date.parse("2023-09-02T00:00:00.000Z"),
    })
    assert.equal(result.ok, true)
    assert.notEqual(getPlayerCharacterSync(granted.playerId, 111039), null)
    assert.equal(getPlayerGachaInfoSync(granted.playerId, 80000).gachaExchangePoint, 0)
    assert.deepEqual(getPlayerStarsGachaCampaignByGachaSync(granted.playerId, 80000), {
        campaignId: 1,
        gachaId: 80000,
        periodStartTime: Math.floor(Date.parse("2023-09-01T00:00:00.000Z") / 1000),
        periodEndTime: Math.floor(Date.parse("2023-09-10T00:00:00.000Z") / 1000),
        freeOneTimes: 1,
        freeTenTimes: 2,
    })
    assert.equal(historyCount(granted.playerId), 1)

    const missing = await createPlayer("gacha-exchange-stars-missing")
    insertPlayerGachaInfoSync(missing.playerId, {
        gachaId: 80000,
        isAccountFirst: true,
        isDailyFirst: true,
        gachaExchangePoint: 250,
    })
    const rejected = executeGachaExchangeSync({
        playerId: missing.playerId,
        gachaId: 80000,
        targetId: 111039,
        kind: "character",
        nowMs: Date.parse("2023-09-02T00:00:00.000Z"),
    })
    assert.deepEqual(rejected, {
        ok: false,
        kind: "protocolResultCode",
        resultCode: 1351,
        message: "Gacha exchange period is unavailable.",
    })
    assert.equal(getPlayerCharacterSync(missing.playerId, 111039), null)
    assert.equal(getPlayerGachaInfoSync(missing.playerId, 80000).gachaExchangePoint, 250)
    assert.equal(historyCount(missing.playerId), 0)
})

test("gacha exec rolls every persistent result back on late mission failure", async t => {
    const { playerId, viewerId } = await createPlayer("gacha-exec")
    updatePlayerSync({ id: playerId, freeVmoney: 1000, vmoney: 800 })
    const before = drawState(playerId, ACTIVE_CHARACTER_GACHA_ID)
    database.exec(`
        CREATE TRIGGER reject_gacha_mission_counter
        BEFORE INSERT ON players_active_mission_counters
        WHEN NEW.player_id = ${playerId}
        BEGIN SELECT RAISE(ABORT, 'forced gacha mission counter failure'); END;
    `)
    t.after(() => database.exec("DROP TRIGGER IF EXISTS reject_gacha_mission_counter"))

    const quarantine = getDefaultGachaSeedQuarantine()
    const originalMarkSent = quarantine.markSent
    const markedSeeds = []
    quarantine.markSent = (...args) => markedSeeds.push(args)
    let routeSql
    try {
        routeSql = await captureSqlAsync(() => captureGachaLogs(() => app.inject({
            method: "POST",
            url: "/gacha/exec",
            payload: {
                viewer_id: viewerId,
                gacha_id: ACTIVE_CHARACTER_GACHA_ID,
                payment_type: 1,
                number_of_exec: 1,
                type: 2,
                api_count: 1,
            },
        })))
    } finally {
        quarantine.markSent = originalMarkSent
    }
    const captured = routeSql.result
    const response = captured.result

    assert.equal(response.statusCode, 500)
    assert.match(response.body, /forced gacha mission counter failure/)
    assert.deepEqual(drawState(playerId, ACTIVE_CHARACTER_GACHA_ID), before)
    assert.deepEqual(captured.logs, [])
    assert.deepEqual(markedSeeds, [])
    assert.equal(
        routeSql.statements.filter(sql => /^\s*SELECT[\s\S]*\bFROM\s+players\b/i.test(sql)).length,
        2,
    )
    assert.equal(
        routeSql.statements.filter(sql => /^\s*(?:SAVEPOINT|RELEASE)\b/i.test(sql)).length,
        0,
    )
})

test("gacha exec commits charge reward history points and mission fact together", async () => {
    const { playerId, viewerId } = await createPlayer("gacha-exec-success")
    updatePlayerSync({ id: playerId, freeVmoney: 1000, vmoney: 0 })

    const quarantine = getDefaultGachaSeedQuarantine()
    const originalMarkSent = quarantine.markSent
    const markObservations = []
    quarantine.markSent = () => markObservations.push({
        historyCount: historyCount(playerId),
        exchangePoint: getPlayerGachaInfoSync(
            playerId,
            ACTIVE_CHARACTER_GACHA_ID,
        )?.gachaExchangePoint,
    })
    let routeSql
    try {
        routeSql = await captureSqlAsync(() => captureGachaLogs(() => app.inject({
            method: "POST",
            url: "/gacha/exec",
            payload: {
                viewer_id: viewerId,
                gacha_id: ACTIVE_CHARACTER_GACHA_ID,
                payment_type: 1,
                number_of_exec: 1,
                type: 1,
                api_count: 1,
            },
        })))
    } finally {
        quarantine.markSent = originalMarkSent
    }
    const captured = routeSql.result
    const response = captured.result

    assert.equal(response.statusCode, 200, response.body)
    const after = drawState(playerId, ACTIVE_CHARACTER_GACHA_ID)
    assert.equal(after.freeVmoney, 850)
    assert.equal(after.vmoney, 0)
    assert.equal(Object.keys(after.characters).length, 2)
    assert.equal(after.gachaInfo.gachaExchangePoint, 1)
    assert.equal(after.gachaInfo.isDailyFirst, true)
    assert.equal(after.gachaInfo.isAccountFirst, true)
    assert.equal(after.historyCount, 1)
    assert.equal(after.activeMissionCounters.totalGachaCharacterCount, 1)
    assert.equal(captured.logs.length, 1)
    assert.deepEqual(markObservations, [{ historyCount: 1, exchangePoint: 1 }])
    const payload = require("msgpackr").unpack(Buffer.from(response.body, "base64"))
    assert.equal(payload.data.gacha_info_list[0].is_daily_first, true)
    assert.equal(payload.data.gacha_info_list[0].is_account_first, true)
    assert.equal(
        routeSql.statements.filter(sql => /^\s*SELECT[\s\S]*\bFROM\s+players_items\b/i.test(sql)).length,
        0,
        "a first-character non-ticket draw must not activate deferred Inventory",
    )
    assert.equal(
        routeSql.statements.filter(sql => /^\s*INSERT\s+INTO\s+players_items\b/i.test(sql)).length,
        0,
    )
})

test("post-commit seed failure cannot turn a committed draw into HTTP 500", async () => {
    const { playerId, viewerId } = await createPlayer("gacha-seed-postcommit-failure")
    updatePlayerSync({ id: playerId, freeVmoney: 1000, vmoney: 0 })
    const quarantine = getDefaultGachaSeedQuarantine()
    const originalMarkSent = quarantine.markSent
    quarantine.markSent = () => { throw new Error("fixture seed postcommit failure") }
    const originalError = console.error
    console.error = () => {}
    let response
    try {
        response = await app.inject({
            method: "POST",
            url: "/gacha/exec",
            payload: {
                viewer_id: viewerId,
                gacha_id: ACTIVE_CHARACTER_GACHA_ID,
                payment_type: 1,
                number_of_exec: 1,
                type: 1,
                api_count: 1,
            },
        })
    } finally {
        quarantine.markSent = originalMarkSent
        console.error = originalError
    }
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(historyCount(playerId), 1)
    assert.equal(getPlayerSync(playerId).freeVmoney, 850)
})

test("Character ten draw persists free-first mixed Stone after-state", async () => {
    const { playerId, viewerId } = await createPlayer("gacha-mixed-stone")
    updatePlayerSync({ id: playerId, freeVmoney: 1000, vmoney: 800 })
    const response = await app.inject({
        method: "POST",
        url: "/gacha/exec",
        payload: {
            viewer_id: viewerId,
            gacha_id: ACTIVE_CHARACTER_GACHA_ID,
            payment_type: 1,
            number_of_exec: 1,
            type: 2,
            api_count: 1,
        },
    })
    assert.equal(response.statusCode, 200, response.body)
    const payload = require("msgpackr").unpack(Buffer.from(response.body, "base64")).data
    assert.equal(payload.draw.length, 10)
    assert.equal(payload.user_info.free_vmoney, 0)
    assert.equal(payload.user_info.vmoney, 300)
    assert.equal(getPlayerSync(playerId).freeVmoney, 0)
    assert.equal(getPlayerSync(playerId).vmoney, 300)
})

test("Gacha HTTP adapter minimally rejects non-integer protocol fields", async () => {
    const { playerId, viewerId } = await createPlayer("gacha-invalid-body")
    updatePlayerSync({ id: playerId, freeVmoney: 1000, vmoney: 0 })
    const before = drawState(playerId, ACTIVE_CHARACTER_GACHA_ID)
    const response = await app.inject({
        method: "POST",
        url: "/gacha/exec",
        payload: {
            viewer_id: viewerId,
            gacha_id: ACTIVE_CHARACTER_GACHA_ID,
            payment_type: 1,
            number_of_exec: null,
            type: 1,
            api_count: 1,
        },
    })
    assert.equal(response.statusCode, 400)
    assert.deepEqual(drawState(playerId, ACTIVE_CHARACTER_GACHA_ID), before)
})

test("daily paid draw only consumes daily-first state", async () => {
    const { playerId, viewerId } = await createPlayer("gacha-daily-state")
    updatePlayerSync({ id: playerId, freeVmoney: 0, vmoney: 100 })
    const first = await app.inject({
        method: "POST",
        url: "/gacha/exec",
        payload: {
            viewer_id: viewerId,
            gacha_id: ACTIVE_CHARACTER_GACHA_ID,
            payment_type: 2,
            number_of_exec: 1,
            type: 5,
            api_count: 1,
        },
    })
    assert.equal(first.statusCode, 200, first.body)
    const info = getPlayerGachaInfoSync(playerId, ACTIVE_CHARACTER_GACHA_ID)
    assert.equal(info.isDailyFirst, false)
    assert.equal(info.isAccountFirst, true)
    assert.equal(getPlayerSync(playerId).vmoney, 50)
    const beforeRetry = drawState(playerId, ACTIVE_CHARACTER_GACHA_ID)
    const retry = await app.inject({
        method: "POST",
        url: "/gacha/exec",
        payload: {
            viewer_id: viewerId,
            gacha_id: ACTIVE_CHARACTER_GACHA_ID,
            payment_type: 2,
            number_of_exec: 1,
            type: 5,
            api_count: 2,
        },
    })
    assert.equal(retry.statusCode, 400)
    assert.deepEqual(drawState(playerId, ACTIVE_CHARACTER_GACHA_ID), beforeRetry)
})

test("account-paid ten draw only consumes account-first state", async () => {
    const { playerId } = await createPlayer("gacha-account-state")
    updatePlayerSync({ id: playerId, freeVmoney: 0, vmoney: 1500 })
    const result = executeGachaDrawSync({
        playerId,
        gachaId: 800209,
        paymentType: 2,
        execType: 7,
        numberOfExec: 1,
        nowMs: Date.parse("2024-05-10T00:00:00.000Z"),
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    runGachaPostCommitEffects(result)
    assert.equal(result.draw.length, 10)
    assert.equal(result.isAccountFirst, false)
    assert.equal(result.isDailyFirst, true)
    assert.equal(getPlayerSync(playerId).vmoney, 0)
    const info = getPlayerGachaInfoSync(playerId, 800209)
    assert.equal(info.isAccountFirst, false)
    assert.equal(info.isDailyFirst, true)
})

test("active campaign ten draw consumes its campaign once inside the owner", async () => {
    const { playerId } = await createPlayer("gacha-campaign-ten")
    const result = executeGachaDrawSync({
        playerId,
        gachaId: 28,
        paymentType: 4,
        execType: 8,
        numberOfExec: 1,
        nowMs: Date.parse("2020-05-28T00:00:00.000Z"),
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    runGachaPostCommitEffects(result)
    assert.equal(result.draw.length, 10)
    assert.deepEqual(result.campaignList, [{ gachaId: 28, campaignId: 1, count: 0 }])
    assert.equal(getPlayerGachaCampaignSync(playerId, 28, 1).count, 0)
    assert.equal(result.isDailyFirst, true)
    assert.equal(result.isAccountFirst, true)
})

test("campaign single is consumed once and retry leaves state unchanged", async () => {
    const { playerId } = await createPlayer("gacha-campaign-single")
    const command = {
        playerId,
        gachaId: 46,
        paymentType: 4,
        execType: 11,
        numberOfExec: 1,
        nowMs: Date.parse("2020-10-31T00:00:00.000Z"),
    }
    const first = executeGachaDrawSync(command)
    assert.equal(first.ok, true)
    if (!first.ok) return
    runGachaPostCommitEffects(first)
    assert.equal(first.draw.length, 1)
    assert.deepEqual(first.campaignList, [{ gachaId: 46, campaignId: 2, count: 0 }])
    const beforeRetry = drawState(playerId, 46)
    const retry = executeGachaDrawSync(command)
    assert.deepEqual(retry, {
        ok: false,
        kind: "badRequest",
        message: "Already redeemed campaign for this period.",
    })
    assert.deepEqual(drawState(playerId, 46), beforeRetry)
})

test("current campaign identity and late rollback preserve historical campaign rows", async t => {
    const { playerId } = await createPlayer("gacha-campaign-history")
    insertPlayerGachaCampaignSync(playerId, {
        gachaId: 49,
        campaignId: 2,
        count: 0,
    })
    const command = {
        playerId,
        gachaId: 49,
        paymentType: 4,
        execType: 8,
        numberOfExec: 1,
        nowMs: Date.parse("2020-11-27T00:00:00.000Z"),
    }
    const before = drawState(playerId, 49)
    database.exec(`
        CREATE TRIGGER reject_current_campaign_mission
        BEFORE INSERT ON players_active_mission_counters
        WHEN NEW.player_id = ${playerId}
        BEGIN SELECT RAISE(ABORT, 'forced current campaign failure'); END;
    `)
    t.after(() => database.exec("DROP TRIGGER IF EXISTS reject_current_campaign_mission"))
    assert.throws(() => executeGachaDrawSync(command), /forced current campaign failure/)
    assert.deepEqual(drawState(playerId, 49), before)
    assert.equal(getPlayerGachaCampaignSync(playerId, 49, 2).count, 0)
    assert.equal(getPlayerGachaCampaignSync(playerId, 49, 3), null)

    database.exec("DROP TRIGGER reject_current_campaign_mission")
    const result = executeGachaDrawSync(command)
    assert.equal(result.ok, true)
    if (!result.ok) return
    runGachaPostCommitEffects(result)
    assert.deepEqual(result.campaignList, [{ gachaId: 49, campaignId: 3, count: 0 }])
    assert.equal(getPlayerGachaCampaignSync(playerId, 49, 2).count, 0)
    assert.equal(getPlayerGachaCampaignSync(playerId, 49, 3).count, 0)
})

test("wildcard single ticket supports the client-reachable ten execution batch", async () => {
    const { playerId, viewerId } = await createPlayer("gacha-wildcard-single-ten")
    grantInventoryFixtureItemSync(playerId, 999003, 10)
    const response = await app.inject({
        method: "POST",
        url: "/gacha/exec",
        payload: {
            viewer_id: viewerId,
            gacha_id: ACTIVE_CHARACTER_GACHA_ID,
            payment_type: 3,
            number_of_exec: 10,
            type: 10,
            api_count: 1,
        },
    })
    assert.equal(response.statusCode, 200, response.body)
    const payload = require("msgpackr").unpack(Buffer.from(response.body, "base64")).data
    assert.equal(payload.draw.length, 10)
    assert.equal(payload.item_list[999003], 0)
    assert.equal(getPlayerItemSync(playerId, 999003), 0)
})

test("real 25009 ticket extends execution beyond base period without extending no-ticket access", async () => {
    const withTicket = await createPlayer("gacha-25009-ticket-extension")
    grantInventoryFixtureItemSync(withTicket.playerId, 999004, 1)
    const command = {
        playerId: withTicket.playerId,
        gachaId: 25009,
        paymentType: 3,
        execType: 13,
        numberOfExec: 1,
        nowMs: Date.parse("2024-08-14T12:00:00.000Z"),
    }
    const result = executeGachaDrawSync(command)
    assert.equal(result.ok, true)
    if (!result.ok) return
    runGachaPostCommitEffects(result)
    assert.equal(result.kind, "equipment")
    assert.equal(result.draw.length, 10)
    assert.equal(result.ticketItemBalances[999004], 0)
    assert.equal(getPlayerItemSync(withTicket.playerId, 999004), 0)
    assert.equal(historyCount(withTicket.playerId), 10)
    assert.equal(getPlayerGachaInfoSync(withTicket.playerId, 25009).gachaExchangePoint, 10)

    const withoutTicket = await createPlayer("gacha-25009-no-ticket")
    const before = drawState(withoutTicket.playerId, 25009)
    const rejected = executeGachaDrawSync({ ...command, playerId: withoutTicket.playerId })
    assert.deepEqual(rejected, {
        ok: false,
        kind: "protocolResultCode",
        resultCode: 1351,
        message: "Gacha is outside its available period.",
    })
    assert.deepEqual(drawState(withoutTicket.playerId, 25009), before)
})

test("explicit Comeback period enables only the granted player window", async () => {
    const { playerId } = await createPlayer("gacha-comeback-period")
    const start = Math.floor(Date.parse("2024-08-14T00:00:00.000Z") / 1000)
    const end = Math.floor(Date.parse("2024-08-15T00:00:00.000Z") / 1000)
    grantPlayerComebackGachaPeriodSync({
        playerId,
        gachaId: 700000,
        periodStartTime: start,
        periodEndTime: end,
    })
    updatePlayerSync({ id: playerId, freeVmoney: 150, vmoney: 0 })
    const result = executeGachaDrawSync({
        playerId,
        gachaId: 700000,
        paymentType: 1,
        execType: 1,
        numberOfExec: 1,
        nowMs: Date.parse("2024-08-14T12:00:00.000Z"),
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    runGachaPostCommitEffects(result)
    assert.equal(result.draw.length, 1)
    assert.equal(getPlayerSync(playerId).freeVmoney, 0)
    const loaded = getClientSerializedData(playerId, { viewerId: 0 })
    assert.deepEqual(
        loaded.gacha_info_list.find(info => info.gacha_id === 700000).comeback_campaign,
        { period_start_time: start, period_end_time: end },
    )
})

test("Stars free counts accumulate across daily reset and return absolute after-state", async () => {
    const { playerId } = await createPlayer("gacha-stars-state")
    const periodStartTime = Math.floor(Date.parse("2023-09-01T00:00:00.000Z") / 1000)
    const periodEndTime = Math.floor(Date.parse("2023-09-10T00:00:00.000Z") / 1000)
    grantPlayerStarsGachaCampaignSync({
        playerId,
        campaignId: 1,
        gachaId: 80000,
        periodStartTime,
        periodEndTime,
        freeOneTimes: 0,
        freeTenTimes: 0,
    })
    const command = {
        playerId,
        gachaId: 80000,
        paymentType: 4,
        execType: 8,
        numberOfExec: 1,
        nowMs: Date.parse("2023-09-02T00:00:00.000Z"),
    }
    const first = executeGachaDrawSync(command)
    assert.equal(first.ok, true)
    if (!first.ok) return
    runGachaPostCommitEffects(first)
    assert.deepEqual(first.starsCampaignList, [{
        campaignId: 1,
        freeOneTimes: 0,
        freeTenTimes: 1,
    }])
    upsertPlayerGachaDetailSync({
        playerId,
        gachaId: 80000,
        dailyOneCount: 2,
        dailyTenCount: 3,
        comebackPeriodStartTime: null,
        comebackPeriodEndTime: null,
    })
    const resetSql = captureSql(() => resetPlayerGachaDailyStateSync(playerId))
    assert.equal(resetSql.statements.filter(sql => /^\s*UPDATE\s+players_gacha_/i.test(sql)).length, 3)
    assert.equal(resetSql.statements.filter(sql => /^\s*SELECT\b/i.test(sql)).length, 0)
    assert.equal(getPlayerStarsGachaCampaignByGachaSync(playerId, 80000).freeTenTimes, 1)
    assert.equal(getPlayerGachaDetailSync(playerId, 80000).dailyOneCount, 0)
    assert.equal(getPlayerGachaDetailSync(playerId, 80000).dailyTenCount, 0)
    assert.equal(getPlayerGachaCampaignSync(playerId, 80000, 12).count, 1)
    const second = executeGachaDrawSync({
        ...command,
        nowMs: Date.parse("2023-09-03T00:00:00.000Z"),
    })
    assert.equal(second.ok, true)
    if (!second.ok) return
    assert.deepEqual(second.starsCampaignList, [{
        campaignId: 1,
        freeOneTimes: 0,
        freeTenTimes: 2,
    }])
    const loaded = getClientSerializedData(playerId, { viewerId: 0 })
    const loadedInfo = loaded.gacha_info_list.find(info => info.gacha_id === 80000)
    assert.deepEqual(loadedInfo.stars_campaign, {
        period_start_time: periodStartTime,
        period_end_time: periodEndTime,
    })
    assert.equal(loadedInfo.daily_one_count, 0)
    assert.equal(loadedInfo.daily_ten_count, 0)
    assert.deepEqual(loaded.stars_gacha_campaign_list, [{
        campaign_id: 1,
        free_one_times: 0,
        free_ten_times: 2,
    }])
    resetPlayerGachaDailyStateSync(playerId)
    database.exec(`CREATE TRIGGER reject_stars_mission
        BEFORE UPDATE ON players_active_mission_counters
        WHEN OLD.player_id = ${playerId}
        BEGIN SELECT RAISE(ABORT, 'forced Stars mission failure'); END;`)
    try {
        assert.throws(() => executeGachaDrawSync({
            ...command,
            nowMs: Date.parse("2023-09-04T00:00:00.000Z"),
        }), /forced Stars mission failure/)
    } finally {
        database.exec("DROP TRIGGER reject_stars_mission")
    }
    assert.equal(getPlayerStarsGachaCampaignByGachaSync(playerId, 80000).freeTenTimes, 2)
    assert.equal(getPlayerGachaCampaignSync(playerId, 80000, 12).count, 1)
})

test("Stars free single increments only its absolute one-draw counter", async () => {
    const { playerId } = await createPlayer("gacha-stars-single")
    grantPlayerStarsGachaCampaignSync({
        playerId,
        campaignId: 2,
        gachaId: 80001,
        periodStartTime: Math.floor(Date.parse("2024-01-25T04:00:00.000Z") / 1000),
        periodEndTime: Math.floor(Date.parse("2024-02-03T00:00:00.000Z") / 1000),
        freeOneTimes: 0,
        freeTenTimes: 0,
    })
    const result = executeGachaDrawSync({
        playerId,
        gachaId: 80001,
        paymentType: 4,
        execType: 11,
        numberOfExec: 1,
        nowMs: Date.parse("2024-01-26T00:00:00.000Z"),
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.draw.length, 1)
    assert.deepEqual(result.starsCampaignList, [{
        campaignId: 2,
        freeOneTimes: 1,
        freeTenTimes: 0,
    }])
    assert.equal(getPlayerGachaCampaignSync(playerId, 80001, 1013).count, 0)
})

test("active Equipment ten draw projects only Equipment response facts", async () => {
    const { playerId, viewerId } = await createPlayer("gacha-equipment-active")
    updatePlayerSync({ id: playerId, freeVmoney: 1000, vmoney: 0 })
    const routeSql = await captureSqlAsync(() => app.inject({
        method: "POST",
        url: "/gacha/exec",
        payload: {
            viewer_id: viewerId,
            gacha_id: 25030,
            payment_type: 1,
            number_of_exec: 1,
            type: 2,
            api_count: 1,
        },
    }))
    const response = routeSql.result
    assert.equal(response.statusCode, 200, response.body)
    const payload = require("msgpackr").unpack(Buffer.from(response.body, "base64")).data
    assert.equal(payload.draw_equipment.length, 10)
    assert.equal(payload.draw_equipment.every(draw => (
        Number.isInteger(draw.treasure_up_type)
        && draw.treasure_up_type >= 0
        && draw.treasure_up_type <= 3
    )), true)
    assert.equal(payload.equipment_list.length >= 1, true)
    assert.equal("draw" in payload, false)
    assert.equal("character_list" in payload, false)
    assert.equal(payload.gacha_info_list[0].is_daily_first, true)
    assert.equal(payload.gacha_info_list[0].is_account_first, true)
    assert.equal(historyCount(playerId), 10)
    assert.deepEqual(
        database.prepare(`SELECT type_id FROM players_receive_history
            WHERE player_id = ? ORDER BY id`).all(playerId).map(row => row.type_id),
        payload.draw_equipment.map(draw => draw.equipment_id),
    )
    assert.equal(routeSql.statements.filter(sql => (
        /^\s*INSERT\s+INTO\s+players_receive_history\b/i.test(sql)
    )).length, 1)
})

test("expired ordinary banner is rejected before any persistent write", async () => {
    const { playerId, viewerId } = await createPlayer("gacha-expired")
    updatePlayerSync({ id: playerId, freeVmoney: 1000, vmoney: 0 })
    const before = drawState(playerId, 1)
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
    assert.equal(response.statusCode, 200)
    const payload = require("msgpackr").unpack(Buffer.from(response.body, "base64"))
    assert.equal(payload.data_headers.result_code, 1351)
    assert.deepEqual(payload.data, {})
    assert.deepEqual(drawState(playerId, 1), before)
})

test("missing active campaign returns the client-known 1361 result code", async () => {
    const { playerId, viewerId } = await createPlayer("gacha-campaign-period-error")
    const before = drawState(playerId, ACTIVE_CHARACTER_GACHA_ID)
    const response = await app.inject({
        method: "POST",
        url: "/gacha/exec",
        payload: {
            viewer_id: viewerId,
            gacha_id: ACTIVE_CHARACTER_GACHA_ID,
            payment_type: 4,
            number_of_exec: 1,
            type: 11,
            api_count: 1,
        },
    })
    assert.equal(response.statusCode, 200)
    const payload = require("msgpackr").unpack(Buffer.from(response.body, "base64"))
    assert.equal(payload.data_headers.result_code, 1361)
    assert.deepEqual(payload.data, {})
    assert.deepEqual(drawState(playerId, ACTIVE_CHARACTER_GACHA_ID), before)
})

test("newbie ten-ticket gacha consumes the configured 70030 ticket", async () => {
    const { playerId, viewerId } = await createPlayer("gacha-newbie-ten-ticket")
    grantInventoryFixtureItemSync(playerId, 70030, 1)
    const collectedBefore = getPlayerCollectedItemTotalSync(playerId, 70030)

    const routeSql = await captureSqlAsync(() => app.inject({
        method: "POST",
        url: "/gacha/exec",
        payload: {
            viewer_id: viewerId,
            gacha_id: 1613,
            payment_type: 3,
            number_of_exec: 1,
            type: 4,
            api_count: 1,
        },
    }))
    const response = routeSql.result

    assert.equal(response.statusCode, 200, response.body)
    const payload = require("msgpackr").unpack(Buffer.from(response.body, "base64"))
    assert.equal(getPlayerItemSync(playerId, 70030), 0)
    assert.equal(payload.data.item_list[70030], 0)
    assert.equal(payload.data.draw.length, 10)
    assert.equal(getPlayerGachaInfoSync(playerId, 1613).gachaExchangePoint, 10)
    assert.equal(getPlayerCollectedItemTotalSync(playerId, 70030), collectedBefore)
    const ticketWrites = routeSql.statements.filter(sql => (
        /^\s*INSERT\s+INTO\s+players_items\b/i.test(sql)
        && /VALUES\s*\(70030(?:\.0+)?,\s*0(?:\.0+)?,/i.test(sql)
    ))
    assert.equal(ticketWrites.length, 1, routeSql.statements.filter(sql => (
        /^\s*INSERT\s+INTO\s+players_items\b/i.test(sql)
    )).join("\n---\n"))
    const ticketCollectedWrites = routeSql.statements.filter(sql => (
        /^\s*INSERT\s+INTO\s+players_collected_items\b/i.test(sql)
        && /VALUES\s*\([^,]+,\s*70030(?:\.0+)?,/i.test(sql)
    ))
    assert.equal(ticketCollectedWrites.length, 0, ticketCollectedWrites.join("\n---\n"))
    assert.equal(
        routeSql.statements.filter(sql => /^\s*(?:SAVEPOINT|RELEASE)\b/i.test(sql)).length,
        0,
    )
})

test("ticket gacha rolls its ticket and rewards back on a late mission failure", async t => {
    const { playerId, viewerId } = await createPlayer("gacha-ticket-late-failure")
    grantInventoryFixtureItemSync(playerId, 70030, 1)
    const before = drawState(playerId, 1613)
    const collectedBefore = getPlayerCollectedItemTotalSync(playerId, 70030)
    database.exec(`
        CREATE TRIGGER reject_ticket_gacha_mission_counter
        BEFORE INSERT ON players_active_mission_counters
        WHEN NEW.player_id = ${playerId}
        BEGIN SELECT RAISE(ABORT, 'forced ticket gacha mission counter failure'); END;
    `)
    t.after(() => database.exec("DROP TRIGGER IF EXISTS reject_ticket_gacha_mission_counter"))

    const routeSql = await captureSqlAsync(() => app.inject({
        method: "POST",
        url: "/gacha/exec",
        payload: {
            viewer_id: viewerId,
            gacha_id: 1613,
            payment_type: 3,
            number_of_exec: 1,
            type: 4,
            api_count: 1,
        },
    }))
    const response = routeSql.result

    assert.equal(response.statusCode, 500)
    assert.match(response.body, /forced ticket gacha mission counter failure/)
    assert.deepEqual(drawState(playerId, 1613), before)
    assert.equal(getPlayerCollectedItemTotalSync(playerId, 70030), collectedBefore)
    assert.equal(
        routeSql.statements.filter(sql => (
            /^\s*INSERT\s+INTO\s+players_items\b/i.test(sql)
            && /VALUES\s*\(70030(?:\.0+)?,\s*0(?:\.0+)?,/i.test(sql)
        )).length,
        1,
        routeSql.statements.filter(sql => (
            /^\s*INSERT\s+INTO\s+players_items\b/i.test(sql)
        )).join("\n---\n"),
    )
    assert.equal(
        routeSql.statements.filter(sql => /^\s*(?:SAVEPOINT|RELEASE)\b/i.test(sql)).length,
        0,
    )
})

test("character duplicate gacha item_list reports the post-reward inventory", async () => {
    const { playerId } = await createPlayer("gacha-duplicate-item-list")
    const characterId = 1
    const exBoostItemId = 14002
    setInventoryFixtureItemExactSync(playerId, exBoostItemId, 20)

    const result = database.transaction(() => rewardPlayerGachaDrawResultSync(
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
        {
            ownerGrant: plan => executeRewardGrantExecutionPlanAsTransactionOwnerSync(
                playerId,
                plan,
                rewardGrantPlayerSnapshot(playerId),
            ),
        },
    ))()

    assert.equal(getPlayerItemSync(playerId, exBoostItemId), 21)
    assert.equal(result.draw[0].ex_boost_item.count, 1)
    assert.equal(result.items[exBoostItemId], 21)
})

test("gacha duplicate compensation sends capped overflow to Mail", async () => {
    const { playerId } = await createPlayer("gacha-capped-overflow")
    const characterId = 1
    const exBoostItemId = 14002
    givePlayerCharacterSync(playerId, characterId)
    const policy = createRewardGrantItemOverflowPolicy(playerId)
    setInventoryFixtureItemExactSync(playerId, exBoostItemId, policy.maxCount(exBoostItemId))

    const result = database.transaction(() => rewardPlayerGachaDrawResultSync(
        playerId,
        { type: GachaType.CHARACTER },
        [characterId],
        undefined,
        [{ characterId, rarity: 4, movieId: "normal", seed: 2, requiresVerification: true }],
        {
            ownerGrant: plan => executeRewardGrantExecutionPlanAsTransactionOwnerSync(
                playerId,
                plan,
                rewardGrantPlayerSnapshot(playerId),
                { itemOverflow: policy },
            ),
        },
    ))()

    assert.equal(result.draw[0].ex_boost_item.count, 0)
    assert.equal(result.items[exBoostItemId], policy.maxCount(exBoostItemId))
    const overflowMails = getPlayerMailsSync(playerId, 1, 100, true)
        .filter(mail => mail.type_id === exBoostItemId)
    assert.deepEqual(overflowMails.map(mail => mail.number), [1])
    assert.deepEqual(result.itemOverflowDispositions, [{
        kind: "mail",
        itemId: exBoostItemId,
        overflowAmount: 1,
    }])
})

test("gacha capped overflow rolls back with a later source failure", async () => {
    const { playerId } = await createPlayer("gacha-capped-overflow-rollback")
    const characterId = 1
    const exBoostItemId = 14002
    givePlayerCharacterSync(playerId, characterId)
    const policy = createRewardGrantItemOverflowPolicy(playerId)
    setInventoryFixtureItemExactSync(playerId, exBoostItemId, policy.maxCount(exBoostItemId))

    assert.throws(() => database.transaction(() => {
        rewardPlayerGachaDrawResultSync(
            playerId,
            { type: GachaType.CHARACTER },
            [characterId],
            undefined,
            [{ characterId, rarity: 4, movieId: "normal", seed: 3, requiresVerification: true }],
            {
                ownerGrant: plan => executeRewardGrantExecutionPlanAsTransactionOwnerSync(
                    playerId,
                    plan,
                    rewardGrantPlayerSnapshot(playerId),
                    { itemOverflow: policy },
                ),
            },
        )
        throw new Error("late gacha source failure")
    })(), /late gacha source failure/)
    assert.equal(getPlayerItemSync(playerId, exBoostItemId), policy.maxCount(exBoostItemId))
    assert.deepEqual(getPlayerMailsSync(playerId, 1, 100, true), [])
})

test("gacha source adapter writes capped overflow after external finalize", async () => {
    const { playerId } = await createPlayer("gacha-adapter-capped-overflow")
    const characterId = 1
    const exBoostItemId = 14002
    givePlayerCharacterSync(playerId, characterId)
    const policy = createRewardGrantItemOverflowPolicy(playerId)
    setInventoryFixtureItemExactSync(playerId, exBoostItemId, policy.maxCount(exBoostItemId))
    const player = getPlayerSync(playerId)
    const plan = createRewardGrantExecutionPlan([{ type: RewardType.CHARACTER, id: characterId }])

    const result = database.transaction(() => withDeferredInventoryBatchContextWithinTransactionSync({
        playerId,
        preloadItemIds: [exBoostItemId],
        playerExistence: "caller-verified",
    }, inventory => grantGachaRewardPlanInTransactionOwnerWithInventorySync(
        playerId,
        plan,
        {
            id: player.id,
            freeMana: player.freeMana,
            freeVmoney: player.freeVmoney,
            expPool: player.expPool,
        },
        inventory,
    )))()

    assert.equal(result.assets.items[0].acceptedAmount, 0)
    assert.equal(result.assets.items[0].overflowAmount, 1)
    assert.equal(getPlayerMailsSync(playerId, 1, 100, true).length, 1)
    assert.equal(getPlayerItemSync(playerId, exBoostItemId), policy.maxCount(exBoostItemId))

    assert.throws(() => database.transaction(() => {
        withDeferredInventoryBatchContextWithinTransactionSync({
            playerId,
            preloadItemIds: [exBoostItemId],
            playerExistence: "caller-verified",
        }, inventory => grantGachaRewardPlanInTransactionOwnerWithInventorySync(
            playerId,
            plan,
            {
                id: player.id,
                freeMana: player.freeMana,
                freeVmoney: player.freeVmoney,
                expPool: player.expPool,
            },
            inventory,
        ))
        throw new Error("late gacha adapter failure")
    })(), /late gacha adapter failure/)
    assert.equal(getPlayerMailsSync(playerId, 1, 100, true).length, 1)
    assert.equal(getPlayerItemSync(playerId, exBoostItemId), policy.maxCount(exBoostItemId))
})

function executeGachaGrantBatch(playerId, plan) {
    const player = getPlayerSync(playerId)
    return database.transaction(() => withDeferredInventoryBatchContextWithinTransactionSync({
        playerId,
        playerExistence: "caller-verified",
    }, inventory => grantGachaRewardPlanInTransactionOwnerWithInventorySync(
        playerId,
        plan,
        {
            id: player.id,
            freeMana: player.freeMana,
            freeVmoney: player.freeVmoney,
            expPool: player.expPool,
        },
        inventory,
    )))()
}

function acquisitionSqlMetrics(statements) {
    return {
        characterReads: statements.filter(sql => (
            /^\s*SELECT[\s\S]*FROM\s+players_characters\b/i.test(sql)
            && /\bIN\s*\(/i.test(sql)
        )).length,
        bondReads: statements.filter(sql => (
            /^\s*SELECT[\s\S]*FROM\s+players_characters_bond_tokens\b/i.test(sql)
        )).length,
        characterWrites: statements.filter(sql => (
            /^\s*INSERT\s+INTO\s+players_characters\b/i.test(sql)
        )).length,
        equipmentReads: statements.filter(sql => (
            /^\s*SELECT[\s\S]*FROM\s+players_equipment\b/i.test(sql)
        )).length,
        equipmentWrites: statements.filter(sql => (
            /^\s*INSERT\s+INTO\s+players_equipment\b/i.test(sql)
        )).length,
    }
}

test("Gacha acquisition SQL statement counts stay constant from one to ten unique draws", async () => {
    const characterIds = Object.keys(require("../assets/character.json"))
        .map(Number)
        .filter(id => id !== 1)
        .slice(0, 10)
    const equipmentIds = Object.keys(require("../assets/equipment_lookup.json"))
        .map(Number)
        .filter(id => id >= 3_000_000)
        .slice(0, 10)
    const characterMetrics = []
    const equipmentMetrics = []
    for (const count of [1, 10]) {
        const characterPlayer = await createPlayer(`gacha-character-slope-${count}`)
        const characterPlan = createRewardGrantExecutionPlan(characterIds.slice(0, count).map(id => ({
            type: RewardType.CHARACTER,
            id,
        })))
        characterMetrics.push(acquisitionSqlMetrics(
            captureSql(() => executeGachaGrantBatch(characterPlayer.playerId, characterPlan)).statements,
        ))

        const equipmentPlayer = await createPlayer(`gacha-equipment-slope-${count}`)
        const equipmentPlan = createRewardGrantExecutionPlan(equipmentIds.slice(0, count).map(id => ({
            type: RewardType.EQUIPMENT,
            id,
            count: 1,
        })))
        equipmentMetrics.push(acquisitionSqlMetrics(
            captureSql(() => executeGachaGrantBatch(equipmentPlayer.playerId, equipmentPlan)).statements,
        ))
    }
    assert.deepEqual(characterMetrics, [
        { characterReads: 1, bondReads: 0, characterWrites: 1, equipmentReads: 0, equipmentWrites: 0 },
        { characterReads: 1, bondReads: 0, characterWrites: 1, equipmentReads: 0, equipmentWrites: 0 },
    ])
    assert.deepEqual(equipmentMetrics, [
        { characterReads: 0, bondReads: 0, characterWrites: 0, equipmentReads: 1, equipmentWrites: 1 },
        { characterReads: 0, bondReads: 0, characterWrites: 0, equipmentReads: 1, equipmentWrites: 1 },
    ])
})

test("batched Character ownership records the hundred-character milestone once", async () => {
    const { playerId } = await createPlayer("gacha-character-milestone")
    const copyCharacter = database.prepare(`
        INSERT INTO players_characters (
            id, entry_count, evolution_level, over_limit_step, protection,
            join_time, update_time, exp, stack, mana_board_index, player_id,
            ex_boost_status_id, ex_boost_ability_id_list, illustration_settings
        )
        SELECT ?, entry_count, evolution_level, over_limit_step, protection,
            join_time, update_time, exp, stack, mana_board_index, player_id,
            ex_boost_status_id, ex_boost_ability_id_list, illustration_settings
        FROM players_characters WHERE player_id = ? AND id = 1
    `)
    for (let index = 0; index < 98; index += 1) {
        copyCharacter.run(900000 + index, playerId)
    }
    executeGachaGrantBatch(playerId, createRewardGrantExecutionPlan([{
        type: RewardType.CHARACTER,
        id: 251001,
    }]))
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM players_characters
        WHERE player_id = ?`).get(playerId).count, 100)
    assert.equal(database.prepare(`SELECT COUNT(*) AS count
        FROM players_player_history_milestones
        WHERE player_id = ? AND aggregation_target = 7 AND slot = 0`).get(playerId).count, 1)
})

test("Character acquisition batches repeated new ownership into final-state SQL", async () => {
    const { playerId } = await createPlayer("gacha-character-batch")
    const characterId = 251001
    const plan = createRewardGrantExecutionPlan(Array.from({ length: 10 }, () => ({
        type: RewardType.CHARACTER,
        id: characterId,
    })))
    const measured = captureSql(() => executeGachaGrantBatch(playerId, plan))
    assert.deepEqual(measured.result.entries.map(entry => ({
        isNew: entry.outcome.isNew,
        stack: entry.outcome.after.stack,
    })), [
        { isNew: true, stack: undefined },
        ...Array.from({ length: 9 }, (_, index) => ({ isNew: false, stack: index + 1 })),
    ])
    assert.equal(getPlayerCharacterSync(playerId, characterId).stack, 9)
    assert.equal(measured.statements.filter(sql => (
        /^\s*SELECT[\s\S]*FROM\s+players_characters\b/i.test(sql)
        && /\bIN\s*\(/i.test(sql)
    )).length, 1)
    assert.equal(measured.statements.filter(sql => (
        /^\s*SELECT[\s\S]*FROM\s+players_characters_bond_tokens\b/i.test(sql)
    )).length, 0)
    assert.equal(measured.statements.filter(sql => (
        /^\s*INSERT\s+INTO\s+players_characters\b/i.test(sql)
    )).length, 1)
    assert.equal(measured.statements.filter(sql => (
        /^\s*INSERT\s+INTO\s+players_characters_bond_tokens\b/i.test(sql)
    )).length, 1)
    database.prepare(`UPDATE players_characters
        SET exp = 123, evolution_level = 2, protection = 1, mana_board_index = 2
        WHERE player_id = ? AND id = ?`).run(playerId, characterId)
    executeGachaGrantBatch(playerId, createRewardGrantExecutionPlan([{
        type: RewardType.CHARACTER,
        id: characterId,
    }]))
    const preserved = getPlayerCharacterSync(playerId, characterId)
    assert.equal(preserved.stack, 10)
    assert.equal(preserved.exp, 123)
    assert.equal(preserved.evolutionLevel, 2)
    assert.equal(preserved.protection, true)
    assert.equal(preserved.manaBoardIndex, 2)
})

test("batched duplicate compensation preserves per-entry capacity and overflow order", async () => {
    const { playerId } = await createPlayer("gacha-character-batch-overflow")
    const characterId = 1
    const itemId = 14002
    const maxCount = createRewardGrantItemOverflowPolicy(playerId).maxCount(itemId)
    setInventoryFixtureItemExactSync(playerId, itemId, maxCount - 5)
    const plan = createRewardGrantExecutionPlan(Array.from({ length: 10 }, () => ({
        type: RewardType.CHARACTER,
        id: characterId,
    })))
    const result = executeGachaGrantBatch(playerId, plan)
    assert.deepEqual(
        result.entries.map(entry => entry.outcome.compensationItem.acceptedAmount),
        [1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
    )
    assert.deepEqual(
        result.entries.map(entry => entry.outcome.compensationItem.overflowAmount),
        [0, 0, 0, 0, 0, 1, 1, 1, 1, 1],
    )
    assert.equal(getPlayerItemSync(playerId, itemId), maxCount)
    assert.equal(getPlayerCharacterSync(playerId, characterId).stack, 10)
})

test("Equipment acquisition batches repeated draws without overwriting non-stack state", async () => {
    const { playerId } = await createPlayer("gacha-equipment-batch")
    const equipmentId = 5020008
    const plan = createRewardGrantExecutionPlan(Array.from({ length: 10 }, () => ({
        type: RewardType.EQUIPMENT,
        id: equipmentId,
        count: 1,
    })))
    const measured = captureSql(() => executeGachaGrantBatch(playerId, plan))
    assert.deepEqual(
        measured.result.entries.map(entry => entry.outcome.after.stack),
        Array.from({ length: 10 }, (_, index) => index),
    )
    assert.equal(getPlayerEquipmentSync(playerId, equipmentId).stack, 9)
    assert.equal(measured.statements.filter(sql => (
        /^\s*SELECT[\s\S]*FROM\s+players_equipment\b/i.test(sql)
    )).length, 1)
    assert.equal(measured.statements.filter(sql => (
        /^\s*INSERT\s+INTO\s+players_equipment\b/i.test(sql)
    )).length, 1)

    database.prepare(`UPDATE players_equipment
        SET level = 7, enhancement_level = 3, protection = 1
        WHERE player_id = ? AND id = ?`).run(playerId, equipmentId)
    executeGachaGrantBatch(playerId, createRewardGrantExecutionPlan([{
        type: RewardType.EQUIPMENT,
        id: equipmentId,
        count: 1,
    }]))
    assert.deepEqual(getPlayerEquipmentSync(playerId, equipmentId), {
        level: 7,
        enhancementLevel: 3,
        protection: true,
        stack: 10,
    })
})

test("character owner plan preserves per-draw movie order duplicate deltas and merged state", async () => {
    const { playerId } = await createPlayer("gacha-owner-character-plan")
    const existingCharacterId = 1
    const newCharacterId = 251001
    const specialMovieCharacterId = 111001
    const existingCompensationItemId = 14002
    const newCharacterCompensationItemId = 14017
    const drawResult = [
        existingCharacterId,
        newCharacterId,
        newCharacterId,
        specialMovieCharacterId,
        existingCharacterId,
        existingCharacterId,
        existingCharacterId,
        existingCharacterId,
        existingCharacterId,
        existingCharacterId,
    ]
    const moviePlan = drawResult.map((characterId, drawIndex) => ({
        characterId,
        rarity: drawIndex === 3 ? 5 : 4,
        movieId: drawIndex === 3 ? "rarity_5_guarantee" : `normal_${drawIndex}`,
        seed: 1000 + drawIndex,
        requiresVerification: drawIndex !== 3,
    }))
    setInventoryFixtureItemExactSync(playerId, existingCompensationItemId, 20)
    setInventoryFixtureItemExactSync(playerId, newCharacterCompensationItemId, 5)
    const knownPlayerBefore = rewardGrantPlayerSnapshot(playerId)
    let capturedPlan
    let deferredLog
    const quarantine = getDefaultGachaSeedQuarantine()
    const originalMarkSent = quarantine.markSent
    const markedSeeds = []
    quarantine.markSent = (...args) => markedSeeds.push(args)

    let measured
    try {
        database.transaction(() => {
            measured = captureSql(() => rewardPlayerGachaDrawResultSync(
                playerId,
                { type: GachaType.CHARACTER },
                drawResult,
                undefined,
                moviePlan,
                {
                    ownerGrant: plan => {
                        capturedPlan = plan
                        return executeRewardGrantExecutionPlanAsTransactionOwnerSync(
                            playerId,
                            plan,
                            knownPlayerBefore,
                        )
                    },
                    deferCharacterSampledLog: log => { deferredLog = log },
                },
            ))
        })()
    } finally {
        quarantine.markSent = originalMarkSent
    }

    assert.ok(capturedPlan, "owner callback must receive the character reward plan")
    assert.deepEqual(capturedPlan.entries.map(entry => entry.id), drawResult)
    assert.equal(measured.result.draw.length, drawResult.length)
    assert.deepEqual(measured.result.draw[3], {
        character_id: specialMovieCharacterId,
        movie_id: "rarity_5_guarantee",
        seed: 1003,
        entry_count: 1,
    })
    assert.deepEqual(measured.result.draw[0].ex_boost_item, {
        id: existingCompensationItemId,
        count: 1,
    })
    assert.deepEqual(measured.result.draw[2].ex_boost_item, {
        id: newCharacterCompensationItemId,
        count: 1,
    })
    assert.equal(measured.result.items[existingCompensationItemId], 27)
    assert.equal(measured.result.items[newCharacterCompensationItemId], 6)
    assert.equal(
        measured.statements.filter(sql => /^\s*SELECT[\s\S]*\bFROM\s+players_items\b/i.test(sql)).length,
        2,
    )
    assert.equal(
        measured.statements.filter(sql => /^\s*INSERT\s+INTO\s+players_items\b/i.test(sql)).length,
        2,
    )
    assert.deepEqual(measured.result.characters.map(character => character.character_id), [
        existingCharacterId,
        newCharacterId,
        specialMovieCharacterId,
    ])
    assert.equal(measured.result.characters[0].stack, 7)
    assert.equal(measured.result.characters[1].stack, 1)
    assert.equal(typeof measured.result.characters[1].create_time, "string")
    assert.deepEqual(markedSeeds, moviePlan
        .filter(plan => plan.requiresVerification)
        .map(plan => [plan.movieId, plan.seed, plan.rarity]))
    assert.equal(typeof deferredLog, "function")
    assert.equal(JSON.stringify(measured.result).includes("itemDeltas"), false)
    assert.equal(JSON.stringify(measured.result).includes("joined_character_id_list"), false)
    assert.equal(JSON.stringify(measured.result).includes("isNew"), false)
    const playerReads = measured.statements.filter(sql => /^\s*SELECT[\s\S]*\bFROM\s+players\b/i.test(sql))
    assert.deepEqual(playerReads, [], playerReads.join("\n"))
    const transactionStatements = measured.statements.filter(sql => /^\s*(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql))
    assert.deepEqual(transactionStatements, [], transactionStatements.join("\n"))
})

test("verification-free movie still projects duplicate Character compensation", async () => {
    const { playerId } = await createPlayer("gacha-verification-free-duplicate")
    const characterId = 111001
    const compensationItemId = 14003
    assert.equal(givePlayerCharacterSync(playerId, characterId).isNew, true)
    const quarantine = getDefaultGachaSeedQuarantine()
    const originalMarkSent = quarantine.markSent
    const markedSeeds = []
    quarantine.markSent = (...args) => markedSeeds.push(args)
    let result
    try {
        result = database.transaction(() => rewardPlayerGachaDrawResultSync(
            playerId,
            { type: GachaType.CHARACTER },
            [characterId],
            undefined,
            [{
                characterId,
                rarity: 5,
                movieId: "rarity_5_guarantee",
                seed: 1003,
                requiresVerification: false,
            }],
            {
                ownerGrant: plan => executeRewardGrantExecutionPlanAsTransactionOwnerSync(
                    playerId,
                    plan,
                    rewardGrantPlayerSnapshot(playerId),
                ),
            },
        ))()
    } finally {
        quarantine.markSent = originalMarkSent
    }
    assert.deepEqual(result.draw[0].ex_boost_item, {
        id: compensationItemId,
        count: 1,
    })
    assert.equal(result.items[compensationItemId], 1)
    assert.deepEqual(markedSeeds, [])
})

test("equipment owner plan preserves draw order metadata effects and last equipment state", async () => {
    const { playerId } = await createPlayer("gacha-owner-equipment-plan")
    const movieModule = require("../src/lib/gacha-equipment-movie")
    const originalCompute = movieModule.computeEquipmentGachaMovieEffectsForGacha
    const drawResult = [4030003, 4030003, 5020008]
    const metadata = [
        { id: drawResult[0], rank: 4, isGuarantee: false },
        { id: drawResult[1], rank: 4, isGuarantee: false },
        { id: drawResult[2], rank: 5, isGuarantee: false },
    ]
    let movieInputs
    let capturedPlan
    movieModule.computeEquipmentGachaMovieEffectsForGacha = (_gacha, inputs) => {
        movieInputs = inputs
        return {
            isErupt: false,
            draws: [
                { equipmentId: drawResult[0], treasureUpType: 3 },
                { equipmentId: drawResult[1], treasureUpType: 0 },
                { equipmentId: drawResult[2], treasureUpType: 1 },
            ],
        }
    }

    let result
    try {
        const knownPlayerBefore = rewardGrantPlayerSnapshot(playerId)
        result = database.transaction(() => rewardPlayerGachaDrawResultSync(
            playerId,
            { type: GachaType.WEAPON, equipmentMovieProbabilityId: "1" },
            drawResult,
            metadata,
            undefined,
            {
                ownerGrant: plan => {
                    capturedPlan = plan
                    return executeRewardGrantExecutionPlanAsTransactionOwnerSync(
                        playerId,
                        plan,
                        knownPlayerBefore,
                    )
                },
            },
        ))()
    } finally {
        movieModule.computeEquipmentGachaMovieEffectsForGacha = originalCompute
    }

    assert.deepEqual(movieInputs, metadata.map(({ id, rank, isGuarantee }) => ({ id, rank, isGuarantee })))
    assert.ok(capturedPlan, "owner callback must receive the equipment reward plan")
    assert.deepEqual(capturedPlan.entries.map(entry => entry.id), drawResult)
    assert.deepEqual(result.draw, [
        { equipment_id: drawResult[0], treasure_up_type: 3 },
        { equipment_id: drawResult[1], treasure_up_type: 0 },
        { equipment_id: drawResult[2], treasure_up_type: 1 },
    ])
    assert.equal(result.isErupt, false)
    assert.deepEqual(result.equipment.map(item => [item.equipment_id, item.stack]), [
        [drawResult[0], 1],
        [drawResult[2], 0],
    ])
})

test("owner path rejects metadata and returned typed reward mismatches with no committed rewards", async () => {
    const movieMismatchPlayer = await createPlayer("gacha-owner-movie-mismatch")
    let movieMismatchOwnerCalls = 0
    assert.throws(
        database.transaction(() => rewardPlayerGachaDrawResultSync(
            movieMismatchPlayer.playerId,
            { type: GachaType.CHARACTER },
            [251001, 251002],
            undefined,
            [{ characterId: 251001, rarity: 4, movieId: "normal", seed: 1001, requiresVerification: true }],
            {
                ownerGrant: () => {
                    movieMismatchOwnerCalls++
                    throw new Error("owner must not run")
                },
            },
        )),
        /movie plan.*draw result/i,
    )
    assert.equal(movieMismatchOwnerCalls, 0)
    assert.equal(getPlayerCharacterSync(movieMismatchPlayer.playerId, 251001), null)

    const metadataMismatchPlayer = await createPlayer("gacha-owner-metadata-mismatch")
    assert.throws(
        database.transaction(() => rewardPlayerGachaDrawResultSync(
            metadataMismatchPlayer.playerId,
            { type: GachaType.WEAPON, equipmentMovieProbabilityId: "1" },
            [5040016, 5020008],
            [{ id: 5040016, rank: 4, isGuarantee: false }],
            undefined,
            {
                ownerGrant: plan => executeRewardGrantExecutionPlanAsTransactionOwnerSync(
                    metadataMismatchPlayer.playerId,
                    plan,
                    rewardGrantPlayerSnapshot(metadataMismatchPlayer.playerId),
                ),
            },
        )),
        /metadata.*draw result/i,
    )
    assert.deepEqual(getPlayerEquipmentListSync(metadataMismatchPlayer.playerId), {})

    const resultMismatchPlayer = await createPlayer("gacha-owner-result-mismatch")
    assert.throws(
        database.transaction(() => rewardPlayerGachaDrawResultSync(
            resultMismatchPlayer.playerId,
            { type: GachaType.WEAPON, equipmentMovieProbabilityId: "1" },
            [5040016, 5020008],
            [
                { id: 5040016, rank: 4, isGuarantee: false },
                { id: 5020008, rank: 3, isGuarantee: false },
            ],
            undefined,
            {
                ownerGrant: plan => {
                    const granted = executeRewardGrantExecutionPlanAsTransactionOwnerSync(
                        resultMismatchPlayer.playerId,
                        plan,
                        rewardGrantPlayerSnapshot(resultMismatchPlayer.playerId),
                    )
                    return {
                        ...granted,
                        entries: granted.entries.map((entry, index) => index === 0
                            ? { ...entry, reward: { ...entry.reward, id: 999999999 } }
                            : entry),
                    }
                },
            },
        )),
        /Invalid RewardGrant contract at entry 0: reward/,
    )
    assert.deepEqual(getPlayerEquipmentListSync(resultMismatchPlayer.playerId), {})
})

test("owner path rolls a valid earlier draw back when a later character is unknown", async () => {
    const { playerId } = await createPlayer("gacha-owner-unknown-character")
    const knownPlayerBefore = rewardGrantPlayerSnapshot(playerId)

    assert.throws(
        database.transaction(() => rewardPlayerGachaDrawResultSync(
            playerId,
            { type: GachaType.CHARACTER },
            [251001, 999999996],
            undefined,
            [
                { characterId: 251001, rarity: 4, movieId: "normal", seed: 1001, requiresVerification: true },
                { characterId: 999999996, rarity: 4, movieId: "normal", seed: 1002, requiresVerification: true },
            ],
            {
                ownerGrant: plan => executeRewardGrantExecutionPlanAsTransactionOwnerSync(
                    playerId,
                    plan,
                    knownPlayerBefore,
                ),
                deferCharacterSampledLog: () => assert.fail("failed grants must not schedule a success log"),
            },
        )),
        /RewardGrant entry 1 failed: unknown Character 999999996/,
    )
    assert.equal(getPlayerCharacterSync(playerId, 251001), null)
})
