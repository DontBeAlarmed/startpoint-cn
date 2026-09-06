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
const { pack, unpack } = require("msgpackr")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "gacha-crazy-c5-"))
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
const { getPlayerCharactersSync } = require("../src/data/domains/character")
const {
    getPendingPlayerGachaConversionsSync,
    getPlayerCrazyGachaResultsSync,
    recordPlayerGachaConversionSync,
} = require("../src/data/domains/gacha-lifecycle-state")
const {
    getPlayerGachaInfoSync,
    insertPlayerGachaInfoSync,
    updatePlayerGachaInfoSync,
} = require("../src/data/domains/gacha")
const { getPlayerItemSync } = require("../src/data/domains/item")
const { getPlayerMailsSync, MailType } = require("../src/data/domains/mail")
const { getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const {
    projectCrazyGachaLoadStateSync,
    projectPendingGachaConversionsSync,
    settleExpiredGachaPointsOnLoadSync,
} = require("../src/lib/gacha-owner")
const gachaRoutes = require("../src/routes/api/gacha").default
const cnLoadRoutes = require("../src/routes/cn/load").default
const mailRoutes = require("../src/routes/api/mail").default
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
const {
    grantInventoryFixtureItemSync,
    setInventoryFixtureItemExactSync,
} = require("./helpers/inventory-fixture.cjs")
const { getTimeOffset, setServerTimeOffset } = require("../src/utils")

const CRAZY_GACHA_ID = 100
const CRAZY_TICKET_ID = 999012
const EXTENDED_GACHA_ID = 25009
const EXTENDED_TICKET_ID = 999004
const EXPIRED_GACHA_ID = 29
const NOW_MS = Date.parse("2024-08-14T12:00:00.000Z")
const previousTimeOffset = getTimeOffset()
let nextViewerId = 870000000
let database
let app

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

function decode(response) {
    return unpack(Buffer.from(response.body, "base64"))
}

function historyCount(playerId) {
    return database.prepare(`SELECT COUNT(*) AS count
        FROM players_receive_history WHERE player_id = ?`).get(playerId).count
}

async function crazyExec(viewerId) {
    return app.inject({
        method: "POST",
        url: "/gacha/exec",
        payload: {
            viewer_id: viewerId,
            gacha_id: CRAZY_GACHA_ID,
            type: 14,
            payment_type: 3,
            number_of_exec: 1,
        },
    })
}

test.before(async () => {
    setServerTimeOffset(NOW_MS - Date.now())
    database = data.initializeDatabase({
        databaseFactory: databasePath => new BetterSqlite3(databasePath),
    })
    app = Fastify({ logger: false })
    app.addContentTypeParser(
        "application/x-www-form-urlencoded",
        { parseAs: "string" },
        (_request, body, done) => done(null, unpack(Buffer.from(body, "base64"))),
    )
    registerCnMsgpackOnSend(app)
    await app.register(gachaRoutes, { prefix: "/gacha" })
    await app.register(mailRoutes, { prefix: "/mail" })
    await app.register(cnLoadRoutes, {
        assetProvider: { mode: "client-owned" },
        multiMode: "embedded",
    })
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

test("Crazy candidate, save, redraw, load recovery and select form one reachable lifecycle", async () => {
    const { playerId, viewerId } = await createPlayer("crazy-lifecycle")
    grantInventoryFixtureItemSync(playerId, CRAZY_TICKET_ID, 1)
    const charactersBefore = getPlayerCharactersSync(playerId)

    const first = await crazyExec(viewerId)
    assert.equal(first.statusCode, 200, first.body)
    const firstData = decode(first).data
    assert.equal(firstData.draw.length, 10)
    assert.equal(firstData.gacha_info_list[0].crazy_draw_count, 1)
    assert.equal(firstData.item_list[CRAZY_TICKET_ID], 0)
    assert.equal(firstData.crazy_gacha_result_list[0].length, 10)
    assert.deepEqual(getPlayerCharactersSync(playerId), charactersBefore)
    assert.equal(historyCount(playerId), 0)
    assert.equal(getPlayerGachaInfoSync(playerId, CRAZY_GACHA_ID).gachaExchangePoint, 0)

    const saved = await app.inject({
        method: "POST",
        url: "/gacha/crazy_gacha_save",
        payload: { viewer_id: viewerId, index: 1 },
    })
    assert.equal(saved.statusCode, 200, saved.body)
    const savedSlot = [...decode(saved).data.crazy_gacha_result_list[1]]
    assert.equal(savedSlot.length, 10)

    grantInventoryFixtureItemSync(playerId, CRAZY_TICKET_ID, 1)
    const second = await crazyExec(viewerId)
    assert.equal(second.statusCode, 200, second.body)
    const secondData = decode(second).data
    assert.equal(secondData.gacha_info_list[0].crazy_draw_count, 2)
    assert.deepEqual(secondData.crazy_gacha_result_list[1], savedSlot)
    assert.equal(secondData.crazy_gacha_result_list[0].length, 10)
    assert.equal(getPlayerItemSync(playerId, CRAZY_TICKET_ID), 0)

    const loaded = projectCrazyGachaLoadStateSync(playerId)
    assert.deepEqual(loaded.crazyGachaResultList[1], savedSlot)
    assert.equal(loaded.lastCrazyGachaDrawResult.length, 10)
    assert.equal(typeof loaded.lastCrazyGachaDrawResult[0].movie_id, "string")
    assert.equal(Number.isSafeInteger(loaded.lastCrazyGachaDrawResult[0].seed), true)

    const selected = await app.inject({
        method: "POST",
        url: "/gacha/crazy_gacha_select",
        payload: { viewer_id: viewerId, gacha_id: CRAZY_GACHA_ID, index: 1 },
    })
    assert.equal(selected.statusCode, 200, selected.body)
    assert.equal(decode(selected).data.character_list.length > 0, true)
    assert.equal(historyCount(playerId), 10)
    assert.equal(getPlayerCrazyGachaResultsSync(playerId, CRAZY_GACHA_ID).length, 0)
    assert.deepEqual(projectCrazyGachaLoadStateSync(playerId), {
        crazyGachaResultList: {},
        lastCrazyGachaDrawResult: [],
    })
    const charactersAfter = getPlayerCharactersSync(playerId)

    const repeated = await app.inject({
        method: "POST",
        url: "/gacha/crazy_gacha_select",
        payload: { viewer_id: viewerId, gacha_id: CRAZY_GACHA_ID, index: 1 },
    })
    assert.equal(repeated.statusCode, 400)
    assert.deepEqual(getPlayerCharactersSync(playerId), charactersAfter)
    assert.equal(historyCount(playerId), 10)
})

test("Crazy select rolls rewards and slot clearing back on a late history failure", async t => {
    const { playerId, viewerId } = await createPlayer("crazy-rollback")
    grantInventoryFixtureItemSync(playerId, CRAZY_TICKET_ID, 1)
    const candidate = await crazyExec(viewerId)
    assert.equal(candidate.statusCode, 200, candidate.body)
    database.exec(`
        CREATE TRIGGER reject_crazy_history
        BEFORE INSERT ON players_receive_history
        WHEN NEW.player_id = ${playerId}
        BEGIN SELECT RAISE(ABORT, 'forced Crazy history failure'); END;
    `)
    t.after(() => database.exec("DROP TRIGGER IF EXISTS reject_crazy_history"))
    const before = getPlayerCharactersSync(playerId)

    const selected = await app.inject({
        method: "POST",
        url: "/gacha/crazy_gacha_select",
        payload: { viewer_id: viewerId, gacha_id: CRAZY_GACHA_ID, index: 0 },
    })
    assert.equal(selected.statusCode, 500)
    assert.deepEqual(getPlayerCharactersSync(playerId), before)
    assert.equal(getPlayerCrazyGachaResultsSync(playerId, CRAZY_GACHA_ID).length, 10)
    assert.equal(historyCount(playerId), 0)
})

test("expired points convert once, respect Star Crumb cap, mail overflow and ack once", async () => {
    const { playerId, viewerId } = await createPlayer("conversion")
    updatePlayerSync({ id: playerId, starCrumb: 9995 })
    insertPlayerGachaInfoSync(playerId, {
        gachaId: EXPIRED_GACHA_ID,
        isDailyFirst: true,
        isAccountFirst: true,
        gachaExchangePoint: 10,
    })

    const converted = settleExpiredGachaPointsOnLoadSync({
        playerId,
        nowMs: NOW_MS,
        maxStarCrumb: 9999,
    })
    assert.equal(converted.status, "converted")
    assert.deepEqual(converted.entries.map(entry => ({
        requested: entry.requestedPoint,
        accepted: entry.acceptedStarCrumb,
        overflow: entry.overflowStarCrumb,
    })), [{ requested: 10, accepted: 4, overflow: 6 }])
    assert.equal(getPlayerSync(playerId).starCrumb, 9999)
    assert.equal(getPlayerGachaInfoSync(playerId, EXPIRED_GACHA_ID).gachaExchangePoint, 0)
    const overflow = getPlayerMailsSync(playerId, 1, 100, true)
        .filter(mail => mail.type === MailType.STAR_CRUMB)
    assert.equal(overflow.length, 1)
    assert.equal(overflow[0].number, 6)
    const blockedClaim = await app.inject({
        method: "POST",
        url: "/mail/receive",
        payload: { viewer_id: viewerId, mail_id: overflow[0].id, api_count: 1 },
    })
    assert.equal(blockedClaim.statusCode, 400)
    assert.equal(getPlayerMailsSync(playerId, 1, 100, true)
        .some(mail => mail.id === overflow[0].id), true)
    assert.deepEqual(projectPendingGachaConversionsSync(playerId), [{
        gacha_id: EXPIRED_GACHA_ID,
        gacha_exchange_point: 10,
    }])

    const repeatedSettlement = settleExpiredGachaPointsOnLoadSync({
        playerId,
        nowMs: NOW_MS,
        maxStarCrumb: 9999,
    })
    assert.equal(repeatedSettlement.status, "none")
    assert.equal(getPlayerMailsSync(playerId, 1, 100, true)
        .filter(mail => mail.type === MailType.STAR_CRUMB).length, 1)

    const acknowledged = await app.inject({
        method: "POST",
        url: "/gacha/shown_converted",
        payload: { viewer_id: viewerId, gacha_id: EXPIRED_GACHA_ID },
    })
    assert.equal(acknowledged.statusCode, 200, acknowledged.body)
    assert.deepEqual(projectPendingGachaConversionsSync(playerId), [])
    const repeatedAck = await app.inject({
        method: "POST",
        url: "/gacha/shown_converted",
        payload: { viewer_id: viewerId, gacha_id: EXPIRED_GACHA_ID },
    })
    assert.equal(repeatedAck.statusCode, 200, repeatedAck.body)
    assert.equal(getPlayerSync(playerId).starCrumb, 9999)
})

test("held extension ticket delays conversion until the last legal path disappears", async () => {
    const { playerId } = await createPlayer("conversion-ticket")
    insertPlayerGachaInfoSync(playerId, {
        gachaId: EXTENDED_GACHA_ID,
        isDailyFirst: true,
        isAccountFirst: true,
        gachaExchangePoint: 7,
    })
    grantInventoryFixtureItemSync(playerId, EXTENDED_TICKET_ID, 1)

    const delayed = settleExpiredGachaPointsOnLoadSync({
        playerId,
        nowMs: NOW_MS,
        maxStarCrumb: 9999,
    })
    assert.equal(delayed.status, "none")
    assert.equal(getPlayerGachaInfoSync(playerId, EXTENDED_GACHA_ID).gachaExchangePoint, 7)

    setInventoryFixtureItemExactSync(playerId, EXTENDED_TICKET_ID, 0)
    const converted = settleExpiredGachaPointsOnLoadSync({
        playerId,
        nowMs: NOW_MS,
        maxStarCrumb: 9999,
    })
    assert.equal(converted.status, "converted")
    assert.equal(getPlayerGachaInfoSync(playerId, EXTENDED_GACHA_ID).gachaExchangePoint, 0)
})

test("load publishes committed conversion and does not repeat it after shown ack", async () => {
    const { playerId, viewerId } = await createPlayer("conversion-load")
    insertPlayerGachaInfoSync(playerId, {
        gachaId: EXPIRED_GACHA_ID,
        isDailyFirst: true,
        isAccountFirst: true,
        gachaExchangePoint: 3,
    })
    const requestLoad = () => app.inject({
        method: "POST",
        url: "/load",
        headers: {
            "content-type": "application/x-www-form-urlencoded",
            res_ver: "1.4.54",
        },
        payload: pack({
            viewer_id: viewerId,
            keychain: viewerId,
            device_id: 1,
            device_token: "c5-conversion-load",
        }).toString("base64"),
    })
    const first = await requestLoad()
    assert.equal(first.statusCode, 200, first.body)
    const firstData = decode(first).data
    assert.deepEqual(firstData.converted_gacha_list, [{
        gacha_id: EXPIRED_GACHA_ID,
        gacha_exchange_point: 3,
    }])
    assert.equal(firstData.gacha_info_list
        .find(info => info.gacha_id === EXPIRED_GACHA_ID).gacha_exchange_point, 0)
    assert.deepEqual(firstData.crazy_gacha_result_list, {})
    assert.deepEqual(firstData.last_crazy_gacha_draw_result, [])

    const acknowledged = await app.inject({
        method: "POST",
        url: "/gacha/shown_converted",
        payload: { viewer_id: viewerId, gacha_id: EXPIRED_GACHA_ID },
    })
    assert.equal(acknowledged.statusCode, 200, acknowledged.body)
    const second = await requestLoad()
    assert.equal(second.statusCode, 200, second.body)
    assert.deepEqual(decode(second).data.converted_gacha_list, [])
    assert.equal(getPlayerSync(playerId).starCrumb, 5)
})

test("conversion notification accumulates before shown and reopens with only the new amount", async () => {
    const { playerId } = await createPlayer("conversion-notification")
    insertPlayerGachaInfoSync(playerId, {
        gachaId: EXPIRED_GACHA_ID,
        isDailyFirst: true,
        isAccountFirst: true,
        gachaExchangePoint: 0,
    })
    database.transaction(() => {
        recordPlayerGachaConversionSync({
            playerId,
            gachaId: EXPIRED_GACHA_ID,
            point: 3,
            convertedAt: 1,
        })
        recordPlayerGachaConversionSync({
            playerId,
            gachaId: EXPIRED_GACHA_ID,
            point: 4,
            convertedAt: 2,
        })
    })()
    assert.equal(getPendingPlayerGachaConversionsSync(playerId)[0].pendingPoint, 7)
    database.prepare(`UPDATE players_gacha_conversions SET shown = 1
        WHERE player_id = ? AND gacha_id = ?`).run(playerId, EXPIRED_GACHA_ID)
    database.transaction(() => recordPlayerGachaConversionSync({
        playerId,
        gachaId: EXPIRED_GACHA_ID,
        point: 2,
        convertedAt: 3,
    }))()
    assert.equal(getPendingPlayerGachaConversionsSync(playerId)[0].pendingPoint, 2)
})

test("Crazy select recalculates duplicate compensation from selection-time state", async () => {
    const { playerId, viewerId } = await createPlayer("crazy-recalc-owned")
    grantInventoryFixtureItemSync(playerId, CRAZY_TICKET_ID, 1)
    const candidate = await crazyExec(viewerId)
    assert.equal(candidate.statusCode, 200, candidate.body)
    const rows = getPlayerCrazyGachaResultsSync(playerId, CRAZY_GACHA_ID)
    // 抽取时为新增角色的候选不含补偿 display 元数据
    const fresh = rows.find(row => row.exBoostItemId === null)
    assert.notEqual(fresh, undefined)

    // 选择前通过独立途径获得该角色：select 必须按选择时权威状态重算为重复并发补偿
    database.prepare(`
        INSERT INTO players_characters (
            id, entry_count, evolution_level, over_limit_step, protection,
            join_time, update_time, exp, stack, mana_board_index, player_id
        ) VALUES (?, 1, 0, 0, 0, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z', 0, 0, 1, ?)
    `).run(fresh.characterId, playerId)
    const { getCharacterDataSync } = require("../src/lib/assets")
    const { getCharacterStackCompensationItemId } = require("../src/lib/character-growth/commands/grant-character-stack")
    const compensationItemId = getCharacterStackCompensationItemId(
        getCharacterDataSync(fresh.characterId).rarity,
        getCharacterDataSync(fresh.characterId).element,
    )
    const before = getPlayerItemSync(playerId, compensationItemId) ?? 0
    // 期望值只能从选择时的权威持有状态顺序模拟；候选 display-only
    // exBoost 元数据不得参与 acquisition 判定。同一新角色在候选中重复时，
    // 第一次是新增，后续 occurrence 才产生补偿。
    const { getCharacterAcquisitionStatesSync } = require("../src/data/domains/reward-acquisition")
    const ownedAtSelect = new Set(Object.keys(getCharacterAcquisitionStatesSync(
        playerId,
        rows.map(row => row.characterId),
    )).map(Number))
    let expectedCount = 0
    for (const row of rows) {
        if (ownedAtSelect.has(row.characterId)
            && getCharacterStackCompensationItemId(
                getCharacterDataSync(row.characterId).rarity,
                getCharacterDataSync(row.characterId).element,
            ) === compensationItemId) {
            expectedCount += 1
        }
        ownedAtSelect.add(row.characterId)
    }
    assert.equal(expectedCount >= 1, true)

    const selected = await app.inject({
        method: "POST",
        url: "/gacha/crazy_gacha_select",
        payload: { viewer_id: viewerId, gacha_id: CRAZY_GACHA_ID, index: 0 },
    })
    assert.equal(selected.statusCode, 200, selected.body)
    assert.equal(getPlayerItemSync(playerId, compensationItemId), before + expectedCount)
    assert.equal(decode(selected).data.item_list[compensationItemId], before + expectedCount)
    assert.equal(historyCount(playerId), 10)
})

test("Crazy select ignores stored candidate display metadata for acquisition", async () => {
    const { playerId, viewerId } = await createPlayer("crazy-recalc-display")
    const { getCharacterAcquisitionStatesSync } = require("../src/data/domains/reward-acquisition")
    const { replacePlayerCrazyGachaSlotZeroSync } = require("../src/data/domains/gacha-lifecycle-state")
    const bundledGachas = require("../assets/gacha.json")
    const bundledPools = require("../assets/gacha_pool.json")
    const allIds = Object.values(bundledGachas[String(CRAZY_GACHA_ID)].poolOddsIds)
        .flatMap(oddsId => bundledPools[oddsId].map(item => item.id))
    const owned = new Set(Object.keys(getCharacterAcquisitionStatesSync(playerId, allIds)).map(Number))
    const characterIds = allIds.filter(id => !owned.has(id)).slice(0, 10)
    assert.equal(characterIds.length, 10)

    insertPlayerGachaInfoSync(playerId, {
        gachaId: CRAZY_GACHA_ID,
        isDailyFirst: true,
        isAccountFirst: true,
        gachaExchangePoint: 0,
    })
    database.transaction(() => replacePlayerCrazyGachaSlotZeroSync({
        playerId,
        gachaId: CRAZY_GACHA_ID,
        draws: characterIds.map(characterId => ({
            characterId,
            movieId: "normal",
            seed: 10000001,
            entryCount: 5,
            exBoostItemId: 14002,
            exBoostItemCount: 3,
        })),
    }))()

    const selected = await app.inject({
        method: "POST",
        url: "/gacha/crazy_gacha_select",
        payload: { viewer_id: viewerId, gacha_id: CRAZY_GACHA_ID, index: 0 },
    })
    assert.equal(selected.statusCode, 200, selected.body)
    // display 元数据声称重复+entryCount 5，但选择时角色为新增：不产生补偿
    assert.equal(getPlayerItemSync(playerId, 14002) ?? 0, 0)
    assert.equal(decode(selected).data.item_list[14002], undefined)
    assert.equal(historyCount(playerId), 10)
    assert.equal(getPlayerCrazyGachaResultsSync(playerId, CRAZY_GACHA_ID).length, 0)
})

test("Crazy save and select fail closed on repeats, empty slots, wrong gacha and expiry", async t => {
    const { playerId, viewerId } = await createPlayer("crazy-fail-closed")
    const requestSave = index => app.inject({
        method: "POST",
        url: "/gacha/crazy_gacha_save",
        payload: { viewer_id: viewerId, index },
    })
    const requestSelect = (gachaId, index) => app.inject({
        method: "POST",
        url: "/gacha/crazy_gacha_select",
        payload: { viewer_id: viewerId, gacha_id: gachaId, index },
    })

    const withoutSlotZero = await requestSave(1)
    assert.equal(withoutSlotZero.statusCode, 400)

    grantInventoryFixtureItemSync(playerId, CRAZY_TICKET_ID, 2)
    const candidate = await crazyExec(viewerId)
    assert.equal(candidate.statusCode, 200, candidate.body)
    const saved = await requestSave(1)
    assert.equal(saved.statusCode, 200, saved.body)
    const repeatedSave = await requestSave(1)
    assert.equal(repeatedSave.statusCode, 400)
    assert.equal(getPlayerCrazyGachaResultsSync(playerId, CRAZY_GACHA_ID)
        .filter(row => row.slotIndex === 1).length, 10)

    const wrongGacha = await requestSelect(EXPIRED_GACHA_ID, 0)
    assert.equal(wrongGacha.statusCode, 400)
    const emptySlot = await requestSelect(CRAZY_GACHA_ID, 2)
    assert.equal(emptySlot.statusCode, 400)
    assert.equal(getPlayerCrazyGachaResultsSync(playerId, CRAZY_GACHA_ID).length, 20)

    // banner 100 的 base/ticket 期都到 2050-12-16；越过之后 save/select 返回 1351
    const previousOffset = getTimeOffset()
    setServerTimeOffset(Date.parse("2051-06-01T00:00:00.000Z") - Date.now())
    t.after(() => setServerTimeOffset(previousOffset))
    const expiredSave = await requestSave(2)
    assert.equal(expiredSave.statusCode, 200, expiredSave.body)
    assert.equal(decode(expiredSave).data_headers.result_code, 1351)
    const expiredSelect = await requestSelect(CRAZY_GACHA_ID, 1)
    assert.equal(expiredSelect.statusCode, 200, expiredSelect.body)
    assert.equal(decode(expiredSelect).data_headers.result_code, 1351)
    assert.equal(getPlayerCrazyGachaResultsSync(playerId, CRAZY_GACHA_ID).length, 20)
    assert.equal(historyCount(playerId), 0)
})

test("Crazy draw limit comes from config gacha_crazy_ten_max_count", async () => {
    const { playerId, viewerId } = await createPlayer("crazy-draw-limit")
    const { getCrazyGachaPolicySync } = require("../src/lib/config-content")
    const maxCount = getCrazyGachaPolicySync().tenDrawMaxCount
    assert.equal(Number.isSafeInteger(maxCount) && maxCount > 0, true)

    grantInventoryFixtureItemSync(playerId, CRAZY_TICKET_ID, 2)
    insertPlayerGachaInfoSync(playerId, {
        gachaId: CRAZY_GACHA_ID,
        isDailyFirst: true,
        isAccountFirst: true,
        gachaExchangePoint: 0,
        crazyDrawCount: maxCount - 1,
    })
    const allowed = await crazyExec(viewerId)
    assert.equal(allowed.statusCode, 200, allowed.body)
    assert.equal(decode(allowed).data.gacha_info_list[0].crazy_draw_count, maxCount)

    grantInventoryFixtureItemSync(playerId, CRAZY_TICKET_ID, 1)
    const rejected = await crazyExec(viewerId)
    assert.equal(rejected.statusCode, 400)
    assert.equal(decode(allowed).data.crazy_gacha_result_list[0].length, 10)
    // 拒绝路径不扣票：2 - 1(成功抽) + 1(补发) = 2
    assert.equal(getPlayerItemSync(playerId, CRAZY_TICKET_ID), 2)
})

test("points on a banner missing from the content snapshot convert and do not block save export", async () => {
    const { playerId } = await createPlayer("conversion-missing-banner")
    const unknownGachaId = 987654
    const starCrumbBefore = getPlayerSync(playerId).starCrumb
    insertPlayerGachaInfoSync(playerId, {
        gachaId: unknownGachaId,
        isDailyFirst: true,
        isAccountFirst: true,
        gachaExchangePoint: 5,
    })

    const converted = settleExpiredGachaPointsOnLoadSync({
        playerId,
        nowMs: NOW_MS,
        maxStarCrumb: 9999,
    })
    assert.equal(converted.status, "converted")
    assert.equal(getPlayerSync(playerId).starCrumb, starCrumbBefore + 5)
    assert.deepEqual(projectPendingGachaConversionsSync(playerId), [{
        gacha_id: unknownGachaId,
        gacha_exchange_point: 5,
    }])
    assert.equal(getPlayerGachaInfoSync(playerId, unknownGachaId).gachaExchangePoint, 0)

    // conversion 是 lifecycle 终态记录：banner 缺失不应让同一快照下的 save 导出失败
    const { exportPlayerSaveV2Sync } = require("../src/data/player-save/v2")
    const snapshot = exportPlayerSaveV2Sync(playerId)
    assert.equal(snapshot.domains.economy.tables.players_gacha_conversions.length, 1)
})
