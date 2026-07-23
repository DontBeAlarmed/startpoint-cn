import { isIP } from "node:net"
import os from "node:os"

import { resolveCnCdnRoot } from "../paths"
import { resolveRuntimeDataPaths } from "../../runtime/data-paths"
import { normalizeCdnBaseUrl } from "./protocol"

export type AssetMode = "client-owned" | "local" | "remote"

export type AssetProviderConfig =
    | Readonly<{ readonly mode: "client-owned" }>
    | Readonly<{
        readonly mode: "local"
        readonly baseUrl: string
        readonly cdnRoot: string
        readonly patchUploadRoot: string
    }>
    | Readonly<{
        readonly mode: "remote"
        readonly baseUrl: string
    }>

export interface AssetModeEnvironment {
    readonly [name: string]: string | undefined
    readonly ASSET_MODE?: string
    readonly CDN_BASE_URL?: string
    readonly CDN_DIR?: string
    readonly DATA_DIR?: string
    readonly WDFP_DATABASE_DIR?: string
    readonly CN_LISTEN_HOST?: string
    readonly CN_LISTEN_PORT?: string
    readonly CN_PUBLIC_HOST?: string
}

export interface ParseAssetProviderConfigOptions {
    readonly projectRoot: string
    readonly env?: AssetModeEnvironment
    readonly resolveListenHost?: (listenHost: string) => string
}

export interface AssetLoadState {
    readonly assetUpdate: boolean
    readonly availableAssetVersion: string
}

export class AssetModeConfigError extends Error {
    readonly code: "INVALID_ASSET_MODE" | "MISSING_CDN_BASE_URL"

    constructor(
        code: "INVALID_ASSET_MODE" | "MISSING_CDN_BASE_URL",
        message: string,
    ) {
        super(message)
        this.name = "AssetModeConfigError"
        this.code = code
    }
}

function parseMode(value: string | undefined): AssetMode {
    if (value === undefined) return "local"
    if (value === "client-owned" || value === "local" || value === "remote") return value
    throw new AssetModeConfigError("INVALID_ASSET_MODE", "invalid ASSET_MODE configuration")
}

export function isValidAssetVersion(value: string | undefined): value is string {
    return typeof value === "string"
        && value.length <= 64
        && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value)
}

export function resolveAssetLoadState(
    config: AssetProviderConfig,
    clientVersion: string | undefined,
    snapshotTargetVersion: string,
): AssetLoadState {
    return config.mode === "client-owned"
        ? Object.freeze({
            assetUpdate: false,
            availableAssetVersion: isValidAssetVersion(clientVersion) ? clientVersion : "",
        })
        : Object.freeze({
            assetUpdate: true,
            availableAssetVersion: snapshotTargetVersion,
        })
}

function isUnspecifiedIpHost(hostname: string): boolean {
    const unwrapped = hostname.startsWith("[") && hostname.endsWith("]")
        ? hostname.slice(1, -1)
        : hostname
    return unwrapped === "0.0.0.0"
        || (isIP(unwrapped) === 6 && /^[0:]+$/.test(unwrapped))
}

function formatTrustedHost(value: string): string {
    if (!value
        || value !== value.trim()
        || /[\x00-\x20\x7f]/.test(value)
        || /[\\/@?#]/.test(value)) {
        throw new Error("configured CDN host is invalid")
    }
    if (isUnspecifiedIpHost(value) || /^\d+$/.test(value)) {
        throw new Error("configured CDN host is invalid")
    }
    if (value.startsWith("[") || value.endsWith("]")) {
        if (!value.startsWith("[") || !value.endsWith("]") || isIP(value.slice(1, -1)) !== 6) {
            throw new Error("configured CDN host is invalid")
        }
        return value
    }
    if (isIP(value) === 6) return `[${value}]`
    if (isIP(value) === 4) return value
    if (/^[0-9.]+$/.test(value)) throw new Error("configured CDN host is invalid")
    if (value.length > 253 || !/^[A-Za-z0-9.-]+$/.test(value)) {
        throw new Error("configured CDN host is invalid")
    }
    const labels = value.split(".")
    if (labels.some(label => (
        !label
        || label.length > 63
        || label.startsWith("-")
        || label.endsWith("-")
    ))) {
        throw new Error("configured CDN host is invalid")
    }
    return value
}

function resolveCdnListenHost(listenHost: string): string {
    const addresses = Object.values(os.networkInterfaces()).flatMap(items => items ?? [])
    const preferredFamily = listenHost === "::" ? "IPv6" : "IPv4"
    const preferred = addresses.find(address => !address.internal && address.family === preferredFamily)
    const fallback = addresses.find(address => !address.internal)
    return preferred?.address ?? fallback?.address ?? (listenHost === "::" ? "::1" : "127.0.0.1")
}

function requireTrustedPort(value: string): number {
    if (!/^[1-9]\d{0,4}$/.test(value)) throw new Error("configured CDN port is invalid")
    const port = Number(value)
    if (port > 65535) throw new Error("configured CDN port is invalid")
    return port
}

function resolveLocalBaseUrl(
    env: AssetModeEnvironment,
    resolveListenHost: (listenHost: string) => string,
): string {
    if (env.CDN_BASE_URL !== undefined) return normalizeCdnBaseUrl(env.CDN_BASE_URL)
    const listenHost = env.CN_LISTEN_HOST ?? "127.0.0.1"
    const selectedHost = env.CN_PUBLIC_HOST !== undefined
        ? env.CN_PUBLIC_HOST
        : listenHost === "0.0.0.0" || listenHost === "::"
            ? resolveListenHost(listenHost)
            : listenHost
    const host = formatTrustedHost(selectedHost)
    const port = requireTrustedPort(env.CN_LISTEN_PORT ?? "8001")
    return normalizeCdnBaseUrl(`http://${host}:${port}/patch/cn`)
}

export function parseAssetProviderConfig({
    projectRoot,
    env = process.env,
    resolveListenHost = resolveCdnListenHost,
}: ParseAssetProviderConfigOptions): AssetProviderConfig {
    const mode = parseMode(env.ASSET_MODE)
    if (mode === "client-owned") return Object.freeze({ mode })

    if (mode === "remote") {
        if (env.CDN_BASE_URL === undefined) {
            throw new AssetModeConfigError(
                "MISSING_CDN_BASE_URL",
                "CDN_BASE_URL is required when ASSET_MODE=remote",
            )
        }
        return Object.freeze({ mode, baseUrl: normalizeCdnBaseUrl(env.CDN_BASE_URL) })
    }

    return Object.freeze({
        mode,
        baseUrl: resolveLocalBaseUrl(env, resolveListenHost),
        cdnRoot: resolveCnCdnRoot(env.CDN_DIR ?? ".cdn", projectRoot),
        patchUploadRoot: resolveRuntimeDataPaths(env, projectRoot).assetPatchUploadDir,
    })
}
