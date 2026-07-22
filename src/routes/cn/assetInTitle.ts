import type { FastifyInstance } from "fastify"
import path from "node:path"
import {
    parseAssetProviderConfig,
    type AssetModeEnvironment,
    type AssetProviderConfig,
} from "../../content/cdn/asset-mode"
import type { ContentSnapshot } from "../../content/runtime/content-snapshot"
import { getContentSnapshot } from "../../content/runtime/content-snapshot"
import { generateDataHeaders } from "../../utils"
import {
    getCdnVersionInfo,
    sendAssetRouteError,
    type AssetRouteErrorLogger,
} from "./asset"

type AssetInTitleEnvironment = AssetModeEnvironment

export interface CnAssetInTitleRouteOptions {
    readonly getSnapshot?: () => ContentSnapshot
    readonly provider?: AssetProviderConfig
    readonly env?: AssetInTitleEnvironment
    readonly logError?: AssetRouteErrorLogger
    readonly resolveListenHost?: (listenHost: string) => string
}

const routes = async (fastify: FastifyInstance, options: CnAssetInTitleRouteOptions) => {
    const snapshot = options.getSnapshot ?? getContentSnapshot
    const env = options.env ?? process.env
    const getProvider = (): AssetProviderConfig => options.provider ?? parseAssetProviderConfig({
        projectRoot: path.resolve(__dirname, "../../.."),
        env,
        resolveListenHost: options.resolveListenHost,
    })

    fastify.post("/version_info_in_title", async (request, reply) => {
        let provider: AssetProviderConfig
        try {
            provider = getProvider()
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
        if (provider.mode === "client-owned") {
            return reply.type("application/x-msgpack").send({
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
                "application/x-msgpack",
            )
        }

        try {
            return reply.type("application/x-msgpack").send({
                data_headers: generateDataHeaders(),
                data: getCdnVersionInfo(provider.baseUrl, contentSnapshot),
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
