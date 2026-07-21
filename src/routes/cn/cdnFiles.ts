import { createHash } from "node:crypto"
import { constants, type Stats } from "node:fs"
import { lstat, mkdir, mkdtemp, open, realpath, rm, type FileHandle } from "node:fs/promises"
import path from "node:path"
import type { Readable } from "node:stream"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { resolveContentPaths, type ContentPaths } from "../../content/paths"
import type { ContentSnapshot } from "../../content/runtime/content-snapshot"
import { getContentSnapshot } from "../../content/runtime/content-snapshot"

export interface CdnFileSystem {
    realpath(filePath: string): Promise<string>
    lstat(filePath: string): Promise<Stats>
    open(filePath: string, flags: number, mode?: number): Promise<FileHandle>
}

export interface CdnFileHandleObserver {
    opened(): void
    closed(): void
}

interface ZipSpoolContext {
    readonly relativePath: string
}

interface ZipSpoolDirectoryContext extends ZipSpoolContext {
    readonly directory: string
}

interface ZipSpoolChunkContext extends ZipSpoolContext {
    readonly bytesCopied: number
    readonly totalBytes: number
}

interface ZipSpoolResponseContext extends ZipSpoolDirectoryContext {
    readonly stream: Readable
}

export interface CdnZipSpoolHooks {
    readonly afterSourceStat?: (context: ZipSpoolContext) => void | Promise<void>
    readonly afterChunk?: (context: ZipSpoolChunkContext) => void | Promise<void>
    readonly beforeResponse?: (context: ZipSpoolResponseContext) => void | Promise<void>
    readonly spoolCreated?: (context: ZipSpoolDirectoryContext) => void
    readonly spoolRemoved?: (context: ZipSpoolDirectoryContext) => void
}

export interface CnCdnFilesRouteOptions {
    readonly getSnapshot?: () => ContentSnapshot
    readonly paths?: Pick<ContentPaths, "cdnRoot" | "contentStateDir">
    readonly patchUploadRoot?: string
    readonly fileSystem?: CdnFileSystem
    readonly handleObserver?: CdnFileHandleObserver
    readonly zipSpoolHooks?: CdnZipSpoolHooks
}

interface ZipIdentity {
    readonly logicalPath: string
    readonly dev: number
    readonly ino: number
    readonly size: number
    readonly mtimeMs: number
    readonly ctimeMs: number
    readonly sha256: string
}

interface CatalogZipMetadata {
    readonly size: number
    readonly sha256: string
}

interface VerifiedZipSpool {
    readonly directory: string
    readonly stream: Readable
    readonly cleanup: () => Promise<void>
}

const defaultFileSystem: CdnFileSystem = { realpath, lstat, open }
const OPEN_READ_NOFOLLOW = constants.O_RDONLY | constants.O_NOFOLLOW
const OPEN_CREATE_EXCLUSIVE = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW
const ZIP_COPY_BUFFER_BYTES = 64 * 1024
const ZIP_SPOOL_DIRECTORY = "cdn-response-spool-v1"

function requestRelativePath(request: FastifyRequest): string | null {
    const rawUrl = request.raw.url?.split("?", 1)[0] ?? ""
    const prefix = "/patch/cn/"
    if (!rawUrl.startsWith(prefix)) return null
    const rawRelativePath = rawUrl.slice(prefix.length)
    if (rawRelativePath.includes("%")) return null

    let relativePath: string
    try {
        relativePath = decodeURIComponent(rawRelativePath)
    } catch {
        return null
    }
    if (!relativePath
        || /[\x00-\x1f\x7f]/.test(relativePath)
        || relativePath.includes("\\")
        || relativePath.startsWith("/")
        || relativePath.includes("//")
        || relativePath.includes("%")) {
        return null
    }
    const segments = relativePath.split("/")
    if (segments.some(segment => segment === "" || segment === "." || segment === "..")) {
        return null
    }
    return relativePath
}

function isDescendant(root: string, candidate: string): boolean {
    const relativePath = path.relative(root, candidate)
    return relativePath !== ""
        && !path.isAbsolute(relativePath)
        && relativePath !== ".."
        && !relativePath.startsWith(`..${path.sep}`)
}

function contentType(relativePath: string): string {
    const extension = path.posix.extname(relativePath).toLowerCase()
    if (extension === ".zip") return "application/zip"
    if (extension === ".csv") return "text/csv; charset=utf-8"
    return "application/octet-stream"
}

function catalogRelativePath(relativePath: string): string | null {
    if (!/^[\x21-\x7e]+$/.test(relativePath)
        || relativePath.includes("\\")
        || relativePath.startsWith("/")
        || relativePath.includes("//")
        || relativePath.includes("%")) {
        return null
    }
    const segments = relativePath.split("/")
    return segments.some(segment => segment === "" || segment === "." || segment === "..")
        ? null
        : relativePath
}

async function hasSymlinkComponent(
    logicalRoot: string,
    relativePath: string,
    fileSystem: CdnFileSystem,
): Promise<boolean> {
    let candidate = logicalRoot
    for (const segment of relativePath.split("/")) {
        candidate = path.join(candidate, segment)
        if ((await fileSystem.lstat(candidate)).isSymbolicLink()) return true
    }
    return false
}

function sameIdentity(stat: Stats, identity: ZipIdentity): boolean {
    return stat.isFile()
        && stat.dev === identity.dev
        && stat.ino === identity.ino
        && stat.size === identity.size
        && stat.mtimeMs === identity.mtimeMs
        && stat.ctimeMs === identity.ctimeMs
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
    return left.isFile()
        && right.isFile()
        && left.dev === right.dev
        && left.ino === right.ino
        && left.size === right.size
}

function sameFileSnapshot(left: Stats, right: Stats): boolean {
    return sameFileIdentity(left, right)
        && left.mtimeMs === right.mtimeMs
        && left.ctimeMs === right.ctimeMs
}

async function openObserved(
    filePath: string,
    flags: number,
    fileSystem: CdnFileSystem,
    observer: CdnFileHandleObserver | undefined,
    mode?: number,
): Promise<FileHandle> {
    const handle = await fileSystem.open(filePath, flags, mode)
    observer?.opened()
    return handle
}

async function closeObserved(
    handle: FileHandle,
    observer: CdnFileHandleObserver | undefined,
): Promise<void> {
    try {
        await handle.close()
    } finally {
        observer?.closed()
    }
}

function sendHandle(
    reply: FastifyReply,
    handle: FileHandle,
    mimeType: string,
    observer: CdnFileHandleObserver | undefined,
) {
    const stream = handle.createReadStream({ autoClose: true })
    stream.once("close", () => observer?.closed())
    return reply.status(200).type(mimeType).send(stream)
}

async function closeObservedQuietly(
    handle: FileHandle | null,
    observer: CdnFileHandleObserver | undefined,
): Promise<void> {
    if (!handle) return
    try {
        await closeObserved(handle, observer)
    } catch {
        // The response remains unavailable if a descriptor cannot be closed cleanly.
    }
}

function createObservedReadStream(
    handle: FileHandle,
    observer: CdnFileHandleObserver | undefined,
): Readable {
    const stream = handle.createReadStream({ autoClose: true })
    stream.once("close", () => observer?.closed())
    return stream
}

async function writeAll(handle: FileHandle, buffer: Buffer, position: number): Promise<void> {
    let written = 0
    while (written < buffer.length) {
        const result = await handle.write(buffer, written, buffer.length - written, position + written)
        if (result.bytesWritten === 0) throw new Error("ZIP spool write made no progress")
        written += result.bytesWritten
    }
}

async function copyZipToSpool(
    source: FileHandle,
    destination: FileHandle,
    identity: ZipIdentity,
    relativePath: string,
    hooks: CdnZipSpoolHooks | undefined,
): Promise<string> {
    const hash = createHash("sha256")
    const buffer = Buffer.allocUnsafe(Math.min(ZIP_COPY_BUFFER_BYTES, Math.max(identity.size, 1)))
    let bytesCopied = 0
    while (bytesCopied < identity.size) {
        const bytesToRead = Math.min(buffer.length, identity.size - bytesCopied)
        const result = await source.read(buffer, 0, bytesToRead, bytesCopied)
        if (result.bytesRead === 0) throw new Error("ZIP source ended during spool copy")
        const chunk = buffer.subarray(0, result.bytesRead)
        hash.update(chunk)
        await writeAll(destination, chunk, bytesCopied)
        bytesCopied += result.bytesRead
        await hooks?.afterChunk?.({ relativePath, bytesCopied, totalBytes: identity.size })
    }
    return hash.digest("hex")
}

function makeSpoolCleanup(
    directory: string,
    relativePath: string,
    hooks: CdnZipSpoolHooks | undefined,
): () => Promise<void> {
    let cleanup: Promise<void> | null = null
    return () => {
        cleanup ??= (async () => {
            try {
                await rm(directory, { recursive: true, force: true })
            } finally {
                hooks?.spoolRemoved?.({ relativePath, directory })
            }
        })()
        return cleanup
    }
}

async function createVerifiedZipSpool(
    relativePath: string,
    identity: ZipIdentity,
    logicalRoot: string,
    spoolRoot: string,
    fileSystem: CdnFileSystem,
    observer: CdnFileHandleObserver | undefined,
    hooks: CdnZipSpoolHooks | undefined,
): Promise<VerifiedZipSpool> {
    let source: FileHandle | null = null
    let spoolWriter: FileHandle | null = null
    let spoolReader: FileHandle | null = null
    let directory: string | null = null
    let cleanup: (() => Promise<void>) | null = null
    try {
        if (await hasSymlinkComponent(logicalRoot, relativePath, fileSystem)) {
            throw new Error("ZIP path contains a symlink")
        }
        source = await openObserved(identity.logicalPath, OPEN_READ_NOFOLLOW, fileSystem, observer)
        const beforeStat = await source.stat()
        const beforePathStat = await fileSystem.lstat(identity.logicalPath)
        if (!sameIdentity(beforeStat, identity)
            || !sameIdentity(beforePathStat, identity)
            || await hasSymlinkComponent(logicalRoot, relativePath, fileSystem)) {
            throw new Error("ZIP identity changed before spool copy")
        }
        await hooks?.afterSourceStat?.({ relativePath })

        directory = await mkdtemp(path.join(spoolRoot, "request-"))
        cleanup = makeSpoolCleanup(directory, relativePath, hooks)
        hooks?.spoolCreated?.({ relativePath, directory })
        const spoolPath = path.join(directory, "archive.zip")
        spoolWriter = await openObserved(
            spoolPath,
            OPEN_CREATE_EXCLUSIVE,
            fileSystem,
            observer,
            0o600,
        )
        const digest = await copyZipToSpool(
            source,
            spoolWriter,
            identity,
            relativePath,
            hooks,
        )
        await spoolWriter.sync()
        const spoolStat = await spoolWriter.stat()
        const afterStat = await source.stat()
        const afterPathStat = await fileSystem.lstat(identity.logicalPath)
        if (!sameIdentity(afterStat, identity)
            || !sameFileSnapshot(beforeStat, afterStat)
            || !sameIdentity(afterPathStat, identity)
            || await hasSymlinkComponent(logicalRoot, relativePath, fileSystem)
            || spoolStat.size !== identity.size
            || digest !== identity.sha256) {
            throw new Error("ZIP changed or failed digest verification during spool copy")
        }

        const verifiedSource = source
        source = null
        await closeObserved(verifiedSource, observer)
        const verifiedWriter = spoolWriter
        spoolWriter = null
        await closeObserved(verifiedWriter, observer)
        spoolReader = await openObserved(spoolPath, OPEN_READ_NOFOLLOW, fileSystem, observer)
        const readStat = await spoolReader.stat()
        if (!readStat.isFile() || readStat.size !== identity.size) {
            throw new Error("ZIP spool identity changed before response")
        }
        const stream = createObservedReadStream(spoolReader, observer)
        spoolReader = null
        stream.once("close", () => { void cleanup?.() })
        return { directory, stream, cleanup }
    } catch (error) {
        await closeObservedQuietly(source, observer)
        await closeObservedQuietly(spoolWriter, observer)
        await closeObservedQuietly(spoolReader, observer)
        if (cleanup) await cleanup()
        else if (directory) await rm(directory, { recursive: true, force: true })
        throw error
    }
}

async function buildZipIdentities(
    snapshot: ContentSnapshot,
    logicalRoot: string,
    physicalRoot: string,
    fileSystem: CdnFileSystem,
    observer: CdnFileHandleObserver | undefined,
): Promise<ReadonlyMap<string, ZipIdentity>> {
    const archiveMetadata = new Map<string, CatalogZipMetadata>()
    const conflictingPaths = new Set<string>()
    for (const edge of snapshot.cdn.edges) {
        for (const archive of edge.archives) {
            if (path.posix.extname(archive.relativePath).toLowerCase() !== ".zip") continue
            if (conflictingPaths.has(archive.relativePath)) continue
            const metadata = { size: archive.compressedBytes, sha256: archive.sha256 }
            const previous = archiveMetadata.get(archive.relativePath)
            if (previous === undefined) {
                archiveMetadata.set(archive.relativePath, metadata)
            } else if (previous.size !== metadata.size || previous.sha256 !== metadata.sha256) {
                archiveMetadata.delete(archive.relativePath)
                conflictingPaths.add(archive.relativePath)
            }
        }
    }

    const identities = new Map<string, ZipIdentity>()
    for (const [rawRelativePath, metadata] of archiveMetadata) {
        const relativePath = catalogRelativePath(rawRelativePath)
        if (relativePath === null) continue
        const logicalPath = path.resolve(logicalRoot, ...relativePath.split("/"))
        if (!isDescendant(logicalRoot, logicalPath)) continue

        let handle: FileHandle | null = null
        try {
            if (await hasSymlinkComponent(logicalRoot, relativePath, fileSystem)) continue
            const physicalPath = await fileSystem.realpath(logicalPath)
            if (!isDescendant(physicalRoot, physicalPath)) continue
            handle = await openObserved(logicalPath, OPEN_READ_NOFOLLOW, fileSystem, observer)
            const fileStat = await handle.stat()
            const pathStat = await fileSystem.lstat(logicalPath)
            if (await hasSymlinkComponent(logicalRoot, relativePath, fileSystem)
                || !fileStat.isFile()
                || fileStat.size !== metadata.size
                || !sameFileSnapshot(fileStat, pathStat)) {
                continue
            }
            identities.set(relativePath, {
                logicalPath,
                dev: fileStat.dev,
                ino: fileStat.ino,
                size: fileStat.size,
                mtimeMs: fileStat.mtimeMs,
                ctimeMs: fileStat.ctimeMs,
                sha256: metadata.sha256,
            })
        } catch {
            // Missing, symlinked, or unstable Catalog archives are unavailable at this snapshot.
        } finally {
            if (handle) await closeObserved(handle, observer)
        }
    }
    return identities
}

async function sendPinnedZip(
    reply: FastifyReply,
    relativePath: string,
    identity: ZipIdentity,
    logicalRoot: string,
    spoolRoot: string,
    fileSystem: CdnFileSystem,
    observer: CdnFileHandleObserver | undefined,
    hooks: CdnZipSpoolHooks | undefined,
) {
    let spool: VerifiedZipSpool | null = null
    let onReplyClose: (() => void) | null = null
    try {
        // Phase 1 security boundary: verify and spool before sending; immutable object storage can replace this double-I/O path later.
        spool = await createVerifiedZipSpool(
            relativePath,
            identity,
            logicalRoot,
            spoolRoot,
            fileSystem,
            observer,
            hooks,
        )
        const verifiedSpool = spool
        onReplyClose = () => {
            if (!verifiedSpool.stream.closed) verifiedSpool.stream.destroy()
            else void verifiedSpool.cleanup()
        }
        reply.raw.once("close", onReplyClose)
        if (reply.raw.destroyed) throw new Error("client disconnected before ZIP verification completed")
        await hooks?.beforeResponse?.({
            relativePath,
            directory: verifiedSpool.directory,
            stream: verifiedSpool.stream,
        })
        if (reply.raw.destroyed) throw new Error("client disconnected before ZIP response")
        verifiedSpool.stream.once("close", () => {
            if (onReplyClose) reply.raw.off("close", onReplyClose)
            void verifiedSpool.cleanup()
        })
        return reply.status(200).type("application/zip").send(verifiedSpool.stream)
    } catch {
        if (onReplyClose) reply.raw.off("close", onReplyClose)
        if (spool) {
            if (!spool.stream.closed) {
                await new Promise<void>(resolve => {
                    spool!.stream.once("close", resolve)
                    if (!spool!.stream.destroyed) spool!.stream.destroy()
                })
            }
            await spool.cleanup()
        }
        return reply.status(404).send("Not Found")
    }
}

async function sendNonZip(
    reply: FastifyReply,
    logicalRoot: string,
    physicalRoot: string,
    relativePath: string,
    fileSystem: CdnFileSystem,
    observer: CdnFileHandleObserver | undefined,
) {
    let handle: FileHandle | null = null
    try {
        const logicalPath = path.resolve(logicalRoot, ...relativePath.split("/"))
        if (!isDescendant(logicalRoot, logicalPath)) return reply.status(404).send("Not Found")
        const physicalPath = await fileSystem.realpath(logicalPath)
        if (!isDescendant(physicalRoot, physicalPath)) return reply.status(404).send("Not Found")
        handle = await openObserved(physicalPath, OPEN_READ_NOFOLLOW, fileSystem, observer)
        const fileStat = await handle.stat()
        const currentPhysicalPath = await fileSystem.realpath(logicalPath)
        const pathStat = await fileSystem.lstat(currentPhysicalPath)
        if (currentPhysicalPath !== physicalPath
            || !isDescendant(physicalRoot, currentPhysicalPath)
            || !sameFileIdentity(fileStat, pathStat)) {
            await closeObserved(handle, observer)
            handle = null
            return reply.status(404).send("Not Found")
        }
        const response = sendHandle(reply, handle, contentType(relativePath), observer)
        handle = null
        return response
    } catch {
        if (handle) await closeObserved(handle, observer)
        return reply.status(404).send("Not Found")
    }
}

const routes = async (fastify: FastifyInstance, options: CnCdnFilesRouteOptions) => {
    const snapshot = (options.getSnapshot ?? getContentSnapshot)()
    const paths = options.paths ?? resolveContentPaths({
        projectRoot: path.resolve(__dirname, "../../.."),
    })
    const fileSystem = options.fileSystem ?? defaultFileSystem
    const observer = options.handleObserver
    const hooks = options.zipSpoolHooks
    const logicalRoot = path.resolve(paths.cdnRoot)
    const physicalRoot = await fileSystem.realpath(logicalRoot)
    const contentStateRoot = path.resolve(paths.contentStateDir)
    await mkdir(contentStateRoot, { recursive: true, mode: 0o700 })
    const physicalContentStateRoot = await fileSystem.realpath(contentStateRoot)
    if (physicalContentStateRoot === physicalRoot
        || isDescendant(physicalRoot, physicalContentStateRoot)
        || isDescendant(physicalContentStateRoot, physicalRoot)) {
        throw new Error("CONTENT_STATE_DIR must be isolated from the CDN root")
    }
    const logicalSpoolRoot = path.join(physicalContentStateRoot, ZIP_SPOOL_DIRECTORY)
    await mkdir(logicalSpoolRoot, { recursive: true, mode: 0o700 })
    const spoolRoot = await fileSystem.realpath(logicalSpoolRoot)
    if (!isDescendant(physicalContentStateRoot, spoolRoot)) {
        throw new Error("CDN spool directory must resolve inside CONTENT_STATE_DIR")
    }
    const zipIdentities = await buildZipIdentities(
        snapshot,
        logicalRoot,
        physicalRoot,
        fileSystem,
        observer,
    )

    const patchUploadRoot = path.resolve(
        options.patchUploadRoot
            ?? path.resolve(__dirname, "../../../assets/asset-patch/production/upload"),
    )
    let physicalPatchUploadRoot: string | null = null
    try {
        physicalPatchUploadRoot = await fileSystem.realpath(patchUploadRoot)
    } catch {
        // The compatibility patch store is optional.
    }

    fastify.get("/patch/cn/dummy/download/production/upload/:prefix/:hash", async (request, reply) => {
        if (physicalPatchUploadRoot === null) return reply.status(404).send("Not Found")
        if ((request.raw.url?.split("?", 1)[0] ?? "").includes("%")) {
            return reply.status(404).send("Not Found")
        }
        const { prefix, hash } = request.params as { prefix: string; hash: string }
        if (!/^[A-Za-z0-9._-]+$/.test(prefix) || !/^[A-Za-z0-9._-]+$/.test(hash)) {
            return reply.status(404).send("Not Found")
        }
        return sendNonZip(
            reply,
            patchUploadRoot,
            physicalPatchUploadRoot,
            `${prefix}/${hash}`,
            fileSystem,
            observer,
        )
    })

    fastify.get("/patch/cn/recovery/empty.csv", async (_request, reply) => {
        return reply.status(200).type("text/csv; charset=utf-8").send("")
    })

    fastify.get("/patch/cn/*", async (request, reply) => {
        const relativePath = requestRelativePath(request)
        if (relativePath === null) return reply.status(404).send("Not Found")
        if (path.posix.extname(relativePath).toLowerCase() === ".zip") {
            const identity = zipIdentities.get(relativePath)
            return identity
                ? sendPinnedZip(
                    reply,
                    relativePath,
                    identity,
                    logicalRoot,
                    spoolRoot,
                    fileSystem,
                    observer,
                    hooks,
                )
                : reply.status(404).send("Not Found")
        }
        return sendNonZip(
            reply,
            logicalRoot,
            physicalRoot,
            relativePath,
            fileSystem,
            observer,
        )
    })
}

export default routes
