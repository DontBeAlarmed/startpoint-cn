"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const previousDataDirectory = process.env.DATA_DIR
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "gift-receive-route-"))
process.env.DATA_DIR = path.join(dataDirectory, "data")

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
const Fastify = require("fastify")
const { unpack } = require("msgpackr")
const data = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const {
    createGiftSync,
    startGiftSync,
    stopGiftSync,
} = require("../src/data/domains/gift")
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
const giftRoutes = require("../src/routes/api/gift").default

let app
let nextViewerId = 931000000

const rewards = [
    { position: 0, type: 1, typeId: 1, number: 3 },
    { position: 1, type: 4, typeId: null, number: 5000 },
    { position: 2, type: 5, typeId: 111001, number: 1 },
    { position: 3, type: 6, typeId: 100001, number: 1 },
    { position: 4, type: 8, typeId: null, number: 700 },
    { position: 5, type: 9, typeId: null, number: 900 },
]

function createActiveGift(code) {
    const gift = createGiftSync({ code, note: null, rewards })
    return startGiftSync(gift.id, gift.revision)
}

async function createPlayer(label) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `gift-route-${label}`,
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
    assert.equal(response.statusCode, 200, response.body)
    return unpack(Buffer.from(response.body, "base64")).data
}

async function receive(viewerId, rawKey) {
    return decode(await app.inject({
        method: "POST",
        url: "/api/index.php/gift/receive",
        payload: { viewer_id: viewerId, key: rawKey },
    }))
}

test.before(async () => {
    data.initializeDatabase()
    app = Fastify({ logger: false })
    registerCnMsgpackOnSend(app)
    app.register(giftRoutes, { prefix: "/api/index.php/gift" })
    await app.ready()
})

test.after(async () => {
    await app.close()
    data.closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(dataDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test("receives a Chinese code once and projects all six rewards in protocol order", async () => {
    const gift = createActiveGift("中文礼包码")
    const { playerId, viewerId } = await createPlayer("chinese")
    const response = await receive(viewerId, gift.code)
    assert.equal(response.result_code, 1)
    assert.deepEqual(response.all_gift_info, [
        { type: 1, type_id: 1, number: 3 },
        { type: 4, type_id: null, number: 5000 },
        { type: 5, type_id: 111001, number: 1 },
        { type: 6, type_id: 100001, number: 1 },
        { type: 8, type_id: null, number: 700 },
        { type: 9, type_id: null, number: 900 },
    ])
    assert.equal(getDb().prepare(
        "SELECT COUNT(*) AS count FROM players_gift_redemptions WHERE gift_id = ? AND player_id = ?",
    ).get(gift.id, playerId).count, 1)
})

test("uses viewer sessions and rejects exact-code variants without redeeming", async () => {
    const gift = createActiveGift("Case Key")
    const { viewerId } = await createPlayer("exact")
    const invalidViewerResponse = await app.inject({
        method: "POST",
        url: "/api/index.php/gift/receive",
        payload: { viewer_id: 999999999, code: gift.code },
    })
    assert.equal(invalidViewerResponse.statusCode, 400, invalidViewerResponse.body)

    const wrongKeyTypeResponse = await app.inject({
        method: "POST",
        url: "/api/index.php/gift/receive",
        payload: { viewer_id: viewerId, key: 42 },
    })
    assert.equal(wrongKeyTypeResponse.statusCode, 400)
    assert.equal((await receive(viewerId, "case key")).result_code, 6101)
    assert.equal((await receive(viewerId, "Case Key ")).result_code, 6101)
    assert.equal(getDb().prepare(
        "SELECT COUNT(*) AS count FROM players_gift_redemptions WHERE gift_id = ?",
    ).get(gift.id).count, 0)
})

test("rejects malformed protocol bodies before touching redemption fields", async () => {
    const gift = createActiveGift("malformed-body")
    const { playerId, viewerId } = await createPlayer("malformed")

    const malformedBodies = [
        null,
        [],
        { viewer_id: viewerId },
        { viewer_id: viewerId, code: gift.code },
        { viewer_id: viewerId, key: 42 },
        { viewer_id: String(viewerId), key: gift.code },
    ]
    for (const payload of malformedBodies) {
        const response = await app.inject({
            method: "POST",
            url: "/api/index.php/gift/receive",
            payload,
        })
        assert.equal(response.statusCode, 400, `payload: ${JSON.stringify(payload)}`)
    }

    assert.equal(getDb().prepare(
        "SELECT COUNT(*) AS count FROM players_gift_redemptions WHERE gift_id = ? AND player_id = ?",
    ).get(gift.id, playerId).count, 0)
})

test("unexpected redemption failures return a redacted HTTP 500 and one bounded log", async t => {
    const gift = createActiveGift("owner-failure")
    const { viewerId } = await createPlayer("owner-failure")
    const redemptionModule = require("../src/lib/gift-code/redemption")
    const originalOwner = redemptionModule.receiveGiftCodeSync
    redemptionModule.receiveGiftCodeSync = () => {
        throw new Error(`secret failure for ${gift.code}`)
    }
    t.after(() => {
        redemptionModule.receiveGiftCodeSync = originalOwner
    })

    const logChunks = []
    const failureApp = Fastify({
        logger: {
            level: "error",
            stream: {
                write(chunk) {
                    logChunks.push(chunk)
                },
            },
        },
    })
    registerCnMsgpackOnSend(failureApp)
    failureApp.register(giftRoutes, { prefix: "/api/index.php/gift" })
    await failureApp.ready()
    t.after(() => failureApp.close())

    const response = await failureApp.inject({
        method: "POST",
        url: "/api/index.php/gift/receive",
        payload: { viewer_id: viewerId, key: gift.code },
    })
    assert.equal(response.statusCode, 500)
    assert.deepEqual(response.json(), {
        statusCode: 500,
        error: "Internal Server Error",
        message: "Gift redemption failed",
    })
    assert.equal(response.body.includes(gift.code), false)
    assert.equal(response.body.includes("secret failure"), false)
    assert.equal(logChunks.length, 1)
    assert.equal(logChunks.join("").includes(gift.code), false)
    assert.equal(logChunks.join("").includes("secret failure"), false)
    assert.equal(getDb().prepare(
        "SELECT COUNT(*) AS count FROM players_gift_redemptions WHERE gift_id = ?",
    ).get(gift.id).count, 0)
})

test("stopped gifts return 6103 and redeemed gifts return 6104 for the same player", async () => {
    const stoppedGift = createActiveGift("stopped-route")
    stopGiftSync(stoppedGift.id, stoppedGift.revision)
    const stoppedPlayer = await createPlayer("stopped")
    assert.equal((await receive(stoppedPlayer.viewerId, stoppedGift.code)).result_code, 6103)

    const gift = createActiveGift("duplicate-route")
    const player = await createPlayer("duplicate")
    assert.equal((await receive(player.viewerId, gift.code)).result_code, 1)
    assert.equal((await receive(player.viewerId, gift.code)).result_code, 6104)
})

test("different players redeem the same gift independently", async () => {
    const gift = createActiveGift("shared-route")
    const first = await createPlayer("shared-first")
    const second = await createPlayer("shared-second")
    assert.equal((await receive(first.viewerId, gift.code)).result_code, 1)
    assert.equal((await receive(second.viewerId, gift.code)).result_code, 1)
})
