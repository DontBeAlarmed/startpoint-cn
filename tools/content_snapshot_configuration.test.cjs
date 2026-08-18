"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const modulePath = path.resolve(__dirname, "../src/content/runtime/content-snapshot.ts")

function loadIsolatedSnapshotModule(t) {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "content-snapshot-config-"))
    const contentDir = path.join(temporaryRoot, "content")
    fs.mkdirSync(contentDir)
    const hadContentDir = Object.prototype.hasOwnProperty.call(process.env, "CONTENT_DIR")
    const previousContentDir = process.env.CONTENT_DIR
    process.env.CONTENT_DIR = contentDir
    const resolvedModulePath = require.resolve(modulePath)
    delete require.cache[resolvedModulePath]
    t.after(() => {
        delete require.cache[resolvedModulePath]
        if (hadContentDir) process.env.CONTENT_DIR = previousContentDir
        else delete process.env.CONTENT_DIR
        fs.rmSync(temporaryRoot, { recursive: true, force: true })
    })
    return require(resolvedModulePath)
}

test("production snapshot identity is stable and its first runtime mode is locked", {
    concurrency: false,
}, async t => {
    const snapshotModuleBefore = loadIsolatedSnapshotModule(t)
    const {
        initializeContentSnapshot,
        productionContentSnapshotProvider: destructuredBeforeInitialization,
    } = snapshotModuleBefore
    const first = initializeContentSnapshot({
        assetMode: "client-owned",
        localCdn: false,
    })
    const concurrent = initializeContentSnapshot({
        assetMode: "client-owned",
        localCdn: false,
    })

    assert.strictEqual(concurrent, first)
    const snapshot = await first

    const snapshotModuleAfter = require(require.resolve(modulePath))
    assert.equal(
        snapshotModuleAfter.productionContentSnapshotProvider
            === destructuredBeforeInitialization,
        true,
    )
    assert.equal(
        snapshotModuleAfter.productionContentSnapshotProvider
            === snapshotModuleBefore.productionContentSnapshotProvider,
        true,
    )
    assert.strictEqual(snapshotModuleAfter.getContentSnapshot(), snapshot)

    assert.throws(
        () => initializeContentSnapshot({ assetMode: "local", localCdn: true }),
        error => error.code === "CONTENT_SNAPSHOT_CONFIGURATION_CONFLICT"
            && error.message === "content snapshot runtime configuration is already locked",
    )
    assert.strictEqual(snapshotModuleAfter.getContentSnapshot(), snapshot)
})

test("independent configured provider shares one initialization and rejects mode conflicts", {
    concurrency: false,
}, async t => {
    const {
        ContentSnapshotProvider,
        createConfiguredContentSnapshotProvider,
    } = loadIsolatedSnapshotModule(t)
    let providerCreations = 0
    let sourceLoads = 0
    let releaseSource
    const sourceGate = new Promise(resolve => { releaseSource = resolve })
    const fixture = Object.freeze({
        cdn: Object.freeze({ targetVersion: "9.9.9" }),
        repository: Object.freeze({}),
    })
    const provider = createConfiguredContentSnapshotProvider({
        createProvider: configuration => {
            providerCreations++
            assert.deepEqual(configuration, {
                assetMode: "remote",
                localCdn: false,
                contentEnvironment: {
                    CONTENT_RUNTIME_DIR: "runtime-first",
                },
            })
            return new ContentSnapshotProvider({
                snapshotSource: {
                    async load() {
                        sourceLoads++
                        await sourceGate
                        return fixture
                    },
                },
            })
        },
    })

    const contentEnvironment = { CONTENT_RUNTIME_DIR: "runtime-first" }
    const first = provider.initialize({
        assetMode: "remote",
        localCdn: false,
        contentEnvironment,
    })
    contentEnvironment.CONTENT_RUNTIME_DIR = "runtime-second"
    const concurrent = provider.initialize({
        assetMode: "remote",
        localCdn: false,
        contentEnvironment: { CONTENT_RUNTIME_DIR: "runtime-first" },
    })
    assert.strictEqual(concurrent, first)
    assert.equal(providerCreations, 1)
    assert.equal(sourceLoads, 1)

    assert.throws(
        () => provider.initialize({
            assetMode: "client-owned",
            localCdn: false,
            contentEnvironment: { CONTENT_RUNTIME_DIR: "runtime-first" },
        }),
        error => error.code === "CONTENT_SNAPSHOT_CONFIGURATION_CONFLICT",
    )
    releaseSource()
    assert.strictEqual(await first, fixture)
    assert.strictEqual(provider.get(), fixture)
    assert.equal(providerCreations, 1)
    assert.equal(sourceLoads, 1)
})
