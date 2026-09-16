import type { FastifyReply, FastifyRequest } from "fastify"
import { getSession } from "../../../data/domains/session"
import { resolvePlayerIdSync } from "../../../data/activeAccount"
import { getPlayerSync } from "../../../data/domains/player"

export interface FollowViewerContext {
    readonly viewerId: number
    readonly playerId: number
}

export async function resolveFollowViewer(
    request: FastifyRequest,
    reply: FastifyReply,
): Promise<FollowViewerContext | null> {
    const viewerId = (request.body as { viewer_id?: unknown })?.viewer_id
    if (!Number.isSafeInteger(viewerId) || (viewerId as number) <= 0) {
        reply.status(400).send({ error: "Bad Request", message: "Invalid request body." })
        return null
    }
    const session = await getSession(String(viewerId))
    if (!session) {
        reply.status(400).send({ error: "Bad Request", message: "Invalid viewer id." })
        return null
    }
    const playerId = resolvePlayerIdSync(session.accountId)
    if (playerId === null || getPlayerSync(playerId) === null) {
        reply.status(400).send({ error: "Bad Request", message: "Invalid viewer id." })
        return null
    }
    return { viewerId: viewerId as number, playerId }
}

/** 把目标 viewer id 解析为同服 player（本地 session 即同服边界，F0 冻结）。 */
export async function resolveFollowTarget(
    targetViewerId: number,
): Promise<number | null> {
    if (!Number.isSafeInteger(targetViewerId) || targetViewerId <= 0) return null
    const session = await getSession(String(targetViewerId))
    if (!session) return null
    return resolvePlayerIdSync(session.accountId)
}
