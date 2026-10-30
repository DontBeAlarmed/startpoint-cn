import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"
import { describeError } from "../describe-error"
import { GetRoomsBody, CreateRoomBody, SearchRoomBody, SelectRoomBody } from "../types"
import { getQuestFromCategorySync } from "../../lib/quest-content"
import { generateDataHeaders, realSecondsToVirtual } from "../../utils"
import { getRealNowMs } from "../../runtime/time/game-time"
import { lifecycleRegistry } from "../lifecycle"
import { serializeRoomStatusConnection } from "../room/serializer"
import { isValidMultiViewerId, type MultiHttpContext } from "./context"
import { classifyRoomJoin, roomUnavailableRaisingState } from "./join-result"
import { resolveRoomEstablisherFollowStateSafeSync } from "../follow-policy"
import { isQuestJoinAllowed } from "../../lib/quest-join-gate"
import { getPlayerSingleQuestProgressSync } from "../../data/domains/quest"
import { issueRoomAdmission } from "./room-admission"
import { listActiveRoomSharesAsync } from "../../data/domains/social-room-shares"
import { getSharedFollowRelationAsync } from "../../data/domains/social-follow"
import { parseEstablisherSnapshot } from "../../data/domains/attention"
import { resolveBattlePartyLeaderCharacterIdSync } from "../../lib/battle-party-leader"
import { projectLobbyRaisingState } from "../room/lobby-projection"

function isPositiveSafeInteger(value: number): boolean {
    return Number.isSafeInteger(value) && value > 0
}

/**
 * 好友房间大厅（房间条目渲染在关卡列表的房号输入格旁）。
 *
 * 数据源是 social_room_shares 注册表（share_room 持久化房主的可见性位），
 * 过滤用请求者与房主的真实 follow 关系（social_follows，mutual ⊃ single ⊃
 * none），establisher_follow 徽章与过滤同源。跨服计费/UI 的 follow=1 投影
 * 是 F0-F4 契约，不用于本过滤——可见性是房主的访问控制意图，投影会让
 * 互关房退化成全服房。bit3（随机招募）只走铃铛，注册表位掩码里本来就不含。
 */
async function buildFriendRoomLobby(viewerId: number, categoryId: number): Promise<Record<string, unknown>[]> {
    if (!Number.isSafeInteger(categoryId)) return []
    // F-06：共享注册行 TTL（expires_at）写侧锚真实钟，读侧同域——虚拟钟会恒判未过期
    const nowMs = getRealNowMs()
    const rooms: Record<string, unknown>[] = []
    // 注册表查询失败（如未初始化数据库的 stub/降级环境）→ 空列表安全终态：
    // get_rooms 任何情况下都不 500
    let rows: readonly {
        host_viewer_id: number
        share_bits: number
        category_id: number
        quest_id: number
        room_number: string
        raising_state: number
        mates: number
        establisher_json: string
    }[] = []
    try {
        rows = await listActiveRoomSharesAsync(categoryId, nowMs)
    } catch (error) {
        console.warn("[LOBBY] friend room registry unavailable, returning empty list", describeError(error))
        return rooms
    }
    for (const row of rows) {
        const relation = await getSharedFollowRelationAsync(viewerId, row.host_viewer_id)
        const visible = ((row.share_bits & 1) !== 0 && relation === "mutual")
            || ((row.share_bits & 2) !== 0 && relation !== "none")
        if (!visible) continue
        const snapshot = parseEstablisherSnapshot(row.establisher_json)
        rooms.push({
            category_id: row.category_id,
            quest_id: row.quest_id,
            room_number: row.room_number,
            establisher_name: snapshot.name ?? `Player${row.host_viewer_id}`,
            establisher_character: Number(snapshot.character) || 0,
            establisher_character_evolution_img_level: Number(snapshot.evolutionImgLevel) || 0,
            establisher_follow: relation === "mutual" ? 1 : 0,
            host_entry_time: realSecondsToVirtual(Number(snapshot.hostEntryTime) || 0),
            mates: row.mates,
            raising_state: projectLobbyRaisingState(row.room_number, row.host_viewer_id, row.raising_state),
            is_pickup: false,
        })
    }
    return rooms
}

function unavailableConnection(roomNumber: string, raisingState: 3 | 7 | 9) {
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
    }
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
            "data": { "rooms": await buildFriendRoomLobby(viewerId, body.category_id) }
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

        const compatibility = context.snapshotProvider.getCompatibility(request.headers)
        if (!compatibility.ok) return reply.status(400).send({
            "error": compatibility.error, "message": "Unable to create room."
        })

        const quest = getQuestFromCategorySync(category, quest_id)
        if (!quest) return reply.status(400).send({
            "error": "Bad Request", "message": "Quest doesn't exist."
        })
        const availability = context.questAvailability.check(category, quest_id)
        if (!availability.available) return reply.status(400).send({
            "error": availability.code, "message": "Unable to create room."
        })
        // R-G04：房主同样受领主战参加门约束（语义=未满足前置链不得开战该任务）
        if (!isQuestJoinAllowed(
            category,
            quest_id,
            (refCategory, refQuestId) => getPlayerSingleQuestProgressSync(ctx.playerId, refCategory, refQuestId),
        )) return reply.status(400).send({
            "error": "QUEST_NOT_AVAILABLE", "message": "Unable to create room."
        })

        const room = await context.coordinator.createRoom({
            requestId: `create_room:${viewer_id}:${body.api_count}`,
            participant: context.snapshotProvider.getParticipant(viewer_id),
            localPlayerId: ctx.playerId,
            partyId: party_id,
            category,
            questId: quest_id,
            // 房间主角色 = 本次所选战斗编队一号位（诚实展示当前配队状态；
            // 存档 leader 是社交层字段且历史账号停在种子默认值，不作依据）
            leaderCharacterId: resolveBattlePartyLeaderCharacterIdSync(
                ctx.playerId,
                party_id,
                ctx.player?.leaderCharacterId,
            ),
            compatibility: compatibility.value,
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

        const compatibility = context.snapshotProvider.getCompatibility(request.headers)
        const selected = compatibility.ok ? await context.coordinator.searchRoom({
            participant: context.snapshotProvider.getParticipant(viewerId),
            roomNumber: body.room_number,
            compatibility: compatibility.value,
        }) : compatibility
        const room = classifyRoomJoin(context.questAvailability, selected)
        if (room.kind === "unavailable") {
            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({
                "data_headers": generateDataHeaders({ viewer_id: viewerId, result_code: 4020 }),
                "data": {},
            })
        }
        const status = room.kind === "available" ? room.value : null
        const establisherFollow = status === null ? 0 : resolveRoomEstablisherFollowStateSafeSync({
            requester: context.snapshotProvider.getParticipant(viewerId),
            host: status.host,
            requesterPlayerId: ctx.playerId,
            hostPlayerId: (await context.resolvePlayerContext(status.host.viewerId))?.playerId ?? null,
        })
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "room_exists": status !== null,
                "category_id": status?.category ?? 0,
                "quest_id": status?.questId ?? 0,
                "room_number": status?.roomNumber ?? body.room_number,
                "establisher_viewer_id": status?.host.viewerId ?? 0,
                "establisher_follow": establisherFollow
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
        const compatibility = context.snapshotProvider.getCompatibility(request.headers)
        const selected = compatibility.ok ? await context.coordinator.selectRoom({
            participant: context.snapshotProvider.getParticipant(viewerId),
            compatibility: compatibility.value,
            ...locator,
        }) : compatibility
        const room = classifyRoomJoin(context.questAvailability, selected)
        if (room.kind !== "available") {
            const state = room.kind === "missing"
                ? 9
                : roomUnavailableRaisingState(room.error)
            console.log(`[MULTI] select_room unavailable`
                + ` error=${room.kind === "missing" ? "ROOM_NOT_FOUND" : room.error} → state=${state}`)
            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({
                "data_headers": generateDataHeaders({ viewer_id: viewerId }),
                "data": unavailableConnection(body.room_number || "", state),
            })
        }

        // R-G04：领主战参加门——加入者的任务进度必须满足 viewable 前置链
        // （主线关卡/前一档通关），堵住按房间号加入未解锁档位的跳关缺口
        if (room.kind === "available"
            && !isQuestJoinAllowed(
                room.value.category,
                room.value.questId,
                (refCategory, refQuestId) => getPlayerSingleQuestProgressSync(ctx.playerId, refCategory, refQuestId),
            )) {
            console.log(`[MULTI] select_room quest-gate blocked room=${room.value.roomNumber}`
                + ` quest=${room.value.questId} → state=7`)
            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({
                "data_headers": generateDataHeaders({ viewer_id: viewerId }),
                "data": unavailableConnection(
                    body.room_number || "",
                    roomUnavailableRaisingState("QUEST_NOT_AVAILABLE"),
                ),
            })
        }

        const participant = context.snapshotProvider.getParticipant(viewerId)
        const issued = await issueRoomAdmission(
            context,
            room.value.roomNumber,
            viewerId,
            participant,
        )
        if (!issued) return reply.status(400).send({
            "error": "Bad Request", "message": "Unable to snapshot player."
        })
        if (!issued.ok) {
            // 按真实错误种类投影（双审后用户实测钉死）：ROOM_FULL → 3 满员文案，
            // 写死 7 会把满员误报成"未满足参加条件"（NotPlayable）
            console.log(`[MULTI] select_room admission rejected room=${room.value.roomNumber}`
                + ` error=${issued.error} → state=${roomUnavailableRaisingState(issued.error)}`)
            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({
                "data_headers": generateDataHeaders({ viewer_id: viewerId }),
                "data": unavailableConnection(
                    room.value.roomNumber,
                    roomUnavailableRaisingState(issued.error),
                ),
            })
        }

        const selectData = serializeRoomStatusConnection(room.value, context.tcpEndpoint?.())
        // state 4（战斗/结算）期间的区分服务（用户实测钉死）：
        // - 房间成员（返回房间流程，含 prepare 链式重试）→ 2 等待横幅：
        //   等房主返回房间或超时判定已解散；不可回 4——prepare 远端的链式
        //   select 解析器对 4 抛 C5001（mac-c 实测）。
        // - 非成员（房间号直进的局外人）→ 4 已开战弹窗（立即明确）。
        // 房主返回房间经 prepare 路径释放状态（R-6）。
        if (viewerId === room.value.host.viewerId) {
            const hostIdentity = lifecycleRegistry.hostOf(room.value.roomNumber)
            if (hostIdentity !== undefined) {
                lifecycleRegistry.dispatch(room.value.roomNumber, generation => ({
                    type: "hostReturn",
                    generation,
                    identity: hostIdentity,
                    nowMs: getRealNowMs(),
                }))
            }
            selectData.raising_state = 1
            console.log(`[MULTI] select_room: host override raising_state → 1`)
        } else if (room.value.raisingState === 4) {
            const isMember = room.value.members.some(
                member => member.viewerId === viewerId,
            )
            selectData.raising_state = isMember ? 2 : 4
            console.log(`[MULTI] select_room: room in battle → state=${selectData.raising_state}`
                + ` member=${isMember}`)
        } else if (!room.value.hostOnline) {
            selectData.raising_state = 2
            console.log(`[MULTI] select_room: host offline, guest polls raising_state → 2`)
        }

        console.log(`[MULTI] select_room served room=${room.value.roomNumber}`
            + ` state=${selectData.raising_state}`)
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": selectData
        })
    })
}
