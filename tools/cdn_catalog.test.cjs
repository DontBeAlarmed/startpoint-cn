"use strict"

const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    buildCdnCatalog,
    CatalogValidationError,
    catalogEdgeKey,
    parseDiffArchiveName,
    parseEntityListInstalledBytes,
    parseFullArchiveName,
    scanCdnCatalogInput,
} = require("../src/content/cdn/catalog-builder")
const { validatePatchGraph } = require("../src/content/cdn/patch-graph")

const fixtureRoot = path.join(__dirname, "fixtures/cdn-catalog")
const DIGEST_A = "a".repeat(64)
const DIGEST_B = "b".repeat(64)

function archive(overrides = {}) {
    const kind = overrides.kind ?? "diff"
    const layer = overrides.layer ?? "common"
    const order = overrides.order ?? 1
    const fromVersion = kind === "full" ? null : (overrides.fromVersion ?? "1.4.0")
    const toVersion = overrides.toVersion ?? (kind === "full" ? "1.4.0" : "1.4.1")
    const directory = `archive-${layer === "quality" ? "medium" : layer === "platform" ? "android" : "common"}-${kind}`
    const name = kind === "full"
        ? `pinball-${toVersion}-${order}-abcd.zip`
        : `pinball-${fromVersion}-${toVersion}-${order}-abcd.zip`

    return {
        kind,
        fromVersion,
        toVersion,
        platform: "android",
        layer,
        order,
        relativePath: `${directory}/${name}`,
        compressedBytes: 10 + order,
        sha256: DIGEST_A,
        ...overrides,
    }
}

function validInput() {
    return {
        archives: [
            archive({ kind: "full", layer: "common", order: 2 }),
            archive({ kind: "full", layer: "common", order: 1 }),
            archive({ kind: "full", layer: "quality", order: 1 }),
            archive({ kind: "full", layer: "platform", order: 1 }),
            archive({ layer: "common", order: 2 }),
            archive({ layer: "common", order: 1 }),
            archive({ layer: "quality", order: 1 }),
            archive({ layer: "platform", order: 1 }),
        ],
        installedBytes: 30,
        entityListsRelativePath: "EntityLists/fixture-android_medium.csv",
    }
}

function issueCodes(callback) {
    let observedError
    assert.throws(callback, error => {
        assert.ok(error instanceof CatalogValidationError)
        assert.equal(error.code, error.issues[0].code)
        observedError = error
        return true
    })
    return observedError.issues.map(issue => issue.code)
}

test("parses full and diff archive names without accepting unrelated names", () => {
    const diffName = "pinball-1.4.53-1.4.54-2-abcd.zip"
    const fullName = "pinball-1.4.0-2-abcd.zip"
    assert.deepEqual(parseDiffArchiveName(diffName), {
        fromVersion: "1.4.53",
        toVersion: "1.4.54",
        order: 2,
    })
    assert.deepEqual(parseFullArchiveName(fullName), {
        toVersion: "1.4.0",
        order: 2,
    })
    assert.equal(parseFullArchiveName(diffName), null)
    assert.equal(parseDiffArchiveName(fullName), null)

    for (const invalid of [
        "notes.txt",
        "pinball-1.4-1.4.1-2-abcd.zip",
        "pinball-1.4.0-1.4.1-0-abcd.zip",
        "pinball-1.4.0-1.4.1-9007199254740992-abcd.zip",
        "pinball-1.4.0-1.4.1-two-abcd.zip",
    ]) {
        assert.equal(parseDiffArchiveName(invalid), null, invalid)
    }
    assert.equal(parseFullArchiveName("pinball-1.4.0-0-abcd.zip"), null)
    assert.equal(parseFullArchiveName("pinball-1.4.x-2-abcd.zip"), null)
    assert.equal(parseFullArchiveName("s_asset-1.4.0-2-abcd.zip"), null)
    assert.equal(parseDiffArchiveName("s_asset-1.4.0-1.4.1-2-abcd.zip"), null)
})

test("sums the third EntityLists CSV column from the real five-column format", () => {
    const csv = [
        "production/upload/2d/asset-a,1.4.43,72979,SHA256_BASE64_A,common",
        "",
        "production/upload/3e/asset-b,1.4.54,20,SHA256_BASE64_B,android",
        "   ",
    ].join("\n")
    assert.equal(parseEntityListInstalledBytes(csv), 72999)
    assert.equal(parseEntityListInstalledBytes(Buffer.from(csv)), 72999)
    assert.equal(parseEntityListInstalledBytes([
        "path,version,size,hash,layer",
        "production/upload/2d/asset-a,1.4.43,72979,not-a-size,common",
    ].join("\n")), 72979)

    for (const invalid of [
        "upload/a,1.4.0,-1,hash-a,common",
        "upload/a,1.4.0,1.5,hash-a,common",
        "upload/a,1.4.0,nope,hash-a,common",
        "upload/a,1.4.0,9007199254740992,hash-a,common",
        "upload/a,1.4.0",
        "not,path,size,hash,layer",
    ]) {
        assert.throws(() => parseEntityListInstalledBytes(invalid), error => (
            error instanceof CatalogValidationError
            && error.code === "INVALID_INSTALLED_BYTES"
        ))
    }
})

test("builds a deterministic deeply frozen catalog with stable layer ordering", () => {
    const input = validInput()
    const shuffled = { ...input, archives: [...input.archives].reverse() }
    const first = buildCdnCatalog(input)
    const second = buildCdnCatalog(shuffled)

    assert.deepEqual(first, second)
    assert.equal(first.schemaVersion, 1)
    assert.equal(first.fullBaseVersion, "1.4.0")
    assert.equal(first.targetVersion, "1.4.1")
    assert.equal(first.installedBytes, 30)
    assert.equal(first.entityListsRelativePath, "EntityLists/fixture-android_medium.csv")

    const shortenedDiff = first.edges.find(edge => (
        edge.fromVersion === "1.4.0" && edge.assetSizeKind === "shortened"
    ))
    assert.deepEqual(shortenedDiff.archives.map(item => [item.layer, item.order]), [
        ["common", 1],
        ["common", 2],
        ["quality", 1],
        ["platform", 1],
    ])
    assert.ok(Object.isFrozen(first))
    assert.ok(Object.isFrozen(first.edges))
    assert.ok(Object.isFrozen(shortenedDiff))
    assert.ok(Object.isFrozen(shortenedDiff.archives))
    assert.ok(shortenedDiff.archives.every(Object.isFrozen))
    assert.throws(() => first.edges.push(shortenedDiff), TypeError)
    assert.throws(() => { shortenedDiff.archives[0].order = 99 }, TypeError)
})

test("uses mode in edge identity while sharing the first-stage archive set", () => {
    const catalog = buildCdnCatalog(validInput())
    const shortened = catalog.edges.filter(edge => edge.assetSizeKind === "shortened")
    const fulfill = catalog.edges.filter(edge => edge.assetSizeKind === "fulfill")

    assert.equal(shortened.length, fulfill.length)
    for (const edge of shortened) {
        const counterpart = fulfill.find(candidate => (
            candidate.fromVersion === edge.fromVersion
            && candidate.toVersion === edge.toVersion
            && candidate.platform === edge.platform
        ))
        assert.ok(counterpart)
        assert.notEqual(catalogEdgeKey(edge), catalogEdgeKey(counterpart))
        assert.deepEqual(
            edge.archives.map(item => item.relativePath),
            counterpart.archives.map(item => item.relativePath),
        )
    }
})

test("reports forks, conflicting paths, duplicate orders, and missing required layers", () => {
    const forked = validInput()
    forked.archives.push(
        archive({ fromVersion: "1.4.0", toVersion: "1.4.2", layer: "common" }),
        archive({ fromVersion: "1.4.0", toVersion: "1.4.2", layer: "platform" }),
    )
    assert.ok(issueCodes(() => buildCdnCatalog(forked)).includes("GRAPH_FORK"))

    const conflictingPath = validInput()
    conflictingPath.archives.push({
        ...conflictingPath.archives[0],
        compressedBytes: conflictingPath.archives[0].compressedBytes + 1,
    })
    assert.ok(issueCodes(() => buildCdnCatalog(conflictingPath)).includes("CONFLICTING_ARCHIVE_PATH"))

    const duplicateOrder = validInput()
    duplicateOrder.archives.push(archive({ layer: "common", order: 1, relativePath: "archive-common-diff/other-1.4.0-1.4.1-1-beef.zip" }))
    assert.ok(issueCodes(() => buildCdnCatalog(duplicateOrder)).includes("DUPLICATE_ARCHIVE_ORDER"))

    const missingCommon = validInput()
    missingCommon.archives = missingCommon.archives.filter(item => !(item.kind === "diff" && item.layer === "common"))
    assert.ok(issueCodes(() => buildCdnCatalog(missingCommon)).includes("MISSING_ARCHIVE_LAYER"))

    const missingPlatform = validInput()
    missingPlatform.archives = missingPlatform.archives.filter(item => !(item.kind === "full" && item.layer === "platform"))
    assert.ok(issueCodes(() => buildCdnCatalog(missingPlatform)).includes("MISSING_ARCHIVE_LAYER"))

    const missingQuality = validInput()
    missingQuality.archives = missingQuality.archives.filter(item => !(item.kind === "diff" && item.layer === "quality"))
    assert.ok(issueCodes(() => buildCdnCatalog(missingQuality)).includes("MISSING_ARCHIVE_LAYER"))
})

test("reports duplicate archive paths even when their metadata is identical", () => {
    const input = validInput()
    input.archives.push({ ...input.archives[0] })
    assert.ok(issueCodes(() => buildCdnCatalog(input)).includes("DUPLICATE_ARCHIVE_PATH"))
})

test("rejects cycles and diff edges disconnected from the full base", () => {
    const cycle = validInput()
    cycle.archives.push(
        archive({ fromVersion: "1.4.1", toVersion: "1.4.0", layer: "common" }),
        archive({ fromVersion: "1.4.1", toVersion: "1.4.0", layer: "platform" }),
    )
    assert.ok(issueCodes(() => buildCdnCatalog(cycle)).includes("GRAPH_CYCLE"))

    const disconnected = validInput()
    disconnected.archives.push(
        archive({ fromVersion: "1.5.0", toVersion: "1.5.1", layer: "common" }),
        archive({ fromVersion: "1.5.0", toVersion: "1.5.1", layer: "platform" }),
    )
    assert.ok(issueCodes(() => buildCdnCatalog(disconnected)).includes("MISSING_PATH"))
})

test("patch graph validation is pure and distinguishes full from diff edges", () => {
    const full = {
        fromVersion: null,
        toVersion: "1.4.0",
        platform: "android",
        assetSizeKind: "shortened",
        archives: [],
    }
    const diff = {
        ...full,
        fromVersion: "1.4.0",
        toVersion: "1.4.1",
    }
    const duplicate = { ...diff, archives: [] }
    const conflictingDuplicate = {
        ...diff,
        archives: [{
            relativePath: "archive-common-diff/conflict.zip",
            compressedBytes: 1,
            sha256: DIGEST_B,
            layer: "common",
            order: 1,
        }],
    }
    const fork = { ...diff, toVersion: "1.4.2" }
    const cycle = { ...diff, fromVersion: "1.4.1", toVersion: "1.4.0" }

    assert.deepEqual(validatePatchGraph([full, diff], "1.4.0"), [])
    assert.ok(validatePatchGraph([full, diff, duplicate], "1.4.0").some(issue => issue.code === "DUPLICATE_EDGE"))
    assert.ok(validatePatchGraph([full, diff, conflictingDuplicate], "1.4.0").some(issue => issue.code === "CONFLICTING_EDGE"))
    assert.ok(validatePatchGraph([full, diff, fork], "1.4.0").some(issue => issue.code === "GRAPH_FORK"))
    assert.ok(validatePatchGraph([full, diff, cycle], "1.4.0").some(issue => issue.code === "GRAPH_CYCLE"))
    assert.equal(full.fromVersion, null)
    assert.equal(diff.fromVersion, "1.4.0")
})

test("scanner reads only fixed CDN directories and reuses an atomic digest cache", async t => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "cdn-catalog-"))
    const cdnRoot = path.join(sandbox, "configured-cdn-root")
    const contentStateDir = path.join(sandbox, "configured-state")
    fs.cpSync(fixtureRoot, cdnRoot, { recursive: true })
    fs.mkdirSync(path.join(cdnRoot, "unrelated"))
    fs.writeFileSync(path.join(cdnRoot, "unrelated", "ignored.zip"), "ignored")
    t.after(() => fs.rmSync(sandbox, { force: true, recursive: true }))

    const paths = {
        cdnDir: path.dirname(cdnRoot),
        cdnRoot,
        contentStoreDir: path.join(sandbox, "store"),
        contentStateDir,
        contentRuntimeDir: path.join(sandbox, "runtime"),
    }
    let digestCalls = 0
    const digestFile = async filePath => {
        digestCalls++
        return crypto.createHash("sha256").update(await fs.promises.readFile(filePath)).digest("hex")
    }

    const first = await scanCdnCatalogInput(paths, { digestFile })
    assert.equal(first.archives.length, 6)
    assert.equal(first.installedBytes, 30)
    assert.equal(first.entityListsRelativePath, "EntityLists/fixture-android_medium.csv")
    assert.equal(digestCalls, 6)
    assert.ok(first.archives.every(item => !Object.hasOwn(item, "mtime")))
    assert.ok(first.archives.every(item => !path.isAbsolute(item.relativePath)))

    const firstCatalog = buildCdnCatalog(first)
    assert.equal(firstCatalog.fullBaseVersion, "1.4.0")
    assert.equal(firstCatalog.targetVersion, "1.4.1")
    assert.equal(JSON.stringify(firstCatalog).includes("mtime"), false)

    await scanCdnCatalogInput(paths, { digestFile })
    assert.equal(digestCalls, 6)

    const changedArchive = path.join(cdnRoot, "archive-common-diff", "pinball-1.4.0-1.4.1-1-abcd.zip")
    const future = new Date(Date.now() + 2_000)
    fs.utimesSync(changedArchive, future, future)
    await scanCdnCatalogInput(paths, { digestFile })
    assert.equal(digestCalls, 7)

    fs.appendFileSync(changedArchive, "changed")
    await scanCdnCatalogInput(paths, { digestFile })
    assert.equal(digestCalls, 8)

    fs.writeFileSync(
        path.join(cdnRoot, "archive-common-diff", "pinball-1.4.0-1.4.1-2-beef.zip"),
        "new archive",
    )
    await scanCdnCatalogInput(paths, { digestFile })
    assert.equal(digestCalls, 9)

    const cache = JSON.parse(fs.readFileSync(path.join(contentStateDir, "cdn-digest-cache.json"), "utf8"))
    assert.equal(cache.length, 7)
    assert.ok(cache.every(entry => (
        Object.keys(entry).sort().join(",") === "digest,mtime,path,size"
    )))
    assert.ok(cache.every(entry => !path.isAbsolute(entry.path)))
    assert.equal(fs.readdirSync(contentStateDir).some(name => name.includes(".tmp-")), false)
})

test("scanner rejects ambiguous EntityLists candidates without inspecting arbitrary trees", async t => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "cdn-catalog-entity-"))
    const cdnRoot = path.join(sandbox, "cdn")
    fs.cpSync(fixtureRoot, cdnRoot, { recursive: true })
    fs.copyFileSync(
        path.join(cdnRoot, "EntityLists", "fixture-android_medium.csv"),
        path.join(cdnRoot, "EntityLists", "other-android_medium.csv"),
    )
    t.after(() => fs.rmSync(sandbox, { force: true, recursive: true }))

    const paths = {
        cdnDir: sandbox,
        cdnRoot,
        contentStoreDir: path.join(sandbox, "store"),
        contentStateDir: path.join(sandbox, "state"),
        contentRuntimeDir: path.join(sandbox, "runtime"),
    }
    await assert.rejects(
        scanCdnCatalogInput(paths),
        error => error instanceof CatalogValidationError && error.code === "AMBIGUOUS_PATH",
    )
})

test("catalog rejects invalid scalar metadata with explicit issue codes", () => {
    const invalidInstalledBytes = validInput()
    invalidInstalledBytes.installedBytes = -1
    assert.ok(issueCodes(() => buildCdnCatalog(invalidInstalledBytes)).includes("INVALID_INSTALLED_BYTES"))

    const invalidDigest = validInput()
    invalidDigest.archives[0] = { ...invalidDigest.archives[0], sha256: "short" }
    assert.ok(issueCodes(() => buildCdnCatalog(invalidDigest)).includes("INVALID_SHA256"))

    const invalidBytes = validInput()
    invalidBytes.archives[0] = { ...invalidBytes.archives[0], compressedBytes: -1 }
    assert.ok(issueCodes(() => buildCdnCatalog(invalidBytes)).includes("INVALID_COMPRESSED_BYTES"))
})

test("full archives remain Full edges and diff archives remain Diff edges", () => {
    const catalog = buildCdnCatalog(validInput())
    const full = catalog.edges.filter(edge => edge.fromVersion === null)
    const diff = catalog.edges.filter(edge => edge.fromVersion !== null)

    assert.equal(full.length, 2)
    assert.equal(diff.length, 2)
    assert.ok(full.every(edge => edge.toVersion === catalog.fullBaseVersion))
    assert.ok(diff.every(edge => edge.fromVersion === catalog.fullBaseVersion))
})
