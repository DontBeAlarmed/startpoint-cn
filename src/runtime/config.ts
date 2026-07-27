import {
    AssetModeEnvironment,
    AssetProviderConfig,
    parseAssetProviderConfig,
} from "../content/cdn/asset-mode"
import fs from "node:fs"
import { isIP } from "node:net"
import path from "node:path"

export interface RuntimeEnvironment extends AssetModeEnvironment {
    readonly SESSION_HOST?: string
    readonly SESSION_PORT?: string
    readonly EMBEDDED_RUNTIME?: string
    readonly DATA_DIR?: string
    readonly COMIC_DIR?: string
    readonly WDFP_DATABASE_DIR?: string
    readonly CONTENT_DIR?: string
    readonly CONTENT_STORE_DIR?: string
    readonly CONTENT_STATE_DIR?: string
    readonly CONTENT_RUNTIME_DIR?: string
}

export interface RuntimeNetworkServiceConfig {
    readonly host: string
    readonly port: number
}

export interface CnRuntimeConfig {
    readonly http: RuntimeNetworkServiceConfig
    readonly tcp: RuntimeNetworkServiceConfig
    readonly assetProvider: AssetProviderConfig
    readonly comicDir: string | null
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

function resolvePhysicalPath(filePath: string): string {
    const missing: string[] = []
    let existing = path.resolve(filePath)
    while (true) {
        try {
            return path.resolve(fs.realpathSync(existing), ...missing)
        } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw new RuntimeConfigError()
            const parent = path.dirname(existing)
            if (parent === existing) throw new RuntimeConfigError()
            missing.unshift(path.basename(existing))
            existing = parent
        }
    }
}

function pathsOverlap(left: string, right: string): boolean {
    const isSameOrDescendant = (parent: string, candidate: string): boolean => {
        const relative = path.relative(parent, candidate)
        return relative === ""
            || (!path.isAbsolute(relative)
                && relative !== ".."
                && !relative.startsWith(`..${path.sep}`))
    }
    return isSameOrDescendant(left, right) || isSameOrDescendant(right, left)
}

function validateEmbeddedRuntime(
    env: RuntimeEnvironment,
    projectRoot: string,
    assetProvider: AssetProviderConfig,
    comicDir: string | null,
): void {
    if (env.EMBEDDED_RUNTIME !== undefined
        && env.EMBEDDED_RUNTIME !== "0"
        && env.EMBEDDED_RUNTIME !== "1") throw new RuntimeConfigError()
    if (env.EMBEDDED_RUNTIME !== "1") return
    if (env.DATA_DIR === undefined || !path.isAbsolute(env.DATA_DIR)) {
        throw new RuntimeConfigError()
    }
    if ([
        env.WDFP_DATABASE_DIR,
        env.CONTENT_DIR,
        env.CONTENT_STORE_DIR,
        env.CONTENT_STATE_DIR,
        env.CONTENT_RUNTIME_DIR,
    ].some(value => value !== undefined)) throw new RuntimeConfigError()

    const dataDir = resolvePhysicalPath(env.DATA_DIR)
    const protectedRoots = [resolvePhysicalPath(projectRoot)]
    if (assetProvider.mode === "local") {
        protectedRoots.push(resolvePhysicalPath(assetProvider.cdnRoot))
    }
    if (protectedRoots.some(protectedRoot => pathsOverlap(dataDir, protectedRoot))) {
        throw new RuntimeConfigError()
    }
    if (comicDir !== null) {
        const resolvedComicDir = resolvePhysicalPath(comicDir)
        if (protectedRoots.some(protectedRoot => pathsOverlap(resolvedComicDir, protectedRoot))
            || pathsOverlap(resolvedComicDir, dataDir)) {
            throw new RuntimeConfigError()
        }
    }
}

function resolveComicDir(env: RuntimeEnvironment, projectRoot: string): string | null {
    if (env.COMIC_DIR !== undefined) {
        if (!path.isAbsolute(env.COMIC_DIR)) throw new RuntimeConfigError()
        return resolvePhysicalPath(env.COMIC_DIR)
    }
    return env.EMBEDDED_RUNTIME === "1"
        ? null
        : path.join(projectRoot, "web", "public", "comic")
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
    const comicDir = resolveComicDir(env, projectRoot)
    validateEmbeddedRuntime(env, projectRoot, assetProvider, comicDir)
    return Object.freeze({ http, tcp, assetProvider, comicDir })
}
