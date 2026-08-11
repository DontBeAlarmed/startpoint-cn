import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export interface VersionCheckPluginOptions {
    readonly ios?: {
        readonly enabled: boolean
        readonly apiHost: string
        readonly apiScheme: "http" | "https"
    }
}

// Android 客户端保持官方域名（与历史行为逐字节一致）。
const CN_API_HOST = "shijtswygamegf.leiting.com";

const versionDataAndroid = [
    "// 用于官服正式用",
    JSON.stringify({
        "default": {
            "apiPath": CN_API_HOST,
        },
    })
].join("\r\n");

const routes = async (fastify: FastifyInstance, options: VersionCheckPluginOptions) => {
    // iOS 仅在 IOS_COMPAT_ENABLED=1 且配置了可达的 IOS_API_HOST 时返回私服地址；
    // 否则与 Android 完全一致（官方域名），保证默认行为零变化。
    const ios = options.ios
    const versionDataIOS = ios !== undefined && ios.enabled
        ? [
            "// 用于官服正式用",
            JSON.stringify({
                "default": {
                    "apiPath": ios.apiHost,
                    "apiScheme": ios.apiScheme,
                },
            }),
        ].join("\r\n")
        : versionDataAndroid

    fastify.get("/shijtswy/version/client_release_android.dis",
        async (_request: FastifyRequest, reply: FastifyReply) => {
        reply.header("content-type", "text/plain; charset=utf-8");
        reply.status(200).send(versionDataAndroid);
    });

    fastify.get("/shijtswy/version/client_release_ios.dis",
        async (_request: FastifyRequest, reply: FastifyReply) => {
        reply.header("content-type", "text/plain; charset=utf-8");
        reply.status(200).send(versionDataIOS);
    });
};

export default routes;
