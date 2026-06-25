import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { deletePlayerRushEventPlayedPartyListSync, getPlayerRushEventPlayedPartiesSync, getPlayerRushEventSync, getPlayerSingleQuestProgressSync, getPlayerSync, getSession, insertPlayerQuestProgressSync, insertPlayerRushEventClearedFolderSync, insertPlayerRushEventPlayedPartySync, deletePlayerActiveQuestSync, updatePlayerActiveQuestContinueCountSync, updatePlayerQuestProgressSync, updatePlayerRushEventSync, updatePlayerSync } from "../../data/wdfpData";
import { getQuestFromCategorySync, getRushEventFolderClearRewards } from "../../lib/assets";
import { getCharactersEvolutionImgLevels, givePlayerCharactersExpSync } from "../../lib/character";
import { givePlayerRewardsSync, givePlayerRewardSync, givePlayerScoreRewardsSync } from "../../lib/quest";
import { BattleQuest, EquipmentItemReward, MultiMate, MultiMateParty, PlayerRewardResult, QuestCategory } from "../../lib/types";
import { generateDataHeaders, getServerTime } from "../../utils";
import { createRoom, disbandRoom, getDisplayHost, getNpcMates, getRoom, getRoomByToken, getRooms, serializeRoom, serializeRoomConnection, updateHostEntryTime, updateRoomState } from "../../data/multiRoom";
import { hasRoomClients, notifyRoomDisbanded, isHostOnline } from "../../data/sessionServer";
import { insertActiveQuest, activeQuests } from "./singleBattleQuest";
import { computeRealTimeStamina, getRankDegree, getMaxStamina } from "../../lib/stamina";
import { RushEventBattleType, UserRushEventPlayedParty } from "../../data/types";
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { getSerializedPlayerRushEventPlayedPartiesSync } from "../../lib/rush";
import { rushEventFolderMaxRounds } from "./rushEvent";

interface GetRoomsBody {
    event_id?: number
    viewer_id: number
    category_id: number
}

interface CreateRoomBody {
    category: number
    party_id: number
    quest_id: number
    viewer_id: number
    api_count: number
}

interface SearchRoomBody {
    room_number: string
    viewer_id: number
    api_count: number
}

interface SelectRoomBody {
    category: number
    quest_id: number
    party_id: number
    accepted_type: number
    viewer_id: number
    room_number?: string
    access_token?: string
    api_count: number
}

interface PrepareBody {
    category: number
    quest_id: number
    viewer_id: number
    room_number?: string
    access_token?: string
    api_count: number
}

interface SummonBody {
    category_id: number
    quest_id: number
    room_number: string
    viewer_id: number
    api_count: number
}

interface MultiStartBody {
    quest_id: number
    use_boss_boost_point: boolean
    use_boost_point: boolean
    category: number
    viewer_id: number
    play_id: string
    is_auto_start_mode: boolean
    party_id: number
    api_count: number
    room_number: string
    mate_player_ids: number[]
    mate_party_ids: Array<{
        party_id: number
        characters: Array<{ id: number, evolution_level: number, exp: number, over_limit_step?: number }>
        unison_characters?: Array<{ id: number, evolution_level: number, exp: number }>
        equipments: Array<{ equipment_id: number, level: number, enhancement_level: number }>
        ability_soul_ids?: (number | null)[]
    }>
    attention_key?: string
    combat_power: number
    client_battle_party?: object
    auto_start_times?: number
}

interface QuestStatistics {
    clear_phase: number
    party: {
        unison_characters: ({ id: (number | null) } | null)[]
        characters: ({ id: (number | null) } | null)[]
        equipments: ({ id: (number | null) } | null)[]
        ability_soul_ids: (number | null)[]
    }
}

interface MultiFinishBody {
    is_restored: boolean
    continue_count: number
    elapsed_time_ms: number
    quest_id: number
    category: number
    score: number
    viewer_id: number
    add_mana: number
    is_accomplished: boolean
    statistics: QuestStatistics
    sub_statistics?: QuestStatistics[]
    api_count: number
    contribution_score: number
    mate_player_result: Array<{
        viewer_id: number
        com_id: number
        score: number
        contribution_score: number
    }>
    isolated: boolean
    priority_factors: string[]
    is_lose?: boolean
    equipment_element?: number[]
}

interface MultiAbortBody {
    api_count: number
    finish_kind: number
    statistics: QuestStatistics
    sub_statistics?: QuestStatistics[]
    viewer_id: number
    quest_id: number
    play_id: string
    category: number
    reproduce_log_data?: object
}

interface PlayContinueBody {
    api_count: number
    payment_type: number
    quest_id: number
    viewer_id: number
    paly_id: string
    category: number
}

interface RestoreRoomBody {
    room_number: string
    room_sequence: number
    viewer_id: number
    api_count: number
}

interface ShareRoomBody {
    category: number
    quest_id: number
    room_number: string
    share_type_list: number[]
    viewer_id: number
    api_count: number
}

interface VerifyAccessTokenBody {
    access_token: string
    viewer_id: number
    api_count: number
}

interface MicroCommunityBody {
    category_id: number
    quest_id: number
    room_number: string
    viewer_id: number
    api_count: number
}

interface ReturnRushEvent {
    rush_battle_reward_list: {
        kind: number
        kind_id: number
        number: number
    }[]
    rush_battle_played_party_list: Record<number, UserRushEventPlayedParty> | null
    endless_battle_played_party_list: Record<number, UserRushEventPlayedParty> | null
    is_out_of_period: boolean
}

const continueVmoneyCost = 50;

async function getViewerIdAndPlayer(viewerId: number) {
    const session = await getSession(viewerId.toString());
    if (!session) return null;
    const playerId = resolvePlayerIdSync(session.accountId)!;
    if (playerId === null) return null;
    const player = getPlayerSync(playerId);
    return { session, playerId, player };
}

interface MateInfo {
    mate1: MultiMate | null
    mate2: MultiMate | null
}

const routes = async (fastify: FastifyInstance) => {

    // ---- get_rooms ----
    fastify.post("/get_rooms", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as GetRoomsBody
        const viewerId = body.viewer_id
        console.log(`[MULTI] get_rooms body:`, JSON.stringify(body))
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        })
        const sid = await getSession(viewerId.toString())
        if (!sid) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id."
        })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": { "rooms": getRooms(body.category_id, body.event_id)
                .filter(r => r.host_viewer_id === viewerId)
                .filter(r => hasRoomClients(r.room_number))
                .map(serializeRoom) }
        })
    })

    // ---- create_room ----
    fastify.post("/create_room", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as CreateRoomBody
        const { viewer_id, category, quest_id, party_id } = body
        console.log(`[MULTI] create_room: viewer=${viewer_id} category=${category} quest=${quest_id} party=${party_id}`)
        const ctx = await getViewerIdAndPlayer(viewer_id)
        if (!ctx) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id or no player bound."
        })

        // validate quest exists
        const quest = getQuestFromCategorySync(category, quest_id)
        if (!quest) return reply.status(400).send({
            "error": "Bad Request", "message": "Quest doesn't exist."
        })

        const room = createRoom(viewer_id, ctx.playerId, party_id, category, quest_id, 0, ctx.player?.leaderCharacterId || 1)

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

    // ---- search_room ----
    fastify.post("/search_room", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as SearchRoomBody
        const viewerId = body.viewer_id
        console.log(`[MULTI] search_room: viewer=${viewerId} room=${body.room_number}`)
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

    // ---- select_room ----
    fastify.post("/select_room", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as SelectRoomBody
        const viewerId = body.viewer_id
        console.log(`[MULTI] select_room body:`, JSON.stringify(body))
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        })
        const ctx = await getViewerIdAndPlayer(viewerId)
        if (!ctx) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id or no player bound."
        })

        const room = body.room_number ? getRoom(body.room_number) : getRoomByToken(body.access_token || "")
        if (!room) {
            console.log(`[MULTI] select_room: room not found, return raising_state=9`)
            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({
                "data_headers": generateDataHeaders({ viewer_id: viewerId }),
                "data": {
                    application_update_url: "",
                    category_id: 0,
                    host_entry_time: 0,
                    ip_address: getDisplayHost(),
                    port: parseInt(process.env.SESSION_PORT || "8003"),
                    quest_id: 0,
                    raising_state: 9,
                    room_number: body.room_number || "",
                    room_sequence: 0,
                    share_room_options: 0,
                    is_pickup: null
                }
            })
        }

        console.log(`[MULTI] select_room: room found, raising_state=${room.raising_state}`)
        updateHostEntryTime(room.room_number)

        const selectData = serializeRoomConnection(room)
        // Host always sees Ready; guests see true state
        if (viewerId === room.host_viewer_id) {
            selectData.raising_state = 1
            console.log(`[MULTI] select_room: host override raising_state → 1`)
        } else if (!isHostOnline(room.room_number)) {
            // Host not online → guests poll (raising_state=2)
            selectData.raising_state = 2
            console.log(`[MULTI] select_room: host offline, guest polls raising_state → 2`)
        }
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": selectData
        })
    })

    // ---- prepare ----
    fastify.post("/prepare", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as PrepareBody
        const viewerId = body.viewer_id
        console.log(`[MULTI] prepare: viewer=${viewerId} room=${body.room_number}`)
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        })
        const ctx = await getViewerIdAndPlayer(viewerId)
        if (!ctx) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id or no player bound."
        })

        const room = body.room_number ? getRoom(body.room_number) : getRoomByToken(body.access_token || "")
        if (!room) {
            console.log(`[MULTI] prepare: room not found, return raising_state=9`)
            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({
                "data_headers": generateDataHeaders({ viewer_id: viewerId }),
                "data": {
                    application_update_url: "",
                    category_id: 0,
                    host_entry_time: 0,
                    ip_address: getDisplayHost(),
                    port: parseInt(process.env.SESSION_PORT || "8003"),
                    quest_id: 0,
                    raising_state: 9,
                    room_number: body.room_number || "",
                    room_sequence: 0,
                    share_room_options: 0,
                    is_pickup: null
                }
            })
        }

        // prepare → select_room (client will call select_room after prepare)
        console.log(`[MULTI] prepare: room found, raising_state=${room.raising_state}`)
        updateHostEntryTime(room.room_number)

        const prepareData = serializeRoomConnection(room)
        if (viewerId === room.host_viewer_id) {
            prepareData.raising_state = 1
            console.log(`[MULTI] prepare: host override raising_state → 1`)
        } else if (!isHostOnline(room.room_number)) {
            prepareData.raising_state = 2
            console.log(`[MULTI] prepare: host offline, guest polls raising_state → 2`)
        }
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": prepareData
        })
    })

    // ---- summon (NPC mate data) ----
    fastify.post("/summon", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as SummonBody
        const viewerId = body.viewer_id
        console.log(`[MULTI] summon body:`, JSON.stringify(body))
        if (!viewerId || isNaN(viewerId)) {
            console.log(`[MULTI] summon 400: invalid viewer_id=${viewerId}`)
            return reply.status(400).send({
                "error": "Bad Request", "message": "Invalid request body."
            })
        }
        const ctx = await getViewerIdAndPlayer(viewerId)
        if (!ctx) {
            console.log(`[MULTI] summon 400: no player bound viewer=${viewerId}`)
            return reply.status(400).send({
                "error": "Bad Request", "message": "Invalid viewer id or no player bound."
            })
        }

        const room = getRoom(body.room_number)
        if (!room) {
            console.log(`[MULTI] summon 400: room not found room=${body.room_number}`)
            return reply.status(400).send({
                "error": "Bad Request", "message": "Room doesn't exist."
            })
        }

        console.log(`[MULTI] summon: viewer=${viewerId} room=${body.room_number} quest=${body.quest_id}`)

        // Check if room has real players as mates, else fall back to NPCs
        const realMates = room.mates.filter(m => m.viewer_id !== null)
        let mate1: MultiMate | null = null
        let mate2: MultiMate | null = null

        if (realMates.length >= 1) {
            // TODO phase 2: generate mate from real player data
        }

        // Always provide NPC mates for solo multi play
        const npcMates = getNpcMates(body.quest_id, room.category)
        mate1 = npcMates.mate1
        mate2 = npcMates.mate2
        console.log(`[MULTI] summon res: mate1=${mate1?.com_id} mate2=${mate2?.com_id}`)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "mate1": mate1,
                "mate2": mate2
            }
        })
    })

    // ---- restore_room ----
    fastify.post("/restore_room", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as RestoreRoomBody
        const viewerId = body.viewer_id
        console.log(`[MULTI] restore_room: viewer=${viewerId} room=${body.room_number} seq=${body.room_sequence}`)
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        })
        const sid = await getSession(viewerId.toString())
        if (!sid) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id."
        })

        const room = getRoom(body.room_number)
        const displayHost = getDisplayHost()
        const sessionPort = parseInt(process.env.SESSION_PORT || "8003")

        if (room) {
            console.log(`[MULTI] restore_room: room found, raising_state=${room.raising_state} host=${room.host_viewer_id}`)
            const restoreData = serializeRoomConnection(room)
            if (viewerId === room.host_viewer_id) {
                restoreData.raising_state = 1
                console.log(`[MULTI] restore_room: host override raising_state → 1`)
            }
            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({
                "data_headers": generateDataHeaders({ viewer_id: viewerId }),
                "data": restoreData
            })
        }

        console.log(`[MULTI] restore_room: room not found, return raising_state=9`)
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                application_update_url: "",
                category_id: 0,
                host_entry_time: 0,
                ip_address: displayHost,
                port: sessionPort,
                quest_id: 0,
                raising_state: 9,
                room_number: body.room_number,
                room_sequence: body.room_sequence || 0,
                share_room_options: 0,
                is_pickup: null
            }
        })
    })

    // ---- share_room ----
    fastify.post("/share_room", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as ShareRoomBody
        const viewerId = body.viewer_id
        console.log(`[MULTI] share_room: viewer=${viewerId} room=${body.room_number} shareTypes=${JSON.stringify(body.share_type_list)}`)
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        })
        const sid = await getSession(viewerId.toString())
        if (!sid) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id."
        })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {}
        })
    })

    // ---- verify_access_token ----
    fastify.post("/verify_access_token", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as VerifyAccessTokenBody
        const viewerId = body.viewer_id
        console.log(`[MULTI] verify_token: viewer=${viewerId}`)
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        })
        const sid = await getSession(viewerId.toString())
        if (!sid) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id."
        })

        const room = getRoomByToken(body.access_token)
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "room_exists": !!room,
                "category_id": room?.category ?? 0,
                "quest_id": room?.quest_id ?? 0,
                "room_number": room?.room_number ?? "",
                "establisher_viewer_id": room?.host_viewer_id ?? 0,
                "establisher_follow": 0
            }
        })
    })

    // ---- disband_room ----
    fastify.post("/disband_room", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { room_number: string, viewer_id: number, api_count: number };
        const viewerId = body.viewer_id;
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        });

        if (body.room_number) {
            notifyRoomDisbanded(body.room_number);
            disbandRoom(body.room_number);
            console.log(`[MULTI] room ${body.room_number} disbanded by viewer ${viewerId}`);
        }

        reply.header("content-type", "application/x-msgpack");
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": []
        });
    })

    // ---- micro_community (CN-specific) ----
    fastify.post("/micro_community", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as MicroCommunityBody
        const viewerId = body.viewer_id
        console.log(`[MULTI] micro_community: viewer=${viewerId}`)
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        })
        const sid = await getSession(viewerId.toString())
        if (!sid) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id."
        })

        // Micro community is CN-specific; return empty for now
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "micro_community_list": [],
                "page_token": ""
            }
        })
    })

    // ---- publish_room (CN micro community share) ----
    fastify.post("/publish_room", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { viewer_id: number, room_number: string, api_count: number }
        const viewerId = body.viewer_id
        console.log(`[MULTI] publish_room: viewer=${viewerId} room=${body.room_number}`)
        if (!viewerId || isNaN(viewerId)) {
            console.log(`[MULTI] publish_room: 400 invalid viewer_id=${viewerId}`)
            return reply.status(400).send({
                "error": "Bad Request", "message": "Invalid request body."
            })
        }
        const sid = await getSession(viewerId.toString())
        if (!sid) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id."
        })
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {}
        })
    })

    // ---- start (multi) ----
    fastify.post("/start", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as MultiStartBody
        const { viewer_id, quest_id, category, party_id, use_boost_point, use_boss_boost_point, is_auto_start_mode, room_number, mate_player_ids } = body
        console.log(`[MULTI] start: viewer=${viewer_id} quest=${quest_id} category=${category} party=${party_id} room=${room_number}`)
        console.log(`[MULTI] start mate_player_ids=${JSON.stringify(mate_player_ids)}`)
        console.log(`[MULTI] start mate_party_ids=${JSON.stringify(body.mate_party_ids)}`)

        if (isNaN(viewer_id) || isNaN(party_id) || isNaN(quest_id) || isNaN(category) || use_boost_point === undefined || use_boss_boost_point === undefined || is_auto_start_mode === undefined) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Invalid request body."
            })
        }

        const ctx = await getViewerIdAndPlayer(viewer_id)
        if (!ctx) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id or no player bound."
        })

        const questData = getQuestFromCategorySync(category, quest_id) as BattleQuest | null
        if (questData === null || !('rankPointReward' in questData)) return reply.status(400).send({
            "error": "Bad Request", "message": "Quest doesn't exist."
        })

        const room = getRoom(room_number)
        if (!room) return reply.status(400).send({
            "error": "Bad Request", "message": "Room doesn't exist."
        })

        // Set room to battle state
        updateRoomState(room_number, 4)

        // Insert active quest with multi flag
        const mateComIds = room.mates.map(m => m.com_id)
        insertActiveQuest(ctx.playerId, {
            questId: quest_id,
            category: category,
            useBoostPoint: use_boost_point,
            useBossBoostPoint: use_boss_boost_point,
            isAutoStartMode: is_auto_start_mode,
            isMulti: true,
            roomNumber: room_number,
            matePlayerIds: mate_player_ids,
            mateComIds,
            playId: body.play_id,
            continueCount: 0
        })

        // update player last quest id
        if (questData.fixedParty === undefined) {
            updatePlayerSync({
                id: ctx.playerId,
                partySlot: party_id
            })
        }

        const dataHeaders = generateDataHeaders({ viewer_id })
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": dataHeaders,
            "data": {
                "user_info": { "last_main_quest_id": quest_id },
                "category_id": category,
                "is_multi": "multi",
                "start_time": dataHeaders['servertime'],
                "quest_name": "",
                "follow_bonus_info": null
            }
        })
    })

    // ---- finish (multi) ----
    fastify.post("/finish", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as MultiFinishBody
        const viewerId = body.viewer_id
        console.log(`[MULTI] finish: viewer=${viewerId} quest=${body.quest_id} category=${body.category} accomplished=${body.is_accomplished}`)
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        })

        const ctx = await getViewerIdAndPlayer(viewerId)
        if (!ctx || !ctx.player) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id."
        })

        const playerData = ctx.player
        const playerId = ctx.playerId

        // get active quest
        const activeQuestData = activeQuests[playerId]
        if (activeQuestData === undefined) return reply.status(400).send({
            "error": "Bad Request", "message": "No active quest to finish."
        })

        // get quest data
        const questCategory = activeQuestData.category
        const questId = activeQuestData.questId
        const questData = getQuestFromCategorySync(questCategory, questId) as BattleQuest | null
        if (questData === null || !('rankPointReward' in questData)) return reply.status(400).send({
            "error": "Bad Request", "message": "Quest doesn't exist."
        })

        // delete active quest
        delete activeQuests[playerId]
        deletePlayerActiveQuestSync(playerId)

        // keep room alive for "return to room" after battle
        if (activeQuestData.roomNumber) {
            const room = getRoom(activeQuestData.roomNumber)
            if (room && room.host_player_id === playerId) {
                updateRoomState(room.room_number, 1)
                console.log(`[MULTI] finish: room ${activeQuestData.roomNumber} reset to raising_state=1`)
            }
        }

        // calculate clear rank (only if quest has rank time thresholds)
        const clearTime = body.elapsed_time_ms
        const hasRankThresholds = questData.bRankTime > 0
        const clearRank = hasRankThresholds ? (
            questData.sPlusRankTime >= clearTime ? 5
                : questData.sRankTime >= clearTime ? 4
                    : questData.aRankTime >= clearTime ? 3
                        : questData.bRankTime >= clearTime ? 2
                            : 1
        ) : null

        // calculate player rewards
        const newExpPool = playerData.expPool + questData.poolExpReward
        const beforeRankPoint = playerData.rankPoint
        const newRankPoint = beforeRankPoint + questData.rankPointReward
        let newMana = playerData.freeMana + questData.manaReward + body.add_mana

        // boost points
        let newBoostPoint = playerData.boostPoint - (activeQuestData.useBoostPoint ? 1 : 0)
        let newBossBoostPoint = playerData.bossBoostPoint - (activeQuestData.useBossBoostPoint ? 1 : 0)
        let useBoostPoint = (activeQuestData.useBoostPoint && (newBoostPoint >= 0)) || (activeQuestData.useBossBoostPoint && (newBossBoostPoint >= 0))

        // quest progress
        const questProgress = getPlayerSingleQuestProgressSync(playerId, questCategory, questId)
        const questPreviouslyCompleted = questProgress !== null
        const questAccomplished = body.is_accomplished

        const clearReward = !questPreviouslyCompleted && questData.clearReward !== undefined ? givePlayerRewardSync(playerId, questData.clearReward) : null
        const sPlusClearReward = (clearRank === 5) && (questProgress?.clearRank !== 5) && (questData.sPlusReward !== undefined) ? givePlayerRewardSync(playerId, questData.sPlusReward) : null
        if (questAccomplished) {
            if (questPreviouslyCompleted) {
                const updateData: any = {
                    questId: questId,
                    finished: true,
                    bestElapsedTimeMs: questProgress.bestElapsedTimeMs === undefined || questProgress.bestElapsedTimeMs === null ? clearTime : Math.min(clearTime, questProgress.bestElapsedTimeMs),
                    highScore: questProgress.highScore === undefined ? body.score : Math.max(body.score, questProgress.highScore)
                }
                if (clearRank !== null) {
                    updateData.clearRank = questProgress.clearRank === undefined ? clearRank : Math.max(clearRank, questProgress.clearRank)
                }
                updatePlayerQuestProgressSync(playerId, questCategory, updateData)
            } else {
                const insertData: any = {
                    questId: questId,
                    finished: true,
                    bestElapsedTimeMs: clearTime,
                    highScore: body.score,
                    clearRank: clearRank ?? 5
                }
                insertPlayerQuestProgressSync(playerId, questCategory, insertData)
            }
        }

        // update player
        const newDegreeId = getRankDegree(newRankPoint)
        const didLevelUp = newDegreeId > playerData.degreeId
        updatePlayerSync({
            id: playerId,
            freeMana: newMana,
            expPool: newExpPool,
            rankPoint: newRankPoint,
            boostPoint: newBoostPoint,
            bossBoostPoint: newBossBoostPoint,
            degreeId: newDegreeId,
            ...(didLevelUp ? { stamina: playerData.stamina + getMaxStamina(newDegreeId), staminaHealTime: new Date() } : {}),
        })
        if (didLevelUp) {
            playerData.stamina = playerData.stamina + getMaxStamina(newDegreeId)
            playerData.staminaHealTime = new Date()
            console.log(`[MULTI-FINISH] player ${playerId} leveled up: ${playerData.degreeId} -> ${newDegreeId}, stamina refilled`)
        }
        playerData.degreeId = newDegreeId

        // reward score rewards
        const scoreRewardsResult = givePlayerScoreRewardsSync(playerId, questData.scoreRewardGroupId, questData.scoreRewardGroup, useBoostPoint, questData.element)

        // reward character exp
        const bodyPartyStatistics = body.statistics.party
        const partyCharacterIds = [...bodyPartyStatistics.characters, ...bodyPartyStatistics.unison_characters]
        const partyCharacterIdsArray: number[] = []
        for (const value of partyCharacterIds.values()) {
            if (value !== null && value.id !== null) partyCharacterIdsArray.push(value.id)
        }
        const addExpAmount = questData.characterExpReward
        const rewardCharacterExpResult = givePlayerCharactersExpSync(
            playerId, partyCharacterIdsArray, addExpAmount,
            questData.fixedParty !== undefined
        )

        const dataHeaders = generateDataHeaders({ viewer_id: viewerId })

        // handle rush event if applicable
        let rushEventData: ReturnRushEvent | null = null
        let rushEventRewardsResult: PlayerRewardResult | null = null

        if (questCategory === QuestCategory.RUSH_EVENT) {
            const rushEventId = questData.rushEventId
            const rushEventFolderId = questData.rushEventFolderId
            const rushEventRound = questData.rushEventRound

            if (rushEventFolderId !== undefined && rushEventRound !== undefined && rushEventId !== undefined) {
                const rushEventBattleType = rushEventRound === 0 ? RushEventBattleType.ENDLESS : RushEventBattleType.FOLDER
                const characterIds = bodyPartyStatistics.characters.map(val => val?.id ?? null)
                const unisonCharacterIds = bodyPartyStatistics.unison_characters.map(val => val?.id ?? null)
                const evolutionImgLevels = getCharactersEvolutionImgLevels(playerId, characterIds)
                const unisonEvolutionImgLevels = getCharactersEvolutionImgLevels(playerId, unisonCharacterIds)
                let round: number = questId

                if (rushEventBattleType === RushEventBattleType.ENDLESS) {
                    const playerRushEventData = getPlayerRushEventSync(playerId, rushEventId)
                    const playerNextRound = playerRushEventData?.endlessBattleNextRound ?? 1
                    const playerMaxRound = playerRushEventData?.endlessBattleMaxRound ?? 1
                    const playerBestClearTime = playerRushEventData?.endlessBattleMaxRoundTime ?? Number.MAX_SAFE_INTEGER
                    round = playerNextRound

                    if ((playerNextRound >= playerMaxRound && playerBestClearTime >= clearTime) || (playerNextRound > playerMaxRound)) {
                        updatePlayerRushEventSync(playerId, {
                            eventId: rushEventId,
                            endlessBattleMaxRound: playerNextRound,
                            endlessBattleMaxRoundTime: clearTime,
                            endlessBattleMaxRoundCharacterIds: characterIds,
                            endlessBattleMaxRoundCharacterEvolutionImgLvls: evolutionImgLevels
                        })
                    }

                    insertPlayerRushEventPlayedPartySync(playerId, rushEventId, {
                        characterIds, unisonCharacterIds,
                        equipmentIds: bodyPartyStatistics.equipments.map(val => val?.id ?? null),
                        abilitySoulIds: bodyPartyStatistics.ability_soul_ids,
                        evolutionImgLevels, unisonEvolutionImgLevels,
                        battleType: rushEventBattleType, round
                    })
                } else if (rushEventBattleType === RushEventBattleType.FOLDER) {
                    const isFolderFinal = rushEventRound >= (rushEventFolderMaxRounds[rushEventFolderId] ?? 0)
                    if (isFolderFinal) {
                        insertPlayerRushEventClearedFolderSync(playerId, rushEventId, rushEventFolderId)
                        updatePlayerRushEventSync(playerId, { eventId: rushEventId, activeRushBattleFolderId: null })
                        deletePlayerRushEventPlayedPartyListSync(playerId, rushEventId, rushEventBattleType)
                    } else {
                        insertPlayerRushEventPlayedPartySync(playerId, rushEventId, {
                            characterIds, unisonCharacterIds,
                            equipmentIds: bodyPartyStatistics.equipments.map(val => val?.id ?? null),
                            abilitySoulIds: bodyPartyStatistics.ability_soul_ids,
                            evolutionImgLevels, unisonEvolutionImgLevels,
                            battleType: rushEventBattleType, round
                        })
                    }
                }

                const serializedPlayedParties = getSerializedPlayerRushEventPlayedPartiesSync(playerId, rushEventId)
                rushEventData = {
                    "rush_battle_reward_list": [],
                    "rush_battle_played_party_list": serializedPlayedParties.folderParties,
                    "endless_battle_played_party_list": serializedPlayedParties.endlessParties,
                    "is_out_of_period": false
                }

                if (rushEventBattleType === RushEventBattleType.FOLDER && rushEventRound >= (rushEventFolderMaxRounds[rushEventFolderId] ?? 0)) {
                    const rewards = getRushEventFolderClearRewards(rushEventId, rushEventFolderId) ?? []
                    rushEventRewardsResult = givePlayerRewardsSync(playerId, rewards)
                    rushEventData.rush_battle_reward_list = rewards.map(reward => {
                        const itemReward = reward as EquipmentItemReward
                        return { "kind": 1, "kind_id": itemReward.id, "number": itemReward.count }
                    })
                }
            }
        }

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": dataHeaders,
            "data": {
                "user_info": {
                    "free_mana": newMana + (clearReward?.user_info.free_mana || 0) + (sPlusClearReward?.user_info.free_mana || 0) + scoreRewardsResult.user_info.free_mana,
                    "exp_pool": rewardCharacterExpResult.exp_pool + (clearReward?.user_info.exp_pool || 0) + scoreRewardsResult.user_info.exp_pool,
                    "exp_pooled_time": getServerTime(playerData.expPooledTime),
                    "free_vmoney": playerData.freeVmoney + (clearReward?.user_info.free_vmoney || 0) + (sPlusClearReward?.user_info.free_vmoney || 0) + scoreRewardsResult.user_info.free_vmoney,
                    "rank_point": newRankPoint,
                    "degree_id": 1,
                    "stamina": computeRealTimeStamina(playerData),
                    "stamina_heal_time": getServerTime(),
                    "boost_point": newBoostPoint,
                    "boss_boost_point": newBossBoostPoint
                },
                "add_exp_list": rewardCharacterExpResult.add_exp_list,
                "character_list": [
                    ...rewardCharacterExpResult.character_list,
                    ...(clearReward?.character_list || []),
                    ...(sPlusClearReward?.character_list || []),
                    ...scoreRewardsResult.character_list
                ],
                "bond_token_status_list": rewardCharacterExpResult.bond_token_status_list,
                "rewards": {
                    "overflow_pool_exp": 0,
                    "converted_pool_exp": 0,
                    "reward_pool_exp": questData.poolExpReward,
                    "reward_mana": questData.manaReward,
                    "field_mana": body.add_mana
                },
                "old_high_score": questProgress === null ? 0 : questProgress.highScore || 0,
                "joined_character_id_list": [
                    ...(clearReward?.joined_character_id_list || []),
                    ...(sPlusClearReward?.joined_character_id_list || []),
                    ...scoreRewardsResult.joined_character_id_list
                ],
                "before_rank_point": beforeRankPoint,
                "clear_rank": clearRank ?? 5,
                "drop_score_reward_ids": scoreRewardsResult.drop_score_reward_ids,
                "drop_rare_reward_ids": scoreRewardsResult.drop_rare_reward_ids,
                "drop_additional_reward_ids": [],
                "drop_periodic_reward_ids": [],
                "equipment_list": [
                    ...scoreRewardsResult.equipment_list,
                    ...(clearReward?.equipment_list || []),
                    ...(sPlusClearReward?.equipment_list || [])
                ],
                "category_id": questCategory,
                "start_time": dataHeaders['servertime'],
                "is_multi": "multi",
                "quest_name": "",
                "item_list": {
                    ...scoreRewardsResult.items,
                    ...(rushEventRewardsResult?.items ?? {})
                },
                "rush_event": rushEventData,
                "presigned_quest_category": [],
                // multi-specific fields
                "mate_player_result": body.mate_player_result || [],
                "contribution_score": body.contribution_score ?? 0,
                "host_finished": true,
                "aborted_play_id": null,
                "drawn_quest": null,
                "follow_info": null,
                "party_info": null,
                "unfinished_play_id": null,
                "carnival_event": null,
                "ranking_event": null,
                "score_attack_event": null,
                "solo_time_attack_event": null,
                "user_notice_list": [],
                "user_periodic_reward_point_list": []
            }
        })
    })

    // ---- abort (multi) ----
    fastify.post("/abort", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as MultiAbortBody
        const viewerId = body.viewer_id
        console.log(`[MULTI] abort: viewer=${viewerId} quest=${body.quest_id} category=${body.category}`)
        if (isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        })

        const ctx = await getViewerIdAndPlayer(viewerId)
        if (!ctx) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id or no player bound."
        })

        const activeQuestData = activeQuests[ctx.playerId]
        if (activeQuestData) {
            if (activeQuestData.roomNumber) {
                const room = getRoom(activeQuestData.roomNumber)
                if (room && room.host_player_id === ctx.playerId) {
                    notifyRoomDisbanded(activeQuestData.roomNumber);
                    disbandRoom(activeQuestData.roomNumber)
                    console.log(`[MULTI] abort: room ${activeQuestData.roomNumber} disbanded (host abandoned)`)
                }
            }
            delete activeQuests[ctx.playerId]
            deletePlayerActiveQuestSync(ctx.playerId)
        }

        const headers = generateDataHeaders({ viewer_id: body.viewer_id })
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": headers,
            "data": {
                "user_info": {},
                "category_id": body.category,
                "is_multi": "multi",
                "start_time": headers['servertime'],
                "quest_name": "",
                "aborted_play_id": body.play_id,
                "unfinished_play_id": null,
                "drawn_quest": null,
                "party_info": null,
                "presigned_url": null
            }
        })
    })

    // ---- play_continue (multi) ----
    fastify.post("/play_continue", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as PlayContinueBody
        const viewerId = body.viewer_id
        console.log(`[MULTI] play_continue: viewer=${viewerId} quest=${body.quest_id} category=${body.category}`)
        if (isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        })

        const ctx = await getViewerIdAndPlayer(viewerId)
        if (!ctx || !ctx.player) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id or no player bound."
        })

        const player = ctx.player
        if (activeQuests[ctx.playerId] === undefined) return reply.status(400).send({
            "error": "Bad Request", "message": "No active quest to continue."
        })

        const freeVmoney = player.freeVmoney
        const newFreeVmoney = freeVmoney - continueVmoneyCost
        const vmoney = player.vmoney
        const newVmoney = 0 > newFreeVmoney ? vmoney - continueVmoneyCost : vmoney
        if (0 > newFreeVmoney && 0 > newVmoney) return reply.status(400).send({
            "error": "Bad Request", "message": "Not enough vmoney to continue"
        })

        const setNewFreeVmoney = 0 > newFreeVmoney ? freeVmoney : newFreeVmoney
        updatePlayerSync({
            id: ctx.playerId,
            freeVmoney: setNewFreeVmoney,
            vmoney: newVmoney
        })

        // increment continue count for battle recovery
        const activeData = activeQuests[ctx.playerId]
        activeData!.continueCount++
        updatePlayerActiveQuestContinueCountSync(ctx.playerId, activeData!.continueCount)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "user_info": { "free_vmoney": setNewFreeVmoney, "vmoney": newVmoney },
                "mail_arrived": false
            }
        })
    })
}

export default routes;
