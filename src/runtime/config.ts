import {
    AssetModeEnvironment,
    AssetProviderConfig,
    parseAssetProviderConfig,
} from "../content/cdn/asset-mode"
import { isIP } from "node:net"

export interface RuntimeEnvironment extends AssetModeEnvironment {
    readonly SESSION_HOST?: string
    readonly SESSION_PORT?: string
}

export interface RuntimeNetworkServiceConfig {
    readonly host: string
    readonly port: number
}

export interface CnRuntimeConfig {
    readonly http: RuntimeNetworkServiceConfig
    readonly tcp: RuntimeNetworkServiceConfig
    readonly assetProvider: AssetProviderConfig
}

export interface ParseCnRuntimeConfigOptions {
    readonly projectRoot: string
    readonly env?: RuntimeEnvironment
}

export class RuntimeConfigError extends Error {
    readonly code = "INVALID_RUNTIME_CONFIG"

    constructor() {
        super("invalid runtime network configuration")
        this.name = "RuntimeConfigError"
    }
}

function parseHost(value: string | undefined, fallback: string): string {
    const host = value ?? fallback
    if (host.length === 0 || host !== host.trim() || /\s|[\x00-\x1f\x7f]/.test(host)) {
        throw new RuntimeConfigError()
    }
    if (isIP(host) !== 0) return host
    if (host.length > 253 || /^[0-9.]+$/.test(host) || !/^[A-Za-z0-9.-]+$/.test(host)) {
        throw new RuntimeConfigError()
    }
    const labels = host.split(".")
    if (labels.some(label => (
        label.length === 0
        || label.length > 63
        || label.startsWith("-")
        || label.endsWith("-")
    ))) throw new RuntimeConfigError()
    return host
}

function parsePort(value: string | undefined, fallback: number): number {
    if (value === undefined) return fallback
    if (!/^\d+$/.test(value)) throw new RuntimeConfigError()
    const port = Number(value)
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
        throw new RuntimeConfigError()
    }
    return port
}

export function parseCnRuntimeConfig({
    projectRoot,
    env = process.env,
}: ParseCnRuntimeConfigOptions): CnRuntimeConfig {
    const http = Object.freeze({
        host: parseHost(env.CN_LISTEN_HOST, "127.0.0.1"),
        port: parsePort(env.CN_LISTEN_PORT, 8001),
    })
    const tcp = Object.freeze({
        host: parseHost(env.SESSION_HOST, "127.0.0.1"),
        port: parsePort(env.SESSION_PORT, 8003),
    })
    const assetProvider = parseAssetProviderConfig({ projectRoot, env })
    return Object.freeze({ http, tcp, assetProvider })
}
