"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { deepFreeze } = require("../src/content/deep-freeze")
const {
    CdnCatalogLoader,
    CatalogLoaderError,
    resolveCatalogProjectRoot,
} = require("../src/content/cdn/catalog-loader")
const {
    CdnRuntimeFileError,
    createCdnRuntimeManifest,
    serializeCdnRuntimeManifest,
} = require("../src/content/cdn/runtime-manifest")
const {
    ContentSnapshotError,
    ContentSnapshotProvider,
    ContentSnapshotSourcesError,
    productionContentSnapshotProvider,
    resolveContentProjectRoot,
} = require("../src/content/runtime/content-snapshot")

const fixtureRoot = path.join(__dirname, "fixtures/cdn-catalog")
const DIGEST = "a".repeat(64)
const runtimeArchiveDefinitions = [
    {
        kind: "full",
        fromVersion: null,
        toVersion: "1.4.0",
        layer: "common",
        relativePath: "archive-common-full/pinball-1.4.0-1-abcd.zip",
    },
    {
        kind: "full",
        fromVersion: null,
        toVersion: "1.4.0",
        layer: "quality",
        relativePath: "archive-medium-full/pinball-1.4.0-1-abcd.zip",
    },
    {
        kind: "full",
        fromVersion: null,
        toVersion: "1.4.0",
        layer: "platform",
        relativePath: "archive-android-full/pinball-1.4.0-1-abcd.zip",
    },
    {
        kind: "diff",
        fromVersion: "1.4.0",
        toVersion: "1.4.54",
        layer: "common",
        relativePath: "archive-common-diff/pinball-1.4.0-1.4.1-1-abcd.zip",
    },
    {
        kind: "diff",
        fromVersion: "1.4.0",
        toVersion: "1.4.54",
        layer: "quality",
        relativePath: "archive-medium-diff/pinball-1.4.0-1.4.1-1-abcd.zip",
    },
    {
        kind: "diff",
        fromVersion: "1.4.0",
        toVersion: "1.4.54",
        layer: "platform",
        relativePath: "archive-android-diff/pinball-1.4.0-1.4.1-1-abcd.zip",
    },
]

function runtimeManifest(sizeFor = () => 10, entityListsBytes = 127) {
    const input = {
        archives: runtimeArchiveDefinitions.map(definition => ({
            ...definition,
            platform: "android",
            order: 1,
            compressedBytes: sizeFor(definition.relativePath),
            sha256: DIGEST,
        })),
        installedBytes: 30,
        entityListsRelativePath: "EntityLists/fixture-android_medium.csv",
    }
    return createCdnRuntimeManifest(input, {
        relativePath: input.entityListsRelativePath,
        compressedBytes: entityListsBytes,
        sha256: DIGEST,
    })
}

function writeRuntimeManifest(projectRoot, manifest = runtimeManifest(
    relativePath => fs.statSync(path.join(projectRoot, ".cdn", "cn", relativePath)).size,
    fs.statSync(path.join(
        projectRoot,
        ".cdn",
        "cn",
        "EntityLists/fixture-android_medium.csv",
    )).size,
)) {
    const manifestDirectory = path.join(projectRoot, "assets", "cdn")
    fs.mkdirSync(manifestDirectory, { recursive: true })
    fs.writeFileSync(
        path.join(manifestDirectory, "catalog-cn-1.4.54.json"),
        serializeCdnRuntimeManifest(manifest),
    )
}

function writePatchManifest(projectRoot, patches = []) {
    const manifestDirectory = path.join(projectRoot, "assets", "asset-patch")
    fs.mkdirSync(manifestDirectory, { recursive: true })
    fs.writeFileSync(
        path.join(manifestDirectory, "manifest.json"),
        JSON.stringify({ cdn_version: "1.4.54", patches }),
    )
}

function createProject(t) {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cdn-provider-"))
    fs.mkdirSync(path.join(projectRoot, ".cdn"), { recursive: true })
    fs.cpSync(fixtureRoot, path.join(projectRoot, ".cdn", "cn"), { recursive: true })
    writeRuntimeManifest(projectRoot)
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

function injectedLoader({ read, build }) {
    let candidateInput
    return new CdnCatalogLoader({
        projectRoot: path.resolve("/synthetic-project"),
        env: {},
        dependencies: {
            resolvePaths: () => ({ cdnRoot: "/synthetic-cdn" }),
            createStore: () => ({ readCurrentReleaseSnapshot: () => null }),
            readRuntimeManifest: async manifestPath => {
                candidateInput = await read(manifestPath)
                return runtimeManifest()
            },
            validateRuntimeFiles: async () => {},
            build: input => build(candidateInput, input),
            readPatchManifest: async () => ({ cdn_version: "1.4.1", patches: [] }),
        },
    })
}

function patch(overrides = {}) {
    return {
        id: "fixture-patch",
        type: "patch",
        name: "fixture patch",
        version: "1.4.54",
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

function repository(source = "bundled") {
    const metadata = {
        source,
        assetVersion: source === "bundled" ? "1.4.54" : "1.4.55",
        generatorVersion: 1,
        releaseDigest: source === "bundled" ? null : `sha256:${"b".repeat(64)}`,
    }
    return {
        metadata,
        info() {
            return this.metadata
        },
        table(tableName) {
            if (tableName !== "fixture.json") throw new Error(`not registered: ${tableName}`)
            return this.fixture
        },
        fixture: { nested: { value: 1 } },
    }
}

function snapshotProvider(catalogSource, repositorySource = { load: async () => repository() }) {
    return new ContentSnapshotProvider({ catalogSource, repositorySource })
}

function causeContainsPath(value, sensitivePaths, seen = new Set()) {
    if (typeof value === "string") {
        return sensitivePaths.some(sensitivePath => value.includes(sensitivePath))
    }
    if (!value || typeof value !== "object" || seen.has(value)) return false
    seen.add(value)
    return [value.message, value.path, value.cause]
        .some(nested => causeContainsPath(nested, sensitivePaths, seen))
}

function isRedactedRuntimeManifestError(error, code, sensitivePaths) {
    assert.equal(error instanceof CatalogLoaderError, true)
    assert.equal(error.code, code)
    assert.equal(causeContainsPath(error.cause, sensitivePaths), false)
    assert.equal(error.cause, undefined)
    return true
}

test("default loader uses the trusted manifest without ZIP reads or runtime state", async t => {
    const projectRoot = createProject(t)
    const contentStateDir = path.join(projectRoot, "missing-content-state")
    const digestCachePath = path.join(contentStateDir, "cdn-digest-cache.json")
    const originalOpen = fs.promises.open
    let zipOpens = 0
    t.mock.method(fs.promises, "open", async (filePath, ...args) => {
        if (String(filePath).endsWith(".zip")) {
            zipOpens++
            throw new Error("ZIP content must not be opened by the runtime loader")
        }
        return originalOpen.call(fs.promises, filePath, ...args)
    })
    const loader = new CdnCatalogLoader({
        projectRoot,
        env: { CONTENT_STATE_DIR: contentStateDir },
    })

    assert.equal(fs.existsSync(contentStateDir), false)
    assert.equal(fs.existsSync(digestCachePath), false)

    const first = await loader.load()
    const second = await loader.load()

    assert.strictEqual(second, first)
    assert.strictEqual(loader.get(), first)
    assert.equal(first.targetVersion, "1.4.54")
    assert.equal(first.installedBytes, 30)
    assert.equal(Object.isFrozen(first), true)
    assert.equal(Object.isFrozen(first.edges), true)
    assert.equal(Object.isFrozen(first.edges[0]), true)
    assert.equal(Object.isFrozen(first.edges[0].archives), true)
    assert.equal(Object.isFrozen(first.edges[0].archives[0]), true)
    assert.equal(zipOpens, 0)
    assert.equal(fs.existsSync(contentStateDir), false)
    assert.equal(fs.existsSync(digestCachePath), false)
})

test("loader reads the fixed trusted manifest path before validating runtime files", async t => {
    const projectRoot = createProject(t)
    const expectedManifestPath = path.join(
        projectRoot,
        "assets",
        "cdn",
        "catalog-cn-1.4.54.json",
    )
    const calls = []
    const loader = new CdnCatalogLoader({
        projectRoot,
        env: {},
        dependencies: {
            readRuntimeManifest: async manifestPath => {
                calls.push(["read", manifestPath])
                return runtimeManifest()
            },
            validateRuntimeFiles: async (manifest, paths) => {
                calls.push(["validate", manifest.baseline, paths.cdnRoot])
            },
        },
    })

    assert.equal((await loader.load()).targetVersion, "1.4.54")
    assert.deepEqual(calls, [
        ["read", expectedManifestPath],
        ["validate", "cn-1.4.54", path.join(projectRoot, ".cdn", "cn")],
    ])
})

test("default loader rejects missing and wrong-size referenced archives", async t => {
    const missingRoot = createProject(t)
    const relativePath = "archive-android-diff/pinball-1.4.0-1.4.1-1-abcd.zip"
    fs.unlinkSync(path.join(
        missingRoot,
        ".cdn/cn",
        relativePath,
    ))
    await assert.rejects(
        new CdnCatalogLoader({ projectRoot: missingRoot, env: {} }).load(),
        error => (
            error instanceof CdnRuntimeFileError
            && error.code === "RUNTIME_FILE_MISSING"
            && error.message.includes(relativePath)
            && !error.message.includes(missingRoot)
        ),
    )

    const wrongSizeRoot = createProject(t)
    fs.appendFileSync(path.join(wrongSizeRoot, ".cdn", "cn", relativePath), "tampered")
    await assert.rejects(
        new CdnCatalogLoader({ projectRoot: wrongSizeRoot, env: {} }).load(),
        error => (
            error instanceof CdnRuntimeFileError
            && error.code === "RUNTIME_FILE_SIZE"
            && error.message.includes(relativePath)
            && !error.message.includes(wrongSizeRoot)
        ),
    )
})

test("concurrent initial loads share one manifest read and get fails clearly before initialization", async () => {
    let reads = 0
    let releaseRead
    const loader = injectedLoader({
        read: () => {
            reads++
            return new Promise(resolve => { releaseRead = resolve })
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
    assert.equal(reads, 1)

    releaseRead({ targetVersion: "1.4.1" })
    const [first, second] = await Promise.all([firstLoad, secondLoad])
    assert.strictEqual(second, first)
    assert.strictEqual(loader.get(), first)
    assert.strictEqual(await loader.load(), first)
    assert.equal(reads, 1)
})

test("load then reload linearizes candidates in call order", async () => {
    const firstCandidate = deferred()
    const secondCandidate = deferred()
    let reads = 0
    const loader = injectedLoader({
        read: () => (++reads === 1 ? firstCandidate.promise : secondCandidate.promise),
        build: input => catalog(input.targetVersion),
    })

    const initialLoad = loader.load()
    const reload = loader.reload()
    assert.equal(reads, 1)

    firstCandidate.resolve({ targetVersion: "1.4.1" })
    const initial = await initialLoad
    assert.equal(initial.targetVersion, "1.4.1")
    assert.equal(reads, 2)

    secondCandidate.resolve({ targetVersion: "1.4.2" })
    const replacement = await reload
    assert.equal(replacement.targetVersion, "1.4.2")
    assert.strictEqual(loader.get(), replacement)
})

test("reload then load linearizes candidates in call order without stale overwrite", async () => {
    const firstCandidate = deferred()
    const secondCandidate = deferred()
    const secondStarted = deferred()
    let reads = 0
    const loader = injectedLoader({
        read: () => {
            reads++
            if (reads === 1) return firstCandidate.promise
            secondStarted.resolve()
            return secondCandidate.promise
        },
        build: input => catalog(input.targetVersion),
    })

    const reload = loader.reload()
    const load = loader.load()
    assert.equal(reads, 1)

    firstCandidate.resolve({ targetVersion: "1.4.1" })
    const first = await reload
    assert.equal(first.targetVersion, "1.4.1")
    await secondStarted.promise
    assert.equal(reads, 2)

    secondCandidate.resolve({ targetVersion: "1.4.2" })
    const second = await load
    assert.equal(second.targetVersion, "1.4.2")
    assert.strictEqual(loader.get(), second)
})

test("failed initial load leaves no catalog and can be retried", async () => {
    let reads = 0
    const loader = injectedLoader({
        read: async () => {
            reads++
            if (reads === 1) throw new Error("initial candidate rejected")
            return { targetVersion: "1.4.1" }
        },
        build: input => catalog(input.targetVersion),
    })

    await assert.rejects(
        loader.load(),
        error => error instanceof CatalogLoaderError && error.code === "RUNTIME_MANIFEST_READ",
    )
    assert.throws(
        () => loader.get(),
        error => error instanceof CatalogLoaderError && error.code === "CATALOG_NOT_LOADED",
    )
    assert.equal((await loader.load()).targetVersion, "1.4.1")
    assert.equal(reads, 2)
})

test("loader recursively freezes children of an already frozen catalog root", async () => {
    const shallow = shallowFrozenCatalog()
    const loader = injectedLoader({
        read: async () => ({}),
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
    let reads = 0
    const loader = injectedLoader({
        read: async () => {
            const candidate = candidates[reads++]
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

    await assert.rejects(
        loader.reload(),
        error => error instanceof CatalogLoaderError && error.code === "RUNTIME_MANIFEST_READ",
    )
    assert.strictEqual(loader.get(), replacement)
    assert.equal(reads, 3)
})

test("a failed reload does not lock the queue and a queued success becomes cache", async () => {
    const failedCandidate = deferred()
    const successfulCandidate = deferred()
    const successStarted = deferred()
    let reads = 0
    const loader = injectedLoader({
        read: () => {
            reads++
            if (reads === 1) return Promise.resolve({ targetVersion: "1.4.1" })
            if (reads === 2) return failedCandidate.promise
            successStarted.resolve()
            return successfulCandidate.promise
        },
        build: input => catalog(input.targetVersion),
    })
    const initial = await loader.load()
    const failedReload = loader.reload()
    const successfulReload = loader.reload()
    assert.equal(reads, 2)

    failedCandidate.reject(new Error("queued candidate rejected"))
    await assert.rejects(
        failedReload,
        error => error instanceof CatalogLoaderError && error.code === "RUNTIME_MANIFEST_READ",
    )
    await successStarted.promise
    assert.equal(reads, 3)
    assert.strictEqual(loader.get(), initial)

    successfulCandidate.resolve({ targetVersion: "1.4.2" })
    const replacement = await successfulReload
    assert.equal(replacement.targetVersion, "1.4.2")
    assert.strictEqual(loader.get(), replacement)
})

test("concurrent reloads build serial candidates and publish in call order", async () => {
    let reads = 0
    let releaseFirstReload
    const loader = injectedLoader({
        read: () => {
            reads++
            if (reads === 1) return Promise.resolve({ targetVersion: "1.4.1" })
            if (reads === 2) {
                return new Promise(resolve => { releaseFirstReload = resolve })
            }
            return Promise.resolve({ targetVersion: "1.4.3" })
        },
        build: input => catalog(input.targetVersion),
    })
    await loader.load()

    const firstReload = loader.reload()
    const secondReload = loader.reload()
    assert.equal(reads, 2)
    releaseFirstReload({ targetVersion: "1.4.2" })
    assert.equal((await firstReload).targetVersion, "1.4.2")
    assert.equal((await secondReload).targetVersion, "1.4.3")
    assert.equal(reads, 3)
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
    assert.equal((await loader.load()).targetVersion, "1.4.54")

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
    assert.equal(loaded.targetVersion, "1.4.54")
})

test("the repository disabled patch manifest preserves the 1.4.54 catalog baseline", async () => {
    const loader = new CdnCatalogLoader({
        projectRoot: path.join(__dirname, ".."),
        env: {},
        dependencies: {
            resolvePaths: () => ({ cdnRoot: "/unused-cdn-root" }),
            createStore: () => ({ readCurrentReleaseSnapshot: () => null }),
            validateRuntimeFiles: async () => {},
        },
    })

    assert.equal((await loader.load()).targetVersion, "1.4.54")
})

test("runtime manifest read, JSON, and schema failures use stable loader errors", async t => {
    const missingRoot = createProject(t)
    const missingManifestPath = path.join(missingRoot, "assets/cdn/catalog-cn-1.4.54.json")
    fs.unlinkSync(missingManifestPath)
    await assert.rejects(
        new CdnCatalogLoader({ projectRoot: missingRoot, env: {} }).load(),
        error => isRedactedRuntimeManifestError(
            error,
            "RUNTIME_MANIFEST_READ",
            [missingRoot, missingManifestPath],
        ),
    )

    const invalidJsonRoot = createProject(t)
    fs.writeFileSync(path.join(invalidJsonRoot, "assets/cdn/catalog-cn-1.4.54.json"), "{")
    await assert.rejects(
        new CdnCatalogLoader({ projectRoot: invalidJsonRoot, env: {} }).load(),
        error => isRedactedRuntimeManifestError(
            error,
            "RUNTIME_MANIFEST_SCHEMA",
            [invalidJsonRoot],
        ),
    )

    const invalidSchemaRoot = createProject(t)
    fs.writeFileSync(
        path.join(invalidSchemaRoot, "assets/cdn/catalog-cn-1.4.54.json"),
        JSON.stringify({ schemaVersion: 2 }),
    )
    await assert.rejects(
        new CdnCatalogLoader({ projectRoot: invalidSchemaRoot, env: {} }).load(),
        error => isRedactedRuntimeManifestError(
            error,
            "RUNTIME_MANIFEST_SCHEMA",
            [invalidSchemaRoot],
        ),
    )
})

test("injected runtime manifest read failures redact nested absolute paths", async () => {
    const projectRoot = path.resolve("/private/injected-runtime-project")
    const manifestPath = path.join(projectRoot, "assets/cdn/catalog-cn-1.4.54.json")
    const nestedCause = Object.assign(
        new Error(`nested read failure for ${projectRoot}`),
        { path: manifestPath },
    )
    const injectedError = Object.assign(
        new Error(`cannot read ${manifestPath}`),
        { path: manifestPath, cause: nestedCause },
    )
    const loader = new CdnCatalogLoader({
        projectRoot,
        env: {},
        dependencies: {
            resolvePaths: () => ({ cdnRoot: "/unused-cdn-root" }),
            createStore: () => ({ readCurrentReleaseSnapshot: () => null }),
            readRuntimeManifest: async () => { throw injectedError },
        },
    })

    await assert.rejects(
        loader.load(),
        error => isRedactedRuntimeManifestError(
            error,
            "RUNTIME_MANIFEST_READ",
            [projectRoot, manifestPath],
        ),
    )
})

test("patch manifest schema failures use a stable diagnostic loader error", async t => {
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
    let reads = 0
    const loader = injectedLoader({
        read: async () => ({ targetVersion: candidates[reads++] }),
        build: input => catalog(input.targetVersion),
    })
    const contentRepository = repository("release")
    const provider = snapshotProvider(loader, { load: async () => contentRepository })

    assert.throws(
        () => provider.get(),
        error => error instanceof ContentSnapshotError && error.code === "CONTENT_SNAPSHOT_NOT_INITIALIZED",
    )
    const first = await provider.initialize()
    const second = await provider.initialize()
    assert.strictEqual(second, first)
    assert.strictEqual(provider.get(), first)
    assert.strictEqual(first.cdn, loader.get())
    assert.strictEqual(first.repository, contentRepository)
    assert.equal(Object.isFrozen(first), true)
    assert.equal(Object.isFrozen(first.cdn), true)
    assert.equal(Object.isFrozen(first.repository), true)
    assert.equal(Object.isFrozen(first.repository.info()), true)

    const replacement = await loader.reload()
    assert.equal(replacement.targetVersion, "1.4.2")
    assert.strictEqual(provider.get(), first)
    assert.equal(provider.get().cdn.targetVersion, "1.4.1")

    const candidateRepository = repository("release")
    const candidateProvider = snapshotProvider(loader, {
        load: async () => candidateRepository,
    })
    const candidateSnapshot = await candidateProvider.initialize()
    assert.strictEqual(candidateSnapshot.cdn, replacement)
    assert.strictEqual(candidateSnapshot.repository, candidateRepository)
    assert.equal(candidateSnapshot.cdn.targetVersion, "1.4.2")
})

test("concurrent snapshot initialization loads once and returns one snapshot object", async () => {
    const candidate = deferred()
    const repositoryCandidate = deferred()
    let catalogLoads = 0
    let repositoryLoads = 0
    const provider = snapshotProvider({
        load: () => {
            catalogLoads++
            return candidate.promise
        },
    }, {
        load: () => {
            repositoryLoads++
            return repositoryCandidate.promise
        },
    })

    const firstInitialization = provider.initialize()
    const secondInitialization = provider.initialize()
    assert.strictEqual(secondInitialization, firstInitialization)
    assert.equal(catalogLoads, 1)
    assert.equal(repositoryLoads, 1)

    candidate.resolve(catalog("1.4.1"))
    const contentRepository = repository()
    repositoryCandidate.resolve(contentRepository)
    const [first, second] = await Promise.all([firstInitialization, secondInitialization])
    assert.strictEqual(second, first)
    assert.strictEqual(provider.get(), first)
    assert.strictEqual(first.repository, contentRepository)
    assert.equal(catalogLoads, 1)
    assert.equal(repositoryLoads, 1)
})

test("failed snapshot initialization leaves no partial state and can be retried safely", async () => {
    let attempts = 0
    const expected = catalog("1.4.1")
    const expectedRepository = repository()
    const provider = snapshotProvider({ load: async () => expected }, {
        load: async () => {
            attempts++
            if (attempts === 1) throw new Error("initial repository failed")
            return expectedRepository
        },
    })

    await assert.rejects(provider.initialize(), /initial repository failed/)
    assert.throws(
        () => provider.get(),
        error => error instanceof ContentSnapshotError && error.code === "CONTENT_SNAPSHOT_NOT_INITIALIZED",
    )
    const snapshot = await provider.initialize()
    assert.strictEqual(snapshot.cdn, expected)
    assert.strictEqual(snapshot.repository, expectedRepository)
    assert.equal(Object.isFrozen(expected), true)
    assert.equal(attempts, 2)
})

test("snapshot waits for both sources to settle before rejecting or allowing retry", async () => {
    const catalogCandidate = deferred()
    const repositoryCandidate = deferred()
    const catalogFailure = new Error("catalog rejected first")
    let catalogLoads = 0
    let repositoryLoads = 0
    const provider = snapshotProvider({
        load: () => (++catalogLoads === 1
            ? catalogCandidate.promise
            : Promise.resolve(catalog("1.4.2"))),
    }, {
        load: () => (++repositoryLoads === 1
            ? repositoryCandidate.promise
            : Promise.resolve(repository("release"))),
    })

    const initialization = provider.initialize()
    let initializationSettled = false
    void initialization.then(
        () => { initializationSettled = true },
        () => { initializationSettled = true },
    )
    catalogCandidate.reject(catalogFailure)
    await new Promise(resolve => setImmediate(resolve))

    assert.equal(initializationSettled, false)
    assert.strictEqual(provider.initialize(), initialization)
    assert.equal(catalogLoads, 1)
    assert.equal(repositoryLoads, 1)

    repositoryCandidate.resolve(repository())
    await assert.rejects(initialization, error => error === catalogFailure)

    const retried = await provider.initialize()
    assert.equal(retried.cdn.targetVersion, "1.4.2")
    assert.equal(catalogLoads, 2)
    assert.equal(repositoryLoads, 2)
})

test("snapshot preserves both source diagnostics when both loads fail", async () => {
    const catalogFailure = new Error("catalog failed")
    const repositoryFailure = new Error("repository failed")
    const provider = snapshotProvider(
        { load: async () => { throw catalogFailure } },
        { load: async () => { throw repositoryFailure } },
    )

    await assert.rejects(
        provider.initialize(),
        error => (
            error instanceof ContentSnapshotSourcesError
            && Object.isFrozen(error.errors)
            && error.errors[0] === catalogFailure
            && error.errors[1] === repositoryFailure
        ),
    )
})

test("snapshot recursively freezes children of an already frozen catalog root", async () => {
    const shallow = shallowFrozenCatalog()
    const contentRepository = repository()
    const provider = snapshotProvider(
        { load: async () => shallow },
        { load: async () => contentRepository },
    )

    const snapshot = await provider.initialize()
    assert.strictEqual(snapshot.cdn, shallow)
    assert.equal(Object.isFrozen(snapshot), true)
    assert.equal(Object.isFrozen(snapshot.cdn.edges), true)
    assert.equal(Object.isFrozen(snapshot.cdn.edges[0]), true)
    assert.equal(Object.isFrozen(snapshot.cdn.edges[0].archives), true)
    assert.equal(Object.isFrozen(snapshot.cdn.edges[0].archives[0]), true)
    assert.equal(Object.isFrozen(snapshot.repository.fixture), true)
    assert.equal(Object.isFrozen(snapshot.repository.fixture.nested), true)
    assert.throws(() => snapshot.cdn.edges[0].archives.push({}), TypeError)
})

test("legacy version facade derives every runtime version from the pinned snapshot", t => {
    const previousSnapshot = productionContentSnapshotProvider.snapshot
    productionContentSnapshotProvider.snapshot = Object.freeze({
        cdn: catalog("1.4.1"),
        repository: repository(),
    })
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

test("runtime catalog loader source no longer references CDN scanning or digest dependencies", () => {
    const source = fs.readFileSync(path.join(
        __dirname,
        "../src/content/cdn/catalog-loader.ts",
    ), "utf8")

    assert.doesNotMatch(source, /scanCdnCatalogInput|ScanCdnCatalogDependencies|scanDependencies/)
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
    const initializeIndex = source.indexOf("await initializeContentSnapshot({")
    const listenIndex = source.indexOf("await fastify.listen(")

    assert.ok(initializeIndex >= 0)
    assert.ok(listenIndex >= 0)
    assert.ok(initializeIndex < listenIndex)
    assert.doesNotMatch(source, /^await\s/m)
    assert.match(source, /registerCnAssetProviderRoutes\(fastify/)
    assert.doesNotMatch(source, /fastify\.register\(cnCdnFilesPlugin\)/)
    assert.doesNotMatch(source, /getCdnVersionInfo\(CDN_BASE_URL\)/)
    assert.doesNotMatch(source, /asset-patch\/active\/:file/)
    assert.doesNotMatch(source, /CDN_TOTAL_SIZE|ENTITY_LISTS_DIR/)
    const sessionIndex = source.indexOf("await startSessionServer()")
    assert.ok(sessionIndex >= 0)
    assert.ok(listenIndex < sessionIndex)
})

test("legacy bootstrap initializes the content snapshot before listening and exits on failure", () => {
    const source = fs.readFileSync(path.join(__dirname, "../src/server.ts"), "utf8")
    const initializeIndex = source.indexOf("await initializeContentSnapshot()")
    const listenIndex = source.indexOf("await fastify.listen(")

    assert.match(source, /import \{ initializeContentSnapshot \} from ["']\.\/content\/runtime\/content-snapshot["']/)
    assert.ok(initializeIndex >= 0)
    assert.ok(listenIndex >= 0)
    assert.ok(initializeIndex < listenIndex)
    assert.doesNotMatch(source, /^await\s/m)
    assert.match(source, /async function bootstrap\(\): Promise<void>/)
    assert.match(source, /void bootstrap\(\)\.catch\(error => \{[\s\S]*console\.error\(error\)[\s\S]*process\.exit\(1\)/)
})
