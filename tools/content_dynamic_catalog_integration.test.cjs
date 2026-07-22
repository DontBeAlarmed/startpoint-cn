"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { CdnCatalogLoader } = require("../src/content/cdn/catalog-loader")
const { ContentObjectStore } = require("../src/content/sync/object-store")
const {
    createSandbox,
    synchronizeRelease,
} = require("./helpers/content-dynamic-catalog-fixture.cjs")

test("full sync publishes the scanned catalog and release tables together", async t => {
    const fixture = createSandbox(t)
    const synchronizedCatalog = await synchronizeRelease(fixture, "1.4.54")
    let fallbackReads = 0
    const loader = new CdnCatalogLoader({
        projectRoot: fixture.projectRoot,
        env: {},
        dependencies: {
            resolvePaths: () => fixture.paths,
            readRuntimeManifest: async () => {
                fallbackReads++
                throw new Error("fallback runtime manifest must not be read")
            },
            readPatchManifest: async () => {
                fallbackReads++
                throw new Error("fallback patch manifest must not be read")
            },
            validateRuntimeFiles: async () => {
                throw new Error("fallback files must not be validated")
            },
        },
    })

    const loaded = await loader.load()
    const store = new ContentObjectStore(fixture.paths)
    const release = await store.readCurrentReleaseSnapshot()

    assert.deepEqual(loaded, synchronizedCatalog)
    assert.deepEqual(release.objects[release.manifest.catalog.object], synchronizedCatalog)
    assert.equal(loaded.targetVersion, release.manifest.assetVersion)
    assert.equal(Object.keys(release.manifest.tables).length, 94)
    assert.equal(fallbackReads, 0)
})
