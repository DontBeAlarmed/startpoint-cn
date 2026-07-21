import { constants, type Stats } from "node:fs"
import { lstat, open, realpath, type FileHandle } from "node:fs/promises"
import path from "node:path"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { resolveContentPaths, type ContentPaths } from "../../content/paths"
import type { ContentSnapshot } from "../../content/runtime/content-snapshot"
import { getContentSnapshot } from "../../content/runtime/content-snapshot"

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
    readonly paths?: Pick<ContentPaths, "cdnRoot">
    readonly patchUploadRoot?: string
    readonly fileSystem?: CdnFileSystem
    readonly handleObserver?: CdnFileHandleObserver
}

interface ZipIdentity {
    readonly logicalPath: string
    readonly dev: number
    readonly ino: number
    readonly size: number
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
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
    return left.isFile()
        && right.isFile()
        && left.dev === right.dev
        && left.ino === right.ino
        && left.size === right.size
}

async function openObserved(
    filePath: string,
    flags: number,
    fileSystem: CdnFileSystem,
    observer: CdnFileHandleObserver | undefined,
): Promise<FileHandle> {
    const handle = await fileSystem.open(filePath, flags)
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

async function buildZipIdentities(
    snapshot: ContentSnapshot,
    logicalRoot: string,
    physicalRoot: string,
    fileSystem: CdnFileSystem,
    observer: CdnFileHandleObserver | undefined,
): Promise<ReadonlyMap<string, ZipIdentity>> {
    const archiveSizes = new Map<string, number>()
    for (const edge of snapshot.cdn.edges) {
        for (const archive of edge.archives) {
            if (path.posix.extname(archive.relativePath).toLowerCase() !== ".zip") continue
            const previousSize = archiveSizes.get(archive.relativePath)
            if (previousSize === undefined || previousSize === archive.compressedBytes) {
                archiveSizes.set(archive.relativePath, archive.compressedBytes)
            } else {
                archiveSizes.delete(archive.relativePath)
            }
        }
    }

    const identities = new Map<string, ZipIdentity>()
    for (const [rawRelativePath, expectedSize] of archiveSizes) {
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
                || fileStat.size !== expectedSize
                || pathStat.dev !== fileStat.dev
                || pathStat.ino !== fileStat.ino) {
                continue
            }
            identities.set(relativePath, {
                logicalPath,
                dev: fileStat.dev,
                ino: fileStat.ino,
                size: fileStat.size,
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
    fileSystem: CdnFileSystem,
    observer: CdnFileHandleObserver | undefined,
) {
    let handle: FileHandle | null = null
    try {
        if (await hasSymlinkComponent(logicalRoot, relativePath, fileSystem)) {
            return reply.status(404).send("Not Found")
        }
        handle = await openObserved(identity.logicalPath, OPEN_READ_NOFOLLOW, fileSystem, observer)
        const fileStat = await handle.stat()
        const pathStat = await fileSystem.lstat(identity.logicalPath)
        if (!sameIdentity(fileStat, identity)
            || !sameIdentity(pathStat, identity)
            || await hasSymlinkComponent(logicalRoot, relativePath, fileSystem)) {
            await closeObserved(handle, observer)
            handle = null
            return reply.status(404).send("Not Found")
        }
        const response = sendHandle(reply, handle, "application/zip", observer)
        handle = null
        return response
    } catch {
        if (handle) await closeObserved(handle, observer)
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
    const logicalRoot = path.resolve(paths.cdnRoot)
    const physicalRoot = await fileSystem.realpath(logicalRoot)
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
                ? sendPinnedZip(reply, relativePath, identity, logicalRoot, fileSystem, observer)
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
