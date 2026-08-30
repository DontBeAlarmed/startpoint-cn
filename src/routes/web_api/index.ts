import { FastifyInstance } from "fastify";
import playerApiPlugin from "./player"
import serverApiPlugin from "./server"
import mailApiPlugin from "./mail"
import lookupApiPlugin from "./lookup"
import settingsApiPlugin from "./settings"
import multiManagementApiPlugin from "./multi-management"
import scheduledResourceApiPlugin from "./scheduled-resource"
import newsApiPlugin from "./news"
import { ADMIN_UPLOAD_FILE_SIZE_LIMIT } from "./upload-limits"
import type { ServerRoutesOptions } from "./server"
import type { MultiManagementRoutesOptions } from "./multi-management"

export { ADMIN_UPLOAD_FILE_SIZE_LIMIT } from "./upload-limits"

export interface WebApiRoutesOptions extends ServerRoutesOptions {
    readonly getMultiManagementService?: MultiManagementRoutesOptions["getMultiManagementService"]
}

const routes = async (fastify: FastifyInstance, options: WebApiRoutesOptions) => {
    fastify.register(require('@fastify/multipart'), {
        limits: {
            fieldNameSize: 100, // Max field name size in bytes
            fieldSize: 100,     // Max field value size in bytes
            fields: 10,         // Max number of non-file fields
            fileSize: ADMIN_UPLOAD_FILE_SIZE_LIMIT,
            files: 1,           // Max number of file fields
            headerPairs: 2000,  // Max number of header key=>value pairs
            parts: 1000         // For multipart forms, the max number of parts (fields + files)
        }
    })

    fastify.register(playerApiPlugin, { prefix: "/player" })
    fastify.register(serverApiPlugin, {
        prefix: "/server",
        getMultiStatus: options.getMultiStatus,
        runtimeConfig: options.runtimeConfig,
        getRuntimeConfig: options.getRuntimeConfig,
        serverTimeService: options.serverTimeService,
    })
    fastify.register(mailApiPlugin, { prefix: "/mail" })
    fastify.register(newsApiPlugin, { prefix: "/news" })
    fastify.register(scheduledResourceApiPlugin, { prefix: "/scheduled-resource" })
    fastify.register(lookupApiPlugin, { prefix: "/lookup" })
    fastify.register(settingsApiPlugin, { prefix: "/server/settings" })
    fastify.register(multiManagementApiPlugin, {
        prefix: "/server/multiplayer",
        getMultiManagementService: options.getMultiManagementService ?? (() => null),
    })
}

export default routes;
