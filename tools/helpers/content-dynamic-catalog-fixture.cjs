"use strict"

const crypto = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const { buildCdnCatalog } = require("../../src/content/cdn/catalog-builder")
const { createBaselineArchiveSourceManifest } = require("../../src/content/cdn/archive-sources")
const { createCdnRuntimeManifest } = require("../../src/content/cdn/runtime-manifest")
const { runContentSync } = require("../../src/content/sync/engine")
const { ContentObjectStore } = require("../../src/content/sync/object-store")
const {
    CONTENT_RUNTIME_SCHEMA_VERSION,
    CONTENT_SCHEMA_VERSION,
} = require("../../src/content/sync/schema")
const { TABLE_SOURCES } = require("../../src/content/sync/table-registry")

function createSandbox(t) {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "content-dynamic-catalog-"))
    const paths = {
        layout: "modern",
        cdnDir: path.join(projectRoot, ".cdn"),
        cdnRoot: path.join(projectRoot, ".cdn", "cn"),
        contentRootDir: path.join(projectRoot, ".content"),
        contentStoreDir: path.join(projectRoot, ".database", "content", "store"),
        contentStateDir: path.join(projectRoot, ".database", "state", "content"),
        contentRuntimeDir: path.join(projectRoot, "assets"),
    }
    fs.mkdirSync(paths.cdnRoot, { recursive: true })
    t.after(() => fs.rmSync(projectRoot, { force: true, recursive: true }))
    return { paths, projectRoot }
}

function archiveDigest(label) {
    return crypto.createHash("sha256").update(label).digest("hex")
}

function catalogInput(targetVersion) {
    const definitions = [
        ["common", "archive-common-full", "full"],
        ["quality", "archive-medium-full", "full"],
        ["platform", "archive-android-full", "full"],
        ["common", "archive-common-diff", "diff"],
        ["quality", "archive-medium-diff", "diff"],
        ["platform", "archive-android-diff", "diff"],
    ]
    return {
        archives: definitions.map(([layer, directory, kind]) => {
            const isFull = kind === "full"
            const fileName = isFull
                ? "pinball-1.4.0-1-fixture.zip"
                : `pinball-1.4.0-${targetVersion}-1-fixture.zip`
            const relativePath = `${directory}/${fileName}`
            return {
                kind,
                fromVersion: isFull ? null : "1.4.0",
                toVersion: isFull ? "1.4.0" : targetVersion,
                platform: "android",
                layer,
                order: 1,
                relativePath,
                compressedBytes: 10,
                sha256: archiveDigest(relativePath),
            }
        }),
        installedBytes: 30,
        entityListsRelativePath: `EntityLists/${targetVersion}-android_medium.csv`,
    }
}

function scan(paths, targetVersion) {
    return {
        cdnRoot: paths.cdnRoot,
        targetVersion,
        entityListsRelativePath: `EntityLists/${targetVersion}-android_medium.csv`,
        entityListsFingerprint: {
            physicalPath: path.join(paths.cdnRoot, "EntityLists", `${targetVersion}.csv`),
            compressedBytes: 1,
            mtimeMs: "1",
            ctimeMs: "1",
            dev: "1",
            ino: "1",
        },
        archives: [],
        ignoredPaths: [],
    }
}

function tableValues(targetVersion) {
    return new Map(TABLE_SOURCES.map(definition => [
        definition.tableName,
        { tableName: definition.tableName, targetVersion },
    ]))
}

async function synchronizeRelease(fixture, targetVersion) {
    const input = catalogInput(targetVersion)
    const catalog = buildCdnCatalog(input)
    await runContentSync({
        projectRoot: fixture.projectRoot,
        generatorVersion: 1,
    }, {
        resolvePaths: () => fixture.paths,
        scanTarget: async () => scan(fixture.paths, targetVersion),
        materializeCatalog: async () => input,
        buildArchiveIndex: async () => ({ marker: "in-memory-index" }),
        tableBuilder: { build: async () => tableValues(targetVersion) },
    })
    return catalog
}

async function installLightweightRelease(fixture, targetVersion, options = {}) {
    const store = options.store ?? new ContentObjectStore(fixture.paths)
    const catalog = buildCdnCatalog(catalogInput(targetVersion))
    const tableObject = await store.writeObject({
        fixture: options.marker ?? targetVersion,
    })
    const catalogObject = await store.writeObject(catalog)
    const summaryObject = await store.writeObject({
        targetVersion,
        archiveSources: createBaselineArchiveSourceManifest(catalog),
    })
    const tables = Object.fromEntries(TABLE_SOURCES.map(definition => [
        definition.tableName,
        {
            object: tableObject,
            scope: definition.scope,
            converterId: definition.converterId,
            converterVersion: definition.converterVersion,
            sources: definition.manifestSources,
        },
    ]))
    const manifest = await store.writeRelease({
        schemaVersion: CONTENT_SCHEMA_VERSION,
        assetVersion: targetVersion,
        runtimeSchemaVersion: CONTENT_RUNTIME_SCHEMA_VERSION,
        generatorVersion: 1,
        tables,
        catalog: { object: catalogObject },
        summary: { object: summaryObject },
    })
    await store.activate(manifest)
    return { catalog, manifest, store }
}

function fallbackManifest(targetVersion = "1.4.54") {
    const input = catalogInput(targetVersion)
    return createCdnRuntimeManifest(input, {
        relativePath: input.entityListsRelativePath,
        compressedBytes: 1,
        sha256: archiveDigest(input.entityListsRelativePath),
    })
}

module.exports = {
    createSandbox,
    fallbackManifest,
    installLightweightRelease,
    synchronizeRelease,
}
