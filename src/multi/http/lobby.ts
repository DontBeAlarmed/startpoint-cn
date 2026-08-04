import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"
import { GetRoomsBody, CreateRoomBody, SearchRoomBody, SelectRoomBody } from "../types"
import { getQuestFromCategorySync } from "../../lib/assets"
import { generateDataHeaders } from "../../utils"
import { serializeRoomStatusConnection } from "../room/serializer"
import { isValidMultiViewerId, type MultiHttpContext } from "./context"

function isPositiveSafeInteger(value: number): boolean {
    return Number.isSafeInteger(value) && value > 0
}

export function registerLobbyRoutes(fastify: FastifyInstance, context: MultiHttpContext): void {

    fastify.post("/get_rooms", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as GetRoomsBody
        const viewerId = body.viewer_id
        if (!isValidMultiViewerId(viewerId)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        })
        const ctx = await context.resolvePlayerContext(viewerId)
        if (!ctx) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id."
        })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": { "rooms": [] }
        })
    })

    fastify.post("/create_room", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as CreateRoomBody
        const { viewer_id, category, quest_id, party_id } = body
        if (!isValidMultiViewerId(viewer_id)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        })
        if (![party_id, category, quest_id].every(isPositiveSafeInteger)) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Invalid request body."
            })
        }
        const ctx = await context.resolvePlayerContext(viewer_id)
        if (!ctx) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id or no player bound."
        })

        const quest = getQuestFromCategorySync(category, quest_id)
        if (!quest) return reply.status(400).send({
            "error": "Bad Request", "message": "Quest doesn't exist."
        })

        const room = await context.coordinator.createRoom({
            requestId: `create_room:${viewer_id}:${body.api_count}`,
            participant: context.snapshotProvider.getParticipant(viewer_id),
            localPlayerId: ctx.playerId,
            partyId: party_id,
            category,
            questId: quest_id,
            leaderCharacterId: ctx.player?.leaderCharacterId || 1,
            compatibility: await context.snapshotProvider.getCompatibility(viewer_id),
        })
        if (!room.ok) return reply.status(400).send({
            "error": "Bad Request", "message": "Unable to create room."
        })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id }),
            "data": {
                "access_token": room.value.accessToken,
                "room_number": room.value.roomNumber,
                "room_url": ""
            }
        })
    })

    fastify.post("/search_room", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as SearchRoomBody
        const viewerId = body.viewer_id
        if (!isValidMultiViewerId(viewerId)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        })
        const ctx = await context.resolvePlayerContext(viewerId)
        if (!ctx) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id."
        })

        const room = await context.coordinator.searchRoom({
            participant: context.snapshotProvider.getParticipant(viewerId),
            roomNumber: body.room_number,
            compatibility: await context.snapshotProvider.getCompatibility(viewerId),
        })
        const status = room.ok ? room.value : null
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "room_exists": status !== null,
                "category_id": status?.category ?? 0,
                "quest_id": status?.questId ?? 0,
                "room_number": status?.roomNumber ?? body.room_number,
                "establisher_viewer_id": status?.host.viewerId ?? 0,
                "establisher_follow": 0
            }
        })
    })

    fastify.post("/select_room", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as SelectRoomBody
        const viewerId = body.viewer_id
        if (!isValidMultiViewerId(viewerId)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        })
        const ctx = await context.resolvePlayerContext(viewerId)
        if (!ctx) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id or no player bound."
        })

        const roomNumber = typeof body.room_number === "string" && body.room_number.trim().length > 0
            ? body.room_number
            : null
        const locator = roomNumber === null
            ? { accessToken: body.access_token || "" }
            : { roomNumber }
        const room = await context.coordinator.selectRoom({
            participant: context.snapshotProvider.getParticipant(viewerId),
            compatibility: await context.snapshotProvider.getCompatibility(viewerId),
            ...locator,
        })
        if (!room.ok) {
            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({
                "data_headers": generateDataHeaders({ viewer_id: viewerId }),
                "data": {
                    application_update_url: "",
                    category_id: 0,
                    host_entry_time: 0,
                    ip_address: "",
                    port: 0,
                    quest_id: 0,
                    raising_state: 9,
                    room_number: body.room_number || "",
                    room_sequence: 0,
                    share_room_options: 0,
                    is_pickup: null
                }
            })
        }

        const selectData = serializeRoomStatusConnection(room.value)
        if (viewerId === room.value.host.viewerId) {
            selectData.raising_state = 1
            console.log(`[MULTI] select_room: host override raising_state → 1`)
        } else if (!room.value.hostOnline) {
            selectData.raising_state = 2
            console.log(`[MULTI] select_room: host offline, guest polls raising_state → 2`)
        }

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": selectData
        })
    })
}
