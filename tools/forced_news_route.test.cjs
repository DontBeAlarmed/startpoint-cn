require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const Fastify = require("fastify")
const { unpack } = require("msgpackr")

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "forced-news-route-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = dataDirectory

const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { findPendingForcedNews } = require("../src/lib/news-catalog")
const newsRoutes = require("../src/routes/api/news").default
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
const { getTimeOffset, setServerTime, setServerTimeOffset } = require("../src/utils")

function decode(response) {
    return unpack(Buffer.from(response.body, "base64"))
}

async function main() {
    initializeDatabase()
    const database = getDb()
    const originalTimeOffset = getTimeOffset()
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "forced-news-route",
        idpCode: "test",
        idpId: "forced-news-route-player",
        status: "normal",
    })
    const player = insertDefaultPlayerSync(account.id)
    const viewerId = 730000000 + player.id
    database.prepare(`
        INSERT INTO sessions (token, account_id, expires, type)
        VALUES (?, ?, ?, 2)
    `).run(viewerId.toString(), account.id, new Date(Date.now() + 3600_000).toISOString())

    setServerTime(new Date("2026-08-14T10:00:00.000Z"))
    assert.equal(findPendingForcedNews(player.id)?.id, 1)

    const app = Fastify()
    registerCnMsgpackOnSend(app)
    await app.register(newsRoutes)
    await app.ready()

    try {
        const first = decode(await app.inject({
            method: "POST",
            url: "/latest_forced",
            payload: { viewer_id: viewerId },
        }))
        assert.equal(first.data.id, 1)
        assert.equal(first.data.label, 4)
        assert.equal(Object.hasOwn(first.data, "forced"), false)
        assert.equal(findPendingForcedNews(player.id), null)

        const repeated = decode(await app.inject({
            method: "POST",
            url: "/latest_forced",
            payload: { viewer_id: viewerId },
        }))
        assert.deepEqual(repeated.data, {})
    } finally {
        await app.close()
        setServerTimeOffset(originalTimeOffset)
        if (database.open) database.close()
        fs.rmSync(dataDirectory, { recursive: true, force: true })
        if (previousDataDirectory === undefined) delete process.env.DATA_DIR
        else process.env.DATA_DIR = previousDataDirectory
    }
}

main()
    .then(() => console.log("forced news route tests passed"))
    .catch(error => {
        console.error(error)
        process.exitCode = 1
    })
