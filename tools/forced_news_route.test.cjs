"use strict"

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const Fastify = require("fastify")
const { unpack } = require("msgpackr")

require("ts-node/register/transpile-only")

const previousDataDirectory = process.env.DATA_DIR
const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "forced-news-route-"))
process.env.DATA_DIR = databaseDirectory

const data = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const { createNewsSync } = require("../src/data/domains/news")
const newsRoutes = require("../src/routes/api/news").default
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")

data.initializeDatabase()
const publishedAt = new Date(Date.now() - 60_000).toISOString()

test("forced news stays empty without reading SQLite announcements or claiming delivery", async t => {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `forced-news-route-${randomUUID()}`,
        status: "normal",
    })
    const player = insertDefaultPlayerSync(account.id)
    const viewerId = 730000000 + player.id
    await insertSessionWithToken({
        token: String(viewerId),
        accountId: account.id,
        expires: new Date("2099-12-31T23:59:59.000Z"),
        type: SessionType.VIEWER,
    })
    createNewsSync({
        category: 1,
        title: "ordinary announcement",
        publishedAtReal: publishedAt,
        bodyRichText: "<p>ordinary announcement</p>",
        label: 4,
        thumbnail: 7,
        enabled: true,
    })

    const app = Fastify({ logger: false })
    registerCnMsgpackOnSend(app)
    await app.register(newsRoutes)
    await app.ready()
    t.after(() => app.close())

    async function latestForced() {
        const response = await app.inject({
            method: "POST",
            url: "/latest_forced",
            payload: { viewer_id: viewerId },
        })
        assert.equal(response.statusCode, 200)
        return unpack(Buffer.from(response.body, "base64"))
    }

    assert.deepEqual((await latestForced()).data, {})
    assert.deepEqual((await latestForced()).data, {})
    assert.equal(
        getDb().prepare(`
            SELECT COUNT(*) AS count
            FROM players_options
            WHERE key GLOB 'server.forced_news.*'
        `).get().count,
        0,
    )
})

test.after(() => {
    data.closeDatabase()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})
