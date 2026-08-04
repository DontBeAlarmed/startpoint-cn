import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { PrepareBody, SummonBody, RestoreRoomBody, ShareRoomBody } from "../types";
import { generateDataHeaders } from "../../utils";
import { serializeRoomStatusConnection } from "../room/serializer";
import { buildNpcMates } from "../npc/builder";
import { isValidMultiViewerId, type MultiHttpContext } from "./context";

async function hasValidViewer(context: MultiHttpContext, viewerId: number): Promise<boolean> {
    return isValidMultiViewerId(viewerId)
        && await context.resolvePlayerContext(viewerId) !== null;
}

function forbidden(reply: FastifyReply): FastifyReply {
    return reply.status(403).send({ "error": "Forbidden", "message": "Room permission denied." });
}

export function registerRoomRoutes(fastify: FastifyInstance, context: MultiHttpContext): void {

    // ---- prepare ----
    fastify.post("/prepare", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as PrepareBody;
        const viewerId = body.viewer_id;
        console.log(`[MULTI] prepare: viewer=${viewerId} room=${body.room_number}`);

        if (!await hasValidViewer(context, viewerId)) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Invalid request body."
            });
        }

        const roomNumber = typeof body.room_number === "string" && body.room_number.trim().length > 0
            ? body.room_number
            : null;
        const locator = roomNumber === null
            ? { accessToken: body.access_token || "" }
            : { roomNumber };
        const coordinatorInput = {
            participant: context.snapshotProvider.getParticipant(viewerId),
            compatibility: await context.snapshotProvider.getCompatibility(viewerId),
            ...locator,
        };
        const selectedRoom = await context.coordinator.selectRoom(coordinatorInput);

        if (!selectedRoom.ok) {
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

        if (selectedRoom.value.category !== body.category
            || selectedRoom.value.questId !== body.quest_id) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Room quest mismatch."
            });
        }

        const room = await context.coordinator.prepareRoom(coordinatorInput);
        if (!room.ok) {
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

        const data = serializeRoomStatusConnection(room.value);
        if (viewerId === room.value.host.viewerId) {
            data.raising_state = 1
        } else if (!room.value.hostOnline) {
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

        if (!await hasValidViewer(context, viewerId)) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Invalid request body."
            });
        }

        const room = await context.coordinator.getRoomStatus({
            participant: context.snapshotProvider.getParticipant(viewerId),
            roomNumber: body.room_number,
        });
        if (!room.ok) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Room doesn't exist."
            });
        }

        if (viewerId !== room.value.host.viewerId) return forbidden(reply);
        if (room.value.category !== body.category_id || room.value.questId !== body.quest_id) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Room quest mismatch."
            });
        }

        const mates = buildNpcMates(body.quest_id, room.value.category);

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

        if (!await hasValidViewer(context, viewerId)) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Invalid request body."
            });
        }

        const room = await context.coordinator.getRoomStatus({
            participant: context.snapshotProvider.getParticipant(viewerId),
            roomNumber: body.room_number,
        });
        if (!room.ok) {
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

        if (!room.value.members.some(member => member.viewerId === viewerId)) {
            reply.header("content-type", "application/x-msgpack");
            return reply.status(200).send({
                "data_headers": generateDataHeaders({ viewer_id: viewerId }),
                "data": {
                    application_update_url: "",
                    category_id: room.value.category,
                    host_entry_time: room.value.hostEntryTime,
                    ip_address: "",
                    port: 0,
                    quest_id: room.value.questId,
                    raising_state: 13,
                    room_number: room.value.roomNumber,
                    room_sequence: room.value.roomSequence,
                    share_room_options: room.value.shareRoomOptions,
                    is_pickup: null,
                    is_same_room: true,
                }
            });
        }

        const data = { ...serializeRoomStatusConnection(room.value), is_same_room: true };
        if (viewerId === room.value.host.viewerId) {
            data.raising_state = 1
        } else if (!room.value.hostOnline) {
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

        if (!await hasValidViewer(context, viewerId)) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Invalid request body."
            });
        }

        const room = await context.coordinator.getRoomStatus({
            participant: context.snapshotProvider.getParticipant(viewerId),
            roomNumber: body.room_number,
        });
        if (!room.ok || viewerId !== room.value.host.viewerId) return forbidden(reply);

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

        if (!await hasValidViewer(context, viewerId)) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Invalid request body."
            });
        }

        const result = await context.coordinator.disbandRoom({
            participant: context.snapshotProvider.getParticipant(viewerId),
            roomNumber: body.room_number,
        });
        if (!result.ok) return forbidden(reply);
        console.log(`[MULTI] room ${body.room_number} disbanded by viewer ${viewerId}`);

        reply.header("content-type", "application/x-msgpack");
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {}
        });
    });
}
