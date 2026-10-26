import { createHash, timingSafeEqual } from "node:crypto"
import type { FastifyInstance } from "fastify"

/** 读取 ADMIN_API_TOKEN；未设置或空白返回 null（私人形态：不鉴权）。 */
export function readAdminApiToken(): string | null {
    const value = process.env.ADMIN_API_TOKEN?.trim()
    return value ? value : null
}

/**
 * 在封装作用域内为全部管理 API 路由挂 Bearer 门禁。
 * 只作用于挂进本作用域的管理面（web_api + seeds）；游戏路由 /api/index.php/* 不经此作用域，零影响。
 * 比较：两侧都 sha256 归一为 32 字节后再 timingSafeEqual（避免长度差异抛错且恒时）。
 */
export function requireAdminApiToken(instance: FastifyInstance, token: string): void {
    const expected = createHash("sha256").update(token).digest()
    instance.addHook("preHandler", async (request, reply) => {
        const header = request.headers.authorization
        const presented = typeof header === "string" && header.startsWith("Bearer ")
            ? header.slice("Bearer ".length).trim()
            : null
        if (presented === null
            || !timingSafeEqual(expected, createHash("sha256").update(presented).digest())) {
            reply.status(401).send({ error: "unauthorized" })
            return reply
        }
    })
}
