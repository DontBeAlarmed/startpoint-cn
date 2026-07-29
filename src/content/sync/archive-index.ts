import fs from "node:fs"
import path from "node:path"
import unzipper from "unzipper"

import { planCdnUpdate } from "../cdn/planner"
import {
    createBaselineArchiveSourceManifest,
    parseArchiveSourceManifest,
    sourceFor,
    sourceRoot,
    type ArchiveSourceManifest,
} from "../cdn/archive-sources"
import type { CatalogArchive, CdnCatalog } from "../cdn/types"
import { deepFreeze } from "../deep-freeze"
import type { ContentPaths } from "../paths"

const PHYSICAL_PATH_PATTERN = /^production\/upload\/[a-f0-9]{2}\/[a-f0-9]{38}$/

interface ArchiveFileStat {
    readonly size: bigint
    readonly mtimeMs: bigint
    readonly ctimeMs: bigint
    readonly dev: bigint
    readonly ino: bigint
    isFile(): boolean
}

export interface ArchiveIndexEntry {
    readonly path: string
    readonly type: string
    readonly uncompressedSize: number
    buffer?(): Promise<Buffer>
    read?(): Promise<Buffer>
}

export interface OpenedArchiveIndex {
    readonly files: ReadonlyArray<ArchiveIndexEntry>
}

export interface ArchiveIndexDependencies {
    readonly openArchive?: (archivePath: string) => Promise<OpenedArchiveIndex>
    readonly realpath?: (filePath: string) => Promise<string>
    readonly stat?: (filePath: string) => Promise<ArchiveFileStat>
    readonly lstat?: (filePath: string) => Promise<ArchiveFileStat & {
        isDirectory(): boolean
        isSymbolicLink(): boolean
    }>
}

export interface ArchiveEntryLocation {
    readonly archiveRelativePath: string
    readonly entryName: string
    readonly uncompressedBytes: number
}

interface ArchiveSnapshot {
    readonly physicalPath: string
    readonly size: number
    readonly mtimeMs: string
    readonly ctimeMs: string
    readonly dev: string
    readonly ino: string
}

interface IndexedEntry {
    readonly location: ArchiveEntryLocation
    readonly archive: CatalogArchive
    readonly lexicalRoot: string
    readonly physicalRoot: string
    readonly archiveSnapshot: ArchiveSnapshot
}

function isSameOrDescendant(parent: string, candidate: string): boolean {
    const relativePath = path.relative(parent, candidate)
    return relativePath === ""
        || (!path.isAbsolute(relativePath)
            && relativePath !== ".."
            && !relativePath.startsWith(`..${path.sep}`))
}

function isSafeRelativePath(relativePath: string, directory = false): boolean {
    const candidate = directory && relativePath.endsWith("/")
        ? relativePath.slice(0, -1)
        : relativePath
    if (!candidate
        || candidate.includes("\\")
        || /[\u0000-\u001f\u007f]/.test(candidate)
        || path.posix.isAbsolute(candidate)
        || path.win32.isAbsolute(candidate)
        || /^[A-Za-z]:/.test(candidate)) return false
    const segments = candidate.split("/")
    return segments.every(segment => segment !== "" && segment !== "." && segment !== "..")
}

function assertSafeEntryPath(entryName: string, directory = false): void {
    if (!isSafeRelativePath(entryName, directory)) {
        throw new Error(`unsafe ZIP entry path: ${entryName}`)
    }
}

function isPhysicalPath(physicalPath: string): boolean {
    return PHYSICAL_PATH_PATTERN.test(physicalPath)
}

function defaultStat(filePath: string): Promise<ArchiveFileStat> {
    return fs.promises.stat(filePath, { bigint: true })
}

function snapshotFromStat(
    archiveRelativePath: string,
    physicalPath: string,
    stat: ArchiveFileStat,
): ArchiveSnapshot {
    if (!stat.isFile()) throw new Error(`archive is not a regular file: ${archiveRelativePath}`)
    if (stat.size < BigInt(0) || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`archive has unsupported file metadata: ${archiveRelativePath}`)
    }
    return {
        physicalPath,
        size: Number(stat.size),
        mtimeMs: stat.mtimeMs.toString(10),
        ctimeMs: stat.ctimeMs.toString(10),
        dev: stat.dev.toString(10),
        ino: stat.ino.toString(10),
    }
}

function sameSnapshot(left: ArchiveSnapshot, right: ArchiveSnapshot): boolean {
    return left.physicalPath === right.physicalPath
        && left.size === right.size
        && left.mtimeMs === right.mtimeMs
        && left.ctimeMs === right.ctimeMs
        && left.dev === right.dev
        && left.ino === right.ino
}

async function secureArchiveSnapshot(
    cdnRoot: string,
    cdnRealRoot: string,
    archive: CatalogArchive,
    dependencies: ArchiveIndexDependencies,
): Promise<ArchiveSnapshot> {
    if (!isSafeRelativePath(archive.relativePath)) {
        throw new Error(`invalid catalog archive path: ${archive.relativePath}`)
    }
    const absolutePath = path.resolve(cdnRoot, archive.relativePath)
    if (!isSameOrDescendant(cdnRoot, absolutePath)) {
        throw new Error(`archive escapes cdnRoot: ${archive.relativePath}`)
    }
    const lstat = dependencies.lstat
        ?? (filePath => fs.promises.lstat(filePath, { bigint: true }))
    const rootStat = await lstat(cdnRoot)
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        throw new Error(`archive source root is not a regular directory: ${archive.relativePath}`)
    }
    let componentPath = cdnRoot
    for (const [index, segment] of archive.relativePath.split("/").entries()) {
        componentPath = path.join(componentPath, segment)
        const component = await lstat(componentPath)
        if (component.isSymbolicLink()) {
            throw new Error(`archive path contains a symbolic link: ${archive.relativePath}`)
        }
        const isLeaf = index === archive.relativePath.split("/").length - 1
        if ((!isLeaf && !component.isDirectory()) || (isLeaf && !component.isFile())) {
            throw new Error(`archive path has the wrong file type: ${archive.relativePath}`)
        }
    }
    const realpath = dependencies.realpath ?? (filePath => fs.promises.realpath(filePath))
    const physicalPath = path.resolve(await realpath(absolutePath))
    if (!isSameOrDescendant(cdnRealRoot, physicalPath)) {
        throw new Error(`archive resolves outside cdnRoot: ${archive.relativePath}`)
    }
    const stat = dependencies.stat ?? defaultStat
    const snapshot = snapshotFromStat(
        archive.relativePath,
        physicalPath,
        await stat(physicalPath),
    )
    if (snapshot.size !== archive.compressedBytes) {
        throw new Error(
            `archive size does not match catalog: ${archive.relativePath} (${snapshot.size} != ${archive.compressedBytes})`,
        )
    }
    return snapshot
}

function assertStableArchive(
    before: ArchiveSnapshot,
    after: ArchiveSnapshot,
    archiveRelativePath: string,
): void {
    if (!sameSnapshot(before, after)) {
        throw new Error(`archive changed during index build or read: ${archiveRelativePath}`)
    }
}

function assertEntrySize(entry: ArchiveIndexEntry): number {
    if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) {
        throw new Error(`ZIP entry has invalid uncompressed size: ${entry.path}`)
    }
    return entry.uncompressedSize
}

export class ArchiveIndex {
    readonly #entries: ReadonlyMap<string, IndexedEntry>
    private readonly dependencies: ArchiveIndexDependencies

    private constructor(
        entries: ReadonlyMap<string, IndexedEntry>,
        dependencies: ArchiveIndexDependencies,
    ) {
        this.#entries = entries
        this.dependencies = dependencies
    }

    static async build(
        catalog: CdnCatalog,
        pathsOrRoot: Pick<ContentPaths, "cdnRoot" | "patchesRoot"> | string,
        archiveSourcesOrDependencies: ArchiveSourceManifest | ArchiveIndexDependencies = {},
        maybeDependencies: ArchiveIndexDependencies = {},
    ): Promise<ArchiveIndex> {
        const legacy = typeof pathsOrRoot === "string"
        const paths: Pick<ContentPaths, "cdnRoot" | "patchesRoot"> = legacy
            ? {
                cdnRoot: pathsOrRoot,
                patchesRoot: path.join(path.dirname(pathsOrRoot), "patches"),
            }
            : pathsOrRoot
        const dependencies = legacy
            ? archiveSourcesOrDependencies as ArchiveIndexDependencies
            : maybeDependencies
        const archiveSources = legacy
            ? createBaselineArchiveSourceManifest(catalog)
            : parseArchiveSourceManifest(archiveSourcesOrDependencies, catalog)
        const realpath = dependencies.realpath ?? (filePath => fs.promises.realpath(filePath))
        const openArchive = dependencies.openArchive
            ?? (archivePath => unzipper.Open.file(archivePath))
        const plan = planCdnUpdate(catalog, {
            currentVersion: null,
            targetVersion: catalog.targetVersion,
            platform: "android",
            assetSizeKind: "fulfill",
            isInitial: true,
        })
        if (plan.kind !== "initial") {
            throw new Error(`expected initial CDN plan, received ${plan.kind}`)
        }
        const edges = [plan.full, ...(plan.diff ?? [])]
        const indexed = new Map<string, IndexedEntry>()

        for (const edge of edges) {
            for (const archive of edge.archives) {
                const source = sourceFor(archiveSources, archive.relativePath)
                const lexicalRoot = path.resolve(sourceRoot(paths, source))
                const physicalRoot = path.resolve(await realpath(lexicalRoot))
                const before = await secureArchiveSnapshot(
                    lexicalRoot,
                    physicalRoot,
                    archive,
                    dependencies,
                )
                const opened = await openArchive(before.physicalPath)
                const pathsInArchive = new Set<string>()
                for (const entry of opened.files) {
                    assertSafeEntryPath(entry.path, entry.type === "Directory")
                    if (entry.type !== "File" || !isPhysicalPath(entry.path)) continue
                    if (pathsInArchive.has(entry.path)) {
                        throw new Error(
                            `duplicate physical path in archive ${archive.relativePath}: ${entry.path}`,
                        )
                    }
                    pathsInArchive.add(entry.path)
                    const location = deepFreeze({
                        archiveRelativePath: archive.relativePath,
                        entryName: entry.path,
                        uncompressedBytes: assertEntrySize(entry),
                    })
                    indexed.set(entry.path, {
                        location,
                        archive,
                        lexicalRoot,
                        physicalRoot,
                        archiveSnapshot: before,
                    })
                }
                const after = await secureArchiveSnapshot(
                    lexicalRoot,
                    path.resolve(await realpath(lexicalRoot)),
                    archive,
                    dependencies,
                )
                assertStableArchive(before, after, archive.relativePath)
            }
        }

        const index = new ArchiveIndex(indexed, dependencies)
        Object.freeze(index)
        return index
    }

    has(physicalPath: string): boolean {
        return isPhysicalPath(physicalPath) && this.#entries.has(physicalPath)
    }

    location(physicalPath: string): ArchiveEntryLocation | null {
        if (!isPhysicalPath(physicalPath)) return null
        return this.#entries.get(physicalPath)?.location ?? null
    }

    async read(physicalPath: string): Promise<Buffer> {
        if (!isPhysicalPath(physicalPath)) {
            throw new Error(`invalid physical path: ${physicalPath}`)
        }
        const indexed = this.#entries.get(physicalPath)
        if (!indexed) throw new Error(`physical path not found in archive index: ${physicalPath}`)

        const before = await secureArchiveSnapshot(
            indexed.lexicalRoot,
            indexed.physicalRoot,
            indexed.archive,
            this.dependencies,
        )
        assertStableArchive(indexed.archiveSnapshot, before, indexed.archive.relativePath)
        const openArchive = this.dependencies.openArchive
            ?? (archivePath => unzipper.Open.file(archivePath))
        const opened = await openArchive(before.physicalPath)
        const matches: ArchiveIndexEntry[] = []
        for (const entry of opened.files) {
            assertSafeEntryPath(entry.path, entry.type === "Directory")
            if (entry.type === "File" && entry.path === indexed.location.entryName) matches.push(entry)
        }
        if (matches.length !== 1) {
            throw new Error(
                `indexed ZIP entry is ${matches.length === 0 ? "missing" : "duplicated"}: ${physicalPath}`,
            )
        }
        const entry = matches[0]
        if (assertEntrySize(entry) !== indexed.location.uncompressedBytes) {
            throw new Error(`ZIP entry size changed: ${physicalPath}`)
        }
        if (!entry.buffer) throw new Error(`ZIP entry cannot be read: ${physicalPath}`)
        const content = await entry.buffer()
        if (!Buffer.isBuffer(content)) throw new Error(`ZIP entry did not produce a Buffer: ${physicalPath}`)
        if (content.length !== indexed.location.uncompressedBytes) {
            throw new Error(
                `ZIP entry length does not match central directory: ${physicalPath}`,
            )
        }
        const after = await secureArchiveSnapshot(
            indexed.lexicalRoot,
            indexed.physicalRoot,
            indexed.archive,
            this.dependencies,
        )
        assertStableArchive(before, after, indexed.archive.relativePath)
        return Buffer.from(content)
    }
}
