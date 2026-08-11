import path from "node:path"
import type { FastifyInstance } from "fastify"

import type { AssetProviderConfig } from "../../content/cdn/asset-mode"
import type { ContentSnapshot } from "../../content/runtime/content-snapshot"
import { getContentSnapshot } from "../../content/runtime/content-snapshot"
import { prepareIosCompat } from "../../content/cdn/ios-compat"
import assetPlugin, {
    type AssetRouteErrorLogger,
    type AssetTargetMismatchWarning,
} from "./asset"
import assetInTitlePlugin from "./assetInTitle"
import cdnFilesPlugin, {
    type CdnFileHandleObserver,
    type CdnFileSystem,
} from "./cdnFiles"

export interface CnAssetProviderRouteOptions {
    readonly config: AssetProviderConfig
    readonly getSnapshot?: () => ContentSnapshot
    readonly warn?: (details: AssetTargetMismatchWarning) => void
    readonly logError?: AssetRouteErrorLogger
    readonly fileSystem?: CdnFileSystem
    readonly handleObserver?: CdnFileHandleObserver
    readonly patchUploadRoot?: string
    readonly iosCompat?: {
        readonly enabled: boolean
        readonly apiHost: string
        readonly apiScheme: "http" | "https"
    }
}

export function registerCnAssetProviderRoutes(
    fastify: FastifyInstance,
    options: CnAssetProviderRouteOptions,
): void {
    const getSnapshot = options.getSnapshot ?? getContentSnapshot
    const sharedOptions = {
        provider: options.config,
        getSnapshot,
        logError: options.logError,
        iosCompat: options.iosCompat,
    }
    fastify.register(assetPlugin, {
        prefix: "/api/index.php/asset",
        ...sharedOptions,
        warn: options.warn,
    })
    fastify.register(assetInTitlePlugin, {
        prefix: "/api/index.php/assetintitle",
        ...sharedOptions,
    })

    if (options.config.mode === "local") {
        fastify.register(cdnFilesPlugin, {
            getSnapshot,
            paths: {
                cdnRoot: path.resolve(options.config.cdnRoot),
                patchesRoot: path.resolve(path.dirname(options.config.cdnRoot), "patches"),
            },
            fileSystem: options.fileSystem,
            handleObserver: options.handleObserver,
            patchUploadRoot: options.patchUploadRoot ?? options.config.patchUploadRoot,
            iosCompat: options.iosCompat,
        })
    }

    if (options.iosCompat?.enabled === true && options.config.mode === "local") {
        // iOS 目录在适配器初始化时扫描一次并冻结（幂等；目录/实体表缺失时缓存"不可用"状态）。
        // 扫描失败只影响 iOS 请求，不影响 Android 服务启动。
        try {
            prepareIosCompat(getSnapshot(), path.resolve(options.config.cdnRoot))
        } catch (error) {
            console.warn("[ios-compat] startup scan failed", error)
        }
    }
}
