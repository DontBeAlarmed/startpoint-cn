"use strict"

const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const test = require("node:test")

const packPath = path.join(__dirname, "server-bundle/pack.cjs")
const zipPath = path.join(__dirname, "server-bundle/zip.cjs")
const { collectBundleEntries, crc32, writeStoredZip } = require(zipPath)
const { canonicalJsonBuffer } = require("./server-bundle/canonical-json.cjs")

const LOCAL_SIGNATURE = 0x04034b50
const CENTRAL_SIGNATURE = 0x02014b50
const EOCD_SIGNATURE = 0x06054b50
const UTF8_FLAG = 0x0800
const DOS_1980_01_01 = 0x0021
const REGULAR_0644 = (0o100644 << 16) >>> 0
const UINT32_MAX = 0xffffffff

function write(root, relativePath, contents) {
    const destination = path.join(root, ...relativePath.split("/"))
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.writeFileSync(destination, contents)
    return destination
}

function digest(bytes) {
    return crypto.createHash("sha256").update(bytes).digest("hex")
}

function createFixture(t, files = {}) {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "server-bundle-zip-"))
    t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
    const bundleRoot = path.join(sandbox, "bundle")
    fs.mkdirSync(bundleRoot)
    for (const [relativePath, contents] of Object.entries(files)) write(bundleRoot, relativePath, contents)
    return {
        bundleRoot,
        outputPath: path.join(sandbox, "server-bundle.zip"),
        sandbox,
    }
}

function addManifest(fixture, listedPaths) {
    const files = listedPaths.map(relativePath => {
        const bytes = fs.readFileSync(path.join(fixture.bundleRoot, ...relativePath.split("/")))
        return { path: relativePath, bytes: bytes.length, sha256: digest(bytes) }
    })
    files.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
    const manifest = { files }
    write(fixture.bundleRoot, "server-manifest.json", canonicalJsonBuffer(manifest))
    return manifest
}

function createPackFixture(t, serverVersion = "1.2.3") {
    const fixture = createFixture(t, {
        "LICENSE": "GPL-3.0-or-later\n",
        "NOTICE": "notice\n",
        "out/cn-server.js": "console.log('server')\n",
        "out/content/sync/entry.js": "module.exports = {}\n",
        "web/dist/index.html": "<main>admin</main>\n",
    })
    const outputDirectory = path.join(fixture.sandbox, "dist")
    fs.mkdirSync(outputDirectory)
    const listedPaths = [
        "LICENSE",
        "NOTICE",
        "out/cn-server.js",
        "out/content/sync/entry.js",
        "web/dist/index.html",
    ]
    const files = listedPaths.map(relativePath => {
        const bytes = fs.readFileSync(path.join(fixture.bundleRoot, ...relativePath.split("/")))
        return { path: relativePath, bytes: bytes.length, sha256: digest(bytes) }
    })
    files.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
    const manifestWithoutId = {
        admin: { path: "web/dist", required: true },
        assets: {
            minClientAssetVersion: "1.4.54",
            supportedModes: ["client-owned", "local", "remote"],
        },
        entry: "out/cn-server.js",
        files,
        name: "starpoint-cn",
        ports: { http: 8001, tcp: 8003 },
        requires: {
            dependencyLock: `sha256:${"0".repeat(64)}`,
            minDataSchema: 0,
            node: ">=20.12.0",
            runtimeApi: 1,
            targetDataSchema: 19,
        },
        schemaVersion: 3,
        serverVersion,
        startup: { localPrepareEntry: "out/content/sync/entry.js" },
    }
    const manifest = {
        ...manifestWithoutId,
        bundleId: `sha256:${digest(canonicalJsonBuffer(manifestWithoutId))}`,
    }
    write(fixture.bundleRoot, "server-manifest.json", canonicalJsonBuffer(manifest))
    return {
        ...fixture,
        archiveName: `starpoint-cn-server-bundle-${serverVersion}.zip`,
        outputDirectory,
    }
}

function packCandidates(outputDirectory, archiveName) {
    return fs.readdirSync(outputDirectory)
        .filter(name => name !== archiveName)
}

function parseStoredZip(bytes) {
    assert.ok(bytes.length >= 22)
    const eocdOffset = bytes.length - 22
    assert.equal(bytes.readUInt32LE(eocdOffset), EOCD_SIGNATURE)
    assert.equal(bytes.readUInt16LE(eocdOffset + 4), 0)
    assert.equal(bytes.readUInt16LE(eocdOffset + 6), 0)
    const diskEntries = bytes.readUInt16LE(eocdOffset + 8)
    const entryCount = bytes.readUInt16LE(eocdOffset + 10)
    assert.equal(diskEntries, entryCount)
    const centralSize = bytes.readUInt32LE(eocdOffset + 12)
    const centralOffset = bytes.readUInt32LE(eocdOffset + 16)
    assert.equal(bytes.readUInt16LE(eocdOffset + 20), 0)
    assert.equal(centralOffset + centralSize, eocdOffset)

    const entries = []
    let cursor = centralOffset
    for (let index = 0; index < entryCount; index++) {
        assert.equal(bytes.readUInt32LE(cursor), CENTRAL_SIGNATURE)
        const nameLength = bytes.readUInt16LE(cursor + 28)
        const extraLength = bytes.readUInt16LE(cursor + 30)
        const commentLength = bytes.readUInt16LE(cursor + 32)
        const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength)
        const entry = {
            versionMadeBy: bytes.readUInt16LE(cursor + 4),
            versionNeeded: bytes.readUInt16LE(cursor + 6),
            flags: bytes.readUInt16LE(cursor + 8),
            method: bytes.readUInt16LE(cursor + 10),
            time: bytes.readUInt16LE(cursor + 12),
            date: bytes.readUInt16LE(cursor + 14),
            crc: bytes.readUInt32LE(cursor + 16),
            compressedSize: bytes.readUInt32LE(cursor + 20),
            size: bytes.readUInt32LE(cursor + 24),
            name: nameBytes.toString("utf8"),
            nameBytes,
            extraLength,
            commentLength,
            disk: bytes.readUInt16LE(cursor + 34),
            internalAttributes: bytes.readUInt16LE(cursor + 36),
            externalAttributes: bytes.readUInt32LE(cursor + 38),
            localOffset: bytes.readUInt32LE(cursor + 42),
        }
        cursor += 46 + nameLength + extraLength + commentLength

        const local = entry.localOffset
        assert.equal(bytes.readUInt32LE(local), LOCAL_SIGNATURE)
        const localNameLength = bytes.readUInt16LE(local + 26)
        const localExtraLength = bytes.readUInt16LE(local + 28)
        const localName = bytes.subarray(local + 30, local + 30 + localNameLength)
        assert.equal(bytes.readUInt16LE(local + 4), entry.versionNeeded)
        assert.equal(bytes.readUInt16LE(local + 6), entry.flags)
        assert.equal(bytes.readUInt16LE(local + 8), entry.method)
        assert.equal(bytes.readUInt16LE(local + 10), entry.time)
        assert.equal(bytes.readUInt16LE(local + 12), entry.date)
        assert.equal(bytes.readUInt32LE(local + 14), entry.crc)
        assert.equal(bytes.readUInt32LE(local + 18), entry.compressedSize)
        assert.equal(bytes.readUInt32LE(local + 22), entry.size)
        assert.deepEqual(localName, nameBytes)
        assert.equal(localExtraLength, 0)
        const payloadOffset = local + 30 + localNameLength
        entry.payload = bytes.subarray(payloadOffset, payloadOffset + entry.size)
        entry.localEnd = payloadOffset + entry.size
        entries.push(entry)
    }
    assert.equal(cursor, eocdOffset)
    for (let index = 0; index < entries.length; index++) {
        assert.equal(entries[index].localEnd, entries[index + 1]?.localOffset ?? centralOffset)
    }
    return entries
}

function plannedEntry(sourcePath, name, size = fs.statSync(sourcePath).size) {
    const bytes = fs.readFileSync(sourcePath)
    return { name, sourcePath, size, sha256: digest(bytes), crc32: crc32(bytes) }
}

function assertNoOutputOrTemps(outputPath) {
    assert.equal(fs.existsSync(outputPath), false)
    assertNoTemps(outputPath)
}

function assertNoTemps(outputPath) {
    const parent = path.dirname(outputPath)
    const prefix = `.${path.basename(outputPath)}.tmp-`
    assert.deepEqual(fs.readdirSync(parent).filter(name => name.startsWith(prefix)), [])
}

test("exports the server bundle ZIP32 encoder surface", () => {
    assert.deepEqual(
        Object.keys(require(zipPath)).sort(),
        ["collectBundleEntries", "crc32", "writeStoredZip"],
    )
})

test("exports the server bundle packer surface", () => {
    assert.equal(fs.existsSync(packPath), true, "server bundle packer must exist")
    assert.deepEqual(
        Object.keys(require(packPath)).sort(),
        ["packServerBundle", "parseArguments"],
    )
})

test("parses strict pack CLI arguments with project dist defaults", () => {
    const { parseArguments } = require(packPath)
    assert.deepEqual(parseArguments([]), {
        bundleRoot: path.resolve(__dirname, "../dist/server-bundle"),
        outputDirectory: path.resolve(__dirname, "../dist"),
    })
    assert.deepEqual(parseArguments(["--bundle", "custom-bundle", "--output", "release"]), {
        bundleRoot: "custom-bundle",
        outputDirectory: "release",
    })

    for (const argv of [
        ["--bundle"],
        ["--bundle", "--output", "release"],
        ["--bundle", "one", "--bundle", "two"],
        ["--output"],
        ["--output", "--bundle", "one"],
        ["--output", "one", "--output", "two"],
        ["bundle"],
        ["--unknown", "value"],
    ]) {
        assert.throws(() => parseArguments(argv), /pack argument|--bundle|--output/i)
    }
})

test("packs verified bundles by server version and repeats idempotently", t => {
    const fixture = createPackFixture(t, "1.2.3-test.1")
    const { packServerBundle } = require(packPath)

    const first = packServerBundle({
        bundleRoot: fixture.bundleRoot,
        outputDirectory: fixture.outputDirectory,
    })
    const archivePath = path.join(fixture.outputDirectory, fixture.archiveName)
    const firstBytes = fs.readFileSync(archivePath)
    assert.deepEqual(first, {
        archiveName: fixture.archiveName,
        cleanupPending: false,
        outputPath: archivePath,
        status: "created",
        warnings: [],
    })
    assert.deepEqual(
        parseStoredZip(firstBytes).map(entry => entry.name),
        [
            "server-bundle/LICENSE",
            "server-bundle/NOTICE",
            "server-bundle/out/cn-server.js",
            "server-bundle/out/content/sync/entry.js",
            "server-bundle/server-manifest.json",
            "server-bundle/web/dist/index.html",
        ],
    )

    const second = packServerBundle({
        bundleRoot: fixture.bundleRoot,
        outputDirectory: fixture.outputDirectory,
    })
    assert.equal(second.status, "unchanged")
    assert.equal(second.cleanupPending, false)
    assert.deepEqual(second.warnings, [])
    assert.deepEqual(fs.readFileSync(archivePath), firstBytes)
    assert.deepEqual(packCandidates(fixture.outputDirectory, fixture.archiveName), [])
})

test("rejects a differing same-name archive without replacing it", t => {
    const fixture = createPackFixture(t)
    const { packServerBundle } = require(packPath)
    packServerBundle({ bundleRoot: fixture.bundleRoot, outputDirectory: fixture.outputDirectory })
    const archivePath = path.join(fixture.outputDirectory, fixture.archiveName)
    const conflictingBytes = fs.readFileSync(archivePath)
    conflictingBytes[0] ^= 0xff
    fs.writeFileSync(archivePath, conflictingBytes)

    assert.throws(
        () => packServerBundle({ bundleRoot: fixture.bundleRoot, outputDirectory: fixture.outputDirectory }),
        /archive.*(?:differs|conflict)/i,
    )
    assert.deepEqual(fs.readFileSync(archivePath), conflictingBytes)
    assert.deepEqual(packCandidates(fixture.outputDirectory, fixture.archiveName), [])
})

test("rejects an existing archive modified in place during byte comparison", t => {
    const fixture = createPackFixture(t)
    const { packServerBundle } = require(packPath)
    packServerBundle({ bundleRoot: fixture.bundleRoot, outputDirectory: fixture.outputDirectory })
    const archivePath = path.join(fixture.outputDirectory, fixture.archiveName)
    const originalBytes = fs.readFileSync(archivePath)
    const conflictingBytes = Buffer.from(originalBytes)
    conflictingBytes[conflictingBytes.length - 1] ^= 0xff
    const originalStatus = fs.lstatSync(archivePath, { bigint: true })
    const io = Object.create(fs)
    let candidateDescriptor
    let candidateFlags
    let existingDescriptor
    let existingFlags
    let mutated = false
    const bigintFstats = new Map()

    io.openSync = (filePath, flags, mode) => {
        const descriptor = fs.openSync(filePath, flags, mode)
        const basename = path.basename(filePath)
        if (path.resolve(filePath) === archivePath) {
            existingDescriptor = descriptor
            existingFlags = flags
        } else if (basename.includes(".candidate-") && !basename.includes(".tmp-")) {
            candidateDescriptor = descriptor
            candidateFlags = flags
        }
        return descriptor
    }
    io.fstatSync = (descriptor, options) => {
        if ((descriptor === candidateDescriptor || descriptor === existingDescriptor)
            && options?.bigint === true) {
            bigintFstats.set(descriptor, (bigintFstats.get(descriptor) ?? 0) + 1)
        }
        return fs.fstatSync(descriptor, options)
    }
    io.readSync = (descriptor, buffer, offset, length, position) => {
        const bytesRead = fs.readSync(descriptor, buffer, offset, length, position)
        if (descriptor === existingDescriptor && !mutated && bytesRead > 0) {
            const writeDescriptor = fs.openSync(archivePath, fs.constants.O_WRONLY)
            try {
                fs.writeSync(writeDescriptor, conflictingBytes, 0, conflictingBytes.length, 0)
                fs.fsyncSync(writeDescriptor)
            } finally {
                fs.closeSync(writeDescriptor)
            }
            const changedTime = new Date(Date.now() + 2_000)
            fs.utimesSync(archivePath, changedTime, changedTime)
            mutated = true
        }
        return bytesRead
    }

    assert.throws(
        () => packServerBundle({
            bundleRoot: fixture.bundleRoot,
            outputDirectory: fixture.outputDirectory,
            fs: io,
        }),
        /archive.*(?:differs|conflict)|changed during byte comparison/i,
    )
    assert.equal(mutated, true)
    assert.equal(candidateFlags & fs.constants.O_NOFOLLOW, fs.constants.O_NOFOLLOW)
    assert.equal(existingFlags & fs.constants.O_NOFOLLOW, fs.constants.O_NOFOLLOW)
    assert.ok(bigintFstats.get(candidateDescriptor) >= 2)
    assert.ok(bigintFstats.get(existingDescriptor) >= 2)
    const finalStatus = fs.lstatSync(archivePath, { bigint: true })
    assert.equal(finalStatus.dev, originalStatus.dev)
    assert.equal(finalStatus.ino, originalStatus.ino)
    assert.equal(finalStatus.size, originalStatus.size)
    assert.deepEqual(fs.readFileSync(archivePath), conflictingBytes)
    assert.deepEqual(packCandidates(fixture.outputDirectory, fixture.archiveName), [])
})

test("cleans the candidate when the existing archive becomes unavailable during comparison", async t => {
    await t.test("existing archive disappears", t => {
        const fixture = createPackFixture(t)
        const { packServerBundle } = require(packPath)
        packServerBundle({ bundleRoot: fixture.bundleRoot, outputDirectory: fixture.outputDirectory })
        const archivePath = path.join(fixture.outputDirectory, fixture.archiveName)
        const io = Object.create(fs)
        let removed = false
        io.lstatSync = (filePath, options) => {
            if (!removed && path.resolve(filePath) === archivePath) {
                fs.unlinkSync(archivePath)
                removed = true
                const error = new Error("injected existing disappearance")
                error.code = "ENOENT"
                throw error
            }
            return fs.lstatSync(filePath, options)
        }

        assert.throws(
            () => packServerBundle({
                bundleRoot: fixture.bundleRoot,
                outputDirectory: fixture.outputDirectory,
                fs: io,
            }),
            /existing archive.*missing|unreadable/i,
        )
        assert.equal(removed, true)
        assert.equal(fs.existsSync(archivePath), false)
        assert.deepEqual(packCandidates(fixture.outputDirectory, fixture.archiveName), [])
    })

    await t.test("existing archive cannot be opened", t => {
        const fixture = createPackFixture(t)
        const { packServerBundle } = require(packPath)
        packServerBundle({ bundleRoot: fixture.bundleRoot, outputDirectory: fixture.outputDirectory })
        const archivePath = path.join(fixture.outputDirectory, fixture.archiveName)
        const archiveBytes = fs.readFileSync(archivePath)
        const io = Object.create(fs)
        let rejected = false
        io.openSync = (filePath, flags, mode) => {
            if (path.resolve(filePath) === archivePath) {
                rejected = true
                const error = new Error("injected existing unreadable")
                error.code = "EACCES"
                throw error
            }
            return fs.openSync(filePath, flags, mode)
        }

        assert.throws(
            () => packServerBundle({
                bundleRoot: fixture.bundleRoot,
                outputDirectory: fixture.outputDirectory,
                fs: io,
            }),
            /injected existing unreadable/i,
        )
        assert.equal(rejected, true)
        assert.deepEqual(fs.readFileSync(archivePath), archiveBytes)
        assert.deepEqual(packCandidates(fixture.outputDirectory, fixture.archiveName), [])
    })
})

test("reports safe merged cleanup details when comparison and candidate cleanup fail", t => {
    const fixture = createPackFixture(t)
    const { packServerBundle } = require(packPath)
    packServerBundle({ bundleRoot: fixture.bundleRoot, outputDirectory: fixture.outputDirectory })
    const archivePath = path.join(fixture.outputDirectory, fixture.archiveName)
    const archiveBytes = fs.readFileSync(archivePath)
    const comparisonError = new Error(`injected comparison failure at ${archivePath}`)
    comparisonError.code = "EACCES"
    const io = Object.create(fs)
    let candidatePath
    let candidateFile
    let candidateCleanupAttempts = 0
    let zipTemporaryPath
    let zipCleanupAttempts = 0

    io.openSync = (filePath, flags, mode) => {
        if (path.resolve(filePath) === archivePath) throw comparisonError
        const descriptor = fs.openSync(filePath, flags, mode)
        if (path.basename(filePath).includes(".tmp-")) zipTemporaryPath = filePath
        return descriptor
    }
    io.linkSync = (source, destination) => {
        const basename = path.basename(destination)
        if (basename.includes(".candidate-") && !basename.includes(".tmp-")) {
            candidatePath = destination
            candidateFile = basename
        }
        return fs.linkSync(source, destination)
    }
    io.unlinkSync = filePath => {
        if (filePath === zipTemporaryPath) {
            zipCleanupAttempts++
            const error = new Error("injected ZIP temporary cleanup failure")
            error.code = "EBUSY"
            throw error
        }
        if (path.basename(filePath) === candidateFile) {
            candidateCleanupAttempts++
            const error = new Error("injected candidate cleanup failure")
            error.code = "EBUSY"
            throw error
        }
        return fs.unlinkSync(filePath)
    }

    assert.throws(
        () => packServerBundle({
            bundleRoot: fixture.bundleRoot,
            outputDirectory: fixture.outputDirectory,
            fs: io,
        }),
        error => {
            assert.equal(error.cause, comparisonError)
            assert.match(error.message, /archive decision failed.*cleanup remains.*temporary file/i)
            assert.equal(error.message.includes(path.basename(candidatePath)), true)
            assert.equal(error.message.includes(fixture.sandbox), false)
            assert.equal(Array.isArray(error.warnings), true)
            assert.equal(error.warnings.length, 2)
            assert.equal(error.warnings.some(warning => (
                warning.includes(path.basename(zipTemporaryPath))
            )), true)
            assert.equal(error.warnings.some(warning => (
                warning.includes(path.basename(candidatePath))
            )), true)
            assert.equal(error.warnings.every(warning => !warning.includes(fixture.sandbox)), true)
            return true
        },
    )
    assert.equal(zipCleanupAttempts, 1)
    assert.equal(candidateCleanupAttempts, 1)
    assert.equal(fs.existsSync(zipTemporaryPath), true)
    assert.equal(fs.existsSync(candidatePath), true)
    assert.deepEqual(fs.readFileSync(archivePath), archiveBytes)
})

test("verification failure creates no archive or temporary candidate", t => {
    const fixture = createPackFixture(t)
    fs.writeFileSync(path.join(fixture.bundleRoot, "out/cn-server.js"), "damaged\n")
    const { packServerBundle } = require(packPath)

    assert.throws(
        () => packServerBundle({ bundleRoot: fixture.bundleRoot, outputDirectory: fixture.outputDirectory }),
        /wrong (?:size|hash)/i,
    )
    assert.deepEqual(fs.readdirSync(fixture.outputDirectory), [])
})

test("passes the verified manifest to the ZIP writer before publication", t => {
    const fixture = createPackFixture(t)
    const { packServerBundle } = require(packPath)
    const io = Object.create(fs)
    let mutated = false
    io.lstatSync = filePath => {
        const status = fs.lstatSync(filePath)
        if (!mutated && path.resolve(filePath) === path.resolve(fixture.bundleRoot)) {
            mutated = true
            fs.writeFileSync(path.join(fixture.bundleRoot, "out/cn-server.js"), "changed after verify\n")
        }
        return status
    }

    assert.throws(
        () => packServerBundle({
            bundleRoot: fixture.bundleRoot,
            outputDirectory: fixture.outputDirectory,
            fs: io,
        }),
        /verified manifest.*(?:size|hash)|match.*verified manifest/i,
    )
    assert.equal(mutated, true)
    assert.deepEqual(fs.readdirSync(fixture.outputDirectory), [])
})

test("reports ZIP writer cleanupPending as committed success without private paths", t => {
    const fixture = createPackFixture(t)
    const { packServerBundle } = require(packPath)
    const io = Object.create(fs)
    let rejectedTemporary
    io.unlinkSync = filePath => {
        if (rejectedTemporary === undefined && path.basename(filePath).includes(".tmp-")) {
            rejectedTemporary = filePath
            const error = new Error("injected cleanup failure")
            error.code = "EBUSY"
            throw error
        }
        return fs.unlinkSync(filePath)
    }

    const result = packServerBundle({
        bundleRoot: fixture.bundleRoot,
        outputDirectory: fixture.outputDirectory,
        fs: io,
    })
    assert.equal(result.status, "created")
    assert.equal(result.cleanupPending, true)
    assert.equal(fs.existsSync(path.join(fixture.outputDirectory, fixture.archiveName)), true)
    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0], /committed.*cleanup.*temporary/i)
    assert.equal(result.warnings[0].includes(fixture.sandbox), false)
    assert.equal(result.warnings[0].includes(path.basename(rejectedTemporary)), true)
})

test("pack CLI supports explicit paths, idempotence, and private-path-safe errors", t => {
    const fixture = createPackFixture(t)
    const argumentsList = [
        packPath,
        "--bundle",
        fixture.bundleRoot,
        "--output",
        fixture.outputDirectory,
    ]
    const first = spawnSync(process.execPath, argumentsList, { encoding: "utf8" })
    assert.equal(first.status, 0, first.stderr)
    assert.equal(first.stdout, `Packed ${fixture.archiveName} (created)\n`)
    assert.equal(first.stderr, "")

    const second = spawnSync(process.execPath, argumentsList, { encoding: "utf8" })
    assert.equal(second.status, 0, second.stderr)
    assert.equal(second.stdout, `Packed ${fixture.archiveName} (unchanged)\n`)
    assert.equal(second.stderr, "")

    fs.writeFileSync(path.join(fixture.bundleRoot, "out/cn-server.js"), "damaged\n")
    const damaged = spawnSync(process.execPath, argumentsList, { encoding: "utf8" })
    assert.equal(damaged.status, 1)
    assert.match(damaged.stderr, /packaging failed.*wrong (?:size|hash)/i)
    assert.match(damaged.stderr, /out\/cn-server\.js/)
    assert.equal(damaged.stderr.includes(fixture.sandbox), false)
})

test("computes the standard CRC-32 check value", () => {
    assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926)
})

test("writes deterministic STORE archives with stable UTF-8 ordering and exact payloads", t => {
    const fixture = createFixture(t, {
        "z-last.bin": Buffer.from([0x00, 0xff, 0x7f]),
        "a/empty.txt": Buffer.alloc(0),
        "é.txt": Buffer.from("utf8 payload\n"),
    })
    const manifest = addManifest(fixture, ["z-last.bin", "a/empty.txt", "é.txt"])
    const secondOutput = path.join(fixture.sandbox, "copy.zip")

    const entries = collectBundleEntries({ bundleRoot: fixture.bundleRoot, verifiedManifest: manifest })
    assert.deepEqual(entries.map(entry => entry.name), [
        "server-bundle/a/empty.txt",
        "server-bundle/server-manifest.json",
        "server-bundle/z-last.bin",
        "server-bundle/é.txt",
    ])
    writeStoredZip({ bundleRoot: fixture.bundleRoot, outputPath: fixture.outputPath, verifiedManifest: manifest })
    fs.utimesSync(path.join(fixture.bundleRoot, "z-last.bin"), new Date(), new Date())
    writeStoredZip({ bundleRoot: fixture.bundleRoot, outputPath: secondOutput, verifiedManifest: manifest })

    const firstBytes = fs.readFileSync(fixture.outputPath)
    assert.deepEqual(fs.readFileSync(secondOutput), firstBytes)
    const parsed = parseStoredZip(firstBytes)
    assert.deepEqual(parsed.map(entry => entry.name), entries.map(entry => entry.name))
    for (const entry of parsed) {
        assert.equal(entry.versionMadeBy, 0x0314)
        assert.equal(entry.versionNeeded, 20)
        assert.equal(entry.flags, UTF8_FLAG)
        assert.equal(entry.method, 0)
        assert.equal(entry.time, 0)
        assert.equal(entry.date, DOS_1980_01_01)
        assert.equal(entry.compressedSize, entry.size)
        assert.equal(entry.extraLength, 0)
        assert.equal(entry.commentLength, 0)
        assert.equal(entry.disk, 0)
        assert.equal(entry.internalAttributes, 0)
        assert.equal(entry.externalAttributes, REGULAR_0644)
        assert.equal(entry.crc, crc32(entry.payload))
        const relativePath = entry.name.slice("server-bundle/".length)
        assert.deepEqual(entry.payload, fs.readFileSync(path.join(fixture.bundleRoot, ...relativePath.split("/"))))
    }
})

test("verified manifest metadata is enforced and source mutation aborts publication", t => {
    const fixture = createFixture(t, { "out/server.js": "before\n" })
    const manifest = addManifest(fixture, ["out/server.js"])
    const entries = collectBundleEntries({ bundleRoot: fixture.bundleRoot, verifiedManifest: manifest })
    fs.writeFileSync(path.join(fixture.bundleRoot, "out/server.js"), "mutate\n")

    assert.throws(
        () => writeStoredZip({
            bundleRoot: fixture.bundleRoot,
            outputPath: fixture.outputPath,
            verifiedManifest: manifest,
            entries,
        }),
        /changed|mutation|size|hash/i,
    )
    assertNoOutputOrTemps(fixture.outputPath)

    manifest.files[0].sha256 = "0".repeat(64)
    assert.throws(
        () => collectBundleEntries({ bundleRoot: fixture.bundleRoot, verifiedManifest: manifest }),
        /manifest|hash/i,
    )
})

test("rejects a disk manifest replaced after verification", t => {
    const fixture = createFixture(t, { "out/server.js": "payload\n" })
    const verifiedManifest = addManifest(fixture, ["out/server.js"])
    fs.writeFileSync(
        path.join(fixture.bundleRoot, "server-manifest.json"),
        canonicalJsonBuffer({ ...verifiedManifest, replaced: true }),
    )

    assert.throws(
        () => writeStoredZip({
            bundleRoot: fixture.bundleRoot,
            outputPath: fixture.outputPath,
            verifiedManifest,
        }),
        /manifest.*(?:size|hash|match)|size.*hash/i,
    )
    assertNoOutputOrTemps(fixture.outputPath)
})

test("rejects a source parent replaced by a symlink after collection", t => {
    const fixture = createFixture(t, { "out/server.js": "same bytes\n" })
    const entries = collectBundleEntries({ bundleRoot: fixture.bundleRoot })
    const externalRoot = path.join(fixture.sandbox, "external")
    write(externalRoot, "server.js", "same bytes\n")
    fs.renameSync(path.join(fixture.bundleRoot, "out"), path.join(fixture.bundleRoot, "out-original"))
    fs.symlinkSync(externalRoot, path.join(fixture.bundleRoot, "out"))

    assert.throws(
        () => writeStoredZip({ bundleRoot: fixture.bundleRoot, outputPath: fixture.outputPath, entries }),
        /symbolic link|unsafe source|outside.*bundle|changed/i,
    )
    assertNoOutputOrTemps(fixture.outputPath)
})

test("rejects non-ordinary bundle inputs", async t => {
    await t.test("missing and non-directory roots", () => {
        const fixture = createFixture(t)
        const plainFile = write(fixture.sandbox, "plain", "x")
        assert.throws(() => collectBundleEntries({ bundleRoot: path.join(fixture.sandbox, "missing") }), /root.*missing/i)
        assert.throws(() => collectBundleEntries({ bundleRoot: plainFile }), /root.*directory/i)
    })

    await t.test("symlink roots and entries", () => {
        const fixture = createFixture(t, { "real.txt": "x" })
        const rootLink = path.join(fixture.sandbox, "bundle-link")
        fs.symlinkSync(fixture.bundleRoot, rootLink)
        assert.throws(() => collectBundleEntries({ bundleRoot: rootLink }), /root.*symbolic link/i)
        fs.symlinkSync(path.join(fixture.bundleRoot, "real.txt"), path.join(fixture.bundleRoot, "link.txt"))
        assert.throws(() => collectBundleEntries({ bundleRoot: fixture.bundleRoot }), /symbolic link/i)
    })

    await t.test("special files", () => {
        if (process.platform === "win32") return t.skip("FIFO fixtures require POSIX")
        const fixture = createFixture(t, { "regular.txt": "x" })
        const fifo = path.join(fixture.bundleRoot, "runtime.pipe")
        const result = spawnSync("mkfifo", [fifo])
        assert.equal(result.status, 0)
        assert.throws(() => collectBundleEntries({ bundleRoot: fixture.bundleRoot }), /regular file|directory/i)
    })
})

test("refuses unsafe and conflicting destinations", t => {
    const fixture = createFixture(t, { "file.txt": "payload" })
    const entries = collectBundleEntries({ bundleRoot: fixture.bundleRoot })
    assert.throws(
        () => writeStoredZip({ bundleRoot: fixture.bundleRoot, outputPath: path.join(fixture.bundleRoot, "inside.zip"), entries }),
        /inside.*bundle root/i,
    )
    assert.throws(
        () => writeStoredZip({ bundleRoot: fixture.bundleRoot, outputPath: path.join(fixture.sandbox, "missing/out.zip"), entries }),
        /destination.*parent|parent.*directory/i,
    )
    fs.writeFileSync(fixture.outputPath, "occupied")
    assert.throws(
        () => writeStoredZip({ bundleRoot: fixture.bundleRoot, outputPath: fixture.outputPath, entries }),
        /destination.*exist|conflict/i,
    )
    assert.equal(fs.readFileSync(fixture.outputPath, "utf8"), "occupied")
})

test("publishes through a real parent resolved from a directory symlink", t => {
    const fixture = createFixture(t, { "file.txt": "payload" })
    const entries = collectBundleEntries({ bundleRoot: fixture.bundleRoot })
    const realParent = path.join(fixture.sandbox, "real-output")
    const linkedParent = path.join(fixture.sandbox, "linked-output")
    fs.mkdirSync(realParent)
    fs.symlinkSync(realParent, linkedParent, "dir")
    const linkedOutput = path.join(linkedParent, "archive.zip")
    const io = Object.create(fs)
    let temporaryPath
    io.openSync = (filePath, flags, mode) => {
        const descriptor = fs.openSync(filePath, flags, mode)
        if (path.basename(filePath).startsWith(".archive.zip.tmp-")) temporaryPath = filePath
        return descriptor
    }

    writeStoredZip({ bundleRoot: fixture.bundleRoot, outputPath: linkedOutput, entries, fs: io })
    assert.equal(path.dirname(temporaryPath), fs.realpathSync(realParent))
    assert.equal(fs.existsSync(linkedOutput), true)
    assertNoTemps(linkedOutput)

    const bundleParentLink = path.join(fixture.sandbox, "bundle-parent-link")
    fs.symlinkSync(fixture.bundleRoot, bundleParentLink, "dir")
    assert.throws(
        () => writeStoredZip({
            bundleRoot: fixture.bundleRoot,
            outputPath: path.join(bundleParentLink, "escaped.zip"),
            entries,
        }),
        /inside.*bundle root/i,
    )
})

test("preflights ZIP32 entry, name, size, and offset bounds from planned metadata", t => {
    const fixture = createFixture(t, { "file.txt": "x" })
    const sourcePath = path.join(fixture.bundleRoot, "file.txt")
    const valid = plannedEntry(sourcePath, "server-bundle/file.txt")

    assert.throws(
        () => writeStoredZip({
            bundleRoot: fixture.bundleRoot,
            outputPath: fixture.outputPath,
            entries: new Array(65535).fill(valid),
        }),
        /65534|entry count|ZIP32/i,
    )
    assert.throws(
        () => writeStoredZip({
            bundleRoot: fixture.bundleRoot,
            outputPath: fixture.outputPath,
            entries: [{ ...valid, name: `server-bundle/${"x".repeat(65536)}` }],
        }),
        /name.*65535|ZIP32/i,
    )
    assert.throws(
        () => writeStoredZip({
            bundleRoot: fixture.bundleRoot,
            outputPath: fixture.outputPath,
            entries: [{ ...valid, size: UINT32_MAX + 1 }],
        }),
        /size.*ZIP32|size.*32/i,
    )
    assert.throws(
        () => writeStoredZip({
            bundleRoot: fixture.bundleRoot,
            outputPath: fixture.outputPath,
            entries: [{ ...valid, size: UINT32_MAX }],
        }),
        /offset.*ZIP32|offset.*32/i,
    )
    assertNoOutputOrTemps(fixture.outputPath)
})

test("fsyncs and closes a sibling unique temporary file before atomic no-replace publication", t => {
    const fixture = createFixture(t, { "file.txt": "payload" })
    const entries = collectBundleEntries({ bundleRoot: fixture.bundleRoot })
    const io = Object.create(fs)
    const events = []
    let outputDescriptor
    let temporaryPath
    io.openSync = (filePath, flags, mode) => {
        const descriptor = fs.openSync(filePath, flags, mode)
        if (path.basename(filePath).startsWith(`.${path.basename(fixture.outputPath)}.tmp-`)) {
            outputDescriptor = descriptor
            temporaryPath = filePath
            events.push("open")
        }
        return descriptor
    }
    io.fsyncSync = descriptor => {
        if (descriptor === outputDescriptor) events.push("fsync")
        return fs.fsyncSync(descriptor)
    }
    io.closeSync = descriptor => {
        if (descriptor === outputDescriptor) events.push("close")
        return fs.closeSync(descriptor)
    }
    io.linkSync = (source, destination) => {
        events.push("link")
        return fs.linkSync(source, destination)
    }
    io.unlinkSync = target => {
        if (target === temporaryPath) events.push("unlink")
        return fs.unlinkSync(target)
    }

    writeStoredZip({ bundleRoot: fixture.bundleRoot, outputPath: fixture.outputPath, entries, fs: io })
    assert.deepEqual(events, ["open", "fsync", "close", "link", "unlink"])
    assert.equal(path.dirname(temporaryPath), fs.realpathSync(path.dirname(fixture.outputPath)))
    assert.notEqual(temporaryPath, fixture.outputPath)
    assert.equal(fs.existsSync(temporaryPath), false)
})

test("cleans the temporary archive when publication fails", t => {
    const fixture = createFixture(t, { "file.txt": "payload" })
    const entries = collectBundleEntries({ bundleRoot: fixture.bundleRoot })
    const io = Object.create(fs)
    let attemptedTemporaryPath
    io.linkSync = source => {
        attemptedTemporaryPath = source
        throw new Error("injected link failure")
    }

    assert.throws(
        () => writeStoredZip({ bundleRoot: fixture.bundleRoot, outputPath: fixture.outputPath, entries, fs: io }),
        /injected link failure/,
    )
    assert.equal(path.dirname(attemptedTemporaryPath), fs.realpathSync(path.dirname(fixture.outputPath)))
    assertNoOutputOrTemps(fixture.outputPath)
})

test("preserves a destination that appears at publication and cleans the temporary archive", t => {
    const fixture = createFixture(t, { "file.txt": "payload" })
    const entries = collectBundleEntries({ bundleRoot: fixture.bundleRoot })
    const io = Object.create(fs)
    const racedBytes = Buffer.from("raced destination\n")
    io.linkSync = (source, destination) => {
        fs.writeFileSync(destination, racedBytes)
        const error = new Error("platform-specific link conflict")
        error.code = "EPERM"
        throw error
    }

    assert.throws(
        () => writeStoredZip({ bundleRoot: fixture.bundleRoot, outputPath: fixture.outputPath, entries, fs: io }),
        error => {
            assert.match(error.message, /destination.*(?:appeared|exist|conflict)/i)
            assert.equal(error.code, "EEXIST")
            return true
        },
    )
    assert.deepEqual(fs.readFileSync(fixture.outputPath), racedBytes)
    assertNoTemps(fixture.outputPath)
})

test("preserves a replacement installed at the temporary name after unlink failure", t => {
    const fixture = createFixture(t, { "file.txt": "payload" })
    const entries = collectBundleEntries({ bundleRoot: fixture.bundleRoot })
    const io = Object.create(fs)
    let temporaryPath
    let temporaryUnlinks = 0
    const replacement = Buffer.from("temporary replacement\n")
    io.openSync = (filePath, flags, mode) => {
        const descriptor = fs.openSync(filePath, flags, mode)
        if (path.basename(filePath).startsWith(`.${path.basename(fixture.outputPath)}.tmp-`)) {
            temporaryPath = filePath
        }
        return descriptor
    }
    io.unlinkSync = target => {
        if (target === temporaryPath) {
            temporaryUnlinks++
            if (temporaryUnlinks === 1) {
                fs.unlinkSync(temporaryPath)
                fs.writeFileSync(temporaryPath, replacement)
            }
            const error = new Error("temporary unlink failure")
            error.code = "EBUSY"
            throw error
        }
        return fs.unlinkSync(target)
    }

    const result = writeStoredZip({ bundleRoot: fixture.bundleRoot, outputPath: fixture.outputPath, entries, fs: io })
    assert.deepEqual(result, {
        published: true,
        cleanupPending: true,
        temporaryFile: path.basename(temporaryPath),
    })
    assert.equal(result.temporaryFile.includes("/"), false)
    assert.equal(result.temporaryFile.includes("\\"), false)
    assert.equal(temporaryUnlinks, 1)
    const archiveEntries = parseStoredZip(fs.readFileSync(fixture.outputPath))
    assert.deepEqual(archiveEntries.map(entry => entry.name), ["server-bundle/file.txt"])
    assert.deepEqual(archiveEntries[0].payload, Buffer.from("payload"))
    assert.deepEqual(fs.readFileSync(temporaryPath), replacement)
})

test("never deletes a concurrently replaced target after publication", t => {
    const fixture = createFixture(t, { "file.txt": "payload" })
    const entries = collectBundleEntries({ bundleRoot: fixture.bundleRoot })
    const io = Object.create(fs)
    let temporaryPath
    let publishedOutputPath
    let temporaryUnlinks = 0
    let outputUnlinks = 0
    const replacement = Buffer.from("concurrent replacement\n")
    io.openSync = (filePath, flags, mode) => {
        const descriptor = fs.openSync(filePath, flags, mode)
        if (path.basename(filePath).startsWith(`.${path.basename(fixture.outputPath)}.tmp-`)) {
            temporaryPath = filePath
        }
        return descriptor
    }
    io.linkSync = (source, destination) => {
        publishedOutputPath = destination
        return fs.linkSync(source, destination)
    }
    io.unlinkSync = target => {
        if (target === temporaryPath) {
            temporaryUnlinks++
            if (temporaryUnlinks === 1) {
                fs.unlinkSync(fixture.outputPath)
                fs.writeFileSync(fixture.outputPath, replacement)
            }
            const error = new Error("persistent temporary unlink failure")
            error.code = "EBUSY"
            throw error
        }
        if (target === publishedOutputPath) outputUnlinks++
        return fs.unlinkSync(target)
    }

    const result = writeStoredZip({ bundleRoot: fixture.bundleRoot, outputPath: fixture.outputPath, entries, fs: io })
    assert.equal(temporaryUnlinks, 1)
    assert.equal(outputUnlinks, 0)
    assert.deepEqual(fs.readFileSync(fixture.outputPath), replacement)
    assert.deepEqual(result, {
        published: true,
        cleanupPending: true,
        temporaryFile: path.basename(temporaryPath),
    })
    assert.equal(fs.existsSync(temporaryPath), true)
})
