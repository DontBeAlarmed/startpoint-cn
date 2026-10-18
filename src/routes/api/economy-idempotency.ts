import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { setCnMsgpackPendingEncoder } from "../cn/msgpack"
import {
    findEconomyReplay,
    rememberEconomyResponse,
} from "../../lib/economy-response-cache"
import { getSession } from "../../data/domains/session"
import { resolvePlayerIdSync } from "../../data/activeAccount"

export interface EconomyIdempotencyOptions {
    /** 挂载前缀（scoped hooks 只作用于该前缀下的路由）。 */
    readonly prefix: string
    /** 测试注入：跳过会话解析，直接用调用方给的 playerId。 */
    readonly resolvePlayerId?: (
        viewerId: number,
    ) => Promise<number | null>
}

interface RequestScope {
    playerId: number | null
    apiCount: number
    endpoint: string
}

function readScope(request: FastifyRequest, prefix: string): RequestScope | null {
    if (request.method !== "POST") return null
    if (!request.url.startsWith(prefix)) return null
    const body = request.body
    if (body === null || typeof body !== "object" || Array.isArray(body)) return null
    const viewerId = Number((body as Record<string, unknown>).viewer_id)
    const apiCount = Number((body as Record<string, unknown>).api_count)
    if (!Number.isSafeInteger(viewerId) || viewerId <= 0) return null
    if (!Number.isSafeInteger(apiCount) || apiCount <= 0) return null
    // 端点取路由模板（去 query），作为键的一部分防跨端点误回放
    const routeOptions = (request as unknown as { routeOptions?: { url?: string } }).routeOptions
    const endpoint = routeOptions?.url ?? request.url.split("?")[0]
    return { playerId: null, apiCount, endpoint }
}

/**
 * R-03 经济写路径请求级幂等：按 (会话解析的 playerId, api_count, 端点)
 * 缓存 200 响应字节，精确命中即透传回放（不执行业务逻辑）。
 * 未命中/任何不确定 —— 一律照常执行（fail-safe 退化为现状）。
 */
export async function registerEconomyIdempotency(
    fastify: FastifyInstance,
    options: EconomyIdempotencyOptions,
): Promise<void> {
    // 钩子注册在传入实例上（Fastify 封装模型：scoped 插件的钩子不会作用于
    // 兄弟插件的路由），URL 前缀过滤在钩子体内实现
    registerHooks(fastify, options)
}

function registerHooks(
    instance: FastifyInstance,
    options: EconomyIdempotencyOptions,
): void {
    // preHandler：解析会话 → 回放命中则短路
    instance.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
        const scope = readScope(request, options.prefix)
        if (scope === null) return
        let playerId: number | null
        if (options.resolvePlayerId !== undefined) {
            playerId = await options.resolvePlayerId(Number((request.body as Record<string, unknown>).viewer_id))
        } else {
            const session = await getSession(String((request.body as Record<string, unknown>).viewer_id))
            playerId = session === null ? null : resolvePlayerIdSync(session.accountId)
        }
        if (playerId === null) return
        scope.playerId = playerId
        request.economyIdempotencyScope = scope

        const cached = findEconomyReplay(playerId, scope.apiCount, scope.endpoint)
        if (cached !== null) {
            // 原字节回放：pending encoder 忽略传入 payload，直接返回缓存字节，
            // 规避 msgpack onSend 的二次打包
            reply.header("content-type", "application/x-msgpack")
            setCnMsgpackPendingEncoder(reply, () => cached.payload)
            reply.send({})
        }
    })

    // onSend：业务执行成功（200、x-msgpack）后记录响应字节。
    // 本钩子注册在 msgpack onSend 之后，收到的是已打包的 base64 字节串。
    instance.addHook("onSend", async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
        if (!request.url.startsWith(options.prefix)) return
        const scope = (request as unknown as {
            economyIdempotencyScope?: RequestScope
        }).economyIdempotencyScope
        if (scope === undefined || scope.playerId === null) return
        if (reply.statusCode !== 200) return
        if (typeof payload !== "string") return
        rememberEconomyResponse(scope.playerId, scope.apiCount, scope.endpoint, payload)
    })
}

declare module "fastify" {
    interface FastifyRequest {
        economyIdempotencyScope?: RequestScope
    }
}
