import fs from "node:fs"
import path from "node:path"

// Health metadata source only; this module does not validate or activate server bundles.
export const FALLBACK_BUNDLE_VERSION = "unknown"

export interface BundleMetadata {
    readonly version: string
    readonly bundleId: string | null
}

export interface LoadBundleMetadataOptions {
    readonly bundleRoot: string
    readonly loadServerManifest?: () => BundleMetadata | null
    readonly readFileSync?: (filePath: string, encoding: "utf8") => string
}

function isSafeMetadataValue(value: unknown): value is string {
    return typeof value === "string"
        && value.length > 0
        && value.length <= 128
        && !/[\x00-\x1f\x7f/\\]/.test(value)
}

function normalizeMetadata(value: BundleMetadata | null): BundleMetadata | null {
    if (value === null || !isSafeMetadataValue(value.version)) return null
    if (value.bundleId !== null && !isSafeMetadataValue(value.bundleId)) return null
    return Object.freeze({ version: value.version, bundleId: value.bundleId })
}

export function loadBundleMetadata({
    bundleRoot,
    loadServerManifest,
    readFileSync = fs.readFileSync,
}: LoadBundleMetadataOptions): BundleMetadata {
    try {
        const manifest = normalizeMetadata(loadServerManifest?.() ?? null)
        if (manifest !== null) return manifest
    } catch { /* future manifest is optional until its contract is implemented */ }

    try {
        const packageJson = JSON.parse(readFileSync(path.join(bundleRoot, "package.json"), "utf8"))
        if (isSafeMetadataValue(packageJson?.version)) {
            return Object.freeze({ version: packageJson.version, bundleId: null })
        }
    } catch { /* packaged bundles may intentionally omit package.json */ }

    return Object.freeze({ version: FALLBACK_BUNDLE_VERSION, bundleId: null })
}
