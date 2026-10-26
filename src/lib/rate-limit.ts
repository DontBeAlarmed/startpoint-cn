import type { FastifyReply, FastifyRequest } from "fastify"
import { getRealNowMs } from "../runtime/time/game-time"

// 进程内固定窗口限速：单进程模型，只为凭据类端点（signup / 引继 / SDK 登录）
// 加兜底——遏制在线爆破与 bcrypt 同步比对的 CPU 放大。窗口状态在内存，重启即清零。

export interface RateLimitRule {
    readonly name: string
    readonly max: number
    readonly windowMs: number
}

// 单 limiter 桶容量上界：TRUST_PROXY_XFF=1 时 key 客户端可控，无上界会变成
// 内存 DoS 面。达到容量时优先回收已过期窗口，否则拒绝新 key 计数（按超限
// 处理，fail-closed）——既有 key 的窗口不受影响。
const MAX_BUCKETS = 10_000

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

/** 限速键：默认只用对端地址；仅当 TRUST_PROXY_XFF=1（部署在可信反代之后）才
 * 信任 X-Forwarded-For **末段**——常见反代（$proxy_add_x_forwarded_for）是
 * 追加式，末段才是反代写入的直连地址，首段是客户端可伪造值。反代必须以
 * 覆写模式（proxy_set_header X-Forwarded-For $remote_addr）或确保末段可信。
 * 直连公网时该头完全由客户端控制，TRUST_PROXY_XFF 保持关闭。
 * 注意：用服务器真实时钟（非游戏时间偏移）。 */
export function clientKeyOf(request: FastifyRequest): string {
    if (process.env.TRUST_PROXY_XFF === "1") {
        const xff = request.headers["x-forwarded-for"]
        const raw = Array.isArray(xff) ? xff.join(",") : xff
        const segments = raw?.split(",").map(part => part.trim()).filter(Boolean) ?? []
        const last = segments[segments.length - 1]
        if (last) return last
    }
    return request.ip
}

export interface RateLimiter {
    (request: FastifyRequest): boolean
    /** 创建本 limiter 的规则；enforceRateLimit 用它计算 Retry-After。 */
    readonly rule: RateLimitRule
}

/** 返回 true = 超限（调用方统一 429）。 */
export function createRateLimiter(rule: RateLimitRule): RateLimiter {
    const buckets = new Map<string, { count: number; reset: number }>()
    const limiter = (request: FastifyRequest): boolean => {
        const key = clientKeyOf(request)
        const now = getRealNowMs()
        const entry = buckets.get(key)
        if (entry === undefined || now >= entry.reset) {
            if (!buckets.has(key) && buckets.size >= MAX_BUCKETS) {
                // 插入路径顺带清扫过期窗口；清完仍满则拒绝新 key（fail-closed）
                for (const [oldestKey, oldest] of buckets) {
                    if (now < oldest.reset) break
                    buckets.delete(oldestKey)
                }
                if (buckets.size >= MAX_BUCKETS) return true
            }
            buckets.set(key, { count: 1, reset: now + rule.windowMs })
            return false
        }
        entry.count += 1
        return entry.count > rule.max
    }
    return Object.assign(limiter, { rule })
}

/** 共享 429 回复：这些端点位于鉴权之前，纯文本即可（与既有 /crash 行为一致）。 */
export async function enforceRateLimit(
    request: FastifyRequest,
    reply: FastifyReply,
    limiter: RateLimiter,
): Promise<unknown> {
    if (limiter(request)) {
        const retryAfterSeconds = Math.max(1, Math.ceil(limiter.rule.windowMs / 1000))
        return reply
            .header("retry-after", retryAfterSeconds)
            .status(429)
            .send("Too Many Requests")
    }
    return undefined
}
