import type { FastifyInstance, FastifyRequest } from "fastify"
import { CdnPlannerError, planCdnUpdate } from "../../content/cdn/planner"
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

export interface CnAssetRouteOptions {
    readonly getSnapshot?: () => ContentSnapshot
    readonly env?: AssetRouteEnvironment
    readonly warn?: (details: AssetTargetMismatchWarning) => void
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

function plannerStatus(code: CdnPlannerError["code"]): number {
    return code === "UNKNOWN_CURRENT_VERSION" ? 400 : 500
}

const routes = async (fastify: FastifyInstance, options: CnAssetRouteOptions) => {
    const snapshot = options.getSnapshot ?? getContentSnapshot
    const env = options.env ?? process.env

    fastify.post("/version_info", async (request, reply) => {
        reply.type("application/json")
        return {
            data_headers: generateDataHeaders(),
            data: getCdnVersionInfo(getCdnBase(request, env), snapshot()),
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

        const contentSnapshot = snapshot()
        const currentVersion = headerValue(request, "res_ver") ?? null
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

        try {
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
            if (!(error instanceof CdnPlannerError)) throw error
            return reply.status(plannerStatus(error.code)).type("application/json").send({
                code: error.code,
                message: error.message,
            })
        }
    })
}

export default routes
