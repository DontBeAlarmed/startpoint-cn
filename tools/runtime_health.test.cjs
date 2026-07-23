"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const Fastify = require("fastify")
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
const {
    createRuntimeHealthSnapshot,
    registerRuntimeHealthRoute,
} = require("../src/runtime/health")

function state(overrides = {}) {
    return {
        phase: "ready",
        bundleVersion: "1.0.1",
        bundleId: `sha256:${"b".repeat(64)}`,
        nodeVersion: "v20.12.0",
        database: { ready: true, schema: 4 },
        contentInitialized: true,
        httpListening: true,
        tcpListening: true,
        adminAvailable: true,
        assetMode: "local",
        ...overrides,
    }
}

test("ready health exposes only the embedded contract fields", () => {
    const result = createRuntimeHealthSnapshot(state())

    assert.equal(result.statusCode, 200)
    assert.deepEqual(result.body, {
        contractVersion: 1,
        status: "ready",
        serverBundle: { version: "1.0.1", bundleId: `sha256:${"b".repeat(64)}` },
        runtime: { api: 1, node: "v20.12.0" },
        database: { ready: true, schema: 4 },
        services: { http: true, tcp: true },
        admin: { available: true },
        assets: {
            mode: "local",
            status: "ready",
            minClientVersion: "1.4.54",
            observedClientVersion: null,
        },
    })
    assert.doesNotMatch(JSON.stringify(result.body), /DATA_DIR|token|player|\/Users\//i)
})

for (const phase of ["starting", "stopping", "failed", "stopped"]) {
    test(`${phase} health is unavailable even when dependencies report ready`, () => {
        const result = createRuntimeHealthSnapshot(state({ phase }))
        assert.equal(result.statusCode, 503)
        assert.equal(result.body.status, phase)
    })
}

for (const overrides of [
    { database: { ready: false, schema: null } },
    { contentInitialized: false },
    { httpListening: false },
    { tcpListening: false },
]) {
    test(`ready phase still requires ${Object.keys(overrides)[0]}`, () => {
        const result = createRuntimeHealthSnapshot(state(overrides))
        assert.equal(result.statusCode, 503)
        assert.equal(result.body.status, "failed")
    })
}

test("admin absence and client-owned unknown assets do not block readiness", () => {
    const result = createRuntimeHealthSnapshot(state({
        adminAvailable: false,
        assetMode: "client-owned",
    }))

    assert.equal(result.statusCode, 200)
    assert.equal(result.body.status, "ready")
    assert.deepEqual(result.body.admin, { available: false })
    assert.deepEqual(result.body.assets, {
        mode: "client-owned",
        status: "unknown",
        minClientVersion: "1.4.54",
        observedClientVersion: null,
    })
})

test("health route remains ordinary JSON with the CN MsgPack hook installed", async t => {
    const app = Fastify({ logger: false })
    registerCnMsgpackOnSend(app)
    registerRuntimeHealthRoute(app, () => createRuntimeHealthSnapshot(state()))
    await app.ready()
    t.after(() => app.close())

    const response = await app.inject({ method: "GET", url: "/healthz" })
    assert.equal(response.statusCode, 200)
    assert.match(response.headers["content-type"], /^application\/json/)
    assert.equal(response.json().contractVersion, 1)
})
