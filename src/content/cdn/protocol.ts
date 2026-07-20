import type { CatalogArchive, DiffCatalogEdge, FullCatalogEdge, UpdatePlan } from "./types"

export interface CdnProtocolOptions {
    readonly baseUrl: string
    readonly currentVersion: string | null
    readonly targetVersion: string
}

export interface CnWireArchive {
    readonly location: string
    readonly size: number
    readonly sha256: string
}

export interface CnWireFull {
    readonly version: string
    readonly archive: ReadonlyArray<CnWireArchive>
}

export interface CnWireDiff {
    readonly original_version: string
    readonly version: string
    readonly archive: ReadonlyArray<CnWireArchive>
}

export interface CnAssetUpdateWire {
    readonly info: {
        readonly client_asset_version: string
        readonly target_asset_version: string
        readonly eventual_target_asset_version: string
        readonly is_initial: boolean
    }
    readonly full: CnWireFull | null
    readonly diff: ReadonlyArray<CnWireDiff> | null
    readonly asset_version_hash: string
    readonly delayed_assets_size: 0
}

export function normalizeCdnBaseUrl(baseUrl: string): string {
    const value = baseUrl.trim()
    if (!value || value.includes("\\") || /[?#]/.test(value)) {
        throw new Error("CDN base URL contains unsupported characters")
    }

    const pathStart = value.indexOf("/", value.indexOf("://") + 3)
    const rawPath = pathStart === -1 ? "" : value.slice(pathStart)
    if (rawPath.includes("%")
        || /\/{2,}/.test(rawPath)
        || /(?:^|\/)\.{1,2}(?:\/|$)/.test(rawPath)) {
        throw new Error("CDN base URL contains an unsafe path")
    }

    const parsed = new URL(value)
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
        || parsed.username
        || parsed.password) {
        throw new Error("CDN base URL must be an HTTP(S) origin URL")
    }
    const pathname = parsed.pathname.replace(/\/+$/, "")
    return `${parsed.origin}${pathname}`
}

function requireSafeRelativePath(relativePath: string): string {
    if (!relativePath
        || relativePath.includes("\\")
        || relativePath.startsWith("/")
        || relativePath.includes("//")
        || /[?#%]/.test(relativePath)
        || /^[A-Za-z][A-Za-z\d+.-]*:/.test(relativePath)) {
        throw new Error(`unsafe CDN archive path: ${relativePath}`)
    }
    const segments = relativePath.split("/")
    if (segments.some(segment => segment === "" || segment === "." || segment === "..")) {
        throw new Error(`unsafe CDN archive path: ${relativePath}`)
    }
    return relativePath
}

function serializeArchive(baseUrl: string, archive: CatalogArchive): CnWireArchive {
    const relativePath = requireSafeRelativePath(archive.relativePath)
    return {
        location: `${baseUrl}/${relativePath}`,
        size: archive.compressedBytes,
        sha256: archive.sha256,
    }
}

function serializeFull(baseUrl: string, edge: FullCatalogEdge): CnWireFull {
    return {
        version: edge.toVersion,
        archive: edge.archives.map(archive => serializeArchive(baseUrl, archive)),
    }
}

function serializeDiff(baseUrl: string, edge: DiffCatalogEdge): CnWireDiff {
    return {
        original_version: edge.fromVersion,
        version: edge.toVersion,
        archive: edge.archives.map(archive => serializeArchive(baseUrl, archive)),
    }
}

export function serializeCdnUpdatePlan(
    plan: UpdatePlan,
    options: CdnProtocolOptions,
): CnAssetUpdateWire {
    const baseUrl = normalizeCdnBaseUrl(options.baseUrl)
    return {
        info: {
            client_asset_version: options.currentVersion ?? "",
            target_asset_version: options.targetVersion,
            eventual_target_asset_version: options.targetVersion,
            is_initial: plan.kind === "initial",
        },
        full: plan.full === null ? null : serializeFull(baseUrl, plan.full),
        diff: plan.diff === null
            ? null
            : plan.diff.map(edge => serializeDiff(baseUrl, edge)),
        asset_version_hash: "",
        delayed_assets_size: plan.delayedAssetsBytes,
    }
}
