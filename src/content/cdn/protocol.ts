import { isIP } from "node:net"
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

const INVALID_CDN_BASE_URL_MESSAGE = "invalid CDN base URL configuration"

function invalidCdnBaseUrl(): Error {
    const error = new Error(INVALID_CDN_BASE_URL_MESSAGE)
    error.name = "CdnConfigurationError"
    return error
}

export function normalizeCdnBaseUrl(baseUrl: string): string {
    const value = baseUrl
    if (!value
        || value.length > 2048
        || /\s/u.test(value)
        || value.includes("@")
        || value.includes("\\")
        || /[?#]/.test(value)
        || !/^https?:\/\//.test(value)) {
        throw invalidCdnBaseUrl()
    }

    const authorityStart = value.indexOf("://") + 3
    const pathStart = value.indexOf("/", authorityStart)
    const authority = value.slice(authorityStart, pathStart === -1 ? value.length : pathStart)
    const rawHost = authority.startsWith("[")
        ? authority.slice(0, authority.indexOf("]") + 1)
        : authority.split(":", 1)[0]
    if (!authority
        || !rawHost
        || (/^[0-9.]+$/.test(rawHost) && isIP(rawHost) !== 4)) {
        throw invalidCdnBaseUrl()
    }

    const rawPath = pathStart === -1 ? "" : value.slice(pathStart)
    if ((rawPath !== "" && !/^\/[A-Za-z0-9._~/-]*$/.test(rawPath))
        || rawPath.includes("%")
        || /\/{2,}/.test(rawPath)
        || /(?:^|\/)\.{1,2}(?:\/|$)/.test(rawPath)) {
        throw invalidCdnBaseUrl()
    }

    let parsed: URL
    try {
        parsed = new URL(value)
    } catch {
        throw invalidCdnBaseUrl()
    }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
        || parsed.username
        || parsed.password) {
        throw invalidCdnBaseUrl()
    }
    const pathname = parsed.pathname.replace(/\/+$/, "")
    return `${parsed.origin}${pathname}`
}

function requireSafeRelativePath(relativePath: string): string {
    if (!relativePath
        || !/^[\x21-\x7e]+$/.test(relativePath)
        || relativePath.includes("\\")
        || relativePath.startsWith("/")
        || relativePath.includes("//")
        || /[?#%]/.test(relativePath)
        || /^[A-Za-z][A-Za-z\d+.-]*:/.test(relativePath)) {
        throw new Error(`unsafe CDN archive path: ${relativePath}`)
    }
    const segments = relativePath.split("/")
    if (segments.some(segment => (
        segment === ""
        || segment === "."
        || segment === ".."
        || !/^[A-Za-z0-9._~-]+$/.test(segment)
    ))) {
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
