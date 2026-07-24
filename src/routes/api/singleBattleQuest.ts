import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { deletePlayerActiveQuestSync, updatePlayerActiveQuestContinueCountSync } from "../../data/domains/quest_active"
import { deletePlayerRushEventPlayedPartyListSync, getPlayerRushEventPlayedPartiesSync, getPlayerRushEventSync, insertPlayerRushEventClearedFolderSync, insertPlayerRushEventPlayedPartySync, updatePlayerRushEventSync } from "../../data/domains/rushEvent"
import { getPlayerDailyChallengePointListSync, getPlayerSync, updatePlayerDailyChallengePointSync, updatePlayerSync } from "../../data/domains/player"
import { getPlayerItemSync, givePlayerItemSync, updatePlayerItemSync } from "../../data/domains/item"
import { getPlayerMailCountSync } from "../../data/domains/mail"
import { getPlayerSingleQuestProgressSync, insertPlayerQuestProgressSync, updatePlayerQuestProgressSync } from "../../data/domains/quest"
import { getSession } from "../../data/domains/session"
import { incrementPlayerCharacterClearSync } from "../../data/domains/character_clear"
import { updatePlayerEquipmentSync } from "../../data/domains/equipment"
import {
    getPlayerCarnivalEventRecordsSync,
    getPlayerClaimedCarnivalRewardIdsSync,
    insertPlayerClaimedCarnivalRewardIdsSync,
    runCarnivalEventTransactionSync,
    upsertPlayerCarnivalEventRecordSync,
} from "../../data/domains/carnivalEvent"
import { getQuestFromCategorySync, getRushEventFolderClearRewards } from "../../lib/assets";
import { getCharactersEvolutionImgLevels, givePlayerCharactersExpSync } from "../../lib/character";
import { givePlayerRewardsSync, givePlayerRewardSync, givePlayerScoreRewardsSync } from "../../lib/quest";
import { BattleQuest, EquipmentItemReward, PlayerRewardResult, QuestCategory } from "../../lib/types";
import { generateDataHeaders, getServerTime, realToVirtual } from "../../utils";
import { rushEventFolderMaxRounds } from "./rushEvent";
import { RushEventBattleType, UserRushEventPlayedParty } from "../../data/types";
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { computeRealTimeStamina, getRankDegree, getMaxStamina } from "../../lib/stamina";
import { getStaminaCost } from "../../lib/stamina-cost";
import { handleCarnivalEventFinish } from "../../lib/quest/finish/carnival-handler";
import { handleRushEventFinish } from "../../lib/quest/finish/rush-handler";
import { handleRaidEventFinish } from "../../lib/quest/finish/raid-handler";
import { calculateClearRank } from "../../lib/quest/finish/quest-calc";
import {
    calculateScoreAttackClearRank,
    handleScoreAttackEventFinish,
    resolveScoreAttackBorderTiers,
    ScoreAttackBorderTier,
} from "../../lib/quest/finish/score-attack-handler";
import { validateSessionAndPlayer } from "../../lib/quest/finish/session-validator";
import { handleDailyChallengePoint } from "../../lib/quest/finish/challenge-point";
import { BATTLE_SETTLEMENT_CATEGORIES, recordMissionBattleFacts } from "../../lib/mission/battle-facts";
import type { FinishContext } from "../../lib/quest/finish/types";
import questEntryCosts from "../../../assets/quest_entry_costs.json";
import scoreAttackBorderRewards from "../../../assets/score_attack_border_reward.json";
import eventChallengePointMap from "../../../assets/event_challenge_point_map.json";

import { getSerializedPlayerRushEventPlayedPartiesSync } from "../../lib/rush";
import {
    mergeMissionSettlementResponse,
    reconcileAwakeUnlockCharacterList,
    settleMissionCategories,
} from "../../lib/mission";
import type { MissionSettlementResult } from "../../lib/mission";
import { getCarnivalRewardDefinitions, grantCarnivalRewards } from "../../lib/carnival-rewards";
import { givePlayerDegreeSync } from "../../data/domains/degree";
import { givePlayerEquipmentSync } from "../../lib/equipment";
import { getDb } from "../../data/db";
import {
    buildStartEntryItemList,
    InsufficientEntryItemError,
    InsufficientStaminaError,
    PlayerNotFoundError,
    runStartEntryTransaction,
    StartEntryCost,
} from "../../lib/quest/start-entry";
import {
    ActiveQuest,
    activeQuests,
    persistActiveQuest,
    publishActiveQuest,
    runAbortActiveQuestTransaction,
} from "../../lib/quest/active-quest-service";
import { recordActiveMissionQuestChallengeFactSync } from "../../lib/mission/active-entry-facts";

interface StartBody {
    quest_id: number
    use_boss_boost_point: boolean
    use_boost_point: boolean
    category: number
    viewer_id: number
    play_id: string
    is_auto_start_mode: boolean
    party_id: number
    api_count: number
}

interface QuestStatistics {
    clear_phase: number,
    party: {
        unison_characters: ({ id: (number | null) } | null)[],
        characters: ({ id: (number | null) } | null)[],
        equipments: ({ id: (number | null) } | null)[],
        ability_soul_ids: (number | null)[],
        leader?: ({ id: (number | null) } | null)
    }
    zones?: {
        use_power_flip_count?: number
        use_dash_count?: number
        use_skill_count?: number
        [key: string]: any
    }[]
}

export interface FinishBody {
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
    equipment_element?: number[]
    api_count: number
}

interface PlayContinueBody {
    api_count: number,
    payment_type: number,
    quest_id: number,
    viewer_id: number,
    paly_id: string,
    category: number
}

interface AbortBody {
    api_count: number,
    finish_kind: number,
    statistics: QuestStatistics,
    viewer_id: number,
    quest_id: number,
    play_id: string,
    category: number
}

interface ReturnRushEvent {
    rush_battle_reward_list: {
        kind: number,
        kind_id: number,
        number: number
    }[],
    rush_battle_played_party_list: Record<number, UserRushEventPlayedParty> | null,
    endless_battle_played_party_list: Record<number, UserRushEventPlayedParty> | null,
    is_out_of_period: boolean,
    endless_battle_next_round: number | null,
    endless_battle_max_round: number | null,
    high_score: number | null,
    best_elapsed_time_ms: number | null,
    old_endless_battle_max_round: number | null,
    old_best_elapsed_time_ms: number | null
}

const continueVmoneyCost = 50;

const routes = async (fastify: FastifyInstance) => {

    fastify.post("/finish", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as FinishBody

        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        })

        const sessionResult = await validateSessionAndPlayer(viewerId)
        if (!sessionResult) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id."
        })
        const { playerId, playerData } = sessionResult

        // get active quest data
        const activeQuestData = activeQuests[playerId]
        console.log(`[FINISH] req: playerId=${playerId} questId=${body.quest_id} category=${body.category} activeExists=${activeQuestData !== undefined} multi=${activeQuestData?.isMulti ?? false}`)
        if (activeQuestData === undefined) return reply.status(400).send({
            "error": "Bad Request",
            "message": "No active quest to finish."
        })

        const questCategory = activeQuestData.category
        const questId = activeQuestData.questId
        console.log(`[FINISH] active: category=${questCategory} questId=${questId}`)
        const questData = getQuestFromCategorySync(questCategory, questId) as BattleQuest | null
        if (questData === null || !('rankPointReward' in questData)) {
            console.log(`[BATTLE] finish failed: category=${questCategory} questId=${questId} found=${!!questData} hasRankReward=${questData ? ('rankPointReward' in questData) : 'N/A'}`)
            return reply.status(400).send({
                "error": "Bad Request",
                "message": "Quest doesn't exist."
            })
        }

        // calculate clear rank
        const clearTime = body.elapsed_time_ms
        const isScoreAttackEvent = questCategory === QuestCategory.SCORE_ATTACK_EVENT
        if (isScoreAttackEvent && (
            questData.bRankScore === undefined
            || questData.aRankScore === undefined
            || questData.sRankScore === undefined
            || questData.ssRankScore === undefined
        )) {
            return reply.status(500).send({
                "error": "Internal Server Error",
                "message": "Score attack rank thresholds are missing.",
            })
        }
        const clearRank = isScoreAttackEvent
            ? calculateScoreAttackClearRank(body.score, {
                bRankScore: questData.bRankScore!,
                aRankScore: questData.aRankScore!,
                sRankScore: questData.sRankScore!,
                ssRankScore: questData.ssRankScore!,
            })
            : calculateClearRank(clearTime, questData)

        // calculate player rewards
        const newExpPool = playerData.expPool + questData.poolExpReward
        const beforeRankPoint = playerData.rankPoint
        const newRankPoint = beforeRankPoint + questData.rankPointReward
        let newMana = playerData.freeMana + questData.manaReward + body.add_mana
        const manaObtained = questData.manaReward + body.add_mana

        // calculate boost point
        let newBoostPoint = playerData.boostPoint - (activeQuestData.useBoostPoint ? 1 : 0)
        let newBossBoostPoint = playerData.bossBoostPoint - (activeQuestData.useBossBoostPoint ? 1 : 0)
        let useBoostPoint = (activeQuestData.useBoostPoint && (newBoostPoint >= 0)) || (activeQuestData.useBossBoostPoint && (newBossBoostPoint >= 0))

        // check current quest progress
        const questProgress = getPlayerSingleQuestProgressSync(playerId, questCategory, questId);
        const questPreviouslyCompleted = questProgress !== null

        let questAccomplished = body.is_accomplished
        let scoreAttackBorderTiers: ScoreAttackBorderTier[] = []
        if (isScoreAttackEvent) {
            try {
                scoreAttackBorderTiers = resolveScoreAttackBorderTiers(
                    questData.eventId,
                    questData.scoreAttackQuestId,
                    scoreAttackBorderRewards as Record<string, ScoreAttackBorderTier[]>,
                )
            } catch (error) {
                console.error(`[SCORE_ATTACK] invalid configuration: ${(error as Error).message}`)
                return reply.status(500).send({
                    "error": "Internal Server Error",
                    "message": "Score attack reward configuration is missing.",
                })
            }
            questAccomplished = body.score >= scoreAttackBorderTiers[0].score
        }

        const leaderId = body.statistics.party.characters[0]?.id

        const bodyPartyStatistics = body.statistics.party
        const partyCharacterIds = [...bodyPartyStatistics.characters, ...bodyPartyStatistics.unison_characters]
        const finishCtx: FinishContext = {
            playerId, questCategory, questId,
            questAccomplished,
            clearTime: body.elapsed_time_ms,
            clearRank,
            party: body.statistics.party as any,
            statistics: (body as any).statistics,
            equipmentElements: body.equipment_element,
            player: playerData,
            questPreviouslyCompleted,
            questProgress,
        }
        const partyCharacterIdsArray: number[] = []
        for (const value of partyCharacterIds.values()) {
            if (value !== null && value.id !== null) partyCharacterIdsArray.push(value.id);
        }
        const addExpAmount = questData.characterExpReward

        const executeFinishWrites = () => {
            const missionEvaluationTime = new Date(getServerTime() * 1000)
            const clearReward = !isScoreAttackEvent && !questPreviouslyCompleted && questData.clearReward !== undefined
                ? givePlayerRewardSync(playerId, questData.clearReward)
                : null
            const sPlusClearReward = !isScoreAttackEvent && (clearRank === 5) && (questProgress?.clearRank !== 5) && (questData.sPlusReward !== undefined)
                ? givePlayerRewardSync(playerId, questData.sPlusReward)
                : null

            if (questAccomplished && !isScoreAttackEvent) {
                if (questPreviouslyCompleted) {
                    const updateData: any = {
                        questId: questId,
                        finished: true,
                        bestElapsedTimeMs: questProgress.bestElapsedTimeMs === undefined || questProgress.bestElapsedTimeMs === null ? clearTime : Math.min(clearTime, questProgress.bestElapsedTimeMs),
                        highScore: questProgress.highScore === undefined ? body.score : Math.max(body.score, questProgress.highScore),
                        leaderCharacterId: leaderId ?? undefined
                    }
                    if (clearRank !== null) {
                        updateData.clearRank = questProgress.clearRank === undefined ? clearRank : Math.max(clearRank, questProgress.clearRank)
                    }
                    updatePlayerQuestProgressSync(playerId, questCategory, updateData)
                } else {
                    insertPlayerQuestProgressSync(playerId, questCategory, {
                        questId: questId,
                        finished: true,
                        bestElapsedTimeMs: clearTime,
                        highScore: body.score,
                        clearRank: clearRank ?? 5,
                        leaderCharacterId: leaderId ?? undefined
                    })
                }
            }

            const oldRkDegree = getRankDegree(beforeRankPoint)
            const newDegreeId = getRankDegree(newRankPoint)
            const didLevelUp = newDegreeId > oldRkDegree
            const afterStamina = didLevelUp
                ? playerData.stamina + getMaxStamina(newDegreeId)
                : playerData.stamina
            const afterStaminaHealTime = didLevelUp ? new Date() : playerData.staminaHealTime
            updatePlayerSync({
                id: playerId,
                freeMana: newMana,
                expPool: newExpPool,
                rankPoint: newRankPoint,
                boostPoint: newBoostPoint,
                bossBoostPoint: newBossBoostPoint,
                totalManaObtained: (playerData.totalManaObtained ?? 0) + manaObtained,
                maxComboAchieved: Math.max(playerData.maxComboAchieved ?? 0, (body as any).statistics?.max_combo_count ?? 0),
                ...(didLevelUp ? { stamina: afterStamina, staminaHealTime: afterStaminaHealTime } : {}),
            })
            if (didLevelUp) {
                console.log(`[BATTLE-FINISH] player ${playerId} leveled up: ${oldRkDegree} -> ${newDegreeId}, stamina refilled`)
            }

            const dailyChallengePointList = handleDailyChallengePoint({
                questCategory,
                eventId: questData.eventId,
                playerId,
                challengePointMap: eventChallengePointMap as Record<string, number>,
                getEntries: (pid) => getPlayerDailyChallengePointListSync(pid),
                updatePoint: (pid, id, pt) => updatePlayerDailyChallengePointSync(pid, id, pt),
            })

            console.log(`[BATTLE] scoreReward groupId=${questData.scoreRewardGroupId} groupLen=${questData.scoreRewardGroup?.length ?? 'null'} questId=${questId} category=${questCategory}`)
            const scoreRewardsResult = givePlayerScoreRewardsSync(playerId, questData.scoreRewardGroupId, questData.scoreRewardGroup, useBoostPoint, questData.element)

            recordMissionBattleFacts(finishCtx, missionEvaluationTime)

            const rewardCharacterExpResult = givePlayerCharactersExpSync(
                playerId,
                partyCharacterIdsArray,
                addExpAmount,
                questData.fixedParty !== undefined
            )

            const { rushEventData, rushEventRewardsResult } = handleRushEventFinish({
                questCategory,
                questAccomplished,
                questData,
                clearTime,
                party: bodyPartyStatistics,
                playerId,
                questId,
                getEvoLevels: (pid, chars) => getCharactersEvolutionImgLevels(pid, chars),
                folderMaxRounds: rushEventFolderMaxRounds,
                getRushEvent: (pid, eid) => getPlayerRushEventSync(pid, eid),
                updateRushEvent: (pid, data) => updatePlayerRushEventSync(pid, data),
                insertParty: (pid, eid, p) => insertPlayerRushEventPlayedPartySync(pid, eid, p),
                insertClearedFolder: (pid, eid, fid) => insertPlayerRushEventClearedFolderSync(pid, eid, fid),
                deletePartyList: (pid, eid, bt) => deletePlayerRushEventPlayedPartyListSync(pid, eid, bt),
                getSerializedParties: (pid, eid) => getSerializedPlayerRushEventPlayedPartiesSync(pid, eid),
                getFolderRewards: (eid, fid) => getRushEventFolderClearRewards(eid, fid),
                giveRewards: (pid, r) => givePlayerRewardsSync(pid, r),
                transaction: operation => getDb().transaction(operation)(),
            })

            const raidEventData = handleRaidEventFinish({
                questCategory,
                questAccomplished,
                activeEventId: activeQuestData.eventId ?? undefined,
                killCountWeight: questData.killCountWeight,
                party: bodyPartyStatistics,
                playerId,
                questId,
                getEvoLevelsFn: (pid, chars) => getCharactersEvolutionImgLevels(pid, chars),
                insertPartyFn: (pid, eid, p) => insertPlayerRushEventPlayedPartySync(pid, eid, p),
            })

            const carnivalFinishResult = handleCarnivalEventFinish({
                questCategory,
                questAccomplished,
                questId,
                questData,
                clearTime,
                party: bodyPartyStatistics,
                playerId,
                getRecordsFn: (pid, eid) => getPlayerCarnivalEventRecordsSync(pid, eid),
                upsertFn: (pid, eid, fid, score, chars, unisons) => upsertPlayerCarnivalEventRecordSync(pid, eid, fid, score, chars, unisons),
                getRewardDefinitionsFn: eid => getCarnivalRewardDefinitions(eid),
                getClaimedRewardIdsFn: (pid, eid) => getPlayerClaimedCarnivalRewardIdsSync(pid, eid),
                grantRewardsFn: (pid, definitions) => grantCarnivalRewards(pid, definitions, {
                    getPlayer: getPlayerSync,
                    giveItem: givePlayerItemSync,
                    giveEquipment: givePlayerEquipmentSync,
                    giveDegree: givePlayerDegreeSync,
                    updatePlayer: updatePlayerSync,
                }),
                claimRewardIdsFn: (pid, eid, rewardIds) => insertPlayerClaimedCarnivalRewardIdsSync(pid, eid, rewardIds),
                transactionFn: runCarnivalEventTransactionSync,
            })
            const carnivalEventData = carnivalFinishResult?.carnivalEventData ?? null
            const carnivalRewardResult = carnivalFinishResult?.rewardResult

            const scoreAttackFinishResult = isScoreAttackEvent
                ? handleScoreAttackEventFinish({
                    playerId,
                    questId,
                    category: questCategory,
                    score: body.score,
                    elapsedTimeMs: clearTime,
                    isAccomplished: questAccomplished,
                    quest: {
                        bRankScore: questData.bRankScore!,
                        aRankScore: questData.aRankScore!,
                        sRankScore: questData.sRankScore!,
                        ssRankScore: questData.ssRankScore!,
                    },
                    tiers: scoreAttackBorderTiers,
                    party: bodyPartyStatistics,
                }, {
                    transaction: operation => operation(),
                    getProgress: (pid, category, qid) => getPlayerSingleQuestProgressSync(pid, category, qid),
                    grantRewards: (pid, rewards) => givePlayerRewardsSync(pid, rewards),
                    updateProgress: (pid, category, progress) => updatePlayerQuestProgressSync(pid, category, progress),
                    insertProgress: (pid, category, progress) => insertPlayerQuestProgressSync(pid, category, progress),
                    deleteActiveQuest: pid => deletePlayerActiveQuestSync(pid),
                })
                : null
            const scoreAttackRewardResult = scoreAttackFinishResult?.rewardResult
            const missionSettlement = settleMissionCategories(
                playerId,
                BATTLE_SETTLEMENT_CATEGORIES,
                missionEvaluationTime,
            )
            const itemList = {
                ...(activeQuestData.entryItemId ? { [activeQuestData.entryItemId]: getPlayerItemSync(playerId, activeQuestData.entryItemId) ?? 0 } : {}),
                ...scoreRewardsResult.items,
                ...(scoreAttackRewardResult?.items ?? {}),
                ...(rushEventRewardsResult?.items ?? {}),
                ...(carnivalRewardResult?.item_list ?? {}),
            }
            const characterList = reconcileAwakeUnlockCharacterList(playerId, [
                ...rewardCharacterExpResult.character_list as unknown as Record<string, unknown>[],
                ...((clearReward?.character_list || []) as Record<string, unknown>[]),
                ...((sPlusClearReward?.character_list || []) as Record<string, unknown>[]),
                ...(scoreRewardsResult.character_list as Record<string, unknown>[]),
                ...((scoreAttackRewardResult?.character_list ?? []) as Record<string, unknown>[]),
            ])

            if (!isScoreAttackEvent) deletePlayerActiveQuestSync(playerId)

            return {
                afterStamina,
                afterStaminaHealTime,
                dailyChallengePointList,
                scoreRewardsResult,
                rewardCharacterExpResult,
                rushEventData,
                rushEventRewardsResult,
                raidEventData,
                carnivalEventData,
                carnivalRewardResult,
                scoreAttackFinishResult,
                scoreAttackRewardResult,
                itemList,
                characterList,
                clearReward,
                sPlusClearReward,
                missionSettlement,
            }
        }

        const finishWrites = getDb().transaction(executeFinishWrites)()
        const {
            afterStamina,
            afterStaminaHealTime,
            dailyChallengePointList,
            scoreRewardsResult,
            rewardCharacterExpResult,
            rushEventData,
            rushEventRewardsResult,
            raidEventData,
            carnivalEventData,
            carnivalRewardResult,
            scoreAttackFinishResult,
            scoreAttackRewardResult,
            itemList,
            characterList,
            clearReward,
            sPlusClearReward,
            missionSettlement,
        } = finishWrites
        delete activeQuests[playerId]
        const scoreAttackEventData = scoreAttackFinishResult?.scoreAttackEvent ?? null

        const dataHeaders = generateDataHeaders({ viewer_id: viewerId })
        reply.header("content-type", "application/x-msgpack")
        const responseData: Record<string, any> = {
                "user_info": {
                    "free_mana": newMana + (clearReward?.user_info.free_mana || 0) + (sPlusClearReward?.user_info.free_mana || 0) + scoreRewardsResult.user_info.free_mana + (scoreAttackRewardResult?.user_info.free_mana ?? 0) + (carnivalRewardResult?.user_info.free_mana ?? 0),
                    "exp_pool": rewardCharacterExpResult.exp_pool + (clearReward?.user_info.exp_pool || 0) + scoreRewardsResult.user_info.exp_pool + (scoreAttackRewardResult?.user_info.exp_pool ?? 0) + (carnivalRewardResult?.user_info.exp_pool ?? 0),
                    "exp_pooled_time": getServerTime(playerData.expPooledTime),
                    "free_vmoney": playerData.freeVmoney + (clearReward?.user_info.free_vmoney || 0) + (sPlusClearReward?.user_info.free_vmoney || 0) + scoreRewardsResult.user_info.free_vmoney + (scoreAttackRewardResult?.user_info.free_vmoney ?? 0) + (carnivalRewardResult?.user_info.free_vmoney ?? 0),
                    "rank_point": newRankPoint,
                    "degree_id": playerData.degreeId,
                    "stamina": afterStamina,
                    "stamina_heal_time": realToVirtual(afterStaminaHealTime),
                    "boost_point": newBoostPoint,
                    "boss_boost_point": newBossBoostPoint
                },
                "add_exp_list": rewardCharacterExpResult.add_exp_list,
                "character_list": characterList,
                "bond_token_status_list": rewardCharacterExpResult.bond_token_status_list,
                "rewards": {
                    "overflow_pool_exp": 0,
                    "converted_pool_exp": 0,
                    "reward_pool_exp": questData.poolExpReward,
                    "reward_mana": questData.manaReward,
                    "field_mana": body.add_mana
                },
                "old_high_score": scoreAttackFinishResult?.oldHighScore ?? (questProgress === null ? 0 : questProgress.highScore || 0),
                "joined_character_id_list": [
                    ...(clearReward?.joined_character_id_list || []),
                    ...(sPlusClearReward?.joined_character_id_list || []),
                    ...scoreRewardsResult.joined_character_id_list,
                    ...(scoreAttackRewardResult?.joined_character_id_list ?? []),
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
                    ...(sPlusClearReward?.equipment_list || []),
                    ...(rushEventRewardsResult?.equipment_list || []),
                    ...(scoreAttackRewardResult?.equipment_list ?? []),
                    ...(carnivalRewardResult?.equipment_list ?? []),
                ],
                "category_id": body.category,
                "start_time": dataHeaders['servertime'],
                "is_multi": "single",
                "quest_name": "",
                "item_list": itemList,
                "raid_event": raidEventData,
                "rush_event": rushEventData,
                "carnival_event": carnivalEventData,
                "score_attack_event": scoreAttackEventData,
                "user_daily_challenge_point_list": dailyChallengePointList ?? [],
                "presigned_quest_category": []
        }
        mergeMissionSettlementResponse(responseData, missionSettlement, viewerId)
        responseData.mail_arrived = getPlayerMailCountSync(playerId, true) > 0
        return reply.status(200).send({
            "data_headers": dataHeaders,
            "data": responseData,
        })

    })

    fastify.post("/abort", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as AbortBody

        const viewerId = body.viewer_id
        if (isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        })

        const sessionResult = await validateSessionAndPlayer(viewerId)
        if (!sessionResult) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id."
        })
        const { playerId } = sessionResult

        const headers = generateDataHeaders({ viewer_id: body.viewer_id })

        const abortResult = runAbortActiveQuestTransaction(playerId, {
            playId: body.play_id,
            questId: body.quest_id,
            category: body.category,
        })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": headers,
            "data": {
                "user_info": {},
                "category_id": body.category,
                "is_multi": "single",
                "start_time": headers['servertime'],
                "quest_name": "",
                "item_list": abortResult.itemList
            }
        })
    })

    fastify.post("/start", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as StartBody

        const viewerId = body.viewer_id
        const partyId = body.party_id
        const questId = body.quest_id
        const category = body.category
        const useBoostPoint = body.use_boost_point
        const useBossBoostPoint = body.use_boss_boost_point
        const isAutoStartMode = body.is_auto_start_mode
        if (isNaN(viewerId) || isNaN(partyId) || isNaN(questId) || isNaN(category) || useBoostPoint === undefined || useBossBoostPoint === undefined || isAutoStartMode === undefined) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        })

        const sessionResult = await validateSessionAndPlayer(viewerId)
        if (!sessionResult) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id."
        })
        const { playerId, playerData: player } = sessionResult

        // get quest data
        const questData = getQuestFromCategorySync(category, questId) as BattleQuest | null
        if (questData === null || !('rankPointReward' in questData)) {
            console.log(`[BATTLE] start failed: category=${category} questId=${questId} found=${!!questData} hasRankReward=${questData ? ('rankPointReward' in questData) : 'N/A'}`)
            return reply.status(400).send({
                "error": "Bad Request",
                "message": "Quest doesn't exist."
            })
        }

        // Validate and persist all quest-start state atomically.
        const questKey = `${category}_${questId}`
        const entryCost = (questEntryCosts as Record<string, StartEntryCost>)[questKey]
        const staminaInfo = getStaminaCost(questKey)
        console.log(`[BATTLE] start entry: questId=${questId} questKey=${questKey} entryCost=${JSON.stringify(entryCost)} discountRate=${staminaInfo.rate} baseStamina=${staminaInfo.baseCost}→${staminaInfo.cost}`)
        const staminaCost = staminaInfo.cost
        const activeQuest: ActiveQuest = {
            questId: questId,
            category: category,
            useBoostPoint: useBoostPoint,
            useBossBoostPoint: useBossBoostPoint,
            isAutoStartMode: isAutoStartMode,
            isMulti: false,
            entryItemId: entryCost && entryCost.itemId > 0 ? entryCost.itemId : undefined,
            entryItemCount: entryCost && entryCost.itemCount > 0 ? entryCost.itemCount : undefined,
            playId: body.play_id,
            continueCount: 0
        }
        const startTime = new Date()
        let startResult
        let missionSettlement: MissionSettlementResult | undefined
        try {
            startResult = runStartEntryTransaction({
                playerId,
                entryCost,
                staminaCost,
                partyId,
                updatePartySlot: questData.fixedParty === undefined,
                activeQuest,
                now: startTime,
            }, {
                transaction: operation => getDb().transaction(operation)(),
                getPlayer: getPlayerSync,
                computeStamina: computeRealTimeStamina,
                getItemCount: getPlayerItemSync,
                updateItemCount: updatePlayerItemSync,
                updatePlayer: updatePlayerSync,
                persistActiveQuest,
                afterPersist: () => {
                    recordActiveMissionQuestChallengeFactSync(playerId, category)
                    missionSettlement = settleMissionCategories(
                        playerId,
                        [1, 2, 10],
                        new Date(getServerTime() * 1000),
                    )
                },
                publishActiveQuest,
            })
        } catch (error) {
            if (error instanceof InsufficientEntryItemError
                || error instanceof InsufficientStaminaError
                || error instanceof PlayerNotFoundError) {
                console.warn(`[BATTLE-START] player ${playerId}: ${error.message}`)
                return reply.status(400).send({
                    "error": "Bad Request",
                    "message": error.message,
                })
            }
            throw error
        }
        console.log(`[BATTLE-START] stamina: ${player.stamina} -> ${startResult.afterStamina} (cost: ${staminaCost}, rate: ${staminaInfo.rate})`)

        const dataHeaders = generateDataHeaders({
            viewer_id: viewerId
        })

        reply.header("content-type", "application/x-msgpack")
        const responseData: Record<string, any> = {
                "user_info": {
                    "last_main_quest_id": body.quest_id,
                    "stamina": startResult.afterStamina,
                    "stamina_heal_time": realToVirtual(new Date())
                },
                "item_list": buildStartEntryItemList(startResult),
                "category_id": body.category,
                "is_multi": "single",
                "start_time": dataHeaders['servertime'],
                "quest_name": ""
        }
        if (missionSettlement) {
            mergeMissionSettlementResponse(responseData, missionSettlement, viewerId)
        }
        responseData.mail_arrived = getPlayerMailCountSync(playerId, true) > 0
        return reply.status(200).send({
            "data_headers": dataHeaders,
            "data": responseData,
        })
    })

    fastify.post("/play_continue", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as PlayContinueBody

        const viewerId = body.viewer_id
        if (isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        })

        const sessionResult = await validateSessionAndPlayer(viewerId)
        if (!sessionResult) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id."
        })
        const { playerId, playerData: player } = sessionResult

        // get active quest data
        const activeQuestData = activeQuests[playerId]
        if (activeQuestData === undefined) return reply.status(400).send({
            "error": "Bad Request",
            "message": "No active quest to continue."
        })

        const freeVmoney = player.freeVmoney
        const newFreeVmoney = freeVmoney - continueVmoneyCost
        const vmoney = player.vmoney
        const newVmoney = 0 > newFreeVmoney ? vmoney - continueVmoneyCost : vmoney
        if (0 > newFreeVmoney && 0 > newVmoney) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Not enough vmoney to continue"
        })

        // update the player's vmoney balances
        const setNewFreeVmoney = 0 > newFreeVmoney ? freeVmoney : newFreeVmoney
        updatePlayerSync({
            id: playerId,
            freeVmoney: setNewFreeVmoney,
            vmoney: newVmoney
        })

        // increment continue count for battle recovery
        activeQuestData.continueCount++
        updatePlayerActiveQuestContinueCountSync(playerId, activeQuestData.continueCount)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "user_info": {
                    "free_vmoney": setNewFreeVmoney,
                    "vmoney": newVmoney
                },
                "mail_arrived": false
            }
        })

    })
}

export default routes;
