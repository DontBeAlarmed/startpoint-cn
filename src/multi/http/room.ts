import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { PrepareBody, SummonBody, RestoreRoomBody, ShareRoomBody } from "../types";
import { generateDataHeaders, getServerTime } from "../../utils";
import { serializeRoomStatusConnection } from "../room/serializer";
import { buildNpcMates } from "../npc/builder";
import { isValidMultiViewerId, type MultiHttpContext } from "./context";
import type { CoordinatorErrorCode } from "../coordinator/contracts";
import { classifyRoomJoin } from "./join-result";
import {
    prepareFailureRaisingState,
    restoreRoomUnavailableRaisingState,
} from "./join-result";
import { issueRoomAdmission } from "./room-admission";
import {
    buildEstablisherSnapshot,
    closeRecruitmentForRoom,
    getOrCreateRecruitmentForRoom,
    pruneExpiredRecruitments,
} from "../../data/domains/attention";
import { isNewbieHostSync } from "../../lib/newbie-host";
import { getPlayerRankLevel } from "../player-context";

async function hasValidViewer(context: MultiHttpContext, viewerId: number): Promise<boolean> {
    return isValidMultiViewerId(viewerId)
        && await context.resolvePlayerContext(viewerId) !== null;
}

function forbidden(reply: FastifyReply): FastifyReply {
    return reply.status(403).send({ "error": "Forbidden", "message": "Room permission denied." });
}

function hubUnavailable(reply: FastifyReply): FastifyReply {
    return reply.status(503).send({
        "error": "Service Unavailable",
        "code": "HUB_UNAVAILABLE",
        "message": "Multiplayer service is unavailable.",
    });
}

function prepareFailure(
    reply: FastifyReply,
    viewerId: number,
    roomNumber: string,
    error: CoordinatorErrorCode,
): FastifyReply {
    reply.header("content-type", "application/x-msgpack");
    // prepare 客户端仅 1/2/9 合法；只有 ROOM_NOT_FOUND 走 raising_state(9)，
    // 其余（含满房）走 A-error 4507 → Failure。
    const raisingState = prepareFailureRaisingState(error);
    if (raisingState !== null) return reply.status(200).send({
        "data_headers": generateDataHeaders({ viewer_id: viewerId }),
        "data": unavailableRoomData(roomNumber, raisingState),
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

        const issued = await issueRoomAdmission(
            context,
            room.value.roomNumber,
            viewerId,
            coordinatorInput.participant,
        )
        if (!issued) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Unable to snapshot player."
            })
        }
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
            if (room.error === "HUB_UNAVAILABLE") return hubUnavailable(reply);
            if (room.error === "ROOM_PERMISSION_DENIED") return forbidden(reply);
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
                        restoreRoomUnavailableRaisingState(room.error),
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
    // 铃铛招募落点。客户端两种语义（RoomShareType 1=互关 2=粉丝 3=随机招募）：
    // 仅 share_type_list 含 3 才创建/刷新招募行——含 3 时客户端把 3 移出列表走
    // startRecruit 定时器（重发恒为 [3]），纯 [1]/[2] 一次性分享不广播铃铛。
    // 房主每 15s 重发（上限 20 次），幂等 get-or-create（同房间恒定 attention_key）
    // + 刷新过期时间与房主快照。客户端忽略响应体；招募记账尽力而为，失败不 500。
    fastify.post("/share_room", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as ShareRoomBody;
        const viewerId = body.viewer_id;
        console.log("[MULTI] share_room received");

        if (!isValidMultiViewerId(viewerId)) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Invalid request body."
            });
        }
        const hostContext = await context.resolvePlayerContext(viewerId);
        if (hostContext === null) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Invalid request body."
            });
        }

        const room = await context.coordinator.getRoomStatus({
            participant: context.snapshotProvider.getParticipant(viewerId),
            roomNumber: body.room_number,
        });
        if (!room.ok) {
            if (room.error === "HUB_UNAVAILABLE") return hubUnavailable(reply);
            return forbidden(reply);
        }
        if (viewerId !== room.value.host.viewerId) return forbidden(reply);

        const wantsRecruitment = Array.isArray(body.share_type_list)
            && body.share_type_list.includes(3);
        if (wantsRecruitment) {
            // 尽力而为：招募落库/过期清理失败不得阻断分享主流程（15s 重发自愈）
            try {
                const recruitment = getOrCreateRecruitmentForRoom({
                    hostPid: hostContext.playerId,
                    hostViewerId: viewerId,
                    category: room.value.category,
                    questId: room.value.questId,
                    roomNumber: body.room_number,
                    isNewbieHost: isNewbieHostSync(hostContext.playerId),
                    establisherJson: buildEstablisherSnapshot({
                        character: room.value.hostMainCharacterId,
                        rankLevel: getPlayerRankLevel(hostContext.player.rankPoint ?? 0),
                        hostEntryTime: room.value.hostEntryTime,
                    }),
                    nowMs: getServerTime() * 1000,
                });
                console.log(`[MULTI] share_room ${recruitment.created ? "created" : "refreshed"} key=${recruitment.attentionKey}`);
                pruneExpiredRecruitments(getServerTime() * 1000);
            } catch (error) {
                console.warn("[MULTI] share_room recruitment bookkeeping failed", error);
            }
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
        if (!result.ok && result.error === "HUB_UNAVAILABLE") return hubUnavailable(reply);
        if (!result.ok && result.error !== "ROOM_NOT_FOUND") return forbidden(reply);
        console.log(result.ok ? "[MULTI] room disbanded" : "[MULTI] room already absent");
        if (result.ok) {
            // 尽力而为的铃铛卫生操作：绝不能让招募关闭失败破坏解散主流程
            try {
                closeRecruitmentForRoom(viewerId, body.room_number);
            } catch (error) {
                console.warn("[MULTI] close recruitment on disband failed", error);
            }
        }

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
