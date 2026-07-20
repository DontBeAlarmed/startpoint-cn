import type { FastifyInstance } from "fastify"
import type { ContentSnapshot } from "../../content/runtime/content-snapshot"
import { getContentSnapshot } from "../../content/runtime/content-snapshot"
import { generateDataHeaders } from "../../utils"
import { getCdnBase, getCdnVersionInfo } from "./asset"

interface AssetInTitleEnvironment {
    readonly [name: string]: string | undefined
    readonly CDN_BASE_URL?: string
}

export interface CnAssetInTitleRouteOptions {
    readonly getSnapshot?: () => ContentSnapshot
    readonly env?: AssetInTitleEnvironment
}

const routes = async (fastify: FastifyInstance, options: CnAssetInTitleRouteOptions) => {
    const snapshot = options.getSnapshot ?? getContentSnapshot
    const env = options.env ?? process.env

    fastify.post("/version_info_in_title", async (request, reply) => {
        reply.type("application/x-msgpack")
        return {
            data_headers: generateDataHeaders(),
            data: getCdnVersionInfo(getCdnBase(request, env), snapshot()),
        }
    })
}

export default routes
