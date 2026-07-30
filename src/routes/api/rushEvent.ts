// Handles mail.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { PartyCategory, RushEventBattleType, UserRushEventPlayedParty } from "../../data/types";
import { deletePlayerRushEventPlayedPartiesUntilSync, deletePlayerRushEventPlayedPartyListSync, deletePlayerRushEventPlayedPartySync, getDefaultPlayerRushEventSync, getPlayerRushEventClearedFoldersSync, getPlayerRushEventNextEndlessBattleRoundSync, getPlayerRushEventPlayedPartiesSync, getPlayerRushEventSync, getRushEventEndlessRankingListSync, insertPlayerRushEventClearedFolderSync, insertPlayerRushEventPlayedPartySync, insertPlayerRushEventSync, serializePlayerRushEventPlayedParty, updatePlayerRushEventSync } from "../../data/domains/rushEvent"
import { getAccountPlayers } from "../../data/domains/account"
import { getDefaultPlayerPartyGroupsSync } from "../../data/domains/player"
import { getPlayerCharacterSync } from "../../data/domains/character"
import { ensurePlayerPartyGroupListSync, getPlayerPartyGroupListSync } from "../../data/domains/party"
import { getSession } from "../../data/domains/session"
import {
    getQuestFromCategorySync,
    getRushEventRankingRewards,
    type RushEventRankingRewardEntry,
} from "../../lib/assets";
import { BattleQuest, QuestCategory, RushEventFolder } from "../../lib/types";
import { generateDataHeaders, getServerDate, getServerTime } from "../../utils";
import type { FinishBody } from "./singleBattleQuest";
import { insertActiveQuest } from "../../lib/quest/active-quest-service";
import { getPlayerRushEventEndlessBattleRankingSync, getRushEventEndlessBattleRankPlayedPartyListSync, getSerializedPlayerRushEventPlayedPartiesSync } from "../../lib/rush";
import { clientSerializeDate } from "../../data/utils";
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { ensureSpecialEventPartyGroupsSync, getGlobalPartyId } from "../../lib/special-event-parties";
import { getDb } from "../../data/db";

interface SummaryBody {
    event_id: number,
    viewer_id: number
}

interface PartyBody {
    viewer_id: number
}

interface SelectFolderBody {
    folder_id: number,
    event_id: number,
    viewer_id: number
}

interface BattleStartBody {
    is_auto_start_mode: boolean,
    party_id: number,
    play_id: string,
    quest_id: number,
    viewer_id: number
}

interface ResetBody {
    quest_type: number,
    event_id: number,
    viewer_id: number,
    reset_target_id?: number,
    is_reset_after_target_round?: boolean
}

interface RankingBody {
    viewer_id: number,
    event_id: number,
    page?: number,
    aggregated_time?: string
}

interface RankingPlayedPartyBody {
    viewer_id: number,
    rank_number: number,
    aggregated_time: string,
    event_id: number
}

enum ResetQuestType {
    EMPTY,
    FOLDER,
    ENDLESS
}

interface RushParty {
    ability_soul_ids: (number | null)[],
    character_ids: (number | null)[],
    equipment_ids: (number | null)[],
    options: {
        allow_other_players_to_heal_me: boolean
    },
    party_edited: boolean,
    party_id: number,
    party_name: string,
    unison_character_ids: (number | null)[]
}

interface RushPartyGroup {
    party_group_color_id: number,
    party_group_id: number,
    party_list: RushParty[]
}

export const rushEventFolderMaxRounds: { [key in RushEventFolder]?: number } = {
    [RushEventFolder.INTERMEDIATE]: 2,
    [RushEventFolder.ADVANCED]: 2,
    [RushEventFolder.GODLY]: 2
}

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/summary", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as SummaryBody

        const viewerId = body.viewer_id
        const eventId = body.event_id
        console.log(`[RUSH] summary: viewer=${viewerId} eventId=${eventId}`)
        if (isNaN(viewerId) || isNaN(eventId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        })

        // get player
        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!
        if (playerId === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No player bound to account."
        })

        // get rush event data
        let rushEventData = getPlayerRushEventSync(playerId, eventId)
        if (rushEventData === null) {
            rushEventData = getDefaultPlayerRushEventSync(eventId)
            insertPlayerRushEventSync(playerId, rushEventData)
        }

        // get cleared folder id list
        const clearedFolderIdList = getPlayerRushEventClearedFoldersSync(playerId, eventId)

        // get serialized parties
        const serializedPlayedParties = getSerializedPlayerRushEventPlayedPartiesSync(playerId, eventId)
        console.log(`[RUSH] summary: folderParties=${Object.keys(serializedPlayedParties.folderParties ?? {}).length} endlessParties=${Object.keys(serializedPlayedParties.endlessParties ?? {}).length}`)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "endless_battle_next_round": rushEventData.endlessBattleNextRound,
                "endless_battle_max_round": rushEventData.endlessBattleMaxRound,
                "active_rush_battle_folder_id": rushEventData.activeRushBattleFolderId,
                "endless_battle_played_max_round": rushEventData.endlessBattleMaxRound,
                "cleared_folder_id_list": clearedFolderIdList,
                "endless_battle_played_party_list": serializedPlayedParties.endlessParties,
                "rush_battle_played_party_list": serializedPlayedParties.folderParties,
                "endless_battle_my_ranking": getPlayerRushEventEndlessBattleRankingSync(playerId, eventId, {
                    rushEventData: rushEventData
                }),
                "aggregated_time": clientSerializeDate(getServerDate()),
            }
        })
    })

    fastify.post("/select_folder", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as SelectFolderBody

        const viewerId = body.viewer_id
        const eventId = body.event_id
        const folderId = body.folder_id
        console.log(`[RUSH] select_folder: viewer=${viewerId} eventId=${eventId} folderId=${folderId}`)
        if (isNaN(viewerId) || isNaN(eventId) || isNaN(folderId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        })

        // get player
        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!
        if (playerId === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No player bound to account."
        })

        // get existing rush event data 
        const rushEventData = getPlayerRushEventSync(playerId, eventId)
        if (rushEventData === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": `No rush event data for rush event with id '${eventId}'`
        });

        // Error if a folder has already been selected
        if (rushEventData.activeRushBattleFolderId !== null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Already selected a folder for this rush event."
        });

        // update folder
        updatePlayerRushEventSync(playerId, {
            eventId: eventId,
            activeRushBattleFolderId: folderId
        })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "folder_id": folderId,
                "event_id": eventId
            }
        })
    })

    fastify.post("/ranking", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as RankingBody

        const viewerId = body.viewer_id
        const eventId = body.event_id
        const page = body.page ?? 0
        console.log(`[RUSH] ranking: viewer=${viewerId} eventId=${eventId} page=${page}`)
        if (isNaN(viewerId) || isNaN(eventId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        })

        // get player
        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!
        if (playerId === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No player bound to account."
        })

        // get player endless rank
        const endlessRanking = getPlayerRushEventEndlessBattleRankingSync(playerId, eventId)

        // get all rankings for page
        const rankings = getRushEventEndlessRankingListSync(eventId, page);

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "aggregated_time": clientSerializeDate(getServerDate()),
                "current_page": page + 1,
                "page_max": rankings.pageMax,
                "my_data": endlessRanking,
                "ranking_data": rankings.list
            }
        })
    })

    fastify.post("/ranking/played_party", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as RankingPlayedPartyBody

        const viewerId = body.viewer_id
        const eventId = body.event_id
        const rankNumber = body.rank_number
        if (isNaN(viewerId) || isNaN(eventId) || isNaN(rankNumber)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        })

        // get player
        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!
        if (playerId === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No player bound to account."
        })

        // get party list
        const partyList = getRushEventEndlessBattleRankPlayedPartyListSync(rankNumber, eventId) ?? []

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "rush_ranking_party": partyList
            }
        })
    })

    fastify.post("/aggregated_time", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as SummaryBody

        const viewerId = body.viewer_id
        const eventId = body.event_id
        if (isNaN(viewerId) || isNaN(eventId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        })

        // get player
        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!
        if (playerId === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No player bound to account."
        })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "aggregated_time": clientSerializeDate(getServerDate())
            }
        })
    })

    fastify.post("/party", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as PartyBody

        const viewerId = body.viewer_id
        if (isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        })

        // get player
        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!
        if (playerId === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No player bound to account."
        })

        const playerPartyGroups = ensureSpecialEventPartyGroupsSync(
            playerId,
            PartyCategory.RUSH,
            undefined,
            {
                getGroups: getPlayerPartyGroupListSync,
                getDefaults: getDefaultPlayerPartyGroupsSync,
                ensureGroups: ensurePlayerPartyGroupListSync,
            },
        )

        // convert to proper format
        const userPartyGroupList: RushPartyGroup[] = []

        for (const [idString, group] of Object.entries(playerPartyGroups)) {
            const partyList: RushParty[] = []

            // convert parties
            for (const [partyIdString, party] of Object.entries(group.list)) {
                partyList.push({
                    ability_soul_ids: party.abilitySoulIds,
                    character_ids: party.characterIds,
                    equipment_ids: party.equipmentIds,
                    unison_character_ids: party.unisonCharacterIds,
                    options: {
                        allow_other_players_to_heal_me: party.options.allowOtherPlayersToHealMe
                    },
                    party_edited: party.edited,
                    party_id: getGlobalPartyId(Number(idString), Number(partyIdString)),
                    party_name: party.name
                })
            }

            userPartyGroupList.push({
                "party_group_color_id": group.colorId,
                "party_group_id": Number(idString),
                "party_list": partyList
            })
        }

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "user_party_group_list": userPartyGroupList
            }
        })
    })

    fastify.post("/battle/start", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as BattleStartBody

        const viewerId = body.viewer_id
        const isAutoStartMode = body.is_auto_start_mode
        const partyId = body.party_id
        const questId = body.quest_id
        console.log(`[RUSH] battle/start: viewer=${viewerId} questId=${questId} partyId=${partyId} autoStart=${isAutoStartMode}`)
        if (isNaN(viewerId) || isNaN(partyId) || isNaN(questId) || isAutoStartMode === undefined) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        })

        // get player
        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!
        if (playerId === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No player bound to account."
        })

        // get quest
        const questData = getQuestFromCategorySync(QuestCategory.RUSH_EVENT, questId) as BattleQuest | null
        if (questData === null || !('rankPointReward' in questData) || questData.rushEventId === undefined) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Quest doesn't exist."
        })

        // insert active quest for '/single_battle_quest/finish' endpoint
        insertActiveQuest(playerId, {
            questId: questId,
            category: QuestCategory.RUSH_EVENT,
            useBoostPoint: false,
            useBossBoostPoint: false,
            isAutoStartMode: isAutoStartMode,
            isMulti: false,
            playId: body.play_id,
            continueCount: 0
        })

        const headers = generateDataHeaders({
            viewer_id: viewerId
        })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": headers,
            "data": {
                "user_info": {
                    "last_main_quest_id": body.quest_id
                },
                "is_multi": "single",
                "start_time": headers['servertime'],
                "quest_name": ""
            }
        })
    })

    fastify.post("/reset", async (request: FastifyRequest, reply: FastifyReply) => {
        if (request.body === null
            || typeof request.body !== "object"
            || Array.isArray(request.body)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })
        const body = request.body as ResetBody

        const viewerId = body.viewer_id
        const eventId = body.event_id
        const questType: ResetQuestType = body.quest_type
        const resetTargetId: number | undefined = body.reset_target_id
        const isResetAfterTargetRound: boolean | undefined = body.is_reset_after_target_round
        console.log(`[RUSH] reset: viewer=${viewerId} eventId=${eventId} questType=${questType} resetTargetId=${resetTargetId} isResetAfterTarget=${isResetAfterTargetRound}`)
        if (!Number.isSafeInteger(viewerId) || viewerId <= 0
            || !Number.isSafeInteger(eventId) || eventId <= 0
            || (questType !== ResetQuestType.FOLDER && questType !== ResetQuestType.ENDLESS)
            || (resetTargetId !== undefined
                && (!Number.isSafeInteger(resetTargetId) || resetTargetId <= 0))
            || (questType === ResetQuestType.FOLDER && isResetAfterTargetRound !== undefined)
            || (questType === ResetQuestType.ENDLESS
                && (resetTargetId === undefined || typeof isResetAfterTargetRound !== "boolean"))) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        })

        // get player
        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!
        if (playerId === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No player bound to account."
        })

        const rushEventData = getPlayerRushEventSync(playerId, eventId)
        if (rushEventData === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Rush event progress does not exist."
        })
        const playedParties = getPlayerRushEventPlayedPartiesSync(playerId, eventId)

        if (questType === ResetQuestType.FOLDER) {
            if (resetTargetId !== undefined) {
                const targetQuest = getQuestFromCategorySync(QuestCategory.RUSH_EVENT, resetTargetId) as BattleQuest | null
                if (targetQuest === null
                    || targetQuest.rushEventId !== eventId
                    || targetQuest.rushEventFolderId === undefined
                    || targetQuest.rushEventRound === undefined
                    || targetQuest.rushEventRound <= 0
                    || rushEventData.activeRushBattleFolderId !== targetQuest.rushEventFolderId
                    || !playedParties.some(party =>
                        party.battleType === RushEventBattleType.FOLDER
                        && party.round === resetTargetId
                    )) return reply.status(400).send({
                    "error": "Bad Request",
                    "message": "Invalid rush battle reset target."
                })

                const targetIds = playedParties.flatMap(party => {
                    if (party.battleType !== RushEventBattleType.FOLDER) return []
                    const quest = getQuestFromCategorySync(QuestCategory.RUSH_EVENT, party.round) as BattleQuest | null
                    if (quest === null
                        || quest.rushEventId !== eventId
                        || quest.rushEventFolderId !== targetQuest.rushEventFolderId
                        || quest.rushEventRound === undefined
                        || quest.rushEventRound < targetQuest.rushEventRound!) return []
                    return [party.round]
                })
                getDb().transaction(() => {
                    for (const questId of targetIds) {
                        deletePlayerRushEventPlayedPartySync(
                            playerId,
                            eventId,
                            questId,
                            RushEventBattleType.FOLDER,
                        )
                    }
                })()
            } else {
                getDb().transaction(() => {
                    updatePlayerRushEventSync(playerId, {
                        eventId: eventId,
                        activeRushBattleFolderId: null
                    })
                    deletePlayerRushEventPlayedPartyListSync(playerId, eventId, RushEventBattleType.FOLDER)
                })()
            }
        } else {
            if (!playedParties.some(party =>
                party.battleType === RushEventBattleType.ENDLESS
                && party.round === resetTargetId
            )) return reply.status(400).send({
                "error": "Bad Request",
                "message": "Invalid endless battle reset target."
            })
            getDb().transaction(() => {
                if (isResetAfterTargetRound) {
                    deletePlayerRushEventPlayedPartiesUntilSync(
                        playerId,
                        eventId,
                        RushEventBattleType.ENDLESS,
                        resetTargetId!,
                    )
                } else {
                    deletePlayerRushEventPlayedPartySync(
                        playerId,
                        eventId,
                        resetTargetId!,
                        RushEventBattleType.ENDLESS,
                    )
                }
            })()
        }
        
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": []
        })
    })

    // ---- reward ----
    fastify.post("/reward", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { event_id: number, viewer_id: number, api_count: number };
        const viewerId = body.viewer_id;
        const eventId = body.event_id;
        console.log(`[RUSH] reward: viewer=${viewerId} eventId=${eventId}`)
        if (!viewerId || isNaN(viewerId) || isNaN(eventId)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        });

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id."
        })

        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!
        if (playerId === null) return reply.status(500).send({
            "error": "Internal Server Error", "message": "No player bound to account."
        })

        // get player's rank
        const myRanking = getPlayerRushEventEndlessBattleRankingSync(playerId, eventId)
        const rankNumber = myRanking?.rank_number ?? null

        // find matching reward tier
        const rewards = getRushEventRankingRewards()[String(eventId)] ?? {}
        let rewardList: RushEventRankingRewardEntry[] = []
        if (rankNumber !== null && rankNumber > 0) {
            for (const entries of Object.values(rewards)) {
                for (const entry of entries) {
                    if (rankNumber >= entry.fromRank && rankNumber <= entry.toRank) {
                        rewardList.push(entry)
                        break
                    }
                }
            }
        }

        console.log(`[RUSH] reward: rank=${rankNumber} rewards=${rewardList.length}`)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "rank_number": rankNumber,
                "ranking_reward": {
                    "reward_list": rewardList.map(r => ({
                        "kind": r.kind,
                        "kind_id": r.kindId,
                        "number": r.number
                    })),
                    "status": 0
                }
            }
        });
    })

    // ---- endless_battle ----
    fastify.post("/endless_battle", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { event_id: number, viewer_id: number, api_count: number };
        const viewerId = body.viewer_id;
        const eventId = body.event_id;
        console.log(`[RUSH] endless_battle: viewer=${viewerId} eventId=${eventId}`)
        if (!viewerId || isNaN(viewerId) || isNaN(eventId)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        });

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id."
        })

        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!
        if (playerId === null) return reply.status(500).send({
            "error": "Internal Server Error", "message": "No player bound to account."
        })

        const rushEventData = getPlayerRushEventSync(playerId, eventId)
        const serializedPlayedParties = rushEventData !== null
            ? getSerializedPlayerRushEventPlayedPartiesSync(playerId, eventId)
            : { endlessParties: null, folderParties: null }
        const maxRound = rushEventData?.endlessBattleMaxRound ?? null
        const nextRound = rushEventData?.endlessBattleNextRound ?? 1

        console.log(`[RUSH] endless_battle: maxRound=${maxRound} nextRound=${nextRound}`)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "endless_battle_max_round": maxRound,
                "endless_battle_next_round": nextRound,
                "endless_battle_played_party_list": serializedPlayedParties.endlessParties ?? null
            }
        });
    })
}

export default routes;
