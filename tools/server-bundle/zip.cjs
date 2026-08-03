"use strict"

const crypto = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")

const { canonicalJsonBuffer, sha256Hex } = require("./canonical-json.cjs")

const ARCHIVE_PREFIX = "server-bundle/"
const MANIFEST_NAME = "server-manifest.json"
const MAX_ENTRIES = 65534
const UINT16_MAX = 0xffff
const UINT32_MAX = 0xffffffff
const LOCAL_HEADER_SIZE = 30
const CENTRAL_HEADER_SIZE = 46
const EOCD_SIZE = 22
const UTF8_FLAG = 0x0800
const DOS_TIME = 0
const DOS_DATE = 0x0021
const REGULAR_0644 = (0o100644 << 16) >>> 0
const READ_BUFFER_SIZE = 64 * 1024

const CRC32_TABLE = new Uint32Array(256)
for (let index = 0; index < CRC32_TABLE.length; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) {
        value = (value & 1) === 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1
    }
    CRC32_TABLE[index] = value >>> 0
}

function fail(message) {
    throw new Error(message)
}

function compareUtf8(left, right) {
    return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
}

function updateCrc32(state, bytes) {
    let value = state >>> 0
    for (let index = 0; index < bytes.length; index++) {
        value = CRC32_TABLE[(value ^ bytes[index]) & 0xff] ^ (value >>> 8)
    }
    return value >>> 0
}

function crc32(bytes) {
    if (!Buffer.isBuffer(bytes)) throw new TypeError("crc32 input must be a Buffer")
    return (updateCrc32(0xffffffff, bytes) ^ 0xffffffff) >>> 0
}

function safeRelativePath(value, label) {
    if (typeof value !== "string"
        || value.length === 0
        || value.includes("\\")
        || value.includes("\0")
        || path.posix.isAbsolute(value)
        || /^[A-Za-z]:/.test(value)
        || path.posix.normalize(value) !== value
        || value.split("/").some(segment => segment === "" || segment === "." || segment === "..")) {
        fail(`${label} is an unsafe POSIX relative path`)
    }
    return value
}

function lstat(io, filePath, label, optional = false) {
    try {
        return io.lstatSync(filePath)
    } catch (error) {
        if (optional && error && error.code === "ENOENT") return null
        fail(`${label} is missing or unreadable`)
    }
}

function requireBundleRoot(io, bundleRoot) {
    const status = lstat(io, bundleRoot, "Bundle root")
    if (status.isSymbolicLink()) fail("Bundle root must not be a symbolic link")
    if (!status.isDirectory()) fail("Bundle root must be a directory")
}

function openRegularFile(io, filePath, label) {
    const status = lstat(io, filePath, label)
    if (status.isSymbolicLink()) fail(`${label} must not be a symbolic link`)
    if (!status.isFile()) fail(`${label} must be a regular file`)

    let descriptor
    try {
        descriptor = io.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
        const openedStatus = io.fstatSync(descriptor)
        if (!openedStatus.isFile()) fail(`${label} must be a regular file`)
        if (status.dev !== openedStatus.dev || status.ino !== openedStatus.ino) {
            fail(`${label} changed while it was opened`)
        }
        return { descriptor, status: openedStatus }
    } catch (error) {
        if (descriptor !== undefined) {
            try {
                io.closeSync(descriptor)
            } catch {
                // Preserve the source safety failure.
            }
        }
        throw error
    }
}

function inspectRegularFile(io, filePath, label) {
    const { descriptor } = openRegularFile(io, filePath, label)
    const hash = crypto.createHash("sha256")
    const buffer = Buffer.allocUnsafe(READ_BUFFER_SIZE)
    let crcState = 0xffffffff
    let size = 0
    try {
        while (true) {
            const bytesRead = io.readSync(descriptor, buffer, 0, buffer.length, null)
            if (bytesRead === 0) break
            const chunk = buffer.subarray(0, bytesRead)
            size += bytesRead
            if (size > UINT32_MAX) fail(`${label} size exceeds ZIP32`)
            hash.update(chunk)
            crcState = updateCrc32(crcState, chunk)
        }
    } finally {
        io.closeSync(descriptor)
    }
    return {
        size,
        sha256: hash.digest("hex"),
        crc32: (crcState ^ 0xffffffff) >>> 0,
    }
}

function manifestFileMap(verifiedManifest) {
    if (verifiedManifest === undefined) return null
    if (verifiedManifest === null
        || typeof verifiedManifest !== "object"
        || !Array.isArray(verifiedManifest.files)) {
        fail("Verified manifest must contain a files array")
    }

    const manifestBytes = canonicalJsonBuffer(verifiedManifest)
    const expected = new Map([[
        MANIFEST_NAME,
        { size: manifestBytes.length, sha256: sha256Hex(manifestBytes) },
    ]])
    for (const [index, file] of verifiedManifest.files.entries()) {
        if (file === null || typeof file !== "object") fail(`Verified manifest files[${index}] is invalid`)
        const relativePath = safeRelativePath(file.path, `Verified manifest files[${index}].path`)
        if (relativePath === MANIFEST_NAME || expected.has(relativePath)) {
            fail("Verified manifest file paths must be unique and exclude server-manifest.json")
        }
        if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > UINT32_MAX) {
            fail(`Verified manifest file "${relativePath}" has an invalid ZIP32 size`)
        }
        if (typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256)) {
            fail(`Verified manifest file "${relativePath}" has an invalid hash`)
        }
        expected.set(relativePath, { size: file.bytes, sha256: file.sha256 })
    }
    return expected
}

function collectBundleEntries(options = {}) {
    if (typeof options === "string") options = { bundleRoot: options }
    if (options === null || typeof options !== "object") fail("ZIP collection options must be an object")
    const io = options.fs ?? fs
    const bundleRoot = path.resolve(options.bundleRoot ?? path.resolve(__dirname, "../../dist/server-bundle"))
    const verifiedManifest = options.verifiedManifest ?? options.manifest
    requireBundleRoot(io, bundleRoot)
    const expected = manifestFileMap(verifiedManifest)
    const entries = []
    const actualPaths = new Set()

    function visit(absoluteDirectory, relativeDirectory) {
        let directoryEntries
        try {
            directoryEntries = io.readdirSync(absoluteDirectory, { withFileTypes: true })
        } catch {
            fail(relativeDirectory
                ? `Bundle directory "${relativeDirectory}" is unreadable`
                : "Bundle root is unreadable")
        }
        directoryEntries.sort((left, right) => compareUtf8(left.name, right.name))

        for (const directoryEntry of directoryEntries) {
            const relativePath = relativeDirectory
                ? `${relativeDirectory}/${directoryEntry.name}`
                : directoryEntry.name
            safeRelativePath(relativePath, "Bundle entry path")
            const sourcePath = path.join(absoluteDirectory, directoryEntry.name)
            const status = lstat(io, sourcePath, `Bundle entry "${relativePath}"`)
            if (status.isSymbolicLink()) fail(`Bundle entry "${relativePath}" must not be a symbolic link`)
            if (status.isDirectory()) {
                visit(sourcePath, relativePath)
                continue
            }
            if (!status.isFile()) {
                fail(`Bundle entry "${relativePath}" must be a regular file or directory`)
            }

            const metadata = inspectRegularFile(io, sourcePath, `Bundle entry "${relativePath}"`)
            const expectedMetadata = expected?.get(relativePath)
            if (expected && !expected.has(relativePath)) {
                fail(`Bundle file set has extra file "${relativePath}" outside the verified manifest`)
            }
            if (expectedMetadata !== null && expectedMetadata !== undefined
                && (metadata.size !== expectedMetadata.size || metadata.sha256 !== expectedMetadata.sha256)) {
                fail(`Bundle file "${relativePath}" does not match the verified manifest size or hash`)
            }
            actualPaths.add(relativePath)
            entries.push({
                name: `${ARCHIVE_PREFIX}${relativePath}`,
                sourcePath,
                ...metadata,
            })
        }
    }

    visit(bundleRoot, "")
    if (expected) {
        for (const relativePath of expected.keys()) {
            if (!actualPaths.has(relativePath)) {
                fail(`Bundle file set is missing verified manifest file "${relativePath}"`)
            }
        }
    }
    entries.sort((left, right) => compareUtf8(left.name, right.name))
    if (entries.length > MAX_ENTRIES) fail(`ZIP32 supports at most ${MAX_ENTRIES} entries`)
    return entries
}

function isContainedBy(candidate, root) {
    const relative = path.relative(root, candidate)
    return relative === ""
        || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function resolveDestination(io, bundleRoot, outputPath) {
    const requestedParent = path.dirname(outputPath)
    const parentStatus = lstat(io, requestedParent, "Destination parent directory")
    if (!parentStatus.isDirectory() && !parentStatus.isSymbolicLink()) {
        fail("Destination parent must resolve to a directory")
    }
    let realParent
    try {
        realParent = io.realpathSync(requestedParent)
    } catch {
        fail("Destination parent must resolve to an existing directory")
    }
    const parent = lstat(io, realParent, "Resolved destination parent directory")
    if (!parent.isDirectory()) fail("Destination parent must resolve to a directory")
    const realBundleRoot = io.realpathSync(bundleRoot)
    const realOutput = path.join(realParent, path.basename(outputPath))
    if (isContainedBy(realOutput, realBundleRoot)) {
        fail("Archive destination must not be inside the bundle root")
    }
    if (lstat(io, realOutput, "Archive destination", true) !== null) {
        fail("Archive destination already exists and conflicts with atomic publication")
    }
    return realOutput
}

function validatePlannedEntries(entries, bundleRoot, verifiedManifest) {
    if (!Array.isArray(entries)) fail("ZIP entries must be an array")
    if (entries.length > MAX_ENTRIES) fail(`ZIP32 supports at most ${MAX_ENTRIES} entries`)
    const expected = manifestFileMap(verifiedManifest)
    const seen = new Set()
    const planned = entries.map((entry, index) => {
        if (entry === null || typeof entry !== "object") fail(`ZIP entry ${index} is invalid`)
        if (typeof entry.name !== "string" || !entry.name.startsWith(ARCHIVE_PREFIX)) {
            fail(`ZIP entry ${index} must use the server-bundle/ prefix`)
        }
        const relativePath = safeRelativePath(entry.name.slice(ARCHIVE_PREFIX.length), `ZIP entry ${index} name`)
        const nameBytes = Buffer.from(entry.name, "utf8")
        if (nameBytes.length > UINT16_MAX) fail(`ZIP entry name exceeds the ZIP32 65535-byte limit`)
        if (seen.has(entry.name)) fail(`ZIP entry name "${entry.name}" is duplicated`)
        seen.add(entry.name)
        if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > UINT32_MAX) {
            fail(`ZIP entry "${entry.name}" size exceeds ZIP32`)
        }
        if (!Number.isSafeInteger(entry.crc32) || entry.crc32 < 0 || entry.crc32 > UINT32_MAX) {
            fail(`ZIP entry "${entry.name}" has an invalid CRC-32`)
        }
        if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
            fail(`ZIP entry "${entry.name}" has an invalid SHA-256`)
        }
        const sourcePath = path.resolve(entry.sourcePath)
        const requiredSource = path.resolve(bundleRoot, ...relativePath.split("/"))
        if (sourcePath !== requiredSource) fail(`ZIP entry "${entry.name}" has an unsafe source path`)
        return { ...entry, nameBytes, relativePath, sourcePath }
    }).sort((left, right) => Buffer.compare(left.nameBytes, right.nameBytes))

    if (expected) {
        if (planned.length !== expected.size) fail("ZIP entries do not match the verified manifest file set")
        for (const entry of planned) {
            if (!expected.has(entry.relativePath)) {
                fail(`ZIP entry "${entry.name}" is outside the verified manifest`)
            }
            const expectedMetadata = expected.get(entry.relativePath)
            if (expectedMetadata !== null
                && (entry.size !== expectedMetadata.size || entry.sha256 !== expectedMetadata.sha256)) {
                fail(`ZIP entry "${entry.name}" does not match the verified manifest size or hash`)
            }
        }
    }

    let offset = 0n
    for (const entry of planned) {
        if (offset > BigInt(UINT32_MAX)) fail("ZIP entry offset exceeds ZIP32")
        entry.localOffset = Number(offset)
        offset += BigInt(LOCAL_HEADER_SIZE + entry.nameBytes.length) + BigInt(entry.size)
    }
    if (offset > BigInt(UINT32_MAX)) fail("Central directory offset exceeds ZIP32")
    const centralOffset = Number(offset)
    let centralSize = 0n
    for (const entry of planned) centralSize += BigInt(CENTRAL_HEADER_SIZE + entry.nameBytes.length)
    if (centralSize > BigInt(UINT32_MAX)) fail("Central directory size exceeds ZIP32")
    if (offset + centralSize + BigInt(EOCD_SIZE) > BigInt(UINT32_MAX)) {
        fail("Archive offset exceeds ZIP32")
    }
    return { entries: planned, centralOffset, centralSize: Number(centralSize) }
}

function writeAll(io, descriptor, bytes) {
    let offset = 0
    while (offset < bytes.length) {
        const written = io.writeSync(descriptor, bytes, offset, bytes.length - offset)
        if (written <= 0) fail("Archive write made no progress")
        offset += written
    }
}

function localHeader(entry) {
    const header = Buffer.alloc(LOCAL_HEADER_SIZE)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(UTF8_FLAG, 6)
    header.writeUInt16LE(0, 8)
    header.writeUInt16LE(DOS_TIME, 10)
    header.writeUInt16LE(DOS_DATE, 12)
    header.writeUInt32LE(entry.crc32, 14)
    header.writeUInt32LE(entry.size, 18)
    header.writeUInt32LE(entry.size, 22)
    header.writeUInt16LE(entry.nameBytes.length, 26)
    header.writeUInt16LE(0, 28)
    return header
}

function centralHeader(entry) {
    const header = Buffer.alloc(CENTRAL_HEADER_SIZE)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(0x0314, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(UTF8_FLAG, 8)
    header.writeUInt16LE(0, 10)
    header.writeUInt16LE(DOS_TIME, 12)
    header.writeUInt16LE(DOS_DATE, 14)
    header.writeUInt32LE(entry.crc32, 16)
    header.writeUInt32LE(entry.size, 20)
    header.writeUInt32LE(entry.size, 24)
    header.writeUInt16LE(entry.nameBytes.length, 28)
    header.writeUInt16LE(0, 30)
    header.writeUInt16LE(0, 32)
    header.writeUInt16LE(0, 34)
    header.writeUInt16LE(0, 36)
    header.writeUInt32LE(REGULAR_0644, 38)
    header.writeUInt32LE(entry.localOffset, 42)
    return header
}

function eocd(entryCount, centralSize, centralOffset) {
    const record = Buffer.alloc(EOCD_SIZE)
    record.writeUInt32LE(0x06054b50, 0)
    record.writeUInt16LE(0, 4)
    record.writeUInt16LE(0, 6)
    record.writeUInt16LE(entryCount, 8)
    record.writeUInt16LE(entryCount, 10)
    record.writeUInt32LE(centralSize, 12)
    record.writeUInt32LE(centralOffset, 16)
    record.writeUInt16LE(0, 20)
    return record
}

function requireSafeSourceParents(io, bundleRoot, entry) {
    let current = bundleRoot
    const segments = entry.relativePath.split("/")
    for (const segment of segments.slice(0, -1)) {
        current = path.join(current, segment)
        const status = lstat(io, current, `Bundle source parent "${entry.relativePath}"`)
        if (status.isSymbolicLink()) fail(`Bundle source parent "${entry.relativePath}" must not be a symbolic link`)
        if (!status.isDirectory()) fail(`Bundle source parent "${entry.relativePath}" must be a directory`)
    }
    const expectedRealPath = path.join(io.realpathSync(bundleRoot), ...segments)
    let actualRealPath
    try {
        actualRealPath = io.realpathSync(entry.sourcePath)
    } catch {
        fail(`Bundle source "${entry.relativePath}" is missing or unreadable`)
    }
    if (actualRealPath !== expectedRealPath) fail(`Bundle source "${entry.relativePath}" has an unsafe source path`)
}

function writeEntryPayload(io, outputDescriptor, bundleRoot, entry) {
    const label = `Bundle source "${entry.relativePath}"`
    requireSafeSourceParents(io, bundleRoot, entry)
    const { descriptor, status } = openRegularFile(io, entry.sourcePath, label)
    if (status.size !== entry.size) {
        io.closeSync(descriptor)
        fail(`${label} changed size after ZIP planning`)
    }
    const hash = crypto.createHash("sha256")
    const buffer = Buffer.allocUnsafe(READ_BUFFER_SIZE)
    let crcState = 0xffffffff
    let size = 0
    try {
        while (true) {
            const bytesRead = io.readSync(descriptor, buffer, 0, buffer.length, null)
            if (bytesRead === 0) break
            const chunk = buffer.subarray(0, bytesRead)
            size += bytesRead
            hash.update(chunk)
            crcState = updateCrc32(crcState, chunk)
            writeAll(io, outputDescriptor, chunk)
        }
    } finally {
        io.closeSync(descriptor)
    }
    const actualCrc = (crcState ^ 0xffffffff) >>> 0
    const actualSha256 = hash.digest("hex")
    if (size !== entry.size || actualCrc !== entry.crc32 || actualSha256 !== entry.sha256) {
        fail(`${label} changed or was mutated after ZIP planning`)
    }
}

function openUniqueTemporary(io, outputPath) {
    const parent = path.dirname(outputPath)
    const prefix = `.${path.basename(outputPath)}.tmp-`
    for (let attempt = 0; attempt < 8; attempt++) {
        const temporaryPath = path.join(parent, `${prefix}${crypto.randomUUID()}`)
        try {
            const descriptor = io.openSync(
                temporaryPath,
                fs.constants.O_CREAT
                    | fs.constants.O_EXCL
                    | fs.constants.O_WRONLY
                    | (fs.constants.O_NOFOLLOW ?? 0),
                0o644,
            )
            return { descriptor, temporaryPath }
        } catch (error) {
            if (!error || error.code !== "EEXIST") throw error
        }
    }
    fail("Could not create a unique sibling temporary archive")
}

function destinationExists(io, outputPath) {
    try {
        return io.lstatSync(outputPath) !== null
    } catch (error) {
        if (error && error.code === "ENOENT") return false
        return false
    }
}

function publishWithoutReplacement(io, temporaryPath, outputPath) {
    try {
        io.linkSync(temporaryPath, outputPath)
    } catch (error) {
        if ((error && error.code === "EEXIST") || destinationExists(io, outputPath)) {
            const conflict = new Error("Archive destination appeared during publication", { cause: error })
            conflict.code = "EEXIST"
            throw conflict
        }
        throw error
    }

    try {
        io.unlinkSync(temporaryPath)
        return { published: true, cleanupPending: false }
    } catch (error) {
        if (error && error.code === "ENOENT") {
            return { published: true, cleanupPending: false }
        }
    }
    return {
        published: true,
        cleanupPending: true,
        temporaryFile: path.basename(temporaryPath),
    }
}

function writeStoredZip(options = {}) {
    if (options === null || typeof options !== "object") fail("ZIP writer options must be an object")
    const io = options.fs ?? fs
    const bundleRoot = path.resolve(options.bundleRoot ?? path.resolve(__dirname, "../../dist/server-bundle"))
    const requestedOutputPath = path.resolve(options.outputPath ?? `${bundleRoot}.zip`)
    const verifiedManifest = options.verifiedManifest ?? options.manifest
    requireBundleRoot(io, bundleRoot)
    const outputPath = resolveDestination(io, bundleRoot, requestedOutputPath)
    const entries = options.entries ?? collectBundleEntries({ bundleRoot, verifiedManifest, fs: io })
    const plan = validatePlannedEntries(entries, bundleRoot, verifiedManifest)

    let outputDescriptor
    let temporaryPath
    let publicationResult
    try {
        const temporary = openUniqueTemporary(io, outputPath)
        outputDescriptor = temporary.descriptor
        temporaryPath = temporary.temporaryPath
        for (const entry of plan.entries) {
            writeAll(io, outputDescriptor, localHeader(entry))
            writeAll(io, outputDescriptor, entry.nameBytes)
            writeEntryPayload(io, outputDescriptor, bundleRoot, entry)
        }
        for (const entry of plan.entries) {
            writeAll(io, outputDescriptor, centralHeader(entry))
            writeAll(io, outputDescriptor, entry.nameBytes)
        }
        writeAll(io, outputDescriptor, eocd(plan.entries.length, plan.centralSize, plan.centralOffset))
        io.fsyncSync(outputDescriptor)
        io.closeSync(outputDescriptor)
        outputDescriptor = undefined
        publicationResult = publishWithoutReplacement(io, temporaryPath, outputPath)
        temporaryPath = undefined
    } catch (error) {
        if (outputDescriptor !== undefined) {
            try {
                io.closeSync(outputDescriptor)
            } catch {
                // Preserve the archive failure.
            }
        }
        if (temporaryPath !== undefined) {
            try {
                io.unlinkSync(temporaryPath)
            } catch {
                // Best-effort cleanup must not hide the original failure.
            }
        }
        throw error
    }
    return publicationResult
}

module.exports = { collectBundleEntries, crc32, writeStoredZip }
