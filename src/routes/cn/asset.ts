import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import path from "node:path"
import {
    CdnPlannerError,
    planCdnUpdate,
    type CdnPlannerErrorCode,
} from "../../content/cdn/planner"
import {
    isValidAssetVersion,
    parseAssetProviderConfig,
    type AssetModeEnvironment,
    type AssetProviderConfig,
} from "../../content/cdn/asset-mode"
import { normalizeCdnBaseUrl, serializeCdnUpdatePlan } from "../../content/cdn/protocol"
import type { ContentSnapshot } from "../../content/runtime/content-snapshot"
import { getContentSnapshot } from "../../content/runtime/content-snapshot"
import { generateDataHeaders } from "../../utils"

type AssetRouteEnvironment = AssetModeEnvironment

export type AssetTargetSummary =
    | { readonly type: "string"; readonly length: number; readonly value?: string; readonly truncated: boolean }
    | { readonly type: "array"; readonly length: number }
    | { readonly type: "object"; readonly keyCount: number }
    | { readonly type: "null" }
    | { readonly type: "boolean" | "number" | "undefined" }

export interface AssetTargetMismatchWarning {
    readonly clientTarget: AssetTargetSummary
    readonly snapshotTargetVersion: string
}

export type AssetRouteErrorCode = "CONTENT_SNAPSHOT_UNAVAILABLE" | "ASSET_SERVICE_ERROR"
export type AssetRouteLogCode = AssetRouteErrorCode | CdnPlannerErrorCode

export interface AssetRouteErrorDetails {
    readonly code: AssetRouteLogCode
    readonly error: unknown
    readonly route: string
}

export type AssetRouteErrorLogger = (details: AssetRouteErrorDetails) => void

export interface CnAssetRouteOptions {
    readonly getSnapshot?: () => ContentSnapshot
    readonly provider?: AssetProviderConfig
    readonly env?: AssetRouteEnvironment
    readonly warn?: (details: AssetTargetMismatchWarning) => void
    readonly logError?: AssetRouteErrorLogger
    readonly resolveListenHost?: (listenHost: string) => string
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
    const value = request.headers[name]
    return typeof value === "string" ? value : undefined
}

export function getCdnBase(
    env: AssetRouteEnvironment = process.env,
    resolveListenHost?: (listenHost: string) => string,
): string {
    const provider = parseAssetProviderConfig({
        projectRoot: path.resolve(__dirname, "../../.."),
        env,
        resolveListenHost,
    })
    if (provider.mode === "client-owned") {
        throw new Error("client-owned asset mode does not expose a CDN base URL")
    }
    return provider.baseUrl
}

function summarizeClientTarget(value: unknown): AssetTargetSummary {
    if (typeof value === "string") {
        const summary: AssetTargetSummary = {
            type: "string",
            length: value.length,
            truncated: value.length > 64,
        }
        return /^\d+(?:\.\d+){1,3}$/.test(value) && value.length <= 64
            ? { ...summary, value }
            : summary
    }
    if (Array.isArray(value)) return { type: "array", length: value.length }
    if (value === null) return { type: "null" }
    if (typeof value === "object") return { type: "object", keyCount: Object.keys(value).length }
    if (typeof value === "boolean") return { type: "boolean" }
    if (typeof value === "number") return { type: "number" }
    if (typeof value === "undefined") return { type: "undefined" }
    return { type: "undefined" }
}

export function getCdnVersionInfo(
    baseUrl: string,
    snapshot: ContentSnapshot = getContentSnapshot(),
) {
    const normalizedBaseUrl = normalizeCdnBaseUrl(baseUrl)
    return {
        base_url: `${normalizedBaseUrl}/`,
        files_list: `${normalizedBaseUrl}/recovery/empty.csv`,
        total_size: snapshot.cdn.installedBytes,
        delayed_assets_size: 0,
    }
}

const PLANNER_CLIENT_MESSAGES: Readonly<Partial<Record<CdnPlannerErrorCode, string>>> = {
    UNKNOWN_CURRENT_VERSION: "unknown current asset version",
    UNSUPPORTED_PLATFORM: "unsupported asset platform",
    UNSUPPORTED_ASSET_SIZE_KIND: "unsupported asset size kind",
}

function plannerStatus(code: CdnPlannerErrorCode): number {
    return PLANNER_CLIENT_MESSAGES[code] === undefined ? 500 : 400
}

const ERROR_MESSAGES: Readonly<Record<AssetRouteErrorCode, string>> = {
    CONTENT_SNAPSHOT_UNAVAILABLE: "content snapshot is unavailable",
    ASSET_SERVICE_ERROR: "asset service is unavailable",
}

export function sendAssetRouteError(
    request: FastifyRequest,
    reply: FastifyReply,
    code: AssetRouteErrorCode,
    error: unknown,
    logError: AssetRouteErrorLogger | undefined,
    contentType = "application/json",
) {
    const details = { code, error, route: request.routeOptions.url ?? request.url }
    if (logError) logError(details)
    else request.log.error({ err: error, code, route: details.route }, "CN asset route failed")
    return reply.status(500).type(contentType).send({ code, message: ERROR_MESSAGES[code] })
}

function sendPlannerError(
    request: FastifyRequest,
    reply: FastifyReply,
    error: CdnPlannerError,
    logError: AssetRouteErrorLogger | undefined,
) {
    const status = plannerStatus(error.code)
    if (status === 400) {
        return reply.status(status).type("application/json").send({
            code: error.code,
            message: PLANNER_CLIENT_MESSAGES[error.code],
        })
    }

    const details = {
        code: error.code,
        error,
        route: request.routeOptions.url ?? request.url,
    }
    if (logError) logError(details)
    else request.log.error(
        { err: error, code: error.code, route: details.route },
        "CN asset planner failed",
    )
    return reply.status(status).type("application/json").send({
        code: error.code,
        message: "asset update plan is unavailable",
    })
}

const routes = async (fastify: FastifyInstance, options: CnAssetRouteOptions) => {
    const snapshot = options.getSnapshot ?? getContentSnapshot
    const env = options.env ?? process.env
    const getProvider = (): AssetProviderConfig => options.provider ?? parseAssetProviderConfig({
        projectRoot: path.resolve(__dirname, "../../.."),
        env,
        resolveListenHost: options.resolveListenHost,
    })

    fastify.post("/version_info", async (request, reply) => {
        let provider: AssetProviderConfig
        try {
            provider = getProvider()
        } catch (error) {
            return sendAssetRouteError(request, reply, "ASSET_SERVICE_ERROR", error, options.logError)
        }
        if (provider.mode === "client-owned") {
            return reply.type("application/json").send({
                data_headers: generateDataHeaders({ asset_update: false }),
                data: {
                    base_url: "",
                    files_list: "",
                    total_size: 0,
                    delayed_assets_size: 0,
                },
            })
        }

        let contentSnapshot: ContentSnapshot
        try {
            contentSnapshot = snapshot()
        } catch (error) {
            return sendAssetRouteError(
                request,
                reply,
                "CONTENT_SNAPSHOT_UNAVAILABLE",
                error,
                options.logError,
            )
        }

        try {
            return reply.type("application/json").send({
                data_headers: generateDataHeaders(),
                data: getCdnVersionInfo(provider.baseUrl, contentSnapshot),
            })
        } catch (error) {
            return sendAssetRouteError(request, reply, "ASSET_SERVICE_ERROR", error, options.logError)
        }
    })

    fastify.post("/get_path", async (request, reply) => {
        const device = headerValue(request, "device")?.toLowerCase()
        if (device !== undefined && device !== "2" && device !== "android") {
            return reply.status(400).type("application/json").send({
                code: "UNSUPPORTED_PLATFORM",
                message: `unsupported DEVICE header: ${device}`,
            })
        }

        const assetSize = headerValue(request, "asset_size")?.toLowerCase() ?? "fulfill"
        if (assetSize !== "fulfill" && assetSize !== "shortened" && assetSize !== "delayed") {
            return reply.status(400).type("application/json").send({
                code: "UNSUPPORTED_ASSET_SIZE_KIND",
                message: `unsupported ASSET_SIZE header: ${assetSize}`,
            })
        }

        let provider: AssetProviderConfig
        try {
            provider = getProvider()
        } catch (error) {
            return sendAssetRouteError(request, reply, "ASSET_SERVICE_ERROR", error, options.logError)
        }

        const currentVersion = headerValue(request, "res_ver")
        if (provider.mode === "client-owned") {
            if (!isValidAssetVersion(currentVersion)) {
                return reply.status(400).type("application/json").send({
                    code: "INVALID_RES_VERSION",
                    message: "a valid RES_VER header is required in client-owned asset mode",
                })
            }
            return reply.status(200).type("application/json").send({
                data_headers: generateDataHeaders({ asset_update: false }),
                data: {
                    info: {
                        client_asset_version: currentVersion,
                        target_asset_version: currentVersion,
                        eventual_target_asset_version: currentVersion,
                        is_initial: false,
                    },
                    full: null,
                    diff: null,
                    asset_version_hash: "",
                    delayed_assets_size: 0,
                },
            })
        }

        let contentSnapshot: ContentSnapshot
        try {
            contentSnapshot = snapshot()
        } catch (error) {
            return sendAssetRouteError(
                request,
                reply,
                "CONTENT_SNAPSHOT_UNAVAILABLE",
                error,
                options.logError,
            )
        }

        const plannerCurrentVersion = currentVersion ?? null
        try {
            const body = request.body as { target_asset_version?: unknown } | null | undefined
            const clientTarget = body?.target_asset_version
            if (clientTarget !== undefined && clientTarget !== contentSnapshot.cdn.targetVersion) {
                const warning = {
                    clientTarget: summarizeClientTarget(clientTarget),
                    snapshotTargetVersion: contentSnapshot.cdn.targetVersion,
                }
                if (options.warn) options.warn(warning)
                else request.log.warn(warning, "ignoring client asset target that differs from pinned snapshot")
            }

            const plan = planCdnUpdate(contentSnapshot.cdn, {
                currentVersion: plannerCurrentVersion,
                targetVersion: contentSnapshot.cdn.targetVersion,
                platform: "android",
                assetSizeKind: "fulfill",
                isInitial: plannerCurrentVersion === null,
            })
            const data = serializeCdnUpdatePlan(plan, {
                baseUrl: provider.baseUrl,
                currentVersion: plannerCurrentVersion,
                targetVersion: contentSnapshot.cdn.targetVersion,
            })
            return reply.status(200).type("application/json").send({
                data_headers: generateDataHeaders({ asset_update: true }),
                data,
            })
        } catch (error) {
            if (error instanceof CdnPlannerError) {
                return sendPlannerError(request, reply, error, options.logError)
            }
            return sendAssetRouteError(request, reply, "ASSET_SERVICE_ERROR", error, options.logError)
        }
    })
}

export default routes
