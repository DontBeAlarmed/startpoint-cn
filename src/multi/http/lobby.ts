import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"
import { GetRoomsBody, CreateRoomBody, SearchRoomBody, SelectRoomBody } from "../types"
import { getSession, getAccountPlayers, getPlayerSync } from "../../data/wdfpData"
import { getQuestFromCategorySync } from "../../lib/assets"
import { generateDataHeaders } from "../../utils"
import { createRoom, getRoom, getRoomByToken, getRooms } from "../room/manager"
import { serializeRoom, serializeRoomConnection } from "../room/serializer"
import { sessionManager } from "../state/SessionManager"

async function getViewerIdAndPlayer(viewerId: number): Promise<{ playerId: number; player: any } | null> {
    const sid = await getSession(viewerId.toString())
    if (!sid) return null
    const players = await getAccountPlayers(sid.accountId)
    if (!players || players.length === 0) return null
    const player = getPlayerSync(players[0])
    if (!player) return null
    return { playerId: players[0], player }
}

export function registerLobbyRoutes(fastify: FastifyInstance): void {

    fastify.post("/get_rooms", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as GetRoomsBody
        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        })
        const sid = await getSession(viewerId.toString())
        if (!sid) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id."
        })

        const rooms = getRooms(body.category_id, body.event_id)
            .filter(r => r.host_viewer_id === viewerId)
            .filter(r => sessionManager.hasRoomClients(r.room_number))
            .map(serializeRoom)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": { "rooms": rooms }
        })
    })

    fastify.post("/create_room", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as CreateRoomBody
        const { viewer_id, category, quest_id, party_id } = body
        if (!viewer_id || isNaN(viewer_id)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        })
        const ctx = await getViewerIdAndPlayer(viewer_id)
        if (!ctx) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id or no player bound."
        })

        const quest = getQuestFromCategorySync(category, quest_id)
        if (!quest) return reply.status(400).send({
            "error": "Bad Request", "message": "Quest doesn't exist."
        })

        const room = createRoom(
            viewer_id,
            ctx.playerId,
            party_id,
            category,
            quest_id,
            0,
            ctx.player?.leaderCharacterId || 1
        )

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id }),
            "data": {
                "access_token": room.access_token,
                "room_number": room.room_number,
                "room_url": ""
            }
        })
    })

    fastify.post("/search_room", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as SearchRoomBody
        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        })
        const sid = await getSession(viewerId.toString())
        if (!sid) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id."
        })

        const room = getRoom(body.room_number)
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "room_exists": !!room,
                "category_id": room?.category ?? 0,
                "quest_id": room?.quest_id ?? 0,
                "room_number": room?.room_number ?? body.room_number,
                "establisher_viewer_id": room?.host_viewer_id ?? 0,
                "establisher_follow": 0
            }
        })
    })

    fastify.post("/select_room", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as SelectRoomBody
        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        })
        const ctx = await getViewerIdAndPlayer(viewerId)
        if (!ctx) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id or no player bound."
        })

        const room = body.room_number ? getRoom(body.room_number) : getRoomByToken(body.access_token || "")
        if (!room) {
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

        const selectData = serializeRoomConnection(room)
        if (viewerId === room.host_viewer_id) {
            selectData.raising_state = 1
        }

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": selectData
        })
    })
}
