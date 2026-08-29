"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { createRuntimeHealthSnapshot } = require("../src/runtime/health")
const {
    FALLBACK_BUNDLE_VERSION,
    loadBundleMetadata,
} = require("../src/runtime/bundle-metadata")

function temporaryBundle(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-metadata-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    return root
}

function validManifest(schemaVersion) {
    const manifest = {
        schemaVersion,
        name: "starpoint-cn",
        serverVersion: "1.4.2",
        bundleId: `sha256:${"a".repeat(64)}`,
        entry: "out/cn-server.js",
        requires: {
            runtimeApi: 1,
            node: ">=20.12.0",
            dependencyLock: `sha256:${"b".repeat(64)}`,
            minDataSchema: 0,
            targetDataSchema: 21,
        },
        admin: { path: "web/dist", required: false },
        assets: {
            supportedModes: ["client-owned", "local", "remote"],
            minClientAssetVersion: "1.4.54",
        },
        ports: { http: 8001, tcp: 8003 },
        files: [],
    }
    if (schemaVersion === 3) {
        manifest.startup = { localPrepareEntry: "out/content/sync/entry.js" }
    }
    return manifest
}

function writeManifest(bundleRoot, manifest) {
    fs.writeFileSync(path.join(bundleRoot, "server-manifest.json"), JSON.stringify(manifest))
}

function assertManifestInvalid(t, manifest) {
    const bundleRoot = temporaryBundle(t)
    writeManifest(bundleRoot, manifest)
    fs.writeFileSync(path.join(bundleRoot, "package.json"), JSON.stringify({ version: "1.0.1" }))

    assert.deepEqual(loadBundleMetadata({ bundleRoot }), {
        version: "1.0.1",
        bundleId: null,
    })
    assert.throws(
        () => loadBundleMetadata({ bundleRoot, requireManifest: true }),
        error => error?.code === "INVALID_BUNDLE_MANIFEST",
    )
}

function withPrototypeStartup(getter, callback) {
    const previousDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "startup")
    Object.defineProperty(Object.prototype, "startup", {
        configurable: true,
        enumerable: true,
        get: getter,
    })
    try {
        return callback()
    } finally {
        if (previousDescriptor === undefined) delete Object.prototype.startup
        else Object.defineProperty(Object.prototype, "startup", previousDescriptor)
    }
}

test("future server manifest metadata takes priority over development package metadata", t => {
    const bundleRoot = temporaryBundle(t)
    fs.writeFileSync(path.join(bundleRoot, "package.json"), JSON.stringify({ version: "1.2.3" }))

    assert.deepEqual(loadBundleMetadata({
        bundleRoot,
        loadServerManifest: () => ({
            version: "9.8.7",
            bundleId: `sha256:${"9".repeat(64)}`,
        }),
    }), {
        version: "9.8.7",
        bundleId: `sha256:${"9".repeat(64)}`,
    })
})

test("injected metadata cannot bypass the bundle identity format", t => {
    const bundleRoot = temporaryBundle(t)
    fs.writeFileSync(path.join(bundleRoot, "package.json"), JSON.stringify({ version: "1.2.3" }))

    assert.deepEqual(loadBundleMetadata({
        bundleRoot,
        loadServerManifest: () => ({ version: "9.8.7", bundleId: "bundle-test" }),
    }), { version: "1.2.3", bundleId: null })
})

test("packaged bundle accepts strict v2 and v3 manifest identity", async t => {
    const expectedIdentity = {
        version: "1.4.2",
        bundleId: `sha256:${"a".repeat(64)}`,
    }

    for (const schemaVersion of [2, 3]) {
        await t.test(`schema ${schemaVersion}`, t => {
            const bundleRoot = temporaryBundle(t)
            const manifest = validManifest(schemaVersion)
            writeManifest(bundleRoot, manifest)

            if (schemaVersion === 2) {
                assert.equal(Object.hasOwn(manifest, "startup"), false)
            } else {
                assert.deepEqual(manifest.startup, {
                    localPrepareEntry: "out/content/sync/entry.js",
                })
            }
            assert.deepEqual(loadBundleMetadata({ bundleRoot }), expectedIdentity)
            assert.deepEqual(
                loadBundleMetadata({ bundleRoot, requireManifest: true }),
                expectedIdentity,
            )
        })
    }
})

test("schema v2 rejects every startup field", async t => {
    const startupValues = [
        ["null", null],
        ["empty object", {}],
        ["valid v3 startup", { localPrepareEntry: "out/content/sync/entry.js" }],
    ]

    for (const [name, startup] of startupValues) {
        await t.test(name, t => {
            const manifest = validManifest(2)
            manifest.startup = startup
            assertManifestInvalid(t, manifest)
        })
    }
})

test("schema v2 ignores an inherited startup getter", { concurrency: false }, t => {
    const bundleRoot = temporaryBundle(t)
    const manifest = validManifest(2)
    writeManifest(bundleRoot, manifest)
    let getterCalls = 0

    withPrototypeStartup(() => {
        getterCalls += 1
        return { localPrepareEntry: "out/content/sync/entry.js" }
    }, () => {
        const expectedIdentity = {
            version: manifest.serverVersion,
            bundleId: manifest.bundleId,
        }
        assert.deepEqual(loadBundleMetadata({ bundleRoot }), expectedIdentity)
        assert.deepEqual(
            loadBundleMetadata({ bundleRoot, requireManifest: true }),
            expectedIdentity,
        )
        assert.equal(getterCalls, 0)
    })
})

test("schema v3 requires the exact local preparation entry", async t => {
    const invalidStartupValues = [
        ["missing", undefined],
        ["null", null],
        ["array", []],
        ["string primitive", "out/content/sync/entry.js"],
        ["number primitive", 1],
        ["boolean primitive", true],
        ["missing key", {}],
        ["unknown key", {
            localPrepareEntry: "out/content/sync/entry.js",
            unknown: true,
        }],
        ["non-fixed path", { localPrepareEntry: "out/content/sync/other.js" }],
    ]

    for (const [name, startup] of invalidStartupValues) {
        await t.test(name, t => {
            const manifest = validManifest(3)
            if (startup === undefined) delete manifest.startup
            else manifest.startup = startup
            assertManifestInvalid(t, manifest)
        })
    }
})

test("schema v3 rejects inherited startup even when its getter looks valid", {
    concurrency: false,
}, t => {
    const manifest = validManifest(3)
    delete manifest.startup
    let getterCalls = 0

    withPrototypeStartup(() => {
        getterCalls += 1
        return { localPrepareEntry: "out/content/sync/entry.js" }
    }, () => {
        assertManifestInvalid(t, manifest)
        assert.equal(getterCalls, 0)
    })
})

test("strict v2 and v3 manifests retain identity field validation", async t => {
    const invalidIdentityFields = [
        ["name", manifest => { manifest.name = "other" }],
        ["server version", manifest => { manifest.serverVersion = "latest" }],
        ["bundle id", manifest => { manifest.bundleId = "not-a-digest" }],
        ["entry", manifest => { manifest.entry = "out/server.js" }],
        ["runtime API", manifest => { manifest.requires.runtimeApi = 2 }],
        ["Node requirement", manifest => { manifest.requires.node = "20.12.0" }],
        ["dependency lock", manifest => { manifest.requires.dependencyLock = "not-a-digest" }],
        ["minimum data schema", manifest => { manifest.requires.minDataSchema = 1 }],
        ["target data schema", manifest => { manifest.requires.targetDataSchema = 13 }],
    ]

    for (const schemaVersion of [2, 3]) {
        for (const [name, mutate] of invalidIdentityFields) {
            await t.test(`schema ${schemaVersion} ${name}`, t => {
                const manifest = validManifest(schemaVersion)
                mutate(manifest)
                assertManifestInvalid(t, manifest)
            })
        }
    }
})

test("invalid packaged manifest metadata falls back to development package metadata", t => {
    const bundleRoot = temporaryBundle(t)
    const manifest = validManifest(2)
    manifest.bundleId = "not-a-digest"
    writeManifest(bundleRoot, manifest)
    fs.writeFileSync(path.join(bundleRoot, "package.json"), JSON.stringify({ version: "1.0.1" }))

    assert.deepEqual(loadBundleMetadata({ bundleRoot }), {
        version: "1.0.1",
        bundleId: null,
    })
})

test("embedded runtime requires valid packaged manifest metadata", t => {
    const missingRoot = temporaryBundle(t)
    const invalidRoot = temporaryBundle(t)
    const incompleteRoot = temporaryBundle(t)
    fs.writeFileSync(path.join(invalidRoot, "server-manifest.json"), JSON.stringify({
        schemaVersion: 2,
        name: "starpoint-cn",
        serverVersion: "1.4.2",
        bundleId: "not-a-digest",
    }))
    fs.writeFileSync(path.join(incompleteRoot, "server-manifest.json"), JSON.stringify({
        schemaVersion: 2,
        name: "starpoint-cn",
        serverVersion: "1.4.2",
        bundleId: `sha256:${"c".repeat(64)}`,
    }))

    for (const bundleRoot of [missingRoot, invalidRoot, incompleteRoot]) {
        assert.throws(
            () => loadBundleMetadata({ bundleRoot, requireManifest: true }),
            error => error?.code === "INVALID_BUNDLE_MANIFEST",
        )
    }
    assert.throws(
        () => loadBundleMetadata({
            bundleRoot: missingRoot,
            requireManifest: true,
            loadServerManifest: () => ({
                version: "1.4.2",
                bundleId: `sha256:${"d".repeat(64)}`,
            }),
        }),
        error => error?.code === "INVALID_BUNDLE_MANIFEST",
    )
})

test("development bundle reads a safe package version", t => {
    const bundleRoot = temporaryBundle(t)
    fs.writeFileSync(path.join(bundleRoot, "package.json"), JSON.stringify({ version: "1.0.1" }))

    assert.deepEqual(loadBundleMetadata({ bundleRoot }), {
        version: "1.0.1",
        bundleId: null,
    })
})

test("missing or invalid metadata uses a safe explicit fallback", async t => {
    const missingRoot = temporaryBundle(t)
    const invalidRoot = temporaryBundle(t)
    fs.writeFileSync(path.join(invalidRoot, "package.json"), JSON.stringify({
        version: "/private/sensitive\nvalue",
    }))

    for (const bundleRoot of [missingRoot, invalidRoot]) {
        const metadata = loadBundleMetadata({ bundleRoot })
        assert.deepEqual(metadata, { version: FALLBACK_BUNDLE_VERSION, bundleId: null })
        const health = createRuntimeHealthSnapshot({
            phase: "ready",
            bundleVersion: metadata.version,
            bundleId: metadata.bundleId,
            nodeVersion: process.version,
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
            assetMode: "client-owned",
        })
        assert.equal(health.statusCode, 200)
        assert.deepEqual(health.body.serverBundle, {
            version: FALLBACK_BUNDLE_VERSION,
            bundleId: null,
        })
        assert.doesNotMatch(JSON.stringify(health.body), /private|sensitive/)
    }
})
