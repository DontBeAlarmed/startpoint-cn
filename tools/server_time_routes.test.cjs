"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const Fastify = require("fastify")

const { getTimeOffset, setServerTimeOffset } = require("../src/utils")
const { ServerTimeService } = require("../src/runtime/server-time/service")
const { ServerTimeStore } = require("../src/runtime/server-time/store")
const serverRoutes = require("../src/routes/web_api/server").default

const NOW_MS = Date.parse("2026-08-06T03:00:00.000Z")
const ORIGINAL_TIME_OFFSET = getTimeOffset()

function createFixture() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-time-route-"))
    const legacyFilePath = path.join(dataDir, "state", "active_account.json")
    const serverTimeFilePath = path.join(dataDir, "server-time.json")
    fs.mkdirSync(path.dirname(legacyFilePath), { recursive: true })
    fs.writeFileSync(legacyFilePath, JSON.stringify({
        activePlayerId: 77,
        timeOffset: 123,
        lastSetTime: "unchanged",
        defaultPlayers: { 1: 77 },
    }))
    const store = new ServerTimeStore({
        filePath: serverTimeFilePath,
        legacyFilePath,
        now: () => NOW_MS,
    })
    return {
        dataDir,
        legacyFilePath,
        serverTimeFilePath,
        store,
        service: new ServerTimeService({ store, now: () => NOW_MS }),
    }
}

async function createApp(fixture, t, options = {}) {
    const app = Fastify({ logger: false, ...options })
    app.register(serverRoutes, {
        prefix: "/api/server",
        serverTimeService: fixture.service,
    })
    await app.ready()
    t.after(() => {
        void app.close()
        fs.rmSync(fixture.dataDir, { recursive: true, force: true })
    })
    return app
}

test.after(() => setServerTimeOffset(ORIGINAL_TIME_OFFSET))

test("time-package GET exposes only the three HTTP package fields", async t => {
    const fixture = createFixture()
    fixture.service.setAbsoluteTime(Date.parse("2025-01-02T03:04:05.000Z"), { nowMs: NOW_MS })
    const app = await createApp(fixture, t)

    const response = await app.inject({ method: "GET", url: "/api/server/time-package" })

    assert.equal(response.statusCode, 200)
    assert.deepEqual(Object.keys(response.json()).sort(), ["generatedAt", "mode", "offsetMs"])
})

test("time-package PUT imports valid packages and returns current server time", async t => {
    const fixture = createFixture()
    const app = await createApp(fixture, t)
    const generatedAt = "2026-08-06T03:00:00.000Z"
    const offsetMs = -123456

    const response = await app.inject({
        method: "PUT",
        url: "/api/server/time-package",
        remoteAddress: "127.0.0.1",
        headers: { "content-type": "application/json" },
        payload: { mode: "offset", offsetMs, generatedAt },
    })

    assert.equal(response.statusCode, 200)
    assert.equal(response.json().serverTimeMs, NOW_MS + offsetMs)
    assert.equal(fixture.service.getState({ nowMs: NOW_MS }).offsetMs, offsetMs)
})

test("invalid time-package PUT is rejected without changing the old state", async t => {
    const fixture = createFixture()
    fixture.service.setAbsoluteTime(Date.parse("2025-01-02T03:04:05.000Z"), { nowMs: NOW_MS })
    const previousOffset = getTimeOffset()
    const previousFile = fs.readFileSync(fixture.serverTimeFilePath, "utf8")
    const app = await createApp(fixture, t)

    const response = await app.inject({
        method: "PUT",
        url: "/api/server/time-package",
        remoteAddress: "127.0.0.1",
        headers: { "content-type": "application/json" },
        payload: {
            mode: "offset",
            offsetMs: 1,
            generatedAt: "2026-08-06T03:00:00.000Z",
            extra: true,
        },
    })

    assert.equal(response.statusCode, 400)
    assert.match(response.json().message, /INVALID_SERVER_TIME_STATE|invalid/i)
    assert.equal(getTimeOffset(), previousOffset)
    assert.equal(fs.readFileSync(fixture.serverTimeFilePath, "utf8"), previousFile)
})

test("legacy time routes use ServerTimeService and do not touch active_account.json", async t => {
    const fixture = createFixture()
    fixture.service.restore({ nowMs: NOW_MS })
    const before = fs.readFileSync(fixture.legacyFilePath, "utf8")
    const app = await createApp(fixture, t)

    const current = await app.inject({ method: "GET", url: "/api/server/currentTime" })
    assert.equal(current.statusCode, 200)
    assert.deepEqual(Object.keys(current.json()).sort(), ["date", "isCustom", "servertime"])

    const set = await app.inject({
        method: "GET",
        url: "/api/server/time?time=2025-01-02T03:04:05Z",
        remoteAddress: "127.0.0.1",
    })
    assert.equal(set.statusCode, 200)
    assert.deepEqual(Object.keys(set.json()).sort(), ["date", "isCustom", "servertime"])

    const reset = await app.inject({
        method: "GET",
        url: "/api/server/resetTime",
        remoteAddress: "127.0.0.1",
    })
    assert.equal(reset.statusCode, 200)
    assert.deepEqual(Object.keys(reset.json()).sort(), ["date", "isCustom", "servertime"])
    assert.equal(reset.json().isCustom, false)
    assert.equal(fs.readFileSync(fixture.legacyFilePath, "utf8"), before)
})

test("time-package writes require a loopback request", async t => {
    const fixture = createFixture()
    const app = await createApp(fixture, t)

    const response = await app.inject({
        method: "PUT",
        url: "/api/server/time-package",
        remoteAddress: "192.0.2.10",
        headers: { "content-type": "application/json" },
        payload: {
            mode: "system",
            offsetMs: 0,
            generatedAt: "2026-08-06T03:00:00.000Z",
        },
    })

    assert.equal(response.statusCode, 403)
    assert.equal(response.json().code, "LOCAL_MANAGEMENT_ONLY")
    assert.match(response.json().message, /loopback/i)
})

test("time-package writes accept loopback variants and ignore forwarded client addresses", async t => {
    const fixture = createFixture()
    const app = await createApp(fixture, t, { trustProxy: true })
    const packagePayload = {
        mode: "system",
        offsetMs: 0,
        generatedAt: "2026-08-06T03:00:00.000Z",
    }

    for (const remoteAddress of [
        "127.0.0.1",
        "127.0.0.2",
        "::ffff:127.0.0.2",
        "::1",
        "0:0:0:0:0:0:0:1",
    ]) {
        const response = await app.inject({
            method: "PUT",
            url: "/api/server/time-package",
            remoteAddress,
            headers: { "content-type": "application/json" },
            payload: packagePayload,
        })
        assert.equal(response.statusCode, 200, remoteAddress)
    }

    const forwardedRemote = await app.inject({
        method: "PUT",
        url: "/api/server/time-package",
        remoteAddress: "192.0.2.10",
        headers: {
            "content-type": "application/json",
            "x-forwarded-for": "127.0.0.1",
        },
        payload: packagePayload,
    })
    assert.equal(forwardedRemote.statusCode, 403)
    assert.equal(forwardedRemote.json().code, "LOCAL_MANAGEMENT_ONLY")
    assert.match(forwardedRemote.json().message, /loopback/i)
})
