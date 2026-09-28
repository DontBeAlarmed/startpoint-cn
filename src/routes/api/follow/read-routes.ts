import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { generateDataHeaders } from "../../../utils"
import {
    countLocalFollowersSync,
    listLocalFollowerSourcesSync,
    listLocalFollowTargetsSync,
} from "../../../data/domains/follow"
import { resolveFollowTarget, resolveFollowViewer } from "./context"
import { projectRelationFor } from "./profile"

function ok(viewerId: number, data: Record<string, unknown>, reply: FastifyReply) {
    reply.header("content-type", "application/x-msgpack")
    return reply.status(200).send({
        data_headers: generateDataHeaders({ viewer_id: viewerId }),
        data,
    })
}

function aError(viewerId: number, resultCode: number, reply: FastifyReply) {
    reply.header("content-type", "application/x-msgpack")
    return reply.status(200).send({
        data_headers: generateDataHeaders({ viewer_id: viewerId, result_code: resultCode }),
        data: {},
    })
}

function parseSearchViewerId(value: unknown): number | null {
    if (typeof value === "number") {
        return Number.isSafeInteger(value) && value > 0 ? value : null
    }
    if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
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
        const parsedSearchId = parseSearchViewerId(searchId)
        if (parsedSearchId === null) {
            return reply.status(400).send({ error: "Bad Request", message: "Invalid request body." })
        }
        const targetPlayerId = await resolveFollowTarget(parsedSearchId)
        if (targetPlayerId === null) {
            return aError(viewer.viewerId, 1457, reply)
        }
        const projected = projectRelationFor(viewer.playerId, targetPlayerId)
        if (projected === null) {
            return aError(viewer.viewerId, 1457, reply)
        }
        return ok(viewer.viewerId, { search_result: projected }, reply)
    })
}
