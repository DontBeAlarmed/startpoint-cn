import type { FastifyInstance } from "fastify"
import type { ContentSnapshot } from "../../content/runtime/content-snapshot"
import { getContentSnapshot } from "../../content/runtime/content-snapshot"
import { generateDataHeaders } from "../../utils"
import {
    getCdnBase,
    getCdnVersionInfo,
    sendAssetRouteError,
    type AssetRouteErrorLogger,
} from "./asset"

interface AssetInTitleEnvironment {
    readonly [name: string]: string | undefined
    readonly CDN_BASE_URL?: string
}

export interface CnAssetInTitleRouteOptions {
    readonly getSnapshot?: () => ContentSnapshot
    readonly env?: AssetInTitleEnvironment
    readonly logError?: AssetRouteErrorLogger
    readonly resolveListenHost?: (listenHost: string) => string
}

const routes = async (fastify: FastifyInstance, options: CnAssetInTitleRouteOptions) => {
    const snapshot = options.getSnapshot ?? getContentSnapshot
    const env = options.env ?? process.env
    const resolveListenHost = options.resolveListenHost

    fastify.post("/version_info_in_title", async (request, reply) => {
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
                "application/x-msgpack",
            )
        }

        try {
            return reply.type("application/x-msgpack").send({
                data_headers: generateDataHeaders(),
                data: getCdnVersionInfo(getCdnBase(env, resolveListenHost), contentSnapshot),
            })
        } catch (error) {
            return sendAssetRouteError(
                request,
                reply,
                "ASSET_SERVICE_ERROR",
                error,
                options.logError,
                "application/x-msgpack",
            )
        }
    })
}

export default routes
