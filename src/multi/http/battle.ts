import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { MultiStartBody, MultiFinishBody, MultiAbortBody, PlayContinueBody } from "../types";
import { generateDataHeaders, getServerTime, realToVirtual } from "../../utils";
import { getRoom, disbandRoom } from "../room/manager";
import { sessionManager } from "../state/SessionManager";
import {
    ActiveQuestSettlementConflictError,
    activeQuests,
    persistActiveQuest,
    publishActiveQuest,
    runAbortActiveQuestTransaction,
    runContinueActiveQuestTransaction,
    runMultiActiveQuestSettlementTransaction,
} from "../../lib/quest/active-quest-service";
import { getPlayerActiveQuestSync } from "../../data/domains/quest_active";
import { incrementPlayerCharacterClearSync } from "../../data/domains/character_clear";
import {
    getPlayerSync,
    updatePlayerSync,
} from "../../data/domains/player";
import { getPlayerItemSync, updatePlayerItemSync } from "../../data/domains/item";
import {
    getPlayerSingleQuestProgressSync,
    insertPlayerQuestProgressSync,
    updatePlayerQuestProgressSync,
} from "../../data/domains/quest";
import { getConfigSync, getQuestConfigurationErrorResponse, getQuestFromCategorySync } from "../../lib/assets";
import { getCharactersEvolutionImgLevels, givePlayerCharactersExpSync } from "../../lib/character";
import { givePlayerRewardsSync, givePlayerRewardSync, givePlayerScoreRewardsSync } from "../../lib/quest";
import { computeRealTimeStamina, getRankDegree, getMaxStamina } from "../../lib/stamina";
import { getStaminaCost } from "../../lib/stamina-cost";
import { BattleQuest, EquipmentItemReward, PlayerRewardResult, QuestCategory } from "../../lib/types";
import { getDb } from "../../data/db";
import { getPlayerMailCountSync } from "../../data/domains/mail";
import { getServerGameplaySettingsSync } from "../../data/domains/server-settings";
import { BATTLE_SETTLEMENT_CATEGORIES, recordMissionBattleFacts } from "../../lib/mission/battle-facts";
import type { FinishContext } from "../../lib/quest/finish/types";
import {
    mergeMissionSettlementResponse,
    reconcileAwakeUnlockCharacterList,
    settleMissionCategories,
} from "../../lib/mission";
import { resolveHostFinished } from "../../lib/quest/host-finish";
import { resolveQuestRewardEligibility } from "../../lib/quest/first-clear-reward";
import { getCommonScoreRewardCount } from "../../lib/score-reward-lottery";
import {
    calculateCharacterBattleExp,
    calculateFixedQuestMana,
    calculateFixedQuestPoolExp,
    getRewardCampaignRates,
} from "../../lib/reward-campaign";
import bundledAdditionalRewardRules from "../../../assets/additional_reward_rules.json";
import { getRuntimeContentTableSync } from "../../content/runtime/table-access";
import {
    settleAdditionalRewardsSync,
    type AdditionalRewardTable,
} from "../../lib/additional-reward";
import { buildFinishFollowInfo } from "../../lib/quest/finish/follow-info";
import bundledQuestEntryCosts from "../../../assets/quest_entry_costs.json";
import {
    ActiveQuestAlreadyExistsError,
    buildStartEntryItemList,
    InsufficientEntryItemError,
    InsufficientStaminaError,
    PlayerNotFoundError,
    runStartEntryTransaction,
    type StartEntryCost,
} from "../../lib/quest/start-entry";
import {
    validateMultiFinishRequest,
    validateMultiStartRequest,
} from "../../lib/quest/multi-battle-validation";
import { isValidMultiViewerId, type MultiHttpContext } from "./context";
import {
    participantKey,
    type BattleSessionId,
    type ParticipantIdentity,
} from "../coordinator/contracts";

export function canAbortMultiBattle(
    roomNumber: string,
    participant: ParticipantIdentity,
): boolean {
    const room = getRoom(roomNumber);
    return room?.host_viewer_id !== participant.viewerId
        || sessionManager.isBattleHostParticipant(roomNumber, participant);
}

export function cleanupAbortedMultiBattle(
    roomNumber: string,
    participant: ParticipantIdentity,
): boolean {
    const room = getRoom(roomNumber);
    if (!canAbortMultiBattle(roomNumber, participant)) return false;
    if (room?.host_viewer_id === participant.viewerId) {
        return disbandRoom(roomNumber);
    }
    sessionManager.removeBattleParticipant(roomNumber, participant);
    return false;
}

export function registerBattleRoutes(fastify: FastifyInstance, context: MultiHttpContext): void {

    // ---- start ----
    fastify.post("/start", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as MultiStartBody;
        const { viewer_id, quest_id, category, party_id, use_boost_point, use_boss_boost_point, is_auto_start_mode, room_number, mate_player_ids, play_id } = body;
        console.log(`[MULTI] start: viewer=${viewer_id} quest=${quest_id} category=${category} party=${party_id} room=${room_number}`);

        const requestValidation = validateMultiStartRequest({
            viewerId: viewer_id,
            partyId: party_id,
            questId: quest_id,
            category,
            playId: play_id,
            useBoostPoint: use_boost_point,
            useBossBoostPoint: use_boss_boost_point,
            isAutoStartMode: is_auto_start_mode,
            isRoomMember: true,
            roomCategory: category,
            roomQuestId: quest_id,
        });
        if (!requestValidation.ok) {
            return reply.status(400).send({
                "error": "Bad Request", "message": requestValidation.message,
            });
        }

        const ctx = await context.resolvePlayerContext(viewer_id);
        if (!ctx) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Invalid viewer id or no player bound."
            });
        }

        let questData: BattleQuest | null;
        try {
            questData = getQuestFromCategorySync(category, quest_id);
        } catch (error) {
            const configurationError = getQuestConfigurationErrorResponse(error);
            if (configurationError !== null) return reply.status(500).send(configurationError);
            throw error;
        }
        if (questData === null || !('rankPointReward' in questData)) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Quest doesn't exist."
            });
        }

        const availability = context.questAvailability.check(category, quest_id);
        if (!availability.available) {
            return reply.status(400).send({
                "error": availability.code, "message": "Quest is not available."
            });
        }

        const participant = context.snapshotProvider.getParticipant(viewer_id);
        const room = await context.coordinator.getRoomStatus({
            participant,
            roomNumber: room_number,
        });
        const identityKey = participantKey(participant.nodeSessionId, participant.viewerId);
        const isRoomMember = room.ok && room.value.members.some(member => participantKey(
            member.nodeSessionId,
            member.viewerId,
        ) === identityKey);
        const roomValidation = validateMultiStartRequest({
            viewerId: viewer_id,
            partyId: party_id,
            questId: quest_id,
            category,
            playId: play_id,
            useBoostPoint: use_boost_point,
            useBossBoostPoint: use_boss_boost_point,
            isAutoStartMode: is_auto_start_mode,
            isRoomMember,
            roomCategory: room.ok ? room.value.category : -1,
            roomQuestId: room.ok ? room.value.questId : -1,
        });
        if (!room.ok || !roomValidation.ok) {
            return reply.status(400).send({
                "error": "Bad Request",
                "message": roomValidation.ok ? "Room is unavailable." : roomValidation.message,
            });
        }

        const battle = await context.coordinator.startBattle({ participant, roomNumber: room_number });
        if (!battle.ok
            || battle.value.finalized
            || battle.value.roomNumber !== room_number
            || participantKey(
                battle.value.host.nodeSessionId,
                battle.value.host.viewerId,
            ) !== participantKey(room.value.host.nodeSessionId, room.value.host.viewerId)
            || !battle.value.participants.some(member => participantKey(
                member.nodeSessionId,
                member.viewerId,
            ) === identityKey)) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Battle session is unavailable.",
            });
        }

        const isRoomHost = participantKey(
            room.value.host.nodeSessionId,
            room.value.host.viewerId,
        ) === identityKey;
        const questKey = `${category}_${quest_id}`;
        const entryCost = isRoomHost
            ? getRuntimeContentTableSync(
                "quest_entry_costs.json",
                bundledQuestEntryCosts as Record<string, StartEntryCost>,
            )[questKey]
            : undefined;
        const staminaCost = isRoomHost ? getStaminaCost(questKey).cost : 0;
        const activeQuest = {
            questId: quest_id,
            category,
            useBoostPoint: use_boost_point,
            useBossBoostPoint: use_boss_boost_point,
            isAutoStartMode: is_auto_start_mode,
            isMulti: true,
            roomNumber: room_number,
            battleSessionId: battle.value.battleSessionId,
            matePlayerIds: Array.isArray(mate_player_ids) ? mate_player_ids : [],
            mateComIds: [],
            entryItemId: entryCost && entryCost.itemId > 0 ? entryCost.itemId : undefined,
            entryItemCount: entryCost && entryCost.itemCount > 0 ? entryCost.itemCount : undefined,
            playId: play_id,
            continueCount: 0,
        };
        let startResult;
        try {
            startResult = runStartEntryTransaction({
                playerId: ctx.playerId,
                entryCost,
                staminaCost,
                partyId: party_id,
                updatePartySlot: questData.fixedParty === undefined,
                activeQuest,
                now: new Date(),
            }, {
                transaction: operation => getDb().transaction(operation)(),
                getActiveQuest: getPlayerActiveQuestSync,
                getPlayer: getPlayerSync,
                computeStamina: computeRealTimeStamina,
                getItemCount: getPlayerItemSync,
                updateItemCount: updatePlayerItemSync,
                updatePlayer: updatePlayerSync,
                persistActiveQuest,
                publishActiveQuest,
            });
        } catch (error) {
            if (error instanceof ActiveQuestAlreadyExistsError
                || error instanceof InsufficientEntryItemError
                || error instanceof InsufficientStaminaError
                || error instanceof PlayerNotFoundError) {
                return reply.status(400).send({
                    "error": "Bad Request", "message": error.message,
                });
            }
            throw error;
        }
        reply.header("content-type", "application/x-msgpack");
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id }),
            "data": {
                "is_multi": "multi",
                "play_id": play_id,
                "user_info": {
                    "stamina": startResult.afterStamina,
                    "stamina_heal_time": realToVirtual(new Date()),
                },
                "item_list": buildStartEntryItemList(startResult),
            }
        });
    });

    // ---- finish ----
    fastify.post("/finish", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as MultiFinishBody;
        const viewerId = body.viewer_id;
        console.log(`[MULTI] finish: viewer=${viewerId} quest=${body.quest_id} category=${body.category} room=${body.room_number}`);

        if (!isValidMultiViewerId(viewerId)) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Invalid request body."
            });
        }

        const ctx = await context.resolvePlayerContext(viewerId);
        if (!ctx || !ctx.player) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Invalid viewer id."
            });
        }

        const { playerId } = ctx;
        const participant = context.snapshotProvider.getParticipant(viewerId);

        const activeQuestData = activeQuests[playerId];
        if (activeQuestData === undefined) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "No active quest to finish."
            });
        }

        const questCategory = activeQuestData.category;
        const questId = activeQuestData.questId;
        let questData: BattleQuest | null;
        try {
            questData = getQuestFromCategorySync(questCategory, questId);
        } catch (error) {
            const configurationError = getQuestConfigurationErrorResponse(error);
            if (configurationError !== null) return reply.status(500).send(configurationError);
            throw error;
        }
        if (questData === null || !('rankPointReward' in questData)) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Quest doesn't exist."
            });
        }

        const finishValidation = validateMultiFinishRequest(
            body as unknown as Record<string, unknown>,
            activeQuestData,
        );
        if (!finishValidation.ok) {
            return reply.status(400).send({
                "error": "Bad Request", "message": finishValidation.message,
            });
        }

        if (typeof activeQuestData.roomNumber !== "string"
            || typeof activeQuestData.battleSessionId !== "string") {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Battle session identity is missing."
            });
        }
        const settlement = await context.settlementVerifier.verify({
            nodeSessionId: participant.nodeSessionId,
            viewerId,
            roomNumber: activeQuestData.roomNumber,
            battleSessionId: activeQuestData.battleSessionId,
        });
        if (!settlement.ok) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Battle is not finalized."
            });
        }
        const finalizedBattle = await context.coordinator.finalizeBattle({
            participant,
            roomNumber: activeQuestData.roomNumber,
            battleSessionId: activeQuestData.battleSessionId as BattleSessionId,
        });
        if (!finalizedBattle.ok || !finalizedBattle.value.finalized) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Battle finalization is unavailable."
            });
        }
        const isRoomHost = settlement.isHost;
        console.log(`[MULTI] finish host context: playerId=${playerId} isRoomHost=${isRoomHost}`);
        // calculate clear rank
        const clearTime = finishValidation.elapsedTimeMs;
        const hasRankThresholds = questData.bRankTime > 0;
        const clearRank = hasRankThresholds ? (
            questData.sPlusRankTime >= clearTime ? 5
                : questData.sRankTime >= clearTime ? 4
                    : questData.aRankTime >= clearTime ? 3
                        : questData.bRankTime >= clearTime ? 2
                            : 1
        ) : null;

        const useBoostPoint = activeQuestData.useBoostPoint || activeQuestData.useBossBoostPoint;
        const questAccomplished = body.is_accomplished;
        const leaderId = (finishValidation.statistics as any).party?.characters?.[0]?.id

        const bodyPartyStatistics = (finishValidation.statistics as any).party || { characters: [], unison_characters: [] };
        const partyCharacterIdsArray: number[] = [];
        for (const value of [...(bodyPartyStatistics.characters || []), ...(bodyPartyStatistics.unison_characters || [])]) {
            if (value !== null && (value as any).id !== null && (value as any).id !== undefined) partyCharacterIdsArray.push((value as any).id);
        }

        const executeFinishWrites = () => {
            const player = getPlayerSync(playerId)
            if (!player) throw new PlayerNotFoundError(playerId)
            const freshValidation = validateMultiFinishRequest(
                body as unknown as Record<string, unknown>,
                activeQuestData,
                {
                    boostPoint: player.boostPoint,
                    bossBoostPoint: player.bossBoostPoint,
                },
            )
            if (!freshValidation.ok) throw new ActiveQuestSettlementConflictError()
            const beforeRankPoint = player.rankPoint
            const newRankPoint = beforeRankPoint + questData.rankPointReward
            const newBoostPoint = player.boostPoint - (activeQuestData.useBoostPoint ? 1 : 0)
            const newBossBoostPoint = player.bossBoostPoint
                - (activeQuestData.useBossBoostPoint ? 1 : 0)
            const questProgress = getPlayerSingleQuestProgressSync(
                playerId,
                questCategory,
                questId,
            )
            const questProgressExists = questProgress !== null
            const questPreviouslyCompleted = questProgress?.finished === true
            const hostFinished = resolveHostFinished({
                previouslyHostFinished: questProgress?.hostFinished ?? false,
                questAccomplished,
                isRoomHost,
            })
            const rewardEligibility = resolveQuestRewardEligibility({
                questAccomplished,
                clearRank,
                questProgress,
            })
            const oldRkDegree = getRankDegree(beforeRankPoint)
            const newDegreeId = getRankDegree(newRankPoint)
            const didLevelUp = newDegreeId > oldRkDegree
            const finishCtx: FinishContext = {
                playerId, questCategory, questId,
                questAccomplished,
                clearTime, clearRank,
                score: freshValidation.score,
                party: bodyPartyStatistics as any,
                statistics: freshValidation.statistics as any,
                equipmentElements: (body as any).equipment_element,
                player,
                questPreviouslyCompleted,
                questProgress,
                isMulti: true,
                isMultiHost: isRoomHost,
            }
            const settlementTime = new Date(getServerTime() * 1000)
            const rewardCampaignRates = getRewardCampaignRates(
                questCategory,
                questId,
                settlementTime,
            )
            const fixedManaReward = calculateFixedQuestMana(
                questData.manaReward,
                rewardCampaignRates,
                useBoostPoint,
            )
            const fixedPoolExpReward = calculateFixedQuestPoolExp(
                questData.poolExpReward,
                rewardCampaignRates,
                useBoostPoint,
            )
            const characterBattleExp = calculateCharacterBattleExp(
                questData.characterExpReward || 0,
                rewardCampaignRates,
            )
            const fieldMana = freshValidation.addMana
            const newMana = player.freeMana + fixedManaReward + fieldMana;
            const manaObtained = fixedManaReward + fieldMana;
            const clearReward = rewardEligibility.firstClear && (questData as any).clearReward !== undefined
                ? givePlayerRewardSync(playerId, (questData as any).clearReward)
                : null;
            const sPlusClearReward = rewardEligibility.sPlus
                && ((questData as any).sPlusReward !== undefined)
                ? givePlayerRewardSync(playerId, (questData as any).sPlusReward)
                : null;

            if (questAccomplished) {
                if (questProgressExists) {
                    const updateData: any = {
                        questId: questId,
                        finished: true,
                        bestElapsedTimeMs: questProgress.bestElapsedTimeMs === undefined || questProgress.bestElapsedTimeMs === null ? clearTime : Math.min(clearTime, questProgress.bestElapsedTimeMs),
                        highScore: questProgress.highScore === undefined ? freshValidation.score : Math.max(freshValidation.score, questProgress.highScore),
                        leaderCharacterId: leaderId ?? null,
                        hostFinished,
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
                        highScore: freshValidation.score,
                        clearRank: clearRank ?? 5,
                        leaderCharacterId: leaderId ?? null,
                        hostFinished,
                    });
                }
            }

            updatePlayerSync({
                id: playerId,
                freeMana: newMana,
                expPool: player.expPool + fixedPoolExpReward,
                rankPoint: newRankPoint,
                boostPoint: newBoostPoint,
                bossBoostPoint: newBossBoostPoint,
                totalManaObtained: (player.totalManaObtained ?? 0) + manaObtained,
                maxComboAchieved: Math.max(player.maxComboAchieved ?? 0, (freshValidation.statistics as any).max_combo_count ?? 0),
                ...(didLevelUp ? { stamina: player.stamina + getMaxStamina(newDegreeId), staminaHealTime: new Date() } : {}),
            });
            const playerData = { ...player };
            if (didLevelUp) {
                playerData.stamina = playerData.stamina + getMaxStamina(newDegreeId);
                playerData.staminaHealTime = new Date();
            }

            const scoreRewardsResult = givePlayerScoreRewardsSync(
                playerId,
                questData.scoreRewardGroupId || 0,
                questData.scoreRewardGroup,
                useBoostPoint,
                questData.element,
                {
                    commonRewardCount: getCommonScoreRewardCount(
                        questData,
                        clearRank,
                        getConfigSync().common_reward_multiplier_by_multi_play_mode,
                    ) ?? undefined,
                    rewardCampaignRates,
                    rewardDate: settlementTime,
                },
            );
            const additionalRewardSettlement = questAccomplished
                ? settleAdditionalRewardsSync(
                    getRuntimeContentTableSync(
                        "additional_reward_rules.json",
                        bundledAdditionalRewardRules as AdditionalRewardTable,
                    ),
                    {
                        questCategory,
                        questId,
                        enemyLevel: questData.enemyLevel,
                        nowMs: settlementTime.getTime(),
                        isMulti: true,
                        isQuestCleared: (category, requiredQuestId) => (
                            getPlayerSingleQuestProgressSync(
                                playerId,
                                category,
                                requiredQuestId,
                            )?.finished === true
                        ),
                        rewardCampaignRates,
                        boostPointUsed: useBoostPoint,
                        serverDropMultiplier: getServerGameplaySettingsSync().dropMultiplier,
                    },
                    { grantRewards: rewards => givePlayerRewardsSync(playerId, rewards) },
                )
                : { dropAdditionalRewardIds: [], rewardResult: null };
            recordMissionBattleFacts(finishCtx, settlementTime)
            const rewardCharacterExpResult = givePlayerCharactersExpSync(
                playerId, partyCharacterIdsArray, characterBattleExp,
                questData.fixedParty !== undefined
            );
            const missionSettlement = settleMissionCategories(
                playerId,
                BATTLE_SETTLEMENT_CATEGORIES,
                settlementTime,
            );
            const characterList = reconcileAwakeUnlockCharacterList(playerId, [
                ...rewardCharacterExpResult.character_list as unknown as Record<string, unknown>[],
                ...((clearReward?.character_list || []) as Record<string, unknown>[]),
                ...((sPlusClearReward?.character_list || []) as Record<string, unknown>[]),
                ...(scoreRewardsResult.character_list as Record<string, unknown>[])
            ]);
            return {
                characterList,
                clearReward,
                playerData,
                rewardCharacterExpResult,
                scoreRewardsResult,
                additionalRewardSettlement,
                sPlusClearReward,
                missionSettlement,
                fieldMana,
                fixedManaReward,
                fixedPoolExpReward,
                newMana,
                beforeRankPoint,
                newRankPoint,
                newBoostPoint,
                newBossBoostPoint,
                hostFinished,
                oldHighScore: questProgress?.highScore ?? 0,
            }
        }
        let finishWrites: ReturnType<typeof executeFinishWrites>
        try {
            finishWrites = runMultiActiveQuestSettlementTransaction(
                playerId,
                {
                    playId: activeQuestData.playId,
                    questId: activeQuestData.questId,
                    category: activeQuestData.category,
                    isMulti: true,
                    roomNumber: activeQuestData.roomNumber,
                    battleSessionId: activeQuestData.battleSessionId,
                    useBossBoostPoint: activeQuestData.useBossBoostPoint,
                    useBoostPoint: activeQuestData.useBoostPoint,
                    continueCount: activeQuestData.continueCount,
                },
                executeFinishWrites,
            )
        } catch (error) {
            if (error instanceof ActiveQuestSettlementConflictError) {
                return reply.status(400).send({
                    "error": "Bad Request", "message": error.message,
                })
            }
            throw error
        }
        const {
            characterList,
            clearReward,
            playerData,
            rewardCharacterExpResult,
            scoreRewardsResult,
            additionalRewardSettlement,
            sPlusClearReward,
            missionSettlement,
            fieldMana,
            fixedManaReward,
            fixedPoolExpReward,
            newMana,
            beforeRankPoint,
            newRankPoint,
            newBoostPoint,
            newBossBoostPoint,
            hostFinished,
            oldHighScore,
        } = finishWrites

        delete activeQuests[playerId];

        const dataHeaders = generateDataHeaders({ viewer_id: viewerId });
        const matePlayerResult = ((body as any).mate_player_result || []) as Array<{ viewer_id?: number }>;
        const followInfo = await buildFinishFollowInfo(viewerId, matePlayerResult, activeQuestData.matePlayerIds || []);

        reply.header("content-type", "application/x-msgpack");
        const responseData: Record<string, any> = {
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
                "character_list": characterList,
                "bond_token_status_list": rewardCharacterExpResult.bond_token_status_list,
                "rewards": {
                    "overflow_pool_exp": 0,
                    "converted_pool_exp": 0,
                    "reward_pool_exp": fixedPoolExpReward,
                    "reward_mana": fixedManaReward,
                    "field_mana": fieldMana
                },
                "old_high_score": oldHighScore,
                "joined_character_id_list": [
                    ...(clearReward?.joined_character_id_list || []),
                    ...(sPlusClearReward?.joined_character_id_list || []),
                    ...scoreRewardsResult.joined_character_id_list
                ],
                "before_rank_point": beforeRankPoint,
                "clear_rank": clearRank ?? 5,
                "drop_score_reward_ids": scoreRewardsResult.drop_score_reward_ids,
                "drop_rare_reward_ids": scoreRewardsResult.drop_rare_reward_ids,
                "drop_additional_reward_ids": additionalRewardSettlement.dropAdditionalRewardIds,
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
                    ...(additionalRewardSettlement.rewardResult?.items ?? {}),
                },
                "presigned_quest_category": [],
                "mate_player_result": matePlayerResult,
                "follow_info": followInfo,
                "contribution_score": (body as any).contribution_score ?? 0,
                "host_finished": hostFinished,
                "aborted_play_id": null,
        };
        mergeMissionSettlementResponse(responseData, missionSettlement, viewerId);
        responseData.mail_arrived = getPlayerMailCountSync(playerId, true) > 0;
        return reply.status(200).send({
            "data_headers": dataHeaders,
            "data": responseData,
        });
    });

    // ---- abort ----
    fastify.post("/abort", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as MultiAbortBody;
        const viewerId = body.viewer_id;
        console.log(`[MULTI] abort: viewer=${viewerId} quest=${body.quest_id} category=${body.category}`);

        if (!isValidMultiViewerId(viewerId)) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Invalid request body."
            });
        }

        const ctx = await context.resolvePlayerContext(viewerId);
        if (!ctx) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Invalid viewer id or no player bound."
            });
        }

        const { playerId } = ctx;
        const participant = context.snapshotProvider.getParticipant(viewerId);
        const activeQuestData = activeQuests[playerId];
        const storedQuest = getPlayerActiveQuestSync(playerId)
        if (!activeQuestData
            || !storedQuest
            || !storedQuest.isMulti
            || typeof storedQuest.roomNumber !== "string"
            || storedQuest.playId !== body.play_id
            || storedQuest.questId !== body.quest_id
            || storedQuest.category !== body.category) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Active quest does not match abort request."
            })
        }
        const hubAbort = await context.coordinator.abortBattle({
            participant,
            roomNumber: storedQuest.roomNumber,
        })
        if (!hubAbort.ok) {
            const forbidden = hubAbort.error === "ROOM_PERMISSION_DENIED"
            return reply.status(forbidden ? 403 : 400).send({
                "error": forbidden ? "Forbidden" : "Bad Request",
                "message": "Battle abort is unavailable.",
            })
        }

        const abortResult = runAbortActiveQuestTransaction(playerId, {
            playId: body.play_id,
            questId: body.quest_id,
            category: body.category,
        });
        if (!abortResult.cancelled) return reply.status(400).send({
            "error": "Bad Request", "message": "Active quest was already changed."
        })

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

        if (!isValidMultiViewerId(viewerId)) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Invalid request body."
            });
        }

        const ctx = await context.resolvePlayerContext(viewerId);
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
        const continueCount = runContinueActiveQuestTransaction(playerId, activeData, {
            playId: body.play_id,
            questId: body.quest_id,
            category: body.category,
        });
        if (continueCount === null) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Active quest does not match continue request."
            });
        }

        reply.header("content-type", "application/x-msgpack");
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                continue_count: continueCount,
            }
        });
    });
}
