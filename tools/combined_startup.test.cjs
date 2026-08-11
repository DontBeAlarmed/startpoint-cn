"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

require("ts-node/register/transpile-only")

const Fastify = require("fastify")
const versionCheckPlugin = require("../src/routes/cn/versionCheck").default
const iosLeitingRoutes = require("../src/routes/cn/ios-leiting").default
const assetPlugin = require("../src/routes/cn/asset").default
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

function buildIosFixture() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cn-ios-combined-"))
    const cn = path.join(tempRoot, "cn")
    fs.mkdirSync(path.join(cn, "archive-ios-full"), { recursive: true })
    fs.mkdirSync(path.join(cn, "archive-ios-diff"), { recursive: true })
    fs.mkdirSync(path.join(cn, "EntityLists"), { recursive: true })
    fs.writeFileSync(path.join(cn, "archive-ios-full", "pinball-1.4.0-1-abc123.zip"), Buffer.from("full-archive"))
    fs.writeFileSync(path.join(cn, "archive-ios-diff", "pinball-1.4.0-1.4.53-1-def456.zip"), Buffer.from("diff-archive"))
    // 覆盖 Catalog 全部 edge，保证 iOS 视图 ready
    fs.writeFileSync(path.join(cn, "archive-ios-diff", "pinball-1.4.53-1.4.54-1-cccccc.zip"), Buffer.from("latest-diff"))
    fs.writeFileSync(path.join(cn, "EntityLists", "android_medium.csv"), "path,version,size,hash,layer\n")
    fs.writeFileSync(path.join(cn, "EntityLists", "ios_medium.csv"), [
        "path,version,size,hash,layer",
        "pinball-a,1.4.0,1000,hash-a,common",
        "pinball-b,1.4.0,2000,hash-b,common",
    ].join("\n"))
    return { tempRoot, cn }
}

// PR2（versionCheck + ios-leiting）与 PR3（asset + cdnFiles）联合启动测试：
// 验证两个 PR 同时生效时，iOS 客户端全链路（.dis → SDK 登录 → 版本信息 → 资源路径 → 下载）可工作。
test("combined PR2+PR3 startup serves the full iOS client chain", async t => {
    const fixture = buildIosFixture()
    t.after(() => fs.rmSync(fixture.tempRoot, { recursive: true, force: true }))

    const app = Fastify({ logger: false })
    app.register(versionCheckPlugin, { ios: IOS_COMPAT })
    app.register(iosLeitingRoutes, {
        ios: IOS_COMPAT,
        resolveVersion: () => "1.4.54",
    })
    app.register(assetPlugin, {
        prefix: "/api/index.php/asset",
        getSnapshot: () => createSnapshot(),
        env: { CDN_DIR: fixture.tempRoot, CN_LISTEN_PORT: "8001" },
        resolveListenHost: () => "10.0.0.5",
        iosCompat: IOS_COMPAT,
    })
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

    // 1. version.dis：iOS 拿到私服 apiPath
    const dis = await app.inject({ method: "GET", url: "/shijtswy/version/client_release_ios.dis" })
    assert.equal(dis.statusCode, 200)
    assert.ok(dis.body.includes("10.0.0.5:8001"))
    assert.ok(dis.body.includes("\"apiScheme\":\"http\""))

    // 2. Android .dis 保持官方域名（回归）
    const androidDis = await app.inject({ method: "GET", url: "/shijtswy/version/client_release_android.dis" })
    assert.equal(androidDis.statusCode, 200)
    assert.ok(androidDis.body.includes("shijtswygamegf.leiting.com"))

    // 3. SDK 登录 mock
    const login = await app.inject({ method: "POST", url: "/sdk/v3-3/check_login.do" })
    assert.equal(login.statusCode, 200)
    assert.equal(login.json().status, "0")

    // 4. 协议版本文件没有权威 payload，保持未实现
    const version = await app.inject({ method: "GET", url: "/protocols/leiting/sensitive/part/wf_version.txt" })
    assert.equal(version.statusCode, 404)

    // 5. version_info（iOS 设备 → 空恢复清单 + installedBytes 语义）
    const info = await app.inject({
        method: "POST",
        url: "/api/index.php/asset/version_info",
        headers: { device: "1" },
        payload: {},
    })
    assert.equal(info.statusCode, 200)
    assert.ok(info.json().data.files_list.includes("/recovery/empty.csv"))
    assert.equal(info.json().data.total_size, 3000)

    // 6. get_path（iOS 设备 → ios-full 归档）
    const getPath = await app.inject({
        method: "POST",
        url: "/api/index.php/asset/get_path",
        headers: { device: "1" },
        payload: {},
    })
    assert.equal(getPath.statusCode, 200)
    assert.ok(getPath.json().data.full.archive.some(item => item.location.includes("archive-ios-full/pinball-1.4.0-1-abc123.zip")))

    // 7. 归档下载（allowlist 外放行 + Range）
    const patch = await app.inject({ method: "GET", url: "/patch/cn/archive-ios-full/pinball-1.4.0-1-abc123.zip" })
    assert.equal(patch.statusCode, 200)
    assert.equal(patch.body, "full-archive")
})

// 开关关闭时的联合行为：SDK 路由不注册，iOS .dis 回落官方域名，Android 完全不受影响。
test("combined startup with the switch disabled keeps Android-only behavior", async t => {
    const app = Fastify({ logger: false })
    app.register(versionCheckPlugin, { ios: { enabled: false, apiHost: "", apiScheme: "http" } })
    await app.ready()
    t.after(() => app.close())

    const iosDis = await app.inject({ method: "GET", url: "/shijtswy/version/client_release_ios.dis" })
    assert.ok(iosDis.body.includes("shijtswygamegf.leiting.com"))

    const login = await app.inject({ method: "POST", url: "/sdk/v3-3/check_login.do" })
    assert.equal(login.statusCode, 404)
})
