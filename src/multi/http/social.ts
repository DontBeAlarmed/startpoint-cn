import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"
import { VerifyAccessTokenBody, MicroCommunityBody } from "../types"
import { generateDataHeaders } from "../../utils"
import { getRoomByToken } from "../room/manager"
import { getPlayerRankLevel, resolveMultiPlayerContext } from "../player-context"

export function registerSocialRoutes(fastify: FastifyInstance): void {

    fastify.post("/verify_access_token", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as VerifyAccessTokenBody
        const viewerId = body.viewer_id
        const ctx = Number.isSafeInteger(viewerId) && viewerId > 0
            ? await resolveMultiPlayerContext(viewerId)
            : null
        if (!ctx) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id."
        })

        const room = getRoomByToken(body.access_token || "")
        if (!room) {
            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({
                "data_headers": generateDataHeaders({ viewer_id: viewerId }),
                "data": { "room_exists": false }
            })
        }

        const host = await resolveMultiPlayerContext(room.host_viewer_id)
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                room_exists: true,
                category_id: room.category,
                establisher: room.host_viewer_id,
                establisher_character: room.host_main_character_id,
                establisher_character_evolution_img_level: 0,
                establisher_follow: 0,
                establisher_name: host?.player.name ?? `Player${room.host_viewer_id}`,
                establisher_rank: getPlayerRankLevel(host?.player.rankPoint ?? 0),
                host_entry_time: room.host_entry_time,
                quest_id: room.quest_id,
                room_number: room.room_number,
            }
        })
    })

    fastify.post("/micro_community", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as MicroCommunityBody
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: body.viewer_id }),
            "data": {}
        })
    })

    fastify.post("/publish_room", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as MicroCommunityBody
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: body.viewer_id }),
            "data": { success: false }
        })
    })
}
