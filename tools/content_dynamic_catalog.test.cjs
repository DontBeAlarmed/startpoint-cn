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
        },
    })

    assert.equal((await loader.load()).targetVersion, "1.4.54")
    assert.equal(runtimeReads, 1)
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

test("modern current is authoritative and emits a stable warning when legacy current exists", async t => {
    const fixture = createSandbox(t)
    await installLightweightRelease(fixture, "1.4.55", { marker: "modern" })
    const legacyStore = new ContentObjectStore({ contentRootDir: fixture.paths.contentRootDir })
    await installLightweightRelease(fixture, "1.4.54", {
        marker: "legacy",
        store: legacyStore,
    })
    let warnings = ""
    const provider = createProjectContentSnapshotProvider({
        projectRoot: fixture.projectRoot,
        env: {},
        dependencies: {
            resolvePaths: () => fixture.paths,
            warningSink: { write(value) { warnings += String(value) } },
        },
    })

    const snapshot = await provider.initialize()

    assert.equal(snapshot.cdn.targetVersion, "1.4.55")
    assert.equal(snapshot.repository.info().assetVersion, "1.4.55")
    assert.deepEqual(snapshot.repository.table("config.json"), { fixture: "modern" })
    assert.equal(warnings, "警告 [CONTENT_LEGACY_CURRENT_IGNORED]：已忽略旧版内容快照\n")
})

test("corrupt modern current never falls back to a valid legacy snapshot", async t => {
    const fixture = createSandbox(t)
    const modern = await installLightweightRelease(fixture, "1.4.55")
    const legacyStore = new ContentObjectStore({ contentRootDir: fixture.paths.contentRootDir })
    await installLightweightRelease(fixture, "1.4.54", { store: legacyStore })
    fs.writeFileSync(path.join(fixture.paths.contentStateDir, "current.json"), "{")
    const provider = createProjectContentSnapshotProvider({
        projectRoot: fixture.projectRoot,
        env: {},
        dependencies: { resolvePaths: () => fixture.paths },
    })

    await assert.rejects(provider.initialize(), /current pointer is corrupt/i)
    assert.ok(modern.manifest.releaseDigest)
})

test("missing modern current selects one complete legacy snapshot for catalog and repository", async t => {
    const fixture = createSandbox(t)
    const legacyStore = new ContentObjectStore({ contentRootDir: fixture.paths.contentRootDir })
    const legacy = await installLightweightRelease(fixture, "1.4.54", {
        marker: "legacy-only",
        store: legacyStore,
    })
    const provider = createProjectContentSnapshotProvider({
        projectRoot: fixture.projectRoot,
        env: {},
        dependencies: { resolvePaths: () => fixture.paths },
    })

    const snapshot = await provider.initialize()

    assert.equal(snapshot.cdn.targetVersion, "1.4.54")
    assert.equal(snapshot.repository.info().releaseDigest, legacy.manifest.releaseDigest)
    assert.deepEqual(snapshot.repository.table("config.json"), { fixture: "legacy-only" })
})

test("explicit legacy layout reads only its configured store", async t => {
    const fixture = createSandbox(t)
    const legacyPaths = {
        ...fixture.paths,
        layout: "legacy",
        contentRootDir: fixture.paths.contentRootDir,
        contentStoreDir: fixture.paths.contentRootDir,
        contentStateDir: fixture.paths.contentRootDir,
    }
    const legacyStore = new ContentObjectStore(legacyPaths)
    await installLightweightRelease(fixture, "1.4.54", {
        marker: "configured-legacy",
        store: legacyStore,
    })
    let storeCreations = 0
    const provider = createProjectContentSnapshotProvider({
        projectRoot: fixture.projectRoot,
        env: { CONTENT_DIR: fixture.paths.contentRootDir },
        dependencies: {
            resolvePaths: () => legacyPaths,
            createStore: paths => {
                storeCreations++
                assert.equal(paths.layout, "legacy")
                return new ContentObjectStore(paths)
            },
        },
    })

    const snapshot = await provider.initialize()

    assert.equal(storeCreations, 1)
    assert.deepEqual(snapshot.repository.table("config.json"), { fixture: "configured-legacy" })
})

test("missing modern and legacy currents share one configured runtime fallback without writes", async t => {
    const fixture = createSandbox(t)
    const manifestPaths = []
    const importerRoots = new Set()
    const provider = createProjectContentSnapshotProvider({
        projectRoot: fixture.projectRoot,
        env: {},
        dependencies: {
            resolvePaths: () => fixture.paths,
            catalog: {
                readRuntimeManifest: async manifestPath => {
                    manifestPaths.push(manifestPath)
                    return fallbackManifest()
                },
                validateRuntimeFiles: async () => {},
            },
            repository: {
                importBundledTable: async (runtimeRoot, tableName) => {
                    importerRoots.add(runtimeRoot)
                    return { tableName }
                },
            },
        },
    })

    const snapshot = await provider.initialize()

    assert.equal(snapshot.cdn.targetVersion, "1.4.54")
    assert.equal(snapshot.repository.info().source, "bundled")
    assert.deepEqual([...importerRoots], [fixture.paths.contentRuntimeDir])
    assert.deepEqual(manifestPaths, [
        path.join(fixture.paths.contentRuntimeDir, "cdn/catalog-cn-1.4.54.json"),
    ])
    assert.equal(fs.existsSync(fixture.paths.contentRootDir), false)
    assert.equal(fs.existsSync(fixture.paths.contentStoreDir), false)
    assert.equal(fs.existsSync(fixture.paths.contentStateDir), false)
})

test("missing legacy current ignores a residual non-directory legacy root", async t => {
    const fixture = createSandbox(t)
    fs.writeFileSync(fixture.paths.contentRootDir, "legacy residue")
    const provider = createProjectContentSnapshotProvider({
        projectRoot: fixture.projectRoot,
        env: {},
        dependencies: {
            resolvePaths: () => fixture.paths,
            catalog: {
                readRuntimeManifest: async () => fallbackManifest(),
                validateRuntimeFiles: async () => {},
            },
            repository: {
                importBundledTable: async (_runtimeRoot, tableName) => ({ tableName }),
            },
        },
    })

    const snapshot = await provider.initialize()

    assert.equal(snapshot.cdn.targetVersion, "1.4.54")
    assert.equal(snapshot.repository.info().source, "bundled")
    assert.equal(fs.readFileSync(fixture.paths.contentRootDir, "utf8"), "legacy residue")
})

for (const assetMode of ["remote", "client-owned"]) {
    test(`${assetMode} snapshot fallback does not create content Store or State`, async t => {
        const fixture = createSandbox(t)
        let resolveCalls = 0
        const manifestPaths = []
        const importerRoots = new Set()
        const provider = createProjectContentSnapshotProvider({
            projectRoot: fixture.projectRoot,
            env: { CDN_DIR: "must-be-ignored/cn" },
            localCdn: false,
            dependencies: {
                resolvePaths: ({ env }) => {
                    resolveCalls++
                    assert.equal(env.CDN_DIR, undefined)
                    return fixture.paths
                },
                catalog: {
                    readRuntimeManifest: async manifestPath => {
                        manifestPaths.push(manifestPath)
                        return fallbackManifest()
                    },
                },
                repository: {
                    importBundledTable: async (runtimeRoot, tableName) => {
                        importerRoots.add(runtimeRoot)
                        return { tableName }
                    },
                },
            },
        })

        const snapshot = await provider.initialize()

        assert.equal(resolveCalls, 1)
        assert.equal(snapshot.repository.info().source, "bundled")
        assert.deepEqual([...importerRoots], [fixture.paths.contentRuntimeDir])
        assert.deepEqual(manifestPaths, [
            path.join(fixture.paths.contentRuntimeDir, "cdn/catalog-cn-1.4.54.json"),
        ])
        assert.equal(fs.existsSync(fixture.paths.contentRootDir), false)
        assert.equal(fs.existsSync(fixture.paths.contentStoreDir), false)
        assert.equal(fs.existsSync(fixture.paths.contentStateDir), false)
    })
}

test("non-local snapshot ignores an unusable local CDN path with the real resolver", async t => {
    const fixture = createSandbox(t)
    await installLightweightRelease(fixture, "1.4.54")
    const externalCdn = fs.mkdtempSync(path.join(path.dirname(fixture.projectRoot), "external-cdn-"))
    t.after(() => fs.rmSync(externalCdn, { force: true, recursive: true }))
    fs.rmSync(fixture.paths.cdnDir, { force: true, recursive: true })
    try {
        fs.symlinkSync(externalCdn, fixture.paths.cdnDir, "dir")
    } catch (error) {
        if (process.platform === "win32" && ["EACCES", "EPERM"].includes(error.code)) {
            t.skip("directory symlink creation is unavailable on this Windows host")
            return
        }
        throw error
    }

    const snapshot = await createProjectContentSnapshotProvider({
        projectRoot: fixture.projectRoot,
        env: {},
        localCdn: false,
    }).initialize()

    assert.equal(snapshot.cdn.targetVersion, "1.4.54")
    assert.equal(snapshot.repository.info().assetVersion, "1.4.54")
})
