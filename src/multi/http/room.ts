import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { PrepareBody, SummonBody, RestoreRoomBody, ShareRoomBody } from "../types";
import { generateDataHeaders } from "../../utils";
import { serializeRoomStatusConnection } from "../room/serializer";
import { buildNpcMates } from "../npc/builder";
import { isValidMultiViewerId, type MultiHttpContext } from "./context";
import type { CoordinatorErrorCode } from "../coordinator/contracts";
import { classifyRoomJoin } from "./join-result";

async function hasValidViewer(context: MultiHttpContext, viewerId: number): Promise<boolean> {
    return isValidMultiViewerId(viewerId)
        && await context.resolvePlayerContext(viewerId) !== null;
}

function forbidden(reply: FastifyReply): FastifyReply {
    return reply.status(403).send({ "error": "Forbidden", "message": "Room permission denied." });
}

function prepareFailure(
    reply: FastifyReply,
    viewerId: number,
    roomNumber: string,
    error: CoordinatorErrorCode,
): FastifyReply {
    reply.header("content-type", "application/x-msgpack");
    if (error === "ROOM_NOT_FOUND") return reply.status(200).send({
        "data_headers": generateDataHeaders({ viewer_id: viewerId }),
        "data": unavailableRoomData(roomNumber, 9),
    });
    return reply.status(200).send({
        "data_headers": generateDataHeaders({ viewer_id: viewerId, result_code: 4507 }),
        "data": {},
    });
}

export function registerRoomRoutes(fastify: FastifyInstance, context: MultiHttpContext): void {

    // ---- prepare ----
    fastify.post("/prepare", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as PrepareBody;
        const viewerId = body.viewer_id;
        console.log("[MULTI] prepare received");

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
        const compatibility = context.snapshotProvider.getCompatibility(request.headers);
        if (!compatibility.ok) {
            return prepareFailure(reply, viewerId, body.room_number || "", compatibility.error);
        }
        const coordinatorInput = {
            participant: context.snapshotProvider.getParticipant(viewerId),
            compatibility: compatibility.value,
            ...locator,
        };
        const selected = await context.coordinator.selectRoom(coordinatorInput);
        const selectedRoom = classifyRoomJoin(context.questAvailability, selected);

        if (selectedRoom.kind !== "available") {
            return prepareFailure(reply, viewerId, body.room_number || "", selectedRoom.error);
        }

        if (selectedRoom.value.category !== body.category
            || selectedRoom.value.questId !== body.quest_id) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Room quest mismatch."
            });
        }

        const prepared = await context.coordinator.prepareRoom(coordinatorInput);
        const room = classifyRoomJoin(context.questAvailability, prepared);
        if (room.kind !== "available") {
            return prepareFailure(reply, viewerId, body.room_number || "", room.error);
        }

        const preparedAdmission = await context.snapshotProvider.prepareAdmission(viewerId)
        if (!preparedAdmission) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Unable to snapshot player."
            })
        }
        const issued = await context.admissionIssuer.issue({
            roomNumber: room.value.roomNumber,
            participant: coordinatorInput.participant,
            snapshot: preparedAdmission.snapshot,
            expiresAt: context.now() + context.admissionTtlMs,
        })
        if (!issued.ok) {
            return prepareFailure(reply, viewerId, room.value.roomNumber, issued.error)
        }

        const data = serializeRoomStatusConnection(room.value, context.tcpEndpoint?.());
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
        console.log("[MULTI] summon received");

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
        console.log("[MULTI] restore_room received");

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
                    ...unavailableRoomData(
                        body.room_number,
                        room.error === "ROOM_NOT_FOUND" ? 9 : 13,
                    ),
                    is_same_room: true,
                },
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

        const data = {
            ...serializeRoomStatusConnection(room.value, context.tcpEndpoint?.()),
            is_same_room: true,
        };
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
        console.log("[MULTI] share_room received");

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
        console.log("[MULTI] disband_room received");

        if (!await hasValidViewer(context, viewerId)) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Invalid request body."
            });
        }

        const result = await context.coordinator.disbandRoom({
            participant: context.snapshotProvider.getParticipant(viewerId),
            roomNumber: body.room_number,
        });
        if (!result.ok && result.error !== "ROOM_NOT_FOUND") return forbidden(reply);
        console.log(result.ok ? "[MULTI] room disbanded" : "[MULTI] room already absent");

        reply.header("content-type", "application/x-msgpack");
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {}
        });
    });
}

function unavailableRoomData(roomNumber: string, raisingState: number): Record<string, unknown> {
    return {
        application_update_url: "",
        category_id: 0,
        host_entry_time: 0,
        ip_address: "",
        port: 0,
        quest_id: 0,
        raising_state: raisingState,
        room_number: roomNumber,
        room_sequence: 0,
        share_room_options: 0,
        is_pickup: null,
    };
}
