"use strict"

const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const test = require("node:test")
const unzipper = require("unzipper")

require("ts-node/register/transpile-only")

const { buildCdnCatalog, CatalogValidationError } = require("../src/content/cdn/catalog-builder")
const { ArchiveIndex } = require("../src/content/sync/archive-index")
const {
    materializeContentCatalogInput,
    scanContentTarget,
} = require("../src/content/sync/scanner")

const ARCHIVE_DIRECTORIES = [
    ["archive-common-full", "common"],
    ["archive-medium-full", "quality"],
    ["archive-android-full", "platform"],
    ["archive-common-diff", "common"],
    ["archive-medium-diff", "quality"],
    ["archive-android-diff", "platform"],
]

function createPaths(sandbox) {
    return {
        cdnDir: sandbox,
        cdnRoot: path.join(sandbox, "cdn"),
        contentStoreDir: path.join(sandbox, "store"),
        contentStateDir: path.join(sandbox, "state"),
        contentRuntimeDir: path.join(sandbox, "runtime"),
    }
}

function archiveFileName(directory, fromVersion, toVersion) {
    return directory.endsWith("-full")
        ? `pinball-${toVersion}-1-abcd.zip`
        : `pinball-${fromVersion}-${toVersion}-1-abcd.zip`
}

function addEdgeFiles(cdnRoot, fromVersion, toVersion, marker) {
    for (const [directory] of ARCHIVE_DIRECTORIES) {
        if ((fromVersion === null) !== directory.endsWith("-full")) continue
        fs.mkdirSync(path.join(cdnRoot, directory), { recursive: true })
        fs.writeFileSync(
            path.join(cdnRoot, directory, archiveFileName(directory, fromVersion, toVersion)),
            `${marker}:${directory}`,
        )
    }
}

function createScannerFixture(t) {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "content-scanner-"))
    const paths = createPaths(sandbox)
    fs.mkdirSync(path.join(paths.cdnRoot, "EntityLists"), { recursive: true })
    fs.writeFileSync(
        path.join(paths.cdnRoot, "EntityLists", "1.4.54-android_medium.csv"),
        "path,version,size,hash,layer\nfirst,1,11,a,common\nsecond,1,13,b,platform\n",
    )
    addEdgeFiles(paths.cdnRoot, null, "1.4.0", "full")
    addEdgeFiles(paths.cdnRoot, "1.4.0", "1.4.54", "diff-54")
    t.after(() => fs.rmSync(sandbox, { force: true, recursive: true }))
    return { paths, sandbox }
}

function baselineForScan(scan) {
    return {
        archives: scan.archives.map((archive, index) => ({
            kind: archive.kind,
            fromVersion: archive.fromVersion,
            toVersion: archive.toVersion,
            platform: archive.platform,
            layer: archive.layer,
            order: archive.order,
            relativePath: archive.relativePath,
            compressedBytes: archive.compressedBytes,
            sha256: index.toString(16).padStart(64, "0"),
        })),
        installedBytes: 24,
        entityListsRelativePath: scan.entityListsRelativePath,
    }
}

async function digestHandle(fileHandle) {
    const hash = crypto.createHash("sha256")
    const buffer = Buffer.alloc(16)
    let position = 0
    while (true) {
        const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, position)
        if (bytesRead === 0) break
        hash.update(buffer.subarray(0, bytesRead))
        position += bytesRead
    }
    return hash.digest("hex")
}

async function readHandle(fileHandle) {
    const chunks = []
    const buffer = Buffer.alloc(16)
    let position = 0
    while (true) {
        const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, position)
        if (bytesRead === 0) break
        chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
        position += bytesRead
    }
    return Buffer.concat(chunks)
}

test("target scan reads no archive or EntityLists body and returns frozen deterministic metadata", async t => {
    const { paths } = createScannerFixture(t)
    fs.writeFileSync(path.join(paths.cdnRoot, "ignored.txt"), "ignored")
    fs.writeFileSync(path.join(paths.cdnRoot, "archive-common-full", "notes.txt"), "ignored")
    fs.writeFileSync(path.join(paths.cdnRoot, "EntityLists", "notes.csv"), "ignored")
    let bodyReads = 0

    const scan = await scanContentTarget(paths, {
        openFile: async () => {
            bodyReads++
            throw new Error("scan must not open archive bodies")
        },
        readEntityList: async () => {
            bodyReads++
            throw new Error("scan must not read EntityLists")
        },
    })

    assert.equal(bodyReads, 0)
    assert.equal(scan.targetVersion, "1.4.54")
    assert.equal(scan.entityListsRelativePath, "EntityLists/1.4.54-android_medium.csv")
    assert.equal(
        scan.entityListsFingerprint.physicalPath,
        fs.realpathSync(path.join(paths.cdnRoot, "EntityLists", "1.4.54-android_medium.csv")),
    )
    assert.equal(scan.archives.length, 6)
    assert.equal(
        scan.archives[0].physicalPath,
        fs.realpathSync(path.join(paths.cdnRoot, scan.archives[0].relativePath)),
    )
    assert.deepEqual(scan.ignoredPaths, [
        "archive-common-full/notes.txt",
        "EntityLists/notes.csv",
        "ignored.txt",
    ])
    assert.equal(Object.hasOwn(scan.archives[0], "sha256"), false)
    assert.ok(Object.isFrozen(scan))
    assert.ok(Object.isFrozen(scan.archives))
    assert.ok(Object.isFrozen(scan.archives[0]))
})

test("target scan accepts the lowercase entities directory used by the alternate official dump", async t => {
    const { paths } = createScannerFixture(t)
    fs.renameSync(
        path.join(paths.cdnRoot, "EntityLists"),
        path.join(paths.cdnRoot, "entities"),
    )

    const scan = await scanContentTarget(paths)

    assert.equal(scan.entityListsRelativePath, "entities/1.4.54-android_medium.csv")
    assert.equal(
        scan.entityListsFingerprint.physicalPath,
        fs.realpathSync(path.join(paths.cdnRoot, "entities", "1.4.54-android_medium.csv")),
    )
})

test("target scan keeps EntityLists precedence when both official directory names exist", async t => {
    const { paths } = createScannerFixture(t)
    fs.cpSync(
        path.join(paths.cdnRoot, "EntityLists"),
        path.join(paths.cdnRoot, "entities"),
        { recursive: true },
    )

    const scan = await scanContentTarget(paths)

    assert.equal(scan.entityListsRelativePath, "EntityLists/1.4.54-android_medium.csv")
})

test("materialization reuses a complete baseline and hashes only archives added for a new target", async t => {
    const { paths } = createScannerFixture(t)
    const firstScan = await scanContentTarget(paths)
    const baselineInput = baselineForScan(firstScan)
    buildCdnCatalog(baselineInput)
    let digestCalls = 0

    const baselineHit = await materializeContentCatalogInput(firstScan, {
        baselineInput,
        digestArchive: async fileHandle => {
            digestCalls++
            return digestHandle(fileHandle)
        },
    })

    assert.equal(digestCalls, 0)
    assert.equal(baselineHit.installedBytes, 24)
    assert.deepEqual(
        baselineHit.archives.map(archive => archive.sha256),
        baselineInput.archives.map(archive => archive.sha256),
    )

    addEdgeFiles(paths.cdnRoot, "1.4.54", "1.4.55", "diff-55")
    const secondScan = await scanContentTarget(paths)
    const next = await materializeContentCatalogInput(secondScan, {
        baselineInput,
        digestArchive: async fileHandle => {
            digestCalls++
            return digestHandle(fileHandle)
        },
    })

    assert.equal(secondScan.targetVersion, "1.4.55")
    assert.equal(digestCalls, 3)
    assert.equal(next.archives.length, 9)
    assert.equal(buildCdnCatalog(next).targetVersion, "1.4.55")
    assert.ok(Object.isFrozen(next))
    assert.ok(Object.isFrozen(next.archives[0]))
    assert.equal(fs.existsSync(paths.contentStateDir), false)
})

test("materialization loads the tracked official baseline by default without rehashing it", async () => {
    const manifest = JSON.parse(fs.readFileSync(
        path.join(__dirname, "../assets/cdn/catalog-cn-1.4.54.json"),
        "utf8",
    ))
    const cdnRoot = path.resolve(os.tmpdir(), "virtual-content-baseline-cdn")
    const entityListsRelativePath = manifest.catalogInput.entityListsRelativePath
    const entityBody = Buffer.from("path,version,size,hash,layer\na,1,24,h,common\n")
    const entityPhysicalPath = path.join(cdnRoot, entityListsRelativePath)
    const archives = manifest.catalogInput.archives.map((archive, index) => ({
        kind: archive.kind,
        fromVersion: archive.fromVersion,
        toVersion: archive.toVersion,
        platform: archive.platform,
        layer: archive.layer,
        order: archive.order,
        relativePath: archive.relativePath,
        physicalPath: path.join(cdnRoot, archive.relativePath),
        compressedBytes: archive.compressedBytes,
        mtimeMs: "1",
        ctimeMs: "1",
        dev: "1",
        ino: String(index + 2),
    }))
    const sizeByPath = new Map(archives.map(archive => [
        archive.physicalPath,
        [archive.compressedBytes, archive.ino],
    ]))
    sizeByPath.set(entityPhysicalPath, [entityBody.length, "1"])
    const stat = async filePath => {
        const metadata = sizeByPath.get(filePath)
        if (!metadata) throw Object.assign(new Error("missing virtual file"), { code: "ENOENT" })
        return {
            size: BigInt(metadata[0]),
            mtimeMs: BigInt(1),
            ctimeMs: BigInt(1),
            dev: BigInt(1),
            ino: BigInt(metadata[1]),
            isFile: () => true,
        }
    }
    const scan = {
        cdnRoot,
        targetVersion: "1.4.54",
        entityListsRelativePath,
        entityListsFingerprint: {
            physicalPath: entityPhysicalPath,
            compressedBytes: entityBody.length,
            mtimeMs: "1",
            ctimeMs: "1",
            dev: "1",
            ino: "1",
        },
        archives,
        ignoredPaths: [],
    }

    const materialized = await materializeContentCatalogInput(scan, {
        realpath: async filePath => filePath,
        stat,
        openFile: async filePath => ({
            stat: async () => stat(filePath),
            close: async () => undefined,
        }),
        readEntityList: async () => entityBody,
        digestArchive: async () => { throw new Error("official baseline was rehashed") },
    })

    assert.equal(materialized.archives.length, 677)
    assert.deepEqual(
        materialized.archives.map(archive => archive.sha256),
        manifest.catalogInput.archives.map(archive => archive.sha256),
    )
})

test("scanner records unknown files but rejects zip-like invalid names", async t => {
    const { paths } = createScannerFixture(t)
    fs.writeFileSync(path.join(paths.cdnRoot, "archive-common-diff", "readme.md"), "ok")
    const scan = await scanContentTarget(paths)
    assert.ok(scan.ignoredPaths.includes("archive-common-diff/readme.md"))

    fs.writeFileSync(path.join(paths.cdnRoot, "archive-common-diff", "pinball-invalid.zip"), "bad")
    await assert.rejects(
        scanContentTarget(paths),
        error => error instanceof CatalogValidationError && error.code === "INVALID_ARCHIVE_PATH",
    )
})

test("scanner rejects archive and EntityLists symlinks that escape cdnRoot", async t => {
    const first = createScannerFixture(t)
    const outsideArchive = path.join(first.sandbox, "outside.zip")
    fs.writeFileSync(outsideArchive, "outside")
    const archivePath = path.join(
        first.paths.cdnRoot,
        "archive-common-diff",
        archiveFileName("archive-common-diff", "1.4.0", "1.4.54"),
    )
    fs.unlinkSync(archivePath)
    fs.symlinkSync(outsideArchive, archivePath)
    await assert.rejects(scanContentTarget(first.paths), /outside cdnRoot|escapes cdnRoot/)

    const second = createScannerFixture(t)
    const outsideEntity = path.join(second.sandbox, "outside.csv")
    fs.writeFileSync(outsideEntity, "path,version,size,hash,layer\na,1,1,h,common\n")
    const entityPath = path.join(second.paths.cdnRoot, "EntityLists", "1.4.54-android_medium.csv")
    fs.unlinkSync(entityPath)
    fs.symlinkSync(outsideEntity, entityPath)
    await assert.rejects(scanContentTarget(second.paths), /outside cdnRoot|escapes cdnRoot/)

    const third = createScannerFixture(t)
    const archiveDirectory = path.join(third.paths.cdnRoot, "archive-common-diff")
    const outsideDirectory = path.join(third.sandbox, "outside-archive-directory")
    fs.rmSync(archiveDirectory, { force: true, recursive: true })
    fs.mkdirSync(outsideDirectory)
    fs.writeFileSync(path.join(outsideDirectory, "notes.txt"), "outside")
    fs.symlinkSync(outsideDirectory, archiveDirectory)
    await assert.rejects(scanContentTarget(third.paths), /outside cdnRoot|escapes cdnRoot/)
})

test("materialization rejects files changed after scan without writing state", async t => {
    const { paths } = createScannerFixture(t)
    const scan = await scanContentTarget(paths)
    const baselineInput = baselineForScan(scan)
    const changed = path.join(paths.cdnRoot, scan.archives[0].relativePath)
    fs.appendFileSync(changed, "changed")

    await assert.rejects(
        materializeContentCatalogInput(scan, { baselineInput }),
        error => error instanceof CatalogValidationError && error.code === "UNSTABLE_ARCHIVE_SNAPSHOT",
    )
    assert.equal(fs.existsSync(paths.contentStateDir), false)
})

test("materialization rejects EntityLists changed while its body is read", async t => {
    const { paths } = createScannerFixture(t)
    const scan = await scanContentTarget(paths)
    const baselineInput = baselineForScan(scan)
    const entityPath = path.join(paths.cdnRoot, scan.entityListsRelativePath)

    await assert.rejects(
        materializeContentCatalogInput(scan, {
            baselineInput,
            readEntityList: async (fileHandle, filePath) => {
                const content = await readHandle(fileHandle)
                fs.appendFileSync(entityPath, "changed")
                assert.equal(filePath, fs.realpathSync(entityPath))
                return content
            },
        }),
        error => (
            error instanceof CatalogValidationError
            && error.code === "UNSTABLE_ARCHIVE_SNAPSHOT"
        ),
    )
})

const PHYSICAL_A = `production/upload/ab/${"c".repeat(38)}`
const PHYSICAL_B = `production/upload/de/${"f".repeat(38)}`

function writeZip(archivePath, entries) {
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "content-zip-stage-"))
    try {
        for (const [entryName, content] of Object.entries(entries)) {
            const entryPath = path.join(staging, ...entryName.split("/"))
            fs.mkdirSync(path.dirname(entryPath), { recursive: true })
            fs.writeFileSync(entryPath, content)
        }
        fs.mkdirSync(path.dirname(archivePath), { recursive: true })
        const result = spawnSync("zip", ["-q", "-D", archivePath, ...Object.keys(entries)], {
            cwd: staging,
            encoding: "utf8",
        })
        assert.equal(result.status, 0, result.stderr)
    } finally {
        fs.rmSync(staging, { force: true, recursive: true })
    }
}

function createArchiveSet(cdnRoot, { asZip = false, includeDiff = true } = {}) {
    for (const [directory] of ARCHIVE_DIRECTORIES) {
        const isFull = directory.endsWith("-full")
        if (!includeDiff && !isFull) continue
        const fromVersion = isFull ? null : "1.4.0"
        const toVersion = isFull ? "1.4.0" : "1.4.1"
        const relativePath = `${directory}/${archiveFileName(directory, fromVersion, toVersion)}`
        const archivePath = path.join(cdnRoot, relativePath)
        if (!asZip) {
            fs.mkdirSync(path.dirname(archivePath), { recursive: true })
            fs.writeFileSync(archivePath, `archive:${directory}`)
            continue
        }

        let entries = { "metadata.json": `metadata:${directory}` }
        if (directory === "archive-common-full") entries = { [PHYSICAL_A]: "full-common" }
        if (directory === "archive-android-full") entries = { [PHYSICAL_A]: "full-platform" }
        if (directory === "archive-common-diff") entries = { [PHYSICAL_A]: "diff-common" }
        if (directory === "archive-medium-diff") entries = { [PHYSICAL_B]: "diff-quality" }
        if (directory === "archive-android-diff") entries = { [PHYSICAL_A]: "diff-platform" }
        writeZip(archivePath, entries)
    }
}

function catalogForArchiveSet(cdnRoot, { includeDiff = true } = {}) {
    const archives = []
    for (const [directory, layer] of ARCHIVE_DIRECTORIES) {
        const isFull = directory.endsWith("-full")
        if (!includeDiff && !isFull) continue
        const fromVersion = isFull ? null : "1.4.0"
        const toVersion = isFull ? "1.4.0" : "1.4.1"
        const relativePath = `${directory}/${archiveFileName(directory, fromVersion, toVersion)}`
        archives.push({
            kind: isFull ? "full" : "diff",
            fromVersion,
            toVersion,
            platform: "android",
            layer,
            order: 1,
            relativePath,
            compressedBytes: fs.statSync(path.join(cdnRoot, relativePath)).size,
            sha256: "a".repeat(64),
        })
    }
    return buildCdnCatalog({
        archives,
        installedBytes: 0,
        entityListsRelativePath: "EntityLists/fixture-android_medium.csv",
    })
}

function createArchiveFixture(t, options = {}) {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "archive-index-"))
    const cdnRoot = path.join(sandbox, "cdn")
    createArchiveSet(cdnRoot, options)
    const catalog = catalogForArchiveSet(cdnRoot, options)
    t.after(() => fs.rmSync(sandbox, { force: true, recursive: true }))
    return { catalog, cdnRoot, sandbox }
}

test("ArchiveIndex builds from central directories and applies full then diff archive order", async t => {
    const { catalog, cdnRoot } = createArchiveFixture(t, { asZip: true })
    let bodyReads = 0
    let openCalls = 0
    const openArchive = async archivePath => {
        openCalls++
        const opened = await unzipper.Open.file(archivePath)
        return {
            files: opened.files.map(file => ({
                path: file.path,
                type: file.type,
                uncompressedSize: file.uncompressedSize,
                buffer: async () => {
                    bodyReads++
                    return file.buffer()
                },
                read: async () => {
                    bodyReads++
                    return file.buffer()
                },
            })),
        }
    }

    const index = await ArchiveIndex.build(catalog, cdnRoot, { openArchive })

    assert.equal(openCalls, 6)
    assert.equal(bodyReads, 0)
    assert.equal(index.entries, undefined)
    assert.equal(index.has(PHYSICAL_A), true)
    assert.equal(index.has(PHYSICAL_B), true)
    assert.equal(index.has("production/upload/zz/invalid"), false)
    assert.deepEqual(index.location(PHYSICAL_A), {
        archiveRelativePath: `archive-android-diff/${archiveFileName("archive-android-diff", "1.4.0", "1.4.1")}`,
        entryName: PHYSICAL_A,
        uncompressedBytes: Buffer.byteLength("diff-platform"),
    })
    assert.equal(index.location("metadata.json"), null)

    const first = await index.read(PHYSICAL_A)
    const second = await index.read(PHYSICAL_A)
    assert.equal(first.toString(), "diff-platform")
    assert.equal(second.toString(), "diff-platform")
    assert.notEqual(first, second)
    first[0] = 0
    assert.equal(second.toString(), "diff-platform")
    assert.equal(bodyReads, 2)
    await assert.rejects(index.read(`production/upload/ab/${"0".repeat(38)}`), /not found/)
    await assert.rejects(index.read("../outside"), /invalid physical path/)
})

test("ArchiveIndex rejects every unsafe ZIP entry path before filtering entries", async t => {
    const { catalog, cdnRoot } = createArchiveFixture(t)
    const unsafePaths = [
        "/production/upload/ab/file",
        "production\\upload\\ab\\file",
        "production//upload/ab/file",
        "production/./upload/ab/file",
        "production/upload/../ab/file",
        "C:/production/upload/ab/file",
        "production/upload/ab/file\u0000",
    ]

    for (const entryPath of unsafePaths) {
        await assert.rejects(
            ArchiveIndex.build(catalog, cdnRoot, {
                openArchive: async () => ({
                    files: [{
                        path: entryPath,
                        type: "File",
                        uncompressedSize: 1,
                        buffer: async () => Buffer.from("x"),
                    }],
                }),
            }),
            /unsafe ZIP entry path/,
        )
    }
})

test("ArchiveIndex ignores safe non-production entries and rejects duplicates within one archive", async t => {
    const { catalog, cdnRoot } = createArchiveFixture(t)
    const safeIgnored = await ArchiveIndex.build(catalog, cdnRoot, {
        openArchive: async () => ({
            files: [
                { path: "safe-directory/", type: "Directory", uncompressedSize: 0 },
                { path: "metadata.json", type: "File", uncompressedSize: 2 },
            ],
        }),
    })
    assert.equal(safeIgnored.has(PHYSICAL_A), false)

    await assert.rejects(
        ArchiveIndex.build(catalog, cdnRoot, {
            openArchive: async () => ({
                files: [
                    { path: PHYSICAL_A, type: "File", uncompressedSize: 1 },
                    { path: PHYSICAL_A, type: "File", uncompressedSize: 1 },
                ],
            }),
        }),
        /duplicate physical path/,
    )
})

test("ArchiveIndex rejects archive symlink escapes, mutation during build, and corrupt ZIPs", async t => {
    const symlinkFixture = createArchiveFixture(t)
    const targetRelativePath = `archive-common-full/${archiveFileName("archive-common-full", null, "1.4.0")}`
    const targetPath = path.join(symlinkFixture.cdnRoot, targetRelativePath)
    const outside = path.join(symlinkFixture.sandbox, "outside.zip")
    fs.writeFileSync(outside, fs.readFileSync(targetPath))
    fs.unlinkSync(targetPath)
    fs.symlinkSync(outside, targetPath)
    const symlinkCatalog = catalogForArchiveSet(symlinkFixture.cdnRoot)
    await assert.rejects(
        ArchiveIndex.build(symlinkCatalog, symlinkFixture.cdnRoot, {
            openArchive: async () => ({ files: [] }),
        }),
        /outside cdnRoot/,
    )

    const mutationFixture = createArchiveFixture(t)
    let mutated = false
    await assert.rejects(
        ArchiveIndex.build(mutationFixture.catalog, mutationFixture.cdnRoot, {
            openArchive: async archivePath => {
                if (!mutated) {
                    mutated = true
                    fs.appendFileSync(archivePath, "changed")
                }
                return { files: [] }
            },
        }),
        /changed during index build|size does not match catalog/,
    )

    const corruptFixture = createArchiveFixture(t)
    await assert.rejects(
        ArchiveIndex.build(corruptFixture.catalog, corruptFixture.cdnRoot),
        /FILE_ENDED|signature|central directory|invalid/i,
    )
})
