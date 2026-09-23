"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")

require("ts-node/register/transpile-only")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "api-index-time-semantics-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
const restoreContentSnapshot = installBundledGameplaySnapshot()
const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    getPlayerSync,
    insertDefaultPlayerSync,
    updatePlayerSync,
} = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
const cnLoadRoutes = require("../src/routes/cn/load").default
const apiIndexRoutes = require("../src/routes/api/index").default
const { getTimeOffset, setServerTimeOffset } = require("../src/utils")

const VIEWER_ID = 740000001
const ZAT = "zat-api-index-time-semantics"
const VIRTUAL_NOW_MS = Date.parse("2024-08-14T12:00:00.000Z")
const previousOffset = getTimeOffset()
let app
let playerId

function encode(body) {
    return pack(body).toString("base64")
}

function request(appInstance, url, body) {
    return appInstance.inject({
        method: "POST",
        url,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: encode(body),
    })
}

test.before(async () => {
    setServerTimeOffset(VIRTUAL_NOW_MS - Date.now())
    data.initializeDatabase()

    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: "api-index-time-semantics",
        status: "normal",
    })
    playerId = insertDefaultPlayerSync(account.id).id
    updatePlayerSync({
        id: playerId,
        lastLoginTime: new Date(VIRTUAL_NOW_MS - 24 * 60 * 60 * 1000),
    })
    await insertSessionWithToken({
        token: String(VIEWER_ID),
        accountId: account.id,
        expires: new Date("2099-12-31T23:59:59.000Z"),
        type: SessionType.VIEWER,
    })
    await insertSessionWithToken({
        token: ZAT,
        accountId: account.id,
        expires: new Date("2099-12-31T23:59:59.000Z"),
        type: SessionType.ZAT,
    })

    app = Fastify({ logger: false })
    app.addContentTypeParser(
        "application/x-www-form-urlencoded",
        { parseAs: "string" },
        (_request, body, done) => done(null, unpack(Buffer.from(body, "base64"))),
    )
    registerCnMsgpackOnSend(app)
    await app.register(cnLoadRoutes, {
        assetProvider: { mode: "client-owned" },
        dailyResetHour: 5,
        multiMode: "embedded",
    })
    await app.register(apiIndexRoutes, { prefix: "/api/index.php" })
    await app.ready()
})

test.after(async () => {
    await app.close()
    data.closeDatabase()
    restoreContentSnapshot()
    setServerTimeOffset(previousOffset)
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test("legacy api index load uses the same virtual calendar as CN load", async () => {
    const cnLoad = await request(app, "/load", {
        viewer_id: VIEWER_ID,
        keychain: VIEWER_ID,
        device_id: 1,
        device_token: "api-index-time-semantics-device",
    })
    assert.equal(cnLoad.statusCode, 200, cnLoad.body)
    const afterCnLoad = getPlayerSync(playerId)
    const loginDaysAfterCnLoad = afterCnLoad.totalLoginDays

    const legacyLoad = await request(app, "/api/index.php/load", {
        access_token: ZAT,
        viewer_id: VIEWER_ID,
        device_id: 1,
    })
    assert.equal(legacyLoad.statusCode, 200, legacyLoad.body)

    const afterLegacyLoad = getPlayerSync(playerId)
    assert.equal(
        afterLegacyLoad.totalLoginDays,
        loginDaysAfterCnLoad,
        "the legacy endpoint must not advance the same virtual day a second time",
    )
})
