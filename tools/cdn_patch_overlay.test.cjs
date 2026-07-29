const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { buildCdnCatalog, CatalogValidationError } = require("../src/content/cdn/catalog-builder")
const { PatchOverlayError, scanPatchOverlay } = require("../src/content/cdn/patch-overlay")

const LAYERS = [
    ["common", "archive-common-diff", "common"],
    ["medium", "archive-medium-diff", "quality"],
    ["android", "archive-android-diff", "platform"],
]

function sha256(bytes) {
    return crypto.createHash("sha256").update(bytes).digest("hex")
}

function baselineCatalog() {
    return { targetVersion: "1.4.54" }
}

function createFixture(t) {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "cdn-patch-overlay-"))
    const patchesRoot = path.join(sandbox, "patches")
    fs.mkdirSync(patchesRoot, { recursive: true })
    t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
    return { sandbox, paths: { patchesRoot } }
}

function writePackage(paths, options) {
    const directoryVersion = options.directoryVersion ?? options.targetVersion
    const packageRoot = path.join(paths.patchesRoot, directoryVersion)
    fs.mkdirSync(packageRoot, { recursive: true })
    const archives = []
    for (const [layer, directory] of LAYERS) {
        const bytes = Buffer.from(`${options.fromVersion}-${options.targetVersion}-${layer}`)
        const digest = sha256(bytes)
        const fileName = `pinball-${options.fromVersion}-${options.targetVersion}-1-${digest.slice(0, 8)}.zip`
        const relativePath = `${directory}/${fileName}`
        fs.mkdirSync(path.join(packageRoot, directory), { recursive: true })
        fs.writeFileSync(path.join(packageRoot, relativePath), bytes)
        archives.push({ relativePath, layer, order: 1, bytes: bytes.length, sha256: digest })
    }
    fs.writeFileSync(path.join(packageRoot, "README.md"), "fixture")
    fs.writeFileSync(path.join(packageRoot, "outer.zip"), "ignored")
    fs.writeFileSync(path.join(packageRoot, "patch-manifest.json"), JSON.stringify({
        schema: 1,
        ...(options.baseVersion === undefined ? {} : { baseVersion: options.baseVersion }),
        targetVersion: options.manifestTargetVersion ?? options.targetVersion,
        compatibleClient: "CN 1.8.1",
        archives: options.mutateArchives ? options.mutateArchives(archives) : archives,
    }))
    return { archives, packageRoot }
}

function baselineInputs() {
    const result = []
    for (const [index, [, , layer]] of LAYERS.entries()) {
        result.push({
            kind: "full",
            fromVersion: null,
            toVersion: "1.4.0",
            platform: "android",
            layer,
            order: 1,
            relativePath: `baseline/full-${index}.zip`,
            compressedBytes: 1,
            sha256: String(index + 1).padStart(64, "0"),
        })
        result.push({
            kind: "diff",
            fromVersion: "1.4.0",
            toVersion: "1.4.54",
            platform: "android",
            layer,
            order: 1,
            relativePath: `baseline/diff-${index}.zip`,
            compressedBytes: 1,
            sha256: String(index + 4).padStart(64, "0"),
        })
    }
    return result
}

function catalogInput(scanned) {
    return {
        installedBytes: 1,
        entityListsRelativePath: "EntityLists/fixture.csv",
        archives: [
            ...baselineInputs(),
            ...scanned.archives.map(item => ({
                kind: item.kind,
                fromVersion: item.fromVersion,
                toVersion: item.toVersion,
                platform: item.platform,
                layer: item.layer,
                order: item.order,
                relativePath: item.relativePath,
                compressedBytes: item.compressedBytes,
                sha256: item.expectedSha256,
            })),
        ],
    }
}

test("discovers only manifest archives and ignores outer ZIPs and incomplete directories", async t => {
    const { paths } = createFixture(t)
    fs.writeFileSync(path.join(paths.patchesRoot, "distribution.zip"), "ignored")
    fs.mkdirSync(path.join(paths.patchesRoot, "not-installed"))
    fs.writeFileSync(path.join(paths.patchesRoot, "not-installed", "payload.zip"), "ignored")
    writePackage(paths, {
        baseVersion: "1.4.54",
        fromVersion: "1.4.54",
        targetVersion: "1.4.55",
    })

    const result = await scanPatchOverlay(paths, baselineCatalog())

    assert.equal(result.archives.length, 3)
    assert.deepEqual(new Set(result.archives.map(item => item.source.targetVersion)), new Set(["1.4.55"]))
    assert.ok(result.archives.every(item => item.expectedSha256 === sha256(fs.readFileSync(item.physicalPath))))
    assert.ok(result.ignoredPaths.includes("distribution.zip"))
    assert.ok(result.ignoredPaths.includes("not-installed/"))
    assert.ok(result.ignoredPaths.includes("1.4.55/outer.zip"))
    assert.ok(result.ignoredPaths.includes("1.4.55/README.md"))
})

test("rejects a patch version directory replaced by a symlink after root discovery", async t => {
    const { paths } = createFixture(t)
    writePackage(paths, {
        baseVersion: "1.4.54",
        fromVersion: "1.4.54",
        targetVersion: "1.4.55",
    })
    const packageRoot = path.join(paths.patchesRoot, "1.4.55")
    const relocatedRoot = path.join(paths.patchesRoot, "relocated-1.4.55")
    let replaced = false

    await assert.rejects(
        () => scanPatchOverlay(paths, baselineCatalog(), {
            readdir: async directory => {
                const entries = await fs.promises.readdir(directory, { withFileTypes: true })
                if (!replaced && path.resolve(directory) === path.resolve(paths.patchesRoot)) {
                    replaced = true
                    fs.renameSync(packageRoot, relocatedRoot)
                    fs.symlinkSync(path.basename(relocatedRoot), packageRoot)
                }
                return entries
            },
        }),
        /PATCH_ARCHIVE_SYMLINK/,
    )
})

test("rejects a patch manifest changed while its declared archives are scanned", async t => {
    const { paths } = createFixture(t)
    const written = writePackage(paths, {
        baseVersion: "1.4.54",
        fromVersion: "1.4.54",
        targetVersion: "1.4.55",
    })
    const manifestPath = path.join(written.packageRoot, "patch-manifest.json")
    const firstArchivePath = path.join(written.packageRoot, written.archives[0].relativePath)
    let changed = false

    await assert.rejects(
        () => scanPatchOverlay(paths, baselineCatalog(), {
            lstat: async filePath => {
                const stat = await fs.promises.lstat(filePath, { bigint: true })
                if (!changed && path.resolve(filePath) === path.resolve(firstArchivePath)) {
                    changed = true
                    fs.appendFileSync(manifestPath, "\n")
                }
                return stat
            },
        }),
        /PATCH_ARCHIVE_HASH_MISMATCH/,
    )
})

test("reports stable patch errors when activated files disappear between checks", async t => {
    await t.test("manifest read", async t => {
        const { paths } = createFixture(t)
        const written = writePackage(paths, {
            baseVersion: "1.4.54",
            fromVersion: "1.4.54",
            targetVersion: "1.4.55",
        })
        const manifestPath = path.join(written.packageRoot, "patch-manifest.json")

        await assert.rejects(
            () => scanPatchOverlay(paths, baselineCatalog(), {
                readFile: async filePath => {
                    fs.unlinkSync(filePath)
                    return fs.promises.readFile(filePath)
                },
            }),
            error => error instanceof PatchOverlayError && error.code === "PATCH_ARCHIVE_FILE_MISSING",
        )
        assert.equal(fs.existsSync(manifestPath), false)
    })

    await t.test("archive realpath", async t => {
        const { paths } = createFixture(t)
        const written = writePackage(paths, {
            baseVersion: "1.4.54",
            fromVersion: "1.4.54",
            targetVersion: "1.4.55",
        })
        const archivePath = path.join(written.packageRoot, written.archives[0].relativePath)
        let removed = false

        await assert.rejects(
            () => scanPatchOverlay(paths, baselineCatalog(), {
                realpath: async filePath => {
                    if (!removed && path.resolve(filePath) === path.resolve(archivePath)) {
                        removed = true
                        fs.unlinkSync(archivePath)
                    }
                    return fs.promises.realpath(filePath)
                },
            }),
            error => error instanceof PatchOverlayError && error.code === "PATCH_ARCHIVE_FILE_MISSING",
        )
    })
})

test("resolves optional package dependencies independently from archive upgrade edges", async t => {
    const { paths } = createFixture(t)
    writePackage(paths, {
        baseVersion: "1.4.54",
        fromVersion: "1.4.54",
        targetVersion: "1.4.55",
    })
    writePackage(paths, {
        baseVersion: "1.4.54",
        fromVersion: "1.4.55",
        targetVersion: "1.4.58",
    })

    const result = await scanPatchOverlay(paths, baselineCatalog())
    const catalog = buildCdnCatalog(catalogInput(result))

    assert.equal(result.archives.length, 6)
    assert.equal(catalog.targetVersion, "1.4.58")
})

test("rejects missing and cyclic content dependencies", async t => {
    await t.test("missing", async t => {
        const { paths } = createFixture(t)
        writePackage(paths, { baseVersion: "1.4.99", fromVersion: "1.4.54", targetVersion: "1.4.55" })
        await assert.rejects(() => scanPatchOverlay(paths, baselineCatalog()), /PATCH_BASE_VERSION_MISSING/)
    })
    await t.test("cycle", async t => {
        const { paths } = createFixture(t)
        writePackage(paths, { baseVersion: "1.4.56", fromVersion: "1.4.54", targetVersion: "1.4.55" })
        writePackage(paths, { baseVersion: "1.4.55", fromVersion: "1.4.55", targetVersion: "1.4.56" })
        await assert.rejects(() => scanPatchOverlay(paths, baselineCatalog()), /PATCH_BASE_VERSION_CYCLE/)
    })
})

test("rejects directory, target, size, and symlink violations after manifest activation", async t => {
    await t.test("directory", async t => {
        const { paths } = createFixture(t)
        writePackage(paths, {
            directoryVersion: "1.4.56",
            baseVersion: "1.4.54",
            fromVersion: "1.4.54",
            targetVersion: "1.4.55",
        })
        await assert.rejects(() => scanPatchOverlay(paths, baselineCatalog()), /PATCH_DIRECTORY_VERSION_MISMATCH/)
    })
    await t.test("target", async t => {
        const { paths } = createFixture(t)
        writePackage(paths, {
            baseVersion: "1.4.54",
            fromVersion: "1.4.54",
            targetVersion: "1.4.55",
            manifestTargetVersion: "1.4.56",
        })
        await assert.rejects(() => scanPatchOverlay(paths, baselineCatalog()), /PATCH_DIRECTORY_VERSION_MISMATCH|PATCH_ARCHIVE_TARGET_MISMATCH/)
    })
    await t.test("size", async t => {
        const { paths } = createFixture(t)
        writePackage(paths, {
            baseVersion: "1.4.54",
            fromVersion: "1.4.54",
            targetVersion: "1.4.55",
            mutateArchives: archives => [{ ...archives[0], bytes: archives[0].bytes + 1 }, ...archives.slice(1)],
        })
        await assert.rejects(() => scanPatchOverlay(paths, baselineCatalog()), /PATCH_ARCHIVE_SIZE_MISMATCH/)
    })
    await t.test("symlink", async t => {
        const { sandbox, paths } = createFixture(t)
        const written = writePackage(paths, {
            baseVersion: "1.4.54",
            fromVersion: "1.4.54",
            targetVersion: "1.4.55",
        })
        const archive = written.archives[0]
        const archivePath = path.join(written.packageRoot, archive.relativePath)
        const outside = path.join(sandbox, "outside.zip")
        fs.writeFileSync(outside, fs.readFileSync(archivePath))
        fs.rmSync(archivePath)
        fs.symlinkSync(outside, archivePath)
        await assert.rejects(() => scanPatchOverlay(paths, baselineCatalog()), /PATCH_ARCHIVE_SYMLINK/)
    })
})

test("catalog validation accepts jumps but rejects a newly disconnected intermediate branch", async t => {
    const { paths } = createFixture(t)
    writePackage(paths, { baseVersion: "1.4.54", fromVersion: "1.4.54", targetVersion: "1.4.55" })
    writePackage(paths, { baseVersion: "1.4.54", fromVersion: "1.4.55", targetVersion: "1.4.58" })
    const valid = await scanPatchOverlay(paths, baselineCatalog())
    assert.equal(buildCdnCatalog(catalogInput(valid)).targetVersion, "1.4.58")

    writePackage(paths, { baseVersion: "1.4.54", fromVersion: "1.4.55", targetVersion: "1.4.56" })
    const forked = await scanPatchOverlay(paths, baselineCatalog())
    assert.throws(
        () => buildCdnCatalog(catalogInput(forked)),
        error => error instanceof CatalogValidationError && error.issues.some(issue => issue.code === "GRAPH_FORK"),
    )
})
