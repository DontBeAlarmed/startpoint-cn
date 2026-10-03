import zlib from "node:zlib"
import fs from "node:fs"
import path from "node:path"

import unzipper from "unzipper"

/**
 * Physical location of medium/scaled assets inside the CDN archives. Stored
 * payloads keep the hashed shard path under `production/medium_upload/`.
 */
const MEDIUM_PHYSICAL_PATH_PATTERN = /^production\/medium_upload\/[a-f0-9]{2}\/[a-f0-9]{38}$/

export interface MediumArchiveLocation {
    readonly zipPath: string
    readonly entryName: string
}

export interface MediumArchiveIndexDependencies {
    readonly listArchives?: (directory: string) => Promise<readonly string[]>
    readonly openArchive?: (zipPath: string) => Promise<UnzippedFileLike>
    readonly readEntry?: ((zipPath: string, entryName: string) => Promise<Buffer>) | undefined
}

function defaultListArchives(directory: string): Promise<readonly string[]> {
    return fs.promises.readdir(directory).then(names => names
        .filter(name => name.endsWith(".zip"))
        .sort()
        .map(name => path.join(directory, name)))
}

function defaultOpenArchive(zipPath: string): Promise<UnzippedFileLike> {
    return unzipper.Open.file(zipPath)
}

interface UnzippedFileLike {
    readonly files: ReadonlyArray<{
        readonly path: string
        readonly type: string
        buffer?(): Promise<Buffer>
    }>
}

async function defaultReadEntry(zipPath: string, entryName: string, openArchive = defaultOpenArchive): Promise<Buffer> {
    const opened = await openArchive(zipPath)
    const entry = opened.files.find(file => file.type === "File" && file.path === entryName)
    if (!entry?.buffer) {
        throw new Error(`ZIP entry not found: ${entryName} in ${path.basename(zipPath)}`)
    }
    const content = await entry.buffer()
    if (!Buffer.isBuffer(content)) {
        throw new Error(`ZIP entry did not produce a Buffer: ${entryName}`)
    }
    return content
}

export function isMediumPhysicalPath(physicalPath: string): boolean {
    return MEDIUM_PHYSICAL_PATH_PATTERN.test(physicalPath)
}

/**
 * Lazily-built index over `<cdnRoot>/archive-medium-full/pinball-*.zip`
 * central directories mapping `production/medium_upload/<shard>/<hash>` to
 * the archive holding it. Read-only: archives are never extracted to disk;
 * entries are streamed out on demand.
 */
export class MediumArchiveIndex {
    readonly #directory: string
    readonly #dependencies: MediumArchiveIndexDependencies
    #index: ReadonlyMap<string, MediumArchiveLocation> | null = null
    #building: Promise<ReadonlyMap<string, MediumArchiveLocation>> | null = null

    constructor(directory: string, dependencies: MediumArchiveIndexDependencies = {}) {
        this.#directory = directory
        this.#dependencies = dependencies
    }

    /** Built-entry count, forcing construction. 0 also covers a missing directory. */
    async size(): Promise<number> {
        return (await this.#ensureIndex()).size
    }

    async locate(physicalPath: string): Promise<MediumArchiveLocation | null> {
        if (!isMediumPhysicalPath(physicalPath)) return null
        const index = await this.#ensureIndex()
        return index.get(physicalPath) ?? null
    }

    /** Raw stored bytes, or null when the location is unknown or unreadable. */
    async read(physicalPath: string): Promise<Buffer | null> {
        const location = await this.locate(physicalPath)
        if (location === null) return null
        try {
            const openArchive = this.#dependencies.openArchive ?? defaultOpenArchive
            const readEntry = this.#dependencies.readEntry
                ?? ((zipPath: string, entryName: string) => defaultReadEntry(zipPath, entryName, openArchive))
            return await readEntry(location.zipPath, location.entryName)
        } catch {
            return null
        }
    }

    #ensureIndex(): Promise<ReadonlyMap<string, MediumArchiveLocation>> {
        if (this.#index !== null) return Promise.resolve(this.#index)
        if (this.#building === null) {
            this.#building = this.#build().then(
                index => {
                    this.#index = index
                    this.#building = null
                    return index
                },
                error => {
                    this.#building = null
                    throw error
                },
            )
        }
        return this.#building
    }

    async #build(): Promise<ReadonlyMap<string, MediumArchiveLocation>> {
        const index = new Map<string, MediumArchiveLocation>()
        let archivePaths: readonly string[]
        try {
            const listArchives = this.#dependencies.listArchives ?? defaultListArchives
            archivePaths = await listArchives(this.#directory)
        } catch {
            // Missing/unreadable archive directory degrades to an empty index
            // (the serving route turns this into 404, never a 500).
            return index
        }
        const openArchive = this.#dependencies.openArchive ?? defaultOpenArchive
        for (const zipPath of archivePaths) {
            let opened: UnzippedFileLike
            try {
                opened = await openArchive(zipPath)
            } catch {
                continue
            }
            for (const entry of opened.files) {
                if (entry.type !== "File" || !isMediumPhysicalPath(entry.path)) continue
                // First archive wins; the medium-full chain is versioned so a
                // physical path appearing twice is the same immutable content.
                if (!index.has(entry.path)) {
                    index.set(entry.path, { zipPath, entryName: entry.path })
                }
            }
        }
        return index
    }
}

/**
 * Stored medium PNG payloads carry a 3-byte lowercase "png" where the PNG
 * signature expects "PNG" (in-stream bytes 1-3). Rewriting those three bytes
 * yields a spec-conform signature (89 50 4E 47 0D 0A 1A 0A) without touching
 * the image body.
 */
export function toBrowserPng(payload: Buffer): Buffer {
    const png = Buffer.from(payload)
    if (png.length >= 8
        && png[0] === 0x89
        && png[1] === 0x70 && png[2] === 0x6e && png[3] === 0x67
        && png[4] === 0x0d && png[5] === 0x0a && png[6] === 0x1a && png[7] === 0x0a) {
        png[1] = 0x50
        png[2] = 0x4e
        png[3] = 0x47
    }
    return png
}

/**
 * 归档内部分 PNG 的 zlib 流携带浏览器解码器(libpng/Chrome/sips)拒绝的深层结构
 * (实测 alk 的 square 头像: python zlib 可完整解压, 但 Image/sips 解码失败,
 * 表现为前端 onError 落回首字占位)。物化时对 IDAT 做一次 inflate→deflate 重压缩,
 * 输出标准 zlib 流; 结构异常无法解压的 payload 原样返回(维持既有回退行为)。
 */
export function normalizePngZlibStream(png: Buffer): Buffer {
    if (png.length < 45 || png.readUInt32BE(8) !== 13 || png.slice(12, 16).toString("latin1") !== "IHDR") {
        return png
    }
    try {
        const idatParts: Buffer[] = []
        const auxChunks: Buffer[] = []
        let pos = 8
        let sawIend = false
        while (pos + 12 <= png.length) {
            const length = png.readUInt32BE(pos)
            const type = png.slice(pos + 4, pos + 8).toString("latin1")
            if (pos + 12 + length > png.length) return png
            const payload = png.slice(pos + 8, pos + 8 + length)
            if (type === "IDAT") {
                idatParts.push(payload)
            } else if (type !== "IEND") {
                auxChunks.push(png.slice(pos, pos + 12 + length))
            }
            pos += 12 + length
            if (type === "IEND") { sawIend = true; break }
        }
        if (!sawIend || idatParts.length === 0) return png
        const raw = zlib.inflateSync(Buffer.concat(idatParts))
        const recompressed = zlib.deflateSync(raw, { level: 9 })
        const ihdr = auxChunks.find(c => c.slice(4, 8).toString("latin1") === "IHDR")
        if (ihdr === undefined) return png
        const rest = auxChunks.filter(c => c !== ihdr)
        return Buffer.concat([
            png.slice(0, 8),
            ihdr,
            ...rest,
            pngChunk("IDAT", recompressed),
            pngChunk("IEND", Buffer.alloc(0)),
        ])
    } catch {
        return png
    }
}

const pngCrcTable = (() => {
    const table = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
        let c = n
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
        table[n] = c >>> 0
    }
    return table
})()

function pngCrc(...parts: Buffer[]): number {
    let crc = 0xffffffff
    for (const part of parts) {
        for (let i = 0; i < part.length; i++) {
            crc = pngCrcTable[(crc ^ part[i]) & 0xff] ^ (crc >>> 8)
        }
    }
    return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, payload: Buffer): Buffer {
    const buf = Buffer.alloc(12 + payload.length)
    buf.writeUInt32BE(payload.length, 0)
    buf.write(type, 4, "latin1")
    payload.copy(buf, 8)
    buf.writeUInt32BE(pngCrc(Buffer.from(type, "latin1"), payload), 8 + payload.length)
    return buf
}

const indexesByDirectory = new Map<string, MediumArchiveIndex>()

/** Process-lifetime cache: one index per resolved archive directory. */
export function getMediumArchiveIndex(directory: string): MediumArchiveIndex {
    const key = path.resolve(directory)
    let index = indexesByDirectory.get(key)
    if (index === undefined) {
        index = new MediumArchiveIndex(key)
        indexesByDirectory.set(key, index)
    }
    return index
}
