import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const MAX_SNAPSHOT_ATTEMPTS = 3

export interface DigestCacheEntry {
    readonly path: string
    readonly size: number
    readonly mtimeMs: string
    readonly ctimeMs: string
    readonly dev: string
    readonly ino: string
    readonly digest: string
}

export interface DigestFileCandidate {
    readonly path: string
    readonly absolutePath: string
}

export interface StableDigestSnapshot extends DigestCacheEntry {}

interface FileSnapshotStat {
    readonly size: bigint
    readonly mtimeMs: bigint
    readonly ctimeMs: bigint
    readonly dev: bigint
    readonly ino: bigint
    isFile(): boolean
}

export interface DigestFileHandle {
    stat(options: { readonly bigint: true }): Promise<FileSnapshotStat>
    read(
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
    ): Promise<{ readonly bytesRead: number }>
    close(): Promise<void>
}

export interface DigestCacheDependencies {
    readonly digestFile?: (fileHandle: DigestFileHandle, filePath: string) => Promise<string>
    readonly openFile?: (filePath: string) => Promise<DigestFileHandle>
    readonly readFile?: (filePath: string, encoding: BufferEncoding) => Promise<string>
    readonly writeFile?: (filePath: string, data: string, encoding: BufferEncoding) => Promise<void>
    readonly mkdir?: (directory: string) => Promise<void>
    readonly rename?: (from: string, to: string) => Promise<void>
    readonly unlink?: (filePath: string) => Promise<void>
}

export class UnstableFileSnapshotError extends Error {
    readonly relativePath: string

    constructor(relativePath: string) {
        super(`archive changed during ${MAX_SNAPSHOT_ATTEMPTS} snapshot attempts: ${relativePath}`)
        this.name = "UnstableFileSnapshotError"
        this.relativePath = relativePath
    }
}

async function defaultDigestFile(fileHandle: DigestFileHandle): Promise<string> {
    const hash = createHash("sha256")
    const buffer = Buffer.alloc(64 * 1024)
    let position = 0
    while (true) {
        const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, position)
        if (bytesRead === 0) break
        hash.update(buffer.subarray(0, bytesRead))
        position += bytesRead
    }
    return hash.digest("hex")
}

function isCacheEntry(value: unknown): value is DigestCacheEntry {
    if (!value || typeof value !== "object") return false
    const entry = value as Partial<DigestCacheEntry>
    return typeof entry.path === "string"
        && Number.isSafeInteger(entry.size)
        && entry.size! >= 0
        && typeof entry.mtimeMs === "string"
        && /^-?\d+$/.test(entry.mtimeMs)
        && typeof entry.ctimeMs === "string"
        && /^-?\d+$/.test(entry.ctimeMs)
        && typeof entry.dev === "string"
        && /^\d+$/.test(entry.dev)
        && typeof entry.ino === "string"
        && /^\d+$/.test(entry.ino)
        && typeof entry.digest === "string"
        && /^[a-f0-9]{64}$/.test(entry.digest)
        && Object.keys(entry).every(key => (
            ["path", "size", "mtimeMs", "ctimeMs", "dev", "ino", "digest"].includes(key)
        ))
}

async function readCache(
    cachePath: string,
    readFile: NonNullable<DigestCacheDependencies["readFile"]>,
): Promise<Map<string, DigestCacheEntry>> {
    try {
        const parsed: unknown = JSON.parse(await readFile(cachePath, "utf8"))
        if (!Array.isArray(parsed) || !parsed.every(isCacheEntry)) return new Map()
        return new Map(parsed.map(entry => [entry.path, entry]))
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
            return new Map()
        }
        throw error
    }
}

function snapshotFromStat(relativePath: string, stat: FileSnapshotStat, digest: string): StableDigestSnapshot {
    if (!stat.isFile()) throw new Error(`archive is not a regular file: ${relativePath}`)
    if (stat.size < BigInt(0) || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`archive has unsupported file metadata: ${relativePath}`)
    }
    return {
        path: relativePath,
        size: Number(stat.size),
        mtimeMs: stat.mtimeMs.toString(10),
        ctimeMs: stat.ctimeMs.toString(10),
        dev: stat.dev.toString(10),
        ino: stat.ino.toString(10),
        digest,
    }
}

function hasSameFingerprint(
    left: Omit<DigestCacheEntry, "path" | "digest">,
    right: Omit<DigestCacheEntry, "path" | "digest">,
): boolean {
    return left.size === right.size
        && left.mtimeMs === right.mtimeMs
        && left.ctimeMs === right.ctimeMs
        && left.dev === right.dev
        && left.ino === right.ino
}

async function readStableSnapshot(
    candidate: DigestFileCandidate,
    cached: DigestCacheEntry | undefined,
    dependencies: Required<Pick<DigestCacheDependencies, "digestFile" | "openFile">>,
): Promise<StableDigestSnapshot> {
    for (let attempt = 0; attempt < MAX_SNAPSHOT_ATTEMPTS; attempt++) {
        const fileHandle = await dependencies.openFile(candidate.absolutePath)
        try {
            const before = snapshotFromStat(candidate.path, await fileHandle.stat({ bigint: true }), "")
            const digest = cached && hasSameFingerprint(cached, before)
                ? cached.digest
                : await dependencies.digestFile(fileHandle, candidate.absolutePath)
            const after = snapshotFromStat(candidate.path, await fileHandle.stat({ bigint: true }), digest)
            if (hasSameFingerprint(before, after)) return after
        } finally {
            await fileHandle.close()
        }
    }
    throw new UnstableFileSnapshotError(candidate.path)
}

export async function resolveDigestCache(
    candidates: ReadonlyArray<DigestFileCandidate>,
    cachePath: string,
    dependencies: DigestCacheDependencies = {},
): Promise<ReadonlyMap<string, StableDigestSnapshot>> {
    const readFile = dependencies.readFile ?? ((filePath, encoding) => fs.promises.readFile(filePath, encoding))
    const writeFile = dependencies.writeFile ?? ((filePath, data, encoding) => fs.promises.writeFile(filePath, data, encoding))
    const mkdir = dependencies.mkdir ?? (directory => fs.promises.mkdir(directory, { recursive: true }).then(() => undefined))
    const rename = dependencies.rename ?? ((from, to) => fs.promises.rename(from, to))
    const unlink = dependencies.unlink ?? (filePath => fs.promises.unlink(filePath))
    const stableDependencies = {
        digestFile: dependencies.digestFile ?? defaultDigestFile,
        openFile: dependencies.openFile ?? (filePath => fs.promises.open(filePath, "r")),
    }
    const previous = await readCache(cachePath, readFile)
    const entries: StableDigestSnapshot[] = []

    for (const candidate of [...candidates].sort((left, right) => left.path.localeCompare(right.path))) {
        entries.push(await readStableSnapshot(candidate, previous.get(candidate.path), stableDependencies))
    }

    await mkdir(path.dirname(cachePath))
    const temporaryPath = `${cachePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    try {
        await writeFile(temporaryPath, `${JSON.stringify(entries, null, 2)}\n`, "utf8")
        await rename(temporaryPath, cachePath)
    } catch (error) {
        try {
            await unlink(temporaryPath)
        } catch (cleanupError) {
            if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError
        }
        throw error
    }

    return new Map(entries.map(entry => [entry.path, entry]))
}
