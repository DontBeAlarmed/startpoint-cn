import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { MultiStartBody, MultiFinishBody, MultiAbortBody, PlayContinueBody } from "../types";
import { generateDataHeaders, getServerTime, realToVirtual } from "../../utils";
import { getRoom, setRoomBattle, disbandRoom, updateRoomState } from "../room/manager";
import { sessionManager } from "../state/SessionManager";
import { insertActiveQuest, activeQuests } from "../../routes/api/singleBattleQuest";
import {
    deletePlayerActiveQuestSync,
    updatePlayerActiveQuestContinueCountSync,
} from "../../data/domains/quest_active";
import { incrementPlayerCharacterClearSync } from "../../data/domains/character_clear";
import {
    getPlayerSync,
    updatePlayerSync,
} from "../../data/domains/player";
import {
    getPlayerSingleQuestProgressSync,
    insertPlayerQuestProgressSync,
    updatePlayerQuestProgressSync,
} from "../../data/domains/quest";
import { getSession } from "../../data/domains/session";
import { getQuestFromCategorySync } from "../../lib/assets";
import { getCharactersEvolutionImgLevels, givePlayerCharactersExpSync } from "../../lib/character";
import { givePlayerRewardsSync, givePlayerRewardSync, givePlayerScoreRewardsSync } from "../../lib/quest";
import { computeRealTimeStamina, getRankDegree, getMaxStamina } from "../../lib/stamina";
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { BattleQuest, EquipmentItemReward, PlayerRewardResult, QuestCategory } from "../../lib/types";
import { getDb } from "../../data/db";
import type { Player } from "../../data/types";
import { trackCharacterClears } from "../../lib/quest/finish/character-clear-tracker";
import { trackPowerflip } from "../../lib/quest/finish/powerflip-tracker";
import { trackLeaderPowerflip } from "../../lib/quest/finish/leader-powerflip-tracker";
import { trackPartyCoClears } from "../../lib/quest/finish/party-co-clear-tracker";
import type { FinishContext } from "../../lib/quest/finish/types";

interface PlayerContext { playerId: number; player: Player }

async function resolvePlayer(viewerId: number): Promise<PlayerContext | null> {
    const session = await getSession(viewerId.toString());
    if (!session) return null;
    const playerId = resolvePlayerIdSync(session.accountId);
    if (!playerId) return null;
    const player = getPlayerSync(playerId);
    if (!player) return null;
    return { playerId, player };
}

async function buildFinishFollowInfo(
    viewerId: number,
    mateResults: Array<{ viewer_id?: number }>,
    fallbackMateIds: number[] = [],
) {
    const ids = new Set<number>();
    for (const result of mateResults) {
        const mateViewerId = Number(result?.viewer_id);
        if (Number.isFinite(mateViewerId)) ids.add(mateViewerId);
    }
    for (const mateViewerId of fallbackMateIds) {
        if (Number.isFinite(mateViewerId)) ids.add(Number(mateViewerId));
    }

    const followInfo = [];
    for (const mateViewerId of ids) {
        if (mateViewerId === viewerId || mateViewerId >= 900000000) continue;

        const mateCtx = await resolvePlayer(mateViewerId);
        if (!mateCtx) continue;

        followInfo.push({
            viewer_id: mateViewerId,
            name: mateCtx.player.name,
            last_login_time: getServerTime(new Date()),
            rank: getRankDegree(mateCtx.player.rankPoint || 0),
            comment: "",
            role: mateCtx.player.role || 1,
            degree_id: mateCtx.player.degreeId || 1,
            follow_state: 0,
            follow_time: null,
            followed_time: null,
            profile_image_url: null,
        });
    }

    return followInfo;
}

export function registerBattleRoutes(fastify: FastifyInstance): void {

    // ---- start ----
    fastify.post("/start", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as MultiStartBody;
        const { viewer_id, quest_id, category, party_id, use_boost_point, use_boss_boost_point, is_auto_start_mode, room_number, mate_player_ids, play_id } = body;
        console.log(`[MULTI] start: viewer=${viewer_id} quest=${quest_id} category=${category} party=${party_id} room=${room_number}`);

        if (isNaN(viewer_id) || isNaN(party_id) || isNaN(quest_id) || isNaN(category) || use_boost_point === undefined || use_boss_boost_point === undefined || is_auto_start_mode === undefined) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Invalid request body."
            });
        }

        const ctx = await resolvePlayer(viewer_id);
        if (!ctx) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Invalid viewer id or no player bound."
            });
        }

        const questData = getQuestFromCategorySync(category, quest_id) as BattleQuest | null;
        if (questData === null || !('rankPointReward' in questData)) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Quest doesn't exist."
            });
        }

        const room = getRoom(room_number);
        if (!room) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Room doesn't exist."
            });
        }

        setRoomBattle(room_number);

        const mateComIds = room.mates.map(m => m.com_id);
        insertActiveQuest(ctx.playerId, {
            questId: quest_id,
            category,
            useBoostPoint: use_boost_point,
            useBossBoostPoint: use_boss_boost_point,
            isAutoStartMode: is_auto_start_mode,
            isMulti: true,
            roomNumber: room_number,
            matePlayerIds: mate_player_ids,
            mateComIds,
            playId: play_id,
            continueCount: 0,
        });

        if (questData.fixedParty === undefined) {
            updatePlayerSync({ id: ctx.playerId, partySlot: party_id });
        }

        reply.header("content-type", "application/x-msgpack");
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id }),
            "data": {
                "is_multi": "multi",
                "play_id": play_id,
            }
        });
    });

    // ---- finish ----
    fastify.post("/finish", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as MultiFinishBody;
        const viewerId = body.viewer_id;
        console.log(`[MULTI] finish: viewer=${viewerId} quest=${body.quest_id} category=${body.category} room=${body.room_number}`);

        if (!viewerId || isNaN(viewerId)) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Invalid request body."
            });
        }

        const ctx = await resolvePlayer(viewerId);
        if (!ctx || !ctx.player) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Invalid viewer id."
            });
        }

        const { playerId, player } = ctx;

        const activeQuestData = activeQuests[playerId];
        if (activeQuestData === undefined) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "No active quest to finish."
            });
        }

        const questCategory = activeQuestData.category;
        const questId = activeQuestData.questId;
        const questData = getQuestFromCategorySync(questCategory, questId) as BattleQuest | null;
        if (questData === null || !('rankPointReward' in questData)) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Quest doesn't exist."
            });
        }

        delete activeQuests[playerId];
        deletePlayerActiveQuestSync(playerId);

        if (activeQuestData.roomNumber) {
            sessionManager.clearBattleExpectedCount(activeQuestData.roomNumber);
        }

        if (activeQuestData.roomNumber) {
            const room = getRoom(activeQuestData.roomNumber);
            if (room && room.host_player_id === playerId) {
                updateRoomState(room.room_number, 1);
                console.log(`[MULTI] finish: room ${activeQuestData.roomNumber} reset to raising_state=1`);
            }
        }

        // calculate clear rank
        const clearTime = (body as any).elapsed_time_ms || 0;
        const hasRankThresholds = questData.bRankTime > 0;
        const clearRank = hasRankThresholds ? (
            questData.sPlusRankTime >= clearTime ? 5
                : questData.sRankTime >= clearTime ? 4
                    : questData.aRankTime >= clearTime ? 3
                        : questData.bRankTime >= clearTime ? 2
                            : 1
        ) : null;

        const beforeRankPoint = player.rankPoint;
        const newRankPoint = beforeRankPoint + questData.rankPointReward;
        const newMana = player.freeMana + questData.manaReward + ((body as any).add_mana || 0);
        const manaObtained = questData.manaReward + ((body as any).add_mana || 0);
        const newExpPool = player.expPool + questData.poolExpReward;

        let newBoostPoint = player.boostPoint - (activeQuestData.useBoostPoint ? 1 : 0);
        let newBossBoostPoint = player.bossBoostPoint - (activeQuestData.useBossBoostPoint ? 1 : 0);
        const useBoostPoint = (activeQuestData.useBoostPoint && (newBoostPoint >= 0)) || (activeQuestData.useBossBoostPoint && (newBossBoostPoint >= 0));

        // quest progress
        const questProgress = getPlayerSingleQuestProgressSync(playerId, questCategory, questId);
        const questPreviouslyCompleted = questProgress !== null;
        const questAccomplished = (body as any).is_accomplished;
        const leaderId = ((body as any).statistics?.party || (body as any).quest_statistics?.party)?.characters?.[0]?.id

        const clearReward = !questPreviouslyCompleted && (questData as any).clearReward !== undefined ? givePlayerRewardSync(playerId, (questData as any).clearReward) : null;
        const sPlusClearReward = (clearRank === 5) && (questProgress?.clearRank !== 5) && ((questData as any).sPlusReward !== undefined) ? givePlayerRewardSync(playerId, (questData as any).sPlusReward) : null;
        if (questAccomplished) {
            if (questPreviouslyCompleted) {
                const updateData: any = {
                    questId: questId,
                    finished: true,
                    bestElapsedTimeMs: questProgress.bestElapsedTimeMs === undefined || questProgress.bestElapsedTimeMs === null ? clearTime : Math.min(clearTime, questProgress.bestElapsedTimeMs),
                    highScore: questProgress.highScore === undefined ? ((body as any).score || 0) : Math.max((body as any).score || 0, questProgress.highScore),
                    leaderCharacterId: leaderId ?? null
                };
                if (clearRank !== null) {
                    updateData.clearRank = questProgress.clearRank === undefined ? clearRank : Math.max(clearRank, questProgress.clearRank);
                }
                updatePlayerQuestProgressSync(playerId, questCategory, updateData);
            } else {
                insertPlayerQuestProgressSync(playerId, questCategory, {
                    questId: questId,
                    finished: true,
                    bestElapsedTimeMs: clearTime,
                    highScore: (body as any).score || 0,
                    clearRank: clearRank ?? 5,
                    leaderCharacterId: leaderId ?? null
                });
            }
        }

        const oldRkDegree = getRankDegree(beforeRankPoint);
        const newDegreeId = getRankDegree(newRankPoint);
        const didLevelUp = newDegreeId > oldRkDegree;

        // Increment multi clear count for event mission tracking
        getDb().prepare(`
        UPDATE players_quest_progress SET multi_clear_count = multi_clear_count + 1
        WHERE player_id = ? AND section = ? AND quest_id = ?
        `).run(playerId, Number(questCategory), Number(questId))
        updatePlayerSync({
            id: playerId,
            freeMana: newMana,
            expPool: newExpPool,
            rankPoint: newRankPoint,
            boostPoint: newBoostPoint,
            bossBoostPoint: newBossBoostPoint,
            totalManaObtained: (player.totalManaObtained ?? 0) + manaObtained,
            maxComboAchieved: Math.max(player.maxComboAchieved ?? 0, (body as any).statistics?.max_combo_count ?? 0),
            ...(didLevelUp ? { stamina: player.stamina + getMaxStamina(newDegreeId), staminaHealTime: new Date() } : {}),
        });
        const playerData = player;
        if (didLevelUp) {
            playerData.stamina = playerData.stamina + getMaxStamina(newDegreeId);
            playerData.staminaHealTime = new Date();
        }

        const scoreRewardsResult = givePlayerScoreRewardsSync(playerId, (questData as any).scoreRewardGroupId || 0, (questData as any).scoreRewardGroup, useBoostPoint, (questData as any).element);

        const bodyPartyStatistics = (body as any).statistics?.party || body.quest_statistics?.party || { characters: [], unison_characters: [] };
        const partyCharacterIdsArray: number[] = [];
        for (const value of [...(bodyPartyStatistics.characters || []), ...(bodyPartyStatistics.unison_characters || [])]) {
            if (value !== null && (value as any).id !== null && (value as any).id !== undefined) partyCharacterIdsArray.push((value as any).id);
        }

        // Track mission progress (decoupled from core quest mechanics)
        const finishCtx: FinishContext = {
            playerId, questCategory, questId,
            questAccomplished,
            clearTime, clearRank,
            party: bodyPartyStatistics as any,
            statistics: (body as any).statistics || (body as any).quest_statistics || {},
            player,
            questPreviouslyCompleted,
            questProgress,
            isMulti: true,
        }
        trackCharacterClears(finishCtx)
        trackLeaderPowerflip(finishCtx)
        trackPartyCoClears(finishCtx)
        trackPowerflip(finishCtx)

        const rewardCharacterExpResult = givePlayerCharactersExpSync(
            playerId, partyCharacterIdsArray, questData.characterExpReward || 0,
            questData.fixedParty !== undefined
        );

        const dataHeaders = generateDataHeaders({ viewer_id: viewerId });
        const matePlayerResult = ((body as any).mate_player_result || []) as Array<{ viewer_id?: number }>;
        const followInfo = await buildFinishFollowInfo(viewerId, matePlayerResult, activeQuestData.matePlayerIds || []);

        reply.header("content-type", "application/x-msgpack");
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
                    "stamina": playerData.stamina,
                    "stamina_heal_time": realToVirtual(playerData.staminaHealTime),
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
                    "field_mana": (body as any).add_mana || 0
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
                "item_list": scoreRewardsResult.items,
                "presigned_quest_category": [],
                "mate_player_result": matePlayerResult,
                "follow_info": followInfo,
                "contribution_score": (body as any).contribution_score ?? 0,
                "host_finished": true,
                "aborted_play_id": null,
            }
        });
    });

    // ---- abort ----
    fastify.post("/abort", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as MultiAbortBody;
        const viewerId = body.viewer_id;
        console.log(`[MULTI] abort: viewer=${viewerId} quest=${body.quest_id} category=${body.category}`);

        if (isNaN(viewerId)) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Invalid request body."
            });
        }

        const ctx = await resolvePlayer(viewerId);
        if (!ctx) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Invalid viewer id or no player bound."
            });
        }

        const { playerId, player } = ctx;
        const activeQuestData = activeQuests[playerId];

        if (activeQuestData) {
            if (activeQuestData.roomNumber) {
                const room = getRoom(activeQuestData.roomNumber);
                if (room && room.host_player_id === playerId) {
                    disbandRoom(activeQuestData.roomNumber);
                    console.log(`[MULTI] abort: room ${activeQuestData.roomNumber} disbanded (host abandoned)`);
                }
            }
            delete activeQuests[playerId];
            deletePlayerActiveQuestSync(playerId);
            if (activeQuestData.roomNumber) {
                sessionManager.clearBattleExpectedCount(activeQuestData.roomNumber);
            }
        }

        const headers = generateDataHeaders({ viewer_id: viewerId });
        reply.header("content-type", "application/x-msgpack");
        return reply.status(200).send({
            "data_headers": headers,
            "data": {
                "user_info": {},
                "category_id": body.category,
                "is_multi": "multi",
                "start_time": headers['servertime'],
                "quest_name": "",
                "aborted_play_id": null,
                "unfinished_play_id": null,
                "drawn_quest": null,
                "party_info": null,
                "presigned_url": null
            }
        });
    });

    // ---- play_continue ----
    fastify.post("/play_continue", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as PlayContinueBody;
        const viewerId = body.viewer_id;
        console.log(`[MULTI] play_continue: viewer=${viewerId} quest=${body.quest_id} category=${body.category}`);

        if (isNaN(viewerId)) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Invalid request body."
            });
        }

        const ctx = await resolvePlayer(viewerId);
        if (!ctx || !ctx.player) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Invalid viewer id or no player bound."
            });
        }

        const { playerId } = ctx;

        if (activeQuests[playerId] === undefined) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "No active quest to continue."
            });
        }

        const activeData = activeQuests[playerId];
        activeData.continueCount++;
        updatePlayerActiveQuestContinueCountSync(playerId, activeData.continueCount);

        reply.header("content-type", "application/x-msgpack");
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                continue_count: activeData.continueCount,
            }
        });
    });
}
