import type { FastifyInstance, FastifyRequest } from "fastify"
import { getDb } from "../data/db"
import { SessionType } from "../data/types"
import { generateDataHeaders } from "../utils"

export const TAKEOVER_OLD_ACCESS_ERROR = 516

function normalizeViewerId(value: unknown): string | null {
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value)
    if (typeof value !== "string" || !/^\d{1,15}$/.test(value)) return null
    return value
}

export function getRequestUdid(request: FastifyRequest): string | null {
    const value = request.headers.udid
    if (Array.isArray(value)) return value[0]?.trim() || null
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

/** Reject an old local client after its account has been transferred. */
export function installTakeoverUdidGuard(fastify: FastifyInstance): void {
    fastify.addHook("preHandler", async (request, reply) => {
        if (!request.url.startsWith("/api/index.php/")) return
        const body = request.body
        if (!body || typeof body !== "object" || Array.isArray(body)) return
        const viewerId = normalizeViewerId((body as Record<string, unknown>).viewer_id)
        if (!viewerId) return

        const row = getDb().prepare(`
            SELECT a.takeover_udid
            FROM sessions AS s
            JOIN accounts AS a ON a.id = s.account_id
            WHERE s.token = ? AND s.type = ?
            LIMIT 1
        `).get(viewerId, SessionType.VIEWER) as { takeover_udid: string | null } | undefined
        if (!row?.takeover_udid) return
        if (getRequestUdid(request) === row.takeover_udid) return

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            data_headers: generateDataHeaders({
                viewer_id: Number(viewerId),
                result_code: TAKEOVER_OLD_ACCESS_ERROR,
            }),
            data: {},
        })
    })
}
