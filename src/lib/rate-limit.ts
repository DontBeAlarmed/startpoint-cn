import type { FastifyReply, FastifyRequest } from "fastify"
import { getRealNowMs } from "../runtime/time/game-time"

// 进程内固定窗口限速：单进程模型，只为凭据类端点（signup / 引继 / SDK 登录）
// 加兜底——遏制在线爆破与 bcrypt 同步比对的 CPU 放大。窗口状态在内存，重启即清零。

export interface RateLimitRule {
    readonly name: string
    readonly max: number
    readonly windowMs: number
}

function envInt(name: string, fallback: number): number {
    const parsed = Number.parseInt(process.env[name] ?? "", 10)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

/** 命名规则：env RATE_LIMIT_<NAME>_MAX / RATE_LIMIT_<NAME>_WINDOW_MS 可覆盖默认值。 */
export function rateLimitRule(name: string, defaultMax: number, defaultWindowMs = 60_000): RateLimitRule {
    return {
        name,
        max: envInt(`RATE_LIMIT_${name}_MAX`, defaultMax),
        windowMs: envInt(`RATE_LIMIT_${name}_WINDOW_MS`, defaultWindowMs),
    }
}

/** 限速键：默认只用对端地址；仅当 TRUST_PROXY_XFF=1（部署在可信反代之后）才信任
 * X-Forwarded-For 首段——直连公网时该头完全由客户端控制，信任它等于不限速。
 * 注意：用服务器真实时钟（非游戏时间偏移）。 */
export function clientKeyOf(request: FastifyRequest): string {
    if (process.env.TRUST_PROXY_XFF === "1") {
        const xff = request.headers["x-forwarded-for"]
        const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim()
        if (first) return first
    }
    return request.ip
}

export type RateLimiter = (request: FastifyRequest) => boolean

/** 返回 true = 超限（调用方统一 429）。 */
export function createRateLimiter(rule: RateLimitRule): RateLimiter {
    const buckets = new Map<string, { count: number; reset: number }>()
    return request => {
        const key = clientKeyOf(request)
        const now = getRealNowMs()
        const entry = buckets.get(key)
        if (entry === undefined || now >= entry.reset) {
            buckets.set(key, { count: 1, reset: now + rule.windowMs })
            return false
        }
        entry.count += 1
        return entry.count > rule.max
    }
}

/** 共享 429 回复：这些端点位于鉴权之前，纯文本即可（与既有 /crash 行为一致）。 */
export async function enforceRateLimit(
    request: FastifyRequest,
    reply: FastifyReply,
    limiter: RateLimiter,
): Promise<unknown> {
    if (limiter(request)) {
        return reply.status(429).send("Too Many Requests")
    }
    return undefined
}
