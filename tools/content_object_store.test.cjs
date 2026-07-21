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
    const contentRootDir = path.join(sandbox, ".content")
    t.after(() => fs.rmSync(sandbox, { force: true, recursive: true }))
    return {
        contentRootDir,
        sandbox,
        store: new ContentObjectStore({ contentRootDir }),
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

function releasePath(contentRootDir, manifest) {
    return path.join(
        contentRootDir,
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
    const { contentRootDir, store } = createFixture(t)
    const first = await store.writeObject({ z: 2, a: { second: true, first: false } })
    const second = await store.writeObject({ a: { first: false, second: true }, z: 2 })

    assert.equal(first, second)
    assert.deepEqual(listJsonFiles(path.join(contentRootDir, "objects")), [
        `${first.slice("sha256:".length)}.json`,
    ])
    const value = await store.readObject(first)
    assert.deepEqual(value, { a: { first: false, second: true }, z: 2 })
    assert.ok(Object.isFrozen(value))
    assert.ok(Object.isFrozen(value.a))
    assert.throws(() => { value.a.first = true })
    assert.equal(store.directoryIdentities, undefined)
})

test("different releases reuse unchanged objects and manifests are deterministic", async t => {
    const { contentRootDir, store } = createFixture(t)
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
    assert.equal(listJsonFiles(path.join(contentRootDir, "objects")).length, 4)
    assert.equal(listJsonFiles(path.join(contentRootDir, "releases")).length, 2)
    assert.deepEqual(await store.readRelease(releasePath(contentRootDir, first)), first)
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
    const { contentRootDir, store } = createFixture(t)
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

    const snapshot = await store.readReleaseSnapshot(releasePath(contentRootDir, manifest))

    assert.ok(maxActive > 1)
    assert.ok(maxActive <= 8, `maximum object read concurrency was ${maxActive}`)
    assert.equal(active, 0)
    assert.equal(readCounts.size, digests.length)
    for (const digest of digests) assert.equal(readCounts.get(digest), 1)
    assert.deepEqual(Object.keys(snapshot.objects).sort(), [...digests].sort())
})

test("release snapshot waits for active object reads before rejecting", async t => {
    const { contentRootDir, store } = createFixture(t)
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
        store.readReleaseSnapshot(releasePath(contentRootDir, manifest)),
        error => error === failure,
    )
    assert.equal(active, 0)
    assert.ok(maxActive <= 8, `maximum object read concurrency was ${maxActive}`)
})

test("activate atomically switches current and a rename failure preserves the old pointer", async t => {
    const { contentRootDir, store } = createFixture(t)
    const first = await store.writeRelease(releaseInput(await writeReleaseObjects(store, "first")))
    const secondObjects = await writeReleaseObjects(store, "second")
    const second = await store.writeRelease(releaseInput(secondObjects, { assetVersion: "1.4.56" }))
    const oldCurrent = await store.activate(first)

    const failingStore = new ContentObjectStore({ contentRootDir }, {
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
        fs.readdirSync(contentRootDir).some(name => name.includes(".tmp-")),
        false,
    )
})

test("a failed release write leaves no loadable manifest and never updates current", async t => {
    const { contentRootDir, store } = createFixture(t)
    const objects = await writeReleaseObjects(store)
    const failingStore = new ContentObjectStore({ contentRootDir }, {
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
    assert.deepEqual(listJsonFiles(path.join(contentRootDir, "releases")), [])
    assert.deepEqual(listTemporaryFiles(contentRootDir), [])
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
    fs.mkdirSync(corrupt.contentRootDir, { recursive: true })
    fs.writeFileSync(path.join(corrupt.contentRootDir, "current.json"), "not json\n")
    await assert.rejects(corrupt.store.readCurrent(), /current|JSON|canonical/i)

    const missingManifest = createFixture(t, "content-current-manifest-")
    const manifest = await missingManifest.store.writeRelease(
        releaseInput(await writeReleaseObjects(missingManifest.store)),
    )
    await missingManifest.store.activate(manifest)
    fs.unlinkSync(releasePath(missingManifest.contentRootDir, manifest))
    await assert.rejects(missingManifest.store.readCurrent(), /manifest|ENOENT|missing/i)

    const missingObject = createFixture(t, "content-current-object-")
    const objects = await writeReleaseObjects(missingObject.store)
    const objectManifest = await missingObject.store.writeRelease(releaseInput(objects))
    await missingObject.store.activate(objectManifest)
    fs.unlinkSync(path.join(
        missingObject.contentRootDir,
        "objects",
        `${objects.table.slice("sha256:".length)}.json`,
    ))
    await assert.rejects(missingObject.store.readCurrent(), /object|ENOENT|missing/i)
})

test("existing object corruption is rejected instead of overwritten", async t => {
    const { contentRootDir, store } = createFixture(t)
    const value = { a: 1, nested: [true, false] }
    const digest = await store.writeObject(value)
    const objectPath = path.join(
        contentRootDir,
        "objects",
        `${digest.slice("sha256:".length)}.json`,
    )
    fs.writeFileSync(objectPath, canonicalJsonBuffer({ corrupted: true }))

    await assert.rejects(store.readObject(digest), /digest|canonical|corrupt/i)
    await assert.rejects(store.writeObject(value), /digest|canonical|corrupt/i)
})

test("content root, objects, releases, object files, and current reject symlinks", async t => {
    const rootFixture = createFixture(t, "content-root-link-")
    const outsideRoot = path.join(rootFixture.sandbox, "outside-root")
    fs.mkdirSync(outsideRoot)
    if (!createDirectorySymlink(t, outsideRoot, rootFixture.contentRootDir)) return
    await assert.rejects(rootFixture.store.writeObject({ value: 1 }), /symlink/i)

    const objectsFixture = createFixture(t, "content-objects-link-")
    fs.mkdirSync(objectsFixture.contentRootDir)
    const outsideObjects = path.join(objectsFixture.sandbox, "outside-objects")
    fs.mkdirSync(outsideObjects)
    if (!createDirectorySymlink(
        t,
        outsideObjects,
        path.join(objectsFixture.contentRootDir, "objects"),
    )) return
    await assert.rejects(objectsFixture.store.writeObject({ value: 2 }), /symlink/i)

    const fileFixture = createFixture(t, "content-object-link-")
    const expectedDigest = await fileFixture.store.writeObject({ value: 3 })
    const expectedPath = path.join(
        fileFixture.contentRootDir,
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
        path.join(releasesFixture.contentRootDir, "releases"),
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
    fs.symlinkSync(outsideCurrent, path.join(currentFixture.contentRootDir, "current.json"))
    await assert.rejects(currentFixture.store.readCurrent(), /symlink/i)
})

test("manifest and current persist only portable relative paths", async t => {
    const { contentRootDir, store } = createFixture(t)
    const manifest = await store.writeRelease(releaseInput(await writeReleaseObjects(store)))
    const current = await store.activate(manifest)
    const manifestBytes = fs.readFileSync(releasePath(contentRootDir, manifest), "utf8")
    const currentBytes = fs.readFileSync(path.join(contentRootDir, "current.json"), "utf8")

    assert.equal(manifestBytes.includes(contentRootDir), false)
    assert.equal(currentBytes.includes(contentRootDir), false)
    assert.equal(path.isAbsolute(current.release), false)
    assert.deepEqual(Object.keys(current).sort(), ["assetVersion", "release", "schemaVersion"])
})

test("writeRelease verifies every referenced object before publishing", async t => {
    const { contentRootDir, store } = createFixture(t)
    const objects = await writeReleaseObjects(store)
    await assert.rejects(
        store.writeRelease(releaseInput({ ...objects, table: MISSING_DIGEST })),
        /object|ENOENT|missing/i,
    )
    assert.deepEqual(listJsonFiles(path.join(contentRootDir, "releases")), [])
})
