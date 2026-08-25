import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { getRealNowMs } from "../../runtime/time/game-time"

export interface LegacyAssetArchive {
    readonly location: string
    readonly size: number
    readonly sha256: string
}

export interface LegacyAssetMetadata {
    readonly version: number
    readonly mods: readonly LegacyAssetArchive[]
}

export interface LegacyAssetState {
    readonly availableAssetVersion: string
    readonly metadata: LegacyAssetMetadata
}

export interface LoadLegacyAssetStateOptions {
    readonly cdnDir: string
    readonly assetProviderDir: string
    readonly metadataFile: string
    readonly log?: (message: string) => void
}

const DEFAULT_METADATA: LegacyAssetMetadata = Object.freeze({ version: 125, mods: Object.freeze([]) })

function availableVersion(version: number): string {
    return `2.1.${version}`
}

function inspectOptionalRegularFile(filePath: string, label: string): fs.Stats | null {
    let stats: fs.Stats
    try {
        stats = fs.lstatSync(filePath)
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
        throw error
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new Error(`${label} must be a regular file`)
    }
    return stats
}

function ensureAssetProviderDirectory(directory: string): void {
    let stats: fs.Stats | null = null
    try {
        stats = fs.lstatSync(directory)
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    if (stats === null) {
        fs.mkdirSync(directory, { recursive: true })
        stats = fs.lstatSync(directory)
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error("Legacy asset provider directory must be a directory, not a symbolic link")
    }
}

function parseMetadata(contents: string): LegacyAssetMetadata {
    const value = JSON.parse(contents) as Partial<LegacyAssetMetadata>
    if (!Number.isSafeInteger(value.version) || (value.version as number) < 0 || !Array.isArray(value.mods)) {
        throw new Error("legacy asset metadata has an invalid shape")
    }
    const mods = value.mods.map((entry, index): LegacyAssetArchive => {
        if (!entry || typeof entry !== "object"
            || typeof entry.location !== "string"
            || !Number.isSafeInteger(entry.size) || entry.size < 0
            || typeof entry.sha256 !== "string") {
            throw new Error(`legacy asset metadata mods[${index}] is invalid`)
        }
        return Object.freeze({
            location: entry.location,
            size: entry.size,
            sha256: entry.sha256,
        })
    })
    return Object.freeze({ version: value.version as number, mods: Object.freeze(mods) })
}

function readMetadata(
    metadataFile: string,
    legacyMetadataFile: string,
    log: (message: string) => void,
): LegacyAssetMetadata {
    const canonical = inspectOptionalRegularFile(metadataFile, "Legacy asset metadata")
    const legacy = canonical === null
        ? inspectOptionalRegularFile(legacyMetadataFile, "Legacy CDN metadata")
        : null
    const readPath = canonical !== null ? metadataFile : legacy !== null ? legacyMetadataFile : null
    if (readPath === null) return DEFAULT_METADATA
    try {
        return parseMetadata(fs.readFileSync(readPath, "utf8"))
    } catch (error) {
        log(`Error when reading CDN metadata: ${String(error)}`)
        return DEFAULT_METADATA
    }
}

function hashFile(filePath: string): string {
    return createHash("sha256").update(fs.readFileSync(filePath)).digest("base64")
}

function buildModList(modsDir: string): readonly LegacyAssetArchive[] {
    const directoryStats = fs.lstatSync(modsDir)
    if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
        throw new Error("Legacy mods path must be a directory, not a symbolic link")
    }
    return Object.freeze(fs.readdirSync(modsDir).sort().map(modZipName => {
        const modZipPath = path.join(modsDir, modZipName)
        const stats = inspectOptionalRegularFile(modZipPath, "Legacy mod archive")
        if (stats === null) throw new Error("Legacy mod archive disappeared while loading")
        return Object.freeze({
            location: `{$cdnAddress}/mods/${modZipName}`,
            size: stats.size,
            sha256: hashFile(modZipPath),
        })
    }))
}

function modsMatch(metadata: LegacyAssetMetadata, mods: readonly LegacyAssetArchive[]): boolean {
    if (metadata.mods.length !== mods.length) return false
    return metadata.mods.every((entry, index) => (
        entry.location === mods[index].location
        && entry.size === mods[index].size
        && entry.sha256 === mods[index].sha256
    ))
}

function publishMetadata(
    assetProviderDir: string,
    metadataFile: string,
    metadata: LegacyAssetMetadata,
): void {
    ensureAssetProviderDirectory(assetProviderDir)
    inspectOptionalRegularFile(metadataFile, "Legacy asset metadata")
    const temporaryFile = path.join(
        assetProviderDir,
        `.${path.basename(metadataFile)}.${process.pid}.${getRealNowMs()}.tmp`,
    )
    let descriptor: number | null = null
    try {
        descriptor = fs.openSync(
            temporaryFile,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
            0o600,
        )
        fs.writeFileSync(descriptor, JSON.stringify(metadata), "utf8")
        fs.fsyncSync(descriptor)
        fs.closeSync(descriptor)
        descriptor = null
        fs.renameSync(temporaryFile, metadataFile)
    } catch (error) {
        if (descriptor !== null) {
            try { fs.closeSync(descriptor) } catch { /* preserve publication error */ }
        }
        try { fs.unlinkSync(temporaryFile) } catch { /* temporary file may not exist */ }
        throw error
    }
}

export function loadLegacyAssetState({
    cdnDir,
    assetProviderDir,
    metadataFile,
    log = console.log,
}: LoadLegacyAssetStateOptions): LegacyAssetState {
    const metadata = readMetadata(metadataFile, path.join(cdnDir, "metadata.json"), log)
    const modsDir = path.join(cdnDir, "mods")
    let mods: readonly LegacyAssetArchive[]
    try {
        const stats = fs.lstatSync(modsDir)
        if (stats.isSymbolicLink() || !stats.isDirectory()) {
            throw new Error("Legacy mods path must be a directory, not a symbolic link")
        }
        mods = buildModList(modsDir)
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return Object.freeze({
                availableAssetVersion: availableVersion(metadata.version),
                metadata,
            })
        }
        throw error
    }

    if (modsMatch(metadata, mods)) {
        return Object.freeze({
            availableAssetVersion: availableVersion(metadata.version),
            metadata,
        })
    }

    const nextMetadata = Object.freeze({
        version: metadata.version + 1,
        mods,
    })
    publishMetadata(assetProviderDir, metadataFile, nextMetadata)
    log(`${nextMetadata.mods.length} Mods Loaded.`)
    return Object.freeze({
        availableAssetVersion: availableVersion(nextMetadata.version),
        metadata: nextMetadata,
    })
}
