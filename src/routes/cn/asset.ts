import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import {
    CdnPlannerError,
    planCdnUpdate,
    type CdnPlannerErrorCode,
} from "../../content/cdn/planner"
import { normalizeCdnBaseUrl, serializeCdnUpdatePlan } from "../../content/cdn/protocol"
import type { ContentSnapshot } from "../../content/runtime/content-snapshot"
import { getContentSnapshot } from "../../content/runtime/content-snapshot"
import { generateDataHeaders } from "../../utils"

interface AssetRouteEnvironment {
    readonly [name: string]: string | undefined
    readonly CDN_BASE_URL?: string
}

export interface AssetTargetMismatchWarning {
    readonly clientTargetVersion: unknown
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
    readonly env?: AssetRouteEnvironment
    readonly warn?: (details: AssetTargetMismatchWarning) => void
    readonly logError?: AssetRouteErrorLogger
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
    const value = request.headers[name]
    return typeof value === "string" ? value : undefined
}

export function getCdnBase(
    request: FastifyRequest,
    env: AssetRouteEnvironment = process.env,
): string {
    if (env.CDN_BASE_URL) return normalizeCdnBaseUrl(env.CDN_BASE_URL)
    const host = request.headers.host ?? "localhost:8001"
    return normalizeCdnBaseUrl(`${request.protocol}://${host}/patch/cn`)
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

    fastify.post("/version_info", async (request, reply) => {
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
                data: getCdnVersionInfo(getCdnBase(request, env), contentSnapshot),
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

        const currentVersion = headerValue(request, "res_ver") ?? null
        try {
            const body = request.body as { target_asset_version?: unknown } | null | undefined
            const clientTarget = body?.target_asset_version
            if (clientTarget !== undefined && clientTarget !== contentSnapshot.cdn.targetVersion) {
                const warning = {
                    clientTargetVersion: clientTarget,
                    snapshotTargetVersion: contentSnapshot.cdn.targetVersion,
                }
                if (options.warn) options.warn(warning)
                else request.log.warn(warning, "ignoring client asset target that differs from pinned snapshot")
            }

            const plan = planCdnUpdate(contentSnapshot.cdn, {
                currentVersion,
                targetVersion: contentSnapshot.cdn.targetVersion,
                platform: "android",
                assetSizeKind: "fulfill",
                isInitial: currentVersion === null,
            })
            const data = serializeCdnUpdatePlan(plan, {
                baseUrl: getCdnBase(request, env),
                currentVersion,
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
