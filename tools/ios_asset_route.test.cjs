"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")
const crypto = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

require("ts-node/register/transpile-only")

const Fastify = require("fastify")
const assetPlugin = require("../src/routes/cn/asset").default
const assetInTitlePlugin = require("../src/routes/cn/assetInTitle").default
const cdnFilesPlugin = require("../src/routes/cn/cdnFiles").default

const SHA = "a".repeat(64)

function archive(relativePath, compressedBytes, order = 1) {
    return { relativePath, compressedBytes, sha256: SHA, layer: "common", order }
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

function createSnapshot() {
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
        }),
    })
}

const IOS_COMPAT = { enabled: true, apiHost: "10.0.0.5:8001", apiScheme: "http" }

// ios_medium.csv 的 size 列之和 = 3000（installedBytes 语义）
const IOS_ENTITY_LIST = [
    "path,version,size,hash,layer",
    "pinball-a,1.4.0,1000,hash-a,common",
    "pinball-b,1.4.0,2000,hash-b,common",
].join("\n")

function buildIosFixture() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cn-ios-test-"))
    const cn = path.join(tempRoot, "cn")
    fs.mkdirSync(path.join(cn, "archive-ios-full"), { recursive: true })
    fs.mkdirSync(path.join(cn, "archive-ios-diff"), { recursive: true })
    fs.mkdirSync(path.join(cn, "EntityLists"), { recursive: true })
    fs.writeFileSync(path.join(cn, "archive-ios-full", "pinball-1.4.0-1-abc123.zip"), Buffer.from("full-archive"))
    fs.writeFileSync(path.join(cn, "archive-ios-diff", "pinball-1.4.0-1.4.53-1-def456.zip"), Buffer.from("diff-archive"))
    // 覆盖 Catalog 全部 edge（full + 两个 diff），保证 iOS 视图 ready
    fs.writeFileSync(path.join(cn, "archive-ios-diff", "pinball-1.4.53-1.4.54-1-cccccc.zip"), Buffer.from("latest-diff"))
    // 诱饵：匹配不到任何版本的边 → 不在 iOS 目录视图/allowlist 中
    fs.writeFileSync(path.join(cn, "archive-ios-diff", "pinball-1.4.0-9.9.9-1-deadbe.zip"), Buffer.from("decoy"))
    fs.writeFileSync(path.join(cn, "EntityLists", "android_medium.csv"), "path,version,size,hash,layer\n")
    fs.writeFileSync(path.join(cn, "EntityLists", "ios_medium.csv"), IOS_ENTITY_LIST)
    return { tempRoot, cn }
}

async function createAssetApp(options = {}) {
    const app = Fastify({ logger: false })
    app.register(assetPlugin, {
        prefix: "/asset",
        getSnapshot: options.getSnapshot ?? (() => createSnapshot()),
        env: options.env ?? {},
        warn: options.warn,
        logError: options.logError,
        resolveListenHost: options.resolveListenHost,
        iosCompat: options.iosCompat,
    })
    await app.ready()
    return app
}

test("version_info mirrors Android semantics: empty recovery list and installed bytes", async t => {
    const fixture = buildIosFixture()
    t.after(() => fs.rmSync(fixture.tempRoot, { recursive: true, force: true }))

    const app = await createAssetApp({
        env: { CDN_DIR: fixture.tempRoot, CN_LISTEN_PORT: "8001", CN_PUBLIC_HOST: "10.0.0.5" },
        resolveListenHost: () => "10.0.0.5",
        iosCompat: IOS_COMPAT,
    })
    t.after(() => app.close())

    const response = await app.inject({
        method: "POST",
        url: "/asset/version_info",
        headers: { device: "1" },
        payload: {},
    })
    assert.equal(response.statusCode, 200)
    const data = response.json().data
    // 不宣称逐文件可恢复：files_list 指向空恢复清单
    assert.ok(data.files_list.includes("/recovery/empty.csv"))
    // total_size 使用未压缩 installedBytes（实体表 size 列之和），而非 ZIP 压缩下载量
    assert.equal(data.total_size, 3000)
    assert.ok(data.base_url.startsWith("http://10.0.0.5:8001/"))
})

test("version_info returns explicit unavailable when ios assets are missing", async t => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cn-ios-empty-"))
    t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))

    const app = await createAssetApp({
        env: { CDN_DIR: tempRoot, CN_LISTEN_PORT: "8001" },
        resolveListenHost: () => "10.0.0.5",
        iosCompat: IOS_COMPAT,
    })
    t.after(() => app.close())

    const response = await app.inject({
        method: "POST",
        url: "/asset/version_info",
        headers: { device: "1" },
        payload: {},
    })
    assert.equal(response.statusCode, 503)
    assert.equal(response.json().code, "IOS_ASSETS_UNAVAILABLE")
})

test("version_info returns explicit unavailable when an ios edge is missing (no android fallback)", async t => {
    // fixture 缺少 1.4.53 -> 1.4.54 的 iOS diff（Catalog 中存在该 diff edge）
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cn-ios-edge-"))
    const cn = path.join(tempRoot, "cn")
    fs.mkdirSync(path.join(cn, "archive-ios-full"), { recursive: true })
    fs.mkdirSync(path.join(cn, "archive-ios-diff"), { recursive: true })
    fs.mkdirSync(path.join(cn, "EntityLists"), { recursive: true })
    fs.writeFileSync(path.join(cn, "archive-ios-full", "pinball-1.4.0-1-abc123.zip"), Buffer.from("full-archive"))
    fs.writeFileSync(path.join(cn, "archive-ios-diff", "pinball-1.4.0-1.4.53-1-def456.zip"), Buffer.from("diff-archive"))
    fs.writeFileSync(path.join(cn, "EntityLists", "android_medium.csv"), "path,version,size,hash,layer\n")
    fs.writeFileSync(path.join(cn, "EntityLists", "ios_medium.csv"), IOS_ENTITY_LIST)
    t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))

    const app = await createAssetApp({
        env: { CDN_DIR: tempRoot, CN_LISTEN_PORT: "8001" },
        resolveListenHost: () => "10.0.0.5",
        iosCompat: IOS_COMPAT,
    })
    t.after(() => app.close())

    const response = await app.inject({
        method: "POST",
        url: "/asset/version_info",
        headers: { device: "1" },
        payload: {},
    })
    assert.equal(response.statusCode, 503)
    assert.equal(response.json().code, "IOS_ASSETS_UNAVAILABLE")
})

test("get_path plans ios-full archives for an iOS device and android archives otherwise", async t => {
    const fixture = buildIosFixture()
    t.after(() => fs.rmSync(fixture.tempRoot, { recursive: true, force: true }))

    const app = await createAssetApp({
        env: { CDN_DIR: fixture.tempRoot, CN_LISTEN_PORT: "8001", CN_PUBLIC_HOST: "10.0.0.5" },
        resolveListenHost: () => "10.0.0.5",
        iosCompat: IOS_COMPAT,
    })
    t.after(() => app.close())

    const iosResponse = await app.inject({
        method: "POST",
        url: "/asset/get_path",
        headers: { device: "1" },
        payload: {},
    })
    assert.equal(iosResponse.statusCode, 200)
    const iosData = iosResponse.json().data
    assert.equal(iosData.full.version, "1.4.0")
    const fullArchive = iosData.full.archive.find(item => item.location.includes("archive-ios-full/pinball-1.4.0-1-abc123.zip"))
    assert.ok(fullArchive)
    assert.equal(
        fullArchive.sha256,
        crypto.createHash("sha256").update(Buffer.from("full-archive")).digest("hex"),
    )
    assert.ok(iosData.full.archive[0].location.startsWith("http://10.0.0.5:8001/patch/cn/"))

    // Android 设备不受影响（仍然用 android 归档）
    const androidResponse = await app.inject({
        method: "POST",
        url: "/asset/get_path",
        headers: { device: "2" },
        payload: {},
    })
    assert.equal(androidResponse.statusCode, 200)
    assert.ok(androidResponse.json().data.full.archive[0].location.includes("archive-common-full/base.zip"))
})

test("get_path returns explicit unavailable when ios assets are missing", async t => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cn-ios-empty-"))
    t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))

    const app = await createAssetApp({
        env: { CDN_DIR: tempRoot, CN_LISTEN_PORT: "8001" },
        resolveListenHost: () => "10.0.0.5",
        iosCompat: IOS_COMPAT,
    })
    t.after(() => app.close())

    const response = await app.inject({
        method: "POST",
        url: "/asset/get_path",
        headers: { device: "1" },
        payload: {},
    })
    assert.equal(response.statusCode, 503)
    assert.equal(response.json().code, "IOS_ASSETS_UNAVAILABLE")
})

test("version_info returns unavailable when the iOS entity list is duplicated", async t => {
    const fixture = buildIosFixture()
    fs.writeFileSync(path.join(fixture.cn, "EntityLists", "extra-ios_medium.csv"), IOS_ENTITY_LIST)
    t.after(() => fs.rmSync(fixture.tempRoot, { recursive: true, force: true }))

    const app = await createAssetApp({
        env: { CDN_DIR: fixture.tempRoot, CN_LISTEN_PORT: "8001" },
        resolveListenHost: () => "10.0.0.5",
        iosCompat: IOS_COMPAT,
    })
    t.after(() => app.close())

    const response = await app.inject({
        method: "POST",
        url: "/asset/version_info",
        headers: { device: "1" },
        payload: {},
    })
    assert.equal(response.statusCode, 503)
    assert.equal(response.json().code, "IOS_ASSETS_UNAVAILABLE")
})

test("version_info returns unavailable when the iOS entity list is malformed", async t => {
    const fixture = buildIosFixture()
    fs.writeFileSync(path.join(fixture.cn, "EntityLists", "ios_medium.csv"), "not,a,valid,entity,list")
    t.after(() => fs.rmSync(fixture.tempRoot, { recursive: true, force: true }))

    const app = await createAssetApp({
        env: { CDN_DIR: fixture.tempRoot, CN_LISTEN_PORT: "8001" },
        resolveListenHost: () => "10.0.0.5",
        iosCompat: IOS_COMPAT,
    })
    t.after(() => app.close())

    const response = await app.inject({
        method: "POST",
        url: "/asset/version_info",
        headers: { device: "1" },
        payload: {},
    })
    assert.equal(response.statusCode, 503)
    assert.equal(response.json().code, "IOS_ASSETS_UNAVAILABLE")
})

test("cdnFiles serves only allowlisted archive-ios-* files and honors Range", async t => {
    const fixture = buildIosFixture()
    t.after(() => fs.rmSync(fixture.tempRoot, { recursive: true, force: true }))

    const app = Fastify({ logger: false })
    app.register(cdnFilesPlugin, {
        getSnapshot: () => createSnapshot(),
        paths: {
            cdnRoot: fixture.cn,
            patchesRoot: path.join(fixture.tempRoot, "patches"),
        },
        iosCompat: IOS_COMPAT,
    })
    await app.ready()
    t.after(() => app.close())

    // allowlist 内（冻结 iOS 目录视图解析出的归档）→ 200
    const full = await app.inject({ method: "GET", url: "/patch/cn/archive-ios-full/pinball-1.4.0-1-abc123.zip" })
    assert.equal(full.statusCode, 200)
    assert.equal(full.body, "full-archive")

    // Range → 206
    const ranged = await app.inject({
        method: "GET",
        url: "/patch/cn/archive-ios-full/pinball-1.4.0-1-abc123.zip",
        headers: { range: "bytes=0-3" },
    })
    assert.equal(ranged.statusCode, 206)
    assert.equal(ranged.body, "full")
    assert.match(ranged.headers["content-range"], /^bytes 0-3\/12$/)

    // 目录名前缀匹配但不在 allowlist（未解析来源）→ 404，不直接放行
    const decoy = await app.inject({ method: "GET", url: "/patch/cn/archive-ios-diff/pinball-1.4.0-9.9.9-1-deadbe.zip" })
    assert.equal(decoy.statusCode, 404)
})

test("title entry (assetintitle) keeps responding with iosCompat enabled", async t => {
    const fixture = buildIosFixture()
    t.after(() => fs.rmSync(fixture.tempRoot, { recursive: true, force: true }))

    const app = Fastify({ logger: false })
    const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
    registerCnMsgpackOnSend(app)
    app.register(assetInTitlePlugin, {
        prefix: "/assetintitle",
        getSnapshot: () => createSnapshot(),
        env: { CDN_DIR: fixture.tempRoot, CN_LISTEN_PORT: "8001", CN_PUBLIC_HOST: "10.0.0.5" },
        resolveListenHost: () => "10.0.0.5",
    })
    await app.ready()
    t.after(() => app.close())

    const response = await app.inject({
        method: "POST",
        url: "/assetintitle/version_info_in_title",
        headers: { device: "1" },
        payload: {},
    })
    assert.equal(response.statusCode, 200)
    assert.ok(Buffer.isBuffer(response.rawPayload), "msgpack payload expected")
    assert.ok(response.rawPayload.length > 0)
})
