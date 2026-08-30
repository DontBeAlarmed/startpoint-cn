"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")
const Fastify = require("fastify")

require("ts-node/register/transpile-only")

const serverRoutes = require("../src/routes/web_api/server").default
const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
const { productionContentSnapshotProvider } = require("../src/content/runtime/content-snapshot")
productionContentSnapshotProvider.snapshot = {
    ...productionContentSnapshotProvider.snapshot,
    cdn: {
        ...productionContentSnapshotProvider.snapshot.cdn,
        fullBaseVersion: "1.4.0",
        edges: [],
    },
    archiveSources: { schemaVersion: 1, archives: [] },
}

test.after(() => restoreContentSnapshot())

test("server status uses startup runtime config instead of request-time environment", async t => {
    const previous = {
        ASSET_MODE: process.env.ASSET_MODE,
        CN_LISTEN_HOST: process.env.CN_LISTEN_HOST,
        CN_LISTEN_PORT: process.env.CN_LISTEN_PORT,
        CDN_DIR: process.env.CDN_DIR,
    }
    t.after(() => {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
    })

    const app = Fastify()
    t.after(() => app.close())
    await app.register(serverRoutes, {
        runtimeConfig: {
            http: { host: "0.0.0.0", port: 9101 },
            httpDisplayHost: "configured.example",
            assetProvider: {
                mode: "local",
                baseUrl: "http://configured.example:9101/patch/cn",
                cdnRoot: "/runtime/cdn/cn",
                patchUploadRoot: "/runtime/data/upload",
            },
        },
    })

    process.env.ASSET_MODE = "invalid"
    process.env.CN_LISTEN_HOST = "127.0.0.1"
    process.env.CN_LISTEN_PORT = "8001"
    process.env.CDN_DIR = "/wrong/request-time/path"

    const response = await app.inject({ method: "GET", url: "/status" })
    assert.equal(response.statusCode, 200, response.body)
    const body = response.json()
    assert.equal(body.server.listenHost, "0.0.0.0")
    assert.equal(body.server.listenPort, "9101")
    assert.equal(body.cdn.baseUrl, "http://configured.example:9101/patch/cn")
    assert.equal(body.cdn.configuredDir, "/runtime/cdn")
})

test("server status falls back to the release HTTP default without runtime config", async t => {
    const app = Fastify()
    t.after(() => app.close())
    await app.register(serverRoutes)

    const response = await app.inject({ method: "GET", url: "/status" })
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.json().server.listenPort, "8001")
})
