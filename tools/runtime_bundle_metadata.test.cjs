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
        loadServerManifest: () => ({ version: "9.8.7", bundleId: "bundle-test" }),
    }), {
        version: "9.8.7",
        bundleId: "bundle-test",
    })
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
            nodeVersion: process.version,
            database: { ready: true, schema: 4 },
            contentInitialized: true,
            httpListening: true,
            tcpListening: true,
            adminAvailable: false,
            assetMode: "client-owned",
        })
        assert.equal(health.statusCode, 200)
        assert.equal(health.body.serverBundle.version, FALLBACK_BUNDLE_VERSION)
        assert.doesNotMatch(JSON.stringify(health.body), /private|sensitive/)
    }
})
