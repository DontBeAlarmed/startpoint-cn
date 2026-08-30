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
const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "news-routes-"))
process.env.DATA_DIR = databaseDirectory

const data = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const newsRoutes = require("../src/routes/api/news").default
const newsCatalog = require("../src/lib/news-catalog")
const cnLoadRoutes = require("../src/routes/cn/load").default
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
const { createNewsSync } = require("../src/data/domains/news")
const gameTime = require("../src/runtime/time/game-time")
const { getTimeOffset, setServerTimeOffset } = require("../src/utils")
const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")

const restoreContentSnapshot = installBundledGameplaySnapshot()
data.initializeDatabase()

const initialNowMs = Date.parse("2026-08-30T08:00:00.000Z")
const publishedAt = "2026-08-30T08:00:00.000Z"
let viewerId
let playerId
let lowerId
let higherId

function draft(title, overrides = {}) {
    return {
        category: 1,
        title,
        publishedAtReal: publishedAt,
        bodyRichText: `<p>${title}</p>`,
        label: 4,
        thumbnail: 7,
        enabled: true,
        ...overrides,
    }
}

function decode(response) {
    return unpack(Buffer.from(response.body, "base64"))
}

async function postNews(targetApp, url, payload) {
    return targetApp.inject({ method: "POST", url, payload })
}

async function buildLoadApp(t) {
    const targetApp = Fastify({ logger: false })
    targetApp.addContentTypeParser(
        "application/x-www-form-urlencoded",
        { parseAs: "string" },
        (_request, body, done) => done(null, unpack(Buffer.from(body, "base64"))),
    )
    registerCnMsgpackOnSend(targetApp)
    await targetApp.register(cnLoadRoutes, {
        assetProvider: { mode: "client-owned" },
        dailyResetHour: 5,
        multiMode: "embedded",
    })
    await targetApp.ready()
    t.after(() => targetApp.close())
    return targetApp
}

test.before(async () => {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `news-routes-${randomUUID()}`,
        status: "normal",
    })
    playerId = insertDefaultPlayerSync(account.id).id
    viewerId = 730000000 + playerId
    await insertSessionWithToken({
        token: String(viewerId),
        accountId: account.id,
        expires: new Date("2099-12-31T23:59:59.000Z"),
        type: SessionType.VIEWER,
    })

    const oldSameSecond = createNewsSync(draft("lower same second"))
    const newSameSecond = createNewsSync(draft("higher same second"))
    lowerId = oldSameSecond.id
    higherId = newSameSecond.id
    createNewsSync(draft("future", {
        publishedAtReal: "2026-08-30T08:00:01.000Z",
    }))
    createNewsSync(draft("disabled", { enabled: false }))
    createNewsSync(draft("campaign", { category: 2 }))
    createNewsSync(draft("update", { category: 3 }))
})

test.after(() => {
    data.closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test("news index filters by category and projects SQLite rows for the client", async t => {
    const previousOffset = getTimeOffset()
    let realNow = initialNowMs
    t.mock.method(gameTime, "getRealNow", () => new Date(realNow))
    const app = Fastify({ logger: false })
    registerCnMsgpackOnSend(app)
    await app.register(newsRoutes)
    await app.ready()
    t.after(() => app.close())

    const index = decode(await postNews(app, "/index", {
        viewer_id: viewerId,
        category: 1,
        page_index: 1,
    }))
    assert.deepEqual(index.data.news.map(row => row.id), [higherId, lowerId])
    assert.equal(index.data.news_count, 2)
    assert.equal(index.data.current_page, 1)
    assert.deepEqual(index.data.news[0], {
        id: higherId,
        title: "higher same second",
        date: "2026-08-30 16:00:00",
        html: "<p>higher same second</p>",
        label: 4,
        thumbnail: 7,
        thumbnail_path: null,
        added_time: null,
    })

    for (const virtualNow of [
        Date.parse("2020-01-01T00:00:00.000Z"),
        Date.parse("2027-12-31T23:59:59.000Z"),
    ]) {
        setServerTimeOffset(virtualNow - Date.now())
        const moved = decode(await postNews(app, "/index", {
            viewer_id: viewerId,
            category: 1,
            page_index: 1,
        }))
        assert.deepEqual(moved.data.news.map(row => row.id), [higherId, lowerId])
        assert.equal(moved.data.news_count, 2)
    }

    const campaign = decode(await postNews(app, "/index", {
        viewer_id: viewerId,
        category: 2,
        page_index: 1,
    }))
    assert.equal(campaign.data.news_count, 1)
    assert.equal(campaign.data.news[0].title, "campaign")

    const update = decode(await postNews(app, "/index", {
        viewer_id: viewerId,
        category: 3,
        page_index: 1,
    }))
    assert.equal(update.data.news_count, 1)
    assert.equal(update.data.news[0].title, "update")

    realNow += 1000
    const arrived = decode(await postNews(app, "/index", {
        viewer_id: viewerId,
        category: 1,
        page_index: 1,
    }))
    assert.equal(arrived.data.news_count, 3)
    assert.equal(arrived.data.news[0].title, "future")

    setServerTimeOffset(previousOffset)
})

test("news detail returns only enabled announcements visible at real now", async t => {
    const futureId = getDb().prepare(
        "SELECT id FROM server_news WHERE title = 'future'",
    ).get().id
    let realNow = initialNowMs
    const app = Fastify({ logger: false })
    registerCnMsgpackOnSend(app)
    await app.register(newsRoutes)
    await app.ready()
    t.after(() => app.close())
    t.mock.method(gameTime, "getRealNow", () => new Date(realNow))

    const before = await postNews(app, "/get_info", {
        viewer_id: viewerId,
        news_id: futureId,
    })
    assert.equal(before.statusCode, 400)

    realNow += 1000
    const arrivedResponse = await postNews(app, "/get_info", {
        viewer_id: viewerId,
        news_id: futureId,
    })
    assert.equal(arrivedResponse.statusCode, 200, arrivedResponse.body)
    const after = decode(arrivedResponse)
    assert.equal(after.data.id, futureId)
    assert.equal(after.data.date, "2026-08-30 16:00:01")
})

test("news index rejects invalid category and page values", async t => {
    const app = Fastify({ logger: false })
    registerCnMsgpackOnSend(app)
    await app.register(newsRoutes)
    await app.ready()
    t.after(() => app.close())

    for (const payload of [
        { viewer_id: viewerId, category: 4, page_index: 1 },
        { viewer_id: viewerId, category: "1", page_index: 1 },
        { viewer_id: viewerId, category: 1, page_index: 0 },
        { viewer_id: viewerId, category: 1, page_index: 1.5 },
        { viewer_id: viewerId, category: 1, page_index: "1" },
    ]) {
        const response = await postNews(app, "/index", payload)
        assert.equal(response.statusCode, 400)
    }
})

test("news detail rejects invalid news ids as bad requests", async t => {
    const app = Fastify({ logger: false })
    registerCnMsgpackOnSend(app)
    await app.register(newsRoutes)
    await app.ready()
    t.after(() => app.close())

    for (const newsId of [0, 1.5, "1"]) {
        const response = await postNews(app, "/get_info", {
            viewer_id: viewerId,
            news_id: newsId,
        })
        assert.equal(response.statusCode, 400, `news_id ${String(newsId)}: ${response.body}`)
    }
})

test("news index keeps storage failures internal and rejects empty bodies", async t => {
    t.mock.method(newsCatalog, "listVisibleNewsForClient", () => {
        throw new Error("storage failed")
    })
    const app = Fastify({ logger: false })
    registerCnMsgpackOnSend(app)
    await app.register(newsRoutes)
    await app.ready()
    t.after(() => app.close())

    const storageFailure = await postNews(app, "/index", {
        viewer_id: viewerId,
        category: 1,
        page_index: 1,
    })
    assert.equal(storageFailure.statusCode, 500, storageFailure.body)

    const emptyBody = await postNews(app, "/index", {})
    assert.equal(emptyBody.statusCode, 400)
})

test("system and forced news endpoints retain empty response shapes", async t => {
    const app = Fastify({ logger: false })
    registerCnMsgpackOnSend(app)
    await app.register(newsRoutes)
    await app.ready()
    t.after(() => app.close())

    const systemIndex = decode(await postNews(app, "/system_index", { viewer_id: viewerId }))
    assert.deepEqual(systemIndex.data, { current_page: 1, news: [], news_count: 0 })
    const systemInfo = decode(await postNews(app, "/get_system_info", { viewer_id: viewerId }))
    assert.deepEqual(systemInfo.data, {})
    const forced = decode(await postNews(app, "/latest_forced", { viewer_id: viewerId }))
    assert.deepEqual(forced.data, {})
    const forcedSystem = decode(await postNews(app, "/latest_forced_system", { viewer_id: viewerId }))
    assert.deepEqual(forcedSystem.data, {})
})

test("load does not set the forced-news header", async t => {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `news-load-${randomUUID()}`,
        status: "normal",
    })
    const loadPlayerId = insertDefaultPlayerSync(account.id).id
    const loadViewerId = 730000000 + loadPlayerId
    await insertSessionWithToken({
        token: String(loadViewerId),
        accountId: account.id,
        expires: new Date("2099-12-31T23:59:59.000Z"),
        type: SessionType.VIEWER,
    })
    const previousOffset = getTimeOffset()
    setServerTimeOffset(Date.parse("2027-01-01T00:00:01.000Z") - Date.now())
    t.after(() => setServerTimeOffset(previousOffset))
    const app = await buildLoadApp(t)
    const response = await app.inject({
        method: "POST",
        url: "/load",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: pack({
            viewer_id: loadViewerId,
            keychain: viewerId,
            device_id: 1,
            device_token: "news-routes-device",
        }).toString("base64"),
    })

    assert.equal(response.statusCode, 200, response.body)
    assert.equal(Object.hasOwn(decode(response).data_headers, "force_news"), false)
})
