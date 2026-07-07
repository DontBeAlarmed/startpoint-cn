import { FastifyRequest } from "fastify";

// 迁移期：SPA 客户端带 Accept: application/json，旧 SSR 表单不带。
// 据此分流：JSON 客户端返回 JSON，旧页面保留 302 redirect。
export function wantsJson(request: FastifyRequest): boolean {
    return (request.headers.accept ?? "").includes("application/json");
}
