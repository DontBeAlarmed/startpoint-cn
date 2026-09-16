import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { generateDataHeaders } from "../../../utils"
import { getRealNowMs } from "../../../runtime/time/game-time"
import {
    addLocalFollowSync,
    bulkEditLocalFollowsSync,
    deleteLocalFollowerSync,
    deleteLocalFollowSync,
} from "../../../data/domains/follow"
import { resolveFollowTarget, resolveFollowViewer } from "./context"

// F0 冻结：add 的 A-error 1451=我方关注超限（FollowCountOver）、
// 1452=对方被关注超限（PartnerFollowedCountOver）；其余业务结果按官方语义。
const ADD_FAILURE_RESULT_CODE: Record<string, number> = {
    source_limit: 1451,
    target_limit: 1452,
}

function ok(viewerId: number, reply: FastifyReply) {
    reply.header("content-type", "application/x-msgpack")
    return reply.status(200).send({
        data_headers: generateDataHeaders({ viewer_id: viewerId }),
        data: {},
    })
}

function aError(viewerId: number, resultCode: number, reply: FastifyReply) {
    reply.header("content-type", "application/x-msgpack")
    return reply.status(200).send({
        data_headers: generateDataHeaders({ viewer_id: viewerId, result_code: resultCode }),
        data: {},
    })
}

function badRequest(reply: FastifyReply, message = "Invalid request body.") {
    return reply.status(400).send({ error: "Bad Request", message })
}

export function registerFollowWriteRoutes(fastify: FastifyInstance): void {
    fastify.post("/add", async (request: FastifyRequest, reply: FastifyReply) => {
        const viewer = await resolveFollowViewer(request, reply)
        if (viewer === null) return
        const followId = (request.body as { follow_id?: unknown })?.follow_id
        if (!Number.isSafeInteger(followId) || (followId as number) <= 0) return badRequest(reply)
        const targetPlayerId = await resolveFollowTarget(followId as number)
        if (targetPlayerId === null) return badRequest(reply, "Unknown follow target.")
        // 自关注按幂等成功处理（客户端 UI 不会发出；服务端不产生边）
        if (targetPlayerId === viewer.playerId) return ok(viewer.viewerId, reply)

        const result = addLocalFollowSync({
            sourcePlayerId: viewer.playerId,
            targetPlayerId,
            followedAtMs: getRealNowMs(),
        })
        if (result.ok) return ok(viewer.viewerId, reply)
        const resultCode = ADD_FAILURE_RESULT_CODE[result.reason]
        if (resultCode === undefined) return badRequest(reply, "Invalid follow target.")
        return aError(viewer.viewerId, resultCode, reply)
    })

    fastify.post("/delete", async (request: FastifyRequest, reply: FastifyReply) => {
        const viewer = await resolveFollowViewer(request, reply)
        if (viewer === null) return
        const followId = (request.body as { follow_id?: unknown })?.follow_id
        if (!Number.isSafeInteger(followId) || (followId as number) <= 0) return badRequest(reply)
        const targetPlayerId = await resolveFollowTarget(followId as number)
        if (targetPlayerId === null) return badRequest(reply, "Unknown follow target.")
        deleteLocalFollowSync({ sourcePlayerId: viewer.playerId, targetPlayerId })
        return ok(viewer.viewerId, reply)
    })

    fastify.post("/delete_followed", async (request: FastifyRequest, reply: FastifyReply) => {
        const viewer = await resolveFollowViewer(request, reply)
        if (viewer === null) return
        const followedId = (request.body as { followed_id?: unknown })?.followed_id
        if (!Number.isSafeInteger(followedId) || (followedId as number) <= 0) return badRequest(reply)
        const followerPlayerId = await resolveFollowTarget(followedId as number)
        if (followerPlayerId === null) return badRequest(reply, "Unknown follower target.")
        deleteLocalFollowerSync({ playerId: viewer.playerId, followerPlayerId })
        return ok(viewer.viewerId, reply)
    })

    fastify.post("/bulk_edit", async (request: FastifyRequest, reply: FastifyReply) => {
        const viewer = await resolveFollowViewer(request, reply)
        if (viewer === null) return
        const body = request.body as {
            add_follow_id_list?: unknown
            delete_follow_id_list?: unknown
        }
        const addList = body?.add_follow_id_list
        const deleteList = body?.delete_follow_id_list
        if (!Array.isArray(addList) || !Array.isArray(deleteList)) return badRequest(reply)
        if (addList.length + deleteList.length === 0) return ok(viewer.viewerId, reply)

        const addTargetPlayerIds: number[] = []
        for (const followId of addList) {
            if (!Number.isSafeInteger(followId)) return badRequest(reply)
            const targetPlayerId = await resolveFollowTarget(followId)
            if (targetPlayerId === null) return badRequest(reply, "Unknown follow target.")
            addTargetPlayerIds.push(targetPlayerId)
        }
        const deleteTargetPlayerIds: number[] = []
        for (const followId of deleteList) {
            if (!Number.isSafeInteger(followId)) return badRequest(reply)
            const targetPlayerId = await resolveFollowTarget(followId)
            if (targetPlayerId === null) return badRequest(reply, "Unknown follow target.")
            deleteTargetPlayerIds.push(targetPlayerId)
        }

        const result = bulkEditLocalFollowsSync({
            sourcePlayerId: viewer.playerId,
            addTargetPlayerIds,
            deleteTargetPlayerIds,
            followedAtMs: getRealNowMs(),
        })
        if (result.ok) return ok(viewer.viewerId, reply)
        const resultCode = ADD_FAILURE_RESULT_CODE[result.reason]
        if (resultCode === undefined) return badRequest(reply, "Invalid follow target.")
        return aError(viewer.viewerId, resultCode, reply)
    })
}
