import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

export interface DigestCacheEntry {
    readonly path: string
    readonly size: number
    readonly mtime: number
    readonly digest: string
}

export interface DigestFileCandidate {
    readonly path: string
    readonly absolutePath: string
    readonly size: number
    readonly mtime: number
}

export interface DigestCacheDependencies {
    readonly digestFile?: (filePath: string) => Promise<string>
    readonly readFile?: (filePath: string, encoding: BufferEncoding) => Promise<string>
    readonly writeFile?: (filePath: string, data: string, encoding: BufferEncoding) => Promise<void>
    readonly mkdir?: (directory: string) => Promise<void>
    readonly rename?: (from: string, to: string) => Promise<void>
    readonly unlink?: (filePath: string) => Promise<void>
}

async function defaultDigestFile(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = createHash("sha256")
        const stream = fs.createReadStream(filePath)
        stream.on("error", reject)
        stream.on("data", chunk => hash.update(chunk))
        stream.on("end", () => resolve(hash.digest("hex")))
    })
}

function isCacheEntry(value: unknown): value is DigestCacheEntry {
    if (!value || typeof value !== "object") return false
    const entry = value as Partial<DigestCacheEntry>
    return typeof entry.path === "string"
        && Number.isSafeInteger(entry.size)
        && entry.size! >= 0
        && Number.isFinite(entry.mtime)
        && typeof entry.digest === "string"
        && /^[a-f0-9]{64}$/.test(entry.digest)
        && Object.keys(entry).every(key => ["path", "size", "mtime", "digest"].includes(key))
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

export async function resolveDigestCache(
    candidates: ReadonlyArray<DigestFileCandidate>,
    cachePath: string,
    dependencies: DigestCacheDependencies = {},
): Promise<ReadonlyMap<string, string>> {
    const readFile = dependencies.readFile ?? ((filePath, encoding) => fs.promises.readFile(filePath, encoding))
    const writeFile = dependencies.writeFile ?? ((filePath, data, encoding) => fs.promises.writeFile(filePath, data, encoding))
    const mkdir = dependencies.mkdir ?? (directory => fs.promises.mkdir(directory, { recursive: true }).then(() => undefined))
    const rename = dependencies.rename ?? ((from, to) => fs.promises.rename(from, to))
    const unlink = dependencies.unlink ?? (filePath => fs.promises.unlink(filePath))
    const digestFile = dependencies.digestFile ?? defaultDigestFile
    const previous = await readCache(cachePath, readFile)
    const entries: DigestCacheEntry[] = []

    for (const candidate of [...candidates].sort((left, right) => left.path.localeCompare(right.path))) {
        const cached = previous.get(candidate.path)
        const digest = cached && cached.size === candidate.size && cached.mtime === candidate.mtime
            ? cached.digest
            : await digestFile(candidate.absolutePath)
        entries.push({
            path: candidate.path,
            size: candidate.size,
            mtime: candidate.mtime,
            digest,
        })
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

    return new Map(entries.map(entry => [entry.path, entry.digest]))
}
