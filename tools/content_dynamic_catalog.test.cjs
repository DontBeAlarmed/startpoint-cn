"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { CdnCatalogLoader } = require("../src/content/cdn/catalog-loader")
const {
    createProjectContentSnapshotProvider,
} = require("../src/content/runtime/content-snapshot")
const { ContentObjectStore } = require("../src/content/sync/object-store")
const {
    createSandbox,
    fallbackManifest,
    installLightweightRelease,
} = require("./helpers/content-dynamic-catalog-fixture.cjs")

test("catalog loader preserves the official fallback only when current is absent", async t => {
    const fixture = createSandbox(t)
    let runtimeReads = 0
    let patchReads = 0
    let validations = 0
    const loader = new CdnCatalogLoader({
        projectRoot: fixture.projectRoot,
        env: {},
        dependencies: {
            resolvePaths: () => fixture.paths,
            readRuntimeManifest: async () => {
                runtimeReads++
                return fallbackManifest()
            },
            validateRuntimeFiles: async () => { validations++ },
            readPatchManifest: async () => {
                patchReads++
                return { cdn_version: "1.4.54", patches: [] }
            },
        },
    })

    assert.equal((await loader.load()).targetVersion, "1.4.54")
    assert.equal(runtimeReads, 1)
    assert.equal(patchReads, 1)
    assert.equal(validations, 1)
})

test("corrupt current, release manifest, or catalog object fails without fallback", async t => {
    for (const corruption of ["current", "manifest", "catalog"]) {
        await t.test(corruption, async t => {
            const fixture = createSandbox(t)
            const installed = await installLightweightRelease(fixture, "1.4.54")
            const store = installed.store
            const current = await store.readCurrent()
            const manifest = await store.readRelease(current)
            if (corruption === "current") {
                fs.writeFileSync(path.join(fixture.paths.contentStateDir, "current.json"), "{")
            } else if (corruption === "manifest") {
                fs.writeFileSync(path.join(fixture.paths.contentStoreDir, current.release), "{}")
            } else {
                fs.writeFileSync(
                    path.join(
                        fixture.paths.contentStoreDir,
                        "objects",
                        `${manifest.catalog.object.slice("sha256:".length)}.json`,
                    ),
                    "{}",
                )
            }
            let fallbackReads = 0
            const loader = new CdnCatalogLoader({
                projectRoot: fixture.projectRoot,
                env: {},
                dependencies: {
                    resolvePaths: () => fixture.paths,
                    readRuntimeManifest: async () => {
                        fallbackReads++
                        return fallbackManifest()
                    },
                    readPatchManifest: async () => {
                        fallbackReads++
                        return { cdn_version: "1.4.54", patches: [] }
                    },
                },
            })

            await assert.rejects(loader.load(), /current|release|object|catalog/i)
            assert.equal(fallbackReads, 0)
        })
    }
})

test("project snapshot pins catalog and repository to one release across current changes", async t => {
    const fixture = createSandbox(t)
    await installLightweightRelease(fixture, "1.4.54")
    const provider = createProjectContentSnapshotProvider({
        projectRoot: fixture.projectRoot,
        env: {},
    })
    const first = await provider.initialize()

    assert.equal(first.cdn.targetVersion, "1.4.54")
    assert.equal(first.repository.info().assetVersion, "1.4.54")
    assert.match(first.repository.info().releaseDigest, /^sha256:[a-f0-9]{64}$/)

    await installLightweightRelease(fixture, "1.4.55")
    assert.strictEqual(await provider.initialize(), first)
    assert.strictEqual(provider.get(), first)
    assert.equal(provider.get().cdn.targetVersion, "1.4.54")
    assert.equal(provider.get().repository.info().assetVersion, "1.4.54")
})
