"use strict"

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")

require("ts-node/register/transpile-only")

const previousDataDirectory = process.env.DATA_DIR
const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "quest-recent-party-"))
process.env.DATA_DIR = databaseDirectory

const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const questUnlockRoutes = require("../src/routes/api/questUnlock").default
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")

const restoreContentSnapshot = installBundledGameplaySnapshot()
data.initializeDatabase()

let viewerId

function decode(response) {
    return unpack(Buffer.from(response.body, "base64"))
}

async function postQuest(app, url, body) {
    return app.inject({
        method: "POST",
        url,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: pack(body).toString("base64"),
    })
}

async function buildQuestApp(t) {
    const app = Fastify({ logger: false })
    app.addContentTypeParser(
        "application/x-www-form-urlencoded",
        { parseAs: "string" },
        (_request, body, done) => done(null, unpack(Buffer.from(body, "base64"))),
    )
    registerCnMsgpackOnSend(app)
    await app.register(questUnlockRoutes, { prefix: "/api/index.php/quest" })
    await app.ready()
    t.after(() => app.close())
    return app
}

test.before(async () => {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `quest-recent-party-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    viewerId = 730000000 + playerId
    await insertSessionWithToken({
        token: String(viewerId),
        accountId: account.id,
        expires: new Date("2099-12-31T23:59:59.000Z"),
        type: SessionType.VIEWER,
    })
})

test.after(() => {
    data.closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test("quest get_recent_other_player_party returns a legal empty party projection", async t => {
    const app = await buildQuestApp(t)
    const response = await postQuest(app, "/api/index.php/quest/get_recent_other_player_party", {
        viewer_id: viewerId,
        category: 1,
        quest_id: 1000001,
    })
    assert.equal(response.statusCode, 200, response.body)

    const decoded = decode(response)
    assert.equal(decoded.data_headers.result_code, 1)
    assert.equal(decoded.data_headers.viewer_id, viewerId)
    assert.ok(Array.isArray(decoded.data.recent_other_player_party))
    assert.equal(decoded.data.recent_other_player_party.length, 0)
})

test("quest get_recent_other_player_party rejects an unknown viewer", async t => {
    const app = await buildQuestApp(t)
    const response = await postQuest(app, "/api/index.php/quest/get_recent_other_player_party", {
        viewer_id: 999999999,
        category: 1,
        quest_id: 1000001,
    })
    assert.equal(response.statusCode, 400)
})

test("quest get_recent_other_player_party rejects a malformed body", async t => {
    const app = await buildQuestApp(t)
    const response = await postQuest(app, "/api/index.php/quest/get_recent_other_player_party", {
        category: 1,
    })
    assert.equal(response.statusCode, 400)
})
