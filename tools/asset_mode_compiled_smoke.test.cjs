"use strict"

const assert = require("node:assert/strict")
const { spawnSync } = require("node:child_process")
const { EventEmitter } = require("node:events")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const Fastify = require("fastify")

const projectRoot = path.resolve(__dirname, "..")
const outRoot = path.join(projectRoot, "out")

function buildCompiledRuntime() {
    const result = spawnSync(
        process.execPath,
        [path.join(projectRoot, "tools/test-workflow/build-cn.cjs")],
        { cwd: projectRoot, encoding: "utf8" },
    )
    assert.equal(
        result.status,
        0,
        `build:server failed\n${result.stdout}\n${result.stderr}`,
    )
    assert.match(result.stdout, /CN build verified/)
}

function requireOut(relativePath) {
    const modulePath = path.join(outRoot, relativePath)
    assert.equal(fs.existsSync(modulePath), true, `missing compiled module: ${relativePath}`)
    return require(modulePath)
}

function createSnapshot() {
    return Object.freeze({
        cdn: Object.freeze({
            schemaVersion: 1,
            fullBaseVersion: "1.4.54",
            targetVersion: "1.4.54",
            installedBytes: 123_456,
            entityListsRelativePath: "EntityLists/android_medium.csv",
            edges: Object.freeze([]),
        }),
    })
}

buildCompiledRuntime()

const { parseAssetProviderConfig } = requireOut("content/cdn/asset-mode.js")
const { registerCnAssetProviderRoutes } = requireOut("routes/cn/asset-provider.js")
const { registerCnMsgpackOnSend } = requireOut("routes/cn/msgpack.js")
const { runContentStartup } = requireOut("content/startup/bootstrap.js")

async function createApp(t, config) {
    const app = Fastify({ logger: false })
    registerCnMsgpackOnSend(app)
    registerCnAssetProviderRoutes(app, {
        config,
        getSnapshot: createSnapshot,
    })
    await app.ready()
    t.after(() => app.close())
    return app
}

test("compiled client-owned routes return no-update and omit local patch routes", async t => {
    const config = parseAssetProviderConfig({
        projectRoot,
        env: {
            ASSET_MODE: "client-owned",
            CDN_DIR: "ignored/cn",
            CDN_BASE_URL: "not a URL",
        },
    })
    const app = await createApp(t, config)

    const version = await app.inject({
        method: "POST",
        url: "/api/index.php/asset/version_info",
        payload: {},
    })
    assert.equal(version.statusCode, 200)
    assert.deepEqual(version.json().data, {
        base_url: "",
        files_list: "",
        total_size: 0,
        delayed_assets_size: 0,
    })
    assert.equal(version.json().data_headers.asset_update, false)

    const patch = await app.inject({
        method: "GET",
        url: "/patch/cn/recovery/empty.csv",
    })
    assert.equal(patch.statusCode, 404)
})

test("compiled remote routes publish the remote base URL and omit local patch routes", async t => {
    const config = parseAssetProviderConfig({
        projectRoot,
        env: {
            ASSET_MODE: "remote",
            CDN_BASE_URL: "https://cdn.example.test/releases/cn/",
            CDN_DIR: "ignored/cn",
        },
    })
    const app = await createApp(t, config)

    const version = await app.inject({
        method: "POST",
        url: "/api/index.php/asset/version_info",
        payload: {},
    })
    assert.equal(version.statusCode, 200)
    assert.deepEqual(version.json().data, {
        base_url: "https://cdn.example.test/releases/cn/",
        files_list: "https://cdn.example.test/releases/cn/recovery/empty.csv",
        total_size: 123_456,
        delayed_assets_size: 0,
    })

    const patch = await app.inject({
        method: "GET",
        url: "/patch/cn/recovery/empty.csv",
    })
    assert.equal(patch.statusCode, 404)
})

test("compiled default local routes register the local patch provider", async t => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compiled-asset-local-"))
    t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }))
    fs.mkdirSync(path.join(temporaryRoot, "cn"), { recursive: true })
    const config = parseAssetProviderConfig({
        projectRoot,
        env: { CDN_DIR: temporaryRoot },
    })
    assert.equal(config.mode, "local")
    const app = await createApp(t, config)

    const patch = await app.inject({
        method: "GET",
        url: "/patch/cn/recovery/empty.csv",
    })
    assert.equal(patch.statusCode, 200)
    assert.equal(patch.body, "")
})

class FakeChild extends EventEmitter {
    kill() {
        return true
    }
}

function createStartupHarness(env) {
    const calls = []
    const children = []
    const spawn = (_executable, args) => {
        calls.push(path.basename(args[0]))
        const child = new FakeChild()
        children.push(child)
        return child
    }
    return {
        calls,
        children,
        run: () => runContentStartup({
            projectRoot,
            executable: process.execPath,
            env,
            processTarget: new EventEmitter(),
            spawn,
            stderr: { write() {} },
        }),
    }
}

async function waitForCallCount(harness, count) {
    for (let attempt = 0; attempt < 20 && harness.calls.length < count; attempt++) {
        await new Promise(resolve => setImmediate(resolve))
    }
    assert.equal(harness.calls.length, count)
}

test("compiled bootstrap selects sync only for local mode", async t => {
    await t.test("default local", async () => {
        const harness = createStartupHarness({})
        const running = harness.run()
        assert.deepEqual(harness.calls, ["content_sync.cjs"])
        harness.children[0].emit("close", 0, null)
        await waitForCallCount(harness, 2)
        assert.deepEqual(harness.calls, ["content_sync.cjs", "cn-server.js"])
        harness.children[1].emit("close", 0, null)
        assert.deepEqual(await running, { code: 0, signal: null })
    })

    for (const mode of ["remote", "client-owned"]) {
        await t.test(mode, async () => {
            const env = mode === "remote"
                ? {
                    ASSET_MODE: mode,
                    CDN_BASE_URL: "https://cdn.example.test/releases/cn",
                    CDN_DIR: "ignored/cn",
                }
                : {
                    ASSET_MODE: mode,
                    CDN_BASE_URL: "not a URL",
                    CDN_DIR: "ignored/cn",
                }
            const harness = createStartupHarness(env)
            const running = harness.run()
            assert.deepEqual(harness.calls, ["cn-server.js"])
            harness.children[0].emit("close", 0, null)
            assert.deepEqual(await running, { code: 0, signal: null })
        })
    }
})
