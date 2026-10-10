import { FastifyInstance } from "fastify";
import playerApiPlugin from "./player"
import serverApiPlugin from "./server"
import mailApiPlugin from "./mail"
import lookupApiPlugin from "./lookup"
import settingsApiPlugin from "./settings"
import multiManagementApiPlugin from "./multi-management"
import scheduledResourceApiPlugin from "./scheduled-resource"
import newsApiPlugin from "./news"
import giftApiPlugin from "./gift"
import contentApiPlugin from "./content"
import { ADMIN_UPLOAD_FILE_SIZE_LIMIT } from "./upload-limits"
import type { ServerRoutesOptions } from "./server"
import type { MultiManagementRoutesOptions } from "./multi-management"
import type { ContentRoutesOptions } from "./content"
import { registerContentManagementRoutes } from "./content-management"

export { ADMIN_UPLOAD_FILE_SIZE_LIMIT } from "./upload-limits"

export interface WebApiRoutesOptions extends ServerRoutesOptions {
    readonly getMultiManagementService?: MultiManagementRoutesOptions["getMultiManagementService"]
    readonly getAvatarCdnRoot?: ContentRoutesOptions["getCdnRoot"]
    /** 服务端启动锁定的日历偏移（惰性 getter）；热更新 apply 用（不端点内 parse env）。 */
    readonly getGameCalendarUtcOffsetMinutes?: () => number
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
    fastify.register(giftApiPlugin, { prefix: "/gifts" })
    fastify.register(scheduledResourceApiPlugin, { prefix: "/scheduled-resource" })
    fastify.register(lookupApiPlugin, { prefix: "/lookup" })
    fastify.register(contentApiPlugin, {
        prefix: "/content",
        getCdnRoot: options.getAvatarCdnRoot,
    })
    fastify.register(settingsApiPlugin, { prefix: "/server/settings" })
    fastify.register(multiManagementApiPlugin, {
        prefix: "/server/multiplayer",
        getMultiManagementService: options.getMultiManagementService ?? (() => null),
    })
    if (options.getGameCalendarUtcOffsetMinutes !== undefined) {
        // 收窄需在闭包外完成：async 闭包不保留 `!== undefined` 的可选类型收窄
        const getGameCalendarUtcOffsetMinutes = options.getGameCalendarUtcOffsetMinutes
        // 同步双参函数需 async 包装，否则 avvio 等待 done 直到超时（http startup failed）
        fastify.register(async instance => {
            registerContentManagementRoutes(instance, {
                getGameCalendarUtcOffsetMinutes,
            })
        }, { prefix: "/content-management" })
    }
}

export default routes;
