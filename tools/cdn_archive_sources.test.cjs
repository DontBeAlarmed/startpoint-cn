const assert = require("node:assert/strict")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    createArchiveSourceManifest,
    createBaselineArchiveSourceManifest,
    parseArchiveSourceManifest,
    parseArchiveSourceSummary,
    sourceFor,
    sourceRoot,
} = require("../src/content/cdn/archive-sources")

function createCatalog() {
    return {
        schemaVersion: 1,
        fullBaseVersion: "1.4.54",
        targetVersion: "1.4.55",
        installedBytes: 1,
        entityListsRelativePath: "EntityLists.csv",
        edges: [
            { archives: [{ relativePath: "baseline/common.zip" }] },
            { archives: [{ relativePath: "updates/patch.zip" }] },
        ],
    }
}

function validManifest() {
    return {
        schemaVersion: 1,
        archives: [
            { relativePath: "baseline/common.zip", source: { kind: "baseline" } },
            { relativePath: "updates/patch.zip", source: { kind: "patch", targetVersion: "1.4.55" } },
        ],
    }
}

test("creates, parses, and queries immutable baseline and patch archive sources", () => {
    const catalog = createCatalog()
    const sources = new Map([
        ["baseline/common.zip", { kind: "baseline" }],
        ["updates/patch.zip", { kind: "patch", targetVersion: "1.4.55" }],
    ])

    const created = createArchiveSourceManifest(catalog, sources)
    const parsed = parseArchiveSourceManifest(created, catalog)

    assert.deepEqual(parsed, validManifest())
    assert.ok(Object.isFrozen(parsed))
    assert.ok(Object.isFrozen(parsed.archives))
    assert.ok(Object.isFrozen(parsed.archives[0]))
    assert.ok(Object.isFrozen(parsed.archives[0].source))
    assert.deepEqual(sourceFor(parsed, "baseline/common.zip"), { kind: "baseline" })
    assert.deepEqual(sourceFor(parsed, "updates/patch.zip"), { kind: "patch", targetVersion: "1.4.55" })
    assert.equal(
        sourceRoot({ cdnRoot: "/cdn/cn", patchesRoot: "/cdn/patches" }, sourceFor(parsed, "baseline/common.zip")),
        "/cdn/cn",
    )
    assert.equal(
        sourceRoot({ cdnRoot: "/cdn/cn", patchesRoot: "/cdn/patches" }, sourceFor(parsed, "updates/patch.zip")),
        path.join("/cdn/patches", "1.4.55"),
    )
})

test("restores release sources and limits legacy fallback to the 1.4.54 baseline", () => {
    const catalog = createCatalog()
    assert.deepEqual(
        parseArchiveSourceSummary({ archiveSources: validManifest() }, catalog),
        validManifest(),
    )
    assert.throws(
        () => parseArchiveSourceSummary({ targetVersion: "1.4.55" }, catalog),
        /ARCHIVE_SOURCE_SCHEMA/,
    )

    const baselineCatalog = { ...catalog, targetVersion: "1.4.54" }
    assert.throws(
        () => parseArchiveSourceSummary({}, baselineCatalog),
        /ARCHIVE_SOURCE_SCHEMA/,
    )
    const fallback = parseArchiveSourceSummary({}, baselineCatalog, true)
    assert.deepEqual(fallback, createBaselineArchiveSourceManifest(baselineCatalog))
    assert.ok(fallback.archives.every(entry => entry.source.kind === "baseline"))
})

test("rejects source manifest schema, coverage, path, and version violations", () => {
    const catalog = createCatalog()

    assert.throws(
        () => parseArchiveSourceManifest({ schemaVersion: 2, archives: [] }, catalog),
        /ARCHIVE_SOURCE_SCHEMA/,
    )
    assert.throws(
        () => createArchiveSourceManifest(catalog, new Map()),
        /ARCHIVE_SOURCE_COVERAGE/,
    )
    assert.throws(
        () => parseArchiveSourceManifest({ ...validManifest(), archives: validManifest().archives.slice(0, 1) }, catalog),
        /ARCHIVE_SOURCE_COVERAGE/,
    )
    assert.throws(
        () => parseArchiveSourceManifest({
            ...validManifest(),
            archives: [...validManifest().archives, { relativePath: "extra.zip", source: { kind: "baseline" } }],
        }, catalog),
        /ARCHIVE_SOURCE_COVERAGE/,
    )
    assert.throws(
        () => parseArchiveSourceManifest({
            ...validManifest(),
            archives: [validManifest().archives[0], validManifest().archives[0]],
        }, catalog),
        /ARCHIVE_SOURCE_COVERAGE/,
    )
    assert.throws(
        () => parseArchiveSourceManifest({
            ...validManifest(),
            archives: [{ relativePath: "../escape.zip", source: { kind: "baseline" } }, validManifest().archives[1]],
        }, catalog),
        /ARCHIVE_SOURCE_PATH/,
    )
    assert.throws(
        () => parseArchiveSourceManifest({
            ...validManifest(),
            archives: [validManifest().archives[0], {
                relativePath: "updates/patch.zip",
                source: { kind: "patch", targetVersion: "1.04.55" },
            }],
        }, catalog),
        /ARCHIVE_SOURCE_VERSION/,
    )
    assert.throws(
        () => parseArchiveSourceManifest({
            ...validManifest(),
            archives: [validManifest().archives[0], {
                relativePath: "updates/patch.zip",
                source: { kind: "patch", targetVersion: "9007199254740992.1.1" },
            }],
        }, catalog),
        /ARCHIVE_SOURCE_VERSION/,
    )
    assert.throws(
        () => parseArchiveSourceManifest({
            ...validManifest(),
            archives: [{
                relativePath: "baseline/common.zip:ads",
                source: { kind: "baseline" },
            }, validManifest().archives[1]],
        }, catalog),
        /ARCHIVE_SOURCE_PATH/,
    )
})
