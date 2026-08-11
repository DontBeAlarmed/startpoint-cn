"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")
const util = require("node:util")

require("ts-node/register/transpile-only")

const Fastify = require("fastify")
const { unpack } = require("msgpackr")
const assetPlugin = require("../src/routes/cn/asset").default
const { CdnPlannerError, planCdnUpdate } = require("../src/content/cdn/planner")

const SHA = "a".repeat(64)

function archive(relativePath, compressedBytes, order = 1, digest = SHA) {
    return { relativePath, compressedBytes, sha256: digest, layer: "common", order }
}

function msgpackInt32Token(tag, value) {
    const token = Buffer.alloc(5)
    token[0] = tag
    token.writeUInt32BE(value, 1)
    return token
}

function assertCnInt32Token(wire, value) {
    assert.equal(wire.indexOf(msgpackInt32Token(0xce, value)), -1)
    assert.notEqual(wire.indexOf(msgpackInt32Token(0xd2, value)), -1)
}

function edge(fromVersion, toVersion, archives) {
    return {
        fromVersion,
        toVersion,
        platform: "android",
        assetSizeKind: "fulfill",
        archives,
    }
}

function createSnapshot(overrides = {}) {
    return Object.freeze({
        cdn: Object.freeze({
            schemaVersion: 1,
            fullBaseVersion: "1.4.0",
            targetVersion: "1.4.54",
            installedBytes: 987_654,
            entityListsRelativePath: "EntityLists/android_medium.csv",
            edges: Object.freeze([
                edge(null, "1.4.0", [archive("archive-common-full/base.zip", 100)]),
                edge("1.4.0", "1.4.53", [archive("archive-common-diff/first.zip", 53)]),
                edge("1.4.53", "1.4.54", [archive("archive-common-diff/latest.zip", 54)]),
            ]),
            ...overrides,
        }),
    })
}

function msgpackHook(fastify) {
    const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
    registerCnMsgpackOnSend(fastify)
}

async function createAssetApp(options = {}) {
    const app = Fastify({ logger: false })
    app.register(assetPlugin, {
        prefix: "/asset",
        getSnapshot: options.getSnapshot ?? (() => options.snapshot ?? createSnapshot()),
        env: options.env ?? {},
        warn: options.warn,
        logError: options.logError,
        resolveListenHost: options.resolveListenHost,
        iosCompat: options.iosCompat,
    })
    await app.ready()
    return app
}

async function postGetPath(app, headers = {}, payload = {}) {
    return app.inject({
        method: "POST",
        url: "/asset/get_path",
        headers,
        payload,
    })
}

function wireArchives(data) {
    return [
        ...(data.full?.archive ?? []),
        ...(data.diff ?? []).flatMap(item => item.archive),
    ].map(item => ({ location: item.location, size: item.size }))
}

test("serializes a plan deterministically without mutating it", () => {
    const { serializeCdnUpdatePlan } = require("../src/content/cdn/protocol")
    const snapshot = createSnapshot()
    const plan = planCdnUpdate(snapshot.cdn, {
        currentVersion: null,
        targetVersion: snapshot.cdn.targetVersion,
        platform: "android",
        assetSizeKind: "fulfill",
        isInitial: true,
    })
    const before = structuredClone(plan)

    const first = serializeCdnUpdatePlan(plan, {
        baseUrl: "https://cdn.example.test/patch/cn/",
        currentVersion: null,
        targetVersion: snapshot.cdn.targetVersion,
    })
    const second = serializeCdnUpdatePlan(plan, {
        baseUrl: "https://cdn.example.test/patch/cn",
        currentVersion: null,
        targetVersion: snapshot.cdn.targetVersion,
    })

    assert.deepEqual(first, second)
    assert.deepEqual(plan, before)
    assert.equal(first.full.version, "1.4.0")
    assert.deepEqual(first.diff.map(item => [item.original_version, item.version]), [
        ["1.4.0", "1.4.53"],
        ["1.4.53", "1.4.54"],
    ])
    assert.equal(first.info.eventual_target_asset_version, "1.4.54")
    assert.equal(first.info.is_initial, true)
    assert.equal(first.full.archive[0].location, "https://cdn.example.test/patch/cn/archive-common-full/base.zip")
    assert.equal(first.full.archive[0].size, 100)
    assert.equal(first.full.archive[0].sha256, SHA)
})

test("serializer rejects unsafe base URLs and archive paths", () => {
    const { serializeCdnUpdatePlan } = require("../src/content/cdn/protocol")
    const snapshot = createSnapshot()
    const plan = planCdnUpdate(snapshot.cdn, {
        currentVersion: null,
        targetVersion: snapshot.cdn.targetVersion,
        platform: "android",
        assetSizeKind: "fulfill",
        isInitial: true,
    })

    for (const baseUrl of [
        "https://cdn.test//patch/cn",
        "https://cdn.test/patch\\cn",
        "https://cdn.test/patch/%2e%2e/private",
        "https:/cdn.test/patch/cn",
        " https://cdn.test/patch/cn",
        "https://cdn.test/patch/cn ",
        "https://user:password@cdn.test/patch/cn",
        "https://cdn.test/patch/cn?token=secret",
        "https://cdn.test/patch/cn#fragment",
        "https://cdn.test/patch/\ncn",
        "https://cdn.test/patch/c n",
        "https://cdn.test/patch/<cn>",
        "http://127.1/patch/cn",
        "http://0.0.0.0/patch/cn",
        "http://[::]/patch/cn",
        "http://[0:0:0:0:0:0:0:0]/patch/cn",
    ]) {
        assert.throws(() => serializeCdnUpdatePlan(plan, {
            baseUrl,
            currentVersion: null,
            targetVersion: snapshot.cdn.targetVersion,
        }))
    }

    for (const relativePath of [
        "../escape.zip",
        "/absolute.zip",
        "https://evil.test/a.zip",
        "dir\\a.zip",
        "dir//a.zip",
        "dir/a%20b.zip",
        "dir/a\0b.zip",
        "dir/a b.zip",
        "dir/中文.zip",
        "dir/a\"b.zip",
        "dir/a<b>.zip",
        "dir/a|b.zip",
        "dir/a:b.zip",
    ]) {
        const unsafePlan = structuredClone(plan)
        unsafePlan.full.archives[0].relativePath = relativePath
        assert.throws(() => serializeCdnUpdatePlan(unsafePlan, {
            baseUrl: "https://cdn.test/patch/cn",
            currentVersion: null,
            targetVersion: snapshot.cdn.targetVersion,
        }))
    }
})

test("get_path emits exact Option.None nulls for an up-to-date client", async t => {
    const app = await createAssetApp()
    t.after(() => app.close())

    const response = await postGetPath(app, { res_ver: "1.4.54" })
    assert.equal(response.statusCode, 200)
    assert.match(response.headers["content-type"], /^application\/json/)
    const body = response.json()
    assert.equal(body.data.full, null)
    assert.equal(body.data.diff, null)
    assert.equal(JSON.stringify(body).includes('"full":null'), true)
    assert.equal(JSON.stringify(body).includes('"diff":null'), true)
})

test("get_path emits only the current-to-target incremental edge", async t => {
    const app = await createAssetApp()
    t.after(() => app.close())

    const response = await postGetPath(app, {
        res_ver: "1.4.53",
        device: "2",
        asset_size: "fulfill",
    })
    assert.equal(response.statusCode, 200)
    const data = response.json().data
    assert.equal(data.full, null)
    assert.deepEqual(data.diff.map(item => [item.original_version, item.version]), [["1.4.53", "1.4.54"]])
    assert.deepEqual(wireArchives(data), [{
        location: "http://127.0.0.1:8001/patch/cn/archive-common-diff/latest.zip",
        size: 54,
    }])
    assert.equal(data.info.is_initial, false)
})

test("get_path emits initial full and the continuous base-to-target chain", async t => {
    const app = await createAssetApp()
    t.after(() => app.close())

    const response = await postGetPath(app)
    assert.equal(response.statusCode, 200)
    const data = response.json().data
    assert.equal(data.full.version, "1.4.0")
    assert.deepEqual(data.diff.map(item => [item.original_version, item.version]), [
        ["1.4.0", "1.4.53"],
        ["1.4.53", "1.4.54"],
    ])
    assert.equal(data.info.is_initial, true)
    assert.equal(data.info.eventual_target_asset_version, "1.4.54")
})

test("all supported asset size headers reuse the fulfill archives", async t => {
    const app = await createAssetApp()
    t.after(() => app.close())
    const results = []

    for (const assetSize of ["fulfill", "shortened", "delayed"]) {
        const response = await postGetPath(app, { res_ver: "1.4.53", asset_size: assetSize })
        assert.equal(response.statusCode, 200)
        const data = response.json().data
        assert.equal(data.delayed_assets_size, 0)
        results.push(wireArchives(data))
    }
    assert.deepEqual(results[1], results[0])
    assert.deepEqual(results[2], results[0])
})

test("ignores a client target mismatch and records a warning", async t => {
    const warnings = []
    const app = await createAssetApp({ warn: details => warnings.push(details) })
    t.after(() => app.close())

    const response = await postGetPath(app, { res_ver: "1.4.53" }, {
        target_asset_version: "9.9.9",
    })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().data.info.eventual_target_asset_version, "1.4.54")
    assert.equal(warnings.length, 1)
    assert.deepEqual(warnings[0].clientTarget, {
        type: "string",
        length: 5,
        value: "9.9.9",
        truncated: false,
    })
    assert.equal(warnings[0].snapshotTargetVersion, "1.4.54")

    const nonString = await postGetPath(app, { res_ver: "1.4.53" }, {
        target_asset_version: 1454,
    })
    assert.equal(nonString.statusCode, 200)
    assert.equal(warnings.length, 2)
    assert.deepEqual(warnings[1].clientTarget, { type: "number" })
})

test("bounds target mismatch logging for large strings and nested values", async t => {
    const secret = "TARGET_MISMATCH_SECRET"
    const warnings = []
    const app = await createAssetApp({ warn: details => warnings.push(details) })
    t.after(() => app.close())

    const largeString = `${secret}:` + "x".repeat(256 * 1024)
    const stringResponse = await postGetPath(app, { res_ver: "1.4.53" }, {
        target_asset_version: largeString,
    })
    assert.equal(stringResponse.statusCode, 200)

    const objectResponse = await postGetPath(app, { res_ver: "1.4.53" }, {
        target_asset_version: {
            nested: { secret, payload: "y".repeat(256 * 1024) },
            list: [secret, secret],
        },
    })
    assert.equal(objectResponse.statusCode, 200)
    assert.equal(warnings.length, 2)
    assert.deepEqual(warnings[0].clientTarget, {
        type: "string",
        length: largeString.length,
        truncated: true,
    })
    assert.deepEqual(warnings[1].clientTarget, { type: "object", keyCount: 2 })
    for (const warning of warnings) {
        const serialized = JSON.stringify(warning)
        assert.equal(serialized.includes(secret), false)
        assert.ok(serialized.length < 256, serialized.length)
    }
})

test("uses only trusted CDN host configuration and formats dynamic IPv6", async t => {
    const app = await createAssetApp({
        env: { CN_PUBLIC_HOST: "cdn.example.test", CN_LISTEN_PORT: "9000" },
    })
    t.after(() => app.close())

    for (const host of ["evil.test", "evil.test/extra"]) {
        const response = await app.inject({
            method: "POST",
            url: "/asset/version_info",
            headers: { host },
            payload: {},
        })
        assert.equal(response.statusCode, 200)
        assert.equal(response.json().data.base_url, "http://cdn.example.test:9000/patch/cn/")
        assert.equal(response.body.includes("evil.test"), false)
    }

    const ipv6App = await createAssetApp({
        env: { CN_LISTEN_HOST: "::", CN_LISTEN_PORT: "8001" },
        resolveListenHost: () => "2001:db8::5",
    })
    t.after(() => ipv6App.close())
    const ipv6 = await ipv6App.inject({ method: "POST", url: "/asset/version_info", payload: {} })
    assert.equal(ipv6.statusCode, 200)
    assert.equal(ipv6.json().data.base_url, "http://[2001:db8::5]:8001/patch/cn/")
})

test("rejects untrusted CDN and host configuration without using request Host", async t => {
    const cases = [
        { CDN_BASE_URL: "" },
        { CDN_BASE_URL: "ftp://cdn.test/patch/cn" },
        { CDN_BASE_URL: "https://user:secret@cdn.test/patch/cn" },
        { CDN_BASE_URL: "https:/cdn.test/patch/cn" },
        { CDN_BASE_URL: "https://cdn.test/patch/../private" },
        { CDN_BASE_URL: "https://cdn.test/patch/\ncn" },
        { CN_PUBLIC_HOST: "trusted.test/extra", CN_LISTEN_PORT: "8001" },
        { CN_PUBLIC_HOST: "", CN_LISTEN_PORT: "8001" },
        { CN_PUBLIC_HOST: "0.0.0.0", CN_LISTEN_PORT: "8001" },
        { CN_PUBLIC_HOST: "::", CN_LISTEN_PORT: "8001" },
        { CN_PUBLIC_HOST: "0:0:0:0:0:0:0:0", CN_LISTEN_PORT: "8001" },
        { CN_PUBLIC_HOST: "[0:0:0:0:0:0:0:0]", CN_LISTEN_PORT: "8001" },
        { CN_PUBLIC_HOST: "12345", CN_LISTEN_PORT: "8001" },
        { CN_PUBLIC_HOST: "127.1", CN_LISTEN_PORT: "8001" },
        { CN_LISTEN_HOST: "", CN_LISTEN_PORT: "8001" },
        { CN_PUBLIC_HOST: "trusted.test", CN_LISTEN_PORT: "8001/extra" },
        { CN_PUBLIC_HOST: "trusted.test", CN_LISTEN_PORT: "" },
    ]

    for (const env of cases) {
        const app = await createAssetApp({ env })
        const response = await app.inject({
            method: "POST",
            url: "/asset/version_info",
            headers: { host: "evil.test" },
            payload: {},
        })
        assert.equal(response.statusCode, 500, JSON.stringify(env))
        assert.equal(response.json().code, "ASSET_SERVICE_ERROR")
        assert.equal(response.body.includes("evil.test"), false)
        await app.close()
    }

    const fallbackApp = await createAssetApp({
        env: { CN_LISTEN_HOST: "::", CN_LISTEN_PORT: "8001" },
        resolveListenHost: () => "0:0:0:0:0:0:0:0",
    })
    const fallbackResponse = await fallbackApp.inject({
        method: "POST",
        url: "/asset/version_info",
        payload: {},
    })
    assert.equal(fallbackResponse.statusCode, 500)
    assert.equal(fallbackResponse.json().code, "ASSET_SERVICE_ERROR")
    await fallbackApp.close()
})

test("CDN host fallback ignores SESSION_PUBLIC_HOST and never advertises a wildcard", async t => {
    const previousSessionHost = process.env.SESSION_PUBLIC_HOST
    process.env.SESSION_PUBLIC_HOST = "session-secret.example.test"
    t.after(() => {
        if (previousSessionHost === undefined) delete process.env.SESSION_PUBLIC_HOST
        else process.env.SESSION_PUBLIC_HOST = previousSessionHost
    })

    const app = await createAssetApp({
        env: { CN_LISTEN_HOST: "0.0.0.0", CN_LISTEN_PORT: "8011" },
        resolveListenHost: () => "198.51.100.7",
    })
    t.after(() => app.close())
    const response = await app.inject({ method: "POST", url: "/asset/version_info", payload: {} })

    assert.equal(response.statusCode, 200)
    assert.equal(response.json().data.base_url, "http://198.51.100.7:8011/patch/cn/")
    assert.equal(response.body.includes("session-secret"), false)
    assert.equal(response.body.includes("0.0.0.0"), false)
})

test("CDN_BASE_URL parser failures redact credentials from responses and logs", async t => {
    const { normalizeCdnBaseUrl } = require("../src/content/cdn/protocol")
    const secret = "TOP_SECRET"
    const configuredUrl = `https://user:${secret}@cdn.test:99999/patch/cn`
    let validationError
    assert.throws(() => normalizeCdnBaseUrl(configuredUrl), error => {
        validationError = error
        return true
    })
    assert.equal(util.inspect(validationError, { depth: 5 }).includes(secret), false)
    assert.equal(validationError.message, "invalid CDN base URL configuration")

    const logged = []
    const app = await createAssetApp({
        env: { CDN_BASE_URL: configuredUrl },
        logError: details => logged.push(details),
    })
    t.after(() => app.close())
    const response = await app.inject({ method: "POST", url: "/asset/version_info", payload: {} })

    assert.equal(response.statusCode, 500)
    assert.deepEqual(response.json(), {
        code: "ASSET_SERVICE_ERROR",
        message: "asset service is unavailable",
    })
    const diagnostics = `${response.body}\n${util.inspect(logged, { depth: 8 })}\n${JSON.stringify(logged)}`
    assert.equal(diagnostics.includes(secret), false)
    assert.equal(logged[0].error.message, "invalid CDN base URL configuration")
    assert.equal("cause" in logged[0].error, false)
})

test("accepts missing or Android DEVICE and rejects explicit other platforms", async t => {
    const app = await createAssetApp()
    t.after(() => app.close())

    assert.equal((await postGetPath(app, { res_ver: "1.4.54" })).statusCode, 200)
    assert.equal((await postGetPath(app, { res_ver: "1.4.54", device: "2" })).statusCode, 200)
    assert.equal((await postGetPath(app, { res_ver: "1.4.54", device: "android" })).statusCode, 200)

    const rejected = await postGetPath(app, { res_ver: "1.4.54", device: "1" })
    assert.equal(rejected.statusCode, 400)
    assert.equal(rejected.json().code, "UNSUPPORTED_PLATFORM")
    assert.equal("data" in rejected.json(), false)
})

test("accepts iOS DEVICE when iosCompat is enabled; unavailable when ios assets are missing", async t => {
    const app = await createAssetApp({
        iosCompat: { enabled: true, apiHost: "10.0.0.5:8001", apiScheme: "http" },
    })
    t.after(() => app.close())

    for (const device of ["1", "ios"]) {
        // 无 iOS 目录/实体表 → 明确不可用（不回落 Android，也不 400）
        const response = await postGetPath(app, { res_ver: "1.4.54", device })
        assert.equal(response.statusCode, 503, `device=${device}`)
        assert.equal(response.json().code, "IOS_ASSETS_UNAVAILABLE", `device=${device}`)
    }
})

test("rejects unsupported asset sizes and planner failures without partial data", async t => {
    const app = await createAssetApp()
    t.after(() => app.close())

    const unsupported = await postGetPath(app, { asset_size: "large" })
    assert.equal(unsupported.statusCode, 400)
    assert.equal(unsupported.json().code, "UNSUPPORTED_ASSET_SIZE_KIND")
    assert.equal("data" in unsupported.json(), false)

    const unknown = await postGetPath(app, { res_ver: "1.3.99" })
    assert.equal(unknown.statusCode, 400)
    assert.equal(unknown.json().code, "UNKNOWN_CURRENT_VERSION")
    assert.equal("data" in unknown.json(), false)

    const brokenSnapshot = createSnapshot({
        edges: Object.freeze([
            edge(null, "1.4.0", [archive("archive-common-full/base.zip", 100)]),
            edge("1.4.53", "1.4.54", [archive("archive-common-diff/latest.zip", 54)]),
        ]),
    })
    const brokenApp = await createAssetApp({ snapshot: brokenSnapshot })
    t.after(() => brokenApp.close())
    const noPath = await postGetPath(brokenApp)
    assert.equal(noPath.statusCode, 500)
    assert.equal(noPath.json().code, "NO_UPDATE_PATH")
    assert.equal("data" in noPath.json(), false)
})

test("redacts and logs INVALID_DOWNLOAD_BYTES planner failures", async t => {
    const privatePath = "archive-private/internal/customer-a.zip"
    const invalidSnapshot = createSnapshot({
        edges: Object.freeze([
            edge(null, "1.4.0", [archive("archive-common-full/base.zip", 100)]),
            edge("1.4.53", "1.4.54", [archive(privatePath, Number.MAX_SAFE_INTEGER + 1)]),
        ]),
    })
    const logged = []
    const app = await createAssetApp({
        snapshot: invalidSnapshot,
        logError: details => logged.push(details),
    })
    t.after(() => app.close())

    const response = await postGetPath(app, { res_ver: "1.4.53" })
    assert.equal(response.statusCode, 500)
    assert.match(response.headers["content-type"], /^application\/json/)
    assert.deepEqual(response.json(), {
        code: "INVALID_DOWNLOAD_BYTES",
        message: "asset update plan is unavailable",
    })
    assert.equal(response.body.includes(privatePath), false)
    assert.equal("data" in response.json(), false)
    assert.equal("full" in response.json(), false)
    assert.equal("diff" in response.json(), false)
    assert.equal(logged.length, 1)
    assert.equal(logged[0].code, "INVALID_DOWNLOAD_BYTES")
    assert.equal(logged[0].error instanceof CdnPlannerError, true)
    assert.match(logged[0].error.message, new RegExp(privatePath))
})

test("redacts and logs INVALID_CATALOG planner failures", async t => {
    const privatePath = "archive-private/internal/customer-b.zip"
    const invalidSnapshot = createSnapshot({
        edges: Object.freeze([
            edge("1.4.53", "1.4.54", [archive(privatePath, 54)]),
        ]),
    })
    const logged = []
    const app = await createAssetApp({
        snapshot: invalidSnapshot,
        logError: details => logged.push(details),
    })
    t.after(() => app.close())

    const response = await postGetPath(app, { res_ver: "1.4.53" })
    assert.equal(response.statusCode, 500)
    assert.match(response.headers["content-type"], /^application\/json/)
    assert.deepEqual(response.json(), {
        code: "INVALID_CATALOG",
        message: "asset update plan is unavailable",
    })
    assert.equal(response.body.includes(privatePath), false)
    assert.equal("data" in response.json(), false)
    assert.equal("full" in response.json(), false)
    assert.equal("diff" in response.json(), false)
    assert.equal(logged.length, 1)
    assert.equal(logged[0].code, "INVALID_CATALOG")
    assert.equal(logged[0].error instanceof CdnPlannerError, true)
})

test("get_path returns stable diagnostics and logs the original snapshot error", async t => {
    const originalError = new Error("snapshot failed at /private/internal/catalog.json")
    const logged = []
    const app = await createAssetApp({
        getSnapshot: () => { throw originalError },
        logError: details => logged.push(details),
    })
    t.after(() => app.close())

    const response = await postGetPath(app)
    assert.equal(response.statusCode, 500)
    assert.match(response.headers["content-type"], /^application\/json/)
    assert.deepEqual(response.json(), {
        code: "CONTENT_SNAPSHOT_UNAVAILABLE",
        message: "content snapshot is unavailable",
    })
    assert.equal(response.body.includes("/private/internal"), false)
    assert.equal("data" in response.json(), false)
    assert.equal("full" in response.json(), false)
    assert.equal("diff" in response.json(), false)
    assert.strictEqual(logged[0].error, originalError)
    assert.equal(logged[0].code, "CONTENT_SNAPSHOT_UNAVAILABLE")
})

test("get_path returns a stable service error without leaking serializer details", async t => {
    const logged = []
    const app = await createAssetApp({
        env: { CDN_BASE_URL: "not a valid CDN URL /private/internal" },
        logError: details => logged.push(details),
    })
    t.after(() => app.close())

    const response = await postGetPath(app, { res_ver: "1.4.53" })
    assert.equal(response.statusCode, 500)
    assert.deepEqual(response.json(), {
        code: "ASSET_SERVICE_ERROR",
        message: "asset service is unavailable",
    })
    assert.equal(response.body.includes("/private/internal"), false)
    assert.equal("data" in response.json(), false)
    assert.equal("full" in response.json(), false)
    assert.equal("diff" in response.json(), false)
    assert.equal(logged[0].code, "ASSET_SERVICE_ERROR")
    assert.equal(logged[0].error instanceof Error, true)
    assert.match(logged[0].error.message, /unsupported|invalid/)
})

test("version_info uses installed bytes and the shared empty Recovery URL", async t => {
    const app = await createAssetApp()
    t.after(() => app.close())

    const response = await app.inject({
        method: "POST",
        url: "/asset/version_info",
        headers: { host: "assets.example.test:8443" },
        payload: { asset_version: "1.4.53" },
    })
    assert.equal(response.statusCode, 200)
    assert.match(response.headers["content-type"], /^application\/json/)
    assert.deepEqual(response.json().data, {
        base_url: "http://127.0.0.1:8001/patch/cn/",
        files_list: "http://127.0.0.1:8001/patch/cn/recovery/empty.csv",
        total_size: 987_654,
        delayed_assets_size: 0,
    })
})

test("title version_info is Base64 MsgPack with the same fields as JSON version_info", async t => {
    const titlePlugin = require("../src/routes/cn/assetInTitle").default
    const snapshot = createSnapshot()
    const app = Fastify({ logger: false })
    msgpackHook(app)
    app.register(assetPlugin, { prefix: "/asset", getSnapshot: () => snapshot, env: {} })
    app.register(titlePlugin, { prefix: "/assetintitle", getSnapshot: () => snapshot, env: {} })
    await app.ready()
    t.after(() => app.close())

    const request = {
        method: "POST",
        headers: { host: "assets.example.test" },
        payload: {},
    }
    const ordinary = await app.inject({ ...request, url: "/asset/version_info" })
    const title = await app.inject({ ...request, url: "/assetintitle/version_info_in_title" })

    assert.match(ordinary.headers["content-type"], /^application\/json/)
    assert.equal(title.headers["content-type"], "application/x-msgpack")
    const wire = Buffer.from(title.body, "base64")
    assertCnInt32Token(wire, 987_654)
    const decoded = unpack(wire)
    assert.deepEqual(decoded.data, ordinary.json().data)
    assert.equal(decoded.data.total_size, 987_654)
    assert.equal(typeof decoded.data_headers, "object")
})

test("ordinary and title version_info return content-consistent snapshot diagnostics", async t => {
    const titlePlugin = require("../src/routes/cn/assetInTitle").default
    const originalError = new Error("snapshot failed at /private/internal/catalog.json")
    const logged = []
    const app = Fastify({ logger: false })
    msgpackHook(app)
    const options = {
        getSnapshot: () => { throw originalError },
        env: {},
        logError: details => logged.push(details),
    }
    app.register(assetPlugin, { prefix: "/asset", ...options })
    app.register(titlePlugin, { prefix: "/assetintitle", ...options })
    await app.ready()
    t.after(() => app.close())

    const ordinary = await app.inject({ method: "POST", url: "/asset/version_info", payload: {} })
    assert.equal(ordinary.statusCode, 500)
    assert.match(ordinary.headers["content-type"], /^application\/json/)
    assert.deepEqual(ordinary.json(), {
        code: "CONTENT_SNAPSHOT_UNAVAILABLE",
        message: "content snapshot is unavailable",
    })

    const title = await app.inject({
        method: "POST",
        url: "/assetintitle/version_info_in_title",
        payload: {},
    })
    assert.equal(title.statusCode, 500)
    assert.equal(title.headers["content-type"], "application/x-msgpack")
    assert.deepEqual(unpack(Buffer.from(title.body, "base64")), {
        code: "CONTENT_SNAPSHOT_UNAVAILABLE",
        message: "content snapshot is unavailable",
    })
    assert.equal(logged.length, 2)
    assert.strictEqual(logged[0].error, originalError)
    assert.strictEqual(logged[1].error, originalError)
})

test("ordinary and title version_info return malformed-base service errors", async t => {
    const titlePlugin = require("../src/routes/cn/assetInTitle").default
    const logged = []
    const app = Fastify({ logger: false })
    msgpackHook(app)
    const options = {
        getSnapshot: () => createSnapshot(),
        env: { CDN_BASE_URL: "not a URL /private/internal" },
        logError: details => logged.push(details),
    }
    app.register(assetPlugin, { prefix: "/asset", ...options })
    app.register(titlePlugin, { prefix: "/assetintitle", ...options })
    await app.ready()
    t.after(() => app.close())

    const ordinary = await app.inject({ method: "POST", url: "/asset/version_info", payload: {} })
    assert.equal(ordinary.statusCode, 500)
    assert.deepEqual(ordinary.json(), {
        code: "ASSET_SERVICE_ERROR",
        message: "asset service is unavailable",
    })

    const title = await app.inject({
        method: "POST",
        url: "/assetintitle/version_info_in_title",
        payload: {},
    })
    assert.equal(title.statusCode, 500)
    assert.equal(title.headers["content-type"], "application/x-msgpack")
    assert.deepEqual(unpack(Buffer.from(title.body, "base64")), {
        code: "ASSET_SERVICE_ERROR",
        message: "asset service is unavailable",
    })
    assert.equal(title.body.includes("/private/internal"), false)
    assert.equal(logged.length, 2)
})
