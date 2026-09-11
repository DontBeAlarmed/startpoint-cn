"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { after, before, test } = require("node:test")
const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "load-identity-boundary-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
const restoreContentSnapshot = installBundledGameplaySnapshot()

const data = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const cnLoadRoutes = require("../src/routes/cn/load").default
const { encodeCnMsgpackPayload, registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
const { getTimeOffset, setServerTimeOffset } = require("../src/utils")

const previousTimeOffset = getTimeOffset()
const restoreTime = () => setServerTimeOffset(previousTimeOffset)
setServerTimeOffset(Date.parse("2024-08-14T12:00:00.000Z") - Date.now())

data.initializeDatabase()
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `load-identity-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
const viewerId = 960000001
getDb().prepare("INSERT INTO sessions (token, account_id, expires, type) VALUES (?, ?, ?, ?)")
    .run(String(viewerId), account.id, new Date("2099-12-31T23:59:59.000Z").toISOString(), 2)

function encodeRequest(body) {
    return pack(body).toString("base64")
}

function decodeResponse(response) {
    const contentType = String(response.headers["content-type"] ?? "")
    return contentType.includes("application/x-msgpack")
        ? unpack(Buffer.from(response.body, "base64"))
        : response.json()
}

let app

before(async () => {
    app = Fastify({ logger: false })
    registerCnMsgpackOnSend(app, encodeCnMsgpackPayload)
    app.addContentTypeParser(
        "application/x-www-form-urlencoded",
        { parseAs: "string" },
        (_request, body, done) => done(null, unpack(Buffer.from(body, "base64"))),
    )
    await app.register(cnLoadRoutes, { assetProvider: { mode: "client-owned" } })
    await app.ready()
})

after(async () => {
    await app.close()
    data.closeDatabase()
    restoreContentSnapshot()
    restoreTime()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test("load without any viewer identity is rejected instead of falling back to account 1", async () => {
    for (const body of [{}, { device_id: 1, device_token: "test" }, 5]) {
        const response = await app.inject({
            method: "POST",
            url: "/load",
            headers: {
                "content-type": "application/x-www-form-urlencoded",
                res_ver: "1.4.54",
            },
            payload: encodeRequest(body),
        })
        assert.equal(response.statusCode, 400, `body ${JSON.stringify(body)}: ${response.body}`)
        assert.equal(getDb().prepare(
            "SELECT COUNT(*) AS count FROM players WHERE id = ?",
        ).get(playerId).count, 1, "no side effects on any player")
    }
})

test("load still resolves the keychain identity fallback", async () => {
    const response = await app.inject({
        method: "POST",
        url: "/load",
        headers: {
            "content-type": "application/x-www-form-urlencoded",
            res_ver: "1.4.54",
        },
        payload: encodeRequest({
            keychain: viewerId,
            device_id: 1,
            device_token: "test",
        }),
    })
    assert.equal(response.statusCode, 200, response.body)
    const decoded = decodeResponse(response)
    assert.notEqual(decoded.data, undefined)
    assert.ok(Object.keys(decoded.data).length > 0, "keychain load must return the player save")
})
