"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const Fastify = require("fastify")
const comicRoutes = require("../src/routes/api/comic").default

test("comic image route reads only the configured external directory", async t => {
    const comicDir = fs.mkdtempSync(path.join(os.tmpdir(), "comic-route-"))
    t.after(() => fs.rmSync(comicDir, { recursive: true, force: true }))
    const kindDir = path.join(comicDir, "0")
    fs.mkdirSync(path.join(kindDir, "main"), { recursive: true })
    fs.writeFileSync(path.join(kindDir, "第1话 Test.jpg"), "listing")
    fs.writeFileSync(path.join(kindDir, "main", "第1话 Test.jpg"), "image-bytes")

    const app = Fastify()
    t.after(() => app.close())
    await app.register(comicRoutes, { comicDir })

    const response = await app.inject({ method: "GET", url: "/image?kind=0&episode=1" })
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers["content-type"], "image/jpeg")
    assert.equal(response.body, "image-bytes")
})

test("comic image route returns 404 when external comics are disabled", async t => {
    const app = Fastify()
    t.after(() => app.close())
    await app.register(comicRoutes, { comicDir: null })

    const response = await app.inject({ method: "GET", url: "/image?kind=0&episode=1" })
    assert.equal(response.statusCode, 404)
})
