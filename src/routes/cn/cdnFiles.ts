import { constants, type Stats } from "node:fs"
import { lstat, open, realpath, type FileHandle } from "node:fs/promises"
import path from "node:path"
import type { Readable } from "node:stream"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { resolveContentPaths, type ContentPaths } from "../../content/paths"
import { sourceFor, sourceRoot } from "../../content/cdn/archive-sources"
import type { ContentSnapshot } from "../../content/runtime/content-snapshot"
import { getContentSnapshot } from "../../content/runtime/content-snapshot"
import { parseHttpByteRange, type HttpByteRange } from "./httpRange"

export interface CdnFileSystem {
    realpath(filePath: string): Promise<string>
    lstat(filePath: string): Promise<Stats>
    open(filePath: string, flags: number): Promise<FileHandle>
}

export interface CdnFileHandleObserver {
    opened(): void
    closed(): void
}

export interface CnCdnFilesRouteOptions {
    readonly getSnapshot?: () => ContentSnapshot
    readonly paths?: Pick<ContentPaths, "cdnRoot" | "patchesRoot">
    readonly patchUploadRoot?: string
    readonly fileSystem?: CdnFileSystem
    readonly handleObserver?: CdnFileHandleObserver
}

interface OpenedFile {
    readonly handle: FileHandle
    readonly size: number
}

interface CatalogZipLocation {
    readonly logicalRoot: string
    readonly physicalRoot: string
    readonly expectedSize: number
}

const defaultFileSystem: CdnFileSystem = { realpath, lstat, open }
const OPEN_READ_NOFOLLOW = constants.O_RDONLY | constants.O_NOFOLLOW

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

function isDescendant(root: string, candidate: string): boolean {
    const relativePath = path.relative(root, candidate)
    return relativePath !== ""
        && !path.isAbsolute(relativePath)
        && relativePath !== ".."
        && !relativePath.startsWith(`..${path.sep}`)
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
    return left.isFile()
        && right.isFile()
        && left.dev === right.dev
        && left.ino === right.ino
        && left.size === right.size
}

function contentType(relativePath: string): string {
    const extension = path.posix.extname(relativePath).toLowerCase()
    if (extension === ".zip") return "application/zip"
    if (extension === ".csv") return "text/csv; charset=utf-8"
    return "application/octet-stream"
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

async function openObserved(
    filePath: string,
    fileSystem: CdnFileSystem,
    observer: CdnFileHandleObserver | undefined,
): Promise<FileHandle> {
    const handle = await fileSystem.open(filePath, OPEN_READ_NOFOLLOW)
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

async function buildCatalogZipAllowlist(
    snapshot: ContentSnapshot,
    paths: Pick<ContentPaths, "cdnRoot" | "patchesRoot">,
    fileSystem: CdnFileSystem,
): Promise<ReadonlyMap<string, CatalogZipLocation>> {
    const candidates = new Map<string, number>()
    const conflicts = new Set<string>()
    for (const edge of snapshot.cdn.edges) {
        for (const archive of edge.archives) {
            if (path.posix.extname(archive.relativePath).toLowerCase() !== ".zip") continue
            if (conflicts.has(archive.relativePath)) continue
            const previousSize = candidates.get(archive.relativePath)
            if (previousSize === undefined) {
                candidates.set(archive.relativePath, archive.compressedBytes)
            } else if (previousSize !== archive.compressedBytes) {
                candidates.delete(archive.relativePath)
                conflicts.add(archive.relativePath)
            }
        }
    }

    const allowlist = new Map<string, CatalogZipLocation>()
    for (const [rawRelativePath, expectedSize] of candidates) {
        const relativePath = catalogRelativePath(rawRelativePath)
        if (relativePath === null) continue
        const source = sourceFor(snapshot.archiveSources, relativePath)
        const logicalRoot = path.resolve(sourceRoot(paths, source))
        let physicalRoot: string
        try {
            physicalRoot = await fileSystem.realpath(logicalRoot)
        } catch {
            continue
        }
        const logicalPath = path.resolve(logicalRoot, ...relativePath.split("/"))
        if (!isDescendant(logicalRoot, logicalPath)) continue

        try {
            if (await hasSymlinkComponent(logicalRoot, relativePath, fileSystem)) continue
            const physicalPath = await fileSystem.realpath(logicalPath)
            if (!isDescendant(physicalRoot, physicalPath)) continue
            const logicalStat = await fileSystem.lstat(logicalPath)
            const physicalStat = await fileSystem.lstat(physicalPath)
            if (logicalStat.size !== expectedSize || !sameFileIdentity(logicalStat, physicalStat)) continue
            allowlist.set(relativePath, { logicalRoot, physicalRoot, expectedSize })
        } catch {
            // Missing, symlinked, and unstable Catalog files are unavailable in this snapshot.
        }
    }
    return allowlist
}

async function openSafeFile(
    logicalRoot: string,
    physicalRoot: string,
    relativePath: string,
    fileSystem: CdnFileSystem,
    observer: CdnFileHandleObserver | undefined,
    expectedSize?: number,
    rejectSymlinks = false,
): Promise<OpenedFile> {
    const logicalPath = path.resolve(logicalRoot, ...relativePath.split("/"))
    if (!isDescendant(logicalRoot, logicalPath)) throw new Error("path escapes the CDN root")
    if (rejectSymlinks && await hasSymlinkComponent(logicalRoot, relativePath, fileSystem)) {
        throw new Error("Catalog path contains a symlink")
    }

    const physicalPath = await fileSystem.realpath(logicalPath)
    if (!isDescendant(physicalRoot, physicalPath)) throw new Error("path resolves outside the CDN root")

    const handle = await openObserved(physicalPath, fileSystem, observer)
    try {
        const fileStat = await handle.stat()
        const currentPhysicalPath = await fileSystem.realpath(logicalPath)
        if (!isDescendant(physicalRoot, currentPhysicalPath)
            || currentPhysicalPath !== physicalPath
            || rejectSymlinks && await hasSymlinkComponent(logicalRoot, relativePath, fileSystem)) {
            throw new Error("path changed while opening")
        }
        const pathStat = await fileSystem.lstat(currentPhysicalPath)
        if (!sameFileIdentity(fileStat, pathStat)
            || expectedSize !== undefined && fileStat.size !== expectedSize) {
            throw new Error("file identity or size changed while opening")
        }
        return { handle, size: fileStat.size }
    } catch (error) {
        await closeObserved(handle, observer)
        throw error
    }
}

function streamOptions(range: HttpByteRange): { autoClose: true; start?: number; end?: number } {
    return range.kind === "partial"
        ? { autoClose: true, start: range.start, end: range.end }
        : { autoClose: true }
}

function sendOpenedFile(
    request: FastifyRequest,
    reply: FastifyReply,
    relativePath: string,
    openedFile: OpenedFile,
    observer: CdnFileHandleObserver | undefined,
) {
    const range = parseHttpByteRange(request.headers.range, openedFile.size)
    if (range.kind === "unsatisfiable") {
        return closeObserved(openedFile.handle, observer).then(() => reply
            .status(416)
            .header("Accept-Ranges", "bytes")
            .header("Content-Range", `bytes */${openedFile.size}`)
            .header("Content-Length", "0")
            .send())
    }

    reply.type(contentType(relativePath)).header("Accept-Ranges", "bytes")
    if (range.kind === "partial") {
        const contentLength = range.end - range.start + 1
        reply
            .status(206)
            .header("Content-Range", `bytes ${range.start}-${range.end}/${openedFile.size}`)
            .header("Content-Length", String(contentLength))
    } else {
        reply
            .status(200)
            .header("Content-Length", String(openedFile.size))
    }

    if (request.method === "HEAD") {
        return closeObserved(openedFile.handle, observer).then(() => reply.send())
    }

    let stream: Readable
    try {
        stream = openedFile.handle.createReadStream(streamOptions(range))
    } catch (error) {
        return closeObserved(openedFile.handle, observer).then(() => { throw error })
    }

    const destroyStream = () => {
        if (!stream.destroyed) stream.destroy()
    }
    const onResponseClose = () => {
        if (!reply.raw.writableEnded) destroyStream()
    }
    const onStreamClose = () => {
        request.raw.off("aborted", destroyStream)
        reply.raw.off("close", onResponseClose)
        observer?.closed()
    }
    request.raw.once("aborted", destroyStream)
    reply.raw.once("close", onResponseClose)
    stream.once("close", onStreamClose)
    if (request.raw.aborted || reply.raw.destroyed) destroyStream()

    return reply.send(stream)
}

async function sendFile(
    request: FastifyRequest,
    reply: FastifyReply,
    logicalRoot: string,
    physicalRoot: string,
    relativePath: string,
    fileSystem: CdnFileSystem,
    observer: CdnFileHandleObserver | undefined,
    expectedSize?: number,
    rejectSymlinks = false,
) {
    try {
        const openedFile = await openSafeFile(
            logicalRoot,
            physicalRoot,
            relativePath,
            fileSystem,
            observer,
            expectedSize,
            rejectSymlinks,
        )
        return sendOpenedFile(request, reply, relativePath, openedFile, observer)
    } catch {
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
    const logicalRoot = path.resolve(paths.cdnRoot)
    const physicalRoot = await fileSystem.realpath(logicalRoot)
    const zipAllowlist = await buildCatalogZipAllowlist(
        snapshot,
        paths,
        fileSystem,
    )

    const patchUploadRoot = options.patchUploadRoot === undefined
        ? null
        : path.resolve(options.patchUploadRoot)
    let physicalPatchUploadRoot: string | null = null
    if (patchUploadRoot !== null) {
        try {
            physicalPatchUploadRoot = await fileSystem.realpath(patchUploadRoot)
        } catch {
            // The compatibility patch store is optional.
        }
    }

    fastify.route({
        method: ["GET", "HEAD"],
        url: "/patch/cn/dummy/download/production/upload/:prefix/:hash",
        handler: async (request, reply) => {
            if (physicalPatchUploadRoot === null || patchUploadRoot === null) {
                return reply.status(404).send("Not Found")
            }
            if ((request.raw.url?.split("?", 1)[0] ?? "").includes("%")) {
                return reply.status(404).send("Not Found")
            }
            const { prefix, hash } = request.params as { prefix: string; hash: string }
            if (!/^[A-Za-z0-9._-]+$/.test(prefix) || !/^[A-Za-z0-9._-]+$/.test(hash)) {
                return reply.status(404).send("Not Found")
            }
            return sendFile(
                request,
                reply,
                patchUploadRoot,
                physicalPatchUploadRoot,
                `${prefix}/${hash}`,
                fileSystem,
                observer,
            )
        },
    })

    fastify.get("/patch/cn/recovery/empty.csv", async (_request, reply) => {
        return reply
            .status(200)
            .type("text/csv; charset=utf-8")
            .header("Content-Length", "0")
            .send("")
    })

    fastify.route({
        method: ["GET", "HEAD"],
        url: "/patch/cn/*",
        handler: async (request, reply) => {
            const relativePath = requestRelativePath(request)
            if (relativePath === null) return reply.status(404).send("Not Found")
            if (path.posix.extname(relativePath).toLowerCase() === ".zip") {
                const location = zipAllowlist.get(relativePath)
                return location === undefined
                    ? reply.status(404).send("Not Found")
                    : sendFile(
                        request,
                        reply,
                        location.logicalRoot,
                        location.physicalRoot,
                        relativePath,
                        fileSystem,
                        observer,
                        location.expectedSize,
                        true,
                    )
            }
            return sendFile(
                request,
                reply,
                logicalRoot,
                physicalRoot,
                relativePath,
                fileSystem,
                observer,
            )
        },
    })
}

export default routes
