import fs from "node:fs"
import path from "node:path"
import { DEFAULT_SERVER_PORTS } from "./release-contract"
import {
    AssetModeEnvironment,
    AssetProviderConfig,
    parseAssetProviderConfig,
} from "../content/cdn/asset-mode"
import { validateMultiHubToken } from "../multi/hub/token"
import { resolveRuntimeDataPaths } from "./data-paths"
import {
    isUnspecifiedNetworkHost,
    isValidNetworkHost,
    resolveDisplayHost,
} from "./network-host"
import {
    snapshotContentPathEnvironment,
    type ContentPathEnvironment,
} from "../content/paths"
import {
    DEFAULT_MULTI_BATTLE_TUNING,
    DEFAULT_MULTI_TRANSPORT_TUNING,
    type MultiBattleTuning,
    type MultiTransportTuning,
} from "../multi/runtime/tuning"

export interface RuntimeEnvironment extends AssetModeEnvironment {
    readonly SESSION_HOST?: string
    readonly SESSION_PORT?: string
    readonly SESSION_PUBLIC_HOST?: string
    readonly SESSION_HANDSHAKE_TIMEOUT_MS?: string
    readonly SESSION_MAX_FRAME_BYTES?: string
    readonly SESSION_MAX_BUFFER_BYTES?: string
    readonly SESSION_TCP_KEEPALIVE_MS?: string
    readonly MULTI_SEND_QUEUE_MAX_MESSAGES?: string
    readonly MULTI_SEND_QUEUE_MAX_BYTES?: string
    readonly MULTI_SEND_QUEUE_MAX_AGE_MS?: string
    readonly BATTLE_LOADING_LEASE_MS?: string
    readonly BATTLE_HEARTBEAT_LEASE_MS?: string
    readonly IOS_COMPAT_ENABLED?: string
    readonly IOS_API_HOST?: string
    readonly IOS_API_SCHEME?: string
    readonly MULTI_ROOM_INCOMPLETE_EXPIRY_MS?: string
    readonly MULTI_ROOM_FULL_EXPIRY_MS?: string
    readonly MULTI_ROOM_CLEAN_INTERVAL_MS?: string
    readonly MULTI_ROOM_RECONNECT_GRACE_MS?: string
    readonly NPC_JOIN_DELAY_MS?: string
    readonly NPC_READY_DELAY_MS?: string
    readonly MULTI_MODE?: string
    readonly MULTI_HUB_HOST?: string
    readonly MULTI_HUB_PORT?: string
    readonly MULTI_HUB_URL?: string
    readonly MULTI_HUB_TOKEN?: string
    readonly MULTI_HUB_CREDENTIALS_FILE?: string
    readonly SUMMON_COM_SECONDS?: string
    readonly DAILY_RESET_HOUR?: string
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

export interface RuntimeTcpServiceConfig extends RuntimeNetworkServiceConfig {
    readonly publicHost?: string
}

export interface MultiRuntimeTuningConfig {
    readonly transport: MultiTransportTuning
    readonly battle: MultiBattleTuning
    readonly roomCleanup: {
        readonly incompleteExpiryMs: number
        readonly fullExpiryMs: number
        readonly intervalMs: number
        readonly reconnectGraceMs: number
    }
    readonly npcRecruitment: {
        readonly joinDelayMs: number
        readonly readyDelayMs: number
    }
}

export type MultiRuntimeConfig =
    | { readonly mode: "embedded"; readonly tcp: RuntimeTcpServiceConfig }
    | {
        readonly mode: "host"
        readonly tcp: RuntimeTcpServiceConfig
        readonly hub: RuntimeNetworkServiceConfig
        readonly credentialsPath: string
    }
    | {
        readonly mode: "client"
        readonly hubUrl: URL
        readonly token: string
        readonly tcp: RuntimeTcpServiceConfig
    }

export interface CnIosCompatConfig {
    readonly enabled: boolean
    readonly apiHost: string
    readonly apiScheme: "http" | "https"
}

export interface CnRuntimeConfig {
    readonly http: RuntimeNetworkServiceConfig
    readonly httpDisplayHost: string
    readonly iosCompat: CnIosCompatConfig
    readonly multi: MultiRuntimeConfig
    readonly multiTuning: MultiRuntimeTuningConfig
    readonly assetProvider: AssetProviderConfig
    readonly contentEnvironment: Readonly<ContentPathEnvironment>
    readonly comicDir: string | null
    readonly summonComSeconds: number
    readonly dailyResetHour: number
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
    if (!isValidNetworkHost(host)) throw new RuntimeConfigError()
    return host
}

function parseOptionalPublicHost(value: string | undefined): string | undefined {
    if (value === undefined) return undefined
    const host = parseHost(value, "")
    if (isUnspecifiedNetworkHost(host)) throw new RuntimeConfigError()
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

function parseMilliseconds(value: string | undefined, fallback: number): number {
    if (value === undefined) return fallback
    if (!/^\d+$/.test(value)) throw new RuntimeConfigError()
    const milliseconds = Number(value)
    if (!Number.isSafeInteger(milliseconds)) throw new RuntimeConfigError()
    return milliseconds
}

function parsePositiveSafeInteger(
    value: string | undefined,
    fallback: number,
    minimum = 1,
    maximum = Number.MAX_SAFE_INTEGER,
): number {
    if (value === undefined) return fallback
    if (!/^\d+$/.test(value)) throw new RuntimeConfigError()
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
        throw new RuntimeConfigError()
    }
    return parsed
}

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
    if (value === undefined) return fallback
    if (!/^\d+$/.test(value)) throw new RuntimeConfigError()
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) throw new RuntimeConfigError()
    return parsed
}

function parseDailyResetHour(value: string | undefined): number {
    const hour = parseNonNegativeInteger(value, 5)
    if (hour > 23) throw new RuntimeConfigError()
    return hour
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
    return isSameOrDescendant(left, right) || isSameOrDescendant(right, left)
}

function isSameOrDescendant(parent: string, candidate: string): boolean {
    const relative = path.relative(parent, candidate)
    return relative === ""
        || (!path.isAbsolute(relative)
            && relative !== ".."
            && !relative.startsWith(`..${path.sep}`))
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

export function resolveMultiHubCredentialsPath(
    env: RuntimeEnvironment,
    projectRoot: string,
): string {
    const dataDir = resolvePhysicalPath(resolveRuntimeDataPaths(env, projectRoot).dataDir)
    const configured = env.MULTI_HUB_CREDENTIALS_FILE
    if (configured !== undefined && !path.isAbsolute(configured)) throw new RuntimeConfigError()
    const credentialsPath = configured === undefined
        ? path.join(dataDir, "multi-hub-credentials.json")
        : resolvePhysicalPath(configured)
    const physicalProjectRoot = resolvePhysicalPath(projectRoot)
    const privateProjectDataDir = path.join(physicalProjectRoot, ".database")
    if (isSameOrDescendant(physicalProjectRoot, credentialsPath)
        && !isSameOrDescendant(privateProjectDataDir, credentialsPath)) {
        throw new RuntimeConfigError()
    }
    return credentialsPath
}

function parseHubUrl(value: string | undefined): URL {
    if (value === undefined || value.length === 0 || value !== value.trim()) {
        throw new RuntimeConfigError()
    }
    let hubUrl: URL
    try {
        hubUrl = new URL(value)
    } catch {
        throw new RuntimeConfigError()
    }
    if ((hubUrl.protocol !== "http:" && hubUrl.protocol !== "https:")
        || hubUrl.username !== ""
        || hubUrl.password !== ""
        || hubUrl.search !== ""
        || hubUrl.hash !== ""
        || hubUrl.pathname !== "/") {
        throw new RuntimeConfigError()
    }
    return hubUrl
}

function parseMultiRuntimeConfig(
    env: RuntimeEnvironment,
    projectRoot: string,
): MultiRuntimeConfig {
    const mode = env.MULTI_MODE ?? "embedded"
    if (mode === "embedded") {
        const host = parseHost(env.SESSION_HOST, "127.0.0.1")
        const configuredPublicHost = parseOptionalPublicHost(
            env.SESSION_PUBLIC_HOST ?? env.CN_PUBLIC_HOST,
        )
        const publicHost = configuredPublicHost ?? (isUnspecifiedNetworkHost(host)
            ? resolveDisplayHost({ listenHost: host })
            : undefined)
        return Object.freeze({
            mode,
            tcp: Object.freeze({
                host,
                port: parsePort(env.SESSION_PORT, DEFAULT_SERVER_PORTS.tcp),
                ...(publicHost === undefined ? {} : { publicHost }),
            }),
        })
    }
    if (mode === "host") {
        if (env.MULTI_HUB_HOST === undefined
            || env.MULTI_HUB_PORT === undefined
            || env.SESSION_PUBLIC_HOST === undefined) {
            throw new RuntimeConfigError()
        }
        const publicHost = parseOptionalPublicHost(env.SESSION_PUBLIC_HOST)
        if (publicHost === undefined) throw new RuntimeConfigError()
        return Object.freeze({
            mode,
            tcp: Object.freeze({
                host: parseHost(env.SESSION_HOST, "127.0.0.1"),
                port: parsePort(env.SESSION_PORT, DEFAULT_SERVER_PORTS.tcp),
                publicHost,
            }),
            hub: Object.freeze({
                host: parseHost(env.MULTI_HUB_HOST, ""),
                port: parsePort(env.MULTI_HUB_PORT, DEFAULT_SERVER_PORTS.hub),
            }),
            credentialsPath: resolveMultiHubCredentialsPath(env, projectRoot),
        })
    }
    if (mode === "client") {
        if (!validateMultiHubToken(env.MULTI_HUB_TOKEN)) throw new RuntimeConfigError()
        const host = parseHost(env.SESSION_HOST, "127.0.0.1")
        const publicHost = parseOptionalPublicHost(env.SESSION_PUBLIC_HOST)
        if (isUnspecifiedNetworkHost(host) && publicHost === undefined) {
            throw new RuntimeConfigError()
        }
        return Object.freeze({
            mode,
            hubUrl: parseHubUrl(env.MULTI_HUB_URL),
            token: env.MULTI_HUB_TOKEN,
            tcp: Object.freeze({
                host,
                port: parsePort(env.SESSION_PORT, DEFAULT_SERVER_PORTS.tcp),
                ...(publicHost === undefined ? {} : { publicHost }),
            }),
        })
    }
    throw new RuntimeConfigError()
}

function parseMultiRuntimeTuning(env: RuntimeEnvironment): MultiRuntimeTuningConfig {
    const maximumTimerMs = 2_147_483_647
    const maxFrameBytes = parsePositiveSafeInteger(
        env.SESSION_MAX_FRAME_BYTES,
        DEFAULT_MULTI_TRANSPORT_TUNING.maxFrameBytes,
        1024,
    )
    const maxBufferBytes = parsePositiveSafeInteger(
        env.SESSION_MAX_BUFFER_BYTES,
        DEFAULT_MULTI_TRANSPORT_TUNING.maxBufferBytes,
    )
    if (maxBufferBytes < maxFrameBytes) throw new RuntimeConfigError()

    return Object.freeze({
        transport: Object.freeze({
            handshakeTimeoutMs: parsePositiveSafeInteger(
                env.SESSION_HANDSHAKE_TIMEOUT_MS,
                DEFAULT_MULTI_TRANSPORT_TUNING.handshakeTimeoutMs,
                1,
                maximumTimerMs,
            ),
            maxFrameBytes,
            maxBufferBytes,
            keepAliveInitialDelayMs: parsePositiveSafeInteger(
                env.SESSION_TCP_KEEPALIVE_MS,
                DEFAULT_MULTI_TRANSPORT_TUNING.keepAliveInitialDelayMs,
            ),
            sendQueueMaxMessages: parsePositiveSafeInteger(
                env.MULTI_SEND_QUEUE_MAX_MESSAGES,
                DEFAULT_MULTI_TRANSPORT_TUNING.sendQueueMaxMessages,
            ),
            sendQueueMaxBytes: parsePositiveSafeInteger(
                env.MULTI_SEND_QUEUE_MAX_BYTES,
                DEFAULT_MULTI_TRANSPORT_TUNING.sendQueueMaxBytes,
                1024,
            ),
            sendQueueMaxAgeMs: parsePositiveSafeInteger(
                env.MULTI_SEND_QUEUE_MAX_AGE_MS,
                DEFAULT_MULTI_TRANSPORT_TUNING.sendQueueMaxAgeMs,
                1,
                maximumTimerMs,
            ),
        }),
        battle: Object.freeze({
            loadingLeaseMs: parsePositiveSafeInteger(
                env.BATTLE_LOADING_LEASE_MS,
                DEFAULT_MULTI_BATTLE_TUNING.loadingLeaseMs,
                1,
                maximumTimerMs,
            ),
            heartbeatLeaseMs: parsePositiveSafeInteger(
                env.BATTLE_HEARTBEAT_LEASE_MS,
                DEFAULT_MULTI_BATTLE_TUNING.heartbeatLeaseMs,
                1,
                maximumTimerMs,
            ),
        }),
        roomCleanup: Object.freeze({
            incompleteExpiryMs: parseMilliseconds(env.MULTI_ROOM_INCOMPLETE_EXPIRY_MS, 900_000),
            fullExpiryMs: parseMilliseconds(env.MULTI_ROOM_FULL_EXPIRY_MS, 1_800_000),
            intervalMs: parseMilliseconds(env.MULTI_ROOM_CLEAN_INTERVAL_MS, 60_000),
            reconnectGraceMs: parseMilliseconds(env.MULTI_ROOM_RECONNECT_GRACE_MS, 25_000),
        }),
        npcRecruitment: Object.freeze({
            joinDelayMs: parseMilliseconds(env.NPC_JOIN_DELAY_MS, 2_000),
            readyDelayMs: parseMilliseconds(env.NPC_READY_DELAY_MS, 500),
        }),
    })
}

/**
 * iOS 兼容适配开关。
 * - IOS_COMPAT_ENABLED=1 且 IOS_API_HOST 为合法、可达（非 0.0.0.0/::）地址时启用；
 * - IOS_API_HOST 接受 "host" 或 "host:port"（host 为 IP 或域名，port 1-65535）；
 * - 缺失或非法配置只让 iOS 适配明确不可用（降级关闭），绝不影响 Android 服务启动，
 *   也绝不从 CN_LISTEN_HOST 拼出 0.0.0.0:port 之类的不可达默认值。
 */
function normalizeIosApiHost(value: string): string | null {
    const colon = value.lastIndexOf(":")
    let host = colon === -1 ? value : value.slice(0, colon)
    if (host.startsWith("[") && host.endsWith("]")) {
        // IPv6 字面量带括号（如 [2001:db8::5]:8001）
        host = host.slice(1, -1)
    }
    if (!isValidNetworkHost(host) || isUnspecifiedNetworkHost(host)) return null
    if (colon !== -1) {
        const portText = value.slice(colon + 1)
        if (!/^\d+$/.test(portText)) return null
        const port = Number(portText)
        if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return null
    }
    return value
}

function parseIosCompatConfig(env: RuntimeEnvironment): CnIosCompatConfig {
    if (env.IOS_COMPAT_ENABLED !== "1") {
        return Object.freeze({ enabled: false, apiHost: "", apiScheme: "http" })
    }
    const apiHost = normalizeIosApiHost((env.IOS_API_HOST ?? "").trim())
    if (apiHost === null) {
        console.warn("[runtime] IOS_COMPAT_ENABLED=1 requires a reachable IOS_API_HOST (host[:port]); iOS compatibility disabled")
        return Object.freeze({ enabled: false, apiHost: "", apiScheme: "http" })
    }
    const apiScheme = env.IOS_API_SCHEME === "https" ? "https" : "http"
    return Object.freeze({ enabled: true, apiHost, apiScheme })
}

export function parseCnRuntimeConfig({
    projectRoot,
    env = process.env,
}: ParseCnRuntimeConfigOptions): CnRuntimeConfig {
    const http = Object.freeze({
        host: parseHost(env.CN_LISTEN_HOST, "127.0.0.1"),
        port: parsePort(env.CN_LISTEN_PORT, DEFAULT_SERVER_PORTS.http),
    })
    const httpDisplayHost = resolveDisplayHost({
        listenHost: http.host,
        publicHost: parseOptionalPublicHost(env.SESSION_PUBLIC_HOST ?? env.CN_PUBLIC_HOST),
    })
    const multi = parseMultiRuntimeConfig(env, projectRoot)
    const multiTuning = parseMultiRuntimeTuning(env)
    const assetProvider = parseAssetProviderConfig({ projectRoot, env })
    const contentEnvironment = snapshotContentPathEnvironment(env)
    const comicDir = resolveComicDir(env, projectRoot)
    const summonComSeconds = parseNonNegativeInteger(env.SUMMON_COM_SECONDS, 5)
    const dailyResetHour = parseDailyResetHour(env.DAILY_RESET_HOUR)
    validateEmbeddedRuntime(env, projectRoot, assetProvider, comicDir)
    return Object.freeze({
        http,
        httpDisplayHost,
        iosCompat: parseIosCompatConfig(env),
        multi,
        multiTuning,
        assetProvider,
        contentEnvironment,
        comicDir,
        summonComSeconds,
        dailyResetHour,
    })
}
