"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const Fastify = require("fastify")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "admin-news-"))
process.env.DATA_DIR = databaseDirectory

require("ts-node/register/transpile-only")

const data = require("../src/data")
const newsDomain = require("../src/data/domains/news")

let newsRoutes
try {
    newsRoutes = require("../src/routes/web_api/news").default
} catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error
}

let app

const draft = {
    category: 1,
    title: "更新公告",
    publishedAtReal: "2026-08-30T08:00:00.000Z",
    bodyRichText: "<h2>更新内容</h2><p>内容</p>",
    label: 4,
    thumbnail: 3,
    enabled: false,
}

function json(response) {
    return JSON.parse(response.payload)
}

async function inject(method, url, payload) {
    return app.inject({ method, url, payload })
}

test.before(async () => {
    assert.equal(typeof newsRoutes, "function", "admin news plugin should exist")
    data.initializeDatabase()
    app = Fastify({ logger: false })
    app.register(newsRoutes, { prefix: "/api/news" })
    await app.ready()
})

test.after(async () => {
    await app?.close()
    data.closeDatabase()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
})

test("admin news routes support ordinary announcement CRUD with exact revisions", async () => {
    const createdResponse = await inject("POST", "/api/news", draft)
    assert.equal(createdResponse.statusCode, 201, createdResponse.payload)
    const created = json(createdResponse)
    assert.deepEqual(created, {
        id: created.id,
        ...draft,
        revision: 1,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
    })
    assert.match(created.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)

    const secondResponse = await inject("POST", "/api/news", {
        ...draft,
        title: "第二篇",
        enabled: true,
    })
    const second = json(secondResponse)
    assert.equal(secondResponse.statusCode, 201)

    const listed = json(await inject("GET", "/api/news?page=1&pageSize=20"))
    assert.deepEqual(listed, {
        rows: [second, created],
        totalCount: 2,
        page: 1,
        pageSize: 20,
    })

    const detail = json(await inject("GET", `/api/news/${created.id}`))
    assert.deepEqual(detail, created)

    const editedResponse = await inject("PATCH", `/api/news/${created.id}`, {
        ...draft,
        title: "已编辑公告",
        revision: 1,
    })
    assert.equal(editedResponse.statusCode, 200, editedResponse.payload)
    const edited = json(editedResponse)
    assert.equal(edited.title, "已编辑公告")
    assert.equal(edited.revision, 2)

    const enabledResponse = await inject("PATCH", `/api/news/${created.id}/enabled`, {
        enabled: true,
        revision: 2,
    })
    assert.equal(enabledResponse.statusCode, 200, enabledResponse.payload)
    const enabled = json(enabledResponse)
    assert.equal(enabled.enabled, true)
    assert.equal(enabled.revision, 3)

    const removed = await inject("DELETE", `/api/news/${second.id}?revision=1`)
    assert.equal(removed.statusCode, 200, removed.payload)
    assert.deepEqual(json(removed), { ok: true })
    const afterDelete = json(await inject("GET", "/api/news?page=1&pageSize=20"))
    assert.equal(afterDelete.totalCount, 1)
})

test("admin news routes reject invalid requests and unknown announcements", async () => {
    const invalid = await inject("POST", "/api/news", { ...draft, label: 9 })
    assert.equal(invalid.statusCode, 400)
    assert.deepEqual(json(invalid), { error: "公告内容无效" })

    assert.equal((await inject("GET", "/api/news/999999")).statusCode, 404)
    assert.deepEqual(
        json(await inject("GET", "/api/news/999999")),
        { error: "公告不存在" },
    )

    const missingRevision = await inject("PATCH", "/api/news/999999", {
        ...draft,
        revision: 1,
    })
    assert.equal(missingRevision.statusCode, 404)
})

test("admin news updates reject stale exact revisions", async () => {
    const created = json(await inject("POST", "/api/news", draft))
    const stale = await inject("PATCH", `/api/news/${created.id}`, {
        ...draft,
        revision: 999,
    })
    assert.equal(stale.statusCode, 409)
    assert.deepEqual(json(stale), { error: "公告已被其他操作修改，请刷新" })

    const staleEnabled = await inject("PATCH", `/api/news/${created.id}/enabled`, {
        enabled: true,
        revision: 999,
    })
    assert.equal(staleEnabled.statusCode, 409)

    const staleDelete = await inject("DELETE", `/api/news/${created.id}?revision=999`)
    assert.equal(staleDelete.statusCode, 409)
})

test("admin news list bounds page size to one hundred", async () => {
    const maximum = await inject("GET", "/api/news?page=1&pageSize=100")
    assert.equal(maximum.statusCode, 200, maximum.payload)
    assert.equal(json(maximum).pageSize, 100)

    const excessive = await inject("GET", "/api/news?page=1&pageSize=101")
    assert.equal(excessive.statusCode, 400, excessive.payload)
    assert.deepEqual(json(excessive), { error: "公告内容无效" })
})

test("admin news routes return a limited 503 when the database is not ready", async t => {
    data.closeDatabase()
    t.after(() => data.initializeDatabase())

    for (const request of [
        { method: "GET", url: "/api/news?page=1&pageSize=20" },
        { method: "GET", url: "/api/news/1" },
        { method: "POST", url: "/api/news", payload: draft },
        { method: "PATCH", url: "/api/news/1", payload: { ...draft, revision: 1 } },
        {
            method: "PATCH",
            url: "/api/news/1/enabled",
            payload: { enabled: true, revision: 1 },
        },
        { method: "DELETE", url: "/api/news/1?revision=1" },
    ]) {
        const response = await inject(request.method, request.url, request.payload)
        assert.equal(response.statusCode, 503, `${request.method} ${request.url}`)
        assert.deepEqual(json(response), { error: "数据库尚未就绪" })
    }
})

test("admin news route hides unexpected storage failures", async t => {
    const created = json(await inject("POST", "/api/news", draft))
    t.mock.method(newsDomain, "getAdminNewsSync", () => {
        throw new Error("secret SQL failure")
    })

    const response = await inject("GET", `/api/news/${created.id}`)
    assert.equal(response.statusCode, 500)
    assert.deepEqual(json(response), { error: "公告操作失败" })
})
