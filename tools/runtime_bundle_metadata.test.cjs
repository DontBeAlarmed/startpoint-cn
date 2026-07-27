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

test("packaged bundle reads server manifest metadata without an injected loader", t => {
    const bundleRoot = temporaryBundle(t)
    fs.writeFileSync(path.join(bundleRoot, "server-manifest.json"), JSON.stringify({
        schemaVersion: 2,
        name: "starpoint-cn",
        serverVersion: "1.4.2",
        bundleId: `sha256:${"a".repeat(64)}`,
        entry: "out/cn-server.js",
        requires: {
            runtimeApi: 1,
            node: ">=20.12.0",
            dependencyLock: `sha256:${"b".repeat(64)}`,
            minDataSchema: 0,
            targetDataSchema: 10,
        },
        admin: { path: "web/dist", required: false },
        assets: {
            supportedModes: ["client-owned", "local", "remote"],
            minClientAssetVersion: "1.4.54",
        },
        ports: { http: 8001, tcp: 8003 },
        files: [],
    }))

    assert.deepEqual(loadBundleMetadata({ bundleRoot }), {
        version: "1.4.2",
        bundleId: `sha256:${"a".repeat(64)}`,
    })
})

test("invalid packaged manifest metadata falls back to development package metadata", t => {
    const bundleRoot = temporaryBundle(t)
    fs.writeFileSync(path.join(bundleRoot, "server-manifest.json"), JSON.stringify({
        schemaVersion: 2,
        name: "starpoint-cn",
        serverVersion: "1.4.2",
        bundleId: "not-a-digest",
    }))
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
            tcpListening: true,
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
