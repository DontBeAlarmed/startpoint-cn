"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")
const path = require("node:path")

require("ts-node/register/transpile-only")

const { loadServerReleaseContract } = require("../tools/server-bundle/release-contract.cjs")
const releaseContract = loadServerReleaseContract(path.resolve(__dirname, ".."))

const Fastify = require("fastify")
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
const {
    createRuntimeHealthSnapshot,
    registerRuntimeHealthRoute,
} = require("../src/runtime/health")
const { unavailableMultiRuntimeStatus } = require("../src/multi/runtime/status")

function state(overrides = {}) {
    return {
        phase: "ready",
        bundleVersion: "1.0.1",
        bundleId: `sha256:${"b".repeat(64)}`,
        nodeVersion: "v20.12.0",
        database: { ready: true, schema: 4 },
        contentInitialized: true,
        httpListening: true,
        multi: {
            mode: "embedded",
            state: "ready",
            coordinator: { kind: "local", available: true },
            hub: null,
            tcp: { available: true, endpoint: "127.0.0.1:8003" },
        },
        adminAvailable: true,
        assetMode: "local",
        ...overrides,
    }
}

test("ready health preserves v1 fields and adds embedded multiplayer details", () => {
    const result = createRuntimeHealthSnapshot(state())

    assert.equal(result.statusCode, 200)
    assert.deepEqual(result.body, {
        contractVersion: 1,
        status: "ready",
        serverBundle: { version: "1.0.1", bundleId: `sha256:${"b".repeat(64)}` },
        runtime: { api: 1, node: "v20.12.0" },
        database: { ready: true, schema: 4 },
        services: { http: true, tcp: true },
        admin: { required: true, available: true },
        assets: {
            mode: "local",
            status: "ready",
            minClientVersion: releaseContract.bundledCdnCatalogVersion,
            observedClientVersion: null,
        },
        multiplayer: {
            mode: "embedded",
            state: "ready",
            coordinator: { kind: "local", available: true },
            hub: null,
            tcp: { available: true, endpoint: "127.0.0.1:8003" },
        },
    })
    assert.doesNotMatch(JSON.stringify(result.body), /DATA_DIR|"token"|"player"|\/Users\//i)
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
    { adminAvailable: false },
]) {
    test(`ready phase still requires ${Object.keys(overrides)[0]}`, () => {
        const result = createRuntimeHealthSnapshot(state(overrides))
        assert.equal(result.statusCode, 503)
        assert.equal(result.body.status, "failed")
    })
}

test("degraded multiplayer keeps core health ready and maps TCP compatibility", () => {
    const multiplayer = {
        mode: "client",
        state: "degraded",
        coordinator: { kind: "remote", available: false },
        hub: { available: false, endpoint: "http://192.0.2.20:8004/" },
        tcp: { available: false, endpoint: null },
    }
    const result = createRuntimeHealthSnapshot(state({ multi: multiplayer }))

    assert.equal(result.statusCode, 200)
    assert.equal(result.body.status, "ready")
    assert.equal(result.body.services.tcp, false)
    assert.deepEqual(result.body.multiplayer, multiplayer)
})

test("client-owned unknown assets do not block readiness", () => {
    const result = createRuntimeHealthSnapshot(state({
        assetMode: "client-owned",
    }))

    assert.equal(result.statusCode, 200)
    assert.equal(result.body.status, "ready")
    assert.deepEqual(result.body.admin, { required: true, available: true })
    assert.deepEqual(result.body.assets, {
        mode: "client-owned",
        status: "unknown",
        minClientVersion: releaseContract.bundledCdnCatalogVersion,
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

test("runtime-not-started multiplayer status keeps the diagnostic endpoint shape stable", () => {
    assert.deepEqual(unavailableMultiRuntimeStatus("client"), {
        mode: "client",
        state: "unavailable",
        coordinator: { kind: "remote", available: false },
        hub: { available: false, endpoint: null },
        tcp: { available: false, endpoint: null },
    })
})
