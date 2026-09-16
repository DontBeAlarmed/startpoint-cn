import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { generateDataHeaders } from "../../../utils"
import {
    countLocalFollowersSync,
    listLocalFollowerSourcesSync,
    listLocalFollowTargetsSync,
} from "../../../data/domains/follow"
import { resolveFollowTarget, resolveFollowViewer } from "./context"
import { emptyFollowUserProjection, projectRelationFor } from "./profile"

function ok(viewerId: number, data: Record<string, unknown>, reply: FastifyReply) {
    reply.header("content-type", "application/x-msgpack")
    return reply.status(200).send({
        data_headers: generateDataHeaders({ viewer_id: viewerId }),
        data,
    })
}

export function registerFollowReadRoutes(fastify: FastifyInstance): void {
    // follow/lists：与当前玩家有任一方向边的同服玩家 + 被关注数
    fastify.post("/lists", async (request: FastifyRequest, reply: FastifyReply) => {
        const viewer = await resolveFollowViewer(request, reply)
        if (viewer === null) return
        const targetIds = listLocalFollowTargetsSync(viewer.playerId)
        const followerIds = listLocalFollowerSourcesSync(viewer.playerId)
        const seen = new Set<number>()
        const followInfo = []
        for (const targetId of [...targetIds, ...followerIds]) {
            if (seen.has(targetId)) continue
            seen.add(targetId)
            const projected = projectRelationFor(viewer.playerId, targetId)
            if (projected !== null) followInfo.push(projected)
        }
        followInfo.sort((left, right) => (
            (right.last_login_time ?? 0) - (left.last_login_time ?? 0)
            || (left.viewer_id ?? 0) - (right.viewer_id ?? 0)
        ))
        return ok(viewer.viewerId, {
            follow_info: followInfo,
            followed_count: countLocalFollowersSync(viewer.playerId),
        }, reply)
    })

    // follow/search_id：只解析本地 session（同服边界）
    fastify.post("/search_id", async (request: FastifyRequest, reply: FastifyReply) => {
        const viewer = await resolveFollowViewer(request, reply)
        if (viewer === null) return
        const searchId = (request.body as { search_id?: unknown })?.search_id
        if (!Number.isSafeInteger(searchId) || (searchId as number) <= 0) {
            return reply.status(400).send({ error: "Bad Request", message: "Invalid request body." })
        }
        const targetPlayerId = await resolveFollowTarget(searchId as number)
        if (targetPlayerId === null) {
            return ok(viewer.viewerId, { search_result: emptyFollowUserProjection() }, reply)
        }
        const projected = projectRelationFor(viewer.playerId, targetPlayerId)
        if (projected === null) {
            return ok(viewer.viewerId, { search_result: emptyFollowUserProjection() }, reply)
        }
        return ok(viewer.viewerId, { search_result: projected }, reply)
    })
}
