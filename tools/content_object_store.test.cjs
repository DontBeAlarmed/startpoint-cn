"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { ContentObjectStore } = require("../src/content/sync/object-store")
const { canonicalJsonBuffer } = require("../src/content/sync/canonical-json")

const MISSING_DIGEST = `sha256:${"f".repeat(64)}`

function createFixture(t, prefix = "content-object-store-") {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    const contentStoreDir = path.join(sandbox, "store")
    const contentStateDir = path.join(sandbox, "state")
    t.after(() => fs.rmSync(sandbox, { force: true, recursive: true }))
    return {
        contentStateDir,
        contentStoreDir,
        sandbox,
        store: new ContentObjectStore({ contentStoreDir, contentStateDir }),
    }
}

function createDirectorySymlink(t, target, linkPath) {
    try {
        fs.symlinkSync(target, linkPath, "dir")
        return true
    } catch (error) {
        if (process.platform === "win32" && ["EACCES", "EPERM"].includes(error.code)) {
            t.skip("directory symlink creation is unavailable on this Windows host")
            return false
        }
        throw error
    }
}

function releasePath(contentStoreDir, manifest) {
    return path.join(
        contentStoreDir,
        "releases",
        `${manifest.assetVersion}-${manifest.releaseDigest.slice("sha256:".length)}`,
        "manifest.json",
    )
}

async function writeReleaseObjects(store, suffix = "one") {
    const table = await store.writeObject({ rows: [{ id: 1, name: "shared" }] })
    const catalog = await store.writeObject({ targetVersion: "1.4.55" })
    const summary = await store.writeObject({ release: suffix })
    return { catalog, summary, table }
}

function releaseInput(objects, overrides = {}) {
    return {
        schemaVersion: 1,
        assetVersion: "1.4.55",
        runtimeSchemaVersion: 1,
        generatorVersion: 1,
        tables: {
            "character.json": {
                object: objects.table,
                scope: "cdn",
                converterId: "character",
                converterVersion: 1,
                sources: ["orderedmap/character/character.json"],
            },
        },
        catalog: { object: objects.catalog },
        summary: { object: objects.summary },
        ...overrides,
    }
}

async function writeManyObjectRelease(store, tableCount = 20) {
    const tables = {}
    const digests = []
    for (let index = 0; index < tableCount; index++) {
        const tableName = `table-${index}.json`
        const object = await store.writeObject({ index })
        digests.push(object)
        tables[tableName] = {
            object,
            scope: "bundled",
            converterId: "bundled-json",
            converterVersion: 1,
            sources: [`assets/${tableName}`],
        }
    }
    const catalog = await store.writeObject({ targetVersion: "1.4.55" })
    const summary = await store.writeObject({ tables: tableCount })
    digests.push(catalog, summary)
    const manifest = await store.writeRelease({
        schemaVersion: 1,
        assetVersion: "1.4.55",
        runtimeSchemaVersion: 1,
        generatorVersion: 1,
        tables,
        catalog: { object: catalog },
        summary: { object: summary },
    })
    return { digests, manifest }
}

function listJsonFiles(directory) {
    if (!fs.existsSync(directory)) return []
    return fs.readdirSync(directory, { recursive: true })
        .filter(entry => entry.endsWith(".json"))
        .sort()
}

function listTemporaryFiles(directory) {
    if (!fs.existsSync(directory)) return []
    return fs.readdirSync(directory, { recursive: true })
        .filter(entry => entry.includes(".tmp-"))
        .sort()
}

test("canonical-equivalent objects share one physical file and reads are deeply frozen", async t => {
    const { contentStateDir, contentStoreDir, store } = createFixture(t)
    const first = await store.writeObject({ z: 2, a: { second: true, first: false } })
    const second = await store.writeObject({ a: { first: false, second: true }, z: 2 })

    assert.equal(first, second)
    assert.deepEqual(listJsonFiles(path.join(contentStoreDir, "objects")), [
        `${first.slice("sha256:".length)}.json`,
    ])
    assert.equal(fs.existsSync(contentStateDir), false)
    const value = await store.readObject(first)
    assert.deepEqual(value, { a: { first: false, second: true }, z: 2 })
    assert.ok(Object.isFrozen(value))
    assert.ok(Object.isFrozen(value.a))
    assert.throws(() => { value.a.first = true })
    assert.equal(store.directoryIdentities, undefined)
})

test("different releases reuse unchanged objects and manifests are deterministic", async t => {
    const { contentStoreDir, store } = createFixture(t)
    const firstObjects = await writeReleaseObjects(store, "first")
    const first = await store.writeRelease(releaseInput(firstObjects))
    const reordered = await store.writeRelease({
        ...releaseInput(firstObjects),
        tables: {
            "character.json": {
                sources: ["orderedmap/character/character.json"],
                converterVersion: 1,
                converterId: "character",
                scope: "cdn",
                object: firstObjects.table,
            },
        },
    })
    const secondSummary = await store.writeObject({ release: "second" })
    const second = await store.writeRelease(releaseInput({
        ...firstObjects,
        summary: secondSummary,
    }))

    assert.equal(first.releaseDigest, reordered.releaseDigest)
    assert.notEqual(first.releaseDigest, second.releaseDigest)
    assert.equal(listJsonFiles(path.join(contentStoreDir, "objects")).length, 4)
    assert.equal(listJsonFiles(path.join(contentStoreDir, "releases")).length, 2)
    assert.deepEqual(await store.readRelease(releasePath(contentStoreDir, first)), first)
})

test("current release snapshot reads each unique object once and preserves references", async t => {
    const { store } = createFixture(t)
    const objects = await writeReleaseObjects(store)
    const input = releaseInput(objects)
    input.tables["gacha.json"] = {
        ...input.tables["character.json"],
        converterId: "gacha",
    }
    const manifest = await store.writeRelease(input)
    await store.activate(manifest)

    const originalReadObject = store.readObject.bind(store)
    let objectReads = 0
    store.readObject = async digest => {
        objectReads++
        return originalReadObject(digest)
    }

    const snapshot = await store.readCurrentReleaseSnapshot()

    assert.equal(objectReads, 3)
    assert.strictEqual(
        snapshot.objects[manifest.tables["character.json"].object],
        snapshot.objects[manifest.tables["gacha.json"].object],
    )
    assert.deepEqual(snapshot.objects[objects.table], { rows: [{ id: 1, name: "shared" }] })
    assert.equal(Object.isFrozen(snapshot), true)
    assert.equal(Object.isFrozen(snapshot.objects), true)
})

test("release snapshot bounds unique object reads and reads each digest once", async t => {
    const { contentStoreDir, store } = createFixture(t)
    const { digests, manifest } = await writeManyObjectRelease(store)
    const readCounts = new Map()
    let active = 0
    let maxActive = 0
    store.readObject = async digest => {
        active++
        maxActive = Math.max(maxActive, active)
        readCounts.set(digest, (readCounts.get(digest) ?? 0) + 1)
        try {
            await new Promise(resolve => setImmediate(resolve))
            return { digest }
        } finally {
            active--
        }
    }

    const snapshot = await store.readReleaseSnapshot(releasePath(contentStoreDir, manifest))

    assert.ok(maxActive > 1)
    assert.ok(maxActive <= 8, `maximum object read concurrency was ${maxActive}`)
    assert.equal(active, 0)
    assert.equal(readCounts.size, digests.length)
    for (const digest of digests) assert.equal(readCounts.get(digest), 1)
    assert.deepEqual(Object.keys(snapshot.objects).sort(), [...digests].sort())
})

test("release snapshot waits for active object reads before rejecting", async t => {
    const { contentStoreDir, store } = createFixture(t)
    const { digests, manifest } = await writeManyObjectRelease(store)
    const failure = new Error("controlled object read failure")
    const failingDigest = digests[0]
    let active = 0
    let maxActive = 0
    store.readObject = async digest => {
        active++
        maxActive = Math.max(maxActive, active)
        try {
            if (digest === failingDigest) {
                await new Promise(resolve => setImmediate(resolve))
                throw failure
            }
            await new Promise(resolve => setTimeout(resolve, 20))
            return { digest }
        } finally {
            active--
        }
    }

    await assert.rejects(
        store.readReleaseSnapshot(releasePath(contentStoreDir, manifest)),
        error => error === failure,
    )
    assert.equal(active, 0)
    assert.ok(maxActive <= 8, `maximum object read concurrency was ${maxActive}`)
})

test("activate atomically switches current and a rename failure preserves the old pointer", async t => {
    const { contentStateDir, contentStoreDir, store } = createFixture(t)
    const first = await store.writeRelease(releaseInput(await writeReleaseObjects(store, "first")))
    const secondObjects = await writeReleaseObjects(store, "second")
    const second = await store.writeRelease(releaseInput(secondObjects, { assetVersion: "1.4.56" }))
    const oldCurrent = await store.activate(first)

    const failingStore = new ContentObjectStore({ contentStoreDir, contentStateDir }, {
        rename: async (source, destination) => {
            if (path.basename(destination) === "current.json") {
                const error = new Error("injected current rename failure")
                error.code = "EIO"
                throw error
            }
            await fs.promises.rename(source, destination)
        },
    })
    await assert.rejects(failingStore.activate(second), /injected current rename failure/)

    assert.deepEqual(await store.readCurrent(), oldCurrent)
    assert.equal(
        fs.readdirSync(contentStateDir).some(name => name.includes(".tmp-")),
        false,
    )
    assert.deepEqual(listTemporaryFiles(contentStoreDir), [])
})

test("a failed release write leaves no loadable manifest and never updates current", async t => {
    const { contentStateDir, contentStoreDir, store } = createFixture(t)
    const objects = await writeReleaseObjects(store)
    const failingStore = new ContentObjectStore({ contentStoreDir, contentStateDir }, {
        rename: async (source, destination) => {
            if (path.basename(destination) === "manifest.json") {
                const error = new Error("injected manifest rename failure")
                error.code = "EIO"
                throw error
            }
            await fs.promises.rename(source, destination)
        },
    })

    await assert.rejects(
        failingStore.writeRelease(releaseInput(objects)),
        /injected manifest rename failure/,
    )
    assert.deepEqual(listJsonFiles(path.join(contentStoreDir, "releases")), [])
    assert.deepEqual(listTemporaryFiles(contentStoreDir), [])
    assert.equal(fs.existsSync(contentStateDir), false)
    assert.equal(await store.readCurrent(), null)
})

test("readCurrent returns null only when absent and rejects corrupt or incomplete closures", async t => {
    const absent = createFixture(t, "content-current-absent-")
    assert.equal(await absent.store.readCurrent(), null)
    await assert.rejects(
        absent.store.readObject(MISSING_DIGEST),
        /content object is missing/,
    )
    await assert.rejects(
        absent.store.readRelease(`releases/1.4.55-${"e".repeat(64)}/manifest.json`),
        /release manifest is missing/,
    )

    const corrupt = createFixture(t, "content-current-corrupt-")
    fs.mkdirSync(corrupt.contentStateDir, { recursive: true })
    fs.writeFileSync(path.join(corrupt.contentStateDir, "current.json"), "not json\n")
    await assert.rejects(corrupt.store.readCurrent(), /current|JSON|canonical/i)

    const missingManifest = createFixture(t, "content-current-manifest-")
    const manifest = await missingManifest.store.writeRelease(
        releaseInput(await writeReleaseObjects(missingManifest.store)),
    )
    await missingManifest.store.activate(manifest)
    fs.unlinkSync(releasePath(missingManifest.contentStoreDir, manifest))
    await assert.rejects(missingManifest.store.readCurrent(), /manifest|ENOENT|missing/i)

    const missingObject = createFixture(t, "content-current-object-")
    const objects = await writeReleaseObjects(missingObject.store)
    const objectManifest = await missingObject.store.writeRelease(releaseInput(objects))
    await missingObject.store.activate(objectManifest)
    fs.unlinkSync(path.join(
        missingObject.contentStoreDir,
        "objects",
        `${objects.table.slice("sha256:".length)}.json`,
    ))
    await assert.rejects(missingObject.store.readCurrent(), /object|ENOENT|missing/i)
})

test("existing object corruption is rejected instead of overwritten", async t => {
    const { contentStoreDir, store } = createFixture(t)
    const value = { a: 1, nested: [true, false] }
    const digest = await store.writeObject(value)
    const objectPath = path.join(
        contentStoreDir,
        "objects",
        `${digest.slice("sha256:".length)}.json`,
    )
    fs.writeFileSync(objectPath, canonicalJsonBuffer({ corrupted: true }))

    await assert.rejects(store.readObject(digest), /digest|canonical|corrupt/i)
    await assert.rejects(store.writeObject(value), /digest|canonical|corrupt/i)
})

test("store root, state root, objects, releases, object files, and current reject symlinks", async t => {
    const rootFixture = createFixture(t, "content-root-link-")
    const outsideRoot = path.join(rootFixture.sandbox, "outside-root")
    fs.mkdirSync(outsideRoot)
    if (!createDirectorySymlink(t, outsideRoot, rootFixture.contentStoreDir)) return
    await assert.rejects(rootFixture.store.writeObject({ value: 1 }), /symlink/i)

    const stateRootFixture = createFixture(t, "content-state-root-link-")
    const stateManifest = await stateRootFixture.store.writeRelease(
        releaseInput(await writeReleaseObjects(stateRootFixture.store)),
    )
    const outsideStateRoot = path.join(stateRootFixture.sandbox, "outside-state-root")
    fs.mkdirSync(outsideStateRoot)
    if (!createDirectorySymlink(t, outsideStateRoot, stateRootFixture.contentStateDir)) return
    await assert.rejects(stateRootFixture.store.activate(stateManifest), /symlink/i)

    const objectsFixture = createFixture(t, "content-objects-link-")
    fs.mkdirSync(objectsFixture.contentStoreDir)
    const outsideObjects = path.join(objectsFixture.sandbox, "outside-objects")
    fs.mkdirSync(outsideObjects)
    if (!createDirectorySymlink(
        t,
        outsideObjects,
        path.join(objectsFixture.contentStoreDir, "objects"),
    )) return
    await assert.rejects(objectsFixture.store.writeObject({ value: 2 }), /symlink/i)

    const fileFixture = createFixture(t, "content-object-link-")
    const expectedDigest = await fileFixture.store.writeObject({ value: 3 })
    const expectedPath = path.join(
        fileFixture.contentStoreDir,
        "objects",
        `${expectedDigest.slice("sha256:".length)}.json`,
    )
    const outsideObject = path.join(fileFixture.sandbox, "outside-object.json")
    fs.writeFileSync(outsideObject, canonicalJsonBuffer({ value: 3 }))
    fs.unlinkSync(expectedPath)
    fs.symlinkSync(outsideObject, expectedPath)
    await assert.rejects(fileFixture.store.readObject(expectedDigest), /symlink/i)
    await assert.rejects(fileFixture.store.writeObject({ value: 3 }), /symlink/i)

    const releasesFixture = createFixture(t, "content-releases-link-")
    const releaseObjects = await writeReleaseObjects(releasesFixture.store)
    const outsideReleases = path.join(releasesFixture.sandbox, "outside-releases")
    fs.mkdirSync(outsideReleases)
    if (!createDirectorySymlink(
        t,
        outsideReleases,
        path.join(releasesFixture.contentStoreDir, "releases"),
    )) return
    await assert.rejects(
        releasesFixture.store.writeRelease(releaseInput(releaseObjects)),
        /symlink/i,
    )

    const currentFixture = createFixture(t, "content-current-link-")
    const currentManifest = await currentFixture.store.writeRelease(
        releaseInput(await writeReleaseObjects(currentFixture.store)),
    )
    const outsideCurrent = path.join(currentFixture.sandbox, "outside-current.json")
    fs.writeFileSync(outsideCurrent, canonicalJsonBuffer({
        schemaVersion: 1,
        assetVersion: currentManifest.assetVersion,
        release: `releases/${currentManifest.assetVersion}-${currentManifest.releaseDigest.slice(7)}/manifest.json`,
    }))
    fs.mkdirSync(currentFixture.contentStateDir)
    fs.symlinkSync(outsideCurrent, path.join(currentFixture.contentStateDir, "current.json"))
    await assert.rejects(currentFixture.store.readCurrent(), /symlink/i)
})

test("manifest and current persist only portable relative paths", async t => {
    const { contentStateDir, contentStoreDir, store } = createFixture(t)
    const manifest = await store.writeRelease(releaseInput(await writeReleaseObjects(store)))
    const current = await store.activate(manifest)
    const manifestBytes = fs.readFileSync(releasePath(contentStoreDir, manifest), "utf8")
    const currentBytes = fs.readFileSync(path.join(contentStateDir, "current.json"), "utf8")

    assert.equal(manifestBytes.includes(contentStoreDir), false)
    assert.equal(currentBytes.includes(contentStateDir), false)
    assert.equal(path.isAbsolute(current.release), false)
    assert.deepEqual(Object.keys(current).sort(), ["assetVersion", "release", "schemaVersion"])
})

test("writeRelease verifies every referenced object before publishing", async t => {
    const { contentStoreDir, store } = createFixture(t)
    const objects = await writeReleaseObjects(store)
    await assert.rejects(
        store.writeRelease(releaseInput({ ...objects, table: MISSING_DIGEST })),
        /object|ENOENT|missing/i,
    )
    assert.deepEqual(listJsonFiles(path.join(contentStoreDir, "releases")), [])
})

test("modern layout keeps immutable data in store and current state in state", async t => {
    const { contentStateDir, contentStoreDir, store } = createFixture(t)
    const manifest = await store.writeRelease(releaseInput(await writeReleaseObjects(store)))
    const current = await store.activate(manifest)

    assert.deepEqual(fs.readdirSync(contentStoreDir).sort(), ["objects", "releases"])
    assert.deepEqual(fs.readdirSync(contentStateDir), ["current.json"])
    assert.equal(current.release, `releases/${manifest.assetVersion}-${manifest.releaseDigest.slice(7)}/manifest.json`)
    assert.deepEqual(await store.readCurrentRelease(), { current, manifest })
})

test("read-only and missing modern roots can be inspected without writes", async t => {
    const fixture = createFixture(t, "content-read-only-")
    assert.equal(await fixture.store.readCurrent(), null)
    assert.equal(fs.existsSync(fixture.contentStoreDir), false)
    assert.equal(fs.existsSync(fixture.contentStateDir), false)

    const manifest = await fixture.store.writeRelease(
        releaseInput(await writeReleaseObjects(fixture.store)),
    )
    await fixture.store.activate(manifest)
    fs.chmodSync(fixture.contentStoreDir, 0o500)
    fs.chmodSync(fixture.contentStateDir, 0o500)
    try {
        assert.deepEqual(await fixture.store.readCurrentRelease(), {
            current: await fixture.store.readCurrent(),
            manifest,
        })
    } finally {
        fs.chmodSync(fixture.contentStoreDir, 0o700)
        fs.chmodSync(fixture.contentStateDir, 0o700)
    }
})

test("absolute release paths are accepted only beneath the store root", async t => {
    const { contentStateDir, contentStoreDir, sandbox, store } = createFixture(t)
    const manifest = await store.writeRelease(releaseInput(await writeReleaseObjects(store)))
    const absoluteManifest = releasePath(contentStoreDir, manifest)

    assert.deepEqual(await store.readRelease(absoluteManifest), manifest)
    await assert.rejects(
        store.readRelease(path.join(contentStateDir, path.relative(contentStoreDir, absoluteManifest))),
        /escapes.*store|invalid release manifest path/i,
    )
    await assert.rejects(
        store.readRelease(path.join(sandbox, "outside", "releases", path.basename(path.dirname(absoluteManifest)), "manifest.json")),
        /escapes.*store|invalid release manifest path/i,
    )
})

test("store and state roots cannot be replaced during a store lifetime", async t => {
    const storeFixture = createFixture(t, "content-store-replaced-")
    await storeFixture.store.writeObject({ first: true })
    fs.renameSync(storeFixture.contentStoreDir, `${storeFixture.contentStoreDir}-old`)
    fs.mkdirSync(storeFixture.contentStoreDir)
    await assert.rejects(storeFixture.store.writeObject({ second: true }), /replaced|changed/i)

    const stateFixture = createFixture(t, "content-state-replaced-")
    const manifest = await stateFixture.store.writeRelease(
        releaseInput(await writeReleaseObjects(stateFixture.store)),
    )
    await stateFixture.store.activate(manifest)
    fs.renameSync(stateFixture.contentStateDir, `${stateFixture.contentStateDir}-old`)
    fs.mkdirSync(stateFixture.contentStateDir)
    await assert.rejects(stateFixture.store.readCurrent(), /replaced|changed/i)
})

test("supports explicit legacy single-root construction and rejects ambiguous mixed roots", async t => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "content-legacy-store-"))
    const contentRootDir = path.join(sandbox, "legacy")
    t.after(() => fs.rmSync(sandbox, { force: true, recursive: true }))
    const store = new ContentObjectStore({ contentRootDir })
    const manifest = await store.writeRelease(releaseInput(await writeReleaseObjects(store)))
    await store.activate(manifest)

    assert.deepEqual(fs.readdirSync(contentRootDir).sort(), ["current.json", "objects", "releases"])
    assert.throws(
        () => new ContentObjectStore({
            contentRootDir,
            contentStoreDir: path.join(sandbox, "store"),
            contentStateDir: path.join(sandbox, "state"),
        }),
        /contentRootDir.*contentStoreDir|legacy.*split|ambiguous/i,
    )
    assert.throws(
        () => new ContentObjectStore({
            layout: "legacy",
            contentRootDir,
            contentStoreDir: contentRootDir,
            contentStateDir: contentRootDir,
        }),
        /legacy.*split|complete ContentPaths/i,
    )
})

test("rejects equal or nested split roots after resolving paths", async t => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "content-split-conflict-"))
    t.after(() => fs.rmSync(sandbox, { force: true, recursive: true }))
    const expectedMessage = "contentStoreDir and contentStateDir must not be equal or nested"
    const cases = [
        [
            "equal",
            path.join(sandbox, "shared"),
            path.join(sandbox, "nested", "..", "shared"),
        ],
        [
            "state nested in store",
            path.join(sandbox, "store"),
            path.join(sandbox, "store", "state"),
        ],
        [
            "store nested in state",
            path.join(sandbox, "state", "store"),
            path.join(sandbox, "state"),
        ],
    ]

    for (const [name, contentStoreDir, contentStateDir] of cases) {
        await t.test(name, () => {
            assert.throws(
                () => new ContentObjectStore({ contentStoreDir, contentStateDir }),
                error => error instanceof TypeError
                    && error.message === expectedMessage,
            )
        })
    }
    assert.deepEqual(fs.readdirSync(sandbox), [])
})

test("rejects physically equal or nested split roots through symlink ancestors", async t => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "content-physical-conflict-"))
    const physicalRoot = path.join(sandbox, "physical")
    const aliasRoot = path.join(sandbox, "alias")
    fs.mkdirSync(physicalRoot)
    t.after(() => fs.rmSync(sandbox, { force: true, recursive: true }))
    if (!createDirectorySymlink(t, physicalRoot, aliasRoot)) return
    const expectedMessage = "contentStoreDir and contentStateDir must not be equal or nested"

    await t.test("same physical root with missing tails", () => {
        assert.throws(
            () => new ContentObjectStore({
                contentStoreDir: path.join(physicalRoot, "future", "content"),
                contentStateDir: path.join(aliasRoot, "future", "content"),
            }),
            error => error instanceof TypeError && error.message === expectedMessage,
        )
    })
    await t.test("physically nested roots with missing tails", () => {
        assert.throws(
            () => new ContentObjectStore({
                contentStoreDir: path.join(physicalRoot, "future", "content"),
                contentStateDir: path.join(aliasRoot, "future", "content", "state"),
            }),
            error => error instanceof TypeError && error.message === expectedMessage,
        )
    })

    const legacyRoot = path.join(aliasRoot, "legacy")
    const legacyStore = new ContentObjectStore({ contentRootDir: legacyRoot })
    const digest = await legacyStore.writeObject({ legacy: true })
    assert.equal(fs.existsSync(path.join(
        physicalRoot,
        "legacy",
        "objects",
        `${digest.slice("sha256:".length)}.json`,
    )), true)
})

test("rejects split roots containing a dangling symlink", t => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "content-dangling-root-"))
    const missingTarget = path.join(sandbox, "missing-target")
    const danglingRoot = path.join(sandbox, "dangling")
    t.after(() => fs.rmSync(sandbox, { force: true, recursive: true }))
    if (!createDirectorySymlink(t, missingTarget, danglingRoot)) return

    assert.throws(
        () => new ContentObjectStore({
            contentStoreDir: path.join(danglingRoot, "store"),
            contentStateDir: path.join(sandbox, "state"),
        }),
        error => error instanceof TypeError
            && error.message === `contentStoreDir contains a dangling symbolic link: ${danglingRoot}`,
    )
    assert.equal(fs.existsSync(missingTarget), false)
})

test("accepts complete legacy ContentPaths as one readable root", async t => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "content-complete-legacy-"))
    const contentRootDir = path.join(sandbox, "legacy")
    const paths = {
        layout: "legacy",
        cdnDir: path.join(sandbox, "cdn"),
        cdnRoot: path.join(sandbox, "cdn", "cn"),
        contentRootDir,
        contentStoreDir: contentRootDir,
        contentStateDir: contentRootDir,
        contentRuntimeDir: path.join(sandbox, "runtime"),
    }
    t.after(() => fs.rmSync(sandbox, { force: true, recursive: true }))
    const store = new ContentObjectStore(paths)
    const manifest = await store.writeRelease(releaseInput(await writeReleaseObjects(store)))
    const current = await store.activate(manifest)

    assert.deepEqual(fs.readdirSync(contentRootDir).sort(), ["current.json", "objects", "releases"])
    assert.deepEqual(await store.readCurrentRelease(), { current, manifest })
})
