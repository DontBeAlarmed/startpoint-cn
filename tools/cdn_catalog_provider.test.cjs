"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { CatalogValidationError } = require("../src/content/cdn/catalog-builder")
const { deepFreeze } = require("../src/content/deep-freeze")
const {
    CdnCatalogLoader,
    CatalogLoaderError,
    resolveCatalogProjectRoot,
} = require("../src/content/cdn/catalog-loader")
const {
    ContentSnapshotError,
    ContentSnapshotProvider,
    productionContentSnapshotProvider,
    resolveContentProjectRoot,
} = require("../src/content/runtime/content-snapshot")

const fixtureRoot = path.join(__dirname, "fixtures/cdn-catalog")

function writePatchManifest(projectRoot, patches = []) {
    const manifestDirectory = path.join(projectRoot, "assets", "asset-patch")
    fs.mkdirSync(manifestDirectory, { recursive: true })
    fs.writeFileSync(
        path.join(manifestDirectory, "manifest.json"),
        JSON.stringify({ cdn_version: "1.4.1", patches }),
    )
}

function createProject(t) {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cdn-provider-"))
    fs.mkdirSync(path.join(projectRoot, ".cdn"), { recursive: true })
    fs.cpSync(fixtureRoot, path.join(projectRoot, ".cdn", "cn"), { recursive: true })
    writePatchManifest(projectRoot)
    t.after(() => fs.rmSync(projectRoot, { force: true, recursive: true }))
    return projectRoot
}

function catalog(targetVersion) {
    return {
        schemaVersion: 1,
        fullBaseVersion: "1.4.0",
        targetVersion,
        installedBytes: 30,
        entityListsRelativePath: "EntityLists/fixture-android_medium.csv",
        edges: [],
    }
}

function shallowFrozenCatalog(targetVersion = "1.4.1") {
    return Object.freeze({
        ...catalog(targetVersion),
        edges: [{
            fromVersion: null,
            toVersion: "1.4.0",
            platform: "android",
            assetSizeKind: "fulfill",
            archives: [{
                relativePath: "archive-common-full/pinball-1.4.0-1-abcd.zip",
                compressedBytes: 10,
                sha256: "a".repeat(64),
                layer: "common",
                order: 1,
            }],
        }],
    })
}

function injectedLoader({ scan, build }) {
    return new CdnCatalogLoader({
        projectRoot: path.resolve("/synthetic-project"),
        env: {},
        dependencies: {
            resolvePaths: () => ({}),
            scan,
            build,
            readPatchManifest: async () => ({ cdn_version: "1.4.1", patches: [] }),
        },
    })
}

function patch(overrides = {}) {
    return {
        id: "fixture-patch",
        type: "patch",
        name: "fixture patch",
        version: "1.4.1",
        depends_on: "1.4.0",
        enabled: true,
        archive: "pinball-1.4.0-1.4.1-1-abcd.zip",
        archive_size: 0,
        ...overrides,
    }
}

function deferred() {
    let resolve
    let reject
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, resolve, reject }
}

test("default loader validates a real CDN once and caches one deep-frozen catalog", async t => {
    const projectRoot = createProject(t)
    const loader = new CdnCatalogLoader({ projectRoot, env: {} })

    const first = await loader.load()
    const second = await loader.load()

    assert.strictEqual(second, first)
    assert.strictEqual(loader.get(), first)
    assert.equal(first.targetVersion, "1.4.1")
    assert.equal(first.installedBytes, 30)
    assert.equal(Object.isFrozen(first), true)
    assert.equal(Object.isFrozen(first.edges), true)
    assert.equal(Object.isFrozen(first.edges[0]), true)
    assert.equal(Object.isFrozen(first.edges[0].archives), true)
    assert.equal(Object.isFrozen(first.edges[0].archives[0]), true)
    for (const edge of first.edges.filter(candidate => candidate.assetSizeKind === "fulfill")) {
        for (const archive of edge.archives) {
            const content = fs.readFileSync(path.join(projectRoot, ".cdn", "cn", archive.relativePath))
            assert.equal(archive.compressedBytes, content.length)
            assert.equal(
                archive.sha256,
                require("node:crypto").createHash("sha256").update(content).digest("hex"),
            )
        }
    }
})

test("default loader rejects missing archives and disconnected real catalog graphs", async t => {
    const missingRoot = createProject(t)
    fs.unlinkSync(path.join(
        missingRoot,
        ".cdn/cn/archive-android-diff/pinball-1.4.0-1.4.1-1-abcd.zip",
    ))
    await assert.rejects(
        new CdnCatalogLoader({ projectRoot: missingRoot, env: {} }).load(),
        error => error instanceof CatalogValidationError && error.code === "MISSING_ARCHIVE_LAYER",
    )

    const disconnectedRoot = createProject(t)
    for (const directory of ["archive-common-diff", "archive-medium-diff", "archive-android-diff"]) {
        fs.renameSync(
            path.join(disconnectedRoot, ".cdn", "cn", directory, "pinball-1.4.0-1.4.1-1-abcd.zip"),
            path.join(disconnectedRoot, ".cdn", "cn", directory, "pinball-1.4.2-1.4.3-1-abcd.zip"),
        )
    }
    await assert.rejects(
        new CdnCatalogLoader({ projectRoot: disconnectedRoot, env: {} }).load(),
        error => error instanceof CatalogValidationError && error.code === "MISSING_PATH",
    )
})

test("concurrent initial loads share one scan and get fails clearly before initialization", async () => {
    let scans = 0
    let releaseScan
    const loader = injectedLoader({
        scan: () => {
            scans++
            return new Promise(resolve => { releaseScan = resolve })
        },
        build: input => catalog(input.targetVersion),
    })

    assert.throws(
        () => loader.get(),
        error => error instanceof CatalogLoaderError && error.code === "CATALOG_NOT_LOADED",
    )
    const firstLoad = loader.load()
    const secondLoad = loader.load()
    assert.strictEqual(secondLoad, firstLoad)
    assert.equal(scans, 1)

    releaseScan({ targetVersion: "1.4.1" })
    const [first, second] = await Promise.all([firstLoad, secondLoad])
    assert.strictEqual(second, first)
    assert.strictEqual(loader.get(), first)
    assert.strictEqual(await loader.load(), first)
    assert.equal(scans, 1)
})

test("load then reload linearizes candidates in call order", async () => {
    const firstCandidate = deferred()
    const secondCandidate = deferred()
    let scans = 0
    const loader = injectedLoader({
        scan: () => (++scans === 1 ? firstCandidate.promise : secondCandidate.promise),
        build: input => catalog(input.targetVersion),
    })

    const initialLoad = loader.load()
    const reload = loader.reload()
    assert.equal(scans, 1)

    firstCandidate.resolve({ targetVersion: "1.4.1" })
    const initial = await initialLoad
    assert.equal(initial.targetVersion, "1.4.1")
    assert.equal(scans, 2)

    secondCandidate.resolve({ targetVersion: "1.4.2" })
    const replacement = await reload
    assert.equal(replacement.targetVersion, "1.4.2")
    assert.strictEqual(loader.get(), replacement)
})

test("reload then load linearizes candidates in call order without stale overwrite", async () => {
    const firstCandidate = deferred()
    const secondCandidate = deferred()
    const secondStarted = deferred()
    let scans = 0
    const loader = injectedLoader({
        scan: () => {
            scans++
            if (scans === 1) return firstCandidate.promise
            secondStarted.resolve()
            return secondCandidate.promise
        },
        build: input => catalog(input.targetVersion),
    })

    const reload = loader.reload()
    const load = loader.load()
    assert.equal(scans, 1)

    firstCandidate.resolve({ targetVersion: "1.4.1" })
    const first = await reload
    assert.equal(first.targetVersion, "1.4.1")
    await secondStarted.promise
    assert.equal(scans, 2)

    secondCandidate.resolve({ targetVersion: "1.4.2" })
    const second = await load
    assert.equal(second.targetVersion, "1.4.2")
    assert.strictEqual(loader.get(), second)
})

test("failed initial load leaves no catalog and can be retried", async () => {
    let scans = 0
    const loader = injectedLoader({
        scan: async () => {
            scans++
            if (scans === 1) throw new Error("initial candidate rejected")
            return { targetVersion: "1.4.1" }
        },
        build: input => catalog(input.targetVersion),
    })

    await assert.rejects(loader.load(), /initial candidate rejected/)
    assert.throws(
        () => loader.get(),
        error => error instanceof CatalogLoaderError && error.code === "CATALOG_NOT_LOADED",
    )
    assert.equal((await loader.load()).targetVersion, "1.4.1")
    assert.equal(scans, 2)
})

test("loader recursively freezes children of an already frozen catalog root", async () => {
    const shallow = shallowFrozenCatalog()
    const loader = injectedLoader({
        scan: async () => ({}),
        build: () => shallow,
    })

    const loaded = await loader.load()
    assert.strictEqual(loaded, shallow)
    assert.equal(Object.isFrozen(loaded.edges), true)
    assert.equal(Object.isFrozen(loaded.edges[0]), true)
    assert.equal(Object.isFrozen(loaded.edges[0].archives), true)
    assert.equal(Object.isFrozen(loaded.edges[0].archives[0]), true)
    assert.throws(() => loaded.edges[0].archives.push({}), TypeError)
})

test("deep freeze handles cycles while freezing every reachable object", () => {
    const root = { child: {} }
    root.child.parent = root
    Object.freeze(root)

    assert.doesNotThrow(() => deepFreeze(root))
    assert.equal(Object.isFrozen(root), true)
    assert.equal(Object.isFrozen(root.child), true)
    assert.strictEqual(root.child.parent, root)
})

test("reload publishes only a complete candidate and preserves the old catalog on failure", async () => {
    const candidates = ["1.4.1", "1.4.2", new Error("candidate rejected")]
    let scans = 0
    const loader = injectedLoader({
        scan: async () => {
            const candidate = candidates[scans++]
            if (candidate instanceof Error) throw candidate
            return { targetVersion: candidate }
        },
        build: input => catalog(input.targetVersion),
    })

    const initial = await loader.load()
    const replacement = await loader.reload()
    assert.notStrictEqual(replacement, initial)
    assert.equal(replacement.targetVersion, "1.4.2")
    assert.strictEqual(loader.get(), replacement)

    await assert.rejects(loader.reload(), /candidate rejected/)
    assert.strictEqual(loader.get(), replacement)
    assert.equal(scans, 3)
})

test("a failed reload does not lock the queue and a queued success becomes cache", async () => {
    const failedCandidate = deferred()
    const successfulCandidate = deferred()
    const successStarted = deferred()
    let scans = 0
    const loader = injectedLoader({
        scan: () => {
            scans++
            if (scans === 1) return Promise.resolve({ targetVersion: "1.4.1" })
            if (scans === 2) return failedCandidate.promise
            successStarted.resolve()
            return successfulCandidate.promise
        },
        build: input => catalog(input.targetVersion),
    })
    const initial = await loader.load()
    const failedReload = loader.reload()
    const successfulReload = loader.reload()
    assert.equal(scans, 2)

    failedCandidate.reject(new Error("queued candidate rejected"))
    await assert.rejects(failedReload, /queued candidate rejected/)
    await successStarted.promise
    assert.equal(scans, 3)
    assert.strictEqual(loader.get(), initial)

    successfulCandidate.resolve({ targetVersion: "1.4.2" })
    const replacement = await successfulReload
    assert.equal(replacement.targetVersion, "1.4.2")
    assert.strictEqual(loader.get(), replacement)
})

test("concurrent reloads build serial candidates and publish in call order", async () => {
    let scans = 0
    let releaseFirstReload
    const loader = injectedLoader({
        scan: () => {
            scans++
            if (scans === 1) return Promise.resolve({ targetVersion: "1.4.1" })
            if (scans === 2) {
                return new Promise(resolve => { releaseFirstReload = resolve })
            }
            return Promise.resolve({ targetVersion: "1.4.3" })
        },
        build: input => catalog(input.targetVersion),
    })
    await loader.load()

    const firstReload = loader.reload()
    const secondReload = loader.reload()
    assert.equal(scans, 2)
    releaseFirstReload({ targetVersion: "1.4.2" })
    assert.equal((await firstReload).targetVersion, "1.4.2")
    assert.equal((await secondReload).targetVersion, "1.4.3")
    assert.equal(scans, 3)
    assert.equal(loader.get().targetVersion, "1.4.3")
})

test("enabled patches must match one fulfill diff edge archive basename and size", async t => {
    const projectRoot = createProject(t)
    const archivePath = path.join(
        projectRoot,
        ".cdn/cn/archive-android-diff/pinball-1.4.0-1.4.1-1-abcd.zip",
    )
    const archiveSize = fs.statSync(archivePath).size
    writePatchManifest(projectRoot, [patch({ archive_size: archiveSize })])

    const loader = new CdnCatalogLoader({ projectRoot, env: {} })
    assert.equal((await loader.load()).targetVersion, "1.4.1")

    for (const [overrides, detail] of [
        [{ depends_on: "1.3.9" }, "missing edge"],
        [{ archive: "pinball-other.zip" }, "archive basename"],
        [{ archive_size: archiveSize + 1 }, "archive size"],
    ]) {
        writePatchManifest(projectRoot, [patch({ archive_size: archiveSize, ...overrides })])
        await assert.rejects(
            new CdnCatalogLoader({ projectRoot, env: {} }).load(),
            error => (
                error instanceof CatalogLoaderError
                && error.code === "PATCH_CATALOG_MISMATCH"
                && error.message.includes(detail)
            ),
        )
    }

    fs.appendFileSync(archivePath, "tampered")
    writePatchManifest(projectRoot, [patch({ archive_size: archiveSize })])
    await assert.rejects(
        new CdnCatalogLoader({ projectRoot, env: {} }).load(),
        error => error instanceof CatalogLoaderError && error.code === "PATCH_CATALOG_MISMATCH",
    )
})

test("patch manifest rejects duplicate ids even when both entries match the catalog", async t => {
    const projectRoot = createProject(t)
    const archiveSize = fs.statSync(path.join(
        projectRoot,
        ".cdn/cn/archive-android-diff/pinball-1.4.0-1.4.1-1-abcd.zip",
    )).size
    const matchingPatch = patch({ archive_size: archiveSize })
    writePatchManifest(projectRoot, [matchingPatch, { ...matchingPatch }])

    await assert.rejects(
        new CdnCatalogLoader({ projectRoot, env: {} }).load(),
        error => (
            error instanceof CatalogLoaderError
            && error.code === "PATCH_MANIFEST_SCHEMA"
            && error.message.includes("duplicate patch id fixture-patch")
        ),
    )
})

test("disabled patches and mods never raise the catalog target", async t => {
    const projectRoot = createProject(t)
    writePatchManifest(projectRoot, [
        patch({ enabled: false, version: "9.9.9", depends_on: "9.9.8", archive: "missing.zip" }),
        patch({ id: "fixture-mod", type: "mod", version: "8.8.8", depends_on: "8.8.7" }),
    ])

    const loaded = await new CdnCatalogLoader({ projectRoot, env: {} }).load()
    assert.equal(loaded.targetVersion, "1.4.1")
})

test("the repository disabled patch manifest preserves the 1.4.54 catalog baseline", async () => {
    const loader = new CdnCatalogLoader({
        projectRoot: path.join(__dirname, ".."),
        env: {},
        dependencies: {
            resolvePaths: () => ({}),
            scan: async () => ({ targetVersion: "1.4.54" }),
            build: input => catalog(input.targetVersion),
        },
    })

    assert.equal((await loader.load()).targetVersion, "1.4.54")
})

test("manifest schema failures use a stable diagnostic loader error", async t => {
    const projectRoot = createProject(t)
    fs.writeFileSync(
        path.join(projectRoot, "assets/asset-patch/manifest.json"),
        JSON.stringify({ cdn_version: "1.4.1", patches: {} }),
    )

    await assert.rejects(
        new CdnCatalogLoader({ projectRoot, env: {} }).load(),
        error => error instanceof CatalogLoaderError && error.code === "PATCH_MANIFEST_SCHEMA",
    )
})

test("content snapshot is initialized once, deep-frozen, and pinned across loader reloads", async () => {
    const candidates = ["1.4.1", "1.4.2"]
    let scans = 0
    const loader = injectedLoader({
        scan: async () => ({ targetVersion: candidates[scans++] }),
        build: input => catalog(input.targetVersion),
    })
    const provider = new ContentSnapshotProvider(loader)

    assert.throws(
        () => provider.get(),
        error => error instanceof ContentSnapshotError && error.code === "CONTENT_SNAPSHOT_NOT_INITIALIZED",
    )
    const first = await provider.initialize()
    const second = await provider.initialize()
    assert.strictEqual(second, first)
    assert.strictEqual(provider.get(), first)
    assert.strictEqual(first.cdn, loader.get())
    assert.equal(Object.isFrozen(first), true)
    assert.equal(Object.isFrozen(first.cdn), true)

    const replacement = await loader.reload()
    assert.equal(replacement.targetVersion, "1.4.2")
    assert.strictEqual(provider.get(), first)
    assert.equal(provider.get().cdn.targetVersion, "1.4.1")

    const candidateProvider = new ContentSnapshotProvider(loader)
    const candidateSnapshot = await candidateProvider.initialize()
    assert.strictEqual(candidateSnapshot.cdn, replacement)
    assert.equal(candidateSnapshot.cdn.targetVersion, "1.4.2")
})

test("concurrent snapshot initialization loads once and returns one snapshot object", async () => {
    const candidate = deferred()
    let loads = 0
    const provider = new ContentSnapshotProvider({
        load: () => {
            loads++
            return candidate.promise
        },
    })

    const firstInitialization = provider.initialize()
    const secondInitialization = provider.initialize()
    assert.strictEqual(secondInitialization, firstInitialization)
    assert.equal(loads, 1)

    candidate.resolve(catalog("1.4.1"))
    const [first, second] = await Promise.all([firstInitialization, secondInitialization])
    assert.strictEqual(second, first)
    assert.strictEqual(provider.get(), first)
    assert.equal(loads, 1)
})

test("failed snapshot initialization leaves no partial state and can be retried safely", async () => {
    let attempts = 0
    const expected = catalog("1.4.1")
    const provider = new ContentSnapshotProvider({
        load: async () => {
            attempts++
            if (attempts === 1) throw new Error("initial catalog failed")
            return expected
        },
    })

    await assert.rejects(provider.initialize(), /initial catalog failed/)
    assert.throws(
        () => provider.get(),
        error => error instanceof ContentSnapshotError && error.code === "CONTENT_SNAPSHOT_NOT_INITIALIZED",
    )
    const snapshot = await provider.initialize()
    assert.strictEqual(snapshot.cdn, expected)
    assert.equal(Object.isFrozen(expected), true)
    assert.equal(attempts, 2)
})

test("snapshot recursively freezes children of an already frozen catalog root", async () => {
    const shallow = shallowFrozenCatalog()
    const provider = new ContentSnapshotProvider({ load: async () => shallow })

    const snapshot = await provider.initialize()
    assert.strictEqual(snapshot.cdn, shallow)
    assert.equal(Object.isFrozen(snapshot), true)
    assert.equal(Object.isFrozen(snapshot.cdn.edges), true)
    assert.equal(Object.isFrozen(snapshot.cdn.edges[0]), true)
    assert.equal(Object.isFrozen(snapshot.cdn.edges[0].archives), true)
    assert.equal(Object.isFrozen(snapshot.cdn.edges[0].archives[0]), true)
    assert.throws(() => snapshot.cdn.edges[0].archives.push({}), TypeError)
})

test("legacy version facade derives every runtime version from the pinned snapshot", t => {
    const previousSnapshot = productionContentSnapshotProvider.snapshot
    productionContentSnapshotProvider.snapshot = Object.freeze({ cdn: catalog("1.4.1") })
    t.after(() => { productionContentSnapshotProvider.snapshot = previousSnapshot })

    const version = require("../src/lib/version")
    assert.equal(version.detectCDNVersion(), "1.4.1")
    assert.equal(version.getEffectiveVersion(), "1.4.1")
    assert.equal(version.FULL_BASE, "1.4.0")
    const source = fs.readFileSync(path.join(__dirname, "../src/lib/version.ts"), "utf8")
    assert.doesNotMatch(source, /readdirSync|scanCdnCatalogInput/)
})

test("CN load publishes available_asset_version from the same content snapshot", () => {
    const source = fs.readFileSync(path.join(__dirname, "../src/routes/cn/load.ts"), "utf8")
    assert.match(source, /getContentSnapshot\(\)\.cdn\.targetVersion/)
    assert.doesNotMatch(source, /getEffectiveVersion/)
    assert.doesNotMatch(source, /detectCDNVersion/)
    assert.doesNotMatch(source, /scanCdnCatalogInput/)
})

test("content project root resolution is independent of cwd in src and out layouts", () => {
    const projectRoot = path.resolve("/srv/starpoint-cn")
    for (const outputRoot of ["src", "out"]) {
        assert.equal(
            resolveCatalogProjectRoot(path.join(projectRoot, outputRoot, "content", "cdn")),
            projectRoot,
        )
        assert.equal(
            resolveContentProjectRoot(path.join(projectRoot, outputRoot, "content", "runtime")),
            projectRoot,
        )
    }
})

test("CN bootstrap initializes the content snapshot before listening", () => {
    const source = fs.readFileSync(path.join(__dirname, "../src/cn-server.ts"), "utf8")
    const initializeIndex = source.indexOf("await initializeContentSnapshot()")
    const listenIndex = source.indexOf("await fastify.listen(")

    assert.ok(initializeIndex >= 0)
    assert.ok(listenIndex >= 0)
    assert.ok(initializeIndex < listenIndex)
    assert.doesNotMatch(source, /^await\s/m)
    assert.match(source, /fastify\.register\(cnAssetInTitlePlugin/)
    assert.match(source, /fastify\.register\(cnCdnFilesPlugin\)/)
    assert.doesNotMatch(source, /getCdnVersionInfo\(CDN_BASE_URL\)/)
    assert.doesNotMatch(source, /asset-patch\/active\/:file/)
    assert.doesNotMatch(source, /CDN_TOTAL_SIZE|ENTITY_LISTS_DIR/)
    const sessionIndex = source.indexOf("await startSessionServer()")
    assert.ok(sessionIndex >= 0)
    assert.ok(listenIndex < sessionIndex)
})
