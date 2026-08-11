import { FastifyInstance } from "fastify"
import { getEffectiveVersion } from "../../lib/version"

// --- iOS Leiting SDK 登录 mock ---
// 移植自 dennis96292/startpoint-cn-launcher：
//   https://github.com/dennis96292/startpoint-cn-launcher
//   原始位置 resources/server/out/cn-server.js（IOS_SDK_LOGIN_BLOB / iosLoginPaths / iosStubPaths）
// 背景：iOS 是 AOT 编译无法改成 sdkDummy，必须走真实 Leiting SDK 登录；
// 以下端点返回 AES 加密的固定游客 UserBean（SDK 内置密钥可解密，frida 验证，任何凭据都接受）。
// SDK 日志接口与 /wf/210009_config_20200415.json 引导接口由"灰"制作，
// 基于 DontBeAlarmed/startpoint-cn@dev 提交 11d3bcf9。
const IOS_SDK_LOGIN_BLOB = "Ox8piDWnl7p3xCrJ3bwS8RSjUahG/oB4S8D+s39R7Bb/C7XfVkgxohfumfFMK/Or8Kppz+Bk/tZyrEHnERbc0NYeuBKFrcWdQ+gzSuuliP9kIb1uUBP9Uj0DxB49Pnr3MSs6FDp8SZXDvmPjKT8y0twAiSYGQu1GCUwpKT0uJH1zxb8Q6Zyj70UPLlRKPoKnsSRscBIlOj/ACkDy4cBCfAYFFTApjQY4+NnsddSYs40399y59OzTsKMGCuyghJeeBCeATZYeihAkkcj93Prd6YYI7jLYfUPDN4Rxlj5fx9d89ZKQcRE9GTophK7MWQdP6ihEfY49aUHvXXQjRlO3z+gAAhb2VPW8KHnmG/K0jds182SXYhY3EXqf9bPpbO8NqtYKOAx8lRQBO/h01yRP9vBITftZQ0PIee/27v4EsifUiNpGgZO0Z1nduxadLfZuScp+rsPO8LfXK9pc2LPq7Q86AuH80NfA7/zVnCzhvoOLf5G+KpyOtvlHnuVei76T0/clqHs2iBtrPv8vqlBxjeJo0g08dMbaZhYTsOrZv7Q0KSAd3lPrtI6EeB2PqNG1";
const iosLoginOK = { status: "0", type: "0", message: "", data: IOS_SDK_LOGIN_BLOB };
const iosStatusOK = { status: "0", statusCode: "0", memo: "", message: "", data: "" };
const iosLoginPaths = ["/mobile!mobileLoginPubV2.action", "/login/mobile!mobileLoginPubV2.action", "/mobile!sdkLogin.action", "/login/mobile!sdkLogin.action", "/mobile!guestRegister.action", "/login/mobile!guestRegister.action", "/mobile!sdkCheckLogin.action", "/login/mobile!sdkCheckLogin.action", "/sdk/v3-3/code_login_v2.do", "/sdk/v3-3/code_login.do", "/sdk/v3-3/pwd_login.do", "/sdk/v3-3/check_login.do", "/sdk/v3-3/check_force.do", "/sdk/v3-3/taptap_login.do", "/sdk/auth_login.do", "/sdk/v3-3/auth_login.do"];
const iosStubPaths = ["/mobile_two!getRegisterCodeOnly.action", "/login/mobile_two!getRegisterCodeOnly.action", "/aes/message/send_phone_code", "/aes/message/send_login_verify_code", "/aes/message/send_bind_phone_login_code", "/aes/message/send_register_code"];

const SDK_LOG_PATHS = [
    "/api/sdk_log!addScreenLog",
    "/api/sdk_log!addScreenLog.action",
    "/api/sdk_api!getCaidNew",
    "/api/sdk_api!getCaidNew.action",
] as const;

const MG_LOG_PATHS = [
    "/api/mg_log!addMgActivateLog.action",
    "/api/mg_log!addMgCreateRoleLog.action",
    "/api/mg_log!addMgLoginLog.action",
    "/api/mg_log!addMgRegisterLog.action",
] as const;

const protocolEndpoints = [
    "/protocols/leiting/sensitive/part/common_version.txt",
    "/protocols/leiting/sensitive/part/wf_version.txt",
    "/protocols/leiting/sensitive/part/wf-text_version.txt",
    "/protocols/leiting/sensitive/part/common-text_version.txt",
] as const;

export interface IosLeitingPluginOptions {
    readonly ios?: {
        readonly apiHost: string
        readonly apiScheme: "http" | "https"
    }
    readonly resolveVersion?: () => string
}

export default async function iosLeitingRoutes(
    fastify: FastifyInstance,
    options: IosLeitingPluginOptions = {},
): Promise<void> {
    const resolveVersion = options.resolveVersion ?? getEffectiveVersion
    const ios = options.ios
    // 区服/CDN 配置
    fastify.get("/area/config.json", async (_request, reply) => {
        return reply.type("application/json").send({
            area_list: [],
            cdn_list: [{ url: "" }],
        })
    })

    // 协议版本文件（版本号来自 Content Snapshot，与 CDN 资源版本一致；惰性读取）
    for (const path of protocolEndpoints) {
        fastify.get(path, async (_request, reply) => {
            let version: string
            try {
                version = resolveVersion()
            } catch {
                // 资源版本缺失属于配置/初始化错误：明确失败而非 200 空版本，
                // 避免把配置错误延迟成客户端故障。
                return reply.status(503).type("text/plain").send("content snapshot unavailable")
            }
            if (version === "") {
                return reply.status(503).type("text/plain").send("content snapshot unavailable")
            }
            return reply.type("text/plain").send(version)
        })
    }

    // 功能开关
    fastify.get("/protocols/leiting/switch/switch.txt", async (_request, reply) => {
        return reply.type("text/plain").send("{}")
    })

    // 客户端 IP 检测：返回直连对端地址（request.ip）。
    // 边界说明：仅当客户端直连本服务、或反向代理已按 fastify trustProxy 配置正确透传
    // X-Forwarded-For 时，该值才是真实公网来源 IP；否则它只是上一个网络对端。
    fastify.get("/myip", async (request, reply) => {
        return reply.type("text/plain").send(request.ip)
    })

    // 广告配置
    fastify.post("/logmonitor/api/advert!getNewConfig.action", async (_request, reply) => {
        return reply.type("application/json").send({ code: 0, data: {} })
    })

    // SKAdNetwork
    fastify.get("/api/skan/query_detail", async (_request, reply) => {
        return reply.type("application/json").send({ code: 0, data: {} })
    })

    // SDK 埋点（兼容带/不带 .action）
    for (const route of SDK_LOG_PATHS) {
        fastify.post(route, async (_request, reply) => {
            return reply.type("application/json").send({ code: 0, data: {} })
        })
    }

    // SDK 日志（GET/POST 都接受）
    for (const route of MG_LOG_PATHS) {
        fastify.all(route, async (_request, reply) => {
            return reply.type("application/json").send({ code: 0, message: "success" })
        })
    }

    // 引导配置（apiPath 取 iOS 兼容配置的显式地址）
    fastify.get("/wf/210009_config_20200415.json", async (_request, reply) => {
        return reply.type("application/json").send({
            default: {
                apiPath: ios?.apiHost ?? "",
                apiScheme: ios?.apiScheme ?? "http",
            },
        })
    })

    // sync_data 静默吞掉
    fastify.post("/sync_data", async (_request, reply) => {
        return reply.type("application/json").send({ code: 0 })
    })

    // Leiting SDK 登录 mock（任何凭据都接受）
    for (const p of iosLoginPaths) {
        fastify.all(p, (_req, reply) => { console.log("[iOS-SDK-LOGIN] " + p); reply.send(iosLoginOK); });
    }
    for (const p of iosStubPaths) {
        fastify.all(p, (_req, reply) => { console.log("[iOS-SDK-STUB] " + p); reply.send(iosStatusOK); });
    }
}
