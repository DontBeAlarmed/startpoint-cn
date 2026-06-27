import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { PrepareBody, SummonBody, RestoreRoomBody, ShareRoomBody } from "../types";
import { generateDataHeaders } from "../../utils";
import { getRoom, getRoomByToken, updateHostEntryTime, disbandRoom } from "../room/manager";
import { serializeRoomConnection } from "../room/serializer";
import { sessionManager } from "../state/SessionManager";
import { buildNpcMates } from "../npc/builder";

export function registerRoomRoutes(fastify: FastifyInstance): void {

    // ---- prepare ----
    fastify.post("/prepare", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as PrepareBody;
        const viewerId = body.viewer_id;
        console.log(`[MULTI] prepare: viewer=${viewerId} room=${body.room_number}`);

        if (!viewerId || isNaN(viewerId)) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Invalid request body."
            });
        }

        const room = body.room_number
            ? getRoom(body.room_number)
            : getRoomByToken(body.access_token || "");

        if (!room) {
            reply.header("content-type", "application/x-msgpack");
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
                    is_pickup: null,
                }
            });
        }

        updateHostEntryTime(room.room_number);
        const data = serializeRoomConnection(room);
        if (viewerId === room.host_viewer_id) {
            data.raising_state = 1
        } else if (!sessionManager.isHostOnline(room.host_viewer_id, room.room_number)) {
            data.raising_state = 2
            console.log(`[MULTI] prepare: host offline, guest polls raising_state → 2`)
        }

        reply.header("content-type", "application/x-msgpack");
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": data,
        });
    });

    // ---- summon ----
    fastify.post("/summon", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as SummonBody;
        const viewerId = body.viewer_id;
        console.log(`[MULTI] summon: viewer=${viewerId} room=${body.room_number}`);

        if (!viewerId || isNaN(viewerId)) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Invalid request body."
            });
        }

        const room = getRoom(body.room_number);
        if (!room) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Room doesn't exist."
            });
        }

        const mates = buildNpcMates(body.quest_id, room.category);

        reply.header("content-type", "application/x-msgpack");
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "mate1": mates.mate1,
                "mate2": mates.mate2,
            }
        });
    });

    // ---- restore_room ----
    fastify.post("/restore_room", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as RestoreRoomBody;
        const viewerId = body.viewer_id;
        console.log(`[MULTI] restore_room: viewer=${viewerId} room=${body.room_number}`);

        if (!viewerId || isNaN(viewerId)) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Invalid request body."
            });
        }

        const room = getRoom(body.room_number);
        if (!room) {
            reply.header("content-type", "application/x-msgpack");
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
                    room_number: body.room_number,
                    room_sequence: 0,
                    share_room_options: 0,
                    is_pickup: null,
                    is_same_room: true,
                }
            });
        }

        const data = { ...serializeRoomConnection(room), is_same_room: true };
        if (viewerId === room.host_viewer_id) {
            data.raising_state = 1
        } else if (!sessionManager.isHostOnline(room.host_viewer_id, room.room_number)) {
            data.raising_state = 2
            console.log(`[MULTI] restore_room: host offline, guest polls raising_state → 2`)
        }

        reply.header("content-type", "application/x-msgpack");
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": data,
        });
    });

    // ---- share_room ----
    fastify.post("/share_room", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as ShareRoomBody;
        const viewerId = body.viewer_id;
        console.log(`[MULTI] share_room: viewer=${viewerId} room=${body.room_number}`);

        if (!viewerId || isNaN(viewerId)) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Invalid request body."
            });
        }

        reply.header("content-type", "application/x-msgpack");
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {}
        });
    });

    // ---- disband_room ----
    fastify.post("/disband_room", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as RestoreRoomBody;
        const viewerId = body.viewer_id;
        console.log(`[MULTI] disband_room: viewer=${viewerId} room=${body.room_number}`);

        if (!viewerId || isNaN(viewerId)) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Invalid request body."
            });
        }

        if (body.room_number) {
            sessionManager.broadcastToRoom(body.room_number, [1, [6, "multibattle_room_dismissed"]]);
            disbandRoom(body.room_number);
            console.log(`[MULTI] room ${body.room_number} disbanded by viewer ${viewerId}`);
        }

        reply.header("content-type", "application/x-msgpack");
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {}
        });
    });
}
