import fs from "node:fs"
import path from "node:path"

// Health metadata source only; this module does not validate or activate server bundles.
export const FALLBACK_BUNDLE_VERSION = "unknown"
const SEMANTIC_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
const BUNDLE_ID = /^sha256:[0-9a-f]{64}$/

export interface BundleMetadata {
    readonly version: string
    readonly bundleId: string | null
}

export interface LoadBundleMetadataOptions {
    readonly bundleRoot: string
    readonly loadServerManifest?: () => BundleMetadata | null
    readonly requireManifest?: boolean
    readonly readFileSync?: (filePath: string, encoding: "utf8") => string
}

export class BundleManifestError extends Error {
    readonly code = "INVALID_BUNDLE_MANIFEST"

    constructor() {
        super("embedded runtime requires a valid server manifest")
        this.name = "BundleManifestError"
    }
}

function isSafeMetadataValue(value: unknown): value is string {
    return typeof value === "string"
        && value.length > 0
        && value.length <= 128
        && !/[\x00-\x1f\x7f/\\]/.test(value)
}

function normalizeMetadata(value: BundleMetadata | null): BundleMetadata | null {
    if (value === null
        || !isSafeMetadataValue(value.version)
        || !SEMANTIC_VERSION.test(value.version)) return null
    if (value.bundleId !== null
        && (!isSafeMetadataValue(value.bundleId) || !BUNDLE_ID.test(value.bundleId))) return null
    return Object.freeze({ version: value.version, bundleId: value.bundleId })
}

function readDefaultServerManifest(
    bundleRoot: string,
    readFileSync: (filePath: string, encoding: "utf8") => string,
): BundleMetadata | null {
    const value = JSON.parse(readFileSync(path.join(bundleRoot, "server-manifest.json"), "utf8"))
    if (value?.schemaVersion !== 2
        || value?.name !== "starpoint-cn"
        || typeof value.serverVersion !== "string"
        || !SEMANTIC_VERSION.test(value.serverVersion)
        || typeof value.bundleId !== "string"
        || !BUNDLE_ID.test(value.bundleId)
        || value.entry !== "out/cn-server.js"
        || value.requires?.runtimeApi !== 1
        || typeof value.requires?.node !== "string"
        || !/^>=(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value.requires.node)
        || typeof value.requires?.dependencyLock !== "string"
        || !BUNDLE_ID.test(value.requires.dependencyLock)
        || value.requires?.minDataSchema !== 0
        || value.requires?.targetDataSchema !== 6) return null
    return {
        version: value.serverVersion,
        bundleId: value.bundleId,
    }
}

export function loadBundleMetadata({
    bundleRoot,
    loadServerManifest,
    requireManifest = false,
    readFileSync = fs.readFileSync,
}: LoadBundleMetadataOptions): BundleMetadata {
    try {
        const manifest = normalizeMetadata(
            requireManifest
                ? readDefaultServerManifest(bundleRoot, readFileSync)
                : loadServerManifest?.() ?? readDefaultServerManifest(bundleRoot, readFileSync),
        )
        if (manifest !== null) return manifest
    } catch { /* development checkouts may not contain a server manifest */ }
    if (requireManifest) throw new BundleManifestError()

    try {
        const packageJson = JSON.parse(readFileSync(path.join(bundleRoot, "package.json"), "utf8"))
        if (isSafeMetadataValue(packageJson?.version)) {
            return Object.freeze({ version: packageJson.version, bundleId: null })
        }
    } catch { /* packaged bundles may intentionally omit package.json */ }

    return Object.freeze({ version: FALLBACK_BUNDLE_VERSION, bundleId: null })
}
