import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"
import { VerifyAccessTokenBody, MicroCommunityBody } from "../types"
import { generateDataHeaders } from "../../utils"
import { getPlayerRankLevel } from "../player-context"
import { isValidMultiViewerId, type MultiHttpContext } from "./context"
import type { CoordinatorResult } from "../coordinator/contracts"
import type { RoomStatus } from "../coordinator/interface"

function checkLocalAvailability(
    context: MultiHttpContext,
    room: CoordinatorResult<RoomStatus>,
): CoordinatorResult<RoomStatus> {
    if (!room.ok) return room
    return context.questAvailability.check(room.value.category, room.value.questId).available
        ? room
        : { ok: false, error: "QUEST_NOT_AVAILABLE" }
}

export function registerSocialRoutes(fastify: FastifyInstance, context: MultiHttpContext): void {

    fastify.post("/verify_access_token", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as VerifyAccessTokenBody
        const viewerId = body.viewer_id
        const ctx = isValidMultiViewerId(viewerId)
            ? await context.resolvePlayerContext(viewerId)
            : null
        if (!ctx) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id."
        })

        const compatibility = context.snapshotProvider.getCompatibility(request.headers)
        const selected = compatibility.ok ? await context.coordinator.selectRoom({
            participant: context.snapshotProvider.getParticipant(viewerId),
            accessToken: body.access_token || "",
            compatibility: compatibility.value,
        }) : compatibility
        const room = checkLocalAvailability(context, selected)
        if (!room.ok && room.error !== "ROOM_NOT_FOUND") {
            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({
                "data_headers": generateDataHeaders({ viewer_id: viewerId, result_code: 4020 }),
                "data": {},
            })
        }
        if (!room.ok) {
            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({
                "data_headers": generateDataHeaders({ viewer_id: viewerId }),
                "data": { "room_exists": false }
            })
        }

        const host = await context.resolvePlayerContext(room.value.host.viewerId)
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                room_exists: true,
                category_id: room.value.category,
                establisher: room.value.host.viewerId,
                establisher_character: room.value.hostMainCharacterId,
                establisher_character_evolution_img_level: 0,
                establisher_follow: 0,
                establisher_name: host?.player.name ?? `Player${room.value.host.viewerId}`,
                establisher_rank: getPlayerRankLevel(host?.player.rankPoint ?? 0),
                host_entry_time: room.value.hostEntryTime,
                quest_id: room.value.questId,
                room_number: room.value.roomNumber,
            }
        })
    })

    fastify.post("/micro_community", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as MicroCommunityBody
        if (!isValidMultiViewerId(body.viewer_id)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        })
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: body.viewer_id }),
            "data": {}
        })
    })

    fastify.post("/publish_room", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as MicroCommunityBody
        if (!isValidMultiViewerId(body.viewer_id)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        })
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: body.viewer_id }),
            "data": { success: false }
        })
    })
}
