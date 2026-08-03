"use strict"

const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const test = require("node:test")

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

test("retries a one-time temporary unlink failure after publication", t => {
    const fixture = createFixture(t, { "file.txt": "payload" })
    const entries = collectBundleEntries({ bundleRoot: fixture.bundleRoot })
    const io = Object.create(fs)
    let temporaryPath
    let temporaryUnlinks = 0
    io.openSync = (filePath, flags, mode) => {
        const descriptor = fs.openSync(filePath, flags, mode)
        if (path.basename(filePath).startsWith(`.${path.basename(fixture.outputPath)}.tmp-`)) {
            temporaryPath = filePath
        }
        return descriptor
    }
    io.unlinkSync = target => {
        if (target === temporaryPath && ++temporaryUnlinks === 1) {
            const error = new Error("one-time temporary unlink failure")
            error.code = "EBUSY"
            throw error
        }
        return fs.unlinkSync(target)
    }

    const result = writeStoredZip({ bundleRoot: fixture.bundleRoot, outputPath: fixture.outputPath, entries, fs: io })
    assert.deepEqual(result, { published: true, cleanupPending: false })
    assert.equal(temporaryUnlinks, 2)
    assert.equal(fs.existsSync(fixture.outputPath), true)
    assert.equal(fs.existsSync(temporaryPath), false)
})

test("returns committed cleanup-pending status when temporary unlink keeps failing", t => {
    const fixture = createFixture(t, { "file.txt": "payload" })
    const entries = collectBundleEntries({ bundleRoot: fixture.bundleRoot })
    const io = Object.create(fs)
    let temporaryPath
    let temporaryUnlinks = 0
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
            const error = new Error("persistent temporary unlink failure")
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
    assert.equal(temporaryUnlinks, 2)
    const archiveEntries = parseStoredZip(fs.readFileSync(fixture.outputPath))
    assert.deepEqual(archiveEntries.map(entry => entry.name), ["server-bundle/file.txt"])
    assert.deepEqual(archiveEntries[0].payload, Buffer.from("payload"))
    assert.equal(fs.existsSync(temporaryPath), true)
})

test("never deletes a concurrently replaced target after publication", t => {
    const fixture = createFixture(t, { "file.txt": "payload" })
    const entries = collectBundleEntries({ bundleRoot: fixture.bundleRoot })
    const io = Object.create(fs)
    let temporaryPath
    let publishedOutputPath
    let temporaryUnlinks = 0
    let outputUnlinks = 0
    let replacementInstalled = false
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
            if (temporaryUnlinks === 2) {
                fs.unlinkSync(fixture.outputPath)
                fs.writeFileSync(fixture.outputPath, replacement)
                replacementInstalled = true
            }
            const error = new Error("persistent temporary unlink failure")
            error.code = "EBUSY"
            throw error
        }
        if (target === publishedOutputPath) outputUnlinks++
        return fs.unlinkSync(target)
    }
    io.lstatSync = target => replacementInstalled && target === publishedOutputPath
        ? fs.lstatSync(temporaryPath)
        : fs.lstatSync(target)

    const result = writeStoredZip({ bundleRoot: fixture.bundleRoot, outputPath: fixture.outputPath, entries, fs: io })
    assert.equal(outputUnlinks, 0)
    assert.deepEqual(fs.readFileSync(fixture.outputPath), replacement)
    assert.deepEqual(result, {
        published: true,
        cleanupPending: true,
        temporaryFile: path.basename(temporaryPath),
    })
    assert.equal(fs.existsSync(temporaryPath), true)
})
