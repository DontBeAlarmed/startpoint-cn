"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { ContentRepository } = require("../src/content/runtime/content-repository")
const { ContentObjectStore } = require("../src/content/sync/object-store")
const {
    CONTENT_GENERATOR_VERSION,
    CONTENT_RUNTIME_SCHEMA_VERSION,
    CONTENT_SCHEMA_VERSION,
} = require("../src/content/sync/schema")
const { TABLE_SOURCES } = require("../src/content/sync/table-registry")
const { canonicalJsonBuffer, sha256Object } = require("../src/content/sync/canonical-json")

const projectRoot = path.resolve(__dirname, "..")

function expectedBundledDigest(tables) {
    const identities = Object.entries(tables)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([tableName, value]) => ({
            tableName,
            digest: sha256Object(canonicalJsonBuffer(value)),
        }))
    return sha256Object(canonicalJsonBuffer(identities))
}

function assertDeepFrozen(value, seen = new Set()) {
    if (!value || typeof value !== "object" || seen.has(value)) return
    seen.add(value)
    assert.equal(Object.isFrozen(value), true)
    for (const key of Reflect.ownKeys(value)) assertDeepFrozen(value[key], seen)
}

function createLegacyLayout(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "content-repository-"))
    const contentRootDir = path.join(root, "content")
    t.after(() => fs.rmSync(root, { force: true, recursive: true }))
    return {
        contentRootDir,
        options: {
            projectRoot,
            env: {
                CDN_DIR: path.join(root, "cdn"),
                CONTENT_DIR: contentRootDir,
                CONTENT_RUNTIME_DIR: path.join(projectRoot, "assets"),
            },
        },
        store: new ContentObjectStore({ contentRootDir }),
    }
}

function copyRegisteredRuntimeTables(runtimeRoot) {
    for (const definition of TABLE_SOURCES) {
        const destination = path.join(runtimeRoot, definition.tableName)
        fs.mkdirSync(path.dirname(destination), { recursive: true })
        fs.copyFileSync(path.join(projectRoot, definition.bundledPath), destination)
    }
}

async function writeRelease(store, marker, options = {}) {
    const object = await store.writeObject({ marker, nested: { value: marker } })
    const catalog = await store.writeObject({ targetVersion: options.assetVersion ?? "1.4.55" })
    const summary = await store.writeObject({ marker: `summary-${marker}` })
    const tables = Object.fromEntries(TABLE_SOURCES.map(definition => [
        definition.tableName,
        {
            object,
            scope: definition.scope,
            converterId: definition.converterId,
            converterVersion: definition.converterVersion,
            sources: definition.manifestSources,
        },
    ]))
    options.mutateTables?.(tables, object)
    const manifest = await store.writeRelease({
        schemaVersion: CONTENT_SCHEMA_VERSION,
        assetVersion: options.assetVersion ?? "1.4.55",
        runtimeSchemaVersion: CONTENT_RUNTIME_SCHEMA_VERSION,
        generatorVersion: options.generatorVersion ?? CONTENT_GENERATOR_VERSION,
        tables,
        catalog: { object: catalog },
        summary: { object: summary },
    })
    await store.activate(manifest)
    return { manifest, object }
}

test("missing current loads and freezes every registered bundled fallback table", async t => {
    const fixture = createLegacyLayout(t)
    const repository = await ContentRepository.load(fixture.options)

    const bundledTables = Object.fromEntries(TABLE_SOURCES.map(definition => [
        definition.tableName,
        JSON.parse(fs.readFileSync(path.join(projectRoot, definition.bundledPath), "utf8")),
    ]))
    assert.deepEqual(repository.info(), {
        source: "bundled",
        assetVersion: "1.4.54",
        generatorVersion: CONTENT_GENERATOR_VERSION,
        releaseDigest: null,
        contentDigest: expectedBundledDigest(bundledTables),
        multiBattleContentDigest: repository.info().multiBattleContentDigest,
    })
    assertDeepFrozen(repository.info())

    for (const definition of TABLE_SOURCES) {
        const value = repository.table(definition.tableName)
        assert.equal(value instanceof Promise, false)
        assertDeepFrozen(value)
    }
    assert.deepEqual(
        repository.table("character.json"),
        JSON.parse(fs.readFileSync(path.join(projectRoot, "assets/character.json"), "utf8")),
    )
})

test("bundled fallback reads only the configured runtime root without writing it", async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "content-repository-runtime-root-"))
    const temporaryProject = path.join(root, "project")
    const runtimeRoot = path.join(root, "runtime")
    fs.mkdirSync(temporaryProject)
    fs.mkdirSync(runtimeRoot)
    copyRegisteredRuntimeTables(runtimeRoot)
    t.after(() => fs.rmSync(root, { force: true, recursive: true }))
    const before = fs.statSync(path.join(runtimeRoot, "news.json"))

    const repository = await ContentRepository.load({
        projectRoot: temporaryProject,
        env: {
            CDN_DIR: path.join(root, "cdn"),
            CONTENT_DIR: path.join(root, "content"),
            CONTENT_RUNTIME_DIR: runtimeRoot,
        },
    })

    assert.equal(fs.existsSync(path.join(temporaryProject, "assets")), false)
    assert.deepEqual(repository.table("news.json"), JSON.parse(
        fs.readFileSync(path.join(runtimeRoot, "news.json"), "utf8"),
    ))
    assert.equal(fs.statSync(path.join(runtimeRoot, "news.json")).mtimeMs, before.mtimeMs)
    assert.deepEqual(fs.readdirSync(root).sort(), ["project", "runtime"])
})

test("bundled fallback imports all tables with bounded concurrency and stable ordering", async t => {
    const fixture = createLegacyLayout(t)
    const activeNames = new Set()
    const importedNames = []
    let maxActive = 0

    const repository = await ContentRepository.load(fixture.options, {
        importBundledTable: async (_projectRoot, tableName) => {
            activeNames.add(tableName)
            maxActive = Math.max(maxActive, activeNames.size)
            await new Promise(resolve => setImmediate(resolve))
            activeNames.delete(tableName)
            importedNames.push(tableName)
            return { tableName }
        },
    })

    const expectedNames = TABLE_SOURCES.map(definition => definition.tableName)
    assert.ok(maxActive > 1)
    assert.ok(maxActive <= 8, `maximum bundled import concurrency was ${maxActive}`)
    assert.equal(importedNames.length, expectedNames.length)
    assert.deepEqual([...importedNames].sort(), expectedNames)
    assert.deepEqual(
        expectedNames.map(tableName => repository.table(tableName).tableName),
        expectedNames,
    )
    assert.equal(
        repository.info().contentDigest,
        expectedBundledDigest(Object.fromEntries(expectedNames.map(tableName => [
            tableName,
            { tableName },
        ]))),
    )
})

test("bundled content digest changes with loaded content and not import completion order", async t => {
    const fixture = createLegacyLayout(t)
    async function load(marker, reverseDelay) {
        return ContentRepository.load(fixture.options, {
            importBundledTable: async (_runtimeRoot, tableName) => {
                const index = TABLE_SOURCES.findIndex(definition => definition.tableName === tableName)
                const delay = reverseDelay ? TABLE_SOURCES.length - index : index
                await new Promise(resolve => setTimeout(resolve, delay % 3))
                return { tableName, marker: tableName === "character.json" ? marker : "stable" }
            },
        })
    }

    const first = await load("first", false)
    const sameContent = await load("first", true)
    const changed = await load("changed", false)

    assert.equal(first.info().contentDigest, sameContent.info().contentDigest)
    assert.notEqual(first.info().contentDigest, changed.info().contentDigest)
})

test("multiplayer battle digest ignores gacha content but changes with quest content", async t => {
    const fixture = createLegacyLayout(t)
    const load = overrides => ContentRepository.load(fixture.options, {
        importBundledTable: async (_runtimeRoot, tableName) => ({
            tableName,
            marker: overrides[tableName] ?? "stable",
        }),
    })

    const baseline = await load({})
    const changedGacha = await load({ "gacha.json": "changed" })
    const changedQuest = await load({ "boss_battle_quest.json": "changed" })

    assert.notEqual(baseline.info().contentDigest, changedGacha.info().contentDigest)
    assert.equal(
        baseline.info().multiBattleContentDigest,
        changedGacha.info().multiBattleContentDigest,
    )
    assert.notEqual(
        baseline.info().multiBattleContentDigest,
        changedQuest.info().multiBattleContentDigest,
    )
})

test("bundled import failure drains workers before immediate retry", async t => {
    const fixture = createLegacyLayout(t)
    const failure = new Error("controlled bundled import failure")
    const failingTable = TABLE_SOURCES[0].tableName
    let shouldFail = true
    let active = 0
    let maxActive = 0
    const dependencies = {
        importBundledTable: async (_projectRoot, tableName) => {
            active++
            maxActive = Math.max(maxActive, active)
            try {
                if (shouldFail && tableName === failingTable) {
                    await new Promise(resolve => setImmediate(resolve))
                    throw failure
                }
                await new Promise(resolve => setTimeout(resolve, 10))
                return { tableName }
            } finally {
                active--
            }
        },
    }

    let activeWhenRejected = -1
    try {
        await ContentRepository.load(fixture.options, dependencies)
        assert.fail("first bundled load must reject")
    } catch (error) {
        assert.strictEqual(error, failure)
        activeWhenRejected = active
    }

    shouldFail = false
    const retried = await ContentRepository.load(fixture.options, dependencies)

    assert.equal(activeWhenRejected, 0)
    assert.equal(active, 0)
    assert.ok(maxActive <= 8, `maximum cross-load import concurrency was ${maxActive}`)
    assert.equal(retried.table(failingTable).tableName, failingTable)
})

test("release tables and info are deeply frozen and keep one cached reference", async t => {
    const fixture = createLegacyLayout(t)
    const { manifest } = await writeRelease(fixture.store, "release-a", {
        assetVersion: "1.4.55",
        generatorVersion: 7,
    })

    const repository = await ContentRepository.load(fixture.options)
    const first = repository.table("character.json")
    const second = repository.table("character.json")

    assert.equal(first instanceof Promise, false)
    assert.strictEqual(second, first)
    assert.deepEqual(first, { marker: "release-a", nested: { value: "release-a" } })
    assertDeepFrozen(first)
    const expectedReleaseTables = Object.fromEntries(TABLE_SOURCES.map(definition => [
        definition.tableName,
        { marker: "release-a", nested: { value: "release-a" } },
    ]))
    const expectedContentDigest = expectedBundledDigest(expectedReleaseTables)
    assert.notEqual(expectedContentDigest, manifest.releaseDigest)
    assert.deepEqual(repository.info(), {
        source: "release",
        assetVersion: "1.4.55",
        generatorVersion: 7,
        releaseDigest: manifest.releaseDigest,
        contentDigest: expectedContentDigest,
        multiBattleContentDigest: repository.info().multiBattleContentDigest,
    })
    assertDeepFrozen(repository.info())
    assert.strictEqual(repository.info(), repository.info())
})

test("repository exposes no own property containing its table storage", async t => {
    const fixture = createLegacyLayout(t)
    await writeRelease(fixture.store, "private-storage")

    const repository = await ContentRepository.load(fixture.options)

    assert.deepEqual(Reflect.ownKeys(repository), [])
    assert.deepEqual(repository.table("character.json"), {
        marker: "private-storage",
        nested: { value: "private-storage" },
    })
})

test("release loading reads each unique closure object once without repository rereads", async t => {
    const fixture = createLegacyLayout(t)
    await writeRelease(fixture.store, "single-read")
    const originalReadObject = ContentObjectStore.prototype.readObject
    let objectReads = 0
    t.mock.method(ContentObjectStore.prototype, "readObject", function (...args) {
        objectReads++
        return originalReadObject.apply(this, args)
    })

    const repository = await ContentRepository.load(fixture.options)

    assert.equal(objectReads, 3)
    assert.strictEqual(repository.table("character.json"), repository.table("gacha.json"))
})

test("only a genuinely missing current pointer falls back to bundled tables", async t => {
    const corrupt = createLegacyLayout(t)
    fs.mkdirSync(corrupt.contentRootDir, { recursive: true })
    fs.writeFileSync(path.join(corrupt.contentRootDir, "current.json"), "{")
    await assert.rejects(ContentRepository.load(corrupt.options), /current pointer is corrupt/i)

    const missingRelease = createLegacyLayout(t)
    const { manifest } = await writeRelease(missingRelease.store, "missing-release")
    fs.unlinkSync(path.join(
        missingRelease.contentRootDir,
        "releases",
        `${manifest.assetVersion}-${manifest.releaseDigest.slice(7)}`,
        "manifest.json",
    ))
    await assert.rejects(ContentRepository.load(missingRelease.options), /release manifest is missing/i)

    const missingObject = createLegacyLayout(t)
    const release = await writeRelease(missingObject.store, "missing-object")
    fs.unlinkSync(path.join(
        missingObject.contentRootDir,
        "objects",
        `${release.object.slice(7)}.json`,
    ))
    await assert.rejects(ContentRepository.load(missingObject.options), /content object is missing/i)
})

test("repository stays pinned when current switches to another release", async t => {
    const fixture = createLegacyLayout(t)
    const firstRelease = await writeRelease(fixture.store, "release-a", { assetVersion: "1.4.55" })
    const repository = await ContentRepository.load(fixture.options)

    const secondRelease = await writeRelease(fixture.store, "release-b", { assetVersion: "1.4.56" })

    assert.deepEqual(repository.table("character.json"), {
        marker: "release-a",
        nested: { value: "release-a" },
    })
    assert.equal(repository.info().releaseDigest, firstRelease.manifest.releaseDigest)
    assert.notEqual(repository.info().releaseDigest, secondRelease.manifest.releaseDigest)
    assert.equal(repository.info().assetVersion, "1.4.55")
})

test("unregistered table names fail clearly", async t => {
    const fixture = createLegacyLayout(t)
    const repository = await ContentRepository.load(fixture.options, {
        importBundledTable: async (_projectRoot, tableName) => ({ tableName }),
    })
    assert.throws(() => repository.table("not_registered.json"), /not registered/i)
})

test("release manifest must exactly match all registered tables", async t => {
    const cases = [
        ["missing", (tables) => { delete tables["character.json"] }, /missing tables.*character\.json/i],
        ["extra", (tables, object) => {
            tables["extra.json"] = {
                object,
                scope: "bundled",
                converterId: "bundled-json",
                converterVersion: 1,
                sources: ["assets/extra.json"],
            }
        }, /extra tables.*extra\.json/i],
        ["scope", tables => { tables["character.json"].scope = "bundled" }, /character\.json.*scope/i],
        ["converter id", tables => {
            tables["character.json"].converterId = "other"
        }, /character\.json.*converterId/i],
        ["converter version", tables => {
            tables["character.json"].converterVersion += 1
        }, /character\.json.*converterVersion/i],
        ["sources", tables => {
            tables["character.json"].sources = ["assets/character.json"]
        }, /character\.json.*sources/i],
    ]

    for (const [name, mutateTables, expected] of cases) {
        await t.test(name, async t => {
            const fixture = createLegacyLayout(t)
            await writeRelease(fixture.store, name, { mutateTables })
            await assert.rejects(ContentRepository.load(fixture.options), expected)
        })
    }
})

test("bundled fallback fails clearly when a registered file is missing", async t => {
    const fixture = createLegacyLayout(t)
    const temporaryProject = fs.mkdtempSync(path.join(os.tmpdir(), "content-repository-project-"))
    t.after(() => fs.rmSync(temporaryProject, { force: true, recursive: true }))
    fs.mkdirSync(path.join(temporaryProject, "assets"), { recursive: true })

    await assert.rejects(
        ContentRepository.load({
            ...fixture.options,
            projectRoot: temporaryProject,
            env: {
                ...fixture.options.env,
                CONTENT_RUNTIME_DIR: path.join(temporaryProject, "assets"),
            },
        }),
        error => (
            /cannot read bundled table/i.test(error.message)
            && !error.message.includes(temporaryProject)
            && error.cause === undefined
        ),
    )
})

test("bundled catalog version is defined by the neutral content constants module", () => {
    const { BUNDLED_CDN_CATALOG_VERSION } = require("../src/content/constants")
    const repositorySource = fs.readFileSync(path.join(
        projectRoot,
        "src/content/runtime/content-repository.ts",
    ), "utf8")
    const catalogLoaderSource = fs.readFileSync(path.join(
        projectRoot,
        "src/content/cdn/catalog-loader.ts",
    ), "utf8")

    assert.equal(BUNDLED_CDN_CATALOG_VERSION, "1.4.54")
    assert.doesNotMatch(repositorySource, /cdn\/catalog-loader/)
    assert.match(repositorySource, /from "\.\.\/constants"/)
    assert.match(catalogLoaderSource, /from "\.\.\/constants"/)
})
