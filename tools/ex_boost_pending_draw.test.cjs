"use strict"

require("./test-workflow/bootstrap.cjs").bootstrap()

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const Fastify = require("fastify")
const { unpack } = require("msgpackr")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ex-boost-pending-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory
const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()

const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerCharacterSync, updatePlayerCharacterSync } = require("../src/data/domains/character")
const { getPlayerItemSync } = require("../src/data/domains/item")
const { setInventoryFixtureItemExactSync } = require("./helpers/inventory-fixture.cjs")
const { getPendingExBoostDrawSync } = require("../src/data/domains/ex_boost")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
const { deserializeNumberList, serializeNumberList } = require("../src/data/utils")

async function createApp() {
    const app = Fastify({ logger: false })
    registerCnMsgpackOnSend(app)
    const routePath = require.resolve("../src/routes/api/exBoost")
    delete require.cache[routePath]
    await app.register(require(routePath).default, { prefix: "/ex" })
    await app.ready()
    return app
}

async function main() {
    assert.deepEqual(deserializeNumberList(serializeNumberList([])), [])
    const database = data.initializeDatabase()
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `ex-pending-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const viewerId = 840000001
    await insertSessionWithToken({
        token: String(viewerId),
        accountId: account.id,
        expires: new Date("2099-01-01T00:00:00.000Z"),
        type: SessionType.VIEWER,
    })
    updatePlayerCharacterSync(playerId, 1, { overLimitStep: 6 })
    setInventoryFixtureItemExactSync(playerId, 10002, 1)

    const drawApp = await createApp()
    const drawResponse = await drawApp.inject({
        method: "POST",
        url: "/ex/draw",
        payload: { viewer_id: viewerId, character_id: 1, cost_item_id: 10002 },
    })
    assert.equal(drawResponse.statusCode, 200, drawResponse.body)
    const firstDrawData = unpack(Buffer.from(drawResponse.body, "base64")).data
    const pendingAfterFirstDraw = getPendingExBoostDrawSync(playerId)
    const itemAfterFirstDraw = getPlayerItemSync(playerId, 10002)

    const repeatedDrawResponse = await drawApp.inject({
        method: "POST",
        url: "/ex/draw",
        payload: { viewer_id: viewerId, character_id: 1, cost_item_id: 10002 },
    })
    assert.equal(repeatedDrawResponse.statusCode, 200, repeatedDrawResponse.body)
    assert.deepEqual(
        unpack(Buffer.from(repeatedDrawResponse.body, "base64")).data.draw_result,
        firstDrawData.draw_result,
    )
    assert.deepEqual(getPendingExBoostDrawSync(playerId), pendingAfterFirstDraw)
    assert.equal(getPlayerItemSync(playerId, 10002), itemAfterFirstDraw)
    await drawApp.close()

    const selectApp = await createApp()
    // 新契约：first_draw 遇 pending 不阻塞——隐式放弃旧结果 + 重新扣费 + 自动生效
    setInventoryFixtureItemExactSync(playerId, 10002, 1)
    const firstDrawWhilePending = await selectApp.inject({
        method: "POST",
        url: "/ex/first_draw",
        payload: { viewer_id: viewerId, character_id: 1, cost_item_id: 10002 },
    })
    assert.equal(firstDrawWhilePending.statusCode, 200, firstDrawWhilePending.body)
    assert.equal(getPendingExBoostDrawSync(playerId), null, "auto 生效事务内必须清 pending（隐式放弃）")
    assert.equal(getPlayerItemSync(playerId, 10002), 0, "隐式放弃不退旧抽费用，新抽取正常扣费")
    const appliedExBoost = getPlayerCharacterSync(playerId, 1).exBoost
    assert.notEqual(appliedExBoost, undefined)

    const invalidSelectResponse = await selectApp.inject({
        method: "POST",
        url: "/ex/select",
        payload: { viewer_id: viewerId, is_confirm: 1 },
    })
    assert.equal(invalidSelectResponse.statusCode, 400)

    // 空 pending 的 select：协议守卫
    const selectWithoutPending = await selectApp.inject({
        method: "POST",
        url: "/ex/select",
        payload: { viewer_id: viewerId, is_confirm: true },
    })
    assert.equal(selectWithoutPending.statusCode, 400)

    setInventoryFixtureItemExactSync(playerId, 10002, 1)
    const firstDrawReplay = await selectApp.inject({
        method: "POST",
        url: "/ex/first_draw",
        payload: { viewer_id: viewerId, character_id: 1, cost_item_id: 10002 },
    })
    assert.equal(firstDrawReplay.statusCode, 200, firstDrawReplay.body)
    assert.equal(getPlayerItemSync(playerId, 10002), 1)
    assert.deepEqual(getPlayerCharacterSync(playerId, 1).exBoost, appliedExBoost)

    const repeatedFirstDrawReplay = await selectApp.inject({
        method: "POST",
        url: "/ex/first_draw",
        payload: { viewer_id: viewerId, character_id: 1, cost_item_id: 10002 },
    })
    assert.equal(repeatedFirstDrawReplay.statusCode, 200, repeatedFirstDrawReplay.body)
    assert.equal(getPlayerItemSync(playerId, 10002), 1)
    assert.deepEqual(getPlayerCharacterSync(playerId, 1).exBoost, appliedExBoost)

    setInventoryFixtureItemExactSync(playerId, 10002, 1)
    database.exec(`
        CREATE TRIGGER reject_ex_boost_pending_draw
        BEFORE INSERT ON players_ex_boost_pending_draws
        WHEN NEW.player_id = ${playerId}
        BEGIN SELECT RAISE(ABORT, 'forced EX boost pending failure'); END;
    `)
    const failedDraw = await selectApp.inject({
        method: "POST",
        url: "/ex/draw",
        payload: { viewer_id: viewerId, character_id: 1, cost_item_id: 10002 },
    })
    database.exec("DROP TRIGGER reject_ex_boost_pending_draw")
    assert.equal(failedDraw.statusCode, 500, failedDraw.body)
    assert.equal(getPlayerItemSync(playerId, 10002), 1)
    assert.equal(getPendingExBoostDrawSync(playerId), null)
    await selectApp.close()

    data.closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
}

main().then(
    () => console.log("ex boost pending draw tests passed"),
    error => {
        console.error(error)
        process.exitCode = 1
    },
)
