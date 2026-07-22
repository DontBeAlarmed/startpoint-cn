"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const projectRoot = path.resolve(__dirname, "..")
const {
    parseAssetProviderConfig,
    resolveAssetLoadState,
} = require("../src/content/cdn/asset-mode")
const Fastify = require("fastify")
const { unpack } = require("msgpackr")

const SHA = "a".repeat(64)

function createSnapshot() {
    return Object.freeze({
        cdn: Object.freeze({
            schemaVersion: 1,
            fullBaseVersion: "1.4.0",
            targetVersion: "1.4.54",
            installedBytes: 987_654,
            entityListsRelativePath: "EntityLists/android_medium.csv",
            edges: Object.freeze([
                {
                    fromVersion: null,
                    toVersion: "1.4.0",
                    platform: "android",
                    assetSizeKind: "fulfill",
                    archives: Object.freeze([{
                        relativePath: "archive-common-full/base.zip",
                        compressedBytes: 100,
                        sha256: SHA,
                        layer: "common",
                        order: 1,
                    }]),
                },
                {
                    fromVersion: "1.4.0",
                    toVersion: "1.4.54",
                    platform: "android",
                    assetSizeKind: "fulfill",
                    archives: Object.freeze([{
                        relativePath: "archive-common-diff/latest.zip",
                        compressedBytes: 54,
                        sha256: SHA,
                        layer: "common",
                        order: 1,
                    }]),
                },
            ]),
        }),
    })
}

async function createProviderApp(t, config, getSnapshot = () => createSnapshot()) {
    const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
    const { registerCnAssetProviderRoutes } = require("../src/routes/cn/asset-provider")
    const app = Fastify({ logger: false })
    registerCnMsgpackOnSend(app)
    registerCnAssetProviderRoutes(app, { config, getSnapshot })
    await app.ready()
    t.after(() => app.close())
    return app
}

test("ASSET_MODE defaults to a frozen local provider with the project CDN", () => {
    const config = parseAssetProviderConfig({ projectRoot, env: {} })

    assert.deepEqual(config, {
        mode: "local",
        baseUrl: "http://127.0.0.1:8001/patch/cn",
        cdnRoot: path.join(projectRoot, ".cdn", "cn"),
    })
    assert.equal(Object.isFrozen(config), true)
})

test("ASSET_MODE accepts only exact supported values", () => {
    for (const mode of ["client-owned", "local", "remote"]) {
        const env = mode === "remote"
            ? { ASSET_MODE: mode, CDN_BASE_URL: "https://cdn.example.test/patch/cn" }
            : { ASSET_MODE: mode }
        assert.equal(parseAssetProviderConfig({ projectRoot, env }).mode, mode)
    }

    for (const mode of ["", " ", "LOCAL", "Remote", " local", "local ", "unknown"]) {
        assert.throws(
            () => parseAssetProviderConfig({ projectRoot, env: { ASSET_MODE: mode } }),
            error => error.code === "INVALID_ASSET_MODE"
                && error.message === "invalid ASSET_MODE configuration",
            JSON.stringify(mode),
        )
    }
})

test("local preserves parent-of-cn CDN_DIR semantics and validates only configured base URLs", () => {
    const config = parseAssetProviderConfig({
        projectRoot,
        env: {
            ASSET_MODE: "local",
            CDN_DIR: "runtime-cdn",
            CDN_BASE_URL: "https://cdn.example.test/patch/cn/",
        },
    })
    assert.deepEqual(config, {
        mode: "local",
        baseUrl: "https://cdn.example.test/patch/cn",
        cdnRoot: path.join(projectRoot, "runtime-cdn", "cn"),
    })
    assert.throws(
        () => parseAssetProviderConfig({
            projectRoot,
            env: { ASSET_MODE: "local", CDN_DIR: "runtime-cdn/cn" },
        }),
        /CDN_DIR must point to the parent directory/,
    )
    assert.throws(
        () => parseAssetProviderConfig({
            projectRoot,
            env: { ASSET_MODE: "local", CDN_BASE_URL: "https://cdn.test/cn?token=x" },
        }),
        /invalid CDN base URL configuration/,
    )
})

test("remote requires a strict URL but ignores CDN_DIR without probing the network", () => {
    const config = parseAssetProviderConfig({
        projectRoot,
        env: {
            ASSET_MODE: "remote",
            CDN_BASE_URL: "https://cdn.example.test/patch/cn/",
            CDN_DIR: "bad/../cn",
        },
    })
    assert.deepEqual(config, {
        mode: "remote",
        baseUrl: "https://cdn.example.test/patch/cn",
    })

    for (const baseUrl of [
        undefined,
        "",
        "https://user:pass@cdn.test/cn",
        "https://cdn.test/cn?token=x",
        "https://cdn.test/cn#fragment",
        "ftp://cdn.test/cn",
    ]) {
        const env = { ASSET_MODE: "remote" }
        if (baseUrl !== undefined) env.CDN_BASE_URL = baseUrl
        assert.throws(
            () => parseAssetProviderConfig({ projectRoot, env }),
            /CDN_BASE_URL|required|invalid CDN base URL configuration/,
        )
    }
})

test("client-owned ignores both CDN variables", () => {
    const config = parseAssetProviderConfig({
        projectRoot,
        env: {
            ASSET_MODE: "client-owned",
            CDN_DIR: "bad/../cn",
            CDN_BASE_URL: "not a url",
        },
    })

    assert.deepEqual(config, { mode: "client-owned" })
    assert.equal(Object.isFrozen(config), true)
})

test("only local registers the complete local patch route surface", async t => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asset-mode-routes-"))
    t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }))
    const cdnRoot = path.join(temporaryRoot, "cn")
    fs.mkdirSync(cdnRoot, { recursive: true })

    const modes = [
        { mode: "local", baseUrl: "http://127.0.0.1:8001/patch/cn", cdnRoot },
        { mode: "remote", baseUrl: "https://cdn.example.test/patch/cn" },
        { mode: "client-owned" },
    ]
    for (const config of modes) {
        await t.test(config.mode, async t => {
            const app = await createProviderApp(t, Object.freeze(config))
            for (const route of [
                { method: "POST", url: "/api/index.php/asset/version_info" },
                { method: "POST", url: "/api/index.php/asset/get_path" },
                { method: "POST", url: "/api/index.php/assetintitle/version_info_in_title" },
            ]) {
                assert.equal(app.hasRoute(route), true, `${config.mode}: ${route.url}`)
            }
            for (const route of [
                { method: "GET", url: "/patch/cn/recovery/empty.csv" },
                { method: "GET", url: "/patch/cn/dummy/download/production/upload/:prefix/:hash" },
                { method: "HEAD", url: "/patch/cn/dummy/download/production/upload/:prefix/:hash" },
                { method: "GET", url: "/patch/cn/*" },
                { method: "HEAD", url: "/patch/cn/*" },
            ]) {
                assert.equal(app.hasRoute(route), config.mode === "local", `${config.mode}: ${route.url}`)
            }
        })
    }
})

test("remote version_info and planner use only the frozen remote base URL", async t => {
    const config = Object.freeze({
        mode: "remote",
        baseUrl: "https://cdn.example.test/releases/cn",
    })
    const app = await createProviderApp(t, config)

    const version = await app.inject({
        method: "POST",
        url: "/api/index.php/asset/version_info",
        payload: {},
    })
    assert.deepEqual(version.json().data, {
        base_url: "https://cdn.example.test/releases/cn/",
        files_list: "https://cdn.example.test/releases/cn/recovery/empty.csv",
        total_size: 987_654,
        delayed_assets_size: 0,
    })

    const plan = await app.inject({
        method: "POST",
        url: "/api/index.php/asset/get_path",
        headers: { res_ver: "1.4.0" },
        payload: {},
    })
    assert.equal(plan.statusCode, 200)
    assert.equal(plan.json().data.diff[0].archive[0].location,
        "https://cdn.example.test/releases/cn/archive-common-diff/latest.zip")
    assert.equal(plan.json().data_headers.asset_update, true)
})

test("client-owned ordinary and title version_info encode a no-update response", async t => {
    const app = await createProviderApp(t, Object.freeze({ mode: "client-owned" }), () => {
        throw new Error("client-owned endpoint must not derive a target from the snapshot")
    })
    const expected = {
        base_url: "",
        files_list: "",
        total_size: 0,
        delayed_assets_size: 0,
    }

    const ordinary = await app.inject({
        method: "POST",
        url: "/api/index.php/asset/version_info",
        payload: {},
    })
    assert.equal(ordinary.statusCode, 200)
    assert.deepEqual(ordinary.json().data, expected)
    assert.equal(ordinary.json().data_headers.asset_update, false)

    const title = await app.inject({
        method: "POST",
        url: "/api/index.php/assetintitle/version_info_in_title",
        payload: {},
    })
    assert.equal(title.statusCode, 200)
    assert.equal(title.headers["content-type"], "application/x-msgpack")
    const decoded = unpack(Buffer.from(title.body, "base64"))
    assert.deepEqual(decoded.data, expected)
    assert.equal(decoded.data_headers.asset_update, false)
})

test("client-owned get_path publishes no plan and pins all versions to valid RES_VER", async t => {
    const app = await createProviderApp(t, Object.freeze({ mode: "client-owned" }), () => {
        throw new Error("client-owned endpoint must not derive a target from the snapshot")
    })
    const response = await app.inject({
        method: "POST",
        url: "/api/index.php/asset/get_path",
        headers: { res_ver: "1.8.1" },
        payload: { target_asset_version: "9.9.9" },
    })

    assert.equal(response.statusCode, 200)
    assert.equal(response.json().data_headers.asset_update, false)
    assert.deepEqual(response.json().data, {
        info: {
            client_asset_version: "1.8.1",
            target_asset_version: "1.8.1",
            eventual_target_asset_version: "1.8.1",
            is_initial: false,
        },
        full: null,
        diff: null,
        asset_version_hash: "",
        delayed_assets_size: 0,
    })
})

test("client-owned get_path rejects missing and malicious RES_VER without snapshot fallback", async t => {
    const app = await createProviderApp(t, Object.freeze({ mode: "client-owned" }))

    for (const resVer of [undefined, "", " 1.4.54", "1.4.54 ", "../1.4.54", "1.4", "1.4.54?x"] ) {
        const headers = resVer === undefined ? {} : { res_ver: resVer }
        const response = await app.inject({
            method: "POST",
            url: "/api/index.php/asset/get_path",
            headers,
            payload: {},
        })
        assert.equal(response.statusCode, 400, JSON.stringify(resVer))
        assert.deepEqual(response.json(), {
            code: "INVALID_RES_VERSION",
            message: "a valid RES_VER header is required in client-owned asset mode",
        })
    }
})

test("load asset state preserves local/remote behavior and never upgrades client-owned", () => {
    const local = { mode: "local", baseUrl: "http://localhost/patch/cn", cdnRoot: "/cdn/cn" }
    const remote = { mode: "remote", baseUrl: "https://cdn.test/cn" }
    const owned = { mode: "client-owned" }

    assert.deepEqual(resolveAssetLoadState(local, "1.4.53", "1.4.54"), {
        assetUpdate: true,
        availableAssetVersion: "1.4.54",
    })
    assert.deepEqual(resolveAssetLoadState(remote, "1.4.53", "1.4.54"), {
        assetUpdate: true,
        availableAssetVersion: "1.4.54",
    })
    assert.deepEqual(resolveAssetLoadState(owned, "1.8.1", "1.4.54"), {
        assetUpdate: false,
        availableAssetVersion: "1.8.1",
    })
    for (const value of [undefined, "", "../1.8.1", "1.8.1 "]) {
        assert.deepEqual(resolveAssetLoadState(owned, value, "1.4.54"), {
            assetUpdate: false,
            availableAssetVersion: "",
        })
    }
})

test("non-local snapshot initialization ignores CDN_DIR and uses bundled 1.4.54 fallback", async t => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asset-mode-snapshot-"))
    t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }))
    const { createProjectContentSnapshotProvider } = require(
        "../src/content/runtime/content-snapshot"
    )
    let localValidationCalls = 0
    const provider = createProjectContentSnapshotProvider({
        projectRoot,
        env: {
            CDN_DIR: "must-be-ignored/cn",
            CONTENT_DIR: path.join(temporaryRoot, "content"),
        },
        localCdn: false,
        dependencies: {
            catalog: {
                validateRuntimeFiles: async () => { localValidationCalls++ },
            },
        },
    })

    const snapshot = await provider.initialize()
    assert.equal(snapshot.cdn.targetVersion, "1.4.54")
    assert.deepEqual(snapshot.repository.info(), {
        source: "bundled",
        assetVersion: "1.4.54",
        generatorVersion: 1,
        releaseDigest: null,
    })
    assert.equal(localValidationCalls, 0)
})

test("CN server parses one provider and wires it through routes, load, and snapshot startup", () => {
    const source = fs.readFileSync(path.join(projectRoot, "src/cn-server.ts"), "utf8")

    assert.equal((source.match(/parseAssetProviderConfig\(/g) ?? []).length, 1)
    assert.match(source, /registerCnAssetProviderRoutes\(fastify,\s*\{\s*config: assetProviderConfig/)
    assert.match(source, /fastify\.register\(cnLoadPlugin,\s*\{[^}]*assetProvider: assetProviderConfig/s)
    assert.match(source, /initializeContentSnapshot\(\{\s*assetMode: assetProviderConfig\.mode,\s*localCdn: assetProviderConfig\.mode === "local"/)
    assert.doesNotMatch(source, /fastify\.register\(cnCdnFilesPlugin/)
})
